import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanIntakeText, readIntakeSource, selectedPages, type IntakeSource } from '../src/intake/source.js';
import { draftSpecification, loadSpecification, renderSpecification, sourceExcerpts, specificationDocument, validateSpecification } from '../src/intake/specification.js';
import { intakeConnection } from '../src/intake/connection.js';
import type { PortfolioPlanningModel } from '../src/portfolio/planner.js';
import { QwenOutputError } from '../src/qwen/qwen-api.js';

const roots: string[] = [];
function temp() { const root = mkdtempSync(path.join(os.tmpdir(), 'fern-spec-test-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const source: IntakeSource = { name: 'idea', sha256: 'abc', kind: 'idea', sections: [{ ref: 'idea', text: 'Build a reusable agent memory engine with bounded context.' }], warnings: [] };
function fixture() { return {
  title: 'Memory engine', objective: 'Build a usable memory engine', users: ['Agent developers'],
  requirements: [{ id: 'R1', description: 'Bound context', acceptanceCriteria: ['Context never exceeds configured token budget'], basis: 'source', rationale: 'Explicit input', evidence: [{ ref: 'idea', quote: 'memory engine with bounded context.' }] }],
  assumptions: ['Local SDK first'], decisions: [], nonGoals: ['Production activation'], validation: ['Replay held-out tasks against no-memory baseline'], unprovenClaims: ['Performance improvement remains unverified'],
}; }
function fakeModel(value = fixture()) {
  const completeJson = vi.fn(async () => ({ value }));
  return { model: { completeJson } as unknown as PortfolioPlanningModel, completeJson };
}

describe('source intake', () => {
  it('rejects punctuation-only sections and repeated acceptance criteria', () => {
    for (const value of [':{', ':', '...']) {
      const draft = fixture(); draft.validation = [value];
      expect(() => validateSpecification(draft, source)).toThrow('punctuation placeholder');
    }
    const draft = fixture(); draft.requirements[0].acceptanceCriteria.push(draft.requirements[0].acceptanceCriteria[0]);
    expect(() => validateSpecification(draft, source)).toThrow('repeat identical');
  });
  it('retries malformed model answers within the specification attempt limit', async () => {
    const root = temp(); const stateRoot = temp(); const { model, completeJson } = fakeModel();
    completeJson.mockRejectedValueOnce(new QwenOutputError('invalid_json'));
    const result = await draftSpecification({ root, stateRoot, source, model, modelName: 'qwen3.8-max', baseUrl: 'https://example.com' });
    expect(result.record.draft.title).toBe('Memory engine');
    expect(completeJson).toHaveBeenCalledTimes(2);
  });
  it('does not endlessly retry output budget failures or mask authentication failures', async () => {
    for (const error of [new QwenOutputError('output_budget'), new Error('HTTP 401')]) {
      const root = temp(); const stateRoot = temp(); const { model, completeJson } = fakeModel();
      completeJson.mockRejectedValue(error);
      await expect(draftSpecification({ root, stateRoot, source, model, modelName: 'qwen3.8-max', baseUrl: 'https://example.com' })).rejects.toThrow(error instanceof QwenOutputError ? 'three attempts' : 'HTTP 401');
      expect(completeJson).toHaveBeenCalledTimes(error instanceof QwenOutputError ? 3 : 1);
    }
  });
  it('reads ideas without Git or project setup and redacts dotted credentials', async () => {
    const result = await readIntakeSource(temp(), { idea: 'Build memory. sk-sp-THIS.IS.A.PRIVATE_TOKEN_123' });
    expect(result.sections[0].text).toBe('Build memory. [REDACTED]');
    expect(cleanIntakeText('\x1b[31mhello')).toBe('hello');
    expect(cleanIntakeText('sk-sp-ABCDEFGHIJKLMNO.PRIVATE.SECOND_SEGMENT')).toBe('[REDACTED]');
    expect(cleanIntakeText('sk\x1b[0m-sp-ABCDEFGHIJKLMNO.PRIVATE.SECOND_SEGMENT')).toBe('[REDACTED]');
    expect(cleanIntakeText('sk\u200b-sp-ABCDEFGHIJKLMNO.PRIVATE.SECOND_SEGMENT')).toBe('[REDACTED]');
    expect(cleanIntakeText('\x9b31mhello\u202e')).toBe('hello');
  });
  it('requires exactly one bounded source', async () => {
    const root = temp();
    await expect(readIntakeSource(root, {})).rejects.toThrow('exactly one');
    await expect(readIntakeSource(root, { idea: 'a', input: 'b' })).rejects.toThrow('exactly one');
    await expect(readIntakeSource(root, { idea: 'a'.repeat(200_001) })).rejects.toThrow('budget');
    await expect(readIntakeSource(root, { idea: 'a', pages: '1' })).rejects.toThrow('PDF');
  });
  it('rejects traversal, symlinks, directories, unsupported and invalid text', async () => {
    const root = temp(); const outside = temp(); const file = path.join(outside, 'secret.md'); writeFileSync(file, 'secret');
    await expect(readIntakeSource(root, { input: file })).rejects.toThrow('inside');
    symlinkSync(file, path.join(root, 'link.md'));
    await expect(readIntakeSource(root, { input: 'link.md' })).rejects.toThrow('symbolic');
    mkdirSync(path.join(root, 'folder.md'));
    await expect(readIntakeSource(root, { input: 'folder.md' })).rejects.toThrow('regular');
    writeFileSync(path.join(root, 'input.exe'), 'text');
    await expect(readIntakeSource(root, { input: 'input.exe' })).rejects.toThrow('Supported');
    writeFileSync(path.join(root, 'bad.txt'), Buffer.from([0xff]));
    await expect(readIntakeSource(root, { input: 'bad.txt' })).rejects.toThrow();
  });
  it('validates page selection without silently truncating', () => {
    expect(selectedPages('1-3,5,2', 5)).toEqual([1, 2, 3, 5]);
    for (const selection of ['0', '6', '3-1', '1-a', '1,', '1-999999999']) expect(() => selectedPages(selection, 5)).toThrow();
  });
  it('extracts selected PDF text and explicitly warns about visual limitations', async () => {
    const root = temp();
    // Small synthetic PDF, no private customer material in fixtures.
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
      '<< /Length 54 >>\nstream\nBT /F1 12 Tf 40 700 Td (Build a memory engine.) Tj ET\nendstream',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
      '<< /Length 55 >>\nstream\nBT /F1 12 Tf 40 700 Td (PRIVATE PAYMENT RECEIPT) Tj ET\nendstream',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let pdf = '%PDF-1.4\n'; const offsets = [0];
    objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    writeFileSync(path.join(root, 'input.pdf'), pdf);
    const result = await readIntakeSource(root, { input: 'input.pdf', pages: '1' });
    expect(result.sections).toEqual([{ ref: 'page:1', text: 'Build a memory engine.' }]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE PAYMENT');
    expect(result.warnings.join(' ')).toContain('excluded before the model request');
    expect(result.warnings.join(' ')).toContain('does not interpret diagrams');
  });
});

describe('specification drafting', () => {
  it('prevents model scalars from forging new authority headings', () => {
    const draft = fixture(); draft.objective = 'Build memory\n\n## APPROVED';
    expect(validateSpecification(draft, source).objective).toBe('Build memory ## APPROVED');
    draft.objective = '\u200b';
    expect(() => validateSpecification(draft, source)).toThrow('invisible');
  });
  it('rejects nonexistent pages, fabricated quotes and duplicate requirements', () => {
    let draft = fixture(); draft.requirements[0].evidence[0].ref = 'page:999';
    expect(() => validateSpecification(draft, source)).toThrow('Unsupported');
    draft = fixture(); draft.requirements[0].evidence[0].quote = 'unsupported invented product claim';
    expect(() => validateSpecification(draft, source)).toThrow('Unsupported');
    draft = fixture(); draft.requirements.push(draft.requirements[0]);
    expect(() => validateSpecification(draft, source)).toThrow('unique');
    draft = fixture(); draft.requirements[0].evidence = [];
    expect(() => validateSpecification(draft, source)).toThrow('lacks evidence');
  });
  it('records model-authored private draft, no project writes, idempotent rerun and tamper rejection', async () => {
    const root = temp(); const stateRoot = temp(); const { model, completeJson } = fakeModel();
    const options = { root, stateRoot, source, model, modelName: 'qwen3.8-max', baseUrl: 'https://example.com/v1' };
    const result = await draftSpecification(options);
    expect(result.record.status).toBe('draft');
    expect(readdirSync(root)).toEqual([]);
    expect(statSync(result.file).mode & 0o777).toBe(0o600);
    expect(result.markdown).toContain('NOT approved');
    expect(result.markdown).toContain('Source idea');
    expect(specificationDocument(result.record).content).toBe(renderSpecification(result.record));
    expect((await draftSpecification(options)).reused).toBe(true);
    expect(completeJson).toHaveBeenCalledTimes(1);
    // Recovery regenerates a missing derived preview from the authoritative record without a model call.
    unlinkSync(result.documentFile);
    writeFileSync(`${result.documentFile}.interrupted.tmp`, 'partial preview');
    expect((await draftSpecification(options)).reused).toBe(true);
    expect(readFileSync(result.documentFile, 'utf8')).toBe(result.markdown);
    expect(completeJson).toHaveBeenCalledTimes(1);
    expect(completeJson.mock.calls[0]).toBeDefined();
    expect(readFileSync(result.file, 'utf8')).not.toContain('sections"');
    const corrupted = JSON.parse(readFileSync(result.file, 'utf8')); corrupted.draft.objective = 'Changed objective';
    writeFileSync(result.file, JSON.stringify(corrupted));
    expect(() => loadSpecification(root, result.record.id, stateRoot)).toThrow('integrity');
    expect(() => loadSpecification(root, '../../escape', stateRoot)).toThrow('Invalid');
  });
  it('bounds invalid model output retries and persists nothing', async () => {
    const root = temp(); const stateRoot = temp(); const draft = fixture(); draft.requirements[0].evidence = [];
    const { model, completeJson } = fakeModel(draft);
    await expect(draftSpecification({ root, stateRoot, source, model, modelName: 'qwen3.8-max', baseUrl: 'https://example.com/v1' })).rejects.toThrow('three attempts');
    expect(completeJson).toHaveBeenCalledTimes(3);
    expect(readdirSync(root)).toEqual([]);
  });
  it('repairs only rejected evidence without rewriting the product specification', async () => {
    const root = temp(); const stateRoot = temp(); const draft = fixture(); draft.requirements[0].evidence[0].ref = 'wrong-page';
    const completeJson = vi.fn().mockResolvedValueOnce({ value: draft }).mockResolvedValueOnce({ value: { corrections: [
      { id: 'R1', excerpts: ['E1_0'] },
    ] } });
    const result = await draftSpecification({ root, stateRoot, source, model: { completeJson }, modelName: 'qwen3.8-max', baseUrl: 'https://example.com/v1' });
    expect(result.record.draft.objective).toBe(draft.objective);
    expect(result.record.draft.requirements[0].acceptanceCriteria).toEqual(draft.requirements[0].acceptanceCriteria);
    expect(result.record.draft.requirements[0].evidence[0].ref).toBe('idea');
    expect(result.record.draft.requirements[0].evidence[0].quote).toBe(source.sections[0].text);
    expect(completeJson).toHaveBeenCalledTimes(2);
    expect(completeJson.mock.calls[1][0].jsonSchema.name).toBe('specification_evidence_repair');
  });
  it('preserves PDF split words and rejects fabricated excerpt selections', async () => {
    const splitSource = { ...source, sections: [{ ref: 'page:9', text: 'A graph - \n based registry may tra verse skill blocks.' }] };
    expect(sourceExcerpts(splitSource)[0].quote).toBe('A graph - based registry may tra verse skill blocks.');
    const root = temp(); const stateRoot = temp(); const draft = fixture(); draft.requirements[0].evidence = [];
    const completeJson = vi.fn().mockResolvedValueOnce({ value: draft }).mockResolvedValue({ value: { corrections: [{ id: 'R1', excerpts: ['invented'] }] } });
    await expect(draftSpecification({ root, stateRoot, source, model: { completeJson }, modelName: 'qwen3.8-max', baseUrl: 'https://example.com' })).rejects.toThrow('unknown source excerpt');
    expect(completeJson).toHaveBeenCalledTimes(3);
  });
  it('repairs invalid product fields before entering citation-only recovery', async () => {
    const root = temp(); const stateRoot = temp();
    const bad = { ...fixture(), decisions: 'invalid' }; bad.requirements[0].evidence = [];
    const completeJson = vi.fn().mockResolvedValueOnce({ value: bad }).mockResolvedValueOnce({ value: fixture() });
    await draftSpecification({ root, stateRoot, source, model: { completeJson }, modelName: 'qwen3.8-max', baseUrl: 'https://example.com' });
    expect(completeJson).toHaveBeenCalledTimes(2);
    expect(completeJson.mock.calls[1][0].jsonSchema.name).toBe('input_specification');
  });
  it('does not call the model or save a draft after cancellation', async () => {
    const root = temp(); const stateRoot = temp(); const { model, completeJson } = fakeModel();
    const controller = new AbortController(); controller.abort();
    await expect(draftSpecification({ root, stateRoot, source, model, modelName: 'qwen3.8-max', baseUrl: 'https://example.com/v1', signal: controller.signal })).rejects.toThrow();
    expect(completeJson).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual([]);
  });
  it('keeps one canonical draft when two identical requests finish together', async () => {
    const root = temp(); const stateRoot = temp(); const { model } = fakeModel();
    const options = { root, stateRoot, source, model, modelName: 'qwen3.8-max', baseUrl: 'https://example.com/v1' };
    const results = await Promise.all([draftSpecification(options), draftSpecification(options)]);
    expect(results[0].record).toEqual(results[1].record);
    expect(results.map((result) => result.reused).sort()).toEqual([false, true]);
    expect(readdirSync(path.dirname(results[0].file)).sort()).toEqual([`${results[0].record.id}.json`, `${results[0].record.id}.md`]);
  });
});

describe('pre-setup connection', () => {
  it('uses the exact saved model and endpoint pair, not the first duplicate ID', () => {
    const root = temp(); const file = path.join(root, 'settings.json');
    const token = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
    writeFileSync(file, JSON.stringify({ model: { name: 'qwen3.8-max', baseUrl: token }, modelProviders: { openai: [
      { id: 'qwen3.8-max', baseUrl: 'https://coding.example/v1', envKey: 'CODING_KEY' },
      { id: 'qwen3.8-max', baseUrl: token, envKey: 'CUSTOM_PLAN_KEY' },
    ] } }));
    const config = intakeConnection(root, file);
    expect(config.qwen.credentialEnvKey).toBe('CUSTOM_PLAN_KEY');
    expect(config.qwen.billingPlan).toBe('token-plan-personal');
    expect(config.qwen.baseUrl).toBe(token);
    expect(readdirSync(root)).toEqual(['settings.json']);
  });
  it('fails closed on missing or unsupported selection', () => {
    const root = temp(); const file = path.join(root, 'settings.json');
    expect(() => intakeConnection(root, file)).toThrow('Configure');
    writeFileSync(file, JSON.stringify({ model: { name: 'other-model' } }));
    expect(() => intakeConnection(root, file)).toThrow('qwen3.8-max');
  });
});
