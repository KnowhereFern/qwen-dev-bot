import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import type { GateDefinition, GateResult } from '../core/types.js';
import { environmentSecretValues } from '../core/ledger.js';
import { gateEnvironment, resolveInside, runProcess } from '../runtime/safe-process.js';

export class GateRunner {
  async runAll(
    definitions: GateDefinition[],
    worktree: string,
    changedFiles: string[],
    signal?: AbortSignal,
  ): Promise<GateResult[]> {
    const results: GateResult[] = [];
    results.push(this.securityGate(worktree, changedFiles));
    for (const gate of definitions) results.push(await this.run(gate, worktree, signal));
    return results;
  }

  async run(gate: GateDefinition, worktree: string, signal?: AbortSignal): Promise<GateResult> {
    if (!gate.required && gate.notApplicableReason) {
      return {
        id: gate.id,
        kind: gate.kind,
        required: false,
        applicable: false,
        ok: true,
        exitCode: 0,
        stdout: gate.notApplicableReason,
        stderr: '',
        durationMs: 0,
        command: [gate.command, ...gate.args],
        evidenceHash: sha256(gate.notApplicableReason),
      };
    }
    const cwd = gate.cwd ? resolveInside(worktree, gate.cwd) : worktree;
    const receipt = await runProcess({
      command: gate.command,
      args: gate.args,
      cwd,
      timeoutMs: gate.timeoutMs,
      signal,
      env: gateEnvironment({ ...process.env, CI: 'true', NODE_ENV: 'test' }),
    });
    const evidence = `${receipt.exitCode}\n${receipt.stdout}\n${receipt.stderr}`;
    return {
      id: gate.id,
      kind: gate.kind,
      required: gate.required,
      applicable: true,
      ok: receipt.exitCode === 0 && !receipt.timedOut && !receipt.aborted,
      exitCode: receipt.exitCode,
      stdout: receipt.stdout,
      stderr: receipt.stderr,
      durationMs: receipt.durationMs,
      command: [gate.command, ...gate.args],
      evidenceHash: sha256(evidence),
    };
  }

  private securityGate(worktree: string, changedFiles: string[]): GateResult {
    const started = Date.now();
    const findings: string[] = [];
    const secretPatterns: Array<[string, RegExp]> = [
      ['GitHub token', /\b(?:gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})\b/],
      ['cloud/API key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
      ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ];
    const environmentSecrets = environmentSecretValues();
    for (const relative of changedFiles) {
      let file: string;
      try {
        file = resolveInside(worktree, relative);
      } catch (error) {
        findings.push(String(error));
        continue;
      }
      try {
        const stat = lstatSync(file);
        if (stat.isSymbolicLink()) {
          findings.push(`${relative}: changed symlinks are not accepted by the autonomous path`);
          continue;
        }
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
        const content = readFileSync(file, 'utf8');
        for (const [name, pattern] of secretPatterns) {
          if (pattern.test(content)) findings.push(`${relative}: possible ${name}`);
        }
        if (environmentSecrets.some((secret) => content.includes(secret))) {
          findings.push(`${relative}: contains a secret from the worker environment`);
        }
      } catch {
        // Deleted files are safe to omit from content scanning.
      }
    }
    const stdout = findings.length === 0 ? `Scanned ${changedFiles.length} changed files; no blocked patterns.` : '';
    const stderr = findings.join('\n');
    return {
      id: 'harness-security',
      kind: 'security',
      required: true,
      applicable: true,
      ok: findings.length === 0,
      exitCode: findings.length === 0 ? 0 : 1,
      stdout,
      stderr,
      durationMs: Date.now() - started,
      command: ['internal:harness-security'],
      evidenceHash: sha256(`${stdout}\n${stderr}`),
    };
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
