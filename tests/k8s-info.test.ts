import { ApiException } from "@kubernetes/client-node";
import { afterEach, describe, expect, it } from "vitest";
import { TtlCache } from "../src/inventory/ttl-cache.js";
import { K8sInfoService } from "../src/k8s/k8s-info.js";
import { testApp } from "./support/app-factory.js";
import { FakeClock } from "./support/fake-clock.js";
import { FakeK8sClient } from "./support/fake-k8s.js";

const IN_CLUSTER = { KUBERNETES_SERVICE_HOST: "10.100.0.1", KUBERNETES_SERVICE_PORT: "443", POD_NAME: "aws-dash-7d9f-abcde", POD_NAME_UNUSED: "", POD_NAMESPACE: "aws-dash", NODE_NAME: "ip-10-0-1-23.ec2.internal" };

function service(client: FakeK8sClient, vars: Record<string, string> = IN_CLUSTER, extra: { enabled?: boolean; timeoutMs?: number } = {}) {
  const clock = new FakeClock();
  let created = 0;
  const svc = new K8sInfoService({
    enabled: extra.enabled ?? true, env: (name) => vars[name], clock, cache: new TtlCache(60_000, clock), timeoutMs: extra.timeoutMs ?? 20,
    createClient: () => { created++; return client; },
  });
  return { svc, clock, created: () => created };
}

describe("K8sInfoService", () => {
  it("maps the pod, its containers (with the OOMKilled last state) and the node", async () => {
    const client = new FakeK8sClient();
    const { svc } = service(client);
    const info = await svc.get();
    expect(info).toEqual({
      available: true, reason: null, node_error: null, fetched_at: "2026-01-01T00:00:00.000Z",
      pod: {
        name: "aws-dash-7d9f-abcde", namespace: "aws-dash", node: "ip-10-0-1-23.ec2.internal", phase: "Running", started_at: "2025-12-31T23:00:00.000Z", service_account: "aws-dash", qos_class: "Burstable",
        containers: [{ name: "aws-dash", image: "ghcr.io/kenmoini/aws-dash:main", ready: true, restart_count: 2, state: "running", started_at: "2025-12-31T23:50:00.000Z",
          last_terminated: { reason: "OOMKilled", exit_code: 137, finished_at: "2025-12-31T23:49:00.000Z" } }],
        init_containers: [],
      },
      node: { name: "ip-10-0-1-23.ec2.internal", instance_type: "m6i.large", zone: "us-east-1a", region: "us-east-1", arch: "amd64", os_image: "Amazon Linux 2023", kubelet_version: "v1.33.1-eks-1",
        container_runtime: "containerd://1.7.27", provider_id: "aws:///us-east-1a/i-0abc123", allocatable_cpu: "1930m", allocatable_memory: "7220Mi" },
    });
    expect(client.calls).toEqual({ pod: 1, node: 1 });
  });

  it("lists init containers (native sidecars such as spiffe-helper) with their own restart counts", async () => {
    const client = new FakeK8sClient();
    client.pod.status!.initContainerStatuses = [{ name: "spiffe-helper", image: "registry.redhat.io/zero-trust-workload-identity-manager/spiffe-helper-rhel9:v0.11.0", imageID: "sha256:def", ready: true, restartCount: 1, state: { running: { startedAt: new Date("2025-12-31T23:00:00Z") } } }];
    const info = await service(client).svc.get();
    expect(info.pod?.init_containers).toEqual([{ name: "spiffe-helper", image: "registry.redhat.io/zero-trust-workload-identity-manager/spiffe-helper-rhel9:v0.11.0", ready: true, restart_count: 1, state: "running", started_at: "2025-12-31T23:00:00.000Z", last_terminated: null }]);
  });

  it("describes waiting and terminated container states", async () => {
    const client = new FakeK8sClient();
    client.pod.status!.containerStatuses![0]!.state = { waiting: { reason: "CrashLoopBackOff" } };
    client.pod.status!.containerStatuses![0]!.lastState = { terminated: { exitCode: 3 } };
    const info = await service(client).svc.get();
    expect(info.pod?.containers[0]).toMatchObject({ state: "waiting (CrashLoopBackOff)", started_at: null, last_terminated: { reason: null, exit_code: 3, finished_at: null } });
  });

  it("still shows the pod when the node read is forbidden, with the node-reader hint", async () => {
    const client = new FakeK8sClient();
    client.fail("node", 403, 'nodes "ip-10-0-1-23.ec2.internal" is forbidden');
    const info = await service(client).svc.get();
    expect(info.available).toBe(true);
    expect(info.pod?.name).toBe("aws-dash-7d9f-abcde");
    expect(info.node).toBeNull();
    expect(info.node_error).toBe("forbidden: the service account cannot get nodes — add the node-reader component (deploy/components/node-reader) to your overlay (nodes \"ip-10-0-1-23.ec2.internal\" is forbidden)");
  });

  it("is unavailable with the rbac.yaml hint when the pod read is forbidden", async () => {
    const client = new FakeK8sClient();
    client.fail("pod", 403, "pods is forbidden");
    const info = await service(client).svc.get();
    expect(info).toMatchObject({ available: false, pod: null, node: null, reason: "forbidden: the service account cannot get pods — apply deploy/kubernetes/rbac.yaml (Role aws-dash-pod-reader) (pods is forbidden)" });
    expect(client.calls.node).toBe(0);
  });

  it("keeps the API server's Status message for a real ApiException (JSON string body)", async () => {
    const client = new FakeK8sClient();
    client.fail("pod", 403, 'User "system:serviceaccount:aws-dash:aws-dash" cannot get resource "pods"');
    const info = await service(client).svc.get();
    expect(info.reason).toContain('User "system:serviceaccount:aws-dash:aws-dash" cannot get resource "pods"');
  });

  it("falls back without throwing when the ApiException body is not JSON", async () => {
    const client = new FakeK8sClient();
    client.nodeError = new ApiException(500, "Unknown API Status Code!", "<html>bad gateway</html>", {});
    const info = await service(client).svc.get();
    expect(info.available).toBe(true);
    expect(info.node_error).toBe("HTTP-Code: 500");
  });

  it.each([
    [{ ...IN_CLUSTER, KUBERNETES_SERVICE_HOST: "" }, "not running in Kubernetes (KUBERNETES_SERVICE_HOST is not set)"],
    [{ ...IN_CLUSTER, POD_NAME: "" }, "POD_NAME / POD_NAMESPACE are not set: add the downward API env entries from deploy/kubernetes/deployment.yaml"],
  ])("never builds a client off-cluster: %o", async (vars, reason) => {
    const client = new FakeK8sClient();
    const { svc, created } = service(client, vars);
    expect(await svc.get()).toMatchObject({ available: false, reason });
    expect(created()).toBe(0);
  });

  it("never builds a client when disabled", async () => {
    const { svc, created } = service(new FakeK8sClient(), IN_CLUSTER, { enabled: false });
    expect(await svc.get()).toMatchObject({ available: false, reason: "disabled (K8S_INFO_ENABLED=false)" });
    expect(created()).toBe(0);
  });

  it("reports a client factory that throws as unavailable", async () => {
    const clock = new FakeClock();
    const svc = new K8sInfoService({ enabled: true, env: (n) => IN_CLUSTER[n as keyof typeof IN_CLUSTER], clock, cache: new TtlCache(60_000, clock), createClient: () => { throw new Error("ENOENT: /var/run/secrets/kubernetes.io/serviceaccount/token"); } });
    expect(await svc.get()).toMatchObject({ available: false, reason: "cannot load the in-cluster config: ENOENT: /var/run/secrets/kubernetes.io/serviceaccount/token" });
  });

  it("gives up on a silent API server after the timeout", async () => {
    const client = new FakeK8sClient();
    client.hang = true;
    const info = await service(client).svc.get();
    expect(info).toMatchObject({ available: false, reason: "the Kubernetes API did not answer within 20ms" });
  });

  it("caches for the TTL, force reloads, invalidateAll expires, peek never loads", async () => {
    const client = new FakeK8sClient();
    const { svc, clock } = service(client);
    expect(svc.peek()).toBeNull();
    await svc.get();
    await svc.get();
    expect(client.calls.pod).toBe(1);
    await svc.get(true);
    expect(client.calls.pod).toBe(2);
    clock.advance(61_000);
    await svc.get();
    expect(client.calls.pod).toBe(3);
    svc.invalidateAll();
    await svc.get();
    expect(client.calls.pod).toBe(4);
  });
});

describe("Kubernetes routes", () => {
  let close = async () => {};
  afterEach(() => close());

  it("GET /api/k8s is snake_case JSON and the Identity page carries the card", async () => {
    const { app } = await testApp({ env: IN_CLUSTER });
    close = () => app.close();
    const res = await app.inject({ url: "/api/k8s" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: true, pod: { name: "aws-dash-7d9f-abcde", containers: [{ restart_count: 2 }] }, node: { instance_type: "m6i.large" } });
    expect((await app.inject({ url: "/identity" })).body).toContain('data-k8s-panel hx-get="/partials/k8s" hx-trigger="load"');
  });

  it("the partial marks init containers so sidecar restarts are visible", async () => {
    const { app, k8s } = await testApp({ env: IN_CLUSTER });
    close = () => app.close();
    k8s.pod.status!.initContainerStatuses = [{ name: "spiffe-helper", image: "x", imageID: "y", ready: true, restartCount: 1 }];
    expect((await app.inject({ url: "/partials/k8s" })).body).toContain("spiffe-helper (init)");
  });

  it("the partial highlights OOMKilled, shows the node, and offers refresh", async () => {
    const { app } = await testApp({ env: IN_CLUSTER });
    close = () => app.close();
    const html = (await app.inject({ url: "/partials/k8s" })).body;
    for (const text of ["This pod", "aws-dash-7d9f-abcde", '<span class="badge ok">Running</span>', '<span class="badge bad">OOMKilled (exit 137)</span>', "restarts</th>", "This node", "m6i.large", "us-east-1a",
      "containerd://1.7.27", 'hx-get="/partials/k8s?refresh=1"']) {
      expect(html, text).toContain(text);
    }
  });

  it("renders the node hint inline and Unavailable off-cluster; refresh-all invalidates", async () => {
    const { app, k8s } = await testApp({ env: IN_CLUSTER });
    close = () => app.close();
    k8s.fail("node", 403, "forbidden");
    expect((await app.inject({ url: "/partials/k8s" })).body).toContain("add the node-reader component");
    expect((await app.inject({ method: "POST", url: "/api/aws/refresh" })).statusCode).toBe(204);
    await app.inject({ url: "/api/k8s" });
    expect(k8s.calls.pod).toBe(2);
    await app.close();
    const bare = await testApp({ env: { AWS_REGION: "us-east-1" } });
    close = () => bare.app.close();
    expect((await bare.app.inject({ url: "/partials/k8s" })).body).toContain("Unavailable: not running in Kubernetes");
  });
});
