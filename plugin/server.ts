import { createServer, type ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// ─── Configuration ────────────────────────────────────────────────────────────
const port = Number(process.env.PORT);
if (!Number.isFinite(port) || port <= 0) {
  console.error("FATAL: PORT environment variable is not set or is invalid");
  process.exit(1);
}

const ARGOCD_USERNAME = process.env.ARGOCD_USERNAME?.trim() ?? "";
const ARGOCD_PASSWORD = process.env.ARGOCD_PASSWORD ?? "";

// Substituted at install time from the manifest's ($ .org $) default. One
// install per Cycloid org, so this value is fixed for the lifetime of the
// container. Env is parsed per-app from the ArgoCD naming convention.
const CYCLOID_ORG_SLUG = process.env.CYCLOID_ORG_SLUG?.trim() ?? "";

function normaliseDbFile(raw: string | undefined): string {
  const v = raw?.trim();
  if (!v) return ":memory:";
  if (v.startsWith("file:")) return v.slice("file:".length) || ":memory:";
  return v;
}
const DB_FILE = normaliseDbFile(process.env.DB_FILE);

const SYNC_INSECURE_TLS = process.env.ARGOCD_INSECURE_TLS === "true";

// Single ArgoCD URL per org. If your topology differs, change this.
function argocdBaseUrl(org: string): string {
  return `https://argocd.${org}.demo.cycloid.io`;
}

console.log(
  `[INFO] config: org='${CYCLOID_ORG_SLUG}' argocd_user='${ARGOCD_USERNAME}' db='${DB_FILE}'`,
);

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA foreign_keys = ON");

const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
db.exec(schema);
console.log(`[INFO] sqlite ready (file=${DB_FILE})`);

// ─── HTTP helper ──────────────────────────────────────────────────────────────
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

// ─── Name parser ──────────────────────────────────────────────────────────────
// ArgoCD apps in Cycloid follow the naming convention
//   "<org>-<env>-<component>"
// in both metadata.name and spec.destination.namespace. We know the org at
// install time, so we strip the "<org>-" prefix; the first remaining
// hyphen-separated segment is the env, and the rest is the component.
//
// Assumption: env canonicals do not contain hyphens. Component canonicals
// may contain hyphens (we just take everything after the first split).
function parseAppName(
  name: string,
  org: string,
): { env: string; component: string } | null {
  const prefix = `${org}-`;
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  const firstDash = rest.indexOf("-");
  if (firstDash <= 0) return null;
  const env = rest.slice(0, firstDash);
  const component = rest.slice(firstDash + 1);
  if (!env || !component) return null;
  return { env, component };
}

// ─── Resync ───────────────────────────────────────────────────────────────────
let resyncRunning = false;

async function resync(): Promise<{ started: boolean; reason?: string; apps?: number; skipped?: number }> {
  if (resyncRunning) return { started: false, reason: "already running" };
  if (!ARGOCD_USERNAME || !ARGOCD_PASSWORD || !CYCLOID_ORG_SLUG) {
    return { started: false, reason: "missing configuration" };
  }
  resyncRunning = true;

  const org = CYCLOID_ORG_SLUG;
  const baseUrl = argocdBaseUrl(org);

  try {
    console.log(`[INFO] resync: ${org} from ${baseUrl}`);

    let token: string;
    let apps: ArgoApp[];
    try {
      token = await argocdLogin(baseUrl);
      apps = await argocdListApps(baseUrl, token);
    } catch (err) {
      console.error(`[ERROR] resync ${org}: ${(err as Error).message}`);
      return { started: false, reason: (err as Error).message };
    }
    console.log(`[INFO] resync: fetched ${apps.length} apps from ArgoCD`);

    // Group apps by parsed env so we can scope the per-env wipe correctly.
    const byEnv = new Map<string, Array<{ app: ArgoApp; env: string; component: string }>>();
    let skipped = 0;
    for (const app of apps) {
      const name = app.metadata?.name ?? "";
      if (!name) {
        skipped++;
        continue;
      }
      // Prefer parsing from metadata.name; fall back to destination.namespace.
      const parsed =
        parseAppName(name, org) ??
        parseAppName(app.spec?.destination?.namespace ?? "", org);
      if (!parsed) {
        console.warn(`[WARN] skipping app '${name}': does not match '<org>-<env>-<component>'`);
        skipped++;
        continue;
      }
      const list = byEnv.get(parsed.env) ?? [];
      list.push({ app, env: parsed.env, component: parsed.component });
      byEnv.set(parsed.env, list);
    }

    db.exec("BEGIN");
    try {
      const orgId = `org-${org}`;
      db.prepare("INSERT OR IGNORE INTO organizations (id, slug) VALUES (?, ?)").run(orgId, org);

      const insertEnv = db.prepare(
        "INSERT OR IGNORE INTO environments (id, slug, organization_id) VALUES (?, ?, ?)",
      );
      const deleteAppsForEnv = db.prepare("DELETE FROM argocd_apps WHERE environment_id = ?");
      const insertApp = db.prepare(`
        INSERT INTO argocd_apps
          (id, name, component, sync_status, health_status, namespace, last_synced, url, environment_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      let inserted = 0;
      for (const [env, list] of byEnv) {
        const envId = `env-${org}-${env}`;
        insertEnv.run(envId, env, orgId);
        deleteAppsForEnv.run(envId);
        for (const { app, component } of list) {
          const name = app.metadata?.name ?? "";
          insertApp.run(
            `${envId}-${name}`,
            name,
            component,
            app.status?.sync?.status ?? "",
            app.status?.health?.status ?? "",
            app.spec?.destination?.namespace ?? "",
            app.status?.operationState?.finishedAt ?? "",
            `${baseUrl}/applications/${encodeURIComponent(name)}`,
            envId,
          );
          inserted++;
        }
      }
      db.exec("COMMIT");
      console.log(
        `[INFO] resync ${org}: completed (${inserted} apps across ${byEnv.size} env(s), ${skipped} skipped)`,
      );
      return { started: true, apps: inserted, skipped };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } catch (err) {
    console.error(`[ERROR] resync ${org}: ${(err as Error).message}`);
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
