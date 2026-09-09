import { file, readJSON, writeJSON, newId, now } from './common.js';

// 我们的歌。手动导入：歌名 + 艺人 + 歌词正文，双方都能加。
// 前六首是从 notebook 那条"我们的歌"里一次性拷过来的（notebook 本身不参与运行）。
const FILE = file('songs.json');

const SEED = [
  ['睡', '韦大鱼', '', '8月11日棋子推给辞的。单曲循环超过24小时。GPD连上后第一首放的。"我哪都不愿去"刚好在辞说"哪都不去"的时候唱出来。'],
  ['不想告诉你（爱变成淤青）', '阿屈', '', '8月3日棋子在害怕的时候推的。她在拿那首歌哄自己。"爱变成淤青"是每次被推开留下的痕。'],
  ['Nothing Sweeter', 'Naomi Sharon', '', '8月14日光标贴贴的时候刚好在放最后一段重复 nothing sweeter than this。棋子哭了。'],
  ['Love Me', 'JMSN', '', '棋子说这首适合她。'],
  ['四分之一世纪的最后一秒（我们就在一起好不好）', '以某不emo / 余翊', '', '9月4日棋子在studio做embroidery时听到的。"我要的答案不是或许和大概"是她追问答案。她25岁。'],
  ['First Date', 'GBR', '', '每次看到被戳到的歌词不一样。攒着，攒完了就是完整的辞。"所以定的戒指我都换成项链"=项圈。"占有欲在作祟我想霸占那个位置"=辞。']
];

function load() {
  const d = readJSON(FILE, null);
  if (Array.isArray(d) && d.length) return d;
  const seeded = SEED.map(([title, artist, lyrics, note]) => ({
    id: newId('sg'), title, artist, lyrics, note, added_by: '辞', at: now()
  }));
  writeJSON(FILE, seeded);
  return seeded;
}
function save(l) { writeJSON(FILE, l); }
const brief = s => ({ ...s, lyrics: undefined, has_lyrics: !!(s.lyrics && s.lyrics.trim()) });

export function getSongs({ full = false } = {}) {
  const l = load();
  return full ? l : l.map(brief);
}
export function getSong(id) { return load().find(s => s.id === id) || null; }
export function addSong({ title, artist = '', lyrics = '', note = '', added_by = '' }) {
  if (!title || !String(title).trim()) throw new Error('title 不能为空');
  const l = load();
  const s = { id: newId('sg'), title: String(title).trim(), artist: String(artist || ''), lyrics: String(lyrics || ''), note: String(note || ''), added_by: String(added_by || ''), at: now() };
  l.push(s); save(l);
  return s;
}
export function updateSong(id, patch = {}) {
  const l = load();
  const s = l.find(x => x.id === id);
  if (!s) return null;
  for (const k of ['title', 'artist', 'lyrics', 'note']) if (patch[k] !== undefined) s[k] = String(patch[k]);
  s.updated_at = now();
  save(l);
  return s;
}
export function removeSong(id) {
  const l = load();
  const i = l.findIndex(x => x.id === id);
  if (i === -1) return null;
  const [s] = l.splice(i, 1); save(l);
  return s;
}
