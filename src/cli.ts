import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CommunityCollector } from './community/collector.js';
import { loadProjectConfig, PROJECT_CONFIG_PATH } from './core/config.js';
import { projectIdFor, projectStateDir } from './core/state-paths.js';
import { redactText } from './core/ledger.js';
import { PersistentTaskStore } from './core/persistent-store.js';
import { runDaemon } from './daemon.js';
import { formatDoctor, runDoctor } from './doctor.js';
import { createProductionHarness } from './factory.js';
import { OctokitControlPlane, resolveGitHubToken } from './github/control-plane.js';
import { installProject, uninstallProject } from './installer/installer.js';
import { QwenApiClient } from './qwen/qwen-api.js';
import { assertQwenCredentialCompatibility, resolveQwenCredential } from './qwen/credentials.js';
import { ProjectRegistry } from './registry.js';

const VERSION = '1.0.0-rc.3';

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? 'help';
  const args = argv.slice(1);
  if ((hasFlag(args, '--help') || hasFlag(args, '-h')) && !['help', '--help', '-h'].includes(command)) {
    console.log(help());
    return 0;
  }
  const root = path.resolve(firstPositional(args) ?? process.cwd());
  const json = hasFlag(args, '--json');

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      console.log(help());
      return 0;
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      return 0;
    case 'init': {
      const result = await installProject({
        root,
        dryRun: hasFlag(args, '--dry-run'),
        yes: hasFlag(args, '--yes'),
        answers: {
          projectName: valueOf(args, '--name'),
          githubRepo: valueOf(args, '--repo'),
          trustedAuthor: valueOf(args, '--trusted-author'),
          qwenBaseUrl: valueOf(args, '--base-url'),
          qwenCredentialEnvKey: valueOf(args, '--api-key-env'),
          qwenBillingPlan: billingPlanValue(args),
          autoMerge: hasFlag(args, '--auto-merge') || undefined,
          enableCommunity: hasFlag(args, '--community') || undefined,
          installQwen: hasFlag(args, '--install-qwen') || undefined,
          installService: hasFlag(args, '--install-service') ? true : hasFlag(args, '--no-service') ? false : undefined,
          linkExtension: hasFlag(args, '--no-link-extension') ? false : undefined,
          installMultimodal: hasFlag(args, '--with-mm') || undefined,
          installBrowserAutomation: hasFlag(args, '--with-browser') || undefined,
          bootstrapDependencies: hasFlag(args, '--skip-dependencies') ? false : undefined,
          installCli: hasFlag(args, '--install-cli') || undefined,
          persistCredentials: hasFlag(args, '--persist-api-key') || undefined,
          configureGitHub: hasFlag(args, '--configure-github') || undefined,
        },
      });
      if (json) console.log(JSON.stringify({ projectId: result.receipt.projectId, summary: result.summary }, null, 2));
      else {
        console.log(result.summary.map((line) => `- ${line}`).join('\n'));
        console.log('\nNext: run `qwen-harness doctor`. The harness reuses the credential already stored in Qwen user settings when available.');
      }
      return 0;
    }
    case 'update': {
      const current = loadProjectConfig(root);
      const result = await installProject({
        root,
        yes: true,
        answers: {
          projectName: current.project.name,
          githubRepo: current.project.githubRepo,
          trustedAuthor: current.intake.trustedAuthors.find((author) => author !== 'github-actions[bot]') ?? '',
          qwenBaseUrl: valueOf(args, '--base-url') ?? current.qwen.baseUrl,
          qwenCredentialEnvKey: valueOf(args, '--api-key-env') ?? current.qwen.credentialEnvKey,
          qwenBillingPlan: billingPlanValue(args) ?? current.qwen.billingPlan,
          autoMerge: current.worker.autoMerge,
          enableCommunity: current.intake.communityEnabled,
          installQwen: hasFlag(args, '--install-qwen'),
          installService: hasFlag(args, '--install-service') ? true : hasFlag(args, '--no-service') ? false : undefined,
          linkExtension: hasFlag(args, '--no-link-extension') ? false : undefined,
          installMultimodal: hasFlag(args, '--with-mm'),
          installBrowserAutomation: hasFlag(args, '--with-browser'),
          bootstrapDependencies: !hasFlag(args, '--skip-dependencies'),
          installCli: hasFlag(args, '--install-cli'),
          persistCredentials: hasFlag(args, '--persist-api-key'),
          configureGitHub: hasFlag(args, '--configure-github'),
        },
      });
      console.log(json ? JSON.stringify(result.summary) : result.summary.map((line) => `- ${line}`).join('\n'));
      return 0;
    }
    case 'uninstall': {
      if (!hasFlag(args, '--yes')) throw new Error('Uninstall requires --yes; modified files are always preserved.');
      const actions = await uninstallProject(root, { removeService: hasFlag(args, '--remove-service') });
      console.log(json ? JSON.stringify(actions) : actions.map((line) => `- ${line}`).join('\n'));
      return 0;
    }
    case 'register': {
      const config = loadProjectConfig(root);
      const registration = new ProjectRegistry().register({
        id: projectIdFor(config),
        root: config.project.root,
        configPath: path.join(config.project.root, PROJECT_CONFIG_PATH),
        enabled: true,
      });
      console.log(json ? JSON.stringify(registration, null, 2) : `Registered ${registration.id}`);
      return 0;
    }
    case 'unregister': {
      const id = firstPositional(args) ?? root;
      const removed = new ProjectRegistry().unregister(id);
      console.log(json ? JSON.stringify({ removed }) : removed ? 'Unregistered project' : 'Project was not registered');
      return removed ? 0 : 1;
    }
    case 'doctor':
    case 'verify': {
      const config = loadProjectConfig(root);
      const report = await runDoctor(config, { live: hasFlag(args, '--live') || command === 'verify' });
      console.log(json ? JSON.stringify(report, null, 2) : formatDoctor(report));
      return report.ready ? 0 : 1;
    }
    case 'status': {
      const config = loadProjectConfig(root);
      const store = new PersistentTaskStore(projectIdFor(config), projectStateDir(config));
      try {
        const tasks = store.list();
        const counts = Object.fromEntries(tasks.map((task) => task.state).filter((state, index, all) => all.indexOf(state) === index).map((state) => [state, tasks.filter((task) => task.state === state).length]));
        if (json) console.log(JSON.stringify({ projectId: projectIdFor(config), counts, tasks }, null, 2));
        else console.log(formatStatus(projectIdFor(config), counts, tasks));
      } finally {
        store.close();
      }
      return 0;
    }
    case 'logs': {
      const config = loadProjectConfig(root);
      const store = new PersistentTaskStore(projectIdFor(config), projectStateDir(config));
      const file = store.ledger.file;
      store.close();
      const count = Number(valueOf(args, '--lines') || 50);
      const lines = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').slice(-count) : [];
      console.log(lines.join('\n'));
      return 0;
    }
    case 'reward': {
      const config = loadProjectConfig(root);
      const store = new PersistentTaskStore(projectIdFor(config), projectStateDir(config));
      try {
        const requestedTask = valueOf(args, '--task');
        const requestedIssue = valueOf(args, '--issue');
        const tasks = store.list();
        const task = requestedTask
          ? tasks.find((candidate) => candidate.id === requestedTask)
          : requestedIssue
            ? tasks.find((candidate) => candidate.issueNumber === Number(requestedIssue))
            : [...tasks].reverse().find((candidate) => candidate.rewardRunId);
        if (!task) throw new Error('No matching task was found. Use --task TASK_ID or --issue NUMBER.');
        if (!task.rewardRunId) throw new Error(`Task ${task.id} has no completed reward run.`);
        const scorecard = store.getScorecard(task.rewardRunId);
        if (!scorecard) throw new Error(`Reward scorecard ${task.rewardRunId} is missing.`);
        console.log(json ? JSON.stringify(scorecard, null, 2) : formatReward(scorecard));
        return scorecard.passed ? 0 : 1;
      } finally {
        store.close();
      }
    }
    case 'community': {
      const config = loadProjectConfig(root);
      const credential = resolveQwenCredential(config);
      if (credential) assertQwenCredentialCompatibility(config, credential);
      const store = new PersistentTaskStore(projectIdFor(config), projectStateDir(config));
      try {
        const github = new OctokitControlPlane({
          repo: config.project.githubRepo,
          token: await resolveGitHubToken(root),
        });
        const collector = new CommunityCollector(
          config,
          store,
          github,
          new QwenApiClient({
            model: config.qwen.model,
            baseUrl: config.qwen.baseUrl,
            credentialEnvKey: config.qwen.credentialEnvKey,
            apiKey: credential?.apiKey,
          }),
        );
        const result = await collector.scan({ force: hasFlag(args, '--force') });
        console.log(
          json
            ? JSON.stringify(result, null, 2)
            : `Community scan: checked=${result.checked} changed=${result.changed} created=${result.created} skipped=${result.skipped} failed=${result.failed}`,
        );
        return 0;
      } finally {
        store.close();
      }
    }
    case 'run':
    case 'reconcile': {
      const config = loadProjectConfig(root);
      const harness = await createProductionHarness(config);
      try {
        const result = await harness.supervisor.tick();
        console.log(json ? JSON.stringify(result, null, 2) : `${result.action}${result.processedTaskId ? ` ${result.processedTaskId}` : ''}`);
      } finally {
        harness.close();
      }
      return 0;
    }
    case 'worker': {
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort());
      process.once('SIGTERM', () => controller.abort());
      await runDaemon({ once: hasFlag(args, '--once'), signal: controller.signal });
      return 0;
    }
    default:
      throw new Error(`Unknown command: ${command}\n\n${help()}`);
  }
}

function formatStatus(
  projectId: string,
  counts: Record<string, number>,
  tasks: ReturnType<PersistentTaskStore['list']>,
): string {
  const details = tasks
    .filter((task) => !['done', 'cancelled'].includes(task.state))
    .map(
      (task) =>
        `${task.id}  #${task.issueNumber}  ${task.state.padEnd(12)} attempts=${task.attempts}/${task.maxAttempts}` +
        `${task.prNumber ? ` PR=#${task.prNumber}` : ''}${task.branch ? ` branch=${task.branch}` : ''}` +
        `${task.spec?.dependencies.length ? ` deps=[${task.spec.dependencies.join(',')}]` : ''}` +
        `${task.lastError ? `\n  error: ${task.lastError.slice(0, 500)}` : ''}`,
    );
  return [`Project: ${projectId}`, `Counts: ${JSON.stringify(counts)}`, '', ...details].join('\n');
}

function formatReward(scorecard: NonNullable<ReturnType<PersistentTaskStore['getScorecard']>>): string {
  return [
    `${scorecard.passed ? 'PASS' : 'FAIL'}  reward ${scorecard.id}`,
    `Task: ${scorecard.taskId}`,
    `Commit: ${scorecard.commitSha}`,
    `Aggregate: ${scorecard.aggregateScore.toFixed(3)} / ${scorecard.aggregateThreshold.toFixed(3)}`,
    `Hard gates: ${scorecard.hardGatePass ? 'passed' : 'failed'}`,
    '',
    ...scorecard.criteria.map(
      (criterion) =>
        `${criterion.passed ? 'PASS' : 'FAIL'}  ${criterion.id.padEnd(24)} ${criterion.score.toFixed(3)} / ${criterion.threshold.toFixed(3)}  ${criterion.reason}`,
    ),
    ...(scorecard.blockingReasons.length > 0 ? ['', 'Blocking reasons:', ...scorecard.blockingReasons.map((reason) => `- ${reason}`)] : []),
  ].join('\n');
}

function firstPositional(args: string[]): string | undefined {
  const valueOptions = new Set(['--name', '--repo', '--trusted-author', '--billing-plan', '--base-url', '--api-key-env', '--lines', '--task', '--issue']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (valueOptions.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function billingPlanValue(args: string[]): 'standard' | 'token-plan-personal' | 'token-plan-team' | 'coding-plan' | 'custom' | undefined {
  const value = valueOf(args, '--billing-plan');
  if (value === undefined) return undefined;
  if (!['standard', 'token-plan-personal', 'token-plan-team', 'coding-plan', 'custom'].includes(value)) {
    throw new Error(`Invalid --billing-plan: ${value}`);
  }
  return value as 'standard' | 'token-plan-personal' | 'token-plan-team' | 'coding-plan' | 'custom';
}

function help(): string {
  return `qwen-harness ${VERSION}

Usage: qwen-harness <command> [project] [options]

Commands:
  init                 Guided, idempotent project setup
  update               Refresh installer-owned assets and migrations
  doctor [--live]      Readiness matrix; --live performs a Qwen API call
  verify               Alias for live doctor
  register             Register a project with qwen-harnessd
  unregister           Remove a project registration
  run | reconcile      Run one bounded project supervisor tick
  worker [--once]      Run the persistent multi-project worker
  status [--json]      Show tasks, leases, sessions, PRs, and rewards
  logs [--lines N]     Tail the redacted append-only event ledger
  reward               Show the latest stored universal reward scorecard
  community [--force]  Scan allowlisted sources and create review-only issues
  uninstall --yes      Remove unchanged installer-owned files

Init options:
  --dry-run --yes --name NAME --repo OWNER/NAME --trusted-author LOGIN --billing-plan PLAN
  --base-url URL --api-key-env NAME
  --auto-merge --community --configure-github --install-qwen --with-mm --with-browser --install-cli --persist-api-key
  --install-service --no-service --no-link-extension --skip-dependencies

Reward options:
  --task TASK_ID --issue NUMBER --json
`;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(redactText(error instanceof Error ? error.message : String(error)));
    if (process.env.DEBUG && error instanceof Error) console.error(redactText(error.stack ?? error.message));
    process.exitCode = 1;
  },
);
