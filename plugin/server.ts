import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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

function normaliseDbFile(raw: string | undefined): string {
  const v = raw?.trim();
  if (!v) return ":memory:";
  if (v.startsWith("file:")) return v.slice("file:".length) || ":memory:";
  return v;
}
const DB_FILE = normaliseDbFile(process.env.DB_FILE);

// ─── Startup diagnostic ───────────────────────────────────────────────────────
// 1.5.x is an investigation build. Log everything we can about the runtime so
// we can figure out where (org, env) actually arrive from.
(() => {
  console.log(`[DIAG] node version: ${process.version}`);
  console.log(
    `[DIAG] credentials presence: ARGOCD_USERNAME=${Boolean(ARGOCD_USERNAME)} ARGOCD_PASSWORD=${Boolean(ARGOCD_PASSWORD)}`,
  );

  const SYSTEM_NAMES = new Set([
    "PATH", "HOME", "HOSTNAME", "PWD", "SHELL", "SHLVL", "TERM",
    "LANG", "LC_ALL", "TZ", "USER", "LOGNAME", "OLDPWD",
    "NODE_VERSION", "NODE_OPTIONS", "YARN_VERSION", "NPM_CONFIG_LOGLEVEL",
  ]);
  const injected = Object.keys(process.env)
    .filter((k) => !SYSTEM_NAMES.has(k))
    .filter((k) => !k.startsWith("npm_") && !k.startsWith("_"))
    .sort();
  console.log(`[DIAG] all injected env var names: ${injected.join(", ")}`);

  // Print VALUES too, with credentials redacted, so we can spot whatever the
  // Plugin Manager is shoving in here.
  const REDACT = /PASSWORD|SECRET|TOKEN|KEY/i;
  for (const k of injected) {
    const v = process.env[k] ?? "";
    const shown = REDACT.test(k) && v ? `<redacted len=${v.length}>` : v;
    console.log(`[DIAG] env ${k}=${shown}`);
  }
})();

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA foreign_keys = ON");
const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
db.exec(schema);
console.log(`[INFO] sqlite ready (file=${DB_FILE})`);

// ─── HTTP server (diagnostic-heavy) ──────────────────────────────────────────
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

function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const start = Date.now();
  const method = req.method ?? "GET";
  const rawUrl = req.url ?? "/";
  const url = new URL(rawUrl, `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname.replace(/^\/iframe/, "") || "/";

  // Read the body up-front for ALL non-GET requests so we can log it.
  let body = "";
  if (method !== "GET" && method !== "HEAD") {
    try {
      body = await collectBody(req);
    } catch (e) {
      console.error(`[DIAG] body read error: ${(e as Error).message}`);
    }
  }

  // Headers, with credential-shaped values redacted.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers[k] = v;
    else if (Array.isArray(v)) headers[k] = v.join(", ");
  }
  const redactedHeaders = { ...headers };
  for (const k of Object.keys(redactedHeaders)) {
    if (/authorization|cookie|secret|token|key/i.test(k)) {
      redactedHeaders[k] = `<redacted len=${redactedHeaders[k].length}>`;
    }
  }

  // Comprehensive request log.
  console.log(`[DIAG] ===== ${method} ${rawUrl} =====`);
  if (url.search) {
    console.log(`[DIAG] query: ${JSON.stringify(Object.fromEntries(url.searchParams))}`);
  }
  console.log(`[DIAG] headers: ${JSON.stringify(redactedHeaders)}`);
  if (body) {
    // Cap the body log to 4 KiB so we don't blow up the log on giant events.
    const truncated = body.length > 4096 ? `${body.slice(0, 4096)}…(truncated ${body.length} bytes)` : body;
    console.log(`[DIAG] body: ${truncated}`);
  }

  res.on("finish", () => {
    const ms = Date.now() - start;
    const level =
      res.statusCode >= 500 ? "ERROR" : res.statusCode >= 400 ? "WARN" : "INFO";
    console.log(`[${level}] ${method} ${pathname} → ${res.statusCode} (${ms}ms)`);
  });

  if (method === "GET" && pathname === "/_cy/ping") return send(res, 200, { ok: true });
  if (method === "POST" && pathname === "/_cy/events") return send(res, 200, { ok: true });
  if (method === "DELETE" && pathname === "/_cy/plugin") return send(res, 200, { ok: true });
  if (method === "POST" && pathname === "/_cy/resync") return send(res, 200, { started: true });

  send(res, 404, "Not Found", "text/plain; charset=utf-8");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[INFO] listening on http://0.0.0.0:${port}`);
});
