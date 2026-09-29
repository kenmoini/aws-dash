import type { Clock } from "../clock.js";
import type { AppSettings } from "../config.js";
import type { CpuLoad, CpuLoadStatus } from "../load/cpu-load.js";
import type { MemoryLoad, MemoryLoadStatus } from "../load/memory-load.js";
import type { CgroupInfo } from "../runtime/runtime-info.js";
import type { RuntimeState } from "./runtime-state.js";

/** JSON shape of GET /api/state; keys are snake_case for parity with the sibling apps. */
export interface StateSnapshot {
  live: boolean;
  ready: boolean;
  started_at: string;
  uptime_seconds: number;
  controls_enabled: boolean;
  cpu_load: CpuLoadStatus;
  memory_load: MemoryLoadStatus & { cgroup_limit_bytes: number | null };
}

const NO_CGROUP: CgroupInfo = { version: "none", cpu_limit_cores: null, memory_limit_bytes: null, memory_usage_bytes: null };

export class StateService {
  constructor(
    private readonly state: RuntimeState,
    private readonly cpu: CpuLoad,
    private readonly memory: MemoryLoad,
    private readonly settings: AppSettings,
    private readonly clock: Clock,
    private readonly cgroup: () => CgroupInfo = () => NO_CGROUP,
  ) {}

  snapshot(): StateSnapshot {
    const uptimeMs = this.clock.now().getTime() - this.state.startedAt.getTime();
    return {
      live: this.state.live,
      ready: this.state.ready,
      started_at: this.state.startedAt.toISOString(),
      uptime_seconds: Math.round(uptimeMs / 100) / 10,
      controls_enabled: this.settings.controlsEnabled,
      cpu_load: this.cpu.status(),
      memory_load: { ...this.memory.status(), cgroup_limit_bytes: this.cgroup().memory_limit_bytes },
    };
  }
}
