# aws-dash Phase 1 — Scaffold + Runtime Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A container image that serves the Runtime tab (container/cgroup/pod introspection) and all five controls (liveness, readiness, CPU load, memory load, crash) with health probes, a self-probe healthcheck, CI, and Kustomize base + OpenShift overlays — with no AWS dependency yet.

**Architecture:** Fastify 5 app built by `buildApp(deps)` where every external thing (env, clock, filesystem root, process exit, worker factory) is injectable. Server-rendered Eta templates + vendored htmx; each fragment has exactly one template that both the page and the `/partials/*` endpoint render. Controls mutate in-memory state; probes read it. Later phases add the AWS, Identity, metrics and k8s modules on top of this skeleton without changing it.

**Tech Stack:** Node 24 LTS, TypeScript 5.9.3 (NodeNext ESM), Fastify 5.12.5, @fastify/static 10.1.5, @fastify/formbody 9.0.0, Eta 4.6.0, Pino 10.3.1, vitest 5.0.2, tsx 4.23.15, htmx 2.0.11 (vendored), UBI10 nodejs-24 images, Kustomize.

**Spec:** `docs/superpowers/specs/2026-09-27-aws-dash-design.md` (sections 1–3, 7, 9–14 apply to this phase). Later phases: Phase 2 credentials + inventory, Phase 3 Identity tab + EKS overlays, Phase 4 SPIFFE/k8s/ZTWIM, Phase 5 docs.

## Global Constraints

- Node `>=24 <27` (`engines`, `.nvmrc` = `24`); exact-pinned deps (`.npmrc` `save-exact=true`); TypeScript **5.9.3** (never `latest`, which is 7.x).
- ESM only: `"type": "module"`, `module`/`moduleResolution` = `NodeNext`, relative imports end in `.js`, `verbatimModuleSyntax`, `strict`, `noUncheckedIndexedAccess`.
- HTTP conventions (parity with gcp-dash/azure-dash): JSON keys are **snake_case**; `HX-Request: true` → HTML fragment, otherwise JSON; bad input → `422 {"detail": "..."}`; every `/controls/*` route → `403 {"detail":"controls are disabled (CONTROLS_ENABLED=false)"}` when disabled; probes return `{"status":"ok"}` or `503 {"status":"failing","reason":"<liveness|readiness> disabled via controls"}`.
- Port **8080**, host `0.0.0.0`. The app writes nothing to disk. Image runs as an **arbitrary UID with GID 0** (`chmod g=u`, `USER 1001`, no `runAsUser` in manifests).
- No CDNs: htmx is vendored at `public/js/htmx.min.js`. One hand-written stylesheet `public/css/site.css` with CSS variables, AWS accent `#ff9900`, topbar `#232f3e`.
- Tests never touch the network. Filesystem introspection takes a `root` directory so tests use a temp dir.
- Eta path rule (verified): root-relative template names start with `/` — `layout("/layout", {...})`, `include("/partials/runtime", it)`. Never use bare `"layout"` or `"./x"` from a nested template. (`include("/partials/…")` was verified against Eta 4.6.0; if `layout("/layout")` ever fails to resolve from `views/pages/`, `layout("../layout", {...})` is the verified equivalent.)
- Commit after every task with the message shown; commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

Inputs the spec implies that a demo user will hit; each has a pinned test in the owning task:

1. `POST /controls/memory` with `mib` larger than the cgroup limit must still be accepted (that *is* the demo) but the controls card must show the OOM warning — Task 9 tests the warning text when `target_mib * 1 MiB > memory_limit_bytes`.
2. `POST /controls/cpu` with `workers=64` on a 2-core box must clamp to 2, not reject — Task 3 (`start(64)` → `workers === 2`) and Task 9 (route reports clamped count).
3. Crash must stop CPU workers and release memory before exiting so the exit code is the requested one, not 137 — Task 9 asserts fake exit received the code and both loads report inactive.
4. cgroup files that exist but are unreadable (EACCES on OpenShift) must yield `null` fields, not a 500 on `/` — Task 7 tests a 000-mode file.
5. `CONTROLS_ENABLED=false` must hide buttons **and** block POSTs — Task 9 tests both the 403 and that `/partials/controls` contains "Controls are disabled".

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `.npmrc`, `.nvmrc`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.gitignore`, `.containerignore`, `tests/smoke.test.ts`

**Interfaces:**
- Produces: `npm test`, `npm run typecheck`, `npm run build`, `npm run dev` scripts every later task relies on.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "aws-dash",
  "version": "0.1.0",
  "private": true,
  "description": "AWS workload identity demo dashboard for EKS, Kubernetes and OpenShift (ZTWIM)",
  "type": "module",
  "engines": { "node": ">=24 <27" },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "healthcheck": "node dist/cli.js --healthcheck",
    "kustomize:check": "scripts/kustomize-check.sh"
  },
  "dependencies": {
    "@fastify/formbody": "9.0.0",
    "@fastify/static": "10.1.5",
    "eta": "4.6.0",
    "fastify": "5.12.5",
    "pino": "10.3.1"
  },
  "devDependencies": {
    "@types/node": "24.19.0",
    "pino-pretty": "13.1.3",
    "tsx": "4.23.15",
    "typescript": "5.9.3",
    "vitest": "5.0.2"
  }
}
```

- [ ] **Step 2: Create .npmrc, .nvmrc, tsconfig files, vitest config**

`.npmrc`:
```
save-exact=true
fund=false
audit=false
```

`.nvmrc`:
```
24
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "noEmit": true
  },
  "include": ["src", "tests", "vitest.config.ts"]
}
```

`tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "outDir": "dist", "rootDir": "src", "sourceMap": false },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
});
```

- [ ] **Step 3: Create .gitignore and .containerignore**

`.gitignore`:
```
node_modules/
dist/
coverage/
.DS_Store
deploy/**/secret.yaml
.claude/
.superpowers/
```

`.containerignore`:
```
.git
.github
node_modules
dist
tests
docs
deploy
scripts
*.md
.claude
.superpowers
```

- [ ] **Step 4: Write a smoke test**

`tests/smoke.test.ts`:
```ts
import { describe, expect, it } from "vitest";

describe("toolchain", () => {
  it("runs under node 24 or newer", () => {
    expect(Number(process.versions.node.split(".")[0])).toBeGreaterThanOrEqual(24);
  });
});
```

- [ ] **Step 5: Install and run**

Run: `npm install && npm test && npm run typecheck`
Expected: `package-lock.json` created; 1 test passes; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .npmrc .nvmrc tsconfig.json tsconfig.build.json vitest.config.ts .gitignore .containerignore tests/smoke.test.ts
git commit -m "chore: scaffold TypeScript project with fastify, eta and vitest"
```

---

### Task 2: Environment lookup and settings

**Files:**
- Create: `src/env.ts`, `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `type EnvLookup = (name: string) => string | undefined`; `processEnv: EnvLookup`; `blank(v): string | undefined`; `parseBool(v): boolean | undefined`; `interface AppSettings`; `settingsFromEnv(env): AppSettings`; `class ConfigError extends Error`; `AUTH_MODES`, `type AuthMode`, `type LogLevel`.

- [ ] **Step 1: Write the failing tests**

`tests/config.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { blank, parseBool, type EnvLookup } from "../src/env.js";
import { ConfigError, settingsFromEnv } from "../src/config.js";

const env = (vars: Record<string, string>): EnvLookup => (name) => vars[name];

describe("env helpers", () => {
  it("blank() trims and treats empty as undefined", () => {
    expect(blank("  x ")).toBe("x");
    expect(blank("   ")).toBeUndefined();
    expect(blank(undefined)).toBeUndefined();
  });
  it("parseBool() accepts the usual spellings", () => {
    for (const v of ["1", "true", "YES", "on"]) expect(parseBool(v)).toBe(true);
    for (const v of ["0", "false", "No", "off"]) expect(parseBool(v)).toBe(false);
    expect(parseBool("maybe")).toBeUndefined();
  });
});

describe("settingsFromEnv", () => {
  it("applies defaults", () => {
    const s = settingsFromEnv(env({}));
    expect(s).toMatchObject({
      port: 8080, host: "0.0.0.0", authMode: "auto", region: undefined, cacheTtlSeconds: 60,
      controlsEnabled: true, logLevel: "info", awsDebug: false, imdsEnabled: true,
      k8sInfoEnabled: true, metricsEnabled: true, accessCheckEnabled: true,
      spiffeEndpointSocket: undefined, spiffeJwtAudience: "aws-dash", memoryLoadMaxMib: 4096,
    });
    expect(s.cpuLoadMaxWorkers).toBeGreaterThanOrEqual(1);
  });
  it("reads values", () => {
    const s = settingsFromEnv(env({
      PORT: "9090", AUTH_MODE: "web-identity", AWS_REGION: "eu-west-1", AWS_CACHE_TTL_SECONDS: "5",
      CONTROLS_ENABLED: "off", LOG_LEVEL: "debug", AWS_DEBUG: "1", MEMORY_LOAD_MAX_MIB: "512", CPU_LOAD_MAX_WORKERS: "3",
      SPIFFE_ENDPOINT_SOCKET: "unix:///spiffe-workload-api/spire-agent.sock", SPIFFE_JWT_AUDIENCE: "demo",
    }));
    expect(s).toMatchObject({
      port: 9090, authMode: "web-identity", region: "eu-west-1", cacheTtlSeconds: 5, controlsEnabled: false,
      logLevel: "debug", awsDebug: true, memoryLoadMaxMib: 512, cpuLoadMaxWorkers: 3,
      spiffeEndpointSocket: "unix:///spiffe-workload-api/spire-agent.sock", spiffeJwtAudience: "demo",
    });
  });
  it("falls back to AWS_DEFAULT_REGION and treats blanks as unset", () => {
    expect(settingsFromEnv(env({ AWS_REGION: " ", AWS_DEFAULT_REGION: "us-west-2" })).region).toBe("us-west-2");
    expect(settingsFromEnv(env({ AUTH_MODE: "" })).authMode).toBe("auto");
  });
  it.each([
    [{ AUTH_MODE: "magic" }, "AUTH_MODE must be one of auto, static, profile, web-identity, pod-identity, imds, got 'magic'"],
    [{ PORT: "http" }, "PORT must be an integer between 1 and 65535, got 'http'"],
    [{ AWS_CACHE_TTL_SECONDS: "-1" }, "AWS_CACHE_TTL_SECONDS must be a non-negative integer, got '-1'"],
    [{ CONTROLS_ENABLED: "sometimes" }, "CONTROLS_ENABLED must be true or false, got 'sometimes'"],
    [{ LOG_LEVEL: "loud" }, "LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent, got 'loud'"],
    [{ MEMORY_LOAD_MAX_MIB: "0" }, "MEMORY_LOAD_MAX_MIB must be a positive integer, got '0'"],
  ])("rejects %o", (vars, message) => {
    expect(() => settingsFromEnv(env(vars))).toThrow(new ConfigError(message));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/env.js`.

- [ ] **Step 3: Implement env.ts and config.ts**

`src/env.ts`:
```ts
/** Reads one environment variable; injectable so tests never touch process.env. */
export type EnvLookup = (name: string) => string | undefined;

export const processEnv: EnvLookup = (name) => process.env[name];

/** Trimmed value, or undefined when unset/blank — blank env vars count as unset everywhere. */
export function blank(value: string | undefined | null): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

export function parseBool(value: string | undefined): boolean | undefined {
  switch (value?.trim().toLowerCase()) {
    case "1": case "true": case "yes": case "on": return true;
    case "0": case "false": case "no": case "off": return false;
    default: return undefined;
  }
}
```

`src/config.ts`:
```ts
import os from "node:os";
import { blank, parseBool, type EnvLookup } from "./env.js";

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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/config.test.ts && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/env.ts src/config.ts tests/config.test.ts
git commit -m "feat: parse app settings from the environment"
```

---

### Task 3: CPU load via worker threads

**Files:**
- Create: `src/load/cpu-load.ts`
- Test: `tests/cpu-load.test.ts`, `tests/support/fake-worker-factory.ts`

**Interfaces:**
- Produces: `interface CpuLoadStatus { active: boolean; workers: number }`; `interface CpuWorker { stopped: Promise<void>; terminate(): Promise<unknown> }`; `type WorkerFactory = (stopFlag: SharedArrayBuffer, index: number) => CpuWorker`; `class CpuLoad { constructor(opts?: { maxWorkers?: number; factory?: WorkerFactory; stopTimeoutMs?: number }); status(): CpuLoadStatus; start(requested: number): CpuLoadStatus; stop(): Promise<CpuLoadStatus> }`.
- Node needs real threads to burn more than one core; a JS busy loop on the main thread would freeze the server. Workers spin on a shared `Int32Array` flag so `stop()` is a single atomic store. (Verified: a worker exits ~1 ms after the flag flips.)

- [ ] **Step 1: Write the fake worker factory and failing tests**

`tests/support/fake-worker-factory.ts`:
```ts
import type { CpuWorker, WorkerFactory } from "../../src/load/cpu-load.js";

/** Records worker creation; workers "exit" when the stop flag is set (polled) or when terminated. */
export class FakeWorkerFactory {
  readonly created: number[] = [];
  terminated = 0;
  /** When true, workers ignore the stop flag so stop() has to terminate them. */
  stubborn = false;

  readonly factory: WorkerFactory = (stopFlag, index) => {
    this.created.push(index);
    const flag = new Int32Array(stopFlag);
    let resolve!: () => void;
    const stopped = new Promise<void>((r) => { resolve = r; });
    const poll = setInterval(() => {
      if (!this.stubborn && Atomics.load(flag, 0) === 1) { clearInterval(poll); resolve(); }
    }, 5);
    const worker: CpuWorker = {
      stopped,
      terminate: async () => { this.terminated++; clearInterval(poll); resolve(); },
    };
    return worker;
  };
}
```

`tests/cpu-load.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { CpuLoad } from "../src/load/cpu-load.js";
import { FakeWorkerFactory } from "./support/fake-worker-factory.js";

describe("CpuLoad", () => {
  it("starts the requested number of workers, clamped to maxWorkers", () => {
    const fake = new FakeWorkerFactory();
    const load = new CpuLoad({ maxWorkers: 2, factory: fake.factory });
    expect(load.status()).toEqual({ active: false, workers: 0 });
    expect(load.start(64)).toEqual({ active: true, workers: 2 });
    expect(fake.created).toEqual([0, 1]);
  });

  it("clamps requests below 1 up to 1", () => {
    const fake = new FakeWorkerFactory();
    const load = new CpuLoad({ maxWorkers: 4, factory: fake.factory });
    expect(load.start(0).workers).toBe(1);
  });

  it("is idempotent while running", () => {
    const fake = new FakeWorkerFactory();
    const load = new CpuLoad({ maxWorkers: 4, factory: fake.factory });
    load.start(2);
    expect(load.start(4)).toEqual({ active: true, workers: 2 });
    expect(fake.created).toHaveLength(2);
  });

  it("stop() flips the flag and waits for workers to exit", async () => {
    const fake = new FakeWorkerFactory();
    const load = new CpuLoad({ maxWorkers: 4, factory: fake.factory });
    load.start(3);
    expect(await load.stop()).toEqual({ active: false, workers: 0 });
    expect(fake.terminated).toBe(0);
    expect(await load.stop()).toEqual({ active: false, workers: 0 });
  });

  it("stop() terminates workers that ignore the flag after the timeout", async () => {
    const fake = new FakeWorkerFactory();
    fake.stubborn = true;
    const load = new CpuLoad({ maxWorkers: 4, factory: fake.factory, stopTimeoutMs: 20 });
    load.start(2);
    await load.stop();
    expect(fake.terminated).toBe(2);
  });

  it("burns real worker threads and stops within 2 seconds", async () => {
    const load = new CpuLoad({ maxWorkers: 2 });
    expect(load.start(2).workers).toBe(2);
    const t0 = Date.now();
    expect((await load.stop()).active).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/cpu-load.test.ts`
Expected: FAIL — cannot resolve `../src/load/cpu-load.js`.

- [ ] **Step 3: Implement cpu-load.ts**

`src/load/cpu-load.ts`:
```ts
import os from "node:os";
import { Worker } from "node:worker_threads";

export interface CpuLoadStatus {
  active: boolean;
  workers: number;
}

export interface CpuWorker {
  /** Resolves once the worker has exited (for any reason). */
  stopped: Promise<void>;
  terminate(): Promise<unknown>;
}

export type WorkerFactory = (stopFlag: SharedArrayBuffer, index: number) => CpuWorker;

// Evaluated inside each worker; `require` is available in eval'd worker scripts.
const SPIN_SCRIPT = `
const { workerData } = require("node:worker_threads");
const flag = new Int32Array(workerData.stop);
while (Atomics.load(flag, 0) === 0) { /* burn */ }
`;

export const realWorkerFactory: WorkerFactory = (stopFlag, index) => {
  const worker = new Worker(SPIN_SCRIPT, { eval: true, workerData: { stop: stopFlag }, name: `cpu-load-${index}` });
  const stopped = new Promise<void>((resolve) => {
    worker.once("exit", () => resolve());
    worker.once("error", () => resolve());
  });
  return { stopped, terminate: () => worker.terminate() };
};

/** Burns CPU on N worker threads; the main thread stays free to answer probes. */
export class CpuLoad {
  private readonly maxWorkers: number;
  private readonly factory: WorkerFactory;
  private readonly stopTimeoutMs: number;
  private workers: CpuWorker[] = [];
  private flag: Int32Array | undefined;

  constructor(opts: { maxWorkers?: number; factory?: WorkerFactory; stopTimeoutMs?: number } = {}) {
    this.maxWorkers = Math.max(1, opts.maxWorkers ?? os.availableParallelism());
    this.factory = opts.factory ?? realWorkerFactory;
    this.stopTimeoutMs = opts.stopTimeoutMs ?? 2000;
  }

  status(): CpuLoadStatus {
    return { active: this.workers.length > 0, workers: this.workers.length };
  }

  start(requested: number): CpuLoadStatus {
    if (this.workers.length > 0) return this.status();
    const count = Math.min(Math.max(1, Math.trunc(requested)), this.maxWorkers);
    const buffer = new SharedArrayBuffer(4);
    this.flag = new Int32Array(buffer);
    for (let i = 0; i < count; i++) this.workers.push(this.factory(buffer, i));
    return this.status();
  }

  async stop(): Promise<CpuLoadStatus> {
    const workers = this.workers;
    if (workers.length === 0) return this.status();
    this.workers = [];
    if (this.flag) Atomics.store(this.flag, 0, 1);
    this.flag = undefined;
    await Promise.all(workers.map((w) => this.stopOne(w)));
    return this.status();
  }

  private async stopOne(worker: CpuWorker): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.stopTimeoutMs);
    });
    const outcome = await Promise.race([worker.stopped.then(() => "stopped" as const), timeout]);
    clearTimeout(timer);
    if (outcome === "timeout") await worker.terminate();
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/cpu-load.test.ts && npm run typecheck`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/load/cpu-load.ts tests/cpu-load.test.ts tests/support/fake-worker-factory.ts
git commit -m "feat: CPU load control backed by worker threads"
```

---

### Task 4: Memory load (off-heap allocate-and-hold)

**Files:**
- Create: `src/clock.ts`, `src/load/memory-load.ts`
- Test: `tests/memory-load.test.ts`, `tests/support/fake-clock.ts`

**Interfaces:**
- Produces: `interface Clock { now(): Date }`, `systemClock`; `type MemoryLoadPhase = "idle" | "allocating" | "holding" | "releasing"`; `interface MemoryLoadStatus { active, phase, target_mib, allocated_mib, started_at: string | null, rss_bytes, external_bytes, array_buffers_bytes, constrained_bytes: number | null, available_bytes: number | null }`; `class MemoryLoadActiveError extends Error`; `class MemoryLoad { constructor(opts?: { chunkMib?: number; clock?: Clock; yieldFn?: () => Promise<void> }); status(); start(mib: number): MemoryLoadStatus; stop(): MemoryLoadStatus; settled(): Promise<void> }`.
- Buffers are off-V8-heap, so `--max-old-space-size` does not cap them; the cgroup limit does → the kernel OOM-kills the container (exit 137), which is the demo. Allocation yields between chunks so probes keep answering.

- [ ] **Step 1: Write the fake clock and failing tests**

`tests/support/fake-clock.ts`:
```ts
import type { Clock } from "../../src/clock.js";

export class FakeClock implements Clock {
  constructor(private current = new Date("2026-01-01T00:00:00Z")) {}
  now(): Date { return new Date(this.current); }
  advance(ms: number): void { this.current = new Date(this.current.getTime() + ms); }
  set(iso: string): void { this.current = new Date(iso); }
}
```

`tests/memory-load.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { MemoryLoad, MemoryLoadActiveError } from "../src/load/memory-load.js";
import { FakeClock } from "./support/fake-clock.js";

const MIB = 1024 * 1024;

describe("MemoryLoad", () => {
  it("is idle initially and reports process memory", () => {
    const s = new MemoryLoad().status();
    expect(s).toMatchObject({ active: false, phase: "idle", target_mib: 0, allocated_mib: 0, started_at: null });
    expect(s.rss_bytes).toBeGreaterThan(0);
    expect(typeof s.available_bytes === "number" || s.available_bytes === null).toBe(true);
  });

  it("allocates in chunks, yielding between them, then holds", async () => {
    let yields = 0;
    const load = new MemoryLoad({ chunkMib: 1, clock: new FakeClock(), yieldFn: async () => { yields++; } });
    const first = load.start(3);
    expect(first).toMatchObject({ active: true, phase: "allocating", target_mib: 3, started_at: "2026-01-01T00:00:00.000Z" });
    await load.settled();
    const s = load.status();
    expect(s).toMatchObject({ active: true, phase: "holding", target_mib: 3, allocated_mib: 3 });
    expect(s.array_buffers_bytes).toBeGreaterThanOrEqual(3 * MIB);
    expect(yields).toBe(3);
  });

  it("rejects a second start while active", async () => {
    const load = new MemoryLoad({ chunkMib: 1 });
    load.start(1);
    expect(() => load.start(1)).toThrow(MemoryLoadActiveError);
    await load.settled();
    load.stop();
  });

  it("stop() releases chunks and returns to idle", async () => {
    const load = new MemoryLoad({ chunkMib: 1 });
    load.start(2);
    await load.settled();
    expect(load.stop()).toMatchObject({ active: false, phase: "idle", target_mib: 0, allocated_mib: 0, started_at: null });
  });

  it("stop() during allocation abandons the in-flight loop", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const load = new MemoryLoad({ chunkMib: 1, yieldFn: () => gate });
    load.start(5);
    expect(load.status().allocated_mib).toBe(1);
    load.stop();
    release();
    await load.settled();
    expect(load.status()).toMatchObject({ active: false, allocated_mib: 0, phase: "idle" });
  });

  it("start() after stop() works again", async () => {
    const load = new MemoryLoad({ chunkMib: 1 });
    load.start(1); await load.settled(); load.stop();
    expect(load.start(2).active).toBe(true);
    await load.settled();
    expect(load.status().allocated_mib).toBe(2);
    load.stop();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/memory-load.test.ts`
Expected: FAIL — cannot resolve `../src/load/memory-load.js`.

- [ ] **Step 3: Implement clock.ts and memory-load.ts**

`src/clock.ts`:
```ts
/** Injectable wall clock so tests control started_at/uptime and expiry countdowns. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
```

`src/load/memory-load.ts`:
```ts
import { setImmediate as setImmediatePromise } from "node:timers/promises";
import { systemClock, type Clock } from "../clock.js";

export type MemoryLoadPhase = "idle" | "allocating" | "holding" | "releasing";

export interface MemoryLoadStatus {
  active: boolean;
  phase: MemoryLoadPhase;
  target_mib: number;
  allocated_mib: number;
  started_at: string | null;
  rss_bytes: number;
  external_bytes: number;
  array_buffers_bytes: number;
  /** process.constrainedMemory(): the cgroup limit Node sees, or null when unknown. */
  constrained_bytes: number | null;
  available_bytes: number | null;
}

export class MemoryLoadActiveError extends Error {
  override name = "MemoryLoadActiveError";
  constructor() { super("memory load already active"); }
}

const MIB = 1024 * 1024;

/** Allocates and holds off-heap Buffers so container RSS climbs toward (and past) the cgroup limit. */
export class MemoryLoad {
  private readonly chunkMib: number;
  private readonly clock: Clock;
  private readonly yieldFn: () => Promise<void>;
  private chunks: Buffer[] = [];
  private phase: MemoryLoadPhase = "idle";
  private targetMib = 0;
  private startedAt: Date | null = null;
  private generation = 0;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(opts: { chunkMib?: number; clock?: Clock; yieldFn?: () => Promise<void> } = {}) {
    this.chunkMib = Math.max(1, opts.chunkMib ?? 64);
    this.clock = opts.clock ?? systemClock;
    this.yieldFn = opts.yieldFn ?? (() => setImmediatePromise());
  }

  status(): MemoryLoadStatus {
    const mem = process.memoryUsage();
    const constrained = process.constrainedMemory();
    return {
      active: this.phase !== "idle",
      phase: this.phase,
      target_mib: this.targetMib,
      allocated_mib: this.chunks.reduce((sum, c) => sum + c.length, 0) / MIB,
      started_at: this.startedAt?.toISOString() ?? null,
      rss_bytes: mem.rss,
      external_bytes: mem.external,
      array_buffers_bytes: mem.arrayBuffers,
      constrained_bytes: constrained > 0 ? constrained : null,
      available_bytes: typeof process.availableMemory === "function" ? process.availableMemory() : null,
    };
  }

  /** Kicks off allocation and returns immediately; await settled() to wait for it. */
  start(mib: number): MemoryLoadStatus {
    if (this.phase !== "idle") throw new MemoryLoadActiveError();
    this.targetMib = Math.max(1, Math.trunc(mib));
    this.startedAt = this.clock.now();
    this.phase = "allocating";
    const gen = ++this.generation;
    this.inFlight = this.allocate(gen);
    return this.status();
  }

  stop(): MemoryLoadStatus {
    this.generation++;
    this.phase = "releasing";
    this.chunks = [];
    this.targetMib = 0;
    this.startedAt = null;
    this.phase = "idle";
    return this.status();
  }

  settled(): Promise<void> {
    return this.inFlight;
  }

  private async allocate(gen: number): Promise<void> {
    let allocated = 0;
    while (allocated < this.targetMib && gen === this.generation) {
      const size = Math.min(this.chunkMib, this.targetMib - allocated);
      // allocUnsafe + fill touches every page so the kernel actually commits the memory.
      this.chunks.push(Buffer.allocUnsafe(size * MIB).fill(0x5a));
      allocated += size;
      await this.yieldFn();
    }
    if (gen === this.generation) this.phase = "holding";
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/memory-load.test.ts && npm run typecheck`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/clock.ts src/load/memory-load.ts tests/memory-load.test.ts tests/support/fake-clock.ts
git commit -m "feat: memory pressure control that allocates and holds off-heap buffers"
```

---

### Task 5: Probe state and the state snapshot

**Files:**
- Create: `src/state/runtime-state.ts`, `src/state/process-exit.ts`, `src/state/state-service.ts`
- Test: `tests/state.test.ts`, `tests/support/fake-exit.ts`

**Interfaces:**
- Consumes: `Clock` (Task 4), `CpuLoad`/`CpuLoadStatus` (Task 3), `MemoryLoad`/`MemoryLoadStatus` (Task 4), `AppSettings` (Task 2).
- Produces: `class RuntimeState { live: boolean; ready: boolean; readonly startedAt: Date; constructor(clock: Clock) }`; `type ProcessExit = (code: number) => void`, `realExit`; `interface StateSnapshot { live, ready, started_at: string, uptime_seconds: number, controls_enabled: boolean, cpu_load: CpuLoadStatus, memory_load: MemoryLoadStatus }`; `class StateService { constructor(state, cpu, memory, settings, clock); snapshot(): StateSnapshot }`.

- [ ] **Step 1: Write the fake exit and failing tests**

`tests/support/fake-exit.ts`:
```ts
import type { ProcessExit } from "../../src/state/process-exit.js";

export class FakeExit {
  readonly codes: number[] = [];
  readonly fn: ProcessExit = (code) => { this.codes.push(code); };
}
```

`tests/state.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { settingsFromEnv } from "../src/config.js";
import { CpuLoad } from "../src/load/cpu-load.js";
import { MemoryLoad } from "../src/load/memory-load.js";
import { RuntimeState } from "../src/state/runtime-state.js";
import { StateService } from "../src/state/state-service.js";
import { FakeClock } from "./support/fake-clock.js";
import { FakeWorkerFactory } from "./support/fake-worker-factory.js";

describe("RuntimeState", () => {
  it("starts healthy and records start time from the clock", () => {
    const clock = new FakeClock();
    const s = new RuntimeState(clock);
    expect(s.live).toBe(true);
    expect(s.ready).toBe(true);
    expect(s.startedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("StateService.snapshot", () => {
  it("combines probes, uptime, controls flag and load status with snake_case keys", () => {
    const clock = new FakeClock();
    const state = new RuntimeState(clock);
    const cpu = new CpuLoad({ maxWorkers: 2, factory: new FakeWorkerFactory().factory });
    const memory = new MemoryLoad({ chunkMib: 1, clock });
    const service = new StateService(state, cpu, memory, settingsFromEnv(() => undefined), clock);
    clock.advance(90_500);
    state.ready = false;
    cpu.start(1);
    const snap = service.snapshot();
    expect(snap).toMatchObject({
      live: true, ready: false, started_at: "2026-01-01T00:00:00.000Z", uptime_seconds: 90.5, controls_enabled: true,
      cpu_load: { active: true, workers: 1 },
      memory_load: { active: false, phase: "idle" },
    });
    expect(Object.keys(snap)).toEqual(["live", "ready", "started_at", "uptime_seconds", "controls_enabled", "cpu_load", "memory_load"]);
  });

  it("reflects CONTROLS_ENABLED=false", () => {
    const clock = new FakeClock();
    const service = new StateService(new RuntimeState(clock), new CpuLoad({ factory: new FakeWorkerFactory().factory }),
      new MemoryLoad(), settingsFromEnv((n) => (n === "CONTROLS_ENABLED" ? "false" : undefined)), clock);
    expect(service.snapshot().controls_enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/state.test.ts`
Expected: FAIL — cannot resolve `../src/state/runtime-state.js`.

- [ ] **Step 3: Implement the three state modules**

`src/state/runtime-state.ts`:
```ts
import type { Clock } from "../clock.js";

/** Probe flags flipped by the controls; in-memory only, so a restart resets them to healthy. */
export class RuntimeState {
  live = true;
  ready = true;
  readonly startedAt: Date;

  constructor(clock: Clock) {
    this.startedAt = clock.now();
  }
}
```

`src/state/process-exit.ts`:
```ts
/** Injectable so the crash control can be tested without killing the test runner. */
export type ProcessExit = (code: number) => void;

export const realExit: ProcessExit = (code) => process.exit(code);
```

`src/state/state-service.ts`:
```ts
import type { Clock } from "../clock.js";
import type { AppSettings } from "../config.js";
import type { CpuLoad, CpuLoadStatus } from "../load/cpu-load.js";
import type { MemoryLoad, MemoryLoadStatus } from "../load/memory-load.js";
import type { RuntimeState } from "./runtime-state.js";

/** JSON shape of GET /api/state; keys are snake_case for parity with the sibling apps. */
export interface StateSnapshot {
  live: boolean;
  ready: boolean;
  started_at: string;
  uptime_seconds: number;
  controls_enabled: boolean;
  cpu_load: CpuLoadStatus;
  memory_load: MemoryLoadStatus;
}

export class StateService {
  constructor(
    private readonly state: RuntimeState,
    private readonly cpu: CpuLoad,
    private readonly memory: MemoryLoad,
    private readonly settings: AppSettings,
    private readonly clock: Clock,
  ) {}

  snapshot(): StateSnapshot {
    const uptimeMs = this.clock.now().getTime() - this.state.startedAt.getTime();
    return {
      live: this.state.live,
      ready: this.state.ready,
      started_at: this.state.startedAt.toISOString(),
      uptime_seconds: Math.round(uptimeMs / 100) / 10,
      controls_enabled: this.settings.controlsEnabled,
      cpu_load: this.cpu.status(),
      memory_load: this.memory.status(),
    };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/state.test.ts && npm run typecheck`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/state tests/state.test.ts tests/support/fake-exit.ts
git commit -m "feat: probe state and /api/state snapshot model"
```

---

### Task 6: App bootstrap, logging, health endpoints

**Files:**
- Create: `src/paths.ts`, `src/logging.ts`, `src/app.ts`, `src/server.ts`, `src/routes/htmx.ts`, `src/routes/input.ts`, `src/routes/errors.ts`, `src/routes/health.ts`
- Test: `tests/support/app-factory.ts`, `tests/health.test.ts`, `tests/input.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces: `interface AppDeps { settings, env, clock, logger: pino.Logger, fsRoot: string, version: string, state: RuntimeState, cpu: CpuLoad, memory: MemoryLoad, stateService: StateService, exit: ProcessExit, crashDelayMs: number }`; `createDeps(overrides?: Partial<AppDeps>): AppDeps`; `buildApp(deps): Promise<FastifyInstance>`; `isHtmx(req): boolean`; `readInput(req): Input`, `inputBool(input, key)`, `inputInt(input, key, fallback, min, max)`; `errorBody(detail)`; `ROOT_DIR`, `PUBLIC_DIR`, `VIEWS_DIR`; test helper `testApp(opts)`.
- Routes are registered by plain functions `registerXRoutes(app, deps)`; routes never construct their own dependencies.

- [ ] **Step 1: Write the test app factory and failing tests**

`tests/support/app-factory.ts`:
```ts
import pino from "pino";
import { buildApp, createDeps, type AppDeps } from "../../src/app.js";
import { settingsFromEnv } from "../../src/config.js";
import { CpuLoad } from "../../src/load/cpu-load.js";
import { MemoryLoad } from "../../src/load/memory-load.js";
import { RuntimeState } from "../../src/state/runtime-state.js";
import { StateService } from "../../src/state/state-service.js";
import { FakeClock } from "./fake-clock.js";
import { FakeExit } from "./fake-exit.js";
import { FakeWorkerFactory } from "./fake-worker-factory.js";

export interface TestAppOptions {
  env?: Record<string, string>;
  fsRoot?: string;
  overrides?: Partial<AppDeps>;
}

/** Builds the app with every external dependency faked; nothing reaches the OS, network or AWS. */
export async function testApp(opts: TestAppOptions = {}) {
  const vars = opts.env ?? {};
  const env = (name: string) => vars[name];
  const settings = settingsFromEnv(env);
  const clock = new FakeClock();
  const exit = new FakeExit();
  const workers = new FakeWorkerFactory();
  const state = new RuntimeState(clock);
  const cpu = new CpuLoad({ maxWorkers: 2, factory: workers.factory });
  const memory = new MemoryLoad({ chunkMib: 1, clock });
  const deps = createDeps({
    settings, env, clock, logger: pino({ level: "silent" }), fsRoot: opts.fsRoot ?? "/nonexistent-root",
    state, cpu, memory, stateService: new StateService(state, cpu, memory, settings, clock),
    exit: exit.fn, crashDelayMs: 10, ...opts.overrides,
  });
  const app = await buildApp(deps);
  return { app, deps, clock, exit, workers, state, cpu, memory };
}
```

`tests/health.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { testApp } from "./support/app-factory.js";

describe("health endpoints", () => {
  let close = async () => {};
  afterEach(() => close());

  it("report ok while healthy", async () => {
    const { app } = await testApp();
    close = () => app.close();
    for (const path of ["/healthz/live", "/healthz/ready"]) {
      const res = await app.inject({ method: "GET", url: path });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.json()).toEqual({ status: "ok" });
    }
  });

  it("return 503 with a reason when a probe is disabled", async () => {
    const { app, state } = await testApp();
    close = () => app.close();
    state.live = false;
    expect((await app.inject({ url: "/healthz/live" })).json()).toEqual({ status: "failing", reason: "liveness disabled via controls" });
    expect((await app.inject({ url: "/healthz/live" })).statusCode).toBe(503);
    expect((await app.inject({ url: "/healthz/ready" })).statusCode).toBe(200);
    state.ready = false;
    const ready = await app.inject({ url: "/healthz/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().reason).toBe("readiness disabled via controls");
  });

  it("GET /api/state returns the snapshot", async () => {
    const { app, clock } = await testApp();
    close = () => app.close();
    clock.advance(5000);
    const res = await app.inject({ url: "/api/state" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ live: true, ready: true, uptime_seconds: 5, controls_enabled: true, cpu_load: { active: false } });
  });

  it("unknown routes return JSON 404", async () => {
    const { app } = await testApp();
    close = () => app.close();
    const res = await app.inject({ url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ detail: "not found: GET /nope" });
  });

  it("stops CPU and memory load on close", async () => {
    const { app, cpu, memory } = await testApp();
    cpu.start(1);
    memory.start(1);
    await memory.settled();
    await app.close();
    expect(cpu.status().active).toBe(false);
    expect(memory.status().active).toBe(false);
  });
});
```

`tests/input.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { inputBool, inputInt } from "../src/routes/input.js";

describe("input parsing", () => {
  it("inputBool reads the usual spellings and returns undefined otherwise", () => {
    expect(inputBool({ enabled: "true" }, "enabled")).toBe(true);
    expect(inputBool({ enabled: "off" }, "enabled")).toBe(false);
    expect(inputBool({ enabled: "x" }, "enabled")).toBeUndefined();
    expect(inputBool({}, "enabled")).toBeUndefined();
  });
  it("inputInt returns the fallback when absent, the value when in range, undefined otherwise", () => {
    expect(inputInt({}, "workers", 1, 1, 64)).toBe(1);
    expect(inputInt({ workers: " " }, "workers", 1, 1, 64)).toBe(1);
    expect(inputInt({ workers: "8" }, "workers", 1, 1, 64)).toBe(8);
    expect(inputInt({ workers: "65" }, "workers", 1, 1, 64)).toBeUndefined();
    expect(inputInt({ workers: "0" }, "workers", 1, 1, 64)).toBeUndefined();
    expect(inputInt({ workers: "abc" }, "workers", 1, 1, 64)).toBeUndefined();
    expect(inputInt({ workers: "2.5" }, "workers", 1, 1, 64)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/health.test.ts tests/input.test.ts`
Expected: FAIL — cannot resolve `../src/app.js` / `../src/routes/input.js`.

- [ ] **Step 3: Implement paths, logging, helpers, health routes, app and server**

`src/paths.ts`:
```ts
import path from "node:path";
import { fileURLToPath } from "node:url";

// Works from both src/ (tsx) and dist/ (node): one level up is the repo/app root.
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PUBLIC_DIR = path.join(ROOT_DIR, "public");
export const VIEWS_DIR = path.join(ROOT_DIR, "views");
```

`src/logging.ts`:
```ts
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
```

`src/routes/htmx.ts`:
```ts
import type { FastifyRequest } from "fastify";

/** htmx sets HX-Request on every request it makes; those get HTML fragments, everything else gets JSON. */
export function isHtmx(req: FastifyRequest): boolean {
  return req.headers["hx-request"] === "true";
}
```

`src/routes/input.ts`:
```ts
import type { FastifyRequest } from "fastify";
import { blank, parseBool } from "../env.js";

export type Input = Record<string, string>;

/** Merges query string and form body (form wins) into a flat string map. */
export function readInput(req: FastifyRequest): Input {
  const out: Input = {};
  for (const source of [req.query, req.body]) {
    if (source && typeof source === "object") {
      for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
        if (v !== undefined && v !== null) out[k] = Array.isArray(v) ? String(v[0] ?? "") : String(v);
      }
    }
  }
  return out;
}

export function inputBool(input: Input, key: string): boolean | undefined {
  return key in input ? parseBool(input[key]) : undefined;
}

/** Absent/blank → fallback; integer within [min, max] → value; anything else → undefined (caller answers 422). */
export function inputInt(input: Input, key: string, fallback: number, min: number, max: number): number | undefined {
  const raw = blank(input[key]);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= min && n <= max ? n : undefined;
}
```

`src/routes/errors.ts`:
```ts
export interface ErrorBody {
  detail: string;
}

export function errorBody(detail: string): ErrorBody {
  return { detail };
}
```

`src/routes/health.ts`:
```ts
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppDeps } from "../app.js";

function probe(reply: FastifyReply, ok: boolean, what: "liveness" | "readiness") {
  if (ok) return reply.send({ status: "ok" });
  return reply.code(503).send({ status: "failing", reason: `${what} disabled via controls` });
}

export function registerHealthRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/healthz/live", (_req, reply) => probe(reply, deps.state.live, "liveness"));
  app.get("/healthz/ready", (_req, reply) => probe(reply, deps.state.ready, "readiness"));
  app.get("/api/state", () => deps.stateService.snapshot());
}
```

`src/app.ts`:
```ts
import { createRequire } from "node:module";
import formbody from "@fastify/formbody";
import Fastify, { type FastifyInstance } from "fastify";
import type { Logger } from "pino";
import { systemClock, type Clock } from "./clock.js";
import { settingsFromEnv, type AppSettings } from "./config.js";
import { processEnv, type EnvLookup } from "./env.js";
import { CpuLoad } from "./load/cpu-load.js";
import { MemoryLoad } from "./load/memory-load.js";
import { createLogger } from "./logging.js";
import { errorBody } from "./routes/errors.js";
import { registerHealthRoutes } from "./routes/health.js";
import { realExit, type ProcessExit } from "./state/process-exit.js";
import { RuntimeState } from "./state/runtime-state.js";
import { StateService } from "./state/state-service.js";

export interface AppDeps {
  settings: AppSettings;
  env: EnvLookup;
  clock: Clock;
  logger: Logger;
  /** "/" in production; a temp dir in tests so /proc, /sys and /etc can be faked. */
  fsRoot: string;
  version: string;
  state: RuntimeState;
  cpu: CpuLoad;
  memory: MemoryLoad;
  stateService: StateService;
  exit: ProcessExit;
  crashDelayMs: number;
}

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

/** Production wiring; tests pass overrides for everything that touches the outside world. */
export function createDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const env = overrides.env ?? processEnv;
  const settings = overrides.settings ?? settingsFromEnv(env);
  const clock = overrides.clock ?? systemClock;
  const state = overrides.state ?? new RuntimeState(clock);
  const cpu = overrides.cpu ?? new CpuLoad({ maxWorkers: settings.cpuLoadMaxWorkers });
  const memory = overrides.memory ?? new MemoryLoad({ clock });
  return {
    settings, env, clock, state, cpu, memory,
    logger: overrides.logger ?? createLogger(settings),
    fsRoot: overrides.fsRoot ?? "/",
    version: overrides.version ?? pkg.version,
    stateService: overrides.stateService ?? new StateService(state, cpu, memory, settings, clock),
    exit: overrides.exit ?? realExit,
    crashDelayMs: overrides.crashDelayMs ?? 500,
  };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: deps.logger, disableRequestLogging: true, trustProxy: true });
  await app.register(formbody);

  app.setNotFoundHandler((req, reply) => reply.code(404).send(errorBody(`not found: ${req.method} ${req.url}`)));
  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, "unhandled error");
    return reply.code(status).send(errorBody(status >= 500 ? "internal error" : err.message));
  });
  app.addHook("onClose", async () => {
    await deps.cpu.stop();
    deps.memory.stop();
  });

  registerHealthRoutes(app, deps);
  return app;
}
```

`src/server.ts`:
```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/health.test.ts tests/input.test.ts && npm run typecheck`
Expected: 7 tests pass. Then `npm run dev` in one terminal and `curl -s localhost:8080/healthz/live` → `{"status":"ok"}`; Ctrl-C exits cleanly.

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts src/logging.ts src/app.ts src/server.ts src/routes tests/support/app-factory.ts tests/health.test.ts tests/input.test.ts
git commit -m "feat: fastify app bootstrap with health probes and JSON error handling"
```

---

### Task 7: Runtime introspection (container, pod, cgroup)

**Files:**
- Create: `src/runtime/runtime-info.ts`
- Test: `tests/runtime-info.test.ts`, `tests/support/fake-root.ts`

**Interfaces:**
- Consumes: `EnvLookup`, `blank` (Task 2).
- Produces: `interface PodInfo { name, namespace, node, ip, service_account: string | null }`; `interface CgroupInfo { version: "v1" | "v2" | "none"; cpu_limit_cores: number | null; memory_limit_bytes: number | null; memory_usage_bytes: number | null }`; `interface RuntimeInfo { hostname, container_runtime, orchestrator, pod: PodInfo | null, cgroup: CgroupInfo, os, node_version, cpus_visible, constrained_memory_bytes: number | null, uid: number | null, gid: number | null, pid, load_average_1m: number | null, env_hints: Record<string, string | null> }`; `collectRuntimeInfo(root: string, env: EnvLookup): RuntimeInfo`; `readMemoryLimitBytes(root: string): number | null`.
- Every file read goes through `root` so tests fake `/proc`, `/sys`, `/etc`. Unreadable files (EACCES on OpenShift) yield `null`, never throw.

- [ ] **Step 1: Write the fake root and failing tests**

`tests/support/fake-root.ts`:
```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A temp directory standing in for "/" so /proc, /sys and /etc can be faked. */
export class FakeRoot {
  readonly path = fs.mkdtempSync(path.join(os.tmpdir(), "aws-dash-root-"));

  write(relative: string, content: string, mode?: number): this {
    const full = path.join(this.path, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    if (mode !== undefined) fs.chmodSync(full, mode);
    return this;
  }

  dir(relative: string): this {
    fs.mkdirSync(path.join(this.path, relative), { recursive: true });
    return this;
  }

  cleanup(): void {
    fs.rmSync(this.path, { recursive: true, force: true });
  }
}
```

`tests/runtime-info.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import type { EnvLookup } from "../src/env.js";
import { collectRuntimeInfo, readMemoryLimitBytes } from "../src/runtime/runtime-info.js";
import { FakeRoot } from "./support/fake-root.js";

const roots: FakeRoot[] = [];
const root = () => { const r = new FakeRoot(); roots.push(r); return r; };
afterEach(() => { for (const r of roots.splice(0)) r.cleanup(); });
const env = (vars: Record<string, string> = {}): EnvLookup => (name) => vars[name];
const get = (r: FakeRoot, vars?: Record<string, string>) => collectRuntimeInfo(r.path, env(vars));

describe("container runtime detection", () => {
  it("podman via /run/.containerenv", () => expect(get(root().write("run/.containerenv", "")).container_runtime).toBe("podman"));
  it("docker via /.dockerenv", () => expect(get(root().write(".dockerenv", "")).container_runtime).toBe("docker"));
  it("$container env var", () => expect(get(root(), { container: "oci" }).container_runtime).toBe("oci"));
  it.each([
    ["0::/kubepods.slice/crio-abc.scope", "cri-o"],
    ["0::/kubepods/besteffort/containerd-abc", "containerd"],
    ["0::/docker/abc", "docker"],
    ["0::/kubepods/pod123", "kubernetes"],
    ["0::/", "none"],
  ])("from /proc/self/cgroup %s", (cgroup, expected) => {
    expect(get(root().write("proc/self/cgroup", cgroup)).container_runtime).toBe(expected);
  });
});

describe("orchestrator and pod", () => {
  it("reads downward API fields when KUBERNETES_SERVICE_HOST is set", () => {
    const info = get(root(), {
      KUBERNETES_SERVICE_HOST: "10.0.0.1", POD_NAME: "aws-dash-abc", POD_NAMESPACE: "aws-dash",
      NODE_NAME: "ip-10-0-1-5.ec2.internal", POD_IP: "10.244.0.5", SERVICE_ACCOUNT: "aws-dash",
    });
    expect(info.orchestrator).toBe("kubernetes");
    expect(info.pod).toEqual({ name: "aws-dash-abc", namespace: "aws-dash", node: "ip-10-0-1-5.ec2.internal", ip: "10.244.0.5", service_account: "aws-dash" });
    expect(info.env_hints["KUBERNETES_SERVICE_HOST"]).toBe("10.0.0.1");
  });
  it("falls back to the service-account namespace file", () => {
    const info = get(root().write("var/run/secrets/kubernetes.io/serviceaccount/namespace", "from-file\n"));
    expect(info.orchestrator).toBe("kubernetes");
    expect(info.pod?.namespace).toBe("from-file");
    expect(info.pod?.name).toBeNull();
  });
  it("no orchestrator means no pod", () => {
    const info = get(root());
    expect(info.orchestrator).toBe("none");
    expect(info.pod).toBeNull();
  });
});

describe("cgroup", () => {
  it("v2 limits", () => {
    const r = root().write("sys/fs/cgroup/cgroup.controllers", "cpu memory")
      .write("sys/fs/cgroup/cpu.max", "50000 100000\n").write("sys/fs/cgroup/memory.max", "536870912\n")
      .write("sys/fs/cgroup/memory.current", "1048576\n");
    expect(get(r).cgroup).toEqual({ version: "v2", cpu_limit_cores: 0.5, memory_limit_bytes: 536870912, memory_usage_bytes: 1048576 });
    expect(readMemoryLimitBytes(r.path)).toBe(536870912);
  });
  it("v2 unlimited", () => {
    const r = root().write("sys/fs/cgroup/cgroup.controllers", "").write("sys/fs/cgroup/cpu.max", "max 100000").write("sys/fs/cgroup/memory.max", "max");
    expect(get(r).cgroup).toEqual({ version: "v2", cpu_limit_cores: null, memory_limit_bytes: null, memory_usage_bytes: null });
  });
  it("v1 limits; huge limit means unlimited", () => {
    const r = root().write("sys/fs/cgroup/cpu/cpu.cfs_quota_us", "200000").write("sys/fs/cgroup/cpu/cpu.cfs_period_us", "100000")
      .write("sys/fs/cgroup/memory/memory.limit_in_bytes", "9223372036854771712").write("sys/fs/cgroup/memory/memory.usage_in_bytes", "4096");
    expect(get(r).cgroup).toEqual({ version: "v1", cpu_limit_cores: 2, memory_limit_bytes: null, memory_usage_bytes: 4096 });
  });
  it("v1 negative quota is unlimited", () => {
    const r = root().write("sys/fs/cgroup/cpu/cpu.cfs_quota_us", "-1").write("sys/fs/cgroup/cpu/cpu.cfs_period_us", "100000");
    expect(get(r).cgroup.cpu_limit_cores).toBeNull();
  });
  it("no cgroup fs", () => expect(get(root()).cgroup).toEqual({ version: "none", cpu_limit_cores: null, memory_limit_bytes: null, memory_usage_bytes: null }));
  it.skipIf(process.getuid?.() === 0)("unreadable files yield null instead of throwing (EACCES)", () => {
    const r = root().write("sys/fs/cgroup/cgroup.controllers", "cpu memory").write("sys/fs/cgroup/memory.max", "1024", 0o000).write("sys/fs/cgroup/cpu.max", "max 100000");
    expect(get(r).cgroup).toEqual({ version: "v2", cpu_limit_cores: null, memory_limit_bytes: null, memory_usage_bytes: null });
  });
});

describe("os, ids, load", () => {
  it("reads PRETTY_NAME, uid/gid from /proc/self/status and 1m load", () => {
    const r = root().write("etc/os-release", 'NAME="Red Hat Enterprise Linux"\nPRETTY_NAME="Red Hat Enterprise Linux 10.1 (Coughlan)"\n')
      .write("proc/self/status", "Name:\tnode\nUid:\t1000710000\t1000710000\t1000710000\t1000710000\nGid:\t0\t0\t0\t0\n")
      .write("proc/loadavg", "0.42 0.30 0.20 1/100 12345\n");
    const info = get(r);
    expect(info.os).toBe("Red Hat Enterprise Linux 10.1 (Coughlan)");
    expect(info.uid).toBe(1000710000);
    expect(info.gid).toBe(0);
    expect(info.load_average_1m).toBe(0.42);
    expect(info.node_version).toBe(process.version);
    expect(info.pid).toBe(process.pid);
    expect(info.cpus_visible).toBeGreaterThan(0);
    expect(typeof info.hostname).toBe("string");
  });
  it("falls back to process ids and os.release when files are missing", () => {
    const info = get(root());
    expect(info.uid).toBe(process.getuid?.() ?? null);
    expect(info.os.length).toBeGreaterThan(0);
    expect(info.load_average_1m).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/runtime-info.test.ts`
Expected: FAIL — cannot resolve `../src/runtime/runtime-info.js`.

- [ ] **Step 3: Implement runtime-info.ts**

`src/runtime/runtime-info.ts`:
```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { blank, type EnvLookup } from "../env.js";

export interface PodInfo {
  name: string | null;
  namespace: string | null;
  node: string | null;
  ip: string | null;
  service_account: string | null;
}

export interface CgroupInfo {
  version: "v1" | "v2" | "none";
  cpu_limit_cores: number | null;
  memory_limit_bytes: number | null;
  memory_usage_bytes: number | null;
}

export interface RuntimeInfo {
  hostname: string;
  container_runtime: string;
  orchestrator: "kubernetes" | "none";
  pod: PodInfo | null;
  cgroup: CgroupInfo;
  os: string;
  node_version: string;
  cpus_visible: number;
  constrained_memory_bytes: number | null;
  uid: number | null;
  gid: number | null;
  pid: number;
  load_average_1m: number | null;
  env_hints: Record<string, string | null>;
}

/** "max", negative, unparsable or >= 2^62 all mean "no limit". */
const UNLIMITED = 2 ** 62;
const SA_NAMESPACE = "var/run/secrets/kubernetes.io/serviceaccount/namespace";

/** Container/Kubernetes/cgroup introspection. `root` is "/" in production, a temp dir in tests. */
export function collectRuntimeInfo(root: string, env: EnvLookup): RuntimeInfo {
  const orchestrator = detectOrchestrator(root, env);
  const constrained = process.constrainedMemory();
  return {
    hostname: os.hostname(),
    container_runtime: detectContainerRuntime(root, env),
    orchestrator,
    pod: orchestrator === "kubernetes" ? readPod(root, env) : null,
    cgroup: readCgroup(root),
    os: readOs(root),
    node_version: process.version,
    cpus_visible: os.availableParallelism(),
    constrained_memory_bytes: constrained > 0 ? constrained : null,
    uid: readStatusId(root, "Uid:") ?? process.getuid?.() ?? null,
    gid: readStatusId(root, "Gid:") ?? process.getgid?.() ?? null,
    pid: process.pid,
    load_average_1m: readLoadAverage(root),
    env_hints: {
      KUBERNETES_SERVICE_HOST: env("KUBERNETES_SERVICE_HOST") ?? null,
      container: env("container") ?? null,
      HOSTNAME: env("HOSTNAME") ?? null,
    },
  };
}

/** The controls card uses this to warn when a memory-load target exceeds the cgroup limit. */
export function readMemoryLimitBytes(root: string): number | null {
  return readCgroup(root).memory_limit_bytes;
}

function exists(root: string, relative: string): boolean {
  try { return fs.existsSync(path.join(root, relative)); } catch { return false; }
}

/** Returns null for missing, unreadable (EACCES) or non-file paths — never throws. */
function readText(root: string, relative: string): string | null {
  try { return fs.readFileSync(path.join(root, relative), "utf8"); } catch { return null; }
}

function detectContainerRuntime(root: string, env: EnvLookup): string {
  if (exists(root, "run/.containerenv")) return "podman";
  if (exists(root, ".dockerenv")) return "docker";
  const fromEnv = blank(env("container"));
  if (fromEnv) return fromEnv;
  const cgroup = readText(root, "proc/self/cgroup") ?? "";
  if (cgroup.includes("crio")) return "cri-o";
  if (cgroup.includes("containerd")) return "containerd";
  if (cgroup.includes("docker")) return "docker";
  if (cgroup.includes("kubepods")) return "kubernetes";
  return "none";
}

function detectOrchestrator(root: string, env: EnvLookup): "kubernetes" | "none" {
  return blank(env("KUBERNETES_SERVICE_HOST")) !== undefined || exists(root, SA_NAMESPACE) ? "kubernetes" : "none";
}

function readPod(root: string, env: EnvLookup): PodInfo {
  return {
    name: blank(env("POD_NAME")) ?? null,
    namespace: blank(env("POD_NAMESPACE")) ?? blank(readText(root, SA_NAMESPACE)) ?? null,
    node: blank(env("NODE_NAME")) ?? null,
    ip: blank(env("POD_IP")) ?? null,
    service_account: blank(env("SERVICE_ACCOUNT")) ?? null,
  };
}

function limit(text: string | null): number | null {
  const v = blank(text ?? undefined);
  if (v === undefined || !/^-?\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= 0 && n < UNLIMITED ? n : null;
}

function ratio(quota: number | null, period: number | null): number | null {
  return quota !== null && period !== null && quota > 0 && period > 0 ? Math.round((quota / period) * 100) / 100 : null;
}

function readCgroup(root: string): CgroupInfo {
  if (exists(root, "sys/fs/cgroup/cgroup.controllers")) {
    const [quota, period] = (readText(root, "sys/fs/cgroup/cpu.max") ?? "").trim().split(/\s+/);
    return {
      version: "v2",
      cpu_limit_cores: ratio(limit(quota ?? null), limit(period ?? null)),
      memory_limit_bytes: limit(readText(root, "sys/fs/cgroup/memory.max")),
      memory_usage_bytes: limit(readText(root, "sys/fs/cgroup/memory.current")),
    };
  }
  if (exists(root, "sys/fs/cgroup/cpu") || exists(root, "sys/fs/cgroup/memory")) {
    return {
      version: "v1",
      cpu_limit_cores: ratio(limit(readText(root, "sys/fs/cgroup/cpu/cpu.cfs_quota_us")), limit(readText(root, "sys/fs/cgroup/cpu/cpu.cfs_period_us"))),
      memory_limit_bytes: limit(readText(root, "sys/fs/cgroup/memory/memory.limit_in_bytes")),
      memory_usage_bytes: limit(readText(root, "sys/fs/cgroup/memory/memory.usage_in_bytes")),
    };
  }
  return { version: "none", cpu_limit_cores: null, memory_limit_bytes: null, memory_usage_bytes: null };
}

function readOs(root: string): string {
  for (const line of (readText(root, "etc/os-release") ?? "").split("\n")) {
    if (line.startsWith("PRETTY_NAME=")) return line.slice("PRETTY_NAME=".length).trim().replace(/^"|"$/g, "");
  }
  return `${os.type()} ${os.release()}`;
}

function readStatusId(root: string, prefix: "Uid:" | "Gid:"): number | null {
  for (const line of (readText(root, "proc/self/status") ?? "").split("\n")) {
    if (line.startsWith(prefix)) {
      const first = line.slice(prefix.length).trim().split(/\s+/)[0];
      return first !== undefined && /^\d+$/.test(first) ? Number(first) : null;
    }
  }
  return null;
}

function readLoadAverage(root: string): number | null {
  const first = (readText(root, "proc/loadavg") ?? "").trim().split(/\s+/)[0];
  const n = first ? Number(first) : NaN;
  return Number.isFinite(n) ? n : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/runtime-info.test.ts && npm run typecheck`
Expected: all pass (the EACCES test is skipped only when running as root).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/runtime-info.ts tests/runtime-info.test.ts tests/support/fake-root.ts
git commit -m "feat: container, pod and cgroup runtime introspection"
```

---

### Task 8: Eta rendering, layout, Runtime page and partials

**Files:**
- Create: `src/views/fmt.ts`, `src/routes/render.ts`, `src/routes/runtime.ts`, `src/routes/pages.ts`, `views/layout.eta`, `views/pages/index.eta`, `views/partials/runtime.eta`, `views/partials/controls.eta`, `public/css/site.css`, `public/js/htmx.min.js`
- Modify: `src/app.ts` (register static, rendering, runtime and page routes)
- Test: `tests/fmt.test.ts`, `tests/pages.test.ts`

**Interfaces:**
- Consumes: `collectRuntimeInfo`, `readMemoryLimitBytes` (Task 7), `StateSnapshot` (Task 5), `AppDeps` (Task 6), `PUBLIC_DIR`/`VIEWS_DIR` (Task 6).
- Produces: `fmt` helper object available in every template as `it.fmt`; `reply.page(name, data)` and `reply.partial(name, data)` (both render Eta, pages pull in `/layout` themselves); `runtimeView(deps): { info, state }`; `controlsView(deps): { snapshot, memory_limit_bytes }`; routes `GET /`, `GET /api/runtime`, `GET /partials/runtime`, `GET /partials/controls`.
- Template data contract: every render gets `{ version, fmt, ...data }`; `nav` and `title` are passed to `layout("/layout", {...})` by each page.
- The controls partial renders the forms for all five controls; Task 9 adds the POST routes they target.

- [ ] **Step 1: Write the failing tests**

`tests/fmt.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fmt } from "../src/views/fmt.js";

describe("fmt", () => {
  it("or() substitutes a dash for empty values", () => {
    expect(fmt.or(null)).toBe("—");
    expect(fmt.or("")).toBe("—");
    expect(fmt.or(0)).toBe("0");
    expect(fmt.or("x")).toBe("x");
  });
  it("bytes() uses binary units", () => {
    expect(fmt.bytes(null)).toBe("—");
    expect(fmt.bytes(null, "unlimited")).toBe("unlimited");
    expect(fmt.bytes(512)).toBe("512 B");
    expect(fmt.bytes(536870912)).toBe("512.0 MiB");
    expect(fmt.bytes(1.5 * 1024 ** 3)).toBe("1.5 GiB");
  });
  it("cores() and time() and duration()", () => {
    expect(fmt.cores(null)).toBe("unlimited");
    expect(fmt.cores(0.5)).toBe("0.5 cores");
    expect(fmt.cores(2)).toBe("2 cores");
    expect(fmt.time(null)).toBe("never");
    expect(fmt.time("2026-01-01T12:34:56.000Z")).toBe("2026-01-01 12:34:56 UTC");
    expect(fmt.duration(7)).toBe("7s");
    expect(fmt.duration(306)).toBe("5m 6s");
    expect(fmt.duration(3 * 3600 + 240)).toBe("3h 4m");
    expect(fmt.duration(26 * 3600)).toBe("1d 2h");
  });
  it("until() counts down or reports expired", () => {
    expect(fmt.until("2026-01-01T00:04:12Z", "2026-01-01T00:00:00Z")).toBe("in 4m 12s");
    expect(fmt.until("2026-01-01T00:00:00Z", "2026-01-01T00:00:01Z")).toBe("expired");
  });
});
```

`tests/pages.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { testApp } from "./support/app-factory.js";

describe("runtime page and partials", () => {
  let close = async () => {};
  afterEach(() => close());

  it("GET / renders the layout with nav, runtime poller and controls card", async () => {
    const { app } = await testApp();
    close = () => app.close();
    const res = await app.inject({ url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const html = res.body;
    expect(html).toContain("<title>Runtime · aws-dash</title>");
    expect(html).toContain('<a href="/" class="active">Runtime</a>');
    expect(html).toContain('<a href="/aws" class="">AWS</a>');
    expect(html).toContain('hx-get="/partials/runtime" hx-trigger="every 5s"');
    expect(html).toContain('id="controls"');
    expect(html).toContain('hx-post="/controls/liveness"');
    expect(html).toContain('hx-post="/controls/memory"');
    expect(html).toContain('src="/public/js/htmx.min.js"');
    expect(html).toMatch(/<span class="version">v\d+\.\d+\.\d+<\/span>/);
  });

  it("GET /partials/runtime is a fragment showing pod info from the environment", async () => {
    const { app } = await testApp({ env: { KUBERNETES_SERVICE_HOST: "10.0.0.1", POD_NAME: "aws-dash-x", POD_NAMESPACE: "demo" } });
    close = () => app.close();
    const res = await app.inject({ url: "/partials/runtime" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<html");
    expect(res.body).toContain('<dl class="kv">');
    expect(res.body).toContain("aws-dash-x");
    expect(res.body).toContain('<span class="badge ok">live: OK</span>');
  });

  it("escapes values from the environment", async () => {
    const { app } = await testApp({ env: { KUBERNETES_SERVICE_HOST: "x", POD_NAME: "<script>alert(1)</script>" } });
    close = () => app.close();
    const res = await app.inject({ url: "/partials/runtime" });
    expect(res.body).not.toContain("<script>alert");
    expect(res.body).toContain("&lt;script&gt;");
  });

  it("GET /partials/controls hides buttons when controls are disabled", async () => {
    const { app } = await testApp({ env: { CONTROLS_ENABLED: "false" } });
    close = () => app.close();
    const res = await app.inject({ url: "/partials/controls" });
    expect(res.body).toContain("Controls are disabled (CONTROLS_ENABLED=false)");
    expect(res.body).not.toContain("hx-post=");
  });

  it("GET /api/runtime returns runtime info plus state as JSON", async () => {
    const { app } = await testApp();
    close = () => app.close();
    const res = await app.inject({ url: "/api/runtime" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("container_runtime");
    expect(body).toHaveProperty("cgroup.version");
    expect(body.state).toMatchObject({ live: true, ready: true });
  });

  it("serves static assets", async () => {
    const { app } = await testApp();
    close = () => app.close();
    expect((await app.inject({ url: "/public/css/site.css" })).headers["content-type"]).toContain("text/css");
    expect((await app.inject({ url: "/public/js/htmx.min.js" })).statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/fmt.test.ts tests/pages.test.ts`
Expected: FAIL — cannot resolve `../src/views/fmt.js`; page tests 404.

- [ ] **Step 3: Vendor htmx and write the stylesheet**

Run:
```bash
mkdir -p public/js public/css
curl -fsSL -o public/js/htmx.min.js https://unpkg.com/htmx.org@2.0.11/dist/htmx.min.js
head -c 60 public/js/htmx.min.js   # expect: var htmx=function(){...
```

`public/css/site.css` (ported from azure-dash with the AWS palette; `.progress` is new for the memory control):
```css
:root {
  --bg: #f5f6f8; --card: #ffffff; --text: #1b1b1f; --muted: #5f6368; --line: #e3e5e8;
  --accent: #ff9900; --accent-dark: #ec7211; --ok: #107c10; --bad: #c50f1f; --warn: #8a5300; --topbar: #232f3e;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.topbar { display: flex; align-items: center; gap: 24px; padding: 0 24px; height: 52px; background: var(--topbar); color: #fff; }
.topbar .brand { font-weight: 700; letter-spacing: .02em; }
.topbar nav { display: flex; gap: 18px; flex: 1; }
.topbar nav a { color: #d0d0d0; text-decoration: none; padding: 15px 0 12px; border-bottom: 3px solid transparent; }
.topbar nav a.active, .topbar nav a:hover { color: #fff; border-bottom-color: var(--accent); }
.topbar .version { color: #a0a0a0; font-size: 13px; }
main { max-width: 1100px; margin: 24px auto; padding: 0 16px; }
.grid { display: grid; gap: 16px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px 20px; min-width: 0; }
.card h2 { margin: 0 0 12px; font-size: 17px; }
.card h3 { margin: 16px 0 6px; font-size: 15px; display: flex; gap: 8px; align-items: center; }
.control h3 { margin-top: 0; }
.muted { color: var(--muted); font-size: 13px; }
dl.kv { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
dl.kv dt { color: var(--muted); }
dl.kv dd { margin: 0; font-family: var(--mono); font-size: 13px; overflow-wrap: anywhere; min-width: 0; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--line); padding: 6px 8px; white-space: nowrap; }
td { border-bottom: 1px solid var(--line); padding: 6px 8px; font-family: var(--mono); }
.badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font: 600 12px system-ui, sans-serif; }
.badge.ok { background: #dff6dd; color: var(--ok); }
.badge.bad { background: #fde7e9; color: var(--bad); }
.badge.warn { background: #fff4ce; color: var(--warn); }
.controls-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
.control { border: 1px solid var(--line); border-radius: 6px; padding: 12px; }
button { font: inherit; padding: 6px 14px; border-radius: 4px; border: 1px solid var(--accent-dark); background: var(--accent); color: #1b1b1f; font-weight: 600; cursor: pointer; }
button:hover { filter: brightness(1.05); }
button.secondary { background: #fff; color: var(--accent-dark); }
button.danger { background: var(--bad); border-color: var(--bad); color: #fff; }
input[type=number] { width: 84px; font: inherit; padding: 4px 6px; margin: 0 8px 8px 4px; }
.error { background: #fde7e9; color: var(--bad); border-radius: 4px; padding: 8px 12px; margin-bottom: 8px; font: 13px/1.4 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.warning { background: #fff4ce; color: var(--warn); border-radius: 4px; padding: 8px 12px; margin-bottom: 8px; font-size: 13px; }
.header-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.header-row h2 { margin: 0; }
.progress { height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; margin: 6px 0; }
.progress > span { display: block; height: 100%; background: var(--accent); }
@media (max-width: 600px) {
  .topbar { gap: 12px; padding: 0 16px; }
  .topbar .version { display: none; }
  dl.kv { grid-template-columns: 1fr; gap: 2px; }
  dl.kv dd { margin-bottom: 6px; }
}
```

- [ ] **Step 4: Implement fmt.ts and render.ts**

`src/views/fmt.ts`:
```ts
const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

function bytes(value: number | null | undefined, nullText = "—"): string {
  if (value === null || value === undefined) return nullText;
  let d = value;
  let i = 0;
  while (d >= 1024 && i < UNITS.length - 1) { d /= 1024; i++; }
  return i === 0 ? `${value} B` : `${d.toFixed(1)} ${UNITS[i]}`;
}

function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d >= 1) return `${d}d ${h}h`;
  if (h >= 1) return `${h}h ${m}m`;
  if (m >= 1) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Display helpers exposed to every template as `it.fmt`. Plain functions (no `this`) so Eta can call them directly. */
export const fmt = {
  or: (value: unknown, fallback = "—"): string => (value === null || value === undefined || value === "" ? fallback : String(value)),
  bytes,
  mib: (mib: number): string => bytes(mib * 1024 * 1024),
  cores: (cores: number | null | undefined): string => (cores === null || cores === undefined ? "unlimited" : `${Number(cores.toFixed(2))} cores`),
  num: (value: number | null | undefined, digits = 2): string => (value === null || value === undefined ? "—" : value.toFixed(digits)),
  time: (iso: string | null | undefined): string => (iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "never"),
  duration,
  until: (targetIso: string, nowIso: string): string => {
    const ms = new Date(targetIso).getTime() - new Date(nowIso).getTime();
    return ms <= 0 ? "expired" : `in ${duration(ms / 1000)}`;
  },
};

export type Fmt = typeof fmt;
```

`src/routes/render.ts`:
```ts
import { Eta } from "eta";
import type { FastifyInstance, FastifyReply } from "fastify";
import { fmt } from "../views/fmt.js";

declare module "fastify" {
  interface FastifyReply {
    /** Renders a full page; the page template selects its layout with `<% layout("/layout", {...}) %>`. */
    page(name: string, data?: Record<string, unknown>): Promise<FastifyReply>;
    /** Renders an htmx fragment (no layout). */
    partial(name: string, data?: Record<string, unknown>): Promise<FastifyReply>;
  }
}

export function createRenderer(viewsDir: string, cache: boolean): Eta {
  // Template names are root-relative when they start with "/", e.g. include("/partials/runtime", it).
  return new Eta({ views: viewsDir, cache, autoEscape: true, useWith: false });
}

export function registerRendering(app: FastifyInstance, opts: { eta: Eta; version: string }): void {
  const base = { version: opts.version, fmt };
  async function render(this: FastifyReply, name: string, data: Record<string, unknown> = {}): Promise<FastifyReply> {
    const html = await opts.eta.renderAsync(name, { ...base, ...data });
    return this.type("text/html; charset=utf-8").send(html);
  }
  app.decorateReply("page", render);
  app.decorateReply("partial", render);
}
```

- [ ] **Step 5: Write the templates**

`views/layout.eta`:
```eta
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title><%= it.title %> · aws-dash</title>
  <link rel="stylesheet" href="/public/css/site.css" />
  <script src="/public/js/htmx.min.js"></script>
</head>
<body>
  <header class="topbar">
    <span class="brand">aws-dash</span>
    <nav>
      <a href="/" class="<%= it.nav === "runtime" ? "active" : "" %>">Runtime</a>
      <a href="/aws" class="<%= it.nav === "aws" ? "active" : "" %>">AWS</a>
      <a href="/identity" class="<%= it.nav === "identity" ? "active" : "" %>">Identity</a>
    </nav>
    <span class="version">v<%= it.version %></span>
  </header>
  <main>
<%~ it.body %>
  </main>
</body>
</html>
```

`views/pages/index.eta`:
```eta
<% layout("/layout", { title: "Runtime", nav: "runtime" }) %>
<div class="grid">
  <section class="card">
    <h2>Runtime</h2>
    <div id="runtime" hx-get="/partials/runtime" hx-trigger="every 5s" hx-swap="innerHTML">
<%~ include("/partials/runtime", it) %>
    </div>
  </section>
<%~ include("/partials/controls", it) %>
</div>
```

`views/partials/runtime.eta` (data: `it.info: RuntimeInfo`, `it.state: StateSnapshot`):
```eta
<% const info = it.info, state = it.state, fmt = it.fmt; %>
<dl class="kv">
  <dt>Probes</dt>
  <dd>
    <span class="badge <%= state.live ? "ok" : "bad" %>">live: <%= state.live ? "OK" : "FAILING" %></span>
    <span class="badge <%= state.ready ? "ok" : "bad" %>">ready: <%= state.ready ? "OK" : "FAILING" %></span>
    <span class="badge <%= state.cpu_load.active ? "warn" : "ok" %>">cpu load: <%= state.cpu_load.active ? state.cpu_load.workers + " worker(s)" : "off" %></span>
    <span class="badge <%= state.memory_load.active ? "warn" : "ok" %>">memory load: <%= state.memory_load.active ? fmt.mib(state.memory_load.allocated_mib) + " " + state.memory_load.phase : "off" %></span>
  </dd>
  <dt>Hostname</dt><dd><%= info.hostname %></dd>
  <dt>Container runtime</dt><dd><%= info.container_runtime %></dd>
  <dt>Orchestrator</dt><dd><%= info.orchestrator %></dd>
<% if (info.pod) { %>
  <dt>Pod</dt><dd><%= fmt.or(info.pod.name) %></dd>
  <dt>Namespace</dt><dd><%= fmt.or(info.pod.namespace) %></dd>
  <dt>Node</dt><dd><%= fmt.or(info.pod.node) %></dd>
  <dt>Pod IP</dt><dd><%= fmt.or(info.pod.ip) %></dd>
  <dt>Service account</dt><dd><%= fmt.or(info.pod.service_account) %></dd>
<% } %>
  <dt>cgroup</dt><dd><%= info.cgroup.version %></dd>
  <dt>CPU limit</dt><dd><%= fmt.cores(info.cgroup.cpu_limit_cores) %></dd>
  <dt>Memory</dt><dd><%= fmt.bytes(info.cgroup.memory_usage_bytes) %> used / <%= fmt.bytes(info.cgroup.memory_limit_bytes, "unlimited") %></dd>
  <dt>Node sees</dt><dd><%= fmt.bytes(info.constrained_memory_bytes, "no constraint") %> (process.constrainedMemory)</dd>
  <dt>OS</dt><dd><%= info.os %></dd>
  <dt>Node.js</dt><dd><%= info.node_version %></dd>
  <dt>CPUs visible</dt><dd><%= info.cpus_visible %></dd>
  <dt>Load (1m)</dt><dd><%= fmt.num(info.load_average_1m) %></dd>
  <dt>uid / gid / pid</dt><dd><%= fmt.or(info.uid) %> / <%= fmt.or(info.gid) %> / <%= info.pid %></dd>
  <dt>Started</dt><dd><%= fmt.time(state.started_at) %> (up <%= fmt.duration(state.uptime_seconds) %>)</dd>
</dl>
```

`views/partials/controls.eta` (data: `it.snapshot: StateSnapshot`, `it.memory_limit_bytes: number | null`):
```eta
<% const s = it.snapshot, fmt = it.fmt, limit = it.memory_limit_bytes; %>
<% const MIB = 1024 * 1024; const overLimit = limit !== null && s.memory_load.active && s.memory_load.target_mib * MIB > limit; %>
<section id="controls" class="card">
  <h2>Controls</h2>
<% if (!s.controls_enabled) { %>
  <p class="muted">Controls are disabled (CONTROLS_ENABLED=false).</p>
<% } else { %>
  <div class="controls-grid">
    <div class="control">
      <h3>Liveness <span class="badge <%= s.live ? "ok" : "bad" %>"><%= s.live ? "OK" : "FAILING" %></span></h3>
      <p class="muted">When failing, /healthz/live returns 503; after 3 failed probes the kubelet restarts the container.</p>
      <button hx-post="/controls/liveness" hx-vals='{"enabled":"<%= s.live ? "false" : "true" %>"}' hx-target="#controls" hx-swap="outerHTML"><%= s.live ? "Fail liveness" : "Restore liveness" %></button>
    </div>
    <div class="control">
      <h3>Readiness <span class="badge <%= s.ready ? "ok" : "bad" %>"><%= s.ready ? "OK" : "FAILING" %></span></h3>
      <p class="muted">When failing, /healthz/ready returns 503 and the pod is removed from the Service's endpoints.</p>
      <button hx-post="/controls/readiness" hx-vals='{"enabled":"<%= s.ready ? "false" : "true" %>"}' hx-target="#controls" hx-swap="outerHTML"><%= s.ready ? "Fail readiness" : "Restore readiness" %></button>
    </div>
    <div class="control">
      <h3>CPU load <span class="badge <%= s.cpu_load.active ? "warn" : "ok" %>"><%= s.cpu_load.active ? s.cpu_load.workers + " busy" : "idle" %></span></h3>
      <p class="muted">Spins worker threads to drive CPU usage; watch it with kubectl top pod or an HPA.</p>
<% if (s.cpu_load.active) { %>
      <button hx-post="/controls/cpu" hx-vals='{"enabled":"false"}' hx-target="#controls" hx-swap="outerHTML">Stop</button>
<% } else { %>
      <form hx-post="/controls/cpu" hx-target="#controls" hx-swap="outerHTML">
        <input type="hidden" name="enabled" value="true" />
        <label>Workers <input type="number" name="workers" min="1" max="64" value="1" /></label>
        <button type="submit">Start</button>
      </form>
<% } %>
    </div>
    <div class="control">
      <h3>Memory load <span class="badge <%= s.memory_load.active ? "warn" : "ok" %>"><%= s.memory_load.active ? fmt.mib(s.memory_load.allocated_mib) + " " + s.memory_load.phase : "idle" %></span></h3>
      <p class="muted">Allocates and holds off-heap buffers. cgroup limit: <%= fmt.bytes(limit, "none") %>. Past the limit the kernel OOM-kills the container (exit 137).</p>
<% if (s.memory_load.active) { %>
<% if (overLimit) { %>
      <p class="warning">Target <%= fmt.mib(s.memory_load.target_mib) %> exceeds the cgroup limit — expect OOMKilled.</p>
<% } %>
      <div class="progress"><span style="width: <%= Math.min(100, Math.round(100 * s.memory_load.allocated_mib / Math.max(1, s.memory_load.target_mib))) %>%"></span></div>
      <button hx-post="/controls/memory" hx-vals='{"enabled":"false"}' hx-target="#controls" hx-swap="outerHTML">Release</button>
<% } else { %>
      <form hx-post="/controls/memory" hx-target="#controls" hx-swap="outerHTML">
        <input type="hidden" name="enabled" value="true" />
        <label>MiB <input type="number" name="mib" min="1" value="256" /></label>
        <button type="submit">Allocate</button>
      </form>
<% } %>
    </div>
    <div class="control">
      <h3>Crash</h3>
      <p class="muted">Exits the process with the given code; Kubernetes restarts it and the restart count goes up.</p>
      <form hx-post="/controls/crash" hx-target="#crash-result" hx-confirm="Really exit the process?">
        <label>Exit code <input type="number" name="exit_code" min="0" max="255" value="1" /></label>
        <button type="submit" class="danger">Crash</button>
      </form>
      <div id="crash-result"></div>
    </div>
  </div>
<% } %>
</section>
```

- [ ] **Step 6: Implement the runtime and page routes; wire them into app.ts**

`src/routes/runtime.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import { collectRuntimeInfo, readMemoryLimitBytes } from "../runtime/runtime-info.js";

export function runtimeView(deps: AppDeps) {
  return { info: collectRuntimeInfo(deps.fsRoot, deps.env), state: deps.stateService.snapshot() };
}

export function controlsView(deps: AppDeps) {
  return { snapshot: deps.stateService.snapshot(), memory_limit_bytes: readMemoryLimitBytes(deps.fsRoot) };
}

export function registerRuntimeRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/api/runtime", () => ({ ...collectRuntimeInfo(deps.fsRoot, deps.env), state: deps.stateService.snapshot() }));
  app.get("/partials/runtime", (_req, reply) => reply.partial("partials/runtime", runtimeView(deps)));
  app.get("/partials/controls", (_req, reply) => reply.partial("partials/controls", controlsView(deps)));
}
```
`src/routes/pages.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import { controlsView, runtimeView } from "./runtime.js";

export function registerPageRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/", (_req, reply) => reply.page("pages/index", { ...runtimeView(deps), ...controlsView(deps) }));
}
```

Modify `src/app.ts` — add imports and registrations inside `buildApp` after `formbody`:
```ts
import fastifyStatic from "@fastify/static";
import { PUBLIC_DIR, VIEWS_DIR } from "./paths.js";
import { registerPageRoutes } from "./routes/pages.js";
import { createRenderer, registerRendering } from "./routes/render.js";
import { registerRuntimeRoutes } from "./routes/runtime.js";
// ...inside buildApp, after `await app.register(formbody);`
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/public/" });
  registerRendering(app, { eta: createRenderer(VIEWS_DIR, process.env["NODE_ENV"] === "production"), version: deps.version });
// ...after registerHealthRoutes(app, deps);
  registerRuntimeRoutes(app, deps);
  registerPageRoutes(app, deps);
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx vitest run tests/fmt.test.ts tests/pages.test.ts && npm run typecheck`
Expected: all pass. Then `npm run dev` and open http://localhost:8080 — the Runtime card refreshes every 5 s; the Controls card shows five controls (buttons 404 until Task 9).

- [ ] **Step 8: Commit**

```bash
git add src/views src/routes/render.ts src/routes/runtime.ts src/routes/pages.ts src/app.ts views public tests/fmt.test.ts tests/pages.test.ts
git commit -m "feat: server-rendered Runtime page with htmx polling and controls card"
```

---

### Task 9: Control routes (liveness, readiness, CPU, memory, crash)

**Files:**
- Create: `src/routes/controls.ts`
- Modify: `src/app.ts` (register control routes)
- Test: `tests/controls.test.ts`

**Interfaces:**
- Consumes: `readInput`/`inputBool`/`inputInt`/`isHtmx`/`errorBody` (Task 6), `controlsView` (Task 8), `MemoryLoadActiveError` (Task 4), `AppDeps.exit`/`crashDelayMs` (Task 6).
- Produces: `registerControlRoutes(app, deps)` with `POST /controls/{liveness,readiness,cpu,memory,crash}`. Every route: 403 when controls are disabled; 422 `{detail}` on bad input; htmx → re-rendered `#controls` card, otherwise the state snapshot JSON. Crash → 202 then exit after `crashDelayMs` with CPU/memory loads stopped first.

- [ ] **Step 1: Write the failing tests**

`tests/controls.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { testApp } from "./support/app-factory.js";
import { FakeRoot } from "./support/fake-root.js";

const FORM = { "content-type": "application/x-www-form-urlencoded" };
const post = (app: FastifyInstance, url: string, payload = "", headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload, headers: { ...FORM, ...headers } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("controls", () => {
  let close = async () => {};
  afterEach(() => close());

  it("are blocked with 403 when CONTROLS_ENABLED=false", async () => {
    const { app } = await testApp({ env: { CONTROLS_ENABLED: "false" } });
    close = () => app.close();
    for (const path of ["liveness", "readiness", "cpu", "memory", "crash"]) {
      const res = await post(app, `/controls/${path}`, "enabled=true");
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ detail: "controls are disabled (CONTROLS_ENABLED=false)" });
    }
  });

  it("liveness toggle flips the probe and returns the snapshot as JSON", async () => {
    const { app } = await testApp();
    close = () => app.close();
    const off = await post(app, "/controls/liveness", "enabled=false");
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ live: false, ready: true });
    expect((await app.inject({ url: "/healthz/live" })).statusCode).toBe(503);
    const on = await post(app, "/controls/liveness?enabled=true");
    expect(on.json().live).toBe(true);
    expect((await app.inject({ url: "/healthz/live" })).statusCode).toBe(200);
  });

  it("readiness toggle works and rejects bad input with 422", async () => {
    const { app } = await testApp();
    close = () => app.close();
    expect((await post(app, "/controls/readiness", "enabled=off")).json().ready).toBe(false);
    expect((await app.inject({ url: "/healthz/ready" })).statusCode).toBe(503);
    const bad = await post(app, "/controls/readiness", "enabled=maybe");
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toEqual({ detail: "'enabled' must be true or false" });
    expect((await post(app, "/controls/readiness")).statusCode).toBe(422);
  });

  it("returns the re-rendered controls card for htmx requests", async () => {
    const { app } = await testApp();
    close = () => app.close();
    const res = await post(app, "/controls/liveness", "enabled=false", { "hx-request": "true" });
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('id="controls"');
    expect(res.body).toContain("Restore liveness");
  });

  it("cpu clamps workers to the available cores and validates the range", async () => {
    const { app, workers } = await testApp();
    close = () => app.close();
    const res = await post(app, "/controls/cpu", "enabled=true&workers=64");
    expect(res.json().cpu_load).toEqual({ active: true, workers: 2 });
    expect(workers.created).toHaveLength(2);
    expect((await post(app, "/controls/cpu", "enabled=true&workers=0")).statusCode).toBe(422);
    expect((await post(app, "/controls/cpu", "enabled=true&workers=65")).json()).toEqual({ detail: "'workers' must be an integer between 1 and 64" });
    expect((await post(app, "/controls/cpu", "enabled=false")).json().cpu_load).toEqual({ active: false, workers: 0 });
  });

  it("memory allocates, warns when the target exceeds the cgroup limit, and releases", async () => {
    const root = new FakeRoot().write("sys/fs/cgroup/cgroup.controllers", "memory").write("sys/fs/cgroup/memory.max", String(1024 * 1024));
    const { app, memory } = await testApp({ fsRoot: root.path });
    close = async () => { await app.close(); root.cleanup(); };
    const res = await post(app, "/controls/memory", "enabled=true&mib=2", { "hx-request": "true" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("exceeds the cgroup limit");
    expect(res.body).toContain('class="progress"');
    await memory.settled();
    expect(memory.status()).toMatchObject({ active: true, allocated_mib: 2, phase: "holding" });
    expect((await post(app, "/controls/memory", "enabled=true&mib=1")).statusCode).toBe(409);
    const off = await post(app, "/controls/memory", "enabled=false");
    expect(off.json().memory_load).toMatchObject({ active: false, allocated_mib: 0 });
  });

  it("memory validates mib against MEMORY_LOAD_MAX_MIB", async () => {
    const { app } = await testApp({ env: { MEMORY_LOAD_MAX_MIB: "8" } });
    close = () => app.close();
    expect((await post(app, "/controls/memory", "enabled=true&mib=0")).statusCode).toBe(422);
    const big = await post(app, "/controls/memory", "enabled=true&mib=9");
    expect(big.statusCode).toBe(422);
    expect(big.json()).toEqual({ detail: "'mib' must be an integer between 1 and 8" });
  });

  it("crash answers 202, stops loads, then exits with the requested code", async () => {
    const { app, exit, cpu, memory } = await testApp();
    close = () => app.close();
    cpu.start(1);
    memory.start(1);
    await memory.settled();
    const res = await post(app, "/controls/crash", "exit_code=3");
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ message: "exiting with code 3", exit_code: 3 });
    expect(exit.codes).toEqual([]);
    await sleep(60);
    expect(exit.codes).toEqual([3]);
    expect(cpu.status().active).toBe(false);
    expect(memory.status().active).toBe(false);
  });

  it("crash defaults to exit code 1, rejects 256, and renders a badge for htmx", async () => {
    const { app, exit } = await testApp();
    close = () => app.close();
    expect((await post(app, "/controls/crash", "exit_code=256")).statusCode).toBe(422);
    const hx = await post(app, "/controls/crash", "", { "hx-request": "true" });
    expect(hx.statusCode).toBe(202);
    expect(hx.body).toBe('<span class="badge bad">Exiting with code 1…</span>');
    await sleep(60);
    expect(exit.codes).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/controls.test.ts`
Expected: FAIL — POSTs return 404.

- [ ] **Step 3: Implement controls.ts and register it**

`src/routes/controls.ts`:
```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../app.js";
import { MemoryLoadActiveError } from "../load/memory-load.js";
import { errorBody } from "./errors.js";
import { isHtmx } from "./htmx.js";
import { inputBool, inputInt, readInput, type Input } from "./input.js";
import { controlsView } from "./runtime.js";

export function registerControlRoutes(app: FastifyInstance, deps: AppDeps): void {
  const respond = (req: FastifyRequest, reply: FastifyReply) =>
    isHtmx(req) ? reply.partial("partials/controls", controlsView(deps)) : reply.send(deps.stateService.snapshot());
  const unprocessable = (reply: FastifyReply, detail: string) => reply.code(422).send(errorBody(detail));
  const enabledOr422 = (input: Input, reply: FastifyReply): boolean | undefined => {
    const enabled = inputBool(input, "enabled");
    if (enabled === undefined) void unprocessable(reply, "'enabled' must be true or false");
    return enabled;
  };

  // Encapsulated plugin so the 403 gate applies only to /controls/*.
  void app.register(async (ctl) => {
    ctl.addHook("preHandler", async (_req, reply) => {
      if (!deps.settings.controlsEnabled) return reply.code(403).send(errorBody("controls are disabled (CONTROLS_ENABLED=false)"));
      return undefined;
    });

    ctl.post("/controls/liveness", async (req, reply) => {
      const enabled = enabledOr422(readInput(req), reply);
      if (enabled === undefined) return reply;
      deps.state.live = enabled;
      return respond(req, reply);
    });

    ctl.post("/controls/readiness", async (req, reply) => {
      const enabled = enabledOr422(readInput(req), reply);
      if (enabled === undefined) return reply;
      deps.state.ready = enabled;
      return respond(req, reply);
    });

    ctl.post("/controls/cpu", async (req, reply) => {
      const input = readInput(req);
      const enabled = enabledOr422(input, reply);
      if (enabled === undefined) return reply;
      const workers = inputInt(input, "workers", 1, 1, 64);
      if (workers === undefined) return unprocessable(reply, "'workers' must be an integer between 1 and 64");
      if (enabled) deps.cpu.start(workers);
      else await deps.cpu.stop();
      return respond(req, reply);
    });

    ctl.post("/controls/memory", async (req, reply) => {
      const input = readInput(req);
      const enabled = enabledOr422(input, reply);
      if (enabled === undefined) return reply;
      if (enabled) {
        const max = deps.settings.memoryLoadMaxMib;
        const mib = inputInt(input, "mib", Math.min(256, max), 1, max);
        if (mib === undefined) return unprocessable(reply, `'mib' must be an integer between 1 and ${max}`);
        try {
          deps.memory.start(mib);
        } catch (err) {
          if (err instanceof MemoryLoadActiveError) return reply.code(409).send(errorBody(err.message));
          throw err;
        }
      } else {
        deps.memory.stop();
      }
      return respond(req, reply);
    });

    ctl.post("/controls/crash", async (req, reply) => {
      const code = inputInt(readInput(req), "exit_code", 1, 0, 255);
      if (code === undefined) return unprocessable(reply, "'exit_code' must be an integer between 0 and 255");
      setTimeout(() => {
        void deps.cpu.stop().then(() => {
          deps.memory.stop();
          deps.exit(code);
        });
      }, deps.crashDelayMs);
      reply.code(202);
      return isHtmx(req)
        ? reply.type("text/html; charset=utf-8").send(`<span class="badge bad">Exiting with code ${code}…</span>`)
        : reply.send({ message: `exiting with code ${code}`, exit_code: code });
    });
  });
}
```

Modify `src/app.ts`: import `registerControlRoutes` from `./routes/controls.js` and call `registerControlRoutes(app, deps);` after `registerPageRoutes(app, deps);`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/controls.test.ts && npm test && npm run typecheck`
Expected: all pass. Manual: `npm run dev`, click "Fail liveness" → badge flips, `curl -i localhost:8080/healthz/live` → 503; allocate 256 MiB → progress bar fills; Crash → process exits with the code (`echo $?`).

- [ ] **Step 5: Commit**

```bash
git add src/routes/controls.ts src/app.ts tests/controls.test.ts
git commit -m "feat: liveness, readiness, cpu, memory and crash controls"
```

---

### Task 10: Self-probe CLI for the container HEALTHCHECK

**Files:**
- Create: `src/cli.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `blank`, `processEnv` (Task 2); `buildApp`/`testApp` for the integration test.
- Produces: `localProbeUrl(env): string`; `type FetchLike`; `selfProbe(url, fetchFn?, out?, timeoutMs?): Promise<number>` (0 healthy, 1 unhealthy); `main(argv, env?): Promise<number>`. The image has no curl, so `HEALTHCHECK` runs `node dist/cli.js --healthcheck`.

- [ ] **Step 1: Write the failing tests**

`tests/cli.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { localProbeUrl, main, selfProbe } from "../src/cli.js";
import { testApp } from "./support/app-factory.js";

describe("cli --healthcheck", () => {
  it("builds the probe URL from PORT", () => {
    expect(localProbeUrl(() => undefined)).toBe("http://127.0.0.1:8080/healthz/live");
    expect(localProbeUrl((n) => (n === "PORT" ? "9000" : undefined))).toBe("http://127.0.0.1:9000/healthz/live");
  });

  it("returns 0 on 2xx, 1 otherwise, and prints one line", async () => {
    const lines: string[] = [];
    const ok = await selfProbe("http://x/healthz/live", async () => ({ ok: true, status: 200 }), (l) => lines.push(l));
    const bad = await selfProbe("http://x/healthz/live", async () => ({ ok: false, status: 503 }), (l) => lines.push(l));
    const down = await selfProbe("http://x/healthz/live", async () => { throw new Error("ECONNREFUSED"); }, (l) => lines.push(l));
    expect([ok, bad, down]).toEqual([0, 1, 1]);
    expect(lines).toEqual(["200 http://x/healthz/live", "503 http://x/healthz/live", "unhealthy: ECONNREFUSED"]);
  });

  it("main() prints usage and returns 2 without --healthcheck", async () => {
    const lines: string[] = [];
    expect(await main([], () => undefined, (l) => lines.push(l))).toBe(2);
    expect(lines[0]).toContain("--healthcheck");
  });

  it("probes a real listening app", async () => {
    const { app, state } = await testApp();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const lines: string[] = [];
      expect(await selfProbe(`${address}/healthz/live`, fetch, (l) => lines.push(l))).toBe(0);
      state.live = false;
      expect(await selfProbe(`${address}/healthz/live`, fetch, (l) => lines.push(l))).toBe(1);
    } finally {
      await app.close();
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL — cannot resolve `../src/cli.js`.

- [ ] **Step 3: Implement cli.ts**

`src/cli.ts`:
```ts
import { pathToFileURL } from "node:url";
import { blank, processEnv, type EnvLookup } from "./env.js";

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export function localProbeUrl(env: EnvLookup): string {
  return `http://127.0.0.1:${blank(env("PORT")) ?? "8080"}/healthz/live`;
}

/** Container HEALTHCHECK without curl in the image: exit 0 when /healthz/live answers 2xx. */
export async function selfProbe(
  url: string,
  fetchFn: FetchLike = fetch,
  out: (line: string) => void = console.log,
  timeoutMs = 3000,
): Promise<number> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    out(`${res.status} ${url}`);
    return res.ok ? 0 : 1;
  } catch (err) {
    out(`unhealthy: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export async function main(argv: string[], env: EnvLookup = processEnv, out: (line: string) => void = console.log): Promise<number> {
  if (argv.includes("--healthcheck")) return selfProbe(localProbeUrl(env), fetch, out);
  out("usage: node dist/cli.js --healthcheck");
  return 2;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(await main(process.argv.slice(2)));
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/cli.test.ts && npm run typecheck && npm run build && ls dist/cli.js dist/server.js`
Expected: 4 tests pass; `dist/` contains compiled JS. Then in one terminal `npm start`, in another `node dist/cli.js --healthcheck; echo $?` → `200 http://127.0.0.1:8080/healthz/live` and `0`.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: --healthcheck self-probe for the container HEALTHCHECK"
```

---

### Task 11: Containerfile and local podman runner

**Files:**
- Create: `Containerfile`, `scripts/run-podman.sh`

**Interfaces:**
- Consumes: `npm run build` (Task 1), `dist/cli.js --healthcheck` (Task 10), `views/` and `public/` (Task 8).
- Produces: image `localhost/aws-dash:dev` listening on 8080 as UID 1001/GID 0 with a working `HEALTHCHECK`. The build stage runs on `$BUILDPLATFORM` and the final stage has **no `RUN`**, so a multi-arch build needs no QEMU; `npm prune --omit=optional` keeps `node_modules` pure JS so the same tree works on amd64 and arm64.

- [ ] **Step 1: Write the Containerfile**

`Containerfile`:
```dockerfile
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
```

- [ ] **Step 2: Write the podman runner**

`scripts/run-podman.sh`:
```bash
#!/usr/bin/env bash
# Run aws-dash locally in podman.
#   scripts/run-podman.sh [image]                       # no credentials: Runtime tab + controls only
#   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=us-east-1 scripts/run-podman.sh
#   AWS_PROFILE=demo scripts/run-podman.sh              # mounts ~/.aws read-only for profile mode
# The 512m memory limit is deliberate: the memory-load control can be pushed past it to show an OOM kill (exit 137).
set -euo pipefail
IMAGE="${1:-localhost/aws-dash:dev}"
args=()
for v in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_REGION AWS_DEFAULT_REGION AWS_PROFILE \
         AUTH_MODE AWS_CACHE_TTL_SECONDS CONTROLS_ENABLED LOG_LEVEL AWS_DEBUG IMDS_ENABLED MEMORY_LOAD_MAX_MIB; do
  if [[ -n "${!v:-}" ]]; then args+=(-e "$v"); fi
done
if [[ -n "${AWS_PROFILE:-}" && -d "$HOME/.aws" ]]; then
  args+=(-v "$HOME/.aws:/opt/app-root/src/.aws:ro,Z" -e AWS_SHARED_CREDENTIALS_FILE=/opt/app-root/src/.aws/credentials -e AWS_CONFIG_FILE=/opt/app-root/src/.aws/config)
fi
# Off AWS there is no instance metadata service; skip the chain's IMDS timeout.
args+=(-e AWS_EC2_METADATA_DISABLED=true)
exec podman run --rm -it --name aws-dash --cpus 1 --memory 512m -p 8080:8080 ${args[@]+"${args[@]}"} "$IMAGE"
```

Run: `chmod +x scripts/run-podman.sh`

- [ ] **Step 3: Build and smoke-test the image**

Run:
```bash
podman build --format docker -t localhost/aws-dash:dev .
podman run --rm localhost/aws-dash:dev node -e 'console.log(process.getuid(), process.getgid(), process.version)'
scripts/run-podman.sh
```
Expected: build succeeds; the one-off prints `1001 0 v24.x.y`; the runner logs `aws-dash listening`. In another terminal: `podman inspect --format '{{.State.Health.Status}}' aws-dash` → `healthy` after ~10 s; `curl -s localhost:8080/api/runtime | jq .container_runtime` → `"podman"`; POST `/controls/memory` with `mib=600` → the container dies with exit 137 (`podman inspect` shows `OOMKilled: true` when re-run without `--rm`).

Then verify the tree is pure JS: `podman run --rm localhost/aws-dash:dev sh -c 'find node_modules -name "*.node" | wc -l'` → `0`.

- [ ] **Step 4: Commit**

```bash
git add Containerfile scripts/run-podman.sh
git commit -m "build: multi-stage UBI10 nodejs-24 Containerfile and podman runner"
```

---

### Task 12: CI workflow and Dependabot

**Files:**
- Create: `.github/workflows/build-container.yaml`, `.github/dependabot.yml`

**Interfaces:**
- Consumes: `npm test`, `npm run typecheck`, `npm run build` (Task 1), `Containerfile` (Task 11), `scripts/kustomize-check.sh` (Task 13 — the workflow references it; the step is a no-op until the script exists, so create the file in Task 13 before the first push).
- Produces: `ghcr.io/kenmoini/aws-dash:{main,sha,latest}` multi-arch images on push to `main`, weekly, or manual dispatch.

- [ ] **Step 1: Write the workflow**

`.github/workflows/build-container.yaml`:
```yaml
name: Build AWS Dash Container

on:
  push:
    branches: [main]
    paths-ignore:
      - "docs/**"
      - "**/*.md"
  pull_request:
  schedule:
    - cron: "0 2 * * 0"
  workflow_dispatch: {}

env:
  IMAGE: ghcr.io/${{ github.repository_owner }}/aws-dash

jobs:
  test:
    name: Test
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - name: Verify node_modules has no native addons (multi-arch image copies it as-is)
        run: |
          npm prune --omit=dev --omit=optional --ignore-scripts
          test "$(find node_modules -name '*.node' | wc -l)" -eq 0

  manifests:
    name: Render Kustomize overlays
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
      - run: scripts/kustomize-check.sh

  build:
    name: Build and push image
    needs: [test, manifests]
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v7
      - uses: docker/setup-buildx-action@v4
      - uses: docker/login-action@v4
        if: github.event_name != 'pull_request'
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@v6
        with:
          images: ${{ env.IMAGE }}
          tags: |
            type=schedule
            type=ref,event=branch
            type=ref,event=tag
            type=ref,event=pr
            type=sha
            type=sha,format=long
            type=raw,value=latest,enable={{is_default_branch}}
      # The build stage runs on the runner's platform and the final stage has no RUN, so no QEMU is needed.
      - uses: docker/build-push-action@v7
        with:
          context: .
          file: Containerfile
          platforms: linux/amd64,linux/arm64
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 2: Write dependabot.yml**

`.github/dependabot.yml`:
```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly }
    groups:
      npm-minor-patch:
        update-types: [minor, patch]
    ignore:
      # TypeScript 7 (tsgo) is a different compiler; upgrade deliberately, not via Dependabot.
      - dependency-name: typescript
        update-types: ["version-update:semver-major"]
  - package-ecosystem: docker
    directory: /
    schedule: { interval: weekly }
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
```

- [ ] **Step 3: Validate locally**

Run: `npx --yes @action-validator/cli .github/workflows/build-container.yaml 2>/dev/null || python3 -c 'import yaml,sys; yaml.safe_load(open(".github/workflows/build-container.yaml")); yaml.safe_load(open(".github/dependabot.yml")); print("yaml ok")'`
Expected: `yaml ok` (or the validator reporting no errors).

- [ ] **Step 4: Commit**

```bash
git add .github
git commit -m "ci: test, render overlays and build multi-arch image to ghcr.io"
```

---

### Task 13: Kustomize base, OpenShift overlay, manifest check script

**Files:**
- Create: `deploy/kubernetes/{namespace,serviceaccount,configmap,secret.example,deployment,service,kustomization}.yaml`, `deploy/kubernetes/README.md`, `deploy/openshift/{kustomization,route}.yaml`, `deploy/openshift/README.md`, `deploy/README.md`, `scripts/kustomize-check.sh`

**Interfaces:**
- Consumes: image `ghcr.io/kenmoini/aws-dash:main` (Task 12), probes `/healthz/live` + `/healthz/ready` (Task 6), config vars (Task 2).
- Produces: the base every later overlay (`eks-irsa`, `eks-pod-identity`, `openshift-native-oidc`, `ztwim`) patches. The Deployment keeps **empty `initContainers`, `volumes` and `volumeMounts` lists** so overlays can JSON-patch-append with `/-`. No `runAsUser` anywhere (OpenShift assigns an arbitrary UID; GID 0 is baked into the image).

- [ ] **Step 1: Write the base manifests**

`deploy/kubernetes/namespace.yaml`:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: aws-dash
```

`deploy/kubernetes/serviceaccount.yaml`:
```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: aws-dash
```

`deploy/kubernetes/configmap.yaml`:
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: aws-dash-config
data:
  AUTH_MODE: auto
  AWS_REGION: us-east-1
  AWS_CACHE_TTL_SECONDS: "60"
  CONTROLS_ENABLED: "true"
  LOG_LEVEL: info
  AWS_DEBUG: "false"
  IMDS_ENABLED: "true"
  K8S_INFO_ENABLED: "true"
  METRICS_ENABLED: "true"
```

`deploy/kubernetes/secret.example.yaml` (copy to `secret.yaml`, which is gitignored):
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: aws-dash-credentials
  namespace: aws-dash
type: Opaque
stringData:
  AWS_ACCESS_KEY_ID: "AKIAREPLACEME00000000"
  AWS_SECRET_ACCESS_KEY: "replace-me"
```

`deploy/kubernetes/deployment.yaml`:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: aws-dash
  labels:
    app: aws-dash
spec:
  replicas: 1
  selector:
    matchLabels:
      app: aws-dash
  template:
    metadata:
      labels:
        app: aws-dash
    spec:
      serviceAccountName: aws-dash
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      initContainers: []
      containers:
        - name: aws-dash
          image: ghcr.io/kenmoini/aws-dash:main
          imagePullPolicy: Always
          ports:
            - name: http
              containerPort: 8080
          envFrom:
            - configMapRef:
                name: aws-dash-config
            - secretRef:
                name: aws-dash-credentials
                optional: true
          env:
            - name: POD_NAME
              valueFrom: {fieldRef: {fieldPath: metadata.name}}
            - name: POD_NAMESPACE
              valueFrom: {fieldRef: {fieldPath: metadata.namespace}}
            - name: NODE_NAME
              valueFrom: {fieldRef: {fieldPath: spec.nodeName}}
            - name: POD_IP
              valueFrom: {fieldRef: {fieldPath: status.podIP}}
            - name: SERVICE_ACCOUNT
              valueFrom: {fieldRef: {fieldPath: spec.serviceAccountName}}
          resources:
            requests: {cpu: 100m, memory: 128Mi}
            limits: {cpu: "1", memory: 512Mi}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: {drop: [ALL]}
          livenessProbe:
            httpGet: {path: /healthz/live, port: http}
            initialDelaySeconds: 10
            periodSeconds: 5
            failureThreshold: 3
          readinessProbe:
            httpGet: {path: /healthz/ready, port: http}
            periodSeconds: 5
            failureThreshold: 2
          volumeMounts: []
      volumes: []
```

`deploy/kubernetes/service.yaml`:
```yaml
apiVersion: v1
kind: Service
metadata:
  name: aws-dash
  labels:
    app: aws-dash
spec:
  selector:
    app: aws-dash
  ports:
    - name: http
      port: 8080
      targetPort: http
```

`deploy/kubernetes/kustomization.yaml`:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: aws-dash
resources:
  - namespace.yaml
  - serviceaccount.yaml
  - configmap.yaml
  - deployment.yaml
  - service.yaml
```

`deploy/kubernetes/README.md`:
````markdown
# aws-dash on any Kubernetes with static IAM access keys

The baseline the workload-identity overlays exist to eliminate: a long-lived IAM user key in a Secret.
`AUTH_MODE=auto` picks `static` because `AWS_ACCESS_KEY_ID` is present (the SDK chain checks env first).

The app makes no AWS calls in Phase 1, so the user needs no permissions yet; the read-only policy used by the
AWS tab arrives with Phase 2 as `deploy/aws/aws-dash-readonly-policy.json`.

```bash
aws iam create-user --user-name aws-dash
aws iam create-access-key --user-name aws-dash --query 'AccessKey.{AWS_ACCESS_KEY_ID:AccessKeyId,AWS_SECRET_ACCESS_KEY:SecretAccessKey}' -o json
cp deploy/kubernetes/secret.example.yaml deploy/kubernetes/secret.yaml   # paste the two values; secret.yaml is gitignored
kubectl apply -k deploy/kubernetes
kubectl apply -f deploy/kubernetes/secret.yaml
kubectl -n aws-dash rollout restart deploy/aws-dash          # env vars are read at start
kubectl -n aws-dash port-forward svc/aws-dash 8080:8080
```

Off AWS (kind, minikube, on-prem) set `AWS_EC2_METADATA_DISABLED=true` in the ConfigMap so the SDK never waits on
the instance metadata service; the `openshift` overlay does this for you.

Delete the key when you are done: `aws iam delete-access-key --user-name aws-dash --access-key-id <id>`.
````

- [ ] **Step 2: Write the OpenShift overlay**

`deploy/openshift/route.yaml`:
```yaml
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: aws-dash
spec:
  to:
    kind: Service
    name: aws-dash
  port:
    targetPort: http
  tls:
    termination: edge
    insecureEdgeTerminationPolicy: Redirect
```

`deploy/openshift/kustomization.yaml`:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: aws-dash
resources:
  - ../kubernetes
  - route.yaml
patches:
  - target: {kind: Deployment, name: aws-dash}
    patch: |-
      - op: add
        path: /spec/template/spec/containers/0/env/-
        value:
          name: AWS_EC2_METADATA_DISABLED
          value: "true"
```

`deploy/openshift/README.md`:
````markdown
# aws-dash on OpenShift with static IAM access keys

Same as `deploy/kubernetes` (see its README for creating the IAM user and key) plus an edge-terminated Route and
`AWS_EC2_METADATA_DISABLED=true`, because an on-prem OpenShift node has no EC2 instance metadata service.
The image runs under the `restricted-v2` SCC as-is: arbitrary UID, GID 0, no writes to disk.

```bash
cp deploy/kubernetes/secret.example.yaml deploy/openshift/secret.yaml   # paste the key; secret.yaml is gitignored
oc apply -k deploy/openshift
oc apply -f deploy/openshift/secret.yaml
oc -n aws-dash rollout restart deploy/aws-dash
oc -n aws-dash get route aws-dash -o jsonpath='https://{.spec.host}{"\n"}'
```

For SPIFFE/SPIRE via the Zero Trust Workload Identity Manager use the `ztwim` overlay (Phase 4).
```

`deploy/README.md`:
```markdown
# Deploying aws-dash

One image, several credential sources. Pick the overlay for your platform:

| Overlay | Platform | Credential source | Secret in cluster? |
|---|---|---|---|
| `kubernetes` | any Kubernetes | IAM user access key in a Secret (`AUTH_MODE=static`) | yes |
| `openshift` | OpenShift | same, plus a Route and IMDS disabled | yes |
| `eks-irsa` | EKS | IAM Roles for Service Accounts (Phase 3) | no |
| `eks-pod-identity` | EKS | EKS Pod Identity (Phase 3) | no |
| `openshift-native-oidc` | OpenShift / ROSA with a public SA issuer | projected SA token → `sts:AssumeRoleWithWebIdentity` (Phase 3) | no |
| `ztwim` | OpenShift + Zero Trust Workload Identity Manager | SPIRE JWT-SVID → `sts:AssumeRoleWithWebIdentity` (Phase 4) | no |

Render any overlay without a cluster: `kubectl kustomize deploy/<overlay>`; `scripts/kustomize-check.sh` renders all of them.
````

- [ ] **Step 3: Write the check script**

`scripts/kustomize-check.sh`:
```bash
#!/usr/bin/env bash
# Renders every Kustomize overlay so CI catches a broken patch before anyone applies it.
set -euo pipefail
cd "$(dirname "$0")/.."
status=0
for dir in deploy/*/; do
  [[ -f "$dir/kustomization.yaml" ]] || continue
  if out=$(kubectl kustomize "$dir" 2>&1 >/dev/null); then
    echo "ok   $dir"
  else
    echo "FAIL $dir"; echo "$out"; status=1
  fi
done
exit $status
```

Run: `chmod +x scripts/kustomize-check.sh && scripts/kustomize-check.sh`
Expected:
```
ok   deploy/kubernetes/
ok   deploy/openshift/
```
Also confirm the overlay's env patch landed: `kubectl kustomize deploy/openshift | grep -A1 AWS_EC2_METADATA_DISABLED`.

- [ ] **Step 4: Commit**

```bash
git add deploy scripts/kustomize-check.sh
git commit -m "deploy: kustomize base with static-key secret and OpenShift overlay"
```

---

### Task 14: README for the Phase 1 increment

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: everything above. Phase 5 rewrites this into the full demo script; keep this one accurate to what exists so docs never drift from code.

- [ ] **Step 1: Write README.md**

````markdown
# aws-dash

An intro to zero-trust workload identity on AWS: a small dashboard that shows where its container is running,
lets you break its health probes, burn CPU, fill memory or crash it, and (from Phase 2) lists AWS resources using
whatever credentials the platform hands it — EKS Pod Identity or IRSA, static keys on any Kubernetes, or a
SPIFFE JWT-SVID from the Zero Trust Workload Identity Manager on OpenShift. Same image everywhere; only env vars change.

The AWS sibling of [gcp-dash](https://github.com/kenmoini/gcp-dash) and [azure-dash](https://github.com/kenmoini/azure-dash).

## Status

Phase 1: Runtime tab, five controls, health probes, container image, CI, `kubernetes` and `openshift` overlays.
The AWS and Identity tabs are not implemented yet (the nav links 404).

## Run locally

```bash
npm install
npm run dev            # http://localhost:8080 — JSON logs; pipe through `npx pino-pretty` for colour
npm test               # vitest; nothing touches the network
npm run typecheck
```

Container (the `HEALTHCHECK` is only kept with `--format docker`):

```bash
podman build --format docker -t localhost/aws-dash:dev .
scripts/run-podman.sh   # --cpus 1 --memory 512m; allocate >512 MiB with the memory control to see exit 137
```

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/` | Runtime page (refreshes every 5 s) + Controls |
| GET | `/healthz/live`, `/healthz/ready` | `{"status":"ok"}` or 503 `{"status":"failing","reason":"…"}` |
| GET | `/api/state`, `/api/runtime` | JSON |
| GET | `/partials/runtime`, `/partials/controls` | htmx fragments |
| POST | `/controls/liveness`, `/controls/readiness` | form/query `enabled=true\|false` |
| POST | `/controls/cpu` | `enabled`, `workers` 1–64 (clamped to cores) |
| POST | `/controls/memory` | `enabled`, `mib` 1–`MEMORY_LOAD_MAX_MIB`; 409 if already active |
| POST | `/controls/crash` | `exit_code` 0–255 → 202, exits 500 ms later |

Requests with `HX-Request: true` get HTML fragments; everything else gets JSON. Bad input → 422 `{"detail":…}`;
all controls → 403 when `CONTROLS_ENABLED=false`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | listen address |
| `CONTROLS_ENABLED` | `true` | `false` hides and blocks the controls |
| `LOG_LEVEL` | `info` | pino level |
| `MEMORY_LOAD_MAX_MIB` | `4096` | upper bound for the memory control |
| `CPU_LOAD_MAX_WORKERS` | CPU count | upper bound for the CPU control |
| `AUTH_MODE`, `AWS_REGION`, `AWS_CACHE_TTL_SECONDS`, `AWS_DEBUG`, `IMDS_ENABLED`, `K8S_INFO_ENABLED`, `METRICS_ENABLED`, `ACCESS_CHECK_ENABLED`, `SPIFFE_ENDPOINT_SOCKET`, `SPIFFE_JWT_AUDIENCE` | see `src/config.ts` | parsed now, used from Phase 2 onward |

Downward API variables shown on the Runtime tab: `POD_NAME`, `POD_NAMESPACE`, `NODE_NAME`, `POD_IP`, `SERVICE_ACCOUNT`.

## Deploy

See [deploy/README.md](deploy/README.md). Quick start on any cluster: `kubectl apply -k deploy/kubernetes`.

## Demo (Phase 1)

1. **Readiness off** → `kubectl -n aws-dash get endpoints -w` shows the pod leave the Service.
2. **Liveness off** → the container restarts after ~15 s and the flags reset.
3. **CPU load** → `kubectl top pod -n aws-dash`.
4. **Memory load** above the 512 Mi limit → `kubectl -n aws-dash get pod -o jsonpath='{.items[0].status.containerStatuses[0].lastState}'` shows `OOMKilled`.
5. **Crash** with exit code 3 → `lastState.terminated.exitCode: 3` and the restart count goes up.

## Security

The controls are unauthenticated and have no CSRF protection by design — this is a demo. Do not expose it to the
internet with `CONTROLS_ENABLED=true`.
````

- [ ] **Step 2: Drift check and commit**

Run: `grep -o '^  [A-Z_]*:' deploy/kubernetes/configmap.yaml | tr -d ' :' | sort > /tmp/cm.txt; grep -oE 'env\("[A-Z_]+"\)' src/config.ts | grep -oE '[A-Z_]+' | sort -u > /tmp/cfg.txt; comm -23 /tmp/cm.txt /tmp/cfg.txt`
Expected: no output (every ConfigMap key is a variable `config.ts` reads).

```bash
git add README.md
git commit -m "docs: README for the runtime-only increment"
```

---

## Phase 1 exit criteria

- `npm test` green (≈55 tests), `npm run typecheck` clean, `npm run build` produces `dist/`.
- `podman build --format docker` image reports `healthy`; runs as UID 1001 / GID 0; `find node_modules -name '*.node'` is empty.
- `scripts/kustomize-check.sh` renders both overlays; `kubectl apply -k deploy/kubernetes` on any cluster gives a Running pod whose Runtime tab shows pod/namespace/node and cgroup limits, and whose controls behave per the README demo.
- CI passes on `main` and publishes `ghcr.io/kenmoini/aws-dash:main` for amd64 + arm64.

Next: `docs/superpowers/plans/2026-09-27-aws-dash-phase2-inventory.md` (credential selection, AWS inventory tab, `/metrics`) — written after Phase 1 ships so it can reference real code.
