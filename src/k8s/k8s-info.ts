import type { V1ContainerStatus, V1Node, V1Pod } from "@kubernetes/client-node";
import { firstLine } from "../aws/aws-error.js";
import type { Clock } from "../clock.js";
import type { EnvLookup } from "../env.js";
import type { TtlCache } from "../inventory/ttl-cache.js";
import type { K8sClientFactory, K8sReadClient } from "./k8s-client.js";

export interface K8sContainer {
  name: string;
  image: string;
  ready: boolean;
  restart_count: number;
  state: string;
  started_at: string | null;
  last_terminated: { reason: string | null; exit_code: number; finished_at: string | null } | null;
}

export interface K8sPod {
  name: string;
  namespace: string;
  node: string | null;
  phase: string | null;
  started_at: string | null;
  service_account: string | null;
  qos_class: string | null;
  containers: K8sContainer[];
}

export interface K8sNode {
  name: string;
  instance_type: string | null;
  zone: string | null;
  region: string | null;
  arch: string | null;
  os_image: string | null;
  kubelet_version: string | null;
  container_runtime: string | null;
  provider_id: string | null;
  allocatable_cpu: string | null;
  allocatable_memory: string | null;
}

/** GET /api/k8s: this pod and its node as the API server sees them; off-cluster is a normal, displayable state. */
export interface K8sInfo {
  available: boolean;
  reason: string | null;
  pod: K8sPod | null;
  node: K8sNode | null;
  node_error: string | null;
  fetched_at: string;
}

export interface K8sInfoOptions {
  enabled: boolean;
  env: EnvLookup;
  clock: Clock;
  cache: TtlCache;
  createClient: K8sClientFactory;
  timeoutMs?: number;
}

const blank = (v: string | undefined): string | undefined => (v === undefined || v.trim() === "" ? undefined : v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === "string" && v !== "" ? new Date(v).toISOString() : null);

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`the Kubernetes API did not answer within ${ms}ms`), { name: "TimeoutError" })), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The `Status` message from the API server, when one is available. `@kubernetes/client-node` 2.0.0 throws a
 * non-declared status (403/404/5xx) as `new ApiException(code, "Unknown API Status Code!", body, headers)` where
 * `body` is the raw JSON *string* of a `Status` object; for a 401 `body` is `undefined`.
 */
function apiStatusMessage(e: { body?: unknown }): string | undefined {
  try {
    const parsed: unknown = typeof e.body === "string" ? JSON.parse(e.body) : e.body;
    const message = (parsed as { message?: unknown } | null | undefined)?.message;
    if (typeof message === "string" && message !== "") return message;
  } catch {
    // e.body was not JSON — fall back to e.message below.
  }
  return undefined;
}

/** One line per failure; 403s name the manifest that grants the missing permission. */
export function describeK8sError(err: unknown, what: "pods" | "nodes"): string {
  const e = err as { code?: unknown; name?: string; message?: string; body?: unknown };
  const msg = firstLine(apiStatusMessage(e) ?? e.message ?? String(err));
  if (e.name === "TimeoutError") return msg;
  switch (typeof e.code === "number" ? e.code : null) {
    case 403:
      return what === "pods"
        ? `forbidden: the service account cannot get pods — apply deploy/kubernetes/rbac.yaml (Role aws-dash-pod-reader) (${msg})`
        : `forbidden: the service account cannot get nodes — add the node-reader component (deploy/components/node-reader) to your overlay (${msg})`;
    case 401:
      return `unauthorized: the API server rejected the service-account token (${msg})`;
    case 404:
      return `${what === "pods" ? "pod" : "node"} not found (${msg})`;
    default:
      return msg;
  }
}

function mapContainer(c: V1ContainerStatus): K8sContainer {
  const state = c.state?.running ? "running" : c.state?.waiting ? `waiting (${c.state.waiting.reason ?? "unknown"})` : c.state?.terminated ? `terminated (${c.state.terminated.reason ?? `exit ${c.state.terminated.exitCode}`})` : "unknown";
  const t = c.lastState?.terminated;
  return {
    name: c.name,
    image: c.image,
    ready: c.ready,
    restart_count: c.restartCount,
    state,
    started_at: iso(c.state?.running?.startedAt),
    last_terminated: t ? { reason: str(t.reason), exit_code: t.exitCode, finished_at: iso(t.finishedAt) } : null,
  };
}

function mapPod(pod: V1Pod, name: string, namespace: string): K8sPod {
  return {
    name: pod.metadata?.name ?? name,
    namespace: pod.metadata?.namespace ?? namespace,
    node: str(pod.spec?.nodeName),
    phase: str(pod.status?.phase),
    started_at: iso(pod.status?.startTime),
    service_account: str(pod.spec?.serviceAccountName),
    qos_class: str(pod.status?.qosClass),
    containers: (pod.status?.containerStatuses ?? []).map(mapContainer),
  };
}

function mapNode(node: V1Node, name: string): K8sNode {
  const labels = node.metadata?.labels ?? {};
  return {
    name: node.metadata?.name ?? name,
    instance_type: str(labels["node.kubernetes.io/instance-type"]),
    zone: str(labels["topology.kubernetes.io/zone"]),
    region: str(labels["topology.kubernetes.io/region"]),
    arch: str(labels["kubernetes.io/arch"]),
    os_image: str(node.status?.nodeInfo?.osImage),
    kubelet_version: str(node.status?.nodeInfo?.kubeletVersion),
    container_runtime: str(node.status?.nodeInfo?.containerRuntimeVersion),
    provider_id: str(node.spec?.providerID),
    allocatable_cpu: str(node.status?.allocatable?.["cpu"]),
    allocatable_memory: str(node.status?.allocatable?.["memory"]),
  };
}

export class K8sInfoService {
  private static readonly KEY = "k8s";
  private readonly timeoutMs: number;

  constructor(private readonly opts: K8sInfoOptions) {
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  async get(force = false): Promise<K8sInfo> {
    if (!this.opts.enabled) return this.unavailable("disabled (K8S_INFO_ENABLED=false)");
    if (blank(this.opts.env("KUBERNETES_SERVICE_HOST")) === undefined) return this.unavailable("not running in Kubernetes (KUBERNETES_SERVICE_HOST is not set)");
    const name = blank(this.opts.env("POD_NAME"));
    const namespace = blank(this.opts.env("POD_NAMESPACE"));
    if (name === undefined || namespace === undefined) return this.unavailable("POD_NAME / POD_NAMESPACE are not set: add the downward API env entries from deploy/kubernetes/deployment.yaml");
    const entry = await this.opts.cache.get<K8sInfo>(K8sInfoService.KEY, () => this.load(name, namespace), force);
    return entry.value as K8sInfo;
  }

  peek(): K8sInfo | null {
    return this.opts.cache.peek<K8sInfo>(K8sInfoService.KEY)?.value ?? null;
  }

  invalidateAll(): void {
    this.opts.cache.invalidateAll();
  }

  private unavailable(reason: string): K8sInfo {
    return { available: false, reason, pod: null, node: null, node_error: null, fetched_at: this.opts.clock.now().toISOString() };
  }

  private async load(name: string, namespace: string): Promise<K8sInfo> {
    let client: K8sReadClient;
    try {
      client = this.opts.createClient();
    } catch (err) {
      return this.unavailable(`cannot load the in-cluster config: ${firstLine((err as Error).message ?? String(err))}`);
    }
    let pod: K8sPod;
    try {
      pod = mapPod(await withTimeout(client.readNamespacedPod({ name, namespace }), this.timeoutMs), name, namespace);
    } catch (err) {
      return this.unavailable(describeK8sError(err, "pods"));
    }
    const nodeName = pod.node ?? blank(this.opts.env("NODE_NAME")) ?? null;
    let node: K8sNode | null = null;
    let nodeError: string | null = null;
    if (nodeName === null) {
      nodeError = "the pod is not scheduled to a node yet";
    } else {
      try {
        node = mapNode(await withTimeout(client.readNode({ name: nodeName }), this.timeoutMs), nodeName);
      } catch (err) {
        nodeError = describeK8sError(err, "nodes");
      }
    }
    return { available: true, reason: null, pod, node, node_error: nodeError, fetched_at: this.opts.clock.now().toISOString() };
  }
}
