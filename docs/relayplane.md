# Chaining Guvnah with RelayPlane

RelayPlane is **not required** for Guvnah to work. Guvnah will forward directly to any OpenAI-compatible endpoint (OpenAI, Anthropic via OpenAI-compatible adapter, OpenRouter, etc.).

Where RelayPlane adds value, you can chain it behind Guvnah:

```
Hermes-agent  →  Guvnah Context Inspector  →  RelayPlane  →  provider
   (client)       (pre-flight inspection)      (routing /     (real LLM)
                                                spend)
```

## Configuring Guvnah to use RelayPlane

In `guvnah.context.yaml`:

```yaml
upstream:
  base_url: "http://localhost:8787/v1"     # RelayPlane's OpenAI-compatible endpoint
  api_key_env: "RELAYPLANE_API_KEY"
  forward_client_auth: false               # Guvnah will inject the env-var key
```

Then in your shell:

```bash
export RELAYPLANE_API_KEY=...
guvnah-context proxy
```

## Direct mode (no RelayPlane)

```yaml
upstream:
  base_url: "https://api.openai.com/v1"
  api_key_env: "OPENAI_API_KEY"
```

```bash
export OPENAI_API_KEY=sk-...
guvnah-context proxy
```

## Who owns which concern?

| Concern | Owned by |
| - | - |
| Token budgets, prompt-bloat detection, repeated-block detection | **Guvnah** |
| Model selection, fallback, cost dashboards, spend caps | **RelayPlane** |
| API key storage and provider auth to upstream | **RelayPlane** (or Guvnah env-var fallback if direct) |
| Local SQLite of context-bloat data | **Guvnah** |

Guvnah deliberately does not duplicate RelayPlane's routing/spend features. Likewise, RelayPlane doesn't inspect the prompt body to break it down by category.
