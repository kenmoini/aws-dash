import type { FastifyRequest } from "fastify";
import { blank, parseBool } from "../env.js";

export type Input = Record<string, string>;

/** Merges query string and form body (form wins) into a flat string map. */
export function readInput(req: FastifyRequest): Input {
  const out: Input = {};
  for (const source of [req.query, req.body]) {
    if (source && typeof source === "object") {
      for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
        if (v !== undefined && v !== null) out[k] = Array.isArray(v) ? String(v[0] ?? "") : String(v);
      }
    }
  }
  return out;
}

export function inputBool(input: Input, key: string): boolean | undefined {
  return key in input ? parseBool(input[key]) : undefined;
}

/** Absent/blank → fallback; integer within [min, max] → value; anything else → undefined (caller answers 422). */
export function inputInt(input: Input, key: string, fallback: number, min: number, max: number): number | undefined {
  const raw = blank(input[key]);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= min && n <= max ? n : undefined;
}
