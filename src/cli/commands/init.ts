import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultConfig } from "../../core/config/defaultConfig.js";
import { writeConfig } from "../../core/config/writeConfig.js";
import { openDatabase } from "../../db/client.js";

export interface InitOptions {
  cwd?: string;
  force?: boolean;
}

export function runInit(opts: InitOptions = {}): void {
  const cwd = opts.cwd ?? process.cwd();
  const dataDir = resolve(cwd, ".guvnah-context");
  const configPath = resolve(cwd, "guvnah.context.yaml");
  const envExamplePath = resolve(cwd, ".env.example");

  mkdirSync(dataDir, { recursive: true });

  const wroteConfig = writeConfig(configPath, defaultConfig, !!opts.force);
  console.log(wroteConfig
    ? `Wrote ${configPath}`
    : `Config already exists at ${configPath} (use --force to overwrite).`);

  if (!existsSync(envExamplePath) || opts.force) {
    writeFileSync(
      envExamplePath,
      "# Upstream provider key (RelayPlane, OpenAI, Anthropic, etc.)\nUPSTREAM_API_KEY=sk-replace-me\n",
      "utf8",
    );
    console.log(`Wrote ${envExamplePath}`);
  } else {
    console.log(`.env.example already exists (use --force to overwrite).`);
  }

  const dbPath = resolve(cwd, defaultConfig.database.path);
  const handle = openDatabase(dbPath);
  if (handle.error) {
    console.error(`Failed to initialize SQLite at ${dbPath}: ${handle.error.message}`);
    process.exitCode = 1;
    return;
  }
  handle.db?.close();
  console.log(`Initialized SQLite database at ${dbPath}`);
  console.log("");
  console.log("Next:");
  console.log("  1. cp .env.example .env && edit it");
  console.log("  2. guvnah-context proxy");
}
