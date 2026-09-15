import path from 'node:path';

export const QWEN_HARNESS_MODEL = 'qwen3.8-max';
export const DEFAULT_QWEN_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
export const CODING_PLAN_QWEN_BASE_URL = 'https://coding-intl.dashscope.aliyuncs.com/v1';
export const TOKEN_PLAN_QWEN_BASE_URL = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
export const MIN_QWEN_CODE_VERSION = '0.22.1';
export const NO_MCP_SERVERS_VALUE = '';
export const QWEN_MM_CORE_MCP_SERVER = 'qwen-mm-plugins-core';
export const QWEN_MM_CORE_REF = 'qwen-mm-plugins-core-v1.0.5';
export const QWEN_MM_REPOSITORY = 'https://github.com/QwenLM/Qwen-MM-Plugins.git';

const SAFE_QWEN_ENVIRONMENT = [
  'PATH',
  'Path',
  'PATHEXT',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'COLORTERM',
  'CI',
  'GITHUB_ACTIONS',
  'NO_COLOR',
  'FORCE_COLOR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'DASHSCOPE_API_KEY',
  'DASHSCOPE_BASE_URL',
  'BAILIAN_CODING_PLAN_API_KEY',
  'BAILIAN_TOKEN_PLAN_API_KEY',
  'BAILIAN_API_KEY',
] as const;

export interface QwenRuntimeCredential {
  envKey: string;
  apiKey?: string;
}

/** Build the least-privilege environment inherited by model-driven Qwen processes. */
export function qwenEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  credential?: QwenRuntimeCredential | null,
): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    SAFE_QWEN_ENVIRONMENT.flatMap((name) =>
      source[name] === undefined ? [] : [[name, source[name]]],
    ),
  );
  if (credential) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(credential.envKey)) {
      throw new Error('Configured Qwen credential key must be an uppercase environment variable name');
    }
    const value = credential.apiKey ?? source[credential.envKey];
    if (value !== undefined) environment[credential.envKey] = value;
  }
  return {
    ...environment,
    QWEN_CODE_FORCE_ENCRYPTED_FILE_STORAGE: 'true',
  };
}

/** Apply an invocation-level upper bound so ambient user MCP servers are never inherited. */
export function qwenMcpArgs(allowedServers: string[]): string[] {
  return [
    '--allowed-mcp-server-names',
    allowedServers.length > 0 ? allowedServers.join(',') : NO_MCP_SERVERS_VALUE,
  ];
}

/** Keep main-session delegation available while prohibiting nested fan-out. */
export function qwenSubagentArgs(maxDepth: number): string[] {
  return ['--max-subagent-depth', String(maxDepth)];
}

/** Auto-approve only the audited saved workflow required by the headless Goal. */
export function qwenSavedWorkflowPermissionArgs(scriptPath: string): string[] {
  if (!path.isAbsolute(scriptPath) || /[,()\r\n]/.test(scriptPath)) {
    throw new Error(`Saved workflow path cannot be represented safely in a Qwen permission rule: ${scriptPath}`);
  }
  return ['--allowed-tools', `workflow(scriptPath:${scriptPath})`];
}

export interface QwenWorkflowLimits {
  maxConcurrency: number;
  maxAgents: number;
  maxSeconds: number;
  maxTokens: number;
  maxSubagentTurns: number;
  maxSubagentMinutes: number;
}

/** Pin every Qwen workflow budget instead of inheriting potentially unbounded ambient defaults. */
export function qwenWorkflowEnvironment(limits: QwenWorkflowLimits): NodeJS.ProcessEnv {
  return {
    QWEN_CODE_ENABLE_WORKFLOWS: '1',
    QWEN_CODE_MAX_WORKFLOW_CONCURRENCY: String(limits.maxConcurrency),
    QWEN_CODE_MAX_WORKFLOW_AGENTS: String(limits.maxAgents),
    QWEN_CODE_MAX_WORKFLOW_SECONDS: String(limits.maxSeconds),
    QWEN_CODE_MAX_TOKENS_PER_WORKFLOW: String(limits.maxTokens),
    QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS: String(limits.maxSubagentTurns),
    QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES: String(limits.maxSubagentMinutes),
  };
}

/** Native Qwen Code installation args for the current immutable Qwen-MM core release. */
export function qwenMmCoreInstallArgs(): string[] {
  return [
    'extensions',
    'install',
    `${QWEN_MM_REPOSITORY}:${QWEN_MM_CORE_MCP_SERVER}`,
    `--ref=${QWEN_MM_CORE_REF}`,
    '--consent',
  ];
}

/** Official tagged uvx self-check used by Qwen-MM's own installer. */
export function qwenMmCoreCheckArgs(): string[] {
  return [
    '--from',
    `qwen-mm-plugins[core] @ git+${QWEN_MM_REPOSITORY}@${QWEN_MM_CORE_REF}`,
    QWEN_MM_CORE_MCP_SERVER,
    '--check-system',
  ];
}

export function qwenCodeVersionAtLeast(output: string, minimum = MIN_QWEN_CODE_VERSION): boolean {
  const current = semanticVersion(output);
  const required = semanticVersion(minimum);
  if (!current || !required) return false;
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== required[index]) return current[index] > required[index];
  }
  return true;
}

export function detectedQwenCodeVersion(output: string): string | null {
  const version = semanticVersion(output);
  return version ? version.join('.') : null;
}

function semanticVersion(value: string): [number, number, number] | null {
  const match = /(?:^|[^\d])(\d+)\.(\d+)\.(\d+)(?:[^\d]|$)/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
