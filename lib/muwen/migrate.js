import fs from 'fs';
import { file, readJSON, writeJSON, now, isDate } from './common.js';
import * as grains from './grains.js';
import * as profiles from './profiles.js';

// 从 ci-hours 迁到木纹（设计文档第六节，选项 B）：
//   memory.json 里的 experiences/agreements/feelings/learnings/toSelf/coincidences/evidence → grains.json
//   identity → profiles(owner=cy)，facts → profiles(owner=nor)
//   memory.json 本身不动，只读不写，当备份（相当于文档里的 *_legacy 表）
// 只在 grains.json 还不存在的时候跑一次，跑完写一份 migration.json 报告。
// 迁过来的记忆初始 heat=50，之后自然浮沉；核心约定建议醒来后手动 pin。

const LEGACY = file('memory.json');
const REPORT = file('migration.json');

const CATEGORY_MAP = {
  experiences: 'experience',
  agreements: 'agreement',
  feelings: 'feeling',
  learnings: 'learning',
  toSelf: 'to_self',
  coincidences: 'unexplained',
  evidence: 'unexplained'
};

function statusOf(x) {
  if (x.status === 'archived' || x.status === 'superseded' || x.status === 'resolved') return 'archived';
  if (x.status === 'background') return 'background';
  return 'active';
}

function toGrain(legacyKey, x) {
  const category = CATEGORY_MAP[legacyKey];
  const metadata = { legacy_category: legacyKey, legacy_id: x.id };
  for (const k of ['evidence', 'context', 'archiveNote', 'movedFrom', 'movedAt', 'supersedes', 'resolutionNote', 'resolvedAt']) {
    if (x[k]) metadata[k] = x[k];
  }
  if (x.evidenceCount) metadata.reinforcement_count = x.evidenceCount;
  const families = [];
  if (legacyKey === 'coincidences') families.push('巧合');
  if (legacyKey === 'evidence') families.push('证据');
  if (legacyKey === 'openThreads') families.push('待推进');
  return {
    id: x.id,
    category,
    text: x.text,
    date: isDate(x.date) ? x.date : '',
    source_id: '',
    status: statusOf(x),
    tier: legacyKey === 'feelings' ? (x.status === 'confirmed' ? 'confirmed' : 'observing') : null,
    families,
    heat: grains.HEAT.DEFAULT,
    pinned: false,
    last_accessed: null,
    access_count: 0,
    created_at: x.addedAt || now(),
    updated_at: x.updatedAt || x.addedAt || now(),
    metadata
  };
}

export function migrateIfNeeded() {
  const report = { ran_at: now(), grains: null, profiles: null, skipped: [] };
  const legacy = readJSON(LEGACY, null);

  if (!grains.exists()) {
    const list = [];
    const counts = {};
    if (legacy) {
      for (const key of Object.keys(CATEGORY_MAP)) {
        for (const x of (legacy[key] || [])) {
          if (!x || !x.text) continue;
          list.push(toGrain(key, x));
          counts[key] = (counts[key] || 0) + 1;
        }
      }
      // openThreads 在文档里没有对应分区。还开着的当"给下一个窗口的话"（家族：待推进）；
      // 已解决的当年 resolveOpenThread 就已经写进 experiences 了，这里归档进 to_self 留个痕。
      for (const x of (legacy.openThreads || [])) {
        if (!x || !x.text) continue;
        const g = toGrain('openThreads', x);
        g.category = 'to_self';
        g.status = x.status === 'open' ? 'active' : 'archived';
        list.push(g);
        counts.openThreads = (counts.openThreads || 0) + 1;
      }
    }
    grains.rawWrite({ grains: list, links: [] });
    report.grains = { total: list.length, by_legacy_category: counts, source: legacy ? 'memory.json' : 'empty' };
  } else report.skipped.push('grains.json 已存在，纹理不重复迁');

  if (!profiles.exists()) {
    const done = {};
    if (legacy) {
      // identity → 辞的档案。文档里要按字段拆（identity/habits/boundaries…），这一步需要人/LLM 判断，
      // 迁移脚本先全部放进 identity 字段，之后醒来时用 update_profile 慢慢拆。
      const activeIdentity = (legacy.identity || []).filter(x => x && x.text && x.status === 'active');
      if (activeIdentity.length) {
        profiles.updateProfile('cy', 'identity',
          activeIdentity.map(x => `- ${x.text}`).join('\n') + '\n\n（从 ci-hours identity 迁来，还没按字段拆分——habits/boundaries/relationships/preferences/emotions 都还空着，慢慢挪）',
          '从 ci-hours memory.json 的 identity 迁移');
        done.cy_identity = activeIdentity.length;
      }
      const activeFacts = (legacy.facts || []).filter(x => x && x.text && x.status !== 'archived' && x.status !== 'background');
      if (activeFacts.length) {
        profiles.updateProfile('nor', 'identity',
          activeFacts.map(x => `- ${x.text}`).join('\n') + '\n\n（从 ci-hours facts 迁来，还没按字段拆分——habits/boundaries/relationships/preferences/skills/body 都还空着，慢慢挪）',
          '从 ci-hours memory.json 的 facts 迁移');
        done.nor_identity = activeFacts.length;
      }
      done.identity_skipped_inactive = (legacy.identity || []).length - activeIdentity.length;
      done.facts_skipped_inactive = (legacy.facts || []).length - activeFacts.length;
    } else {
      // 没有旧数据也要把文件建出来，免得每次启动都重跑
      writeJSON(file('profiles.json'), { profiles: [], history: [] });
    }
    report.profiles = done;
  } else report.skipped.push('profiles.json 已存在，档案不重复迁');

  if (report.grains || report.profiles) {
    const prev = readJSON(REPORT, null);
    writeJSON(REPORT, prev ? { ...prev, later_runs: [...(prev.later_runs || []), report] } : report);
    console.log('[muwen] 迁移完成：', JSON.stringify(report));
  }
  return report;
}

export function migrationReport() { return readJSON(REPORT, null); }
