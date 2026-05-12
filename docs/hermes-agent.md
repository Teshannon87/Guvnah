# Using Guvnah Context Inspector with Hermes-agent

Hermes-agent is the original target consumer. Any OpenAI-compatible client works the same way.

## 1. Start Guvnah

```bash
guvnah-context init
guvnah-context proxy
```

Default endpoint: `http://127.0.0.1:8791/v1`.

## 2. Point Hermes-agent at it

Set Hermes-agent's OpenAI base URL:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8791/v1
```

If Hermes-agent uses a config file instead, look for `model.base_url` or similar and set it to the same value.

## 3. (Optional) Attach run metadata

Guvnah groups calls into "runs" using request headers. Setting these lets `guvnah-context report --run <id>` give you a per-task breakdown.

| Header | Default if missing |
| - | - |
| `x-guvnah-agent-id` | `unknown-agent` |
| `x-guvnah-run-id` | auto-generated timestamp ID |
| `x-guvnah-task-id` | null |
| `x-guvnah-task-type` | `unknown` |

If your client library doesn't support adding headers, runs still work — they just get auto-generated IDs.

## 4. Read a report

```bash
guvnah-context report --today
guvnah-context report --run <run_id>
```

## 5. (Optional) Chain RelayPlane behind Guvnah

In `guvnah.context.yaml`:

```yaml
upstream:
  base_url: "http://localhost:8787/v1"     # RelayPlane
  api_key_env: "RELAYPLANE_API_KEY"
```

Now the chain is: **Hermes-agent → Guvnah → RelayPlane → real provider.**
