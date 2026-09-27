import type { CpuWorker, WorkerFactory } from "../../src/load/cpu-load.js";

/** Records worker creation; workers "exit" when the stop flag is set (polled) or when terminated. */
export class FakeWorkerFactory {
  readonly created: number[] = [];
  terminated = 0;
  /** When true, workers ignore the stop flag so stop() has to terminate them. */
  stubborn = false;

  readonly factory: WorkerFactory = (stopFlag, index) => {
    this.created.push(index);
    const flag = new Int32Array(stopFlag);
    let resolve!: () => void;
    const stopped = new Promise<void>((r) => { resolve = r; });
    const poll = setInterval(() => {
      if (!this.stubborn && Atomics.load(flag, 0) === 1) { clearInterval(poll); resolve(); }
    }, 5);
    const worker: CpuWorker = {
      stopped,
      terminate: async () => { this.terminated++; clearInterval(poll); resolve(); },
    };
    return worker;
  };
}
