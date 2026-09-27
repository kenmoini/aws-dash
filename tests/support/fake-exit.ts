import type { ProcessExit } from "../../src/state/process-exit.js";

export class FakeExit {
  readonly codes: number[] = [];
  readonly fn: ProcessExit = (code) => { this.codes.push(code); };
}
