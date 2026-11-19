import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePaperReference, paperLink } from '../../web/paper-reference.js';
import { resolvePaperReference } from '../../src/paper-reference.js';
import { researchInputsSchema } from '../../src/types.js';

const fixture = { title: ['Fixture paper'], DOI: '10.1234/Test', author: [{ given: 'A', family: 'Researcher' }], published: { 'date-parts': [[2025]] } };
test('a single input accepts a DOI, DOI URL, paper link or title while retaining the raw input', () => {
  for (const input of ['10.1234/Test', 'doi:10.1234/Test', 'https://doi.org/10.1234%2FTest']) {
    const parsed = parsePaperReference(input); assert.equal(parsed.doi, fixture.DOI); assert.equal(parsed.title, input);
    const saved = researchInputsSchema.parse({ seedPapers: [{ id: 'paper', kind: 'paper', ...parsed, referenceInput: input }], targetJournal: null });
    assert.equal(saved.seedPapers[0].referenceInput, input);
  }
  assert.deepEqual(parsePaperReference('A paper title'), { title: 'A paper title' });
  assert.equal(parsePaperReference('https://arxiv.org/abs/1706.03762').url, 'https://arxiv.org/abs/1706.03762');
  assert.equal(paperLink({ title: 'Untrusted', url: 'javascript:alert(1)' }), undefined);
});

test('only an exact DOI lookup can automatically complete a paper; title search returns choices', async () => {
  const exact = await resolvePaperReference('10.1234/Test', async (url) => {
    assert.equal(String(url), 'https://api.crossref.org/works/10.1234%2FTest');
    return Response.json({ message: fixture });
  });
  assert.equal(exact.exact, true); assert.equal(exact.candidates[0].title, fixture.title[0]);
  const title = await resolvePaperReference('Fixture paper', async (url) => {
    assert.equal(new URL(String(url)).searchParams.get('query.bibliographic'), 'Fixture paper');
    return Response.json({ message: { items: [fixture] } });
  });
  assert.equal(title.exact, false); assert.equal(title.candidates.length, 1);
  const mismatch = await resolvePaperReference('10.1234/Other', async () => Response.json({ message: fixture }));
  assert.equal(mismatch.exact, false); assert.deepEqual(mismatch.candidates, []);
});

test('unknown links are not fetched and failed metadata lookup cannot replace original inputs', async () => {
  const result = await resolvePaperReference('http://127.0.0.1/private', async () => { throw new Error('Must not fetch an arbitrary host'); });
  assert.deepEqual(result.candidates, []);
  const missing = await resolvePaperReference('10.1234/Missing', async () => new Response('', { status: 404 }));
  assert.deepEqual(missing.candidates, []);
  await assert.rejects(resolvePaperReference('10.1234/Test', async () => new Response('', { status: 503 })), /原始输入已保留/);
});
