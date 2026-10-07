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
import { deliveryChoices } from './menu.js';
import type { TerminalMenu } from './menu.js';
import { listSpecifications } from '../intake/specification.js';
import type { SpecificationRecord } from '../intake/specification.js';

export interface TerminalIO {
  question(prompt: string): Promise<string | null>;
  print(text: string): void;
  close(): void;
  secret?(prompt: string): Promise<string | null>;
  activity?(label: string): (success: boolean) => void;
  signal?: AbortSignal;
  screen?(lines: TerminalScreenLine[]): void;
  select?(menu: TerminalMenu): Promise<string | null>;
  document?(title: string, text: string): Promise<void>;
  begin?(title: string): void;
  finish?(): Promise<void>;
  live?(title: string, read: () => Promise<string>, refreshMs: number): Promise<void>;
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
  specifications?: (root: string) => Array<Pick<SpecificationRecord, 'id' | 'createdAt'> & { draft: Pick<SpecificationRecord['draft'], 'title'> }>;
  workerStatus?: () => Promise<WorkerStatus>;
  credential?: typeof resolveQwenCredential;
  saveCredential?: typeof saveUserModelCredential;
  refreshMs?: number;
  loginGitHub?: () => Promise<number>;
}): Promise<number> {
  const io = options.io ?? createTerminalIO();
  const snapshot = options.snapshot ?? readTerminalSnapshot;
  const projects = options.projects ?? (() => new ProjectRegistry().list().map((item) => ({ root: item.root, name: item.id })));
  const specifications = options.specifications ?? listSpecifications;
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

  async function reviewProgram(plan: PortfolioPlan, current: TerminalSnapshot): Promise<string | undefined> {
    const checks = ['CONFIGURED CHECKS', 'Required checks cannot be waived by this console.',
      ...current.config.gates.map((gate) => `${gate.id} — ${gate.required ? 'required' : 'optional'}: ${gate.command} ${gate.args.join(' ')}`),
      `Configured automatic staging: ${current.config.deployment.staging.enabled ? 'enabled' : 'disabled'}`].join('\n');
    const full = `${formatTerminalPlan(plan)}\n\n${checks}`;
    if (!io.document || !io.select) {
      io.print(full);
      if (!['draft', 'awaiting_initial_approval', 'awaiting_material_approval', 'approving'].includes(plan.status)) {
        io.print('This program is not awaiting approval.'); return undefined;
      }
      io.print('\n1. Approve this revision\n2. Request changes (redraft before initial approval)\n0. Defer');
      return (await io.question('Review decision: '))?.trim();
    }
    const parts = full.split(/\n\n(?=OBJECTIVE\n|ACCEPTANCE\n|CONSTRAINTS\n|FROZEN TECHNOLOGY\n|DEPLOYMENT AUTHORITY\n|OBJECTIVE COVERAGE\n|CURRENT DELIVERY STORIES\n|LATEST REVISION\n|CONFIGURED CHECKS\n)/);
    const names = ['Overview', 'Objective', 'Acceptance criteria', 'Constraints', 'Technology decisions', 'Deployment authority', 'Coverage & evidence', 'Delivery steps', 'Revision history', 'Required checks'];
    const sectionKeys = parts.map((_, index) => String(index + 1));
    const pending = ['draft', 'awaiting_initial_approval', 'awaiting_material_approval', 'approving'].includes(plan.status);
    while (!io.signal?.aborted) {
      const selection = await io.select({ title: `Review plan · version ${plan.revision ?? 1}`, header: [
        { text: `  Fern Delivery · ${plan.title}`, tone: 'title' }, { text: '', tone: 'rule' },
        { text: `  ${planStatusLabel(plan.status)}`, tone: 'attention' },
        { text: `  ${planSize(plan)} · Reading does not change this program.` },
      ], choices: [
        ...parts.map((_, index) => ({ value: sectionKeys[index], label: names[index] ?? 'Plan details', description: index === 0 ? plan.objective : 'Open the read-only reader. Scroll or jump between sections; return here when finished.' })),
        { value: '11', label: 'Read complete plan', description: 'All contracts, evidence, constraints and required checks. Nothing is omitted.' },
        ...(pending ? [{ value: '12', label: 'Approve this revision…', description: 'Opens a separate confirmation. A running worker may pick up approved work.' },
          { value: '13', label: 'Request changes…', description: 'Draft revisions before approval; approved boundaries remain protected.' }] : []),
        { value: '0', label: 'Defer / back', description: 'Leave this plan unchanged.' },
      ] });
      if (!selection || selection === '0') return undefined;
      if (selection === '12' && pending) return '1';
      if (selection === '13' && pending) return '2';
      const index = sectionKeys.indexOf(selection);
      const part = selection === '11' ? full : parts[index];
      if (part !== undefined) await io.document(selection === '11' ? 'Complete plan' : names[index] ?? 'Plan details', part);
    }
    return undefined;
  }

  async function selectProject(): Promise<string | undefined> {
    const items = projects();
    if (io.select) {
      const selected = await io.select({ title: 'Choose your project', choices: [
        ...items.map((item, index) => ({ value: String(index + 1), label: item.name, description: item.root })),
        { value: String(items.length + 1), label: 'Open another folder', description: 'Use an existing project or start with an empty folder.' },
        { value: '0', label: 'Exit' },
      ] });
      if (!selected || selected === '0') return undefined;
      if (selected !== String(items.length + 1)) return items[Number(selected) - 1]?.root;
      const folder = (await io.question('Project folder (Enter cancels): '))?.trim();
      return folder ? path.resolve(folder) : undefined;
    }
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
    if (io.select) {
      const answer = await io.select({ title: 'Choose a delivery plan', choices: [
        ...items.map((plan, index) => ({ value: String(index + 1), label: `${plan.title} · v${plan.revision ?? 1}`, description: `${planStatusLabel(plan.status)} · ${planSize(plan)}` })),
        { value: '0', label: 'Back' },
      ] });
      return answer && answer !== '0' ? items[Number(answer) - 1] : undefined;
    }
    items.forEach((plan, index) => io.print(`${index + 1}. ${plan.title} — plan version ${plan.revision ?? 1}, ${planStatusLabel(plan.status)}, ${planSize(plan)}`));
    const answer = (await io.question('Plan number (Enter returns): '))?.trim();
    if (!answer) return undefined;
    const selected = /^\d+$/.test(answer) ? items[Number(answer) - 1] : undefined;
    if (!selected) io.print('Invalid program number.');
    return selected;
  }

  async function choose(title: string, labels: string[], prompt: string, context?: string): Promise<string | undefined> {
    if (io.select) return (await io.select({ title, ...(context ? { header: [
      { text: `  Fern Delivery · ${title}`, tone: 'title' as const }, { text: '', tone: 'rule' as const },
      ...context.split('\n').map((text) => ({ text: `  ${text}` })),
    ] } : {}), choices: [
      ...labels.map((label, index) => ({ value: String(index + 1), label })),
      { value: '0', label: 'Back to dashboard' },
    ] })) ?? undefined;
    io.print(labels.map((label, index) => `${index + 1}. ${label}`).join('\n') + '\n0. Return');
    return (await io.question(prompt))?.trim();
  }

  async function confirm(title: string, detail: string): Promise<boolean> {
    if (io.select) return await io.select({ title, initial: '0', header: [
      { text: '  Fern Delivery · Confirm decision', tone: 'title' }, { text: '', tone: 'rule' },
      { text: `  ${detail}`, tone: 'attention' },
    ], choices: [
      { value: '1', label: title, description: detail },
      { value: '0', label: 'Cancel', description: 'Leave everything unchanged.' },
    ] }) === '1';
    io.print(`${detail}\n1. ${title}\n0. Cancel`);
    return (await io.question('Choose a number [0 cancels]: '))?.trim() === '1';
  }

  async function selectSpecification(): Promise<string | undefined> {
    const saved = specifications(root!);
    if (!saved.length) { io.print('No saved specifications. Choose a document or describe an idea first.'); return; }
    const picked = await choose('Saved specifications', saved.map((record) => `${terminalText(record.draft.title)} · ${terminalText(record.createdAt)} · ${record.id}`), 'Choose specification: ');
    return saved[Number(picked) - 1]?.id;
  }

  async function draftSpec(): Promise<void> {
    const source = await choose('Draft a product spec', ['Use a document', 'Describe an idea', 'Review a saved specification'], 'Choose input: ',
      'The harness writes a private proposal. This does not set up GitHub, approve a plan or start delivery.');
    if (!source || source === '0') return;
    if (source === '3') {
      const id = await selectSpecification();
      if (id) await execute(['spec-status', root!, '--spec', id]);
      return;
    }
    if (!['1', '2'].includes(source)) return;
    const input = (await io.question(source === '1'
      ? 'Document inside this folder (Enter cancels): '
      : 'Describe what you want to build (Enter cancels): '))?.trim();
    if (!input) return;
    if (input.startsWith('-')) throw new Error('Input cannot start with a CLI flag. Use ./ before a filename starting with a dash.');
    const args = ['spec', root!, source === '1' ? '--input' : '--idea', input];
    if (source === '1' && /\.pdf$/i.test(input)) {
      const pages = (await io.question('PDF pages to include (for example 1-4; Enter includes all; 0 cancels): '))?.trim();
      if (pages === undefined || pages === '0') return;
      if (pages) {
        if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(pages)) throw new Error('Use page numbers or ranges, for example 1-4,6.');
        args.push('--pages', pages);
      }
    }
    if (!await confirm('Generate private spec', 'Sends the selected input to your configured model provider and saves a private draft. No delivery approval or GitHub publication.')) return;
    await execute(args);
    io.print('Spec drafted for review. No delivery plan was approved or started.');
  }

  async function redraft(plan?: PortfolioPlan): Promise<void> {
    if (plan && (!['draft', 'awaiting_initial_approval'].includes(plan.status) || plan.approvedAt !== null)) {
      io.print('The objective is already approved. Material revisions remain paused; automatic redrafting here cannot change the frozen objective.');
      return;
    }
    let sourcePath: string | undefined;
    if (plan?.sourcePath.startsWith('harness-spec:')) sourcePath = plan.sourcePath;
    else {
      if (!plan && specifications(root!).length) {
        const source = await choose('Delivery plan input', ['Use a saved model-generated specification', 'Use a requirements file'], 'Choose input: ');
        if (!source || source === '0') return;
        if (source === '1') {
          const id = await selectSpecification();
          if (!id) return;
          sourcePath = `harness-spec:${id}`;
        } else if (source !== '2') return;
      }
      if (!sourcePath) {
        const requirements = (await io.question(`Requirements file inside the project${plan ? ` [${plan.sourcePath}]` : ''}: `))?.trim();
        if (requirements === undefined) return;
        sourcePath = requirements || plan?.sourcePath;
      }
    }
    if (!sourcePath) { io.print('No requirements file selected.'); return; }
    if (sourcePath.startsWith('-')) throw new Error('Use ./ before a filename starting with a dash; filenames cannot act as CLI flags.');
    const sourceArgs = sourcePath.startsWith('harness-spec:') ? ['--spec', sourcePath.slice('harness-spec:'.length)] : ['--requirements', sourcePath];
    const feedback = plan ? (await io.question('Review feedback file inside the project (Enter cancels): '))?.trim() : undefined;
    if (plan && !feedback) return;
    if (feedback?.startsWith('-')) throw new Error('Use ./ before a filename starting with a dash; filenames cannot act as CLI flags.');
    const defaultMax = Math.max(DEFAULT_MAX_PORTFOLIO_STORIES, plan?.stories.filter((story) => !story.supersededAt).length ?? 0);
    const answer = (await io.question(`Maximum stories [${defaultMax}]: `))?.trim();
    if (answer === undefined) return;
    const max = answer ? Number(answer) : defaultMax;
    if (!Number.isSafeInteger(max) || max < 1) throw new Error('Maximum stories must be a positive integer.');
    if (!await confirm('Generate draft', `This calls Qwen and publishes proposal issues to ${snapshot(root!).config.project.githubRepo} on GitHub. Repository visibility has not been checked here; do not include confidential material unless its access is appropriate. This does not approve delivery.`)) { io.print('Cancelled; no program was generated or approved.'); return; }
    await execute(plan
      ? ['plan-redraft', root!, '--plan', plan.id, ...sourceArgs, '--feedback', feedback!, '--max-stories', String(max)]
      : ['plan', root!, ...sourceArgs, '--max-stories', String(max)]);
    io.print('Draft saved. Return to Review/approve program; drafting never approves it.');
  }

  async function setupProject(current?: TerminalSnapshot): Promise<void> {
    const action = await choose('Project setup', ['Set up this project', 'Refresh harness assets (no worker startup)', 'Sign in to an existing GitHub account', 'Switch project'], 'Setup: ');
    if (action === '4') { root = undefined; return; }
    if (action === '3') {
      io.print('Sign in to an existing GitHub account using GitHub CLI. No account or repository is created by this console.');
      if (!await confirm('Open GitHub sign-in', 'Sign in to an existing GitHub account. No new account or repository is created.')) return;
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
      if (await confirm('Refresh harness assets', 'Update harness-owned files without starting the worker.')) await execute(['update', root!, '--no-service']);
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
    const tools = await choose('Qwen Code during setup', ['Install or upgrade Qwen Code', 'Keep the existing installation'], 'Choose a number (0 cancels): ');
    if (!['1', '2'].includes(tools ?? '')) return;
    const installQwen = tools === '1';
    io.print('Setup writes harness configuration/rules, installs locked dependencies and links the CLI/extension. It enables objective programs and gated auto-merge; existing staging/production authority is preserved. It does not approve work or start the worker.');
    if (!await confirm('Set up this project', `Configure ${projectName} (${repository}). Writes harness assets and installs dependencies; no work is approved or started.`)) return;
    await execute(['init', root!, '--yes', '--name', projectName, '--repo', repository,
      ...(trusted ? ['--trusted-author', trusted] : []), ...(installQwen ? ['--install-qwen'] : []), '--no-service', '--install-cli', '--link-extension', '--configure-github']);
    io.print('Setup complete. Next: Model connection, Readiness, then Create/review program. No work was approved.');
  }

  async function modelConnection(current: TerminalSnapshot): Promise<void> {
    const config = current.config;
    const resolved = credential(config);
    const context = `Model: ${config.qwen.model} (preserved)\nProvider route: ${config.qwen.billingPlan}\nEndpoint: ${config.qwen.baseUrl}\nCredential: ${config.qwen.credentialEnvKey} — ${resolved ? `found in ${resolved.source}; ${liveVerified(config) ? 'live verified this session' : 'not live-verified'}` : 'missing'}`;
    io.print(`\nMODEL CONNECTION\n${context}`);
    const action = await choose('Model connection', ['Configure provider / endpoint', 'Add or replace credential (hidden input)', 'Verify live model connection'], 'Connection: ', context);
    if (action === '1') {
      const route = await choose('Provider route', ['Standard API', 'Token Plan Personal', 'Token Plan Team', 'Custom compatible endpoint'], 'Provider route (Enter cancels): ');
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
      if (!await confirm('Save model connection', `Model requests and credentials will be sent to ${url.origin}. No worker is started.`)) return;
      await execute(['update', root!, '--billing-plan', billing, '--base-url', url.toString().replace(/\/$/, ''), '--api-key-env', envKey, '--no-service', '--skip-dependencies']);
      verifiedConnection = undefined;
    } else if (action === '2') {
      if (!io.secret) throw new Error('Hidden credential input is unavailable. Configure the named environment variable through your credential manager.');
      io.print('The key will be hidden and stored in your user Qwen .env with owner-only permissions, never in this repository, logs, or command arguments.');
      if (!await confirm('Enter and save a credential', 'Store a key privately in your user Qwen environment, outside this repository.')) return;
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
      if (await confirm('Test model connection', 'Make a small live Qwen request using your provider plan.')) {
        await execute(['verify', root!]);
        const key = credential(config);
        if (key) verifiedConnection = { root: root!, model: config.qwen.model, endpoint: config.qwen.baseUrl, envKey: config.qwen.credentialEnvKey, apiKey: key.apiKey };
      }
    }
  }

  async function watchProgress(): Promise<void> {
    if (io.live) {
      await io.live('Live progress · read-only', async () => formatLiveStatus(snapshot(root!), await workerStatus()), options.refreshMs ?? 3_000);
      return;
    }
    io.print('LIVE PROGRESS — read-only; 0 or Enter returns. This does not run or resume delivery.');
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
    try { await io.question('0 · Back to dashboard (Enter also returns): '); }
    finally { open = false; clearInterval(timer); }
  }

  try {
    while (true) {
      if (!root) { root = await selectProject(); if (!root) return 0; }
      let current: TerminalSnapshot | undefined;
      try { current = snapshot(root); }
      catch (error) {
        // A new folder is a supported intake state, not a configuration failure.
        if (existsSync(path.join(root, PROJECT_CONFIG_PATH))) io.print(`Project configuration needs attention: ${terminalText(String(error))}\nChoose Project setup (6) to repair it.`);
      }
      const connection = current ? credential(current.config) : null;
      const lines = homeScreen({ root, snapshot: current,
        connection: current && liveVerified(current.config) ? 'verified' : connection ? 'found' : 'missing',
        worker: current ? await workerStatus().catch(() => 'unknown' as const) : 'unknown',
      });
      let action: string | undefined;
      if (io.select) {
        const next = lines.find((line) => line.text.includes('Next:'))?.text.match(/Next: (\d)/)?.[1];
        const header = [lines[0], lines[1], lines[2], ...lines.filter((line) => /^  (Plan|AI|Service|Staging) {2}/.test(line.text))];
        action = (await io.select({ title: 'What would you like to do?', choices: deliveryChoices, header, initial: next })) ?? undefined;
      } else {
        if (io.screen) io.screen(lines);
        else io.print(lines.map((line) => line.text).join('\n'));
        action = (await io.question('Choose a number (0 exits): '))?.trim();
      }
      if (action === undefined || action === '0') return 0;
      io.begin?.(deliveryChoices.find((choice) => choice.value === action)?.label ?? 'Fern Delivery');
      try {
        if (!current && !['6', '8', '9'].includes(action)) throw new Error('Set up this project first: choose Project setup.');
        switch (action) {
          case '9': await draftSpec(); break;
          case '1': {
            const plan = await selectPlan(current!.plans);
            if (!plan) break;
            const review = await reviewProgram(plan, current!);
            if (review === '2') { await redraft(plan); break; }
            if (review !== '1') { io.print('Deferred; program remains unchanged.'); break; }
            io.print('Approval freezes this program and publishes executable work for the current wave. An already-running worker may pick it up immediately.');
            if (!await confirm(`Approve revision ${plan.revision ?? 1}`, `${plan.title} · ${plan.id} · revision ${plan.revision ?? 1}. Publishes executable work; a running worker may start it immediately.`)) {
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
            const progress = await choose('Progress', ['Live read-only progress', 'Task details'], 'Progress: ');
            if (progress === '1') await watchProgress();
            if (progress === '2') await execute(['status', root]);
            break;
          }
          case '4': await execute(['doctor', root]); break;
          case '5': {
            const evidence = await choose('Evidence & history', ['Deployment status', 'Feedback signals', 'Recent logs', 'Objective evidence report', 'Controller version history'], 'Evidence: ');
            if (evidence === '1') await execute(['deploy-status', root]);
            if (evidence === '2') await execute(['signals', root]);
            if (evidence === '3') await execute(['logs', root, '--lines', '50']);
            if (evidence === '4') { const plan = await selectPlan(current!.plans); if (plan) await execute(['evidence-report', root, '--plan', plan.id]); }
            if (evidence === '5') await execute(['controller-status', root]);
            break;
          }
          case '6': await setupProject(current); break;
          case '7': {
            const execution = await choose('Start / resume delivery', ['Start shared background worker', 'Run one bounded project cycle', 'Worker service status'], 'Execution: ');
            if (execution === '3') { io.print(`Worker: ${await workerStatus()} (service liveness only)`); break; }
            if (!['1', '2'].includes(execution ?? '')) break;
            if ((current!.config.program.enabled || current!.plans.length) && !current!.plans.some((plan) => plan.approvedAt !== null) && !current!.tasks.length) {
              io.print('Approve a program before initiating execution. No worker or cycle was started.'); break;
            }
            if (execution === '2') {
              io.print('This reconciles durable state and may implement approved product work; it is not a read-only status check.');
              if (await confirm('Run one delivery cycle', 'This may implement approved work in this project; it is not a read-only check.')) await execute(['reconcile', root]);
              break;
            }
            if (await workerStatus() === 'running') {
              io.print('The shared worker is already running. Choose Live progress to follow delivery; no restart or setup update was performed.');
              break;
            }
            io.print('This installs/starts the shared worker for ALL enabled registered projects, not just this project. The host must stay awake and connected.');
            projects().forEach((item) => io.print(`- ${item.name}: ${item.root}`));
            if (!await confirm('Start shared worker', 'Starts execution for ALL enabled registered projects, not just this project.')) break;
            await execute(['update', root, '--install-service']);
            io.print('Service installation attempted. Check its result above; installation is not proof of successful delivery.');
            break;
          }
          case '8': if (current) await modelConnection(current); else io.print('Choose Project setup first; model connection will then be available.'); break;
          default: io.print('Choose a listed menu number.');
        }
      } catch (error) { io.print(`Error: ${terminalText(error instanceof Error ? error.message : String(error))}\nThe console remains available. Review status before retrying.`); }
      if (!io.signal?.aborted) await io.finish?.();
      if (io.select && !io.signal?.aborted) {
        await io.select({ title: 'Return to dashboard', initial: '0', choices: [
          { value: '0', label: 'Back to dashboard', description: 'Return without restarting or changing delivery.' },
        ] });
      }
    }
  } finally { io.close(); }
}
