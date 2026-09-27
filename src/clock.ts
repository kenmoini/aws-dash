/** Injectable wall clock so tests control started_at/uptime and expiry countdowns. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
