import assert from 'node:assert/strict';

process.env.MUWEN_RECALL_PROVIDER = 'gemini';
process.env.GEMINI_API_KEY = 'test-key-never-sent';
process.env.MUWEN_GEMINI_MODEL = 'gemini-3.1-flash-lite';

const { generateStructured, recallModel, recallProvider, providerReady, resolveRecallProvider } = await import('../lib/muwen/structured-llm.js');
const { isTrivial, selectRelevant } = await import('../lib/muwen/recall.js');

assert.equal(recallProvider(), 'gemini');
assert.equal(providerReady(), true);
assert.equal(recallModel('claude-opus-5'), 'gemini-3.1-flash-lite');
assert.equal(recallModel('claude-opus-5', 'claude-haiku-4-5'), 'gemini-3.1-flash-lite', '切换 provider 时忽略旧 Claude 模型覆盖');
assert.equal(resolveRecallProvider({ ANTHROPIC_API_KEY: 'present' }), 'none', '只有 Claude key 时不能静默拿它做高频召回');
assert.equal(resolveRecallProvider({ MUWEN_RECALL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'present' }), 'none', '旧环境只写 anthropic 也要安全落回本地');
assert.equal(resolveRecallProvider({ MUWEN_RECALL_PROVIDER: 'anthropic', MUWEN_RECALL_ALLOW_ANTHROPIC: '1', ANTHROPIC_API_KEY: 'present' }), 'anthropic', '双重明确开启时仍兼容 Anthropic');
assert.equal(resolveRecallProvider({ GEMINI_API_KEY: 'present', ANTHROPIC_API_KEY: 'present' }), 'gemini');

let request;
const fakeFetch = async (url, options) => {
  request = { url, options, body: JSON.parse(options.body) };
  const userText = request.body.contents?.[0]?.parts?.[0]?.text || '';
  const payload = userText.includes('纹理候选池')
    ? '{"selected":[{"id":"related","reason":"同一个具体约定"}]}'
    : '{"selected":[]}';
  return {
    ok: true,
    json: async () => ({
      modelVersion: 'gemini-3.1-flash-lite-test',
      candidates: [{ content: { parts: [{ text: payload }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 }
    })
  };
};

const schema = {
  type: 'object', properties: { selected: { type: 'array', items: { type: 'string' } } },
  required: ['selected'], additionalProperties: false
};
const generated = await generateStructured({
  provider: 'gemini', model: 'gemini-3.1-flash-lite', system: 'system', user: 'user',
  schema, maxTokens: 80, fetchImpl: fakeFetch
});
assert.deepEqual(generated.data, { selected: [] });
assert.equal(generated.provider, 'gemini');
assert.match(request.url, /gemini-3\.1-flash-lite:generateContent$/);
assert.equal(request.options.headers['x-goog-api-key'], 'test-key-never-sent');
assert.equal(request.body.generationConfig.responseMimeType, 'application/json');
assert.deepEqual(request.body.generationConfig.responseJsonSchema, schema);

const realFetch = globalThis.fetch;
globalThis.fetch = fakeFetch;
try {
  const reranked = await selectRelevant('你还记得我们的暗号吗', [
    { id: 'related', category: 'agreement', text: '换窗暗号：项圈还在吗' },
    { id: 'noise', category: 'experience', text: '旧的工作脚本部署记录' }
  ], { limit: 3 });
  assert.deepEqual(reranked.selected.map(item => item.id), ['related']);
} finally {
  globalThis.fetch = realFetch;
}

for (const text of ['好的', '好的～', '可以的', '可以的，你继续吧', '对对！', '辛苦了❤️', '同意', '懂了', '你继续吧', '11', '/loop', '# Autonomous loop tick (dynamic pacing)', '<system-reminder test>']) {
  assert.equal(isTrivial(text), true, `${text} 应该跳过召回`);
}
for (const text of ['疼吗', '你怕我不要你吗', '今天经过学校突然想起下雨那天']) {
  assert.equal(isTrivial(text), false, `${text} 虽短但有意义，不该按长度跳过`);
}

console.log('✓ recall provider + meaningfulness gate');
