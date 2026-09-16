import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareProjectCheckout } from '../src/runtime/checkout-preflight.js';
import { makeTmp } from './helpers.js';

describe('prepareProjectCheckout', () => {
  it('runs the protected dependency bootstrap in the exact checkout with a reduced environment', async () => {
    const root = makeTmp('checkout-preflight');
    const scripts = path.join(root, '.qwen-harness', 'scripts');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(path.join(scripts, 'bootstrap.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      "if (process.env.GITHUB_TOKEN || process.env.RAILWAY_TOKEN) process.exit(9);",
      "writeFileSync('prepared.txt', process.cwd());",
    ].join('\n'));

    await prepareProjectCheckout(root);
    expect(existsSync(path.join(root, 'prepared.txt'))).toBe(true);
  });
});
