import { createHash } from 'node:crypto';
import { file, readJSON, writeJSON, newId, now } from './common.js';
import { confidenceOf, STATUSES, TIERS, CATEGORIES } from './grains.js';
import { OWNERS, OWNER_LABELS, FIELDS, FIELD_LABELS } from './profiles.js';

// 正式内容和它的修改提案共用一个 JSON 事务边界：
// 纹理提案存在 grains.json；档案提案存在 profiles.json。
// 因而“保存旧版 + 应用新版 + 记录审议结果”不会出现只完成一半的状态。
const GRAIN_FILE = file('grains.json');
const PROFILE_FILE = file('profiles.json');
const OPEN = new Set(['pending', 'discussing']);
const DECISIONS = new Set(['approve', 'reject', 'counter']);

function loadGrains() {
  const value = readJSON(GRAIN_FILE, {}) || {};
  if (!Array.isArray(value.grains)) value.grains = [];
  if (!Array.isArray(value.links)) value.links = [];
  if (!Array.isArray(value.revision_proposals)) value.revision_proposals = [];
  return value;
}

function saveGrains(value) {
  value.revision_proposals = value.revision_proposals.slice(-2000);
  writeJSON(GRAIN_FILE, value);
}

function loadProfiles() {
  const value = readJSON(PROFILE_FILE, {}) || {};
  if (!Array.isArray(value.profiles)) value.profiles = [];
  if (!Array.isArray(value.history)) value.history = [];
  if (!Array.isArray(value.revision_proposals)) value.revision_proposals = [];
  return value;
}

function saveProfiles(value) {
  value.revision_proposals = value.revision_proposals.slice(-2000);
  writeJSON(PROFILE_FILE, value);
}

function grainView(grain) {
  return grain ? { ...grain, confidence: confidenceOf(Number(grain.heat) || 0) } : null;
}

function grainSnapshot(grain) {
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

function profileSnapshot(profile, owner, field) {
  return {
    id: profile?.id || null,
    owner,
    owner_label: OWNER_LABELS[owner],
    field,
    field_label: FIELD_LABELS[field],
    text: String(profile?.content || ''),
    updated_at: profile?.updated_at || '',
    revision_version: Math.max(0, Number(profile?.revision_version) || 0)
  };
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function grainFingerprint(grain) {
  if (!grain) return '';
  return hash({
    text: grain.text || '', category: grain.category || '', date: grain.date || '',
    source_id: grain.source_id || '', status: grain.status || '', tier: grain.tier || null,
    families: grain.families || [], heat: Number(grain.heat) || 0, pinned: !!grain.pinned,
    metadata: grain.metadata || {}
  });
}

function profileFingerprint(profile, owner, field) {
  return hash({ id: profile?.id || null, owner, field, content: profile?.content || '' });
}

function event(actor, action, note = '') {
  return { at: now(), actor, action, note: String(note || '').slice(0, 2000) };
}

function checkProfile(owner, field) {
  if (!OWNERS.includes(owner)) throw new Error(`owner 必须是 ${OWNERS.join('/')} 之一`);
  if (!FIELDS[owner].includes(field)) throw new Error(`${OWNER_LABELS[owner]}的档案字段只能是 ${FIELDS[owner].join('/')} 之一`);
}

function proposalView(kind, value, proposal) {
  if (!proposal) return null;
  if (kind === 'profile') {
    const current = value.profiles.find(row => row.owner === proposal.owner && row.field === proposal.field) || null;
    const currentSnapshot = profileSnapshot(current, proposal.owner, proposal.field);
    return {
      ...proposal,
      target_type: 'profile',
      target_label: `${OWNER_LABELS[proposal.owner]} · ${FIELD_LABELS[proposal.field]}`,
      current_profile: currentSnapshot,
      applied_profile: proposal.applied_profile || null,
      stale: OPEN.has(proposal.status) && profileFingerprint(current, proposal.owner, proposal.field) !== proposal.base_fingerprint
    };
  }
  const current = value.grains.find(grain => grain.id === proposal.grain_id) || null;
  const applied = value.grains.find(grain => grain.id === proposal.applied_grain_id) || null;
  return {
    ...proposal,
    target_type: 'grain',
    target_label: '纹理记忆',
    current_grain: grainView(current),
    applied_grain: grainView(applied),
    stale: OPEN.has(proposal.status) && (!current || current.status === 'archived' ||
      (proposal.base_fingerprint ? grainFingerprint(current) !== proposal.base_fingerprint : current.updated_at !== proposal.base_updated_at))
  };
}

function locate(id) {
  const grains = loadGrains();
  const grainProposal = grains.revision_proposals.find(item => item.id === id);
  if (grainProposal) return { kind: 'grain', value: grains, proposal: grainProposal, save: saveGrains };
  const profiles = loadProfiles();
  const profileProposal = profiles.revision_proposals.find(item => item.id === id);
  if (profileProposal) return { kind: 'profile', value: profiles, proposal: profileProposal, save: saveProfiles };
  throw new Error('找不到这份记忆修改提案');
}

function assertOpen(proposal) {
  if (!OPEN.has(proposal.status)) throw new Error('这份提案已经结束，不能再修改');
}

function assertCurrentGrain(value, proposal) {
  const grain = value.grains.find(item => item.id === proposal.grain_id);
  if (!grain) throw new Error('原记忆已经不存在，提案已暂停');
  if (grain.status === 'archived') throw new Error('原记忆已经归档，提案已暂停');
  const changed = proposal.base_fingerprint
    ? grainFingerprint(grain) !== proposal.base_fingerprint
    : grain.updated_at !== proposal.base_updated_at;
  if (changed) throw new Error('原记忆在审议期间发生了变化，请撤回后按最新版本重新提议');
  return grain;
}

function assertCurrentProfile(value, proposal) {
  const profile = value.profiles.find(row => row.owner === proposal.owner && row.field === proposal.field) || null;
  if (profileFingerprint(profile, proposal.owner, proposal.field) !== proposal.base_fingerprint) {
    throw new Error('原档案在审议期间发生了变化，请撤回后按最新版本重新提议');
  }
  return profile;
}

export function createProposal({ grain_id, proposed_text, reason = '', actor = 'nor', kind = 'edit', parent_proposal_id = '' } = {}) {
  const text = String(proposed_text || '').trim();
  if (!grain_id) throw new Error('grain_id 必填');
  if (!text) throw new Error('修改后的内容不能为空');
  const value = loadGrains();
  const grain = value.grains.find(item => item.id === grain_id);
  if (!grain) throw new Error('找不到这条记忆');
  if (grain.status === 'archived') throw new Error('归档版本不能直接修改，请从当前生效版本提出');
  if (text === String(grain.text || '').trim()) throw new Error('修改后和原文完全一样');
  const existed = value.revision_proposals.find(item => item.grain_id === grain_id && OPEN.has(item.status));
  if (existed) throw new Error(`这条记忆已经有一份待处理提案：${existed.id}`);
  const at = now();
  const proposal = {
    id: newId('mr_'), target_type: 'grain',
    kind: kind === 'rollback' ? 'rollback' : 'edit',
    parent_proposal_id: parent_proposal_id || null,
    grain_id,
    root_grain_id: grain.metadata?.revision_root_id || grain.id,
    base_updated_at: grain.updated_at || '',
    base_fingerprint: grainFingerprint(grain),
    before: grainSnapshot(grain),
    proposed_text: text,
    reason: String(reason || '').trim().slice(0, 4000),
    proposed_by: actor,
    status: 'pending', decision: null, decision_note: '', applied_grain_id: null,
    created_at: at, updated_at: at, decided_at: null,
    history: [event(actor, kind === 'rollback' ? 'requested_rollback' : 'created', reason)]
  };
  value.revision_proposals.push(proposal);
  saveGrains(value);
  return proposalView('grain', value, proposal);
}

export function createProfileProposal({ owner, field, proposed_text, reason = '', actor = 'nor', kind = 'edit', parent_proposal_id = '' } = {}) {
  checkProfile(owner, field);
  if (proposed_text === undefined || proposed_text === null) throw new Error('修改后的内容必填');
  const text = String(proposed_text).trim();
  const value = loadProfiles();
  const profile = value.profiles.find(row => row.owner === owner && row.field === field) || null;
  const before = profileSnapshot(profile, owner, field);
  if (text === before.text.trim()) throw new Error('修改后和原文完全一样');
  const existed = value.revision_proposals.find(item => item.owner === owner && item.field === field && OPEN.has(item.status));
  if (existed) throw new Error(`这个档案字段已经有一份待处理提案：${existed.id}`);
  const at = now();
  const proposal = {
    id: newId('mr_'), target_type: 'profile',
    kind: kind === 'rollback' ? 'rollback' : 'edit',
    parent_proposal_id: parent_proposal_id || null,
    owner, field, profile_id: profile?.id || null,
    base_updated_at: profile?.updated_at || '',
    base_fingerprint: profileFingerprint(profile, owner, field),
    before, proposed_text: text,
    reason: String(reason || '').trim().slice(0, 4000),
    proposed_by: actor,
    status: 'pending', decision: null, decision_note: '', applied_profile: null,
    created_at: at, updated_at: at, decided_at: null,
    history: [event(actor, kind === 'rollback' ? 'requested_rollback' : 'created', reason)]
  };
  value.revision_proposals.push(proposal);
  saveProfiles(value);
  return proposalView('profile', value, proposal);
}

export function listProposals({ status = '', limit = 200, target_type = '' } = {}) {
  const stores = [];
  if (target_type !== 'profile') {
    const value = loadGrains();
    stores.push(...value.revision_proposals.map(item => proposalView('grain', value, item)));
  }
  if (target_type !== 'grain') {
    const value = loadProfiles();
    stores.push(...value.revision_proposals.map(item => proposalView('profile', value, item)));
  }
  let list = stores;
  if (status === 'open') list = list.filter(item => OPEN.has(item.status));
  else if (status) list = list.filter(item => item.status === status);
  return list.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, Math.max(1, Math.min(Number(limit) || 200, 500)));
}

export function getProposal(id) {
  try {
    const found = locate(id);
    return proposalView(found.kind, found.value, found.proposal);
  } catch { return null; }
}

export function updateProposal(id, { proposed_text, reason, actor = 'nor' } = {}) {
  const found = locate(id);
  const { kind, value, proposal, save } = found;
  assertOpen(proposal);
  if (kind === 'profile') assertCurrentProfile(value, proposal);
  else assertCurrentGrain(value, proposal);
  if (proposed_text !== undefined) {
    const text = String(proposed_text || '').trim();
    if (!text && kind !== 'profile') throw new Error('修改后的内容不能为空');
    if (text === proposal.before.text) throw new Error('修改后和原文完全一样');
    proposal.proposed_text = text;
  }
  if (reason !== undefined) proposal.reason = String(reason || '').trim().slice(0, 4000);
  proposal.updated_at = now();
  proposal.history.push(event(actor, 'updated_proposal', reason));
  save(value);
  return proposalView(kind, value, proposal);
}

export function withdrawProposal(id, { actor = 'nor', note = '' } = {}) {
  const { kind, value, proposal, save } = locate(id);
  assertOpen(proposal);
  proposal.status = 'withdrawn';
  proposal.decision = 'withdraw';
  proposal.decision_note = String(note || '').slice(0, 2000);
  proposal.updated_at = proposal.decided_at = now();
  proposal.history.push(event(actor, 'withdrawn', note));
  save(value);
  return proposalView(kind, value, proposal);
}

function applyGrain(value, proposal, note = '') {
  const grain = assertCurrentGrain(value, proposal);
  const at = now();
  const version = Math.max(1, Number(grain.metadata?.revision_version) || 1) + 1;
  const next = {
    ...grain, id: newId('g'), text: proposal.proposed_text,
    status: STATUSES.includes(grain.status) && grain.status !== 'archived' ? grain.status : 'active',
    tier: grain.tier && TIERS.includes(grain.tier) ? grain.tier : null,
    category: CATEGORIES.includes(grain.category) ? grain.category : 'unexplained',
    families: [...(grain.families || [])],
    metadata: {
      ...(grain.metadata || {}), revision_root_id: proposal.root_grain_id || grain.id,
      revision_version: version, revised_from: grain.id, revision_proposal_id: proposal.id
    },
    created_at: at, updated_at: at, last_accessed: null, access_count: 0
  };
  grain.status = 'archived'; grain.pinned = false; grain.updated_at = at;
  grain.metadata = { ...(grain.metadata || {}), superseded_by: next.id, archived_by_revision: proposal.id };
  value.grains.push(next);
  if (!value.links.some(link => link.from_id === next.id && link.to_id === grain.id && link.relation === 'supersedes')) {
    value.links.push({ id: value.links.length + 1, from_id: next.id, to_id: grain.id, relation: 'supersedes', created_at: at });
  }
  proposal.applied_grain_id = next.id;
  proposal.archived_grain_id = grain.id;
}

function applyProfile(value, proposal) {
  let profile = assertCurrentProfile(value, proposal);
  const at = now();
  if (!profile) {
    profile = { id: newId('p'), owner: proposal.owner, field: proposal.field, content: '', updated_at: '' };
    value.profiles.push(profile);
  }
  value.history.push({
    id: value.history.length + 1,
    profile_id: profile.id,
    old_content: profile.content || '',
    changed_at: at,
    reason: `记忆修改提案 ${proposal.id}${proposal.reason ? `：${proposal.reason}` : ''}`,
    revision_proposal_id: proposal.id
  });
  profile.content = proposal.proposed_text;
  profile.updated_at = at;
  profile.revision_version = Math.max(0, Number(profile.revision_version) || 0) + 1;
  profile.last_revision_proposal_id = proposal.id;
  proposal.profile_id = profile.id;
  proposal.applied_profile = profileSnapshot(profile, proposal.owner, proposal.field);
  proposal.applied_fingerprint = profileFingerprint(profile, proposal.owner, proposal.field);
}

export function decideProposal(id, { action, content = '', note = '', actor = 'cy' } = {}) {
  if (actor !== 'cy') throw new Error('只有辞可以决定正式记忆是否替换');
  if (!DECISIONS.has(action)) throw new Error('action 必须是 approve / reject / counter');
  const { kind, value, proposal, save } = locate(id);
  assertOpen(proposal);
  if (action === 'approve') {
    if (kind === 'profile') applyProfile(value, proposal);
    else applyGrain(value, proposal, note);
    proposal.status = 'applied'; proposal.decision = 'approve';
    proposal.decision_note = String(note || '').slice(0, 2000);
    proposal.updated_at = proposal.decided_at = now();
    proposal.history.push(event(actor, 'approved_and_applied', note));
  } else if (action === 'reject') {
    proposal.status = 'rejected'; proposal.decision = 'reject';
    proposal.decision_note = String(note || '').slice(0, 2000);
    proposal.updated_at = proposal.decided_at = now();
    proposal.history.push(event(actor, 'rejected', note));
  } else {
    if (kind === 'profile') assertCurrentProfile(value, proposal);
    else assertCurrentGrain(value, proposal);
    const text = String(content || '').trim();
    if (!text && kind !== 'profile') throw new Error('counter 必须提供辞修改后的版本');
    proposal.proposed_text = text; proposal.status = 'discussing'; proposal.decision = 'counter';
    proposal.decision_note = String(note || '').slice(0, 2000); proposal.updated_at = now();
    proposal.history.push(event(actor, 'countered', note));
  }
  save(value);
  return proposalView(kind, value, proposal);
}

export function requestRollback(id, { actor = 'nor', reason = '' } = {}) {
  const { kind, value, proposal: parent } = locate(id);
  if (parent.status !== 'applied') throw new Error('只有已经生效的修改才能建议撤销');
  if (kind === 'profile') {
    const current = value.profiles.find(row => row.owner === parent.owner && row.field === parent.field) || null;
    if (!current || profileFingerprint(current, parent.owner, parent.field) !== parent.applied_fingerprint) {
      throw new Error('这次修改已经被后续版本替代，请从当前版本重新提出');
    }
    return createProfileProposal({
      owner: parent.owner, field: parent.field, proposed_text: parent.before.text,
      reason: reason || `建议撤销修改 ${parent.id}`, actor, kind: 'rollback', parent_proposal_id: parent.id
    });
  }
  if (!parent.applied_grain_id) throw new Error('这次修改没有可撤销的新版本');
  const current = value.grains.find(grain => grain.id === parent.applied_grain_id);
  if (!current || current.status === 'archived') throw new Error('这次修改已经被后续版本替代，请从当前版本重新提出');
  return createProposal({
    grain_id: current.id, proposed_text: parent.before.text,
    reason: reason || `建议撤销修改 ${parent.id}`, actor, kind: 'rollback', parent_proposal_id: parent.id
  });
}

export function counts() {
  const proposals = [...loadGrains().revision_proposals, ...loadProfiles().revision_proposals];
  const out = { pending: 0, discussing: 0, applied: 0, rejected: 0, withdrawn: 0, total: proposals.length, open: 0, grains: 0, profiles: 0 };
  for (const item of proposals) {
    out[item.status] = (out[item.status] || 0) + 1;
    if (OPEN.has(item.status)) out.open++;
    if (item.target_type === 'profile') out.profiles++; else out.grains++;
  }
  return out;
}
