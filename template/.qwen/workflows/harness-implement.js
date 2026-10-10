phase('Independent reconnaissance');
const reconnaissance = await parallel([
  () => agent(`Inspect the requested task in args and map the relevant code paths, existing patterns, tests, and risks. Do not edit files. Return JSON. Task: ${JSON.stringify(args)}`, {
    label: 'code reconnaissance',
    agentType: 'harness-researcher',
    schema: {
      type: 'object',
      required: ['paths', 'patterns', 'risks'],
      properties: {
        paths: { type: 'array', items: { type: 'string' } },
        patterns: { type: 'array', items: { type: 'string' } },
        risks: { type: 'array', items: { type: 'string' } }
      }
    }
  }),
  () => agent(`Inspect tests, verification commands, and likely regression boundaries for this task. Do not edit files. Return JSON. Task: ${JSON.stringify(args)}`, {
    label: 'test reconnaissance',
    agentType: 'harness-verifier',
    schema: {
      type: 'object',
      required: ['commands', 'scenarios'],
      properties: {
        commands: { type: 'array', items: { type: 'string' } },
        scenarios: { type: 'array', items: { type: 'string' } }
      }
    }
  })
]);

phase('Implementation');
const implementation = await agent(`Implement the task in the current worktree. You are the only mutating agent. Use this independent reconnaissance as evidence, verify your work, and preserve all protected harness paths. After your final code edit, execute node .qwen-harness/scripts/run-gates.mjs from the worktree root. That existing runner writes .qwen-harness/state/gate-receipt.json as runtime evidence; never author or edit the receipt yourself. If you change code after running gates, run the runner again. A failed or missing receipt is not a successful handoff. Keep your report concise: tests are summaries, not substitutes for the machine-written receipt. Task: ${JSON.stringify(args)}\nReconnaissance: ${JSON.stringify(reconnaissance)}`, {
  label: 'bounded implementation',
  agentType: 'harness-implementer',
  schema: {
    type: 'object',
    required: ['summary', 'changedFiles', 'tests'],
    properties: {
      summary: { type: 'string' },
      changedFiles: { type: 'array', items: { type: 'string' } },
      tests: { type: 'array', items: { type: 'string' } }
    }
  }
});

phase('Independent review');
const review = await agent(`Review the current worktree against the task, reconnaissance, and implementation report. Do not edit files or attempt shell tools; your role is read-only. Read .qwen-harness/state/gate-receipt.json for the runner's actual outcome and required-gate coverage; do not infer execution from test source or the implementer's summary. A missing, incomplete, failed, stale, or wrong-worktree receipt is a blocker. Keep findings concise and evidence-backed. Task: ${JSON.stringify(args)}\nImplementation: ${JSON.stringify(implementation)}`, {
  label: 'independent review',
  agentType: 'harness-reviewer',
  schema: {
    type: 'object',
    required: ['passed', 'findings'],
    properties: {
      passed: { type: 'boolean' },
      findings: { type: 'array', items: { type: 'string' } }
    }
  }
});

// Keep the evidence locator first: the parent Goal's transcript window may
// truncate long reports. The parent must read the receipt, not trust this path
// or a model-authored PASS summary as proof that checks actually ran.
return {
  gateReceiptPath: '.qwen-harness/state/gate-receipt.json',
  evidenceInstruction: 'Read the machine-written gate receipt before proposing local completion. Required checks and exact-commit supervisor verification remain mandatory.',
  implementation,
  review
};
