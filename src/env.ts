/** Reads one environment variable; injectable so tests never touch process.env. */
export type EnvLookup = (name: string) => string | undefined;

export const processEnv: EnvLookup = (name) => process.env[name];

/** Trimmed value, or undefined when unset/blank — blank env vars count as unset everywhere. */
export function blank(value: string | undefined | null): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

export function parseBool(value: string | undefined): boolean | undefined {
  switch (value?.trim().toLowerCase()) {
    case "1": case "true": case "yes": case "on": return true;
    case "0": case "false": case "no": case "off": return false;
    default: return undefined;
  }
}
