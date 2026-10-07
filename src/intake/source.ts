import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { redactText } from '../core/ledger.js';

export interface IntakeSource {
  name: string;
  sha256: string;
  kind: 'idea' | 'text' | 'pdf';
  sections: Array<{ ref: string; text: string }>;
  warnings: string[];
}
export const MAX_INTAKE_TEXT_BYTES = 200_000;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function cleanIntakeText(text: string): string {
  const normalized = text.normalize('NFC')
    .replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]|\p{Cf}/gu, '');
  // Normalize before redaction: invisible controls can otherwise split a secret into unmatched pieces.
  return redactText(normalized.replace(/\bsk-sp-[A-Za-z0-9._-]+/g, '[REDACTED]'));
}

export function selectedPages(selection: string | undefined, count: number): number[] {
  if (!selection) return Array.from({ length: count }, (_, index) => index + 1);
  const pages = new Set<number>();
  for (const part of selection.split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!match) throw new Error('Pages must use ranges such as 1-4,7');
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (first < 1 || last < first || last > count) throw new Error(`Page range must be inside 1-${count}`);
    for (let page = first; page <= last; page++) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

/** Read only the operator-selected source, never linked files, URLs, scripts or attachments. */
export async function readIntakeSource(root: string, options: { input?: string; idea?: string; pages?: string }): Promise<IntakeSource> {
  if (Boolean(options.input) === Boolean(options.idea)) throw new Error('Choose exactly one --input FILE or --idea TEXT');
  if (options.idea) {
    if (options.pages) throw new Error('--pages applies only to PDF input');
    assertText(options.idea);
    return { name: 'User idea', sha256: hash(options.idea), kind: 'idea', sections: [{ ref: 'idea', text: cleanIntakeText(options.idea) }], warnings: [] };
  }
  const base = realpathSync(root);
  const requested = path.resolve(base, options.input!);
  if (lstatSync(requested).isSymbolicLink()) throw new Error('Input must not be a symbolic link');
  const file = realpathSync(requested);
  const relative = path.relative(base, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Input must be inside the selected project');
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('Input must be a regular file of at most 20 MB');
  const bytes = readFileSync(file);
  const source: IntakeSource = { name: cleanIntakeText(relative).replace(/\s+/g, ' '), sha256: hash(bytes), kind: 'text', sections: [], warnings: [] };
  if (path.extname(file).toLowerCase() !== '.pdf') {
    if (options.pages) throw new Error('--pages applies only to PDF input');
    if (!['.txt', '.md', '.markdown'].includes(path.extname(file).toLowerCase())) throw new Error('Supported inputs: PDF, Markdown or plain text');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    assertText(text);
    source.sections = [{ ref: 'document', text: cleanIntakeText(text) }];
    return source;
  }
  source.kind = 'pdf';
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 200) throw new Error('PDF exceeds the 200-page intake limit');
    const pages = selectedPages(options.pages, pdf.numPages);
    let size = 0;
    for (const number of pages) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map((item) => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim();
      size += Buffer.byteLength(text);
      if (size > MAX_INTAKE_TEXT_BYTES) throw new Error('Extracted PDF exceeds intake text budget; select a smaller page range');
      if (text) source.sections.push({ ref: `page:${number}`, text: cleanIntakeText(text) });
      else source.warnings.push(`Page ${number} has no extractable text; image content is unverified.`);
      page.cleanup();
    }
    if (!source.sections.length) throw new Error('No extractable PDF text. Supply a text/OCR version; do not treat an unread document as assessed.');
    source.warnings.push('PDF text extraction does not interpret diagrams, images or layout; visually encoded requirements remain unverified.');
    if (pages.length !== pdf.numPages) source.warnings.push(`Only selected pages ${pages.join(',')} of ${pdf.numPages} were supplied; other pages were excluded before the model request.`);
    return source;
  } finally { await task.destroy(); }
}

function assertText(text: string): void {
  if (!text.trim() || text.includes('\0')) throw new Error('Input must contain nonempty text');
  if (Buffer.byteLength(text) > MAX_INTAKE_TEXT_BYTES) throw new Error('Input exceeds intake text budget');
}
