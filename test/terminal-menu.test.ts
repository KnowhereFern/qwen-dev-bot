import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { describe, expect, it, vi } from 'vitest';
import { deliveryChoices, renderMenu, selectTerminalMenu } from '../src/terminal/menu.js';
import { terminalCellWidth } from '../src/terminal/presentation.js';

const menu = { title: 'Choose an action', choices: deliveryChoices };
function terminal() {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode: vi.fn(function (this: { isRaw: boolean }, raw: boolean) { this.isRaw = raw; }) });
  const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
  let screen = '';
  output.on('data', (chunk) => { screen += chunk.toString(); });
  const controller = new AbortController();
  const interrupt = vi.fn(() => controller.abort());
  const select = () => selectTerminalMenu(menu, { input: input as unknown as ReadStream, output: output as unknown as WriteStream, signal: controller.signal, color: false, interrupt });
  return { input, output, controller, interrupt, select, screen: () => screen };
}

describe('keyboard menu', () => {
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
