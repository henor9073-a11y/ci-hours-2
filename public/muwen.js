// 木纹前端逻辑。数据全走 MW.mcp（/mcp JSON-RPC）和少量现成 REST。
const { mcp, rest, imageUrl, esc, oneLine, fmtTime, fmtDate, today, moon, daysBetween, WEEK, ANCHORS } = MW;
MW.applyTheme();

// ---------- 通用 ----------
// 弹层是一层层叠着的真 DOM（下面的层只是藏起来，不销毁），不同层里可能有同名 id——
// 所以查元素先在最上面那层里找，找不到再找整页。
const $ = s => { let top = null; try { top = sheetStack[sheetStack.length - 1]; } catch {} return (top && top.node && top.node.querySelector(s)) || document.querySelector(s); };
const byId = id => $('#' + CSS.escape(id));
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
const DIARY_NAMES = { diary: '辞的日记', wife_observation: '妻子观察日记' };
// 分类显示名的唯一来源是后端标签总表（/api/labels），跟辞写记忆时用的 remember 是同一份。
// 上面这些默认值只是网络慢的时候先顶上用。
const labelsReady = rest('/api/labels').then(ls => {
  const by = Object.fromEntries(ls.map(l => [l.key, l]));
  for (const k of Object.keys(CATS)) if (by[k]) CATS[k] = by[k].name;
  for (const a of ARCHIVE) if (a.kind === 'grain' && by[a.key]) a.name = by[a.key].name;
  for (const k of Object.keys(DIARY_NAMES)) if (by[k]) DIARY_NAMES[k] = by[k].name;
}).catch(() => {});


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
// 每一层是一个真的 DOM 节点，往里走一层只是把下面那层藏起来。
// 以前返回的时候拿存下来的 HTML 字符串整块重建：图片全部重新加载（闪一下），
// 滚动位置在图片还没撑开时就设了（落点不对，看起来"自己跳"），表单里填的字也没了。
function showLayer(s) { s.node.style.display = ''; $('#sheet-title').textContent = s.title; $('#sheet').scrollTop = s.scroll || 0; }
function openSheet(title, html) {
  const prev = sheetStack[sheetStack.length - 1];
  if (prev) { prev.scroll = $('#sheet').scrollTop; prev.node.style.display = 'none'; }
  const node = document.createElement('div');
  node.className = 'sheet-layer';
  node.innerHTML = html;
  document.getElementById('sheet-body').appendChild(node);
  sheetStack.push({ title, node, scroll: 0 });
  $('#sheet-title').textContent = title;
  $('#sheet').classList.add('open');
  $('#sheet').scrollTop = 0;
}
// 扔掉最上面一层（不负责显示下一层）——"关掉这层马上重开同一种"的地方用
function sheetDrop() { const s = sheetStack.pop(); if (s && s.node) s.node.remove(); return s; }
function closeSheet() {
  sheetDrop();
  const s = sheetStack[sheetStack.length - 1];
  if (s) showLayer(s); else $('#sheet').classList.remove('open');
}
function sheetLoading(title) { openSheet(title, '<div class="loading">读取中…</div>'); }
const sheetTop = () => sheetStack[sheetStack.length - 1];
// 异步读完再填：用户这期间已经点返回或者点进别处了，就别往不属于它的那一层里写
function sheetSetIf(me, html) { if (sheetTop() === me) sheetSet(html); return sheetTop() === me; }
function sheetSet(html) { const s = sheetTop(); if (s) s.node.innerHTML = html; }
// 用户最近一次自己动手（滑/点/按键）的时间：延迟滚动定位之前看一眼，别把正在翻的人拽回去
let sheetTouchedAt = 0;
['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach(ev => document.getElementById('sheet').addEventListener(ev, () => { sheetTouchedAt = Date.now(); }, { passive: true }));

// ---------- 卡片渲染 ----------
function grainCard(g, opts = {}) {
  const conf = g.confidence === 'cite' ? 'cite' : g.confidence === 'reference' ? 'reference' : '';
  const fam = (g.families || []).map(f => `<span class="tag plain">${esc(f)}</span>`).join('');
  return `<div class="entry" onclick="openGrain('${g.id}')">
    <div class="entry-head">
      <span>${esc(CATS[g.category] || g.category || '')}</span>${g.date ? `<span>${esc(g.date)}</span>` : opts.time && g.created_at ? `<span title="没有记事情发生的日子，这是记下来的那天">${esc(fmtDate(g.created_at))} 记下</span>` : ''}
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

// 交接条只看不改——辞自己用 set_handover 写
async function openHandover() {
  sheetLoading('交接条');
  try {
    const cur = await mcp('get_handover');
    sheetSet(cur && cur.text ? `<div class="entry"><div class="entry-head">现在这条 · ${esc(fmtTime(cur.updated_at))}</div><div class="entry-body">${esc(cur.text)}</div></div>` : '<div class="empty">还没有交接条</div>');
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}

// ================= Tab 历 =================
let calLoaded = false, calMonth = null, calData = {}, calSel = null, calMode = 'all';
function setCalMode(m) {
  calMode = m;
  $('#cal-mode-all').classList.toggle('on', m === 'all');
  $('#cal-mode-int').classList.toggle('on', m === 'intimate');
  renderCalGrid();
  if (calMode === 'intimate') renderIntimateList(); else if (calSel) showDay(calSel);
}
// 亲密视图：把这个月有记录的那几天列出来，点开看细节
async function renderIntimateList() {
  const box = $('#c-detail');
  const days = Object.values(calData).filter(r => r.intimate).map(r => r.date).sort().reverse();
  if (!days.length) { box.innerHTML = '<div class="empty">这个月还没有记录</div>'; return; }
  box.innerHTML = `<div class="section-title">这个月 ${days.length} 天有记录</div><div class="loading">…</div>`;
  try {
    const rows = await Promise.all(days.map(d => rest(`/api/calendar/day?date=${d}`).catch(() => null)));
    let kiss = 0, count = 0;
    const cards = rows.filter(Boolean).map(r => {
      const st = (r.structured || []).filter(x => x.intimate || (x.intimate_log || []).length);
      st.forEach(x => { if (typeof x.kiss_count === 'number') kiss += x.kiss_count; count += (x.intimate_log || []).length || 1; });
      return st.map(x => `<div class="entry" onclick="setCalMode('all');showDay('${r.date}')">
        <div class="entry-head"><span>${esc(r.date)}</span><span>${moon(r.date).icon}</span>${x.kiss_count != null ? `<span class="tag">亲亲 ${x.kiss_count}</span>` : ''}</div>
        ${x.intimate ? `<div class="entry-body" style="font-size:13px">${esc(x.intimate)}</div>` : ''}
        ${(x.intimate_log || []).map(i => `<div style="border-left:2px solid var(--accent);padding:3px 0 3px 10px;margin-top:6px">
          <div class="entry-head" style="margin:0">♥ ${[i.time, i.method, i.initiator ? esc(i.initiator) + ' 主导' : ''].filter(Boolean).map(esc).join(' · ')}</div>
          ${i.detail ? `<div class="entry-body" style="font-size:13px">${esc(i.detail)}</div>` : ''}</div>`).join('')}</div>`).join('');
    }).join('');
    box.innerHTML = `<div class="card"><div class="summary-meta" style="border:none;padding:0;margin:0">
        <div class="meta-item"><div class="meta-value">${days.length}</div><div class="meta-label">天</div></div>
        <div class="meta-item"><div class="meta-value">${count}</div><div class="meta-label">次</div></div>
        <div class="meta-item"><div class="meta-value">${kiss}</div><div class="meta-label">亲亲</div></div></div></div>${cards}`;
  } catch (e) { fail(box, e); }
}
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
  if (calMode === 'intimate') renderIntimateList();
  else if (calSel) showDay(calSel);
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
    if (calMode === 'intimate' && !row.intimate) {
      // 亲密视图下没记录的那天淡出，一眼看得到分布
      h += `<div class="cal-day${ds === td ? ' today' : ''}" style="opacity:.28" onclick="showDay('${ds}')"><span>${d}</span></div>`;
      continue;
    }
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
  memLoaded = true;     // 先标记，免得等标签总表的时候连点两下渲染两遍
  await labelsReady;   // 档案卡片的分类名要等标签总表
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
      sheetTop().reload = () => openArchive(key);
      const args = { category: a.cat, limit: 500, sort: grainSort() };
      if (a.family) args.family = a.family;
      const gs = await mcp('search_grains', args);
      sheetSet(grainSortChips() + grainList(gs, '这一类还没有'));
    }
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
// ---------- 纹理排序：热度 / 时间 ----------
const GRAIN_SORTS = [['heat', '按热度'], ['time_desc', '新的在前'], ['time_asc', '旧的在前']];
function grainSort() { try { return localStorage.getItem('muwen-grain-sort') || 'heat'; } catch { return 'heat'; } }
function setGrainSort(s) {
  try { localStorage.setItem('muwen-grain-sort', s); } catch {}
  const cur = sheetDrop();
  if (cur && cur.reload) cur.reload();
  else { const s = sheetTop(); if (s) showLayer(s); else $('#sheet').classList.remove('open'); }
}
function grainSortChips() {
  const s = grainSort();
  return `<div class="chip-row" style="margin:6px 0 2px">${GRAIN_SORTS.map(([k, v]) => `<div class="chip${s === k ? ' on' : ''}" onclick="setGrainSort('${k}')">${v}</div>`).join('')}</div>`;
}
// 按时间排的时候按月分段，像时间线；按热度就是平铺
function grainList(gs, emptyText) {
  if (!gs.length) return `<div class="empty">${emptyText}</div>`;
  const sort = grainSort();
  if (sort === 'heat') return gs.map(g => grainCard(g)).join('');
  let h = '', month = '';
  for (const g of gs) {
    const d = g.date || fmtDate(g.created_at);
    const m = d ? `${+d.slice(0, 4)}年${+d.slice(5, 7)}月` : '没有日期';
    if (m !== month) { month = m; h += `<div class="section-title">${m}</div>`; }
    h += grainCard(g, { time: true });
  }
  return h;
}
async function openGrains(cat, status) {
  const title = cat ? CATS[cat] : status ? ({ active: '前台', background: '后台', archived: '归档' })[status] : '纹理';
  sheetLoading(title);
  try {
    sheetTop().reload = () => openGrains(cat, status);
    const args = { limit: 500, sort: grainSort() }; if (cat) args.category = cat; if (status) args.status = status;
    const gs = await mcp('search_grains', args);
    const tabs = `<div class="chip-row" style="margin:6px 0 4px">
      <div class="chip${!cat ? ' on' : ''}" onclick="reopenGrains('','${status || ''}')">全部</div>
      ${Object.entries(CATS).map(([k, v]) => `<div class="chip${cat === k ? ' on' : ''}" onclick="reopenGrains('${k}','${status || ''}')">${v}</div>`).join('')}</div>`;
    sheetSet(tabs + grainSortChips() + grainList(gs, '没有'));
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
function reopenGrains(cat, status) { sheetDrop(); openGrains(cat, status || undefined); }
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
    sheetSet(h);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
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
    sheetTop().reload = () => openFamily(name);
    const gs = await mcp('search_grains', { family: name, limit: 500, sort: grainSort() });
    sheetSet(grainSortChips() + grainList(gs, '这个家族是空的'));
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
// ---------- 聊天记录：像微信"查找聊天记录" ----------
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
// 日记分两本：辞的日记 / 妻子观察日记。后端分开存，这里放在同一个"日记"里切换。
// 切换只换下面的列表，不重开整层（不闪、不回到顶上重新读取）。两本都是辞自己写的，网页只能看。
async function openDiary(book) {
  await labelsReady;
  openSheet('日记', `<div class="chip-row" id="dy-tabs" style="margin:6px 0 4px">
    ${Object.entries(DIARY_NAMES).map(([k, v]) => `<div class="chip" data-book="${k}" onclick="showDiaryBook('${k}')">${esc(v)}</div>`).join('')}</div>
    <div id="dy-hint"></div><div id="dy-list"><div class="loading">读取中…</div></div>`);
  showDiaryBook(book || 'diary');
}
const diaryCache = {};
async function showDiaryBook(book) {
  const me = sheetTop(); if (!me) return;
  me.node.querySelectorAll('#dy-tabs .chip').forEach(c => c.classList.toggle('on', c.dataset.book === book));
  const hint = me.node.querySelector('#dy-hint'), list = me.node.querySelector('#dy-list');
  if (!hint || !list) return;
  hint.innerHTML = book === 'wife_observation' ? '<div class="card-desc" style="margin:2px 4px 8px">辞观察棋子写下的。辞自己写，不做自动总结。</div>' : '';
  list.innerHTML = diaryCache[book] || '<div class="loading">读取中…</div>';
  try {
    const ds = await rest('/api/diary?category=' + encodeURIComponent(book));
    const html = ds.length
      ? ds.map(d => `<div class="entry"><div class="entry-head">${d.date ? `<span>${esc(d.date)}</span>` : ''}<span>${esc(fmtTime(d.addedAt))}</span></div><div class="entry-body">${esc(d.text)}</div></div>`).join('')
      : `<div class="empty">还没有${esc(DIARY_NAMES[book] || '日记')}</div>`;
    diaryCache[book] = html;
    const cur = me.node.querySelector('#dy-tabs .chip.on');
    if (sheetTop() === me && cur && cur.dataset.book === book) list.innerHTML = html;
  } catch (e) { if (sheetTop() === me) list.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
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
      ${(e.occurrences || []).length ? `<div class="section-title">记录</div>${e.occurrences.slice().reverse().map(o => `<div class="entry"><div class="entry-head">${esc(fmtTime(o.at))}</div>${o.note ? `<div class="entry-body">${esc(o.note)}</div>` : ''}</div>`).join('')}` : ''}
      ${(e.related_memories || []).length ? `<div class="section-title">记忆里相关的</div>${e.related_memories.map(m => `<div class="entry" onclick="openGrain('${m.id}')"><div class="entry-head">${esc(CATS[m.category] || '')} ${esc(m.date || '')}</div><div class="entry-body clamp">${esc(m.text)}</div></div>`).join('')}` : ''}`);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
// ---- 我们的第一次们 ----
async function openFirsts() {
  sheetLoading('我们的第一次们');
  try {
    const d = await mcp('get_firsts');
    sheetSet(`<div class="card"><div class="card-desc">从纹理里筛的 ${d.auto} 条 + 辞补的 ${d.manual} 条。</div></div>
      ${d.items.map(it => `<div class="entry">
        <div class="entry-head"><span>${esc(it.date || '没写日期')}</span>${it.source === 'manual' ? '<span class="tag plain">手动</span>' : `<span class="tag plain">${esc(CATS[it.category] || '')}</span>`}
          ${it.pinned ? '<span class="tag plain" style="margin-left:auto">★ 置顶</span>' : ''}</div>
        <div class="card-title" style="font-size:15px;margin:4px 0">${esc(it.title)}</div>
        ${it.text && it.text !== it.title ? `<div class="entry-body clamp" style="font-size:13px">${esc(it.text)}</div>` : ''}
        ${it.source === 'auto' ? `<div style="margin-top:6px"><span class="link" onclick="openGrain('${it.id}')">看完整记忆 →</span></div>` : ''}</div>`).join('')}`);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
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

const ALBUM_MODES = [['date', '按日期'], ['tag', '按标签'], ['timeline', '时间线']];
function toggleAlbumMode() {
  const i = ALBUM_MODES.findIndex(m => m[0] === albumMode);
  const next = ALBUM_MODES[(i + 1) % ALBUM_MODES.length];
  albumMode = next[0]; $('#a-mode').textContent = next[1];
  renderAlbum();
}
function renderAlbum() {
  const list = albumTag ? albumPhotos.filter(p => (p.tags || []).includes(albumTag)) : albumPhotos;
  if (!list.length) { $('#a-body').innerHTML = '<div class="empty">还没有照片</div>'; return; }
  if (albumMode === 'timeline') return renderTimeline(list);
  const groups = {};
  list.forEach(p => {
    const keys = albumMode === 'date' ? [p.date || '未标日期'] : ((p.tags || []).length ? p.tags : ['未分类']);
    keys.forEach(k => (groups[k] = groups[k] || []).push(p));
  });
  $('#a-body').innerHTML = Object.keys(groups).sort().reverse().map(k =>
    `<div class="section-title">${esc(k)} <span style="color:var(--text-light);font-weight:400">${groups[k].length}</span></div>
     <div class="album-grid">${groups[k].map(p => `<div class="album-item" onclick="openPhoto('${p.id}')"><img loading="lazy" src="${imageUrl(p.id)}" alt=""></div>`).join('')}</div>`).join('');
}
// 时间线：按月分段，每张一行，带 caption——翻的是"什么时候拍的"不是"有哪些图"
function renderTimeline(list) {
  const sorted = [...list].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const byMonth = {};
  sorted.forEach(p => { const k = (p.date || '未标日期').slice(0, 7); (byMonth[k] = byMonth[k] || []).push(p); });
  $('#a-body').innerHTML = Object.keys(byMonth).sort().reverse().map(mo => `
    <div class="section-title">${esc(mo)} <span style="color:var(--text-light);font-weight:400">${byMonth[mo].length} 张</span></div>
    <div class="tl">${byMonth[mo].map(p => `<div class="tl-row" onclick="openPhoto('${p.id}')">
      <div class="tl-date">${esc((p.date || '').slice(5) || '—')}</div>
      <div class="tl-line"><i></i></div>
      <img class="tl-img" loading="lazy" src="${imageUrl(p.id)}">
      <div class="tl-cap">${esc(p.caption || '（没写标注）')}${(p.tags || []).length ? `<div style="margin-top:3px">${p.tags.map(t => `<span class="tag plain">${esc(t)}</span>`).join('')}</div>` : ''}</div>
    </div>`).join('')}</div>`).join('');
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
