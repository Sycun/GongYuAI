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

No file ⇒ no pass. Model self-report is insufficient.

## Idempotency

- History facts are append-only.
- Intent claim is compare-and-swap on `proposed`.
- Goal assert is sticky (`passes` never reverts).
- Tool installs record History events.

## Termination

`completed` | `failed` | `budget_exhausted` | `stopped` written to `worker-status.json`; Watchdog promotes TaskRecord.
