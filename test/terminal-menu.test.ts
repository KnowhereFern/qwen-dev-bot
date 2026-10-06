import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { describe, expect, it, vi } from 'vitest';
import { deliveryChoices, renderMenu, selectTerminalMenu } from '../src/terminal/menu.js';
import { terminalCellWidth } from '../src/terminal/presentation.js';
import { renderContent, renderDocument, renderPrompt } from '../src/terminal/document.js';

const menu = { title: 'Choose an action', choices: deliveryChoices };
function terminal(color = false, reducedMotion = false) {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode: vi.fn(function (this: { isRaw: boolean }, raw: boolean) { this.isRaw = raw; }) });
  const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
  let screen = '';
  output.on('data', (chunk) => { screen += chunk.toString(); });
  const controller = new AbortController();
  const interrupt = vi.fn(() => controller.abort());
  const select = (view = menu as import('../src/terminal/menu.js').TerminalMenu) => selectTerminalMenu(view, { input: input as unknown as ReadStream, output: output as unknown as WriteStream, signal: controller.signal, color, reducedMotion, interrupt });
  return { input, output, controller, interrupt, select, screen: () => screen };
}

describe('keyboard menu', () => {
  it('selects multi-digit choices without prematurely choosing the first digit', async () => {
    const t = terminal();
    const result = t.select({ title: 'Review', choices: Array.from({ length: 13 }, (_, i) => ({ value: String(i + 1), label: `Choice ${i + 1}` })) });
    t.input.emit('keypress', '1', { name: '1', sequence: '1' });
    expect(t.input.isRaw).toBe(true);
    expect(t.screen()).toContain('Number: 1');
    t.input.emit('keypress', '2', { name: '2', sequence: '2' });
    expect(await result).toBe('12');
  });
  it('confirms an ambiguous single-digit choice with Enter', async () => {
    const t = terminal(); const result = t.select({ title: 'Review', choices: [{ value: '1', label: 'One' }, { value: '10', label: 'Ten' }] });
    t.input.emit('keypress', '1', { name: '1', sequence: '1' });
    t.input.emit('keypress', '', { name: 'return' });
    expect(await result).toBe('1');
  });
  it('defaults confirmation menus to Cancel when Enter is pressed', async () => {
    const t = terminal(); const result = t.select({ title: 'Approve revision 5', initial: '0', choices: [{ value: '1', label: 'Approve' }, { value: '0', label: 'Cancel' }] });
    t.input.emit('keypress', '', { name: 'return' });
    expect(await result).toBe('0');
  });
  it.each([5, 6, 8])('fits the document reader into %i terminal rows', (rows) => {
    const view = renderDocument('Plan', 'One\nTwo\nThree\nFour\nFive', 0, { columns: 40, rows, color: false });
    expect(view.screen.split('\n').length).toBeLessThanOrEqual(rows - 1);
    expect(view.screen).toContain('Esc back');
    expect(view.screen).toContain('0/Enter/Esc back');
  });
  it.each([30, 60, 100])('keeps every document line reachable at width %i', (columns) => {
    const source = Array.from({ length: 100 }, (_, index) => `Evidence ${index}: ${'long text '.repeat(8)}`).join('\n');
    const first = renderDocument('Complete plan', source, 0, { columns, rows: 24, color: false });
    const last = renderDocument('Complete plan', source, 99999, { columns, rows: 24, color: false });
    expect(first.screen).toContain('Evidence 0:');
    expect(last.screen).toContain('Evidence 99:');
    expect(last.screen.split('\n').length).toBeLessThanOrEqual(23);
    expect(last.screen.split('\n').every((line) => terminalCellWidth(line) <= columns - 1)).toBe(true);
  });
  it('styles prompts and errors without trusting ANSI from content', () => {
    const prompt = renderPrompt('Type approve revision 5 to approve (Enter cancels): ', 40, true);
    expect(prompt).toContain('Confirm your decision');
    expect(prompt).toContain('\x1b[1;33m');
    expect(renderContent('Error: \x1b[2Jnot available', 40, true).join('\n')).not.toContain('\x1b[2J');
    expect(renderPrompt('Secret key:', 40, false, true)).toContain('Private input');
  });
  it('scrolls documents without treating keys as executable selections', async () => {
    const t = terminal();
    const result = t.select({ ...menu, document: Array.from({ length: 100 }, (_, i) => `Row ${i}`).join('\n') });
    t.input.emit('keypress', '', { name: 'end' });
    expect(t.screen()).toContain('Row 99');
    t.input.emit('keypress', '', { name: 'home' });
    t.input.emit('keypress', '1', { name: '1', sequence: '1' });
    expect(t.input.isRaw).toBe(true);
    t.input.emit('keypress', '', { name: 'return' });
    expect(await result).toBe('0');
  });
  it('refreshes live documents and stops polling after exit', async () => {
    vi.useFakeTimers();
    try {
      const t = terminal(); const refresh = vi.fn(async () => 'Updated evidence');
      const result = t.select({ ...menu, document: 'Initial evidence', refresh, refreshMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      expect(t.screen()).toContain('Updated evidence');
      t.controller.abort(); await result;
      await vi.advanceTimersByTimeAsync(500);
      expect(refresh).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('shows refresh errors and ignores late results after the reader closes', async () => {
    vi.useFakeTimers();
    try {
      const t = terminal();
      const result = t.select({ ...menu, document: 'Initial', refresh: () => { throw new Error('offline'); }, refreshMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      expect(t.screen()).toContain('offline');
      t.input.emit('keypress', '0', { name: '0', sequence: '0' });
      await result;
      const closedScreen = t.screen();
      await vi.advanceTimersByTimeAsync(500);
      expect(t.screen()).toBe(closedScreen);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('uses a minimal brand mark and complete frame on spacious terminals', () => {
    const rendered = renderMenu(menu, 0, { columns: 100, rows: 40, color: false });
    expect(rendered).toContain('F E R N');
    expect(rendered).toContain('╭');
    expect(rendered).toContain('╯');
    expect(rendered.split('\n').every((line) => terminalCellWidth(line) <= 96)).toBe(true);
  });
  it('animates only changed rows and cancels motion on exit', async () => {
    vi.useFakeTimers();
    try {
      const t = terminal(true); const result = t.select();
      const before = t.screen().length;
      t.input.emit('keypress', '', { name: 'down' });
      expect(t.screen().slice(before)).not.toContain('\x1b[2J');
      expect(t.screen().slice(before)).toContain('\x1b[1;30;46m');
      expect(vi.getTimerCount()).toBe(1);
      t.controller.abort();
      await result;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('keeps reduced-motion selection immediate and timer-free', async () => {
    vi.useFakeTimers();
    try {
      const t = terminal(true, true); const result = t.select();
      t.input.emit('keypress', '', { name: 'down' });
      expect(vi.getTimerCount()).toBe(0);
      expect(t.screen()).not.toContain('\x1b[1;30;46m');
      t.controller.abort(); await result;
    } finally { vi.useRealTimers(); }
  });
  it.each([5, 8, 12, 24, 40])('keeps selection and controls visible in %i rows', (rows) => {
    const rendered = renderMenu(menu, 8, { columns: 80, rows, color: false });
    expect(rendered.split('\n').length).toBeLessThanOrEqual(rows - 1);
    expect(rendered).toContain('›  0  Exit');
    expect(rendered).toContain('Esc back');
  });
  it('wraps narrow content and strips untrusted terminal controls', () => {
    const rendered = renderMenu({ ...menu, title: '\x1b[2JDanger' }, 0, { columns: 30, rows: 24, color: false });
    expect(rendered).not.toContain('\x1b');
    expect(rendered.split('\n').every((line) => line.length <= 28)).toBe(true);
    expect(rendered).toContain('Enter');
  });
  it('fits selected wide Unicode project names inside the viewport', () => {
    const rendered = renderMenu({ title: 'Projects', choices: [{ value: '1', label: '餐厅测试 🍜 餐厅测试 🍜' }] }, 0, { columns: 30, rows: 24, color: true });
    expect(rendered.split('\n').every((line) => terminalCellWidth(line) <= 28)).toBe(true);
  });
  it('selects with arrows and Enter, redraws on resize and restores terminal state', async () => {
    const t = terminal();
    const result = t.select();
    t.input.emit('keypress', '', { name: 'down' });
    t.output.columns = 40;
    t.output.emit('resize');
    t.input.emit('keypress', '', { name: 'return' });
    expect(await result).toBe('2');
    expect(t.input.isRaw).toBe(false);
    expect(t.input.listenerCount('keypress')).toBe(0);
    expect(t.output.listenerCount('resize')).toBe(0);
    expect(t.screen()).toContain('\x1b[?25h\x1b[?1049l');
  });
  it.each(['escape', 'q'])('returns safely on %s', async (name) => {
    const t = terminal(); const result = t.select();
    t.input.emit('keypress', '', { name });
    expect(await result).toBe('0');
  });
  it('supports direct numeric shortcuts', async () => {
    const t = terminal(); const result = t.select();
    t.input.emit('keypress', '8', { name: '8', sequence: '8' });
    expect(await result).toBe('8');
  });
  it.each(['c', 'd'])('interrupts on Ctrl-%s without executing a selection', async (name) => {
    const t = terminal(); const result = t.select();
    t.input.emit('keypress', '', { name, ctrl: true });
    expect(await result).toBeNull();
    expect(t.interrupt).toHaveBeenCalledOnce();
    expect(t.input.isRaw).toBe(false);
  });
  it('cleans up on external cancellation and EOF', async () => {
    for (const eof of [false, true]) {
      const t = terminal(); const result = t.select();
      if (eof) t.input.emit('end'); else t.controller.abort();
      expect(await result).toBeNull();
      expect(t.output.listenerCount('resize')).toBe(0);
      expect(t.input.isRaw).toBe(false);
    }
  });
});
