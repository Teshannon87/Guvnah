import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { GuvnahConfig } from "./schema.js";

export function writeConfig(path: string, config: GuvnahConfig, overwrite = false): boolean {
  if (existsSync(path) && !overwrite) {
    return false;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(config), "utf8");
  return true;
}
