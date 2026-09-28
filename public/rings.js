// 木屋的聊天记录（年轮）浏览器——2026-09-28 从木纹搬过来的（木纹只管记忆，原始记录的翻和搜都在木屋）。
// 像微信"查找聊天记录"：搜索框 + 按日期查找；搜索结果逐句列出来，点进去是那一天的气泡，滚到那一句高亮。
// 依赖 muwu.js 先加载（$ / byId / sheetStack / openSheet / sheetSet / sheetLoading / sheetDrop 都是它的）。
const sheetTop = () => sheetStack[sheetStack.length - 1];
// 异步读完再填：用户这期间已经点返回或者点进别处了，就别往不属于它的那一层里写
function sheetSetIf(me, html) { if (sheetTop() === me) sheetSet(html); return sheetTop() === me; }
let sheetTouchedAt = 0;
['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach(ev => document.getElementById('sheet').addEventListener(ev, () => { sheetTouchedAt = Date.now(); }, { passive: true }));

// 首页一个搜索框 + "按日期查找"；搜索结果逐句列出来，点进去是那一天的气泡，滚到那一句高亮。
// 棋子在右、辞在左（翻记录的人是棋子，微信里自己也在右边）。
const WHO = { nor: '棋子', cy: '辞' };
let ringPrefs = null;
let rsQuery = '', rsHits = [], rsTotal = 0, rsErr = '', rsBusy = false;

function ringAvatar(who) {
  const id = ringPrefs && ringPrefs['avatar_' + who];
  if (id) return `<div class="rv-av"><img loading="lazy" src="${imageUrl(id)}" alt=""></div>`;
  return `<div class="rv-av ${who === 'nor' ? 'nor' : ''}">${who === 'cy' ? '辞' : who === 'nor' ? '棋' : '录'}</div>`;
}
function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// 转义 + 把关键词包成 <mark>
function highlight(text, kw) {
  if (!kw) return esc(text);
  const re = new RegExp(reEsc(kw), 'gi');
  let out = '', last = 0, m;
  while ((m = re.exec(text)) !== null) {
    out += esc(text.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
    if (!m[0].length) re.lastIndex++;
  }
  return out + esc(text.slice(last));
}
const slashDate = ds => `${+ds.slice(0, 4)}/${+ds.slice(5, 7)}/${+ds.slice(8, 10)}`;
const dayTitle = ds => `${+ds.slice(5, 7)}月${+ds.slice(8, 10)}日 周${WEEK[MW.dayOfWeek(ds)]}`;
const fmtLen = n => n >= 10000 ? (n / 10000).toFixed(1) + ' 万字' : n + ' 字';

async function openRings() {
  sheetLoading('聊天记录');
  const me = sheetTop();
  ringPrefs = await MW.loadPrefs().catch(() => ({}));
  if (sheetTop() !== me) return;
  renderRingHome();
  if (!rsQuery) loadRecentDays(me);
}
function renderRingHome(recentHtml) {
  const box = `<div class="search-box rs-box">
      <span style="color:var(--text-light)">🔍</span>
      <input id="rg-q" type="search" placeholder="搜索聊天记录" value="${esc(rsQuery)}" enterkeyhint="search"
        onkeydown="if(event.key==='Enter'){this.blur();ringSearch(this.value)}">
      ${rsQuery ? `<span class="rs-clear" onclick="ringSearch('')">取消</span>` : ''}
    </div>`;
  let body;
  if (rsQuery) {
    if (rsErr) body = `<div class="err">${esc(rsErr)}</div>`;
    else if (rsBusy && !rsHits.length) body = '<div class="loading">找…</div>';
    else if (!rsHits.length) body = `<div class="empty">没找到「${esc(rsQuery)}」</div>`;
    else {
      body = `<div class="rs-count">共 ${rsTotal} 处</div>` + rsHits.map(hitRow).join('') +
        (rsHits.length < rsTotal ? `<button class="btn ghost rs-more" onclick="ringSearch(rsQuery, true)"${rsBusy ? ' disabled' : ''}>${rsBusy ? '读取中…' : `再看 ${Math.min(60, rsTotal - rsHits.length)} 处`}</button>` : '');
    }
  } else {
    body = `<div class="rs-entry-title">查找聊天内容</div>
      <div class="rs-entry">
        <span onclick="openRingCalendar()">日期</span>
        <span onclick="openRingDay(MW.today())">今天</span>
        <span onclick="openRingList()">按条目</span>
      </div>
      <div class="section-title">最近聊过的日子</div>
      <div id="rg-recent">${recentHtml || '<div class="loading">…</div>'}</div>`;
  }
  sheetSet(box + body);
}
async function loadRecentDays(me) {
  try {
    const cd = await rest('/api/rings/chat-dates');
    const days = Object.keys(cd.dates).sort().reverse().slice(0, 10);
    const html = days.length ? days.map(ds => `<div class="entry rs-day" onclick="openRingDay('${ds}')">
        <span>${dayTitle(ds)}</span><span>${cd.dates[ds].count} 段 · ${fmtLen(cd.dates[ds].chars)}</span></div>`).join('')
      : '<div class="empty">还没有聊天记录</div>';
    if (sheetTop() === me && !rsQuery) renderRingHome(html);
  } catch (e) { if (sheetTop() === me && !rsQuery) renderRingHome(`<div class="err">${esc(e.message)}</div>`); }
}
function hitRow(h, i) {
  const who = h.speaker || '';
  const name = who ? WHO[who] : (h.window_name || '记录');
  // 微信的做法：关键词尽量靠前，前面只留一小截
  let before = oneLine(h.before);
  if (before.length > 14) before = '…' + before.slice(-14).replace(/^…/, '');
  return `<div class="rs-row" onclick="openRingHit(${i})">
    ${ringAvatar(who)}
    <div class="rs-main">
      <div class="rs-top"><span>${esc(name)}${h.in_thinking ? '<em>思考 / 工具里</em>' : ''}</span><span>${slashDate(h.date)}${h.time ? ' ' + esc(h.time) : ''}</span></div>
      <div class="rs-snip">${esc(before)}<mark>${esc(h.match)}</mark>${esc(oneLine(h.after))}</div>
    </div></div>`;
}
async function ringSearch(q, more) {
  q = String(q || '').trim();
  if (!more) { rsQuery = q; rsHits = []; rsTotal = 0; rsErr = ''; }
  const me = sheetTop();
  if (!q) { renderRingHome(); loadRecentDays(me); return; }
  rsBusy = true; renderRingHome();
  try {
    const r = await rest(`/api/rings/search?q=${encodeURIComponent(q)}&skip=${rsHits.length}&limit=60`);
    if (rsQuery !== q) return;
    rsHits = rsHits.concat(r.hits); rsTotal = r.total;
  } catch (e) { rsErr = e.message; }
  rsBusy = false;
  if (sheetTop() === me) renderRingHome();
}
function openRingHit(i) {
  const h = rsHits[i]; if (!h) return;
  openRingDay(h.date, { ring: h.ring_id, offset: h.offset, kw: rsQuery });
}

// 按日期查找：从第一条记录那个月一直排到这个月，竖着滚；有记录的日子是深色能点，没有的灰掉
async function openRingCalendar() {
  sheetLoading('按日期查找');
  const me = sheetTop();
  try {
    const cd = await rest('/api/rings/chat-dates');
    if (!cd.first) return sheetSetIf(me, '<div class="empty">还没有聊天记录</div>');
    const t = today();
    let y = +cd.first.slice(0, 4), mo = +cd.first.slice(5, 7);
    const endY = +t.slice(0, 4), endM = +t.slice(5, 7);
    let h = `<div class="rc-week">${WEEK.map(w => `<span>${w}</span>`).join('')}</div>`, first = true;
    while (y < endY || (y === endY && mo <= endM)) {
      const ym = `${y}-${String(mo).padStart(2, '0')}`;
      const lead = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
      const len = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      h += `<div class="rc-month">${first || mo === 1 ? `${y}年${mo}月` : `${mo}月`}</div><div class="rc-grid">`;
      for (let i = 0; i < lead; i++) h += '<span></span>';
      for (let d = 1; d <= len; d++) {
        const ds = `${ym}-${String(d).padStart(2, '0')}`;
        if (ds > t) break; // 跟微信一样排到今天为止
        const info = cd.dates[ds];
        h += `<span class="rc-d${info ? ' has' : ''}${ds === t ? ' today' : ''}"${info ? ` onclick="openRingDay('${ds}')" title="${info.count} 段 · ${fmtLen(info.chars)}"` : ''}><b>${d}</b>${ds === t ? '<i>今天</i>' : ''}</span>`;
      }
      h += '</div>';
      first = false; if (++mo > 12) { mo = 1; y++; }
    }
    if (sheetSetIf(me, h)) {
      // 跟微信一样一打开就在最近这个月
      const sh = $('#sheet'); sh.scrollTop = sh.scrollHeight; me.scroll = sh.scrollTop;
    }
  } catch (e) { sheetSetIf(me, `<div class="err">${esc(e.message)}</div>`); }
}

// 某一天的完整对话，气泡
async function openRingDay(date, target) {
  sheetLoading(dayTitle(date));
  const me = sheetTop();
  try {
    if (!ringPrefs) ringPrefs = await MW.loadPrefs().catch(() => ({}));
    const d = await rest('/api/rings/day?date=' + encodeURIComponent(date));
    if (!sheetSetIf(me, renderDay(d, target))) return;
    const t = byId('rv-target');
    if (t) {
      // 气泡用了 content-visibility，上面没画出来的高度是估的；画完再对一次位置
      const t0 = Date.now();
      t.scrollIntoView({ block: 'center' });
      // 这 250ms 里用户要是已经自己动手滑了，就别再把人拽回去（以前"页面自己跳"有一部分是这个）
      setTimeout(() => { if (sheetTop() === me && sheetTouchedAt < t0) { t.scrollIntoView({ block: 'center' }); me.scroll = $('#sheet').scrollTop; } }, 250);
    }
  } catch (e) { sheetSetIf(me, `<div class="err">${esc(e.message)}</div>`); }
}
function reopenRingDay(date) { sheetDrop(); openRingDay(date); }

function renderDay(d, target) {
  const kw = target && target.kw;
  let h = '';
  if (d.daily) {
    h += `<div class="rv-daily"><span class="summary-label">这天的总结</span><div>${esc(d.daily.headline)}</div>
      ${(d.daily.mood_tags || []).length ? `<div>${d.daily.mood_tags.map(t => `<span class="tag plain">${esc(t)}</span>`).join('')}</div>` : ''}</div>`;
  }
  if (!d.rings.length) {
    return h + `<div class="empty">这天没有聊天记录</div>` + dayNav(d);
  }
  // 同一系列（被切成 1/15、2/15…）只在第一段前面放一次分隔标题
  const seriesLen = {};
  d.rings.forEach(r => { seriesLen[r.series] = (seriesLen[r.series] || 0) + r.length; });
  const heads = [];
  let body = '', lastSpeaker = null, lastTime = '', found = false;
  d.rings.forEach((r, ri) => {
    const isTargetRing = target && target.ring === r.id;
    if (!r.continued) {
      heads.push({ i: ri, name: r.series || r.window_name || '记录' });
      body += `<div class="rv-sep" id="rv-s-${ri}"><span>${esc(r.series || r.window_name || '记录')} · ${fmtLen(seriesLen[r.series] || r.length)}</span></div>`;
      lastTime = '';
    }
    if (r.document != null) {
      const hit = isTargetRing && !found; if (hit) found = true;
      body += `<div class="rv-doc${hit ? ' target' : ''}"${hit ? ' id="rv-target"' : ''}>${hit ? highlight(r.document, kw) : esc(r.document)}</div>`;
      return;
    }
    if (r.preamble) {
      const hit = isTargetRing && !found && target.offset < r.preamble_end; if (hit) found = true;
      const txt = hit ? highlight(r.preamble, kw) : esc(r.preamble);
      // 被切断的上一句的后半截，接着用上一句的说话人
      if (r.continued && lastSpeaker) body += bubbleRow(lastSpeaker, [{ type: 'text', html: txt, len: r.preamble.length }], hit);
      else body += `<div class="rv-note${hit ? ' target' : ''}"${hit ? ' id="rv-target"' : ''}>${txt}</div>`;
    }
    for (const m of r.messages) {
      if (m.time && m.time !== lastTime && minutesApart(lastTime, m.time) >= 5) body += `<div class="rv-time">${esc(m.time)}</div>`;
      if (m.time) lastTime = m.time;
      const hit = isTargetRing && !found && target.offset >= m.start && target.offset < m.end; if (hit) found = true;
      body += bubbleRow(m.speaker, m.parts.map(p => ({ type: p.type, len: p.content.length, raw: p.content, html: p.type === 'tool' ? esc(p.content) : hit ? highlight(p.content, kw) : null })), hit, kw);
      lastSpeaker = m.speaker;
    }
  });
  if (heads.length > 1) {
    h += `<div class="chip-row rv-jump">${heads.map(x => `<div class="chip" onclick="byId('rv-s-${x.i}').scrollIntoView({block:'start'})">${esc(x.name.length > 16 ? x.name.slice(0, 16) + '…' : x.name)}</div>`).join('')}</div>`;
  }
  return h + `<div class="rv-list">${body}</div>` + dayNav(d);
}
function minutesApart(a, b) {
  if (!a || !b) return Infinity;
  const toM = s => +s.slice(0, 2) * 60 + +s.slice(3, 5);
  return Math.abs(toM(b) - toM(a));
}
function dayNav(d) {
  return `<div class="rv-nav">
    ${d.prev_date ? `<button class="btn ghost" onclick="reopenRingDay('${d.prev_date}')">‹ ${+d.prev_date.slice(5, 7)}月${+d.prev_date.slice(8, 10)}日</button>` : '<span></span>'}
    ${d.next_date ? `<button class="btn ghost" onclick="reopenRingDay('${d.next_date}')">${+d.next_date.slice(5, 7)}月${+d.next_date.slice(8, 10)}日 ›</button>` : '<span></span>'}
  </div>`;
}
const LONG_BUBBLE = 1800;
function bubbleRow(speaker, parts, isTarget, kw) {
  const lkw = kw ? kw.toLowerCase() : '';
  let inner = '';
  for (const p of parts) {
    const html = p.html != null ? p.html : esc(p.raw);
    if (p.type === 'text') {
      const long = p.len > LONG_BUBBLE && !isTarget;
      inner += `<div class="rv-bubble${long ? ' long' : ''}">${html}${long ? `<button class="rv-more" onclick="this.parentNode.classList.remove('long');this.remove()">展开全文 · ${fmtLen(p.len)}</button>` : ''}</div>`;
    } else if (p.type === 'think' || p.type === 'result') {
      const open = isTarget && lkw && (p.raw || '').toLowerCase().includes(lkw);
      const label = p.type === 'think' ? '思考过程' : `工具返回 · ${fmtLen(p.len)}`;
      inner += `<div class="rv-fold ${p.type}${open ? ' open' : ''}"><button onclick="this.parentNode.classList.toggle('open')"><span>▸</span>${label}</button><div class="rv-fold-body">${html}</div></div>`;
    } else if (p.type === 'tool') {
      inner += `<div class="rv-tool">调用 ${html}</div>`;
    }
  }
  return `<div class="rv-row${speaker === 'nor' ? ' me' : ''}"${isTarget ? ' id="rv-target"' : ''}>${ringAvatar(speaker)}<div class="rv-col${isTarget ? ' target' : ''}">${inner}</div></div>`;
}

// 旧的"按条目翻"留着：想看某一条原文（含每日总结）还是从这里进
async function openRingList() {
  sheetLoading('按条目');
  const me = sheetTop();
  try {
    const days = await mcp('rings_by_date', { limit: 2000 });
    sheetSetIf(me, days.length ? days.map(d => `<div class="section-title">${esc(d.date)} <span class="link" onclick="openRingDay('${d.date}')">看气泡</span></div>
      ${d.items.map(i => `<div class="entry" onclick="openRing('${i.id}')">
        <div class="entry-head"><span>${esc(i.window_name || i.title || '未命名')}</span><span>${fmtLen(i.length)}</span>${i.source_type === 'daily_summary' ? '<span class="tag plain">每日总结</span>' : ''}</div></div>`).join('')}`).join('')
      : '<div class="empty">还没有记录</div>');
  } catch (e) { sheetSetIf(me, `<div class="err">${esc(e.message)}</div>`); }
}

async function openRing(id, offset, kw) {
  sheetLoading('原文');
  try {
    const r = await mcp('get_ring', { id });
    const content = r.content || '';
    let body;
    if (kw) {
      // 把所有出现处都高亮；定位的那一处单独标出来，等下滚过去
      const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      let last = 0, out = '', m;
      while ((m = re.exec(content)) !== null) {
        out += esc(content.slice(last, m.index));
        const isTarget = offset != null && Math.abs(m.index - offset) < 2;
        out += `<mark${isTarget ? ' id="rg-target" class="target"' : ''}>${esc(m[0])}</mark>`;
        last = m.index + m[0].length;
      }
      out += esc(content.slice(last));
      body = out;
    } else body = esc(content);
    sheetSet(`${r.source_type !== 'daily_summary' ? `<div class="card tap" onclick="openRingDay('${esc(r.date)}', { ring: '${r.id}', offset: ${offset == null ? 0 : Number(offset)}, kw: ${kw ? `'${esc(kw).replace(/'/g, '&#39;')}'` : 'null'} })"><div class="card-title">💬 用聊天气泡看这天</div></div>` : ''}
      <div class="entry"><div class="entry-head"><span>${esc(r.date)}</span><span>${esc(r.window_name || '')}</span><span>${content.length} 字</span></div>
      ${r.title ? `<div class="card-title" style="margin-bottom:6px">${esc(r.title)}</div>` : ''}
      <div class="entry-body">${body}</div></div>`);
    const t = byId('rg-target');
    if (t) { const t0 = Date.now(); setTimeout(() => { if (sheetTouchedAt < t0) t.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 60); }
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
