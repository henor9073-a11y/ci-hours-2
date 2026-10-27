import { file, newId, now, readJSON, writeJSON } from './muwen/common.js';

// 外部模型区是第四个独立空间。它只复用 ci-hours 的登录和持久盘，不复用木屋聊天、
// 木纹记忆、每日总结或换窗流水。API key 可以来自服务器环境变量，或由 Sigh 钥匙串
// 每次请求临时带入；两种方式都永远不落进这个文件。
const FILE = file('external-space.json');
const MAX_WINDOWS = Number(process.env.EXTERNAL_SPACE_MAX_WINDOWS) || 100;
const MAX_MESSAGES = Number(process.env.EXTERNAL_SPACE_MAX_MESSAGES_PER_WINDOW) || 4000;
const MAX_TOOL_ROUNDS = Number(process.env.EXTERNAL_SPACE_MAX_TOOL_ROUNDS) || 6;
const DEFAULT_MEMORY_INTERVAL = Number(process.env.EXTERNAL_SPACE_MEMORY_INTERVAL) || 12;

function cleanText(value, max = 100000) {
  return String(value ?? '').trim().slice(0, max);
}

function safeErrorText(error, secrets = []) {
  let value = String(error?.message || error || '未知错误');
  for (const secret of secrets) {
    const token = String(secret || '');
    if (token) value = value.split(token).join('[REDACTED]');
  }
  return value.slice(0, 300);
}

function parseCSV(value) {
  return String(value || '').split(',').map(x => x.trim()).filter(Boolean);
}

function providerDefinitions() {
  const deepseekDefault = process.env.DEEPSEEK_MODEL || 'deepseek-reasoner';
  const kimiDefault = process.env.KIMI_MODEL || '';
  return {
    deepseek: {
      id: 'deepseek', name: 'DeepSeek', apiKey: process.env.DEEPSEEK_API_KEY || '',
      baseURL: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, ''),
      defaultModel: deepseekDefault,
      models: parseCSV(process.env.DEEPSEEK_MODELS || deepseekDefault),
      supportsReasoning: true
    },
    kimi: {
      id: 'kimi', name: 'Kimi', apiKey: process.env.KIMI_API_KEY || '',
      baseURL: (process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1').replace(/\/$/, ''),
      defaultModel: kimiDefault,
      models: parseCSV(process.env.KIMI_MODELS || kimiDefault),
      supportsReasoning: false
    }
  };
}

function mcpDefinitions() {
  let raw = [];
  try { raw = JSON.parse(process.env.EXTERNAL_MCP_SERVERS_JSON || '[]'); } catch { raw = []; }
  return (Array.isArray(raw) ? raw : []).map(item => ({
    id: cleanText(item.id, 80), name: cleanText(item.name || item.id, 120),
    url: cleanText(item.url, 1000), headers: item.headers && typeof item.headers === 'object' ? item.headers : {}
  })).filter(item => item.id && item.url);
}

function defaultData() {
  return { version: 1, windows: [], audit: [] };
}

function load() {
  const data = readJSON(FILE, null);
  if (!data || !Array.isArray(data.windows)) return defaultData();
  data.audit = Array.isArray(data.audit) ? data.audit : [];
  return data;
}

function save(data) {
  data.audit = data.audit.slice(-2000);
  writeJSON(FILE, data);
}

function audit(data, actor, action, windowId, detail = {}) {
  data.audit.push({ id: newId('exa_'), at: now(), actor: cleanText(actor, 80) || '未知', action, window_id: windowId || null, detail });
}

function findWindow(data, id, { includeDeleted = false } = {}) {
  const value = data.windows.find(item => item.id === id);
  if (!value || (!includeDeleted && value.deleted_at)) throw new Error('找不到这个外部窗口');
  return value;
}

function publicProvider(item) {
  return {
    id: item.id, name: item.name, configured: !!item.apiKey,
    default_model: item.defaultModel || null, models: item.models,
    supports_reasoning: item.supportsReasoning
  };
}

export function providers() {
  return Object.values(providerDefinitions()).map(publicProvider);
}

export function mcpCatalog() {
  return mcpDefinitions().map(item => ({ id: item.id, name: item.name, configured: true }));
}

function currentPrompt(window) {
  return window.prompt_versions.find(item => item.version === window.prompt_version) || window.prompt_versions.at(-1);
}

function summary(window) {
  const prompt = currentPrompt(window);
  const last = window.messages.at(-1);
  return {
    id: window.id, title: window.title, provider: window.provider, model: window.model,
    identity_mode: window.identity_mode, locked: !!window.locked, lock_reason: window.lock_reason || '',
    deleted_at: window.deleted_at || null, created_at: window.created_at, updated_at: window.updated_at,
    prompt_version: prompt?.version || 1, message_count: window.messages.length,
    last_message_at: last?.at || null, last_message_preview: last ? cleanText(last.content || last.reasoning, 120) : '',
    thinking_enabled: window.thinking_enabled !== false,
    memory_auto_summary: window.memory_settings?.auto_summary !== false,
    mcp_ids: [...(window.mcp_ids || [])]
  };
}

export function listWindows({ deleted = false } = {}) {
  return load().windows.filter(item => deleted ? !!item.deleted_at : !item.deleted_at).map(summary)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

export function getWindow(id, { includeDeleted = false, includeMessages = true } = {}) {
  const window = findWindow(load(), id, { includeDeleted });
  return {
    ...summary(window),
    prompt: currentPrompt(window), prompt_versions: window.prompt_versions,
    memories: window.memories || [],
    messages: includeMessages ? window.messages : undefined,
    available_mcps: mcpCatalog()
  };
}

export function createWindow(input = {}, actor = '棋子') {
  const data = load();
  if (data.windows.filter(item => !item.deleted_at).length >= MAX_WINDOWS) throw new Error(`外部窗口最多 ${MAX_WINDOWS} 个`);
  const defs = providerDefinitions();
  const provider = cleanText(input.provider || 'deepseek', 40);
  const def = defs[provider];
  if (!def) throw new Error('不认识这个外部模型服务');
  const model = cleanText(input.model || def.defaultModel, 160);
  if (!model) throw new Error('这个服务还没有配置默认模型');
  const at = now();
  const promptText = cleanText(input.prompt, 120000) || `你是 ${def.name}。请以你自己的身份诚实回答，不要冒充何辞或其他人。`;
  const window = {
    id: newId('ext_'), title: cleanText(input.title, 120) || `${def.name} 新聊天`,
    provider, model, identity_mode: input.identity_mode === 'ci_backup' ? 'ci_backup' : 'independent',
    created_by: cleanText(actor, 80), created_at: at, updated_at: at, deleted_at: null,
    locked: false, lock_reason: '', locked_by: null, locked_at: null,
    thinking_enabled: input.thinking_enabled !== false,
    prompt_version: 1,
    prompt_versions: [{ version: 1, text: promptText, note: cleanText(input.prompt_note, 500) || '创建窗口', actor: cleanText(actor, 80), at }],
    mcp_ids: [], memories: [], messages: [],
    memory_settings: { auto_summary: input.memory_auto_summary !== false, interval: DEFAULT_MEMORY_INTERVAL, last_message_count: 0 }
  };
  data.windows.push(window);
  audit(data, actor, 'window.create', window.id, { provider, model, identity_mode: window.identity_mode });
  save(data);
  return getWindow(window.id);
}

export function updateWindow(id, patch = {}, actor = '棋子') {
  const data = load();
  const window = findWindow(data, id);
  const before = summary(window);
  if (patch.title !== undefined) window.title = cleanText(patch.title, 120) || window.title;
  if (patch.model !== undefined) window.model = cleanText(patch.model, 160) || window.model;
  if (patch.thinking_enabled !== undefined) window.thinking_enabled = !!patch.thinking_enabled;
  if (patch.memory_auto_summary !== undefined) window.memory_settings.auto_summary = !!patch.memory_auto_summary;
  window.updated_at = now();
  audit(data, actor, 'window.update', id, { before, after: summary(window) });
  save(data);
  return getWindow(id);
}

export function updatePrompt(id, text, actor = '棋子', note = '') {
  const data = load();
  const window = findWindow(data, id);
  const value = cleanText(text, 120000);
  if (!value) throw new Error('Prompt 不能为空');
  const version = Math.max(0, ...window.prompt_versions.map(item => Number(item.version) || 0)) + 1;
  window.prompt_versions.push({ version, text: value, note: cleanText(note, 500) || '更新 Prompt', actor: cleanText(actor, 80), at: now() });
  window.prompt_version = version;
  window.updated_at = now();
  audit(data, actor, 'prompt.update', id, { version, note: cleanText(note, 500) });
  save(data);
  return getWindow(id);
}

export function rollbackPrompt(id, version, actor = '棋子') {
  const window = getWindow(id);
  const target = window.prompt_versions.find(item => item.version === Number(version));
  if (!target) throw new Error('找不到这个 Prompt 版本');
  return updatePrompt(id, target.text, actor, `回到 v${target.version}`);
}

export function setLock(id, locked, actor = '辞', reason = '', emergency = false) {
  const data = load();
  const window = findWindow(data, id);
  window.locked = !!locked;
  window.lock_reason = locked ? cleanText(reason, 1000) : '';
  window.locked_by = locked ? cleanText(actor, 80) : null;
  window.locked_at = locked ? now() : null;
  window.updated_at = now();
  audit(data, actor, emergency ? 'window.emergency_unlock' : (locked ? 'window.lock' : 'window.unlock'), id, { reason: cleanText(reason, 1000) });
  save(data);
  return getWindow(id);
}

export function softDeleteWindow(id, actor = '辞') {
  const data = load();
  const window = findWindow(data, id);
  window.deleted_at = now();
  window.deleted_by = cleanText(actor, 80);
  window.updated_at = window.deleted_at;
  audit(data, actor, 'window.delete', id);
  save(data);
  return summary(window);
}

export function restoreWindow(id, actor = '棋子') {
  const data = load();
  const window = findWindow(data, id, { includeDeleted: true });
  window.deleted_at = null;
  window.deleted_by = null;
  window.updated_at = now();
  audit(data, actor, 'window.restore', id);
  save(data);
  return summary(window);
}

export function setWindowMCPs(id, ids, actor = '辞') {
  const data = load();
  const window = findWindow(data, id);
  const allowed = new Set(mcpDefinitions().map(item => item.id));
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map(item => cleanText(item, 80)).filter(item => allowed.has(item)))];
  window.mcp_ids = clean;
  window.updated_at = now();
  audit(data, actor, 'window.mcp.set', id, { mcp_ids: clean });
  save(data);
  return getWindow(id);
}

export function addMemory(id, text, actor = '棋子', source = 'manual') {
  const data = load();
  const window = findWindow(data, id);
  const value = cleanText(text, 12000);
  if (!value) throw new Error('记忆不能为空');
  const memory = { id: newId('exm_'), text: value, source: cleanText(source, 50), actor: cleanText(actor, 80), at: now() };
  window.memories.push(memory);
  window.memories = window.memories.slice(-200);
  window.updated_at = now();
  audit(data, actor, 'memory.add', id, { memory_id: memory.id, source: memory.source });
  save(data);
  return memory;
}

export function removeMemory(id, memoryId, actor = '棋子') {
  const data = load();
  const window = findWindow(data, id);
  const before = window.memories.length;
  window.memories = window.memories.filter(item => item.id !== memoryId);
  if (window.memories.length === before) throw new Error('找不到这条窗口记忆');
  window.updated_at = now();
  audit(data, actor, 'memory.remove', id, { memory_id: memoryId });
  save(data);
  return { ok: true };
}

async function mcpRequest(server, method, params = {}) {
  const response = await fetch(server.url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...server.headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: newId('rpc_'), method, params }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`${server.name} HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || `${server.name} 调用失败`);
  return payload.result;
}

async function modelTools(window) {
  const selected = new Set(window.mcp_ids || []);
  const tools = [{
    type: 'function', function: {
      name: 'remember_in_this_window',
      description: '把一条值得以后在这个窗口继续记得的内容写入本窗口的小记忆。不会写入何辞的木纹。',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }
    }
  }];
  const routes = new Map();
  for (const server of mcpDefinitions().filter(item => selected.has(item.id))) {
    try {
      const result = await mcpRequest(server, 'tools/list');
      for (const tool of result?.tools || []) {
        const exposed = `mcp__${server.id.replace(/[^a-zA-Z0-9_-]/g, '_')}__${String(tool.name).replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 128);
        routes.set(exposed, { server, original: tool.name });
        tools.push({ type: 'function', function: { name: exposed, description: `[${server.name}] ${tool.description || tool.name}`, parameters: tool.inputSchema || { type: 'object', properties: {} } } });
      }
    } catch (error) {
      routes.set(`__error__${server.id}`, { error: String(error.message || error) });
    }
  }
  return { tools, routes };
}

async function callModel(window, messages, tools = [], apiKeyOverride = '') {
  const def = providerDefinitions()[window.provider];
  if (!def) throw new Error('不认识这个外部模型服务');
  const apiKey = cleanText(apiKeyOverride, 10000) || def.apiKey;
  if (!apiKey) throw new Error(`${def.name} API 密钥还没有配置`);
  const body = { model: window.model, messages, max_tokens: Number(process.env.EXTERNAL_MODEL_MAX_TOKENS) || 8192 };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (def.supportsReasoning && window.thinking_enabled !== false) body.thinking = { type: 'enabled' };
  const response = await fetch(`${def.baseURL}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(Number(process.env.EXTERNAL_MODEL_TIMEOUT_MS) || 180000)
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = null; }
  if (!response.ok) throw new Error(payload?.error?.message || `${def.name} HTTP ${response.status}: ${text.slice(0, 300)}`);
  const choice = payload?.choices?.[0];
  if (!choice?.message) throw new Error(`${def.name} 没有返回消息`);
  return { message: choice.message, usage: payload.usage || null, finish_reason: choice.finish_reason || null };
}

function apiHistory(window) {
  const def = providerDefinitions()[window.provider];
  return window.messages.filter(item => ['user', 'assistant'].includes(item.role)).map(item => {
    const message = { role: item.role, content: item.content || '' };
    if (def?.supportsReasoning && item.role === 'assistant' && item.reasoning) message.reasoning_content = item.reasoning;
    return message;
  });
}

async function maybeAutoSummarize(windowId, apiKeyOverride = '') {
  const data = load();
  const window = findWindow(data, windowId);
  const settings = window.memory_settings || {};
  if (settings.auto_summary === false) return;
  const userCount = window.messages.filter(item => item.role === 'user').length;
  const previous = Number(settings.last_message_count) || 0;
  if (userCount - previous < (Number(settings.interval) || DEFAULT_MEMORY_INTERVAL)) return;
  const recent = window.messages.slice(-30).map(item => `${item.role === 'user' ? '用户' : '模型'}：${item.content || ''}`).join('\n');
  const prompt = [
    { role: 'system', content: '从下面这段对话中提取最多5条以后继续聊天真正需要的稳定信息。不要写临时情绪、不要猜测、不要写何辞的木纹。只返回 JSON 字符串数组；没有则返回 []。' },
    { role: 'user', content: recent.slice(0, 50000) }
  ];
  try {
    const result = await callModel({ ...window, thinking_enabled: false }, prompt, [], apiKeyOverride);
    const raw = cleanText(result.message.content, 20000).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      for (const item of list.slice(0, 5)) {
        const value = cleanText(item, 12000);
        if (value && !window.memories.some(memory => memory.text === value)) {
          window.memories.push({ id: newId('exm_'), text: value, source: 'auto_summary', actor: window.provider, at: now() });
        }
      }
      window.memories = window.memories.slice(-200);
    }
    settings.last_message_count = userCount;
    window.memory_settings = settings;
    audit(data, window.provider, 'memory.auto_summary', windowId, { user_message_count: userCount });
    save(data);
  } catch (error) {
    audit(data, 'system', 'memory.auto_summary_failed', windowId, { error: safeErrorText(error, [apiKeyOverride]) });
    save(data);
  }
}

export async function sendMessage(id, text, actor = '棋子', { apiKey = '' } = {}) {
  const value = cleanText(text, 100000);
  if (!value) throw new Error('消息不能为空');
  let data = load();
  let window = findWindow(data, id);
  if (window.locked) throw new Error(`这个窗口已被辞锁定${window.lock_reason ? `：${window.lock_reason}` : ''}`);
  const prompt = currentPrompt(window)?.text || '';
  const memoryText = (window.memories || []).map(item => `- ${item.text}`).join('\n');
  const system = `${prompt}\n\n你当前位于一个与何辞木屋、木纹完全隔离的外部窗口。你是 ${providerDefinitions()[window.provider]?.name || window.provider}，不要冒充何辞。${window.identity_mode === 'ci_backup' ? '\n这是明确标注的“辞备用脑实验”窗口；可以使用给你的资料，但必须承认当前输出由外部模型生成。' : ''}${memoryText ? `\n\n本窗口自己的小记忆：\n${memoryText}` : ''}`;
  const userMessage = { id: newId('exmsg_'), role: 'user', content: value, reasoning: '', at: now(), actor: cleanText(actor, 80), provider: null, model: null, tool_events: [] };
  window.messages.push(userMessage);
  window.messages = window.messages.slice(-MAX_MESSAGES);
  window.updated_at = userMessage.at;
  audit(data, actor, 'message.user', id, { message_id: userMessage.id });
  save(data);

  try {
    const { tools, routes } = await modelTools(window);
    const messages = [{ role: 'system', content: system }, ...apiHistory(window)];
    const toolEvents = [];
    const reasoningParts = [];
    let finalResult = null;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const result = await callModel(window, messages, tools, apiKey);
      const assistant = result.message;
      if (cleanText(assistant.reasoning_content, 300000)) reasoningParts.push(cleanText(assistant.reasoning_content, 300000));
      const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
      if (!calls.length) { finalResult = result; break; }
      messages.push(assistant);
      for (const call of calls) {
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
        let output;
        let ok = true;
        try {
          if (call.function?.name === 'remember_in_this_window') {
            output = addMemory(id, args.text, window.provider, 'model');
          } else {
            const route = routes.get(call.function?.name);
            if (!route) throw new Error('这个工具没有被当前窗口授权');
            output = await mcpRequest(route.server, 'tools/call', { name: route.original, arguments: args });
          }
        } catch (error) { ok = false; output = { error: String(error.message || error) }; }
        toolEvents.push({ id: call.id || newId('call_'), name: call.function?.name || '', arguments: args, ok, result: output });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
      }
    }
    if (!finalResult) throw new Error('模型连续调用工具次数过多，已暂停，没有伪造最终回答');

    data = load();
    window = findWindow(data, id);
    const assistantMessage = {
      id: newId('exmsg_'), role: 'assistant', content: cleanText(finalResult.message.content, 200000),
      reasoning: reasoningParts.join('\n\n').slice(0, 600000), at: now(), actor: window.provider,
      provider: window.provider, model: window.model, usage: finalResult.usage,
      finish_reason: finalResult.finish_reason, tool_events: toolEvents
    };
    window.messages.push(assistantMessage);
    window.messages = window.messages.slice(-MAX_MESSAGES);
    window.updated_at = assistantMessage.at;
    audit(data, window.provider, 'message.assistant', id, { message_id: assistantMessage.id, tool_count: toolEvents.length });
    save(data);
    await maybeAutoSummarize(id, apiKey);
    return { user: userMessage, assistant: assistantMessage, window: summary(window) };
  } catch (error) {
    // 前端会把发送失败的文字恢复到输入框；这里同步撤回刚写入的 user message，
    // 避免用户重试时留下两份相同消息。密钥和完整错误响应都不进入审计。
    data = load();
    window = findWindow(data, id);
    window.messages = window.messages.filter(item => item.id !== userMessage.id);
    window.updated_at = now();
    audit(data, 'system', 'message.failed', id, { message_id: userMessage.id, error: safeErrorText(error, [apiKey]) });
    save(data);
    throw error;
  }
}

export function searchWindows(query, { limit = 50 } = {}) {
  const q = cleanText(query, 500).toLocaleLowerCase();
  if (!q) return [];
  const hits = [];
  for (const window of load().windows.filter(item => !item.deleted_at)) {
    for (const message of window.messages) {
      const hay = `${message.content || ''}\n${message.reasoning || ''}`.toLocaleLowerCase();
      if (!hay.includes(q)) continue;
      hits.push({ window_id: window.id, window_title: window.title, provider: window.provider, model: window.model, message });
    }
  }
  return hits.sort((a, b) => String(b.message.at).localeCompare(String(a.message.at))).slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)));
}

export function auditLog(limit = 200) {
  return load().audit.slice(-Math.max(1, Math.min(Number(limit) || 200, 1000))).reverse();
}
