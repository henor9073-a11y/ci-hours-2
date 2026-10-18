import { file, now, readJSON, writeJSON } from './common.js';

const ACCESS_FILE = file('agent-access.json');

// “仅记忆”不是前端装饰：普通 MCP 客户端只会看到并只能调用这张白名单。
// 木纹网页自己的只读请求带 x-muwen-readonly，不受这个开关影响。
export const MEMORY_ONLY_TOOLS = new Set([
  'get_summary', 'get_active_memories', 'get_profile',
  'search_grains', 'get_grain', 'list_families', 'get_grain_with_counterevidence',
  'get_tidy_report', 'get_memory', 'get_recall_logs', 'recall', 'auto_recall',
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
      ? '完整木屋：辞可以使用聊天、婴儿房、相册、位置、健康和其他工具。'
      : '仅记忆：辞只能查看、添加与召回记忆；其他木屋内容不会投递给辞。'
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
