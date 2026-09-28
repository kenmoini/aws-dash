import type { GetCallerIdentityCommand, GetCallerIdentityCommandOutput } from "@aws-sdk/client-sts";
import type { StsLike } from "../../src/identity/identity-service.js";

/** Answers GetCallerIdentity with a fixture, or throws the configured SDK-shaped error; counts calls. */
export class FakeSts implements StsLike {
  calls = 0;
  identity: GetCallerIdentityCommandOutput = { Account: "123456789012", Arn: "arn:aws:sts::123456789012:assumed-role/aws-dash-irsa/aws-dash", UserId: "AROAEXAMPLE:aws-dash", $metadata: {} };
  failure: Error | null = null;

  fail(name: string, message: string, status?: number): void {
    this.failure = Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
  }

  async send(_command: GetCallerIdentityCommand): Promise<GetCallerIdentityCommandOutput> {
    this.calls++;
    if (this.failure) throw this.failure;
    return { ...this.identity };
  }
}
