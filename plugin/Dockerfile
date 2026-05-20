# syntax=docker/dockerfile:1
FROM node:22-trixie-slim

WORKDIR /plugin

COPY manifest.yaml widgets.yaml schema.sql package.json server.ts ./

# Cycloid validates these at registration time; refuse to build without them.
RUN test -f /plugin/manifest.yaml && test -f /plugin/widgets.yaml && test -f /plugin/schema.sql \
    || (echo "ERROR: /plugin/manifest.yaml, /plugin/widgets.yaml, /plugin/schema.sql are required" && exit 1)

# Default port for local runs; the Plugin Manager overrides this at runtime.
ENV PORT=8080
EXPOSE 8080

# PORT is always injected by the Plugin Manager — never hard-code it.
# --experimental-strip-types lets us run .ts directly on Node 22.
# --experimental-sqlite enables the built-in `node:sqlite` module on Node 22.
ENTRYPOINT ["node", "--experimental-strip-types", "--experimental-sqlite", "/plugin/server.ts"]
