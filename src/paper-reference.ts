import { parsePaperReference, type PaperReference } from '../web/paper-reference.js';

export interface PaperMatch extends PaperReference { authors?: string; year?: number }
export async function resolvePaperReference(input: string, fetcher: typeof fetch = fetch) {
  const parsed = parsePaperReference(input);
  // Never fetch user-supplied hosts. Unknown links remain usable as original inputs.
  if (parsed.url && !parsed.doi) return { exact: false, candidates: [] as PaperMatch[] };
  const endpoint = parsed.doi ? `https://api.crossref.org/works/${encodeURIComponent(parsed.doi)}`
    : `https://api.crossref.org/works?${new URLSearchParams({ 'query.bibliographic': input.trim(), rows: '5', select: 'title,DOI,author,published' })}`;
  const response = await fetcher(endpoint, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000), redirect: 'error' });
  if (response.status === 404) return { exact: false, candidates: [] as PaperMatch[] };
  if (!response.ok) throw new Error('论文检索暂时不可用，原始输入已保留，可直接保存或手动补充。');
  if (!response.body) throw new Error('论文检索没有返回内容。');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 512_000) throw new Error('论文检索返回过大。'); chunks.push(value); }
  } finally { await reader.cancel(); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const records: unknown[] = parsed.doi ? [data.message] : Array.isArray(data.message?.items) ? data.message.items : [];
  const candidates: PaperMatch[] = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const work = record as { title?: unknown[]; DOI?: unknown; author?: { given?: string; family?: string }[]; published?: { 'date-parts'?: number[][] } };
    const title = work.title?.[0]; const doi = work.DOI;
    if (typeof title !== 'string' || !title.trim() || title.length > 500 || typeof doi !== 'string' || !/^10\.\d{4,9}\/\S+$/i.test(doi) || doi.length > 2048) continue;
    if (parsed.doi && parsed.doi.toLowerCase() !== doi.toLowerCase()) continue;
    candidates.push({ title: title.trim(), doi, url: `https://doi.org/${doi}`, authors: Array.isArray(work.author) ? work.author.slice(0, 3).map(author => [author.given, author.family].filter(Boolean).join(' ')).join(', ') : undefined, year: work.published?.['date-parts']?.[0]?.[0] });
  }
  return { exact: !!parsed.doi && candidates.length === 1, candidates };
}
