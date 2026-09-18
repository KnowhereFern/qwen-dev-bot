import { existsSync } from 'node:fs';
import path from 'node:path';
import { defaultProjectConfig, loadProjectConfig, PROJECT_CONFIG_PATH } from '../core/config.js';
import { redactText } from '../core/ledger.js';
import { PersistentTaskStore } from '../core/persistent-store.js';
import { projectIdFor, projectStateDir } from '../core/state-paths.js';
import type { DeploymentRecord, PortfolioPlan, ProjectConfig, QwenBillingPlan, TaskRecord } from '../core/types.js';
import { ProjectRegistry } from '../registry.js';
import { DEFAULT_MAX_PORTFOLIO_STORIES } from '../portfolio/planner.js';
import { createTerminalIO } from './presentation.js';
import { formatLiveStatus, readWorkerStatus } from './status.js';
import type { WorkerStatus } from './status.js';
import { resolveQwenCredential, qwenCredentialCompatibilityProblem } from '../qwen/credential-resolver.js';
import { DEFAULT_QWEN_BASE_URL, TOKEN_PLAN_QWEN_BASE_URL } from '../qwen/runtime-compat.js';
import { saveUserModelCredential } from './model-connection.js';
import { format } from 'node:util';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../runtime/safe-process.js';
import { homeScreen, planSize, planStatusLabel } from './home.js';
import type { TerminalScreenLine } from './home.js';

export interface TerminalIO {
  question(prompt: string): Promise<string | null>;
  print(text: string): void;
  close(): void;
  secret?(prompt: string): Promise<string | null>;
  activity?(label: string): (success: boolean) => void;
  signal?: AbortSignal;
  screen?(lines: TerminalScreenLine[]): void;
}

export interface TerminalSnapshot {
  config: ProjectConfig;
  plans: PortfolioPlan[];
  tasks: TaskRecord[];
  deployments?: DeploymentRecord[];
}

export function readTerminalSnapshot(root: string): TerminalSnapshot {
  const config = loadProjectConfig(root);
  const store = new PersistentTaskStore(projectIdFor(config), projectStateDir(config));
  try {
    return { config, plans: store.listPortfolioPlans(), tasks: store.list(), deployments: store.listDeployments() };
  } finally {
    store.close();
  }
}

// Strip terminal control sequences in repository/model evidence and never print credentials.
export function terminalText(value: string): string {
  return redactText(value).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export function formatTerminalPlan(plan: PortfolioPlan): string {
  const stories = plan.stories.filter((story) => !story.supersededAt);
  const waves = new Set(stories.map((story) => story.wave ?? 1));
  return terminalText([
    `${plan.title} — plan version ${plan.revision ?? 1} — ${planStatusLabel(plan.status)}`,
    `Plan: ${plan.id}`,
    `Review: ${plan.epicIssueUrl ?? 'not published'}`,
    `Assessed commit: ${plan.repositorySha ?? 'legacy plan: no repository assessment'}`,
    `Objective file: ${plan.sourcePath}; hash: ${plan.contentHash}`,
    `${stories.length} current stories / ${waves.size} waves; current wave ${plan.currentWave ?? 1}`,
    `${plan.stories.length - stories.length} superseded stories retained in history (not current work).`,
    '', 'OBJECTIVE', plan.objective,
    '', 'ACCEPTANCE', ...plan.definitionOfDone.map((item) => `- ${item}`),
    '', 'CONSTRAINTS', ...plan.constraints.map((item) => `- ${item}`),
    '', 'FROZEN TECHNOLOGY', ...plan.technologyDecisions.map((item) => `- ${item.id}: ${item.technology} (${item.source}) — ${item.rationale}`),
    '', 'DEPLOYMENT AUTHORITY', ...plan.deploymentDecisions.map((item) => `- ${item.id}: ${item.provider}/${item.environment} — ${item.authority}: ${item.rationale}`),
    'Only explicitly configured staging is automatic. Production needs explicit approval. No purchases or new accounts.',
    '', 'OBJECTIVE COVERAGE', ...(plan.coverage ?? []).flatMap((item) => [
      `- ${item.id}: ${item.status}/${item.requiredAction ?? 'legacy'} — ${item.requirement}`,
      `  ${item.rationale}`,
      ...item.evidence.map((evidence) => `  Evidence: ${evidence.kind} ${evidence.locator} @ ${evidence.commitSha ?? 'unversioned'} — ${evidence.summary}`),
    ]),
    '', 'CURRENT DELIVERY STORIES', ...stories.flatMap((story) => [
      `\n${story.key}: ${story.title} — wave ${story.wave ?? 1}, ${story.workType ?? 'implement'}, risk ${story.risk}`,
      `Goal: ${story.goal}`,
      `Depends on: ${story.dependsOn.join(', ') || 'none'}`,
      ...story.acceptanceCriteria.map((item) => `  Accept: ${item}`),
      ...story.constraints.map((item) => `  Constraint: ${item}`),
      `Required checks: ${story.requiredGateIds.join(', ') || 'none'}`,
      `Review criteria: ${story.rewardCriterionIds.join(', ') || 'none'}`,
      `Rollback: ${story.rollback}`,
      `Review: ${story.sourceIssueUrl ?? 'not published'}`,
    ]),
    '', 'LATEST REVISION', plan.revisions?.at(-1)?.summary ?? 'Initial legacy plan',
  ].join('\n'));
}

export async function runInteractiveTerminal(options: {
  root?: string;
  execute?: (argv: string[]) => Promise<number>;
  io?: TerminalIO;
  snapshot?: (root: string) => TerminalSnapshot;
  projects?: () => Array<{ root: string; name: string }>;
  workerStatus?: () => Promise<WorkerStatus>;
  credential?: typeof resolveQwenCredential;
  saveCredential?: typeof saveUserModelCredential;
  refreshMs?: number;
  loginGitHub?: () => Promise<number>;
}): Promise<number> {
  const io = options.io ?? createTerminalIO();
  const snapshot = options.snapshot ?? readTerminalSnapshot;
  const projects = options.projects ?? (() => new ProjectRegistry().list().map((item) => ({ root: item.root, name: item.id })));
  const workerStatus = options.workerStatus ?? readWorkerStatus;
  const credential = options.credential ?? resolveQwenCredential;
  let verifiedConnection: { root: string; model: string; endpoint: string; envKey: string; apiKey: string } | undefined;
  const liveVerified = (config: ProjectConfig) => Boolean(verifiedConnection && verifiedConnection.root === root && verifiedConnection.model === config.qwen.model && verifiedConnection.endpoint === config.qwen.baseUrl && verifiedConnection.envKey === config.qwen.credentialEnvKey && verifiedConnection.apiKey === credential(config)?.apiKey);
  let root = options.root ? path.resolve(options.root) : existsSync(path.join(process.cwd(), PROJECT_CONFIG_PATH)) ? process.cwd() : undefined;
  const command = options.execute ?? (async (argv: string[]) => {
    let stdout = '';
    let stderr = '';
    const emit = (chunk: string, error: boolean) => {
      const pending = (error ? stderr : stdout) + chunk;
      const lines = pending.split('\n');
      const remainder = lines.pop() ?? '';
      if (error) stderr = remainder; else stdout = remainder;
      for (const line of lines) if (line) io.print(terminalText(line));
    };
    const result = await runProcess({
      command: process.execPath, args: [fileURLToPath(new URL('../../bin/qwen-harness.mjs', import.meta.url)), ...argv],
      cwd: root!, signal: io.signal,
      onStdout: (chunk) => emit(chunk, false), onStderr: (chunk) => emit(chunk, true),
    });
    if (stdout) io.print(terminalText(stdout));
    if (stderr) io.print(terminalText(stderr));
    return result.aborted ? 130 : result.exitCode ?? 1;
  });
  const execute = async (argv: string[]): Promise<void> => {
    io.print(`\nRunning ${argv[0]}…`);
    const stop = io.activity?.(argv[0]);
    const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    let success = false;
    try {
      // Route existing command output through the console without letting evidence inject terminal control sequences.
      for (const method of ['log', 'info', 'warn', 'error'] as const) console[method] = (...args) => io.print(terminalText(format(...args)));
      const code = await command(argv);
      if (code !== 0) throw new Error(`${argv[0]} failed (exit ${code}). No approval is inferred from this failure.`);
      success = true;
    } finally { Object.assign(console, saved); stop?.(success); }
  };

  async function selectProject(): Promise<string | undefined> {
    const items = projects();
    io.print('\nSELECT PROJECT');
    items.forEach((item, index) => io.print(`${index + 1}. ${item.name} — ${item.root}`));
    io.print('Enter a project number or folder path; 0 exits.');
    const answer = (await io.question('Project: '))?.trim();
    if (!answer || answer === '0') return undefined;
    if (/^\d+$/.test(answer)) {
      const item = items[Number(answer) - 1];
      if (!item) { io.print('Invalid project number.'); return selectProject(); }
      return item.root;
    }
    return path.resolve(answer);
  }

  async function selectPlan(plans: PortfolioPlan[]): Promise<PortfolioPlan | undefined> {
    const items = [...plans].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!items.length) { io.print('No delivery plan yet. Choose 2 to create one from your objective.'); return undefined; }
    items.forEach((plan, index) => io.print(`${index + 1}. ${plan.title} — plan version ${plan.revision ?? 1}, ${planStatusLabel(plan.status)}, ${planSize(plan)}`));
    const answer = (await io.question('Plan number (Enter returns): '))?.trim();
    if (!answer) return undefined;
    const selected = /^\d+$/.test(answer) ? items[Number(answer) - 1] : undefined;
    if (!selected) io.print('Invalid program number.');
    return selected;
  }

  async function redraft(plan?: PortfolioPlan): Promise<void> {
    if (plan && (!['draft', 'awaiting_initial_approval'].includes(plan.status) || plan.approvedAt !== null)) {
      io.print('The objective is already approved. Material revisions remain paused; automatic redrafting here cannot change the frozen objective.');
      return;
    }
    const requirements = (await io.question(`Requirements file inside the project${plan ? ` [${plan.sourcePath}]` : ''}: `))?.trim();
    if (requirements === undefined) return;
    const sourcePath = requirements || plan?.sourcePath;
    if (!sourcePath) { io.print('No requirements file selected.'); return; }
    if (sourcePath.startsWith('-')) throw new Error('Use ./ before a filename starting with a dash; filenames cannot act as CLI flags.');
    const feedback = plan ? (await io.question('Review feedback file inside the project (Enter cancels): '))?.trim() : undefined;
    if (plan && !feedback) return;
    if (feedback?.startsWith('-')) throw new Error('Use ./ before a filename starting with a dash; filenames cannot act as CLI flags.');
    const defaultMax = Math.max(DEFAULT_MAX_PORTFOLIO_STORIES, plan?.stories.filter((story) => !story.supersededAt).length ?? 0);
    const answer = (await io.question(`Maximum stories [${defaultMax}]: `))?.trim();
    if (answer === undefined) return;
    const max = answer ? Number(answer) : defaultMax;
    if (!Number.isSafeInteger(max) || max < 1) throw new Error('Maximum stories must be a positive integer.');
    const confirm = (await io.question('This calls Qwen to produce a review-only draft. Type draft to continue: '))?.trim();
    if (confirm !== 'draft') { io.print('Cancelled; no program was generated or approved.'); return; }
    await execute(plan
      ? ['plan-redraft', root!, '--plan', plan.id, '--requirements', sourcePath, '--feedback', feedback!, '--max-stories', String(max)]
      : ['plan', root!, '--requirements', sourcePath, '--max-stories', String(max)]);
    io.print('Draft saved. Return to Review/approve program; drafting never approves it.');
  }

  async function setupProject(current?: TerminalSnapshot): Promise<void> {
    io.print('\nPROJECT SETUP\n1. Set up this project\n2. Refresh harness assets (no worker startup)\n3. Existing GitHub account sign-in\n4. Switch project\n0. Return');
    const action = (await io.question('Setup: '))?.trim();
    if (action === '4') { root = undefined; return; }
    if (action === '3') {
      io.print('Sign in to an existing GitHub account using GitHub CLI. No account or repository is created by this console.');
      if ((await io.question('Type login to open GitHub CLI sign-in (Enter cancels): '))?.trim() !== 'login') return;
      const code = await (options.loginGitHub ?? (() => new Promise<number>((resolve, reject) => {
        const child = spawn('gh', ['auth', 'login'], { cwd: root, stdio: 'inherit', shell: false });
        child.once('error', reject);
        child.once('exit', (exit) => resolve(exit ?? 1));
      })))();
      if (code !== 0) throw new Error('GitHub sign-in did not complete. No delivery was started.');
      io.print('GitHub sign-in completed. Continue setup or readiness checks explicitly.');
      return;
    }
    if (action === '2') {
      if (!current) { io.print('Set up this folder first.'); return; }
      if ((await io.question('Type refresh to update harness-owned assets (Enter cancels): '))?.trim() === 'refresh') await execute(['update', root!, '--no-service']);
      return;
    }
    if (action !== '1') return;
    const name = (await io.question(`Project name [${current?.config.project.name ?? path.basename(root!)}]: `))?.trim();
    if (name === undefined) return;
    const repo = (await io.question(`Existing GitHub repository (owner/name)${current ? ` [${current.config.project.githubRepo}]` : ''}: `))?.trim();
    if (repo === undefined) return;
    const repository = repo || current?.config.project.githubRepo;
    if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Use an existing GitHub repository in owner/name form. No repository or account is created here.');
    const trusted = (await io.question('Trusted GitHub login (Enter uses current setup/authenticated login): '))?.trim();
    if (trusted === undefined) return;
    const projectName = name || current?.config.project.name || path.basename(root!);
    if (projectName.startsWith('-') || (trusted && !/^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/.test(trusted))) throw new Error('Use a project name and GitHub login, not CLI flags.');
    const tools = (await io.question(`Install/upgrade Qwen Code during setup? [${current ? 'y/N' : 'Y/n'}]: `))?.trim().toLowerCase();
    if (tools === undefined) return;
    const installQwen = tools ? ['y', 'yes'].includes(tools) : !current;
    io.print('Setup writes harness configuration/rules, installs locked dependencies and links the CLI/extension. It enables objective programs and gated auto-merge; existing staging/production authority is preserved. It does not approve work or start the worker.');
    if ((await io.question('Type setup to continue (Enter cancels): '))?.trim() !== 'setup') return;
    await execute(['init', root!, '--yes', '--name', projectName, '--repo', repository,
      ...(trusted ? ['--trusted-author', trusted] : []), ...(installQwen ? ['--install-qwen'] : []), '--no-service', '--install-cli', '--link-extension', '--configure-github']);
    io.print('Setup complete. Next: Model connection, Readiness, then Create/review program. No work was approved.');
  }

  async function modelConnection(current: TerminalSnapshot): Promise<void> {
    const config = current.config;
    const resolved = credential(config);
    io.print(`\nMODEL CONNECTION\nModel: ${config.qwen.model} (preserved)\nProvider route: ${config.qwen.billingPlan}\nEndpoint: ${config.qwen.baseUrl}\nCredential: ${config.qwen.credentialEnvKey} — ${resolved ? `found in ${resolved.source}; ${liveVerified(config) ? 'live verified this session' : 'not live-verified'}` : 'missing'}\n1. Configure provider/endpoint\n2. Add/replace credential (hidden input; user-only storage)\n3. Verify live model connection\n0. Return`);
    const action = (await io.question('Connection: '))?.trim();
    if (action === '1') {
      io.print('1. Standard API\n2. Token Plan Personal\n3. Token Plan Team\n4. Custom compatible endpoint');
      const route = (await io.question('Provider route (Enter cancels): '))?.trim();
      const billing = ({ '1': 'standard', '2': 'token-plan-personal', '3': 'token-plan-team', '4': 'custom' } as Record<string, QwenBillingPlan>)[route ?? ''];
      if (!billing) return;
      const suggested = billing.startsWith('token-plan-') ? TOKEN_PLAN_QWEN_BASE_URL : billing === 'standard' ? DEFAULT_QWEN_BASE_URL : config.qwen.baseUrl;
      const endpoint = (await io.question(`Endpoint [${suggested}]: `))?.trim();
      if (endpoint === undefined) return;
      const url = new URL(endpoint || suggested);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS endpoint without embedded credentials, query parameters, or fragments.');
      const env = (await io.question(`Credential environment name [${billing.startsWith('token-plan-') ? 'BAILIAN_TOKEN_PLAN_API_KEY' : config.qwen.credentialEnvKey}]: `))?.trim();
      if (env === undefined) return;
      const envKey = env || (billing.startsWith('token-plan-') ? 'BAILIAN_TOKEN_PLAN_API_KEY' : config.qwen.credentialEnvKey);
      if (!/^[A-Z_][A-Z0-9_]*$/.test(envKey)) throw new Error('Use an uppercase environment variable name, not a key.');
      io.print(`Model requests and the configured credential will be sent to ${url.origin}. This changes only the execution connection, not the model, product stack, approved objective, or deployment authority. An existing worker reads it on a later cycle. No subscription is purchased.`);
      if ((await io.question('Type connect to save (Enter cancels): '))?.trim() !== 'connect') return;
      await execute(['update', root!, '--billing-plan', billing, '--base-url', url.toString().replace(/\/$/, ''), '--api-key-env', envKey, '--no-service', '--skip-dependencies']);
      verifiedConnection = undefined;
    } else if (action === '2') {
      if (!io.secret) throw new Error('Hidden credential input is unavailable. Configure the named environment variable through your credential manager.');
      io.print('The key will be hidden and stored in your user Qwen .env with owner-only permissions, never in this repository, logs, or command arguments.');
      if ((await io.question('Type save key to continue (Enter cancels): '))?.trim() !== 'save key') return;
      const secret = await io.secret('Provider API key (hidden; Enter cancels): ');
      if (!secret) return;
      const problem = qwenCredentialCompatibilityProblem(config, { apiKey: secret, envKey: config.qwen.credentialEnvKey, source: 'Qwen user .env' });
      if (problem) throw new Error(problem);
      (options.saveCredential ?? saveUserModelCredential)(config.qwen.credentialEnvKey, secret);
      verifiedConnection = undefined;
      // Existing process/worker credentials deliberately retain precedence; never silently replace them.
      const effective = credential(config);
      io.print(effective && effective.apiKey !== secret ? `Key saved, but ${effective.source} currently takes precedence. Resolve that source before verification; no active worker credential was replaced.` : 'Key saved. Verify the connection explicitly next.');
    } else if (action === '3') {
      if ((await io.question('This makes a small live Qwen request using your provider plan. Type verify to continue: '))?.trim() === 'verify') {
        await execute(['verify', root!]);
        const key = credential(config);
        if (key) verifiedConnection = { root: root!, model: config.qwen.model, endpoint: config.qwen.baseUrl, envKey: config.qwen.credentialEnvKey, apiKey: key.apiKey };
      }
    }
  }

  async function watchProgress(): Promise<void> {
    io.print('LIVE PROGRESS — read-only; Enter returns. This does not run or resume delivery.');
    let open = true;
    let checking = false;
    let previous = '';
    const refresh = async () => {
      if (!open || checking) return;
      checking = true;
      try {
        const text = formatLiveStatus(snapshot(root!), await workerStatus());
        if (open && text !== previous) { previous = text; io.print(`[${new Date().toISOString()}]\n${text}`); }
      } catch (error) { if (open) io.print(`Live status unavailable: ${terminalText(String(error))}`); }
      finally { checking = false; }
    };
    await refresh();
    const timer = setInterval(() => { void refresh(); }, options.refreshMs ?? 3_000);
    try { await io.question('Enter to return: '); }
    finally { open = false; clearInterval(timer); }
  }

  try {
    while (true) {
      if (!root) { root = await selectProject(); if (!root) return 0; }
      let current: TerminalSnapshot | undefined;
      try { current = snapshot(root); }
      catch (error) { io.print(`Project not ready: ${terminalText(String(error))}\nChoose Project setup to initialize this folder or switch projects.`); }
      const connection = current ? credential(current.config) : null;
      const lines = homeScreen({ root, snapshot: current,
        connection: current && liveVerified(current.config) ? 'verified' : connection ? 'found' : 'missing',
        worker: current ? await workerStatus().catch(() => 'unknown' as const) : 'unknown',
      });
      if (io.screen) io.screen(lines);
      else io.print(lines.map((line) => line.text).join('\n'));
      const action = (await io.question('Choose a number (0 exits): '))?.trim();
      if (action === undefined || action === '0') return 0;
      try {
        if (!current && !['6', '8'].includes(action)) { io.print('Set up this project first: choose 6.'); continue; }
        switch (action) {
          case '1': {
            const plan = await selectPlan(current!.plans);
            if (!plan) break;
            io.print(formatTerminalPlan(plan));
            io.print('\nCONFIGURED CHECKS (required checks cannot be waived by this console)');
            current!.config.gates.forEach((gate) => io.print(`${gate.id} — ${gate.required ? 'required' : 'optional'}: ${gate.command} ${gate.args.join(' ')}`));
            io.print(`Configured automatic staging: ${current!.config.deployment.staging.enabled ? 'enabled' : 'disabled'}`);
            if (!['draft', 'awaiting_initial_approval', 'awaiting_material_approval', 'approving'].includes(plan.status)) {
              io.print('This program is not awaiting approval.'); break;
            }
            io.print('\n1. Approve this revision\n2. Request changes (redraft before initial approval)\n0. Defer');
            const review = (await io.question('Review decision: '))?.trim();
            if (review === '2') { await redraft(plan); break; }
            if (review !== '1') { io.print('Deferred; program remains unchanged.'); break; }
            const confirmation = `approve revision ${plan.revision ?? 1}`;
            io.print('Approval freezes this program and publishes executable work for the current wave. An already-running worker may pick it up immediately.');
            if ((await io.question(`Type ${confirmation} to approve (Enter cancels): `))?.trim() !== confirmation) {
              io.print('Cancelled; no approval was recorded.'); break;
            }
            await execute([plan.status === 'awaiting_material_approval' ? 'plan-approve-revision' : 'plan-approve', root, '--plan', plan.id, '--revision', String(plan.revision ?? 1), '--hash', plan.contentHash]);
            io.print('Approval recorded. Choose 3 to watch progress, or 7 to start the background worker if it is not running.');
            break;
          }
          case '2': {
            if (current!.plans.length) {
              const plan = await selectPlan(current!.plans);
              if (plan) await redraft(plan);
            } else await redraft();
            break;
          }
          case '3': {
            io.print('1. Live read-only progress\n2. Task details\n0. Return');
            const progress = (await io.question('Progress: '))?.trim();
            if (progress === '1') await watchProgress();
            if (progress === '2') await execute(['status', root]);
            break;
          }
          case '4': await execute(['doctor', root]); break;
          case '5': {
            io.print('1. Deployment status\n2. Feedback signals\n3. Recent logs\n4. Objective evidence report\n5. Controller version history\n0. Return');
            const evidence = (await io.question('Evidence: '))?.trim();
            if (evidence === '1') await execute(['deploy-status', root]);
            if (evidence === '2') await execute(['signals', root]);
            if (evidence === '3') await execute(['logs', root, '--lines', '50']);
            if (evidence === '4') { const plan = await selectPlan(current!.plans); if (plan) await execute(['evidence-report', root, '--plan', plan.id]); }
            if (evidence === '5') await execute(['controller-status', root]);
            break;
          }
          case '6': await setupProject(current); break;
          case '7': {
            io.print('1. Install/start shared background worker (resumes persisted work)\n2. One bounded project recovery/execution cycle\n3. Worker service status\n0. Return');
            const execution = (await io.question('Execution: '))?.trim();
            if (execution === '3') { io.print(`Worker: ${await workerStatus()} (service liveness only)`); break; }
            if (!['1', '2'].includes(execution ?? '')) break;
            if ((current!.config.program.enabled || current!.plans.length) && !current!.plans.some((plan) => plan.approvedAt !== null) && !current!.tasks.length) {
              io.print('Approve a program before initiating execution. No worker or cycle was started.'); break;
            }
            if (execution === '2') {
              io.print('This reconciles durable state and may implement approved product work; it is not a read-only status check.');
              if ((await io.question('Type run cycle to continue (Enter cancels): '))?.trim() === 'run cycle') await execute(['reconcile', root]);
              break;
            }
            io.print('This installs/starts the shared worker for ALL enabled registered projects, not just this project. The host must stay awake and connected.');
            projects().forEach((item) => io.print(`- ${item.name}: ${item.root}`));
            if ((await io.question('Type start worker to continue (Enter cancels): '))?.trim() !== 'start worker') break;
            await execute(['update', root, '--install-service']);
            io.print('Service installation attempted. Check its result above; installation is not proof of successful delivery.');
            break;
          }
          case '8': if (current) await modelConnection(current); else io.print('Choose Project setup first; model connection will then be available.'); break;
          default: io.print('Choose a listed menu number.');
        }
      } catch (error) { io.print(`Error: ${terminalText(error instanceof Error ? error.message : String(error))}\nThe console remains available. Review status before retrying.`); }
    }
  } finally { io.close(); }
}
