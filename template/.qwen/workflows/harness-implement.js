// The parent workflow tool call may deliver args as functionCall.args.args —
// a JSON string rather than an object. Normalize once, fail safe (keep the
// original value, run full reconnaissance) on anything malformed or non-object
// instead of throwing.
let taskArgs = args;
if (typeof taskArgs === 'string') {
  try {
    const parsed = JSON.parse(taskArgs);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) taskArgs = parsed;
  } catch (_error) { /* malformed JSON: fail safe to the original value below */ }
}

// A focused continuation is an automatic resume where the coordinator supplies
// a precise next action; the two broad read-only reconnaissance agents would
// only repeat mapping already recorded in prior runs. Anything missing or
// malformed fails safe to the full initial-run pipeline.
const focus = taskArgs && typeof taskArgs === 'object' ? taskArgs.executionFocus : null;
const focusAction = focus && typeof focus === 'object' && typeof focus.nextAction === 'string'
  ? focus.nextAction.trim()
  : '';
const focused = focusAction.length > 0;

let reconnaissance = null;
if (!focused) {
phase('Independent reconnaissance');
reconnaissance = await parallel([
  () => agent(`Inspect the requested task in args and map the relevant code paths, existing patterns, tests, and risks. Do not edit files. Return JSON. Task: ${JSON.stringify(taskArgs)}`, {
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
  () => agent(`Inspect tests, verification commands, and likely regression boundaries for this task. Do not edit files. Return JSON. Task: ${JSON.stringify(taskArgs)}`, {
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
}

phase('Implementation');
const focusDirective = focused
  ? `This is a focused continuation of a prior run: reconnaissance is already recorded in the task history. Do not repeat broad read-only surveys. Next action from the coordinator: ${focusAction}\n`
  : '';
const implementation = await agent(`Implement the task in the current worktree. You are the only mutating agent. ${focused ? 'Proceed directly from the focused next action below; skip redundant reconnaissance.' : 'Use the independent reconnaissance below as your starting point;'} inspect only specific files needed for the next change, not the whole repository again. Act on any existing candidate early: if code exists but acceptance tests are missing, add the tests before another broad survey; if the candidate is complete, run verification rather than re-planning it. Make the next concrete change or run the required gates before investigating peripheral documentation. Correct any documentation made inaccurate by your change before handoff. Preserve every acceptance criterion and all protected harness paths. After your final code edit, execute node .qwen-harness/scripts/run-gates.mjs from the worktree root. That existing runner writes .qwen-harness/state/gate-receipt.json as runtime evidence; never author or edit the receipt yourself. If you change code after running gates, run the runner again. A failed or missing receipt is not a successful handoff. Keep your report concise: tests are summaries, not substitutes for the machine-written receipt. ${focusDirective}Task: ${JSON.stringify(taskArgs)}\nReconnaissance: ${JSON.stringify(reconnaissance)}`, {
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
const review = await agent(`Review the current worktree against the task, reconnaissance, and implementation report. Do not edit files or attempt shell tools; your role is read-only. Read .qwen-harness/state/gate-receipt.json for the runner's actual outcome and required-gate coverage; do not infer execution from test source or the implementer's summary. A missing, incomplete, failed, stale, or wrong-worktree receipt is a blocker. Keep findings concise and evidence-backed. Task: ${JSON.stringify(taskArgs)}\nImplementation: ${JSON.stringify(implementation)}`, {
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
