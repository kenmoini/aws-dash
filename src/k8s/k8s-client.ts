// The only file that imports @kubernetes/client-node at runtime.
import { CoreV1Api, KubeConfig, type V1Node, type V1Pod } from "@kubernetes/client-node";

export interface K8sReadClient {
  readNamespacedPod(param: { name: string; namespace: string }): Promise<V1Pod>;
  readNode(param: { name: string }): Promise<V1Node>;
}

export type K8sClientFactory = () => K8sReadClient;

/** Reads KUBERNETES_SERVICE_HOST/PORT and the mounted CA path; the service-account token is read per request. */
export const createInClusterClient: K8sClientFactory = () => {
  const kc = new KubeConfig();
  kc.loadFromCluster();
  return kc.makeApiClient(CoreV1Api);
};
