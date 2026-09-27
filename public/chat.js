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
  let recorder = null, chunks = [], recStart = 0, recTimer = null;
  let slidePending = {}, slideRaf = 0;
  const PAGE = 40;

  function sigOf(m) { return [m.read, m.starred, m.transcript_status, m.transcript, m.has_image].join('|'); }
  let sigs = new Map();

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
    if (m.type === 'voice') {
      const t = m.transcript_status === 'pending' ? '转写中…' : m.transcript || (m.transcript_status === 'failed' ? '没转出文字' : '（没听清）');
      return `<div class="cx-voice"><audio controls preload="none" src="${apiUrl('/api/chat/voice/' + m.id)}"></audio>
        <button class="cx-vt-btn" data-act="vt">转文字</button></div><div class="cx-voice-text" hidden>${esc(t)}</div>`;
    }
    // 辞的语音回复：先是播放器，文字收在「转文字」后面（跟微信一样）
    if (isAi && m.voice_id) {
      return `<div class="cx-voice"><audio class="cx-tts" controls preload="none" src="${MW.audioUrl(m.voice_id)}"></audio>
        <button class="cx-vt-btn" data-act="vt">转文字</button></div><div class="cx-voice-text" hidden>${esc(m.content)}</div>`;
    }
    return esc(m.content);
  }
  function ticks(m) {
    if (m.sender !== 'nor') return '';
    return m.read ? '<span class="cx-tick read" title="辞已读">✓✓</span>' : '<span class="cx-tick" title="已发出">✓</span>';
  }

  function rowHtml(m) {
    if (m.type === 'pat') return `<div class="cx-item" data-id="${esc(m.id)}"><div class="cx-pat">— ${esc(patLine(m))} —${m.starred ? ' ★' : ''}</div></div>`;
    const isAi = m.sender === 'cy';
    const time = esc(fmtTime(m.at).slice(11));
    let extra = '';
    if (isAi && m.thinking) {
      const on = !!expanded['t' + m.id];
      extra += `<button class="cx-fold" data-act="think"><span class="cx-arrow${on ? ' on' : ''}">▸</span><i>thinking…</i></button>
        <div class="cx-fold-body think"${on ? '' : ' hidden'}>${esc(m.thinking)}</div>`;
    }
    if (isAi && (m.tools || []).length) {
      const on = !!expanded['x' + m.id];
      extra += `<button class="cx-fold" data-act="tools"><span class="cx-arrow${on ? ' on' : ''}">▸</span>used ${m.tools.length} tool${m.tools.length > 1 ? 's' : ''}</button>
        <div class="cx-fold-body"${on ? '' : ' hidden'}>${m.tools.map(t => `<div class="cx-tool"><code>${esc(t.name)}</code>${t.result ? `<span>${esc(t.result)}</span>` : ''}</div>`).join('')}</div>`;
    }
    const bare = m.type === 'image' && m.sticker;       // 表情包不套气泡
    return `<div class="cx-item" data-id="${esc(m.id)}">
      <div class="cx-row${isAi ? '' : ' me'}">${avHtml(isAi ? 'cy' : 'nor')}
        <div class="cx-col">${extra}
          <div class="cx-bubble ${isAi ? 'ai' : 'mine'}${bare ? ' bare' : ''}${m.type === 'image' && !bare ? ' pic' : ''}" data-act="bubble">${quoteHtml(m.quote)}${bodyHtml(m)}</div>
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
    box.scrollTop = top + (box.scrollHeight - before);  // 视线停在原来那条上，不跳
  }
  function repaintRow(m) {
    const n = document.querySelector(`#cx-msgs .cx-item[data-id="${CSS.escape(m.id)}"]`); if (!n) return;
    const wrap = document.createElement('div'); wrap.innerHTML = rowHtml(m);
    // 正在播的语音不能被换掉
    const playing = [...n.querySelectorAll('audio')].some(a => !a.paused);
    if (playing) { const meta = n.querySelector('.cx-meta'), fm = wrap.querySelector('.cx-meta'); if (meta && fm) meta.innerHTML = fm.innerHTML; return; }
    n.replaceWith(wrap.firstElementChild);
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
          <button class="cx-tb" id="cx-rec" onclick="CX.rec()" title="按一下开始录，再按一下发">麦</button>
          <span class="cx-sp"></span>
          <select class="cx-model" id="cx-model" title="模型（现在只记录，换不动辞当前的模型）" onchange="CX.setModel(this.value)">
            ${MODELS.map(x => `<option${x === model() ? ' selected' : ''}>${x}</option>`).join('')}
            <option disabled>自定义 API（以后）</option>
          </select>
          <button class="cx-tb" onclick="CX.newline()" title="换行">↵</button>
          <button class="cx-send" onclick="CX.send()" title="发送">↑</button>
        </div>
        <div id="cx-msg" class="cx-hint"></div>
      </div>
      <div id="cx-pop" class="cx-pop" hidden></div>
      <div id="cx-set" class="cx-set" hidden></div>
    </div>`;
    const ta = $('#cx-text');
    // 中文输入法按回车是在选字，这时候不能当成发送
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); CX.send(); } });
    ta.addEventListener('input', autoGrow);
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
    if (act === 'think' || act === 'tools') {
      const key = (act === 'think' ? 't' : 'x') + m.id;
      expanded[key] = !expanded[key];
      el.querySelector('.cx-arrow').classList.toggle('on', expanded[key]);
      el.nextElementSibling.hidden = !expanded[key];
    } else if (act === 'vt') {
      const t = el.closest('.cx-bubble').querySelector('.cx-voice-text');
      t.hidden = !t.hidden; el.textContent = t.hidden ? '转文字' : '收起';
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
      merge([m], 'bottom');
      appendRows([m]);
      return m;
    } catch (e) { hint('发不出去：' + e.message); throw e; }
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
    async rec() {
      const btn = $('#cx-rec');
      if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
      if (!navigator.mediaDevices || !window.MediaRecorder) { hint('这个浏览器不支持录音'); return; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        chunks = []; recStart = Date.now();
        recorder = new MediaRecorder(stream);
        recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        recorder.onstop = async () => {
          clearInterval(recTimer); btn.textContent = '麦'; btn.classList.remove('on');
          stream.getTracks().forEach(t => t.stop());
          const dur = Math.round((Date.now() - recStart) / 1000);
          if (dur < 1) { hint('太短了'); return; }
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          hint('发送中…');
          const b64 = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).replace(/^data:[^;]+;base64,/, '')); fr.readAsDataURL(blob); });
          try { await sendPayload({ type: 'voice', voice_base64: b64, voice_mime: blob.type.split(';')[0], duration: dur }); hint(''); } catch {}
        };
        recorder.start();
        btn.textContent = '■'; btn.classList.add('on');
        recTimer = setInterval(() => hint(`录音中 ${Math.round((Date.now() - recStart) / 1000)}″，再点一次发送`), 500);
      } catch (e) { hint('录不了音：' + (e.message || '没给麦克风权限')); }
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
    // 设置页用：配色选择和拍一拍库
    themes: THEMES,
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
      if (timer) clearInterval(timer);
      timer = setInterval(() => poll(), 5000);   // 在聊天页 5 秒一次，辞回得快也能及时看到
      poll(); markRead(); CX.refreshStatus(); CX.loadPats();
    },
    onHide() {
      open = false;
      document.body.classList.remove('chat-open');
      if (timer) clearInterval(timer);
      timer = setInterval(() => poll(), 30000);  // 不在聊天页只更新角标
    },
    async init() {
      MW.loadPrefs().then(p => { avatars = p; }).catch(() => {});
      await poll(true);
      timer = setInterval(() => poll(), 30000);
      CX.refreshStatus(); CX.loadPats();
    }
  };
  window.CX = CX;
})();
