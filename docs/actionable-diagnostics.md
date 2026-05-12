# Actionable Diagnostics

## Vision

Guvnah today is a passive logger: it proxies, records, and flags. The next step is to turn observations into safe, reversible actions on the upstream agent's config — without ever touching model routing or mutating prompts in-flight.

Boundaries that stay fixed:
- Guvnah does not route between models.
- Guvnah does not rewrite prompts on the wire.
- Every action ships with a backup, a health probe, and a one-line revert command.

Everything else (config edits, cache hints, tool pruning, history summarization triggers) is fair game.

## Why now

Real run on the connected Hermes agent: 41,731 prompt tokens, 5 bloat flags. Breakdown:

| Component | Tokens | Notes |
|---|---|---|
| System prompt | 5,278 | 2.6× a sensible budget; duplicate SOUL content suspected |
| Tool descriptions | 14,511 | 85 skills + 11 tool categories — most unused per run |
| Tool output | 20,182 | One 16,841-token message from a recursive `ls` |
| Memory | 1,052 | fine |
| History | 705 | fine |

The fix for each of these is a config edit on the upstream agent, not a model swap. Guvnah is sitting right next to that config.

## Features

### 1. Cache-friendliness detector

Anthropic / OpenAI / Gemini prompt caches have ~5-minute TTLs and key on prefix stability. If guvnah sees the system prompt or tool block changing across requests within a 5-minute window, the cache is busted on every call.

Detect:
- Hash the (system prompt, tool descriptions) prefix per request.
- If hash churns more than once per 5-minute window, flag `CACHE_THRASH`.

Recommend:
- Identify which segment is changing (system / tools / both).
- Suggest moving volatile content (timestamps, run IDs) into the user message tail.

No action taken — recommendation only. Cache key construction is upstream's call.

### 2. Tool-usage frequency tracker

Across the last N runs (default 50), count how many times each tool was actually called vs. how many times its description was shipped in the prompt.

Output:
```
tool                       descriptions_sent   actual_calls   wasted_tokens_est
Google_Drive__list_files   50                  0              ~12,500
Ramp__list_bills           50                  0              ~9,000
Read                       50                  47             ~120 (good)
```

Recommend (and optionally apply, with `--apply`):
- For tools at 0% usage over N runs, propose disabling them in the upstream config.
- For Hermes specifically: edit `/root/.hermes/config.yaml` `enabled_tools:` list.

Failsafe pattern (reusable across all actions):
1. Snapshot config to `config.yaml.bak.<timestamp>`
2. Apply atomic edit
3. Restart `hermes-gateway`
4. Health probe: `curl /v1/models` with 10s timeout
5. Health probe: minimal chat completion
6. On any failure: restore from backup, restart, print error
7. On success: print one-line revert command

### 3. System prompt diff & dedupe

Guvnah already sees every system prompt. Add:
- Diff between current and last run.
- Detect duplicated blocks (e.g., SOUL.md content appearing in both system prompt AND memory).
- Suggest dedupe targets.

Optional apply: write a deduplicated system prompt to a candidate file, restart, probe, auto-revert on failure.

### 4. Per-tool output size enforcement

The 16,841-token `ls` was the single biggest bloat source in the example run. That kind of blast comes from one tool one time, not from steady-state behavior.

Add:
- Per-tool output size histogram across runs.
- Configurable hard ceiling (e.g., `Bash: 4000 tokens`).
- When ceiling is hit, guvnah truncates the tool result before storing it in the session JSON, replacing the tail with `[truncated by guvnah: N tokens elided]`.

This is the one action that touches in-flight data, so it needs:
- Per-tool opt-in (no global default).
- Logged truncation events surfaced in the report.
- An off switch in config.

### 5. History summarization trigger

When session token count crosses a threshold (default 80% of model context), flag and suggest:
- Calling upstream's compaction endpoint if exposed.
- For Hermes: invoking the session-summary tool.

Recommendation only. Guvnah does not write to the agent's session file directly.

## Action model

Three tiers, surfaced separately in reports:

| Tier | What it does | When safe to auto-apply |
|---|---|---|
| Observe | Logs metric, no recommendation | Always |
| Recommend | Prints suggested action + revert command | Always |
| Apply | Executes change with backup → probe → auto-revert | Only when explicitly invoked with `--apply <action-id>` |

No flag-based auto-apply. Every applied change is one explicit human decision.

## CLI surface (proposed)

```
guvnah-context report              # current behavior, plus new flags
guvnah-context recommend           # list outstanding recommendations across all runs
guvnah-context apply <action-id>   # run the failsafe sequence on one action
guvnah-context revert <action-id>  # restore last backup for an action
```

## Build order

1. Cache-thrash detector — recommendation only. Lowest risk, immediate signal.
2. Tool-usage tracker — recommendation only. Needs N-run aggregation.
3. System prompt diff — recommendation only.
4. Apply path for tool pruning — first concrete `--apply`. Tests the failsafe pattern end-to-end on a low-blast action.
5. History summarization trigger — recommendation only.
6. Per-tool output ceilings — last, because it's the only feature that mutates in-flight payloads.

## Open questions

- Where does guvnah store backups? `/var/lib/guvnah/backups/` or alongside the target file?
- How does guvnah know which upstream agent to act on? Today it only knows the upstream URL. Add `agent_kind: hermes` in config and key actions off that.
- Health probe spec: is `/v1/models` 200 enough, or does each agent kind need its own probe?
