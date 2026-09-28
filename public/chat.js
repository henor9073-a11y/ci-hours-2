// 木屋聊天页。棋子发的消息几秒内送进辞的 Code 窗口（GPD 上的语音频道来取），辞用 chat_reply 回。
// 布局照木屋 mockup：顶上辞的头像/名字/状态，中间微信式气泡（左辞右棋子），底下两行输入栏。
//
// 性能上几条规矩（以前卡、跳都出在这）：
//   · 外壳只建一次；每条消息是一个独立的 DOM 节点，新消息只追加、状态变了只换那一条，不整块重画
//   · 一开始只拉最近 40 条，往上滑到顶再一页页加载（以前一次拉 300 条全画）
//   · 只有本来就停在底部才跟着滚；图片加载完撑高了也只在"停在底部"时补滚，不把往上翻的人拽下来
//   · 外观（主题/圆角/字号/透明度/磨砂）全走 CSS 变量，拖滑块不重画气泡
(function () {
  const { rest, esc, fmtTime, imageUrl, apiUrl, TOKEN } = MW;
  const $ = s => document.querySelector(s);
  const post = (p, body) => fetch(apiUrl(p), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': TOKEN }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; });

  // 聊天配色（樱海石夜雾）。选择在设置页，这里只负责上色。
  const THEMES = {
    sakura: { name: '樱', bg: 'linear-gradient(135deg,#fef7fa,#fdf0f5 30%,#fcecf2 60%,#fef7fa)', ai: '255,255,255', me: '235,200,215', text: '#5a4a55', accent: '#c9a0b2', time: '#cdbdc5', head: 'rgba(255,255,255,.45)', nameC: '#a88a98', thinkBg: 'rgba(200,170,185,.08)', thinkBd: 'rgba(200,170,185,.18)', panel: 'rgba(255,255,255,.96)' },
    ocean: { name: '海', bg: 'linear-gradient(135deg,#f0f6f8,#e6f0f5 30%,#dfedf2 60%,#f0f6f8)', ai: '255,255,255', me: '185,215,228', text: '#3d5562', accent: '#89b0c2', time: '#b0c5d0', head: 'rgba(255,255,255,.45)', nameC: '#7a9aaa', thinkBg: 'rgba(137,176,194,.07)', thinkBd: 'rgba(137,176,194,.14)', panel: 'rgba(255,255,255,.96)' },
    stone: { name: '石', dark: 1, bg: 'linear-gradient(135deg,#3d3d48,#383844 30%,#34343f 60%,#3d3d48)', ai: '255,255,255', aiA: .07, me: '160,165,200', meA: .16, text: '#cdccd8', accent: '#9a9ec4', time: '#6e6e82', head: 'rgba(255,255,255,.04)', nameC: '#9898b0', thinkBg: 'rgba(154,158,196,.07)', thinkBd: 'rgba(154,158,196,.12)', panel: 'rgba(48,48,60,.97)' },
    night: { name: '夜', dark: 1, bg: 'linear-gradient(135deg,#1c1c30,#181830 30%,#1a1a2e 60%,#141428)', ai: '255,255,255', aiA: .07, me: '120,122,200', meA: .18, text: '#d8d6e2', accent: '#a0a4d4', time: '#5a5a72', head: 'rgba(255,255,255,.04)', nameC: '#9090b0', thinkBg: 'rgba(160,164,212,.06)', thinkBd: 'rgba(160,164,212,.12)', panel: 'rgba(32,32,50,.97)' },
    mist: { name: '雾', bg: 'linear-gradient(135deg,#f6f5f2,#efede9 30%,#eceae6 60%,#f6f5f2)', ai: '255,255,255', me: '195,190,182', text: '#4a4742', accent: '#9e998e', time: '#c5c0b8', head: 'rgba(255,255,255,.45)', nameC: '#8a8578', thinkBg: 'rgba(158,153,142,.07)', thinkBd: 'rgba(158,153,142,.13)', panel: 'rgba(255,255,255,.96)' }
  };
  // 模型选择器：先记下来随消息存着。辞现在的模型由他的启动命令定，这里换不动他——留给以后接 API 用。
  const MIC = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/></svg>';
  const CLOCK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 7v5l3 2"/><path d="M12 3a9 9 0 1 1-6.4 2.6"/><path d="M4 4v4h4" stroke-dasharray="1 2.4"/></svg>';
  const TOOLICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M9 8V6a3 3 0 0 1 6 0v2M3 13h18"/></svg>';
  // mcp__muwen__get_calendar → Get Calendar
  const prettyTool = n => String(n || '').replace(/^mcp__[^_]+__/, '').split(/[_\s]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  // 底部弹层（思考过程 / 工具列表），照 Claude 官方 App
  function openSheet(title, html) {
    const s = document.createElement('div'); s.className = 'cx-sheet-wrap';
    s.innerHTML = `<div class="cx-sheet"><button class="cx-sheet-drag" aria-label="上拉展开"></button><div class="cx-sheet-h"><button class="cx-sheet-x">✕</button><span>${esc(title)}</span></div><div class="cx-sheet-b">${html}</div></div>`;
    const close = () => { s.classList.remove('in'); setTimeout(() => s.remove(), 220); };
    s.addEventListener('click', e => { if (e.target === s || e.target.closest('.cx-sheet-x')) close(); });
    const panel = s.querySelector('.cx-sheet'), drag = s.querySelector('.cx-sheet-drag');
    let dragY = null;
    drag.addEventListener('pointerdown', e => { dragY = e.clientY; try { drag.setPointerCapture(e.pointerId); } catch {} });
    drag.addEventListener('pointerup', e => {
      const dy = dragY == null ? 0 : dragY - e.clientY; dragY = null;
      if (dy > 24) panel.classList.add('expanded');
      else if (dy < -24) panel.classList.remove('expanded');
      else panel.classList.toggle('expanded');
    });
    document.body.appendChild(s); requestAnimationFrame(() => s.classList.add('in'));
  }
  const MODELS = ['Opus 4.6 [1m]', 'Opus 5.5', 'Opus 5', 'Sonnet 5', 'Fable 5.1', 'Haiku 4.5'];
  const EMOJI = '😀 😁 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😗 😚 😋 😛 😜 🤪 😝 🤗 🤭 🤫 🤔 😐 😑 😶 🙄 😏 😣 😥 😮 😪 😴 😌 🥱 😒 😓 😔 😕 🙃 🥲 😲 😳 🥺 😦 😧 😨 😰 😢 😭 😱 😖 😞 😩 😫 😤 😡 😠 🤬 😈 👿 💀 👻 🐶 🐱 🐰 🦊 🐻 🐼 🐺 🌙 ⭐ ✨ 🌸 🌷 🍓 🍰 ☕ 🎵 💤 💢 💦 ❤️ 🩷 💕 💞 💗 💔 👍 👎 👌 ✌️ 🤞 🫶 🙏 👏 🙌 🤝 😘 💋'.split(' ');

  const DEF = { theme: 'sakura', avatars: true, radius: 18, fontSize: 15, alpha: 72, frost: true, bg: '' };
  function cfg() { try { return Object.assign({}, DEF, JSON.parse(localStorage.getItem('muwen-chat-cfg') || '{}')); } catch { return { ...DEF }; } }
  function saveCfg(c) {
    try { localStorage.setItem('muwen-chat-cfg', JSON.stringify(c)); }
    catch { hint('存不下（背景图太大了，换张小点的）'); }
    applyLook();
  }
  const model = () => { try { return localStorage.getItem('muwu-model') || MODELS[0]; } catch { return MODELS[0]; } };

  // ---------- 状态 ----------
  let msgs = [], byId = new Map(), hasMore = true, loadingOlder = false;
  let open = false, built = false, timer = null, stick = true;
  let avatars = {}, status = { nor: {}, cy: {} }, pats = [];
  let quoting = null;                      // 正在引用的那条
  let expanded = {};                       // 展开了思考/工具的
  let slidePending = {}, slideRaf = 0;
  const PAGE = 40;

  // 后端会在回复送达后继续补 thinking/tools；这些字段也必须参与变更判断，
  // 否则数据已经到了，页面却要刷新后才看得见。
  function sigOf(m) {
    return JSON.stringify([
      m.read, m.starred, m.transcript_status, m.transcript, m.has_image,
      m.content, m.thinking, m.tools, m.voice_id, m.duration, m.quote
    ]);
  }

  function merge(list, where) {
    const fresh = [];
    const changed = [];
    for (const m of list) {
      const old = byId.get(m.id);
      if (!old) { fresh.push(m); byId.set(m.id, m); continue; }
      if (sigOf(old) !== sigOf(m)) { Object.assign(old, m); changed.push(old); }
    }
    if (where === 'top') msgs = fresh.concat(msgs);
    else msgs = msgs.concat(fresh);
    return { fresh, changed };
  }

  async function poll(initial) {
    try {
      // 最近一页里除了新消息，还可能有后台稍后补上的转写、thinking 和 tools，
      // 所以这里保留最近一页的同步；merge 只会重画真正变化的那一条。
      const list = await rest(`/api/chat?limit=${PAGE}`);
      if (initial && list.length < PAGE) hasMore = false;
      const { fresh, changed } = merge(list, 'bottom');
      if (open && built) {
        if (initial) paintAll(true);
        else {
          if (fresh.length) appendRows(fresh);
          changed.forEach(repaintRow);
          if (fresh.some(m => m.sender === 'cy')) markRead();
        }
      }
      updateBadge();
    } catch { /* 网络抖一下不刷屏 */ }
  }
  async function loadOlder() {
    if (loadingOlder || !hasMore || !msgs.length) return;
    loadingOlder = true;
    const box = $('#cx-msgs');
    const loader = document.createElement('div'); loader.className = 'cx-more'; loader.textContent = '加载更早的…';
    box.prepend(loader);
    try {
      const list = await rest(`/api/chat?limit=${PAGE}&before=${encodeURIComponent(msgs[0].id)}`);
      if (list.length < PAGE) hasMore = false;
      const { fresh } = merge(list, 'top');
      loader.remove();
      if (fresh.length) prependRows(fresh);
      if (!hasMore) box.insertAdjacentHTML('afterbegin', '<div class="cx-more">— 到头了 —</div>');
    } catch { loader.textContent = '加载失败，往下拉一点再试'; }
    loadingOlder = false;
  }

  async function markRead() {
    const un = msgs.filter(m => m.sender === 'cy' && !m.read);
    if (!un.length || !open) return;
    un.forEach(m => m.read = true);
    updateBadge();
    try { await post('/api/chat/read', { who: 'nor', ids: un.map(m => m.id) }); } catch {}
  }
  function updateBadge() {
    const n = msgs.filter(m => m.sender === 'cy' && !m.read).length;
    document.querySelectorAll('[data-chat-badge]').forEach(el => {
      el.textContent = n ? (n > 99 ? '99+' : n) : '';
      el.style.display = n ? 'flex' : 'none';
    });
  }

  // ---------- 渲染 ----------
  function avHtml(who, cls = '') {
    const id = avatars['avatar_' + who];
    return `<div class="cx-av${id ? ' img' : ''} ${cls}" data-who="${who}">${id ? `<img src="${imageUrl(id)}" alt="">` : (who === 'cy' ? '辞' : '棋')}</div>`;
  }
  const NAMES = { nor: '棋子', cy: '小辞' };
  function patLine(m) { return `${NAMES[m.sender]} 拍了拍 ${m.sender === 'nor' ? NAMES.cy : NAMES.nor}${m.content || ''}`; }
  function quoteHtml(q) {
    if (!q) return '';
    return `<div class="cx-quote" data-jump="${esc(q.id)}"><b>${q.sender === 'cy' ? '辞' : '棋子'}：</b>${esc(q.text)}</div>`;
  }
  function imgSrc(m) { return apiUrl('/api/chat/image/' + m.id); }

  function bodyHtml(m) {
    const isAi = m.sender === 'cy';
    if (m.type === 'image') {
      return `<img class="cx-img${m.sticker ? ' sticker' : ''}" loading="lazy" src="${imgSrc(m)}" alt="">${m.content ? `<div class="cx-cap">${esc(m.content)}</div>` : ''}`;
    }
    return esc(m.content);
  }

  // ---------- 语音条（照微信）：`)))  12″`，越长条越长；点一下播放，再点停；「转文字」在条外面 ----------
  // 棋子录的走 /api/chat/voice，辞的语音回复（m.voice_id）走 speak 那套；两种长得一样。
  const isVoice = m => m.type === 'voice' || (m.sender === 'cy' && !!m.voice_id);
  const voiceSrc = m => m.type === 'voice' ? apiUrl('/api/chat/voice/' + m.id) : MW.audioUrl(m.voice_id);
  const voiceText = m => m.type === 'voice'
    ? (m.transcript_status === 'pending' ? '转写中…' : m.transcript || (m.transcript_status === 'failed' ? '没转出文字' : '（没听清）'))
    : m.content;
  const WAVE = '<svg class="cx-vicon" viewBox="0 0 24 24" width="18" height="18"><circle class="a0" cx="5" cy="12" r="1.8" fill="currentColor"/><path class="a1" d="M9 8.2a5.4 5.4 0 0 1 0 7.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path class="a2" d="M12.6 4.8a10.2 10.2 0 0 1 0 14.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const voiceWidth = s => Math.round(78 + Math.min(60, Math.max(1, s || 3)) * 2.6);
  let played = new Set();
  try { played = new Set(JSON.parse(localStorage.getItem('muwu-played') || '[]')); } catch {}
  function markPlayed(id) {
    played.add(id);
    try { localStorage.setItem('muwu-played', JSON.stringify([...played].slice(-500))); } catch {}
    document.querySelectorAll(`.cx-item[data-id="${CSS.escape(id)}"] .cx-vdot`).forEach(n => n.remove());
  }
  const durCache = {};
  function voiceRowHtml(m, isAi) {
    const dur = m.duration || durCache[m.id] || 0;
    const open = !!expanded['v' + m.id];
    const dot = isAi && !played.has(m.id) ? '<i class="cx-vdot"></i>' : '';
    return `<div class="cx-vrow">
        <div class="cx-bubble ${isAi ? 'ai' : 'mine'} cx-vbub${m.type === 'voice' ? '' : ' cx-tts'}" data-act="play" style="width:${voiceWidth(dur)}px">${WAVE}<span class="cx-vdur">${dur ? dur + '″' : '…'}</span></div>
        <button class="cx-vt-btn" data-act="vt">${open ? '收起' : '转文字'}</button>${dot}
      </div><div class="cx-voice-text"${open ? '' : ' hidden'}>${esc(voiceText(m))}</div>`;
  }
  // 辞的语音回复不知道多长：读一下音频头拿时长，拿到了回填条的长度
  function probeDurations(scope) {
    (scope || document).querySelectorAll('.cx-vdur').forEach(n => {
      if (!n.textContent.startsWith('…')) return;
      const item = n.closest('.cx-item'); const m = item && byId.get(item.dataset.id); if (!m || durCache[m.id] !== undefined) return;
      durCache[m.id] = 0;
      const a = new Audio(); a.preload = 'metadata';
      a.onloadedmetadata = () => {
        const s = Math.max(1, Math.round(a.duration || 0)); durCache[m.id] = s;
        const b = document.querySelector(`.cx-item[data-id="${CSS.escape(m.id)}"] .cx-vbub`);
        if (b) { b.style.width = voiceWidth(s) + 'px'; b.querySelector('.cx-vdur').textContent = s + '″'; }
      };
      a.src = voiceSrc(m);
    });
  }
  const player = new Audio();
  let playingId = null;
  function togglePlay(m, bub) {
    document.querySelectorAll('.cx-vbub.playing').forEach(b => b.classList.remove('playing'));
    if (playingId === m.id && !player.paused) { player.pause(); playingId = null; return; }
    playingId = m.id;
    player.src = voiceSrc(m);
    player.play().then(() => { bub.classList.add('playing'); markPlayed(m.id); }).catch(e => { hint('放不出来：' + (e.message || e)); playingId = null; });
  }
  player.onended = player.onpause = () => { document.querySelectorAll('.cx-vbub.playing').forEach(b => b.classList.remove('playing')); };
  function ticks(m) {
    if (m.sender !== 'nor') return '';
    return m.read ? '<span class="cx-tick read" title="辞已读">✓✓</span>' : '<span class="cx-tick" title="已发出">✓</span>';
  }

  function rowHtml(m) {
    if (m.type === 'pat') return `<div class="cx-item" data-id="${esc(m.id)}"><div class="cx-pat">— ${esc(patLine(m))} —${m.starred ? ' ★' : ''}</div></div>`;
    const isAi = m.sender === 'cy';
    const time = esc(fmtTime(m.at).slice(11));
    let extra = '';
    // 照 Claude 官方 App：一行「Thought process ›」/「Used N tools ›」，点开从底部弹一层
    if (isAi && m.thinking) extra += `<button class="cx-native" data-act="think">${CLOCK}<span>Thought process</span><b>›</b></button>`;
    if (isAi && (m.tools || []).length) extra += `<button class="cx-native" data-act="tools"><span>Used ${m.tools.length} tool${m.tools.length > 1 ? 's' : ''}</span><b>›</b></button>`;
    const bare = m.type === 'image' && m.sticker;       // 表情包不套气泡
    const main = isVoice(m)
      ? (m.quote ? `<div class="cx-quote out" data-jump="${esc(m.quote.id)}"><b>${m.quote.sender === 'cy' ? '辞' : '棋子'}：</b>${esc(m.quote.text)}</div>` : '') + voiceRowHtml(m, isAi)
      : `<div class="cx-bubble ${isAi ? 'ai' : 'mine'}${bare ? ' bare' : ''}${m.type === 'image' && !bare ? ' pic' : ''}" data-act="bubble">${quoteHtml(m.quote)}${bodyHtml(m)}</div>`;
    return `<div class="cx-item" data-id="${esc(m.id)}">
      <div class="cx-row${isAi ? '' : ' me'}">${avHtml(isAi ? 'cy' : 'nor')}
        <div class="cx-col">${extra}
          ${main}
          <div class="cx-meta">${m.starred ? '<span class="cx-star">★</span>' : ''}<span>${time}</span>${ticks(m)}</div>
        </div></div></div>`;
  }
  function dayHtml(date) { return `<div class="cx-day" data-day="${esc(date)}">— ${esc(date)} —</div>`; }

  function paintAll(toBottom) {
    const box = $('#cx-msgs'); if (!box) return;
    if (!msgs.length) { box.innerHTML = '<div class="cx-empty">还没有消息。<br>发一条，辞在窗口里就能看到。</div>'; return; }
    let h = hasMore ? '' : '<div class="cx-more">— 到头了 —</div>', prev = '';
    for (const m of msgs) { if (m.date !== prev) { h += dayHtml(m.date); prev = m.date; } h += rowHtml(m); }
    box.innerHTML = h;
    probeDurations(box);
    if (toBottom) toBottomNow();
  }
  function appendRows(list) {
    const box = $('#cx-msgs'); if (!box) return;
    const empty = box.querySelector('.cx-empty'); if (empty) empty.remove();
    const lastDay = [...box.querySelectorAll('.cx-day')].pop();
    let prev = lastDay ? lastDay.dataset.day : '', h = '';
    for (const m of list) { if (m.date !== prev) { h += dayHtml(m.date); prev = m.date; } h += rowHtml(m); }
    const wasStuck = stick;
    box.insertAdjacentHTML('beforeend', h);
    for (const m of list) {
      const n = box.querySelector(`.cx-item[data-id="${CSS.escape(m.id)}"]`);
      if (n) probeDurations(n);
    }
    if (wasStuck || list.some(m => m.sender === 'nor')) toBottomNow();
  }
  function prependRows(list) {
    const box = $('#cx-msgs');
    const before = box.scrollHeight, top = box.scrollTop;
    // 旧的最后一条跟现在第一条同一天的话，现在第一条前面那个日期分隔就多余了
    const firstDay = box.querySelector('.cx-day');
    if (firstDay && list.length && list[list.length - 1].date === firstDay.dataset.day) firstDay.remove();
    let h = '', prev = '';
    for (const m of list) { if (m.date !== prev) { h += dayHtml(m.date); prev = m.date; } h += rowHtml(m); }
    const oldEdge = box.querySelector('.cx-more'); if (oldEdge) oldEdge.remove();
    box.insertAdjacentHTML('afterbegin', h);
    for (const m of list) {
      const n = box.querySelector(`.cx-item[data-id="${CSS.escape(m.id)}"]`);
      if (n) probeDurations(n);
    }
    box.scrollTop = top + (box.scrollHeight - before);  // 视线停在原来那条上，不跳
  }
  function repaintRow(m) {
    const n = document.querySelector(`#cx-msgs .cx-item[data-id="${CSS.escape(m.id)}"]`); if (!n) return;
    const wrap = document.createElement('div'); wrap.innerHTML = rowHtml(m);
    const fresh = wrap.firstElementChild;
    if (playingId === m.id) { const b = fresh.querySelector('.cx-vbub'); if (b) b.classList.add('playing'); }
    n.replaceWith(fresh);
    probeDurations(fresh);
  }
  function toBottomNow() { const box = $('#cx-msgs'); if (box) { box.scrollTop = box.scrollHeight; stick = true; } }

  function applyLook() {
    const root = $('#chat-root .cx'); if (!root) return;
    const c = cfg(), t = THEMES[c.theme] || THEMES.sakura;
    root.style.background = c.bg ? `url("${c.bg}") center/cover` : t.bg;
    const a = Math.max(.15, Math.min(1, c.alpha / 100));
    const v = {
      '--cx-ai': `rgba(${t.ai},${(t.aiA || .75) * a / .75})`, '--cx-me': `rgba(${t.me},${(t.meA || .38) * a / .75})`,
      '--cx-text': t.text, '--cx-accent': t.accent, '--cx-time': t.time, '--cx-head': t.head, '--cx-name': t.nameC,
      '--cx-think-bg': t.thinkBg, '--cx-think-bd': t.thinkBd, '--cx-panel': t.panel,
      '--cx-av-bg': t.accent + '28', '--cx-radius': c.radius + 'px', '--cx-font': c.fontSize + 'px',
      '--cx-blur': c.frost ? '12px' : '0px'
    };
    for (const k in v) root.style.setProperty(k, v[k]);
    root.classList.toggle('no-av', !c.avatars);
    root.classList.toggle('dark', !!t.dark);
  }
  function paintHeader() {
    const s = $('#cx-status'); if (s) s.textContent = '何辞' + (status.cy && status.cy.text ? ' · ' + status.cy.text : '');
    const av = $('#cx-head-av'); if (av) av.outerHTML = avHtml('cy', 'big').replace('class="cx-av', 'id="cx-head-av" class="cx-av');
  }

  function buildShell() {
    const root = $('#chat-root'); if (!root) return false;
    root.innerHTML = `<div class="cx">
      <div class="cx-head">
        <div class="cx-prof">${avHtml('cy', 'big').replace('class="cx-av', 'id="cx-head-av" class="cx-av')}
          <div><div class="cx-title">小辞</div><div class="cx-sub" id="cx-status">何辞</div></div></div>
        <button class="cx-gear" onclick="CX.panel()" title="聊天外观">✧</button>
      </div>
      <div class="cx-msgs" id="cx-msgs"></div>
      <div class="cx-bar">
        <div class="cx-quoting" id="cx-quoting" hidden></div>
        <textarea id="cx-text" rows="1" placeholder="说点什么…" enterkeyhint="send"></textarea>
        <div class="cx-tools">
          <label class="cx-tb" title="发图片">附<input type="file" accept="image/*" hidden onchange="CX.pickImage(this)"></label>
          <button class="cx-tb" onclick="CX.emoji()" title="表情">表</button>
          <select class="cx-model" id="cx-model" title="模型（现在只记录，换不动辞当前的模型）" onchange="CX.setModel(this.value)">
            ${MODELS.map(x => `<option${x === model() ? ' selected' : ''}>${x}</option>`).join('')}
            <option disabled>自定义 API（以后）</option>
          </select>
          <span class="cx-sp"></span>
          <button class="cx-tb" onclick="CX.newline()" title="换行">↵</button>
          <button class="cx-mic" id="cx-rec" title="按住说话" aria-label="按住说话">${MIC}</button>
          <button class="cx-send" onclick="CX.send()" title="发送">↑</button>
        </div>
        <div id="cx-msg" class="cx-hint"></div>
      </div>
      <div id="cx-pop" class="cx-pop" hidden></div>
      <div class="cx-recov" id="cx-recov" hidden>
        <div class="cx-rec-bubble" id="cx-rec-bubble"><div class="cx-wave" id="cx-wave">${'<i></i>'.repeat(26)}</div><div class="cx-rec-sec" id="cx-rec-sec"></div></div>
        <div class="cx-rec-tip" id="cx-rec-tip">松手 发语音</div>
        <div class="cx-zone left" id="cx-z-cancel"><span>取消</span></div>
        <div class="cx-zone right" id="cx-z-text"><span>滑到这里 转文字</span></div>
        <div class="cx-rec-base"></div>
      </div>
      <div id="cx-set" class="cx-set" hidden></div>
    </div>`;
    const ta = $('#cx-text');
    // 中文输入法按回车是在选字，这时候不能当成发送
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); CX.send(); } });
    ta.addEventListener('input', autoGrow);
    bindHoldToTalk($('#cx-rec'));
    const box = $('#cx-msgs');
    box.addEventListener('scroll', () => {
      stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      if (box.scrollTop < 80) loadOlder();
    }, { passive: true });
    // 图片撑高了：只有停在底部时补滚
    box.addEventListener('load', e => { if (e.target.tagName === 'IMG' && stick) toBottomNow(); }, true);
    root.querySelector('.cx').addEventListener('click', onClick);
    bindLongPress(root.querySelector('.cx'));
    // 长按松手时浏览器还会补一个 click——那一下不能把刚弹出来的菜单关掉
    document.addEventListener('click', e => {
      if (longFired) { longFired = false; return; }
      const pop = $('#cx-pop'); if (pop && !pop.hidden && !pop.contains(e.target)) pop.hidden = true;
    });
    built = true;
    applyLook();
    return true;
  }
  function autoGrow() { const ta = $('#cx-text'); ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; }
  function hint(t) { const m = $('#cx-msg'); if (m) m.textContent = t || ''; }

  // ---------- 点击：折叠 / 转文字 / 看大图 / 点引用跳过去 / 点头像改状态 ----------
  function onClick(e) {
    const el = e.target.closest('[data-act],[data-jump],.cx-img,.cx-av');
    if (!el) return;
    const item = el.closest('.cx-item');
    const m = item && byId.get(item.dataset.id);
    if (el.dataset.jump) { jumpTo(el.dataset.jump); return; }
    if (el.classList.contains('cx-img')) { viewImage(el.src); return; }
    if (el.classList.contains('cx-av')) { if (el.dataset.who === 'cy' && !longFired) CX.statusSheet(); return; }
    const act = el.dataset.act;
    if (act === 'think') {
      openSheet('Thought process', `<div class="cx-sheet-think">${esc(m.thinking)}</div>`);
    } else if (act === 'tools') {
      openSheet(`Used ${m.tools.length} tool${m.tools.length > 1 ? 's' : ''}`, `<div class="cx-sheet-tools">${m.tools.map(t => `<div class="cx-tl"><span class="cx-tl-i">${TOOLICON}</span><div><div class="cx-tl-n">Used ${esc(prettyTool(t.name))}</div>${t.result ? `<div class="cx-tl-r">${esc(t.result)}</div>` : ''}</div></div>`).join('')}</div>`);
    } else if (act === 'vt') {
      const t = el.closest('.cx-col').querySelector('.cx-voice-text');
      t.hidden = !t.hidden; el.textContent = t.hidden ? '转文字' : '收起';
      expanded['v' + m.id] = !t.hidden;
      if (!t.hidden && stick) toBottomNow();
    } else if (act === 'play' && !longFired) {
      togglePlay(m, el);
    }
  }
  function jumpTo(id) {
    const n = document.querySelector(`#cx-msgs .cx-item[data-id="${CSS.escape(id)}"]`);
    if (!n) { hint('那条太早了，往上翻翻能看到'); return; }
    n.scrollIntoView({ block: 'center', behavior: 'smooth' });
    n.classList.add('flash'); setTimeout(() => n.classList.remove('flash'), 1600);
  }
  function viewImage(src) {
    const o = document.createElement('div'); o.className = 'cx-viewer';
    o.innerHTML = `<img src="${src}" alt="">`;
    o.onclick = () => o.remove();
    document.body.appendChild(o);
  }

  // ---------- 长按：气泡 → 引用/收藏/复制；辞的头像 → 拍一拍 ----------
  let pressTimer = null, pressStart = null, longFired = false;
  function bindLongPress(root) {
    root.addEventListener('contextmenu', e => { if (e.target.closest('.cx-bubble,.cx-av,.cx-pat')) e.preventDefault(); });
    root.addEventListener('pointerdown', e => {
      const t = e.target.closest('.cx-bubble,.cx-av[data-who="cy"],.cx-pat');
      if (!t || e.target.closest('audio,button,select')) return;
      longFired = false;
      pressStart = { x: e.clientX, y: e.clientY };
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        longFired = true;
        if (navigator.vibrate) navigator.vibrate(10);
        if (t.classList.contains('cx-av')) patMenu(t);
        else msgMenu(t.closest('.cx-item'), t);
      }, 450);
    });
    const cancel = e => {
      if (!pressTimer) return;
      if (e.type === 'pointermove' && pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) < 8) return;
      clearTimeout(pressTimer); pressTimer = null;
    };
    ['pointerup', 'pointercancel', 'pointermove', 'pointerleave'].forEach(ev => root.addEventListener(ev, cancel));
  }
  function popAt(anchor, html) {
    const pop = $('#cx-pop'), root = $('#chat-root .cx');
    pop.innerHTML = html; pop.hidden = false;
    const r = anchor.getBoundingClientRect(), rr = root.getBoundingClientRect();
    const top = r.top - rr.top - pop.offsetHeight - 8;
    pop.style.top = Math.max(60, top < 60 ? r.bottom - rr.top + 8 : top) + 'px';
    pop.style.left = Math.max(8, Math.min(rr.width - pop.offsetWidth - 8, r.left - rr.left + r.width / 2 - pop.offsetWidth / 2)) + 'px';
  }
  function msgMenu(item, anchor) {
    const m = item && byId.get(item.dataset.id); if (!m) return;
    const canCopy = m.type === 'text' || (m.type === 'voice' && m.transcript);
    popAt(anchor, `<div class="cx-menu">
      <button onclick="CX.quote('${m.id}')">引用</button>
      <button onclick="CX.star('${m.id}',${!m.starred})">${m.starred ? '取消收藏' : '收藏'}</button>
      ${canCopy ? `<button onclick="CX.copy('${m.id}')">复制</button>` : ''}
    </div>`);
  }
  function patMenu(anchor) {
    const list = pats.length ? pats : [''];
    popAt(anchor, `<div class="cx-pats"><div class="cx-pats-t">拍一拍小辞…</div>
      ${list.map((p, i) => `<button onclick="CX.pat(${i})">拍了拍 小辞${esc(p)}</button>`).join('')}
      <div class="cx-pats-t">拍一拍库在设置页改</div></div>`);
  }

  // ---------- 发送 ----------
  async function sendPayload(body, clear) {
    hint('');
    try {
      const m = await post('/api/chat', { ...body, model: model(), reply_to: quoting ? quoting.id : '' });
      if (clear) clear();
      CX.cancelQuote();
      const { fresh } = merge([m], 'bottom');
      if (fresh.length) appendRows(fresh);
      return m;
    } catch (e) { hint('发不出去：' + e.message); throw e; }
  }

  // ---------- 按住说话（照微信）：按住录，松手发；往左滑到「取消」松手不发，往右滑到「转文字」松手把话变成文字放进输入框 ----------
  const MAX_REC = 60;
  let rec = null;              // { recorder, stream, chunks, start, zone, ctx, raf, timer }
  let holding = false;
  function zoneAt(x, y) {
    for (const [id, z] of [['#cx-z-cancel', 'cancel'], ['#cx-z-text', 'text']]) {
      const r = $(id).getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return z;
    }
    return 'send';
  }
  function setZone(z) {
    if (!rec || rec.zone === z) return;
    rec.zone = z;
    $('#cx-z-cancel').classList.toggle('on', z === 'cancel');
    $('#cx-z-text').classList.toggle('on', z === 'text');
    $('#cx-rec-bubble').className = 'cx-rec-bubble' + (z === 'send' ? '' : ' ' + z);
    $('#cx-rec-tip').textContent = z === 'cancel' ? '松手 取消' : z === 'text' ? '松手 转文字' : '松手 发语音';
  }
  function bindHoldToTalk(btn) {
    btn.addEventListener('contextmenu', e => e.preventDefault());
    btn.addEventListener('pointerdown', async e => {
      e.preventDefault();
      if (rec || holding) return;
      holding = true;
      try { btn.setPointerCapture(e.pointerId); } catch {}
      if (!navigator.mediaDevices || !window.MediaRecorder) { holding = false; hint('这个浏览器不支持录音'); return; }
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch (err) { holding = false; hint('录不了音：' + (err.message || '没给麦克风权限')); return; }
      // 第一次用会先弹"允许麦克风"，等点完允许手早就松开了——这次不录，下次按住就行
      if (!holding) { stream.getTracks().forEach(t => t.stop()); hint('麦克风可以用了，按住说话'); return; }
      startRec(stream);
    });
    btn.addEventListener('pointermove', e => { if (rec) setZone(zoneAt(e.clientX, e.clientY)); });
    const up = () => { holding = false; if (rec) stopRec(rec.zone); };
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', () => { holding = false; if (rec) stopRec('cancel'); });
  }
  function startRec(stream) {
    hint('');
    const recorder = new MediaRecorder(stream);
    rec = { recorder, stream, chunks: [], start: Date.now(), zone: null };
    recorder.ondataavailable = e => { if (e.data.size) rec && rec.chunks.push(e.data); };
    recorder.start();
    setZone('send');
    $('#cx-recov').hidden = false;
    $('#cx-rec').classList.add('on');
    if (navigator.vibrate) navigator.vibrate(15);
    // 波形跟着声音跳
    const bars = [...document.querySelectorAll('#cx-wave i')];
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx(); const an = ctx.createAnalyser(); an.fftSize = 64;
      ctx.createMediaStreamSource(stream).connect(an);
      const data = new Uint8Array(an.frequencyBinCount);
      rec.ctx = ctx;
      const draw = () => {
        if (!rec) return;
        an.getByteFrequencyData(data);
        bars.forEach((b, i) => { const v = data[(i % (data.length - 2)) + 1] / 255; b.style.transform = `scaleY(${0.18 + v * 0.95})`; });
        rec.raf = requestAnimationFrame(draw);
      };
      draw();
    } catch { /* 画不了波形不影响录音 */ }
    rec.timer = setInterval(() => {
      if (!rec) return;
      const s = Math.floor((Date.now() - rec.start) / 1000);
      $('#cx-rec-sec').textContent = s >= MAX_REC - 10 ? `还能说 ${MAX_REC - s} 秒` : '';
      if (s >= MAX_REC) stopRec(rec.zone);   // 到 60 秒自动结束
    }, 250);
  }
  function stopRec(zone) {
    const r = rec; if (!r) return;
    rec = null;
    clearInterval(r.timer); cancelAnimationFrame(r.raf);
    try { r.ctx && r.ctx.close(); } catch {}
    $('#cx-rec').classList.remove('on');
    const dur = Math.round((Date.now() - r.start) / 1000);
    r.recorder.onstop = async () => {
      r.stream.getTracks().forEach(t => t.stop());
      if (zone === 'cancel') { $('#cx-recov').hidden = true; hint('已取消'); setTimeout(() => hint(''), 1200); return; }
      if (dur < 1) { $('#cx-recov').hidden = true; hint('说话时间太短'); setTimeout(() => hint(''), 1500); return; }
      const blob = new Blob(r.chunks, { type: r.recorder.mimeType || 'audio/webm' });
      const mime = blob.type.split(';')[0];
      const b64 = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).replace(/^data:[^;]+;base64,/, '')); fr.readAsDataURL(blob); });
      if (zone === 'text') {
        $('#cx-rec-tip').textContent = '转文字中…';
        try {
          const { text } = await post('/api/chat/transcribe', { audio_base64: b64, mime });
          $('#cx-recov').hidden = true;
          if (!text) { hint('没听清，这条没发'); return; }
          const ta = $('#cx-text'); ta.value = (ta.value ? ta.value + ' ' : '') + text; autoGrow(); ta.focus();
          hint('转好了，改一改再发'); setTimeout(() => hint(''), 2500);
        } catch (e) { $('#cx-recov').hidden = true; hint('转文字失败：' + e.message + '（这条没发）'); }
        return;
      }
      $('#cx-recov').hidden = true;
      hint('发送中…');
      try { await sendPayload({ type: 'voice', voice_base64: b64, voice_mime: mime, duration: dur }); hint(''); } catch {}
    };
    try { r.recorder.stop(); } catch { $('#cx-recov').hidden = true; }
  }

  const CX = {
    async send() {
      const ta = $('#cx-text'); const text = ta.value.trim(); if (!text) return;
      const keep = ta.value;
      ta.value = ''; autoGrow();
      try { await sendPayload({ type: 'text', content: text }); } catch { ta.value = keep; autoGrow(); }
    },
    newline() {
      const ta = $('#cx-text'), s = ta.selectionStart, e = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + '\n' + ta.value.slice(e);
      ta.selectionStart = ta.selectionEnd = s + 1; ta.focus(); autoGrow();
    },
    setModel(v) { try { localStorage.setItem('muwu-model', v); } catch {} hint(`记下了：${v}（现在还换不动辞当前的模型，以后接 API 用）`); setTimeout(() => hint(''), 4000); },
    quote(id) {
      const m = byId.get(id); if (!m) return;
      quoting = m; $('#cx-pop').hidden = true;
      const q = $('#cx-quoting');
      const text = m.type === 'pat' ? patLine(m) : m.type === 'image' ? '[图片]' : m.type === 'voice' ? '[语音] ' + (m.transcript || '') : m.content;
      q.innerHTML = `<span><b>${m.sender === 'cy' ? '辞' : '棋子'}：</b>${esc(String(text).slice(0, 60))}</span><button onclick="CX.cancelQuote()">✕</button>`;
      q.hidden = false; $('#cx-text').focus();
    },
    cancelQuote() { quoting = null; const q = $('#cx-quoting'); if (q) { q.hidden = true; q.innerHTML = ''; } },
    async star(id, on) {
      $('#cx-pop').hidden = true;
      try { const m = await post('/api/chat/star', { id, on }); Object.assign(byId.get(id), m); repaintRow(byId.get(id)); hint(on ? '收藏了，搜索页能看到全部收藏' : ''); }
      catch (e) { hint('没收藏上：' + e.message); }
    },
    async copy(id) {
      $('#cx-pop').hidden = true;
      const m = byId.get(id); const t = m.type === 'voice' ? m.transcript : m.content;
      try { await navigator.clipboard.writeText(t); hint('复制了'); } catch { hint('这个浏览器不让复制'); }
      setTimeout(() => hint(''), 1500);
    },
    async pat(i) {
      $('#cx-pop').hidden = true;
      try { await sendPayload({ type: 'pat', content: pats[i] || '' }); } catch {}
    },
    async pickImage(input) {
      const f = input.files && input.files[0]; input.value = '';
      if (!f) return;
      hint('发送中…');
      try { await sendPayload({ type: 'image', image_base64: await MW.fileToBase64(f), image_mime: f.type || 'image/jpeg' }); hint(''); } catch {}
    },
    // 表情：上面一排 emoji 直接插进输入框；下面是她的表情包（相册里标了「表情包」的），点一下就发
    async emoji() {
      const set = $('#cx-set');
      if (!set.hidden && set.dataset.kind === 'emoji') { set.hidden = true; return; }
      set.dataset.kind = 'emoji'; set.hidden = false; set.classList.add('bottom');
      set.innerHTML = `<div class="cx-emo">${EMOJI.map(e => `<button onclick="CX.insert('${e}')">${e}</button>`).join('')}</div>
        <div class="cx-set-l split"><span style="opacity:.65">我的表情包</span><label class="cx-file">+ 加一张<input type="file" accept="image/*" hidden onchange="CX.addSticker(this)"></label></div>
        <div class="cx-stk" id="cx-stk"><div class="cx-set-l">…</div></div>`;
      try {
        const list = (await rest('/api/album?limit=500')).filter(p => (p.tags || []).includes('表情包'));
        $('#cx-stk').innerHTML = list.length ? list.map(p => `<img loading="lazy" src="${imageUrl(p.id)}" onclick="CX.sendSticker('${p.id}')" alt="">`).join('')
          : '<div class="cx-set-l">还没有。点「加一张」，或者在相册里给图打「表情包」标签</div>';
      } catch { $('#cx-stk').innerHTML = '<div class="cx-set-l">读不到相册</div>'; }
    },
    insert(e) { const ta = $('#cx-text'); const s = ta.selectionStart ?? ta.value.length; ta.value = ta.value.slice(0, s) + e + ta.value.slice(ta.selectionEnd ?? s); ta.selectionStart = ta.selectionEnd = s + e.length; autoGrow(); },
    async sendSticker(photoId) { $('#cx-set').hidden = true; try { await sendPayload({ type: 'image', photo_id: photoId, sticker: true }); } catch {} },
    async addSticker(input) {
      const f = input.files && input.files[0]; input.value = ''; if (!f) return;
      hint('存表情包…');
      try { await MW.uploadPhoto(f, { caption: '棋子的表情包', tags: ['表情包'] }); hint(''); $('#cx-set').dataset.kind = ''; CX.emoji(); }
      catch (e) { hint('没存上：' + e.message); }
    },
    // 点辞的头像：看两个人的状态，改自己的（辞的只有他自己能改）
    statusSheet() {
      const set = $('#cx-set');
      set.dataset.kind = 'status'; set.classList.remove('bottom'); set.hidden = false;
      set.innerHTML = `<div class="cx-set-t">状态</div>
        <div class="cx-set-l">辞</div><div class="cx-st-show">${esc((status.cy && status.cy.text) || '（他还没写）')}</div>
        <div class="cx-set-l">我</div>
        <input id="cx-st-in" maxlength="30" value="${esc((status.nor && status.nor.text) || '')}" placeholder="在studio / 困了 / 想你…">
        <div style="display:flex;gap:8px;margin-top:10px"><button class="cx-pill" onclick="CX.saveStatus()">保存</button><button class="cx-pill ghost" onclick="CX.closePanel()">关</button></div>
        <div class="cx-set-l" style="margin-top:10px">长按辞的头像可以拍一拍</div>`;
    },
    async saveStatus() {
      try { status = await post('/api/chat/status', { text: $('#cx-st-in').value }); CX.closePanel(); document.dispatchEvent(new CustomEvent('muwu-status', { detail: status })); }
      catch (e) { hint('没存上：' + e.message); }
    },
    closePanel() { const s = $('#cx-set'); if (s) s.hidden = true; },
    // 右上角 ✧：这个聊天窗口自己的外观（配色在设置页）
    panel(keep) {
      const box = $('#cx-set'); if (!box) return;
      if (!keep && !box.hidden && box.dataset.kind === 'look') { box.hidden = true; return; }
      box.dataset.kind = 'look'; box.classList.remove('bottom'); box.hidden = false;
      const c = cfg();
      box.innerHTML = `<div class="cx-set-t">聊天外观</div>
        <div class="cx-set-row"><span>磨砂玻璃</span><button class="cx-tg${c.frost ? ' on' : ''}" onclick="CX.set('frost',${!c.frost})"><i></i></button></div>
        <div class="cx-set-row"><span>显示头像</span><button class="cx-tg${c.avatars ? ' on' : ''}" onclick="CX.set('avatars',${!c.avatars})"><i></i></button></div>
        <div class="cx-set-l">气泡透明度 <span id="cx-v-alpha">${c.alpha}</span>%</div>
        <input type="range" min="20" max="100" value="${c.alpha}" oninput="CX.slide('alpha',this.value)">
        <div class="cx-set-l">气泡圆角 <span id="cx-v-radius">${c.radius}</span>px</div>
        <input type="range" min="4" max="24" value="${c.radius}" oninput="CX.slide('radius',this.value)">
        <div class="cx-set-l">字号 <span id="cx-v-fontSize">${c.fontSize}</span>px</div>
        <input type="range" min="12" max="22" value="${c.fontSize}" oninput="CX.slide('fontSize',this.value)">
        <div class="cx-set-l">背景图</div>
        <label class="cx-file">选图片<input type="file" accept="image/*" hidden onchange="CX.bg(this)"></label>
        ${c.bg ? `<span class="cx-clear" onclick="CX.set('bg','')">清除</span>` : ''}
        <div class="cx-set-l" style="margin-top:10px">配色（樱海石夜雾）和拍一拍库在「设置」页</div>`;
    },
    set(k, v) { const c = cfg(); c[k] = v; saveCfg(c); if ($('#cx-set').dataset.kind === 'look') CX.panel(true); },
    // 滑块 oninput 一秒几十次：只改 CSS 变量，而且一帧最多改一次
    slide(k, v) {
      slidePending[k] = Number(v);
      const s = $('#cx-v-' + k); if (s) s.textContent = v;
      if (slideRaf) return;
      slideRaf = requestAnimationFrame(() => { slideRaf = 0; const c = Object.assign(cfg(), slidePending); slidePending = {}; saveCfg(c); });
    },
    bg(input) {
      const f = input.files && input.files[0]; if (!f) return;
      // 背景图存在本机，太大的先缩一下，不然 localStorage 装不下
      const img = new Image(), fr = new FileReader();
      fr.onload = () => { img.src = fr.result; };
      img.onload = () => {
        const s = Math.min(1, 1200 / Math.max(img.width, img.height));
        const cv = document.createElement('canvas'); cv.width = img.width * s; cv.height = img.height * s;
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        CX.set('bg', cv.toDataURL('image/jpeg', .82));
      };
      fr.readAsDataURL(f);
    },
    // 设置页用：配色选择、拍一拍库、外观
    themes: THEMES,
    cfg,
    theme() { return cfg().theme; },
    setTheme(k) { const c = cfg(); c.theme = k; saveCfg(c); },
    async loadPats() { try { pats = await rest('/api/chat/pats'); } catch {} return pats; },
    async savePats(list) { pats = await post('/api/chat/pats', { list }); return pats; },
    async refreshStatus() { try { status = await rest('/api/chat/status'); paintHeader(); } catch {} return status; },
    getStatus() { return status; },
    async onShow() {
      open = true;
      document.body.classList.add('chat-open');
      const nav = document.querySelector('.bottom-nav');
      if (nav) document.documentElement.style.setProperty('--nav-h', nav.offsetHeight + 'px');
      if (!built && !buildShell()) return;
      const fresh = await MW.loadPrefs().catch(() => ({}));
      if (JSON.stringify(fresh) !== JSON.stringify(avatars)) { avatars = fresh; if (msgs.length) paintAll(stick); }
      paintHeader();
      if (!$('#cx-msgs').children.length) paintAll(true);
      else if (stick) toBottomNow();
      setPollInterval(5000);   // 在聊天页 5 秒一次，辞回得快也能及时看到
      poll(); markRead(); CX.refreshStatus(); CX.loadPats();
    },
    onHide() {
      open = false;
      document.body.classList.remove('chat-open');
      setPollInterval(30000);  // 不在聊天页只更新角标
    },
    async init() {
      MW.loadPrefs().then(p => { avatars = p; }).catch(() => {});
      await poll(true);
      // init 等请求时用户可能已经进了聊天页；按当前状态设置，不能再叠一个定时器。
      setPollInterval(open ? 5000 : 30000);
      CX.refreshStatus(); CX.loadPats();
    }
  };
  function setPollInterval(ms) {
    if (timer) clearInterval(timer);
    timer = setInterval(() => poll(), ms);
  }
  window.CX = CX;
})();
