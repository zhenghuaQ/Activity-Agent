# Stress Eval v1

`stress-v1.0` is a separate robustness track for realistic, model-simulated multi-turn users. It uses OpenEvals only to orchestrate scripted-first / LLM-follow-up turns and the existing Activity-Agent Runtime session for the agent. It does not define the fixed benchmark, score decisions with a judge, or upload scenarios to LangSmith.

## Fixed benchmark versus stress track

- `decision-v3.0` uses fixed turns, deterministic fixtures, and deterministic evaluators. It remains the stable regression benchmark and must not depend on model credentials.
- `stress-v1.0` uses a fixed opening message followed by an LLM-simulated user. Its trajectories are stochastic, model-dependent, and intended to probe robustness. Results are not comparable to the fixed benchmark and must not be combined into its leaderboard.

The simulated user receives only its persona/profile prompt. The Agent app receives only the current user message and a stable thread ID; each run owns one Runtime/session and its own scenario environment. The full conversation is not re-injected into the Agent prompt. Scenario fixtures and evaluator invariants are not exposed to the simulated user.

No LLM judge is used. Metrics are reported separately (runtime completion, planning termination, hard-constraint checks/violations, immutable-fact retention, session isolation, max-turn exhaustion, failures, replans/turns, and outcome distribution). No single robustness score is invented. Since there is no scenario feasibility ground truth, a non-terminating interaction is reported as unclassified/unterminated rather than `missed_feasible_plan`.

Run with `npm run eval:stress`. The default simulated-user model is `openai:gpt-4.1-mini`; set `OPENEVALS_SIM_USER_MODEL` to another supported LangChain chat-model identifier if needed. Credentials for that provider are required and are separate from `LANGSMITH_API_KEY`. `STRESS_RUNS_PER_SCENARIO` defaults to 1; `STRESS_MAX_CONCURRENCY` defaults to 1 and is bounded from 1 to 4. `STRESS_OUTPUT_PATH` defaults to `eval-results/stress`.

Artifacts contain user-visible trajectories and structured Runtime snapshots; keep them local and treat them as potentially sensitive. Missing credentials fail clearly without a deterministic or simulated fallback. `npm run eval`, `npm run eval:decision`, and `npm run eval:runtime` do not run this track.
