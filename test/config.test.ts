import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProjectConfig, discoverGates, validateProjectConfig } from '../src/core/config.js';
import { makeTmp } from './helpers.js';

describe('project configuration invariants', () => {
  it('discovers aggregate checks and browser tests without rerunning a covered unit suite', () => {
    const root = makeTmp('config-discovery');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      scripts: {
        check: 'node scripts/check-syntax.mjs && npm run test && npm run check:budget',
        test: 'node --test',
        'test:browser': 'playwright test',
      },
    }));

    expect(discoverGates(root).map((gate) => [gate.id, gate.kind])).toEqual([
      ['check', 'custom'],
      ['test-browser', 'e2e'],
    ]);
  });

  it('accepts the generated Qwen-native template configuration', () => {
    const config = defaultProjectConfig(makeTmp('config-valid'), 'fixture', 'owner/fixture');
    expect(config.worker.autoMerge).toBe(true);
    expect(validateProjectConfig(config)).toBe(config);
  });

  it('rejects multiple mutating workers and duplicate deterministic gates', () => {
    const multipleWriters = defaultProjectConfig(makeTmp('config-writers'), 'fixture', 'owner/fixture');
    multipleWriters.worker.maxConcurrentMutations = 2;
    expect(() => validateProjectConfig(multipleWriters)).toThrow('single-writer invariant');

    const duplicateGates = defaultProjectConfig(makeTmp('config-gates'), 'fixture', 'owner/fixture');
    duplicateGates.gates = [
      { id: 'test', kind: 'unit', command: 'npm', args: ['test'], required: true, timeoutMs: 1_000 },
      { id: 'test', kind: 'unit', command: 'npm', args: ['test'], required: true, timeoutMs: 1_000 },
    ];
    expect(() => validateProjectConfig(duplicateGates)).toThrow('invalid gate test');
  });

  it('requires the GitHub repository identity used by the control plane', () => {
    const missingRepository = defaultProjectConfig(makeTmp('config-repository'));
    expect(() => validateProjectConfig(missingRepository)).toThrow(/githubRepo is required/);
  });

  it('validates the per-run MCP server allowlist', () => {
    const config = defaultProjectConfig(makeTmp('config-mcp'), 'fixture', 'owner/fixture');
    config.qwen.allowedMcpServers = ['qwen-mm-plugins-core', 'project-read-*'];
    expect(validateProjectConfig(config)).toBe(config);
    config.qwen.allowedMcpServers.push('project-read-*');
    expect(() => validateProjectConfig(config)).toThrow(/allowedMcpServers/);
  });

  it('validates the configured Qwen credential environment name', () => {
    const config = defaultProjectConfig(makeTmp('config-credential'), 'fixture', 'owner/fixture');
    config.qwen.credentialEnvKey = 'CUSTOM_QWEN_API_KEY';
    expect(validateProjectConfig(config)).toBe(config);
    config.qwen.credentialEnvKey = 'bad-key';
    expect(() => validateProjectConfig(config)).toThrow(/credentialEnvKey/);
  });

  it('keeps technology policy approval separate from live deployment authority', () => {
    const config = defaultProjectConfig(makeTmp('config-technologies'), 'fixture', 'owner/fixture');
    expect(config.technologyPolicy.approved).toContainEqual({ category: 'hosting', technology: 'Vercel' });
    config.technologyPolicy.authority = 'production' as 'build-test-only';
    expect(() => validateProjectConfig(config)).toThrow(/technologyPolicy/);
  });

  it.each(['token-plan-personal', 'token-plan-team'] as const)('requires the Token Plan endpoint for %s', (billingPlan) => {
    const config = defaultProjectConfig(makeTmp(`config-${billingPlan}`), 'fixture', 'owner/fixture');
    config.qwen.billingPlan = billingPlan;
    config.qwen.credentialEnvKey = 'BAILIAN_TOKEN_PLAN_API_KEY';
    expect(() => validateProjectConfig(config)).toThrow(/Token Plan base URL/);
    config.qwen.baseUrl = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
    expect(validateProjectConfig(config)).toBe(config);
  });

  it('refuses to run the unattended implementer without the Qwen sandbox', () => {
    const config = defaultProjectConfig(makeTmp('config-sandbox'), 'fixture', 'owner/fixture');
    config.qwen.sandbox = false;
    expect(() => validateProjectConfig(config)).toThrow(/sandbox must remain enabled/);
  });

  it('keeps the supervisor non-mutating and its saved-workflow permission representable', () => {
    const mutatingSupervisor = defaultProjectConfig(makeTmp('config-supervisor'), 'fixture', 'owner/fixture');
    (mutatingSupervisor.qwen as { approvalMode: string }).approvalMode = 'auto-edit';
    expect(() => validateProjectConfig(mutatingSupervisor)).toThrow(/must remain auto/);

    const unsafeRoot = defaultProjectConfig('/tmp/config,unsafe', 'fixture', 'owner/fixture');
    expect(() => validateProjectConfig(unsafeRoot)).toThrow(/scoped workflow permissions/);
  });

  it('keeps nested delegation disabled and workflow budgets within hard bounds', () => {
    const nested = defaultProjectConfig(makeTmp('config-nesting'), 'fixture', 'owner/fixture');
    nested.qwen.maxSubagentDepth = 2;
    expect(() => validateProjectConfig(nested)).toThrow(/must remain 1/);

    const tooLong = defaultProjectConfig(makeTmp('config-workflow-time'), 'fixture', 'owner/fixture');
    tooLong.qwen.maxWorkflowSeconds = 3_601;
    expect(() => validateProjectConfig(tooLong)).toThrow(/cannot exceed qwen.maxWallTime/);

    const tooManyTurns = defaultProjectConfig(makeTmp('config-workflow-turns'), 'fixture', 'owner/fixture');
    tooManyTurns.qwen.maxWorkflowSubagentTurns = 501;
    expect(() => validateProjectConfig(tooManyTurns)).toThrow(/hard ceilings/);
  });
});
