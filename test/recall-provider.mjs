import assert from 'node:assert/strict';

process.env.MUWEN_RECALL_PROVIDER = 'gemini';
process.env.GEMINI_API_KEY = 'test-key-never-sent';
process.env.MUWEN_GEMINI_MODEL = 'gemini-3.1-flash-lite';
process.env.OPENAI_API_KEY = 'test-openai-key-never-sent';

const { generateStructured, recallModel, recallProvider, providerReady, resolveRecallProvider } = await import('../lib/muwen/structured-llm.js');
const { isTrivial, selectRelevant } = await import('../lib/muwen/recall.js');
const { _test: embeddingTest } = await import('../lib/muwen/embeddings.js');

assert.equal(recallProvider(), 'gemini');
assert.equal(providerReady(), true);
assert.equal(recallModel('claude-opus-5'), 'gemini-3.1-flash-lite');
assert.equal(recallModel('claude-opus-5', 'claude-haiku-4-5'), 'gemini-3.1-flash-lite', '切换 provider 时忽略旧 Claude 模型覆盖');
assert.equal(resolveRecallProvider({ ANTHROPIC_API_KEY: 'present' }), 'none', '只有 Claude key 时不能静默拿它做高频召回');
assert.equal(resolveRecallProvider({ MUWEN_RECALL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'present' }), 'none', '旧环境只写 anthropic 也要安全落回本地');
assert.equal(resolveRecallProvider({ MUWEN_RECALL_PROVIDER: 'anthropic', MUWEN_RECALL_ALLOW_ANTHROPIC: '1', ANTHROPIC_API_KEY: 'present' }), 'anthropic', '双重明确开启时仍兼容 Anthropic');
assert.equal(resolveRecallProvider({ OPENAI_API_KEY: 'present' }), 'openai');
assert.equal(resolveRecallProvider({ OPENAI_API_KEY: 'present', GEMINI_API_KEY: 'present' }), 'openai', '没有显式指定时优先一把 OpenAI key 完成向量与精选');
assert.equal(resolveRecallProvider({ MUWEN_RECALL_PROVIDER: 'anthropic', OPENAI_API_KEY: 'present' }), 'openai', '失效的旧 Anthropic 配置不能挡住新 OpenAI key');
assert.equal(resolveRecallProvider({ GEMINI_API_KEY: 'present', ANTHROPIC_API_KEY: 'present' }), 'gemini');

process.env.MUWEN_RECALL_PROVIDER = 'openai';
assert.equal(recallModel('claude-opus-5'), 'gpt-6-luna');
assert.equal(recallModel('claude-opus-5', 'claude-haiku-4-5'), 'gpt-6-luna', 'OpenAI provider 忽略旧 Claude 模型覆盖');
process.env.MUWEN_RECALL_PROVIDER = 'gemini';

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

let openaiRequest;
const openaiFetch = async (url, options) => {
  openaiRequest = { url, options, body: JSON.parse(options.body) };
  return {
    ok: true,
    json: async () => ({
      model: 'gpt-6-luna-test',
      choices: [{ finish_reason: 'stop', message: { content: '{"selected":[]}' } }],
      usage: { prompt_tokens: 15, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } }
    })
  };
};
const openaiGenerated = await generateStructured({
  provider: 'openai', model: 'gpt-6-luna', system: 'system', user: 'user',
  schema, maxTokens: 80, fetchImpl: openaiFetch
});
assert.deepEqual(openaiGenerated.data, { selected: [] });
assert.equal(openaiGenerated.provider, 'openai');
assert.equal(openaiRequest.url, 'https://api.openai.com/v1/chat/completions');
assert.equal(openaiRequest.options.headers.Authorization, 'Bearer test-openai-key-never-sent');
assert.equal(openaiRequest.body.response_format.type, 'json_schema');
assert.deepEqual(openaiRequest.body.response_format.json_schema.schema, schema);
assert.equal(openaiRequest.body.reasoning_effort, 'low');

let embeddingRequest;
const embeddingFetch = async (url, options) => {
  embeddingRequest = { url, options, body: JSON.parse(options.body) };
  return { ok: true, json: async () => ({ data: [
    { index: 1, embedding: [0, 1, 0] },
    { index: 0, embedding: [1, 0, 0] }
  ], usage: { prompt_tokens: 8, total_tokens: 8 } }) };
};
const embedded = await embeddingTest.createEmbeddings(['项圈暗号', '旧工作记录'], { fetchImpl: embeddingFetch });
assert.deepEqual(embedded.vectors, [[1, 0, 0], [0, 1, 0]], '按 API 的 index 恢复输入顺序');
assert.equal(embeddingRequest.url, 'https://api.openai.com/v1/embeddings');
assert.equal(embeddingRequest.options.headers.Authorization, 'Bearer test-openai-key-never-sent');
assert.equal(embeddingRequest.body.model, 'text-embedding-3-small');
assert.equal(embeddingRequest.body.dimensions, 512);
assert.equal(Math.round(embeddingTest.cosine([1, 0], [1, 0]) * 100), 100);
assert.equal(Math.round(embeddingTest.cosine([1, 0], [0, 1]) * 100), 0);

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
