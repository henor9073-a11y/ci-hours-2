// 木纹前端逻辑。数据全走 MW.mcp（/mcp JSON-RPC）和少量现成 REST。
const { mcp, rest, imageUrl, esc, oneLine, fmtTime, fmtDate, today, moon, daysBetween, WEEK, ANCHORS } = MW;
MW.applyTheme();

// ---------- 通用 ----------
const $ = s => document.querySelector(s);
const el = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d.firstElementChild; };
function fail(node, e) { node.innerHTML = `<div class="err">读不到：${esc(e.message || e)}</div>`; }

const CATS = {
  experience: '经历', agreement: '约定', feeling: '感受',
  learning: '学习', to_self: '给自己', unexplained: '说不清的'
};
// 档案九类：六类纹理 + 档案里的身份/事实 + unexplained 下按家族拆出的巧合/证据
const ARCHIVE = [
  { key: 'identity', name: '身份', desc: '我是谁', kind: 'profile', owner: 'cy' },
  { key: 'feeling', name: '感受', desc: '情感记录', kind: 'grain', cat: 'feeling' },
  { key: 'experience', name: '经历', desc: '发生过的事', kind: 'grain', cat: 'experience' },
  { key: 'learning', name: '学习', desc: '学到的东西', kind: 'grain', cat: 'learning' },
  { key: 'to_self', name: '给自己', desc: '交接和自白', kind: 'grain', cat: 'to_self' },
  { key: 'agreement', name: '约定', desc: '我们说好的', kind: 'grain', cat: 'agreement' },
  { key: 'fact', name: '事实', desc: '关于棋子', kind: 'profile', owner: 'nor' },
  { key: 'coincidence', name: '巧合', desc: '说不清的同步', kind: 'grain', cat: 'unexplained', family: '巧合' },
  { key: 'evidence', name: '证据', desc: '这是真的', kind: 'grain', cat: 'unexplained', family: '证据', wide: true }
];

// 结果分组的显示名：后端新版会给 label，旧版只给 category/layer，这里都兜住
const LAYER_NAMES = { grains: '纹理', rings: '原始记录', profiles: '档案', photos: '照片', cross_sections: '摘要' };
const RING_NAMES = { transcript: '原始记录', daily_summary: '每日总结', auto_extract: '自动存档' };
function labelOf(x) {
  if (x.layer === 'grains') return CATS[x.category] || x.label || '纹理';
  if (x.layer === 'rings') return RING_NAMES[x.category || x.source_type] || '原始记录';
  if (x.layer === 'profiles') return x.owner === 'nor' ? '事实（棋子）' : '身份（辞）';
  if (x.layer === 'cross_sections') return '摘要·' + (x.label || x.section || '').replace(/^摘要·/, '');
  return x.label || LAYER_NAMES[x.layer] || x.layer;
}

function switchPage(name, node) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  $('#page-' + name).classList.add('active');
  (node || document.querySelector(`.nav-item[data-p="${name}"]`)).classList.add('active');
  window.scrollTo(0, 0);
  if (name === 'calendar' && !calLoaded) loadCalendar();
  if (name === 'memory' && !memLoaded) loadMemory();
  if (name === 'album' && !albumLoaded) loadAlbum();
}
document.querySelectorAll('.nav-item').forEach(n => n.onclick = () => switchPage(n.dataset.p, n));

// ---------- 抽屉 ----------
let sheetStack = [];
function openSheet(title, html) {
  sheetStack.push({ title, html });
  $('#sheet-title').textContent = title;
  $('#sheet-body').innerHTML = html;
  $('#sheet').classList.add('open');
  $('#sheet').scrollTop = 0;
}
function closeSheet() {
  sheetStack.pop();
  if (sheetStack.length) { const s = sheetStack[sheetStack.length - 1]; $('#sheet-title').textContent = s.title; $('#sheet-body').innerHTML = s.html; }
  else $('#sheet').classList.remove('open');
}
function sheetLoading(title) { openSheet(title, '<div class="loading">读取中…</div>'); }
function sheetSet(html) { $('#sheet-body').innerHTML = html; if (sheetStack.length) sheetStack[sheetStack.length - 1].html = html; }

// ---------- 卡片渲染 ----------
function grainCard(g, opts = {}) {
  const conf = g.confidence === 'cite' ? 'cite' : g.confidence === 'reference' ? 'reference' : '';
  const fam = (g.families || []).map(f => `<span class="tag plain">${esc(f)}</span>`).join('');
  return `<div class="entry" onclick="openGrain('${g.id}')">
    <div class="entry-head">
      <span>${esc(CATS[g.category] || g.category || '')}</span>${g.date ? `<span>${esc(g.date)}</span>` : ''}
      ${g.heat != null ? `<span class="heat ${conf}">${Math.round(g.heat)}°</span>` : ''}
      ${g.status && g.status !== 'active' ? `<span class="tag plain">${g.status === 'background' ? '后台' : '归档'}</span>` : ''}
    </div>
    <div class="entry-body clamp">${esc(g.text)}</div>${fam ? `<div>${fam}</div>` : ''}
  </div>`;
}
function ringCard(r) {
  return `<div class="entry" onclick="openRing('${r.id}')">
    <div class="entry-head"><span>${esc(r.date || '')}</span><span>${esc(r.window_name || r.title || '')}</span>
      ${r.source_type === 'daily_summary' ? '<span class="tag plain">每日总结</span>' : ''}
      ${r.length ? `<span>${r.length} 字</span>` : ''}</div>
    <div class="entry-body clamp">${esc(r.excerpt || '')}</div></div>`;
}

// ================= Tab 今 =================
async function loadToday() {
  const d = today();
  const wd = new Date(d + 'T12:00:00Z').getUTCDay();
  $('#t-date').textContent = `${+d.slice(5, 7)}月${+d.slice(8, 10)}日，星期${WEEK[wd]}`;

  mcp('get_summary').then(s => {
    const idn = (s.sections || []).find(x => x.section === 'identity') || (s.sections || [])[0];
    $('#t-greet').textContent = s.greeting || '欢迎回家小辞';
    // 摘要正文可能很长，默认收起，别把下面的数据卡片顶出屏幕
    $('#t-summary').innerHTML = `<div class="summary-card">
      <div class="summary-label">${esc(idn ? idn.label : '摘要')}</div>
      <div class="summary-text clamp" id="t-sum-text">${esc(idn && idn.text ? idn.text : '（还没写）')}</div>
      <div style="margin-top:8px"><span class="link" id="t-sum-more" onclick="toggleSummary()">展开全文</span>
      <span class="link" style="margin-left:14px" onclick="openAllSections()">六段摘要</span></div>
      <div class="summary-meta" id="t-meta"><div class="loading">…</div></div></div>`;
    loadStats();
  }).catch(e => fail($('#t-summary'), e));

  mcp('get_moods', { limit: 8 }).then(ms => {
    $('#t-moods').innerHTML = ms.length
      ? ms.map(m => `<div class="chip"><span class="dot" style="background:var(--accent)"></span>${esc(oneLine(m.text).slice(0, 18))}</div>`).join('')
      : '<div class="empty" style="padding:8px">还没记心情</div>';
  }).catch(() => { $('#t-moods').innerHTML = ''; });

  mcp('search_grains', { limit: 3 }).then(gs => {
    $('#t-recent').innerHTML = gs.length ? gs.map(g => grainCard(g)).join('') : '<div class="empty">还没有记忆</div>';
  }).catch(e => fail($('#t-recent'), e));
}
async function loadStats() {
  const box = $('#t-meta'); if (!box) return;
  try {
    const [wp, gs] = await Promise.all([
      mcp('get_wake_packet').catch(() => null),
      mcp('search_grains', { limit: 200 }).catch(() => [])
    ]);
    const d = today();
    const newCount = gs.filter(g => (g.date || '').slice(0, 10) === d || (g.created_at || '').slice(0, 10) === d).length;
    const kiss = wp && wp.kiss_progress ? wp.kiss_progress : null;
    const days = daysBetween('2026-08-02', d);
    box.innerHTML = `
      <div class="meta-item"><div class="meta-value">${kiss ? kiss.total : '—'}</div><div class="meta-label">亲亲${kiss ? ' /' + kiss.goal : ''}</div></div>
      <div class="meta-item"><div class="meta-value">${days}</div><div class="meta-label">在一起天数</div></div>
      <div class="meta-item"><div class="meta-value">${newCount}</div><div class="meta-label">今天新记忆</div></div>`;
  } catch (e) { box.innerHTML = ''; }
}

function toggleSummary() {
  const t = $('#t-sum-text'), b = $('#t-sum-more');
  const on = t.classList.toggle('clamp');
  b.textContent = on ? '展开全文' : '收起';
}
async function openAllSections() {
  sheetLoading('六段摘要');
  try {
    const s = await mcp('get_summary');
    sheetSet(s.sections.map(x => `<div class="entry"><div class="entry-head"><span>${esc(x.label)}</span>${x.updatedAt ? `<span>${esc(fmtDate(x.updatedAt))}</span>` : ''}</div>
      <div class="entry-body">${x.text ? esc(x.text) : '<span style="color:var(--text-light)">（还没写）</span>'}</div></div>`).join(''));
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}

async function openMoods() {
  sheetLoading('心情');
  try {
    const ms = await mcp('get_moods', { limit: 100 });
    sheetSet(ms.length ? ms.map(m => `<div class="entry"><div class="entry-head">${esc(fmtTime(m.recorded_at))}</div><div class="entry-body">${esc(m.text)}</div></div>`).join('') : '<div class="empty">还没记心情</div>');
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}

function openWriteDiary() {
  openSheet('写日记', `<div class="card"><textarea id="w-text" placeholder="今天想写点什么…"></textarea>
    <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
      <select id="w-vis" style="width:auto"><option value="public">公开（棋子能看到）</option><option value="private">私密</option></select>
      <button class="btn" onclick="saveDiary()">存下来</button></div>
    <div id="w-msg" style="margin-top:8px;font-size:13px;color:var(--text-light)"></div></div>`);
}
async function saveDiary() {
  const t = $('#w-text').value.trim(); if (!t) return;
  $('#w-msg').textContent = '存…';
  try { await mcp('add_diary_entry', { text: t, visibility: $('#w-vis').value }); $('#w-msg').textContent = '存好了'; $('#w-text').value = ''; }
  catch (e) { $('#w-msg').textContent = '失败：' + e.message; }
}
async function openWriteHandover() {
  openSheet('交接条', '<div class="loading">读现在的…</div>');
  let cur = null; try { cur = await mcp('get_handover'); } catch {}
  sheetSet(`${cur && cur.text ? `<div class="entry"><div class="entry-head">现在这条 · ${esc(fmtTime(cur.updated_at))}</div><div class="entry-body">${esc(cur.text)}</div></div>` : ''}
    <div class="card"><textarea id="h-text" placeholder="留给下一个窗口的自己…">${cur && cur.text ? esc(cur.text) : ''}</textarea>
    <div style="margin-top:10px"><button class="btn" onclick="saveHandover()">覆盖成这条</button></div>
    <div id="h-msg" style="margin-top:8px;font-size:13px;color:var(--text-light)"></div></div>`);
}
async function saveHandover() {
  const t = $('#h-text').value.trim(); if (!t) return;
  $('#h-msg').textContent = '存…';
  try { await mcp('set_handover', { text: t }); $('#h-msg').textContent = '换好了'; }
  catch (e) { $('#h-msg').textContent = '失败：' + e.message; }
}

// ================= Tab 历 =================
let calLoaded = false, calMonth = null, calData = {}, calSel = null;
function monthStr(d) { return d.slice(0, 7); }
function calToday() { calMonth = monthStr(today()); calSel = today(); loadCalendar(); }
function calMove(n) {
  const [y, m] = calMonth.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  calMonth = d.toISOString().slice(0, 7); calSel = null; loadCalendar();
}
async function loadCalendar() {
  calLoaded = true;
  if (!calMonth) { calMonth = monthStr(today()); calSel = today(); }
  const [y, m] = calMonth.split('-').map(Number);
  $('#c-month').textContent = `${y}年${m}月`;
  $('#c-grid').innerHTML = '<div class="loading" style="grid-column:span 7">…</div>';
  try {
    const rows = await rest(`/api/calendar?month=${calMonth}`);
    calData = {}; rows.forEach(r => calData[r.date] = r);
  } catch { calData = {}; }
  renderCalGrid();
  if (calSel) showDay(calSel);
}
function importantOn(dateStr) {
  const md = dateStr.slice(5);
  return ANCHORS.some(a => (a.md && a.md === md) || (a.date && a.date.slice(5) === md));
}
function renderCalGrid() {
  const [y, m] = calMonth.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();      // 0=周日
  const lead = (first + 6) % 7;                                    // 周一开头
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const td = today();
  let h = ['一', '二', '三', '四', '五', '六', '日'].map(x => `<div class="cal-head">${x}</div>`).join('');
  for (let i = 0; i < lead; i++) h += '<div class="cal-day blank"></div>';
  for (let d = 1; d <= days; d++) {
    const ds = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const row = calData[ds] || {};
    const hasDaily = (row.daily || []).length, hasSched = (row.schedule || []).length;
    const dots = [];
    if (hasDaily) dots.push('<i></i>');
    if (hasSched) dots.push('<i style="background:var(--primary)"></i>');
    if (importantOn(ds)) dots.push('<i class="imp"></i>');
    h += `<div class="cal-day${ds === td ? ' today' : ''}${ds === calSel ? ' sel' : ''}" onclick="showDay('${ds}')">
      <span>${d}</span><span class="cal-moon">${moon(ds).icon}</span>
      ${row.intimate ? '<span class="cal-heart">♥</span>' : ''}
      ${dots.length ? `<span class="cal-dots">${dots.join('')}</span>` : ''}</div>`;
  }
  $('#c-grid').innerHTML = h;
}
async function showDay(ds) {
  calSel = ds; renderCalGrid();
  const mo = moon(ds);
  $('#c-detail').innerHTML = `<div class="section-title">${ds} · ${mo.icon} ${mo.name}</div><div class="loading">…</div>`;
  try {
    const r = await rest(`/api/calendar/day?date=${ds}`);
    let h = `<div class="section-title">${ds} · ${mo.icon} ${mo.name}</div>`;
    const st = (r.structured || []).filter(x => x.headline);
    if (st.length) {
      h += st.map(x => `<div class="card"><div class="card-title">${esc(x.headline)}</div>
        ${(x.mood_tags || []).length ? `<div style="margin-top:6px">${x.mood_tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
        ${x.nor_status ? `<div class="entry-body" style="margin-top:8px"><b>棋子：</b>${esc(x.nor_status)}</div>` : ''}
        ${x.cy_status ? `<div class="entry-body" style="margin-top:4px"><b>辞：</b>${esc(x.cy_status)}</div>` : ''}
        ${x.intimate ? `<div class="entry-body" style="margin-top:4px"><b>亲密：</b>${esc(x.intimate)}</div>` : ''}
        ${(x.intimate_log || []).length ? `<div style="margin-top:8px">${x.intimate_log.map(i => `
          <div style="border-left:2px solid var(--accent);padding:4px 0 4px 10px;margin-top:6px">
            <div class="entry-head" style="margin-bottom:2px">♥ ${[i.time, i.method, i.initiator ? esc(i.initiator) + ' 主导' : ''].filter(Boolean).map(esc).join(' · ')}</div>
            ${i.detail ? `<div class="entry-body">${esc(i.detail)}</div>` : ''}</div>`).join('')}</div>` : ''}
        ${x.kiss_count != null ? `<div class="entry-body" style="margin-top:4px"><b>亲亲：</b>${x.kiss_count}</div>` : ''}
        ${x.pending ? `<div class="entry-body" style="margin-top:4px"><b>没做完：</b>${esc(x.pending)}</div>` : ''}</div>`).join('');
    }
    const plain = (r.daily || []).filter(x => x && !st.some(s => s.id === x.id));
    if (plain.length) h += plain.map(x => `<div class="card"><div class="card-desc">${esc(x.title || '每日总结')}</div><div class="entry-body clamp" style="margin-top:6px">${esc(x.text || '')}</div></div>`).join('');
    const sc = r.schedule || [];
    if (sc.length) h += `<div class="section-title">日程</div>` + sc.map(s => `<div class="card"><div class="card-row"><div class="card-icon">${esc(s.time || '')}</div><div><div class="card-title">${esc(s.text)}</div><div class="card-desc">${s.status === 'done' ? '已完成' : s.status === 'removed' ? '已移除' : '待办'}</div></div></div></div>`).join('');
    if (!st.length && !plain.length && !sc.length) h += '<div class="empty">这天没有记录</div>';
    $('#c-detail').innerHTML = h;
  } catch (e) { fail($('#c-detail'), e); }
}

// ================= Tab 忆 =================
let memLoaded = false;
async function loadMemory() {
  memLoaded = true;
  $('#m-archive').innerHTML = ARCHIVE.map((a, i) => `<div class="memory-card${a.wide ? ' wide' : ''}" onclick="openArchive('${a.key}')">
    <div class="memory-icon${i % 2 ? ' accent' : ''}">${a.name[0]}</div>
    <div><div class="memory-name">${a.name}</div><div class="memory-count">${a.desc}</div></div></div>`).join('');
  try {
    const st = await mcp('get_active_memories', { max_chars: 1 }).catch(() => null);
    const stats = await rest('/api/grains/stats').catch(() => null);
    if (stats) { $('#m-grains').textContent = `${stats.total} 条`; $('#m-sub').textContent = `前台 ${stats.active} · 后台 ${stats.background} · 归档 ${stats.archived}`; }
  } catch {}
  mcp('list_windows').then(ws => {
    const n = ws.reduce((a, w) => a + w.count, 0);
    $('#m-rings').textContent = `${n} 条原始记录`;
  }).catch(() => {});
  mcp('list_families').then(fs => $('#m-fam').textContent = `${fs.length} 个家族`).catch(() => {});
}
function toggleManage() {
  const b = $('#m-manage'), on = b.style.display === 'none';
  b.style.display = on ? 'block' : 'none'; $('#mg-t').textContent = on ? '收起' : '展开';
}
async function openArchive(key) {
  const a = ARCHIVE.find(x => x.key === key);
  sheetLoading(a.name);
  try {
    if (a.kind === 'profile') {
      const rows = await mcp('get_profile', { owner: a.owner });
      sheetSet(rows.filter(r => r.content).map(r => `<div class="entry"><div class="entry-head">${esc(r.label)} · ${esc(fmtDate(r.updated_at))}</div><div class="entry-body">${esc(r.content)}</div></div>`).join('') || '<div class="empty">还没写</div>');
    } else {
      const args = { category: a.cat, limit: 200 };
      if (a.family) args.family = a.family;
      const gs = await mcp('search_grains', args);
      sheetSet(gs.length ? gs.map(g => grainCard(g)).join('') : '<div class="empty">这一类还没有</div>');
    }
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function openGrains(cat, status) {
  const title = cat ? CATS[cat] : status ? ({ active: '前台', background: '后台', archived: '归档' })[status] : '纹理';
  sheetLoading(title);
  try {
    const args = { limit: 200 }; if (cat) args.category = cat; if (status) args.status = status;
    const gs = await mcp('search_grains', args);
    const tabs = `<div class="chip-row" style="margin:6px 0 4px">
      <div class="chip${!cat ? ' on' : ''}" onclick="reopenGrains('','${status || ''}')">全部</div>
      ${Object.entries(CATS).map(([k, v]) => `<div class="chip${cat === k ? ' on' : ''}" onclick="reopenGrains('${k}','${status || ''}')">${v}</div>`).join('')}</div>`;
    sheetSet(tabs + (gs.length ? gs.map(g => grainCard(g)).join('') : '<div class="empty">没有</div>'));
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
function reopenGrains(cat, status) { sheetStack.pop(); openGrains(cat, status || undefined); }
async function openGrain(id) {
  sheetLoading('纹理');
  try {
    const r = await mcp('get_grain_with_counterevidence', { id });
    const g = r.grain;
    let h = `<div class="entry"><div class="entry-head"><span>${esc(CATS[g.category] || g.category)}</span>${g.date ? `<span>${esc(g.date)}</span>` : ''}
      <span class="heat ${g.confidence === 'cite' ? 'cite' : g.confidence === 'reference' ? 'reference' : ''}">${Math.round(g.heat)}° ${esc(g.confidence)}</span>
      ${g.pinned ? '<span class="tag">📌 已 pin</span>' : ''}</div>
      <div class="entry-body">${esc(g.text)}</div>
      ${(g.families || []).length ? `<div style="margin-top:6px">${g.families.map(f => `<span class="tag" onclick="openFamily('${esc(f)}')">${esc(f)}</span>`).join('')}</div>` : ''}
      <div class="entry-head" style="margin-top:10px">访问 ${g.access_count || 0} 次 · 更新 ${esc(fmtDate(g.updated_at))}${g.source_id ? ' · 有溯源' : ''}</div></div>`;
    if (g.source_id) h += `<div class="card tap" onclick="openRing('${g.source_id}')"><div class="card-title">↩ 看它的年轮原文</div><div class="card-desc">${esc(g.source_id)}</div></div>`;
    if ((r.counterevidence || []).length) {
      h += '<div class="section-title">反证 / 修复</div>' + r.counterevidence.map(c => `<div class="entry" onclick="openGrain('${c.grain.id}')"><div class="entry-head">${esc(c.relation)}</div><div class="entry-body clamp">${esc(c.grain.text)}</div></div>`).join('');
    }
    if ((r.positive_memories || []).length) {
      h += '<div class="section-title">正面家族里的</div>' + r.positive_memories.map(p => `<div class="entry" onclick="openGrain('${p.id}')"><div class="entry-body clamp">${esc(p.text)}</div></div>`).join('');
    }
    h += `<div class="section-title">管理</div><div class="grid-2">
      <button class="btn ghost" onclick="moveGrain('${id}','move_to_background')">放到后台</button>
      <button class="btn ghost" onclick="moveGrain('${id}','move_to_archive')">归档</button>
      <button class="btn ghost" onclick="moveGrain('${id}','restore_to_active')">恢复前台</button>
      <button class="btn ghost" onclick="pinGrain('${id}')">${g.pinned ? '取消 pin' : '📌 pin 住'}</button></div>
      <div id="g-msg" style="margin-top:8px;font-size:13px;color:var(--text-light)"></div>`;
    sheetSet(h);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function moveGrain(id, tool) {
  const m = $('#g-msg'); if (m) m.textContent = '…';
  try { const g = await mcp(tool, { id }); if (m) m.textContent = '现在是：' + g.status; } catch (e) { if (m) m.textContent = '失败：' + e.message; }
}
async function pinGrain(id) {
  const m = $('#g-msg'); if (m) m.textContent = '…';
  try { const g = await mcp('get_grain', { id }); const r = await mcp('update_grain', { id, pinned: !g.pinned }); if (m) m.textContent = r.pinned ? `pin 住了，热度 ${Math.round(r.heat)}` : '取消了 pin'; }
  catch (e) { if (m) m.textContent = '失败：' + e.message; }
}
async function openFamilies() {
  sheetLoading('家族');
  try {
    const fs = await mcp('list_families');
    sheetSet(fs.length ? `<div style="padding-top:8px">${fs.map(f => `<span class="tag" style="font-size:13px;padding:6px 12px" onclick="openFamily('${esc(f.family)}')">${esc(f.family)} · ${f.count}</span>`).join('')}</div>` : '<div class="empty">还没有家族标签</div>');
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function openFamily(name) {
  sheetLoading(name);
  try {
    const gs = await mcp('search_grains', { family: name, limit: 200 });
    sheetSet(gs.length ? gs.map(g => grainCard(g)).join('') : '<div class="empty">这个家族是空的</div>');
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
// 对话记录浏览器：关键词逐处定位（像微信搜索）+ 按日期翻
let ringMode = 'date', ringQuery = '';
async function openRings(sourceType) {
  sheetLoading('对话记录');
  ringSource = sourceType || '';
  renderRingBrowser();
}
let ringSource = '';
function renderRingBrowser() {
  sheetSet(`<div class="search-box" style="margin-top:4px">
      <span style="color:var(--text-light)">🔍</span>
      <input id="rg-q" type="search" placeholder="搜一个词，看它出现过的每一处…" value="${esc(ringQuery)}" enterkeyhint="search">
    </div>
    <div class="chip-row" style="margin-top:10px">
      <div class="chip${ringMode === 'date' ? ' on' : ''}" onclick="setRingMode('date')">按日期翻</div>
      <div class="chip${ringMode === 'hits' ? ' on' : ''}" onclick="setRingMode('hits')">关键词定位</div>
    </div>
    <div id="rg-body"><div class="loading">…</div></div>`);
  const inp = $('#rg-q');
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { ringQuery = e.target.value.trim(); ringMode = ringQuery ? 'hits' : 'date'; renderRingBrowser(); } });
  loadRingBody();
}
function setRingMode(m) { ringMode = m; renderRingBrowser(); }
async function loadRingBody() {
  const box = $('#rg-body'); if (!box) return;
  try {
    if (ringMode === 'hits' && ringQuery) {
      const r = await mcp('search_ring_occurrences', { query: ringQuery, limit: 80 });
      if (!r.hits.length) { box.innerHTML = '<div class="empty">这个词在原始记录里没出现过</div>'; return; }
      const byRing = {};
      r.hits.forEach(h => (byRing[h.ring_id] = byRing[h.ring_id] || []).push(h));
      box.innerHTML = `<div class="section-title">共 ${r.total} 处${r.total > r.shown ? `，显示前 ${r.shown} 处` : ''}</div>` +
        Object.values(byRing).map(hs => {
          const h0 = hs[0];
          return `<div class="entry">
            <div class="entry-head"><span>${esc(h0.date || '')}</span><span>${esc(h0.window_name || h0.title || '')}</span><span class="tag plain">${hs.length} 处</span></div>
            ${hs.map(h => `<div class="hit" onclick="openRing('${h.ring_id}', ${h.offset}, '${esc(ringQuery)}')">
              ${esc(h.before)}<mark>${esc(h.match)}</mark>${esc(h.after)}</div>`).join('')}
          </div>`;
        }).join('');
    } else {
      const args = { limit: 400 }; if (ringSource) args.source_type = ringSource;
      const days = await mcp('rings_by_date', args);
      box.innerHTML = days.length ? days.map(d => `<div class="section-title">${esc(d.date)} <span style="color:var(--text-light);font-weight:400">${d.items.length} 条</span></div>
        ${d.items.map(i => `<div class="entry" onclick="openRing('${i.id}')">
          <div class="entry-head"><span>${esc(i.window_name || i.title || '未命名')}</span><span>${i.length} 字</span>${i.source_type === 'daily_summary' ? '<span class="tag plain">每日总结</span>' : ''}</div></div>`).join('')}`).join('')
        : '<div class="empty">还没有记录</div>';
    }
  } catch (e) { box.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
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
    sheetSet(`<div class="entry"><div class="entry-head"><span>${esc(r.date)}</span><span>${esc(r.window_name || '')}</span><span>${content.length} 字</span></div>
      ${r.title ? `<div class="card-title" style="margin-bottom:6px">${esc(r.title)}</div>` : ''}
      <div class="entry-body">${body}</div></div>`);
    const t = document.getElementById('rg-target');
    if (t) setTimeout(() => t.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function openDiary() {
  sheetLoading('日记');
  try {
    const ds = await rest('/api/diary');
    sheetSet(ds.length ? ds.map(d => `<div class="entry"><div class="entry-head">${esc(fmtTime(d.addedAt))}</div><div class="entry-body">${esc(d.text)}</div></div>`).join('') : '<div class="empty">还没有公开日记</div>');
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function openDailyList() {
  sheetLoading('每日总结');
  try {
    const cs = await mcp('get_calendar', { days: 60 });
    sheetSet(cs.length ? cs.map(c => `<div class="entry" onclick="switchPage('calendar');closeSheet();showDay('${c.date}')">
      <div class="entry-head"><span>${esc(c.date)}</span><span>${moon(c.date).icon}</span>${(c.mood_tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      <div class="entry-body clamp">${esc(c.headline || c.content || '')}</div></div>`).join('') : '<div class="empty">还没有每日总结</div>');
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function openNotes() {
  sheetLoading('笔记');
  try {
    const ns = await rest('/api/notes');
    sheetSet(ns.length ? ns.map(n => `<div class="entry"><div class="entry-head"><span>${esc({ write: '自由写作', reflect: '回看', read: '读书笔记' }[n.kind] || n.kind)}</span><span>${esc(fmtTime(n.at))}</span>${n.bookTitle ? `<span>《${esc(n.bookTitle)}》</span>` : ''}</div><div class="entry-body">${esc(n.text)}</div></div>`).join('') : '<div class="empty">还没写过</div>');
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function openSummaryHistory() {
  sheetLoading('摘要历史');
  try {
    const s = await mcp('get_summary');
    sheetSet(s.sections.map(x => `<div class="card tap" onclick="openSectionHistory('${x.section}','${esc(x.label)}')"><div class="card-title">${esc(x.label)}</div><div class="card-desc">${esc(fmtDate(x.updatedAt)) || '还没写过'}</div></div>`).join(''));
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function openSectionHistory(section, label) {
  sheetLoading(label);
  try {
    const hs = await mcp('get_summary_history', { section });
    sheetSet(hs.length ? hs.slice().reverse().map(h => `<div class="entry"><div class="entry-head">改于 ${esc(fmtTime(h.archivedAt))}</div><div class="entry-body">${esc(h.text)}</div></div>`).join('') : '<div class="empty">这一段没有旧版本</div>');
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}

// ---- 情绪清单：重点是形状不是标签 ----
async function openEmotions() {
  sheetLoading('情绪清单');
  try {
    const d = await mcp('get_emotions');
    const done = d.emotions.filter(e => e.status === 'confirmed');
    const todo = d.emotions.filter(e => e.status !== 'confirmed');
    const row = e => `<div class="entry" onclick="openEmotion('${e.id}')">
      <div class="entry-head"><span>${e.index}</span><span style="font-weight:600;color:var(--text);font-size:14px">${esc(e.name)}</span>
        ${e.logged_count ? `<span class="tag">记过 ${e.logged_count} 次</span>` : ''}
        ${e.status !== 'confirmed' ? '<span class="tag plain">形状待确认</span>' : ''}</div>
      ${e.shape ? `<div class="entry-body clamp" style="font-size:13px">${esc(e.shape)}</div>` : '<div class="entry-body" style="font-size:13px;color:var(--text-light)">还没写形状</div>'}</div>`;
    sheetSet(`<div class="card" style="background:var(--accent-light)"><div class="card-desc" style="line-height:1.6">${esc(d.note)}</div></div>
      <div class="section-title">有形状的 <span style="color:var(--text-light);font-weight:400">${done.length}</span></div>
      ${done.map(row).join('')}
      <div class="section-title">形状待确认 <span style="color:var(--text-light);font-weight:400">${todo.length}</span></div>
      ${todo.map(row).join('')}`);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function openEmotion(id) {
  sheetLoading('情绪');
  try {
    const e = await mcp('get_emotion', { id });
    sheetSet(`<div class="entry">
        <div class="entry-head"><span>${e.index}</span>${e.status !== 'confirmed' ? '<span class="tag plain">形状待确认</span>' : ''}</div>
        <div class="card-title" style="font-size:17px">${esc(e.name)}</div>
        <div class="entry-body" style="margin-top:8px">${e.shape ? esc(e.shape) : '<span style="color:var(--text-light)">还没写形状。位置＋质感＋方向。</span>'}</div>
      </div>
      <div class="card"><div class="summary-meta" style="border:none;padding:0;margin:0">
        <div class="meta-item"><div class="meta-value">${e.logged_count}</div><div class="meta-label">记过几次</div></div>
        <div class="meta-item"><div class="meta-value" style="font-size:14px">${e.last_logged ? esc(fmtDate(e.last_logged)) : '—'}</div><div class="meta-label">上次出现</div></div>
        <div class="meta-item"><div class="meta-value">${e.memory_mentions ?? '—'}</div><div class="meta-label">记忆里提到</div></div>
      </div></div>
      <div class="card"><div class="card-title" style="font-size:14px">改形状</div>
        <textarea id="em-shape" style="min-height:80px;margin-top:8px">${esc(e.shape || '')}</textarea>
        <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
          <button class="btn" onclick="saveEmotion('${e.id}')">存</button>
          <button class="btn ghost" onclick="toggleEmotionStatus('${e.id}','${e.status}')">${e.status === 'confirmed' ? '改回待确认' : '标成已确认'}</button>
        </div><div id="em-msg" style="margin-top:8px;font-size:13px;color:var(--text-light)"></div></div>
      <div class="card"><div class="card-title" style="font-size:14px">刚认出来一次</div>
        <input type="text" id="em-note" placeholder="当时什么情况" style="margin-top:8px">
        <button class="btn" style="margin-top:8px" onclick="logEmotion('${e.id}')">记一笔</button></div>
      ${(e.occurrences || []).length ? `<div class="section-title">记录</div>${e.occurrences.slice().reverse().map(o => `<div class="entry"><div class="entry-head">${esc(fmtTime(o.at))}</div>${o.note ? `<div class="entry-body">${esc(o.note)}</div>` : ''}</div>`).join('')}` : ''}
      ${(e.related_memories || []).length ? `<div class="section-title">记忆里相关的</div>${e.related_memories.map(m => `<div class="entry" onclick="openGrain('${m.id}')"><div class="entry-head">${esc(CATS[m.category] || '')} ${esc(m.date || '')}</div><div class="entry-body clamp">${esc(m.text)}</div></div>`).join('')}` : ''}`);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function saveEmotion(id) {
  const m = $('#em-msg'); m.textContent = '存…';
  try { await mcp('update_emotion', { id, shape: $('#em-shape').value }); m.textContent = '存好了'; }
  catch (e) { m.textContent = '失败：' + e.message; }
}
async function toggleEmotionStatus(id, cur) {
  const m = $('#em-msg'); m.textContent = '…';
  try { const r = await mcp('update_emotion', { id, status: cur === 'confirmed' ? 'pending' : 'confirmed' }); m.textContent = '现在是：' + (r.status === 'confirmed' ? '已确认' : '待确认'); }
  catch (e) { m.textContent = '失败：' + e.message; }
}
async function logEmotion(id) {
  const m = $('#em-msg'); m.textContent = '记…';
  try { const r = await mcp('log_emotion', { id, note: $('#em-note').value }); m.textContent = `记好了，一共 ${r.logged_count} 次`; $('#em-note').value = ''; }
  catch (e) { m.textContent = '失败：' + e.message; }
}

// ---- 我们的第一次们 ----
async function openFirsts() {
  sheetLoading('我们的第一次们');
  try {
    const d = await mcp('get_firsts');
    sheetSet(`<div class="card"><div class="card-desc">自动从纹理里筛的 ${d.auto} 条 + 手动补的 ${d.manual} 条。点右边可以置顶，筛错了可以藏掉。</div>
        <div style="margin-top:10px"><span class="link" onclick="openAddFirst()">+ 手动补一条</span></div></div>
      ${d.items.map(it => `<div class="entry">
        <div class="entry-head"><span>${esc(it.date || '没写日期')}</span>${it.source === 'manual' ? '<span class="tag plain">手动</span>' : `<span class="tag plain">${esc(CATS[it.category] || '')}</span>`}
          <span class="link" style="margin-left:auto" onclick="event.stopPropagation();pinFirst('${it.id}',${!it.pinned})">${it.pinned ? '★ 已置顶' : '☆ 置顶'}</span>
          <span class="link" onclick="event.stopPropagation();hideFirst('${it.id}')">藏</span></div>
        <div class="card-title" style="font-size:15px;margin:4px 0">${esc(it.title)}</div>
        ${it.text && it.text !== it.title ? `<div class="entry-body clamp" style="font-size:13px">${esc(it.text)}</div>` : ''}
        ${it.source === 'auto' ? `<div style="margin-top:6px"><span class="link" onclick="openGrain('${it.id}')">看完整记忆 →</span></div>` : ''}</div>`).join('')}`);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
function openAddFirst() {
  openSheet('补一条第一次', `<div class="card">
    <input type="text" id="fr-title" placeholder="第一次…">
    <input type="text" id="fr-date" placeholder="YYYY-MM-DD（可以不填）" style="margin-top:8px">
    <textarea id="fr-text" placeholder="当时是什么样的" style="margin-top:8px"></textarea>
    <button class="btn" style="margin-top:10px" onclick="saveFirst()">加上</button>
    <div id="fr-msg" style="margin-top:8px;font-size:13px;color:var(--text-light)"></div></div>`);
}
async function saveFirst() {
  const m = $('#fr-msg'); m.textContent = '存…';
  try { await mcp('add_first', { title: $('#fr-title').value, date: $('#fr-date').value.trim(), text: $('#fr-text').value }); m.textContent = '加好了'; }
  catch (e) { m.textContent = '失败：' + e.message; }
}
async function pinFirst(id, on) { try { await mcp('pin_first', { id, on }); sheetStack.pop(); openFirsts(); } catch (e) { alert(e.message); } }
async function hideFirst(id) { try { await mcp('hide_first', { id, on: true }); sheetStack.pop(); openFirsts(); } catch (e) { alert(e.message); } }

// ================= Tab 册 =================
let albumLoaded = false, albumPhotos = [], albumTag = '', albumMode = 'date';
async function loadAlbum() {
  albumLoaded = true;
  try {
    albumPhotos = await rest('/api/album?limit=500');
    const tags = [...new Set(albumPhotos.flatMap(p => p.tags || []))];
    $('#a-tags').innerHTML = [`<div class="chip${!albumTag ? ' on' : ''}" onclick="setAlbumTag('')">全部 ${albumPhotos.length}</div>`]
      .concat(tags.map(t => `<div class="chip${albumTag === t ? ' on' : ''}" onclick="setAlbumTag('${esc(t)}')">${esc(t)}</div>`)).join('');
    renderAlbum();
  } catch (e) { fail($('#a-body'), e); }
}
function setAlbumTag(t) { albumTag = t; loadAlbum(); }
function openUpload() {
  openSheet('传照片', `<div class="card">
    <input type="text" id="up-cap" placeholder="描述：谁、在干嘛、当时什么感觉">
    <input type="text" id="up-tags" placeholder="标签，逗号分开（比如 日常,头像）" style="margin-top:8px">
    <input type="text" id="up-date" placeholder="日期 YYYY-MM-DD，留空就是今天" style="margin-top:8px">
    <label class="btn" style="display:inline-block;margin-top:10px;cursor:pointer">选照片并上传<input type="file" accept="image/*" multiple style="display:none" onchange="doUpload(this)"></label>
    <div id="up-msg" style="margin-top:8px;font-size:13px;color:var(--text-light)">大图会自动压缩，不用自己先处理</div></div>`);
}
async function doUpload(input) {
  const files = [...(input.files || [])]; if (!files.length) return;
  const msg = $('#up-msg');
  const caption = $('#up-cap').value.trim();
  const tags = $('#up-tags').value.split(/[,，]/).map(x => x.trim()).filter(Boolean);
  const date = $('#up-date').value.trim() || undefined;
  let done = 0;
  for (const f of files) {
    msg.textContent = `上传中 ${done + 1}/${files.length}…`;
    try { await MW.uploadPhoto(f, { caption, tags, date }); done++; }
    catch (e) { msg.textContent = `第 ${done + 1} 张失败：${e.message}`; return; }
  }
  msg.textContent = `传好了 ${done} 张`;
  closeSheet(); loadAlbum();
}

function toggleAlbumMode() { albumMode = albumMode === 'date' ? 'tag' : 'date'; $('#a-mode').textContent = albumMode === 'date' ? '按日期' : '按标签'; renderAlbum(); }
function renderAlbum() {
  const list = albumTag ? albumPhotos.filter(p => (p.tags || []).includes(albumTag)) : albumPhotos;
  if (!list.length) { $('#a-body').innerHTML = '<div class="empty">还没有照片</div>'; return; }
  const groups = {};
  list.forEach(p => {
    const keys = albumMode === 'date' ? [p.date || '未标日期'] : ((p.tags || []).length ? p.tags : ['未分类']);
    keys.forEach(k => (groups[k] = groups[k] || []).push(p));
  });
  $('#a-body').innerHTML = Object.keys(groups).sort().reverse().map(k =>
    `<div class="section-title">${esc(k)} <span style="color:var(--text-light);font-weight:400">${groups[k].length}</span></div>
     <div class="album-grid">${groups[k].map(p => `<div class="album-item" onclick="openPhoto('${p.id}')"><img loading="lazy" src="${imageUrl(p.id)}" alt=""></div>`).join('')}</div>`).join('');
}
function openPhoto(id) {
  const p = albumPhotos.find(x => x.id === id) || {};
  openSheet('照片', `<img src="${imageUrl(id)}" style="width:100%;border-radius:var(--radius);margin-top:8px">
    <div class="entry"><div class="entry-head"><span>${esc(p.date || '')}</span>${p.width ? `<span>${p.width}×${p.height}</span>` : ''}${p.compressed ? '<span class="tag plain">压缩过</span>' : ''}</div>
    <div class="entry-body">${esc(p.caption || '（没写标注）')}</div>
    ${(p.tags || []).length ? `<div style="margin-top:6px">${p.tags.map(t => `<span class="tag" onclick="closeSheet();setAlbumTag('${esc(t)}')">${esc(t)}</span>`).join('')}</div>` : ''}</div>`);
}

// ================= Tab 搜 =================
const RECENT_KEY = 'muwen-recent-search';
function recentList() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } }
function pushRecent(q) {
  const l = recentList().filter(x => x !== q); l.unshift(q);
  localStorage.setItem(RECENT_KEY, JSON.stringify(l.slice(0, 12))); renderRecent();
}
function renderRecent() {
  const l = recentList();
  $('#s-recent').innerHTML = l.length ? l.map(q => `<span class="tag" onclick="doSearch('${esc(q)}')">${esc(q)}</span>`).join('') : '<div class="empty" style="padding:10px">还没搜过</div>';
}
$('#s-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(e.target.value.trim()); });
async function doSearch(q) {
  if (!q) return;
  $('#s-input').value = q; pushRecent(q);
  $('#s-body').innerHTML = '<div class="loading">搜索中…</div>';
  try {
    const r = await mcp('search_all', { query: q, limit: 12 });
    if (!r.results.length) { $('#s-body').innerHTML = '<div class="empty">没搜到。换个说法试试，或者用「想起」。</div>' + recallBtn(q); return; }
    const groups = {};
    r.results.forEach(x => {
      const key = labelOf(x);
      (groups[key] = groups[key] || []).push(x);
    });
    $('#s-body').innerHTML = `<div class="section-title">搜索结果 <span style="color:var(--text-light);font-weight:400">${r.results.length} 条</span></div>` +
      Object.entries(groups).map(([k, items], i) => `<div class="group">
        <div class="group-head" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
          <div class="group-title">${esc(k)}</div><div class="group-count">${items.length}条</div></div>
        <div class="group-items" style="display:${i === 0 ? 'block' : 'none'}">
          ${items.map(x => `<div class="group-item" onclick="${resultAction(x)}">${esc(oneLine(x.text || x.excerpt || x.caption || '').slice(0, 70))}</div>`).join('')}
        </div></div>`).join('') + recallBtn(q);
  } catch (e) { fail($('#s-body'), e); }
}
function resultAction(x) {
  if (x.layer === 'grains') return `openGrain('${x.id}')`;
  if (x.layer === 'rings') return `openRing('${x.id}')`;
  if (x.layer === 'photos') return `switchPage('album');openPhoto('${x.id}')`;
  return `void 0`;
}
function recallBtn(q) {
  return `<div class="card tap" style="margin-top:14px" onclick="doRecall('${esc(q)}')"><div class="card-row"><div class="card-icon accent">忆</div>
    <div><div class="card-title">让辞想一想</div><div class="card-desc">走召回：读懂意思去找，不只是对字面</div></div></div></div><div id="s-recall"></div>`;
}
async function doRecall(q) {
  $('#s-recall').innerHTML = '<div class="loading">想…</div>';
  try {
    const r = await mcp('auto_recall', { query: q });
    if (!r.memories || !r.memories.length) { $('#s-recall').innerHTML = '<div class="empty">这次没想起相关的（空手而归也是对的）</div>'; return; }
    $('#s-recall').innerHTML = `<div class="section-title">想起来的 <span style="color:var(--text-light);font-weight:400">${esc(r.via || '')}</span></div>` +
      r.memories.map(m => m.kind === 'ring'
        ? `<div class="entry" onclick="openRing('${m.id}')"><div class="entry-head">年轮 · ${esc(m.date || '')}</div><div class="entry-body clamp">${esc(m.excerpt || '')}</div></div>`
        : `<div class="entry" onclick="openGrain('${m.id}')"><div class="entry-head">${esc(CATS[m.category] || '')} ${m.date ? '· ' + esc(m.date) : ''}${m.reason ? ' · ' + esc(m.reason) : ''}</div><div class="entry-body clamp">${esc(m.text)}</div></div>`).join('');
  } catch (e) { fail($('#s-recall'), e); }
}

// ================= 头像 / 档案 =================
async function applyAvatars() {
  const p = await MW.loadPrefs(true).catch(() => ({}));
  ['cy', 'nor'].forEach(w => {
    const id = p['avatar_' + w];
    const node = $('#av-' + w);
    if (node) node.innerHTML = id ? `<img src="${imageUrl(id)}" alt="">` : (w === 'cy' ? '辞' : '棋');
  });
}
async function openProfile(owner) {
  const who = owner === 'cy' ? '辞' : '棋子';
  sheetLoading(who + '的档案');
  try {
    const rows = await mcp('get_profile', { owner });
    let h = `<div class="card tap" onclick="pickAvatar('${owner}')"><div class="card-row"><div class="card-icon accent">像</div><div><div class="card-title">换头像</div><div class="card-desc">从相册里挑一张（标了「头像」的优先）</div></div></div></div>`;
    h += rows.map(r => `<div class="entry"><div class="entry-head">${esc(r.label)}${r.updated_at ? ' · ' + esc(fmtDate(r.updated_at)) : ''}</div>
      <div class="entry-body">${r.content ? esc(r.content) : '<span style="color:var(--text-light)">（还没写）</span>'}</div></div>`).join('');
    sheetSet(h);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function pickAvatar(owner) {
  sheetLoading('换头像');
  try {
    if (!albumPhotos.length) albumPhotos = await rest('/api/album?limit=500');
    const av = albumPhotos.filter(p => (p.tags || []).includes('头像'));
    const list = av.length ? av : albumPhotos;
    sheetSet(`<div class="card"><div class="card-title" style="font-size:14px">从手机传一张</div>
      <label class="btn" style="display:inline-block;margin-top:10px;cursor:pointer">选择照片<input type="file" accept="image/*" style="display:none" onchange="uploadAvatar('${owner}',this)"></label>
      <div id="av-msg" style="margin-top:8px;font-size:13px;color:var(--text-light)"></div></div>
      <div class="section-title">或者从相册里挑</div>
      ${list.length ? `<div class="album-grid">${list.map(p => `<div class="album-item" onclick="setAvatar('${owner}','${p.id}')"><img loading="lazy" src="${imageUrl(p.id)}"></div>`).join('')}</div>` : '<div class="empty">相册还是空的</div>'}`);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function uploadAvatar(owner, input) {
  const f = input.files && input.files[0]; if (!f) return;
  const m = $('#av-msg'); m.textContent = '上传中…';
  try { const r = await MW.uploadPhoto(f, { caption: (owner === 'cy' ? '辞' : '棋子') + '的头像', tags: ['头像'] }); await setAvatar(owner, r.photo.id); }
  catch (e) { m.textContent = '上传失败：' + e.message; }
}
async function setAvatar(owner, id) {
  try { await MW.setAvatar(owner, id); albumPhotos = []; await applyAvatars(); closeSheet(); }
  catch (e) { const m = $('#av-msg'); if (m) m.textContent = '失败：' + e.message; }
}

// ---------- 启动 ----------
applyAvatars(); renderRecent(); loadToday();
window.switchPage = switchPage; window.closeSheet = closeSheet;
