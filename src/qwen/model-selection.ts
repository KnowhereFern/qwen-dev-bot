import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Settings = Record<string, unknown>;
const object = (value: unknown): value is Settings => typeof value === 'object' && value !== null && !Array.isArray(value);

function readSettings(file: string): Settings {
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('Cannot read Qwen settings for isolated model selection');
  }
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!object(parsed)) throw new Error();
    return parsed;
  } catch { throw new Error('Qwen settings must be a valid JSON object for isolated model selection'); }
}

function assertNonsecret(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(assertNonsecret); return; }
  if (!object(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'envKey') continue;
    if ((/^(?:api.?key|password|secret|token|access.?token|refresh.?token|authorization|private.?key)$/i.test(key) && entry !== undefined && entry !== null && entry !== '') ||
        (key === 'env' && object(entry) && Object.keys(entry).length > 0)) {
      // Do not duplicate credentials into an invocation file, even with private permissions.
      throw new Error('Qwen system settings contain credential-bearing fields; isolated model selection refused');
    }
    if (typeof entry === 'string' && /(?:\bsk-[A-Za-z0-9]|\bBearer\s|-----BEGIN .*PRIVATE KEY-----)/.test(entry)) {
      throw new Error('Qwen settings contain credential material; isolated model selection refused');
    }
    assertNonsecret(entry);
  }
}

/** Pin a model and endpoint without modifying any persistent Qwen settings or exposing a key. */
export function createQwenModelSelection(options: {
  model: string;
  baseUrl: string;
  envKey: string;
  environment?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  if (!options.model.trim() || !/^[A-Z_][A-Z0-9_]*$/.test(options.envKey)) {
    throw new Error('Invalid isolated Qwen model or credential environment key');
  }
  let endpoint: URL;
  try { endpoint = new URL(options.baseUrl); } catch { throw new Error('Invalid isolated Qwen endpoint'); }
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Qwen endpoint must not contain credentials, query parameters, or fragments');
  }
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const defaultSystem = platform === 'darwin' ? '/Library/Application Support/QwenCode/settings.json'
    : platform === 'win32' ? 'C:\\ProgramData\\qwen-code\\settings.json' : '/etc/qwen-code/settings.json';
  const systemPath = environment.QWEN_CODE_SYSTEM_SETTINGS_PATH || defaultSystem;
  const defaultsPath = environment.QWEN_CODE_SYSTEM_DEFAULTS_PATH || path.join(path.dirname(systemPath), 'system-defaults.json');
  const system = readSettings(systemPath);
  const defaults = readSettings(defaultsPath);
  const user = readSettings(path.join(environment.QWEN_HOME || path.join(options.home ?? os.homedir(), '.qwen'), 'settings.json'));
  // Only retain generation tuning for the exact endpoint, never another duplicate-id provider.
  let generationConfig: unknown;
  for (const settings of [defaults, user, system]) {
    const providers = object(settings.modelProviders) ? settings.modelProviders.openai : undefined;
    if (!Array.isArray(providers)) continue;
    const selected = providers.find((provider) => object(provider) && provider.id === options.model && provider.baseUrl === options.baseUrl);
    if (object(selected) && object(selected.generationConfig)) generationConfig = selected.generationConfig;
  }
  const security = object(system.security) ? system.security : {};
  const auth = object(security.auth) ? security.auth : {};
  const overlay = {
    ...system,
    model: { ...(object(system.model) ? system.model : {}), name: options.model, baseUrl: options.baseUrl },
    security: { ...security, auth: { ...auth, selectedType: 'openai' } },
    modelProviders: { openai: [{ id: options.model, baseUrl: options.baseUrl, envKey: options.envKey,
      ...(generationConfig === undefined ? {} : { generationConfig }) }] },
  };
  assertNonsecret(overlay);
  const directory = mkdtempSync(path.join(os.tmpdir(), 'fern-qwen-model-'));
  const file = path.join(directory, 'settings.json');
  try {
    chmodSync(directory, 0o700);
    writeFileSync(file, `${JSON.stringify(overlay)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    env: { QWEN_CODE_SYSTEM_SETTINGS_PATH: file, QWEN_CODE_SYSTEM_DEFAULTS_PATH: defaultsPath },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
