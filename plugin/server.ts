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

// Optional explicit URL override. Set this when the plugin container's DNS
// resolver can't see the public ArgoCD hostname (sandbox isolation): point it
// at an IP or an internal DNS name reachable from the sandbox, and combine
// with ARGOCD_INSECURE_TLS=true if you're using an IP (cert won't match).
const ARGOCD_URL_OVERRIDE = process.env.ARGOCD_URL_OVERRIDE?.trim() ?? "";

function normaliseDbFile(raw: string | undefined): string {
  const v = raw?.trim();
  if (!v) return ":memory:";
  if (v.startsWith("file:")) return v.slice("file:".length) || ":memory:";
  return v;
}
const DB_FILE = normaliseDbFile(process.env.DB_FILE);

const SYNC_INSECURE_TLS = process.env.ARGOCD_INSECURE_TLS === "true";

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function isIpLiteral(host: string): boolean {
  // Strip brackets from IPv6 literals: [::1]
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  // Cheap-but-sufficient: IPv4 dotted-quad, or anything containing ':' (IPv6)
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
}

// Connection plan for ArgoCD: the URL we actually open a socket to, and the
// hostname we use for TLS SNI + HTTP Host header. They diverge when the
// operator pins ARGOCD_URL_OVERRIDE to an IP — needed when the plugin sandbox
// has UDP/53 egress blocked (so DNS can't resolve argocd.<org>.demo.cycloid.io)
// but TCP/443 to public IPs still works. In that case we need to send the
// canonical hostname in SNI + Host so nginx can route us to the right ingress.
type ArgoConn = { connectUrl: string; tlsHost: string };
function argocdConnection(org: string): ArgoConn {
  const canonical = `argocd.${org}.demo.cycloid.io`;
  if (!ARGOCD_URL_OVERRIDE) {
    return { connectUrl: `https://${canonical}`, tlsHost: canonical };
  }
  const overrideUrl = new URL(stripTrailingSlash(ARGOCD_URL_OVERRIDE));
  if (isIpLiteral(overrideUrl.hostname)) {
    return { connectUrl: overrideUrl.toString().replace(/\/$/, ""), tlsHost: canonical };
  }
  // Override is itself a hostname (e.g. an internal DNS name) — use as-is.
  return { connectUrl: overrideUrl.toString().replace(/\/$/, ""), tlsHost: overrideUrl.hostname };
}

console.log(
  `[INFO] config: org='${CYCLOID_ORG_SLUG}' argocd_user='${ARGOCD_USERNAME}' ` +
    `url_override='${ARGOCD_URL_OVERRIDE || "(none)"}' insecure_tls=${SYNC_INSECURE_TLS} db='${DB_FILE}'`,
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
  // When set, used as the TLS SNI and the HTTP Host header. Lets us connect
  // to an IP while still presenting the canonical hostname to nginx/ArgoCD.
  tlsHost?: string;
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
    if (init.tlsHost) headers["host"] = init.tlsHost;

    const req = request(
      {
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: init.method,
        headers,
        servername: isHttps ? init.tlsHost ?? target.hostname : undefined,
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

async function argocdLogin(conn: ArgoConn): Promise<string> {
  const res = await jsonRequest(new URL("/api/v1/session", conn.connectUrl), {
    method: "POST",
    body: JSON.stringify({ username: ARGOCD_USERNAME, password: ARGOCD_PASSWORD }),
    rejectUnauthorized: !SYNC_INSECURE_TLS,
    tlsHost: conn.tlsHost,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`login HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(res.body) as { token?: string };
  if (!parsed.token) throw new Error("login: no token in response");
  return parsed.token;
}

async function argocdListApps(conn: ArgoConn, token: string): Promise<ArgoApp[]> {
  const res = await jsonRequest(new URL("/api/v1/applications", conn.connectUrl), {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    rejectUnauthorized: !SYNC_INSECURE_TLS,
    tlsHost: conn.tlsHost,
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
  const conn = argocdConnection(org);

  try {
    console.log(
      `[INFO] resync: ${org} connecting to ${conn.connectUrl} (TLS host: ${conn.tlsHost})`,
    );

    let token: string;
    let apps: ArgoApp[];
    try {
      token = await argocdLogin(conn);
      apps = await argocdListApps(conn, token);
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
        // Apps that don't match the convention are typically umbrella/
        // bootstrap apps (e.g. an "app-of-apps" parent). They aren't tied
        // to a single Cycloid component, so they have no component tab to
        // render on — silently skip and count them.
        console.log(
          `[INFO] no component mapping for app '${name}': not '${org}-<env>-<component>', skipping`,
        );
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
        // The link is for a human to click from the Cycloid UI, so it must
        // use the canonical hostname (not the IP we connected with).
        const humanBaseUrl = `https://${conn.tlsHost}`;
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
            `${humanBaseUrl}/applications/${encodeURIComponent(name)}`,
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

// Initial sync with retry. Plugin-manager spawns the container and we boot
// immediately, but the sandbox's DNS/route plumbing can take a few seconds
// before getaddrinfo() works reliably — manifesting as a one-off EAI_AGAIN.
// We retry on the symptoms (EAI_AGAIN / ETIMEDOUT / ENOTFOUND / ECONNREFUSED)
// with linear backoff, then stop. Manual /_cy/resync remains the escape hatch.
const TRANSIENT_NET_ERRORS = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "Invalid URL",
]);

async function initialSyncWithRetry(): Promise<void> {
  const attempts = 5;
  for (let i = 1; i <= attempts; i++) {
    const r = await resync();
    console.log(`[INFO] initial sync (attempt ${i}/${attempts}): ${JSON.stringify(r)}`);
    if (r.started) return;
    const transient =
      r.reason !== undefined &&
      [...TRANSIENT_NET_ERRORS].some((code) => r.reason!.includes(code));
    if (!transient) return;
    if (i < attempts) {
      const delayMs = i * 5_000;
      console.log(`[INFO] initial sync: transient error, retrying in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

server.listen(port, "0.0.0.0", () => {
  console.log(`[INFO] listening on http://0.0.0.0:${port}`);
  initialSyncWithRetry().catch((e) =>
    console.error(`[ERROR] initial sync: ${(e as Error).message}`),
  );
});
