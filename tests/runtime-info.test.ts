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
  it("$container=oci is only the UBI default, so cgroup evidence wins over it", () =>
    expect(get(root().write("proc/self/cgroup", "0::/kubepods.slice/kubepods-burstable.slice/crio-abc.scope"), { container: "oci" }).container_runtime).toBe("cri-o"));
  it("a specific $container value still wins over cgroup evidence", () =>
    expect(get(root().write("proc/self/cgroup", "0::/kubepods/crio-abc"), { container: "podman" }).container_runtime).toBe("podman"));
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
