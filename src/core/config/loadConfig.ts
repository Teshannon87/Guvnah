import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigSchema, type GuvnahConfig } from "./schema.js";
import { defaultConfig } from "./defaultConfig.js";

export const DEFAULT_CONFIG_FILENAMES = [
  "guvnah.context.yaml",
  "guvnah.context.yml",
  ".guvnah-context/guvnah.context.yaml",
];

export function findConfigPath(cwd: string = process.cwd()): string | null {
  for (const name of DEFAULT_CONFIG_FILENAMES) {
    const full = resolve(cwd, name);
    if (existsSync(full)) return full;
  }
  return null;
}

function deepMerge<T>(base: T, override: Partial<T>): T {
  if (
    base === null ||
    typeof base !== "object" ||
    override === null ||
    typeof override !== "object" ||
    Array.isArray(base) ||
    Array.isArray(override)
  ) {
    return (override ?? base) as T;
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    if (v === undefined) continue;
    const existing = (base as Record<string, unknown>)[k];
    if (
      existing !== null &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      result[k] = deepMerge(existing, v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result as T;
}

export function loadConfig(configPath?: string): {
  config: GuvnahConfig;
  source: string | null;
} {
  const path = configPath ?? findConfigPath();
  if (!path) {
    return { config: defaultConfig, source: null };
  }
  if (!existsSync(path)) {
    throw new Error(`Guvnah config not found at ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  const parsed = (parseYaml(raw) ?? {}) as Partial<GuvnahConfig>;
  const merged = deepMerge(defaultConfig, parsed);
  const validated = ConfigSchema.parse(merged);
  return { config: validated, source: path };
}
