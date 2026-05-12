# Reports

All reports come from the local SQLite database at `database.path` (default `.guvnah-context/guvnah-context.sqlite`).

## CLI

```bash
guvnah-context report                       # recent runs (all agents)
guvnah-context report --today               # only today's runs
guvnah-context report --agent hermes-agent  # filter by agent_id
guvnah-context report --run <run_id>        # full breakdown for one run
guvnah-context report --run <run_id> --json
guvnah-context inspect ./request.json       # one-shot inspection from a file (no DB writes)
```

## What's in a full run report

- Run header (id, agent, task)
- Total prompt + response tokens, calls inspected
- Token breakdown by category
- Top context-bloat flags (sorted by priority, deduplicated by type)
- The single call with the largest prompt and its biggest category
- A one-line plain-English summary

## Grouping calls into runs

Guvnah groups calls by the `x-guvnah-run-id` header. If your agent doesn't send one, Guvnah generates a timestamp-based ID per call, which means each call ends up as its own run. To get useful aggregation, set a stable run ID per agent session:

```
x-guvnah-run-id: hermes-2026-05-11-001
```

## JSON output

`--json` emits the raw `RunReport` object (or array of `RunRow`s for the summary view), suitable for piping into `jq` or feeding back into other tools.

## SQLite directly

For ad-hoc queries:

```bash
sqlite3 .guvnah-context/guvnah-context.sqlite \
  "SELECT flag_type, COUNT(*), SUM(estimated_tokens_involved) \
   FROM context_flags GROUP BY flag_type ORDER BY 3 DESC;"
```

Schema lives in [`src/db/schema.ts`](../src/db/schema.ts).
