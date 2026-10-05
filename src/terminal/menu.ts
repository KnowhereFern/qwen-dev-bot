import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';
import type { TerminalScreenLine } from './home.js';
import { terminalCellWidth, wrapTerminalLine } from './presentation.js';

export interface TerminalChoice { value: string; label: string; description?: string }
export interface TerminalMenu {
  title: string;
  choices: TerminalChoice[];
  header?: TerminalScreenLine[];
  initial?: string;
}

export const deliveryChoices: TerminalChoice[] = [
  { value: '1', label: 'Review delivery plan', description: 'Read the proposed outcomes, evidence and decisions before approving.' },
  { value: '2', label: 'Define or revise objective', description: 'Give Fern an objective or request changes to a proposed plan.' },
  { value: '3', label: 'Live progress', description: 'Follow tasks, checks and repairs. Viewing progress does not start work.' },
  { value: '4', label: 'Readiness checks', description: 'Check this project, local tools and GitHub access.' },
  { value: '5', label: 'Evidence & history', description: 'Inspect deployments, feedback, logs and delivery reports.' },
  { value: '6', label: 'Project setup', description: 'Set up a folder, connect GitHub or switch projects.' },
  { value: '7', label: 'Start / resume delivery', description: 'Start approved work. You will confirm before execution begins.' },
  { value: '8', label: 'Model connection', description: 'Connect your provider, save a key privately or test the connection.' },
  { value: '0', label: 'Exit', description: 'Close this console. Any running background worker keeps running.' },
];

/** A bounded viewport: the selected item and navigation hint stay visible on resize. */
export function renderMenu(menu: TerminalMenu, selected: number, options: { columns: number; rows: number; color: boolean }): string {
  const width = Math.max(10, Math.min(96, options.columns - 2));
  const height = Math.max(4, options.rows - 1);
  const paint = (text: string, code: string) => options.color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const wrap = (text: string) => wrapTerminalLine(text, width);
  const header = (menu.header ?? [{ text: '  Fern Delivery', tone: 'title' }]).flatMap((line) =>
    line.tone === 'rule' ? ['  ' + '─'.repeat(Math.max(1, width - 4))]
      : line.text.split('\n').flatMap(wrap).map((text) => paint(text,
        line.tone === 'title' ? '1;36' : line.tone === 'attention' ? '33' : line.tone === 'heading' ? '1' : '0')));
  const title = wrap(`  ${menu.title}`)[0];
  const hint = wrap(width < 50 ? '  ↑↓ move · Enter · Esc' : '  ↑ ↓ move · Enter open · shortcut key · Esc back')[0];
  const item = menu.choices[selected];
  const description = height >= 10 ? wrap(`  ${item?.description ?? 'Select an option to continue.'}`).slice(0, 2) : [];
  const menuRows = Math.min(menu.choices.length, Math.max(1, height - description.length - 4));
  const headerBudget = Math.max(0, height - menuRows - description.length - 4);
  // Keep the status at the top; full details remain available in the dedicated views.
  const visibleHeader = header.slice(0, headerBudget);
  const start = Math.max(0, Math.min(selected - Math.floor(menuRows / 2), menu.choices.length - menuRows));
  const choices = menu.choices.slice(start, start + menuRows).map((choice, offset) => {
    const active = start + offset === selected;
    const label = wrap(`  ${active ? '›' : ' '} ${choice.value.padStart(2)}  ${choice.label}`)[0];
    return active ? paint(label + ' '.repeat(Math.max(0, width - terminalCellWidth(label))), '7;1') : label;
  });
  return [...visibleHeader, paint(title, '1'), '', ...choices, ...(height > 4 ? [''] : []), ...description, paint(hint, '36')].join('\n');
}

/** Own raw input only while selecting; restore the previous terminal mode on every exit. */
export async function selectTerminalMenu(menu: TerminalMenu, options: {
  input: ReadStream; output: WriteStream; signal: AbortSignal; color: boolean; interrupt: () => void;
}): Promise<string | null> {
  const { input, output, signal } = options;
  if (signal.aborted || !menu.choices.length) return null;
  let selected = Math.max(0, menu.choices.findIndex((choice) => choice.value === menu.initial));
  const wasRaw = Boolean(input.isRaw);
  emitKeypressEvents(input);
  return new Promise((resolve, reject) => {
    let finished = false;
    const draw = () => {
      try { output.write(`\x1b[H\x1b[2J${renderMenu(menu, selected, {
        columns: output.columns || 80, rows: output.rows || 24, color: options.color,
      })}`); } catch (error) { finish(null, error); }
    };
    const finish = (value: string | null, error?: unknown) => {
      if (finished) return;
      finished = true;
      input.removeListener('keypress', keypress);
      input.removeListener('end', abort);
      output.removeListener('resize', draw);
      signal.removeEventListener('abort', abort);
      try { input.setRawMode(wasRaw); } catch (restoreError) { error ??= restoreError; }
      input.pause();
      try { output.write('\x1b[?25h\x1b[?1049l'); } catch (restoreError) { error ??= restoreError; }
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(null);
    const keypress = (_text: string, key: Key) => {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) { options.interrupt(); finish(null); return; }
      if (key.name === 'escape' || key.name === 'q') { finish('0'); return; }
      if (key.name === 'up' || key.name === 'k') selected = (selected - 1 + menu.choices.length) % menu.choices.length;
      else if (key.name === 'down' || key.name === 'j' || key.name === 'tab') selected = (selected + 1) % menu.choices.length;
      else if (key.name === 'home') selected = 0;
      else if (key.name === 'end') selected = menu.choices.length - 1;
      else if (key.name === 'return') { finish(menu.choices[selected].value); return; }
      else {
        const shortcut = menu.choices.find((choice) => choice.value === key.sequence);
        if (shortcut) { finish(shortcut.value); return; }
        return;
      }
      draw();
    };
    input.on('keypress', keypress);
    input.once('end', abort);
    output.on('resize', draw);
    signal.addEventListener('abort', abort, { once: true });
    try {
      input.setRawMode(true);
      input.resume();
      output.write('\x1b[?1049h\x1b[?25l');
      draw();
    } catch (error) { finish(null, error); }
  });
}
