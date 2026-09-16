import { symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PortfolioPlanner,
  readRequirementsDocument,
  validatePortfolioDraft,
} from '../src/portfolio/planner.js';
import type { PortfolioPlanningModel } from '../src/portfolio/planner.js';
import type { RepositoryAssessment } from '../src/core/types.js';
import { defaultProjectConfig } from '../src/core/config.js';
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
    workType: 'verify',
    dependsOn,
    rollback: `Revert ${key}`,
    technologyDecisionIds: [],
    deploymentDecisionIds: [],
  };
}

describe('portfolio planner validation', () => {
  it('puts a compact mandatory action matrix ahead of summarized assessment evidence', async () => {
    let prompt = '';
    const model: PortfolioPlanningModel = {
      async completeJson<T>(input: Parameters<PortfolioPlanningModel['completeJson']>[0]): Promise<{ value: T }> {
        prompt = String(input.user);
        return { value: {
          title: 'Runner plan', objective: 'Deliver runner claims', constraints: [], definitionOfDone: ['Verified'],
          technologyDecisions: [], deploymentDecisions: [],
          stories: [{
            ...story('S1'), goal: 'Implement runner claims', workType: 'implement', coverageIds: ['RUNNERS'],
            requiredGateIds: [], rewardCriterionIds: [],
          }],
        } as T };
      },
    };
    const config = defaultProjectConfig(makeTmp('planner-context'), 'fixture', 'owner/fixture');
    const assessment = {
      id: 'assessment-context',
      projectId: 'fixture',
      commitSha: 'a'.repeat(40),
      dirty: false,
      detectedStacks: ['node'],
      files: ['SHOULD_NOT_REACH_PLANNER'],
      analyses: [{ area: 'product', summary: 'Runner claims are absent', findings: [], risks: [] }],
      coverage: [{
        id: 'RUNNERS', requirement: 'Runner claim flow', status: 'missing', requiredAction: 'implement',
        rationale: 'No claim flow exists', evidence: [],
      }],
      createdAt: 1,
    } as RepositoryAssessment;

    await new PortfolioPlanner(config, model).plan({ sourcePath: 'OBJECTIVE.md', content: 'Build runner claims.' }, 5, assessment);

    expect(prompt).toContain('Mandatory coverage/action matrix: [{"id":"RUNNERS"');
    expect(prompt).toContain('"requiredAction":"implement"');
    expect(prompt).not.toContain('SHOULD_NOT_REACH_PLANNER');
  });

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

  it('rejects verification-only stories for coverage that requires implementation', () => {
    const input = {
      title: 'Gap plan',
      objective: 'Deliver missing behavior',
      constraints: [],
      definitionOfDone: ['Verified'],
      technologyDecisions: [],
      deploymentDecisions: [],
      stories: [{ ...story('S1'), coverageIds: ['RUNNERS'], workType: 'verify' }],
    };
    const coverage = [{
      id: 'RUNNERS',
      requirement: 'Multi-runner claim flow',
      status: 'missing' as const,
      requiredAction: 'implement' as const,
      rationale: 'No claim flow exists',
      evidence: [],
    }];

    expect(() => validatePortfolioDraft(input, ['test'], ['execution'], 10, undefined, coverage))
      .toThrow(/requires implement work/);
    const result = validatePortfolioDraft(
      { ...input, stories: [{ ...input.stories[0], workType: 'implement' }] },
      ['test'],
      ['execution'],
      10,
      undefined,
      coverage,
    );
    expect(result.stories[0]?.workType).toBe('implement');
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
