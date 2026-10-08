import { file, readJSON, writeJSON, now } from './common.js';

// 一个很小的共享设置表：存"两个人共同看到的"东西，比如头像用哪张照片。
// 放服务器而不是 localStorage，是因为头像要两个人、两台设备看到的是同一个。
// look_* 是棋子的美化（配色 / 聊天外观 / 首页图标），网页和 Sigh App 共用一份，换设备也一样。
// 值是 JSON 字符串；图片（壁纸照片、聊天背景图、换过的图标图）各设备自己存，不进这里。

const FILE = file('prefs.json');
const ALLOWED = ['avatar_cy', 'avatar_nor', 'look_theme', 'look_chat', 'look_home'];
const LOOK_MAX = 20000;

export function getPrefs() {
  const d = readJSON(FILE, {});
  const out = {};
  for (const k of ALLOWED) out[k] = d[k] ? d[k].value : '';
  return out;
}
export function setPref(key, value, by = '') {
  if (!ALLOWED.includes(key)) throw new Error(`key 只能是 ${ALLOWED.join('/')}`);
  if (key.startsWith('look_')) {
    const text = String(value == null ? '' : value);
    if (text.length > LOOK_MAX) throw new Error('美化设置太大了（图片别往这里放）');
    if (text) { try { JSON.parse(text); } catch { throw new Error('美化设置要是 JSON'); } }
  }
  const d = readJSON(FILE, {});
  d[key] = { value: String(value == null ? '' : value), at: now(), by: String(by || '') };
  writeJSON(FILE, d);
  return { key, ...d[key] };
}
