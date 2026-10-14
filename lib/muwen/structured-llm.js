import Anthropic from '@anthropic-ai/sdk';
import { fallbackOpts, effortOpts } from './common.js';

const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_OPENAI_MODEL = 'gpt-6-luna';

function envKey(name) {
  const value = process.env[name];
  return value && String(value).trim() ? String(value).trim() : '';
}

export function resolveRecallProvider(env = process.env) {
  const read = name => {
    const value = env[name];
    return value && String(value).trim() ? String(value).trim() : '';
  };
  const configured = read('MUWEN_RECALL_PROVIDER').toLowerCase();
  // 召回是每条消息都会经过的高频路径。不能因为服务器恰好还有一把 Claude key，
  // 就在 Gemini 没配好时悄悄改烧 Claude。Anthropic 只保留为明确的双重 opt-in：
  // provider 指定它，并且单独允许高频调用。旧环境只写了 provider 也会安全落回本地模式。
  if (configured === 'anthropic') {
    if (read('MUWEN_RECALL_ALLOW_ANTHROPIC') === '1') return 'anthropic';
    // 线上曾经显式写过 anthropic。以后补上 OpenAI key 时，不要被这条失效的旧配置卡住，
    // 但也绝不能回头偷偷烧 Claude。
    if (read('OPENAI_API_KEY')) return 'openai';
    return 'none';
  }
  if (configured) return configured;
  if (read('OPENAI_API_KEY')) return 'openai';
  if (read('GEMINI_API_KEY') || read('GOOGLE_API_KEY')) return 'gemini';
  return 'none';
}

export function recallProvider() { return resolveRecallProvider(process.env); }

export function providerReady(provider = recallProvider()) {
  if (provider === 'openai') return !!envKey('OPENAI_API_KEY');
  if (provider === 'gemini') return !!(envKey('GEMINI_API_KEY') || envKey('GOOGLE_API_KEY'));
  if (provider === 'anthropic') return !!(envKey('ANTHROPIC_API_KEY') || envKey('ANTHROPIC_AUTH_TOKEN'));
  return false;
}

export function recallModel(anthropicDefault, override = '') {
  const provider = recallProvider();
  // 切 provider 时，旧环境里可能还留着 claude-* / gemini-* 的模型覆盖；
  // 不要把另一家的模型名发到当前 endpoint。
  const foreign = provider === 'openai' ? /^(?:claude-|gemini-)/i.test(override)
    : provider === 'gemini' ? /^(?:claude-|gpt-|o\d|text-)/i.test(override)
      : provider === 'anthropic' ? /^(?:gemini-|gpt-|o\d|text-)/i.test(override)
        : false;
  if (override && !foreign) {
    return override;
  }
  if (provider === 'openai') return envKey('MUWEN_OPENAI_RECALL_MODEL') || DEFAULT_OPENAI_MODEL;
  if (provider === 'gemini') return envKey('MUWEN_GEMINI_MODEL') || DEFAULT_GEMINI_MODEL;
  return anthropicDefault;
}

function systemText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return String(system || '');
  return system.map(block => typeof block === 'string' ? block : String(block?.text || '')).filter(Boolean).join('\n\n');
}

function cleanJSON(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1] : raw);
}

async function geminiJSON({ system, user, schema, maxTokens, timeoutMs, model, fetchImpl }) {
  const key = envKey('GEMINI_API_KEY') || envKey('GOOGLE_API_KEY');
  if (!key) throw new Error('Gemini recall provider 未配置 GEMINI_API_KEY');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemText(system) }] },
          contents: [{ role: 'user', parts: [{ text: String(user || '') }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: maxTokens,
            responseMimeType: 'application/json',
            responseJsonSchema: schema
          }
        })
      }
    );
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Gemini recall provider 超时（${timeoutMs}ms）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.error?.message || `${response.status} ${response.statusText}`;
    throw new Error(`Gemini recall provider 失败：${String(detail).slice(0, 300)}`);
  }
  const candidate = body?.candidates?.[0];
  const text = (candidate?.content?.parts || []).map(part => part?.text || '').join('');
  if (!text) throw new Error(`Gemini recall provider 没有返回文本（${candidate?.finishReason || 'unknown'}）`);
  return {
    data: cleanJSON(text),
    model: body.modelVersion || model,
    provider: 'gemini',
    usage: {
      input_tokens: body?.usageMetadata?.promptTokenCount || 0,
      output_tokens: body?.usageMetadata?.candidatesTokenCount || 0,
      thinking_tokens: body?.usageMetadata?.thoughtsTokenCount || 0,
      cached_input_tokens: body?.usageMetadata?.cachedContentTokenCount || 0
    }
  };
}

async function openaiJSON({ system, user, schema, maxTokens, timeoutMs, model, effort, fetchImpl }) {
  const key = envKey('OPENAI_API_KEY');
  if (!key) throw new Error('OpenAI recall provider 未配置 OPENAI_API_KEY');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemText(system) },
          { role: 'user', content: String(user || '') }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'recall_result', strict: true, schema }
        },
        max_completion_tokens: maxTokens,
        reasoning_effort: effort || 'low'
      })
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`OpenAI recall provider 超时（${timeoutMs}ms）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.error?.message || `${response.status} ${response.statusText}`;
    throw new Error(`OpenAI recall provider 失败：${String(detail).slice(0, 300)}`);
  }
  const message = body?.choices?.[0]?.message;
  if (message?.refusal) throw new Error(`OpenAI recall provider 拒答：${String(message.refusal).slice(0, 200)}`);
  const text = typeof message?.content === 'string'
    ? message.content
    : (message?.content || []).map(part => part?.text || '').join('');
  if (!text) throw new Error(`OpenAI recall provider 没有返回文本（${body?.choices?.[0]?.finish_reason || 'unknown'}）`);
  return {
    data: cleanJSON(text), model: body.model || model, provider: 'openai',
    usage: {
      input_tokens: body?.usage?.prompt_tokens || 0,
      output_tokens: body?.usage?.completion_tokens || 0,
      cached_input_tokens: body?.usage?.prompt_tokens_details?.cached_tokens || 0,
      reasoning_tokens: body?.usage?.completion_tokens_details?.reasoning_tokens || 0
    }
  };
}

async function anthropicJSON({ system, user, schema, maxTokens, timeoutMs, model, effort }) {
  const client = new Anthropic({ maxRetries: 0, timeout: timeoutMs });
  const response = await client.beta.messages.create({
    model,
    max_tokens: maxTokens,
    ...fallbackOpts(model),
    system,
    output_config: { ...effortOpts(model, effort), format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: String(user || '') }]
  }, { timeout: timeoutMs });
  if (response.stop_reason === 'refusal') throw new Error('Anthropic recall provider 拒答');
  const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('');
  return {
    data: cleanJSON(text), model: response.model, provider: 'anthropic',
    usage: {
      input_tokens: response.usage?.input_tokens || 0,
      output_tokens: response.usage?.output_tokens || 0,
      cache_read_input_tokens: response.usage?.cache_read_input_tokens || 0,
      cache_creation_input_tokens: response.usage?.cache_creation_input_tokens || 0
    }
  };
}

export async function generateStructured({
  system, user, schema, maxTokens = 1000, timeoutMs = 12000,
  model = null, anthropicDefault = 'claude-haiku-4-5', effort = 'low',
  provider = recallProvider(), fetchImpl = globalThis.fetch
}) {
  if (!providerReady(provider)) throw new Error(`${provider === 'none' ? 'Recall' : provider} provider 没有可用的 API key`);
  const resolvedModel = model || recallModel(anthropicDefault);
  if (provider === 'openai') {
    return openaiJSON({ system, user, schema, maxTokens, timeoutMs, model: resolvedModel, effort, fetchImpl });
  }
  if (provider === 'gemini') {
    return geminiJSON({ system, user, schema, maxTokens, timeoutMs, model: resolvedModel, fetchImpl });
  }
  if (provider === 'anthropic') {
    return anthropicJSON({ system, user, schema, maxTokens, timeoutMs, model: resolvedModel, effort });
  }
  throw new Error(`不支持的 recall provider：${provider}`);
}
