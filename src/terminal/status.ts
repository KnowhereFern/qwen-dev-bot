import { runProcess } from '../runtime/safe-process.js';
import type { TerminalSnapshot } from './interactive.js';
import os from 'node:os';
import { deploymentLabel, planSize, planStatusLabel, taskStatusLabel } from './home.js';

export type WorkerStatus = 'running' | 'inactive' | 'unknown';

/** Read service liveness without installing, starting, stopping, or displaying its environment. */
export async function readWorkerStatus(): Promise<WorkerStatus> {
  if (process.platform === 'darwin') {
    const result = await runProcess({ command: 'launchctl', args: ['print', `gui/${process.getuid?.() ?? 0}/dev.qwen-harness.worker`], cwd: os.homedir(), timeoutMs: 3_000, maxOutputBytes: 64_000 });
    if (result.timedOut || result.aborted) return 'unknown';
    if (result.exitCode !== 0) return /could not find service|not found/i.test(result.stderr) ? 'inactive' : 'unknown';
    return /state = running|pid = \d+/.test(result.stdout) ? 'running' : 'inactive';
  }
  if (process.platform === 'linux') {
    const result = await runProcess({ command: 'systemctl', args: ['--user', 'show', 'qwen-harness.service', '--property=ActiveState', '--value'], cwd: os.homedir(), timeoutMs: 3_000 });
    if (result.exitCode !== 0 || result.timedOut) return 'unknown';
    return result.stdout.trim() === 'active' ? 'running' : 'inactive';
  }
  return 'unknown';
}

export function formatLiveStatus(snapshot: TerminalSnapshot, worker: WorkerStatus): string {
  const counts: Record<string, number> = {};
  for (const task of snapshot.tasks) counts[task.state] = (counts[task.state] ?? 0) + 1;
  const plans = snapshot.plans.map((plan) => {
    return `${plan.title}: ${planStatusLabel(plan.status)}\n  Plan version ${plan.revision ?? 1} · stage ${plan.currentWave ?? 1} · ${planSize(plan)}`;
  });
  const deployment = snapshot.deployments?.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return [
    `Background service: ${worker === 'running' ? 'running' : worker === 'inactive' ? 'not running' : 'status unknown'} (not proof of delivery)`,
    ...plans,
    snapshot.tasks.length ? `Tasks: ${Object.entries(counts).map(([state, count]) => `${count} ${taskStatusLabel(state as typeof snapshot.tasks[number]['state']).toLowerCase()}`).join(' · ')}`
      : 'Tasks: none scheduled yet. Initial plan approval releases the first stage of work.',
    ...snapshot.tasks.filter((task) => !['done', 'cancelled'].includes(task.state)).map((task) =>
      `#${task.issueNumber} ${task.title}: ${taskStatusLabel(task.state)}${task.prNumber ? ` · PR #${task.prNumber}` : ''}${task.lastError ? ` — ${task.lastError.slice(0, 250)}` : ''}`),
    `Staging: ${deploymentLabel(deployment)}`,
    ...(deployment ? [`  Intended revision: ${deployment.commitSha}; observed revision: ${deployment.observedRevision ?? 'not verified'}`] : []),
    'Task completion is not delivery proof; the objective audit and staging checks must pass.',
  ].join('\n');
}
