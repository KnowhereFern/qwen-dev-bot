import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import { projectDependencyChecks, qwenHarnessExtensionPresent } from '../src/doctor.js';
import { makeTmp } from './helpers.js';

describe('dependency preflight', () => {
  it('recognizes the Qwen CLI display name used for the harness extension', () => {
    expect(qwenHarnessExtensionPresent('✓ Autonomous Software Delivery Harness (1.0.0-rc.23)')).toBe(true);
    expect(qwenHarnessExtensionPresent('qwen-dev-harness')).toBe(true);
    expect(qwenHarnessExtensionPresent('unrelated extension')).toBe(false);
  });

  it('fails closed when a locked Node project has not installed dependencies', async () => {
    const root = makeTmp('doctor-dependencies-missing');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { octokit: '^5.0.5' } }));
    writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    const checks = await projectDependencyChecks(config);
    expect(checks.find((check) => check.id === 'node-dependencies')).toMatchObject({ status: 'fail' });
  });

  it('detects a declared browser package whose local runtime is missing', async () => {
    const root = makeTmp('doctor-browser-missing');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { '@playwright/test': '^1.0.0' } }));
    writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
    mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    const checks = await projectDependencyChecks(config);
    expect(checks.find((check) => check.id === 'browser-runtime')).toMatchObject({ status: 'fail' });
  });
});
