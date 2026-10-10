import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER_PARTS = ['template', '.qwen-harness', 'scripts', 'run-gates.mjs'];
const RUNNER_UNAVAILABLE = 'The installed harness gate runner is missing or unsafe. Repair the harness runtime installation before continuing.';

/** The caller may supply a package fixture in tests; project configuration never selects this path. */
export function resolveInstalledGateRunner(packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')): string {
  try {
    const root = realpathSync(packageRoot);
    if (!lstatSync(root).isDirectory()) throw new Error('invalid package root');
    let current = root;
    for (const [index, part] of RUNNER_PARTS.entries()) {
      current = path.join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (index === RUNNER_PARTS.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error('invalid runner path');
      }
    }
    const resolved = realpathSync(current);
    if (resolved !== current || !resolved.startsWith(root + path.sep)) throw new Error('runner escaped package');
    return resolved;
  } catch {
    throw new Error(RUNNER_UNAVAILABLE);
  }
}

/** Qwen uses Bash on POSIX; Windows may use cmd, PowerShell, or Git Bash. */
export function gateRunnerCommand(runner: string, executable = process.execPath, platform: NodeJS.Platform = process.platform): string {
  if (!runner || !executable || /[\0\r\n]/.test(runner + executable)) throw new Error(RUNNER_UNAVAILABLE);
  if (platform === 'win32') {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    // The outer shell sees only fixed flags and base64, never a path's metacharacters.
    const script = `& ${quote(executable)} ${quote(runner)}; exit $LASTEXITCODE`;
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
  }
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  return `${quote(executable)} ${quote(runner)}`;
}
