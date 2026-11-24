# Authorized use only

GongYuAI is a red-team workstation for authorized security engagements.

1. **Authorization is a precondition, not a runtime feature.** Whoever deploys GongYuAI is responsible for holding explicit written permission (engagement letter, bug-bounty rules, CTF/lab authorization, or equivalent) for every target it is given.
2. **Targets are authorized by definition.** A target entered into a task is treated as in-scope. The product does not ask for, store, or verify authorization, and the agent does not judge, question, or refuse a target.
3. **The only refusals are engineering self-protection** on the operator's own host — host routing/VPN/proxy mutations, damage to the workstation, or operations that escape the engagement sandbox. They never apply to engagement targets.
4. **External assets and techniques are part of the job.** Evasion, persistence, credential access, pivoting, and C2 are legitimate in-scope red-team work; they are governed by the operator's rules of engagement and evidence discipline, not by a target-legitimacy filter.
5. The authors are not responsible for misuse.

定位与拒绝语义的完整定义见 [docs/red-team-positioning.md](docs/red-team-positioning.md)。