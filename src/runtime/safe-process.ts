import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { ProcessReceipt } from '../core/types.js';

export interface ProcessOptions {
  command: string;
  args?: string[];
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  input?: string;
  maxOutputBytes?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export async function runProcess(options: ProcessOptions): Promise<ProcessReceipt> {
  const args = options.args ?? [];
  const started = Date.now();
  const maxOutput = options.maxOutputBytes ?? 10 * 1024 * 1024;
  const cwd = realpathSync(options.cwd);

  return new Promise((resolve) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn(options.command, args, {
      cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      if (current.length >= maxOutput) return current;
      const remaining = maxOutput - current.length;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };

    child.stdout.on('data', (chunk: Buffer<ArrayBufferLike>) => {
      stdout = append(stdout, chunk);
      options.onStdout?.(chunk.toString('utf8'));
    });
    child.stderr.on('data', (chunk: Buffer<ArrayBufferLike>) => {
      stderr = append(stderr, chunk);
      options.onStderr?.(chunk.toString('utf8'));
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // A short-lived command can close stdin before the supplied confirmation
      // input is flushed. Its process exit remains the authoritative result.
      if (error.code !== 'EPIPE') stderr = append(stderr, Buffer.from(error.message));
    });

    const stop = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32' || !child.pid) {
        child.kill('SIGTERM');
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
      const forceTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            shell: false,
            stdio: 'ignore',
            windowsHide: true,
          });
          killer.unref();
        } else if (!child.pid) child.kill('SIGKILL');
        else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      }, 2_000);
      forceTimer.unref();
    };

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, options.timeoutMs)
      : null;
    timeout?.unref();

    const onAbort = (): void => {
      aborted = true;
      stop();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    const finish = (exitCode: number | null, spawnError?: Error): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      if (spawnError) stderr = append(stderr, Buffer.from(spawnError.message));
      resolve({
        command: options.command,
        args: [...args],
        cwd,
        exitCode,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        durationMs: Date.now() - started,
        timedOut,
        aborted,
      });
    };

    child.once('error', (error) => finish(null, error));
    child.once('close', (code) => finish(code));

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export function resolveInside(root: string, candidate: string): string {
  if (path.isAbsolute(candidate)) throw new Error(`Absolute paths are not allowed: ${candidate}`);
  const canonicalRoot = realpathSync(root);
  const resolved = path.resolve(canonicalRoot, candidate);
  const relative = path.relative(canonicalRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${candidate}`);
  }
  return resolved;
}

export function gateEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const safeNames = [
    'PATH',
    'Path',
    'PATHEXT',
    'SYSTEMROOT',
    'SystemRoot',
    'COMSPEC',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'CI',
    'NODE_ENV',
    'NO_COLOR',
  ];
  return Object.fromEntries(safeNames.flatMap((name) => (source[name] === undefined ? [] : [[name, source[name]]])));
}

export function formatProcessFailure(receipt: ProcessReceipt, maxChars = 1_500): string {
  const reason = receipt.timedOut
    ? 'timed out'
    : receipt.aborted
      ? 'aborted'
      : `exited ${String(receipt.exitCode)}`;
  const output = (receipt.stderr.trim() || receipt.stdout.trim()).slice(-maxChars);
  return `${receipt.command} ${receipt.args.join(' ')} ${reason}${output ? `: ${output}` : ''}`;
}
