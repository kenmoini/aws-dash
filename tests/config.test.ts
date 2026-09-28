import { describe, expect, it } from "vitest";
import { blank, parseBool, type EnvLookup } from "../src/env.js";
import { ConfigError, settingsFromEnv } from "../src/config.js";

const env = (vars: Record<string, string>): EnvLookup => (name) => vars[name];

describe("env helpers", () => {
  it("blank() trims and treats empty as undefined", () => {
    expect(blank("  x ")).toBe("x");
    expect(blank("   ")).toBeUndefined();
    expect(blank(undefined)).toBeUndefined();
  });
  it("parseBool() accepts the usual spellings", () => {
    for (const v of ["1", "true", "YES", "on"]) expect(parseBool(v)).toBe(true);
    for (const v of ["0", "false", "No", "off"]) expect(parseBool(v)).toBe(false);
    expect(parseBool("maybe")).toBeUndefined();
  });
});

describe("settingsFromEnv", () => {
  it("applies defaults", () => {
    const s = settingsFromEnv(env({}));
    expect(s).toMatchObject({
      port: 8080, host: "0.0.0.0", authMode: "auto", region: undefined, cacheTtlSeconds: 60,
      controlsEnabled: true, logLevel: "info", awsDebug: false, imdsEnabled: true,
      k8sInfoEnabled: true, metricsEnabled: true, accessCheckEnabled: true,
      spiffeEndpointSocket: undefined, spiffeJwtAudience: "aws-dash", memoryLoadMaxMib: 4096,
    });
    expect(s.cpuLoadMaxWorkers).toBeGreaterThanOrEqual(1);
  });
  it("reads values", () => {
    const s = settingsFromEnv(env({
      PORT: "9090", AUTH_MODE: "web-identity", AWS_REGION: "eu-west-1", AWS_CACHE_TTL_SECONDS: "5",
      CONTROLS_ENABLED: "off", LOG_LEVEL: "debug", AWS_DEBUG: "1", MEMORY_LOAD_MAX_MIB: "512", CPU_LOAD_MAX_WORKERS: "3",
      SPIFFE_ENDPOINT_SOCKET: "unix:///spiffe-workload-api/spire-agent.sock", SPIFFE_JWT_AUDIENCE: "demo",
    }));
    expect(s).toMatchObject({
      port: 9090, authMode: "web-identity", region: "eu-west-1", cacheTtlSeconds: 5, controlsEnabled: false,
      logLevel: "debug", awsDebug: true, memoryLoadMaxMib: 512, cpuLoadMaxWorkers: 3,
      spiffeEndpointSocket: "unix:///spiffe-workload-api/spire-agent.sock", spiffeJwtAudience: "demo",
    });
  });
  it("falls back to AWS_DEFAULT_REGION and treats blanks as unset", () => {
    expect(settingsFromEnv(env({ AWS_REGION: " ", AWS_DEFAULT_REGION: "us-west-2" })).region).toBe("us-west-2");
    expect(settingsFromEnv(env({ AUTH_MODE: "" })).authMode).toBe("auto");
  });
  it("parses ACCESS_CHECK_ACTIONS as a trimmed, comma-separated list", () => {
    expect(settingsFromEnv(env({ ACCESS_CHECK_ACTIONS: " ec2:DescribeVpcs ,s3:ListAllMyBuckets" })).accessCheckActions).toEqual(["ec2:DescribeVpcs", "s3:ListAllMyBuckets"]);
    expect(settingsFromEnv(env({})).accessCheckActions).toBeUndefined();
  });
  it.each([
    [{ AUTH_MODE: "magic" }, "AUTH_MODE must be one of auto, static, profile, web-identity, pod-identity, imds, got 'magic'"],
    [{ PORT: "http" }, "PORT must be an integer between 1 and 65535, got 'http'"],
    [{ AWS_CACHE_TTL_SECONDS: "-1" }, "AWS_CACHE_TTL_SECONDS must be a non-negative integer, got '-1'"],
    [{ CONTROLS_ENABLED: "sometimes" }, "CONTROLS_ENABLED must be true or false, got 'sometimes'"],
    [{ LOG_LEVEL: "loud" }, "LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent, got 'loud'"],
    [{ MEMORY_LOAD_MAX_MIB: "0" }, "MEMORY_LOAD_MAX_MIB must be a positive integer, got '0'"],
    [{ ACCESS_CHECK_ACTIONS: "ec2:DescribeVpcs,ec2:Nope" }, "ACCESS_CHECK_ACTIONS must be a comma-separated subset of sts:GetCallerIdentity, iam:ListAccountAliases, ec2:DescribeRegions, ec2:DescribeInstances, ec2:DescribeVpcs, ec2:DescribeSubnets, ec2:DescribeSecurityGroups, s3:ListAllMyBuckets, eks:ListClusters, ecr:DescribeRepositories, iam:GetRole, got 'ec2:Nope'"],
  ])("rejects %o", (vars, message) => {
    expect(() => settingsFromEnv(env(vars))).toThrow(new ConfigError(message));
  });
});
