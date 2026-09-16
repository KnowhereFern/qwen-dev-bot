import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import { collectRepositorySnapshot, RepositoryAssessor } from '../src/program/repository-assessor.js';
import type { PortfolioPlanningModel } from '../src/portfolio/planner.js';
import { makeTmp } from './helpers.js';

class AssessmentModel implements PortfolioPlanningModel {
  calls = 0;
  constructor(
    private readonly badEvidence = false,
    private readonly blankRisk = false,
  ) {}

  async completeJson<T>(): Promise<{ value: T }> {
    this.calls += 1;
    if (this.calls <= 4) {
      return { value: {
        summary: 'Evidence reviewed',
        findings: [{
          capability: 'Health route', status: 'partial', rationale: 'Source exists but runtime is unverified',
          evidence: [{ kind: 'file', locator: this.badEvidence ? 'invented.ts' : 'server.ts', summary: 'Health source' }],
        }],
        risks: this.blankRisk ? [null, '', '   '] : [],
      } as T };
    }
    return { value: { coverage: [{
      id: 'HEALTH', requirement: 'Expose health', status: 'partial', rationale: 'Runtime is unverified',
      evidence: [{ kind: 'file', locator: 'server.ts', summary: 'Health source' }],
    }] } as T };
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
      : { value: { coverage: [{ id: 'HEALTH', requirement: 'Health', status: 'implemented', rationale: 'Claimed', evidence }] } as T };
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
    expect(assessment.coverage[0]).toMatchObject({ id: 'HEALTH', status: 'partial' });
    expect(assessment.coverage[0]?.evidence[0]?.commitSha).toBe(assessment.commitSha);
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
});

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
