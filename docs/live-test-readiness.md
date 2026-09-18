# Live Test Readiness

Status checked: September 16, 2026

This document describes Fern's software-delivery product: a governed system for turning approved objectives into verified releases through Qwen Code and `qwen3.8-max`.

## Bottom line

The repository now has the complete architecture for a repository-aware objective program, verified staging, continuous maintenance, and controlled controller evolution. It has **not** yet completed the measured Festival SOS run, seven-day observation, or N to N+1 promotion and rollback proof.

The honest status is:

- **Architecture:** implemented for a controlled Festival SOS live run, but the generated program must pass review and approval first.
- **Current machine:** immutable installation, Festival registration, credentials, dependencies, and browser runtime are verified. The worker service is intentionally not started before program approval.
- **Provider:** Qwen Code `0.23.3` is active. Token Plan Personal and Team are supported through their dedicated key and endpoint configuration.
- **Release proof:** deterministic tests cover the new program, staging, feedback, recovery, and controller-release boundaries; the real observation periods remain required before stable `v1.0.0` or a proven self-evolving claim.

A normal user provides one objective file, runs guided setup, reviews the repository assessment and proposed program, and approves it. The harness handles bounded execution, reassessment, staging verification, repairs, and in-scope maintenance after that.

The initial operator interface is `fern-harness interactive [PROJECT]` (or no arguments in an interactive terminal). It covers project setup and existing GitHub sign-in, provider/credential connection, explicit live verification, current revision review and typed approval, initial redrafting, readiness, evidence/logs/controller history, and separately confirmed execution startup/recovery. Commands provide elapsed-time activity animation and streamed feedback; the read-only live monitor refreshes durable work and separately checks worker service liveness on macOS/Linux. Broader interaction design and dedicated approval notifications remain for a later review. Neither a running service nor task counts prove objective delivery.

Live planning exposed coverage omissions and unsupported completion claims. The controller now derives fixed coverage actions, downgrades source-only claims to unverified, checks the mandatory action matrix, and permits at most two synthesis corrections. Passing this structural validation does not replace review of behavior coverage, dependency timing, and authority before approval.

## What a 16-day run actually is

It is not one enormous model conversation. It is a durable supervisor repeatedly starting bounded Qwen sessions and connecting them through persisted state:

```text
PROJECT.md + exact clean repository commit
   ↓
parallel read-only assessment + evidence-backed coverage
   ↓
draft program + dependency-ordered waves
   ↓
human reviews and approves the plan once
   ↓
claim next unblocked story with an expiring lease
   ↓
create/reuse isolated worktree + resume saved Qwen session/Goal
   ↓
implement within wall-time, tool, turn, agent, and token budgets
   ↓
test exact candidate commit + calculate reward scorecard
   ├─ PASS  → push exact SHA → PR → CI → merge → post-merge test → done
   ├─ FAIL  → persist verifier feedback → retry the same story/session
   └─ CRASH → service restarts → lease expires → recover durable state
                                                   ↓
                                      repair or next assessment
   ↓
immutable staging deploy → reported revision + lifecycle checks
   ↓
objective acceptance audit → next revised wave or delivered
   ↓
maintenance signals → relevant work or wait
```

The default implementation window is one hour, with 200 tool calls and 80 session turns. Reaching a budget is not treated as a failed attempt: the story returns to `ready`, keeps its Qwen session ID and worktree, and continues in a later bounded run.

## How each stage is implemented

| Stage | Current implementation |
| --- | --- |
| Requirements to stories | The portfolio planner turns one in-repository requirements file into a bounded acyclic story graph. The coordinator persists the plan and requires explicit approval before work becomes executable. |
| Repository assessment | Product, architecture, verification, and operations assessments run read-only against an exact clean commit. A synthesis maps each objective requirement to a status and validates referenced files against the snapshot. |
| Program reassessment | Only the current dependency wave executes. After it finishes, staging and repository evidence drive an objective audit and a persisted revision of unstarted work. Material changes stop for approval. |
| Claim story | A transactional SQLite `BEGIN IMMEDIATE` claim selects only `ready` stories whose dependencies are `done`, then assigns an expiring lease. |
| Resume Qwen | Each task persists its Qwen session ID. The next bounded run passes `--resume`; unfinished work uses `/goal resume`. Verifier feedback creates a repaired Goal inside the resumed session so prior context is retained. |
| Bounded implementation | Qwen runs in an isolated Git worktree with sandboxing, protected paths, a saved workflow, one mutating implementer, bounded read-only agents, and hard time/tool/turn/token limits. |
| Heartbeat | While Qwen or PR reconciliation is active, the supervisor extends the lease. This distinguishes active work from a dead worker. |
| Test and reward | Required project gates run against a detached worktree at the exact candidate commit. The reward engine then applies execution, acceptance-rubric, independent-review, and optional visual criteria. |
| Pass | Only the tested SHA is pushed. The supervisor verifies the remote head, creates a PR, waits for required GitHub checks, optionally merges, and retests the actual merge commit. |
| Fail | The error and a fingerprint are stored. The task returns to `ready`, and the next run receives the failure as repair feedback. Five total attempts and three identical failures are the defaults; repeated failures stop in `failed` or `quarantined`. |
| Crash | `launchd` or `systemd` restarts the worker. An expired implementation lease is routed back through recovery; PR/CI leases are cleared and reconciled from GitHub. The owned branch/worktree and saved Qwen session are reused. |
| Next story | A dependent story cannot be claimed until its prerequisite task reaches `done` after post-merge verification. |
| Staging | The deployment controller checks out the intended merge commit, targets explicit existing Railway identifiers or a configured command, polls one deployment to terminal state, verifies the served revision, and runs lifecycle gates. |
| Maintenance | GitHub, CI, staging, metrics, and allowlisted-source findings are provenance-preserving and deduplicated. Accepted in-scope signals can trigger reassessment; an empty backlog waits. |
| Harness successor | A credential-free immutable candidate must pass fixed evaluations and Node/Python/Go/Rust canaries. A protected launcher promotes only at idle and can restore the baseline during probation. |

Primary code paths: [supervisor](src/supervisor.ts), [persistent store](src/core/persistent-store.ts), [Qwen executor](src/qwen/qwen-code-executor.ts), [Git worktrees](src/git/git-workspace.ts), [reward engine](src/rewards/engine.ts), [worker daemon](src/daemon.ts), and [service installer](src/installer/service.ts).

### Checkpoint nuance

The harness writes checkpoint snapshots, but recovery does not currently load the latest checkpoint record as an executable snapshot. Its canonical recovery inputs are the SQLite task row, saved Qwen session/workflow IDs, owned Git worktree/branch, and GitHub PR state. The checkpoint table is presently an audit trail.

Therefore, the precise crash branch is:

```text
CRASH → restart worker → expire/recover lease → reuse persisted task + session + worktree
```

That provides practical continuation. A literal `load checkpoint and restore phase` mechanism would be additional hardening, not something the current code should claim.

## What the reward system does

The reward system is the runtime quality gate for delivered work.

For every candidate commit it combines:

1. **Execution evidence:** build, lint, typecheck, unit, integration, E2E, lifecycle, security, or other project commands. A required failure is a hard veto.
2. **Acceptance review:** Qwen scores whether the exact issue criteria are satisfied.
3. **Independent agent review:** a separate read-only review looks for unresolved high-severity defects.
4. **Optional visual review:** rendered screenshots or other configured visual artifacts can be scored.

Every criterion has a threshold and weight. All hard criteria, all critical criteria, and the aggregate threshold must pass. The resulting scorecard is tied to the task and commit SHA and is published as `Fern Delivery Harness / reward`.

The reward system supports a long run by producing a consistent decision at every boundary:

- good work advances;
- bad work cannot be merged;
- the reason for failure becomes the next repair prompt;
- repeated identical failures stop instead of burning time indefinitely;
- scorecards remain durable across worker restarts.

It does **not** keep the worker alive. Long-run continuity comes from the service, leases, SQLite state, worktrees, Qwen session resumption, and GitHub reconciliation.

## Readiness assessment

| Capability | Status | Evidence or gap |
| --- | --- | --- |
| Multi-story requirements intake | Ready | Durable plan, dependency validation, idempotent requirements hash, and explicit approval are implemented. |
| Evidence-backed objective program | Ready for live proof | Exact repository assessment, objective coverage, frozen decisions, waves, revisions, and acceptance audit are implemented and deterministically tested. |
| Staging and repair loop | Ready for Railway live proof | Exact-revision deployment, terminal-status polling, health revision verification, lifecycle gates, durable reconciliation, and repair deduplication are implemented. |
| Continuous maintenance signals | Ready for live proof | Provenance, relevance classification, deduplication, material approval, and idle polling are implemented. |
| Controlled self-evolution | Implemented, intentionally locked | Evaluation, four-stack canaries, promotion, protected launcher handoff, probation, and rollback exist; enabling requires Festival SOS delivery plus its observation period. |
| Bounded Qwen continuation | Ready | Session IDs, `/goal resume`, hard budgets, and no-attempt continuation on budget exit are implemented. |
| Durable dispatch and lease recovery | Ready with caveat | SQLite/WAL, atomic claims, heartbeats, retries, and quarantine are implemented. Checkpoints are written but not read for restoration. |
| Exact-commit testing and rewards | Ready | Gates and reward review run before push against a detached worktree at the candidate SHA. |
| PR, CI, merge, and post-merge loop | Ready, default-on | Exact-head checks and post-merge verification exist. New projects default `autoMerge` to `true`; projects can opt out and pause at `merge_ready`. |
| Dependency and browser preflight | Ready | Setup/bootstrap and doctor check package managers, dependencies, configured gate executables, and declared Playwright/Cypress runtimes. |
| Persistent worker | Implemented, not installed here | macOS uses `RunAtLoad` plus `KeepAlive`; Linux uses `Restart=always`. This Mac currently has no worker service. |
| Current Qwen executable | Ready | `PATH` resolves Qwen Code version `0.23.3`. |
| Current harness installation | Ready via immutable CLI | The immutable absolute CLI and extension are installed. `fern-harness` is not on `PATH`; this is a convenience warning, not an execution blocker. |
| Registered target | Verified | Festival SOS is registered and clean at the recorded starting revision. Its generated program remains review-only until approved. |
| Configured model credential | Verified for planning | The Token Plan route and credential pass doctor, and live Qwen3.8-Max repository assessment/program synthesis has completed without copying the secret into tracked configuration. |
| Always-on host | Not established | A sleeping or powered-off Mac does not execute work. A 16-day run needs an always-on host and network. |
| Health alerting | Missing | Status and logs exist, but there is no proactive alert when the worker stops, a credential expires, disk fills, or a task is quarantined. |
| State backup and log retention | Missing | SQLite and JSONL state are durable on one disk, but there is no scheduled backup, integrity check, or log rotation/retention policy. |
| Live end-to-end proof | Not complete | The RC has deterministic and mocked production coverage, but no completed live issue-to-merge run or multi-day soak. |

## What must be done before calling it a 16-day runner

These are the minimum blockers, not optional polish:

1. Choose a real demo repository and place a small `PROJECT.md` in it.
2. Configure the selected Qwen billing route with its matching credential and endpoint.
3. Run guided setup against that target, install/link the CLI, register the project, and install the worker service.
4. Make every `doctor --live` and `verify` check pass, including one real Qwen3.8-Max call.
5. Keep the default `autoMerge` setting enabled if no human will merge PRs, and configure the required branch-protection checks.
6. Run on an always-on machine. On macOS, the LaunchAgent also assumes the user session is available; sleep still pauses execution.
7. Add at least a simple external heartbeat alert plus daily SQLite backup/integrity check and log rotation before trusting a 16-day unattended period.
8. Prove it progressively: repository assessment, one wave, forced staging failure and repair, restart/resume and duplicate-effect recovery, objective audit, seven-day observation, then controller promotion and rollback.

## Designated proof project

Festival SOS is the first measured project. Before starting, its existing repository must be clean, pushed, repeatably installable, and connected to an existing staging environment with a revision health endpoint. Its objective must cover the complete festival runner-network vision, while production sales and payouts remain outside staging authority.

The target needs:

- a lockfile and repeatable dependency install;
- at least `build` and `test` commands;
- the complete approved objective and observable definition of done;
- reviewable outcomes with dependencies proposed from repository evidence;
- one browser E2E path if browser/visual work is part of the intended use case.

A simple dependency chain is enough:

```text
Story 1: data/API behavior + tests
   ↓
Story 2: user-facing flow using Story 1
   ↓
Story 3: browser E2E + final documentation
```

The minimum `PROJECT.md` needs only:

```markdown
# Product objective
What should exist when the project is finished?

## User and use case
Who uses it, and what are they trying to accomplish?

## MVP scope
What must be included?

## Constraints
What must not change, and what technology or safety rules apply?

## Definition of done
What observable behavior and commands prove completion?
```

The planner can create the stories. A hand-written story list is optional.

## Simple operating path

From this harness checkout:

```sh
npm run bootstrap -- /absolute/path/to/demo-project
node bin/qwen-harness.mjs doctor /absolute/path/to/demo-project --live
node bin/qwen-harness.mjs verify /absolute/path/to/demo-project
node bin/qwen-harness.mjs plan /absolute/path/to/demo-project --requirements PROJECT.md
```

Review the generated GitHub epic and stories, then approve once:

```sh
node bin/qwen-harness.mjs plan-redraft /absolute/path/to/demo-project --plan PLAN_ID --requirements PROJECT.md
node bin/qwen-harness.mjs plan-approve /absolute/path/to/demo-project --plan PLAN_ID
node bin/qwen-harness.mjs plan-status /absolute/path/to/demo-project --plan PLAN_ID
node bin/qwen-harness.mjs status /absolute/path/to/demo-project
node bin/qwen-harness.mjs logs /absolute/path/to/demo-project --lines 100
```

Once setup has linked `fern-harness`, the shorter commands work without `node bin/qwen-harness.mjs`.

## Definition of a successful autonomous proof

Do not measure success only by commit count. A credible run should show:

- bounded Qwen sessions continued without losing task context;
- at least one service restart recovered safely;
- dependency ordering was never violated;
- no duplicate tasks, branches, PRs, merges, or repair issues;
- every merged SHA had passing deterministic gates and a durable reward scorecard;
- the actual merge commit passed post-merge verification;
- failed work was repaired or quarantined within policy;
- state survived worker restarts and was backed up;
- worker uptime and stalled/quarantined tasks were externally visible;
- no protected harness files or unrelated target work were modified.
- staging failure created or resumed one repair and the repaired merge was reverified successfully;
- the objective audit, rather than issue count, determined delivery;
- the seven-day observation recorded waiting separately from useful work;
- controller N promoted a validated N+1 and rollback restored N without unreadable state.

## Runtime documentation

- [Official Qwen Code headless mode, Goal resumption, and budgets](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/)
- [Official QwenCloud Token Plan quick start](https://docs.qwencloud.com/token-plan/personal/token-plan-personal-quickstart)
- [Repository README](README.md)
