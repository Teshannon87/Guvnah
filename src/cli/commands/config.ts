import { stringify as stringifyYaml } from "yaml";
import { loadConfig } from "../../core/config/loadConfig.js";

export interface ConfigOptions {
  config?: string;
  json?: boolean;
}

export function runConfig(opts: ConfigOptions = {}): void {
  const { config, source } = loadConfig(opts.config);
  console.log(`# source: ${source ?? "<defaults>"}`);
  if (opts.json) {
    console.log(JSON.stringify(config, null, 2));
  } else {
    console.log(stringifyYaml(config));
  }
}
