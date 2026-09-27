import pino, { type Logger } from "pino";
import type { AppSettings } from "./config.js";

/** JSON logs to stdout; secrets are redacted by path so a stray debug log cannot leak a token. */
export function createLogger(settings: AppSettings): Logger {
  return pino({
    level: settings.logLevel,
    redact: {
      paths: ["req.headers.authorization", "*.access_token", "*.secret_access_key", "*.session_token", "*.token", "*.assertion"],
      censor: "[redacted]",
    },
  });
}
