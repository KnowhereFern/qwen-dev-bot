/** Collect only the terminal verdict, not the review's potentially large transcript. */
export class QwenStructuredResultCollector {
  private buffer = '';
  private invalid = false;
  private hasResult = false;
  private result: unknown;

  push(chunk: string): void {
    if (this.invalid) return;
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      this.accept(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
      if (this.invalid) { this.buffer = ''; return; }
    }
    if (Buffer.byteLength(this.buffer) > 1024 * 1024) {
      this.invalid = true;
      this.buffer = '';
    }
  }

  finish(): unknown {
    if (this.buffer.trim()) this.accept(this.buffer);
    this.buffer = '';
    if (this.invalid) throw new Error('Qwen independent review returned an invalid or incomplete JSON stream');
    if (!this.hasResult) throw new Error('Qwen independent review returned no successful terminal result');
    return this.result;
  }

  private accept(line: string): void {
    if (!line.trim() || this.invalid) return;
    if (Buffer.byteLength(line) > 1024 * 1024) { this.invalid = true; return; }
    try {
      const event: unknown = JSON.parse(line);
      if (!event || typeof event !== 'object' || Array.isArray(event) || !('type' in event) || typeof event.type !== 'string') {
        this.invalid = true;
        return;
      }
      if (event.type !== 'result') return;
      if (this.hasResult || !('subtype' in event) || event.subtype !== 'success' || !('is_error' in event) || event.is_error !== false || !('result' in event)) {
        this.invalid = true;
        return;
      }
      if (typeof event.result !== 'string' && (!event.result || typeof event.result !== 'object' || Array.isArray(event.result))) {
        this.invalid = true;
        return;
      }
      this.hasResult = true;
      this.result = event.result;
    } catch {
      this.invalid = true;
    }
  }
}
