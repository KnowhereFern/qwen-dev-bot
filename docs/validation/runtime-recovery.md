# Headless workflow recovery

Local validation, 2026-10-05. This is harness validation, not proof of autonomous product delivery.

## Failure reproduced

The installed Qwen CLI reported `0.24.5`. Its headless `auto` setup denied shell, edit and write when they were not registered through `core-tools`. Named workflow implementation agents consequently reported missing mutation tools. The CLI transcript metadata separately reported `0.24.7`; this discrepancy is not resolved by the smoke test.

## Candidate verification

- Registering the required core tools retained `auto` approval and the exact saved-workflow permission rule.
- An isolated `qwen3.8-max` workflow discovered shell, edit and write: run `wf_54b0c07b1cb36641`.
- An isolated named implementation agent created a fixture using `write_file`, then verified its exact bytes with a Node command: stdout `verified`, exit code 0. Workflow `wf_70d118decfa120b8` completed one agent with no failed agents.
- The smoke test changed no target-product files. It used a temporary repository.
- The writer hook's protocol tests cover parent mutation denial, exact saved-workflow selection, malformed inputs, worktree boundaries and deferred-tool dispatch. Permitted calls emit no automatic approval.
- A real parent session attempted `write_file` and received `Fern writer guard: only a saved-workflow implementation agent may execute mutation tools.` The requested file was not created.
- With transcript-backed role checking enabled, workflow `wf_d42b64aa6eb63399` again wrote a fixture and ran its exact-byte verifier successfully. A separate named reviewer could not execute its requested shell command; Qwen reported a non-interactive permission denial. That latter result alone does not establish which permission layer denied it.
- Local checks passed: 303 tests, TypeScript, release metadata checks, and both packaged command aliases. Full-screen terminal navigation through progress, Escape, numbered return and exit was exercised; no delivery actions were selected.
- RC42 was installed into a new versioned runtime, and the Qwen extension was relinked to it. With the temporary workspace hook removed, a real parent write was denied by the installed extension and the target file remained absent. Structural preflight passed for the actual task-43 worktree.
- The shared worker restarted on RC42 and resumed task 43 with its previous attempt count intact. A new saved workflow started its two read-only agents. This is progress, not task completion.
- Workflow `wf_4f5241a6ee7331e4` subsequently completed its implementer and entered independent review. The isolated task-43 checkout contains a README change and a new blocker document written by the harness, not Codex. Task completion and merge remain unverified.
- RC44 source validation passed 323 tests, TypeScript and release metadata checks. Both packaged aliases passed the package smoke test. Added checks cover shared failure budgets across siblings/restarts, per-requirement recovery lineage, rejected recovery proposals and frozen coverage identities. Existing failed/quarantined counters were not reset.

## Review transport recovery

- On RC44, task 43 produced candidate `04466ec7b17e860fcb443f4abab98ce0c747e4ce`. The controller supplied passing results for harness-security, next-typegen, check, build, typecheck and lint to its exact-commit reviewer.
- The independent reviewer exited, but parsing its batch JSON failed near 65 KB. A local child-process reproduction of an unawaited large stdout write followed by exit captured 65,536 of 200,014 bytes. Installed CLI code similarly writes the complete batch transcript before explicitly exiting. This supports pipe truncation as the cause; the redacted review transcript does not prove its lost verdict.
- RC45 uses streamed events and requires exactly one successful, complete terminal verdict. Invalid/missing/truncated verdicts fail closed; no partial response or cached review is accepted.
- Local validation passed 349 tests, TypeScript and release checks. A real saved-model Qwen3.8-Max transport-only smoke returned a schema-conforming terminal event through the new collector. That synthetic result is not product review evidence.
- The failed attempt remains recorded. Task 43 retained its candidate and two failures; no counters were cleared.

## Local handoff recovery

- On RC45, workflow `wf_beb9a9fb6082b3c1` passed its local checks and workflow review for candidate `04466ec7b17e860fcb443f4abab98ce0c747e4ce`, with no further content edits. Qwen's Goal verification then blocked on the missing remote PR, although the supervisor creates that PR only after the session returns successfully.
- RC46 explicitly defines the Qwen Goal as the local implementation handoff. The full task delivery invariant remains controller-owned and unchanged: exact-commit gates and review, push, PR, CI, merge and post-merge verification still follow.
- Blocked Goal states remain failures, not inferred successes. Missing implementation, failed checks, failed workflow review and genuine implementation dependencies cannot be relabeled as handoff success.
- The worker was stopped after this confirmed failure. Task 43 retains three failed attempts and its original candidate; the interrupted subsequent attempt was released without another failure. No exhausted tasks were restarted or counters cleared.
- Local validation passed all 349 tests and TypeScript. The live handoff correction remains unproven until the resumed harness reaches controller verification.

## Remaining limits

- RC48 fixes two further harness failures observed during the authorized recovery: the acceptance API judge received only an empty diff for verification-only work, and resumed chats treated a generic runtime-abort message as a new user cancellation. Empty-diff rubric reviews now inspect the exact candidate checkout; fresh repair conversations preserve task/worktree/history while avoiding replay of failed-chat instructions. Ordinary continuations still resume.
- Local RC48 validation passed 376 tests in 36 files, TypeScript and release checks. These are harness regression checks, not live product acceptance. No retry limits were raised by RC48. Issues 35 and 36 had consumed their authorized ceiling of eight failures; issue 37 retained one remaining attempt when the worker was stopped for this repair.
- A bounded read-only Qwen3.8-Max review identified missing execution excerpts and implicit project-context risks. Source inspection confirmed both; reviewers now receive bounded redacted gate output, frozen constraints and rollback, and run with implicit customizations disabled. Regression tests verify these controls; this is not live provider-behavior proof.
- The live reviewer smoke exposed duplicate provider IDs: explicit model selection picked a different endpoint and returned 401. A private invocation settings file now pins the configured model/endpoint/credential-variable triple, retaining system policy and its original defaults path. Persistent settings are unchanged and credentials are not written into the overlay. Existing settings must be strict JSON; credential-bearing system policy fails closed rather than being copied.
- The installed CLI resolver selected the pinned route in an isolated duplicate-provider test. A live configured-model connection returned OK; the repository rubric then inspected unchanged package/README version declarations and returned a structured passing verdict with file/line evidence. This validates reviewer transport/static inspection only, not Cantina behavior or staging.

- RC47 adds the operator-only `recovery-authorize` command after explicit user authorization for Cantina issues 35–42. Each authorization records its operator, reason, task contract hash, failure baseline and absolute ceiling. Replay cannot grant more attempts or re-release the task. Old failure counters, fingerprints, sessions and required checks remain unchanged.
- The RC46 harness delivered Cantina PR 44 through exact-commit verification, GitHub checks, merge commit `613c011761a886457ce0b5654b7905dfc7143cac`, and the controller's post-merge verification. This completed the blocker-documentation task, not the product objective or staging acceptance.

- Installation preflight validates the matching extension and hook files. It does not prove upstream hook execution is fail-closed on timeout or startup errors.
- The hook additionally checks Qwen's recorded first subagent transcript entry for the `harness-implementer` role, matching session, agent and worktree. Missing or mismatched evidence denies mutation. This depends on the supported Qwen transcript layout and does not constitute OS-level isolation from a malicious implementation agent.
- Packaged extension loading and the recorded implementer path have been exercised locally; upstream hook runtime failure behavior remains a limit.
- Preserve existing failed/quarantined task history. Do not reset counters to make the run appear successful.
- Cantina product-objective acceptance, staging acceptance and the observation period remain unproven.

## RC61 post-merge evidence and retry-in-place

- GLM `zai-coding-plan/glm-5.3` authored the implementation and regression-test drafts through the GLM delegation skill. Codex reviewed and integrated them. Qwen `qwen3.8-max`, using the saved provider configuration through the Qwen delegation skill, reviewed the evidence patch and authored the report-validation and gate-label refinements. Codex independently ran the checks below.
- Post-merge gate records now retain the merge SHA, unique execution ID, timing, result, and per-gate evidence hashes. The security review kept command text, stdout, and stderr outside these records. Program exports retain distinct attempts and exclude unrelated tasks; completed legacy tasks receive no invented records.
- A failed evidence write immediately after merge previously used the generic execution-failure route. The correction keeps the task in `post_merge`, preserves bounded failure accounting, and retries verification rather than implementation.
- Independently executed regression tests verify journal failure followed by recovery to `done`, with one implementation call and one PR; shutdown after the side-effect scan creates no passing record. Focused checks: 29 passed. Full suite: 507 passed, one skipped across 40 files. Type checking and whitespace checks passed.
- Malformed record identifiers, commit SHAs, timestamps, result flags, and missing gate arrays are excluded from the report. Optional and skipped gates are labeled; the report identifies these records as historical checks rather than current acceptance authority.
- Final RC61 local validation passed type checking, 507 tests with one skipped, release checks, and packaged installation/version checks for both command aliases.
- This is local harness evidence, not proof of deployment or full product acceptance. The live controller was not replaced or interrupted. CI and safe-boundary installation remain outstanding.
