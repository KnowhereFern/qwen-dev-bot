import { runProcess } from './runtime/safe-process.js';

export interface GateResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Run one executable plus an explicit argument array as a pass/fail gate.
 * Never invokes a shell and never throws for a non-zero exit, timeout, or
 * spawn failure.
 */
export async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
): Promise<GateResult> {
  const result = await runProcess({ command, args, cwd, timeoutMs });
  return {
    ok: result.exitCode === 0 && !result.timedOut && !result.aborted,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
  };
}

export class TestGate {
  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly cwd: string,
    private readonly timeoutMs = 60_000,
  ) {}

  describe(): string {
    return `${[this.command, ...this.args].join(' ')} (cwd: ${this.cwd})`;
  }

  run(): Promise<GateResult> {
    return runCommand(this.command, this.args, this.cwd, this.timeoutMs);
  }
}
