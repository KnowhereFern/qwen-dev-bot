# Qwen Harness Starter

A minimal project repository ready for the guided Qwen-inspired self-evolving development harness.

## Start here

1. Create a repository with GitHub's **Use this template** button and clone it.
2. Add your project code or describe the project in `PROJECT.md`.
3. Run:

```sh
node setup.mjs
```

The dependency-free launcher checks Node and Git, downloads the pinned `qwen-dev-bot` release candidate into a temporary directory, installs its locked dependencies, and opens the interactive setup wizard for this repository.

Setup explains and verifies Qwen Code, GitHub CLI/authentication, the eligible Qwen billing plan and credential source, project dependencies, browser automation, optional multimodal tools, CI, rewards, and the persistent worker. It does not place credentials in tracked files.

Token Plan Personal cannot run the unattended worker under QwenCloud's plan terms. Use Token Plan Team, standard pay-as-you-go, or an explicitly approved compatible provider for background automation.

After setup, review and commit the generated `.qwen-harness/`, `.qwen/`, `.github/`, `AUTONOMY.md`, and `QWEN.md` files. Then run:

```sh
qwen-harness verify .
```

`verify` must pass before accepting autonomous work.
