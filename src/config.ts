import os from "node:os";
import { blank, parseBool, type EnvLookup } from "./env.js";
import { ACCESS_CHECK_ACTION_NAMES, isAccessCheckAction, type AccessCheckAction } from "./identity/access-check-actions.js";

export const AUTH_MODES = ["auto", "static", "profile", "web-identity", "pod-identity", "imds"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];
export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface AppSettings {
  readonly port: number;
  readonly host: string;
  readonly authMode: AuthMode;
  readonly region: string | undefined;
  readonly cacheTtlSeconds: number;
  readonly controlsEnabled: boolean;
  readonly logLevel: LogLevel;
  readonly awsDebug: boolean;
  readonly imdsEnabled: boolean;
  readonly k8sInfoEnabled: boolean;
  readonly metricsEnabled: boolean;
  readonly accessCheckEnabled: boolean;
  readonly accessCheckActions: readonly AccessCheckAction[] | undefined;
  readonly spiffeEndpointSocket: string | undefined;
  readonly spiffeJwtAudience: string;
  readonly memoryLoadMaxMib: number;
  readonly cpuLoadMaxWorkers: number;
}

/** Parses every app setting once; invalid values throw a ConfigError naming the variable. */
export function settingsFromEnv(env: EnvLookup): AppSettings {
  return {
    port: intIn("PORT", env("PORT"), 8080, 1, 65535),
    host: blank(env("HOST")) ?? "0.0.0.0",
    authMode: oneOf("AUTH_MODE", env("AUTH_MODE"), AUTH_MODES, "auto"),
    region: blank(env("AWS_REGION")) ?? blank(env("AWS_DEFAULT_REGION")),
    cacheTtlSeconds: nonNegativeInt("AWS_CACHE_TTL_SECONDS", env("AWS_CACHE_TTL_SECONDS"), 60),
    controlsEnabled: bool("CONTROLS_ENABLED", env("CONTROLS_ENABLED"), true),
    logLevel: oneOf("LOG_LEVEL", env("LOG_LEVEL"), LOG_LEVELS, "info"),
    awsDebug: bool("AWS_DEBUG", env("AWS_DEBUG"), false),
    imdsEnabled: bool("IMDS_ENABLED", env("IMDS_ENABLED"), true),
    k8sInfoEnabled: bool("K8S_INFO_ENABLED", env("K8S_INFO_ENABLED"), true),
    metricsEnabled: bool("METRICS_ENABLED", env("METRICS_ENABLED"), true),
    accessCheckEnabled: bool("ACCESS_CHECK_ENABLED", env("ACCESS_CHECK_ENABLED"), true),
    accessCheckActions: actionList("ACCESS_CHECK_ACTIONS", env("ACCESS_CHECK_ACTIONS")),
    spiffeEndpointSocket: blank(env("SPIFFE_ENDPOINT_SOCKET")),
    spiffeJwtAudience: blank(env("SPIFFE_JWT_AUDIENCE")) ?? "aws-dash",
    memoryLoadMaxMib: positiveInt("MEMORY_LOAD_MAX_MIB", env("MEMORY_LOAD_MAX_MIB"), 4096),
    cpuLoadMaxWorkers: positiveInt("CPU_LOAD_MAX_WORKERS", env("CPU_LOAD_MAX_WORKERS"), os.availableParallelism()),
  };
}

function invalid(name: string, value: string | undefined, expected: string): ConfigError {
  return new ConfigError(`${name} must be ${expected}, got '${value}'`);
}

function bool(name: string, value: string | undefined, fallback: boolean): boolean {
  if (blank(value) === undefined) return fallback;
  const parsed = parseBool(value);
  if (parsed === undefined) throw invalid(name, value, "true or false");
  return parsed;
}

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  const v = blank(value);
  if (v === undefined) return fallback;
  const lower = v.toLowerCase();
  const match = allowed.find((a) => a === lower);
  if (match === undefined) throw invalid(name, value, `one of ${allowed.join(", ")}`);
  return match;
}

function parseInteger(value: string | undefined): number | undefined {
  const v = blank(value);
  return v !== undefined && /^-?\d+$/.test(v) ? Number(v) : undefined;
}

function nonNegativeInt(name: string, value: string | undefined, fallback: number): number {
  if (blank(value) === undefined) return fallback;
  const n = parseInteger(value);
  if (n === undefined || n < 0) throw invalid(name, value, "a non-negative integer");
  return n;
}

function positiveInt(name: string, value: string | undefined, fallback: number): number {
  if (blank(value) === undefined) return fallback;
  const n = parseInteger(value);
  if (n === undefined || n < 1) throw invalid(name, value, "a positive integer");
  return n;
}

function intIn(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (blank(value) === undefined) return fallback;
  const n = parseInteger(value);
  if (n === undefined || n < min || n > max) throw invalid(name, value, `an integer between ${min} and ${max}`);
  return n;
}

function actionList(name: string, value: string | undefined): readonly AccessCheckAction[] | undefined {
  const v = blank(value);
  if (v === undefined) return undefined;
  const names = v.split(",").map((s) => s.trim()).filter((s) => s !== "");
  const bad = names.find((n) => !isAccessCheckAction(n));
  if (bad !== undefined) throw invalid(name, bad, `a comma-separated subset of ${ACCESS_CHECK_ACTION_NAMES.join(", ")}`);
  return names.filter(isAccessCheckAction);
}
