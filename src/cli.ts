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
