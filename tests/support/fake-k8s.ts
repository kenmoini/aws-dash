import type { V1Node, V1Pod } from "@kubernetes/client-node";
import type { K8sReadClient } from "../../src/k8s/k8s-client.js";

export const apiError = (code: number, message: string): Error => Object.assign(new Error(message), { code, body: { message } });

export const HEALTHY_POD: V1Pod = {
  metadata: { name: "aws-dash-7d9f-abcde", namespace: "aws-dash" },
  spec: { nodeName: "ip-10-0-1-23.ec2.internal", serviceAccountName: "aws-dash", containers: [{ name: "aws-dash", image: "ghcr.io/kenmoini/aws-dash:main" }] },
  status: {
    phase: "Running", qosClass: "Burstable", startTime: new Date("2025-12-31T23:00:00Z"),
    containerStatuses: [{
      name: "aws-dash", image: "ghcr.io/kenmoini/aws-dash:main", imageID: "sha256:abc", ready: true, restartCount: 2,
      state: { running: { startedAt: new Date("2025-12-31T23:50:00Z") } },
      lastState: { terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: new Date("2025-12-31T23:49:00Z") } },
    }],
  },
};

export const NODE: V1Node = {
  metadata: { name: "ip-10-0-1-23.ec2.internal", labels: { "node.kubernetes.io/instance-type": "m6i.large", "topology.kubernetes.io/zone": "us-east-1a", "topology.kubernetes.io/region": "us-east-1", "kubernetes.io/arch": "amd64" } },
  spec: { providerID: "aws:///us-east-1a/i-0abc123" },
  status: { allocatable: { cpu: "1930m", memory: "7220Mi" }, nodeInfo: { kubeletVersion: "v1.33.1-eks-1", containerRuntimeVersion: "containerd://1.7.27", osImage: "Amazon Linux 2023", architecture: "amd64", operatingSystem: "linux", kernelVersion: "6.1", machineID: "", systemUUID: "", bootID: "", kubeProxyVersion: "" } },
};

/** Scripted API server: answers with fixtures; `fail()` throws an ApiException-shaped error; `hang` waits forever. */
export class FakeK8sClient implements K8sReadClient {
  calls = { pod: 0, node: 0 };
  pod: V1Pod = structuredClone(HEALTHY_POD);
  node: V1Node = structuredClone(NODE);
  podError: Error | null = null;
  nodeError: Error | null = null;
  hang = false;

  fail(what: "pod" | "node", code: number, message: string): void {
    if (what === "pod") this.podError = apiError(code, message);
    else this.nodeError = apiError(code, message);
  }

  async readNamespacedPod(): Promise<V1Pod> {
    this.calls.pod++;
    if (this.hang) await new Promise(() => undefined);
    if (this.podError) throw this.podError;
    return this.pod;
  }

  async readNode(): Promise<V1Node> {
    this.calls.node++;
    if (this.nodeError) throw this.nodeError;
    return this.node;
  }
}
