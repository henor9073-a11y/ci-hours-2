import { file, now, readJSON, writeJSON } from './common.js';

const ACCESS_FILE = file('agent-access.json');

// “仅记忆”不是前端装饰：普通 MCP 客户端只会看到并只能调用这张白名单。
// 木纹网页自己的只读请求带 x-muwen-readonly，不受这个开关影响。
export const MEMORY_ONLY_TOOLS = new Set([
  'get_summary', 'get_active_memories', 'get_profile',
  'search_grains', 'get_grain', 'list_families', 'get_grain_with_counterevidence',
  'get_tidy_report', 'get_memory', 'get_recall_logs', 'recall', 'auto_recall',
  'continuity_commitment_list', 'continuity_commitment_candidate',
  'continuity_suggestion_decide', 'continuity_commitment_decide', 'continuity_commitment_update',
  // 外部模型区的结构管理权仍归辞；总开关关闭时只遮住聊天正文和 Thinking。
  'external_windows_list', 'external_window_create', 'external_window_update',
  'external_prompt_update', 'external_prompt_history', 'external_prompt_rollback',
  'external_window_delete', 'external_window_restore', 'external_window_lock',
  'external_window_unlock', 'external_window_mcp_set',
  'add_grain', 'remember',
  'add_experience', 'add_agreement', 'add_feeling', 'add_learning', 'add_to_self',
  'add_coincidence', 'add_evidence', 'add_identity', 'add_fact'
]);

function normalize(value) {
  const fullAccess = value?.full_access !== false;
  return {
    full_access: fullAccess,
    mode: fullAccess ? 'full' : 'memory_only',
    updated_at: value?.updated_at || null,
    updated_by: value?.updated_by || null,
    description: fullAccess
      ? '完整访问：辞可以使用木屋工具，并按需查询木屋与外部模型区记录；记录不会自动注入。'
      : '仅记忆：辞只能查看、添加与召回木纹；木屋与外部模型聊天正文不会投递或开放查询。外部窗口结构仍可管理。'
  };
}

export function getAgentAccess() {
  return normalize(readJSON(ACCESS_FILE, null));
}

export function setAgentAccess({ full_access } = {}, updatedBy = '棋子·Sigh') {
  if (typeof full_access !== 'boolean') throw new Error('full_access 必须是 true 或 false');
  const next = normalize({ full_access, updated_at: now(), updated_by: updatedBy });
  writeJSON(ACCESS_FILE, next);
  return next;
}

export function isMemoryOnly() {
  return !getAgentAccess().full_access;
}

export function toolAllowed(name) {
  return !isMemoryOnly() || MEMORY_ONLY_TOOLS.has(String(name || ''));
}

export function deliveryAllowed() {
  return !isMemoryOnly();
}
