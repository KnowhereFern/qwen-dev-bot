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

## Limits and rollout gates

- Installation preflight validates the matching extension and hook files. It does not prove upstream hook execution is fail-closed on timeout or startup errors.
- The hook additionally checks Qwen's recorded first subagent transcript entry for the `harness-implementer` role, matching session, agent and worktree. Missing or mismatched evidence denies mutation. This depends on the supported Qwen transcript layout and does not constitute OS-level isolation from a malicious implementation agent.
- Packaged extension loading and the recorded implementer path have been exercised locally; upstream hook runtime failure behavior remains a limit.
- Preserve existing failed/quarantined task history. Do not reset counters to make the run appear successful.
- No successful Cantina issue-to-merge delivery, staging acceptance, or observation period is established by these tests.
