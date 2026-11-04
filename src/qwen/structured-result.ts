/** Narrow metering surface for streamed result events: session identity and
 * cumulative usage only. The transcript, prompts, and verdict content are
 * never handed to the callback and never persisted through it. */
export interface QwenStreamMeteringEvent {
  sessionId: string | null;
  usage: unknown;
}

export type QwenStreamMetering = (event: QwenStreamMeteringEvent) => void;

/** Same length bound as the shared quota classifier: never scan or retain
 * unbounded provider-written reason text. */
const METERING_REASON_MAX_LENGTH = 2_000;

/** Collect only the terminal verdict, not the review's potentially large transcript. */
export class QwenStructuredResultCollector {
  private buffer = '';
  private invalid = false;
  private hasResult = false;
  private result: unknown;
  private streamSessionId: string | null = null;
  private sawResultEvent = false;
  private failureReason: string | null = null;

  constructor(private readonly onMetering?: QwenStreamMetering) {}

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

  /** Process a trailing unterminated line once the stream has ended. */
  endInput(): void {
    const line = this.buffer;
    this.buffer = '';
    if (line.trim()) this.accept(line);
  }

  /** Whether any result event (success or not) reached the collector. */
  hasResultEvent(): boolean {
    return this.sawResultEvent;
  }

  /** Bounded structured reason carried by a non-success result event, if any. */
  structuredErrorReason(): string | null {
    return this.failureReason;
  }

  finish(): unknown {
    this.endInput();
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
      // Session identity established by any stream event in this run. A
      // result event may omit session_id after an earlier event carried it;
      // that earlier stream-observed identity meters the snapshot.
      const streamEvent = event as { session_id?: unknown };
      if (typeof streamEvent.session_id === 'string' && streamEvent.session_id.trim() !== '') {
        this.streamSessionId = streamEvent.session_id;
      }
      if (event.type !== 'result') return;
      this.sawResultEvent = true;
      // Meter every result event as it streams in, before any verdict
      // validation: runs whose verdict or process later fail are still
      // counted, and missing usage/session id is marked unmetered by the
      // ledger, never zero. The verdict payload itself never reaches the
      // callback.
      this.onMetering?.({ sessionId: this.streamSessionId, usage: ('usage' in event) ? (event as { usage?: unknown }).usage : undefined });
      if (this.hasResult || !('subtype' in event) || event.subtype !== 'success' || !('is_error' in event) || event.is_error !== false || !('result' in event)) {
        this.captureFailureReason(event as Record<string, unknown>);
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

  /** Retain only a bounded structured reason string (never the payload) from
   * a rejected result event so the caller can classify provider quota
   * exhaustion. Any other shape is discarded. */
  private captureFailureReason(event: Record<string, unknown>): void {
    for (const field of ['reason', 'error']) {
      const value = event[field];
      if (typeof value === 'string' && value.length > 0 && value.length <= METERING_REASON_MAX_LENGTH) {
        this.failureReason = value;
        return;
      }
    }
  }
}
