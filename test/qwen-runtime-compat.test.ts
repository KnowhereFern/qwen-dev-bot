import { describe, expect, it } from 'vitest';
import {
  NO_MCP_SERVERS_VALUE,
  qwenEnvironment,
  qwenMcpArgs,
  qwenMmCoreCheckArgs,
  qwenMmCoreInstallArgs,
  qwenSavedWorkflowPermissionArgs,
  qwenSubagentArgs,
  qwenWorkflowEnvironment,
} from '../src/qwen/runtime-compat.js';

describe('Qwen runtime boundary', () => {
  it('passes only runtime essentials and the dedicated Qwen credential', () => {
    const environment = qwenEnvironment({
      PATH: '/bin',
      HOME: '/safe-home',
      DASHSCOPE_API_KEY: 'dashscope-secret',
      DASHSCOPE_BASE_URL: 'https://qwen.example.test/v1',
      BAILIAN_CODING_PLAN_API_KEY: 'coding-plan-secret',
      BAILIAN_TOKEN_PLAN_API_KEY: 'token-plan-secret',
      BAILIAN_API_KEY: 'bailian-secret',
      GH_TOKEN: 'github-secret',
      GITHUB_TOKEN: 'github-secret-2',
      OPENAI_API_KEY: 'openai-secret',
      NPM_TOKEN: 'npm-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      NODE_OPTIONS: '--require=/tmp/inject.cjs',
      BASH_ENV: '/tmp/inject.sh',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    });

    expect(environment).toMatchObject({
      PATH: '/bin',
      HOME: '/safe-home',
      DASHSCOPE_API_KEY: 'dashscope-secret',
      DASHSCOPE_BASE_URL: 'https://qwen.example.test/v1',
      BAILIAN_CODING_PLAN_API_KEY: 'coding-plan-secret',
      BAILIAN_TOKEN_PLAN_API_KEY: 'token-plan-secret',
      BAILIAN_API_KEY: 'bailian-secret',
      QWEN_CODE_FORCE_ENCRYPTED_FILE_STORAGE: 'true',
    });
    expect(environment).not.toHaveProperty('GH_TOKEN');
    expect(environment).not.toHaveProperty('GITHUB_TOKEN');
    expect(environment).not.toHaveProperty('OPENAI_API_KEY');
    expect(environment).not.toHaveProperty('NPM_TOKEN');
    expect(environment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(environment).not.toHaveProperty('NODE_OPTIONS');
    expect(environment).not.toHaveProperty('BASH_ENV');
    expect(environment).not.toHaveProperty('SSH_AUTH_SOCK');
  });

  it('forwards only the configured custom credential alongside the safe environment', () => {
    const environment = qwenEnvironment(
      { PATH: '/bin', CUSTOM_QWEN_KEY: 'from-source', UNRELATED_SECRET: 'do-not-forward' },
      { envKey: 'CUSTOM_QWEN_KEY', apiKey: 'resolved-custom-secret' },
    );

    expect(environment.CUSTOM_QWEN_KEY).toBe('resolved-custom-secret');
    expect(environment).not.toHaveProperty('UNRELATED_SECRET');
    expect(() => qwenEnvironment({}, { envKey: 'unsafe-key', apiKey: 'secret' })).toThrow(/uppercase/);
  });

  it('caps MCP discovery to explicit project servers and denies all by default', () => {
    expect(NO_MCP_SERVERS_VALUE).toBe('');
    expect(qwenMcpArgs([])).toEqual(['--allowed-mcp-server-names', '']);
    expect(qwenMcpArgs(['qwen-mm-plugins-core', 'project-read-*'])).toEqual([
      '--allowed-mcp-server-names',
      'qwen-mm-plugins-core,project-read-*',
    ]);
  });

  it('pins delegation depth and every dynamic-workflow budget', () => {
    expect(qwenSubagentArgs(1)).toEqual(['--max-subagent-depth', '1']);
    expect(
      qwenWorkflowEnvironment({
        maxConcurrency: 4,
        maxAgents: 6,
        maxSeconds: 3_300,
        maxTokens: 500_000,
        maxSubagentTurns: 80,
        maxSubagentMinutes: 45,
      }),
    ).toEqual({
      QWEN_CODE_ENABLE_WORKFLOWS: '1',
      QWEN_CODE_MAX_WORKFLOW_CONCURRENCY: '4',
      QWEN_CODE_MAX_WORKFLOW_AGENTS: '6',
      QWEN_CODE_MAX_WORKFLOW_SECONDS: '3300',
      QWEN_CODE_MAX_TOKENS_PER_WORKFLOW: '500000',
      QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS: '80',
      QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES: '45',
    });
  });

  it('approves only the exact audited saved workflow path', () => {
    expect(qwenSavedWorkflowPermissionArgs('/project/.qwen/workflows/harness-implement.js')).toEqual([
      '--allowed-tools',
      'workflow(scriptPath:/project/.qwen/workflows/harness-implement.js)',
    ]);
    expect(() => qwenSavedWorkflowPermissionArgs('/project,unsafe/workflow.js')).toThrow(/cannot be represented safely/);
  });

  it('installs Qwen-MM core from its immutable official capability tag', () => {
    expect(qwenMmCoreInstallArgs()).toEqual([
      'extensions',
      'install',
      'https://github.com/QwenLM/Qwen-MM-Plugins.git:qwen-mm-plugins-core',
      '--ref=qwen-mm-plugins-core-v1.0.5',
      '--consent',
    ]);
    expect(qwenMmCoreCheckArgs()).toEqual([
      '--from',
      'qwen-mm-plugins[core] @ git+https://github.com/QwenLM/Qwen-MM-Plugins.git@qwen-mm-plugins-core-v1.0.5',
      'qwen-mm-plugins-core',
      '--check-system',
    ]);
  });
});
