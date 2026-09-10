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
  if (name === 'chat') CX.onShow(); else CX.onHide();
}
document.querySelectorAll('.nav-item').forEach(n => n.onclick = () => switchPage(n.dataset.p, n));

let sheetStack = [];
function openSheet(t, h) { sheetStack.push({ t, h }); $('#sheet-title').textContent = t; $('#sheet-body').innerHTML = h; $('#sheet').classList.add('open'); $('#sheet').scrollTop = 0; }
function closeSheet() { sheetStack.pop(); if (sheetStack.length) { const s = sheetStack[sheetStack.length - 1]; $('#sheet-title').textContent = s.t; $('#sheet-body').innerHTML = s.h; } else $('#sheet').classList.remove('open'); }
function sheetLoading(t) { openSheet(t, '<div class="loading">读取中…</div>'); }
function sheetSet(h) { $('#sheet-body').innerHTML = h; if (sheetStack.length) sheetStack[sheetStack.length - 1].h = h; }

// ---------- 头像：存服务器，两个人看到同一张；点开是今日动态 ----------
async function applyAvatars() {
  const p = await MW.loadPrefs(true).catch(() => ({}));
  ['cy', 'nor'].forEach(w => {
    const id = p['avatar_' + w];
    const label = w === 'cy' ? '辞' : '棋';
    [$('#av-' + w), $('#big-' + w)].forEach(n => { if (n) n.innerHTML = id ? `<img src="${imageUrl(id)}" alt="">` : label; });
  });
}
['cy', 'nor'].forEach(w => {
  ['#av-' + w, '#big-' + w].forEach(sel => { const n = $(sel); if (n) n.onclick = () => openMoment(w); });
});

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
    sheetStack.pop(); openMoment('nor', d);
  } catch (e) { msg.textContent = '上传失败：' + e.message; }
}
async function clearOotdPhoto(d) {
  try { await mcp('set_moment', { date: d, owner: 'nor', ootd_photo: '', by: '棋子' }); sheetStack.pop(); openMoment('nor', d); } catch (e) { alert(e.message); }
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
  loadKiss();

  loadQuote(d);

  loadTodayActivity($('#h-activity'), 4);
  loadCountdowns();
  mcp('get_wake_packet').then(w => {
    if (w.nor_health) $('#nor-state').textContent = oneLine(w.nor_health.text).slice(0, 10);
    const p = w.today_plan || {};
    $('#cy-state').textContent = (p.pendingWakes || []).length ? '待醒 ' + p.pendingWakes[0] : (p.doneWakes || []).length ? '今天醒过' : '在线';
  }).catch(() => {});
}

// 今日一句：优先读辞最新写的那条（服务器每天 9:00 自动写一条 note(kind=write)）；
// 当天没写就从纹理里随机挑一条热度高的顶上。
async function loadQuote(d) {
  const node = $('#h-quote');
  try {
    const q = await mcp('get_daily_quote').catch(() => null);
    if (q && q.text && String(q.at || '').slice(0, 10) === d) {
      node.textContent = oneLine(q.text);
      node.title = '辞今天写的';
      return;
    }
    const gs = await mcp('search_grains', { limit: 60 });
    const hot = gs.filter(g => g.heat >= 55 && g.text.length < 220);
    const pool = hot.length ? hot : gs.filter(g => g.text.length < 300);
    if (!pool.length) { node.textContent = q && q.text ? oneLine(q.text) : '今天还没有话。'; return; }
    node.textContent = oneLine(pool[Math.floor(Math.random() * pool.length)].text).slice(0, 140);
    node.title = '从纹理里挑的（辞今天还没写）';
  } catch { node.textContent = ''; }
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
async function loadKiss() {
  const node = $('#h-kiss'); if (!node) return;
  try {
    const w = await mcp('get_wake_packet');
    const k = w.kiss_progress; if (!k) { node.innerHTML = ''; return; }
    const pct = Math.min(100, k.total / k.goal * 100);
    node.innerHTML = `<div class="card"><div style="display:flex;justify-content:space-between;align-items:baseline">
        <div class="card-title" style="font-size:14px">亲亲</div>
        <div style="font-size:13px;color:var(--accent);font-weight:600">${k.total} / ${k.goal}</div></div>
      <div style="height:8px;border-radius:4px;background:var(--primary-light);margin-top:8px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--primary),var(--accent));border-radius:4px"></div></div>
      <div class="card-desc" style="margin-top:6px">还差 ${k.remaining}${k.last ? ` · 上次记于 ${esc(k.last.date)}` : ''}${pct < 1 ? '' : ` · ${pct.toFixed(2)}%`}</div></div>`;
  } catch { node.innerHTML = ''; }
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
    sheetStack.pop(); openCountdown(id); loadCountdowns();
  } catch (e) { m.textContent = '失败：' + e.message; }
}
async function clearCountdownPhoto(id) {
  try { await mcp('update_countdown', { id, photo_id: '' }); sheetStack.pop(); openCountdown(id); loadCountdowns(); } catch (e) { alert(e.message); }
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
  loadTodayActivity($('#l-today'), 0);
  rest('/api/fishing/status').then(r => {
    const m = (r.text || '').match(/图鉴\s*(\d+)\s*\/\s*(\d+)/);
    $('#l-fish').textContent = m ? `图鉴 ${m[1]}/${m[2]}` : '看看钓到什么了';
  }).catch(() => $('#l-fish').textContent = '读不到');
  rest('/api/push-history?limit=1').then(p => $('#l-push').textContent = p.length ? `最近：${oneLine(p[0].title)}` : '还没推过').catch(() => {});
  loadMuwuCal();
  rest('/api/schedule').then(s => $('#l-sched').textContent = `${s.filter(x => x.status === 'pending').length} 条待办`).catch(() => $('#l-sched').textContent = '—');
  rest('/api/health/sleep').then(s => $('#l-sleep').textContent = s.length ? `昨晚 ${s[0].sleepTime}→${s[0].wakeTime}` : '还没记').catch(() => {});
  rest('/api/health/cycle').then(c => { $('#l-cycle').textContent = cycleStatus(c).short; }).catch(() => {});
  // 健康备注是"某天记过什么"，不是当前状态——带上日期，免得一条旧的看起来像今天的
  rest('/api/health/notes').then(n => $('#l-health').textContent = n.length ? `${n[0].date}：${oneLine(n[0].text).slice(0, 22)}` : '还没记').catch(() => {});
  rest('/api/shelf').then(b => $('#l-shelf').textContent = `${b.length} 本`).catch(() => {});
  rest('/api/songs').then(x => $('#l-songs').textContent = `${x.length} 首`).catch(() => {});
  rest('/api/voice/history?limit=1').then(v => $('#l-voice').textContent = v.length ? `最近：${oneLine(v[0].text).slice(0, 18)}` : '还没说过话').catch(() => $('#l-voice').textContent = '—');
  rest('/api/album?limit=500').then(a => $('#l-album').textContent = `${a.length} 张 · 点开可以传新的`).catch(() => {});
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
    sheetStack.pop(); openShelf();
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
let albumCache = [];
async function openAlbum(tag) {
  sheetLoading('相册');
  try {
    albumCache = await rest('/api/album?limit=500');
    const tags = [...new Set(albumCache.flatMap(p => p.tags || []))];
    const list = tag ? albumCache.filter(p => (p.tags || []).includes(tag)) : albumCache;
    sheetSet(`<div class="card"><div class="card-title" style="font-size:14px">传一张新的</div>
        <input type="text" id="up-cap" placeholder="描述：谁、在干嘛、当时什么感觉" style="margin-top:8px">
        <input type="text" id="up-tags" placeholder="标签，逗号分开（比如 日常,lolita）" style="margin-top:8px">
        <input type="text" id="up-date" placeholder="日期 YYYY-MM-DD，留空就是今天" style="margin-top:8px">
        <label class="btn" style="display:inline-block;margin-top:10px;cursor:pointer">选照片并上传<input type="file" accept="image/*" multiple style="display:none" onchange="doUpload(this)"></label>
        <div id="up-msg" style="margin-top:8px;font-size:13px;color:var(--text-light)"></div></div>
      <div class="chip-row" style="margin-top:12px">
        <div class="chip${!tag ? ' on' : ''}" onclick="reopenAlbum('')">全部 ${albumCache.length}</div>
        ${tags.map(t => `<div class="chip${tag === t ? ' on' : ''}" onclick="reopenAlbum('${esc(t)}')">${esc(t)}</div>`).join('')}</div>
      ${list.length ? `<div class="album-grid">${list.map(p => `<div class="album-item" onclick="openOnePhoto('${p.id}')"><img loading="lazy" src="${imageUrl(p.id)}"></div>`).join('')}</div>` : '<div class="empty">还没有照片</div>'}`);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
}
function reopenAlbum(tag) { sheetStack.pop(); openAlbum(tag || undefined); }
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
  sheetStack.pop(); openAlbum();
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
    h += `<div class="cal-day${ds === td ? ' today' : ''}${ds === lcSel ? ' sel' : ''}" onclick="showMuwuDay('${ds}')">
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
  const box = $('#lc-detail'); if (!box) return;
  const mo = MW.moon(ds);
  const anchors = ANCHORS.filter(a => (a.md && a.md === ds.slice(5)) || (a.date && a.date.slice(5) === ds.slice(5)));
  box.innerHTML = `<div class="section-title">${ds} · ${mo.icon} ${mo.name}</div><div class="loading">…</div>`;
  try {
    const r = await rest(`/api/calendar/day?date=${ds}`);
    let h = `<div class="section-title">${ds} · ${mo.icon} ${mo.name}</div>`;
    if (anchors.length) h += anchors.map(a => `<div class="card" style="background:var(--accent-light)"><div class="card-title" style="font-size:14px">${esc(a.name)}</div></div>`).join('');
    const st = (r.structured || []).filter(x => x.headline);
    // 亲密只给一句提醒，细节在木纹日历里看——木屋是生活面板不是记忆库
    const intimate = st.filter(x => x.intimate || (x.intimate_log || []).length);
    if (intimate.length) {
      h += intimate.map(x => `<div class="card"><div class="card-row"><div class="card-icon accent">♥</div>
        <div><div class="card-title" style="font-size:14px">这天有亲密记录</div>
        <div class="card-desc">${esc(oneLine(x.intimate || '') || `${x.intimate_log.length} 条`)}${x.kiss_count != null ? ` · 亲亲 ${x.kiss_count}` : ''}</div></div></div></div>`).join('');
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
    sheetStack.pop(); openSongs();
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
    const hist = await rest('/api/voice/history?limit=60');
    sheetSet(`<div class="card">
        <div class="card-title" style="font-size:14px">自动播放</div>
        <div class="card-desc" style="margin-top:4px">辞用 speak 说话时，这个页面开着就会自动播出来。手机上必须先手动点一下才允许出声（浏览器的限制）。</div>
        <button class="btn" id="vc-unlock" style="margin-top:10px" ${voiceUnlocked ? 'disabled' : ''} onclick="unlockVoice()">${voiceUnlocked ? '声音已开启' : '开启声音播放'}</button>
      </div>
      <div class="section-title">说过的话 ${hist.length ? `<span style="color:var(--text-light);font-weight:400">${hist.length} 条</span>` : ''}</div>
      ${hist.length ? hist.map(x => `<div class="entry">
        <div class="entry-head">${esc(fmtTime(x.createdAt))}</div>
        <div class="entry-body">${esc(x.text)}</div>
        <audio controls preload="none" style="width:100%;margin-top:8px" src="${MW.audioUrl(x.id)}"></audio>
      </div>`).join('') : '<div class="empty">还没有语音记录</div>'}`);
  } catch (e) { sheetSet(`<div class="err">${esc(e.message)}</div>`); }
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

applyAvatars(); loadHome(); CX.init();
// 上次解锁过就直接开始轮询（解锁状态记在本地，不用每次都点）
if (localStorage.getItem('muwen-voice-unlocked') === '1') { voiceUnlocked = true; startVoicePolling(); }
window.switchPage = switchPage; window.closeSheet = closeSheet;
