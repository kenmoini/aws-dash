# syntax=docker/dockerfile:1
# Build stage runs on the build host's architecture; node_modules is pure JS (no optional native
# addons) so the tree copied into the final stage is architecture-independent.
FROM --platform=$BUILDPLATFORM registry.access.redhat.com/ubi10/nodejs-24:10.2-1779929679 AS build
WORKDIR /opt/app-root/src
COPY --chown=1001:0 package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts
COPY --chown=1001:0 tsconfig.json tsconfig.build.json ./
COPY --chown=1001:0 src ./src
RUN npm run build \
 && npm prune --omit=dev --omit=optional --ignore-scripts \
 && chmod -R g=u /opt/app-root/src

FROM registry.access.redhat.com/ubi10/nodejs-24-minimal:10.2-1788245909
LABEL org.opencontainers.image.title="aws-dash" \
      org.opencontainers.image.description="AWS workload identity demo dashboard for EKS, Kubernetes and OpenShift (ZTWIM)" \
      org.opencontainers.image.source="https://github.com/kenmoini/aws-dash" \
      io.openshift.expose-services="8080:http"
WORKDIR /opt/app-root/src
COPY --from=build --chown=1001:0 /opt/app-root/src/node_modules ./node_modules
COPY --from=build --chown=1001:0 /opt/app-root/src/dist ./dist
COPY --chown=1001:0 package.json ./
COPY --chown=1001:0 views ./views
COPY --chown=1001:0 public ./public
ENV NODE_ENV=production \
    PORT=8080 \
    AUTH_MODE=auto \
    AWS_CACHE_TTL_SECONDS=60 \
    CONTROLS_ENABLED=true \
    LOG_LEVEL=info \
    AWS_DEBUG=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
EXPOSE 8080
USER 1001
# Requires `podman build --format docker`; the OCI image format silently drops HEALTHCHECK.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD ["node", "dist/cli.js", "--healthcheck"]
CMD ["node", "dist/server.js"]
