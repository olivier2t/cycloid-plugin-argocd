# Cycloid plugin — ArgoCD

A Cycloid plugin that imports ArgoCD applications into the Cycloid Plugin
Manager and renders them as an **ArgoCD** tab on every component page.

Each row represents one ArgoCD application. Columns:

| Application | Sync | Health | Namespace | Last Synced | Link |

Data is refreshed at container start-up and whenever you click **Resync** in
the Cycloid UI.

## Why this is a `table` widget, not an `iframe`

The Cycloid widgets reference accepts the four combinations
{`table`,`iframe`} × {`component`,`sideMenuPage`}, but in practice only three
have a renderer in the Cycloid console today:

- `table + component` ✅ — what this plugin uses
- `table + sideMenuPage` ✅
- `iframe + sideMenuPage` ✅
- `iframe + component` ❌ — accepted by validation, silently dropped by the UI

An earlier version of this plugin used `iframe + component` and never
displayed a tab. See the `iframe-attempt` git history for that path.

## Files

| File             | Purpose                                                              |
|------------------|----------------------------------------------------------------------|
| `manifest.yaml`  | Install form: ArgoCD username + password only.                       |
| `widgets.yaml`   | One `table` widget on `placement: component`, tab name **ArgoCD**.   |
| `schema.sql`     | SQLite tables: `organizations`, `environments`, `argocd_apps`.       |
| `server.ts`      | Node 22 server: SQLite open + migrate, org/env discovery, sync.      |
| `Dockerfile`     | `node:22-trixie-slim`, runs `.ts` directly with type-strip + sqlite. |
| `package.json`   | Declares `type: module`. No runtime dependencies.                    |

No Bun, no `just`, no third-party libraries, no build step.

## How it works

```
┌──────────────────┐    list orgs/projects    ┌──────────────────┐
│ This container   │ ───────────────────────▶ │ Cycloid backend  │
│ (Node 22)        │ ◀─── (org, env) pairs    │ via PROXY_URL    │
└─────┬────────────┘                          └──────────────────┘
      │
      │ for each (org, env): login + GET /api/v1/applications
      ▼
┌──────────────────┐
│ ArgoCD instance  │
│ argocd.<org>-    │
│  <env>.demo…     │
└─────┬────────────┘
      │ INSERTs into local SQLite (/plugin/data.db or in-memory)
      ▼
┌─────────────────────────────┐   widget SQL    ┌──────────────────┐
│ Cycloid Plugin Manager      │ ──────────────▶ │ SQLite tables    │
│ runs widget.query for       │   JOIN on       │ argocd_apps      │
│ each component page         │   o.slug/e.slug │ environments     │
│                             │                 │ organizations    │
└─────────────────────────────┘                 └──────────────────┘
```

1. At start-up the plugin opens its SQLite database, applies `schema.sql`,
   then performs an initial sync.
2. The sync first asks the **Cycloid backend** (via `PROXY_URL` +
   `PLUGIN_SECRET`, both injected by the Plugin Manager) for the list of
   organizations and, for each, the list of projects with their
   `environments[]`. From that it builds the full set of `(org, env)` pairs.
3. For each `(org, env)` pair, the plugin logs into
   `argocd.<org>-<env>.demo.cycloid.io` and pulls `/api/v1/applications`.
   Per-pair failures are logged and skipped; the sync continues with the
   other pairs.
4. The sync wipes the `organizations` row (cascade-deletes everything else)
   and re-inserts one `organizations` / `environments` row per discovered
   pair, plus every ArgoCD application as one row in `argocd_apps`.
5. When the Cycloid console renders a component page, it executes the
   widget's `SELECT` against this SQLite database, JOIN-ing on the current
   component's `o.slug` / `e.slug` (declared as `relations:` in
   `widgets.yaml`).
6. The user clicks **Resync** in the Cycloid UI when they want fresh data.

## Install form

These fields appear in **Install ArgoCD** in the Cycloid UI and are injected
as `UPPER_CASE` environment variables into the container at runtime.

| `key`              | Env var             | Required | Description                                                |
|--------------------|---------------------|----------|------------------------------------------------------------|
| `argocd_username`  | `ARGOCD_USERNAME`   | yes      | Local ArgoCD account username used to log in.              |
| `argocd_password`  | `ARGOCD_PASSWORD`   | yes      | Password for the ArgoCD account. Treat as sensitive.       |

The same credentials are used for **every** ArgoCD instance the plugin
discovers, so the local ArgoCD account must exist with the same
username/password on each `argocd.<org>-<env>.demo.cycloid.io` you want to
import from.

The ArgoCD URL is **not** an install-time field. The plugin builds it
per-environment from the Cycloid org and env canonicals following this
convention:

```
https://argocd.<organization_canonical>-<environment_canonical>.demo.cycloid.io
```

For example, an env `arhs` in org `cycloid-demo-cmp` is fetched from
`https://argocd.cycloid-demo-cmp-arhs.demo.cycloid.io/api/v1/applications`.
If your ArgoCD instances don't follow this pattern, fork this plugin and
adjust `argocdBaseUrl()` in `server.ts`.

Authentication uses ArgoCD's session API: at every resync the plugin POSTs
the credentials to `<derived_url>/api/v1/session`, receives a JWT, and uses
it as a Bearer token for `/api/v1/applications`. The JWT is never persisted;
we log in again on each sync.

The org/env canonicals themselves are **not** install-time fields either.
They are discovered at sync time from the Cycloid backend via the
`PROXY_URL` / `PLUGIN_SECRET` environment variables, which the Plugin
Manager injects automatically. You don't set those — they are part of the
runtime contract between the plugin and the Plugin Manager.

Optional, set directly in the container (not in the install form):

| Env var               | Default      | Description                                                                                  |
|-----------------------|--------------|----------------------------------------------------------------------------------------------|
| `DB_FILE`             | `:memory:`   | Path to the SQLite file. Use a mounted volume if you want data to survive container restarts.|
| `ARGOCD_INSECURE_TLS` | _unset_      | Set to `true` to skip TLS verification when calling a self-signed ArgoCD. Off by default.    |

## One-time per-component enable (Cycloid gotcha)

Installing the plugin **does not** automatically wire it to existing
components. For each component where you want the tab, you have to flip the
plugin "enabled" relation:

```sh
# Find the plugin install id
INSTALL_ID=$(curl -sS -H "Authorization: Bearer $CY_API_KEY" \
  "$CY_API_URL/organizations/<org>/plugins" \
  | jq -r '.data[] | select(.name == "argocd") | .install.id')

# Enable it on every component that should show the tab
curl -sS -X PUT \
  -H "Authorization: Bearer $CY_API_KEY" \
  -H "Content-Type: application/vnd.cycloid.io.v1+json" \
  -d '{"relations": {}, "enabled": true}' \
  "$CY_API_URL/organizations/<org>/projects/<project>/environments/<env>/components/<component>/plugins/$INSTALL_ID/relation"
```

The Cycloid UI exposes the same toggle on the component's settings page.
Without this step, the per-component `plugin_widgets` endpoint returns `[]`
and the tab never renders. Yes, this is the same gotcha you hit if you
upgrade from an earlier `iframe + component` version of this plugin.

## Build, push, install

```sh
docker build -t docker.io/<your-namespace>/cycloid-plugin-argocd:1.4.0 .
docker push docker.io/<your-namespace>/cycloid-plugin-argocd:1.4.0
```

The image tag must be a valid semantic version (e.g. `1.4.0`).

### Publish & install via the Cycloid console (recommended)

The Cycloid CLI (`cy`) in current public releases does **not** ship a
`plugin` subcommand. Use the Cycloid console UI instead:

1. **Plugin Registry → Plugins → ArgoCD → New version.** Paste the Docker
   image reference (e.g. `docker.io/<ns>/cycloid-plugin-argocd:1.4.0`).
   Wait until validation reports `Successfully finished`.
2. **Plugins → ArgoCD → Install** (or **Update** if a previous version was
   installed). Fill in `argocd_username` and `argocd_password`. Save.
3. **For each component that should show the tab**, toggle the ArgoCD
   plugin on in the component's settings page, or call the API directly
   (see next section).

### Publish & install via the REST API

If you need to script it, the relevant endpoints are:

```sh
# Discover the registry id, plugin id, and the new version id
curl -sS -H "Authorization: Bearer $CY_API_KEY" \
  "$CY_API_URL/organizations/$CY_ORG/plugin_registries" | jq .

REGISTRY_ID=...   # from the response above
PLUGIN_ID=...     # from /organizations/$CY_ORG/plugins, .data[] | select(.name=="argocd") | .id

# Publish a new version (returns the new version's id)
curl -sS -X POST \
  -H "Authorization: Bearer $CY_API_KEY" \
  -H "Content-Type: application/vnd.cycloid.io.v1+json" \
  -d "{\"url\":\"docker.io/<ns>/cycloid-plugin-argocd:1.4.0\"}" \
  "$CY_API_URL/organizations/$CY_ORG/plugin_registries/$REGISTRY_ID/plugins/$PLUGIN_ID/versions" \
  | jq .

VERSION_ID=...    # .data.id from the response above

# Install the version with configuration values from manifest.yaml
curl -sS -X POST \
  -H "Authorization: Bearer $CY_API_KEY" \
  -H "Content-Type: application/vnd.cycloid.io.v1+json" \
  -d '{"configuration":{"argocd_username":"<user>","argocd_password":"<password>"}}' \
  "$CY_API_URL/organizations/$CY_ORG/plugin_registries/$REGISTRY_ID/plugins/$PLUGIN_ID/versions/$VERSION_ID/install" \
  | jq .
```

## Local development

`PROXY_URL` and `PLUGIN_SECRET` are normally injected by the Plugin Manager.
For local dev you can either point at a real Cycloid backend (you'll need
a plugin install secret — currently only visible to the Plugin Manager,
not exposed in the public CLI) or accept that discovery will no-op and the
sync will report `missing configuration`.

```sh
PORT=8080 \
ARGOCD_USERNAME=admin \
ARGOCD_PASSWORD='your-password' \
PROXY_URL=https://api.cycloid.io \
PLUGIN_SECRET='<plugin install secret>' \
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

## Upgrading from earlier versions

Any time the install form changes (a `key:` is added, renamed, or removed
in `manifest.yaml`), the existing install becomes stale and must be
uninstalled and reinstalled. From the Cycloid console: **Plugins → ArgoCD
→ Uninstall**, then follow "Publish & install via the Cycloid console"
above with the new version. The REST equivalent is `DELETE
/organizations/$CY_ORG/plugins/$PLUGIN_INSTALL_ID`.

### From `iframe + component` (≤ 1.0.5)

Switched the widget from `iframe` to `table`, introduced `schema.sql`,
local SQLite, and a real `server.ts`-driven sync. Uninstall and reinstall.
After reinstall you also need to enable the plugin on each component (see
the "One-time per-component enable" gotcha above).

### From `1.1.0` (token-based auth)

`1.2.0` replaced `argocd_token` with `argocd_username` + `argocd_password`.
Uninstall and reinstall with the new credential fields.

### From `1.2.0` (explicit ArgoCD URL)

`1.3.0` removed `argocd_url` from the install form — it is now derived
per-`(org, env)` from the Cycloid canonicals (see "Install form" above).

### From `1.3.0` (Cycloid org/env in install form)

`1.4.0` removed `cycloid_org_slug` and `cycloid_env_slug` from the install
form. The plugin now discovers organizations and environments at sync time
through the Cycloid backend (via `PROXY_URL` / `PLUGIN_SECRET` injected by
the Plugin Manager) and syncs ArgoCD apps for **every** `(org, env)` pair
in the install's scope. A single install is enough — no more "one install
per environment". Uninstall, publish `1.4.0`, reinstall with only
`argocd_username` + `argocd_password`, re-enable per-component.
