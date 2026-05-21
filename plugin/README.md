# Cycloid plugin — ArgoCD

A Cycloid plugin that imports ArgoCD applications into the Cycloid Plugin
Manager and shows them on an **ArgoCD** entry in the organization **side menu**.

Each row is one ArgoCD application (all envs and components for the org in one
table). Columns: Application, Environment, Component, Sync, Health, Namespace,
Last Synced, Link.

Data is refreshed on plugin startup and whenever you click **Resync** in the
Cycloid UI. There is **no** per-component or per-environment filtering in the
widget SQL — that kept causing Plugin Manager errors on this platform.

## Why `iframe + sideMenuPage`

- `iframe + sideMenuPage` — what this plugin uses (org-wide sidebar; HTML table
  served from `GET /` in the container)
- `table + sideMenuPage` — query API can return rows, but the Cycloid console on
  this stack still shows **unknownWidgetTitle** (no table renderer)
- `table + component` — works, but per-component enable + SQL filtering was fragile
- `iframe + component` — not rendered by the Cycloid UI

## Files

| File             | Purpose                                                              |
|------------------|----------------------------------------------------------------------|
| `manifest.yaml`  | Install form: credentials, org slug, optional ArgoCD URL override.   |
| `widgets.yaml`   | One `iframe` widget on `placement: sideMenuPage`, title **ArgoCD**.  |
| `schema.sql`     | SQLite tables: `organizations`, `environments`, `argocd_apps`.       |
| `server.ts`      | Node 22 server: SQLite open + migrate, org-wide ArgoCD sync.           |
| `Dockerfile`     | `node:22-trixie-slim`, runs `.ts` directly with type-strip + sqlite. |
| `package.json`   | Declares `type: module`. No runtime dependencies.                    |

No Bun, no `just`, no third-party libraries, no build step.

## How it works

```
┌────────────────────────────────┐
│ Cycloid console — side menu    │
│ “ArgoCD” page (org-wide)       │
└─────────────────┬──────────────┘
                  │ iframe → GET / (plugin container)
                  ▼
┌──────────────────────────────────┐  reads SQLite, renders HTML table
│ Plugin container (Node 22)         │
│   GET /                            │
└─────┬────────────────────────────┘
      │ upsert on POST /_cy/resync
      ▼
┌──────────────────────────────────┐  login + GET /api/v1/applications
│ ArgoCD sync                        │ ─────────────────────────────────▶ ArgoCD
└──────────────────────────────────┘     https://argocd.<org>.demo… or override
```

1. One plugin install per Cycloid org (`cycloid_org_slug` in the install form).
2. On startup and `POST /_cy/resync`, the plugin logs into ArgoCD, fetches all
   applications, parses `<org>-<env>-<component>` from each app name, and stores
   rows in SQLite.
3. The side-menu **iframe** loads `GET /`, which reads SQLite and renders the table.

## Install form

These fields appear in **Install ArgoCD** in the Cycloid UI and are injected
as `UPPER_CASE` environment variables into the container at runtime.

| `key`              | Env var             | Operator action | Description                                                |
|--------------------|---------------------|-----------------|------------------------------------------------------------|
| `argocd_username`  | `ARGOCD_USERNAME`   | fill in         | Local ArgoCD account username used to log in.              |
| `argocd_password`  | `ARGOCD_PASSWORD`   | fill in         | Password for the ArgoCD account. Treat as sensitive.       |
| `cycloid_org_slug`    | `CYCLOID_ORG_SLUG`     | type your org canonical (e.g. `test09`)   |
| `argocd_url_override` | `ARGOCD_URL_OVERRIDE`  | optional IP/URL if sandbox DNS is blocked |
| `argocd_insecure_tls` | `ARGOCD_INSECURE_TLS`  | `true` when using IP override             |

The ArgoCD URL defaults to `https://argocd.<cycloid_org_slug>.demo.cycloid.io`
(one ArgoCD per org). Set `argocd_url_override` + `argocd_insecure_tls` when the
plugin container cannot resolve public DNS (see troubleshooting below).

Authentication uses ArgoCD's session API: at every resync the plugin POSTs
the credentials to `<derived_url>/api/v1/session`, receives a JWT, and uses
it as a Bearer token for `/api/v1/applications`. The JWT is never persisted;
we log in again on each sync.

Optional, set directly in the container (not in the install form):

| Env var      | Default      | Description                                                                                  |
|--------------|--------------|----------------------------------------------------------------------------------------------|
| `DB_FILE`    | `:memory:`   | Path to the SQLite file. Use a mounted volume if you want data to survive container restarts.|

### Troubleshooting: `getaddrinfo EAI_AGAIN` on the ArgoCD hostname

If the plugin log shows:

```
[ERROR] resync <org>: getaddrinfo EAI_AGAIN argocd.<org>.demo.cycloid.io
```

…but `getent hosts argocd.<org>.demo.cycloid.io` succeeds *on the host*, the
plugin sandbox can't reach DNS. The most common cause we've seen is that
**UDP/53 egress is firewalled out of the plugin sandbox**, even when TCP/443
to public IPs is allowed. Both glibc's `getaddrinfo` and Node's c-ares
resolver depend on UDP/53 by default; both time out.

Confirm from the host (inside the plugin-manager container):

```sh
CTR=$(crictl ps --name '.*<install-uuid-prefix>.*' -q | head -1)

# Same hostname through both resolvers; if both fail, UDP/53 is blocked
crictl exec "$CTR" node -e '
const dns = require("node:dns");
dns.lookup("argocd.<org>.demo.cycloid.io", (e, a) =>
  console.log("getaddrinfo:", e ? "ERR "+e.code : "OK "+a));
const r = new dns.Resolver(); r.setServers(["8.8.8.8"]);
r.resolve4("argocd.<org>.demo.cycloid.io", (e, a) =>
  console.log("c-ares:", e ? "ERR "+e.code : "OK "+JSON.stringify(a)));
'
```

Two ways out:

1. **Fix the platform** — open UDP/53 egress from the plugin sandbox, or run
   a local DNS forwarder reachable from inside it.
2. **Bypass DNS in the plugin** — at install time, set:
   - `argocd_url_override` = `https://<ArgoCD-IP>` (resolve once from the
     host: `getent hosts argocd.<org>.demo.cycloid.io`)
   - `argocd_insecure_tls` = `true` (the cert won't match an IP host).

## Where to find it in the UI

After install, open the organization **test09** (or your org) and look for
**ArgoCD** in the **left sidebar** (side menu). No per-component enable step
is required.

Verify the org-level widget:

```sh
curl -sS -H "Authorization: Bearer $CY_API_KEY" \
  "$CY_API_URL/organizations/<org>/plugin_widgets?placement=sideMenuPage" | jq .

WIDGET_ID=$(curl -sS -H "Authorization: Bearer $CY_API_KEY" \
  "$CY_API_URL/organizations/<org>/plugin_widgets?placement=sideMenuPage" \
  | jq -r '.data[] | select(.widget.query | contains("argocd_apps")) | .id' | head -1)

curl -sS -H "Authorization: Bearer $CY_API_KEY" \
  "$CY_API_URL/organizations/<org>/plugin_widgets/$WIDGET_ID/query" | jq .
```

## Build, push, install

```sh
docker build -t docker.io/<your-namespace>/cycloid-plugin-argocd:1.7.1 .
docker push docker.io/<your-namespace>/cycloid-plugin-argocd:1.7.1
```

The image tag must match `package.json` (e.g. `1.7.1`).

### Via the Cycloid console (recommended)

The Cycloid CLI does not ship a `plugin` subcommand in current public
releases. Use the console UI:

1. **Plugin Registry → Plugins → ArgoCD → New version.** Paste the Docker
   image reference. Wait for `Successfully finished`.
2. **Plugins → ArgoCD → Install** (or **Update**). Fill in credentials,
   `cycloid_org_slug`, and URL override fields if needed.
3. Open **ArgoCD** in the org side menu.

### Via the REST API

```sh
# Discover ids
curl -sS -H "Authorization: Bearer $CY_API_KEY" \
  "$CY_API_URL/organizations/$CY_ORG/plugin_registries" | jq .
REGISTRY_ID=...
PLUGIN_ID=$(curl -sS -H "Authorization: Bearer $CY_API_KEY" \
  "$CY_API_URL/organizations/$CY_ORG/plugins" \
  | jq -r '.data[] | select(.name == "ArgoCD") | .id')

# Publish version
curl -sS -X POST \
  -H "Authorization: Bearer $CY_API_KEY" \
  -H "Content-Type: application/vnd.cycloid.io.v1+json" \
  -d '{"url":"docker.io/<ns>/cycloid-plugin-argocd:1.7.1"}' \
  "$CY_API_URL/organizations/$CY_ORG/plugin_registries/$REGISTRY_ID/plugins/$PLUGIN_ID/versions" \
  | jq '.data.id'
VERSION_ID=...

# Install. Note the configuration values include the Cycloid template vars
# as-is — the Plugin Manager substitutes them at runtime.
curl -sS -X POST \
  -H "Authorization: Bearer $CY_API_KEY" \
  -H "Content-Type: application/vnd.cycloid.io.v1+json" \
  -d '{
        "configuration": {
          "argocd_username": "<user>",
          "argocd_password": "<password>",
          "cycloid_org_slug": "test09",
          "argocd_url_override": "https://34.253.192.110",
          "argocd_insecure_tls": "true"
        }
      }' \
  "$CY_API_URL/organizations/$CY_ORG/plugin_registries/$REGISTRY_ID/plugins/$PLUGIN_ID/versions/$VERSION_ID/install"
```

## Local development

```sh
PORT=8080 \
ARGOCD_USERNAME=admin \
ARGOCD_PASSWORD='your-password' \
CYCLOID_ORG_SLUG=test09 \
ARGOCD_URL_OVERRIDE=https://34.253.192.110 \
ARGOCD_INSECURE_TLS=true \
DB_FILE=/tmp/argocd-plugin.db \
node --experimental-strip-types --experimental-sqlite --watch server.ts
```

Smoke-test the platform contract:

```sh
curl -fsS http://localhost:8080/_cy/ping
curl -fsS -X POST http://localhost:8080/_cy/events
curl -fsS -X POST http://localhost:8080/_cy/resync
curl -fsS -X DELETE http://localhost:8080/_cy/plugin
```

Inspect the synced data:

```sh
sqlite3 /tmp/argocd-plugin.db 'SELECT name, sync_status, health_status FROM argocd_apps'
```

## Upgrading

Any time the install form changes (a `key:` is added, renamed, or removed
in `manifest.yaml`), the existing install becomes stale and must be
uninstalled and reinstalled. From the Cycloid console: **Plugins → ArgoCD
→ Uninstall**, then publish the new version and install fresh.

### From `1.6.x` / `1.7.0` (table side menu)

`1.7.1` uses `iframe + sideMenuPage` because `table + sideMenuPage` returns data
from the query API but the console shows **unknownWidgetTitle**. Publish `1.7.1`,
update the install, hard-refresh the **ArgoCD** side menu page.

### From earlier versions

See git history. The architecture has shifted enough that no in-place
upgrade path is realistic — uninstall and reinstall.
