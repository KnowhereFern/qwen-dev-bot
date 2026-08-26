import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_VERSION, type GateDefinition, type ProjectConfig } from './types.js';
import { DEFAULT_QWEN_BASE_URL, QWEN_HARNESS_MODEL, TOKEN_PLAN_QWEN_BASE_URL } from '../qwen/runtime-compat.js';

export const PROJECT_CONFIG_PATH = path.join('.qwen-harness', 'project.yml');

export function defaultProjectConfig(root: string, name = path.basename(root), githubRepo = ''): ProjectConfig {
  const teamTokenPlanCredential = Boolean(process.env.BAILIAN_TOKEN_PLAN_API_KEY && process.env.QWEN_HARNESS_TOKEN_PLAN_TEAM === '1');
  return {
    configVersion: CONFIG_VERSION,
    project: { name, root: path.resolve(root), githubRepo, defaultBranch: 'main' },
    qwen: {
      command: 'qwen',
      model: QWEN_HARNESS_MODEL,
      baseUrl: process.env.DASHSCOPE_BASE_URL ?? (teamTokenPlanCredential ? TOKEN_PLAN_QWEN_BASE_URL : DEFAULT_QWEN_BASE_URL),
      credentialEnvKey: teamTokenPlanCredential ? 'BAILIAN_TOKEN_PLAN_API_KEY' : 'DASHSCOPE_API_KEY',
      billingPlan: teamTokenPlanCredential ? 'token-plan-team' : 'standard',
      implementationReasoning: 'xhigh',
      reviewReasoning: 'medium',
      triageReasoning: 'low',
      approvalMode: 'auto',
      sandbox: true,
      maxWallTime: '1h',
      maxToolCalls: 200,
      maxSessionTurns: 80,
      maxSubagentDepth: 1,
      maxWorkflowSeconds: 3_300,
      maxWorkflowTokens: 500_000,
      maxWorkflowSubagentTurns: 80,
      maxWorkflowSubagentMinutes: 45,
      allowedMcpServers: [],
    },
    worker: {
      pollIntervalMs: 30_000,
      leaseMs: 90 * 60_000,
      maxConcurrentMutations: 1,
      maxReadOnlyAgents: 4,
      maxAttempts: 5,
      identicalFailureLimit: 3,
      autoMerge: false,
    },
    intake: {
      readyLabel: 'harness:ready',
      approvalLabel: 'harness:accept',
      normalizedLabel: 'harness:normalized',
      communityLabel: 'harness:community',
      trustedAuthors: ['github-actions[bot]'],
      autoPromoteSelfRepair: true,
      communityEnabled: false,
      communityPollIntervalMs: 6 * 60 * 60_000,
      communityMaxProposalsPerSource: 3,
      communitySources: [
        { name: 'Qwen Code releases', url: 'https://github.com/QwenLM/qwen-code/releases', autoApprove: false },
        { name: 'Qwen Code docs', url: 'https://qwenlm.github.io/qwen-code-docs/', autoApprove: false },
      ],
    },
    gates: discoverGates(root),
    rewards: {
      aggregateThreshold: 0.8,
      criticalThreshold: 0.7,
      criteria: [
        {
          id: 'execution',
          description: 'All required deterministic project gates pass.',
          modality: 'execution',
          hard: true,
          critical: true,
          weight: 1,
          threshold: 1,
        },
        {
          id: 'acceptance',
          description: 'The exact issue acceptance criteria are satisfied by the candidate commit.',
          modality: 'rubric',
          hard: false,
          critical: true,
          weight: 2,
          threshold: 0.7,
        },
        {
          id: 'independent-review',
          description: 'Independent Qwen review finds no unresolved high-severity defect.',
          modality: 'agentic',
          hard: false,
          critical: true,
          weight: 2,
          threshold: 0.7,
        },
      ],
    },
    protectedPaths: [
      'AUTONOMY.md',
      '.qwen-harness/',
      '.github/workflows/harness-',
      '.github/CODEOWNERS',
      '.qwen/agents/harness-',
      '.qwen/skills/harness-',
      '.qwen/workflows/harness-',
    ],
  };
}

export function discoverGates(root: string): GateDefinition[] {
  const pkgPath = path.join(root, 'package.json');
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const candidates: Array<[string, GateDefinition['kind']]> = [
      ['build', 'build'],
      ['typecheck', 'typecheck'],
      ['lint', 'lint'],
      ['test', 'unit'],
      ['test:integration', 'integration'],
      ['test:e2e', 'e2e'],
    ];
    return candidates
      .filter(([script]) => Boolean(scripts[script]))
      .map(([script, kind]) => ({
        id: script.replaceAll(':', '-'),
        kind,
        command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
        args: ['run', script],
        required: true,
        timeoutMs: kind === 'e2e' ? 15 * 60_000 : 5 * 60_000,
      }));
  } catch {
    return [];
  }
}

export function loadProjectConfig(rootOrFile: string): ProjectConfig {
  const file = rootOrFile.endsWith('.yml') || rootOrFile.endsWith('.json')
    ? path.resolve(rootOrFile)
    : path.resolve(rootOrFile, PROJECT_CONFIG_PATH);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ProjectConfig>;
  const project = parsed.project;
  const defaults = defaultProjectConfig(
    project?.root ?? path.dirname(path.dirname(file)),
    project?.name,
    project?.githubRepo,
  );
  const merged: ProjectConfig = {
    ...defaults,
    ...parsed,
    project: { ...defaults.project, ...project },
    qwen: { ...defaults.qwen, ...parsed.qwen },
    worker: { ...defaults.worker, ...parsed.worker },
    intake: {
      ...defaults.intake,
      ...parsed.intake,
      communitySources: (parsed.intake?.communitySources ?? defaults.intake.communitySources).map((source) => ({
        ...source,
        autoApprove: source.autoApprove ?? false,
      })),
    },
    gates: parsed.gates ?? defaults.gates,
    rewards: {
      ...defaults.rewards,
      ...parsed.rewards,
      criteria: parsed.rewards?.criteria ?? defaults.rewards.criteria,
    },
    protectedPaths: parsed.protectedPaths ?? defaults.protectedPaths,
  };
  return validateProjectConfig(merged, file);
}

export function validateProjectConfig(value: unknown, source = 'project config'): ProjectConfig {
  if (!value || typeof value !== 'object') throw new Error(`${source}: expected an object`);
  const config = value as ProjectConfig;
  if (config.configVersion !== CONFIG_VERSION) {
    throw new Error(`${source}: unsupported configVersion ${String(config.configVersion)}; expected ${CONFIG_VERSION}`);
  }
  if (!config.project?.name || !config.project.root || !config.project.defaultBranch) {
    throw new Error(`${source}: project.name, project.root, and project.defaultBranch are required`);
  }
  if (!path.isAbsolute(config.project.root)) throw new Error(`${source}: project.root must be absolute`);
  if (/[,()\r\n]/.test(config.project.root)) {
    throw new Error(`${source}: project.root contains characters incompatible with Qwen scoped workflow permissions`);
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(config.project.githubRepo)) {
    throw new Error(`${source}: project.githubRepo is required and must be owner/name`);
  }
  if (config.qwen?.model !== QWEN_HARNESS_MODEL) {
    throw new Error(`${source}: this template requires qwen.model to be "${QWEN_HARNESS_MODEL}"`);
  }
  if (!config.qwen.command?.trim()) throw new Error(`${source}: qwen.command is required`);
  if (!config.qwen.baseUrl || !isHttpsUrl(config.qwen.baseUrl)) {
    throw new Error(`${source}: qwen.baseUrl must be an HTTPS URL`);
  }
  if (!/^[A-Z_][A-Z0-9_]*$/.test(config.qwen.credentialEnvKey)) {
    throw new Error(`${source}: qwen.credentialEnvKey must be an uppercase environment variable name`);
  }
  if (!['standard', 'token-plan-team', 'custom'].includes(config.qwen.billingPlan)) {
    throw new Error(`${source}: invalid qwen.billingPlan for unattended operation`);
  }
  if (config.qwen.billingPlan === 'token-plan-team' && new URL(config.qwen.baseUrl).hostname !== new URL(TOKEN_PLAN_QWEN_BASE_URL).hostname) {
    throw new Error(`${source}: Token Plan Team requires the Token Plan base URL`);
  }
  if (!['low', 'medium', 'xhigh'].includes(config.qwen.implementationReasoning)) {
    throw new Error(`${source}: invalid qwen.implementationReasoning`);
  }
  if (!['low', 'medium', 'xhigh'].includes(config.qwen.reviewReasoning)) {
    throw new Error(`${source}: invalid qwen.reviewReasoning`);
  }
  if (!['low', 'medium', 'xhigh'].includes(config.qwen.triageReasoning)) {
    throw new Error(`${source}: invalid qwen.triageReasoning`);
  }
  if (config.qwen.approvalMode !== 'auto') {
    throw new Error(`${source}: qwen.approvalMode must remain auto; only the sandboxed implementer may mutate files`);
  }
  if (config.qwen.sandbox !== true) {
    throw new Error(`${source}: qwen.sandbox must remain enabled for the unattended implementer`);
  }
  if (!isPositiveDuration(config.qwen.maxWallTime)) throw new Error(`${source}: invalid qwen.maxWallTime`);
  if (!isPositiveInteger(config.qwen.maxToolCalls) || !isPositiveInteger(config.qwen.maxSessionTurns)) {
    throw new Error(`${source}: Qwen tool and session budgets must be positive integers`);
  }
  if (config.qwen.maxSubagentDepth !== 1) {
    throw new Error(`${source}: qwen.maxSubagentDepth must remain 1 so unattended subagents cannot nest`);
  }
  if (
    !isPositiveInteger(config.qwen.maxWorkflowSeconds) ||
    !isPositiveInteger(config.qwen.maxWorkflowTokens) ||
    !isPositiveInteger(config.qwen.maxWorkflowSubagentTurns) ||
    !isPositiveInteger(config.qwen.maxWorkflowSubagentMinutes)
  ) {
    throw new Error(`${source}: Qwen workflow budgets must be positive integers`);
  }
  if (config.qwen.maxWorkflowSeconds * 1_000 > durationToMs(config.qwen.maxWallTime)) {
    throw new Error(`${source}: qwen.maxWorkflowSeconds cannot exceed qwen.maxWallTime`);
  }
  if (config.qwen.maxWorkflowTokens > 100_000_000) {
    throw new Error(`${source}: qwen.maxWorkflowTokens cannot exceed Qwen Code's hard ceiling`);
  }
  if (config.qwen.maxWorkflowSubagentTurns > 500 || config.qwen.maxWorkflowSubagentMinutes > 100) {
    throw new Error(`${source}: Qwen workflow subagent budgets exceed Qwen Code's hard ceilings`);
  }
  if (
    !Array.isArray(config.qwen.allowedMcpServers) ||
    !config.qwen.allowedMcpServers.every(
      (server) => typeof server === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.?*-]*$/.test(server) && !server.includes(','),
    ) ||
    new Set(config.qwen.allowedMcpServers).size !== config.qwen.allowedMcpServers.length
  ) {
    throw new Error(`${source}: qwen.allowedMcpServers must contain unique MCP server names or glob patterns`);
  }
  if (config.worker.maxConcurrentMutations !== 1) {
    throw new Error(`${source}: worker.maxConcurrentMutations must remain 1 to preserve the single-writer invariant`);
  }
  for (const [key, number] of Object.entries({
    pollIntervalMs: config.worker.pollIntervalMs,
    leaseMs: config.worker.leaseMs,
    maxReadOnlyAgents: config.worker.maxReadOnlyAgents,
    maxAttempts: config.worker.maxAttempts,
    identicalFailureLimit: config.worker.identicalFailureLimit,
    communityPollIntervalMs: config.intake.communityPollIntervalMs,
    communityMaxProposalsPerSource: config.intake.communityMaxProposalsPerSource,
  })) {
    if (!isPositiveInteger(number)) throw new Error(`${source}: ${key} must be a positive integer`);
  }
  if (!Array.isArray(config.gates) || !Array.isArray(config.rewards?.criteria)) {
    throw new Error(`${source}: gates and rewards.criteria must be arrays`);
  }
  const gateIds = new Set<string>();
  for (const gate of config.gates) {
    if (
      !gate.id ||
      gateIds.has(gate.id) ||
      !gate.command ||
      !Array.isArray(gate.args) ||
      !gate.args.every((arg) => typeof arg === 'string') ||
      !isPositiveInteger(gate.timeoutMs) ||
      !['build', 'typecheck', 'lint', 'unit', 'integration', 'e2e', 'lifecycle', 'security', 'custom'].includes(gate.kind) ||
      (gate.cwd !== undefined && (path.isAbsolute(gate.cwd) || gate.cwd.split(/[\\/]/).includes('..')))
    ) {
      throw new Error(`${source}: invalid gate ${gate.id || '<unnamed>'}`);
    }
    gateIds.add(gate.id);
  }
  if (!isUnitInterval(config.rewards.aggregateThreshold) || !isUnitInterval(config.rewards.criticalThreshold)) {
    throw new Error(`${source}: reward thresholds must be between 0 and 1`);
  }
  if (config.rewards.criteria.length === 0) {
    throw new Error(`${source}: at least one reward criterion is required`);
  }
  const rewardIds = new Set<string>();
  for (const criterion of config.rewards.criteria) {
    if (!criterion.id || rewardIds.has(criterion.id)) throw new Error(`${source}: duplicate/empty reward criterion id`);
    rewardIds.add(criterion.id);
    if (
      !criterion.description?.trim() ||
      !['execution', 'rubric', 'visual', 'agentic'].includes(criterion.modality) ||
      !Number.isFinite(criterion.weight) ||
      criterion.weight < 0 ||
      !isUnitInterval(criterion.threshold) ||
      (criterion.gateId !== undefined && !gateIds.has(criterion.gateId)) ||
      (criterion.artifactGlobs !== undefined && !criterion.artifactGlobs.every(isSafeRelativePattern))
    ) {
      throw new Error(`${source}: invalid reward criterion ${criterion.id}`);
    }
  }
  if (!Array.isArray(config.intake.trustedAuthors) || !config.intake.trustedAuthors.every(isNonEmptyString)) {
    throw new Error(`${source}: intake.trustedAuthors must contain non-empty GitHub logins`);
  }
  if (!Array.isArray(config.intake.communitySources)) throw new Error(`${source}: intake.communitySources must be an array`);
  for (const communitySource of config.intake.communitySources) {
    if (!isNonEmptyString(communitySource.name) || !isHttpsUrl(communitySource.url)) {
      throw new Error(`${source}: every community source requires a name and HTTPS URL`);
    }
  }
  if (!Array.isArray(config.protectedPaths) || !config.protectedPaths.every(isSafeRelativePattern)) {
    throw new Error(`${source}: protectedPaths must contain safe relative path patterns`);
  }
  return config;
}

export function serializeProjectConfig(config: ProjectConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isPositiveDuration(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(value.trim());
  return Boolean(match && Number(match[1]) > 0);
}

function durationToMs(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(value.trim());
  if (!match) return 0;
  const amount = Number(match[1]);
  const multiplier = match[2] === 'h' ? 60 * 60_000 : match[2] === 'm' ? 60_000 : 1_000;
  return amount * multiplier;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSafeRelativePattern(value: unknown): value is string {
  return isNonEmptyString(value) && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..');
}
