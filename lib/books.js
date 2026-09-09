import { addBook, getShelf, getBookContent } from './store.js';

// ---------- 章节切分 ----------
// 尽量识别常见的章节标记；识别不到就按长度粗切，不至于一整本糊在一起。
const CHAPTER_PATTERNS = [
  /^\s*(第\s*[0-9一二三四五六七八九十百千零两]+\s*[章回节卷篇])\s*[^\n]{0,40}$/,
  /^\s*(CHAPTER|Chapter)\s+([IVXLCDM]+|[0-9]+)\.?\s*[^\n]{0,60}$/,
  /^\s*(PART|Part|BOOK|Book)\s+([IVXLCDM]+|[0-9]+)\.?\s*[^\n]{0,60}$/,
  /^\s*([0-9]{1,3})\s*$/
];

const MAX_CHARS_PER_CHUNK = 12000;

export function splitIntoChapters(text) {
  const lines = text.split(/\r?\n/);
  const chapters = [];
  let current = { title: '开头', body: [] };

  for (const line of lines) {
    const isHeading = CHAPTER_PATTERNS.some(p => p.test(line)) && line.trim().length < 80;
    if (isHeading) {
      if (current.body.join('').trim().length > 200) {
        chapters.push({ title: current.title, text: current.body.join('\n').trim() });
      }
      current = { title: line.trim(), body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.join('').trim().length > 200) {
    chapters.push({ title: current.title, text: current.body.join('\n').trim() });
  }

  // 完全没识别到章节，或只切出一大块：按长度粗切
  if (chapters.length <= 1) {
    const whole = text.trim();
    const chunks = [];
    for (let i = 0; i < whole.length; i += MAX_CHARS_PER_CHUNK) {
      chunks.push({
        title: `第 ${chunks.length + 1} 部分`,
        text: whole.slice(i, i + MAX_CHARS_PER_CHUNK)
      });
    }
    return chunks.length ? chunks : [{ title: '全文', text: whole }];
  }

  // 单章过长的再拆一次
  const result = [];
  for (const ch of chapters) {
    if (ch.text.length <= MAX_CHARS_PER_CHUNK * 1.5) { result.push(ch); continue; }
    for (let i = 0; i < ch.text.length; i += MAX_CHARS_PER_CHUNK) {
      result.push({
        title: `${ch.title}（${Math.floor(i / MAX_CHARS_PER_CHUNK) + 1}）`,
        text: ch.text.slice(i, i + MAX_CHARS_PER_CHUNK)
      });
    }
  }
  return result;
}

// ---------- 古腾堡计划 ----------
export async function searchGutenberg(query) {
  const res = await fetch(`https://gutendex.com/books?search=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error('Gutendex 搜索失败: ' + res.status);
  const data = await res.json();
  return (data.results || []).slice(0, 10).map(b => ({
    gid: b.id,
    title: b.title,
    author: (b.authors && b.authors[0] && b.authors[0].name) || '未知',
    languages: b.languages,
    downloads: b.download_count,
    txtUrl: b.formats['text/plain; charset=utf-8']
         || b.formats['text/plain; charset=us-ascii']
         || b.formats['text/plain']
  })).filter(b => b.txtUrl);
}

export async function addFromGutenberg(book) {
  const res = await fetch(book.txtUrl);
  if (!res.ok) throw new Error('下载失败: ' + res.status);
  let text = await res.text();

  // 去掉古腾堡的页眉页脚
  const startMark = text.indexOf('*** START OF');
  if (startMark > -1) {
    const nl = text.indexOf('\n', startMark);
    if (nl > -1) text = text.slice(nl + 1);
  }
  const endMark = text.indexOf('*** END OF');
  if (endMark > -1) text = text.slice(0, endMark);

  const chapters = splitIntoChapters(text);
  return addBook({
    title: book.title,
    author: book.author,
    source: 'gutenberg',
    chapters
  });
}

// ---------- 文本解码：中文书常见 GBK，按 UTF-8 硬读会整本乱码 ----------
// 棋子上传的 txt 很多是 GBK/GB18030 的，以前一律 buffer.toString('utf-8')，
// 结果书架里全是"锟斤拷"。这里先看 BOM，再按严格 UTF-8 试，失败了按
// gb18030 / big5 试，挑替换字符最少的那个。
const REPL = /\uFFFD/g;
function tryDecode(buffer, enc, fatal) {
  try { return new TextDecoder(enc, { fatal: !!fatal }).decode(buffer); } catch { return null; }
}
export function decodeText(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return tryDecode(b.subarray(3), 'utf-8') || '';
  if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return tryDecode(b.subarray(2), 'utf-16le') || '';
  if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) return tryDecode(b.subarray(2), 'utf-16be') || '';
  // 严格模式：不是合法 UTF-8 就直接失败，不会悄悄给一堆替换字符
  const strict = tryDecode(b, 'utf-8', true);
  if (strict !== null) return strict;
  const cands = [];
  for (const enc of ['gb18030', 'big5', 'utf-8']) {
    const t = tryDecode(b, enc);
    if (t !== null) cands.push({ enc, t, bad: (t.match(REPL) || []).length });
  }
  if (!cands.length) return b.toString('latin1');
  cands.sort((a, x) => a.bad - x.bad);
  return cands[0].t;
}

// HTML/XML 转成纯文本：块级标签换行，剩下的标签去掉，实体还原
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '\u201c', rdquo: '\u201d', mdash: '\u2014', hellip: '\u2026' };
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

// RTF：把控制字，转义和分组符号去掉，够读就行
function rtfToText(buffer) {
  return decodeText(buffer)
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\s?\??/g, (_, n) => String.fromCharCode(((+n) + 65536) % 65536))
    .replace(/\\par[d]?\b/g, '\n').replace(/\\line\b/g, '\n')
    .replace(/\\[a-z]+-?\d*\s?/gi, '').replace(/[{}]/g, '');
}

// docx：本质是个 zip，正文在 word/document.xml。adm-zip 已经在依赖里（epub2 带的）
async function docxToText(buffer) {
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(buffer);
  const parts = [];
  for (const name of ['word/document.xml', 'word/footnotes.xml']) {
    const e = zip.getEntry(name);
    if (!e) continue;
    const xml = e.getData().toString('utf8')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:tab[^>]*\/>/g, '\t');
    parts.push(htmlToText(xml));
  }
  return parts.join('\n\n');
}

export const SUPPORTED_FORMATS = ['txt', 'md', 'markdown', 'text', 'log', 'csv', 'html', 'htm', 'xhtml', 'xml', 'rtf', 'docx', 'pdf', 'epub'];

// ---------- 上传的文件 ----------
export async function addFromUpload(buffer, filename) {
  const lower = String(filename || '').toLowerCase();
  const ext = (lower.match(/\.([a-z0-9]+)$/) || [, ''])[1];
  let text = '';

  if (ext === 'pdf') {
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(buffer);
    text = data.text;
  } else if (ext === 'epub') {
    // epub 解析失败时退回按纯文本读，避免整个上传失败
    try {
      const { EPub } = await import('epub2');
      const epub = await EPub.createAsync(buffer);
      const parts = [];
      for (const ch of epub.flow) {
        const raw = await epub.getChapterRawAsync(ch.id);
        parts.push(htmlToText(raw));
      }
      text = parts.join('\n\n');
    } catch {
      text = htmlToText(decodeText(buffer));
    }
  } else if (ext === 'docx') {
    text = await docxToText(buffer);
  } else if (ext === 'rtf') {
    text = rtfToText(buffer);
  } else if (['html', 'htm', 'xhtml', 'xml'].includes(ext)) {
    text = htmlToText(decodeText(buffer));
  } else if (ext === 'doc') {
    throw new Error('老的 .doc 格式读不了，用 Word 另存成 .docx 或 .txt 再传');
  } else {
    // txt / md / 没后缀的，都按纯文本读（自动认编码）
    text = decodeText(buffer);
  }

  text = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 100) {
    throw new Error(`没能从这个文件里读出足够的文字（只读到 ${text.length} 字）。支持的格式：${SUPPORTED_FORMATS.join(' / ')}`);
  }

  const chapters = splitIntoChapters(text);
  const title = String(filename || '').replace(/\.[a-z0-9]+$/i, '');
  return addBook({ title, author: '', source: 'upload', chapters });
}

// ---------- 体检：哪几本是当年按 UTF-8 硬读 GBK 存进来的 ----------
// 那时候非法字节已经被替换成 U+FFFD 存下去了，原始字节没留，救不回来——
// 只能标出来让棋子重新传一次。这里只看每本的前两章，不整本扫。
export function checkShelfEncoding() {
  const shelf = getShelf();
  return shelf.map(b => {
    const c = getBookContent(b.id);
    if (!c || !c.chapters || !c.chapters.length) return { id: b.id, title: b.title, ok: false, reason: '读不到正文' };
    const sample = c.chapters.slice(0, 2).map(x => x.text || '').join('').slice(0, 20000);
    const bad = (sample.match(/�/g) || []).length;
    const ratio = sample.length ? bad / sample.length : 0;
    return {
      id: b.id, title: b.title, chapters: c.chapters.length,
      bad_chars: bad, ratio: Math.round(ratio * 10000) / 100,
      ok: ratio < 0.002,
      reason: ratio < 0.002 ? '' : '当年按 UTF-8 读了 GBK 的文件，乱码已经存进去了，救不回来——重新传一次就好'
    };
  });
}
