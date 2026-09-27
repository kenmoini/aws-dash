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
