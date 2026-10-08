import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';
import type { TerminalScreenLine } from './home.js';
import { terminalCellWidth, wrapTerminalLine } from './presentation.js';
import { renderDocument } from './document.js';

export interface TerminalChoice { value: string; label: string; description?: string }
export interface TerminalMenu {
  title: string;
  choices: TerminalChoice[];
  header?: TerminalScreenLine[];
  initial?: string;
  document?: string;
  refresh?: () => Promise<string>;
  refreshMs?: number;
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
  { value: '9', label: 'Draft spec from idea/document', description: 'Let the harness turn your input into a private proposal. No Git setup or approval required.' },
  { value: '0', label: 'Exit', description: 'Close this console. Any running background worker keeps running.' },
];

/** A bounded viewport: the selected item and navigation hint stay visible on resize. */
export function renderMenu(menu: TerminalMenu, selected: number, options: { columns: number; rows: number; color: boolean; emphasis?: boolean; numberInput?: string }): string {
  const width = Math.max(10, Math.min(96, options.columns - 2));
  const height = Math.max(4, options.rows - 1);
  const paint = (text: string, code: string) => options.color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const wrap = (text: string) => wrapTerminalLine(text, width);
  let header = (menu.header ?? [{ text: '  Fern Delivery', tone: 'title' }]).flatMap((line) =>
    line.tone === 'rule' ? ['  ' + '─'.repeat(Math.max(1, width - 4))]
      : line.text.split('\n').flatMap(wrap).map((text) => paint(text,
        line.tone === 'title' ? '1;36' : line.tone === 'attention' ? '33' : line.tone === 'heading' ? '1' : '0')));
  const compactHeader = header;
  const spacious = height >= 32 && width >= 58;
  if (spacious) {
    const contentWidth = width - 6;
    const fit = (text: string) => wrapTerminalLine(text, contentWidth)[0];
    const frame = (text: string, tone = '0') => {
      const label = fit(text);
      return paint('  │ ', '36') + paint(label, tone) + ' '.repeat(Math.max(0, contentWidth - terminalCellWidth(label))) + paint(' │', '36');
    };
    const project = menu.header?.[0]?.text.replace(/^\s*Fern Delivery\s*·?\s*/, '').trim();
    header = [
      '',
      paint('   \\|/   F E R N', '1;36'),
      paint('    |    ', '36') + 'Your software delivery workspace',
      '',
      paint('  ╭' + '─'.repeat(width - 4) + '╮', '36'),
      frame(project || 'Fern Delivery', '1'),
      ...(menu.header?.slice(2) ?? []).flatMap((line) => line.text.split('\n').flatMap((text) =>
        wrapTerminalLine(text.trim(), contentWidth).map((part) => frame(part, line.tone === 'attention' ? '1;33' : '0')))),
      paint('  ╰' + '─'.repeat(width - 4) + '╯', '36'),
      '',
    ];
  }
  const title = wrap(`  ${menu.title}`)[0];
  const validNumber = menu.choices.some((choice) => choice.value === options.numberInput);
  const hint = wrap(options.numberInput ? `  Number: ${options.numberInput} · ${validNumber ? 'Enter selects' : 'Invalid choice'} · Backspace edits`
    : width < 50 ? '  Number + Enter · Esc back' : '  ↑ ↓ move · number + Enter selects · Esc back')[0];
  const item = menu.choices[selected];
  const description = height >= 10 ? wrap(`  ${item?.description ?? 'Select an option to continue.'}`).slice(0, 2) : [];
  const menuRows = Math.min(menu.choices.length, Math.max(1, height - description.length - 4));
  const headerBudget = Math.max(0, height - menuRows - description.length - 4);
  // Keep the status at the top; full details remain available in the dedicated views.
  const visibleHeader = header.length <= headerBudget ? header : compactHeader.slice(0, headerBudget);
  const start = Math.max(0, Math.min(selected - Math.floor(menuRows / 2), menu.choices.length - menuRows));
  const choices = menu.choices.slice(start, start + menuRows).map((choice, offset) => {
    const active = start + offset === selected;
    const label = wrap(`  ${active ? '›' : ' '} ${choice.value.padStart(2)}  ${choice.label}`)[0];
    const padded = label + ' '.repeat(Math.max(0, width - terminalCellWidth(label)));
    return active ? paint(padded, options.emphasis ? '1;30;46' : '1;36') : label;
  });
  return [...visibleHeader, paint(title, '1'), '', ...choices, ...(height > 4 ? [''] : []), ...description, paint(hint, '36')].join('\n');
}

/** Own raw input only while selecting; restore the previous terminal mode on every exit. */
export async function selectTerminalMenu(menu: TerminalMenu, options: {
  input: ReadStream; output: WriteStream; signal: AbortSignal; color: boolean; interrupt: () => void; reducedMotion?: boolean;
}): Promise<string | null> {
  const { input, output, signal } = options;
  if (signal.aborted || !menu.choices.length) return null;
  let selected = Math.max(0, menu.choices.findIndex((choice) => choice.value === menu.initial));
  const wasRaw = Boolean(input.isRaw);
  emitKeypressEvents(input);
  return new Promise((resolve, reject) => {
    let finished = false;
    let previous: string[] = [];
    let emphasis = false;
    let animation: ReturnType<typeof setTimeout> | undefined;
    let offset = 0;
    let documentView: ReturnType<typeof renderDocument> | undefined;
    let documentText = menu.document;
    let refreshTimer: ReturnType<typeof setInterval> | undefined;
    let refreshing = false;
    let numberInput = '';
    const draw = () => {
      try {
        const dimensions = {
          columns: output.columns || 80, rows: output.rows || 24, color: options.color, emphasis, numberInput,
        };
        documentView = documentText !== undefined ? renderDocument(menu.title, documentText, offset, dimensions) : undefined;
        if (documentView) offset = documentView.offset;
        const lines = (documentView?.screen ?? renderMenu(menu, selected, dimensions)).split('\n');
        // Paint only changed rows: selection motion must not flash the whole screen.
        let update = '';
        for (let row = 0; row < Math.max(lines.length, previous.length); row++) {
          if (lines[row] !== previous[row]) update += `\x1b[${row + 1};1H\x1b[2K${lines[row] ?? ''}`;
        }
        if (update) output.write(update);
        previous = lines;
      } catch (error) { finish(null, error); }
    };
    const resize = () => {
      try { previous = []; output.write('\x1b[H\x1b[2J'); draw(); }
      catch (error) { finish(null, error); }
    };
    const finish = (value: string | null, error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(animation);
      clearInterval(refreshTimer);
      input.removeListener('keypress', keypress);
      input.removeListener('end', abort);
      output.removeListener('resize', resize);
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
      if (documentView) {
        if (key.name === 'return' || key.sequence === '0') { finish('0'); return; }
        if (key.name === 'up' || key.name === 'k') offset--;
        else if (key.name === 'down' || key.name === 'j') offset++;
        else if (key.name === 'pageup') offset -= documentView.pageSize;
        else if (key.name === 'pagedown' || key.name === 'space') offset += documentView.pageSize;
        else if (key.name === 'home') offset = 0;
        else if (key.name === 'end') offset = documentView.maxOffset;
        else if (key.name === 'tab') offset = key.shift
          ? documentView.sections.filter((section) => section < offset).at(-1) ?? 0
          : documentView.sections.find((section) => section > offset) ?? documentView.maxOffset;
        else return;
        draw(); return;
      }
      if (key.sequence && /^\d$/.test(key.sequence)) {
        const candidate = numberInput + key.sequence;
        const exact = menu.choices.findIndex((choice) => choice.value === candidate);
        numberInput = candidate;
        if (exact >= 0) selected = exact;
        draw(); return;
      }
      if (key.name === 'backspace') {
        numberInput = numberInput.slice(0, -1);
        const exact = menu.choices.findIndex((choice) => choice.value === numberInput);
        selected = exact >= 0 ? exact : Math.max(0, menu.choices.findIndex((choice) => choice.value === (menu.initial ?? '0')));
        draw(); return;
      }
      if (key.name === 'return' && numberInput) {
        if (menu.choices.some((choice) => choice.value === numberInput)) finish(numberInput);
        return;
      }
      numberInput = '';
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
      clearTimeout(animation);
      emphasis = options.color && !options.reducedMotion;
      draw();
      if (emphasis && !finished) animation = setTimeout(() => { emphasis = false; draw(); }, 180);
    };
    input.on('keypress', keypress);
    input.once('end', abort);
    output.on('resize', resize);
    signal.addEventListener('abort', abort, { once: true });
    try {
      input.setRawMode(true);
      input.resume();
      output.write('\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J');
      draw();
      if (menu.refresh && !finished) refreshTimer = setInterval(() => {
        if (refreshing || finished) return;
        refreshing = true;
        void Promise.resolve().then(menu.refresh!).then((text) => {
          if (!finished) { documentText = text; draw(); }
        }, (error: unknown) => {
          if (!finished) { documentText = `Live status unavailable: ${String(error)}\nReturn and retry when the connection is available.`; draw(); }
        }).finally(() => { refreshing = false; });
      }, menu.refreshMs ?? 3_000);
    } catch (error) { finish(null, error); }
  });
}
