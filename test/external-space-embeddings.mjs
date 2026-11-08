import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'external-embedding-test-'));
process.env.OPENAI_API_KEY = 'fake-embedding-key';
process.env.EXTERNAL_EMBEDDING_DIMENSIONS = '64';

const embedding = await import('../lib/external-space-embeddings.js');

function vectorFor(text) {
  const value = String(text);
  const vector = Array(64).fill(0);
  if (/龙|dragon/i.test(value)) vector[0] = 1;
  else if (/海|ocean/i.test(value)) vector[1] = 1;
  else vector[2] = 1;
  return vector;
}

const fakeFetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  return new Response(JSON.stringify({
    data: body.input.map((text, index) => ({ index, embedding: vectorFor(text) }))
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const windowA = {
  id: 'window-a', messages: [
    { id: 'a1', role: 'user', at: '2026-11-01T00:00:00Z', content: '我们以前聊过一条蓝色的龙。', reasoning: '不应进入索引的隐藏文字' },
    { id: 'a2', role: 'assistant', at: '2026-11-01T00:01:00Z', content: '我记得那条龙住在山里。', reasoning: 'secret dragon thinking' },
    { id: 'a3', role: 'user', at: '2026-11-02T00:00:00Z', content: '今天聊海。' }
  ], memories: [], episodes: [
    { id: 'old', summary: '第三人称旧摘要里也有龙', perspective: 'legacy_unverified', recallable: false },
    { id: 'new', summary: '我记得蓝色的龙。', perspective: 'first_person', recallable: true, source_message_ids: ['a1', 'a2'] }
  ]
};
const windowB = {
  id: 'window-b', messages: [{ id: 'b1', role: 'user', at: '2026-11-01T00:00:00Z', content: '另一个窗口的 dragon。' }],
  memories: [], episodes: []
};

const sources = embedding.externalEmbeddingSources(windowA);
assert.equal(sources.some(item => item.id === 'episode:old'), false);
assert.equal(sources.some(item => item.text.includes('secret dragon thinking')), false);
await embedding.syncExternalWindowEmbeddings(windowA, { fetchImpl: fakeFetch });
await embedding.syncExternalWindowEmbeddings(windowB, { fetchImpl: fakeFetch });
const result = await embedding.recallExternalWindow(windowA, '那条 dragon 后来怎么样', {
  fetchImpl: fakeFetch, excludeMessageIDs: ['a3'], limit: 10
});
assert.equal(result.ready, true);
assert.ok(result.sources.some(item => item.source_message_ids?.includes('a1')));
assert.equal(result.sources.some(item => item.window_id === 'window-b'), false);

console.log('✓ external raw semantic recall is isolated, evidence-backed and excludes thinking/legacy summaries');
