import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HarnessEvent } from './types.js';

const SECRET_KEY = /(token|secret|password|api[_-]?key|authorization|cookie)/i;

export function redactText(value: string): string {
  let redacted = value
    .replace(/\bsk[-_][A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{12,}\b/g, '[REDACTED]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[^\s]+/gi, '$1 [REDACTED]')
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
  const environmentSecrets = environmentSecretValues();
  for (const secret of environmentSecrets) redacted = redacted.split(secret).join('[REDACTED]');
  return redacted;
}

export function environmentSecretValues(source: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(source)
    .filter(([name, secret]) => SECRET_KEY.test(name) && typeof secret === 'string' && secret.length >= 8)
    .map(([, secret]) => secret as string)
    .sort((left, right) => right.length - left.length);
}

export function redactForLedger(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((entry) => redactForLedger(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        redactForLedger(child, childKey),
      ]),
    );
  }
  if (typeof value === 'string') return redactText(value);
  return value;
}

export class EventLedger {
  readonly file: string;

  constructor(stateDir: string, projectId: string) {
    const dir = path.join(stateDir, 'ledgers');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, `${safeName(projectId)}.jsonl`);
  }

  append(input: Omit<HarnessEvent, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): HarnessEvent {
    const event: HarnessEvent = {
      id: input.id ?? randomUUID(),
      projectId: input.projectId,
      taskId: input.taskId,
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      payload: redactForLedger(input.payload) as Record<string, unknown>,
      createdAt: input.createdAt ?? Date.now(),
    };
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    return event;
  }
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120);
}
