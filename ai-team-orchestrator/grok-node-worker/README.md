# Grok Node Worker

Grok joins AI Team as a real registered pull worker using the official Grok Build CLI. It reuses the shared Node Worker SDK; the Bridge remains the source of truth for queued/acknowledged/running/completed state.

## Prerequisites

1. Install Grok Build CLI: `curl -fsSL https://x.ai/cli/install.sh | bash`.
2. Authenticate once with `grok login` / `grok login --device-code`, or set `XAI_API_KEY`.
3. Start Bridge with `--pull-agent grok` in addition to the other enabled agents.
4. Set `AI_TEAM_BOOTSTRAP_TOKEN_FILE` (or `AI_TEAM_BOOTSTRAP_TOKEN`) for readiness reporting.

## Headless execution

The worker uses Grok's official headless mode with `--no-auto-update`, `--cwd`, `-p`, and `--output-format streaming-json`. Streaming session/tool events are mapped to Orchestrator Progress Events.

Environment options:

- `GROK_BIN`: Grok executable (default `grok`)
- `GROK_MODEL`: optional model override
- `GROK_REASONING_EFFORT`: optional reasoning effort
- `GROK_PERMISSION_MODE`: default `auto`
- `GROK_ALWAYS_APPROVE=1`: explicitly add `--always-approve`
- `GROK_TASK_TIMEOUT_MS`: bounded task timeout
- `AI_TEAM_BRIDGE_URL`: Bridge URL
- `AI_TEAM_BOOTSTRAP_TOKEN` / `AI_TEAM_BOOTSTRAP_TOKEN_FILE`: readiness auth

Readiness runs a real headless preflight and requires exactly `GROK_MODEL_OK` before the worker registers.
