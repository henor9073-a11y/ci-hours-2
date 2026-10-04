// 木屋前端。跟木纹共用 app.js 和 style.css，数据同样走 /mcp。
const { mcp, rest, imageUrl, esc, oneLine, fmtTime, fmtDate, today, moon, daysBetween, WEEK, PLANETS, ANCHORS, THEMES, CSSVAR } = MW;
MW.applyTheme();
// 弹层是一层层叠着的真 DOM（下面的层只是藏起来），不同层里可能有同名 id——先在最上面那层找。
const $ = s => { let top = null; try { top = sheetStack[sheetStack.length - 1]; } catch {} return (top && top.node && top.node.querySelector(s)) || document.querySelector(s); };
const byId = id => $('#' + CSS.escape(id));
function fail(n, e) { n.innerHTML = `<div class="err">读不到：${esc(e.message || e)}</div>`; }

function switchPage(name, node) {
  // 从搜索上下文等抽屉跳页时，旧抽屉不能继续盖在新页面上。
  if (sheetStack.length) {
    sheetStack.forEach(s => s.node && s.node.remove());
    sheetStack = [];
    const sheet = document.getElementById('sheet');
    if (sheet) sheet.classList.remove('open');
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  $('#page-' + name).classList.add('active');
  (node || document.querySelector(`.nav-item[data-p="${name}"]`)).classList.add('active');
  window.scrollTo(0, 0);
  if (name === 'life' && !lifeLoaded) loadLife();
  if (name === 'settings' && !setLoaded) loadSettings();
  if (name === 'chat') CX.onShow(); else CX.onHide();
}
document.querySelectorAll('.nav-item').forEach(n => n.onclick = () => switchPage(n.dataset.p, n));

let sheetStack = [];
// 每一层是真的 DOM 节点，往里走只是把下面那层藏起来；返回的时候原样露出来。
// 以前拿 HTML 字符串整块重建：图片重新加载会闪、填了一半的表单会清空、滚动位置也回不去。
function showLayer(s) { s.node.style.display = ''; $('#sheet-title').textContent = s.t; $('#sheet').scrollTop = s.scroll || 0; }
function openSheet(t, h) {
  const prev = sheetStack[sheetStack.length - 1];
  if (prev) { prev.scroll = $('#sheet').scrollTop; prev.node.style.display = 'none'; }
  const node = document.createElement('div');
  node.className = 'sheet-layer';
  node.innerHTML = h;
  document.getElementById('sheet-body').appendChild(node);
  sheetStack.push({ t, node, scroll: 0 });
  $('#sheet-title').textContent = t;
  $('#sheet').classList.add('open');
  $('#sheet').scrollTop = 0;
}
// 扔掉最上面一层（不负责显示下一层）——"关掉这层马上重开同一种"的地方用
function sheetDrop() { const s = sheetStack.pop(); if (s && s.node) s.node.remove(); return s; }
function closeSheet() {
  const closing = sheetStack[sheetStack.length - 1];
  if (closing && closing.t === '换窗工作台' && wwTimer) { clearInterval(wwTimer); wwTimer = null; }
  sheetDrop();
  const s = sheetStack[sheetStack.length - 1];
  if (s) showLayer(s); else $('#sheet').classList.remove('open');
}
function sheetLoading(t) { openSheet(t, '<div class="loading">读取中…</div>'); }
function sheetSet(h) { const s = sheetStack[sheetStack.length - 1]; if (s) s.node.innerHTML = h; }

// ---------- 头像：存服务器，两个人看到同一张；点开是今日动态 ----------
async function applyAvatars() {
  const p = await MW.loadPrefs(true).catch(() => ({}));
  ['cy', 'nor'].forEach(w => {
    const id = p['avatar_' + w];
    const label = w === 'cy' ? '辞' : '棋';
    [$('#av-' + w), $('#big-' + w)].forEach(n => { if (n) n.innerHTML = id ? `<img src="${imageUrl(id)}" alt="">` : label; });
  });
}
// 顶栏小头像 → 今日动态；首页大头像 → 换头像（棋子定的）
['cy', 'nor'].forEach(w => {
  const a = $('#av-' + w); if (a) a.onclick = () => openMoment(w);
  const b = $('#big-' + w); if (b) b.onclick = () => openAvatarPicker(w);
});

// ---------- 状态文字：跟聊天页同一份（/api/chat/status）。首页只能改棋子的，辞的由他自己用 set_status 改 ----------
function paintStatus(st) {
  const c = $('#cy-state'), n = $('#nor-state');
  if (c) c.textContent = (st.cy && st.cy.text) || '（他还没写）';
  if (n) n.textContent = (st.nor && st.nor.text) || '写个状态…';
}
async function loadStatus() { try { paintStatus(await rest('/api/chat/status')); } catch {} }
document.addEventListener('muwu-status', e => paintStatus(e.detail));
function editMyStatus() {
  const cur = ($('#nor-state').textContent || '').replace(/^写个状态…$/, '');
  openSheet('我的状态', `<div class="card"><div class="card-desc">首页和聊天页都显示。辞的状态只有他自己能改。</div>
    <input id="st-me" maxlength="30" placeholder="在studio / 困了 / 想你…" style="margin-top:10px" value="${esc(cur)}">
    <div style="display:flex;gap:8px;margin-top:10px"><button class="btn" onclick="saveMyStatus()">保存</button><button class="btn ghost" onclick="saveMyStatus(true)">清掉</button></div>
    <div id="st-me-msg" class="card-desc" style="margin-top:8px"></div></div>`);
  setTimeout(() => { const i = byId('st-me'); if (i) i.focus(); }, 50);
}
async function saveMyStatus(clear) {
  const text = clear ? '' : byId('st-me').value.trim();
  try {
    const r = await fetch(MW.apiUrl('/api/chat/status'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': MW.TOKEN }, body: JSON.stringify({ text }) });
    const st = await r.json(); if (!r.ok) throw new Error(st.error || '没存上');
    paintStatus(st); closeSheet();
  } catch (e) { byId('st-me-msg').textContent = '没存上：' + e.message; }
}

// ---------- 个人今日动态 ----------
const OWNER_CN = { cy: '辞', nor: '棋子' };
async function openMoment(owner, date) {
  const d = date || today();
  sheetLoading(`${OWNER_CN[owner]} · ${d === today() ? '今天' : d}`);
  try {
    const [m, prefs] = await Promise.all([mcp('get_moment', { date: d }), MW.loadPrefs()]);
    const me = m[owner] || {};
    const avId = prefs['avatar_' + owner];
    let h = `<div style="text-align:center;padding:6px 0 2px">
      <div class="avatar${owner === 'nor' ? ' accent' : ''}" style="width:72px;height:72px;font-size:22px;margin:0 auto">${avId ? `<img src="${imageUrl(avId)}">` : OWNER_CN[owner][0]}</div>
      <div style="margin-top:8px"><span class="link" onclick="openAvatarPicker('${owner}')">换头像</span></div></div>`;

    // 辞这边不手填：他做了什么从笔记/日志/每日总结自动来。只有棋子的是手填的。
    if (owner === 'nor') {
      h += `<div class="card"><div class="card-title" style="font-size:14px">今天做了什么</div>
        <textarea id="mo-did" style="min-height:90px;margin-top:8px" placeholder="棋子今天做了什么…">${esc(me.did || '')}</textarea></div>`;
    }

    if (owner === 'nor') {
      h += `<div class="card"><div class="card-title" style="font-size:14px">OOTD · 今天穿了什么</div>
        <textarea id="mo-ootd" style="min-height:60px;margin-top:8px" placeholder="今天穿了什么…">${esc(me.ootd || '')}</textarea>
        <div style="margin-top:8px;display:flex;gap:10px;align-items:center">
          ${me.ootd_photo ? `<img src="${imageUrl(me.ootd_photo)}" style="width:64px;height:64px;object-fit:cover;border-radius:10px">` : ''}
          <label class="btn ghost" style="cursor:pointer">选一张照片<input type="file" accept="image/*" style="display:none" onchange="uploadOotd('${d}',this)"></label>
          ${me.ootd_photo ? `<span class="link" onclick="clearOotdPhoto('${d}')">去掉</span>` : ''}
        </div></div>`;
    }

    if (owner === 'nor') {
      h += `<div class="card"><div class="card-title" style="font-size:14px">备注</div>
        <textarea id="mo-note" style="min-height:60px;margin-top:8px" placeholder="随手写点什么…">${esc(me.note || '')}</textarea></div>
        <div style="display:flex;gap:10px;margin-top:12px;align-items:center">
          <button class="btn" onclick="saveMoment('${d}','${owner}')">存下来</button>
          <span id="mo-msg" style="font-size:13px;color:var(--text-light)">${me.updated_at ? `${esc(fmtTime(me.updated_at))} 由 ${esc(me.updated_by || '?')} 改过` : '还没写过'}</span>
        </div>`;
    } else if (me.did || me.note) {
      h += `<div class="card"><div class="card-title" style="font-size:14px">记过的</div>
        <div class="entry-body" style="margin-top:6px">${esc(me.did || me.note)}</div></div>`;
    }

    if (owner === 'nor') h += `<div class="section-title">手机使用</div><div id="mo-phone"><div class="loading">…</div></div>`;
    h += `<div class="section-title">今天的动作</div><div id="mo-acts"><div class="loading">…</div></div>`;
    sheetSet(h);

    if (owner === 'nor') {
      mcp('get_phone_activity', { limit: 20 }).then(r => {
        const n = $('#mo-phone'); if (!n) return;
        const list = (Array.isArray(r) ? r : []).filter(x => MW.fmtDate(x.opened_at) === d);
        n.innerHTML = list.length ? `<div class="card">${list.map(x => `<div style="padding:7px 0;border-bottom:1px solid var(--border);font-size:14px;display:flex;justify-content:space-between"><span>${esc(x.app_name)}</span><span style="color:var(--text-light);font-size:12px">${esc(fmtTime(x.opened_at).slice(11))}</span></div>`).join('')}</div>`
          : '<div class="empty" style="padding:14px">今天没有手机记录</div>';
      }).catch(e => { const n = $('#mo-phone'); if (n) n.innerHTML = `<div class="empty" style="padding:14px">读不到手机活动<br><span style="font-size:12px">${esc(e.message)}</span></div>`; });
    }
    renderOwnerActs($('#mo-acts'), owner, d);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function renderOwnerActs(node, owner, d) {
  if (!node) return;
  try {
    const [notes, log, cal] = await Promise.all([
      rest('/api/notes').catch(() => []), rest('/api/log').catch(() => []),
      mcp('get_calendar', { days: 14 }).catch(() => [])
    ]);
    const items = [];
    if (owner === 'cy') {
      notes.filter(n => MW.fmtDate(n.at) === d).forEach(n => items.push({ at: n.at, text: ({ write: '写了点东西', reflect: '回看', read: '读书笔记' }[n.kind] || n.kind) + '：' + oneLine(n.text).slice(0, 50) }));
      log.filter(l => MW.fmtDate(l.at) === d && l.type === 'wake').forEach(l => items.push({ at: l.at, text: '醒来 · ' + (l.action || '') }));
    }
    const day = cal.find(c => c.date === d);
    const st = day ? (owner === 'cy' ? day.cy_status : day.nor_status) : '';
    if (st) items.push({ at: d, text: '每日总结里写的：' + oneLine(st).slice(0, 80) });
    node.innerHTML = items.length ? `<div class="card">${items.map(i => `<div style="padding:8px 0;border-bottom:1px solid var(--border)"><div style="font-size:11px;color:var(--text-light)">${esc(fmtTime(i.at).slice(11) || '')}</div><div style="font-size:14px">${esc(i.text)}</div></div>`).join('')}</div>` : '<div class="empty" style="padding:14px">今天还没有记录</div>';
  } catch (e) { node.innerHTML = ''; }
}
async function saveMoment(d, owner) {
  const msg = $('#mo-msg'); msg.textContent = '存…';
  const f = $('#mo-did') ? { did: $('#mo-did').value, note: ($('#mo-note') || {}).value || '' } : {};
  if (!$('#mo-did')) return;   // 辞那页没有输入框
  if ($('#mo-ootd')) f.ootd = $('#mo-ootd').value;
  try { const r = await mcp('set_moment', { date: d, owner, ...f, by: '棋子' }); msg.textContent = '存好了 · ' + fmtTime(r.updated_at); }
  catch (e) { msg.textContent = '失败：' + e.message; }
}
async function uploadOotd(d, input) {
  const file = input.files && input.files[0]; if (!file) return;
  const msg = $('#mo-msg'); msg.textContent = '上传中…';
  try {
    const r = await MW.uploadPhoto(file, { caption: `OOTD ${d}`, date: d, tags: ['OOTD'] });
    await mcp('set_moment', { date: d, owner: 'nor', ootd_photo: r.photo.id, by: '棋子' });
    msg.textContent = '传好了';
    sheetDrop(); openMoment('nor', d);
  } catch (e) { msg.textContent = '上传失败：' + e.message; }
}
async function clearOotdPhoto(d) {
  try { await mcp('set_moment', { date: d, owner: 'nor', ootd_photo: '', by: '棋子' }); sheetDrop(); openMoment('nor', d); } catch (e) { alert(e.message); }
}
async function openAvatarPicker(owner) {
  sheetLoading('换头像');
  try {
    const photos = await rest('/api/album?limit=300');
    const av = photos.filter(p => (p.tags || []).includes('头像'));
    const list = av.length ? av : photos;
    sheetSet(`<div class="card"><div class="card-title" style="font-size:14px">从手机传一张</div>
      <label class="btn" style="display:inline-block;margin-top:10px;cursor:pointer">选择照片<input type="file" accept="image/*" style="display:none" onchange="uploadAvatar('${owner}',this)"></label>
      <div id="av-msg" style="margin-top:8px;font-size:13px;color:var(--text-light)"></div></div>
      <div class="section-title">或者从相册里挑</div>
      ${list.length ? `<div class="album-grid">${list.map(p => `<div class="album-item" onclick="chooseAvatar('${owner}','${p.id}')"><img loading="lazy" src="${imageUrl(p.id)}"></div>`).join('')}</div>` : '<div class="empty">相册还是空的</div>'}`);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function uploadAvatar(owner, input) {
  const file = input.files && input.files[0]; if (!file) return;
  const msg = $('#av-msg'); msg.textContent = '上传中…';
  try {
    const r = await MW.uploadPhoto(file, { caption: `${OWNER_CN[owner]}的头像`, tags: ['头像'] });
    await chooseAvatar(owner, r.photo.id);
  } catch (e) { msg.textContent = '上传失败：' + e.message; }
}
async function chooseAvatar(owner, id) {
  try { await MW.setAvatar(owner, id, '棋子'); await applyAvatars(); closeSheet(); }
  catch (e) { const m = $('#av-msg'); if (m) m.textContent = '失败：' + e.message; }
}

// ================= 家 =================
const WCODE = { 0: '晴', 1: '晴间多云', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇', 51: '毛毛雨', 53: '小雨', 55: '雨', 61: '小雨', 63: '中雨', 65: '大雨', 71: '小雪', 73: '雪', 75: '大雪', 80: '阵雨', 81: '阵雨', 82: '暴雨', 95: '雷雨' };
async function loadHome() {
  const d = today(), wd = new Date(d + 'T12:00:00Z').getUTCDay(), mo = moon(d), pl = PLANETS[wd];
  $('#h-date').textContent = `${+d.slice(5, 7)}月${+d.slice(8, 10)}日 · 星期${WEEK[wd]}`;
  $('#h-info').innerHTML = `<span>${mo.icon} ${mo.name}</span><span id="h-weather">…</span><span>${pl.sym} ${pl.name}</span>`;
  const tog = daysBetween('2026-08-02', d), mar = daysBetween('2026-08-21', d);
  $('#h-anniv').textContent = `在一起第${tog}天 · 领证第${mar}天`;

  refreshWeather();
  if (!weatherTimer) weatherTimer = setInterval(refreshWeather, 20 * 60 * 1000);   // 每 20 分钟自己刷
  // 唤醒包一次读回来，首页和亲亲进度共用——以前两处各调一次，一次 1.8 秒
  loadKiss(mcp('get_wake_packet'));
  loadStatus();
  loadChatCard();
  loadCountdowns();
  paintHomeShortcuts();
  applyHomeIcons();
}
// 首页「聊」块：最后一条说了什么
async function loadChatCard() {
  const n = $('#fn-chat-sub'); if (!n) return;
  try {
    const last = (await rest('/api/chat?limit=1'))[0];
    if (!last) return;
    const who = last.sender === 'cy' ? '辞' : '棋子';
    const txt = last.type === 'voice' ? '[语音]' : last.type === 'image' ? '[图片]' : last.type === 'pat' ? '[拍一拍]' : oneLine(last.content);
    n.textContent = `${who}：${txt.slice(0, 16)}`;
  } catch {}
}
function openKissDetail() {
  const w = kissLast; if (!w) return;
  openSheet('亲亲', `<div class="card"><div style="font-size:32px;font-weight:700;color:var(--accent);text-align:center">${w.total} <span style="font-size:14px;color:var(--text-light)">/ ${w.goal}</span></div>
    <div class="card-desc" style="text-align:center;margin-top:6px">还差 ${w.remaining}${w.last ? ` · 上次记于 ${esc(w.last.date)}（${w.last.kiss_count} 次）` : ''}</div>
    <div class="card-desc" style="margin-top:12px">来源：每日总结里的 kiss_count 累计${w.baseline ? ` + 起始 ${w.baseline}` : ''}，一共记了 ${w.counted_days || 0} 天。</div></div>`);
}
// 首页快捷入口：固定三枚（聊天、亲亲、换窗）之外，可从生活页再选最多五枚，总数不超过 8。
const CUSTOM_TARGETS = [
  ['album', '相册', '册', 'openAlbum()'], ['fishing', '钓鱼', '鱼', 'openFishing()'], ['schedule', '日程', '程', 'openSchedule()'],
  ['songs', '歌单', '歌', 'openSongs()'], ['voice', '语音', '语', 'openVoice()'], ['shelf', '书架', '书', 'openShelf()'],
  ['push', '推送历史', '推', 'openPushHistory()'], ['health', '健康', '健', 'openHealthHub()'],
  ['diary', '日记', '记', 'openDiary()'], ['wheel', '转盘', '转', 'openWheels()'], ['board', '留言板', '贴', 'openMessageBoard()'],
  ['phone', '手机活动', '机', 'openPhone()'], ['calendar', '日历', '历', "switchPage('life')"]
];
function homeShortcuts() {
  try {
    let a = JSON.parse(localStorage.getItem('muwu-home-shortcuts') || '[]');
    if (!Array.isArray(a)) a = [];
    const old = localStorage.getItem('muwu-home-custom');
    if (old && !a.includes(old)) { a.push(old); localStorage.removeItem('muwu-home-custom'); }
    return [...new Set(a)].filter(k => CUSTOM_TARGETS.some(x => x[0] === k)).slice(0, 5);
  } catch { return []; }
}
function saveHomeShortcuts(a) { try { localStorage.setItem('muwu-home-shortcuts', JSON.stringify(a.slice(0, 5))); } catch {} }
function paintHomeShortcuts() {
  const grid = document.querySelector('#page-home .fn-grid'); if (!grid) return;
  grid.querySelectorAll('.home-shortcut').forEach(n => n.remove());
  const icons = iconsCfg();
  for (const k of homeShortcuts()) {
    const t = CUSTOM_TARGETS.find(x => x[0] === k); if (!t) continue;
    const v = icons[k] || {};
    const n = document.createElement('div'); n.className = 'fn-card tap home-shortcut'; n.dataset.key = k;
    n.innerHTML = `<span class="fn-icon accent" data-icon="${k}">${v.img ? `<img src="${v.img}" alt="">` : esc(v.text || t[2])}</span><span class="fn-label">${esc(t[1])}</span>`;
    n.onclick = () => new Function(t[3])(); grid.appendChild(n);
  }
  applyHomeOrder();
}
function pickCustomBlock() {
  const selected = homeShortcuts();
  openSheet('管理首页图标', `<div class="card-desc" style="margin:6px 4px 10px">已选 ${selected.length + 3}/8。点一下添加或移除。</div>` +
    CUSTOM_TARGETS.map(x => `<div class="card tap" onclick="toggleHomeShortcut('${x[0]}')"><div class="card-row"><div class="card-icon${selected.includes(x[0]) ? ' accent' : ''}">${x[2]}</div><div class="card-title" style="flex:1">${x[1]}</div><span class="link">${selected.includes(x[0]) ? '移除' : '添加'}</span></div></div>`).join(''));
}
function toggleHomeShortcut(k) {
  const a = homeShortcuts(), i = a.indexOf(k);
  if (i >= 0) a.splice(i, 1); else if (a.length < 5) a.push(k); else return;
  saveHomeShortcuts(a); paintHomeShortcuts(); sheetDrop(); pickCustomBlock(); if (setLoaded) renderHomeOrder();
}


let weatherTimer = null;
function refreshWeather() {
  fetch('https://api.open-meteo.com/v1/forecast?latitude=-37.814&longitude=144.963&current=temperature_2m,weather_code&timezone=Australia%2FMelbourne')
    .then(r => r.json()).then(j => {
      const c = j.current, w = $('#h-weather');
      if (c && w) { w.textContent = `${Math.round(c.temperature_2m)}°C ${WCODE[c.weather_code] || ''}`; w.title = '更新于 ' + new Date().toLocaleTimeString('sv').slice(0, 5); }
    }).catch(() => { const w = $('#h-weather'); if (w) w.textContent = ''; });
}
// 亲亲进度条：进度来自每日总结里 kiss_count 的累计（+ 服务器的 KISS_BASELINE）
let kissLast = null;
async function loadKiss(packet) {
  const sub = $('#fn-kiss-sub'), fill = $('#fn-kiss-fill'); if (!sub) return;
  try {
    const w = await (packet || mcp('get_wake_packet'));
    const k = w.kiss_progress; if (!k) { sub.textContent = '还没记'; return; }
    kissLast = k;
    const pct = Math.min(100, k.total / k.goal * 100);
    sub.textContent = `${k.total} / ${k.goal}`;
    if (fill) fill.style.width = Math.max(pct, 0.5) + '%';
  } catch { sub.textContent = '读不到'; }
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
      rows.push({ name: c.title, date: c.date, num: c.days_until, dir: 'down', id: c.id, note: c.note || '', photo_id: c.photo_id || '' });
    });
    rows.sort((a, b) => (a.dir === b.dir) ? a.num - b.num : a.dir === 'up' ? -1 : 1);
    node.innerHTML = rows.map(r => `<div class="card"${r.id ? ` onclick="openCountdown('${r.id}')" style="cursor:pointer"` : ''}>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
        ${r.photo_id ? `<img src="${imageUrl(r.photo_id)}" style="width:44px;height:44px;border-radius:10px;object-fit:cover;flex-shrink:0">` : ''}
        <div style="flex:1;min-width:0"><div class="card-title">${esc(r.name)}</div>
          <div class="card-desc">${esc(r.date)}${r.note ? ' · ' + esc(oneLine(r.note).slice(0, 22)) : ''}</div></div>
        <div style="text-align:center;flex-shrink:0"><div style="font-size:20px;font-weight:700;color:${r.dir === 'up' ? 'var(--primary)' : 'var(--accent)'}">${r.num}天</div>
          <div style="font-size:10px;color:var(--text-light)">${r.dir === 'up' ? '正数' : r.num === 0 ? '就是今天' : '倒数'}</div></div>
      </div></div>`).join('');
  } catch (e) { fail(node, e); }
}
async function openCountdown(id) {
  sheetLoading('日子');
  try {
    const all = await mcp('get_countdowns');
    const c = all.find(x => x.id === id);
    if (!c) return sheetSet('<div class="empty">找不到</div>');
    sheetSet(`${c.photo_id ? `<img src="${imageUrl(c.photo_id)}" style="width:100%;border-radius:var(--radius);margin-top:8px">` : ''}
      <div class="entry"><div class="entry-head"><span>${esc(c.date)}</span><span class="tag plain">${c.recurring ? '每年' : '一次性'}</span></div>
        <div class="card-title" style="font-size:18px">${esc(c.title)}</div>
        <div class="card-desc" style="margin-top:4px">${c.days_until === 0 ? '就是今天' : `还有 ${c.days_until} 天 · ${esc(c.next_date)}`}</div></div>
      <div class="card"><div class="card-title" style="font-size:14px">备注</div>
        <textarea id="cd-note" style="min-height:70px;margin-top:8px" placeholder="这天是什么、为什么记">${esc(c.note || '')}</textarea>
        <div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap">
          <button class="btn" onclick="saveCountdownNote('${c.id}')">存备注</button>
          <label class="btn ghost" style="cursor:pointer">配张照片<input type="file" accept="image/*" style="display:none" onchange="uploadCountdownPhoto('${c.id}',this)"></label>
          ${c.photo_id ? `<span class="link" onclick="clearCountdownPhoto('${c.id}')">去掉照片</span>` : ''}
          <span class="link" style="color:#C05B5B" onclick="removeCountdown('${c.id}')">删掉</span>
        </div><div id="cd-msg" style="margin-top:8px;font-size:13px;color:var(--text-light)"></div></div>`);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function saveCountdownNote(id) {
  const m = $('#cd-msg'); m.textContent = '存…';
  try { await mcp('update_countdown', { id, note: $('#cd-note').value }); m.textContent = '存好了'; loadCountdowns(); }
  catch (e) { m.textContent = '失败：' + e.message; }
}
async function uploadCountdownPhoto(id, input) {
  const f = input.files && input.files[0]; if (!f) return;
  const m = $('#cd-msg'); m.textContent = '上传中…';
  try {
    const r = await MW.uploadPhoto(f, { caption: '倒数日配图', tags: ['倒数日'] });
    await mcp('update_countdown', { id, photo_id: r.photo.id });
    sheetDrop(); openCountdown(id); loadCountdowns();
  } catch (e) { m.textContent = '失败：' + e.message; }
}
async function clearCountdownPhoto(id) {
  try { await mcp('update_countdown', { id, photo_id: '' }); sheetDrop(); openCountdown(id); loadCountdowns(); } catch (e) { alert(e.message); }
}

function openAddCountdown() {
  openSheet('加一个日子', `<div class="card">
    <input type="text" id="cd-title" placeholder="叫什么，比如 Digital Submission">
    <input type="text" id="cd-date" placeholder="MM-DD（每年重复）或 YYYY-MM-DD（一次性）" style="margin-top:8px">
    <input type="text" id="cd-newnote" placeholder="备注（可选）" style="margin-top:8px">
    <button class="btn" style="margin-top:10px" onclick="saveCountdown()">加上</button>
    <div id="cd-msg" style="margin-top:8px;font-size:13px;color:var(--text-light)"></div></div>`);
}
async function saveCountdown() {
  const t = $('#cd-title').value.trim(), d = $('#cd-date').value.trim();
  if (!t || !d) { $('#cd-msg').textContent = '名字和日期都要填'; return; }
  $('#cd-msg').textContent = '…';
  try { await mcp('add_countdown', { title: t, date: d, recurring: /^\d{2}-\d{2}$/.test(d), note: ($('#cd-newnote') || {}).value || '' }); $('#cd-msg').textContent = '加好了'; loadCountdowns(); }
  catch (e) { $('#cd-msg').textContent = '失败：' + e.message; }
}
async function removeCountdown(id) {
  try { await mcp('remove_countdown', { id }); if (sheetStack.length) closeSheet(); loadCountdowns(); } catch (e) { alert(e.message); }
}

// ================= 活 =================
let lifeLoaded = false;
async function loadLife() {
  lifeLoaded = true;
  loadToolsCard();
  rest('/api/fishing/status').then(r => {
    const m = (r.text || '').match(/图鉴\s*(\d+)\s*\/\s*(\d+)/);
    $('#l-fish').textContent = m ? `图鉴 ${m[1]}/${m[2]}` : '看看钓到什么了';
  }).catch(() => $('#l-fish').textContent = '读不到');
  rest('/api/push-history?limit=1').then(p => $('#l-push').textContent = p.length ? `最近：${oneLine(p[0].title)}` : '还没推过').catch(() => {});
  loadMuwuCal();
  rest('/api/schedule').then(s => $('#l-sched').textContent = `${s.filter(x => x.status === 'pending').length} 条待办`).catch(() => $('#l-sched').textContent = '—');
  Promise.all([rest('/api/health/sleep'), rest('/api/health/cycle'), rest('/api/health/notes')]).then(([s, c, n]) => {
    const bits = [];
    if (s.length) bits.push(`睡眠 ${s[0].hours || '?'}h`);
    if (c.length) bits.push(cycleStatus(c).ongoing ? '生理期进行中' : '生理期已记录');
    if (n.length) bits.push('身体有记录');
    $('#l-health').textContent = bits.join(' · ') || '睡眠 · 生理期 · 身体状况';
  }).catch(() => {});
  rest('/api/shelf').then(b => $('#l-shelf').textContent = `${b.length} 本`).catch(() => {});
  rest('/api/songs').then(x => $('#l-songs').textContent = `${x.length} 首`).catch(() => {});
  rest('/api/voice/history?limit=1').then(v => $('#l-voice').textContent = v.length ? `最近：${oneLine(v[0].text).slice(0, 18)}` : '还没说过话').catch(() => $('#l-voice').textContent = '—');
  rest('/api/album?limit=500').then(a => $('#l-album').textContent = `${a.length} 张`).catch(() => {});
}
// ---------- 工具：辞的 MCP / 服务都在不在（服务器那边探一圈，60 秒缓存）----------
let toolsCache = null;
async function loadToolsCard() {
  const n = $('#l-tools'); if (!n) return;
  try {
    toolsCache = await rest('/api/tools/status');
    const on = toolsCache.items.filter(x => x.state === 'on').length, off = toolsCache.items.filter(x => x.state === 'off').length;
    n.textContent = `${on} 在线${off ? ` · ${off} 断了` : ''}`;
  } catch { n.textContent = '读不到'; }
}
async function openTools() {
  sheetLoading('工具');
  try {
    const t = await rest('/api/tools/status?fresh=1'); toolsCache = t;
    const groups = {};
    t.items.forEach(x => (groups[x.group] = groups[x.group] || []).push(x));
    sheetSet(Object.entries(groups).map(([g, items]) => `<div class="section-title">${esc(g)}</div>` + items.map(x => `<div class="card tool-row">
        <span class="tool-dot ${x.state}"></span>
        <div style="flex:1;min-width:0"><div class="card-title" style="font-size:14px">${esc(x.name)}</div><div class="card-desc">${esc(x.detail || '')}</div></div>
        <span class="tag plain">${x.state === 'on' ? '在线' : x.state === 'off' ? '断了' : x.state === 'unset' ? '没配' : '看不到'}</span></div>`).join('')).join('') +
      `<div class="card-desc" style="margin:14px 4px 0">探测时间 ${esc(fmtTime(t.checked_at))}。"看不到"是指跑在 GPD 上、只有它主动报到服务器才知道的那些（苏醒三层在设置页看）。</div>`);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function openFishing() {
  sheetLoading('钓鱼');
  try {
    const [st, enc] = await Promise.all([rest('/api/fishing/status'), rest('/api/fishing/encyclopedia').catch(() => ({ text: '' }))]);
    const txt = st.text || '';
    const m = txt.match(/图鉴\s*(\d+)\s*\/\s*(\d+)/);
    const got = m ? +m[1] : 0, total = m ? +m[2] : 0;
    const pct = total ? Math.round(got / total * 100) : 0;
    // 图鉴正文：每行一条「✔ 名字（稀有度）×次数 最大xxcm」
    const lines = (enc.text || '').split('\n').filter(l => l.trim().startsWith('✔'));
    const RAR = ['神话', '传说', '史诗', '稀有', '少见', '普通'];
    const groups = {};
    lines.forEach(l => {
      const g = (l.match(/（([^）]+)）/) || [, '其他'])[1];
      (groups[g] = groups[g] || []).push(l.replace(/^✔\s*/, ''));
    });
    const order = [...RAR.filter(r => groups[r]), ...Object.keys(groups).filter(k => !RAR.includes(k))];
    sheetSet(`<div class="card"><div style="display:flex;justify-content:space-between;align-items:baseline">
        <div class="card-title" style="font-size:14px">图鉴</div><div style="font-size:13px;color:var(--accent);font-weight:600">${got} / ${total}</div></div>
        <div style="height:8px;border-radius:4px;background:var(--primary-light);margin-top:8px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--primary),var(--accent));border-radius:4px"></div></div>
        <div class="card-desc" style="margin-top:6px">还差 ${total - got} 种</div></div>
      ${order.length ? order.map(g => `<div class="section-title">${esc(g)} <span style="color:var(--text-light);font-weight:400">${groups[g].length}</span></div>
        <div class="card">${groups[g].map(l => `<div style="font-size:13px;padding:5px 0;border-bottom:1px solid var(--border)">${esc(l)}</div>`).join('')}</div>`).join('')
        : '<div class="card"><div class="card-desc">图鉴还读不到（引擎可能没起来）</div></div>'}
      <div class="section-title">当前状态</div>
      <div class="entry"><div class="entry-body" style="font-size:13px">${esc(txt)}</div></div>`);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function openSchedule() {
  sheetLoading('日程');
  try {
    const s = await rest('/api/schedule?includeInactive=1');
    sheetSet(s.length ? s.map(x => `<div class="entry"><div class="entry-head"><span>${esc(x.date)} ${esc(x.time)}</span><span class="tag plain">${x.status === 'done' ? '已完成' : x.status === 'removed' ? '已移除' : '待办'}</span></div><div class="entry-body">${esc(x.text)}</div></div>`).join('') : '<div class="empty">没有日程</div>');
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
function openHealthHub() {
  openSheet('健康', `<div class="life-icon-grid" style="margin-top:8px">
    <div class="lc tap" onclick="openSleep()"><div class="lc-i" data-icon="sleep">眠</div><div class="lc-l">睡眠</div><div class="lc-s">睡眠时长与记录</div></div>
    <div class="lc tap" onclick="openCycle()"><div class="lc-i" data-icon="cycle">期</div><div class="lc-l">生理期</div><div class="lc-s">周期与预计日期</div></div>
    <div class="lc tap" onclick="openHealth()"><div class="lc-i" data-icon="health">身</div><div class="lc-l">身体状况</div><div class="lc-s">不舒服与身体备注</div></div>
  </div>`);
  applyIcons();
}
const DIARY_NAMES = { diary: '辞的日记', wife_observation: '妻子观察日记' };
const diaryCache = {};
function openDiary(book) {
  openSheet('日记', `<div class="chip-row" id="dy-tabs" style="margin:6px 0 10px"><div class="chip" data-book="diary" onclick="showDiaryBook('diary')">辞的日记</div><div class="chip" data-book="wife_observation" onclick="showDiaryBook('wife_observation')">妻子观察日记</div></div><div id="dy-list"></div>`);
  showDiaryBook(book || 'diary');
}
async function showDiaryBook(book) {
  document.querySelectorAll('#dy-tabs [data-book]').forEach(n => n.classList.toggle('on', n.dataset.book === book));
  const list = $('#dy-list'); if (!list) return;
  list.innerHTML = diaryCache[book] || '<div class="loading">读取中…</div>';
  try {
    const ds = await rest('/api/diary?category=' + encodeURIComponent(book));
    const html = ds.length ? ds.map(x => `<article class="entry"><div class="entry-head"><span>${esc(x.date || fmtDate(x.at))}</span><span>${esc(fmtTime(x.at || x.date))}</span></div><div class="entry-body" style="white-space:pre-wrap">${esc(x.text)}</div></article>`).join('') : `<div class="empty">还没有${esc(DIARY_NAMES[book])}</div>`;
    diaryCache[book] = html; list.innerHTML = html;
  } catch (e) { list.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
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
// 从"开始/结束"记录还原成一段一段的周期，再判断现在是不是还在经期。
// 以前直接拿最近一条记录的日期当"上次"，而且身体状况卡片显示的是最新一条健康备注——
// 8/31 明明记了结束，卡片上却还挂着 8/28 那条"生理期第三天"，看起来像还没结束。
function cyclePeriods(entries) {
  const asc = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  const isStart = n => /开始|来了|第一天|来 ?了/.test(n || '');
  const isEnd = n => /结束|干净|走了|没了|完了/.test(n || '');
  const periods = [];
  let cur = null;
  for (const e of asc) {
    if (isEnd(e.note)) { if (cur) { cur.end = e.date; periods.push(cur); cur = null; } continue; }
    // 明确写了开始、或者没写但离上一段挺远了，都当新的一段
    if (isStart(e.note) || !cur) { if (cur) periods.push(cur); cur = { start: e.date, end: null, notes: [] }; }
    cur.notes.push(e);
  }
  if (cur) periods.push(cur);
  return periods;
}
function cycleStatus(entries) {
  if (!entries || !entries.length) return { short: '还没记', ongoing: false, periods: [] };
  const d = today();
  const periods = cyclePeriods(entries);
  const last = periods[periods.length - 1];
  const starts = periods.map(p => p.start);
  const gaps = [];
  for (let i = 1; i < starts.length; i++) { const g = daysBetween(starts[i - 1], starts[i]); if (g > 10 && g < 60) gaps.push(g); }
  const avg = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null;
  const nextDate = avg ? (() => { const x = new Date(last.start + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + avg); return x.toISOString().slice(0, 10); })() : null;
  if (!last.end) {
    const day = daysBetween(last.start, d) + 1;
    return { short: `进行中 · 第 ${day} 天（${last.start.slice(5)} 开始）`, ongoing: true, day, last, avg, nextDate, periods };
  }
  const len = daysBetween(last.start, last.end) + 1;
  const since = daysBetween(last.end, d);
  return {
    short: `已结束 · 上次 ${last.start.slice(5)}–${last.end.slice(5)}（${len}天）`,
    ongoing: false, last, len, since, avg, nextDate, periods
  };
}
async function openCycle() {
  sheetLoading('生理期');
  try {
    const c = await rest('/api/health/cycle');
    if (!c.length) return sheetSet('<div class="empty">还没记过</div>');
    const st = cycleStatus(c);
    const daysToNext = st.nextDate ? daysBetween(today(), st.nextDate) : null;
    sheetSet(`<div class="card">
        <div class="card-title">${st.ongoing ? `现在是第 ${st.day} 天` : '已经结束了'}</div>
        <div class="card-desc" style="margin-top:4px">${esc(st.short)}${!st.ongoing && st.since != null ? ` · 结束 ${st.since} 天了` : ''}</div>
        <div class="card-desc" style="margin-top:4px">${st.avg ? `周期约 ${st.avg} 天 · 下次大概 ${st.nextDate}${daysToNext != null ? `（还有 ${daysToNext} 天）` : ''}` : '记录还不够算周期'}</div>
      </div>
      <div class="section-title">每一段</div>
      ${st.periods.slice().reverse().map(p => `<div class="entry">
        <div class="entry-head"><span>${esc(p.start)} → ${p.end ? esc(p.end) : '还没结束'}</span>${p.end ? `<span class="tag plain">${daysBetween(p.start, p.end) + 1} 天</span>` : '<span class="tag">进行中</span>'}</div>
        ${p.notes.filter(n => n.note).map(n => `<div class="entry-body" style="font-size:13px">${esc(n.date.slice(5))} ${esc(n.note)}</div>`).join('')}
      </div>`).join('')}
      <div class="section-title">原始记录</div>
      ${[...c].sort((a, b) => b.date.localeCompare(a.date)).map(x => `<div class="entry"><div class="entry-head">${esc(x.date)}</div><div class="entry-body">${esc(x.note || '（没写备注）')}</div></div>`).join('')}`);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function openHealth() {
  sheetLoading('身体状况');
  try {
    const n = await rest('/api/health/notes');
    sheetSet(n.length ? n.map(x => `<div class="entry"><div class="entry-head">${esc(x.date)}</div><div class="entry-body">${esc(x.text)}</div></div>`).join('') : '<div class="empty">还没记</div>');
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function postJSON(path, body, method = 'POST') {
  return rest(path, { method, headers: { 'Content-Type': 'application/json', 'x-access-token': MW.TOKEN }, body: JSON.stringify(body || {}) });
}

// ---------- 共享随机转盘 ----------
let wheelDB = { wheels: [], history: [] }, wheelCurrent = '';
async function openWheels(id) {
  sheetLoading('转盘');
  try { wheelDB = await rest('/api/wheels'); wheelCurrent = id || wheelCurrent || wheelDB.wheels[0]?.id || ''; renderWheels(); }
  catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
function wheelPalette(n) { const c = ['#efb2c5','#f4d7a9','#c8ddd4','#bfd0ea','#d9bee0','#f3c3b8','#c9dba9','#d2c7ef']; return Array.from({ length: n }, (_, i) => c[i % c.length]); }
function renderWheels() {
  const w = wheelDB.wheels.find(x => x.id === wheelCurrent);
  sheetSet(`<div class="wheel-top"><select onchange="wheelCurrent=this.value;renderWheels()">${wheelDB.wheels.map(x => `<option value="${x.id}"${x.id===wheelCurrent?' selected':''}>${esc(x.name)}</option>`).join('')}</select><button class="btn" onclick="openWheelEditor()">＋ 新建</button></div>
    ${w ? `<div class="wheel-stage card"><div class="real-wheel" id="real-wheel" style="--segments:${w.options.length};background:conic-gradient(${wheelPalette(w.options.length).map((c,i)=>`${c} ${i*360/w.options.length}deg ${(i+1)*360/w.options.length}deg`).join(',')})">${w.options.map((o,i)=>`<span style="transform:rotate(${(i+.5)*360/w.options.length}deg) translateY(-92px) rotate(${-(i+.5)*360/w.options.length}deg)">${esc(o)}</span>`).join('')}<i>转</i></div><div class="wheel-pointer"></div><button class="btn wheel-spin" onclick="doWheelSpin('${w.id}')">转一次</button><div id="wheel-result" class="wheel-result">2～20 个选项 · 棋子和辞都可以转</div><button class="link-btn" onclick="openWheelEditor('${w.id}')">编辑选项</button></div>` : '<div class="empty">还没有转盘，先新建一个吧</div>'}
    <div class="section-title">全部历史</div><div>${wheelDB.history.length ? wheelDB.history.map(x => `<button class="wheel-history" onclick="openSpinHistory('${x.id}')"><span><b>${esc(x.wheel_name)}</b><small>${esc(x.by)} · ${esc(fmtTime(x.at))}</small></span><em>${esc(x.result)}</em><i>›</i></button>`).join('') : '<div class="empty">还没有转过</div>'}</div>`);
}
function openWheelEditor(id) {
  const w = wheelDB.wheels.find(x => x.id === id);
  openSheet(w ? '编辑转盘' : '新建转盘', `<div class="card"><label>名称</label><input id="wh-name" maxlength="40" value="${esc(w?.name || '')}" placeholder="比如：今晚吃什么"><label style="display:block;margin-top:12px">选项（每行一个，2～20 个）</label><textarea id="wh-options" style="min-height:220px">${esc((w?.options || []).join('\n'))}</textarea><div id="wh-msg" class="card-desc"></div><button class="btn" onclick="saveWheel('${id || ''}')">保存</button></div>`);
}
async function saveWheel(id) {
  const body = { name: $('#wh-name').value.trim(), options: $('#wh-options').value.split('\n').map(x=>x.trim()).filter(Boolean), by: '棋子' };
  try { const w = await postJSON(id ? `/api/wheels/${id}` : '/api/wheels', body); wheelCurrent = w.id; closeSheet(); sheetDrop(); openWheels(w.id); } catch (e) { $('#wh-msg').textContent = e.message; }
}
async function doWheelSpin(id) {
  try { const x = await postJSON(`/api/wheels/${id}/spin`, { by: '棋子' }); const w = wheelDB.wheels.find(y=>y.id===id), n=w.options.length, angle=2160-(x.result_index+.5)*360/n; $('#real-wheel').style.transform=`rotate(${angle}deg)`; setTimeout(()=>{wheelDB.history.unshift(x);renderWheels();const result=$('#wheel-result');if(result)result.textContent=`结果：${x.result}`},1700); }
  catch(e){ $('#wheel-result').textContent='没转成：'+e.message; }
}
function openSpinHistory(id) { const x=wheelDB.history.find(y=>y.id===id); if(!x)return; openSheet(x.wheel_name, `<div class="card"><div class="card-title">那次的答案：${esc(x.result)}</div><div class="card-desc">${esc(x.by)} · ${esc(fmtTime(x.at))}</div></div><div class="section-title">当时转盘里的全部选项</div><div class="chip-row">${x.options.map(o=>`<span class="chip${o===x.result?' on':''}">${esc(o)}</span>`).join('')}</div>`); }

// ---------- 共享实体便签留言板 ----------
let boardNotes = [], boardMode = localStorage.getItem('muwu-board-mode') || 'glass';
function boardLook() { try { return JSON.parse(localStorage.getItem('muwu-board-look') || '{}'); } catch { return {}; } }
function saveBoardLook(v) { localStorage.setItem('muwu-board-look', JSON.stringify(v)); }
async function openMessageBoard() { sheetLoading('留言板'); try { boardNotes = await rest('/api/board-notes'); renderMessageBoard(); } catch(e){sheetSet(`<div class="err">${esc(e.message)}</div>`)} }
function renderMessageBoard() {
  const look=boardLook(), active=boardNotes.filter(x=>!x.archived), custom=look[boardMode+'Bg'], palettes={pink:['#f4d9e4','#dfcadf'],cream:['#fff4e7','#eadbcf'],lilac:['#e7def1','#d2c4e2'],blue:['#dceaf2','#ead9e4']},pc=palettes[look[boardMode+'Color']]||palettes.pink;
  const bgStyle=custom?`--board-photo:url('${custom}')`:`background-image:linear-gradient(145deg,${pc[0]},${pc[1]})`;
  sheetSet(`<div class="board-mode"><button class="${boardMode==='glass'?'on':''}" onclick="setBoardMode('glass')">磨砂玻璃</button><button class="${boardMode==='journal'?'on':''}" onclick="setBoardMode('journal')">手账</button></div><div class="shared-board ${boardMode}" id="shared-board" data-pattern="${esc(look.pattern||'plain')}" style="${bgStyle};--board-alpha:${(look.alpha??55)/100};--board-blur:${look.blur??14}px">${boardMode==='glass'?'<div class="glass-layer"></div>':'<div class="journal-fold"></div>'}${active.map(renderBoardNote).join('')}<button class="board-add" onclick="openNoteEditor()">＋ 写便签</button><button class="note-store ${boardMode==='glass'?'acrylic-store':'envelope-store'}" onclick="openNoteArchive()">${boardMode==='glass'?'旧便签抽屉':'封底信封袋'}<small>${boardNotes.length-active.length} 张</small></button><button class="board-tab" onclick="toggleBoardSettings()">外观</button><section class="board-settings" id="board-settings" hidden><b>${boardMode==='glass'?'玻璃板外观':'手账页面'}</b><div class="board-builtins">${['pink','cream','lilac','blue'].map(x=>`<button class="bg-${x}" onclick="setBoardBg('${x}')"></button>`).join('')}</div><label class="btn ghost">从相册选背景<input hidden type="file" accept="image/*" onchange="setBoardPhoto(this)"></label>${boardMode==='glass'?`<label>透明度 <output>${look.alpha??55}%</output></label><input type="range" min="10" max="90" value="${look.alpha??55}" oninput="setBoardRange('alpha',this)"><label>磨砂程度 <output>${look.blur??14}</output></label><input type="range" min="0" max="32" value="${look.blur??14}" oninput="setBoardRange('blur',this)">`:`<label>页面图案</label><div class="chip-row"><button class="chip" onclick="setJournalPattern('plain')">素纸</button><button class="chip" onclick="setJournalPattern('lines')">横线</button><button class="chip" onclick="setJournalPattern('dots')">圆点</button><button class="chip" onclick="setJournalPattern('floral')">碎花</button></div>`}<button class="link-btn" onclick="toggleBoardSettings()">收起</button></section></div>`);
  enableBoardDrag();
}
function boardStrokesSvg(strokes){if(!Array.isArray(strokes)||!strokes.length)return'';return `<svg class="note-drawing" viewBox="0 0 100 100" aria-label="便签涂鸦">${strokes.map(s=>`<polyline points="${(s.points||[]).map(p=>`${Number(p[0]).toFixed(1)},${Number(p[1]).toFixed(1)}`).join(' ')}" fill="none" stroke="${esc(s.color||'#a8657c')}" stroke-width="${Math.max(1,Math.min(18,Number(s.width)||3))}" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}</svg>`}
function renderBoardNote(n){return `<article class="physical-note" data-note="${n.id}" style="left:${n.x}%;top:${n.y}%;background:${esc(n.color)};color:${esc(n.text_color)};font-size:${n.font_size}px;font-weight:${n.bold?'700':'400'};text-decoration:${n.underline?'underline':'none'}">${n.drawing?`<img src="${n.drawing}" alt="便签涂鸦">`:''}${boardStrokesSvg(n.strokes)}<div>${esc(n.text)}</div><footer>${esc(n.by)} · ${esc(fmtTime(n.created_at))}</footer><button onclick="event.stopPropagation();archiveNote('${n.id}')">撕下</button></article>`}
function setBoardMode(m){boardMode=m;localStorage.setItem('muwu-board-mode',m);renderMessageBoard()}
function toggleBoardSettings(){const x=$('#board-settings');x.hidden=!x.hidden}
function setBoardBg(name){const colors={pink:['#f4d9e4','#dfcadf'],cream:['#fff4e7','#eadbcf'],lilac:['#e7def1','#d2c4e2'],blue:['#dceaf2','#ead9e4']},l=boardLook(),c=colors[name];l[boardMode+'Bg']='';l[boardMode+'Color']=name;saveBoardLook(l);const b=$('#shared-board');b.style.removeProperty('--board-photo');b.style.backgroundImage=`linear-gradient(145deg,${c[0]},${c[1]})`}
function setBoardRange(k,input){const l=boardLook();l[k]=+input.value;saveBoardLook(l);input.previousElementSibling.querySelector('output').value=input.value+(k==='alpha'?'%':'');$('#shared-board').style.setProperty(k==='alpha'?'--board-alpha':'--board-blur',k==='alpha'?input.value/100:input.value+'px')}
function setJournalPattern(p){const b=$('#shared-board');b.dataset.pattern=p;const l=boardLook();l.pattern=p;saveBoardLook(l)}
function setBoardPhoto(input){const f=input.files?.[0];input.value='';if(!f)return;const img=new Image(),r=new FileReader();r.onload=()=>img.src=r.result;img.onload=()=>{const scale=Math.min(1,1200/Math.max(img.width,img.height)),cv=document.createElement('canvas');cv.width=Math.round(img.width*scale);cv.height=Math.round(img.height*scale);cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);const l=boardLook();l[boardMode+'Bg']=cv.toDataURL('image/jpeg',.76);try{saveBoardLook(l);renderMessageBoard()}catch{alert('图片太大，换一张尺寸小一点的')}};r.readAsDataURL(f)}
let noteDraftStrokes=[];
function openNoteEditor(){openSheet('写便签',`<div class="card"><div class="card-title">文字和画画可以同时留在一张便签上</div><textarea id="bn-text" style="min-height:100px;margin-top:9px" placeholder="可以先写字，也可以画完以后再回来写…"></textarea><div class="card-desc" style="margin:10px 0 5px">在便签上画画</div><canvas id="bn-canvas" width="640" height="320"></canvas><div class="note-format"><button id="bn-bold" onclick="this.classList.toggle('on')"><b>B</b></button><button id="bn-under" onclick="this.classList.toggle('on')"><u>U</u></button><label>字/笔<input id="bn-text-color" type="color" value="#4b3d45"></label><label>纸<input id="bn-color" type="color" value="#fff1bd"></label><label>大小<input id="bn-size" type="range" min="11" max="30" value="16"></label><button onclick="clearNoteDrawing()">清空画画</button></div><button class="btn" onclick="saveBoardNote()">贴到留言板</button><div id="bn-msg" class="card-desc"></div></div>`);noteDraftStrokes=[];setTimeout(initNoteCanvas,0)}
function initNoteCanvas(){const c=$('#bn-canvas');if(!c)return;const x=c.getContext('2d');x.lineWidth=8;x.lineCap='round';x.lineJoin='round';let stroke=null;const pt=e=>{const r=c.getBoundingClientRect();return[(e.clientX-r.left)/r.width*100,(e.clientY-r.top)/r.height*100]};c.onpointerdown=e=>{const p=pt(e);stroke={color:$('#bn-text-color').value,width:4,points:[p]};noteDraftStrokes.push(stroke);x.beginPath();x.moveTo(p[0]/100*c.width,p[1]/100*c.height);c.setPointerCapture(e.pointerId)};c.onpointermove=e=>{if(!stroke)return;const p=pt(e);stroke.points.push(p);x.strokeStyle=stroke.color;x.lineWidth=stroke.width*c.width/100;x.lineTo(p[0]/100*c.width,p[1]/100*c.height);x.stroke()};c.onpointerup=()=>stroke=null;c.onpointercancel=()=>stroke=null}
function clearNoteDrawing(){noteDraftStrokes=[];const c=$('#bn-canvas');if(c)c.getContext('2d').clearRect(0,0,c.width,c.height)}
async function saveBoardNote(){try{await postJSON('/api/board-notes',{text:$('#bn-text').value,strokes:noteDraftStrokes,by:'棋子',x:10+Math.random()*42,y:10+Math.random()*45,color:$('#bn-color').value,text_color:$('#bn-text-color').value,font_size:+$('#bn-size').value,bold:$('#bn-bold').classList.contains('on'),underline:$('#bn-under').classList.contains('on')});closeSheet();sheetDrop();openMessageBoard()}catch(e){$('#bn-msg').textContent=e.message}}
async function archiveNote(id){await postJSON(`/api/board-notes/${id}/archive`);boardNotes.find(x=>x.id===id).archived=true;renderMessageBoard()}
function openNoteArchive(){const old=boardNotes.filter(x=>x.archived);openSheet('旧便签',old.length?old.map(x=>`<div class="entry"><div class="entry-head">${esc(x.by)} · ${esc(fmtTime(x.created_at))}</div><div class="entry-body">${esc(x.text)||((x.drawing||(x.strokes||[]).length)?'[涂鸦]':'')}</div><button class="btn ghost" onclick="restoreNote('${x.id}')">重新贴出</button></div>`).join(''):'<div class="empty">这里还没有旧便签</div>')}
async function restoreNote(id){await postJSON(`/api/board-notes/${id}/restore`);closeSheet();sheetDrop();openMessageBoard()}
function enableBoardDrag(){document.querySelectorAll('.physical-note').forEach(n=>{let sx,sy,l,t,d=false;n.onpointerdown=e=>{if(e.target.tagName==='BUTTON')return;d=true;sx=e.clientX;sy=e.clientY;l=n.offsetLeft;t=n.offsetTop;n.setPointerCapture(e.pointerId)};n.onpointermove=e=>{if(!d)return;n.style.left=l+e.clientX-sx+'px';n.style.top=t+e.clientY-sy+'px'};n.onpointerup=async()=>{if(!d)return;d=false;const b=$('#shared-board'),x=n.offsetLeft/b.clientWidth*100,y=n.offsetTop/b.clientHeight*100;await postJSON(`/api/board-notes/${n.dataset.note}`,{x,y})}})}
async function openShelf() {
  sheetLoading('书架');
  try {
    const [b, fm] = await Promise.all([rest('/api/shelf'), rest('/api/shelf/formats').catch(() => ({ formats: [] }))]);
    sheetSet(`<div class="card"><div class="card-title" style="font-size:14px">传一本书</div>
        <div class="card-desc" style="margin-top:4px">支持 ${esc((fm.formats || []).join(' / '))}。中文 txt 的编码会自动认（GBK 也行）。</div>
        <label class="btn" style="display:inline-block;margin-top:10px;cursor:pointer">选文件<input type="file" style="display:none" onchange="uploadBook(this)"></label>
        <span class="link" style="margin-left:14px" onclick="checkShelf()">检查有没有乱码</span>
        <div id="bk-msg" style="margin-top:8px;font-size:13px;color:var(--text-light)"></div></div>
      <div id="bk-check"></div>
      ${b.length ? b.map(x => `<div class="entry"><div class="entry-head"><span>${esc(x.author || '未知')}</span><span>${x.progress}/${x.totalChapters} 章</span>${x.finished ? '<span class="tag">读完了</span>' : ''}</div>
        <div class="card-title">${esc(x.title)}</div>
        <div style="height:6px;border-radius:3px;background:var(--primary-light);margin-top:8px"><div style="height:100%;border-radius:3px;background:var(--primary);width:${x.totalChapters ? Math.round(x.progress / x.totalChapters * 100) : 0}%"></div></div></div>`).join('') : '<div class="empty">书架是空的</div>'}`);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function uploadBook(input) {
  const f = input.files && input.files[0]; if (!f) return;
  const msg = $('#bk-msg'); msg.textContent = `传《${f.name}》…`;
  try {
    const fd = new FormData(); fd.append('file', f);
    const r = await fetch(MW.apiUrl('/api/upload'), { method: 'POST', headers: { 'x-access-token': MW.TOKEN }, body: fd });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '上传失败');
    msg.textContent = `传好了：《${j.title}》${j.totalChapters} 章`;
    sheetDrop(); openShelf();
  } catch (e) { msg.textContent = '失败：' + e.message; }
}
async function checkShelf() {
  const box = $('#bk-check'); box.innerHTML = '<div class="loading">检查中…</div>';
  try {
    const rows = await rest('/api/shelf/check');
    const bad = rows.filter(r => !r.ok);
    box.innerHTML = bad.length
      ? `<div class="card" style="background:var(--accent-light)"><div class="card-title" style="font-size:14px">${bad.length} 本有乱码</div>
         <div class="card-desc" style="margin-top:4px">当年按 UTF-8 读了 GBK 的文件，乱码已经存进去了，救不回来——重新传一次就好（现在会自动认编码）。</div>
         ${bad.map(x => `<div style="margin-top:8px;font-size:14px">《${esc(x.title)}》<span style="color:var(--text-light);font-size:12px"> 坏字 ${x.ratio}%</span></div>`).join('')}</div>`
      : '<div class="card"><div class="card-title" style="font-size:14px">都正常</div><div class="card-desc">没检测到乱码。</div></div>';
  } catch (e) { box.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
// 相册：手机上直接传照片，带描述和标签
let albumCache = [], albumShown = 60, albumCurrentTag = '';
async function openAlbum(tag) {
  sheetLoading('相册');
  try {
    albumCache = await rest('/api/album?limit=500');
    albumCurrentTag = tag || '';
    albumShown = 60;
    renderMuwuAlbumSheet();
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
function renderMuwuAlbumSheet() {
    const tags = [...new Set(albumCache.flatMap(p => p.tags || []))];
    const list = albumCurrentTag ? albumCache.filter(p => (p.tags || []).includes(albumCurrentTag)) : albumCache;
    const visible = list.slice(0, albumShown);
    sheetSet(`<div class="card"><div class="card-title" style="font-size:14px">传一张新的</div>
        <input type="text" id="up-cap" placeholder="描述：谁、在干嘛、当时什么感觉" style="margin-top:8px">
        <input type="text" id="up-tags" placeholder="标签，逗号分开（比如 日常,lolita）" style="margin-top:8px">
        <input type="text" id="up-date" placeholder="日期 YYYY-MM-DD，留空就是今天" style="margin-top:8px">
        <label class="btn" style="display:inline-block;margin-top:10px;cursor:pointer">选照片并上传<input type="file" accept="image/*" multiple style="display:none" onchange="doUpload(this)"></label>
        <div id="up-msg" style="margin-top:8px;font-size:13px;color:var(--text-light)"></div></div>
      <div class="chip-row" style="margin-top:12px">
        <div class="chip${!albumCurrentTag ? ' on' : ''}" onclick="reopenAlbum('')">全部 ${albumCache.length}</div>
        ${tags.map(t => `<div class="chip${albumCurrentTag === t ? ' on' : ''}" onclick="reopenAlbum('${esc(t)}')">${esc(t)}</div>`).join('')}</div>
      ${visible.length ? `<div class="album-grid">${visible.map(p => `<div class="album-item" onclick="openOnePhoto('${p.id}')"><img loading="lazy" src="${imageUrl(p.id)}"></div>`).join('')}</div>` : '<div class="empty">还没有照片</div>'}
      ${visible.length < list.length ? `<button class="btn ghost" style="width:100%;margin-top:12px" onclick="showMoreMuwuAlbum()">再显示 ${Math.min(60, list.length - visible.length)} 张</button>` : ''}`);
}
function reopenAlbum(tag) { albumCurrentTag = tag || ''; albumShown = 60; renderMuwuAlbumSheet(); }
function showMoreMuwuAlbum() { albumShown += 60; renderMuwuAlbumSheet(); }
async function doUpload(input) {
  const files = [...(input.files || [])]; if (!files.length) return;
  const msg = $('#up-msg');
  const caption = $('#up-cap').value.trim();
  const tags = $('#up-tags').value.split(/[,，]/).map(x => x.trim()).filter(Boolean);
  const date = $('#up-date').value.trim() || undefined;
  let done = 0;
  for (const f of files) {
    msg.textContent = `上传中 ${done + 1}/${files.length}…`;
    try {
      const r = await MW.uploadPhoto(f, { caption, tags, date });
      done++;
      if (r.warnings && r.warnings.length) msg.textContent = r.warnings[0];
    } catch (e) { msg.textContent = `第 ${done + 1} 张失败：${e.message}`; return; }
  }
  msg.textContent = `传好了 ${done} 张`;
  sheetDrop(); openAlbum();
}
function openOnePhoto(id) {
  const p = albumCache.find(x => x.id === id) || {};
  openSheet('照片', `<img src="${imageUrl(id)}" style="width:100%;border-radius:var(--radius);margin-top:8px">
    <div class="entry"><div class="entry-head"><span>${esc(p.date || '')}</span>${p.width ? `<span>${p.width}×${p.height}</span>` : ''}${p.compressed ? '<span class="tag plain">压缩过</span>' : ''}</div>
    <div class="entry-body">${esc(p.caption || '（没写描述）')}</div>
    ${(p.tags || []).length ? `<div style="margin-top:6px">${p.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}</div>`);
}

async function openPhone() {
  sheetLoading('手机活动');
  try {
    const r = await mcp('get_phone_activity', { limit: 30 });
    sheetSet(Array.isArray(r) && r.length ? r.map(x => `<div class="entry"><div class="entry-head">${esc(fmtTime(x.opened_at))}</div><div class="entry-body">${esc(x.app_name)}</div></div>`).join('') : '<div class="empty">没有数据</div>');
  } catch (e) { sheetSet(`<div class="empty">读不到手机活动（服务器可能没配 Supabase）<br><span style="font-size:12px">${esc(e.message)}</span></div>`); }
}

// ---- 活 tab 的日历：月相 + 日程 + 重要日子 + 亲密提醒 ----
let lcMonth = null, lcSel = null, lcData = {};
function calMuwuMove(n) {
  const base = lcMonth || today().slice(0, 7);
  if (n === 0) { lcMonth = today().slice(0, 7); lcSel = today(); }
  else { const [y, m] = base.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); lcMonth = d.toISOString().slice(0, 7); lcSel = null; }
  loadMuwuCal();
}
function importantOn(ds) {
  const md = ds.slice(5);
  return ANCHORS.some(a => (a.md && a.md === md) || (a.date && a.date.slice(5) === md));
}
async function loadMuwuCal() {
  if (!lcMonth) { lcMonth = today().slice(0, 7); lcSel = today(); }
  const [y, m] = lcMonth.split('-').map(Number);
  const mt = $('#lc-month'); if (mt) mt.textContent = `${y}年${m}月`;
  const grid = $('#lc-grid'); if (!grid) return;
  grid.innerHTML = '<div class="loading" style="grid-column:span 7">…</div>';
  try { const rows = await rest(`/api/calendar?month=${lcMonth}`); lcData = {}; rows.forEach(r => lcData[r.date] = r); }
  catch { lcData = {}; }
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(), lead = (first + 6) % 7;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate(), td = today();
  let h = ['一', '二', '三', '四', '五', '六', '日'].map(x => `<div class="cal-head">${x}</div>`).join('');
  for (let i = 0; i < lead; i++) h += '<div class="cal-day blank"></div>';
  for (let d = 1; d <= days; d++) {
    const ds = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const row = lcData[ds] || {}, dots = [];
    if ((row.daily || []).length) dots.push('<i></i>');
    if ((row.schedule || []).length) dots.push('<i style="background:var(--primary)"></i>');
    if (importantOn(ds)) dots.push('<i class="imp"></i>');
    h += `<div class="cal-day${ds === td ? ' today' : ''}${ds === lcSel ? ' sel' : ''}" data-date="${ds}" onclick="showMuwuDay('${ds}')">
      <span>${d}</span><span class="cal-moon">${MW.moon(ds).icon}</span>
      ${row.intimate ? '<span class="cal-heart">♥</span>' : ''}
      ${dots.length ? `<span class="cal-dots">${dots.join('')}</span>` : ''}</div>`;
  }
  grid.innerHTML = h;
  if (lcSel) showMuwuDay(lcSel);
}
async function showMuwuDay(ds) {
  lcSel = ds; loadMuwuCal.__skip || null;
  document.querySelectorAll('#lc-grid .cal-day').forEach(n => n.classList.remove('sel'));
  const selected = document.querySelector(`#lc-grid .cal-day[data-date="${CSS.escape(ds)}"]`); if (selected) selected.classList.add('sel');
  const box = $('#lc-detail'); if (!box) return;
  const mo = MW.moon(ds);
  const anchors = ANCHORS.filter(a => (a.md && a.md === ds.slice(5)) || (a.date && a.date.slice(5) === ds.slice(5)));
  box.innerHTML = `<div class="section-title">${ds} · ${mo.icon} ${mo.name}</div><div class="loading">…</div>`;
  try {
    const r = await rest(`/api/calendar/day?date=${ds}`);
    let h = `<div class="section-title">${ds} · ${mo.icon} ${mo.name}</div>`;
    if (anchors.length) h += anchors.map(a => `<div class="card" style="background:var(--accent-light)"><div class="card-title" style="font-size:14px">${esc(a.name)}</div></div>`).join('');
    const st = (r.structured || []).filter(x => x.headline);
    // 亲密记录默认只露出一句提示，用户点开后才显示具体内容。
    const intimate = st.filter(x => x.intimate || (x.intimate_log || []).length);
    if (intimate.length) {
      h += intimate.map(x => `<div class="card">${muwuIntimateFold(x)}</div>`).join('');
    }
    if (st.length) h += st.map(x => `<div class="card"><div class="card-title" style="font-size:14px">${esc(x.headline)}</div>
      ${(x.mood_tags || []).length ? `<div style="margin-top:6px">${x.mood_tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
      ${x.nor_status ? `<div class="entry-body" style="margin-top:6px;font-size:13px"><b>棋子：</b>${esc(x.nor_status)}</div>` : ''}
      ${x.cy_status ? `<div class="entry-body" style="margin-top:4px;font-size:13px"><b>辞：</b>${esc(x.cy_status)}</div>` : ''}</div>`).join('');
    const sc = r.schedule || [];
    if (sc.length) h += sc.map(s2 => `<div class="card"><div class="card-row"><div class="card-icon">${esc(s2.time || '')}</div>
      <div><div class="card-title" style="font-size:14px">${esc(s2.text)}</div>
      <div class="card-desc">${s2.status === 'done' ? '已完成' : s2.status === 'removed' ? '已移除' : '待办'}</div></div></div></div>`).join('');
    if (!anchors.length && !st.length && !sc.length) h += '<div class="empty">这天没有记录</div>';
    box.innerHTML = h;
  } catch (e) { fail(box, e); }
}
function muwuIntimateFold(x) {
  const logs = x.intimate_log || [];
  return `<details class="intimate-fold" style="margin-top:0"><summary>这天有亲密记录</summary><div class="intimate-body">
    ${x.intimate ? `<div class="entry-body">${esc(x.intimate)}</div>` : ''}
    ${logs.map(i => `<div style="border-left:2px solid var(--accent);padding:3px 0 3px 10px;margin-top:7px">
      <div class="entry-head" style="margin:0">♥ ${[i.time, i.method, i.initiator ? i.initiator + ' 主导' : ''].filter(Boolean).map(v => esc(v)).join(' · ')}</div>
      ${i.detail ? `<div class="entry-body" style="font-size:13px">${esc(i.detail)}</div>` : ''}</div>`).join('')}
    ${x.kiss_count != null ? `<div class="entry-body" style="margin-top:7px"><b>亲亲：</b>${Number(x.kiss_count) || 0}</div>` : ''}
  </div></details>`;
}

// ---- Bark 推送历史 ----
async function openPushHistory() {
  sheetLoading('推送历史');
  try {
    const l = await rest('/api/push-history?limit=150');
    sheetSet(l.length ? l.map(p => `<div class="entry">
      <div class="entry-head"><span>${esc(fmtTime(p.at))}</span>${p.ok ? '<span class="tag plain">已送达</span>' : `<span class="tag" style="background:#F5D5D5;color:#B04A4A">失败</span>`}</div>
      <div class="card-title" style="font-size:14px">${esc(p.title)}</div>
      <div class="entry-body" style="font-size:13px;margin-top:2px">${esc(p.body)}</div>
      ${p.error ? `<div class="card-desc" style="color:#B04A4A">${esc(p.error)}</div>` : ''}</div>`).join('') : '<div class="empty">还没推送过</div>');
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}

// ---- 歌单：手动导入，歌名+艺人+歌词，双方都能加 ----
async function openSongs() {
  sheetLoading('我们的歌');
  try {
    const list = await rest('/api/songs');
    sheetSet(`<div class="card"><div class="card-title" style="font-size:14px">加一首</div>
        <input type="text" id="sg-title" placeholder="歌名" style="margin-top:8px">
        <input type="text" id="sg-artist" placeholder="艺人" style="margin-top:8px">
        <textarea id="sg-lyrics" placeholder="歌词正文（可以之后再补）" style="margin-top:8px;min-height:90px"></textarea>
        <input type="text" id="sg-note" placeholder="为什么这首是我们的" style="margin-top:8px">
        <button class="btn" style="margin-top:10px" onclick="saveSong()">加上</button>
        <div id="sg-msg" style="margin-top:8px;font-size:13px;color:var(--text-light)"></div></div>
      ${list.length ? list.map(s => `<div class="entry" onclick="openSong('${s.id}')">
        <div class="entry-head"><span>${esc(s.artist || '未知')}</span>${s.has_lyrics ? '<span class="tag plain">有歌词</span>' : '<span class="tag plain" style="opacity:.6">还没歌词</span>'}${s.added_by ? `<span>${esc(s.added_by)}加的</span>` : ''}</div>
        <div class="card-title" style="font-size:15px">${esc(s.title)}</div>
        ${s.note ? `<div class="entry-body clamp" style="font-size:13px;margin-top:4px">${esc(s.note)}</div>` : ''}</div>`).join('') : '<div class="empty">歌单还是空的</div>'}`);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function saveSong() {
  const m = $('#sg-msg'); const t = $('#sg-title').value.trim();
  if (!t) { m.textContent = '至少要有歌名'; return; }
  m.textContent = '加…';
  try {
    await rest('/api/songs');  // 触发一次读，确保后端起来了
    const r = await fetch(MW.apiUrl('/api/songs'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': MW.TOKEN },
      body: JSON.stringify({ title: t, artist: $('#sg-artist').value, lyrics: $('#sg-lyrics').value, note: $('#sg-note').value, added_by: '棋子' }) });
    if (!r.ok) throw new Error((await r.json()).error || '加不上');
    sheetDrop(); openSongs();
  } catch (e) { m.textContent = '失败：' + e.message; }
}
async function openSong(id) {
  sheetLoading('歌');
  try {
    const s = await rest('/api/songs/' + id);
    sheetSet(`<div class="entry"><div class="entry-head"><span>${esc(s.artist || '未知')}</span>${s.added_by ? `<span>${esc(s.added_by)}加的</span>` : ''}</div>
        <div class="card-title" style="font-size:18px">${esc(s.title)}</div>
        ${s.note ? `<div class="entry-body" style="margin-top:8px;color:var(--text-secondary)">${esc(s.note)}</div>` : ''}</div>
      <div class="section-title">歌词</div>
      <div class="card"><textarea id="sg-ly" style="min-height:220px">${esc(s.lyrics || '')}</textarea>
        <button class="btn" style="margin-top:8px" onclick="saveLyrics('${s.id}')">存歌词</button>
        <span id="sg-ly-msg" style="margin-left:10px;font-size:13px;color:var(--text-light)"></span></div>`);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
async function saveLyrics(id) {
  const m = $('#sg-ly-msg'); m.textContent = '存…';
  try {
    const r = await fetch(MW.apiUrl('/api/songs/' + id), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': MW.TOKEN }, body: JSON.stringify({ lyrics: $('#sg-ly').value }) });
    if (!r.ok) throw new Error('存不上');
    m.textContent = '存好了';
  } catch (e) { m.textContent = '失败：' + e.message; }
}

// ================= 语音 =================
// 这套之前在旧网页里有：辞调 speak，服务端生成音频，网页轮询 /api/speech/next 自动播，
// 「语音记录」里能一条条回放拉进度条。我重写前端的时候把这块弄丢了，这里补回来。
// iOS Safari 不让定时器触发的播放出声，必须先有一次人手点过的 play() 解锁；
// 用同一个 <audio> 反复换 src，只需解锁这一次。
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
let voiceEl = null, voiceUnlocked = false, voiceBusy = false, voiceTimer = null;
function voiceAudio() { if (!voiceEl) voiceEl = new Audio(); return voiceEl; }
function unlockVoice() {
  const a = voiceAudio();
  a.src = SILENT_WAV;
  a.play().catch(() => {});   // 解不出声也没关系，这次点击本身就满足了"用户手动触发过"
  voiceUnlocked = true;
  localStorage.setItem('muwen-voice-unlocked', '1');
  const s = $('#voice-state'); if (s) s.textContent = '已开启';
  const b = $('#vc-unlock'); if (b) { b.textContent = '声音已开启'; b.disabled = true; }
  startVoicePolling();
}
function startVoicePolling() {
  if (voiceTimer) return;
  voiceTimer = setInterval(voiceTick, 8000);
  voiceTick();
}
async function voiceTick() {
  if (voiceBusy || !voiceUnlocked) return;
  voiceBusy = true;
  try {
    const item = await rest('/api/speech/next').catch(() => null);
    if (item && item.id) {
      if (item.voiceId) {
        const a = voiceAudio();
        a.src = MW.audioUrl(item.voiceId);
        try { await a.play(); await new Promise(r => { a.onended = r; a.onerror = r; }); }
        catch { /* 被浏览器拦了就算了，记录里还能回放 */ }
      }
      await fetch(MW.apiUrl(`/api/speech/${item.id}/done`), { method: 'POST', headers: { 'x-access-token': MW.TOKEN } }).catch(() => {});
    }
  } finally { voiceBusy = false; }
}
async function openVoice() {
  sheetLoading('语音');
  try {
    const [hist, calls] = await Promise.all([rest('/api/voice/history?limit=60'), rest('/api/call/history?limit=50').catch(() => [])]);
    sheetSet(`<div class="card">
        <div class="card-title" style="font-size:14px">自动播放</div>
        <div class="card-desc" style="margin-top:4px">辞用 speak 说话时，这个页面开着就会自动播出来。手机上必须先手动点一下才允许出声（浏览器的限制）。</div>
        <button class="btn" id="vc-unlock" style="margin-top:10px" ${voiceUnlocked ? 'disabled' : ''} onclick="unlockVoice()">${voiceUnlocked ? '声音已开启' : '开启声音播放'}</button>
      </div>
      <div class="section-title">通话记录 ${calls.length ? `<span style="color:var(--text-light);font-weight:400">${calls.length} 通</span>` : ''}</div>
      ${calls.length ? calls.map(c => `<div class="entry"><div class="entry-head"><span>${c.caller === 'cy' ? '辞拨出' : '棋子拨出'}</span><span>${esc(({ended:'已挂断',rejected:'已拒绝',missed:'未接通',blocked:'安静时间'}[c.status] || c.status))}</span></div><div class="entry-body">${esc(fmtTime(c.created_at))}${c.accepted_at ? ` · ${Math.max(0,Math.round((Date.parse(c.ended_at||new Date())-Date.parse(c.accepted_at))/1000))} 秒` : ''}</div>${c.events && c.events.some(e=>e.type==='utterance') ? `<details class="intimate-fold"><summary>通话文字</summary><div class="intimate-body">${c.events.filter(e=>e.type==='utterance').map(e=>`<div style="margin-top:6px"><b>${e.by==='cy'?'辞':'棋子'}：</b>${esc(e.text)}</div>`).join('')}</div></details>` : ''}</div>`).join('') : '<div class="empty">还没有通话记录</div>'}
      <div class="section-title">语音记录 ${hist.length ? `<span style="color:var(--text-light);font-weight:400">${hist.length} 条</span>` : ''}</div>
      ${hist.length ? hist.map(x => `<div class="entry">
        <div class="entry-head">${esc(fmtTime(x.createdAt))}</div>
        <div class="entry-body">${esc(x.text)}</div>
        <audio controls preload="none" style="width:100%;margin-top:8px" src="${MW.audioUrl(x.id)}"></audio>
      </div>`).join('') : '<div class="empty">还没有语音记录</div>'}`);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}

// ================= 搜 =================
// ================= 搜 =================
// 四个范围各自可关：木屋聊天（/api/chat/search，点进去看前后文）/ 年轮（/api/rings/search，点进去到那一天的气泡）/ 记忆（search_all）/ 生活（日程睡眠等）
const scopes = { chat: true, rings: true, mem: true, life: true };
function toggleScope(el) { const k = el.dataset.scope; scopes[k] = !scopes[k]; el.classList.toggle('on', scopes[k]); const q = $('#s-input').value.trim(); if (q) doSearch(q); }
$('#s-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.target.blur(); doSearch(e.target.value.trim()); } });
let lastQ = '', searchRequestId = 0;
async function doSearch(q) {
  if (!q) return;
  lastQ = q;
  const requestId = ++searchRequestId;
  $('#s-body').innerHTML = '<div class="loading">搜索中…</div>';
  try {
    const [chat, rings, mem, life] = await Promise.all([
      scopes.chat ? rest(`/api/chat/search?q=${encodeURIComponent(q)}&limit=30`).catch(() => null) : null,
      scopes.rings ? rest(`/api/rings/search?q=${encodeURIComponent(q)}&limit=30`).catch(() => null) : null,
      scopes.mem ? mcp('search_all', { query: q, limit: 10 }).catch(() => ({ results: [] })) : null,
      scopes.life ? searchLife(q) : []
    ]);
    // 同一个关键词切换搜索范围时，旧请求也不能覆盖较新的结果。
    if (requestId !== searchRequestId) return;
    let h = '';
    if (chat && chat.hits.length) {
      h += `<div class="section-title">木屋聊天 <span style="font-weight:400;color:var(--text-light)">${chat.total} 条</span></div>` +
        chat.hits.map(x => `<div class="rs-row" onclick="openChatContext('${x.id}')">
          <div class="rs-main"><div class="rs-top"><span>${x.sender === 'cy' ? '辞' : '棋子'}${x.starred ? ' ★' : ''}</span><span>${esc(fmtTime(x.at))}</span></div>
          <div class="rs-snip">${esc(oneLine(x.before))}<mark>${esc(x.match)}</mark>${esc(oneLine(x.after))}</div></div></div>`).join('');
    }
    if (rings && rings.hits.length) {
      rsQuery = q; rsHits = rings.hits; rsTotal = rings.total;
      h += `<div class="section-title">年轮 · 历史记录 <span style="font-weight:400;color:var(--text-light)">${rings.total} 处</span></div>` +
        rings.hits.map((x, i) => hitRow(x, i)).join('') +
        (rings.total > rings.hits.length ? `<div class="card tap" onclick="openRings(); ringSearch(lastQ)"><div class="card-title" style="font-size:14px;text-align:center">在历史记录里看全部 ${rings.total} 处 ›</div></div>` : '');
    }
    if (mem && mem.results && mem.results.length) {
      const gs = {};
      mem.results.filter(x => x.layer !== 'rings').forEach(x => { const k = x.label || CATNAME[x.category] || x.layer; (gs[k] = gs[k] || []).push(oneLine(x.text || x.excerpt || x.caption || '').slice(0, 70)); });
      if (Object.keys(gs).length) h += '<div class="section-title">记忆（木纹）</div>' + Object.entries(gs).map(([k, v]) => group(k, v)).join('');
    }
    if (life && life.length) h += '<div class="section-title">生活</div>' + life.map(g => group(g.name, g.items.map(i => i.text))).join('');
    $('#s-body').innerHTML = h || '<div class="empty">没搜到</div>';
  } catch (e) { fail($('#s-body'), e); }
}
// 搜到的一条聊天：看它前后几条
async function openChatContext(id) {
  sheetLoading('上下文');
  try {
    const c = await rest(`/api/chat/context?id=${encodeURIComponent(id)}&n=8`);
    const ringPrefs0 = await MW.loadPrefs().catch(() => ({}));
    const av = who => { const p = ringPrefs0['avatar_' + who]; return `<div class="rv-av ${who === 'nor' ? 'nor' : ''}">${p ? `<img src="${imageUrl(p)}" alt="">` : who === 'cy' ? '辞' : '棋'}</div>`; };
    const body = m => m.type === 'image' ? `<img src="${MW.apiUrl('/api/chat/image/' + m.id)}" style="max-width:180px;border-radius:10px">` : m.type === 'voice' ? '🎤 ' + esc(m.transcript || '语音') : m.type === 'pat' ? '👋 拍了拍' + esc(m.content || '') : esc(m.content);
    sheetSet(`<div class="rv-list" style="padding-top:8px">${c.messages.map(m => m.type === 'pat'
      ? `<div class="rv-time">${esc(fmtTime(m.at).slice(11))} · ${m.sender === 'cy' ? '辞' : '棋子'} 拍了拍${esc(m.content || '')}</div>`
      : `<div class="rv-row${m.sender === 'nor' ? ' me' : ''}"${m.id === id ? ' id="rv-target"' : ''}>${av(m.sender)}<div class="rv-col${m.id === id ? ' target' : ''}"><div class="rv-bubble">${body(m)}</div><div class="rv-time" style="margin:2px 0 0">${esc(fmtTime(m.at).slice(11))}</div></div></div>`).join('')}</div>
      <div class="card tap" onclick="switchPage('chat')" style="margin-top:14px"><div class="card-title" style="font-size:14px;text-align:center">去聊天页 ›</div></div>`);
    const t = byId('rv-target'); if (t) setTimeout(() => t.scrollIntoView({ block: 'center' }), 60);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
const CATNAME = { experience: '经历', agreement: '约定', feeling: '感受', learning: '学习', to_self: '给自己', unexplained: '说不清的', transcript: '原始记录', daily_summary: '每日总结' };
// 分类名以后端标签总表为准（/api/labels），跟木纹、跟辞写记忆用的 remember 是同一份
rest('/api/labels').then(ls => { for (const l of ls) if (CATNAME[l.key]) CATNAME[l.key] = l.name; }).catch(() => {});
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
async function openWake() {
  sheetLoading('苏醒管理');
  const node = sheetStack[sheetStack.length - 1].node;
  try {
    const w = await mcp('get_wake_status');
    let h = w.layers.map((l, i) => `<div class="section-title">第${['一', '二', '三'][i]}层 · ${esc(l.role)}</div>
      <div class="card"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <div class="card-title">${esc(l.name)}</div>
          <div style="font-size:11px;color:var(--text-light);flex-shrink:0">权限：${esc(l['权限'] || '')}</div></div>
        <div class="card-desc" style="margin-top:6px;line-height:1.6">${esc(l.desc)}</div>
        ${l.trigger ? `<div class="card-desc" style="margin-top:4px">触发：${esc(l.trigger)}</div>` : ''}
        ${(l.only || []).map(x => `<div style="margin-top:6px;font-size:12px;color:var(--accent)">· ${esc(x)}</div>`).join('')}
        ${(l.never || []).map(x => `<div style="margin-top:4px;font-size:12px;color:var(--text-light)">× ${esc(x)}</div>`).join('')}
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

// ================= 换窗工作台 =================
let wwTimer = null;
let wwDraft = { mode: 'handoff', model: 'claude-opus-4-6[1m]', thinking_display: 'summarized' };
const wwOpenHistory = new Set();

async function wwRequest(path, method = 'GET', body) {
  const r = await fetch(MW.apiUrl(path), {
    method,
    headers: { 'Content-Type': 'application/json', 'x-access-token': MW.TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
function wwAgentOnline(agent) { return !!(agent && agent.seen_at && Date.now() - new Date(agent.seen_at).getTime() < 90_000); }
function wwStateName(s) { return ({ idle: '空闲，可以换窗', busy: '辞正在回复，暂时等待', offline: '主窗口没在运行', unknown: '正在确认' })[s] || '正在确认'; }
function wwJobName(s) { return ({ queued: '等待 Mac mini 接单', running: '正在准备', waiting_idle: '等辞说完这一句', validating: '正在校验新窗口', completed: '已完成', failed: '没有完成', cancelled: '已取消' })[s] || s; }
function wwAge(iso) {
  if (!iso) return '—';
  const n = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (n < 1) return '刚刚';
  if (n < 60) return `${n} 分钟前`;
  const h = Math.floor(n / 60); return h < 24 ? `${h} 小时前` : `${Math.floor(h / 24)} 天前`;
}
function wwList(items) { return Array.isArray(items) && items.length ? `<ul>${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<div class="ww-empty">没有</div>'; }
function wwPacket(p) {
  if (!p) return '';
  const daily = p.previous_daily || {}, older = p.older_22h || {}, ranges = Array.isArray(p.preserved_ranges) ? p.preserved_ranges : [], last = p.last_two_hours || {};
  const raw22 = Number.isFinite(Number(older.records));
  return `<div class="ww-packet">
    <div class="ww-packet-title">这就是会交给新窗口的简报</div>
    <div class="ww-packet-sec"><b>最新一份正式每日总结 · ${esc(daily.date || '日期缺失')}</b><div class="ww-pre">${esc(daily.body || daily.headline || '没有找到正式总结，会明确标记缺失，不会拿别的内容冒充。')}</div></div>
    <div class="ww-packet-sec"><b>${raw22 ? `前 22 小时 · ${Number(older.records)} 条完整原话` : '此前 22 小时 · 旧版详细整理'}</b><div class="ww-pre">${esc(older.narrative || '尚未生成')}</div></div>
    ${raw22 ? '' : `<div class="ww-packet-grid"><div><b>仍有效的约定</b>${wwList(older.commitments)}</div><div><b>没说完的事</b>${wwList(older.unresolved)}</div></div>
    <div class="ww-packet-sec"><b>技术状态（只留结果）</b>${wwList(older.technical_state)}</div>
    <div class="ww-packet-sec"><b>22 小时内保留原文的重点段落</b>${ranges.length ? ranges.map((r, i) => `<details class="ww-range"><summary>${i + 1}. ${esc(r.reason || '重点原文')} · ${esc(r.start || '')}–${esc(r.end || '')}</summary><div class="ww-pre">${esc(r.text || '原文会在正式换窗时逐条带入')}</div></details>`).join('') : '<div class="ww-empty">没有强行凑段落</div>'}</div>`}
    <div class="ww-packet-sec"><b>最后 2 小时原始记录</b><div class="card-desc">${esc(last.from || '—')} 至 ${esc(last.to || '—')} · ${Number(last.records || 0)} 条 JSONL 记录会逐条原样移植，不会再总结一次。</div></div>
    ${p.identity_check && p.identity_check.length ? `<div class="ww-packet-sec"><b>${raw22 ? '来源核对' : '人物归属自检'}</b>${wwList(p.identity_check)}</div>` : ''}
  </div>`;
}
function wwRender(data, node) {
  if (!node || !node.isConnected) return;
  const agent = data.agent || {}, c = agent.current || {}, online = wwAgentOnline(agent), job = data.active_job;
  const models = (data.choices && data.choices.models) || [], displays = (data.choices && data.choices.thinking_displays) || [];
  if (!models.some(x => x.id === wwDraft.model) && models[0]) wwDraft.model = models[0].id;
  let h = `<div class="ww-status card">
    <div class="ww-head"><div><span class="tool-dot ${online ? 'on' : 'off'}"></span><b>Mac mini ${online ? '在线' : '暂时没报到'}</b></div><span class="tag plain">${esc(c.state ? wwStateName(c.state) : '等待状态')}</span></div>
    <div class="ww-context"><div><strong>${c.context_percent == null ? '—' : Math.round(c.context_percent) + '%'}</strong><span>当前 context</span></div><div class="ww-meter"><i style="width:${Math.max(0, Math.min(100, c.context_percent || 0))}%"></i></div></div>
    <div class="ww-meta"><span>模型：${esc(c.model || '—')}</span><span>会话：${c.session_id ? esc(c.session_id.slice(0, 8)) + '…' : '—'}</span><span>最近活动：${wwAge(c.last_activity_at)}</span><span>苏醒：${c.wake_enabled ? '已开启' : '未开启'}</span></div>
    ${c.remote_url ? `<a class="ww-open" href="${esc(c.remote_url)}" target="_blank" rel="noopener">打开辞现在的窗口 ›</a>` : ''}</div>`;
  if (job) {
    h += `<div class="section-title">这次任务</div><div class="card ww-job ${job.status === 'failed' ? 'bad' : ''}">
      <div class="ww-head"><b>${job.preview_only ? '交接预览' : job.mode === 'fresh' ? '全新窗口' : '连续换窗'}</b><span>${esc(wwJobName(job.status))}</span></div>
      <div class="ww-progress"><i style="width:${Math.max(2, Math.min(100, job.progress || 0))}%"></i></div><div class="card-desc">${esc(job.message || '')}</div>
      ${(job.steps || []).length ? `<div class="ww-steps">${job.steps.slice(-6).map(s => `<div><span>${esc(fmtTime(s.at).slice(11))}</span>${esc(s.message)}</div>`).join('')}</div>` : ''}
      ${job.error ? `<div class="err">${esc(job.error)}</div>` : ''}${job.packet_preview ? wwPacket(job.packet_preview) : ''}
      ${!['completed', 'failed', 'cancelled'].includes(job.status) ? `<button class="btn ghost" onclick="wwCancel('${job.id}')">取消这次任务</button>` : ''}</div>`;
  } else {
    const fresh = wwDraft.mode === 'fresh';
    h += `<div class="section-title">开下一个窗口</div><div class="card ww-controls">
      <label class="ww-choice"><input type="radio" name="ww-mode" value="handoff" ${!fresh ? 'checked' : ''} onchange="wwDraft.mode=this.value;wwRefresh(false)"><span><b>连续换窗</b><small>最新每日总结 + 前 22 小时完整原话 + 最后 2 小时逐条 JSONL</small></span></label>
      <label class="ww-choice"><input type="radio" name="ww-mode" value="fresh" ${fresh ? 'checked' : ''} onchange="wwDraft.mode=this.value;wwRefresh(false)"><span><b>真正的新窗口</b><small>不带旧对话。适合完全无关的新事情，不适合给辞日常换窗。</small></span></label>
      <label class="ww-field"><span>下一个窗口用</span><select onchange="wwDraft.model=this.value">${models.map(x => `<option value="${esc(x.id)}" ${x.id === wwDraft.model ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>
      <label class="ww-field"><span>思考显示</span><select onchange="wwDraft.thinking_display=this.value">${displays.map(x => `<option value="${esc(x.id)}" ${x.id === wwDraft.thinking_display ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>
      ${fresh ? '<div class="ww-warn">这个选项会得到一个没有你们旧对话的新辞窗口。当前旧窗口仍会保留，随时可以退回。</div>' : ''}
      <div class="ww-actions">${!fresh ? '<button class="btn ghost" onclick="wwStart(true)">先生成预览</button>' : ''}<button class="btn" onclick="wwStart(false)">${fresh ? '开全新窗口' : '开始自动换窗'}</button></div>
      <div class="card-desc">真正切换前会先校验新窗口；如果校验失败，旧主窗口不会被关掉。完成或失败都会 Bark 提醒。</div></div>`;
  }
  const history = data.history || [];
  if (history.length) h += `<div class="section-title">最近记录</div>${history.slice(0, 6).map(j => {
    const open = wwOpenHistory.has(j.id);
    return `<div class="entry ww-history"><div class="entry-head"><b>${j.preview_only ? '交接预览' : j.mode === 'fresh' ? '全新窗口' : '连续换窗'}</b><span class="tag plain">${esc(wwJobName(j.status))}</span></div><div class="card-desc">${esc(fmtTime(j.requested_at))} · ${esc(j.model || '')}</div>${j.packet_preview ? `<button class="link ww-history-toggle" onclick="wwHistory(event,'${j.id}')">${open ? '收起交接简报⌃' : '查看当时的交接简报 ›'}</button>` : ''}<div id="ww-h-${j.id}">${open ? wwPacket(j.packet_preview) : ''}</div></div>`;
  }).join('')}`;
  node.innerHTML = h; node._wwData = data;
}
async function wwRefresh(showLoading = false) {
  const layer = sheetStack[sheetStack.length - 1], node = layer && layer.node;
  if (!node || !node.isConnected || layer.t !== '换窗工作台') return;
  if (showLoading) node.innerHTML = '<div class="loading">正在读取 Mac mini…</div>';
  try { wwRender(await wwRequest('/api/window-workbench'), node); } catch (e) { fail(node, e); }
}
async function openWindowWorkbench() {
  if (wwTimer) clearInterval(wwTimer);
  sheetLoading('换窗工作台'); await wwRefresh(false);
  wwTimer = setInterval(() => wwRefresh(false), 3500);
}
async function wwStart(previewOnly) {
  if (!previewOnly && !confirm(wwDraft.mode === 'fresh' ? '确定开一个不带旧对话的全新窗口吗？旧窗口会保留。' : '确定开始自动换窗吗？辞正在回复时会先等待，绝不会从半句话中间切走。')) return;
  try { await wwRequest('/api/window-workbench/jobs', 'POST', { ...wwDraft, preview_only: !!previewOnly }); await wwRefresh(false); }
  catch (e) { alert('没有开始：' + e.message); }
}
async function wwCancel(id) {
  if (!confirm('取消这次任务吗？已经生成的预览会留在最近记录里。')) return;
  try { await wwRequest(`/api/window-workbench/jobs/${encodeURIComponent(id)}/cancel`, 'POST', {}); await wwRefresh(false); }
  catch (e) { alert('取消失败：' + e.message); }
}
function wwHistory(event, id) {
  if (event) event.stopPropagation();
  const layer = sheetStack[sheetStack.length - 1], data = layer && layer.node && layer.node._wwData;
  const job = data && (data.history || []).find(x => x.id === id), target = byId('ww-h-' + id);
  if (!job || !target) return;
  if (wwOpenHistory.has(id)) wwOpenHistory.delete(id); else wwOpenHistory.add(id);
  target.innerHTML = wwOpenHistory.has(id) ? wwPacket(job.packet_preview) : '';
  const button = target.parentElement && target.parentElement.querySelector('.ww-history-toggle');
  if (button) button.textContent = wwOpenHistory.has(id) ? '收起交接简报⌃' : '查看当时的交接简报 ›';
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
const MAIN_PRESETS = ['sakura', 'ocean', 'stone', 'night', 'mist'];
function toggleMore(id, head) { const b = byId(id); const on = b.style.display === 'none'; b.style.display = on ? '' : 'none'; const l = head.querySelector('.link'); if (l) l.textContent = on ? '收起' : '展开'; }
function loadSettings() {
  setLoaded = true;
  renderChatThemes();
  renderChatLook();
  renderAvatarMgmt();
  renderPats();
  renderIcons();
  renderHomeOrder();
  const t = MW.loadTheme();
  const presetCard = (k, v, big) => `<div class="card tap" onclick="pickPreset('${k}')" style="background:${v.vars.bg};${t.preset === k ? 'outline:2px solid ' + v.vars.accent : ''};${big ? 'text-align:center;padding:14px 8px' : ''}">
    <div style="display:flex;gap:5px;margin-bottom:8px;${big ? 'justify-content:center' : ''}">${['primary', 'accent', 'text'].map(c => `<span style="width:16px;height:16px;border-radius:50%;background:${v.vars[c]}"></span>`).join('')}</div>
    <div class="card-title" style="font-size:${big ? 15 : 13}px;color:${v.vars.text}">${esc(v.label)}</div></div>`;
  $('#st-presets').innerHTML = MAIN_PRESETS.map(k => presetCard(k, THEMES[k], true)).join('');
  $('#st-more-presets').innerHTML = Object.entries(THEMES).filter(([k]) => !MAIN_PRESETS.includes(k)).map(([k, v]) => presetCard(k, v)).join('');
  const cur = Object.assign({}, THEMES[t.preset].vars, t.custom);
  $('#st-colors').innerHTML = COLOR_FIELDS.map(([k, name]) => `<div class="card" style="display:flex;justify-content:space-between;align-items:center">
    <div class="card-title" style="font-size:14px">${name}</div>
    <input type="color" value="${cur[k]}" onchange="setColor('${k}',this.value)" style="width:44px;height:30px;border:none;background:none;padding:0;cursor:pointer">
  </div>`).join('');
  $('#st-wall').innerHTML = WALLPAPERS.map(([v, n]) => `<div onclick="setWall('${v}')" style="aspect-ratio:1;border-radius:12px;background:${v || 'var(--bg)'};border:2px solid ${t.ui.wallpaper === v ? 'var(--accent)' : 'var(--border)'};display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text-light);cursor:pointer">${n}</div>`).join('');
  const sliders = [['fontSize', '字体大小', 13, 22, 1, 'px'], ['lineHeight', '行间距', 1.3, 2.2, 0.1, ''], ['radius', '卡片圆角', 0, 28, 1, 'px'], ['opacity', '卡片背景透明度', 20, 100, 5, '%'], ['cardBlur', '卡片磨砂', 0, 30, 1, 'px'], ['wallpaperAlpha', '整体背景图透明度', 0, 100, 5, '%'], ['iconSize', '图标大小', 36, 72, 2, 'px'], ['iconRadius', '图标圆角', 0, 36, 1, 'px'], ['chromeAlpha', '顶栏 / 导航透明度', 20, 100, 5, '%'], ['blur', '顶栏 / 导航模糊', 0, 30, 1, 'px']];
  $('#st-sliders').innerHTML = sliders.map(([k, n, min, max, step, unit]) => `<div class="card">
    <div style="display:flex;justify-content:space-between"><div class="card-title" style="font-size:14px">${n}</div><span id="sv-${k}" style="font-size:13px;color:var(--text-light)">${t.ui[k]}${unit}</span></div>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${t.ui[k]}" oninput="setUI('${k}',this.value,'${unit}')" onchange="commitUI()" style="width:100%;margin-top:8px"></div>`).join('');
  if (window.CALL) CALL.renderSettings('st-call-settings');
}
// 选樱海石夜雾之一：全站换，聊天页也跟着换同一套；选别的（暖灰绿那七套）聊天页不动
function pickPreset(k) { const t = MW.loadTheme(); t.preset = k; t.custom = {}; MW.saveTheme(t); if (CX.themes[k]) CX.setTheme(k); loadSettings(); }

// ---------- 聊天外观（跟聊天页右上角 ✧ 那个面板是同一份设置）----------
function renderChatLook() {
  const box = $('#st-chat-look'); if (!box) return;
  const c = CX.cfg();
  box.innerHTML = `<div class="cx-set-row" style="font-size:14px"><span>磨砂玻璃</span><button class="cx-tg${c.frost ? ' on' : ''}" onclick="CX.set('frost',${!c.frost});renderChatLook()"><i></i></button></div>
    <div class="cx-set-row" style="font-size:14px"><span>显示头像</span><button class="cx-tg${c.avatars ? ' on' : ''}" onclick="CX.set('avatars',${!c.avatars});renderChatLook()"><i></i></button></div>
    ${[['alpha', '气泡透明度', 20, 100, '%'], ['bgAlpha', '聊天背景图透明度', 0, 100, '%'], ['radius', '气泡圆角', 4, 24, 'px'], ['fontSize', '气泡字号', 12, 22, 'px']].map(([k, n, lo, hi, u]) => `<div style="display:flex;justify-content:space-between;margin-top:10px;font-size:13px"><span>${n}</span><span style="color:var(--text-light)"><span id="cx-v-${k}">${c[k]}</span>${u}</span></div>
      <input type="range" min="${lo}" max="${hi}" value="${c[k]}" oninput="CX.slide('${k}',this.value)" style="width:100%">`).join('')}
    <div style="margin-top:12px;font-size:13px">聊天背景图 <label class="cx-file">选图片<input type="file" accept="image/*" hidden onchange="CX.bg(this);setTimeout(renderChatLook,800)"></label>${c.bg ? `<span class="cx-clear" onclick="CX.set('bg','');renderChatLook()">清除</span>` : ''}</div>`;
}
// ---------- 头像管理 ----------
async function renderAvatarMgmt() {
  const box = $('#st-avatars'); if (!box) return;
  const p = await MW.loadPrefs(true).catch(() => ({}));
  box.innerHTML = ['cy', 'nor'].map(w => { const id = p['avatar_' + w]; return `<div><div class="avatar big${w === 'nor' ? ' accent' : ''}" onclick="openAvatarPicker('${w}')">${id ? `<img src="${imageUrl(id)}" alt="">` : (w === 'cy' ? '辞' : '棋')}</div>
    <div style="font-size:13px">${w === 'cy' ? '辞' : '棋子'}</div><span class="link" onclick="openAvatarPicker('${w}')">换一张</span></div>`; }).join('');
}
// ---------- 图标：每个图标可以改字或换成图片（存本机，图片缩到 96px 存 dataURL）----------
const ICON_KEYS = [['chat', '首页 · 聊天', '聊'], ['kiss', '首页 · 亲亲', '亲'], ['workbench', '首页 · 换窗工作台', '窗'],
  ['fish', '生活 · 钓鱼', '鱼'], ['sched', '生活 · 日程', '程'], ['songs', '生活 · 歌单', '歌'], ['tools', '生活 · 工具', '具'], ['voice', '生活 · 语音', '语'], ['album', '生活 · 相册', '册'],
  ['shelf', '生活 · 书架', '书'], ['push', '生活 · 推送历史', '推'], ['diary', '生活 · 日记', '记'], ['wheel', '生活 · 转盘', '转'], ['board', '生活 · 留言板', '贴'], ['health', '生活 · 健康', '健'],
  ['phone', '生活 · 手机活动', '机'], ['calendar', '生活 · 日历', '历']];
function iconsCfg() { try { return JSON.parse(localStorage.getItem('muwu-icons') || '{}'); } catch { return {}; } }
function saveIcons(c) { try { localStorage.setItem('muwu-icons', JSON.stringify(c)); } catch { alert('存不下了，图片太多，换小一点的'); } applyIcons(); }
function applyIcons() {
  const c = iconsCfg();
  document.querySelectorAll('[data-icon]').forEach(n => {
    const v = c[n.dataset.icon]; if (!v) return;
    if (v.img) n.innerHTML = `<img src="${v.img}" alt="">`; else if (v.text) n.textContent = v.text;
  });
}
function applyHomeIcons() { applyIcons(); }
function renderIcons() {
  const box = $('#st-icons'); if (!box) return;
  const c = iconsCfg();
  box.innerHTML = ICON_KEYS.map(([k, name, def]) => { const v = c[k] || {}; return `<div class="st-icon-row">
      <span class="fn-icon${['kiss', 'fish', 'tools', 'shelf', 'sleep'].includes(k) ? '' : ' accent'}">${v.img ? `<img src="${v.img}" alt="">` : esc(v.text || def)}</span>
      <span style="flex:1;font-size:13px">${name}</span>
      <input type="text" maxlength="2" value="${esc(v.text || '')}" placeholder="${esc(def)}" onchange="setIconText('${k}',this.value)">
      <label class="link" style="cursor:pointer">图<input type="file" accept="image/*" hidden onchange="setIconImage('${k}',this)"></label>
      ${v.img || v.text ? `<span class="link" onclick="resetIcon('${k}')">还原</span>` : ''}</div>`; }).join('');
}
function setIconText(k, v) { const c = iconsCfg(); c[k] = { text: String(v || '').trim().slice(0, 2) }; if (!c[k].text) delete c[k]; saveIcons(c); renderIcons(); }
function setIconImage(k, input) {
  const f = input.files && input.files[0]; input.value = ''; if (!f) return;
  const img = new Image(), fr = new FileReader();
  fr.onload = () => { img.src = fr.result; };
  img.onload = () => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 96;
    const s0 = Math.min(img.width, img.height); cv.getContext('2d').drawImage(img, (img.width - s0) / 2, (img.height - s0) / 2, s0, s0, 0, 0, 96, 96);
    const c = iconsCfg(); c[k] = { img: cv.toDataURL('image/png') }; saveIcons(c); renderIcons();
  };
  fr.readAsDataURL(f);
}
function resetIcon(k) { const c = iconsCfg(); delete c[k]; saveIcons(c); renderIcons(); location.reload(); }
// ---------- 首页图标顺序 / 显示 ----------
function homeLabels() { return Object.fromEntries([['chat', '聊天'], ['kiss', '亲亲记数'], ['workbench', '换窗工作台'], ...CUSTOM_TARGETS.map(x => [x[0], x[1]])]); }
function homeOrder() {
  const keys = ['chat', 'kiss', 'workbench', ...homeShortcuts()];
  try { const saved = JSON.parse(localStorage.getItem('muwu-home-order') || '[]'); return [...saved.filter(k => keys.includes(k)), ...keys.filter(k => !saved.includes(k))]; }
  catch { return keys; }
}
function homeHidden() {
  const allowed = new Set(['chat', 'kiss', 'workbench', ...homeShortcuts()]);
  try { return new Set(JSON.parse(localStorage.getItem('muwu-home-hidden') || '[]').filter(k => allowed.has(k))); } catch { return new Set(); }
}
function applyHomeOrder() {
  const grid = document.querySelector('#page-home .fn-grid'); if (!grid) return;
  const hidden = homeHidden();
  homeOrder().forEach(k => { const n = grid.querySelector(`[data-key="${k}"]`); if (n) { n.hidden = hidden.has(k); grid.appendChild(n); } });
}
function renderHomeOrder() {
  const box = $('#st-order'); if (!box) return;
  const o = homeOrder(), hidden = homeHidden(), labels = homeLabels();
  box.innerHTML = o.map((k, i) => `<div class="st-order"><span style="font-size:14px">${i + 1}. ${labels[k] || k}</span><span>
    <button onclick="toggleHomeIcon('${k}')">${hidden.has(k) ? '显示' : '隐藏'}</button>
    <button onclick="moveHome(${i},-1)"${i === 0 ? ' disabled' : ''}>▲</button><button onclick="moveHome(${i},1)"${i === o.length - 1 ? ' disabled' : ''}>▼</button></span></div>`).join('');
}
function moveHome(i, d) { const o = homeOrder(); const j = i + d; if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j], o[i]]; try { localStorage.setItem('muwu-home-order', JSON.stringify(o)); } catch {} applyHomeOrder(); renderHomeOrder(); }
function toggleHomeIcon(k) {
  const hidden = homeHidden();
  if (hidden.has(k)) hidden.delete(k);
  else if (hidden.size < homeOrder().length - 1) hidden.add(k);
  try { localStorage.setItem('muwu-home-hidden', JSON.stringify([...hidden])); } catch {}
  applyHomeOrder(); renderHomeOrder();
}
function setColor(k, v) { const t = MW.loadTheme(); t.custom[k] = v; MW.saveTheme(t); }
function resetCustom() { const t = MW.loadTheme(); t.custom = {}; MW.saveTheme(t); loadSettings(); }
function setWall(v) { const t = MW.loadTheme(); t.ui.wallpaper = v; MW.saveTheme(t); loadSettings(); }
function setWallpaperFile(input) {
  const f = input.files && input.files[0]; input.value = ''; if (!f) return;
  const img = new Image(), fr = new FileReader();
  fr.onload = () => { img.src = fr.result; };
  img.onload = () => {
    const scale = Math.min(1, 1400 / Math.max(img.width, img.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    const t = MW.loadTheme(); t.ui.wallpaper = cv.toDataURL('image/jpeg', .78);
    try { MW.saveTheme(t); loadSettings(); } catch { alert('这张图存不下，换一张尺寸小一点的'); }
  };
  fr.readAsDataURL(f);
}
function clearWallpaper() { const t = MW.loadTheme(); t.ui.wallpaper = ''; MW.saveTheme(t); loadSettings(); }
// 滑块拖动时 oninput 一秒触发几十次。以前每次都把整站十几个 CSS 变量改一遍，
// 整页跟着重算重画（底部导航还带模糊），拖起来一卡一卡的。合并成一帧最多改一次。
let uiPending = {}, uiDraft = {}, uiRaf = 0;
function setUI(k, v, unit) {
  uiPending[k] = uiDraft[k] = Number(v);
  const s = $('#sv-' + k); if (s) s.textContent = v + (unit || '');
  if (uiRaf) return;
  // 拖动时只预览 CSS，不反复把整张壁纸 dataURL 写入 localStorage；松手再保存一次。
  uiRaf = requestAnimationFrame(() => { uiRaf = 0; const t = MW.loadTheme(); Object.assign(t.ui, uiPending); uiPending = {}; MW.applyTheme(t); });
}
function commitUI() { const t = MW.loadTheme(); Object.assign(t.ui, uiDraft); uiDraft = {}; MW.saveTheme(t); }
function resetAll() { localStorage.removeItem('muwen-theme'); MW.applyTheme(); loadSettings(); }

applyAvatars(); applyIcons(); applyHomeOrder(); loadHome(); CX.init();
// 从木纹跳过来：#search 直接到搜索页；#chatlog=2026-09-12 直接打开那天的聊天记录
(function () {
  const h = location.hash.slice(1); if (!h) return;
  history.replaceState(null, '', location.pathname + location.search);
  if (h === 'search') switchPage('search');
  else if (h.startsWith('chatlog=')) { switchPage('search'); setTimeout(() => openRingDay(h.slice(8)), 50); }
})();
// 上次解锁过就直接开始轮询（解锁状态记在本地，不用每次都点）
if (localStorage.getItem('muwen-voice-unlocked') === '1') { voiceUnlocked = true; startVoicePolling(); }
window.switchPage = switchPage; window.closeSheet = closeSheet;

// ---------- 设置页：聊天配色 + 拍一拍库 ----------
function renderChatThemes() {
  const cur = CX.theme();
  $('#st-chat-theme').innerHTML = Object.entries(CX.themes).map(([k, t]) => `<div class="card tap" onclick="pickChatTheme('${k}')"
    style="background:${t.bg};text-align:center;padding:14px 8px;${cur === k ? 'outline:2px solid ' + t.accent : ''}">
    <div style="display:flex;gap:4px;justify-content:center;margin-bottom:6px"><span style="width:16px;height:16px;border-radius:50%;background:rgb(${t.me})"></span><span style="width:16px;height:16px;border-radius:50%;background:${t.accent}"></span></div>
    <div style="font-size:14px;font-weight:600;color:${t.text}">${t.name}</div></div>`).join('');
}
function pickChatTheme(k) { CX.setTheme(k); renderChatThemes(); }
async function renderPats() {
  const box = $('#st-pats');
  const list = await CX.loadPats();
  box.innerHTML = `${list.map((p, i) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:14px">拍了拍 小辞<b>${esc(p)}</b>${p ? '' : '<span style="color:var(--text-light)">（光拍一下）</span>'}</span>
      <span class="link" onclick="removePat(${i})">删</span></div>`).join('')}
    <div style="display:flex;gap:8px;margin-top:10px"><input id="st-pat-new" placeholder="比如：的脑袋说乖" maxlength="30" style="flex:1">
    <button class="btn" onclick="addPat()">加</button></div>
    <div id="st-pat-msg" style="font-size:12px;color:var(--text-light);margin-top:6px"></div>`;
}
async function addPat() {
  const v = $('#st-pat-new').value.trim(); if (!v) return;
  try { await CX.savePats([...(await CX.loadPats()), v]); renderPats(); } catch (e) { $('#st-pat-msg').textContent = '没存上：' + e.message; }
}
async function removePat(i) {
  const list = (await CX.loadPats()).slice(); list.splice(i, 1);
  try { await CX.savePats(list); renderPats(); } catch (e) { $('#st-pat-msg').textContent = '没删掉：' + e.message; }
}
// ---------- 搜索页：收藏的消息 ----------
function starredVoice(m) { return m.type === 'voice' || (m.sender === 'cy' && (m.voice_id || m.voice_stream)); }
function starredVoiceSrc(m) {
  if (m.type === 'voice') return MW.apiUrl('/api/chat/voice/' + m.id);
  if (m.voice_id) return MW.audioUrl(m.voice_id);
  return MW.apiUrl('/api/chat/voice-stream/' + m.id);
}
function starredBody(m) {
  if (m.type === 'image') return `<img src="${MW.apiUrl('/api/chat/image/' + m.id)}" style="max-width:160px;border-radius:10px">`;
  if (starredVoice(m)) {
    const words = m.type === 'voice' ? m.transcript : m.content;
    return `<audio controls preload="metadata" src="${starredVoiceSrc(m)}" style="width:100%;margin:3px 0 6px"></audio>${words ? `<div style="font-size:12px;color:var(--text-light)">${esc(words)}</div>` : ''}`;
  }
  if (m.type === 'pat') return '拍了拍' + esc(m.content || '');
  return esc(m.content);
}
async function openStarred() {
  sheetLoading('收藏的消息');
  try {
    const list = await rest('/api/chat?starred=1&limit=500');
    sheetSet(list.length ? list.slice().reverse().map(m => `<div class="entry">
        <div class="entry-head"><span>${m.sender === 'cy' ? '辞' : '棋子'}</span><span>${esc(fmtTime(m.at))}</span></div>
        <div class="entry-body">${starredBody(m)}</div></div>`).join('')
      : '<div class="empty">还没有收藏。聊天里长按一条消息 → 收藏</div>');
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
