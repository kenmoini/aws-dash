import { buildApp, createDeps, type AppDeps } from "./app.js";
import { ConfigError } from "./config.js";

function createDepsOrExit(): AppDeps {
  try {
    return createDeps();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`aws-dash: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

const deps = createDepsOrExit();
const app = await buildApp(deps);
await app.listen({ port: deps.settings.port, host: deps.settings.host });
app.log.info({ port: deps.settings.port, auth_mode: deps.settings.authMode, version: deps.version }, "aws-dash listening");

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    const timer = setTimeout(() => process.exit(1), 10_000);
    timer.unref();
    void app.close().then(() => process.exit(0)).catch(() => process.exit(1));
  });
}
