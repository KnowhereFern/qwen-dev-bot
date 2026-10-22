import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** User-only credentials: never pass a key as a CLI argument or write it in a project. */
export function saveUserModelCredential(envKey: string, secret: string, userDirectory = path.join(os.homedir(), '.qwen')): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(envKey)) throw new Error('Credential name must be an uppercase environment variable.');
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(secret)) throw new Error('Invalid credential: use the provider key only, without spaces or quotes.');
  const file = path.join(userDirectory, '.env');
  if ((existsSync(userDirectory) && lstatSync(userDirectory).isSymbolicLink()) || (existsSync(file) && lstatSync(file).isSymbolicLink())) {
    throw new Error('Refusing to replace a symlinked credential file. Configure it through your existing credential manager.');
  }
  mkdirSync(userDirectory, { recursive: true, mode: 0o700 });
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${envKey}\\s*=`);
  const preserved = lines.filter((line) => !assignment.test(line));
  while (preserved.at(-1) === '') preserved.pop();
  const temporary = path.join(userDirectory, `.env.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${preserved.join('\n')}${preserved.length ? '\n' : ''}${envKey}=${secret}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
  return file;
}
