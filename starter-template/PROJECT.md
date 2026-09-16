# Project requirements

Fill in the short sections below. Plain language is enough. Delete examples that do not apply; do not invent detail just to fill space.

## Product idea and objective

What are we building, and what useful outcome must the MVP produce?

## User and core use case

Who uses it? Describe the one most important end-to-end scenario.

## MVP scope

- Must have:
- Nice to have, only after the must-haves:
- Explicitly out of scope:

## Inputs, outputs, and integrations

List required data, pages/APIs, third-party services, and any existing code that must be preserved.

## Constraints

List technology, security, privacy, compatibility, budget, design, deployment, and production-activation constraints. Existing decisions remain binding unless you explicitly approve a material revision.

## Definition of done

- [ ] State observable behavior a user can verify.
- [ ] State the required automated checks.
- [ ] State any demo or deployment result required.
- [ ] State the staging user journey and the revision or health evidence that proves it.

## Known stories or acceptance examples (optional)

Add any stories you already know. The planner can propose a dependency-aware story graph when this section is empty.

After setup and `qwen-harness verify .`, create a review-only plan with:

```sh
qwen-harness plan . --requirements PROJECT.md
```

Executable work still begins only after `qwen-harness plan-approve` creates the separate normalized task issues.
