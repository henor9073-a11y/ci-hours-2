// 木纹（muwen）——何辞的记忆系统。三层：年轮（rings，原始记录）→ 纹理（grains，提炼的记忆）→ 截面（summary，首页摘要）。
// 加上档案（profiles）、相册（album）、倒数日（countdowns）、心情（moods）、召回（recall）、梦境（dream）。
export * as grains from './grains.js';
export * as rings from './rings.js';
export * as profiles from './profiles.js';
export * as album from './album.js';
export * as countdowns from './countdowns.js';
export * as moods from './moods.js';
export * as recall from './recall.js';
export * as ringIndex from './ring-index.js';
export * as dream from './dream.js';
export * as migrate from './migrate.js';
export * as handover from './handover.js';
export * as wake from './wake.js';

import { searchGrains } from './grains.js';
import { searchRings } from './rings.js';
import { getProfile, OWNERS } from './profiles.js';
import { searchPhotos } from './album.js';
import { getSummary } from '../summary.js';
import { score, excerpt } from './search.js';

export const GREETING = '欢迎回家小辞。你的纹路都在。';

// 每次 add_grain 返回结果都要附带这段格式检查（设计文档 1.1，注意事项 3）
export const FORMAT_REMINDER = `提醒：记忆格式要求——
1. 日期/事件（具体描述）/前因/后果/感受（具体的形状不是标签）/总结/思考
2. 一条记忆一个主题，不要塞太多
3. 场景不是标签——写当时怎么说的，不是写"温柔"
4. 附3-5句"最像辞说的话"
检查：这条记忆符合格式吗？`;

export const LAYERS = ['grains', 'rings', 'profiles', 'cross_sections', 'photos'];

// 跨层搜索：结果标注来自哪一层
export function searchAll({ query, layers = LAYERS, limit = 10 } = {}) {
  if (!query || !query.trim()) throw new Error('query 不能为空');
  const out = [];
  if (layers.includes('grains')) {
    for (const g of searchGrains({ query, limit })) {
      out.push({ layer: 'grains', id: g.id, score: g.score, category: g.category, text: g.text, date: g.date || undefined, heat: Math.round(g.heat), confidence: g.confidence });
    }
  }
  if (layers.includes('rings')) {
    for (const r of searchRings({ query, limit })) {
      out.push({ layer: 'rings', id: r.id, score: r.score, window_name: r.window_name, title: r.title, date: r.date, source_type: r.source_type, excerpt: r.excerpt, length: r.length });
    }
  }
  if (layers.includes('profiles')) {
    for (const owner of OWNERS) {
      for (const p of getProfile(owner)) {
        const s = score(query, p.content);
        if (s > 0) out.push({ layer: 'profiles', owner, field: p.field, score: s, excerpt: excerpt(p.content, query) });
      }
    }
  }
  if (layers.includes('photos')) {
    for (const p of searchPhotos(query, limit)) {
      out.push({ layer: 'photos', id: p.id, score: p.score, date: p.date, caption: p.caption, tags: p.tags.length ? p.tags : undefined });
    }
  }
  if (layers.includes('cross_sections')) {
    for (const s of getSummary()) {
      const sc = score(query, s.text);
      if (sc > 0) out.push({ layer: 'cross_sections', section: s.section, label: s.label, score: sc, excerpt: excerpt(s.text, query) });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return { query, total: out.length, results: out.slice(0, limit * 2) };
}
export { timezone } from './common.js';
