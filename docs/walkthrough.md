# Quest Harness: File-by-File Walkthrough

## The Big Picture

Quest is a **three-agent coding harness** that takes a list of features and implements them autonomously using Claude. The architecture enforces **separation of concerns**: the coder builds, the evaluator verifies, and neither can override the other. All communication between agents happens through **files on disk** — agents are stateless.

```
User types `quest`
  -> detect.ts (what state is the project in?)
  -> cli.ts (dispatch to init / run / resume)
  -> orchestrator.ts (control loop)
    -> scheduler.ts (build DAG, plan batches)
    -> for each feature:
        -> coder agent (implement)
        -> evaluator agent (verify)
        -> pass? -> commit + next feature
        -> fail? -> retry or skip
```

---

## Layer 1: Entry Point

### `src/cli.ts` (~700 lines)

The CLI built with Commander.js.

Commands:
- `quest` (no subcommand) — auto-detects project state via `detect.ts` and dispatches to init, run, or resume
- `quest init` — explicit initialization with `--plan` for interactive Claude Q&A
- `quest run` — explicit orchestration loop with `--max-concurrency`, `--dry-run`, `--review`, `--tdd` flags
- `quest resume` — explicit resume from `claude-progress.txt`
- `quest status` — print pass/fail summary
- `quest eval <id>` — run evaluator only (debugging)
- `quest feature <id>` — run coder only (debugging)
- `quest monitor` — live TUI dashboard in a second terminal
- `quest traces` — list recorded LLM sessions
- `quest inspect <session-id>` — view full LLM trace

Each command creates an `Orchestrator` instance with the relevant options and calls its methods.

### `src/detect.ts` (~80 lines)

Project state detection. Checks filesystem artifacts to return one of:
- `uninitialized` — no `features.json` exists
- `interrupted` — `currentFeatureId` is set in progress, or `sprint-context-handoff.json` exists
- `pending` — features exist with some still `passes: false`
- `complete` — all features pass

This powers the default `quest` command's auto-dispatch.

---

## Layer 2: Orchestrator (the brain)

### `src/orchestrator.ts` (~1250 lines)

The control loop. This is the largest file and the central coordinator. It has two execution modes:

**Sequential mode** (`maxConcurrency = 1`):
```
while (pending features remain):
  1. Pick next feature (by priority)
  2. Write sprint-contract.json (lock criteria)
  3. Run coder via runCoderWithResets()
  4. Run evaluator
  5. Read eval-report.json
  6. Pass -> commit, mark passes:true
  7. Fail -> retry (up to retryLimit)
```

**DAG-scheduled parallel mode** (`maxConcurrency > 1`):
```
1. Build DAG from dependsOn fields (via scheduler.ts)
2. Create WorkerPool (dynamic worktree allocation)
3. Loop:
   a. planNextBatch() -> get ready features
   b. For each: acquire worktree, launch runFeatureInWorktree()
   c. Promise.race() -> process first completion
   d. Cherry-pick passing commits to main
   e. Check for newly unblocked features
   f. Repeat until done
4. Sequential retry for cherry-pick conflicts
5. Cleanup worktrees
```

Key methods:
- `initialize()` — runs the initializer agent once
- `run()` — main loop, delegates to `runDAGScheduled()` when parallel
- `implementFeature()` — coder -> evaluator for one feature (sequential)
- `runCoderWithResets()` — handles context window exhaustion transparently
- `runFeatureInWorktree()` — same as implementFeature but in an isolated git worktree
- `WorkerPool` class — creates worktrees on-demand, reuses them between batches

### `src/scheduler.ts` (~460 lines)

DAG construction and batch planning. Pure functions, no side effects:
- `buildDAG(features)` — Kahn's topological sort, cycle detection, level assignment, critical path computation. O(V+E).
- `planNextBatch(dag, completed, inFlight, maxConcurrency)` — returns features whose dependencies are all met, sorted by critical path > weight > priority, capped at available slots
- `getNewlyUnblocked(dag, completedId)` — which features just became ready after a completion
- `estimateTotalTime(dag, maxConcurrency)` — simulates scheduling for `--dry-run`
- `formatDAGSummary()` — human-readable level map for console output

### `src/worktree.ts` (~170 lines)

Git worktree isolation for parallel workers. Each parallel worker gets its own git worktree (lightweight checkout sharing the `.git` object store). Functions:
- `createWorktree(mainDir, workerId)` — `git worktree add` on a fresh branch
- `removeWorktree()` — cleanup
- `cherryPickToMain()` — merge a worker's passing commit back to main
- `syncFilesToWorktree()` — copy `features.json`, `claude-progress.txt`, `init.sh` to worker
- `cleanupAllWorktrees()` — remove stale worktrees from crashed runs

---

## Layer 3: Agents (the workers)

All agents follow the same pattern: call `query()` from `@anthropic-ai/claude-agent-sdk`, iterate the async generator, log each message, extract token usage on the `result` message.

### `src/agents/coder.ts` (~230 lines)

Implements one feature per session. System prompt enforces:
1. Startup protocol: `pwd -> git log -> read progress -> read current-feature.json -> read sprint-contract.json -> bash init.sh -> run tests`
2. Implement ONLY the feature in the sprint contract
3. Commit when done, write `sprint-completion.json`
4. Never set `passes: true` (that's the evaluator's job)

Has a TDD mode extension (`TDD_SYSTEM_PROMPT_EXTENSION`) that instructs red-green-refactor when `options.tdd` is true.

Throws `ContextResetNeededError` when the context manager detects the window is filling up — the orchestrator catches this and starts a fresh session with a handoff file.

### `src/agents/evaluator.ts` (~225 lines)

Independent QA verification. System prompt enforces:
1. Read `sprint-contract.json` (same contract the coder read)
2. For each acceptance criterion, design a test that would **fail** if the criterion isn't met
3. Execute the test (curl, Playwright, test runners)
4. Record pass/fail with **concrete evidence** (quoted output)
5. Only set `passes: true` if ALL criteria pass
6. Optional regression checks on previously passing features
7. Optional TDD verification (re-run tests independently)

Has Playwright MCP server for browser testing.

### `src/agents/initializer.ts` (~160 lines)

Project scaffold generation. Creates three files: `init.sh` (dev server startup), `features.json` (200+ features), `claude-progress.txt` (initial state). Runs once.

### `src/agents/reviewer.ts`

Optional code review agent (fourth agent). Runs between coder and evaluator when `--review` is set. Reads the git diff, checks for security, error handling, duplication, naming, style. Writes `review-report.json`. Critical issues bounce the feature back to the coder.

### `src/agents/types.ts` (~240 lines)

All shared type definitions. The contract between agents and orchestrator:
- `Feature` — id, description, acceptanceCriteria, dependsOn, passes
- `SprintContract` — locked criteria before coder runs
- `SprintCompletion` — what the coder claims to have done
- `ContextHandoff` — state for resuming after context reset
- `EvalReport` — verdict + per-criterion evidence
- `ReviewReport` / `ReviewIssue` — code review results
- `AgentResult` — session metadata returned to orchestrator
- `WorkerResult` — parallel worker outcome
- `OrchestratorOptions` — all configuration

---

## Layer 4: State Management (files on disk)

### `src/state/features.ts` (~47 lines)

Read/write `features.json`, priority sorting, mark passing.

### `src/state/progress.ts` (~30 lines)

Read/write `claude-progress.txt` (JSON with pass count, current feature, etc.)

### `src/sprint/contracts.ts` (~100 lines)

Manage sprint artifacts:
- `writeSprintContract()` — lock criteria before coder runs
- `writeCurrentFeature()` — single-feature file (saves coder from reading all 200+)
- `writeSprintCompletion()` — coder's claim of what it did
- `readEvalReport()` — evaluator's verdict
- `cleanSprintArtifacts()` — reset between features

### File Protocol Summary

| File | Written By | Read By |
|------|-----------|---------|
| `features.json` | Initializer, Evaluator | Everyone |
| `sprint-contract.json` | Orchestrator | Coder, Evaluator |
| `current-feature.json` | Orchestrator | Coder |
| `sprint-completion.json` | Coder | Evaluator |
| `eval-report.json` | Evaluator | Orchestrator |
| `sprint-context-handoff.json` | Orchestrator | Coder (on reset) |
| `claude-progress.txt` | Orchestrator | Coder |

---

## Layer 5: Observability

### `src/events.ts` (~100 lines)

JSONL event log. Appends structured events to `quest-events.jsonl`. Event types: `run_start`, `feature_start`, `agent_start`, `tool_use`, `tool_progress`, `agent_done`, `context_reset`, `context_warning`, `eval_verdict`, `feature_done`, `dag_built`, `batch_plan`, `feature_unblocked`, `run_complete`.

Supports byte-offset reads for efficient polling by the monitor.

### `src/logger.ts` (~180 lines)

Console output + event emission. `logMessage()` is called for every SDK message from every agent. It:
- Prints colored tool-use lines with summaries
- Tracks turn count per worker
- Emits structured events to the JSONL log
- `printAgentBanner()` prints section headers between agent phases

### `src/trace.ts` (~440 lines)

LLM session recording. `Tracer` creates `TraceSession` objects for each agent invocation. Records every SDK message (assistant content, tool calls with inputs, tool results, token usage) to `.quest/traces/<session-id>.jsonl`. Session index at `.quest/traces/index.jsonl` for fast querying via `quest traces`.

### `src/transcript.ts` (~360 lines)

Similar to trace but per-feature transcript capture.

### `src/cost.ts`

Token-to-USD cost calculator by model.

### `src/failure-classifier.ts`

Classifies failures as timeout, tool_error, logic_bug, external_dep, context_exhaustion, or unknown.

---

## Layer 6: Context Management

### `src/context/manager.ts` (~250 lines)

Token tracking and context reset detection. Tracks cumulative `inputTokens`, `outputTokens`, `peakContextTokens` per session. When `peakContextTokens` exceeds the threshold (dynamic based on feature complexity), signals a reset. On reset:
1. Orchestrator writes `sprint-context-handoff.json` with completed steps, remaining criteria, recent git commits, diff stats
2. Fresh coder session reads the handoff and continues where the previous one left off

---

## Layer 7: Planning & Initialization

### `src/planner.ts` (~245 lines)

Interactive planning with Claude. Uses the direct Anthropic SDK (`@anthropic-ai/sdk`, not the agent SDK) for multi-turn conversation. Claude asks one question at a time across 8 dimensions (product, tech stack, auth, workflows, data model, integrations, non-functional, out-of-scope). Outputs a structured JSON plan that feeds into the initializer as enriched context.

### `src/scaffold.ts` (~222 lines)

Quick scaffold without an AI agent. Generates 15 template features (CRUD patterns) for `quest init` without `--plan`. Fast but generic.

---

## Layer 8: TUI Monitor

### `src/tui/App.tsx` (~292 lines)

React/Ink terminal dashboard. Polls `quest-events.jsonl` every 500ms. Shows: header with pass/total, progress bar, feature list with verdict icons, active panel with current agent/tool/turn, scrollable history.

### `src/tui/state.ts` (~226 lines)

Event replay reducer. Rebuilds full UI state from the event stream. Each event type maps to a state transition (feature started, agent changed, tool used, verdict received, etc.)

### `src/tui/monitor.ts` (~7 lines)

Ink renderer entry point.

---

## Data Flow Example

What happens when you run `quest` on a project with 3 pending features (A, B, C) where C depends on A:

```
1. cli.ts: detect.ts returns { status: 'pending', passing: 2, total: 5 }
2. cli.ts: creates Orchestrator({ maxConcurrency: 4 })
3. orchestrator.run():
   - maxConcurrency > 1, so calls runDAGScheduled()

4. scheduler.buildDAG(features):
   - 3 pending features, feature-C dependsOn [feature-A]
   - Level 0: [A, B], Level 1: [C]
   - Critical path: A -> C
   - maxParallelism: 2

5. planNextBatch(): A and B are ready (level 0, no deps)
   - Dispatches 2 workers

6. WorkerPool.acquire() x 2: creates 2 git worktrees

7. Worker 1: runFeatureInWorktree(A)
   - writeSprintContract -> runCoderAgent -> runEvaluatorAgent
   - eval-report: pass -> git commit in worktree

8. Worker 2: runFeatureInWorktree(B)
   - same flow, maybe fails

9. Promise.race() -> Worker 1 finishes first
   - cherryPickToMain(A's commit) -> success
   - getNewlyUnblocked(A) -> returns [C]

10. planNextBatch(): C is now ready
    - Dispatches C to available worker

11. Promise.race() -> Worker 2 finishes (B failed)
    - Mark B as failed

12. Promise.race() -> Worker for C finishes
    - cherryPickToMain(C's commit)

13. No more features -> cleanup worktrees
14. Summary: 4/5 features passing
```
