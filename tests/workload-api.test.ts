import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkloadApi, describeWorkloadApiError } from "../src/identity/workload-api.js";

describe("describeWorkloadApiError", () => {
  const sock = "unix:///spiffe-workload-api/spire-agent.sock";
  it.each([
    [{ code: "UNAVAILABLE", message: "No connection established" }, /SPIRE agent not reachable at unix:\/\/\/spiffe-workload-api\/spire-agent.sock: is the csi.spiffe.io volume mounted and the agent running\? \(No connection established\)/],
    [{ code: "DEADLINE_EXCEEDED", message: "Deadline exceeded" }, /did not answer within the deadline at unix:\/\/\/spiffe-workload-api\/spire-agent.sock/],
    [{ code: "PERMISSION_DENIED", message: "no identity issued" }, /no registration entry matches this pod \(no identity issued\)/],
    [{ code: "INTERNAL", message: "boom\nsecond line" }, /^INTERNAL: boom$/],
    [new Error("plain failure"), /^plain failure$/],
  ])("maps %o", (err, expected) => {
    expect(describeWorkloadApiError(err, sock)).toMatch(expected);
  });
});

describe("createWorkloadApi against a local Unix socket", () => {
  let dir = "";
  let server: net.Server | undefined;
  // A gRPC channel that never completes its HTTP/2 handshake with a silent peer leaves its socket
  // half-open even after transport.close() — grpc-js only tears it down once the peer engages at the
  // protocol level (see the accompanying report). We destroy accepted sockets ourselves so
  // server.close() below does not hang forever waiting for connections that will never end on their own.
  const connections: net.Socket[] = [];
  afterEach(async () => {
    for (const socket of connections.splice(0)) socket.destroy();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("fails fast with a reachable-but-silent socket and never exceeds the deadline", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "aws-dash-spiffe-"));
    const sockPath = path.join(dir, "agent.sock");
    server = net.createServer((socket) => connections.push(socket) /* accept and say nothing */);
    await new Promise<void>((resolve) => server!.listen(sockPath, resolve));
    const api = createWorkloadApi(`unix://${sockPath}`, 300);
    const started = Date.now();
    await expect(api.fetchJwt("aws-dash")).rejects.toMatchObject({ code: expect.stringMatching(/UNAVAILABLE|DEADLINE_EXCEEDED|INTERNAL/) });
    expect(Date.now() - started).toBeLessThan(2000);
    api.close();
  }, 10_000);

  it("reports a missing socket as not reachable", async () => {
    const api = createWorkloadApi("unix:///nonexistent/aws-dash/agent.sock", 300);
    let message = "";
    try {
      await api.fetchX509();
    } catch (err) {
      message = describeWorkloadApiError(err, "unix:///nonexistent/aws-dash/agent.sock");
    } finally {
      api.close();
    }
    expect(message).toMatch(/not reachable at unix:\/\/\/nonexistent\/aws-dash\/agent.sock|did not answer within the deadline/);
  }, 10_000);
});
