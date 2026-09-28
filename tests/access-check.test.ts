import { afterEach, describe, expect, it } from "vitest";
import { ACCESS_CHECK_ACTION_NAMES } from "../src/identity/access-check-actions.js";
import { classify } from "../src/identity/access-check.js";
import { testApp } from "./support/app-factory.js";

const ENV = { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" };
const sdkError = (name: string, message: string, status?: number) => Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });

describe("classify", () => {
  it.each([
    [sdkError("AccessDenied", "x", 403), "denied"],
    [sdkError("UnauthorizedOperation", "x", 403), "denied"],
    [sdkError("SomethingElse", "x", 403), "denied"],
    [sdkError("ExpiredTokenException", "x", 400), "credential"],
    [sdkError("InvalidClientTokenId", "x", 403), "credential"],
    [Object.assign(new Error("no creds"), { name: "CredentialsProviderError" }), "credential"],
    [sdkError("ThrottlingException", "x", 400), "error"],
    [Object.assign(new Error("ECONNREFUSED"), { name: "Error", code: "ECONNREFUSED" }), "error"],
    [sdkError("AccessDenied", "User is not authorized to perform: sts:AssumeRoleWithWebIdentity on resource: arn:aws:iam::123456789012:role/aws-dash-irsa", 403), "credential"],
  ])("%o → %s", (err, result) => {
    expect(classify(err).result).toBe(result);
  });
  it("records the error name as code and the first line as message", () => {
    expect(classify(sdkError("AccessDenied", "Access Denied\nmore", 403))).toEqual({ result: "denied", code: "AccessDenied", message: "Access Denied" });
  });
});

describe("access-check matrix", () => {
  let close = async () => {};
  afterEach(() => close());

  it("runs every action with the gate first, GetRole against the assumed role, concurrency ≤ 4", async () => {
    const { app, accessClients, sts } = await testApp({ env: ENV, credentials: {} });
    close = () => app.close();
    const res = await app.inject({ url: "/api/access-check" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ enabled: true, fetched_at: "2026-01-01T00:00:00.000Z", principal_arn: "arn:aws:sts::123456789012:assumed-role/aws-dash-irsa/aws-dash", error: null });
    expect(body.rows.map((r: { action: string }) => r.action)).toEqual([...ACCESS_CHECK_ACTION_NAMES]);
    expect(body.rows.every((r: { result: string }) => r.result === "allowed")).toBe(true);
    expect(body.rows[0]).toMatchObject({ action: "sts:GetCallerIdentity", service: "sts", code: null, message: null });
    expect(typeof body.rows[0].duration_ms).toBe("number");
    expect(sts.calls).toBe(1);
    expect(accessClients.inputs["GetRoleCommand"]).toEqual({ RoleName: "aws-dash-irsa" });
    expect(accessClients.inputs["DescribeInstancesCommand"]).toEqual({ MaxResults: 5 });
    expect(accessClients.inputs["DescribeRegionsCommand"]).toEqual({ RegionNames: ["us-east-1"] });
    expect(accessClients.inputs["ListBucketsCommand"]).toEqual({ MaxBuckets: 1 });
    expect(accessClients.inputs["ListClustersCommand"]).toEqual({ maxResults: 1 });
    expect(accessClients.inputs["DescribeRepositoriesCommand"]).toEqual({ maxResults: 1 });
    expect(accessClients.inputs["ListAccountAliasesCommand"]).toEqual({ MaxItems: 1 });
    expect(accessClients.maxInFlight).toBeLessThanOrEqual(4);
    expect(accessClients.maxInFlight).toBeGreaterThan(1);
  });

  it("classifies denied actions and keeps going", async () => {
    const { app, accessClients } = await testApp({ env: ENV, credentials: {} });
    close = () => app.close();
    accessClients.deny("DescribeInstancesCommand");
    accessClients.fail("ListClustersCommand", "ThrottlingException", "Rate exceeded", 400);
    const rows = (await app.inject({ url: "/api/access-check" })).json().rows;
    const byAction = Object.fromEntries(rows.map((r: { action: string }) => [r.action, r]));
    expect(byAction["ec2:DescribeInstances"]).toMatchObject({ result: "denied", code: "AccessDenied", message: "Access Denied" });
    expect(byAction["eks:ListClusters"]).toMatchObject({ result: "error", code: "ThrottlingException" });
    expect(byAction["ec2:DescribeVpcs"].result).toBe("allowed");
  });

  it("skips everything when the gate fails as a credential error", async () => {
    const { app, accessClients, sts } = await testApp({ env: ENV, credentials: {} });
    close = () => app.close();
    sts.fail("ExpiredTokenException", "The security token included in the request is expired", 400);
    const rows = (await app.inject({ url: "/api/access-check" })).json().rows;
    expect(rows[0]).toMatchObject({ action: "sts:GetCallerIdentity", result: "credential", code: "ExpiredTokenException" });
    expect(rows.slice(1).every((r: { result: string; message: string }) => r.result === "skipped" && r.message === "skipped: sts:GetCallerIdentity did not succeed")).toBe(true);
    expect(Object.keys(accessClients.calls)).toEqual([]);
  });

  it("classifies a trust-policy AssumeRole denial on the gate as a credential failure, and skips the rest", async () => {
    const { app, accessClients, sts } = await testApp({ env: ENV, credentials: {} });
    close = () => app.close();
    sts.fail("AccessDenied", "User is not authorized to perform: sts:AssumeRoleWithWebIdentity on resource: arn:aws:iam::123456789012:role/aws-dash-irsa", 403);
    const rows = (await app.inject({ url: "/api/access-check" })).json().rows;
    expect(rows[0]).toMatchObject({ action: "sts:GetCallerIdentity", result: "credential", code: "AccessDenied" });
    expect(rows.slice(1).every((r: { result: string }) => r.result === "skipped")).toBe(true);
    expect(Object.keys(accessClients.calls)).toEqual([]);
  });

  it("skips iam:GetRole when the principal is not an assumed role", async () => {
    const { app, sts } = await testApp({ env: ENV, credentials: {} });
    close = () => app.close();
    sts.identity = { Account: "123456789012", Arn: "arn:aws:iam::123456789012:user/aws-dash", UserId: "AIDA1", $metadata: {} };
    const rows = (await app.inject({ url: "/api/access-check" })).json().rows;
    expect(rows.at(-1)).toMatchObject({ action: "iam:GetRole", result: "skipped", message: "skipped: the caller is not an assumed role" });
  });

  it("ACCESS_CHECK_ACTIONS narrows the matrix but always keeps the gate", async () => {
    const { app, accessClients } = await testApp({ env: { ...ENV, ACCESS_CHECK_ACTIONS: "ec2:DescribeInstances, s3:ListAllMyBuckets" }, credentials: {} });
    close = () => app.close();
    const rows = (await app.inject({ url: "/api/access-check" })).json().rows;
    expect(rows.map((r: { action: string }) => r.action)).toEqual(["sts:GetCallerIdentity", "ec2:DescribeInstances", "s3:ListAllMyBuckets"]);
    expect(Object.keys(accessClients.calls).sort()).toEqual(["DescribeInstancesCommand", "ListBucketsCommand"]);
  });

  it("is cached, refreshable, and invalidated by POST /api/aws/refresh", async () => {
    const { app, sts } = await testApp({ env: ENV, credentials: {} });
    close = () => app.close();
    await app.inject({ url: "/api/access-check" });
    await app.inject({ url: "/api/access-check" });
    expect(sts.calls).toBe(1);
    await app.inject({ url: "/api/access-check?refresh=true" });
    expect(sts.calls).toBe(2);
    await app.inject({ method: "POST", url: "/api/aws/refresh" });
    await app.inject({ url: "/api/access-check" });
    expect(sts.calls).toBe(3);
  });

  it("reports disabled, missing region and unbuildable credentials without calling anything", async () => {
    const off = await testApp({ env: { ...ENV, ACCESS_CHECK_ENABLED: "false" }, credentials: {} });
    expect((await off.app.inject({ url: "/api/access-check" })).json()).toEqual({ enabled: false, fetched_at: null, principal_arn: null, error: null, rows: [] });
    await off.app.close();
    const noRegion = await testApp({ env: { AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" }, credentials: {} });
    const nr = (await noRegion.app.inject({ url: "/api/access-check" })).json();
    await noRegion.app.close();
    expect(nr.error).toMatch(/AWS_REGION is not set/);
    expect(nr.rows).toEqual([]);
    const { app, sts } = await testApp({ env: { AUTH_MODE: "web-identity", AWS_REGION: "us-east-1" }, credentials: { factoryError: Object.assign(new Error("AUTH_MODE web-identity requires AWS_WEB_IDENTITY_TOKEN_FILE, AWS_ROLE_ARN"), { name: "AwsError" }) } });
    close = () => app.close();
    const body = (await app.inject({ url: "/api/access-check" })).json();
    expect(body.error).toMatch(/requires AWS_WEB_IDENTITY_TOKEN_FILE/);
    expect(sts.calls).toBe(0);
  });

  it("renders the matrix partial with result badges and a re-run link, and the page has the card", async () => {
    const { app, accessClients } = await testApp({ env: ENV, credentials: {} });
    close = () => app.close();
    accessClients.deny("ListBucketsCommand");
    const html = (await app.inject({ url: "/partials/access-check" })).body;
    expect(html).toContain("<h2>Access check</h2>");
    expect(html).toContain('<span class="badge ok">allowed</span>');
    expect(html).toContain('<span class="badge bad">denied</span>');
    expect(html).toContain("s3:ListAllMyBuckets");
    expect(html).toContain('hx-get="/partials/access-check?refresh=1"');
    expect((await app.inject({ url: "/identity" })).body).toContain('data-access-check-panel hx-get="/partials/access-check" hx-trigger="load"');
    const off = await testApp({ env: { ACCESS_CHECK_ENABLED: "false" } });
    expect((await off.app.inject({ url: "/partials/access-check" })).body).toContain("Disabled (ACCESS_CHECK_ENABLED=false)");
    await off.app.close();
  });
});
