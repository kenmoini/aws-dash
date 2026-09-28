import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import type { AppSettings } from "../config.js";
import type { EnvLookup } from "../env.js";
import { createCredentialSpec, resolveAuthMode, type CredentialSelection, type CredentialSpec } from "./credential-factory.js";

/** Lazily builds the shared credential spec; caches only success so a misconfigured pod shows the error in every panel and retries on the next request. */
export class CredentialProvider {
  private spec: CredentialSpec | undefined;

  constructor(
    private readonly settings: AppSettings,
    private readonly env: EnvLookup,
    private readonly factory: (settings: AppSettings, env: EnvLookup) => CredentialSpec = createCredentialSpec,
  ) {}

  describe(): CredentialSelection {
    return resolveAuthMode(this.settings, this.env);
  }

  get(): CredentialSpec {
    if (this.spec === undefined) this.spec = this.factory(this.settings, this.env);
    return this.spec;
  }

  provider(): AwsCredentialIdentityProvider {
    return this.get().provider;
  }
}
