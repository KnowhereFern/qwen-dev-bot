export const CONFIG_VERSION = 2 as const;
export const SUPPORTED_CONFIG_VERSIONS = [1, CONFIG_VERSION] as const;
export type ConfigVersion = (typeof SUPPORTED_CONFIG_VERSIONS)[number];

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

export interface StructuredOutputSchema {
  name: string;
  schema: Record<string, unknown>;
}
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

export type DeliveryAuthority = 'build-test-only' | 'staging';

export interface ApprovedTechnology {
  category: string;
  technology: string;
}

export interface TechnologyPolicy {
  authority: 'build-test-only';
  approved: ApprovedTechnology[];
  requirePlanApprovalForExceptions: true;
}

export interface TechnologyDecision {
  id: string;
  category: string;
  technology: string;
  source: 'approved' | 'exception';
  rationale: string;
}

export interface DeploymentDecision {
  id: string;
  component: string;
  provider: string;
  environment: 'local' | 'preview' | 'staging' | 'production';
  authority: DeliveryAuthority;
  rationale: string;
}

export type QwenBillingPlan = 'standard' | 'token-plan-personal' | 'token-plan-team' | 'custom';

export interface ProjectConfig {
  configVersion: ConfigVersion;
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
    billingPlan: QwenBillingPlan;
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
    maxContinuations: number;
    identicalFailureLimit: number;
    autoMerge: boolean;
  };
  intake: {
    readyLabel: string;
    approvalLabel: string;
    normalizedLabel: string;
    communityLabel: string;
    planLabel: string;
    plannedLabel: string;
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
  technologyPolicy: TechnologyPolicy;
  program: {
    enabled: boolean;
    reassessAfterWave: boolean;
    maintenance: boolean;
    maxAssessmentFiles: number;
    maxAssessmentBytes: number;
    requireCleanSnapshot: boolean;
    materialChangesRequireApproval: true;
  };
  evolution: {
    enabled: boolean;
    githubFeedback: boolean;
    ciFailures: boolean;
    stagingFailures: boolean;
    productMetrics: Array<{ name: string; url: string }>;
    pollIntervalMs: number;
  };
  deployment: {
    staging: {
      enabled: boolean;
      provider: 'railway' | 'command';
      project: string;
      environment: string;
      service: string;
      healthUrl: string;
      revisionJsonPath: string;
      revisionEnvKey?: string;
      timeoutMs: number;
      lifecycleGateIds: string[];
      command?: { command: string; args: string[] };
      rollback?: { command: string; args: string[]; dataCompatible: boolean };
    };
    production: {
      requiresApproval: true;
    };
  };
  selfHosting: {
    enabled: boolean;
    autoPromote: boolean;
    probationMs: number;
    deliveryObservationMs: number;
    requiredProjectId: string;
    candidateRoot: string;
    evaluationCommands: Array<{ command: string; args: string[] }>;
    canaryCommands: Array<{ stack: 'node' | 'python' | 'go' | 'rust'; command: string; args: string[] }>;
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
  technologyDecisions: TechnologyDecision[];
  deploymentDecisions: DeploymentDecision[];
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
  continuations?: number;
  waitKind?: 'provider' | null;
  resumeAfter?: number | null;
  identicalFailures: number;
  lastFailureFingerprint: string | null;
  failureLineageId?: string | null;
  lineageFailures?: number;
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

export const PORTFOLIO_PLAN_STATUSES = [
  'draft',
  'awaiting_initial_approval',
  'approving',
  'active',
  'assessing',
  'awaiting_material_approval',
  'deploying_staging',
  'verifying_staging',
  'delivered',
  'maintaining',
  'paused',
  'done',
  'blocked',
  'superseded',
] as const;

export type PortfolioPlanStatus = (typeof PORTFOLIO_PLAN_STATUSES)[number];

export type CapabilityStatus = 'implemented' | 'partial' | 'missing' | 'unverified' | 'externally_blocked';
export type CoverageAction = 'none' | 'implement' | 'verify' | 'operate' | 'document' | 'external';
export type ProgramWorkType = 'implement' | 'verify' | 'operate' | 'document';

export interface EvidenceReference {
  kind: 'file' | 'test' | 'deployment' | 'git' | 'config' | 'signal';
  locator: string;
  summary: string;
  commitSha: string;
}

export interface ObjectiveCoverage {
  id: string;
  requirement: string;
  status: CapabilityStatus;
  requiredAction: CoverageAction;
  rationale: string;
  evidence: EvidenceReference[];
}

export interface RepositoryAnalysis {
  area: 'product' | 'architecture' | 'verification' | 'operations';
  summary: string;
  findings: Array<{
    capability: string;
    status: CapabilityStatus;
    rationale: string;
    evidence: EvidenceReference[];
  }>;
  risks: string[];
}

export interface RepositoryAssessment {
  id: string;
  projectId: string;
  commitSha: string;
  dirty: boolean;
  detectedStacks: Array<'node' | 'python' | 'go' | 'rust' | 'unknown'>;
  files: string[];
  analyses: RepositoryAnalysis[];
  coverage: ObjectiveCoverage[];
  createdAt: number;
  objectiveContentHash?: string;
  reviewedAssessmentId?: string;
}

export interface ProgramRevision {
  number: number;
  assessmentId: string;
  repositorySha: string;
  reason: 'initial' | 'wave-complete' | 'quarantine' | 'staging-failure' | 'signal' | 'manual';
  material: boolean;
  summary: string;
  createdAt: number;
  approvedAt: number | null;
  sourceSignalId?: string | null;
  objectiveContentHash?: string;
  objectiveSourceContent?: string;
  objectiveSourcePath?: string;
}

export interface PortfolioStory {
  key: string;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  constraints: string[];
  requiredGateIds: string[];
  rewardCriterionIds: string[];
  risk: 'low' | 'medium' | 'high';
  workType?: ProgramWorkType;
  dependsOn: string[];
  rollback: string;
  technologyDecisionIds: string[];
  deploymentDecisionIds: string[];
  coverageIds?: string[];
  sourceIssueNumber: number | null;
  sourceIssueUrl: string | null;
  normalizedIssueNumber: number | null;
  normalizedIssueUrl: string | null;
  wave?: number;
  revision?: number;
  supersededAt?: number | null;
  failureOriginIssueNumber?: number | null;
}

export interface PortfolioPlan {
  id: string;
  projectId: string;
  sourcePath: string;
  contentHash: string;
  sourceContent?: string;
  title: string;
  objective: string;
  constraints: string[];
  definitionOfDone: string[];
  technologyDecisions: TechnologyDecision[];
  deploymentDecisions: DeploymentDecision[];
  status: PortfolioPlanStatus;
  epicIssueNumber: number | null;
  epicIssueUrl: string | null;
  stories: PortfolioStory[];
  createdAt: number;
  updatedAt: number;
  approvedAt: number | null;
  assessmentId?: string | null;
  repositorySha?: string | null;
  revision?: number;
  currentWave?: number;
  coverage?: ObjectiveCoverage[];
  revisions?: ProgramRevision[];
  latestDeploymentId?: string | null;
  deliveredAt?: number | null;
  maintenanceStartedAt?: number | null;
}

export type SignalStatus = 'observed' | 'normalized' | 'deduplicated' | 'relevant' | 'proposed' | 'accepted' | 'rejected';

export interface EvolutionSignal {
  id: string;
  projectId: string;
  source: 'github' | 'ci' | 'staging' | 'metric' | 'community';
  sourceKey: string;
  contentHash: string;
  title: string;
  summary: string;
  evidence: EvidenceReference[];
  status: SignalStatus;
  material: boolean;
  observedAt: number;
  updatedAt: number;
}

export type DeploymentStatus = 'pending' | 'uploading' | 'building' | 'deploying' | 'verifying' | 'succeeded' | 'failed' | 'rolled_back';

export interface DeploymentRecord {
  id: string;
  projectId: string;
  planId: string;
  wave: number;
  provider: 'railway' | 'command';
  commitSha: string;
  previousVerifiedCommitSha: string | null;
  externalId: string | null;
  status: DeploymentStatus;
  healthUrl: string;
  observedRevision: string | null;
  error: string | null;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export type ControllerReleaseStatus = 'candidate' | 'evaluating' | 'ready' | 'active' | 'inactive' | 'probation' | 'rejected' | 'rolled_back';

export interface ControllerRelease {
  id: string;
  version: string;
  commitSha: string;
  root: string;
  status: ControllerReleaseStatus;
  baselineReleaseId: string | null;
  evaluationHash: string | null;
  promotedAt: number | null;
  probationEndsAt: number | null;
  createdAt: number;
  updatedAt: number;
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
