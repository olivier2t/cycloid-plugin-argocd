# Cycloid plugin — ArgoCD

A minimal Cycloid plugin that adds an **ArgoCD** tab on every Cycloid
component. The tab embeds the ArgoCD app‑of‑apps view served at:

```
https://argocd.<org>-<env>.demo.cycloid.io/applications/argocd/app-of-apps
```

`<org>` and `<env>` are filled in by Cycloid from the current component's
organization and environment canonicals.

## Files

| File             | Purpose                                                              |
|------------------|----------------------------------------------------------------------|
| `manifest.yaml`  | Plugin metadata (no install‑time configuration is needed).           |
| `widgets.yaml`   | Single `iframe` widget with `placement: component`, tab name `ArgoCD`.|
| `server.ts`      | ~50‑line Node 22 server using only `node:http` and `node:fs`.        |
| `index.html`     | Reads `org`/`env` from the query string and renders the iframe.      |
| `Dockerfile`     | `node:22-alpine`, runs the TS file with `--experimental-strip-types`.|
| `package.json`   | Declares `type: module`. No dependencies, no scripts.                |

No Bun, no `just`, no third‑party libraries, no build step.

## How it works

1. The plugin container exposes the four Cycloid platform endpoints
   (`GET /_cy/ping`, `POST /_cy/events`, `DELETE /_cy/plugin`,
   `POST /_cy/resync`) and a single application route at `GET /` that
   returns `index.html`.
2. `widgets.yaml` declares an `iframe` widget on `placement: component`.
   Cycloid renders the widget as a tab named **ArgoCD** inside every
   component page and loads the plugin container at:

   ```
   /?org=<org-canonical>&env=<env-canonical>
   ```
3. `index.html` reads `org` and `env` from `URLSearchParams`, builds the
   ArgoCD URL, and inserts a full‑viewport `<iframe>` pointing at it.

## Build, push, install

```sh
# Build (assumes you're inside plugin/)
docker build -t cycloid-docker-registry:5000/cycloid/argocd:0.1.0 .

# Push to the Cycloid Docker registry
docker push cycloid-docker-registry:5000/cycloid/argocd:0.1.0

# Register and install via cy CLI
cy plugin registry plugin create internal --name argocd
cy plugin registry plugin version publish internal argocd \
  --docker-image cycloid-docker-registry:5000/cycloid/argocd:0.1.0
cy plugin install --version-id <id>
```

The image tag must be a valid semantic version (e.g. `0.1.0`).

## Local development

```sh
PORT=8080 node --experimental-strip-types --watch server.ts
# then open: http://localhost:8080/?org=acme&env=staging
```

The four `/_cy/*` endpoints can be smoke‑tested with curl:

```sh
curl -fsS http://localhost:8080/_cy/ping
curl -fsS -X POST http://localhost:8080/_cy/events
curl -fsS -X POST http://localhost:8080/_cy/resync
curl -fsS -X DELETE http://localhost:8080/_cy/plugin
```

## About the “your connection is not private” warning

If `argocd.<org>-<env>.demo.cycloid.io` does not present a TLS certificate
your browser trusts, the iframe will be blocked by the browser's "Your
connection is not private" interstitial.

**This cannot be bypassed from JavaScript.** Browsers explicitly forbid pages
from suppressing or auto‑clicking through the TLS interstitial — it's a hard
security boundary, not a quirk of how this plugin is written. There is no
HTML, JS, or iframe attribute that disables it.

The realistic fixes, in order of preference:

1. **Install a valid TLS certificate** on the ArgoCD ingress. Easiest options:
   - cert‑manager + Let's Encrypt (HTTP‑01 or DNS‑01 challenge), or
   - a wildcard certificate covering `*.demo.cycloid.io`, or
   - an internal CA whose root cert is already trusted by users' browsers.
2. **Accept the certificate exception once per host.** Have each user open
   `https://argocd.<org>-<env>.demo.cycloid.io` directly in the same browser,
   click *Advanced* → *Proceed to host (unsafe)*. The browser remembers the
   exception per‑host afterwards and the iframe loads normally.
3. **Reverse‑proxy ArgoCD through this plugin container.** The plugin can call
   ArgoCD over HTTPS with `rejectUnauthorized: false` (Node's `https.request`)
   and re‑serve the response under the plugin's own (valid) origin, so the
   browser only ever sees the trusted Cycloid certificate. This requires
   proxying HTTP, WebSocket upgrades (ArgoCD streams live status updates over
   WS), and rewriting absolute URLs in HTML/JS responses, so it adds a few
   hundred lines and changes ArgoCD's required configuration. It is **not**
   included in this minimal plugin — open an issue if you need it.
