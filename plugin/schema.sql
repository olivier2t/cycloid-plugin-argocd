CREATE TABLE IF NOT EXISTS organizations (
    id   TEXT PRIMARY KEY,
    slug TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS environments (
    id              TEXT PRIMARY KEY,
    slug            TEXT NOT NULL,
    organization_id TEXT NOT NULL,

    CONSTRAINT fk__environments__organizations
        FOREIGN KEY (organization_id) REFERENCES organizations (id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS argocd_apps (
    id             TEXT PRIMARY KEY,
    name           TEXT,
    component      TEXT,
    sync_status    TEXT,
    health_status  TEXT,
    namespace      TEXT,
    last_synced    TEXT,
    url            TEXT,
    project        TEXT,
    revision       TEXT,
    cluster        TEXT,
    resources      TEXT,
    ingress_url    TEXT,

    environment_id TEXT NOT NULL,

    CONSTRAINT fk__argocd_apps__environments
        FOREIGN KEY (environment_id) REFERENCES environments (id)
        ON DELETE CASCADE
);
