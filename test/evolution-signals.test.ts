import { describe, expect, it } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import { PersistentTaskStore } from '../src/core/persistent-store.js';
import { EvolutionSignalCollector } from '../src/evolution/signals.js';
import type { GitHubControl } from '../src/github/control-plane.js';
import type { PortfolioPlanningModel } from '../src/portfolio/planner.js';
import { makeTmp } from './helpers.js';

describe('EvolutionSignalCollector', () => {
  it('deduplicates accepted non-material feedback by source and content', async () => {
    const root = makeTmp('signals-root');
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    const store = new PersistentTaskStore('signals-fixture', makeTmp('signals-state'));
    const github = {
      listOpenIssues: async () => [{
        number: 7, title: 'Checkout regression', body: 'PIN confirmation fails after refresh.', labels: ['bug', 'harness:accept'],
        author: 'owner', url: 'https://github.com/owner/fixture/issues/7',
      }],
    } as unknown as GitHubControl;
    const model = {
      completeJson: async <T>() => ({ value: {
        relevant: true, material: false, title: 'Repair PIN confirmation', summary: 'Reproduce and repair the refresh regression.',
      } as T }),
    } satisfies PortfolioPlanningModel;
    const collector = new EvolutionSignalCollector(config, store, github, model);

    expect(await collector.scan(true)).toMatchObject({ observed: 1, accepted: 1, deduplicated: 0 });
    expect(await collector.scan(true)).toMatchObject({ observed: 0, accepted: 0, deduplicated: 1 });
    expect(store.listSignals()).toHaveLength(1);
    expect(store.listSignals()[0]?.status).toBe('accepted');
    store.close();
  });

  it('keeps material feedback as a proposal until explicitly accepted', async () => {
    const config = defaultProjectConfig(makeTmp('signals-material-root'), 'fixture', 'owner/fixture');
    const store = new PersistentTaskStore('signals-material', makeTmp('signals-material-state'));
    const github = {
      listOpenIssues: async () => [{
        number: 8, title: 'Move payment provider', body: 'Replace the approved payment provider.', labels: ['feedback'],
        author: 'owner', url: 'https://github.com/owner/fixture/issues/8',
      }],
    } as unknown as GitHubControl;
    const model = {
      completeJson: async <T>() => ({ value: {
        relevant: true, material: true, title: 'Payment provider change', summary: 'Changes approved technology.',
      } as T }),
    } satisfies PortfolioPlanningModel;
    const collector = new EvolutionSignalCollector(config, store, github, model);
    await collector.scan(true);
    const proposal = store.listSignals()[0]!;
    expect(proposal.status).toBe('proposed');
    expect(collector.decide(proposal.id, true).status).toBe('accepted');
    store.close();
  });
});
