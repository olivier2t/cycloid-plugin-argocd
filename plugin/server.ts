import { createServer, type ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// ─── Configuration ────────────────────────────────────────────────────────────
// PORT is always injected by the Cycloid Plugin Manager — there is no default.
// Everything else is optional at start-up so the Plugin Registry can validate
// the image without supplying real install-time values; sync is just skipped
// in that case.
const port = Number(process.env.PORT);
if (!Number.isFinite(port) || port <= 0) {
  console.error("FATAL: PORT environment variable is not set or is invalid");
  process.exit(1);
}

// Install-form values (capitalised manifest keys → env vars).
const ARGOCD_USERNAME = process.env.ARGOCD_USERNAME?.trim() ?? "";
const ARGOCD_PASSWORD = process.env.ARGOCD_PASSWORD ?? "";

// Injected by the Plugin Manager. Used to enumerate orgs/envs at sync time.
const PROXY_URL = process.env.PROXY_URL?.replace(/\/+$/, "") ?? "";
const PLUGIN_SECRET = process.env.PLUGIN_SECRET?.trim() ?? "";

const DB_FILE = process.env.DB_FILE?.trim() || ":memory:";

const SYNC_INSECURE_TLS = process.env.ARGOCD_INSECURE_TLS === "true";

// Startup diagnostic: report which install/runtime env vars are present
// (values masked) so we can tell what the Plugin Manager actually injects.
// Also list any other env var names that look plugin-related, in case the
// Plugin Manager uses different names than the ones we read above.
(() => {
  const presence = {
    ARGOCD_USERNAME: Boolean(ARGOCD_USERNAME),
    ARGOCD_PASSWORD: Boolean(ARGOCD_PASSWORD),
    PROXY_URL: Boolean(PROXY_URL),
    PLUGIN_SECRET: Boolean(PLUGIN_SECRET),
    DB_FILE: Boolean(process.env.DB_FILE),
    PORT: Boolean(process.env.PORT),
  };
  console.log(`[INFO] config presence: ${JSON.stringify(presence)}`);

  const knownNames = new Set(Object.keys(presence));
  const interesting = Object.keys(process.env)
    .filter((k) => /ARGO|CYCLOID|PROXY|PLUGIN|SECRET|TOKEN|CONFIG/i.test(k))
    .filter((k) => !knownNames.has(k))
    .sort();
  if (interesting.length > 0) {
    console.log(`[INFO] other plugin-related env var names: ${interesting.join(", ")}`);
  }
})();

// ArgoCD URLs follow a fixed convention. The plugin doesn't expose this as
// configuration on purpose — the install form only carries credentials.
function argocdBaseUrl(orgSlug: string, envSlug: string): string {
  return `https://argocd.${orgSlug}-${envSlug}.demo.cycloid.io`;
}

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA foreign_keys = ON");

const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
db.exec(schema);
console.log(`[INFO] sqlite ready (file=${DB_FILE})`);

// ─── Generic JSON HTTP helper ─────────────────────────────────────────────────
type ReqInit = {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  rejectUnauthorized?: boolean;
};

function jsonRequest(
  target: URL,
  init: ReqInit,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === "https:";
    const request = isHttps ? httpsRequest : httpRequest;
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.body !== undefined) {
      headers["content-type"] ??= "application/json";
      headers["content-length"] = String(Buffer.byteLength(init.body));
    }
    const req = request(
      target,
      {
        method: init.method,
        headers,
        rejectUnauthorized: isHttps ? init.rejectUnauthorized : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

// ─── Cycloid proxy client (org/env discovery) ─────────────────────────────────
async function cycloidProxyGet<T>(path: string): Promise<T> {
  if (!PROXY_URL || !PLUGIN_SECRET) {
    throw new Error("PROXY_URL or PLUGIN_SECRET not set");
  }
  const sep = path.includes("?") ? "&" : "?";
  const url = new URL(`${PROXY_URL}${path}${sep}secret=${PLUGIN_SECRET}`);
  const res = await jsonRequest(url, { method: "GET" });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `Cycloid proxy GET ${path} HTTP ${res.status}: ${res.body.slice(0, 200)}`,
    );
  }
  return JSON.parse(res.body) as T;
}

type CyOrganization = { canonical?: string };
type CyProject = { canonical?: string; environments?: string[] };
type CyListResponse<T> = { data?: T[] };

async function discoverOrgsAndEnvs(): Promise<Array<{ org: string; env: string }>> {
  const out: Array<{ org: string; env: string }> = [];
  const orgsResp = await cycloidProxyGet<CyListResponse<CyOrganization>>("/organizations");
  const orgs = orgsResp.data ?? [];
  for (const o of orgs) {
    if (!o.canonical) continue;
    let projectsResp: CyListResponse<CyProject>;
    try {
      projectsResp = await cycloidProxyGet<CyListResponse<CyProject>>(
        `/organizations/${encodeURIComponent(o.canonical)}/projects`,
      );
    } catch (err) {
      console.warn(`[WARN] discovery: skipping org ${o.canonical}: ${(err as Error).message}`);
      continue;
    }
    for (const p of projectsResp.data ?? []) {
      for (const env of p.environments ?? []) {
        out.push({ org: o.canonical, env });
      }
    }
  }
  // Deduplicate (project1.envs and project2.envs may overlap).
  const seen = new Set<string>();
  return out.filter((p) => {
    const key = `${p.org}\u0000${p.env}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── ArgoCD client ────────────────────────────────────────────────────────────
type ArgoApp = {
  metadata?: { name?: string };
  spec?: { destination?: { namespace?: string } };
  status?: {
    sync?: { status?: string };
    health?: { status?: string };
    operationState?: { finishedAt?: string };
  };
};

async function argocdLogin(baseUrl: string): Promise<string> {
  const res = await jsonRequest(new URL("/api/v1/session", baseUrl), {
    method: "POST",
    body: JSON.stringify({ username: ARGOCD_USERNAME, password: ARGOCD_PASSWORD }),
    rejectUnauthorized: !SYNC_INSECURE_TLS,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`login HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(res.body) as { token?: string };
  if (!parsed.token) throw new Error("login: no token in response");
  return parsed.token;
}

async function argocdListApps(baseUrl: string, token: string): Promise<ArgoApp[]> {
  const res = await jsonRequest(new URL("/api/v1/applications", baseUrl), {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    rejectUnauthorized: !SYNC_INSECURE_TLS,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`applications HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(res.body) as { items?: ArgoApp[] };
  return parsed.items ?? [];
}

// ─── Resync ───────────────────────────────────────────────────────────────────
let resyncRunning = false;

async function resync(): Promise<{ started: boolean; reason?: string }> {
  if (resyncRunning) return { started: false, reason: "already running" };
  if (!ARGOCD_USERNAME || !ARGOCD_PASSWORD || !PROXY_URL || !PLUGIN_SECRET) {
    return { started: false, reason: "missing configuration" };
  }
  resyncRunning = true;

  try {
    console.log("[INFO] resync: starting");

    let pairs: Array<{ org: string; env: string }>;
    try {
      pairs = await discoverOrgsAndEnvs();
    } catch (err) {
      console.error(`[ERROR] resync: discovery failed: ${(err as Error).message}`);
      return { started: false, reason: "discovery failed" };
    }
    console.log(`[INFO] resync: discovered ${pairs.length} (org, env) pair(s)`);

    // Collect ArgoCD apps per pair before opening the SQLite transaction, so
    // a slow or failing ArgoCD instance doesn't hold a write lock.
    const synced: Array<{ org: string; env: string; apps: ArgoApp[] }> = [];
    for (const { org, env } of pairs) {
      const base = argocdBaseUrl(org, env);
      try {
        const token = await argocdLogin(base);
        const apps = await argocdListApps(base, token);
        synced.push({ org, env, apps });
        console.log(`[INFO] resync: ${org}/${env}: ${apps.length} apps from ${base}`);
      } catch (err) {
        console.warn(
          `[WARN] resync: skipping ${org}/${env} (${base}): ${(err as Error).message}`,
        );
      }
    }

    db.exec("BEGIN");
    try {
      // Cascade DELETE wipes environments + argocd_apps via FK ON DELETE CASCADE.
      db.exec("DELETE FROM organizations");

      const orgIds = new Map<string, string>();
      const insertOrg = db.prepare("INSERT INTO organizations (id, slug) VALUES (?, ?)");
      const insertEnv = db.prepare(
        "INSERT INTO environments (id, slug, organization_id) VALUES (?, ?, ?)",
      );
      const insertApp = db.prepare(`
        INSERT INTO argocd_apps
          (id, name, sync_status, health_status, namespace, last_synced, url, environment_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      let totalApps = 0;
      for (const { org, env, apps } of synced) {
        let orgId = orgIds.get(org);
        if (!orgId) {
          orgId = `org-${org}`;
          insertOrg.run(orgId, org);
          orgIds.set(org, orgId);
        }
        const envId = `env-${org}-${env}`;
        insertEnv.run(envId, env, orgId);

        const baseUrl = argocdBaseUrl(org, env);
        for (const app of apps) {
          const name = app.metadata?.name ?? "";
          if (!name) continue;
          insertApp.run(
            `${envId}-${name}`,
            name,
            app.status?.sync?.status ?? "",
            app.status?.health?.status ?? "",
            app.spec?.destination?.namespace ?? "",
            app.status?.operationState?.finishedAt ?? "",
            `${baseUrl}/applications/${encodeURIComponent(name)}`,
            envId,
          );
          totalApps++;
        }
      }
      db.exec("COMMIT");
      console.log(
        `[INFO] resync: completed (${synced.length} envs synced, ${totalApps} apps inserted)`,
      );
      return { started: true };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } catch (err) {
    console.error(`[ERROR] resync: ${(err as Error).message}`);
    return { started: false, reason: (err as Error).message };
  } finally {
    resyncRunning = false;
  }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
function send(
  res: ServerResponse,
  status: number,
  body: string | object,
  contentType = "application/json",
): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": contentType });
  res.end(payload);
}

const server = createServer((req, res) => {
  const start = Date.now();
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname.replace(/^\/iframe/, "") || "/";

  res.on("finish", () => {
    const ms = Date.now() - start;
    const level =
      res.statusCode >= 500 ? "ERROR" : res.statusCode >= 400 ? "WARN" : "INFO";
    console.log(`[${level}] ${method} ${pathname} → ${res.statusCode} (${ms}ms)`);
  });

  if (method === "GET" && pathname === "/_cy/ping") return send(res, 200, { ok: true });
  if (method === "POST" && pathname === "/_cy/events") return send(res, 200, { ok: true });
  if (method === "DELETE" && pathname === "/_cy/plugin") return send(res, 200, { ok: true });

  if (method === "POST" && pathname === "/_cy/resync") {
    resync().then(
      (r) => console.log(`[INFO] /_cy/resync handler: ${JSON.stringify(r)}`),
      (e) => console.error(`[ERROR] /_cy/resync handler: ${e}`),
    );
    return send(res, 200, { started: true });
  }

  send(res, 404, "Not Found", "text/plain; charset=utf-8");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[INFO] listening on http://0.0.0.0:${port}`);
  resync().then(
    (r) => console.log(`[INFO] initial sync: ${JSON.stringify(r)}`),
    (e) => console.error(`[ERROR] initial sync: ${e}`),
  );
});
