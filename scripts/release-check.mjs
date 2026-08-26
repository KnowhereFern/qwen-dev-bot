import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(read('package.json'));
const lockfile = JSON.parse(read('package-lock.json'));
const extension = JSON.parse(read('qwen-extension.json'));
const cliSource = read('src/cli.ts');
const problems = [];

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
  problems.push(`package.json has an invalid semver version: ${manifest.version}`);
}
if (extension.version !== manifest.version) {
  problems.push(`qwen-extension.json version ${extension.version} does not match package ${manifest.version}`);
}
if (lockfile.version !== manifest.version || lockfile.packages?.['']?.version !== manifest.version) {
  problems.push(`package-lock.json root version does not match package ${manifest.version}`);
}
const cliVersion = cliSource.match(/const VERSION = '([^']+)'/)?.[1];
if (cliVersion !== manifest.version) {
  problems.push(`src/cli.ts version ${cliVersion ?? 'missing'} does not match package ${manifest.version}`);
}
if (!existsSync(path.join(root, 'LICENSE'))) problems.push('LICENSE is missing');
if (manifest.main) problems.push(`package.json main points to ${manifest.main}; this CLI package must not advertise a nonexistent module entry`);
if (manifest.private !== true) problems.push('package.json must remain private until npm publication is explicitly approved');
if (!Array.isArray(manifest.files) || !manifest.files.includes('LICENSE')) problems.push('package.json files allowlist must include LICENSE');
if (!existsSync(path.join(root, '.github', 'workflows', 'ci.yml'))) problems.push('root source CI workflow is missing');
const starterManifest = JSON.parse(read('starter-template/package.json'));
if (starterManifest.version !== manifest.version) {
  problems.push(`starter-template/package.json version ${starterManifest.version} does not match package ${manifest.version}`);
}
if (!read('starter-template/setup.mjs').includes(`const ref = 'v${manifest.version}';`)) {
  problems.push(`starter-template/setup.mjs is not pinned to v${manifest.version}`);
}

for (const file of filesUnder('.github', 'template/.github', 'starter-template/.github')) {
  const source = read(file);
  for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)) {
    const reference = match[1];
    if (reference.startsWith('./') || reference.startsWith('docker://')) continue;
    const at = reference.lastIndexOf('@');
    const revision = at >= 0 ? reference.slice(at + 1) : '';
    if (!/^[a-f0-9]{40}$/.test(revision)) problems.push(`${file} has a mutable action reference: ${reference}`);
  }
}

const publishableFiles = filesUnder(...manifest.files.filter((entry) => entry.endsWith('/')).map((entry) => entry.slice(0, -1)))
  .concat(manifest.files.filter((entry) => !entry.endsWith('/') && existsSync(path.join(root, entry))));
const macHomePrefix = `${path.sep}Users${path.sep}`;
const personalPath = publishableFiles.find((file) => read(file).includes(macHomePrefix));
if (personalPath) problems.push(`${personalPath} contains a personal absolute path`);
const secretPatterns = [
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
];
for (const file of publishableFiles) {
  if (secretPatterns.some((pattern) => pattern.test(read(file)))) problems.push(`${file} contains a credential-like value`);
}

if (problems.length) {
  for (const problem of problems) console.error(`FAIL  ${problem}`);
  process.exit(1);
}

console.log(`PASS  release metadata and synchronized version ${manifest.version}`);
console.log('PASS  immutable GitHub Action references');
console.log('PASS  package allowlist and personal-path scan');

function read(relative) {
  return readFileSync(path.join(root, relative), 'utf8');
}

function filesUnder(...entries) {
  const result = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry);
    if (!existsSync(absolute)) continue;
    if (statSync(absolute).isFile()) {
      result.push(entry);
      continue;
    }
    for (const name of readdirSync(absolute)) {
      result.push(...filesUnder(path.join(entry, name)));
    }
  }
  return result;
}
