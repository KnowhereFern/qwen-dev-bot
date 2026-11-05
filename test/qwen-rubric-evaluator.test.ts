import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { defaultProjectConfig } from '../src/core/config.js';
import type { QwenApiClient } from '../src/qwen/qwen-api.js';
import { QwenRubricEvaluator } from '../src/rewards/evaluators.js';
import type { RewardContext } from '../src/rewards/engine.js';
import { runProcess } from '../src/runtime/safe-process.js';
import { makeTmp } from './helpers.js';

vi.mock('../src/runtime/safe-process.js', () => ({ runProcess: vi.fn() }));
const claim = { criterionIndex: 0, filePath: 'payment.ts', line: 2, gateId: null, note: 'payment.ts:2 rejects live keys' };
const verdict = { score: 1, confidence: 1, reason: 'src/payment.ts and tests/payment.test.ts verify metadata', blockingFindings: [], evidenceClaims: [claim] };

function fixture() {
  const worktree = makeTmp('repository-rubric');
  writeFileSync(`${worktree}/payment.ts`, 'line one\nrejects live keys\n');
  const config = defaultProjectConfig(worktree, 'fixture', 'owner/repo');
  const context = {
    config, worktree, commitSha: 'exact-candidate-sha', changedFiles: [], diff: '', gateResults: [],
    task: { title: 'Verify checkout', spec: { goal: 'Verify existing behavior', acceptanceCriteria: ['Reject live keys'], constraints: ['No code changes; verification only'], rollback: 'No changes made', technologyDecisions: [], deploymentDecisions: [] } },
  } as unknown as RewardContext;
  const completeJson = vi.fn().mockResolvedValue({ value: verdict, raw: JSON.stringify(verdict), usage: {} });
  const api = { model: config.qwen.model, completeJson } as unknown as QwenApiClient;
  const criterion = config.rewards.criteria.find((item) => item.modality === 'rubric')!;
  return { context, criterion, completeJson, evaluator: new QwenRubricEvaluator(api, { envKey: 'CUSTOM_REVIEW_KEY', apiKey: 'fixture-secret' }) };
}

function output(value: unknown = verdict, timedOut = false) {
  vi.mocked(runProcess).mockImplementation(async (options) => {
    options.onStdout?.(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: value })}\n`);
    return { command: options.command, args: options.args ?? [], cwd: options.cwd, exitCode: 0, timedOut, aborted: false, durationMs: 1, stdout: '', stderr: '' };
  });
}

describe('repository-aware empty-diff rubric', () => {
  beforeEach(() => { vi.mocked(runProcess).mockReset(); });

  it('inspects the exact candidate while preserving criterion, modality, sandbox and custom credential', async () => {
    const { context, criterion, completeJson, evaluator } = fixture();
    output();
    const result = await evaluator.evaluate(criterion, context);
    expect(completeJson).not.toHaveBeenCalled();
    expect(result).toMatchObject(verdict);
    expect(result.evidence[0]).toMatchObject({ modality: 'rubric', data: { criterion: criterion.id, commitSha: context.commitSha } });
    const options = vi.mocked(runProcess).mock.calls[0]![0];
    expect(options.cwd).toBe(context.worktree);
    expect(options.env?.CUSTOM_REVIEW_KEY).toBe('fixture-secret');
    const prompt = options.args![options.args!.indexOf('--prompt') + 1];
    expect(prompt).toContain(`Criterion: ${criterion.id}`);
    expect(prompt).toContain(`Commit: ${context.commitSha}`);
    expect(prompt).toContain('Reject live keys');
    expect(prompt).toContain('No code changes; verification only');
    expect(prompt).toContain('Frozen rollback: No changes made');
    expect(prompt).toContain('Missing required behavioral evidence must remain a blocking finding');
    expect(prompt).toContain('Do not invent a change requirement or waive an explicit requirement');
    expect(options.args).toContain('--sandbox');
    expect(options.args).toContain('--safe-mode');
    expect(options.args).toContain('agent,workflow,shell,write,edit');
    expect(options.args).toContain('create_sub_session,exec,run_shell_command,write_file,notebook_edit,web_fetch,web_search,exit_plan_mode,save_memory,skill');
  });

  it('supplies redacted, bounded gate excerpts without disguising failed or skipped gates', async () => {
    const { context, criterion, completeJson, evaluator } = fixture();
    const secret = `sk-${'a'.repeat(32)}`;
    context.changedFiles = ['source.ts'];
    context.diff = '+ change';
    context.gateResults = Array.from({ length: 8 }, (_, index) => ({
      id: `gate-${index}`, kind: 'unit', command: ['fixture-check'], required: true, applicable: index !== 1,
      ok: index !== 0, exitCode: index === 0 ? 1 : 0, durationMs: 1,
      stdout: `${'a'.repeat(3_000)} ${secret} verified 26 tests`, stderr: `${'b'.repeat(3_000)} failing detail`, evidenceHash: `hash-${index}`,
    }));
    await evaluator.evaluate(criterion, context);
    const prompt = completeJson.mock.calls[0]![0].user as string;
    expect(prompt).not.toContain(secret);
    expect(prompt).toContain('[REDACTED] verified 26 tests');
    expect(prompt).toContain('gate-0: FAIL; required=true; exit=1 (hash-0)');
    expect(prompt).toContain('gate-1: NOT APPLICABLE');
    expect(prompt).toContain('[TRUNCATED:');
    expect(prompt).toContain('failing detail');
    expect(prompt).toContain('gate-7: PASS');
    expect(prompt.length).toBeLessThan(19_000);
  });

  it('preserves negative repository verdicts instead of treating no changes as success', async () => {
    const { context, criterion, evaluator } = fixture();
    output({ ...verdict, score: 0, blockingFindings: ['No provider verification evidence'] });
    expect(await evaluator.evaluate(criterion, context)).toMatchObject({ score: 0, blockingFindings: ['No provider verification evidence'] });
  });

  it('fails closed on a timed out repository review even with a positive verdict', async () => {
    const { context, criterion, evaluator } = fixture();
    output(verdict, true);
    await expect(evaluator.evaluate(criterion, context)).rejects.toThrow('review failed');
  });

  it.each([{ changedFiles: ['src/payment.ts'], diff: '' }, { changedFiles: [], diff: '+ changed' }])('retains the API rubric for nonempty change evidence %j', async (change) => {
    const { context, criterion, evaluator, completeJson } = fixture();
    await evaluator.evaluate(criterion, { ...context, ...change });
    expect(completeJson).toHaveBeenCalledOnce();
    expect(runProcess).not.toHaveBeenCalled();
  });

  it('sends the evidence contract and schema to the API judge for indexed criteria', async () => {
    const { context, criterion, evaluator, completeJson } = fixture();
    const result = await evaluator.evaluate(criterion, { ...context, changedFiles: ['payment.ts'], diff: '+ change' });
    expect(result).toMatchObject(verdict);
    const call = completeJson.mock.calls[0]![0];
    expect(call.user).toContain('criterionIndex 0: Reject live keys');
    expect(call.user).toContain('nonblank note explaining how the cited file line or gate demonstrates the criterion');
    expect(call.jsonSchema).toMatchObject({ name: 'reviewVerdict' });
    expect(JSON.stringify(call.jsonSchema.schema)).toContain('evidenceClaims');
  });

  it('fails the API judge evaluation normally when a claim is missing', async () => {
    const { context, criterion, evaluator, completeJson } = fixture();
    completeJson.mockResolvedValue({ value: { ...verdict, evidenceClaims: [] }, raw: '', usage: {} });
    const result = await evaluator.evaluate(criterion, { ...context, changedFiles: ['payment.ts'], diff: '+ change' });
    expect(result.score).toBe(0);
    expect(result.blockingFindings).toContain('evidence claim rejected: missing claim for criterionIndex 0');
  });

  it('accepts a passing-gate claim from the API judge', async () => {
    const { context, criterion, evaluator, completeJson } = fixture();
    context.gateResults = [{
      id: 'gate-unit', kind: 'unit', required: true, applicable: true, ok: true, exitCode: 0,
      stdout: 'ok', stderr: '', durationMs: 1, command: [], evidenceHash: 'hash',
    }];
    completeJson.mockResolvedValue({
      value: { ...verdict, evidenceClaims: [{ criterionIndex: 0, filePath: null, line: null, gateId: 'gate-unit', note: 'gate-unit proves the criterion' }] },
      raw: '', usage: {},
    });
    expect(await evaluator.evaluate(criterion, { ...context, changedFiles: ['payment.ts'], diff: '+ change' })).toMatchObject({ score: 1 });
  });

  it('keeps a negative API verdict while appending missing-claim findings', async () => {
    const { context, criterion, evaluator, completeJson } = fixture();
    completeJson.mockResolvedValue({
      value: { score: 0, confidence: 0.7, reason: 'No provider verification evidence', blockingFindings: ['No provider verification evidence'], evidenceClaims: [] },
      raw: '', usage: {},
    });
    const result = await evaluator.evaluate(criterion, { ...context, changedFiles: ['payment.ts'], diff: '+ change' });
    expect(result).toMatchObject({ score: 0, confidence: 0.7, reason: 'No provider verification evidence' });
    expect(result.blockingFindings).toEqual(['No provider verification evidence', 'evidence claim rejected: missing claim for criterionIndex 0']);
  });

  it('filters the neutral "No blocking findings" sentinel but keeps a real finding', async () => {
    const { context, criterion, evaluator, completeJson } = fixture();
    completeJson.mockResolvedValue({
      value: { ...verdict, blockingFindings: [' No Blocking Findings.', 'No provider verification evidence'] },
      raw: '', usage: {},
    });
    const result = await evaluator.evaluate(criterion, { ...context, changedFiles: ['payment.ts'], diff: '+ change' });
    expect(result.blockingFindings).toEqual(['No provider verification evidence']);
  });

  it('keeps API rubric compatibility for tasks without acceptance criteria', async () => {
    const { context, criterion, evaluator, completeJson } = fixture();
    context.task.spec = { ...context.task.spec!, acceptanceCriteria: [] };
    completeJson.mockResolvedValue({ value: { score: 1, confidence: 1, reason: 'ok', blockingFindings: [] }, raw: '', usage: {} });
    expect(await evaluator.evaluate(criterion, { ...context, changedFiles: ['payment.ts'], diff: '+ change' })).toMatchObject({ score: 1 });
    const call = completeJson.mock.calls[0]![0];
    expect(call.user).toContain('no indexed acceptance criteria');
  });
});
