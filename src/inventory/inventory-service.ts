import type { Logger } from "pino";
import { awsErrorFrom } from "../aws/aws-error.js";
import type { InventoryKind } from "./kinds.js";
import type { InventoryItem, ListResult } from "./models.js";
import { fetchKind, type AwsProvider } from "./provider.js";
import type { CacheEntry, TtlCache } from "./ttl-cache.js";

/** Metrics hook (Task 9); a no-op by default. */
export interface InventoryObserver {
  fetched(kind: InventoryKind, ok: boolean, seconds: number): void;
}

/** Loads one kind at a time through the cache; the live provider is built lazily so a misconfiguration shows in the panels instead of at startup. */
export class InventoryService {
  private provider: AwsProvider | undefined;

  constructor(
    private readonly createProvider: () => AwsProvider,
    private readonly cache: TtlCache,
    private readonly logger: Logger,
    private readonly observer: InventoryObserver = { fetched: () => undefined },
  ) {}

  fetch(kind: InventoryKind, force = false): Promise<CacheEntry<ListResult<InventoryItem>>> {
    return this.cache.get(kind, () => this.load(kind), force);
  }

  invalidateAll(): void {
    this.cache.invalidateAll();
  }

  private getProvider(): AwsProvider {
    if (this.provider === undefined) this.provider = this.createProvider();
    return this.provider;
  }

  private async load(kind: InventoryKind): Promise<ListResult<InventoryItem>> {
    const started = performance.now();
    try {
      const result = await fetchKind(this.getProvider(), kind);
      const seconds = (performance.now() - started) / 1000;
      this.logger.info({ kind, items: result.items.length, truncated: result.truncated, ms: Math.round(seconds * 1000) }, "aws fetch ok");
      this.observer.fetched(kind, true, seconds);
      return result;
    } catch (err) {
      const seconds = (performance.now() - started) / 1000;
      const error = awsErrorFrom(err);
      this.logger.warn({ kind, ms: Math.round(seconds * 1000), error: error.message }, "aws fetch failed");
      this.logger.debug({ err }, "aws fetch failure detail");
      this.observer.fetched(kind, false, seconds);
      throw error;
    }
  }
}
