import type { DeploymentRecord, PortfolioPlan, PortfolioPlanStatus, TaskState } from '../core/types.js';
import type { TerminalSnapshot } from './interactive.js';
import type { WorkerStatus } from './status.js';

export interface TerminalScreenLine {
  text: string;
  tone?: 'title' | 'heading' | 'attention' | 'action' | 'rule';
  choices?: [string, string];
}

const planLabels: Record<PortfolioPlanStatus, string> = {
  draft: 'Draft ready for review', awaiting_initial_approval: 'Waiting for your approval',
  approving: 'Preparing approved work', active: 'Approved for delivery', assessing: 'Reassessing the plan',
  awaiting_material_approval: 'A plan change needs your approval', deploying_staging: 'Deploying to staging',
  verifying_staging: 'Checking the staging application', delivered: 'Initial objective delivered',
  maintaining: 'Maintaining the delivered product', paused: 'Delivery is paused', done: 'Plan marked complete',
  blocked: 'Delivery needs attention', superseded: 'Replaced by a newer plan',
};

const taskLabels: Record<TaskState, string> = {
  intake: 'Received', normalized: 'Preparing', ready: 'Ready to start', leased: 'Claimed by an agent',
  active: 'Implementing', verifying: 'Running checks', pr_open: 'Pull request open', waiting_ci: 'Waiting for CI checks',
  merge_ready: 'Ready to merge', post_merge: 'Checking merged code', waiting: 'Waiting', failed: 'Failed',
  quarantined: 'Paused after repeated failures', cancelled: 'Cancelled', done: 'Completed',
};

export function planStatusLabel(status: PortfolioPlanStatus): string { return planLabels[status]; }
export function taskStatusLabel(state: TaskState): string { return taskLabels[state]; }

export function planSize(plan: PortfolioPlan): string {
  const stories = plan.stories.filter((story) => !story.supersededAt);
  const stages = new Set(stories.map((story) => story.wave ?? 1)).size;
  return `${stories.length} delivery ${stories.length === 1 ? 'step' : 'steps'} in ${stages} ${stages === 1 ? 'stage' : 'stages'}`;
}

export function deploymentLabel(deployment?: DeploymentRecord): string {
  if (!deployment) return 'No staging verification recorded yet';
  const revision = deployment.commitSha.slice(0, 8);
  switch (deployment.status) {
    case 'succeeded': return deployment.observedRevision === deployment.commitSha
      ? `Verified at ${revision} (recorded result)` : `Deployment finished at ${revision}; revision not verified`;
    case 'failed': return `Failed at ${revision}; repair and re-verification needed`;
    case 'rolled_back': return `Rolled back from ${revision}; check recovery evidence`;
    case 'verifying': return `Checking application and revision at ${revision}`;
    case 'pending': return `Queued at ${revision}`;
    case 'uploading': return `Uploading ${revision}`;
    case 'building': return `Building ${revision}`;
    case 'deploying': return `Deploying ${revision}`;
  }
}

export function homeScreen(options: {
  root: string;
  snapshot?: TerminalSnapshot;
  connection: 'missing' | 'found' | 'verified';
  worker: WorkerStatus;
}): TerminalScreenLine[] {
  const { snapshot, root, connection, worker } = options;
  const plans = [...(snapshot?.plans ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  const plan = plans.find((item) => item.status !== 'superseded');
  const pending = plans.filter((item) => ['draft', 'awaiting_initial_approval', 'awaiting_material_approval', 'approving'].includes(item.status));
  const tasks = snapshot?.tasks ?? [];
  const unfinished = tasks.filter((task) => !['done', 'cancelled'].includes(task.state));
  const deployment = snapshot?.deployments?.filter((item) => !plan || item.planId === plan.id)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const initialReview = plan && plan.approvedAt === null && ['draft', 'awaiting_initial_approval'].includes(plan.status);
  const status = !snapshot ? 'Set up this project' : plan ? planStatusLabel(plan.status) : 'No delivery plan yet';
  const explanation = !snapshot ? 'Connect an existing repository and configure this folder.'
    : initialReview ? 'The plan is a proposal. It does not authorize work yet.'
    : plan?.status === 'awaiting_material_approval' ? 'Review the proposed change before delivery can continue.'
    : plan?.status === 'blocked' || plan?.status === 'paused' ? 'Check progress and logs for the reason and recovery options.'
    : plan?.status === 'delivered' || plan?.status === 'maintaining' ? 'The initial acceptance audit passed. Maintenance follows useful evidence.'
    : plan ? 'Plan approval, completed tasks, and verified delivery are different things.'
    : 'Give the harness an objective; it will propose a plan for your review.';
  const next = !snapshot ? '6 — Set up this project' : connection === 'missing' ? '8 — Connect your AI model'
    : !plan ? '2 — Create a delivery plan' : pending.length ? '1 — Review the delivery plan'
    : connection !== 'verified' ? '8 — Test the AI connection'
    : worker === 'inactive' && unfinished.length ? '7 — Start or resume approved delivery' : '3 — Watch delivery progress';
  const rows: TerminalScreenLine[] = [];
  const line = (text: string, tone?: TerminalScreenLine['tone']) => rows.push({ text: text ? `  ${text}` : '', tone });
  line(`Fern Delivery · ${snapshot?.config.project.name ?? 'Unconfigured project'}`, 'title');
  line('', 'rule');
  line(status, initialReview || plan?.status === 'awaiting_material_approval' || plan?.status === 'blocked' ? 'attention' : 'heading');
  line(explanation);
  line('');
  line(`Plan     ${plan ? `${planSize(plan)} · version ${plan.revision ?? 1}${initialReview ? ' · not started' : ` · stage ${plan.currentWave ?? 1}`}` : 'Not created yet'}`);
  line(`AI       ${snapshot?.config.qwen.model ?? 'Not configured'} · ${connection === 'verified' ? 'Connection: live verified this session' : connection === 'found' ? 'Key found · not tested this session (8)' : 'Key missing · connect your model (8)'}`);
  line(`Work     ${initialReview && !tasks.length ? 'Not scheduled until you approve the plan' : `${tasks.filter((task) => task.state === 'done').length} completed · ${unfinished.length} unfinished tasks`}`);
  line(`Service  ${worker === 'running' ? 'Shared background worker is running' : worker === 'inactive' ? 'Background worker is not running' : 'Background worker status is unknown'}`);
  line(`Staging  ${deploymentLabel(deployment)}`);
  if (pending.length > 1) line(`Review   ${pending.length} plans need attention (1)`);
  line('');
  line(`Next: ${next}`, 'action');
  line(pending.length ? 'Approval can release work to an already-running worker.' : 'Choose a number to inspect or act; execution requires confirmation.');
  line('');
  line('Plan & delivery', 'heading');
  const choices = (left: string, right: string) => rows.push({ text: `  ${left}\n  ${right}`, choices: [left, right] });
  choices('1  Review & approve plan', '2  Create or revise plan');
  choices('3  Watch progress & tasks', '4  Check readiness');
  line('7  Start or resume delivery');
  line('Project & tools', 'heading');
  choices('5  Staging, feedback, logs & proof', '6  Set up or switch project');
  choices('8  Connect or test AI', '0  Exit');
  line('');
  line(`Folder: ${root}`);
  line('Opening this console never approves or starts delivery.');
  return rows;
}
