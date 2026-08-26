import { randomUUID } from 'node:crypto';
import type {
  GateResult,
  ProjectConfig,
  RewardCriterionConfig,
  RewardCriterionResult,
  RewardEvidence,
  RewardScorecard,
  TaskRecord,
} from '../core/types.js';
import { redactForLedger, redactText } from '../core/ledger.js';

export interface RewardContext {
  config: ProjectConfig;
  task: TaskRecord;
  worktree: string;
  commitSha: string;
  changedFiles: string[];
  diff: string;
  gateResults: GateResult[];
  signal?: AbortSignal;
}

export interface EvaluatorResult {
  score: number;
  confidence: number;
  reason: string;
  evidence: RewardEvidence[];
  blockingFindings?: string[];
}

export interface RewardEvaluator {
  readonly modality: RewardCriterionConfig['modality'];
  evaluate(criterion: RewardCriterionConfig, context: RewardContext): Promise<EvaluatorResult>;
}

export class UniversalRewardEngine {
  private readonly byModality: Map<RewardCriterionConfig['modality'], RewardEvaluator>;

  constructor(evaluators: RewardEvaluator[]) {
    this.byModality = new Map(evaluators.map((evaluator) => [evaluator.modality, evaluator]));
  }

  async evaluate(context: RewardContext): Promise<RewardScorecard> {
    const criteria: RewardCriterionResult[] = [];
    const evidence: RewardEvidence[] = [];
    const blockingReasons: string[] = [];

    for (const criterion of context.config.rewards.criteria) {
      throwIfAborted(context.signal);
      const evaluator = this.byModality.get(criterion.modality);
      let result: EvaluatorResult;
      if (!evaluator) {
        result = {
          score: 0,
          confidence: 1,
          reason: `No ${criterion.modality} evaluator is configured`,
          evidence: [],
          blockingFindings: [`Missing required evaluator: ${criterion.modality}`],
        };
      } else {
        try {
          result = await evaluator.evaluate(criterion, context);
        } catch (error) {
          throwIfAborted(context.signal);
          result = {
            score: 0,
            confidence: 1,
            reason: `Evaluator failed closed: ${error instanceof Error ? error.message : String(error)}`,
            evidence: [],
            blockingFindings: [`${criterion.id} evaluator failed`],
          };
        }
      }
      result = {
        ...result,
        reason: redactText(result.reason),
        evidence: redactForLedger(result.evidence) as RewardEvidence[],
        blockingFindings: result.blockingFindings?.map(redactText),
      };
      const score = clamp(result.score);
      const threshold = criterion.critical
        ? Math.max(criterion.threshold, context.config.rewards.criticalThreshold)
        : criterion.threshold;
      const passed = score >= threshold;
      evidence.push(...result.evidence);
      criteria.push({
        id: criterion.id,
        modality: criterion.modality,
        score,
        threshold,
        hard: criterion.hard,
        critical: criterion.critical,
        passed,
        confidence: clamp(result.confidence),
        reason: result.reason,
        evidenceIds: result.evidence.map((item) => item.id),
      });
      if (!passed && (criterion.hard || criterion.critical)) blockingReasons.push(`${criterion.id}: ${result.reason}`);
      blockingReasons.push(...(result.blockingFindings ?? []));
    }

    const hardGatePass = criteria.filter((criterion) => criterion.hard).every((criterion) => criterion.passed);
    const weighted = criteria.filter((criterion) => !criterion.hard && weightFor(context.config, criterion.id) > 0);
    const totalWeight = weighted.reduce((sum, criterion) => sum + weightFor(context.config, criterion.id), 0);
    const aggregateScore =
      totalWeight === 0
        ? hardGatePass ? 1 : 0
        : weighted.reduce((sum, criterion) => sum + criterion.score * weightFor(context.config, criterion.id), 0) /
          totalWeight;
    const criticalPass = criteria.filter((criterion) => criterion.critical).every((criterion) => criterion.passed);
    const passed =
      hardGatePass && criticalPass && aggregateScore >= context.config.rewards.aggregateThreshold && blockingReasons.length === 0;
    if (aggregateScore < context.config.rewards.aggregateThreshold) {
      blockingReasons.push(
        `aggregate reward ${aggregateScore.toFixed(3)} is below ${context.config.rewards.aggregateThreshold.toFixed(3)}`,
      );
    }

    return {
      id: randomUUID(),
      taskId: context.task.id,
      projectId: context.task.projectId,
      commitSha: context.commitSha,
      evaluatorVersion: 'qwen-harness-reward/v1',
      hardGatePass,
      aggregateScore,
      aggregateThreshold: context.config.rewards.aggregateThreshold,
      passed,
      criteria,
      evidence,
      blockingReasons: [...new Set(blockingReasons)],
      createdAt: Date.now(),
    };
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Reward evaluation aborted by worker shutdown');
}

function weightFor(config: ProjectConfig, id: string): number {
  return config.rewards.criteria.find((criterion) => criterion.id === id)?.weight ?? 0;
}

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
