# Guvnah Context Inspector

```
╔══════════════════════════════════════════════════════╗
║                       GUV'NAH                        ║
║                Royal Context Inspectorate            ║
║                                                      ║
║   Ensuring the Majesty's tokens do not fall prey     ║
║   to bloated prompts, runaway agents, needless       ║
║   model extravagance, or rogue automata of           ║
║   questionable judgment.                             ║
║                                                      ║
║   Some agents are loyal servants of the Crown.       ║
║   Others are expensive little goblins in waistcoats. ║
║                                                      ║
║   We inspect accordingly.                            ║
╚══════════════════════════════════════════════════════╝
```

Guvnah Context Inspector is a local-first proxy that shows what your AI agent is stuffing into the prompt.

It sits between your agent (e.g. Hermes-agent) and your LLM provider or RelayPlane, inspects outgoing chat completion requests, estimates token usage, categorizes context, detects repeated blocks and tool/memory bloat, and produces plain-English reports.

RelayPlane helps route model calls. Guvnah Context Inspector helps you see and control the context payload **before** the model call.

> **Status:** v1 — local-first, no SaaS, no cloud telemetry, no prompt mutation. Inspect-only.

---

## Why Guvnah and not just RelayPlane?

| | RelayPlane | Guvnah Context Inspector |
| - | - | - |
| When it runs | Around the model call | **Before** the model call |
| Primary concern | Routing + spend intelligence | Prompt / context bloat |
| Answers | "What did this cost? Which model?" | "What is my agent stuffing into the prompt and what is wasteful?" |
| Cache awareness | Spend-side | Detects cache-hostile prefixes |
| Deployment | Hosted or self-hosted | Local-only |

They are complementary. The recommended chain is `Hermes-agent → Guvnah → RelayPlane → provider`. RelayPlane is not required — Guvnah will forward directly to OpenAI/Anthropic/anything OpenAI-compatible.

## Install

```bash
git clone https://github.com/teshannon87/guvnah
cd guvnah
npm install
npm run build
npm link            # exposes the `guvnah-context` binary on your PATH
```

## Quickstart

```bash
cp guvnah.context.example.yaml guvnah.context.yaml   # template → runtime
# edit guvnah.context.yaml — at minimum set upstream.base_url
guvnah-context init                                  # bootstraps .env + sqlite
# edit .env (UPSTREAM_API_KEY)
guvnah-context proxy
```

`guvnah.context.yaml` is the runtime config and is **gitignored** so a
`git pull` never touches it. Only `guvnah.context.example.yaml` is tracked.
Treat the example file as documentation; copy it into place once per host.

The proxy boots at `http://127.0.0.1:8791/v1` and forwards `POST /v1/chat/completions` to the URL in `guvnah.context.yaml`.

Point your agent's OpenAI-compatible base URL at Guvnah:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8791/v1
```

Optionally attach run-tracking headers (used to group calls in reports):

```
x-guvnah-agent-id: hermes-agent
x-guvnah-run-id:   hermes-2026-05-11-001
x-guvnah-task-id:  refactor-auth
x-guvnah-task-type: code
```

## Chaining with RelayPlane

Set Guvnah's upstream to RelayPlane:

```yaml
upstream:
  base_url: "http://localhost:8787/v1"
```

The chain becomes `Hermes-agent → Guvnah Context Inspector → RelayPlane → OpenRouter/Anthropic/OpenAI`.

## Live cost line

After every completed request, Guvnah prints a one-line cost summary to stdout:

```
🪙 4,820 in / 312 out → $0.0262 (gpt-4o-mini, run=hermes-001)
```

Pricing is resolved in this order: `pricing.overrides` (in your config) → `.guvnah-context/openrouter-models.json` (if synced) → built-in baseline (~12 popular models). If no source has a price for the model, the line falls back to `🪙 4,820 in / 312 out · cost unknown (...)`. Disable with `notifications.cli.enabled: false`.

Provider prices change. The baseline is a starting point — override in config when you see a gap.

## Resilience

**Guvnah will never block your agent from reaching the model.** Inspection and DB writes run inside a circuit breaker; if Guvnah's own sidecar work fails, it logs to stderr and forwards the request anyway. After N consecutive failures the breaker opens and Guvnah short-circuits inspection until it cools down, while continuing to forward requests verbatim. The breaker only protects Guvnah's sidecar work — upstream errors are returned to the agent as-is so they can be retried or surfaced normally.

If SQLite itself can't open (permissions, disk full, etc.), the proxy still starts in **degraded mode** and forwards requests. Reports will be empty until the DB is repaired.

## Reading reports

```bash
guvnah-context report --today              # list runs from today
guvnah-context report --run <run_id>       # full breakdown for one run
guvnah-context report --run <run_id> --json
guvnah-context inspect ./request.json      # standalone inspection of a saved request
```

Example output:

```
Run: hermes-2026-05-11-001
Agent: hermes-agent
Calls inspected: 14
Total prompt tokens: 186,420
Total response tokens: 12,890

Context breakdown:
- System/developer: 38,200 tokens
- Tools/skills: 64,900 tokens
- Memory/profile: 21,400 tokens
- Conversation history: 42,700 tokens
- Tool output/logs: 17,900 tokens
- Unknown: 1,320 tokens

Top context bloat flags:
1. tool_bloat [high]
   Tools/skills consumed 64,900 tokens (budget 4,000).
   Suggestion: inject a compact tool index first, then expand only selected tool schemas.
...

Guvnah estimate: this run has high context bloat. Most waste appears to come from tools/skills and repeated prompt blocks.
```

## Flag glossary

| Flag | What it means |
| - | - |
| `oversized_context` | Total prompt tokens exceed `token_budgets.max_total_prompt_tokens`. |
| `large_system_prompt` | System/developer message tokens exceed budget. |
| `tool_bloat` | Tool/function schemas + tool-keyword messages exceed budget. |
| `memory_bloat` | Memory/profile context exceeds budget. |
| `history_bloat` | Conversation history exceeds budget. |
| `raw_tool_output_bloat` | Raw stdout/HTML/JSON tool outputs exceed budget. |
| `repeated_block` | The same ≥N-token block appears multiple times in this request or run. |
| `cache_hostile_prefix` | The first ~4K tokens changed since the previous call in the same run. |
| `large_single_message` | A single message exceeds the per-message threshold. |
| `unknown_context_mass` | A large amount of context could not be categorized. |

## What v1 doesn't do (yet)

- No dashboard. CLI reports only.
- No prompt mutation (Guvnah is inspect-only).
- No model routing — point Guvnah at RelayPlane (or your provider) for that.
- No streaming (`stream: true` returns HTTP 400 with a clear error).
- No cloud telemetry. Nothing leaves your machine.
- No Composio / MCP governance.

## Configuration

See [`guvnah.context.example.yaml`](./guvnah.context.example.yaml) and [docs/context-bloat.md](./docs/context-bloat.md).

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
