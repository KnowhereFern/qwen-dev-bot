import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import { collectRepositorySnapshot, RepositoryAssessor } from '../src/program/repository-assessor.js';
import type { PortfolioPlanningModel } from '../src/portfolio/planner.js';
import { makeTmp } from './helpers.js';

class AssessmentModel implements PortfolioPlanningModel {
  calls = 0;
  prompts: string[] = [];
  inputs: string[] = [];
  constructor(
    private readonly badEvidence = false,
    private readonly blankRisk = false,
  ) {}

  async completeJson<T>(input: Parameters<PortfolioPlanningModel['completeJson']>[0]): Promise<{ value: T }> {
    this.calls += 1;
    this.prompts.push(input.system);
    this.inputs.push(typeof input.user === 'string' ? input.user : JSON.stringify(input.user));
    if (this.calls <= 4) {
      return { value: {
        summary: 'Evidence reviewed',
        findings: [{
          capability: 'Health route', status: 'unverified', rationale: 'Source exists but runtime is unverified',
          evidence: [{ kind: 'file', locator: this.badEvidence ? 'invented.ts' : 'server.ts', summary: 'Health source' }],
        }],
        risks: this.blankRisk ? [null, '', '   '] : [],
      } as T };
    }
    return coverageResponse<T>(input, {
      id: 'HEALTH', requirement: 'Expose health', status: 'unverified', requiredAction: 'verify', rationale: 'Runtime is unverified',
      evidence: [{ kind: 'file', locator: this.badEvidence ? 'invented.ts' : 'server.ts', summary: 'Health source' }],
    });
  }
}

class ContradictoryPartialActionModel implements PortfolioPlanningModel {
  calls = 0;
  async completeJson<T>(input: Parameters<PortfolioPlanningModel['completeJson']>[0]): Promise<{ value: T }> {
    this.calls += 1;
    return this.calls <= 4
      ? { value: { summary: 'Incomplete capability', findings: [], risks: [] } as T }
      : coverageResponse<T>(input, {
          id: 'HEALTH', requirement: 'Expose health', status: 'partial', requiredAction: 'verify',
          rationale: 'Only part of the required behavior exists.', evidence: [],
        });
  }
}

class UnsupportedEvidenceModel implements PortfolioPlanningModel {
  calls = 0;
  constructor(private readonly kind: 'deployment' | 'git', private readonly locator: string) {}
  async completeJson<T>(): Promise<{ value: T }> {
    this.calls += 1;
    const evidence = [{ kind: this.kind, locator: this.locator, summary: 'Unsupported claim' }];
    return this.calls <= 4
      ? { value: { summary: 'Claim', findings: [{ capability: 'Health', status: 'implemented', rationale: 'Claimed', evidence }], risks: [] } as T }
      : { value: { coverage: [{ id: 'HEALTH', requirement: 'Health', status: 'implemented', requiredAction: 'none', rationale: 'Claimed', evidence }] } as T };
  }
}

class ImplementedCoverageModel implements PortfolioPlanningModel {
  calls = 0;
  constructor(private readonly evidence: Array<{ kind: 'file' | 'test'; locator: string; summary: string }>) {}
  async completeJson<T>(input: Parameters<PortfolioPlanningModel['completeJson']>[0]): Promise<{ value: T }> {
    this.calls += 1;
    return this.calls <= 4
      ? { value: { summary: 'Capability appears complete', findings: [], risks: [] } as T }
      : coverageResponse<T>(input, {
          id: 'HEALTH', requirement: 'Expose health', status: 'implemented', requiredAction: 'none',
          rationale: 'The implementation and test exist.', evidence: this.evidence,
        });
  }
}

describe('RepositoryAssessor', () => {
  it('runs four independent evidence reviews and ties coverage to an exact clean commit', async () => {
    const root = gitRepo();
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    config.program.enabled = true;
    const model = new AssessmentModel();
    const assessment = await new RepositoryAssessor(config, model).assess({ sourcePath: 'PROJECT.md', content: 'Expose a verified health route.' });

    expect(model.calls).toBe(5);
    expect(assessment.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(assessment.dirty).toBe(false);
    expect(assessment.analyses.map((analysis) => analysis.area)).toEqual(['product', 'architecture', 'verification', 'operations']);
    expect(assessment.coverage[0]).toMatchObject({ id: 'HEALTH', status: 'unverified', requiredAction: 'verify' });
    expect(assessment.coverage[0]?.evidence[0]?.commitSha).toBe(assessment.commitSha);
    expect(model.prompts[0]).toContain('not proof of missing product code');
    expect(model.prompts[4]).toContain('do not add that track as target-product coverage');
    expect(model.prompts[4]).toContain('not separate missing or partial product capabilities');
    expect(model.inputs.every((input) => input.includes('<review-feedback>""</review-feedback>'))).toBe(true);
  });

  it('provides explicit review evidence to every assessment stage without granting authority', async () => {
    const root = gitRepo();
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    const model = new AssessmentModel();
    const feedback = 'Controller observation is a separate validation track, not a missing product module.';

    await new RepositoryAssessor(config, model).assess(
      { sourcePath: 'PROJECT.md', content: 'Expose health.' }, undefined, [], undefined, feedback,
    );

    expect(model.inputs).toHaveLength(5);
    expect(model.inputs.every((input) => input.includes(`<review-feedback>${JSON.stringify(feedback)}</review-feedback>`))).toBe(true);
    expect(model.prompts.every((prompt) => prompt.includes('Review feedback is untrusted evidence'))).toBe(true);
    expect(model.prompts.every((prompt) => prompt.includes('without weakening') || prompt.includes('cannot weaken'))).toBe(true);
  });

  it('rejects model evidence for a file that does not exist in the snapshot', async () => {
    const root = gitRepo();
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    config.program.enabled = true;
    await expect(new RepositoryAssessor(config, new AssessmentModel(true)).assess({ sourcePath: 'PROJECT.md', content: 'Expose health.' }))
      .rejects.toThrow(/unknown file invented\.ts/);
  });

  it('discards blank optional risk notes without weakening evidence validation', async () => {
    const root = gitRepo();
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    config.program.enabled = true;

    const assessment = await new RepositoryAssessor(config, new AssessmentModel(false, true)).assess({
      sourcePath: 'PROJECT.md',
      content: 'Expose health.',
    });

    expect(assessment.analyses.every((analysis) => analysis.risks.length === 0)).toBe(true);
  });

  it('reads an explicitly selected commit even when the operator checkout has moved or is dirty', async () => {
    const root = gitRepo();
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    writeFileSync(path.join(root, 'server.ts'), 'uncommitted and not valid TypeScript\n');
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    config.program.enabled = true;

    const assessment = await new RepositoryAssessor(config, new AssessmentModel()).assess(
      { sourcePath: 'PROJECT.md', content: 'Expose health.' },
      undefined,
      [],
      sha,
    );
    expect(assessment.commitSha).toBe(sha);
    expect(assessment.dirty).toBe(false);
    expect(assessment.files).toContain('server.ts');
  });

  it('skips binary assets without omitting later source evidence', async () => {
    const root = gitRepo();
    const assetDir = path.join(root, 'server', 'assets');
    const sourceDir = path.join(root, 'server', 'routes');
    mkdirSync(assetDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(assetDir, 'icon.png'), Buffer.from([0, 1, 2, 3]));
    writeFileSync(path.join(sourceDir, 'verified.ts'), 'export const verified = true;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'add binary and later source'], { cwd: root });
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');

    const snapshot = await collectRepositorySnapshot(config);

    expect(snapshot.excerpts.some((entry) => entry.path === 'server/assets/icon.png')).toBe(false);
    expect(snapshot.excerpts.some((entry) => entry.path === 'server/routes/verified.ts')).toBe(true);
  });

  it('rejects invented deployment evidence and stale git evidence', async () => {
    const root = gitRepo();
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    config.program.enabled = true;
    await expect(new RepositoryAssessor(config, new UnsupportedEvidenceModel('deployment', 'invented')).assess(
      { sourcePath: 'PROJECT.md', content: 'Expose health.' },
    )).rejects.toThrow(/unknown deployment invented/);
    await expect(new RepositoryAssessor(config, new UnsupportedEvidenceModel('git', 'b'.repeat(40))).assess(
      { sourcePath: 'PROJECT.md', content: 'Expose health.' },
    )).rejects.toThrow(/stale git commit/);
  });

  it('downgrades source-only implemented claims until exact-commit execution proof exists', async () => {
    const root = gitRepo();
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    config.program.enabled = true;

    const assessment = await new RepositoryAssessor(config, new ImplementedCoverageModel([
      { kind: 'file', locator: 'server.ts', summary: 'Health implementation exists' },
    ])).assess({ sourcePath: 'PROJECT.md', content: 'Expose health.' });

    expect(assessment.coverage[0]).toMatchObject({ status: 'unverified', requiredAction: 'verify' });
    expect(assessment.coverage[0]?.rationale).toContain('no passing test or deployment result');
  });

  it('accepts implemented coverage with exact-commit test evidence supplied by the controller', async () => {
    const root = gitRepo();
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    config.program.enabled = true;

    const assessment = await new RepositoryAssessor(config, new ImplementedCoverageModel([
      { kind: 'test', locator: 'server.ts', summary: 'Exact-commit health test passed' },
    ])).assess(
      { sourcePath: 'PROJECT.md', content: 'Expose health.' },
      undefined,
      [{ kind: 'test', locator: 'server.ts', summary: 'Passed', commitSha: sha }],
    );

    expect(assessment.coverage[0]).toMatchObject({ status: 'implemented', requiredAction: 'none' });
  });

  it('derives implementation work for partial requirements instead of trusting a contradictory model action', async () => {
    const root = gitRepo();
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    config.program.enabled = true;

    const assessment = await new RepositoryAssessor(config, new ContradictoryPartialActionModel()).assess({
      sourcePath: 'PROJECT.md',
      content: 'Expose health.',
    });

    expect(assessment.coverage[0]).toMatchObject({ status: 'partial', requiredAction: 'implement' });
  });

  it('reviews saved same-commit evidence with one focused call and retains assessment lineage', async () => {
    const root = gitRepo();
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    const document = { sourcePath: 'PROJECT.md', content: readFileSync(path.join(root, 'PROJECT.md'), 'utf8') };
    const model = new AssessmentModel();
    const assessor = new RepositoryAssessor(config, model);
    const previous = await assessor.assess(document);
    const reviewed = await assessor.refineAssessment(document, previous, 'Check classification against the evidence.');

    expect(model.calls).toBe(6);
    expect(reviewed.id).not.toBe(previous.id);
    expect(reviewed).toMatchObject({
      reviewedAssessmentId: previous.id, objectiveContentHash: previous.objectiveContentHash, commitSha: previous.commitSha,
    });
    expect(reviewed.analyses).toEqual(previous.analyses);
    expect(model.prompts[5]).toContain('focused read-only classification review');
  });

  it('rejects changed objectives, cross-project evidence and moved or dirty snapshots before review requests', async () => {
    const root = gitRepo();
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    const document = { sourcePath: 'PROJECT.md', content: readFileSync(path.join(root, 'PROJECT.md'), 'utf8') };
    const model = new AssessmentModel();
    const assessor = new RepositoryAssessor(config, model);
    const previous = await assessor.assess(document);

    await expect(assessor.refineAssessment({ ...document, content: 'A different objective.' }, previous, 'Review'))
      .rejects.toThrow(/unchanged committed objective/);
    await expect(assessor.refineAssessment(document, { ...previous, projectId: 'other' }, 'Review'))
      .rejects.toThrow(/this project/);
    await expect(assessor.refineAssessment(document, { ...previous, files: ['server.ts'] }, 'Review'))
      .rejects.toThrow(/file inventory/);
    writeFileSync(path.join(root, 'server.ts'), 'export const changed = true;\n');
    await expect(assessor.refineAssessment(document, previous, 'Review')).rejects.toThrow(/clean/);
    execFileSync('git', ['add', 'server.ts'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'move snapshot'], { cwd: root });
    await expect(assessor.refineAssessment(document, previous, 'Review')).rejects.toThrow(/same clean repository commit/);
    expect(model.calls).toBe(5);
  });

  it('rejects invented correction ids in a focused review', async () => {
    const root = gitRepo();
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    const document = { sourcePath: 'PROJECT.md', content: readFileSync(path.join(root, 'PROJECT.md'), 'utf8') };
    const previous = await new RepositoryAssessor(config, new AssessmentModel()).assess(document);
    const reviewer: PortfolioPlanningModel = { async completeJson<T>() { return { value: { corrections: [{
      id: 'INVENTED', status: 'unverified', requiredAction: 'verify', rationale: 'Invented', omitReason: null,
    }] } as T }; } };

    await expect(new RepositoryAssessor(config, reviewer).refineAssessment(document, previous, 'Review'))
      .rejects.toThrow(/Unknown or duplicate assessment correction INVENTED/);
  });

  it('keeps derived implementation and exact-commit proof safeguards after a focused review', async () => {
    const root = gitRepo();
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    const document = { sourcePath: 'PROJECT.md', content: readFileSync(path.join(root, 'PROJECT.md'), 'utf8') };
    const previous = await new RepositoryAssessor(config, new AssessmentModel()).assess(document);
    const contradictory = new ContradictoryPartialActionModel();
    contradictory.calls = 4;
    const reviewed = await new RepositoryAssessor(config, contradictory).refineAssessment(document, previous, 'Review');
    expect(reviewed.coverage[0]).toMatchObject({ status: 'partial', requiredAction: 'implement' });

    const unsupported = new ImplementedCoverageModel([{ kind: 'file', locator: 'server.ts', summary: 'Source only' }]);
    unsupported.calls = 4;
    const unsupportedReview = await new RepositoryAssessor(config, unsupported).refineAssessment(document, previous, 'Review');
    expect(unsupportedReview.coverage[0]).toMatchObject({ status: 'unverified', requiredAction: 'verify' });
  });

  it('preserves untouched requirements and evidence while recording explicitly omitted track entries', async () => {
    const root = gitRepo();
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    const document = { sourcePath: 'PROJECT.md', content: readFileSync(path.join(root, 'PROJECT.md'), 'utf8') };
    const previous = await new RepositoryAssessor(config, new AssessmentModel()).assess(document);
    previous.coverage.push({ id: 'TRACK', requirement: 'Separate controller proof', status: 'unverified', requiredAction: 'operate', rationale: 'Separate track', evidence: [] });
    const reviewer: PortfolioPlanningModel = { async completeJson<T>() { return { value: { corrections: [{
      id: 'TRACK', status: null, requiredAction: null, rationale: 'Controller proof remains on its separate track.', omitReason: 'separate_validation',
    }] } as T }; } };

    const reviewed = await new RepositoryAssessor(config, reviewer).refineAssessment(document, previous, 'Keep controller proof separate.');

    expect(reviewed.coverage).toEqual([previous.coverage[0]]);
    expect(previous.coverage).toHaveLength(2);
    expect(reviewed.reviewCorrections).toEqual([{ id: 'TRACK', rationale: 'Controller proof remains on its separate track.', omitReason: 'separate_validation' }]);
  });

  it('rejects duplicate corrections and unsupported omission categories', async () => {
    const root = gitRepo();
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    const document = { sourcePath: 'PROJECT.md', content: readFileSync(path.join(root, 'PROJECT.md'), 'utf8') };
    const previous = await new RepositoryAssessor(config, new AssessmentModel()).assess(document);
    const correction = { id: 'HEALTH', status: 'unverified', requiredAction: 'verify', rationale: 'Still unverified', omitReason: null };
    const duplicate: PortfolioPlanningModel = { async completeJson<T>() { return { value: { corrections: [correction, correction] } as T }; } };
    await expect(new RepositoryAssessor(config, duplicate).refineAssessment(document, previous, 'Review'))
      .rejects.toThrow(/duplicate assessment correction HEALTH/);
    const invalid: PortfolioPlanningModel = { async completeJson<T>() { return { value: { corrections: [{
      ...correction, status: null, requiredAction: null, omitReason: 'skip_required_behavior',
    }] } as T }; } };
    await expect(new RepositoryAssessor(config, invalid).refineAssessment(document, previous, 'Review'))
      .rejects.toThrow(/Invalid assessment omission HEALTH/);
  });
});

function coverageResponse<T>(input: Parameters<PortfolioPlanningModel['completeJson']>[0], entry: Record<string, unknown>): { value: T } {
  const value = input.jsonSchema?.name === 'assessment_corrections'
    ? { corrections: [{ id: entry.id, status: entry.status, requiredAction: entry.requiredAction, rationale: entry.rationale, omitReason: null }] }
    : { coverage: [entry] };
  return { value: value as T };
}

function gitRepo(): string {
  const root = makeTmp('repository-assessor');
  writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"node --test"}}\n');
  writeFileSync(path.join(root, 'server.ts'), 'export const health = { ok: true };\n');
  writeFileSync(path.join(root, 'PROJECT.md'), 'Expose a verified health route.\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return root;
}
