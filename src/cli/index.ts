#!/usr/bin/env node
import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runProxy } from "./commands/proxy.js";
import { runReport } from "./commands/report.js";
import { runInspect } from "./commands/inspect.js";
import { runConfig } from "./commands/config.js";

const program = new Command();

program
  .name("guvnah-context")
  .description("Local-first proxy that inspects what your AI agent is stuffing into the prompt.")
  .version("0.1.0");

program
  .command("init")
  .description("Create .guvnah-context/, guvnah.context.yaml, .env.example, and bootstrap SQLite.")
  .option("--force", "Overwrite existing config and .env.example")
  .action((opts: { force?: boolean }) => {
    runInit({ force: opts.force });
  });

program
  .command("proxy")
  .description("Start the local OpenAI-compatible proxy.")
  .option("-c, --config <path>", "Path to guvnah.context.yaml")
  .option("--host <host>", "Override bind host")
  .option("--port <port>", "Override bind port", (v) => parseInt(v, 10))
  .action(async (opts: { config?: string; host?: string; port?: number }) => {
    await runProxy(opts);
  });

program
  .command("report")
  .description("Show prompt bloat reports from the local SQLite log.")
  .option("--run <id>", "Show a detailed report for a single run")
  .option("--today", "Only include runs from today")
  .option("--agent <id>", "Filter by agent_id")
  .option("--json", "Emit JSON instead of formatted text")
  .option("-c, --config <path>", "Path to guvnah.context.yaml")
  .action((opts: {
    run?: string;
    today?: boolean;
    agent?: string;
    json?: boolean;
    config?: string;
  }) => {
    runReport(opts);
  });

program
  .command("inspect <file>")
  .description("Inspect a saved JSON chat completion request without forwarding it.")
  .option("--json", "Emit JSON instead of formatted text")
  .option("-c, --config <path>", "Path to guvnah.context.yaml")
  .action((file: string, opts: { json?: boolean; config?: string }) => {
    runInspect(file, opts);
  });

program
  .command("config")
  .description("Print the resolved (merged) configuration.")
  .option("-c, --config <path>", "Path to guvnah.context.yaml")
  .option("--json", "Emit JSON instead of YAML")
  .action((opts: { config?: string; json?: boolean }) => {
    runConfig(opts);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
