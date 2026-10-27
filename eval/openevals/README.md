# OpenEvals scripted Decision benchmark adapter

OpenEvals is used only as the fixed scripted multi-turn execution harness. The canonical benchmark remains `eval/decision/scenarios`; each run derives its user response sequence directly from that Scenario's fixed `turns`.

This harness does not define benchmark cases, score domain outcomes, create simulated users, or run LLM judges. Activity-Agent owns Runtime, session state, memory, provider fixtures, planning, and decision evidence. Existing deterministic evaluators consume the same `DecisionScenarioRunOutput` contract for both the manual reference runner and this adapter.

## Fixed scripted benchmark

Fixed turns provide stable information disclosure for regression testing and version comparisons. The next user message is independent of the Agent's previous response. Do not mix these results with future robustness stress tests on a shared leaderboard.

## Future LLM simulated-user stress tests

An LLM-generated user may later probe robustness under variable disclosures and follow-ups. Such runs are stochastic stress tests, not the fixed benchmark, and must remain separately labeled and reported. No LLM-simulated user or LLM judge is used here.

The package currently used is `openevals@0.2.2`. The runner calls its `runMultiturnSimulation` API with `user: string[]` and `maxTurns` equal to the Scenario's number of user turns. OpenEvals counts each user/app exchange as one turn; its implementation starts `turnCounter` at zero, passes one static user response to the app, and increments the counter after that app call.

Each execution gets a unique run-scoped `threadId`; all turns for that execution map to one Scenario Runtime and one session. The session registry is disposed in a `finally` block, including when the simulator or app throws. The app callback receives only the current `{ inputs, threadId }`; it never receives or reconstructs the full transcript. OpenEvals' returned trajectory contains only visible user/assistant messages, while structured runtime evidence remains in per-turn snapshots.

Local evaluation does not require `LANGSMITH_API_KEY`. OpenEvals internally wraps simulation callbacks with LangSmith `traceable`; with tracing disabled (the default absent explicit tracing configuration), this stays local. The harness does not attach trajectory evaluators.
