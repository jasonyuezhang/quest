# Harness Design Implementation Guide

Distilled from two Anthropic engineering articles into actionable patterns for the Quest harness.

**Sources:**
- "Effective Harnesses for Long-Running Agents" (Justin Young)
- "Harness Design for Long-Running Application Development" (Prithvi Rajasekaran)

---

## 1. Core Architecture: Three-Agent System

The harness uses three specialized agents, each addressing a specific failure mode:

| Agent | Role | Failure Mode Addressed |
|-------|------|----------------------|
| **Planner/Initializer** | Expands a short prompt into a full product spec with 200+ features | Agents under-scope when given raw prompts |
| **Generator/Coder** | Implements one feature per session, commits to git | Agents attempt too much at once, leave half-finished code |
| **Evaluator** | Tests the running app via Playwright, grades against criteria | Agents self-evaluate leniently, mark broken features as passing |

### Why Three Agents (Not One)

> "Separating the agent doing the work from the agent judging it proves to be a strong lever."

Self-evaluation bias: when asked to evaluate their own work, agents consistently praise it — even when quality is obviously mediocre. Tuning a standalone evaluator to be skeptical is far more tractable than making a generator critical of its own work.

---

## 2. Initializer Agent

### Responsibilities

On first run, the initializer creates:

1. **`init.sh`** — Script to start the dev server. Every subsequent agent session runs this first.
2. **`features.json`** — Comprehensive feature list (200+ features), each with structured acceptance criteria. All start as `passes: false`.
3. **`claude-progress.txt`** — State file tracking which features are done, current feature, last commit.
4. **Initial git commit** — Clean baseline showing all scaffolded files.

### Feature Structure

```json
{
  "id": "user-auth-login",
  "name": "User Login",
  "description": "User can log in with email and password",
  "category": "auth",
  "priority": "high",
  "acceptanceCriteria": [
    "Navigate to /login",
    "Submit valid credentials",
    "Verify redirect to dashboard",
    "Verify session token is set"
  ],
  "passes": false
}
```

### Key Design Decisions

- **JSON over Markdown**: Models less frequently modify JSON files inappropriately. Strong instructions prevent removal: *"It is unacceptable to remove or edit tests."*
- **Coding agents edit only the `passes` field.** The evaluator is the sole authority for setting `passes: true`.
- **Planner should specify deliverables, not implementation details.** If the planner gets granular details wrong, errors cascade into the downstream implementation. Constrain on *what* to build, let agents figure out *how*.

---

## 3. Coder (Generator) Agent

### Session Startup Protocol

Every coder session follows this exact sequence:

```
1. pwd                           — Confirm working directory
2. git log --oneline -5          — Understand recent work
3. Read claude-progress.txt      — Load current state
4. Read current-feature.json     — Single feature to implement
5. Read sprint-contract.json     — Acceptance criteria (source of truth)
6. bash init.sh                  — Start dev server
7. Run existing tests            — Establish baseline before changes
```

This conserves tokens by eliminating setup guesswork. The agent knows immediately what to do.

### Implementation Rules

- **One feature at a time.** This critically addresses agents' tendency to attempt too much simultaneously.
- **Smallest change that satisfies all criteria.** No gold-plating.
- **Commit after each feature.** Leave a clean, mergeable code state.
- **Do NOT set `passes: true`.** That is the evaluator's exclusive job.
- **Do NOT modify `features.json` or `claude-progress.txt`.** The orchestrator manages those.

### Sprint Contract

Before the coder runs, the orchestrator writes a `sprint-contract.json` locking the acceptance criteria. Both the coder and evaluator read the same contract — criteria are locked before implementation begins.

This prevents:
- Scope creep (coder adds unrequested features)
- Self-evaluation bias (coder can't redefine "done")
- Mismatch between what was built and what gets tested

```json
{
  "featureId": "user-auth-login",
  "featureName": "User Login",
  "description": "User can log in with email and password",
  "acceptanceCriteria": [
    "Navigate to /login, submit valid credentials, verify redirect to dashboard",
    "Submit invalid credentials, verify error message shown",
    "Verify session token is set in cookies after login"
  ],
  "startedAt": "2026-03-25T19:00:00Z"
}
```

### When Done

1. Run all existing tests — they must pass
2. `git add -A && git commit -m "feat: implement <feature-name>"`
3. Write `sprint-completion.json` with commit SHA and notes
4. Stop. Do not run the evaluator. Do not set `passes: true`.

---

## 4. Evaluator Agent

### Design Principles

- **Independent**: Never reads the coder's source code, only tests observable behavior
- **Browser-capable**: Uses Playwright MCP to interact with live pages
- **Conservative**: False negatives acceptable, false positives are not
- **Sole authority**: Only the evaluator may set `passes: true`

### Evaluation Protocol

For each acceptance criterion in the sprint contract:

1. Design a test that would **fail** if the criterion is NOT met
2. Execute the test (curl for APIs, Playwright for UI)
3. Record the result with **concrete evidence** — quote what you actually saw

```json
{
  "featureId": "user-auth-login",
  "verdict": "fail",
  "criteriaResults": [
    {
      "criterion": "Submit valid credentials, verify redirect to dashboard",
      "result": "pass",
      "evidence": "Response: 302 redirect to /dashboard, session cookie set"
    },
    {
      "criterion": "Submit invalid credentials, verify error message",
      "result": "fail",
      "evidence": "Expected error message, got blank page with 500 status"
    }
  ]
}
```

### Calibrating the Evaluator

Out of the box, Claude is a poor QA agent. In early runs:
- It identified legitimate issues, then talked itself into deciding they weren't a big deal
- It tested superficially, not probing edge cases
- Subtle bugs slipped through

Tuning loop: read the evaluator's logs, find examples where its judgment diverged from yours, update the QA prompt to solve for those issues. Several rounds of this before the evaluator grades reasonably.

### Grading Criteria (for subjective quality)

When evaluating design/UX quality, use four criteria:

| Criterion | What It Tests | Weight |
|-----------|---------------|--------|
| **Design quality** | Coherent aesthetic identity across visual elements | High |
| **Originality** | Custom decisions vs template defaults and AI slop | High |
| **Craft** | Typography hierarchy, spacing, color harmony | Normal |
| **Functionality** | Can users find actions and complete tasks | Normal |

Weight design quality and originality higher — Claude already scores well on craft and functionality by default.

---

## 5. Context Management

### The Problem

Two failure modes degrade agent performance on lengthy tasks:

1. **Context window filling**: Models lose coherence as context grows
2. **Context anxiety**: Models prematurely wrap up work as they approach what they believe is their context limit

### Context Resets vs. Compaction

| Approach | How It Works | Tradeoff |
|----------|-------------|----------|
| **Compaction** | Summarize earlier conversation in place | Preserves continuity but context anxiety persists |
| **Context reset** | Clear window entirely, start fresh agent with handoff artifact | Clean slate eliminates anxiety, but requires enough state in handoff for next agent to resume |

Context resets were essential for Sonnet 4.5 (exhibited strong context anxiety). Opus 4.5/4.6 largely removed this behavior, enabling continuous sessions with compaction only.

### Context Handoff Structure

When a context reset is needed, the orchestrator writes:

```json
{
  "featureId": "user-auth-login",
  "completedSteps": ["Created login form component", "Added API endpoint"],
  "remainingCriteria": ["Verify redirect to dashboard", "Add error handling"],
  "recentCommits": "abc123 feat: add login form\ndef456 feat: add auth endpoint",
  "diffStat": "5 files changed, 234 insertions(+), 12 deletions(-)",
  "resetCount": 1
}
```

The fresh agent reads this + `current-feature.json` + `sprint-contract.json` to resume without re-reading the entire codebase.

---

## 6. Orchestrator Control Loop

```
initialize()
  └─ planner expands prompt → features.json (200+ features)

run()
  └─ while (pending features remain):
       1. Pick next feature by priority
       2. Write sprint-contract.json (lock criteria)
       3. Run coder agent
          └─ On context limit → write handoff, reset, continue
       4. Run evaluator agent
          └─ verdict: pass → commit, mark passes:true
          └─ verdict: fail → retry (up to retryLimit)
       5. Update progress
```

### Key Invariants

- Sprint contract is written BEFORE coder runs — criteria are locked
- Evaluator reads the SAME contract the coder read — no drift
- Only the evaluator sets `passes: true` — never the coder
- Progress file is updated by the orchestrator — never by agents
- Each feature gets a clean sprint artifact set — no contamination between features

---

## 7. When to Use Each Component

Not every component is load-bearing for every task. The article emphasizes:

> "Every component in a harness encodes an assumption about what the model can't do on its own, and those assumptions are worth stress testing."

### Decision Matrix

| Component | Use When | Skip When |
|-----------|----------|-----------|
| **Planner** | Task needs scope expansion (1-sentence → full spec) | User provides detailed spec |
| **Sprint contracts** | Model struggles with scope creep | Model (e.g., Opus 4.6) handles scope natively |
| **Context resets** | Model exhibits context anxiety (Sonnet 4.5) | Model handles long context well (Opus 4.6) |
| **Evaluator** | Task is at the edge of model capability | Task is within model's reliable baseline |
| **Playwright testing** | App has UI that needs E2E verification | CLI/API-only apps |
| **Feature decomposition** | Complex app with 10+ features | Simple single-feature task |

### Cost Awareness

| Harness Config | Example Duration | Example Cost |
|----------------|-----------------|-------------|
| Solo (no harness) | 20 min | $9 |
| Full harness (3 agents, sprints) | 6 hr | $200 |
| Simplified harness (no sprints, single-pass eval) | 3 hr 50 min | $125 |

The evaluator is worth the cost **when the task sits beyond what the current model does reliably solo.**

---

## 8. Common Failure Modes and Solutions

| Problem | Cause | Solution |
|---------|-------|----------|
| Agent declares victory prematurely | No structured feature list | Initializer creates 200+ features, all `passes: false` |
| Agent leaves buggy undocumented code | No progress tracking | Git commits + `claude-progress.txt` after each feature |
| Agent marks features complete prematurely | Self-evaluation bias | Separate evaluator agent is sole `passes: true` authority |
| Agent wastes tokens figuring out how to run app | No startup script | `init.sh` written by initializer, read by every session |
| Agent attempts too much at once | No decomposition | One feature per session, sprint contract locks scope |
| Agent talks itself out of bug reports | QA leniency | Calibrate evaluator with few-shot examples, penalize false positives |
| Agent produces generic "AI slop" designs | No design criteria | Explicit grading criteria weighted toward originality |
| Context anxiety causes premature wrap-up | Context window pressure | Context resets with structured handoff artifacts |

---

## 9. File Protocol Summary

All inter-agent communication is through files on disk. Agents are stateless.

| File | Written By | Read By | Purpose |
|------|-----------|---------|---------|
| `features.json` | Initializer (creates), Evaluator (sets `passes`) | Coder, Evaluator, Orchestrator | Feature definitions and pass/fail state |
| `sprint-contract.json` | Orchestrator | Coder, Evaluator | Locked acceptance criteria for current feature |
| `current-feature.json` | Orchestrator | Coder | Single feature definition (saves coder from reading all 200+) |
| `sprint-completion.json` | Coder | Evaluator | What the coder claims to have done |
| `eval-report.json` | Evaluator | Orchestrator | Verdict + per-criterion evidence |
| `sprint-context-handoff.json` | Orchestrator | Coder (on reset) | State for resuming after context reset |
| `claude-progress.txt` | Orchestrator | Coder | Current state: which features passed, what's in progress |
| `init.sh` | Initializer | Coder, Evaluator | Dev server startup script |

---

## 10. Evolution Principle

> "The space of interesting harness combinations doesn't shrink as models improve. Instead, it moves."

When a new model lands, re-examine the harness:
1. **Remove** components that are no longer load-bearing (e.g., sprint contracts with Opus 4.6)
2. **Add** components that enable new capabilities (e.g., agent-driven features within apps)
3. **Test** each component individually — remove one at a time and review impact
4. **Avoid** radical simplification in one step — methodical removal reveals which pieces are actually load-bearing
