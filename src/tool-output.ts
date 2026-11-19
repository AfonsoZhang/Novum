import fs from 'node:fs';
import path from 'node:path';
import { contentHash, local } from './store.js';

export const TOOL_OUTPUT_BYTES = 50 * 1024;
export const READ_PAGE_BYTES = 16 * 1024;

/** Byte offsets make progress even through a single huge HTML/JSON line. */
export function textPage(text: string, offset = 0, limit = READ_PAGE_BYTES) {
  const bytes = Buffer.from(text);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) throw new Error('Offset is outside the file');
  if (!Number.isSafeInteger(limit) || limit < 4 || limit > READ_PAGE_BYTES) throw new Error(`Limit must be 4..${READ_PAGE_BYTES} bytes`);
  let start = offset;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  let end = Math.min(bytes.length, start + limit);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return { content: bytes.subarray(start, end).toString('utf8'), offset: start, nextOffset: end < bytes.length ? end : null,
    totalBytes: bytes.length, truncated: start > 0 || end < bytes.length };
}

/** Derived reading aid only; the immutable HTML remains the citation evidence. */
export function readableHtml(html: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', times: '×' };
  return html.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<\/(?:p|div|h[1-6]|section|li|tr|article)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (original, entity: string) => {
      if (entity[0] !== '#') return entities[entity.toLowerCase()] ?? original;
      const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : original;
    }).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function saveToolText(root: string, text: string): string {
  const name = `.research-loop/tool-output/${contentHash(text)}.txt`;
  const file = local(root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return name;
}

/** Preserve full output on disk and explicitly identify omitted content. */
export function boundToolContent(root: string, serialized: string): string {
  if (Buffer.byteLength(serialized) <= TOOL_OUTPUT_BYTES) return serialized;
  const fullOutputPath = saveToolText(root, serialized);
  let text = serialized; let sourceId: string | undefined;
  try {
    const parsed = JSON.parse(serialized);
    if (typeof parsed === 'string') text = parsed;
    else if (parsed && typeof parsed.content === 'string') { text = parsed.content; sourceId = typeof parsed.sourceId === 'string' && parsed.sourceId.length <= 200 ? parsed.sourceId : undefined; }
  } catch { /* Raw tool text remains readable. */ }
  const rawTextPath = saveToolText(root, text);
  const html = /^\s*(?:<!doctype html|<html\b)/i.test(text);
  if (html) text = readableHtml(text);
  const readPath = saveToolText(root, text);
  // Small head and tail preserve an overview and conclusions; middle is accessible by read_file.
  const page = textPage(text, 0, 4096);
  const tail = page.nextOffset === null ? undefined : textPage(text, Math.max(0, page.totalBytes - 2048), 2048).content;
  return JSON.stringify({ sourceId, fullOutputPath, rawTextPath, readPath, originalBytes: Buffer.byteLength(serialized),
    ...page, tail, outputTruncated: true, derivedFromHtml: html,
    instruction: 'The full tool output is preserved. This is a preview, not the complete evidence. Use read_file with path=readPath, byte offset=nextOffset, optional limit or literal query to inspect needed passages. Use rawTextPath for original evidence.' });
}
