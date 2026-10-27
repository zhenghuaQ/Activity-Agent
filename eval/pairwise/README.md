# Blind Pairwise Decision Comparison

This compares two canonical `decision-v3.1` Decision Evaluation Artifacts. The Pairwise CLI only reads artifact files: it never creates a Scenario Runtime or runs an Agent. Stress trajectories are intentionally excluded. Artifacts from `decision-v3.0` are not compatible with v3.1 and are rejected by benchmark-version validation.

## Recommended workflow

1. Check out/build Variant A.
2. Run `npm run eval:decision:artifact` and retain the generated JSON.
3. Check out/build Variant B.
4. Run `npm run eval:decision:artifact` and retain the generated JSON.
5. Configure the pairwise judge model credential.
6. Set `PAIRWISE_ARTIFACT_A` and `PAIRWISE_ARTIFACT_B`, then run `npm run eval:pairwise`.

Artifacts include `DECISION_VARIANT_LABEL` only in local provenance/results. Judge context is constructed exclusively from the selected scenario's reference and the two projected decision contexts. The judge sees only Candidate A and Candidate B, never variant labels, Git metadata, or timestamps.

The artifact loader rejects invalid JSON/schema, a different benchmark version, scenario-count/ID mismatch, and per-scenario hash mismatch. There is no partial comparison mode. Dirty working trees are allowed and flagged in provenance and the final report.

Before semantic judging, a conservative deterministic gate handles clear runtime, hard-constraint, and valid-task-success differences. Other unresolved cases use a dedicated pairwise rubric with A/B/TIE, in both original and swapped positions. A result must be stable within each orientation and agree after normalization to the real artifact identity; position bias, instability, ties, and judge failures remain explicit statuses. No weighted score, Elo, leaderboard, automatic CI gate, or stress comparison is produced.

`PAIRWISE_JUDGE_MODEL` defaults to `DECISION_JUDGE_MODEL`, then `openai:gpt-4.1-mini`. `PAIRWISE_RUNS_PER_ORIENTATION` defaults to 1 (maximum 3), so a semantic comparison uses two calls by default. `PAIRWISE_MAX_CONCURRENCY` defaults to 1 (maximum 4). A credential is required only if at least one scenario needs semantic comparison. Results are written under `eval-results/pairwise/`.
