import type { Clock } from "../clock.js";

/** Probe flags flipped by the controls; in-memory only, so a restart resets them to healthy. */
export class RuntimeState {
  live = true;
  ready = true;
  readonly startedAt: Date;

  constructor(clock: Clock) {
    this.startedAt = clock.now();
  }
}
