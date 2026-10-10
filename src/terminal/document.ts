import { terminalText } from './interactive.js';
import { wrapTerminalLine } from './presentation.js';

export function renderPrompt(prompt: string, columns: number, color: boolean, hidden = false): string {
  const width = Math.max(10, Math.min(96, columns - 1));
  const paint = (text: string, code: string) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const confirmation = /\bType\b/.test(prompt);
  return ['\n' + paint(`  ${confirmation ? 'Confirm your decision' : hidden ? 'Private input' : 'Your input'}`, confirmation ? '1;33' : '1;36'),
    ...renderContent(prompt.trim(), width + 1, color),
    paint(`  ${'─'.repeat(Math.max(1, width - 2))}`, '36'),
  ].join('\n') + '\n';
}

/** Shared typography for plans, logs, results, errors and prompt explanations. */
export function renderContent(text: string, columns: number, color: boolean): string[] {
  const paint = (value: string, code: string) => color ? `\x1b[${code}m${value}\x1b[0m` : value;
  return terminalText(text).split('\n').flatMap((line) => {
    const heading = /^[A-Z][A-Z /()_-]{3,}$/.test(line.trim());
    const story = /^[A-Z][A-Z0-9_-]*\d+:/.test(line.trim());
    const error = /^(Error:|! Failed|Live status unavailable:)/i.test(line.trim());
    const warning = /^(Cancelled|Deferred|Warning:|Approval freezes|This installs\/starts)/i.test(line.trim());
    const success = /^(Draft saved|Key saved|Approval recorded|Setup complete|✓ Completed)/.test(line.trim());
    return wrapTerminalLine(`  ${line}`, Math.max(10, Math.min(columns - 1, 96))).map((wrapped) => {
      if (error || warning || heading || story || success) return paint(wrapped, error ? '1;31' : warning ? '33' : success ? '32' : '1;36');
      const field = /^(\s*(?:Goal|Depends on|Accept|Constraint|Required checks|Review criteria|Rollback|Review|Model|Provider route|Endpoint|Credential|Plan|Assessed commit|Objective file|Worker|Staging|Status):)(.*)$/.exec(wrapped);
      return field ? paint(field[1], '36') + field[2] : wrapped;
    });
  });
}

export function renderDocument(title: string, text: string, requestedOffset: number, options: { columns: number; rows: number; color: boolean }) {
  const width = Math.max(10, Math.min(96, options.columns - 1));
  const height = Math.max(3, options.rows - 1);
  const compact = height < 8;
  const paint = (value: string, code: string) => options.color ? `\x1b[${code}m${value}\x1b[0m` : value;
  const lines = renderContent(text || 'No information recorded yet.', width + 1, options.color);
  const pageSize = Math.max(1, height - (compact ? 2 : 5));
  const maxOffset = Math.max(0, lines.length - pageSize);
  const offset = Math.max(0, Math.min(requestedOffset, maxOffset));
  const fit = (value: string) => wrapTerminalLine(value, width)[0];
  const sections = lines.flatMap((line, index) => /^  (?:[A-Z][A-Z /()_-]{3,}|[\w-]+:.* — wave.*)$/.test(terminalText(line)) ? [index] : []);
  const screen = [
    paint(fit(`  Fern / ${title}`), '1;36'),
    ...(compact ? [] : [paint(`  ${'─'.repeat(Math.max(1, width - 2))}`, '36')]),
    ...lines.slice(offset, offset + pageSize),
    ...Array.from({ length: Math.max(0, pageSize - (lines.length - offset)) }, () => ''),
    ...(compact ? [] : ['', fit(`  Lines ${offset + 1}–${Math.min(lines.length, offset + pageSize)} of ${lines.length} · Read-only`)]),
    paint(fit(width < 60 ? '  ↑↓ scroll · 0/Enter/Esc back' : '  ↑↓ scroll · PgUp/PgDn · Tab section · 0/Enter/Esc back'), '36'),
  ].join('\n');
  return { screen, offset, maxOffset, pageSize, sections };
}
