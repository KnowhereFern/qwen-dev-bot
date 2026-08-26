import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CommunityCollector } from './community/collector.js';
import type { ProjectConfig } from './core/types.js';
import { projectIdFor, projectStateDir } from './core/state-paths.js';
import { PersistentTaskStore } from './core/persistent-store.js';
import { GitWorkspace } from './git/git-workspace.js';
import { OctokitControlPlane, resolveGitHubToken, type GitHubControl } from './github/control-plane.js';
import { IssueNormalizer } from './intake/normalizer.js';
import { Logger } from './logger.js';
import { QwenApiClient } from './qwen/qwen-api.js';
import { assertQwenCredentialCompatibility, resolveQwenCredential } from './qwen/credentials.js';
import { QwenCodeExecutor } from './qwen/qwen-code-executor.js';
import { UniversalRewardEngine } from './rewards/engine.js';
import {
  ExecutionEvaluator,
  QwenAgenticEvaluator,
  QwenRubricEvaluator,
  QwenVisualEvaluator,
} from './rewards/evaluators.js';
import { GateRunner } from './rewards/gates.js';
import { HarnessSupervisor } from './supervisor.js';

export interface ProductionHarness {
  supervisor: HarnessSupervisor;
  store: PersistentTaskStore;
  github: GitHubControl;
  close(): void;
}

export async function createProductionHarness(
  config: ProjectConfig,
  options: { logger?: Logger; github?: GitHubControl; qwenApi?: QwenApiClient; workerId?: string } = {},
): Promise<ProductionHarness> {
  const projectId = projectIdFor(config);
  const stateDir = projectStateDir(config);
  const store = new PersistentTaskStore(projectId, stateDir);
  try {
    const github =
      options.github ??
      new OctokitControlPlane({
        repo: config.project.githubRepo,
        token: await resolveGitHubToken(config.project.root),
      });
    const credential = options.qwenApi ? null : resolveQwenCredential(config);
    if (credential) assertQwenCredentialCompatibility(config, credential);
    const qwenApi =
      options.qwenApi ??
      new QwenApiClient({
        model: config.qwen.model,
        baseUrl: config.qwen.baseUrl,
        credentialEnvKey: config.qwen.credentialEnvKey,
        apiKey: credential?.apiKey,
      });
    const logger = options.logger ?? new Logger();
    const git = new GitWorkspace(config.project.root, stateDir, config);
    await git.assertReady();
    const rewards = new UniversalRewardEngine([
      new ExecutionEvaluator(),
      new QwenRubricEvaluator(qwenApi),
      new QwenAgenticEvaluator(),
      new QwenVisualEvaluator(qwenApi),
    ]);
    const supervisor = new HarnessSupervisor(
      config,
      store,
      github,
      git,
      new QwenCodeExecutor(config),
      new IssueNormalizer(config, qwenApi),
      new GateRunner(),
      rewards,
      logger,
      options.workerId ?? `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
      new CommunityCollector(config, store, github, qwenApi),
    );
    return { supervisor, store, github, close: () => store.close() };
  } catch (error) {
    store.close();
    throw error;
  }
}
