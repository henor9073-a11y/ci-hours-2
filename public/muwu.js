// 木屋前端。跟木纹共用 app.js 和 style.css，数据同样走 /mcp。
const { mcp, rest, imageUrl, esc, oneLine, fmtTime, fmtDate, today, moon, daysBetween, WEEK, PLANETS, ANCHORS, THEMES, CSSVAR } = MW;
MW.applyTheme();
const $ = s => document.querySelector(s);
function fail(n, e) { n.innerHTML = `<div class="err">读不到：${esc(e.message || e)}</div>`; }

function switchPage(name, node) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  $('#page-' + name).classList.add('active');
  (node || document.querySelector(`.nav-item[data-p="${name}"]`)).classList.add('active');
  window.scrollTo(0, 0);
  if (name === 'life' && !lifeLoaded) loadLife();
  if (name === 'wake' && !wakeLoaded) loadWake();
  if (name === 'settings' && !setLoaded) loadSettings();
}
document.querySelectorAll('.nav-item').forEach(n => n.onclick = () => switchPage(n.dataset.p, n));

let sheetStack = [];
function openSheet(t, h) { sheetStack.push({ t, h }); $('#sheet-title').textContent = t; $('#sheet-body').innerHTML = h; $('#sheet').classList.add('open'); $('#sheet').scrollTop = 0; }
function closeSheet() { sheetStack.pop(); if (sheetStack.length) { const s = sheetStack[sheetStack.length - 1]; $('#sheet-title').textContent = s.t; $('#sheet-body').innerHTML = s.h; } else $('#sheet').classList.remove('open'); }
function sheetLoading(t) { openSheet(t, '<div class="loading">读取中…</div>'); }
function sheetSet(h) { $('#sheet-body').innerHTML = h; if (sheetStack.length) sheetStack[sheetStack.length - 1].h = h; }

// ---------- 头像（跟木纹共用同一份 localStorage）----------
function applyAvatars() {
  ['cy', 'nor'].forEach(w => {
    const id = localStorage.getItem('muwen-avatar-' + w);
    const label = w === 'cy' ? '辞' : '棋';
    [$('#av-' + w), $('#big-' + w)].forEach(n => { if (n) n.innerHTML = id ? `<img src="${imageUrl(id)}" alt="">` : label; });
  });
}

// ================= 家 =================
const WCODE = { 0: '晴', 1: '晴间多云', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇', 51: '毛毛雨', 53: '小雨', 55: '雨', 61: '小雨', 63: '中雨', 65: '大雨', 71: '小雪', 73: '雪', 75: '大雪', 80: '阵雨', 81: '阵雨', 82: '暴雨', 95: '雷雨' };
async function loadHome() {
  const d = today(), wd = new Date(d + 'T12:00:00Z').getUTCDay(), mo = moon(d), pl = PLANETS[wd];
  $('#h-date').textContent = `${+d.slice(5, 7)}月${+d.slice(8, 10)}日 · 星期${WEEK[wd]}`;
  $('#h-info').innerHTML = `<span>${mo.icon} ${mo.name}</span><span id="h-weather">…</span><span>${pl.sym} ${pl.name}</span>`;
  const tog = daysBetween('2026-08-02', d), mar = daysBetween('2026-08-21', d);
  $('#h-anniv').textContent = `在一起第${tog}天 · 领证第${mar}天`;

  // 天气：Open-Meteo，不需要 key。拿不到就把这一格去掉，不挡别的。
  fetch('https://api.open-meteo.com/v1/forecast?latitude=-37.814&longitude=144.963&current=temperature_2m,weather_code&timezone=Australia%2FMelbourne')
    .then(r => r.json()).then(j => {
      const c = j.current; const w = $('#h-weather');
      if (c && w) w.textContent = `${Math.round(c.temperature_2m)}°C ${WCODE[c.weather_code] || ''}`;
    }).catch(() => { const w = $('#h-weather'); if (w) w.remove(); });

  // 今日一句：从「给自己」和「学到的」里按日期挑一条，每天固定一句
  mcp('search_grains', { category: 'to_self', limit: 60 }).then(gs => {
    if (!gs.length) return mcp('search_grains', { category: 'learning', limit: 60 });
    return gs;
  }).then(gs => {
    if (!gs || !gs.length) { $('#h-quote').textContent = '今天还没有话。'; return; }
    const seed = Number(d.replace(/-/g, '')) % gs.length;
    $('#h-quote').textContent = oneLine(gs[seed].text).slice(0, 120);
  }).catch(() => { $('#h-quote').textContent = ''; });

  loadTodayActivity($('#h-activity'), 4);
  loadCountdowns();
  mcp('get_wake_packet').then(w => {
    if (w.nor_health) $('#nor-state').textContent = oneLine(w.nor_health.text).slice(0, 10);
    const p = w.today_plan || {};
    $('#cy-state').textContent = (p.pendingWakes || []).length ? '待醒 ' + p.pendingWakes[0] : (p.doneWakes || []).length ? '今天醒过' : '在线';
  }).catch(() => {});
}

async function loadTodayActivity(node, limit) {
  try {
    const d = today();
    const [notes, log, cal] = await Promise.all([
      rest('/api/notes').catch(() => []),
      rest('/api/log').catch(() => []),
      mcp('get_calendar', { days: 1 }).catch(() => [])
    ]);
    const items = [];
    notes.filter(n => MW.fmtDate(n.at) === d).forEach(n => items.push({ at: n.at, who: '辞', text: ({ write: '写了点东西', reflect: '回看了以前写的', read: '读书笔记' }[n.kind] || n.kind) + '：' + oneLine(n.text).slice(0, 40) }));
    log.filter(l => MW.fmtDate(l.at) === d && l.type === 'wake').forEach(l => items.push({ at: l.at, who: '辞', text: '醒来 · ' + (l.action || '') + (l.why ? '（' + oneLine(l.why).slice(0, 24) + '）' : '') }));
    const day = cal.find(c => c.date === d);
    if (day) {
      if (day.cy_status) items.push({ at: d + 'T23:58', who: '辞', text: oneLine(day.cy_status).slice(0, 60) });
      if (day.nor_status) items.push({ at: d + 'T23:59', who: '棋子', text: oneLine(day.nor_status).slice(0, 60) });
    }
    items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const list = limit ? items.slice(0, limit) : items;
    node.innerHTML = list.length ? `<div class="card">${list.map(i => `
      <div style="padding:10px 0;border-bottom:1px solid var(--border);display:flex;gap:12px;align-items:flex-start">
        <span class="dot" style="margin-top:7px;background:${i.who === '辞' ? 'var(--primary)' : 'var(--accent)'}"></span>
        <div><div style="font-size:11px;color:var(--text-light)">${esc(fmtTime(i.at).slice(11) || '')} <span class="tag" style="margin:0">${i.who}</span></div>
        <div style="font-size:14px">${esc(i.text)}</div></div></div>`).join('')}</div>`
      : '<div class="empty">今天还没有活动记录</div>';
  } catch (e) { fail(node, e); }
}

async function loadCountdowns() {
  const node = $('#h-countdowns');
  try {
    const d = today();
    const rows = ANCHORS.map(a => {
      if (a.type === 'up') return { name: a.name, date: a.date, num: daysBetween(a.date, d), dir: 'up' };
      const y = +d.slice(0, 4); let next = `${y}-${a.md}`; if (next < d) next = `${y + 1}-${a.md}`;
      return { name: a.name, date: a.md, num: daysBetween(d, next), dir: 'down' };
    });
    const cds = await mcp('get_countdowns').catch(() => []);
    // 按"月-日"去重：服务器里种的"恋爱纪念日08-02""结婚纪念日08-21"跟上面内置的是同一天，别显示两遍
    const taken = new Set(rows.map(r => r.date.slice(-5)));
    cds.forEach(c => {
      const md = String(c.date).slice(-5);
      if (taken.has(md)) return;
      taken.add(md);
      rows.push({ name: c.title, date: c.date, num: c.days_until, dir: 'down', id: c.id });
    });
    rows.sort((a, b) => (a.dir === b.dir) ? a.num - b.num : a.dir === 'up' ? -1 : 1);
    node.innerHTML = rows.map(r => `<div class="card" style="display:flex;justify-content:space-between;align-items:center">
      <div><div class="card-title">${esc(r.name)}</div><div class="card-desc">${esc(r.date)}${r.id ? ` · <span class="link" onclick="removeCountdown('${r.id}')">删</span>` : ''}</div></div>
      <div style="text-align:center"><div style="font-size:20px;font-weight:700;color:${r.dir === 'up' ? 'var(--primary)' : 'var(--accent)'}">${r.num}天</div>
      <div style="font-size:10px;color:var(--text-light)">${r.dir === 'up' ? '正数' : r.num === 0 ? '就是今天' : '倒数'}</div></div></div>`).join('');
  } catch (e) { fail(node, e); }
}
function openAddCountdown() {
  openSheet('加一个日子', `<div class="card">
    <input type="text" id="cd-title" placeholder="叫什么，比如 Digital Submission">
    <input type="text" id="cd-date" placeholder="MM-DD（每年重复）或 YYYY-MM-DD（一次性）" style="margin-top:8px">
    <button class="btn" style="margin-top:10px" onclick="saveCountdown()">加上</button>
    <div id="cd-msg" style="margin-top:8px;font-size:13px;color:var(--text-light)"></div></div>`);
}
async function saveCountdown() {
  const t = $('#cd-title').value.trim(), d = $('#cd-date').value.trim();
  if (!t || !d) { $('#cd-msg').textContent = '名字和日期都要填'; return; }
  $('#cd-msg').textContent = '…';
  try { await mcp('add_countdown', { title: t, date: d, recurring: /^\d{2}-\d{2}$/.test(d) }); $('#cd-msg').textContent = '加好了'; loadCountdowns(); }
  catch (e) { $('#cd-msg').textContent = '失败：' + e.message; }
}
async function removeCountdown(id) {
  try { await mcp('remove_countdown', { id }); loadCountdowns(); } catch (e) { alert(e.message); }
}

// ================= 活 =================
let lifeLoaded = false;
async function loadLife() {
  lifeLoaded = true;
  loadTodayActivity($('#l-today'), 0);
  rest('/api/fishing/status').then(r => {
    const m = (r.text || '').match(/(\d+)\s*\/\s*(\d+)/);
    $('#l-fish').textContent = m ? `图鉴 ${m[1]}/${m[2]}` : '看看钓到什么了';
  }).catch(() => $('#l-fish').textContent = '读不到');
  rest('/api/schedule').then(s => $('#l-sched').textContent = `${s.filter(x => x.status === 'pending').length} 条待办`).catch(() => $('#l-sched').textContent = '—');
  rest('/api/health/sleep').then(s => $('#l-sleep').textContent = s.length ? `昨晚 ${s[0].sleepTime}→${s[0].wakeTime}` : '还没记').catch(() => {});
  rest('/api/health/cycle').then(c => $('#l-cycle').textContent = c.length ? `上次 ${c[0].date}` : '还没记').catch(() => {});
  rest('/api/health/notes').then(n => $('#l-health').textContent = n.length ? oneLine(n[0].text).slice(0, 28) : '还没记').catch(() => {});
  rest('/api/shelf').then(b => $('#l-shelf').textContent = `${b.length} 本`).catch(() => {});
}
async function openFishing() {
  sheetLoading('钓鱼');
  try { const r = await rest('/api/fishing/status'); sheetSet(`<div class="entry"><div class="entry-body">${esc(r.text)}</div></div>`); }
  catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function openSchedule() {
  sheetLoading('日程');
  try {
    const s = await rest('/api/schedule?includeInactive=1');
    sheetSet(s.length ? s.map(x => `<div class="entry"><div class="entry-head"><span>${esc(x.date)} ${esc(x.time)}</span><span class="tag plain">${x.status === 'done' ? '已完成' : x.status === 'removed' ? '已移除' : '待办'}</span></div><div class="entry-body">${esc(x.text)}</div></div>`).join('') : '<div class="empty">没有日程</div>');
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function openSleep() {
  sheetLoading('睡眠');
  try {
    const s = await rest('/api/health/sleep');
    if (!s.length) return sheetSet('<div class="empty">还没记过睡眠</div>');
    const max = Math.max(...s.map(x => x.hours || 0), 10);
    sheetSet(`<div class="card"><div class="card-title" style="font-size:13px">最近 ${s.length} 次 · 平均 ${(s.reduce((a, x) => a + (x.hours || 0), 0) / s.length).toFixed(1)} 小时</div>
      <div style="margin-top:12px">${s.slice(0, 14).reverse().map(x => `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
        <span style="font-size:11px;color:var(--text-light);width:44px">${esc((x.date || '').slice(5))}</span>
        <span style="height:10px;border-radius:5px;background:var(--primary);width:${Math.round((x.hours || 0) / max * 100)}%"></span>
        <span style="font-size:11px;color:var(--text-secondary)">${x.hours || '?'}h</span></div>`).join('')}</div></div>`
      + s.map(x => `<div class="entry"><div class="entry-head"><span>${esc(x.date)}</span><span>${esc(x.sleepTime)} → ${esc(x.wakeTime)}</span><span>${x.hours}h</span></div>${x.note ? `<div class="entry-body">${esc(x.note)}</div>` : ''}</div>`).join(''));
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function openCycle() {
  sheetLoading('生理期');
  try {
    const c = await rest('/api/health/cycle');
    if (!c.length) return sheetSet('<div class="empty">还没记过</div>');
    const sorted = [...c].sort((a, b) => b.date.localeCompare(a.date));
    const gaps = [];
    for (let i = 0; i + 1 < sorted.length; i++) { const g = daysBetween(sorted[i + 1].date, sorted[i].date); if (g > 10 && g < 60) gaps.push(g); }
    const avg = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null;
    const next = avg ? (() => { const d = new Date(sorted[0].date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + avg); return d.toISOString().slice(0, 10); })() : null;
    sheetSet(`<div class="card"><div class="card-title">上次 ${esc(sorted[0].date)}</div>
      <div class="card-desc">${avg ? `周期约 ${avg} 天 · 下次大概 ${next}` : '记录还不够算周期'}</div></div>`
      + sorted.map(x => `<div class="entry"><div class="entry-head">${esc(x.date)}</div><div class="entry-body">${esc(x.note || '')}</div></div>`).join(''));
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function openHealth() {
  sheetLoading('身体状况');
  try {
    const n = await rest('/api/health/notes');
    sheetSet(n.length ? n.map(x => `<div class="entry"><div class="entry-head">${esc(x.date)}</div><div class="entry-body">${esc(x.text)}</div></div>`).join('') : '<div class="empty">还没记</div>');
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function openShelf() {
  sheetLoading('书架');
  try {
    const b = await rest('/api/shelf');
    sheetSet(b.length ? b.map(x => `<div class="entry"><div class="entry-head"><span>${esc(x.author)}</span><span>${x.progress}/${x.totalChapters} 章</span>${x.finished ? '<span class="tag">读完了</span>' : ''}</div>
      <div class="card-title">${esc(x.title)}</div>
      <div style="height:6px;border-radius:3px;background:var(--primary-light);margin-top:8px"><div style="height:100%;border-radius:3px;background:var(--primary);width:${x.totalChapters ? Math.round(x.progress / x.totalChapters * 100) : 0}%"></div></div></div>`).join('') : '<div class="empty">书架是空的</div>');
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function openPhone() {
  sheetLoading('手机活动');
  try {
    const r = await mcp('get_phone_activity', { limit: 30 });
    sheetSet(Array.isArray(r) && r.length ? r.map(x => `<div class="entry"><div class="entry-head">${esc(fmtTime(x.opened_at))}</div><div class="entry-body">${esc(x.app_name)}</div></div>`).join('') : '<div class="empty">没有数据</div>');
  } catch (e) { sheetSet(`<div class="empty">读不到手机活动（服务器可能没配 Supabase）<br><span style="font-size:12px">${esc(e.message)}</span></div>`); }
}

// ================= 搜 =================
let searchMem = true;
function toggleMemSearch() { searchMem = !searchMem; const t = $('#s-toggle'); t.textContent = searchMem ? '开' : '关'; t.classList.toggle('on', searchMem); }
$('#s-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(e.target.value.trim()); });
async function doSearch(q) {
  if (!q) return;
  $('#s-body').innerHTML = '<div class="loading">搜索中…</div>';
  try {
    const [life, mem] = await Promise.all([searchLife(q), searchMem ? mcp('search_all', { query: q, limit: 10 }).catch(() => ({ results: [] })) : { results: [] }]);
    let h = '';
    if (life.length) h += '<div class="section-title">木屋结果</div>' + life.map(g => group(g.name, g.items.map(i => i.text)));
    if (mem.results && mem.results.length) {
      const gs = {};
      mem.results.forEach(x => { const k = x.label || CATNAME[x.category] || x.layer; (gs[k] = gs[k] || []).push(oneLine(x.text || x.excerpt || x.caption || '').slice(0, 70)); });
      h += '<div class="section-title">木纹记忆</div>' + Object.entries(gs).map(([k, v]) => group(k, v)).join('');
    }
    $('#s-body').innerHTML = h || '<div class="empty">没搜到</div>';
  } catch (e) { fail($('#s-body'), e); }
}
const CATNAME = { experience: '经历', agreement: '约定', feeling: '感受', learning: '学习', to_self: '给自己', unexplained: '说不清的', transcript: '原始记录', daily_summary: '每日总结' };
function group(title, items) {
  return `<div class="group"><div class="group-head" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
    <div class="group-title">${esc(title)}</div><div class="group-count">${items.length}条</div></div>
    <div class="group-items">${items.map(t => `<div class="group-item">${esc(t)}</div>`).join('')}</div></div>`;
}
async function searchLife(q) {
  const hit = s => String(s || '').toLowerCase().includes(q.toLowerCase());
  const out = [];
  const [sched, sleep, cyc, notes, shelf] = await Promise.all([
    rest('/api/schedule?includeInactive=1').catch(() => []), rest('/api/health/sleep').catch(() => []),
    rest('/api/health/cycle').catch(() => []), rest('/api/health/notes').catch(() => []), rest('/api/shelf').catch(() => [])
  ]);
  const add = (name, arr, fmt) => { const m = arr.filter(x => hit(fmt(x))); if (m.length) out.push({ name, items: m.map(x => ({ text: fmt(x) })) }); };
  add('日程', sched, x => `${x.date} ${x.time} ${x.text}`);
  add('睡眠', sleep, x => `${x.date} ${x.sleepTime}→${x.wakeTime} ${x.note || ''}`);
  add('生理期', cyc, x => `${x.date} ${x.note || ''}`);
  add('身体状况', notes, x => `${x.date} ${x.text}`);
  add('书架', shelf, x => `${x.title} ${x.author}`);
  return out;
}

// ================= 醒 =================
let wakeLoaded = false;
async function loadWake() {
  wakeLoaded = true;
  const node = $('#w-body');
  try {
    const w = await mcp('get_wake_status');
    let h = w.layers.map((l, i) => `<div class="section-title">第${['一', '二', '三'][i]}层 · ${esc(l.role)}</div>
      <div class="card"><div class="card-title">${esc(l.name)}</div>
        <div class="card-desc" style="margin-top:6px;line-height:1.6">${esc(l.desc)}</div>
        <div style="margin-top:10px;font-size:13px;font-weight:600;color:${l.connected ? 'var(--primary)' : 'var(--text-light)'}">状态：${esc(l.status)}</div>
        ${l.last_ping ? `<div class="card-desc">最近报到 ${esc(fmtTime(l.last_ping))}（${l.minutes_since} 分钟前）</div>` : ''}
        ${l.planned ? `<div class="card-desc">计划 ${l.planned.join('、') || '无'} · 已醒 ${l.done.join('、') || '无'}</div>` : ''}
        ${l.last_activity ? `<div class="card-desc">最近动作：${esc(oneLine(l.last_activity.text))}</div>` : ''}
      </div>`).join('');
    h += `<div class="section-title">手动排一次苏醒</div>
      <div class="card"><div class="card-desc">往今天的计划里加一个时刻，到点 Cowork 那边的检查会把它当成一次该处理的苏醒。</div>
      <div style="display:flex;gap:8px;margin-top:10px"><input type="text" id="wk-slot" placeholder="HH:MM" style="width:90px">
      <input type="text" id="wk-why" placeholder="想让他做什么（可选）"></div>
      <button class="btn" style="margin-top:10px" onclick="addWake()">加进去</button>
      <div id="wk-msg" style="margin-top:8px;font-size:13px;color:var(--text-light)"></div></div>`;
    if ((w.recent_wakes || []).length) {
      h += '<div class="section-title">最近苏醒</div>' + w.recent_wakes.map(r => `<div class="entry"><div class="entry-head"><span>${esc(fmtTime(r.at))}</span><span class="tag plain">${esc(r.action || '')}</span></div>${r.why ? `<div class="entry-body">${esc(r.why)}</div>` : ''}</div>`).join('');
    }
    h += `<div class="card" style="background:none;box-shadow:none;padding:12px 4px"><div class="card-desc">${esc(w.note || '')}</div></div>`;
    node.innerHTML = h;
  } catch (e) { fail(node, e); }
}
async function addWake() {
  const slot = $('#wk-slot').value.trim();
  if (!/^\d{2}:\d{2}$/.test(slot)) { $('#wk-msg').textContent = '时间要写成 HH:MM'; return; }
  $('#wk-msg').textContent = '…';
  try { const r = await mcp('add_wake_time', { slot, why: $('#wk-why').value.trim() }); $('#wk-msg').textContent = r.ok ? `加好了：${slot}` : (r.message || '没加成'); }
  catch (e) { $('#wk-msg').textContent = '失败：' + e.message; }
}

// ================= 设 =================
let setLoaded = false;
const COLOR_FIELDS = [
  ['primary', '主色'], ['accent', '点缀色'], ['bg', '底色'], ['card', '卡片背景'],
  ['text', '文字色'], ['textSecondary', '次要文字'], ['primaryLight', '主色浅'], ['accentLight', '点缀浅'], ['border', '描边']
];
const WALLPAPERS = [
  ['', '默认'], ['linear-gradient(135deg,#E8EAF0,#EDE7F0)', '薰衣草'], ['linear-gradient(135deg,#E4EBE8,#F0E8DF)', '森林'],
  ['linear-gradient(135deg,#F5EDE4,#FAECD8)', '暖阳'], ['linear-gradient(135deg,#E0E8F0,#D8E4F0)', '雨天']
];
function loadSettings() {
  setLoaded = true;
  const t = MW.loadTheme();
  $('#st-presets').innerHTML = Object.entries(THEMES).map(([k, v]) => `<div class="card tap" onclick="pickPreset('${k}')" style="${t.preset === k ? 'outline:2px solid var(--accent)' : ''}">
    <div style="display:flex;gap:5px;margin-bottom:8px">${['bg', 'primary', 'accent', 'text'].map(c => `<span style="width:20px;height:20px;border-radius:6px;background:${v.vars[c]};border:1px solid rgba(0,0,0,.08)"></span>`).join('')}</div>
    <div class="card-title" style="font-size:13px">${esc(v.label)}</div></div>`).join('');
  const cur = Object.assign({}, THEMES[t.preset].vars, t.custom);
  $('#st-colors').innerHTML = COLOR_FIELDS.map(([k, name]) => `<div class="card" style="display:flex;justify-content:space-between;align-items:center">
    <div class="card-title" style="font-size:14px">${name}</div>
    <input type="color" value="${cur[k]}" onchange="setColor('${k}',this.value)" style="width:44px;height:30px;border:none;background:none;padding:0;cursor:pointer">
  </div>`).join('');
  $('#st-wall').innerHTML = WALLPAPERS.map(([v, n]) => `<div onclick="setWall('${v}')" style="aspect-ratio:1;border-radius:12px;background:${v || 'var(--bg)'};border:2px solid ${t.ui.wallpaper === v ? 'var(--accent)' : 'var(--border)'};display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text-light);cursor:pointer">${n}</div>`).join('');
  $('#st-wall-url').value = /^https?:|^data:/.test(t.ui.wallpaper || '') ? t.ui.wallpaper : '';
  const sliders = [['radius', '圆角', 0, 28, 1, 'px'], ['fontSize', '字体大小', 13, 20, 1, 'px'], ['lineHeight', '行间距', 1.3, 2.2, 0.1, ''], ['opacity', '卡片不透明度', 40, 100, 5, '%'], ['blur', '导航模糊', 0, 30, 1, 'px']];
  $('#st-sliders').innerHTML = sliders.map(([k, n, min, max, step, unit]) => `<div class="card">
    <div style="display:flex;justify-content:space-between"><div class="card-title" style="font-size:14px">${n}</div><span id="sv-${k}" style="font-size:13px;color:var(--text-light)">${t.ui[k]}${unit}</span></div>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${t.ui[k]}" oninput="setUI('${k}',this.value,'${unit}')" style="width:100%;margin-top:8px"></div>`).join('');
}
function pickPreset(k) { const t = MW.loadTheme(); t.preset = k; t.custom = {}; MW.saveTheme(t); loadSettings(); }
function setColor(k, v) { const t = MW.loadTheme(); t.custom[k] = v; MW.saveTheme(t); }
function resetCustom() { const t = MW.loadTheme(); t.custom = {}; MW.saveTheme(t); loadSettings(); }
function setWall(v) { const t = MW.loadTheme(); t.ui.wallpaper = v; MW.saveTheme(t); loadSettings(); }
function setWallpaperUrl() { const t = MW.loadTheme(); t.ui.wallpaper = $('#st-wall-url').value.trim(); MW.saveTheme(t); loadSettings(); }
function setUI(k, v, unit) { const t = MW.loadTheme(); t.ui[k] = k === 'lineHeight' ? Number(v) : Number(v); MW.saveTheme(t); const s = $('#sv-' + k); if (s) s.textContent = v + (unit || ''); }
function resetAll() { localStorage.removeItem('muwen-theme'); MW.applyTheme(); loadSettings(); }

applyAvatars(); loadHome();
window.switchPage = switchPage; window.closeSheet = closeSheet;
