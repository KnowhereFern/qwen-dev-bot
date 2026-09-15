# Changelog

All notable changes to this project are documented here.

## [Unreleased]

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
