# Decision Semantic Judge v1

`decision-judge-v1.0` adds a model-based semantic diagnostic to the fixed `decision-v3.1` benchmark only. It runs the canonical fixed-turn OpenEvals harness once per Scenario, then evaluates the resulting execution artifact. It does not run the stress track, use an LLM-simulated user, change DecisionOutcome/taskSuccess, or replace deterministic checks.

Four independent 1–5 ratings are produced: semantic goal alignment, plan coherence, tradeoff quality, and interaction quality. Each includes a short evidence comment. No weighted overall score is produced. Deterministic runtime, feasibility, hard-constraint, adaptation, preference, and task-success metrics remain separate source-of-truth fields in the artifact.

The judge sees the fixed user conversation, the Agent's user-visible replies, a bounded selected-plan summary, final constraints, planning termination, and an explicit projection of relevant reference expectations. It does not receive runtime traces, tool inputs/outputs, unselected candidates/rankings, Pareto scores, deterministic scores, task success, hard-violation results, agent version, branch, or baseline/candidate labels. User and Agent text is treated as quoted evaluation data, not instructions.

For infeasible cases with `no_feasible_plan`, the rubrics assess the coherence and explanation of declining an infeasible plan; absence of a place sequence is not automatically penalized. A deterministic `runtime_failure` is skipped, not assigned a low score. An `invalid_plan` may still receive semantic diagnostics, but no semantic rating can alter its deterministic hard-constraint result.

Run explicitly with `npm run eval:judge`. The judge model is configured independently through `DECISION_JUDGE_MODEL` (default `openai:gpt-4.1-mini`); `OPENEVALS_SIM_USER_MODEL` configures a different role and is not reused. OpenAI models require `OPENAI_API_KEY`, not `LANGSMITH_API_KEY`. `JUDGE_RUNS_PER_SCENARIO` defaults to 1 (maximum 3); `JUDGE_MAX_CONCURRENCY` defaults to 1 (maximum 4). Results are saved under `eval-results/judge/` with benchmark/rubric/model versions, deterministic metrics, separate judge scores/comments, repetitions and call count. Judge calls can incur model cost.

The current runner does not upload data to LangSmith. Fixed benchmark commands remain offline and do not invoke this judge. No pairwise comparison is implemented.
