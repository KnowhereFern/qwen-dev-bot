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
const implementation = await agent(`Implement the task in the current worktree. You are the only mutating agent. Use this independent reconnaissance as evidence, verify your work, and preserve all protected harness paths. Task: ${JSON.stringify(args)}\nReconnaissance: ${JSON.stringify(reconnaissance)}`, {
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
const review = await agent(`Review the current worktree against the task, reconnaissance, and implementation report. Do not edit files. Return only evidence-backed blockers. Task: ${JSON.stringify(args)}\nImplementation: ${JSON.stringify(implementation)}`, {
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

log(JSON.stringify({ implementation, review }));
return { implementation, review };
