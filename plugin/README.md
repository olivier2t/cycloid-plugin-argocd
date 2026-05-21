# Cycloid plugin — ArgoCD

A Cycloid plugin that imports ArgoCD applications into the Cycloid Plugin
Manager and renders them as an **ArgoCD** tab on every component page.

Each row represents one ArgoCD application. Columns:

| Application | Sync | Health | Namespace | Last Synced | Link |

Data is refreshed on every widget render and whenever you click **Resync** in
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
| `manifest.yaml`  | Install form: ArgoCD username + password, plus 2 auto-filled fields. |
| `widgets.yaml`   | One `table` widget on `placement: component`, tab name **ArgoCD**.   |
| `schema.sql`     | SQLite tables: `organizations`, `environments`, `argocd_apps`.       |
| `server.ts`      | Node 22 server: SQLite open + migrate, per-context ArgoCD sync.      |
| `Dockerfile`     | `node:22-trixie-slim`, runs `.ts` directly with type-strip + sqlite. |
| `package.json`   | Declares `type: module`. No runtime dependencies.                    |

No Bun, no `just`, no third-party libraries, no build step.

## How it works

```
┌────────────────────────────────┐
│ Cycloid console renders        │
│ component (org=Y, env=Z) page  │
└─────────────────┬──────────────┘
                  │ POST /_cy/resync
                  │ (with CYCLOID_ORG_SLUG=Y, CYCLOID_ENV_SLUG=Z
                  │  substituted from manifest.yaml ($ .org $) / ($ .env $))
                  ▼
┌──────────────────────────────────┐  login + GET /api/v1/applications
│ This container (Node 22)         │ ─────────────────────────────────▶ ArgoCD
│   resyncCurrentContext()         │                                   argocd.Y-Z.demo…
└─────┬────────────────────────────┘
      │ upsert rows for (Y, Z) into local SQLite
      ▼
┌──────────────────────────────────┐  widget SQL with ($ .org $) / ($ .env $)
│ Cycloid Plugin Manager           │ ─────────────────────────────────▶ SQLite tables
│ substitutes placeholders, runs   │  WHERE o.slug='Y' AND e.slug='Z'  argocd_apps
│ SELECT against plugin SQLite     │                                   environments
└──────────────────────────────────┘                                   organizations
```

1. Cycloid substitutes the `($ .org $)` / `($ .env $)` template variables
   in `manifest.yaml`'s configuration defaults into the plugin container's
   environment as `CYCLOID_ORG_SLUG` and `CYCLOID_ENV_SLUG`. These reflect
   the *current widget context*, i.e. the component being rendered.
2. The plugin starts, applies `schema.sql`, performs an initial sync for
   that one `(org, env)`, and listens on `:8080`. It re-syncs that same
   pair on every `POST /_cy/resync`.
3. A sync logs into `https://argocd.<org>-<env>.demo.cycloid.io` with the
   install-form credentials, fetches `/api/v1/applications`, then upserts
   the rows into SQLite under `(org, env)`. Other `(org, env)` slices in
   the DB are left intact.
4. When the Cycloid console renders the component page, the widget's
   `query:` SQL has `($ .org $)` / `($ .env $)` substituted and runs
   against the plugin's SQLite, returning only the rows for that
   `(org, env)`.

No `PROXY_URL`, no Plugin Manager API calls from the plugin, no
discovery — the substitution layer carries all the context.

## Install form

These fields appear in **Install ArgoCD** in the Cycloid UI and are injected
as `UPPER_CASE` environment variables into the container at runtime.

| `key`              | Env var             | Operator action | Description                                                |
|--------------------|---------------------|-----------------|------------------------------------------------------------|
| `argocd_username`  | `ARGOCD_USERNAME`   | fill in         | Local ArgoCD account username used to log in.              |
| `argocd_password`  | `ARGOCD_PASSWORD`   | fill in         | Password for the ArgoCD account. Treat as sensitive.       |
| `cycloid_org_slug` | `CYCLOID_ORG_SLUG`  | leave default   | Auto-filled by Cycloid with `($ .org $)`. Do not edit.     |
| `cycloid_env_slug` | `CYCLOID_ENV_SLUG`  | leave default   | Auto-filled by Cycloid with `($ .env $)`. Do not edit.     |

The last two fields are technically required by the install form, but their
defaults are Cycloid template variables (`($ .org $)` / `($ .env $)`) that
the Plugin Manager substitutes at runtime with the *current widget
context*. Operators must not change them.

The same credentials are used for **every** ArgoCD instance the plugin
hits, so the local ArgoCD account must exist with the same
username/password on each `argocd.<org>-<env>.demo.cycloid.io` you want to
import from.

The ArgoCD URL is **not** an install-time field. The plugin builds it
per-render from `CYCLOID_ORG_SLUG` and `CYCLOID_ENV_SLUG`:

```
https://argocd.<CYCLOID_ORG_SLUG>-<CYCLOID_ENV_SLUG>.demo.cycloid.io
```

For example, a render in env `arhs` of org `cycloid-demo-cmp` fetches from
`https://argocd.cycloid-demo-cmp-arhs.demo.cycloid.io/api/v1/applications`.
If your ArgoCD instances don't follow this pattern, fork this plugin and
adjust `argocdBaseUrl()` in `server.ts`.

Authentication uses ArgoCD's session API: at every resync the plugin POSTs
the credentials to `<derived_url>/api/v1/session`, receives a JWT, and uses
it as a Bearer token for `/api/v1/applications`. The JWT is never persisted;
we log in again on each sync.

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
  | jq -r '.data[] | select(.name == "ArgoCD") | .install.id')

# Enable it on every component that should show the tab
curl -sS -X PUT \
  -H "Authorization: Bearer $CY_API_KEY" \
  -H "Content-Type: application/vnd.cycloid.io.v1+json" \
  -d '{"relations": {}, "enabled": true}' \
  "$CY_API_URL/organizations/<org>/projects/<project>/environments/<env>/components/<component>/plugins/$INSTALL_ID/relation"
```

The Cycloid UI exposes the same toggle on the component's settings page.
Without this step, the per-component `plugin_widgets` endpoint returns `[]`
and the tab never renders.

## Build, push, install

```sh
docker build -t docker.io/<your-namespace>/cycloid-plugin-argocd:1.5.0 .
docker push docker.io/<your-namespace>/cycloid-plugin-argocd:1.5.0
```

The image tag must be a valid semantic version (e.g. `1.5.0`).

### Via the Cycloid console (recommended)

The Cycloid CLI does not ship a `plugin` subcommand in current public
releases. Use the console UI:

1. **Plugin Registry → Plugins → ArgoCD → New version.** Paste the Docker
   image reference. Wait for `Successfully finished`.
2. **Plugins → ArgoCD → Install** (or **Update**). Fill in
   `argocd_username` and `argocd_password`. Leave the two `cycloid_*_slug`
   fields at their default — they contain Cycloid template variables that
   are substituted at runtime.
3. Enable the plugin on each component (see the per-component gotcha
   above).

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
  -d '{"url":"docker.io/<ns>/cycloid-plugin-argocd:1.5.0"}' \
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
          "cycloid_org_slug": "($ .org $)",
          "cycloid_env_slug": "($ .env $)"
        }
      }' \
  "$CY_API_URL/organizations/$CY_ORG/plugin_registries/$REGISTRY_ID/plugins/$PLUGIN_ID/versions/$VERSION_ID/install"
```

## Local development

```sh
PORT=8080 \
ARGOCD_USERNAME=admin \
ARGOCD_PASSWORD='your-password' \
CYCLOID_ORG_SLUG=cycloid-demo-cmp \
CYCLOID_ENV_SLUG=arhs \
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

### From `1.4.x` (PROXY_URL / discovery)

`1.5.0` removes the `PROXY_URL`-based discovery entirely. The plugin no
longer calls the Plugin Manager API; it relies on the
`($ .org $)` / `($ .env $)` template substitution in `manifest.yaml` to
receive the current widget context as env vars.

1. Uninstall the existing 1.4.x install.
2. Publish `1.5.0`.
3. Install with `argocd_username` + `argocd_password`. Leave the two
   `cycloid_*_slug` fields at their template-variable defaults.
4. Re-enable the plugin on each component.

### From earlier versions

See git history. The architecture has shifted enough that no in-place
upgrade path is realistic — uninstall and reinstall.
