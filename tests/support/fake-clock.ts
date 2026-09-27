import type { Clock } from "../../src/clock.js";

export class FakeClock implements Clock {
  constructor(private current = new Date("2026-01-01T00:00:00Z")) {}
  now(): Date { return new Date(this.current); }
  advance(ms: number): void { this.current = new Date(this.current.getTime() + ms); }
  set(iso: string): void { this.current = new Date(iso); }
}
