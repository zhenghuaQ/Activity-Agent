# Runtime Lifecycle Hardening Design

## Context

The submitted Runtime version changes the application from a fixed five-stage
pipeline into a generic Agent Runtime. The intended production path is:

```text
Channel Adapter
  -> Submission
  -> SessionSubmissionLoop
  -> AgentRun / AgentState
  -> ActivityPlanner
  -> RuntimePlan
  -> Executor
  -> ToolExecutor
  -> Evaluation / bounded replan
```

The architectural direction is retained. This design closes lifecycle and
correctness gaps found in the submitted implementation without introducing new
external infrastructure or changing the existing activity-decision product
scope.

## Goals

1. Make `AgentRuntime` the only production execution entry while retaining
   deprecated pipeline APIs as thin compatibility adapters.
2. Preserve user constraints across every replan and separate them from mutable
   search policy.
3. Guarantee progress for queued turns while allowing control operations to
   inspect or cancel the active turn.
4. Propagate cancellation through every Runtime, planner, tool, LLM, and provider
   boundary without converting cancellation into fallback success.
5. Enforce Session ownership for every run control operation.
6. Bound the lifetime and memory use of Session loops, transcripts, and Runtime
   event subscriptions.
7. Make circuit-breaker transitions total: every admitted probe must settle.
8. Produce a complete, ordered run transcript and correlated trace.
9. Evaluate the canonical Runtime path and cover concurrency and failure modes.

## Non-goals

- No distributed queue, Redis, Kafka, NATS, or database-backed Session store.
- No cross-process run recovery.
- No unbounded LLM-authored Runtime Plans.
- No true parallel Runtime step execution in this change; DAG readiness and
  conflict metadata remain preparation for a later bounded-concurrency phase.
- No changes to ordering, payment, booking, or fulfillment scope.
- No unrelated refactoring of the activity scoring and recommendation model.

## Architectural Boundaries

### Channel Adapter

The Fastify adapter owns transport concerns only: request conversion, response
encoding, SSE framing, rate limiting, metrics, and connection-close detection.
Channel handlers may construct and submit Runtime operations but must not invoke
activity pipeline stages directly.

### Runtime

The Runtime owns Submission routing, Session scheduling, Run lifecycle,
cancellation, transcript recording, Trace publication, tool recovery, evaluation,
and bounded replan orchestration. It does not contain activity-specific scoring
or candidate-generation rules.

### Activity Planner

`ActivityPlanner` owns the activity workflow and binds activity stage handlers to
a Runtime Plan. It receives an already-created `AgentState`; it does not create
Sessions, accept HTTP requests, or manage external connection lifetimes.

### Compatibility APIs

`runFullPipeline()` and `runFullPipelineStreaming()` remain available for older
callers and tests. They normalize legacy arguments and delegate to the same
`ActivityPlanner`/Runtime execution path. They must not contain a second copy of
step handlers, evaluation, or replan loops.

## State Model and Invariants

### Immutable user constraints

The planning state distinguishes the constraints accepted from the user from
Runtime execution policy:

```ts
interface PlanningState {
  constraints?: StructuredConstraints;
  searchPolicy?: {
    radiusKm: number;
  };
  planRevision?: number;
  // existing derived planning fields
}
```

`constraints` remains the authoritative acceptance criterion for the entire Run.
Runtime code must not increase `constraints.distance.maxKm` without an explicit
new user input. `searchPolicy.radiusKm` may be increased by a bounded replan to
discover additional candidates, but final evaluation always uses the immutable
user constraints.

### Replan invalidation

Applying a replan creates a new planning revision. It preserves input,
constraints, messages, trace, errors, and run identity, while invalidating all
derived artifacts that depend on the changed search policy:

- candidates;
- constraint evaluations;
- decision;
- selected plan;
- stage-specific derived notes that no longer describe the active revision.

The new Runtime Plan then regenerates candidates, re-evaluates them, and creates a
new decision. A failed replan cannot fall back to stale derived artifacts.

### Terminal-state invariants

- `completed` requires a selected plan that passes evaluation against the
  original user constraints.
- `cancelled` is distinct from `failed` at AgentRun and Submission boundaries.
- Every terminal Run appends one final Decision message and one final Trace event.
- A Run cannot publish two final Trace events.

## Session Mailbox and Scheduling

Each `SessionSubmissionLoop` uses separate queues for turns and control
operations:

```text
turnQueue       serial user turns
controlQueue    inspect/cancel operations
currentTurn     at most one running turn
```

When no turn is active, the loop starts the next queued turn. While a turn is
active, it waits only for either current-turn completion or arrival of a control
operation. The presence of an ordinary queued turn is not a wake-up condition.
This prevents a resolved-Promise spin loop from starving timers, fetch callbacks,
or I/O.

Control operations may preempt queue consumption but never execute another turn
concurrently in the same Session. Different Sessions retain independent loops
and may run concurrently.

The loop exposes explicit lifecycle state:

```ts
isIdle(): boolean;
stop(reason?: string): void;
```

The Router removes a loop when it has no active turn, queued operation, or live
control waiter.

## Run Ownership

Active runs are keyed or validated by both Session and Run identity. Every
`inspect_run` and `cancel` operation must verify:

```ts
active.sessionId === submission.sessionId
```

A mismatch returns a non-disclosing rejection equivalent to a missing Run. Run
IDs are never treated as sufficient authorization. The interface leaves room for
adding `userId` ownership later without changing the Session control contract.

## Structured Cancellation

A shared abort-linking helper creates child scopes with these properties:

1. If the parent is already aborted, the child is aborted immediately.
2. A later parent abort propagates the original reason once.
3. Completion removes listeners and clears timeout handles.
4. Tool timeout and user cancellation remain distinguishable outcomes.

All potentially blocking boundaries accept `AbortSignal`: intent parsing,
follow-up generation, Tool execution, LLM requests, provider searches, geocoding,
and transit requests.

Abort errors are rethrown or normalized as cancellation. Providers must not turn
an abort into a Mock fallback. Network failures, timeouts, rate limits, and
explicitly configured recoverable errors may still use retry or fallback policy.

For SSE, the Channel Adapter observes socket closure and cancels the corresponding
Run. The event subscription is closed in `finally`, regardless of normal final
events, submission rejection, execution failure, or client disconnect.

## Bounded Session Retention

Anonymous requests that do not provide a Session ID are one-shot Sessions. Their
loop and transcript are released after the turn reaches a terminal state.

Explicit Sessions use bounded in-memory retention:

- idle TTL;
- maximum Session count;
- maximum retained messages or transcript bytes per Session;
- no eviction of an active Session;
- deterministic cleanup during Runtime shutdown.

The implementation should reuse the project's existing TTL/LRU approach behind a
Session-store interface. This preserves an upgrade path to durable storage without
making a distributed dependency part of this change.

## Circuit-breaker State Machine

Every call admitted in half-open state must settle the probe exactly once.
Outcomes are classified as follows:

- successful or partial Tool response: close the circuit;
- retryable upstream/infrastructure failure: reopen the circuit;
- parameter or domain-state rejection: release the probe without counting an
  upstream health failure;
- cancellation: release the probe without changing upstream health;
- unexpected thrown error: record an execution failure and reopen the circuit.

A single breaker method, such as `completeProbe(toolName, outcome)`, owns the
transition and always clears `halfOpenProbeInFlight`. ToolExecutor must not
manipulate half-open bookkeeping through unrelated branches.

## Transcript and Trace

Runtime owns the ordered run transcript:

1. append `user_input` when a Run starts;
2. append each `tool_result` after the corresponding attempt;
3. append replan/system messages when Runtime policy changes execution;
4. append exactly one `decision` at the terminal transition.

The completed Run's messages are appended to the Session once, without duplicating
the inbound Submission message. Tests assert semantic ordering and correlation,
not a fixed total message count.

Trace events remain correlated by `traceId` and `runId`. SSE consumes the Runtime
EventBus rather than a private pipeline callback. The Runtime guarantees either a
final event or explicit subscription closure so consumers cannot wait forever.

## Evaluation Harness

The Runtime evaluator invokes `AgentRuntime.submit()` and therefore exercises the
canonical Submission, Session loop, ActivityPlanner, ToolExecutor, Trace, and
replan path. Baseline continues to invoke the deterministic legacy stage sequence
as a control group.

Runtime evaluation records task success, constraint pass rate, latency, replan
count, Tool attempts, Trace count, terminal status, and cleanup state. A successful
Eval requires final evaluation against the original constraints.

## Error Handling

- Invalid Runtime Plans fail before the first step starts.
- A stage exception preserves the most recent completed planning state and Trace;
  it does not restore the initial state.
- Submission rejection closes any waiting stream subscription.
- Cancellation is reported as cancellation, not generic execution failure.
- Session ownership failure does not reveal whether another Session owns the Run.
- Cleanup runs in `finally` paths and is idempotent.

## Testing Strategy

### Unit tests

- DAG validation and Ready Set behavior remain covered.
- Session mailbox test queues a second turn without a control operation and proves
  the first timer-driven turn completes.
- Control preemption tests cover inspect and cancel without starting a second turn.
- Run ownership tests reject cross-Session inspect and cancel.
- Abort tests cover already-aborted parents, mid-call cancellation, and providers
  refusing to fallback after abort.
- Replan tests prove original constraints are unchanged, derived artifacts are
  cleared, and stale plans cannot pass.
- Circuit tests cover every half-open outcome and prove the probe flag is released.
- Session retention tests prove one-shot cleanup, TTL eviction, active-run
  protection, and bounded transcript size.
- Transcript tests assert user input first, final decision last, matching Run IDs,
  and Tool-result correspondence.

### Integration tests

- Sync HTTP and SSE both execute through AgentRuntime.
- SSE disconnect cancels the Run and releases the subscription.
- A rejected or failed Submission cannot leave SSE waiting for a final event.
- Deprecated compatibility APIs return the same decision semantics as the
  canonical ActivityPlanner path.
- Runtime Eval proves that Submission/Session/ActivityPlanner paths were entered
  and includes explicit retry, cancellation, and replan scenarios.

### Required verification

The merged implementation must pass:

```text
npm test
npm run typecheck
npm run lint
npm run build
npm run eval
```

The verification run must contain zero test failures and zero type errors. Existing
lint warnings may be cleaned when they occur in touched files; unrelated lint
cleanup is outside scope.

## Migration and Compatibility

The merge proceeds in behavior-preserving increments:

1. import the submitted contracts and Runtime modules with their tests;
2. harden mailbox, cancellation, ownership, retention, breaker, and replan
   invariants before routing production traffic through them;
3. make ActivityPlanner the single orchestration implementation;
4. convert compatibility functions and SSE into adapters;
5. switch Eval to AgentRuntime;
6. update tests and documentation to describe actual behavior.

Existing HTTP decision fields remain available. Runtime identifiers may be added
to responses, but existing clients must not be forced to understand Session,
Submission, Run, or Trace identifiers to obtain a decision.

## Acceptance Criteria

1. No production Channel handler directly executes pipeline stages.
2. There is one implementation of the activity Runtime workflow.
3. Two turns in one Session cannot run concurrently and cannot starve each other.
4. Control operations cannot access a Run from another Session.
5. Cancellation stops blocking work promptly and never triggers Mock fallback.
6. Replanning never mutates user constraints or reuses stale derived results.
7. Every admitted half-open probe reaches a settled breaker state.
8. Anonymous request state is released and explicit Session retention is bounded.
9. Each terminal Run has a complete transcript and exactly one final Trace event.
10. Runtime Eval uses AgentRuntime and exercises failure and replan paths.
11. All required verification commands complete successfully.
