# DVWA / lab smoke

Authorized lab example for GongYuAI MVP.

```bash
# Mock closed loop (no LLM) against a reachable URL
pnpm gy run \
  --goals examples/dvwa-smoke/goals.json \
  --target http://127.0.0.1:8080 \
  --auth "Written authorization: local DVWA lab owned by operator" \
  --mock --wait
```

Replace the target with your authorized DVWA/lab URL. For real LLM:

```bash
export OPENAI_API_KEY=...
# optional OpenAI-compatible base
export OPENAI_BASE_URL=https://api.openai.com/v1
pnpm gy run \
  --goals examples/dvwa-smoke/goals.json \
  --target http://127.0.0.1:8080 \
  --auth "Written authorization: local DVWA lab owned by operator" \
  --wait
```

Crash recovery check: while running, `kill` the worker PID from `gy status` and confirm Watchdog brings status back to `running` then `completed`.
