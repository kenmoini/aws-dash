import pino from "pino";
import { describe, expect, it } from "vitest";
import { AwsError } from "../src/aws/aws-error.js";
import { clientDefaults, REGION_HINT } from "../src/aws/client-defaults.js";

const credentials = async () => ({ accessKeyId: "AKIA", secretAccessKey: "x" });
const logger = pino({ level: "silent" });

describe("clientDefaults", () => {
  it("throws an AwsError naming AWS_REGION when the region is unset", () => {
    expect(() => clientDefaults({ region: undefined, credentials, logger, debug: false })).toThrow(AwsError);
    expect(() => clientDefaults({ region: undefined, credentials, logger, debug: false })).toThrow(REGION_HINT);
  });
  it("applies bounded retries and timeouts and omits the SDK logger unless debugging", () => {
    const cfg = clientDefaults({ region: "eu-west-1", credentials, logger, debug: false });
    expect(cfg).toMatchObject({ region: "eu-west-1", maxAttempts: 2, requestHandler: { connectionTimeout: 3000, requestTimeout: 10000, throwOnRequestTimeout: true } });
    expect(cfg.credentials).toBe(credentials);
    expect(cfg.logger).toBeUndefined();
    expect(clientDefaults({ region: "eu-west-1", credentials, logger, debug: true }).logger).toBeDefined();
  });
});
