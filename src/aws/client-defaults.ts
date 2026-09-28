import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import type { Logger } from "pino";
import { AwsError } from "./aws-error.js";

export const REGION_HINT = "AWS_REGION is not set; set it in the ConfigMap or environment (outside EC2 the SDK cannot pick a region on its own)";

/** The configuration every SDK client shares: bounded retries and timeouts so blocked egress fails in seconds. */
export interface AwsClientDefaults {
  region: string;
  credentials: AwsCredentialIdentityProvider;
  maxAttempts: number;
  requestHandler: { connectionTimeout: number; requestTimeout: number };
  logger?: Logger;
}

export function clientDefaults(opts: {
  region: string | undefined;
  credentials: AwsCredentialIdentityProvider;
  logger: Logger;
  debug: boolean;
}): AwsClientDefaults {
  if (!opts.region) throw new AwsError(REGION_HINT, "MissingRegion");
  const base: AwsClientDefaults = {
    region: opts.region,
    credentials: opts.credentials,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 },
  };
  // The SDK logger is chatty (request/response metadata per call); only wire it on AWS_DEBUG.
  return opts.debug ? { ...base, logger: opts.logger.child({ component: "aws-sdk" }) } : base;
}
