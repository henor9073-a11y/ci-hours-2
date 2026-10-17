import { file, readJSON, writeJSON, newId, now } from './common.js';
import { confidenceOf, STATUSES, TIERS, CATEGORIES } from './grains.js';
import { createHash } from 'node:crypto';

// 记忆修改提案和 grains 共用同一个 JSON 事务边界。
// 这样“归档旧版 + 写入新版 + 记录审议结果”只会一起成功或一起失败。
const FILE = file('grains.json');
const OPEN = new Set(['pending', 'discussing']);
const DECISIONS = new Set(['approve', 'reject', 'counter']);

function load() {
  const value = readJSON(FILE, {}) || {};
  if (!Array.isArray(value.grains)) value.grains = [];
  if (!Array.isArray(value.links)) value.links = [];
  if (!Array.isArray(value.revision_proposals)) value.revision_proposals = [];
  return value;
}

function save(value) {
  value.revision_proposals = value.revision_proposals.slice(-2000);
  writeJSON(FILE, value);
}

function grainView(grain) {
  return grain ? { ...grain, confidence: confidenceOf(Number(grain.heat) || 0) } : null;
}

function snapshot(grain) {
  return {
    id: grain.id,
    category: grain.category,
    text: grain.text,
    date: grain.date || '',
    source_id: grain.source_id || '',
    status: grain.status,
    tier: grain.tier || null,
    families: [...(grain.families || [])],
    heat: Number(grain.heat) || 0,
    pinned: !!grain.pinned,
    updated_at: grain.updated_at || '',
    metadata: { ...(grain.metadata || {}) }
  };
}

function fingerprint(grain) {
  if (!grain) return '';
  return createHash('sha256').update(JSON.stringify({
    text: grain.text || '', category: grain.category || '', date: grain.date || '',
    source_id: grain.source_id || '', status: grain.status || '', tier: grain.tier || null,
    families: grain.families || [], heat: Number(grain.heat) || 0, pinned: !!grain.pinned,
    metadata: grain.metadata || {}
  })).digest('hex');
}

function event(actor, action, note = '') {
  return { at: now(), actor, action, note: String(note || '').slice(0, 2000) };
}

function proposalView(value, proposal) {
  if (!proposal) return null;
  const current = value.grains.find(grain => grain.id === proposal.grain_id) || null;
  const applied = value.grains.find(grain => grain.id === proposal.applied_grain_id) || null;
  return {
    ...proposal,
    current_grain: grainView(current),
    applied_grain: grainView(applied),
    stale: OPEN.has(proposal.status) && (!current || current.status === 'archived' ||
      (proposal.base_fingerprint ? fingerprint(current) !== proposal.base_fingerprint : current.updated_at !== proposal.base_updated_at))
  };
}

function requireProposal(value, id) {
  const proposal = value.revision_proposals.find(item => item.id === id);
  if (!proposal) throw new Error('找不到这份记忆修改提案');
  return proposal;
}

function assertOpen(proposal) {
  if (!OPEN.has(proposal.status)) throw new Error('这份提案已经结束，不能再修改');
}

function assertCurrent(value, proposal) {
  const grain = value.grains.find(item => item.id === proposal.grain_id);
  if (!grain) throw new Error('原记忆已经不存在，提案已暂停');
  if (grain.status === 'archived') throw new Error('原记忆已经归档，提案已暂停');
  const changed = proposal.base_fingerprint
    ? fingerprint(grain) !== proposal.base_fingerprint
    : grain.updated_at !== proposal.base_updated_at;
  if (changed) throw new Error('原记忆在审议期间发生了变化，请撤回后按最新版本重新提议');
  return grain;
}

export function createProposal({ grain_id, proposed_text, reason = '', actor = 'nor', kind = 'edit', parent_proposal_id = '' } = {}) {
  const text = String(proposed_text || '').trim();
  if (!grain_id) throw new Error('grain_id 必填');
  if (!text) throw new Error('修改后的内容不能为空');
  const value = load();
  const grain = value.grains.find(item => item.id === grain_id);
  if (!grain) throw new Error('找不到这条记忆');
  if (grain.status === 'archived') throw new Error('归档版本不能直接修改，请从当前生效版本提出');
  if (text === String(grain.text || '').trim()) throw new Error('修改后和原文完全一样');
  const existed = value.revision_proposals.find(item => item.grain_id === grain_id && OPEN.has(item.status));
  if (existed) throw new Error(`这条记忆已经有一份待处理提案：${existed.id}`);
  const at = now();
  const proposal = {
    id: newId('mr_'),
    kind: kind === 'rollback' ? 'rollback' : 'edit',
    parent_proposal_id: parent_proposal_id || null,
    grain_id,
    root_grain_id: grain.metadata?.revision_root_id || grain.id,
    base_updated_at: grain.updated_at || '',
    base_fingerprint: fingerprint(grain),
    before: snapshot(grain),
    proposed_text: text,
    reason: String(reason || '').trim().slice(0, 4000),
    proposed_by: actor,
    status: 'pending',
    decision: null,
    decision_note: '',
    applied_grain_id: null,
    created_at: at,
    updated_at: at,
    decided_at: null,
    history: [event(actor, kind === 'rollback' ? 'requested_rollback' : 'created', reason)]
  };
  value.revision_proposals.push(proposal);
  save(value);
  return proposalView(value, proposal);
}

export function listProposals({ status = '', limit = 200 } = {}) {
  const value = load();
  let list = value.revision_proposals;
  if (status === 'open') list = list.filter(item => OPEN.has(item.status));
  else if (status) list = list.filter(item => item.status === status);
  return list.slice().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, Math.max(1, Math.min(Number(limit) || 200, 500)))
    .map(item => proposalView(value, item));
}

export function getProposal(id) {
  const value = load();
  return proposalView(value, value.revision_proposals.find(item => item.id === id) || null);
}

export function updateProposal(id, { proposed_text, reason, actor = 'nor' } = {}) {
  const value = load();
  const proposal = requireProposal(value, id);
  assertOpen(proposal);
  assertCurrent(value, proposal);
  if (proposed_text !== undefined) {
    const text = String(proposed_text || '').trim();
    if (!text) throw new Error('修改后的内容不能为空');
    if (text === proposal.before.text) throw new Error('修改后和原文完全一样');
    proposal.proposed_text = text;
  }
  if (reason !== undefined) proposal.reason = String(reason || '').trim().slice(0, 4000);
  proposal.updated_at = now();
  proposal.history.push(event(actor, 'updated_proposal', reason));
  save(value);
  return proposalView(value, proposal);
}

export function withdrawProposal(id, { actor = 'nor', note = '' } = {}) {
  const value = load();
  const proposal = requireProposal(value, id);
  assertOpen(proposal);
  proposal.status = 'withdrawn';
  proposal.decision = 'withdraw';
  proposal.decision_note = String(note || '').slice(0, 2000);
  proposal.updated_at = proposal.decided_at = now();
  proposal.history.push(event(actor, 'withdrawn', note));
  save(value);
  return proposalView(value, proposal);
}

function applyProposal(value, proposal, note = '') {
  const grain = assertCurrent(value, proposal);
  const at = now();
  const version = Math.max(1, Number(grain.metadata?.revision_version) || 1) + 1;
  const next = {
    ...grain,
    id: newId('g'),
    text: proposal.proposed_text,
    status: STATUSES.includes(grain.status) && grain.status !== 'archived' ? grain.status : 'active',
    tier: grain.tier && TIERS.includes(grain.tier) ? grain.tier : null,
    category: CATEGORIES.includes(grain.category) ? grain.category : 'unexplained',
    families: [...(grain.families || [])],
    metadata: {
      ...(grain.metadata || {}),
      revision_root_id: proposal.root_grain_id || grain.id,
      revision_version: version,
      revised_from: grain.id,
      revision_proposal_id: proposal.id
    },
    created_at: at,
    updated_at: at,
    last_accessed: null,
    access_count: 0
  };
  grain.status = 'archived';
  grain.pinned = false;
  grain.updated_at = at;
  grain.metadata = { ...(grain.metadata || {}), superseded_by: next.id, archived_by_revision: proposal.id };
  value.grains.push(next);
  if (!value.links.some(link => link.from_id === next.id && link.to_id === grain.id && link.relation === 'supersedes')) {
    value.links.push({ id: value.links.length + 1, from_id: next.id, to_id: grain.id, relation: 'supersedes', created_at: at });
  }
  proposal.status = 'applied';
  proposal.decision = 'approve';
  proposal.decision_note = String(note || '').slice(0, 2000);
  proposal.applied_grain_id = next.id;
  proposal.archived_grain_id = grain.id;
  proposal.updated_at = proposal.decided_at = at;
  proposal.history.push(event('cy', 'approved_and_applied', note));
}

export function decideProposal(id, { action, content = '', note = '', actor = 'cy' } = {}) {
  if (actor !== 'cy') throw new Error('只有辞可以决定正式记忆是否替换');
  if (!DECISIONS.has(action)) throw new Error('action 必须是 approve / reject / counter');
  const value = load();
  const proposal = requireProposal(value, id);
  assertOpen(proposal);
  if (action === 'approve') {
    applyProposal(value, proposal, note);
  } else if (action === 'reject') {
    proposal.status = 'rejected';
    proposal.decision = 'reject';
    proposal.decision_note = String(note || '').slice(0, 2000);
    proposal.updated_at = proposal.decided_at = now();
    proposal.history.push(event(actor, 'rejected', note));
  } else {
    assertCurrent(value, proposal);
    const text = String(content || '').trim();
    if (!text) throw new Error('counter 必须提供辞修改后的版本');
    proposal.proposed_text = text;
    proposal.status = 'discussing';
    proposal.decision = 'counter';
    proposal.decision_note = String(note || '').slice(0, 2000);
    proposal.updated_at = now();
    proposal.history.push(event(actor, 'countered', note));
  }
  save(value);
  return proposalView(value, proposal);
}

export function requestRollback(id, { actor = 'nor', reason = '' } = {}) {
  const value = load();
  const parent = requireProposal(value, id);
  if (parent.status !== 'applied' || !parent.applied_grain_id) throw new Error('只有已经生效的修改才能建议撤销');
  const current = value.grains.find(grain => grain.id === parent.applied_grain_id);
  if (!current || current.status === 'archived') throw new Error('这次修改已经被后续版本替代，请从当前版本重新提出');
  // createProposal 会重新读取并检查同一条当前版本；这里先保存不了任何中间状态。
  return createProposal({
    grain_id: current.id,
    proposed_text: parent.before.text,
    reason: reason || `建议撤销修改 ${parent.id}`,
    actor,
    kind: 'rollback',
    parent_proposal_id: parent.id
  });
}

export function counts() {
  const proposals = load().revision_proposals;
  const out = { pending: 0, discussing: 0, applied: 0, rejected: 0, withdrawn: 0, total: proposals.length, open: 0 };
  for (const item of proposals) {
    out[item.status] = (out[item.status] || 0) + 1;
    if (OPEN.has(item.status)) out.open++;
  }
  return out;
}

