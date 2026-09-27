import os from "node:os";
import { Worker } from "node:worker_threads";

export interface CpuLoadStatus {
  active: boolean;
  workers: number;
}

export interface CpuWorker {
  /** Resolves once the worker has exited (for any reason). */
  stopped: Promise<void>;
  terminate(): Promise<unknown>;
}

export type WorkerFactory = (stopFlag: SharedArrayBuffer, index: number) => CpuWorker;

// Evaluated inside each worker; `require` is available in eval'd worker scripts.
const SPIN_SCRIPT = `
const { workerData } = require("node:worker_threads");
const flag = new Int32Array(workerData.stop);
while (Atomics.load(flag, 0) === 0) { /* burn */ }
`;

export const realWorkerFactory: WorkerFactory = (stopFlag, index) => {
  const worker = new Worker(SPIN_SCRIPT, { eval: true, workerData: { stop: stopFlag }, name: `cpu-load-${index}` });
  const stopped = new Promise<void>((resolve) => {
    worker.once("exit", () => resolve());
    worker.once("error", () => resolve());
  });
  return { stopped, terminate: () => worker.terminate() };
};

/** Burns CPU on N worker threads; the main thread stays free to answer probes. */
export class CpuLoad {
  private readonly maxWorkers: number;
  private readonly factory: WorkerFactory;
  private readonly stopTimeoutMs: number;
  private workers: CpuWorker[] = [];
  private flag: Int32Array | undefined;

  constructor(opts: { maxWorkers?: number; factory?: WorkerFactory; stopTimeoutMs?: number } = {}) {
    this.maxWorkers = Math.max(1, opts.maxWorkers ?? os.availableParallelism());
    this.factory = opts.factory ?? realWorkerFactory;
    this.stopTimeoutMs = opts.stopTimeoutMs ?? 2000;
  }

  status(): CpuLoadStatus {
    return { active: this.workers.length > 0, workers: this.workers.length };
  }

  start(requested: number): CpuLoadStatus {
    if (this.workers.length > 0) return this.status();
    const count = Math.min(Math.max(1, Math.trunc(requested)), this.maxWorkers);
    const buffer = new SharedArrayBuffer(4);
    this.flag = new Int32Array(buffer);
    for (let i = 0; i < count; i++) this.workers.push(this.factory(buffer, i));
    return this.status();
  }

  async stop(): Promise<CpuLoadStatus> {
    const workers = this.workers;
    if (workers.length === 0) return this.status();
    this.workers = [];
    if (this.flag) Atomics.store(this.flag, 0, 1);
    this.flag = undefined;
    await Promise.all(workers.map((w) => this.stopOne(w)));
    return this.status();
  }

  private async stopOne(worker: CpuWorker): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.stopTimeoutMs);
    });
    const outcome = await Promise.race([worker.stopped.then(() => "stopped" as const), timeout]);
    clearTimeout(timer);
    if (outcome === "timeout") await worker.terminate();
  }
}
