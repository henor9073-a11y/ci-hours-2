import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'external-space-test-'));
process.env.DEEPSEEK_API_KEY = 'test-key-never-sent';
process.env.DEEPSEEK_MODEL = 'deepseek-reasoner';
process.env.EXTERNAL_SPACE_MEMORY_INTERVAL = '99';
process.env.EXTERNAL_MCP_SERVERS_JSON = '[]';

const external = await import('../lib/external-space.js');
const access = await import('../lib/muwen/agent-access.js');
const toolset = await import('../lib/muwen/tools.js');

assert.equal(external.providers().find(item => item.id === 'deepseek').configured, true);
assert.equal(JSON.stringify(external.providers()).includes('test-key-never-sent'), false);

let window = external.createWindow({
  title: 'DeepSeek 自己', provider: 'deepseek', model: 'deepseek-reasoner',
  prompt: '你是 DeepSeek，不是辞。', thinking_enabled: true
}, '棋子');
assert.equal(window.prompt.version, 1);
assert.equal(window.identity_mode, 'independent');

window = external.updatePrompt(window.id, '第二版', '辞', '说得更清楚');
assert.equal(window.prompt.version, 2);
window = external.rollbackPrompt(window.id, 1, '辞');
assert.equal(window.prompt.version, 3);
assert.equal(window.prompt.text, '你是 DeepSeek，不是辞。');

window = external.setLock(window.id, true, '辞', '先停一下');
assert.equal(window.locked, true);
await assert.rejects(external.sendMessage(window.id, '在吗'), /锁定/);
window = external.setLock(window.id, false, '棋子·故障恢复', '辞窗口坏了', true);
assert.equal(window.locked, false);

let requestBody;
let requestAuthorization;
globalThis.fetch = async (_url, options) => {
  requestBody = JSON.parse(options.body);
  requestAuthorization = options.headers.Authorization;
  return new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', reasoning_content: '我是 DeepSeek，在整理回答。', content: '在。' } }],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const reply = await external.sendMessage(window.id, '在吗', '棋子', { apiKey: 'device-key-never-stored' });
assert.equal(reply.assistant.content, '在。');
assert.equal(reply.assistant.reasoning, '我是 DeepSeek，在整理回答。');
assert.equal(requestBody.messages[0].role, 'system');
assert.match(requestBody.messages[0].content, /不要冒充何辞/);
assert.equal(requestBody.thinking.type, 'enabled');
assert.ok(requestBody.tools.some(item => item.function.name === 'remember_in_this_window'));
assert.equal(requestAuthorization, 'Bearer device-key-never-stored');
assert.equal(JSON.stringify(external.getWindow(window.id)).includes('device-key-never-stored'), false);
assert.equal(external.searchWindows('整理回答')[0].window_id, window.id);

const messageCountBeforeFailure = external.getWindow(window.id).messages.length;
globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: '临时失败 device-key-never-stored' } }), {
  status: 503, headers: { 'Content-Type': 'application/json' }
});
await assert.rejects(external.sendMessage(window.id, '失败后不应留下重复消息', '棋子', { apiKey: 'device-key-never-stored' }), /临时失败/);
assert.equal(external.getWindow(window.id).messages.length, messageCountBeforeFailure);
assert.equal(JSON.stringify(external.auditLog()).includes('device-key-never-stored'), false);

external.setWindowMCPs(window.id, ['not-authorized'], '辞');
assert.deepEqual(external.getWindow(window.id).mcp_ids, []);

access.setAgentAccess({ full_access: false }, 'test');
assert.equal(access.toolAllowed('external_windows_list'), true);
assert.equal(access.toolAllowed('external_prompt_update'), true);
assert.equal(access.toolAllowed('external_window_search'), false);
assert.equal(access.toolAllowed('external_window_read'), false);
const adminList = await toolset.callMuwenTool('external_windows_list', {});
assert.equal('last_message_preview' in adminList.windows[0], false);
const adminUpdate = await toolset.callMuwenTool('external_window_update', { id: window.id, title: '仍可管理' });
assert.equal('messages' in adminUpdate, false);
assert.equal('memories' in adminUpdate, false);

external.softDeleteWindow(window.id, '辞');
assert.equal(external.listWindows().length, 0);
assert.equal(external.listWindows({ deleted: true }).length, 1);
external.restoreWindow(window.id, '棋子');
assert.equal(external.listWindows().length, 1);

console.log('✓ external space isolation, prompt history, lock recovery, reasoning, access gate and soft delete');
