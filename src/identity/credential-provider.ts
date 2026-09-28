import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import type { AppSettings } from "../config.js";
import type { EnvLookup } from "../env.js";
import { createCredentialSpec, resolveAuthMode, type CredentialResolution, type CredentialSdk, type CredentialSelection, type CredentialSpec } from "./credential-factory.js";

/** Lazily builds the shared credential spec; caches only success so a misconfigured pod shows the error in every panel and retries on the next request. */
export class CredentialProvider {
  private spec: CredentialSpec | undefined;
  private last: CredentialResolution | null = null;
  private readonly listeners: Array<(r: CredentialResolution) => void> = [];

  constructor(
    private readonly settings: AppSettings,
    private readonly env: EnvLookup,
    private readonly factory: (
      settings: AppSettings,
      env: EnvLookup,
      sdk?: CredentialSdk,
      onResolve?: (r: CredentialResolution) => void,
    ) => CredentialSpec = createCredentialSpec,
  ) {}

  describe(): CredentialSelection {
    return resolveAuthMode(this.settings, this.env);
  }

  get(): CredentialSpec {
    if (this.spec === undefined) {
      this.spec = this.factory(this.settings, this.env, undefined, (r) => {
        this.last = r;
        for (const listener of this.listeners) listener(r);
      });
    }
    return this.spec;
  }

  provider(): AwsCredentialIdentityProvider {
    return this.get().provider;
  }

  /** The most recent recorded resolution from the memoized provider's tap, or null before the first one. */
  lastResolution(): CredentialResolution | null {
    return this.last;
  }

  /** Notified on every real resolution (never on a memoize cache hit). */
  onResolve(listener: (r: CredentialResolution) => void): void {
    this.listeners.push(listener);
  }
}
