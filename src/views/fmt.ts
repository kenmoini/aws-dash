const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

function bytes(value: number | null | undefined, nullText = "—"): string {
  if (value === null || value === undefined) return nullText;
  let d = value;
  let i = 0;
  while (d >= 1024 && i < UNITS.length - 1) { d /= 1024; i++; }
  return i === 0 ? `${value} B` : `${d.toFixed(1)} ${UNITS[i]}`;
}

function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d >= 1) return `${d}d ${h}h`;
  if (h >= 1) return `${h}h ${m}m`;
  if (m >= 1) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Display helpers exposed to every template as `it.fmt`. Plain functions (no `this`) so Eta can call them directly. */
export const fmt = {
  or: (value: unknown, fallback = "—"): string => (value === null || value === undefined || value === "" ? fallback : String(value)),
  bytes,
  mib: (mib: number): string => bytes(mib * 1024 * 1024),
  cores: (cores: number | null | undefined): string => (cores === null || cores === undefined ? "unlimited" : `${Number(cores.toFixed(2))} cores`),
  num: (value: number | null | undefined, digits = 2): string => (value === null || value === undefined ? "—" : value.toFixed(digits)),
  time: (iso: string | null | undefined): string => (iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "never"),
  duration,
  until: (targetIso: string, nowIso: string): string => {
    const ms = new Date(targetIso).getTime() - new Date(nowIso).getTime();
    return ms <= 0 ? "expired" : `in ${duration(ms / 1000)}`;
  },
};

export type Fmt = typeof fmt;
