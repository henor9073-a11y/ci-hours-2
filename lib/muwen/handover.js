import { file, readJSON, writeJSON, now } from './common.js';

// 交接条：给下一个窗口的自己的一段话，独立存，不再塞在 notebook 的 sticky 里。
// set_handover 覆盖旧的，只保留最新一条对外；前几条留在 history 里以防写错了想找回来。
const FILE = file('handover.json');

export function setHandover(text) {
  if (!text || !String(text).trim()) throw new Error('text 不能为空');
  const d = readJSON(FILE, { current: null, history: [] });
  if (d.current) d.history = [d.current, ...(d.history || [])].slice(0, 5);
  d.current = { text: String(text).trim(), updated_at: now() };
  writeJSON(FILE, d);
  return d.current;
}

export function getHandover() {
  const d = readJSON(FILE, null);
  return d && d.current ? d.current : null;
}
