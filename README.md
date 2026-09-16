# Autonomous Software Delivery Harness

A software product designed and built by Fern. It uses Qwen Code and `qwen3.8-max` as its execution engine to turn approved GitHub feedback into isolated code changes, exact-commit verification, pull requests, and post-merge self-repair.

**Release status:** `v1.0.0-rc.13`. The objective-delivery, staging, and controller-evolution paths are implemented and covered by deterministic tests. Stable `v1.0.0` remains gated on the measured Festival SOS run, the seven-day observation period, and a demonstrated controller promotion and rollback.

See [live test readiness](docs/live-test-readiness.md) for the current machine and end-to-end proof status.

This is the canonical harness source and installer repository. For a blank application repository, use the separate [Harness Starter](https://github.com/KnowhereFern/qwen-harness-starter) template and run `node setup.mjs`. Each target project receives a small tracked control plane under `.qwen-harness/`, `.qwen/`, and `.github/`; project-specific gates, reward rubrics, protected paths, sources, and merge policy live in `.qwen-harness/project.yml`.

## Designed and built by Fern

Fern created the architecture, delivery model, governance rules, reward system, and product philosophy in this repository.

Qwen Code and `qwen3.8-max` provide the model runtime. The harness supplies the orchestration, evaluation, delivery workflow, and operating contract.

## What is implemented

| Product capability | Implementation |
| --- | --- |
| Issue state, dispatch, monitoring, watchdog recovery | Transactional SQLite state machine, dependency-aware atomic leases, heartbeats, checkpoints, retry fingerprints, quarantine, and reconciliation |
| Long-running autonomous implementation | Headless Qwen Code `/goal`, saved session IDs, `/goal resume`, stream-JSON monitoring, hard wall/tool/turn budgets, and isolated Git worktrees |
| Build, unit, integration, E2E, lifecycle, and security checks | Auto-discovered and project-configurable gates, bounded subprocesses, a built-in secret/symlink scan, GitHub CI, and fresh-worktree post-merge verification |
| Universal reward system | Hard execution vetoes plus weighted Qwen rubric, independent agentic review, and optional rendered-visual scoring; every result is an evidence-linked scorecard |
| Multi-source evolution | GitHub feedback, CI and staging failures, approved metrics, and allowlisted HTTPS engineering sources are provenance-preserving, hashed, relevance-checked, deduplicated, and kept inside the approval boundary |
| Requirements-to-delivery planning | A project-local requirements file becomes a durable master-plan issue plus bounded, dependency-aware review stories; explicit approval freezes exact normalized task contracts |
| Repository-aware objective programs | Parallel read-only repository assessment records an exact clean commit, maps objective coverage to verified evidence, activates one dependency wave at a time, and reassesses the objective after delivery |
| Staging delivery | A credential-isolated deployment controller deploys an immutable merged commit to an explicitly configured Railway or command provider, verifies the reported revision, runs lifecycle gates, and records rollback evidence |
| Continuous maintenance | GitHub feedback, CI failures, staging failures, approved metrics, and allowlisted engineering sources become provenance-preserving, deduplicated signals; material changes still require approval |
| Controlled harness evolution | An immutable controller can evaluate a successor without credentials, require Node/Python/Go/Rust canaries, promote it through a protected launcher at an idle boundary, observe probation, and roll back |
| Dynamic workflows and multi-agent work | A Qwen workflow with parallel read-only reconnaissance, one mutating implementer, and independent review; six bounded Qwen subagents ship in the extension |
| Multimodal-native work | Visual reward artifacts are supported directly; setup can also install the official Qwen-MM-Plugins core capability for Qwen's implementation agents |
| Continuous delivery and self-repair | Exact remote-head checks, guarded auto-merge by default, verification of the actual merge commit, and one deduplicated repair issue per post-merge regression |

The harness evaluates delivered software at runtime using deterministic per-project polling, task priority, and bounded mutation concurrency.

The Qwen Code integration follows its official documentation for [headless goals and budgets](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/), [subagents](https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/), [saved dynamic workflows](https://qwenlm.github.io/qwen-code-docs/en/blog/updates/weekly-update-2026-06-25/), [extensions](https://qwenlm.github.io/qwen-code-docs/en/users/extension/introduction/), and [OpenAI-compatible model providers](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/). GitHub and multimodal integration use the official [Qwen Code GitHub Actions guide](https://github.com/QwenLM/qwen-code/blob/main/docs/users/integration-github-action.md) and [Qwen-MM-Plugins installation guide](https://github.com/QwenLM/Qwen-MM-Plugins/blob/main/docs/en/installation.md); multimodal installation uses Qwen Code's native extension command and an immutable capability tag.

## Runtime loop

```text
objective + repository snapshot -> evidence map -> program + explicit approval
                                      |
                   current dependency wave only
                                      v
approved issue / accepted signal / CI or staging regression
                         |
                  untrusted intake
                         v
              Qwen-normalized issue spec
                         |
        ready -> leased -> active -> verifying
                         |
             isolated Git worktree + /goal
                         |
      deterministic gates + universal reward
                         |
       tested SHA -> remote SHA -> pull request
                         |
       exact-head CI -> merge-ready -> merge
                         |
        fresh merge-commit verification
                  |                 |
            wave complete    deduplicated repair issue
                  |
       immutable staging deployment
                  |
       revision check + lifecycle gates
                  |
     objective audit -> next wave / delivered
                  |
     maintenance signals; no invented backlog
```

Supported task states are `intake`, `normalized`, `ready`, `leased`, `active`, `verifying`, `pr_open`, `waiting_ci`, `merge_ready`, `post_merge`, `waiting`, `failed`, `quarantined`, `cancelled`, and `done`.

## Prerequisites

- Node.js 22.5 or newer
- Git and a clean target repository with an `origin` remote
- Qwen Code 0.22.1 or newer (the setup wizard can install or upgrade it)
- GitHub CLI authenticated to the target repository, or `GH_TOKEN`/`GITHUB_TOKEN` (`repo` for a classic token; Contents, Issues, Pull requests, Commit statuses write plus Checks read for a fine-grained token)
- A Qwen credential and matching endpoint that can call `qwen3.8-max`: standard QwenCloud, Token Plan Personal, Token Plan Team, or a custom compatible provider. The harness can reuse the configured credential name from Qwen Code's user settings, `~/.qwen/.env`, the shell, or its mode-0600 worker file.

Token Plan Personal and Team use `BAILIAN_TOKEN_PLAN_API_KEY` with `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`; standard QwenCloud uses its matching standard key and endpoint. Setup and doctor prevent known key/endpoint mismatches.

The target repository must already exist. Setup does not create a GitHub repository or push commits. New project configurations enable guarded auto-merge by default; setup changes GitHub labels and branch protection only when explicitly requested.

## Guided setup

For the easiest clone-to-running path, use the dependency-free bootstrap. It installs this harness's locked packages, asks for the target project folder, and launches the guided setup:

```sh
npm run bootstrap
```

You can also provide the path up front: `npm run bootstrap -- /absolute/path/to/your-project`. The lower-level equivalent is `npm ci && npm run setup -- /absolute/path/to/your-project`.

The wizard detects the GitHub repository and project scripts, then asks about:

- trusted issue author and merge policy;
- repository-aware objective delivery; new installations enable it by default, while existing version 1 projects retain their prior authority until explicitly upgraded;
- the Qwen billing plan, matching endpoint/credential name, and optional Qwen Code install or upgrade;
- reuse of a credential already saved in Qwen Code; accepting the matching default normally requires no token copying or shell export;
- allowlisted community-source scanning;
- the delivery harness extension for Qwen Code and optional Qwen-MM-Plugins core capability (`uvx` required and its official system check runs during setup);
- target dependencies and declared Playwright/Cypress browser runtimes; dependency bootstrap is on by default, and `--with-browser` can add project-local `@playwright/test` first;
- the persistent launchd, systemd-user, or Windows worker;
- optional mode-0600 copying of the detected Qwen credential for that worker (off by default because the worker can normally reuse Qwen user settings);
- GitHub labels and branch protection.

Review without writing anything:

```sh
npm run setup -- /absolute/path/to/your-project --dry-run --yes \
  --repo owner/repository --trusted-author github-login \
  --no-service --link-extension --no-link-extension
```

An explicit unattended setup can enable the optional pieces:

```sh
npm run setup -- /absolute/path/to/your-project --yes \
  --repo owner/repository --trusted-author github-login \
  --billing-plan standard \
  --base-url https://dashscope-intl.aliyuncs.com/compatible-mode/v1 \
  --api-key-env DASHSCOPE_API_KEY \
  --install-qwen --community --with-mm --install-cli \
  --with-browser \
  --persist-api-key --configure-github
```

Guarded auto-merge defaults on for new projects so a fully passing story can unblock its dependents without human polling. Answer `no` in the wizard or pass `--no-auto-merge` to opt out; `--auto-merge` can explicitly opt an existing project back in during `update`. Existing project choices are preserved unless a flag changes them. The installer is idempotent: it updates unchanged harness-owned files, preserves project customizations, backs up pre-existing settings, and records hashes for safe uninstall. Before linking the extension, CLI, or worker service, it packs the current release into a versioned controller installation under harness state; services never depend on a temporary bootstrap clone or mutable development checkout. Optional GitHub configuration creates only missing labels and adds only missing required status contexts; it does not replace existing label metadata or branch-protection rules.

Setup writes additive project `.qwen/settings.json` entries for `qwen3.8-max`, sandboxing, leaf-only delegation, and dynamic workflows, referring only to the configured credential environment name; it never writes the credential into tracked project settings. The harness resolves that name from the same untracked user locations Qwen Code uses. Model-driven Qwen subprocesses receive a least-privilege environment, never inherit GitHub/OpenAI/npm/cloud credentials, and use an invocation-level MCP allowlist. The allowlist is empty by default; `--with-mm` adds only `qwen-mm-plugins-core`. The main session and reviewers remain non-mutating; each headless run auto-approves only the exact installed saved workflow path, and only that workflow's implementer receives YOLO approval. The implementer remains inside Qwen's sandbox, an isolated worktree, and the supervisor's external protected-path checks. The saved dynamic workflow receives explicit concurrency, total-agent, wall-time, output-token, per-agent turn, and per-agent time limits from project configuration.

Native Qwen Computer Use is explicitly disabled in the generated project settings. It is a GUI operator that can click and type outside a Git worktree, so it is not part of the unattended YOLO path. Web projects should declare project-local Playwright or Cypress: setup installs the locked package and its matching browser runtime, and doctor verifies both. Qwen Computer Use can still be used separately in a supervised Qwen session; Qwen downloads its own `cua-driver` on first use and macOS requires Accessibility plus Screen Recording permission.

After setup:

```sh
node bin/qwen-harness.mjs doctor /absolute/path/to/your-project
node bin/qwen-harness.mjs verify /absolute/path/to/your-project
```

`verify` includes a small live Qwen3.8-Max JSON call. Commit the generated tracked files only after reviewing them.

## Dependency preflight

The setup wizard runs the installed target's `.qwen-harness/scripts/bootstrap.mjs` by default. It uses the committed npm, pnpm, Yarn, Bun, uv, or requirements lock/input files; Python `requirements.txt` installs into a project-local `.venv`; and declared Playwright/Cypress runtimes are installed and verified.

Run the no-install checks any time:

```sh
npm run preflight -- /absolute/path/to/your-project
# or, from the target repository:
node .qwen-harness/scripts/bootstrap.mjs --check
qwen-harness doctor
```

The readiness matrix checks Node, Git, GitHub auth/repository/protection, the active Qwen binary and required headless flags, harness CLI/extension/assets, credential source, package manager and dependency tree, every configured gate executable, Playwright/Cypress browser binaries when declared, sandboxing, optional Qwen-MM/uvx, and—under `verify`—a real Qwen3.8-Max call. A missing required dependency is a `FAIL`, not a warning that autonomous execution ignores.

## Operating the harness

Create a GitHub issue and apply `harness:accept`. The raw issue is never executed. Qwen creates a separate normalized issue, the persistent worker claims it, and the task proceeds through the loop.

For a larger project, give the planner one project-local requirements file (committing it is recommended). With program mode enabled, the harness first inspects a clean repository snapshot at an exact commit. It records architecture, features, tests, dependencies, deployment configuration, and operational evidence; maps each requirement to `implemented`, `partial`, `missing`, `unverified`, or `externally_blocked`; then proposes a bounded acyclic delivery program. Nothing can execute until you approve it:

```sh
qwen-harness plan /path/to/project --requirements PROJECT.md
# Review the generated epic and stories on GitHub.
qwen-harness plan-approve /path/to/project --plan PLAN_ID
qwen-harness plan-status /path/to/project --plan PLAN_ID
```

Approval freezes the objective, acceptance criteria, technology choices, deployment targets, and authority. Only the current dependency wave becomes executable. After its exact merge commit passes staging and lifecycle verification, the harness reassesses the entire objective and may revise only unstarted work within those boundaries. Material changes pause at `awaiting_material_approval`; task completion alone never marks the objective delivered.

Use `plan ... --approve` only when you intentionally want planning and approval in one command. Re-running the same requirements snapshot is idempotent. Editing the file creates a new draft; accepted work is never silently rewritten.

The minimum useful requirements file needs only: a product objective, intended user/use case, MVP scope, constraints, and observable definition of done. A story list is optional—the planner can propose it—but specific acceptance examples improve the result. The planner also records the relevant technology and deployment choices. Catalog exceptions are visibly marked; approval freezes the reviewed choices into each normalized story contract. Deployment choices remain build-and-test-only unless version 2 explicitly enables an existing staging target. Staging credentials stay inside the deployment controller, resource creation is never inferred, and production always requires approval. The starter repository’s `PROJECT.md` is a fill-in template.

Useful commands:

```sh
qwen-harness doctor /path/to/project [--live]
qwen-harness run /path/to/project
qwen-harness worker [--once]
qwen-harness status /path/to/project [--json]
qwen-harness logs /path/to/project [--lines 100]
qwen-harness reward /path/to/project [--task TASK_ID | --issue N]
qwen-harness community /path/to/project [--force]
qwen-harness plan /path/to/project --requirements FILE [--max-stories N] [--approve]
qwen-harness plan-approve /path/to/project --plan PLAN_ID
qwen-harness plan-status /path/to/project [--plan PLAN_ID]
qwen-harness plan-reassess /path/to/project --plan PLAN_ID
qwen-harness plan-approve-revision /path/to/project --plan PLAN_ID
qwen-harness signals /path/to/project [--scan] [--accept ID | --reject ID]
qwen-harness deploy-status /path/to/project [--plan PLAN_ID]
qwen-harness evidence-report /path/to/project --plan PLAN_ID [--json]
qwen-harness controller-status /path/to/project
qwen-harness controller-evaluate /path/to/project --sha COMMIT_SHA
qwen-harness controller-promote /path/to/project --release RELEASE_ID
qwen-harness controller-rollback /path/to/project --release RELEASE_ID
qwen-harness update /path/to/project
qwen-harness uninstall /path/to/project --yes [--remove-service]
```

The Qwen extension also contributes `/harness:doctor`, `/harness:status`, and `/harness:implement`, the `harness-reward` skill, and six specialized subagents.

## Project customization

`.qwen-harness/project.yml` is emitted as JSON, which is a valid YAML subset; keep the file valid JSON because the dependency-free loader parses JSON directly. Customize:

- `gates`: exact command/argument arrays, applicability, required status, cwd, and timeout;
- `rewards.criteria`: execution, rubric, agentic, or visual modality; hard/critical behavior; weights and thresholds;
- `protectedPaths`: governance files the autonomous path cannot change;
- `intake.communitySources`: HTTPS sources, poll interval, proposal cap, and per-source `autoApprove`;
- `worker`: retry/quarantine policy, lease timing, polling, read-only workflow concurrency, and auto-merge. The mutation capacity is fixed at one;
- `qwen`: reasoning tiers; main-run, workflow, token, and subagent budgets; and `allowedMcpServers`. The model is intentionally fixed to `qwen3.8-max`; ambient user MCP servers are not inherited and subagent nesting is disabled.
- `technologyPolicy`: approved category/technology pairs used by portfolio planning. Choices outside the catalog are plan exceptions, and delivery authority is fixed at `build-test-only`.
- `program`: repository assessment, wave reassessment, maintenance, snapshot cleanliness, and material-change approval.
- `evolution`: approved feedback sources and polling. External content is evidence only and cannot grant execution authority.
- `deployment.staging`: explicit existing Railway identifiers or an argument-array command adapter, revision health endpoint, optional non-secret revision environment key, lifecycle gates, timeout, and optional data-compatible rollback. Deployment credentials are available only to this controller.
- `selfHosting`: disabled by default; names the proven delivery project, isolated evaluation commands, all four stack canaries, probation period, and whether a validated release may promote automatically. Enabling it also requires protecting the launcher, fixed acceptance runner, configuration validator, release manager, and reward evaluator paths listed by config validation.

Version 1 configurations continue with program, deployment, and self-hosting capabilities disabled. Migrating to version 2 never enables staging or self-promotion by itself. Production activation always remains outside autonomous authority.

For visual scoring, add a `visual` reward criterion with `artifactGlobs` pointing to deterministic screenshots or renders produced by a gate. Missing or out-of-worktree artifacts fail closed.

Normalized task gate/reward IDs are trace metadata only: a task cannot weaken project policy by omitting them. Every configured applicable gate and reward criterion is enforced.

## Safety and evidence invariants

- Issues, comments, linked pages, source pages, logs, test output, and model output are untrusted data.
- Only normalized issues created by configured trusted identities can become runnable tasks.
- Portfolio story issues are review-only; approval creates separate normalized task issues from the validated, frozen plan graph, including only the technology/deployment decisions referenced by each story.
- Repository assessment evidence is tied to the recorded commit and checked against the snapshot; source code without a passing test or operational receipt remains unverified where runtime behavior matters.
- Required checks and the objective contract cannot be weakened by model review, a later signal, a replacement task, or a controller candidate.
- One worker mutates one harness-owned worktree; research and review agents are read-only.
- Shell execution uses argument arrays with `shell: false`, bounded output, timeouts, process-tree termination, a reduced gate environment, and a credential-minimized Qwen environment.
- A passing summary cannot compensate for a failed hard gate, critical rubric, security finding, or changed PR head.
- Auto-merge defaults on, can be disabled per project, and uses GitHub's expected-head SHA guard.
- When a repository plan does not expose remote branch protection, setup records that provider limitation and the supervisor continues to enforce exact-head CI, governance, and reward checks before calling the merge API.
- `done` means the actual merge commit passed a fresh post-merge run—not merely that code, a PR, or CI exists.
- Program delivery additionally requires the objective acceptance audit and, when enabled, an exact-revision verified staging deployment.
- A successor controller cannot modify the running controller, its credentials, governance, launcher, or the evaluation that approves it.
- SQLite state, checkpoints, service credentials, transcripts, and redacted JSONL ledgers stay outside tracked project content.

See the installed project's `AUTONOMY.md` for the enforceable project contract.

## Development and verification

```sh
npm test
npm run typecheck
npm run build
npm run release:check
npm run package:smoke
```

The production-path integration test uses a real temporary Git repository and bare remote with mocked GitHub/Qwen boundaries. It proves normalization through merge and post-merge verification without credentials. Live GitHub and Qwen readiness remains the responsibility of `qwen-harness verify` in the installed target project.

## Release model

- `qwen-dev-bot` is the reusable source, installer, extension, supervisor, tests, and release history.
- `qwen-harness-starter` is the minimal GitHub template for a new project. Its dependency-free `setup.mjs` downloads a pinned harness release and launches the guided wizard.
- GitHub-hosted source CI runs the release gate, typecheck, full test suite, and packed-CLI smoke test on Linux and macOS.
- Stable releases require a clean-clone package check plus a real issue-to-post-merge run with a configured Qwen credential. Mocked integration proves plumbing but is not represented as live service proof.
