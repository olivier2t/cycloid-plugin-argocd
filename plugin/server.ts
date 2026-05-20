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

const ARGOCD_URL = process.env.ARGOCD_URL?.trim() ?? "";
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN?.trim() ?? "";
const CYCLOID_ORG_SLUG = process.env.CYCLOID_ORG_SLUG?.trim() ?? "";
const CYCLOID_ENV_SLUG = process.env.CYCLOID_ENV_SLUG?.trim() ?? "";
const DB_FILE = process.env.DB_FILE?.trim() || ":memory:";

const SYNC_INSECURE_TLS = process.env.ARGOCD_INSECURE_TLS === "true";

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA foreign_keys = ON");

const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
db.exec(schema);
console.log(`[INFO] sqlite ready (file=${DB_FILE})`);

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

function fetchArgoCDApps(): Promise<ArgoApp[]> {
  return new Promise((resolve, reject) => {
    if (!ARGOCD_URL || !ARGOCD_TOKEN) {
      reject(new Error("ARGOCD_URL or ARGOCD_TOKEN not set"));
      return;
    }
    const target = new URL("/api/v1/applications", ARGOCD_URL);
    const isHttps = target.protocol === "https:";
    const request = isHttps ? httpsRequest : httpRequest;
    const req = request(
      target,
      {
        method: "GET",
        headers: { authorization: `Bearer ${ARGOCD_TOKEN}` },
        // Self-signed ArgoCD installations are common; opt-in via env var.
        rejectUnauthorized: isHttps ? !SYNC_INSECURE_TLS : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`ArgoCD HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            const parsed = JSON.parse(body) as { items?: ArgoApp[] };
            resolve(parsed.items ?? []);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ─── Resync ───────────────────────────────────────────────────────────────────
let resyncRunning = false;

async function resync(): Promise<{ started: boolean; reason?: string }> {
  if (resyncRunning) return { started: false, reason: "already running" };
  if (!ARGOCD_URL || !ARGOCD_TOKEN || !CYCLOID_ORG_SLUG || !CYCLOID_ENV_SLUG) {
    return { started: false, reason: "missing configuration" };
  }
  resyncRunning = true;

  try {
    console.log("[INFO] resync: starting");
    const apps = await fetchArgoCDApps();
    console.log(`[INFO] resync: fetched ${apps.length} apps from ArgoCD`);

    const orgId = `org-${CYCLOID_ORG_SLUG}`;
    const envId = `env-${CYCLOID_ORG_SLUG}-${CYCLOID_ENV_SLUG}`;
    const baseUrl = ARGOCD_URL.replace(/\/+$/, "");

    db.exec("BEGIN");
    try {
      // Cascade DELETE wipes environments + argocd_apps via FK ON DELETE CASCADE.
      db.exec("DELETE FROM organizations");

      db.prepare("INSERT INTO organizations (id, slug) VALUES (?, ?)")
        .run(orgId, CYCLOID_ORG_SLUG);

      db.prepare(
        "INSERT INTO environments (id, slug, organization_id) VALUES (?, ?, ?)",
      ).run(envId, CYCLOID_ENV_SLUG, orgId);

      const insertApp = db.prepare(`
        INSERT INTO argocd_apps
          (id, name, sync_status, health_status, namespace, last_synced, url, environment_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

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
      }
      db.exec("COMMIT");
      console.log(`[INFO] resync: completed (${apps.length} rows)`);
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
    // Run async; respond immediately with start status. The Plugin Manager
    // doesn't wait for completion.
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
  // Kick off an initial sync once the server is up. Fire-and-forget; failures
  // are logged but don't crash the container.
  resync().then(
    (r) => console.log(`[INFO] initial sync: ${JSON.stringify(r)}`),
    (e) => console.error(`[ERROR] initial sync: ${e}`),
  );
});
