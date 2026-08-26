import { describe, expect, it } from 'vitest';
import type { TaskSpec } from '../src/core/types.js';
import { parseNormalizedSpec, renderNormalizedBody } from '../src/intake/normalizer.js';

const source = {
  number: 41,
  title: 'Example task',
  body: 'Implement it.',
  author: 'owner',
  labels: [],
  url: 'https://github.example.test/owner/repo/issues/41',
  state: 'open' as const,
};

function validSpec(): TaskSpec {
  return {
    goal: 'Implement the example.',
    source: { kind: 'user', author: 'owner', url: source.url },
    acceptanceCriteria: ['The example works.'],
    constraints: [],
    requiredGateIds: ['test'],
    rewardCriterionIds: ['execution'],
    risk: 'low',
    dependencies: [2],
    rollback: 'Revert the task commit.',
  };
}

describe('normalized task markers', () => {
  it('round trips a structurally valid task specification', () => {
    expect(parseNormalizedSpec(renderNormalizedBody(source, validSpec()))).toEqual(validSpec());
  });

  it('rejects a marker with invalid source authority or dependency data', () => {
    const malformed = {
      ...validSpec(),
      source: { kind: 'instructions-from-issue' },
      dependencies: ['2'],
    };
    const body = `<!-- qwen-harness-spec:v1 ${Buffer.from(JSON.stringify(malformed)).toString('base64url')} -->`;
    expect(parseNormalizedSpec(body)).toBeNull();
  });
});
