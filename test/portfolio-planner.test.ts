import { symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readRequirementsDocument,
  validatePortfolioDraft,
} from '../src/portfolio/planner.js';
import { makeTmp } from './helpers.js';

function story(key: string, dependsOn: string[] = []): Record<string, unknown> {
  return {
    key,
    title: `Story ${key}`,
    goal: `Implement ${key}`,
    acceptanceCriteria: [`${key} is verified`],
    constraints: [],
    requiredGateIds: ['test'],
    rewardCriterionIds: ['execution'],
    risk: 'low',
    dependsOn,
    rollback: `Revert ${key}`,
    technologyDecisionIds: [],
    deploymentDecisionIds: [],
  };
}

describe('portfolio planner validation', () => {
  it('normalizes a valid dependency graph into topological order', () => {
    const result = validatePortfolioDraft(
      {
        title: 'Demo plan',
        objective: 'Ship the demo',
        constraints: ['Keep compatibility'],
        definitionOfDone: ['All stories pass'],
        technologyDecisions: [],
        deploymentDecisions: [],
        stories: [story('S2', ['S1']), story('S1')],
      },
      ['test'],
      ['execution'],
      10,
    );

    expect(result.stories.map((item) => item.key)).toEqual(['S1', 'S2']);
  });

  it('rejects cycles, unknown dependencies, and unknown verifier ids', () => {
    const base = {
      title: 'Demo plan',
      objective: 'Ship the demo',
      constraints: [],
      definitionOfDone: ['All stories pass'],
      technologyDecisions: [],
      deploymentDecisions: [],
    };
    expect(() => validatePortfolioDraft({ ...base, stories: [story('S1', ['S2']), story('S2', ['S1'])] }, ['test'], ['execution'])).toThrow(/cycle/);
    expect(() => validatePortfolioDraft({ ...base, stories: [story('S1', ['MISSING'])] }, ['test'], ['execution'])).toThrow(/unknown dependency/);
    expect(() => validatePortfolioDraft({ ...base, stories: [{ ...story('S1'), requiredGateIds: ['made-up'] }] }, ['test'], ['execution'])).toThrow(/unknown gate/);
  });

  it('freezes approved and exception technologies with build-test-only deployment authority', () => {
    const result = validatePortfolioDraft(
      {
        title: 'Delivery plan',
        objective: 'Ship safely',
        constraints: [],
        definitionOfDone: ['Verified'],
        technologyDecisions: [
          { id: 'WEB', category: 'hosting', technology: 'Vercel', rationale: 'Approved hosting' },
          { id: 'QUEUE', category: 'queue', technology: 'Example Queue', rationale: 'Required exception' },
        ],
        deploymentDecisions: [
          { id: 'PREVIEW', component: 'web', provider: 'WEB', environment: 'preview', rationale: 'Build preview' },
        ],
        stories: [{
          ...story('S1'),
          risk: 'HIGH',
          technologyDecisionIds: ['WEB', 'QUEUE'],
          deploymentDecisionIds: ['PREVIEW'],
        }],
      },
      ['test'],
      ['execution'],
      10,
      {
        authority: 'build-test-only',
        approved: [{ category: 'hosting', technology: 'Vercel' }],
        requirePlanApprovalForExceptions: true,
      },
    );

    expect(result.technologyDecisions.map((decision) => decision.source)).toEqual(['approved', 'exception']);
    expect(result.stories[0]?.risk).toBe('high');
    expect(result.deploymentDecisions[0]?.provider).toBe('Vercel');
    expect(result.deploymentDecisions[0]?.authority).toBe('build-test-only');
    expect(() => validatePortfolioDraft(
      {
        title: 'Bad references', objective: 'Reject drift', constraints: [], definitionOfDone: ['Verified'],
        technologyDecisions: [], deploymentDecisions: [],
        stories: [{ ...story('S1'), technologyDecisionIds: ['MISSING'] }],
      },
      ['test'],
      ['execution'],
      10,
    )).toThrow(/unknown technology decision/);
  });
});

describe('requirements document boundary', () => {
  it('reads tracked project text and rejects files outside the project or through symlinks', () => {
    const root = makeTmp('requirements-root');
    const outside = makeTmp('requirements-outside');
    writeFileSync(path.join(root, 'REQUIREMENTS.md'), '# Product\nBuild it.\n');
    writeFileSync(path.join(outside, 'secret.md'), 'not project input\n');
    symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'linked.md'));

    expect(readRequirementsDocument(root, 'REQUIREMENTS.md')).toEqual({
      sourcePath: 'REQUIREMENTS.md',
      content: '# Product\nBuild it.\n',
    });
    expect(() => readRequirementsDocument(root, path.join(outside, 'secret.md'))).toThrow(/inside the project root/);
    expect(() => readRequirementsDocument(root, 'linked.md')).toThrow(/symbolic link/);
  });
});
