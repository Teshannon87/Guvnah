import { describe, expect, it } from "vitest";
import { extractToolUsage } from "../src/core/inspect/extractToolUsage.js";
import { buildRecommendations } from "../src/core/reports/buildRecommendations.js";
import { openDatabase, closeDatabase } from "../src/db/client.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertToolUsage } from "../src/db/queries.js";
import type { ChatRequest } from "../src/types/index.js";

describe("extractToolUsage", () => {
  it("flags shipped tools that were never invoked", () => {
    const req: ChatRequest = {
      model: "x",
      tools: [
        { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object" } } },
        { type: "function", function: { name: "write_file", description: "Write a file", parameters: { type: "object" } } },
      ],
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }],
        },
      ],
    };
    const usage = extractToolUsage(req);
    const byName = new Map(usage.map((u) => [u.tool_name, u]));
    expect(byName.get("read_file")?.shipped).toBe(true);
    expect(byName.get("read_file")?.invoked).toBe(true);
    expect(byName.get("write_file")?.shipped).toBe(true);
    expect(byName.get("write_file")?.invoked).toBe(false);
    expect(byName.get("write_file")?.description_tokens).toBeGreaterThan(0);
  });

  it("handles legacy functions array and function_call message", () => {
    const req: ChatRequest = {
      model: "x",
      functions: [{ name: "search", description: "search", parameters: {} }],
      messages: [
        { role: "assistant", function_call: { name: "search", arguments: "{}" } } as never,
      ],
    };
    const usage = extractToolUsage(req);
    expect(usage[0]?.tool_name).toBe("search");
    expect(usage[0]?.shipped).toBe(true);
    expect(usage[0]?.invoked).toBe(true);
  });
});

describe("buildRecommendations", () => {
  it("recommends disabling tools shipped >= minShipped that were never invoked", () => {
    const tmp = mkdtempSync(join(tmpdir(), "guv-recs-"));
    const dbPath = join(tmp, "guv.sqlite");
    try {
      const handle = openDatabase(dbPath);
      if (!handle.db) throw new Error("db open failed");
      const db = handle.db;
      // Seed: 10 calls all shipping "ghost_tool" but never invoking
      const created = new Date().toISOString();
      for (let i = 0; i < 10; i++) {
        insertToolUsage(db, {
          id: `tu-${i}`,
          call_id: `c-${i}`,
          run_id: "r-1",
          agent_id: "agent-x",
          entry: {
            tool_name: "ghost_tool",
            shipped: true,
            invoked: false,
            description_tokens: 800,
          },
          created_at: created,
        });
      }
      const recs = buildRecommendations(db, { agentId: "agent-x", minShippedCalls: 5 });
      const unused = recs.find((r) => r.id === "rec-unused-ghost_tool");
      expect(unused).toBeDefined();
      expect(unused?.kind).toBe("unused_tool");
      expect(unused?.evidence.shipped_calls).toBe(10);
      expect(unused?.evidence.invoked_calls).toBe(0);
      closeDatabase({ db, path: dbPath, error: null });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rolls up to an unused_toolset recommendation when every shipped Hermes tool in that toolset is unused", () => {
    const tmp = mkdtempSync(join(tmpdir(), "guv-toolset-"));
    const dbPath = join(tmp, "guv.sqlite");
    try {
      const handle = openDatabase(dbPath);
      if (!handle.db) throw new Error("db open failed");
      const db = handle.db;
      const created = new Date().toISOString();
      // skills toolset: skill_manage, skill_view, skills_list — none invoked
      for (const tool of ["skill_manage", "skill_view", "skills_list"]) {
        for (let i = 0; i < 9; i++) {
          insertToolUsage(db, {
            id: `tu-${tool}-${i}`,
            call_id: `c-${tool}-${i}`,
            run_id: "r-1",
            agent_id: "agent-y",
            entry: {
              tool_name: tool,
              shipped: true,
              invoked: false,
              description_tokens: 500,
              description_preview: `manages skills (${tool})`,
            },
            created_at: created,
          });
        }
      }
      const recs = buildRecommendations(db, { agentId: "agent-y", minShippedCalls: 5 });
      const toolsetRec = recs.find((r) => r.id === "rec-unused-toolset-skills");
      expect(toolsetRec).toBeDefined();
      expect(toolsetRec?.kind).toBe("unused_toolset");
      // Per-tool recs should be suppressed in favor of the toolset rec
      expect(recs.find((r) => r.id === "rec-unused-skill_manage")).toBeUndefined();
      expect(recs.find((r) => r.id === "rec-unused-skill_view")).toBeUndefined();
      closeDatabase({ db, path: dbPath, error: null });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
