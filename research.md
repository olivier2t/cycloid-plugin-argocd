# Research — Cycloid plugin for ArgoCD (no Bun, no Just, no deps)

This document captures everything I learned by:

1. Reading the current contents of this repository in depth.
2. Reading the Cycloid plugin documentation linked in the prompt
   ([Plugins overview](https://docs.cycloid.io/reference/plugins/),
   [Writing a plugin](https://docs.cycloid.io/reference/plugins/concepts/writing-a-plugin),
   [Plugin Registry](https://docs.cycloid.io/reference/plugins/concepts/plugin-registry),
   [Plugin Manager](https://docs.cycloid.io/reference/plugins/concepts/plugin-manager),
   [Managing plugins](https://docs.cycloid.io/reference/plugins/concepts/managing-plugins),
   [Manifest reference](https://docs.cycloid.io/reference/plugins/reference/manifest),
   [Widgets reference](https://docs.cycloid.io/reference/plugins/reference/widgets),
   [HTTP API reference](https://docs.cycloid.io/reference/plugins/reference/http-api),
   [Permissions](https://docs.cycloid.io/reference/plugins/reference/permissions),
   [CLI reference](https://docs.cycloid.io/reference/plugins/reference/cli),
   [Hello World cookbook](https://docs.cycloid.io/cookbook/plugins/install-hello-world),
   [Self‑hosted infrastructure](https://docs.cycloid.io/cookbook/dedicated-platform/advanced-configurations/infrastructure/plugins)).

It is intentionally written *before* writing any code, to fix the design and make
the eventual implementation straightforward.

---

## 1. State of this repository today

The repo is named `cycloid-plugin-argocd`, but the code currently in the tree is
**not** an ArgoCD plugin. It is an unrelated plugin called **“Control Plane”**
that manages OIDC credentials and triggers rotation pipelines. We can keep it as
historical reference, but it has to be replaced by an ArgoCD plugin.

### 1.1 Files in the repo

| Path | What it is | Keep / drop |
|---|---|---|
| `manifest.yaml` | Plugin configuration form (API key, org, regex, glob, pipeline patterns, pipeline job). | Replace — fields are OIDC‑specific. |
| `widgets.yaml` | One `iframe` widget on `sideMenuPage` titled “Control Plane”. The query injects `api_url` and `console_url` from Cycloid into the iframe URL. | Keep the *shape* (iframe + sideMenuPage), rewrite copy. |
| `Dockerfile` | `oven/bun:1-slim` base, copies sources, runs `bun run /plugin/server.ts`. | Replace — must be a Node‑only Dockerfile, no Bun. |
| `package.json` | Declares `@types/bun` and a `bun run --watch` script. | Replace — strip Bun, no third‑party deps. |
| `bun.lock` | Bun lockfile. | Delete. |
| `server.ts` | 585 LOC. Uses `Bun.serve` for HTTP, embeds an entire vanilla‑JS SPA in a `HTML` template literal, exposes both `/_cy/*` plugin hooks and a custom `/api/*` JSON API consumed by the iframe. | Rewrite using Node’s built‑in `node:http`, smaller scope (ArgoCD), no Bun globals. |
| `cycloid-api.ts` | Thin client around `CY_API_URL` + `Bearer ${CY_API_KEY}`. Lists orgs/credentials, updates credentials, triggers/queries Cycloid pipelines. | Drop — out of scope for ArgoCD plugin. |
| `pipeline-resolver.ts` | Parses credential canonicals to `(project, env, component)` via regexes from `CY_PIPELINE_PATTERNS`. Note the cute trick of converting Go/Python `(?P<name>…)` to JS `(?<name>…)`. | Drop. |
| `justfile` | `dev`, `docker-build`, `tag`, `smoke-test`, `docker-push`, `publish-registry`. The publish recipe is the most useful piece — it `kubectl port-forward`s `svc/docker-registry`, reads the password from the `plugin-registry` Secret, `docker login`s to `localhost:5000`, then pushes. | Drop the `justfile`; replace with a tiny shell script (or just `README.md` instructions) that does the same flow without `just`. |
| `dev.md` | Local dev notes. | Rewrite for the new plugin. |
| `README.md` | Two lines, accurate. | Update. |

### 1.2 Patterns worth carrying over from the current code

Even though the current plugin gets deleted, several patterns it implements are
load‑bearing for *any* Cycloid iframe plugin and we should re‑use them:

1. **`/_cy/*` is the plugin contract.** The current server answers all four
   required endpoints with `{ ok: true }` (or `{ started: false }` for resync).
   For an ArgoCD plugin that doesn’t store data, the same trivial responses are
   fine.
2. **Strip the `/iframe` path prefix.** When Cycloid serves the plugin inside a
   side‑menu iframe, requests come in under
   `/organizations/<org>/plugin_widgets/<id>/jwt/...` and the platform forwards
   them to the container with an `/iframe` prefix. The current code does
   `pathname.replace(/^\/iframe/, "")` — we need the same.
3. **Rewrite root‑relative `fetch()` from inside the iframe.** Browser code
   loaded inside the iframe at a deep URL like
   `https://console.cycloid.io/organizations/foo/plugin_widgets/42/jwt/` will
   resolve `fetch('/api/x')` against `console.cycloid.io`, not the plugin
   container. The existing UI patches `window.fetch` to prepend
   `window.location.pathname` to root‑relative paths. This is essential.
4. **Read the iframe URL query string for runtime context.** `widgets.yaml`’s
   `query:` template uses `($ .api_url $)` and `($ .console_url $)` placeholders
   that the platform substitutes per‑install. The container just reads them from
   `URLSearchParams`. We can use the same mechanism to pass an ArgoCD URL into
   the iframe if we want, but for the simple plugin we will pass it via env vars
   from `manifest.yaml` instead.
5. **Logging shape.** The current server logs `[INFO|WARN|ERROR] METHOD PATH →
   STATUS (ms)`. Worth keeping — the Plugin Manager captures stdout/stderr and
   shows it in the UI.

### 1.3 Anti‑patterns to avoid in the new plugin

- **Bun globals everywhere.** `Bun.serve(...)` and `Bun.file(...)` lock the code
  to the Bun runtime. Using `node:http` is one extra import and works
  everywhere.
- **Embedding the full UI as a JS string in a `.ts` file.** Fine for a tiny
  plugin, but if the UI grows it becomes unreadable. For a small ArgoCD iframe
  we will keep a separate `index.html` and read it at startup with `fs`. That is
  still zero dependencies and much friendlier to edit.
- **Hard‑coded constants littered across files.** The current plugin has
  separate state for `_apiUrl` and `_consoleUrl` mutated from request handlers.
  We will keep config strictly read from env at boot in the new plugin.
- **A heavy `justfile` for what is really `docker build && docker push`.** The
  user explicitly does not want `just`. A 20‑line shell script (or just
  documented commands) is enough.

---

## 2. What the Cycloid plugin platform actually requires

Distilled from the eight documentation pages.

### 2.1 Architecture (three services, all internal)

| Service | Internal address | Role |
|---|---|---|
| Docker Registry | `cycloid-docker-registry:5000` | Stores plugin container images. Can be the bundled one or external (Nexus/Harbor/…). |
| Plugin Registry | `http://cycloid-plugin-registry:4000` | Catalog. Pulls images, validates `/plugin/*` files, starts the container, checks the endpoints. Only validated versions can be installed. Shared catalog: every org connected to the same registry sees the same list of plugins. |
| Plugin Manager | `http://cycloid-plugin-manager:4000` | Runtime. Deploys plugin containers, injects config, proxies to Cycloid backend, captures logs, recovers plugins on restart. |

This stack is **only available on dedicated/self‑hosted Cycloid installations**.
On SaaS the plugin system is not available at all — worth keeping in mind for
distribution.

Org access is driven by a comma‑separated `cycloid_plugins_orgs_cans` (Ansible)
or `orgsCans` value. Listed orgs get write access on the registry and are
auto‑invited on the manager. Other orgs can be invited to the manager only via
its API (`POST http://localhost:4000/organizations '{"canonical":"…"}'`).

### 2.2 Container contract

A plugin is just a Docker image with a specific filesystem layout and a small
HTTP API.

#### Required files (read by the registry at validation time)

```text
/plugin/
  manifest.yaml   # required — plugin metadata & install form
  widgets.yaml   # required — UI surface
  schema.sql     # optional — SQLite3 DDL for table widgets
```

#### Required HTTP endpoints (checked by the registry, served by the manager)

| Method | Path | Semantics |
|---|---|---|
| `GET` | `/_cy/ping` | 2xx ⇒ healthy. Used continuously by the Plugin Manager. |
| `POST` | `/_cy/events` | Receives events from Cycloid. May have a TTL. We can no‑op it. |
| `DELETE` | `/_cy/plugin` | Called on uninstall — chance to clean up extra state. |
| `POST` | `/_cy/resync` | Rebuild/reimport all plugin data. For an iframe‑only plugin we just return `{ started: false }` or 200 OK. |

Constraints:

- The container **must listen on `process.env.PORT`**. There is no default —
  the value is always provided by the Plugin Manager at start‑up. We should
  fail fast (or at least log a warning) if it is missing.
- The container **must be ready within 2 minutes**, otherwise the version is
  marked failed.
- Anything else the plugin exposes is fair game — additional routes can be
  called from iframe widgets or used as webhooks.

#### Communicating back to Cycloid

The Plugin Manager injects two extra env vars at deploy time:

- `PROXY_URL` — base URL of the proxy back to Cycloid.
- `PLUGIN_SECRET` — per‑plugin secret.

Calls go to `${PROXY_URL}/<backend-path>?secret=${PLUGIN_SECRET}`. The manager
verifies the secret, attaches a signed JWT, and forwards to the Cycloid
backend. **For a pure iframe ArgoCD plugin we don’t need this** — we don’t talk
to Cycloid, we talk to ArgoCD. But we should still document it because users
may want to enrich the iframe with Cycloid context.

### 2.3 `manifest.yaml` (StackForms‑shaped install form)

Top‑level keys:

```yaml
description:   string          # human‑readable
icon:          string          # icon URL
images:        [string]        # screenshots
configuration: [field]         # install form fields
relations:     [relation]      # optional, scoping
```

Each `configuration` field has:

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Display label. |
| `key` | yes | Internal id. **Capitalised at deploy time → env var.** E.g. `argocd_url` becomes `ARGOCD_URL`. |
| `widget` | yes | StackForms widget (e.g. `simple_text`). |
| `type` | yes | Value type (`string`, …). |
| `description` | no | Help text. |
| `required` | no | Boolean. |
| `default` | no | Pre‑filled value. |

`relations` declare entity selectors (e.g. `selector: "p.slug"` for project
slug) so widget queries / iframe URL templates can be parameterised by the
current entity. Optional and not needed for the simple ArgoCD plugin.

### 2.4 `widgets.yaml` (the UI surface)

Top‑level is a YAML list. Each entry is a widget with three blocks: `type`,
`placement`, `widget`.

#### Allowed `type`

- `table` — SQL query against the plugin’s SQLite database. Requires
  `widget.columns` (≥ 1, each with `value`, `title`, `type`).
- `iframe` — `widget.query` is a path served by the plugin container (e.g.
  `/ui/dashboard`). The platform substitutes `($ .relation $)` placeholders and
  appends a JWT, then loads it in an `<iframe>`.

#### Allowed `placement.type`

| `placement.type` | Required `placement.config` | Optional |
|---|---|---|
| `component` | `tab_name` | — |
| `sideMenuPage` | `title`, `description` | `icon` |

For an ArgoCD plugin, **`type: iframe` + `placement.type: sideMenuPage`** is
the right shape. It gives a top‑level entry in the org sidebar that opens a
full‑page iframe where the plugin’s UI lives.

The `widget.query` line (despite being called `query`) is just the container
path + query string the iframe should be loaded with. Exactly like the current
code, we can pass runtime context through it:

```yaml
widget:
  query: "/?api_url=($ .api_url $)"
```

The right‑hand side is rendered server‑side; what reaches the container is a
plain query string.

### 2.5 `schema.sql` (optional)

SQLite3 DDL. Only needed if the plugin has `table` widgets. The registry
validates by executing it against an in‑memory SQLite at registration time. We
**don’t need it** for the simple iframe ArgoCD plugin and will omit the file.

### 2.6 Image URL & versioning rules

- Image URL host:port must match the Docker Registry the registry was
  configured with.
- Tag **must be valid semver** (e.g. `1.0.0`, `0.3.1-beta`). Otherwise the
  registry rejects the version with `invalid version`.
- Adding a version uses `cy plugin registry plugin version publish` (CLI),
  Terraform `cycloid_plugin_version`, or the UI (Settings → Browse Plugins →
  plugin → Versions → Add version).

### 2.7 Lifecycle commands worth knowing

- `cy plugin registry add --name … --url …`
- `cy plugin registry plugin create <registry> --name <plugin>`
- `cy plugin registry plugin version publish <registry> <plugin> --docker-image …`
- `cy plugin install --version-id <id> --config key=value`
- `cy plugin logs <plugin>` — runtime logs from the container (the same stdout
  the Plugin Manager captures and shows in the UI).
- `cy plugin uninstall <plugin>` / `cy plugin upgrade --version-id <id>`.

### 2.8 Permissions (for context, not blockers for plugin authoring)

Most of the time we’ll be using an Owner role. Notable per‑action permissions:
`organization:plugin:create`, `organization:plugin:install`,
`organization:plugin_manager_deployment:create`,
`organization:plugin_manager_deployment:logs`,
`organization:plugin_manager_deployment:data` (for resync). These matter for
giving non‑Owner users access to the plugin lifecycle — not for writing the
plugin itself.

---

## 3. Implications for the new ArgoCD plugin

### 3.1 Scope (what the plugin will *do*)

Goal: a tiny iframe plugin that embeds an existing ArgoCD UI/dashboard in
Cycloid’s side menu.

The simplest viable behaviour:

1. Operator installs the plugin and provides an `argocd_url` (and maybe an
   `argocd_app_path` and a display title) in the install form.
2. The plugin container ships a tiny HTML page that iframes that URL.
3. The plugin appears in the Cycloid org sidebar as a single entry, opens a
   full‑page iframe pointing at the ArgoCD UI.

This keeps:

- Zero third‑party libraries.
- Zero data fetched from ArgoCD by the plugin itself (no auth proxying, no
  CORS, no SQLite).
- Zero use of the Cycloid `PROXY_URL`/`PLUGIN_SECRET` mechanism.

If we want to grow it later (e.g. show app status from ArgoCD’s API), we have a
clean place to add an `/api/*` route in the same Node server.

### 3.2 Files to ship in the new repo

```
/
├─ Dockerfile           # node:22-alpine, copies sources, runs `node --experimental-strip-types server.ts`
├─ manifest.yaml        # ArgoCD‑specific config fields
├─ widgets.yaml         # one iframe widget on a sideMenuPage
├─ server.ts            # node:http server, no deps
├─ index.html           # tiny static page that mounts the iframe
├─ package.json         # name, version, type:module — no dependencies, no devDependencies
├─ README.md            # what the plugin is + install instructions
└─ research.md          # this file
```

No `bun.lock`, no `justfile`, no `package-lock.json` (we have no deps).

### 3.3 Dockerfile shape (no Bun, no third‑party tooling)

Two viable Node base options:

| Base image | Why | Why not |
|---|---|---|
| `node:22-alpine` | Smallest. Node 22+ supports running `.ts` directly with `--experimental-strip-types`. | Need to remember the `--experimental-strip-types` flag at runtime. |
| `node:lts-alpine` | Future‑proof. | Same flag applies until type stripping goes stable. |

Plan: `FROM node:22-alpine`, `WORKDIR /plugin`, copy the small source set, run
`node --experimental-strip-types server.ts`. The container reads `PORT`,
`ARGOCD_URL`, etc. from env. No `npm install`, because there are no deps.

Sanity assertions in the build (mirroring the existing Dockerfile’s pattern):

```dockerfile
RUN test -f /plugin/manifest.yaml && test -f /plugin/widgets.yaml
```

### 3.4 `server.ts` shape (Node built‑ins only)

- Use `node:http` (`createServer`) and `node:fs` (`readFileSync` once at
  start‑up to load `index.html`).
- Bind to `0.0.0.0:Number(process.env.PORT)`. Fail fast if `PORT` is not set.
- Routes:
  - `GET /_cy/ping` → `200 {"ok":true}`.
  - `POST /_cy/events` → `200 {"ok":true}`.
  - `DELETE /_cy/plugin` → `200 {"ok":true}`.
  - `POST /_cy/resync` → `200 {"started":false}` (we have no data to resync).
  - `GET /` (and `GET /index.html`) → return the in‑memory HTML.
  - Anything else → `404 Not Found`.
- Strip the `/iframe` prefix from `req.url` (see §1.2.2) before matching
  routes.
- Log one line per request: method, path, status, latency.

### 3.5 `index.html` shape

- One full‑viewport `<iframe>`.
- Reads `argocd_url` from either `URLSearchParams` (if we choose to pass it
  through `widgets.yaml`) or from a small `<script>` block whose value the
  server templated in at boot from `process.env.ARGOCD_URL`. Picking the
  template approach removes the need to expose env vars over a JSON endpoint.
- A 1‑line CSS reset so the iframe takes the whole viewport with no border.
- No JS framework, no fetch — purely declarative HTML.

### 3.6 `manifest.yaml` shape

Keys to expose (capitalised → env vars in the container):

| `key` | Required | Default | Description |
|---|---|---|---|
| `argocd_url` | yes | — | Base URL of the ArgoCD UI to embed (e.g. `https://argocd.example.com`). |
| `argocd_path` | no | `/applications` | Path appended to `argocd_url` when the iframe loads. |
| `display_title` | no | `ArgoCD` | Sidebar entry title (purely cosmetic — matched in `widgets.yaml`). |

We will **not** add an API key field. The simple plugin doesn’t hit ArgoCD’s
API; the iframe relies on the user’s existing ArgoCD auth (cookie / SSO) when
loaded in the browser.

### 3.7 `widgets.yaml` shape

```yaml
- type: iframe
  placement:
    type: sideMenuPage
    config:
      title: ArgoCD
      description: View ArgoCD applications inside Cycloid
  widget:
    query: "/"
```

We don’t need the `($ .api_url $)` template because we’re not calling the
Cycloid API. If later we want to scope to a project we can introduce a
`relations:` block in `manifest.yaml` and reference it here.

### 3.8 Build & publish (replacing the `justfile`)

Documented commands in `README.md`:

```bash
docker build -t cycloid/plugin-argocd:0.1.0 .
docker tag cycloid/plugin-argocd:0.1.0 cycloid-docker-registry:5000/cycloid/plugin-argocd:0.1.0
docker push cycloid-docker-registry:5000/cycloid/plugin-argocd:0.1.0
```

…then in Cycloid:

```bash
cy plugin registry plugin create internal --name plugin-argocd
cy plugin registry plugin version publish internal plugin-argocd \
  --docker-image cycloid-docker-registry:5000/cycloid/plugin-argocd:0.1.0
cy plugin install --version-id <id> --config argocd_url=https://argocd.example.com
```

For dev access from outside the cluster, the `kubectl port-forward
svc/docker-registry 5000` trick from the existing `justfile` still applies and
will be documented.

### 3.9 Local development without Bun

```bash
# Pretty‑print logs locally
PORT=8080 ARGOCD_URL=https://argocd.example.com \
  node --experimental-strip-types --watch server.ts
```

That’s it — no install step, no `node_modules/`. Bun watch becomes Node’s
built‑in `--watch`.

### 3.10 Smoke‑test recipe (no `just`)

A short shell snippet (could live in `README.md` or a `scripts/smoke.sh`):

```bash
docker build -t cycloid/plugin-argocd:dev .
cid=$(docker run --rm -d -e PORT=8080 -e ARGOCD_URL=https://demo cycloid/plugin-argocd:dev)
trap 'docker stop "$cid" >/dev/null' EXIT
ip=$(docker inspect "$cid" | sed -n 's/.*"IPAddress":"\([^"]*\)".*/\1/p' | head -n1)
curl -fsS --retry 10 --retry-delay 1 "http://$ip:8080/_cy/ping" | grep ok
docker exec "$cid" test -f /plugin/manifest.yaml
docker exec "$cid" test -f /plugin/widgets.yaml
echo "ok"
```

Pure shell, no Bun, no Just, no jq.

---

## 4. Open questions / decisions to confirm before coding

These don’t block the design but are worth flagging up front.

1. **Should the plugin name be `argocd` or `plugin-argocd`?** The repo is
   `cycloid-plugin-argocd`; the manifest can use either. Cycloid’s convention
   from the docs (`hello-world`, `sentry-plugin`) suggests just `argocd`.
2. **Should we pass `argocd_url` to the browser via `widgets.yaml` query
   templating, or render it into `index.html` server‑side?** The latter is
   simpler and means the URL never appears in the iframe address bar. Tentative
   choice: server‑side templating into a tiny placeholder in `index.html`.
3. **Do we want to support per‑project ArgoCD URLs via `relations:`?** Not for
   v0.1. Add it once the basic embed works.
4. **Node 22 type‑stripping is still flagged as experimental.** If we want to
   be conservative we can compile the TS to JS at build time using `tsc` — but
   that introduces a third‑party dep (`typescript`), which contradicts the
   user’s no‑deps constraint. Sticking with `--experimental-strip-types` is the
   right call given the constraint.
5. **How will the plugin access ArgoCD if it’s on a private network?** Out of
   scope of the plugin: the operator configures network reachability between
   the user’s browser (loading the iframe) and the ArgoCD UI. The plugin
   container itself doesn’t need to reach ArgoCD.

---

## 5. Summary

- This repo currently holds an OIDC credential‑management plugin built on Bun +
  Just; it is unrelated to ArgoCD and needs to be replaced.
- A Cycloid plugin is *just* a Docker image with three things: required files
  in `/plugin/` (`manifest.yaml`, `widgets.yaml`, optional `schema.sql`), an
  HTTP server bound to `$PORT`, and four `/_cy/*` endpoints. Everything else is
  optional.
- For an ArgoCD embed plugin we need none of the optional bits: no SQL schema,
  no Cycloid backend proxy calls, no relations.
- The new implementation will be: Node 22 + `node:http` + `node:fs`, a single
  `server.ts`, a small `index.html`, the two YAML files, and a 10‑line
  Dockerfile. Zero third‑party libraries, zero `just`, zero `bun`.
- Build & publish flow becomes plain `docker build && docker push` plus the
  three `cy plugin …` commands, all documented in `README.md`.

This is the plan I’ll implement once you confirm the design.
