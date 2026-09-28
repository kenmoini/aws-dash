import type { AttributedAwsCredentialIdentity } from "@aws-sdk/types";
import type { AppSettings } from "../../src/config.js";
import type { EnvLookup } from "../../src/env.js";
import { resolveAuthMode, type CredentialSpec } from "../../src/identity/credential-factory.js";
import { CredentialProvider } from "../../src/identity/credential-provider.js";

export const FAKE_TEMPORARY_CREDENTIALS: AttributedAwsCredentialIdentity = {
  accessKeyId: "ASIAEXAMPLE1234567Q2K",
  secretAccessKey: "SECRET-DO-NOT-LEAK",
  sessionToken: "SESSION-TOKEN-DO-NOT-LEAK",
  expiration: new Date("2026-01-01T00:55:00.000Z"),
  accountId: "123456789012",
  $source: { CREDENTIALS_ENV_VARS_STS_WEB_ID_TOKEN: "h", CREDENTIALS_STS_ASSUME_ROLE_WEB_ID: "k" },
};

export interface FakeCredentialOptions {
  spec?: Partial<Omit<CredentialSpec, "provider">>;
  /** Resolved credentials, or an Error to throw on resolve. Defaults to FAKE_TEMPORARY_CREDENTIALS. */
  credentials?: AttributedAwsCredentialIdentity | Error;
  /** Throw this from the factory itself (simulates a misconfigured mode). */
  factoryError?: Error;
}

/** A CredentialProvider whose spec resolves fixture credentials instead of calling AWS. Counts resolves. */
export function fakeCredentialProvider(settings: AppSettings, env: EnvLookup, opts: FakeCredentialOptions = {}) {
  const counter = { resolves: 0 };
  const provider = new CredentialProvider(settings, env, (s, e) => {
    if (opts.factoryError) throw opts.factoryError;
    const selection = resolveAuthMode(s, e);
    return {
      ...selection,
      credential_type: "fake",
      role_arn: null, role_session_name: null, token_file: null, container_credentials_uri: null, profile: null,
      ...opts.spec,
      provider: async () => {
        counter.resolves++;
        const creds = opts.credentials ?? FAKE_TEMPORARY_CREDENTIALS;
        if (creds instanceof Error) throw creds;
        return creds;
      },
    };
  });
  return { provider, counter };
}
