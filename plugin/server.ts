import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

// PORT is always injected by the Cycloid Plugin Manager — there is no default.
// We fail fast if it is missing so the registry validation reports the issue.
const port = Number(process.env.PORT);
if (!Number.isFinite(port) || port <= 0) {
  console.error("FATAL: PORT environment variable is not set or is invalid");
  process.exit(1);
}

const HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8");

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
  // Cycloid forwards iframe traffic with an /iframe prefix; strip it so the
  // plugin sees the same paths whether it's hit directly or via the platform.
  const pathname = url.pathname.replace(/^\/iframe/, "") || "/";

  res.on("finish", () => {
    const ms = Date.now() - start;
    const level =
      res.statusCode >= 500 ? "ERROR" : res.statusCode >= 400 ? "WARN" : "INFO";
    console.log(`[${level}] ${method} ${pathname} → ${res.statusCode} (${ms}ms)`);
  });

  // Required Cycloid plugin platform hooks.
  if (method === "GET"    && pathname === "/_cy/ping")    return send(res, 200, { ok: true });
  if (method === "POST"   && pathname === "/_cy/events")  return send(res, 200, { ok: true });
  if (method === "DELETE" && pathname === "/_cy/plugin")  return send(res, 200, { ok: true });
  if (method === "POST"   && pathname === "/_cy/resync")  return send(res, 200, { started: false });

  // Iframe entry point.
  if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    return send(res, 200, HTML, "text/html; charset=utf-8");
  }

  send(res, 404, "Not Found", "text/plain; charset=utf-8");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[INFO] Listening on http://0.0.0.0:${port}`);
});
