# Cycloid plugin — ArgoCD

A Cycloid plugin that imports ArgoCD applications into the Cycloid Plugin
Manager and renders them as an **ArgoCD** tab on every component page.

Each row represents one ArgoCD application. Columns:

| Application | Sync | Health | Namespace | Last Synced | Link |

Data is refreshed at container start-up and whenever you click **Resync** in
the Cycloid UI (or call `cy plugin resync argocd`).

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
| `manifest.yaml`  | Install form: ArgoCD URL + token, Cycloid org + env slugs.           |
| `widgets.yaml`   | One `table` widget on `placement: component`, tab name **ArgoCD**.   |
| `schema.sql`     | SQLite tables: `organizations`, `environments`, `argocd_apps`.       |
| `server.ts`      | Node 22 server: SQLite open + migrate, ArgoCD sync, `/_cy/*` API.    |
| `Dockerfile`     | `node:22-trixie-slim`, runs `.ts` directly with type-strip + sqlite. |
| `package.json`   | Declares `type: module`. No runtime dependencies.                    |

No Bun, no `just`, no third-party libraries, no build step.

## How it works

```
┌──────────────────┐    sync (REST)    ┌─────────────────┐
│ This container   │ ────────────────▶ │ ArgoCD API      │
│ (Node 22)        │                   │ /api/v1/apps    │
└─────┬────────────┘                   └─────────────────┘
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
   then performs an initial sync against the ArgoCD API.
2. The sync deletes the `organizations` row (cascade-deletes everything else)
   and re-creates one row keyed by `CYCLOID_ORG_SLUG` / `CYCLOID_ENV_SLUG`,
   then INSERTs every ArgoCD application as one row in `argocd_apps`.
3. When the Cycloid console renders a component page, it executes the
   widget's `SELECT` against this SQLite database, JOIN-ing on the current
   `o.slug` / `e.slug` (declared as `relations:` in `widgets.yaml`).
4. The user clicks **Resync** in the Cycloid UI when they want fresh data.

## Install form

These fields appear in **Install ArgoCD** in the Cycloid UI and are injected
as `UPPER_CASE` environment variables into the container at runtime.

| `key`              | Env var             | Required | Description                                                              |
|--------------------|---------------------|----------|--------------------------------------------------------------------------|
| `argocd_url`       | `ARGOCD_URL`        | yes      | Base URL of the ArgoCD API (e.g. `https://argocd.example.com`).          |
| `argocd_token`     | `ARGOCD_TOKEN`      | yes      | Bearer token. `argocd account generate-token` in ArgoCD generates one.   |
| `cycloid_org_slug` | `CYCLOID_ORG_SLUG`  | yes      | Cycloid organization slug to attach this data to (one install per org).  |
| `cycloid_env_slug` | `CYCLOID_ENV_SLUG`  | yes      | Cycloid environment slug to attach this data to (one install per env).   |

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
docker build -t cycloid-docker-registry:5000/cycloid/argocd:1.1.0 .
docker push cycloid-docker-registry:5000/cycloid/argocd:1.1.0

cy plugin registry plugin version publish internal argocd \
  --docker-image cycloid-docker-registry:5000/cycloid/argocd:1.1.0
cy plugin install --version-id <id> \
  --config argocd_url=https://argocd.example.com \
  --config argocd_token=<token> \
  --config cycloid_org_slug=<org> \
  --config cycloid_env_slug=<env>
```

The image tag must be a valid semantic version (e.g. `1.1.0`).

## Local development

```sh
PORT=8080 \
ARGOCD_URL=https://argocd.example.com \
ARGOCD_TOKEN=$(argocd account generate-token) \
CYCLOID_ORG_SLUG=acme \
CYCLOID_ENV_SLUG=staging \
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

## Upgrading from `iframe + component` (≤ 1.0.5)

1. `cy plugin uninstall argocd`
2. Publish `1.1.0` per the build/push/install steps above.
3. Install with the four required config fields.
4. Enable the plugin per-component using the API call in the "gotcha"
   section, or via the UI toggle on each component page.
