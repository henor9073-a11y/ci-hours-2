import { file, readJSON, writeJSON, now } from './common.js';

// 一个很小的共享设置表：存"两个人共同看到的"东西，比如头像用哪张照片。
// 放服务器而不是 localStorage，是因为头像要两个人、两台设备看到的是同一个。
// 配色那种"这台设备我喜欢怎么看"的仍然留在 localStorage，不进这里。

const FILE = file('prefs.json');
const ALLOWED = ['avatar_cy', 'avatar_nor'];

export function getPrefs() {
  const d = readJSON(FILE, {});
  const out = {};
  for (const k of ALLOWED) out[k] = d[k] ? d[k].value : '';
  return out;
}
export function setPref(key, value, by = '') {
  if (!ALLOWED.includes(key)) throw new Error(`key 只能是 ${ALLOWED.join('/')}`);
  const d = readJSON(FILE, {});
  d[key] = { value: String(value == null ? '' : value), at: now(), by: String(by || '') };
  writeJSON(FILE, d);
  return { key, ...d[key] };
}
