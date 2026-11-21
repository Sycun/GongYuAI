# Long-run contract

## Lease

- Control plane owner acquires lease (`leaseOwner`, `leaseUntil`, monotonic `fence`).
- Watchdog renews while worker is alive.
- Expired lease + dead worker ⇒ restart with same task volumes.

## Checkpoint

Worker persists `{ phase, step, toolCalls, installs, tokens }` before advancing. After crash, resume from last phase (init → loop → report → done).

## Evidence gate

`assertGoal(goalId, paths)` succeeds only when:

1. Each `evidencePatterns` entry matches at least one provided relative path.
2. Every provided path exists under `evidence/`.
3. If a path is `**/ALL_COMPLETE.json`, the JSON must be a non-empty challenge array and **every** `is_completed` must be `true` (used by autonomous board-clearance goals).

No file ⇒ no pass. Model self-report / verbal DONE is insufficient.

## Worker budget (OpenAI-compatible loop)

Loop exits on any of: all goals pass, `maxToolCalls`, `maxTokens`, `maxWallMs`, or fatal error.

- `completed` only when all goals pass.
- Otherwise terminal status is `budget_exhausted` (or `failed` / `stopped`).
- Tool results are truncated; chat history is trimmed to recent turns.
- Host network / VPN / proxy mutations are denied even if `auth.targets` contains `*`.

## Idempotency

- History facts are append-only.
- Intent claim is compare-and-swap on `proposed`.
- Goal assert is sticky (`passes` never reverts).
- Tool installs record History events.

## Termination

`completed` | `failed` | `budget_exhausted` | `stopped` written to `worker-status.json`; Watchdog promotes TaskRecord.
