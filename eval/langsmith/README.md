# LangSmith adapter

LangSmith stores a remote mirror of the repository-owned `decision-v3.1` dataset, experiment runs, and deterministic evaluator scores. The local Decision Benchmark remains the source of truth for scenarios and decision semantics; `npm run eval:decision` never reads from LangSmith and remains fully offline.

The benchmark currently uses fixed multi-turn activity scenarios with synthetic fixture environments. Those serializable fixtures are uploaded with each Dataset Example so the remote Dataset records the exact evaluated inputs. Ground-truth expectations are stored separately in `referenceOutputs`; the target only consumes `inputs`.

## Run an experiment

1. Set `LANGSMITH_API_KEY` in `.env` or the process environment. `LANGSMITH_ENDPOINT`, `LANGSMITH_PROJECT`, `LANGSMITH_WORKSPACE_ID`, dataset/experiment overrides, and `LANGSMITH_EVAL_MAX_CONCURRENCY` are optional. `LANGSMITH_DECISION_RUNNER` selects `manual` (default) or `openevals-scripted`.
2. Run `npm run eval:langsmith:sync` to idempotently create or update the Dataset mirror. Stale remote examples are reported and are never deleted automatically.
3. Run `npm run eval:langsmith` to evaluate the remote Dataset with the local deterministic evaluators.

The default Dataset and experiment prefix are derived from the benchmark version: `activity-agent-decision-v3.1`. The default concurrency is bounded at 2. `npm run eval`, `npm run eval:decision`, `npm run eval:runtime`, and `npm test` do not require a LangSmith key or network access. The previous `activity-agent-decision-v3.0` Dataset remains a separate historical dataset and is not overwritten by the v3.1 default.

The target reuses the same scenario Runtime and multi-turn execution function as local evaluation. Local and LangSmith evaluator adapters call the same pure Decision Evaluator core. The `recommendation_preference_coverage` key is selectedPlan-scoped; a Pareto alternative cannot satisfy it. Not-applicable cases omit this feedback item rather than recording a zero. The evaluator semantics version is `decision-evaluator-v1.0`, independent of the benchmark version. The optional OpenEvals runner uses fixed scripted turns only. LangSmith is an experiment backend, not the benchmark definition, a decision judge, or a production Runtime dependency.
