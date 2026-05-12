# Hermes-agent + Guvnah Context Inspector

Drop-in example config for using Guvnah in front of a Hermes-agent install.

## Setup

```bash
# 1. Install Guvnah
npm install -g guvnah-context   # or `npm link` from a checkout

# 2. From your Hermes-agent project root:
cp examples/hermes-agent/guvnah.context.yaml ./guvnah.context.yaml
guvnah-context init                         # bootstraps SQLite
echo "UPSTREAM_API_KEY=sk-..." > .env

# 3. Start the proxy
guvnah-context proxy
```

Then in Hermes-agent's config (or env):

```
OPENAI_BASE_URL=http://127.0.0.1:8791/v1
```

## Per-run grouping

If you can set request headers, attach:

```
x-guvnah-agent-id: hermes-agent
x-guvnah-run-id:   hermes-${SESSION_ID}
x-guvnah-task-type: chat
```

Then read the report:

```bash
guvnah-context report --run hermes-<SESSION_ID>
```
