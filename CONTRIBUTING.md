# Contributing

Use Node.js 22.5 or newer and install the locked dependencies with `npm ci`.

Before opening a pull request, run:

```sh
npm run release:check
npm run typecheck
npm test
npm run package:smoke
```

Keep changes bounded and preserve the safety invariants in `QWEN-HARNESS.md` and the generated `AUTONOMY.md`. New behavior needs focused tests. Never commit API keys, worker state, session transcripts, SQLite databases, or generated install receipts.

Use GitHub issues for proposed behavior changes and security advisories for suspected vulnerabilities.
