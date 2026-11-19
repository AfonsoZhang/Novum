export interface PaperReference { title: string; doi?: string; url?: string }

export function parsePaperReference(input: string): PaperReference {
  const raw = input.trim();
  let doi = raw.replace(/^doi:\s*/i, '');
  let url: URL | undefined;
  try { const parsed = new URL(raw); if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed; } catch { /* A title or bare DOI. */ }
  if (url && /^(?:dx\.)?doi\.org$/i.test(url.hostname)) {
    try { doi = decodeURIComponent(url.pathname.slice(1)); } catch { doi = ''; }
  }
  if (/^10\.\d{4,9}\/\S+$/i.test(doi)) return { title: raw.slice(0, 500), doi, url: url?.href ?? `https://doi.org/${doi}` };
  return { title: raw.slice(0, 500), ...(url ? { url: url.href } : {}) };
}

export function paperLink(reference: PaperReference): string | undefined {
  const candidate = reference.url ?? (reference.doi ? `https://doi.org/${reference.doi}` : undefined);
  if (!candidate) return;
  try { const url = new URL(candidate); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href; } catch { /* Invalid legacy link. */ }
}
