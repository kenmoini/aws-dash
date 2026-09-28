import { setImmediate as yieldNow } from "node:timers/promises";
import type { AccessCheckClients, SendLike } from "../../src/identity/access-check.js";

type Answer = () => unknown;

/** One fake per service; answers `{}` by default, or the configured failure, keyed by the command class name. Tracks concurrency. */
export class FakeAccessCheckClients implements AccessCheckClients {
  readonly calls: Record<string, number> = {};
  readonly inputs: Record<string, unknown> = {};
  inFlight = 0;
  maxInFlight = 0;
  private readonly answers = new Map<string, Answer>();

  constructor(readonly sts: SendLike & { calls: number }) {}

  readonly iam = this.service();
  readonly ec2 = this.service();
  readonly s3 = this.service();
  readonly eks = this.service();
  readonly ecr = this.service();

  deny(commandName: string): void {
    this.answers.set(commandName, () => { throw Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }); });
  }

  fail(commandName: string, name: string, message: string, status?: number): void {
    this.answers.set(commandName, () => { throw Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } }); });
  }

  private service(): SendLike {
    return {
      send: async (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        this.calls[name] = (this.calls[name] ?? 0) + 1;
        this.inputs[name] = (command as { input?: unknown }).input;
        this.inFlight++;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        try {
          await yieldNow();
          const answer = this.answers.get(name);
          return answer ? answer() : {};
        } finally {
          this.inFlight--;
        }
      },
    };
  }
}
