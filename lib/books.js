import { addBook } from './store.js';

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

// ---------- 上传的文件 ----------
export async function addFromUpload(buffer, filename) {
  const lower = filename.toLowerCase();
  let text = '';

  if (lower.endsWith('.pdf')) {
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(buffer);
    text = data.text;
  } else if (lower.endsWith('.epub')) {
    // epub 解析失败时退回按纯文本读，避免整个上传失败
    try {
      const { EPub } = await import('epub2');
      const epub = await EPub.createAsync(buffer);
      const parts = [];
      for (const ch of epub.flow) {
        const raw = await epub.getChapterRawAsync(ch.id);
        parts.push(raw.replace(/<[^>]+>/g, '\n'));
      }
      text = parts.join('\n\n');
    } catch {
      text = buffer.toString('utf-8').replace(/<[^>]+>/g, '\n');
    }
  } else {
    text = buffer.toString('utf-8');
  }

  text = text.replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 100) throw new Error('没能从这个文件里读出足够的文字');

  const chapters = splitIntoChapters(text);
  const title = filename.replace(/\.(txt|pdf|epub)$/i, '');
  return addBook({ title, author: '', source: 'upload', chapters });
}
