import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { terminalText } from './interactive.js';
import type { TerminalIO } from './interactive.js';
import type { TerminalScreenLine } from './home.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = (text: string) => Array.from(segmenter.segment(text), (item) => item.segment);
const cellWidth = (text: string) => /\p{Extended_Pictographic}|[\u1100-\u115f\u2329-\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u.test(text) ? 2 : /^\p{Mark}+$/u.test(text) ? 0 : 1;

/** Wrap sanitized content without clipping paths, splitting graphemes, or trusting evidence as ANSI. */
export function wrapTerminalLine(value: string, columns: number): string[] {
  const width = Math.max(10, Math.floor(columns));
  const text = terminalText(value).replace(/\t/g, '  ');
  const indent = /^ */.exec(text)?.[0].slice(0, Math.min(4, width - 2)) ?? '';
  const result: string[] = [];
  let remaining = graphemes(text.trimStart());
  if (!remaining.length) return [''];
  while (remaining.length) {
    const available = width - indent.length;
    let cells = 0;
    let count = 0;
    while (count < remaining.length && cells + cellWidth(remaining[count]) <= available) cells += cellWidth(remaining[count++]);
    if (count < remaining.length) {
      const space = remaining.slice(0, count).lastIndexOf(' ');
      if (space > 0) count = space;
    }
    result.push(`${indent}${remaining.slice(0, count).join('').trimEnd()}`);
    remaining = remaining.slice(count);
    while (remaining[0] === ' ') remaining.shift();
  }
  return result;
}

export function renderTerminalScreen(lines: TerminalScreenLine[], options: { columns?: number; rows?: number; color?: boolean } = {}): string {
  const columns = Math.max(10, options.columns ?? 80);
  const styles = { title: '\x1b[1;36m', heading: '\x1b[1m', attention: '\x1b[1;33m', action: '\x1b[1;36m', rule: '' };
  const rendered = lines.flatMap((line) => {
    const text = line.tone === 'rule' ? `  ${'─'.repeat(Math.max(1, Math.min(58, columns - 2)))}`
      : line.choices && columns >= 78 ? `  ${terminalText(line.choices[0]).padEnd(Math.floor((columns - 4) / 2))}  ${terminalText(line.choices[1])}` : terminalText(line.text);
    return text.split('\n').flatMap((paragraph) => wrapTerminalLine(paragraph, columns)).map((wrapped) =>
      options.color && line.tone && styles[line.tone] ? `${styles[line.tone]}${wrapped}\x1b[0m` : wrapped);
  });
  // Short windows keep every status/action; compress whitespace rather than hide information.
  const compact = options.rows !== undefined && rendered.length > options.rows - 2;
  return `${compact ? '' : '\n'}${(compact ? rendered.filter((line) => line.trim()) : rendered).join('\n')}\n`;
}

export interface TerminalActivity {
  pause(): void;
  resume(): void;
  stop(success: boolean): void;
}

export function startTerminalActivity(label: string, options: {
  write: (text: string) => void;
  animated: boolean;
  columns?: () => number;
  now?: () => number;
}): TerminalActivity {
  const now = options.now ?? Date.now;
  const started = now();
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let index = 0;
  let paused = false;
  let stopped = false;
  const clear = () => { if (options.animated) options.write('\r\x1b[2K'); };
  const render = () => {
    if (stopped || paused) return;
    const line = `${frames[index++ % frames.length]} ${terminalText(label)} · ${Math.floor((now() - started) / 1_000)}s`;
    options.write(`\r\x1b[2K${line.slice(0, Math.max(10, (options.columns?.() ?? 80) - 1))}`);
  };
  if (options.animated) render();
  else options.write(`Working: ${terminalText(label)}\n`);
  const timer = options.animated ? setInterval(render, 120) : undefined;
  timer?.unref();
  return {
    pause() { paused = true; clear(); },
    resume() { paused = false; if (options.animated) render(); },
    stop(success) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clear();
      options.write(`${success ? '✓ Completed' : '! Failed/interrupted'}: ${terminalText(label)} · ${Math.floor((now() - started) / 1_000)}s\n`);
    },
  };
}

export function createTerminalIO(): TerminalIO {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive mode requires a terminal. Run fern-harness interactive in Terminal, or use help/status --json for automation.');
  }
  const session = new AbortController();
  let active: ReturnType<typeof createInterface> | undefined;
  let activity: TerminalActivity | undefined;
  const interrupt = () => session.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const ask = async (prompt: string, hidden = false): Promise<string | null> => {
    if (session.signal.aborted) return null;
    activity?.pause();
    // A separate muted output hides both the credential and readline's editing echo.
    const muted = hidden ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : undefined;
    const rl = createInterface({ input: process.stdin, output: muted ?? process.stdout, terminal: true, historySize: hidden ? 0 : 30 });
    active = rl;
    const question = new AbortController();
    const abort = () => question.abort();
    session.signal.addEventListener('abort', abort, { once: true });
    rl.once('close', abort);
    rl.once('SIGINT', interrupt);
    rl.setPrompt(prompt);
    if (hidden) process.stdout.write(prompt);
    try { return await rl.question(hidden ? '' : prompt, { signal: question.signal }); }
    catch (error) { if (question.signal.aborted || session.signal.aborted) return null; throw error; }
    finally {
      session.signal.removeEventListener('abort', abort);
      active = undefined;
      rl.close();
      muted?.end();
      if (hidden) process.stdout.write('\n');
    }
  };
  return {
    signal: session.signal,
    question: (prompt) => ask(prompt),
    secret: (prompt) => ask(prompt, true),
    screen(lines) {
      activity?.pause();
      process.stdout.write(renderTerminalScreen(lines, {
        columns: process.stdout.columns,
        rows: process.stdout.rows,
        color: process.env.TERM !== 'dumb' && !process.env.NO_COLOR,
      }));
      activity?.resume();
    },
    print(text) {
      activity?.pause();
      if (active) process.stdout.write('\r\x1b[2K');
      process.stdout.write(`${terminalText(text)}\n`);
      if (active) active.prompt(true);
      else activity?.resume();
    },
    activity(label) {
      activity = startTerminalActivity(label, {
        write: (text) => process.stdout.write(text),
        animated: process.env.TERM !== 'dumb' && !process.env.NO_COLOR && process.env.QWEN_HARNESS_REDUCED_MOTION !== '1',
        columns: () => process.stdout.columns,
      });
      const current = activity;
      return (success) => { current.stop(success); if (activity === current) activity = undefined; };
    },
    close() {
      session.abort();
      active?.close();
      activity?.stop(false);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    },
  };
}
