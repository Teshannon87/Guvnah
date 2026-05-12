# Context bloat: what Guvnah looks for

Guvnah categorizes every outgoing prompt into six buckets and flags categories that exceed configured budgets.

## Categories

| Bucket | Detection rule |
| - | - |
| `system` | Role is `system` or `developer`. |
| `toolOutput` | Role is `tool`/`function`, OR content matches `tool_output.keyword_patterns` (defaults: `stdout`, `stderr`, `stack trace`, `html`, `json`, …). |
| `tools` | Content matches `tools.keyword_patterns` (defaults: `tool`, `function`, `skill`, `available tools`, `mcp`, …) OR top-level `tools`/`functions` array on the request. |
| `memory` | Content matches `memory.keyword_patterns` (defaults: `memory`, `user profile`, `known facts`, …). |
| `history` | Role is `user`/`assistant` and nothing else matched. |
| `unknown` | Nothing matched. Large unknown mass triggers `unknown_context_mass`. |

Precedence: `system → toolOutput (role) → toolOutput (keywords) → tools → memory → history → unknown`.

Adjust the keyword lists in `guvnah.context.yaml` if your agent uses different wording.

## Flags

| Flag | Triggers when |
| - | - |
| `oversized_context` | Total prompt tokens exceed `detection.oversized_context_tokens`. |
| `large_system_prompt` | System bucket exceeds `token_budgets.max_system_tokens`. |
| `tool_bloat` | Tools bucket exceeds `token_budgets.max_tools_tokens`. |
| `memory_bloat` | Memory bucket exceeds `token_budgets.max_memory_tokens`. |
| `history_bloat` | History bucket exceeds `token_budgets.max_history_tokens`. |
| `raw_tool_output_bloat` | Tool-output bucket exceeds `token_budgets.max_tool_output_tokens`. |
| `repeated_block` | A ≥ `repeated_block_min_tokens` paragraph appears ≥ `repeated_block_min_occurrences` times in this request OR across earlier calls in the same run. |
| `cache_hostile_prefix` | The hash of the first `cache_prefix_window_tokens` worth of messages changed between this call and the previous one in the same run. |
| `large_single_message` | Any single message exceeds `detection.large_message_tokens`. |
| `unknown_context_mass` | Unknown bucket exceeds `detection.unknown_mass_tokens`. |

## Tuning

- **Tokenizer:** `cl100k_base` via `js-tiktoken`. Counts are estimates — accurate within a few percent for OpenAI/Claude models.
- **Token budgets** map to your real-world targets. Pick numbers that reflect your actual usable context window and quality cliff, not the model's hard max.
- **Repeated blocks** split on blank lines. If your agent never uses blank-line separation, smaller blocks won't be detected.
- **Cache-hostile prefix** uses a coarse heuristic. Two prompts with the same first 4K tokens hash identically; small persona tweaks will trip the flag. That's usually what you want — providers' caches are sensitive to byte-exact prefixes.

## Severity

`low` / `medium` / `high`. Medium triggers when a budget is exceeded; high when it is exceeded by ≥ 2× (or ≥ 1.5× for `oversized_context`).
