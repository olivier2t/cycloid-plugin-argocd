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

const SYNC_INSECURE_TLS = true;

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
for (const sql of [
  "ALTER TABLE argocd_apps ADD COLUMN project TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE argocd_apps ADD COLUMN revision TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE argocd_apps ADD COLUMN cluster TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE argocd_apps ADD COLUMN resources TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE argocd_apps ADD COLUMN ingress_url TEXT NOT NULL DEFAULT ''",
]) {
  try {
    db.exec(sql);
  } catch {
    /* column already exists */
  }
}
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
const ARGOCD_LOGO_URL =
  "https://raw.githubusercontent.com/cncf/artwork/main/projects/argo/icon/color/argo-icon-color.svg";

type ArgoApp = {
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: {
    project?: string;
    destination?: { namespace?: string; name?: string; server?: string };
  };
  status?: {
    sync?: { status?: string; revision?: string };
    health?: { status?: string };
    reconciledAt?: string;
    resources?: unknown[];
    summary?: { externalURLs?: string[] };
    history?: Array<{ deployedAt?: string }>;
    operationState?: {
      phase?: string;
      finishedAt?: string;
      startedAt?: string;
    };
  };
};

// Cycloid demo stacks register apps under the "argocd" project, not "default".
const ARGOCD_UI_PROJECT = "argocd";

function argocdProject(app: ArgoApp): string {
  return app.spec?.project?.trim() || ARGOCD_UI_PROJECT;
}

function argocdAppUrl(conn: ArgoConn, project: string, name: string): string {
  const proj = project || ARGOCD_UI_PROJECT;
  return `https://${conn.tlsHost}/applications/${encodeURIComponent(proj)}/${encodeURIComponent(name)}`;
}

function argocdConsoleUrl(conn: ArgoConn): string {
  return argocdAppUrl(conn, ARGOCD_UI_PROJECT, "app-of-apps");
}

function formatTimestamp(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function extractIngressUrl(
  app: ArgoApp,
  org: string,
  env: string,
  component: string,
): string {
  const urls = app.status?.summary?.externalURLs;
  if (urls && urls.length > 0) {
    const first = urls[0].trim();
    if (first) return first.startsWith("http") ? first : `https://${first}`;
  }
  return `https://${component}.${org}.demo.cycloid.io`;
}

function extractCluster(app: ArgoApp): string {
  const dest = app.spec?.destination;
  if (dest?.name?.trim()) return dest.name.trim();
  const server = dest?.server?.trim() ?? "";
  if (!server) return "—";
  try {
    return new URL(server).hostname || server;
  } catch {
    return server.replace(/^https?:\/\//, "").split("/")[0] ?? server;
  }
}

function extractLastSynced(app: ArgoApp): string {
  const candidates: string[] = [];
  const op = app.status?.operationState;
  if (op?.finishedAt) candidates.push(op.finishedAt);
  if (app.status?.reconciledAt) candidates.push(app.status.reconciledAt);
  if (op?.startedAt && !op.finishedAt) candidates.push(op.startedAt);
  for (const h of app.status?.history ?? []) {
    if (h.deployedAt) candidates.push(h.deployedAt);
  }
  let best = "";
  let bestMs = 0;
  for (const iso of candidates) {
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms) && ms > bestMs) {
      bestMs = ms;
      best = iso;
    }
  }
  return best ? formatTimestamp(best) : "";
}

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

async function argocdRefreshApp(
  conn: ArgoConn,
  token: string,
  name: string,
): Promise<void> {
  const url = new URL(
    `/api/v1/applications/${encodeURIComponent(name)}/refresh`,
    conn.connectUrl,
  );
  url.searchParams.set("refresh", "hard");
  const res = await jsonRequest(url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    rejectUnauthorized: !SYNC_INSECURE_TLS,
    tlsHost: conn.tlsHost,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`refresh ${name} HTTP ${res.status}: ${res.body.slice(0, 120)}`);
  }
}

// ─── Name parser ──────────────────────────────────────────────────────────────
// ArgoCD apps in Cycloid can follow two naming conventions:
//   1. "<org>-<env>-<component>"  (e.g. test09-dev-pr1)
//   2. "<org>-<component>"        (e.g. test13-pr1, no env in name)
//
// We try the 3-part split first; if there's no second dash we treat the
// remainder as the component and leave env empty (caller fills it in from
// labels, namespace, or a default).
function parseAppName(
  name: string,
  org: string,
): { env: string; component: string } | null {
  const prefix = `${org}-`;
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  if (!rest) return null;
  const firstDash = rest.indexOf("-");
  if (firstDash > 0) {
    const env = rest.slice(0, firstDash);
    const component = rest.slice(firstDash + 1);
    if (env && component) return { env, component };
  }
  // No dash → <org>-<component> format (env unknown)
  return { env: "", component: rest };
}

// ─── UI (iframe side menu) ────────────────────────────────────────────────────
type AppRow = {
  name: string;
  env: string;
  component: string;
  health_status: string;
  namespace: string;
  last_synced: string;
  url: string;
  project: string;
  cluster: string;
  ingress_url: string;
};

function listAppsFromDb(): AppRow[] {
  return db
    .prepare(
      `SELECT a.name, e.slug AS env, a.component, a.health_status, a.namespace,
              a.last_synced, a.url, a.project, a.cluster, a.ingress_url
       FROM argocd_apps AS a
       JOIN environments AS e ON e.id = a.environment_id
       ORDER BY e.slug, a.component, a.name`,
    )
    .all() as AppRow[];
}

function healthBadgeClass(status: string): string {
  const s = status.toLowerCase();
  if (s === "healthy") return "badge badge-healthy";
  if (s === "progressing") return "badge badge-progressing";
  if (s === "degraded" || s === "suspended") return "badge badge-degraded";
  if (s === "missing" || s === "unknown") return "badge badge-unknown";
  return "badge";
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderAppsPage(rows: AppRow[], consoleUrl: string): string {
  const table =
    rows.length === 0
      ? `<p class="empty">No Cycloid applications in ArgoCD yet. Click <strong>Refresh</strong> to pull the latest state.</p>`
      : `<div class="table-wrap"><table>
  <thead><tr>
    <th>Application</th><th>Environment</th><th>Component</th><th>Project</th>
    <th>Cluster</th><th>Health</th><th>Namespace</th><th>Last reconciled</th><th>App URL</th>
  </tr></thead>
  <tbody>${rows
    .map((r) => {
      const health = r.health_status?.trim() || "—";
      const ingress = r.ingress_url?.trim() || "";
      const ingressCell = ingress
        ? `<a class="ingress-link" href="${escapeHtml(ingress)}" title="${escapeHtml(ingress)}">${escapeHtml(new URL(ingress).hostname)}</a>`
        : "—";
      return `<tr>
    <td class="mono nowrap">${escapeHtml(r.name)}</td>
    <td>${escapeHtml(r.env)}</td>
    <td>${escapeHtml(r.component)}</td>
    <td>${escapeHtml(r.project || "—")}</td>
    <td>${escapeHtml(r.cluster || "—")}</td>
    <td><span class="${healthBadgeClass(health)}">${escapeHtml(health)}</span></td>
    <td class="mono nowrap">${escapeHtml(r.namespace)}</td>
    <td class="muted">${escapeHtml(r.last_synced || "—")}</td>
    <td class="nowrap">${ingressCell}</td>
  </tr>`;
    })
    .join("")}</tbody>
</table></div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ArgoCD</title>
  <style>
    :root {
      color-scheme: light;
      --argo-orange: #ef7b4d;
      --argo-orange-dark: #d9643a;
      --argo-navy: #192149;
      --argo-slate: #39415b;
      --argo-bg: #f4f6fa;
      --argo-card: #ffffff;
      --argo-border: #dde3ef;
      --argo-text: #1a2233;
      --argo-muted: #5c677f;
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: linear-gradient(160deg, var(--argo-bg) 0%, #e8ecf5 100%);
      color: var(--argo-text);
      min-height: 100vh;
    }
    .page { max-width: 1280px; margin: 0 auto; padding: 1.25rem 1.5rem 2rem; }
    .header {
      display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
      background: var(--argo-card);
      border: 1px solid var(--argo-border);
      border-radius: 12px;
      padding: 1rem 1.25rem;
      box-shadow: 0 2px 8px rgba(25, 33, 73, 0.06);
      margin-bottom: 1rem;
    }
    .header img { width: 48px; height: 48px; }
    .header-text { flex: 1; min-width: 200px; }
    .header h1 {
      margin: 0;
      font-size: 1.35rem;
      font-weight: 700;
      color: var(--argo-navy);
    }
    .header p { margin: 0.2rem 0 0; font-size: 0.85rem; color: var(--argo-muted); }
    .header-actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    .btn {
      border: none; border-radius: 8px; padding: 0.5rem 1rem;
      font-size: 0.875rem; font-weight: 600; cursor: pointer;
      transition: background 0.15s, transform 0.1s;
    }
    .btn:active { transform: scale(0.98); }
    .btn:disabled { opacity: 0.6; cursor: wait; }
    .btn-primary {
      background: var(--argo-orange);
      color: #fff;
    }
    .btn-primary:hover:not(:disabled) { background: var(--argo-orange-dark); }
    .btn-secondary {
      background: var(--argo-card);
      color: var(--argo-navy);
      border: 1px solid var(--argo-border);
    }
    .btn-secondary:hover:not(:disabled) { background: var(--argo-bg); }
    .card {
      background: var(--argo-card);
      border: 1px solid var(--argo-border);
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(25, 33, 73, 0.05);
      overflow: hidden;
    }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
    th {
      text-align: left; padding: 0.65rem 0.85rem;
      background: var(--argo-navy); color: #fff;
      font-weight: 600; white-space: nowrap;
    }
    td { padding: 0.6rem 0.85rem; border-bottom: 1px solid var(--argo-border); vertical-align: middle; }
    tr:hover td { background: #f8f9fd; }
    .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.8rem; }
    .nowrap { white-space: nowrap; }
    .muted { color: var(--argo-muted); white-space: nowrap; }
    .empty { padding: 2rem; text-align: center; color: var(--argo-muted); }
    .badge {
      display: inline-block; padding: 0.15rem 0.5rem;
      border-radius: 999px; font-size: 0.75rem; font-weight: 600;
    }
    .badge-healthy { background: #d4edda; color: #155724; }
    .badge-progressing { background: #fff3cd; color: #856404; }
    .badge-degraded { background: #f8d7da; color: #721c24; }
    .badge-unknown { background: #e9ecef; color: #495057; }
    .url-group { display: flex; gap: 0.35rem; align-items: center; }
    .url-input {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 0.8rem;
      padding: 0.45rem 0.65rem;
      border: 1px solid var(--argo-border);
      border-radius: 8px;
      background: var(--argo-bg);
      color: var(--argo-text);
      width: 26rem;
      max-width: 50vw;
      cursor: text;
    }
    .url-input:focus { outline: 2px solid var(--argo-orange); outline-offset: -1px; }
    .ingress-link {
      color: var(--argo-orange-dark);
      font-weight: 600; font-size: 0.8rem;
      text-decoration: none;
    }
    .ingress-link:hover { text-decoration: underline; }
    .status { font-size: 0.8rem; color: var(--argo-muted); min-height: 1.2em; }
    .status.err { color: #b02a37; }
  </style>
</head>
<body>
  <div class="page">
    <header class="header">
      <img src="${ARGOCD_LOGO_URL}" alt="Argo CD" width="48" height="48" />
      <div class="header-text">
        <h1>Argo CD applications</h1>
        <p>GitOps apps for this Cycloid organization</p>
      </div>
      <div class="header-actions">
        <div class="url-group">
          <input type="text" readonly class="url-input" id="argo-url" value="${escapeHtml(consoleUrl)}" />
          <button type="button" class="btn btn-secondary" id="btn-copy-url">Copy URL</button>
        </div>
        <button type="button" class="btn btn-primary" id="btn-refresh">Refresh</button>
      </div>
    </header>
    <p class="status" id="status" aria-live="polite"></p>
    <section class="card">${table}</section>
  </div>
  <script>
    // Cycloid plugin iframe is sandboxed without allow-popups-to-escape-sandbox.
    // Any new tab opened from here inherits the sandbox (localStorage blocked →
    // ArgoCD JS crashes). We cannot open a working ArgoCD tab from this context.
    // Instead, show the URL and let the user paste it in a fresh tab.
    const urlInput = document.getElementById("argo-url");
    const copyBtn = document.getElementById("btn-copy-url");
    urlInput?.addEventListener("click", () => { urlInput.select(); });
    copyBtn?.addEventListener("click", () => {
      const url = urlInput?.value || "";
      if (!url) return;
      urlInput.select();
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(url).then(() => {
          copyBtn.textContent = "Copied!";
          setTimeout(() => { copyBtn.textContent = "Copy URL"; }, 1500);
        }).catch(() => {
          document.execCommand("copy");
          copyBtn.textContent = "Copied!";
          setTimeout(() => { copyBtn.textContent = "Copy URL"; }, 1500);
        });
      } else {
        document.execCommand("copy");
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy URL"; }, 1500);
      }
    });
    const btn = document.getElementById("btn-refresh");
    const statusEl = document.getElementById("status");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      statusEl.className = "status";
      statusEl.textContent = "Refreshing manifests in Argo CD and updating the table…";
      try {
        // Use path relative to the iframe document. The Cycloid proxy serves
        // the plugin at /iframe/… on the container; the browser sees a deep
        // console URL. A bare "./api/refresh" resolves against that deep URL,
        // keeping the same origin + proxy path so the request reaches us.
        const base = window.location.pathname.replace(/\/$/, "");
        const res = await fetch(base + "/api/refresh", {
          method: "POST",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Refresh failed (" + res.status + ")");
        statusEl.textContent = "Done — reloaded.";
        location.reload();
      } catch (err) {
        statusEl.className = "status err";
        statusEl.textContent = err.message || String(err);
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

// ─── Refresh + resync ─────────────────────────────────────────────────────────
let resyncRunning = false;

async function refreshAllApps(): Promise<{ refreshed: number; failed: number }> {
  if (!ARGOCD_USERNAME || !ARGOCD_PASSWORD || !CYCLOID_ORG_SLUG) {
    throw new Error("missing configuration");
  }
  const org = CYCLOID_ORG_SLUG;
  const conn = argocdConnection(org);
  const token = await argocdLogin(conn);
  const apps = await argocdListApps(conn, token);
  let refreshed = 0;
  let failed = 0;
  for (const app of apps) {
    const name = app.metadata?.name ?? "";
    if (!name) continue;
    try {
      await argocdRefreshApp(conn, token, name);
      refreshed++;
      console.log(`[INFO] refresh: hard refresh queued for '${name}'`);
    } catch (err) {
      failed++;
      console.warn(`[WARN] refresh ${name}: ${(err as Error).message}`);
    }
  }
  // Give the Argo CD controller a moment to reconcile after refresh.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return { refreshed, failed };
}

// ─── Resync ───────────────────────────────────────────────────────────────────

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
        console.log(
          `[INFO] no component mapping for app '${name}': not '${org}-…', skipping`,
        );
        skipped++;
        continue;
      }
      // Resolve env when name format is <org>-<component> (no env segment).
      // Try: ArgoCD labels → namespace parse → fallback "default".
      let env = parsed.env;
      if (!env) {
        const labels = app.metadata?.labels ?? {};
        env =
          labels["cycloid.io/env"] ??
          labels["env"] ??
          labels["environment"] ??
          "";
      }
      if (!env) {
        const nsParsed = parseAppName(app.spec?.destination?.namespace ?? "", org);
        if (nsParsed?.env) env = nsParsed.env;
      }
      if (!env) env = "default";
      const list = byEnv.get(env) ?? [];
      list.push({ app, env, component: parsed.component });
      byEnv.set(env, list);
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
          (id, name, component, sync_status, health_status, namespace, last_synced, url,
           project, revision, cluster, resources, ingress_url, environment_id)
        VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      let inserted = 0;
      for (const [env, list] of byEnv) {
        const envId = `env-${org}-${env}`;
        insertEnv.run(envId, env, orgId);
        deleteAppsForEnv.run(envId);
        for (const { app, component } of list) {
          const name = app.metadata?.name ?? "";
          const project = argocdProject(app);
          insertApp.run(
            `${envId}-${name}`,
            name,
            component,
            app.status?.health?.status ?? "",
            app.spec?.destination?.namespace ?? "",
            extractLastSynced(app),
            argocdAppUrl(conn, project, name),
            project,
            "",
            extractCluster(app),
            "",
            extractIngressUrl(app, org, env, component),
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

  if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    const consoleUrl = CYCLOID_ORG_SLUG
      ? argocdConsoleUrl(argocdConnection(CYCLOID_ORG_SLUG))
      : "";
    return send(res, 200, renderAppsPage(listAppsFromDb(), consoleUrl), "text/html; charset=utf-8");
  }

  if (method === "POST" && (pathname === "/api/refresh" || pathname === "api/refresh")) {
    (async () => {
      try {
        const refresh = await refreshAllApps();
        const sync = await resync();
        if (!sync.started) {
          send(res, 500, {
            ok: false,
            error: sync.reason ?? "resync failed",
            refreshed: refresh.refreshed,
          });
          return;
        }
        send(res, 200, {
          ok: true,
          refreshed: refresh.refreshed,
          refresh_failed: refresh.failed,
          apps: sync.apps,
          skipped: sync.skipped,
        });
      } catch (err) {
        send(res, 500, { ok: false, error: (err as Error).message });
      }
    })();
    return;
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
