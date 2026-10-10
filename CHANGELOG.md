# Changelog

All notable changes to this project are documented here.

## [Unreleased]

## [1.0.0-rc.65] - 2026-10-09

- Treat an observed Qwen provider quota pause as a resumable wait when the process exits 1; other unexpected exits remain failures.
- Preserve the Qwen session across provider waits by keeping the wait reason in durable events instead of repair feedback.
- Add regression coverage for quota exits, unsafe lookalikes, and provider wait resumption.

## [1.0.0-rc.64] - 2026-10-09

- Preserve the exact unconsumed candidate link when an orderly shutdown interrupts recovery itself, then rerun authorization and verification on restart without repeating implementation.
- Discard inherited links after known stale evidence, rejected authorization, lost ownership, or consumption. Keep invocation markers separate and reject already-consumed evidence.
- Test second-shutdown recovery and concurrent shutdown with dirty files or an untrusted issue author.

## [1.0.0-rc.63] - 2026-10-09

- Resume an unchanged candidate after an orderly verification interruption without repeating implementation. Reauthorize the issue and program, validate the exact candidate and lease, consume recovery evidence once, and rerun required gates and independent review.
- Stop execution safely when lease ownership is lost instead of allowing heartbeat exceptions to escape the worker.
- Use the same approved story for staging preparation and read-only completion. Reject ambiguous authorization rather than selecting the first matching plan.
- Preserve failure budgets and fall back to normal implementation when authorized candidate evidence is stale. Interrupted recovery before candidate consumption may still repeat model work; it cannot reuse a passing result.

## [1.0.0-rc.62] - 2026-10-09

- Honor `update --dry-run` so an update preview cannot install files, relink the CLI, change registration, or restart the worker.
- Add isolated CLI regressions for dry-run and ordinary update argument forwarding.

## [1.0.0-rc.61] - 2026-10-09

- Retain post-merge gate results, exact merge commits, execution timing, and evidence hashes in durable events and program evidence exports without storing raw command output.
- Retry verification in place when evidence persistence fails after a merge. Preserve failure budgets and avoid re-running implementation or opening another PR for an already-merged task.
- Cover interrupted verification, evidence-write recovery, distinct attempts, program scoping, and legacy tasks without invented historical records.

## [1.0.0-rc.60] - 2026-10-09

- Tell repository assessments to cite supplied exact-commit execution evidence alongside requirement-specific source or tests. Do not treat global passing CI as proof of every requirement.
- Distinguish a missing execution citation from a missing execution result in coverage diagnostics. Preserve the existing fail-closed validator and rejection of stale commit evidence.
- Add regressions for citation instructions, uncited passing gates, matching gate citations, and stale execution evidence.

## [1.0.0-rc.59] - 2026-10-09

- Run receipt-producing checks from the installed controller package so unfinished worktrees can retain their original protected harness scripts and task base.
- Pass the trusted runner command through the saved workflow to its sole implementation writer; keep coordinator and reviewer execution read-only and preserve independent supervisor verification.
- Reject missing, nonregular, or symlinked runner assets and safely quote runtime paths. Verify legacy worktree checks leave tracked controls and the candidate commit unchanged.

## [1.0.0-rc.58] - 2026-10-09

- Persist session-bound automatic-stop provenance from actual process limits. Start a fresh local Goal after confirmed automatic limits so synthetic cancellation text cannot masquerade as a new human instruction.
- Preserve the candidate worktree, approved contract, failure history, and bounded continuation limits. Keep ordinary provider waits resumable; explicit user stops and external aborts do not grant automatic continuation.
- Clear consumed stop markers and stale workflow identifiers when a new session is recorded. Cover restart persistence, mismatched provenance, provider waits, and cancellation precedence with regression tests.

## [1.0.0-rc.57] - 2026-10-09

### Fixed

- Save machine-generated gate execution receipts so local completion review can inspect actual checks instead of truncated agent summaries. Receipts record commands, outcomes, timeouts, and candidate fingerprints; required supervisor checks remain independent.
- Replace stale passing receipts before a new run, reject unsafe receipt paths, redact credential arguments, and fail timed-out checks even if their termination handler exits successfully.
- Require the implementation workflow and coordinator to read receipt evidence before handing work back for exact-commit verification. No active sessions are upgraded in place.

## [1.0.0-rc.56] - 2026-10-09

- Record safe planning-stage and validation-attempt progress in the program ledger and worker logs without logging model prompts or responses.
- Forward cancellation through initial and correction planning requests, and refuse to publish cancelled results. Preserve bounded validation retries and JSON command output.

## [1.0.0-rc.55] - 2026-10-09

- Carry approved technology, deployment, and acceptance boundaries into program reassessment. Retain decision identities and avoid asking again for unchanged approved exceptions.
- Preserve the prior approved contract when proposing a material revision. Support audited rejection and restoration without deleting proposals, completed work, or revision history.

## [1.0.0-rc.54] - 2026-10-08

- Stop sending a resolved writer-guard installation failure to the product agent as verifier feedback. Recheck the guard before filtering that exact error; preserve failed-session isolation, retry history, and all genuine verification failures.

## [1.0.0-rc.53] - 2026-10-07

- Keep program-enabled projects idle until initial program approval, including automatic CI repairs and previously normalized work. An empty project's expected failing baseline cannot start product implementation through the repair path.
- Give repository assessment one bounded model correction for invalid evidence or output shape without relaxing validation; distinguish saved specification references and approval prerequisites from repository files and product features.

## [1.0.0-rc.52] - 2026-10-07

- Block new program approval when required product checks are absent; empty, optional-only and security-only checks cannot authorize delivery. Preserve existing active/completed program idempotence.
- Report missing product checks in readiness, while allowing a new repository to generate a proposed program before its first implementation.

## [1.0.0-rc.51] - 2026-10-07

- Confirm numbered menu choices with Enter so a trailing Enter cannot accidentally select the next screen's default action; reject invalid numbers without activating a previous selection.
- Add visible 0/Enter Back controls to document and idea input, and default spec intake to saved-draft review when one exists.

## [1.0.0-rc.50] - 2026-10-07

- Repair PDF citations by having the model select exact source excerpts, preserving split words and hyphens without rewriting product requirements or accepting fabricated quotes.
- Use schema-guided JSON object output for intake and reject punctuation placeholders and repeated criteria before saving a proposed specification.

## [1.0.0-rc.49] - 2026-10-07

- Let the harness draft a private, source-grounded product specification from an idea or PDF before Git/GitHub setup; keep assumptions, acceptance criteria and unproven claims explicit.
- Add numbered spec drafting/review and direct saved-spec planning, without manual requirements-file preparation or implicit execution approval.
- Repair rejected source citations without rewriting product requirements; retain bounded retries, exact source validation and private atomic draft storage.
- Include observed manual product work and explicit retry authorizations in evidence exports, scoped to the selected program and its task lineage.

## [1.0.0-rc.48] - 2026-10-07

- Let empty-diff acceptance reviews inspect existing source and tests in the exact candidate checkout, without weakening required evidence or independent review.
- Start verifier-repair conversations fresh so synthetic cancellation messages from an earlier runtime abort cannot masquerade as new user instructions; retain saved sessions for ordinary continuation.
- Preserve custom review credentials, task contracts, worktrees, retry ceilings, and failure history.
- Supply bounded redacted check output and frozen constraints to reviewers, and disable implicit project instructions in repository reviews.
- Pin the configured model, endpoint and credential variable together in private invocation settings so duplicate model names cannot select another provider route; leave persistent settings unchanged.

## [1.0.0-rc.47] - 2026-10-06

- Add explicit, recorded recovery authorization for exhausted tasks without resetting failure history or weakening checks.
- Cap each authorization at three additional attempts, preserve the shared lineage ceiling across replacements and restarts, and prevent duplicate authorization from granting more attempts.
- Keep repeated-failure quarantine and merged-task safeguards in force.

## [1.0.0-rc.46] - 2026-10-05

- Separate the local Qwen implementation handoff from controller-owned PR delivery so an absent PR cannot deadlock the session that must return before publication.
- Keep acceptance criteria, workflow review, required checks, failure classification and supervisor delivery verification mandatory.

## [1.0.0-rc.45] - 2026-10-05

- Read independent-review verdicts from streamed terminal events so a large CLI transcript is not parsed as one exit-time pipe write.
- Reject missing, truncated, duplicate or invalid verdicts without accepting partial evidence or logging raw review content.
- Preserve Unicode characters across process-output chunks and validate review score ranges and finding types.

## [1.0.0-rc.44] - 2026-10-05

- Enforce one shared retry budget across replacement and repair tasks, including after restart.
- Preserve approved requirement identities during reassessment and attach repairs to their actual failure lineage.
- Stop automatic replacement proposals when recovery is exhausted or cannot be linked safely; retain the evidence for review.

## [1.0.0-rc.43] - 2026-10-05

- Clarify that the parent session coordinates the saved workflow rather than running shell commands or editing directly.
- Distinguish interrupted workflow continuation from a fresh verifier-driven repair so completed results are not reused as new work.

## [1.0.0-rc.42] - 2026-10-05

- Register implementation tools for saved Qwen workflows in headless mode, with a scoped writer hook and explicit read-only helper tool restrictions.
- Constrain generated coverage identifiers before assessment validation instead of failing on overlong model output.
- Wait for confirmed macOS service unload before replacing the background worker.
- Preserve project configuration formatting when an update makes no semantic change.
- Show the numbered return option in both live-progress and document-reader footers.

## [1.0.0-rc.41] - 2026-10-05

- Replace the post-action text prompt with a numbered dashboard return supporting Escape and Enter.
- Avoid restarting or reinstalling a shared worker that is already running.

## [1.0.0-rc.40] - 2026-10-05

- Give the macOS background worker an explicit command-search path so it can reuse the existing GitHub CLI login and find installed tools.
- Test service path escaping and ensure GitHub credentials are not copied into the service definition.

## [1.0.0-rc.39] - 2026-10-05

- Replace typed confirmation phrases with numbered decisions for approval, setup, connection, credentials, drafting and execution. Cancel is selected by default.
- Number all plan-review and project choices; support multi-digit selection without prematurely opening the first digit.
- Preserve exact plan revision/hash checks, separate execution confirmation, and hidden credential entry.

## [1.0.0-rc.38] - 2026-10-05

- Carry the Fern presentation through prompts, confirmations, errors, command results and live progress.
- Replace the full-plan text dump with a sectioned review workspace and scrollable, read-only plan reader; preserve every acceptance criterion, contract and approval guard.
- Add keyboard scrolling, section jumps, small-window layouts, and bounded recent-result viewing.
- Exercise nested menu paths, cancellation, failure presentation and live-refresh cleanup with simulated side effects.

## [1.0.0-rc.37] - 2026-10-04

- Give spacious terminal windows a small Fern mark, framed project summary, and clearer visual hierarchy.
- Add brief keyboard-selection feedback and redraw only changed rows to avoid full-screen flashes.
- Preserve compact layouts, no-color operation, and reduced-motion preferences; cancel animation timers on exit.

## [1.0.0-rc.36] - 2026-10-04

- Replace the dense terminal home screen with a keyboard-driven dashboard and focused action list.
- Add arrow-key navigation, direct shortcuts, resize-aware menus, and safe cancellation across project, plan, setup, progress, evidence, and execution menus.
- Keep command results visible until dismissed; retain typed approval and execution confirmations, hidden credential input, and a plain-terminal fallback.

## [1.0.0-rc.35] - 2026-09-17

- Prepare controller-owned staging before operations acceptance without circular waits or premature task completion.
- Require completed writer work and exact-commit CI before preparation; retain later required checks and independent review.
- Safely refresh clean read-only branches after new merges, with durable restart recovery and no overwritten candidate changes.
- Count only the current proposal in status totals while preserving superseded history.

## [1.0.0-rc.34] - 2026-09-17

- Let approved verification and operations work finish without fabricated repository changes after exact-commit required checks and independent review pass.
- Reject stale or changed contracts; require controller-owned staging evidence for unchanged operations work, and recover interrupted issue closure without another PR.

## [1.0.0-rc.33] - 2026-09-17

- Keep focused review responses to changed classifications instead of regenerating the full assessment; preserve untouched requirements and evidence.
- Reject unknown/duplicate corrections and unsupported omissions without weakening exact-commit or required-action safeguards.

## [1.0.0-rc.32] - 2026-09-17

- Add focused read-only assessment correction using saved evidence only when project, clean commit, inventory and committed objective still match.
- Keep assessment lineage and objective hashes, and retain existing exact-evidence and implementation-action safeguards.

## [1.0.0-rc.31] - 2026-09-17

- Pass redraft review evidence to repository assessment as well as planning, keeping it outside execution authority.
- Separate unavailable integration access and blocker operating records from missing product behavior without weakening derived implementation requirements.

## [1.0.0-rc.30] - 2026-09-17

- Keep explicitly separate controller proof out of target-product work and classify unavailable access separately from actual code gaps.
- Require complete journey milestones and resumable blocker operating records without adding duplicate product controllers or weakening sandbox evidence.

## [1.0.0-rc.29] - 2026-09-17

- Allow explicitly guarded objective changes only before initial approval; preserve objective snapshots, superseded proposal history and planning intervention evidence.
- Reject changed, stale or already-approved redrafts before provider planning requests, and re-check before persisting their result.
- Separate Festival SOS product journey acceptance from controller recovery, observation and self-evolution validation.

## [1.0.0-rc.28] - 2026-09-16

- Simplify the terminal home screen with plain-language plan status, proposed step/stage counts, separate connection/worker/staging evidence, and a clear next action.
- Add restrained, optional color and responsive grouped menus; preserve every option and wrap long paths in narrow terminals.
- Explain live task states without raw state-machine codes and retain revision-specific approval, execution confirmations, and safe output handling.

## [1.0.0-rc.27] - 2026-09-16

- Make fern-harness the primary terminal command and keep qwen-harness as an alias to the same executable and project state.
- Update operator guidance and verify both command names in installation and package smoke checks; retain existing directories, services, and saved sessions.

## [1.0.0-rc.26] - 2026-09-16

- Complete the terminal's setup and model-connection paths, including existing GitHub sign-in, provider configuration, hidden user-only credentials, and explicitly confirmed live verification.
- Add honest elapsed-time activity animation, safe command output, grouped evidence views, and read-only live progress with separate worker service liveness.
- Keep unconfigured folders in the console, preserve the intended model and approval boundaries, and prevent filenames from becoming approval flags.

## [1.0.0-rc.25] - 2026-09-16

- Add an interactive terminal for project selection, current-program review, revision-specific approval, pre-approval redrafting, readiness, task/deployment/feedback status, and logs.
- Keep worker startup separate from approval and require explicit confirmation before starting the shared background service.
- Exclude superseded proposals from the terminal's current backlog and reject approvals for a revision or objective hash that changed after review.

## [1.0.0-rc.24] - 2026-09-16

- Audit exact merge CI separately from candidate-only governance/reward checks.
- Accept explicit in-repository review evidence during pre-approval redrafting while keeping the objective frozen and feedback outside execution authority.
- Separate product implementation gaps from harness-owned operational proof so target programs do not duplicate the controller or evidence-export machinery.

## [1.0.0-rc.23] - 2026-09-16

- Add a three-attempt planning correction loop that returns the exact validator error and rejected draft to Qwen without repeating the repository assessment; provider waiting errors remain outside this correction loop.

## [1.0.0-rc.22] - 2026-09-16

- Downgrade model claims of implemented behavior to unverified unless the controller has an exact-commit passing test or deployment result.
- Feed successful required checks for the exact candidate commit into each post-wave objective audit as controller-owned test evidence.
- Prevent planning from inventing polling or background work that conflicts with repository sleep, wake, idleness, or cost constraints.

## [1.0.0-rc.21] - 2026-09-16

- Put a compact mandatory coverage/action matrix before planning evidence and omit repository inventory/findings that distract story synthesis; require an explicit final matrix audit in the model contract.

## [1.0.0-rc.20] - 2026-09-16

- Derive the only valid action for implemented, partial, missing, and externally blocked coverage in the controller; retain model judgment only for test-versus-live proof of unverified behavior.

## [1.0.0-rc.19] - 2026-09-16

- Define partial coverage as incomplete product behavior and require implementation work; reserve unverified coverage for complete behavior that lacks proof.

## [1.0.0-rc.18] - 2026-09-16

- Distinguish implementation, verification, operation, documentation, and external coverage actions; reject plans that answer implementation gaps with verification-only work.
- Add safe pre-approval redrafting that supersedes the narrow proposal while retaining its issue and revision history.

## [1.0.0-rc.17] - 2026-09-16

- Add strict provider-backed JSON Schemas for repository analysis, objective coverage, and delivery programs while retaining all local validation.

## [1.0.0-rc.16] - 2026-09-16

- Request provider-backed JSON Object output for direct Qwen planning calls while retaining local schema and evidence validation.

## [1.0.0-rc.15] - 2026-09-16

- Normalize case and surrounding whitespace for the fixed low, medium, and high story-risk vocabulary while rejecting unknown categories.

## [1.0.0-rc.14] - 2026-09-16

- Keep only non-empty text in optional repository-risk notes so null-like model output cannot abort an otherwise valid assessment.

## [1.0.0-rc.13] - 2026-09-16

- Normalize an exact deployment technology decision id to its declared provider value while continuing to reject unknown providers and targets.

## [1.0.0-rc.12] - 2026-09-16

- Ignore blank optional repository-risk notes from model output while preserving strict validation of evidence and non-blank fields.

## [1.0.0-rc.11] - 2026-09-16

- Increased the bounded direct-model request window for real repository planning, reduced the default evidence payload, and continued past binary assets so later source files remain assessable.

## [1.0.0-rc.10] - 2026-09-16

- Recorded private-repository branch-protection plan limits without blocking the independently gated supervisor merge path or claiming that remote protection was configured.

## [1.0.0-rc.9] - 2026-09-16

- Updated readiness detection to recognize the display name emitted by current Qwen Code extension listings.

## [1.0.0-rc.8] - 2026-09-16

- Added an optional Railway revision environment key so an immutable CLI deployment can report and verify its exact merged commit without triggering a separate variable deployment.

## [1.0.0-rc.7] - 2026-09-16

- Added an explicit `--link-extension` retry control so a noninteractive setup can recover after a partial extension-link failure, including commands that close confirmation input early.

## [1.0.0-rc.6] - 2026-09-16

- Replace stale Qwen extension links during setup and verify the exact immutable runtime path reported by the installed Qwen CLI.

## [1.0.0-rc.5] - 2026-09-16

- Added configuration version 2 with opt-in repository-aware programs, explicit staging authority, evidence signals, and protected controller self-hosting while preserving version 1 behavior.
- Added exact-commit repository assessment, evidence-backed objective coverage, dependency-wave activation, persistent program revisions, post-wave reassessment, and an objective acceptance audit.
- Added immutable Railway staging deployment with explicit project/environment/service targeting, exact deployment polling, revision health verification, lifecycle gates, durable recovery, and guarded rollback.
- Added provenance-preserving, deduplicated feedback intake for GitHub, CI, staging, metrics, and allowlisted sources, including approval boundaries for material signals.
- Added isolated successor evaluation, credential-free regression and four-stack canaries, protected launcher promotion, 24-hour probation, and rollback.
- Made installer-linked extensions, CLIs, and worker services use a versioned immutable runtime instead of the bootstrap or development checkout.
- Added `plan-reassess`, `plan-approve-revision`, `signals`, `deploy-status`, `evidence-report`, and controller release commands with text and JSON output.
- Bounded saved-session continuations, persisted provider waits separately from code failures, and carried identical failure history across repair tasks.
- Generated CI now follows the target project's declared Node major version and automatically gates common aggregate `check` and Playwright-style `test:browser` scripts.
- Enabled guarded auto-merge by default for newly installed projects, with `--no-auto-merge` as the explicit opt-out and existing project choices preserved during updates.
- Added Token Plan Personal as a first-class technical configuration using the same dedicated key and endpoint validation as Token Plan Team.
- Removed the obsolete in-memory teaching pipeline so the package contains only the production supervisor and its tests.

## [1.0.0-rc.4] - 2026-08-25

- Added tracked requirements ingestion with bounded Qwen decomposition into a validated acyclic delivery graph.
- Added durable master plans, review-only epic/story issues, duplicate-safe publishing, explicit approval, exact dependency mapping, and progress refresh.
- Added `plan`, `plan-approve`, and `plan-status` commands plus a fill-in starter requirements template.

## [1.0.0-rc.3] - 2026-08-25

- Detects compatible Qwen binaries across PATH and the npm global prefix instead of failing when an older Homebrew copy shadows a current npm installation.
- Reworked starter tag checkout to avoid confusing annotated-tag and detached-HEAD warnings.

## [1.0.0-rc.2] - 2026-08-25

- Upgraded pinned GitHub Actions to their Node 24 releases after the hosted runner reported Node 20 deprecation warnings.
- Revalidated clean-clone install, source CI, package smoke, and starter generation.

## [1.0.0-rc.1] - 2026-08-25

First public release candidate of Fern's autonomous software delivery harness, powered by Qwen Code.

- Durable issue state, leasing, monitoring, recovery, and post-merge repair.
- Isolated Qwen Code execution with bounded workflows and least-privilege tools.
- Deterministic gates plus execution, rubric, agentic, and visual rewards.
- Interactive setup, dependency preflight, browser runtime checks, and worker services.
- GitHub issue intake, pull-request delivery, exact-head CI, and guarded auto-merge.
- Reproducible starter-repository generator and release acceptance checks.

This remains a release candidate until the complete delivery loop is verified with a configured Qwen account.
