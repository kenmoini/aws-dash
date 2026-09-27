import { buildApp, createDeps } from "./app.js";

const deps = createDeps();
const app = await buildApp(deps);
await app.listen({ port: deps.settings.port, host: deps.settings.host });
app.log.info({ port: deps.settings.port, auth_mode: deps.settings.authMode, version: deps.version }, "aws-dash listening");

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close().then(() => process.exit(0));
  });
}
