import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createQwenModelSelection } from '../src/qwen/model-selection.js';
import { makeTmp } from './helpers.js';

function fixture() {
  const home = makeTmp('model-selection');
  mkdirSync(path.join(home, '.qwen'));
  const systemPath = path.join(home, 'system.json');
  const defaultsPath = path.join(home, 'defaults.json');
  const input = { model: 'qwen3.8-max', baseUrl: 'https://token.example/v1', envKey: 'TOKEN_KEY', home,
    environment: { QWEN_CODE_SYSTEM_SETTINGS_PATH: systemPath, QWEN_CODE_SYSTEM_DEFAULTS_PATH: defaultsPath } };
  return { home, systemPath, defaultsPath, input };
}

describe('invocation-scoped Qwen model selection', () => {
  it('pins duplicate model routing, preserves system policy and defaults, and cleans up private files', () => {
    const f = fixture();
    writeFileSync(f.systemPath, JSON.stringify({ tools: { sandbox: true }, security: { auth: { enforcedType: 'openai' } } }));
    writeFileSync(f.defaultsPath, JSON.stringify({ general: { checkpointing: { enabled: true } } }));
    const userPath = path.join(f.home, '.qwen', 'settings.json');
    const user = JSON.stringify({ modelProviders: { openai: [
      { id: 'qwen3.8-max', baseUrl: 'https://coding.example/v1', envKey: 'CODING_KEY', generationConfig: { temperature: 0 } },
      { id: 'qwen3.8-max', baseUrl: f.input.baseUrl, envKey: 'TOKEN_KEY', generationConfig: { maxTokens: 9000 } },
    ] } });
    writeFileSync(userPath, user);
    const selected = createQwenModelSelection(f.input);
    const file = selected.env.QWEN_CODE_SYSTEM_SETTINGS_PATH!;
    try {
      const overlay = JSON.parse(readFileSync(file, 'utf8'));
      expect(overlay.tools.sandbox).toBe(true);
      expect(overlay.security.auth).toEqual({ selectedType: 'openai', enforcedType: 'openai' });
      expect(overlay.model).toEqual({ name: f.input.model, baseUrl: f.input.baseUrl });
      expect(overlay.modelProviders.openai).toEqual([{ id: f.input.model, baseUrl: f.input.baseUrl,
        envKey: 'TOKEN_KEY', generationConfig: { maxTokens: 9000 } }]);
      expect(selected.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH).toBe(f.defaultsPath);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      expect(readFileSync(userPath, 'utf8')).toBe(user);
    } finally { selected.cleanup(); }
    expect(existsSync(file)).toBe(false);
    expect(() => selected.cleanup()).not.toThrow();
  });

  it('keeps implicit defaults relative to original custom system settings', () => {
    const f = fixture();
    delete (f.input.environment as Record<string, string>).QWEN_CODE_SYSTEM_DEFAULTS_PATH;
    const selected = createQwenModelSelection(f.input);
    try { expect(selected.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH).toBe(path.join(f.home, 'system-defaults.json')); }
    finally { selected.cleanup(); }
  });

  it.each(['{broken', '[]', 'null'])('fails closed on malformed existing settings %s', (value) => {
    const f = fixture();
    writeFileSync(f.systemPath, value);
    expect(() => createQwenModelSelection(f.input)).toThrow('valid JSON object');
  });

  it.each([
    { security: { auth: { apiKey: 'private-value' } } },
    { mcpServers: { server: { env: { KEY: 'private-value' } } } },
    { mcpServers: { server: { headers: { Authorization: 'private-value' } } } },
  ])('refuses to duplicate credentials from system policy', (system) => {
    const f = fixture();
    writeFileSync(f.systemPath, JSON.stringify(system));
    expect(() => createQwenModelSelection(f.input)).toThrow(/credential/);
  });

  it('rejects credential-bearing endpoints', () => {
    const f = fixture();
    expect(() => createQwenModelSelection({ ...f.input, baseUrl: 'https://user:pass@example.test/v1' })).toThrow(/credentials/);
  });
});
