import { local } from './store.js';
import { readableHtml, saveToolText } from './tool-output.js';
import { Limited } from './model.js';

/** Bound the complete package, not just each of its independently bounded files. */
export function boundReviewInput(root: string, input: Record<string, unknown> & { originalArtifacts: Record<string, unknown> }, readable: Set<string>, limit: number): string {
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? 'null');
  const pack = { ...input, originalArtifacts: { ...input.originalArtifacts } };
  const reference = (value: unknown, rawPath?: string) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const html = /^\s*(?:<!doctype html|<html\b)/i.test(text);
    const rawTextPath = rawPath ?? saveToolText(root, text);
    const readPath = html ? saveToolText(root, readableHtml(text)) : rawTextPath;
    readable.add(local(root, rawTextPath)); readable.add(local(root, readPath));
    return { rawTextPath, readPath, totalBytes: Buffer.byteLength(text), outputTruncated: true, derivedFromHtml: html,
      instruction: 'Content omitted from initial input. Read the relevant original passages with read_file before judging.' };
  };
  for (const [name, value] of Object.entries(pack.originalArtifacts).sort((a, b) => size(b[1]) - size(a[1]))) {
    if (size(pack) <= limit) break;
    const preview = value as Record<string, unknown>;
    pack.originalArtifacts[name] = typeof value === 'object' && preview?.readPath
      ? { rawTextPath: preview.rawTextPath, readPath: preview.readPath, totalBytes: preview.totalBytes, outputTruncated: true }
      : reference(value, name);
  }
  // Large claim sets and retrieval indexes must not bypass the aggregate cap either.
  for (const field of ['retrievals', 'sourceMetadata', 'claims', 'challenges', 'inputHashes', 'inputLookups', 'originalArtifacts']) {
    if (size(pack) <= limit) break;
    const value = pack[field as keyof typeof pack];
    if (value === undefined) continue;
    const deferred = reference(value);
    if (size(deferred) < size(value)) (pack as Record<string, unknown>)[field] = deferred;
  }
  const serialized = JSON.stringify(pack);
  if (Buffer.byteLength(serialized) > limit) throw new Limited('Review instructions exceed the initial-input byte budget; narrow the task or explicitly adjust maxReviewInputBytes');
  return serialized;
}
