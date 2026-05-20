# syntax=docker/dockerfile:1
FROM node:22-trixie-slim

WORKDIR /plugin

COPY manifest.yaml widgets.yaml package.json server.ts index.html ./

# Cycloid validates these at registration time; refuse to build without them.
RUN test -f /plugin/manifest.yaml && test -f /plugin/widgets.yaml \
    || (echo "ERROR: /plugin/manifest.yaml and /plugin/widgets.yaml are required" && exit 1)

# Default port for local runs; the Plugin Manager overrides this at runtime.
ENV PORT=8080
EXPOSE 8080

# PORT is always injected by the Plugin Manager — never hard-code it.
ENTRYPOINT ["node", "--experimental-strip-types", "/plugin/server.ts"]
