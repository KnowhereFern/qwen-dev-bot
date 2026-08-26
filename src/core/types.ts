export const CONFIG_VERSION = 1 as const;

export const TASK_STATES = [
  'intake',
  'normalized',
  'ready',
  'leased',
  'active',
  'verifying',
  'pr_open',
  'waiting_ci',
  'merge_ready',
  'post_merge',
  'waiting',
  'failed',
  'quarantined',
  'cancelled',
  'done',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export type ReasoningEffort = 'low' | 'medium' | 'xhigh';
export type GateKind =
  | 'build'
  | 'typecheck'
  | 'lint'
  | 'unit'
  | 'integration'
  | 'e2e'
  | 'lifecycle'
  | 'security'
  | 'custom';
export type RewardModality = 'execution' | 'rubric' | 'visual' | 'agentic';

export interface GateDefinition {
  id: string;
  kind: GateKind;
  command: string;
  args: string[];
  required: boolean;
  timeoutMs: number;
  cwd?: string;
  notApplicableReason?: string;
}

export interface RewardCriterionConfig {
  id: string;
  description: string;
  modality: RewardModality;
  hard: boolean;
  critical: boolean;
  weight: number;
  threshold: number;
  gateId?: string;
  artifactGlobs?: string[];
}

export interface ProjectConfig {
  configVersion: typeof CONFIG_VERSION;
  project: {
    name: string;
    root: string;
    githubRepo: string;
    defaultBranch: string;
  };
  qwen: {
    command: string;
    model: string;
    baseUrl: string;
    credentialEnvKey: string;
    billingPlan: 'standard' | 'token-plan-team' | 'custom';
    implementationReasoning: ReasoningEffort;
    reviewReasoning: ReasoningEffort;
    triageReasoning: ReasoningEffort;
    approvalMode: 'auto';
    sandbox: boolean;
    maxWallTime: string;
    maxToolCalls: number;
    maxSessionTurns: number;
    maxSubagentDepth: number;
    maxWorkflowSeconds: number;
    maxWorkflowTokens: number;
    maxWorkflowSubagentTurns: number;
    maxWorkflowSubagentMinutes: number;
    allowedMcpServers: string[];
  };
  worker: {
    pollIntervalMs: number;
    leaseMs: number;
    maxConcurrentMutations: number;
    maxReadOnlyAgents: number;
    maxAttempts: number;
    identicalFailureLimit: number;
    autoMerge: boolean;
  };
  intake: {
    readyLabel: string;
    approvalLabel: string;
    normalizedLabel: string;
    communityLabel: string;
    trustedAuthors: string[];
    autoPromoteSelfRepair: boolean;
    communityEnabled: boolean;
    communityPollIntervalMs: number;
    communityMaxProposalsPerSource: number;
    communitySources: Array<{ name: string; url: string; autoApprove: boolean }>;
  };
  gates: GateDefinition[];
  rewards: {
    aggregateThreshold: number;
    criticalThreshold: number;
    criteria: RewardCriterionConfig[];
  };
  protectedPaths: string[];
}

export interface TaskSpec {
  goal: string;
  source: {
    kind: 'user' | 'community' | 'self-repair' | 'ci' | 'developer';
    url?: string;
    author?: string;
  };
  acceptanceCriteria: string[];
  constraints: string[];
  requiredGateIds: string[];
  rewardCriterionIds: string[];
  risk: 'low' | 'medium' | 'high';
  dependencies: number[];
  rollback: string;
}

export interface TaskRecord {
  id: string;
  projectId: string;
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  author: string;
  state: TaskState;
  spec: TaskSpec | null;
  priority: number;
  attempts: number;
  identicalFailures: number;
  lastFailureFingerprint: string | null;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  baseSha: string | null;
  branch: string | null;
  worktreePath: string | null;
  commitSha: string | null;
  qwenSessionId: string | null;
  qwenWorkflowRunId: string | null;
  prNumber: number | null;
  prUrl: string | null;
  mergeSha: string | null;
  rewardRunId: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export interface RunCheckpoint {
  taskId: string;
  phase: TaskState;
  qwenSessionId: string | null;
  qwenWorkflowRunId: string | null;
  baseSha: string | null;
  commitSha: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface GateResult {
  id: string;
  kind: GateKind;
  required: boolean;
  applicable: boolean;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  command: string[];
  evidenceHash: string;
}

export interface RewardEvidence {
  id: string;
  source: string;
  modality: RewardModality;
  artifactPath?: string;
  artifactHash?: string;
  summary: string;
  data: Record<string, unknown>;
}

export interface RewardCriterionResult {
  id: string;
  modality: RewardModality;
  score: number;
  threshold: number;
  hard: boolean;
  critical: boolean;
  passed: boolean;
  confidence: number;
  reason: string;
  evidenceIds: string[];
}

export interface RewardScorecard {
  id: string;
  taskId: string;
  projectId: string;
  commitSha: string;
  evaluatorVersion: string;
  hardGatePass: boolean;
  aggregateScore: number;
  aggregateThreshold: number;
  passed: boolean;
  criteria: RewardCriterionResult[];
  evidence: RewardEvidence[];
  blockingReasons: string[];
  createdAt: number;
}

export interface HarnessEvent {
  id: string;
  projectId: string;
  taskId: string | null;
  type: string;
  idempotencyKey: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface ProcessReceipt {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
}
