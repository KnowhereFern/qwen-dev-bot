import { loadProjectConfig } from './core/config.js';
import { createProductionHarness } from './factory.js';
import { Logger } from './logger.js';
import { ProjectRegistry } from './registry.js';

export async function runDaemon(options: {
  once?: boolean;
  registry?: ProjectRegistry;
  logger?: Logger;
  signal?: AbortSignal;
} = {}): Promise<void> {
  const registry = options.registry ?? new ProjectRegistry();
  const logger = options.logger ?? new Logger();
  do {
    const projects = registry.list().filter((project) => project.enabled);
    if (projects.length === 0) logger.info('no registered projects');
    let shortestPoll = 30_000;
    for (const registration of projects) {
      if (options.signal?.aborted) return;
      let harness;
      try {
        const config = loadProjectConfig(registration.configPath);
        shortestPoll = Math.min(shortestPoll, config.worker.pollIntervalMs);
        harness = await createProductionHarness(config, { logger });
        const result = await harness.supervisor.tick(options.signal);
        logger.info('worker tick complete', { projectId: registration.id, ...result });
      } catch (error) {
        logger.error('project tick failed', {
          projectId: registration.id,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        harness?.close();
      }
    }
    if (options.once) return;
    await abortableDelay(shortestPoll, options.signal);
  } while (!options.signal?.aborted);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
