import type { Dispatcher } from './dispatcher.js';
import type { Logger } from './logger.js';
import type { Monitor } from './monitor.js';
import { isTerminal } from './state-machine.js';
import type { IssueStore } from './store.js';
import type { Watchdog } from './watchdog.js';

export interface LoopOptions {
  tickMs: number;
  /** Hard bound on ticks so the loop can never hang forever. */
  maxTicks?: number;
  /** Stop automatically once there is no open work left. */
  stopWhenDrained?: boolean;
}

export type LoopOutcome = 'drained' | 'max-ticks' | 'stopped';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Orchestrator: a tick-based async loop (no overlapping ticks) wiring the
 * watchdog, dispatcher, and monitor together with structured logging and
 * clean start/stop semantics.
 */
export class OrchestratorLoop {
  private ticks = 0;
  private stopRequested = false;

  constructor(
    private readonly dispatcher: Dispatcher,
    private readonly watchdog: Watchdog,
    private readonly monitor: Monitor,
    private readonly store: IssueStore,
    private readonly opts: LoopOptions,
    private readonly logger: Logger,
  ) {}

  get tickCount(): number {
    return this.ticks;
  }

  /** True when every issue is terminal and no pipeline or merge is pending. */
  isDrained(): boolean {
    return (
      this.store.all().every((issue) => isTerminal(issue.state)) &&
      this.monitor.pending === 0 &&
      this.dispatcher.inflight === 0
    );
  }

  async tick(): Promise<void> {
    this.ticks += 1;
    this.watchdog.runOnce();
    this.dispatcher.poll();
    await this.monitor.runOnce();
  }

  /** Run until drained, stopped, or maxTicks hit — whichever comes first. */
  async start(): Promise<LoopOutcome> {
    this.logger.info('loop started', { tickMs: this.opts.tickMs });
    while (!this.stopRequested) {
      await this.tick();
      if (this.opts.stopWhenDrained && this.isDrained()) {
        this.logger.info('loop drained', { ticks: this.ticks });
        return 'drained';
      }
      if (this.opts.maxTicks !== undefined && this.ticks >= this.opts.maxTicks) {
        this.logger.warn('loop hit max ticks', { ticks: this.ticks });
        return 'max-ticks';
      }
      await sleep(this.opts.tickMs);
    }
    this.logger.info('loop stopped', { ticks: this.ticks });
    return 'stopped';
  }

  stop(): void {
    this.stopRequested = true;
  }
}
