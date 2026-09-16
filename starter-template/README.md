# Autonomous Software Delivery Harness Starter

A minimal project repository for Fern's autonomous software delivery harness, powered by Qwen Code.

## Start here

1. Create a repository with GitHub's **Use this template** button and clone it.
2. Add your project code and fill in the short requirements template in `PROJECT.md`.
3. Run:

```sh
node setup.mjs
```

The dependency-free launcher checks Node and Git, downloads the pinned `qwen-dev-bot` release candidate into a temporary directory, installs its locked dependencies, and opens the interactive setup wizard for this repository. The wizard packs any linked extension, CLI, and worker into versioned harness state before that temporary directory is removed.

Setup explains and verifies Qwen Code, GitHub CLI/authentication, the selected Qwen billing route and credential source, project dependencies, browser automation, optional multimodal tools, CI, rewards, and the persistent worker. It does not place credentials in tracked files.

New projects default to guarded auto-merge after every local gate, reward check, and required GitHub check passes. The setup wizard offers a clear opt-out.

After setup, review and commit the generated `.qwen-harness/`, `.qwen/`, `.github/`, `AUTONOMY.md`, and `QWEN.md` files. Then run:

```sh
qwen-harness verify .
```

`verify` must pass before accepting autonomous work.

Create the repository-aware project program, review its evidence and proposed waves on GitHub, and approve it only when it matches your intent:

```sh
qwen-harness plan . --requirements PROJECT.md
qwen-harness plan-approve . --plan PLAN_ID
qwen-harness plan-status . --plan PLAN_ID
```

The first command records the repository revision, maps objective coverage to evidence, and creates only a master-plan issue and review stories. The second command freezes the approved objective and activates only the first dependency wave. Later waves are reassessed against merged and staging evidence before they execute.
