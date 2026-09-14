// 木屋里的异步留言。UI 照 chat mockup v4：五个主题、thinking 折叠、工具调用卡片、
// 头像开关、气泡圆角/字号可调。棋子随时发，辞苏醒时读未读并回复。
// 以后要换成实时聊天的话，这层不用重做——只是轮询换成推送。
//
// 渲染分三层，互不牵连。以前一个 render() 全包，卡顿、跳动、字被冲掉全出在这：
//   · 外壳（头、输入框、设置面板）只建一次——新消息进来不会冲掉正在打的字，手机键盘也不会收起来
//   · 消息区能追加就只追加新的——正在播的语音不断；往上翻旧消息时不会被拽回底部
//   · 外观（主题/圆角/字号/头像开关）全走 CSS 变量和 class——拖滑块不用重画几百个气泡
// 页面不在前台时轮询只更新数据和角标，不动 DOM，切回来再画。
(function () {
  const { rest, esc, fmtTime, imageUrl, apiUrl, TOKEN } = MW;
  const $ = s => document.querySelector(s);

  const THEMES = {
    sakura: { name: '樱', bg: 'linear-gradient(135deg,#fef7fa,#fdf0f5 30%,#fcecf2 60%,#fef7fa)', ai: 'rgba(255,255,255,.7)', me: 'rgba(235,200,215,.35)', text: '#5a4a55', accent: '#c9a0b2', time: '#cdbdc5', input: 'rgba(255,255,255,.55)', head: 'rgba(255,255,255,.35)', name: '#a88a98', thinkBg: 'rgba(200,170,185,.08)', thinkBd: 'rgba(200,170,185,.18)' },
    ocean: { name: '海', bg: 'linear-gradient(135deg,#f0f6f8,#e6f0f5 30%,#dfedf2 60%,#f0f6f8)', ai: 'rgba(255,255,255,.7)', me: 'rgba(185,215,228,.35)', text: '#3d5562', accent: '#89b0c2', time: '#b0c5d0', input: 'rgba(255,255,255,.55)', head: 'rgba(255,255,255,.35)', name: '#7a9aaa', thinkBg: 'rgba(137,176,194,.07)', thinkBd: 'rgba(137,176,194,.14)' },
    stone: { name: '石', dark: 1, bg: 'linear-gradient(135deg,#3d3d48,#383844 30%,#34343f 60%,#3d3d48)', ai: 'rgba(255,255,255,.06)', me: 'rgba(160,165,200,.14)', text: '#cdccd8', accent: '#9a9ec4', time: '#6e6e82', input: 'rgba(255,255,255,.05)', head: 'rgba(255,255,255,.03)', name: '#9898b0', thinkBg: 'rgba(154,158,196,.07)', thinkBd: 'rgba(154,158,196,.12)' },
    night: { name: '夜', dark: 1, bg: 'linear-gradient(135deg,#1c1c30,#181830 30%,#1a1a2e 60%,#141428)', ai: 'rgba(255,255,255,.06)', me: 'rgba(120,122,200,.16)', text: '#d8d6e2', accent: '#a0a4d4', time: '#5a5a72', input: 'rgba(255,255,255,.05)', head: 'rgba(255,255,255,.04)', name: '#9090b0', thinkBg: 'rgba(160,164,212,.06)', thinkBd: 'rgba(160,164,212,.12)' },
    mist: { name: '雾', bg: 'linear-gradient(135deg,#f6f5f2,#efede9 30%,#eceae6 60%,#f6f5f2)', ai: 'rgba(255,255,255,.7)', me: 'rgba(195,190,182,.22)', text: '#4a4742', accent: '#9e998e', time: '#c5c0b8', input: 'rgba(255,255,255,.55)', head: 'rgba(255,255,255,.35)', name: '#8a8578', thinkBg: 'rgba(158,153,142,.07)', thinkBd: 'rgba(158,153,142,.13)' }
  };
  const DEF = { theme: 'sakura', avatars: true, radius: 18, fontSize: 15, bg: '' };
  function cfg() { try { return Object.assign({}, DEF, JSON.parse(localStorage.getItem('muwen-chat-cfg') || '{}')); } catch { return { ...DEF }; } }
  function saveCfg(c) {
    try { localStorage.setItem('muwen-chat-cfg', JSON.stringify(c)); }
    catch { const m = $('#cx-msg'); if (m) m.textContent = '存不下（背景图太大了，换张小点的）'; }
    applyLook();
  }

  let msgs = [], timer = null, open = false, expanded = {}, avatars = {};
  let recorder = null, chunks = [], recStart = 0, recTimer = null;
  let built = false, renderedIds = [], dirty = true;
  let slidePending = {}, slideRaf = 0;

  function setTimer(ms) { if (timer) clearInterval(timer); timer = setInterval(load, ms); }

  async function load(initial) {
    try {
      const list = await rest('/api/chat?limit=300');
      const last = list.length ? list[list.length - 1].id : '';
      const prevLast = msgs.length ? msgs[msgs.length - 1].id : '';
      const changed = !!initial || list.length !== msgs.length || last !== prevLast;
      const readChanged = !changed && list.some((m, i) => msgs[i] && m.read !== msgs[i].read);
      msgs = list;
      if (open && built) {
        if (changed) { paintMessages(); markRead(); }
        else if (readChanged) refreshStatuses();
      } else if (changed || readChanged) dirty = true;
      updateBadge();
    } catch { /* 网络抖一下不刷屏 */ }
  }
  async function markRead() {
    const un = msgs.filter(m => m.sender === 'cy' && !m.read);
    if (!un.length) return;
    try { await fetch(apiUrl('/api/chat/read'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': TOKEN }, body: JSON.stringify({ who: 'nor', ids: un.map(m => m.id) }) }); un.forEach(m => m.read = true); updateBadge(); }
    catch {}
  }
  function unread() { return msgs.filter(m => m.sender === 'cy' && !m.read).length; }
  function updateBadge() {
    const n = unread();
    document.querySelectorAll('[data-chat-badge]').forEach(el => {
      el.textContent = n ? (n > 99 ? '99+' : n) : '';
      el.style.display = n ? 'flex' : 'none';
    });
  }

  // 棋子发的那条，辞看没看过 / 回没回
  function lastCyIndex() { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].sender === 'cy') return i; return -1; }
  function statusOf(m, i, lastCy) {
    if (m.sender !== 'nor') return '';
    if (lastCy > i) return '辞已回复';
    if (m.read) return '辞已读';
    return '已发送';
  }

  function avHtml(who) {
    const id = avatars['avatar_' + who];
    return `<div class="cx-av${id ? ' img' : ''}" data-who="${who}">${id ? `<img src="${imageUrl(id)}">` : (who === 'cy' ? '辞' : '棋')}</div>`;
  }
  function refreshAvatars() {
    document.querySelectorAll('#chat-root .cx-av[data-who]').forEach(n => {
      const box = document.createElement('div'); box.innerHTML = avHtml(n.dataset.who);
      const fresh = box.firstElementChild;
      if (n.outerHTML !== fresh.outerHTML) n.replaceWith(fresh);
    });
  }

  function rowHtml(m, i, lastCy) {
    let h = '';
    const prevDate = i ? msgs[i - 1].date : '';
    if (m.date !== prevDate) h += `<div class="cx-day">— ${esc(m.date)} —</div>`;
    const isAi = m.sender === 'cy';
    const time = esc(fmtTime(m.at).slice(11));
    if (isAi && m.thinking) {
      const on = !!expanded[m.id];
      h += `<div class="cx-think-wrap" data-think="${esc(m.id)}">
        <button class="cx-think-btn" onclick="CX.toggle('${esc(m.id)}')"><span class="cx-arrow${on ? ' on' : ''}">▶</span><i>thinking…</i><span class="cx-t">${time}</span></button>
        ${on ? `<div class="cx-think">${esc(m.thinking)}</div>` : ''}</div>`;
    }
    if (isAi && (m.tools || []).length) {
      h += m.tools.map(tl => `<div class="cx-tool-wrap"><div class="cx-tool">
        <span><span class="cx-bolt">⚡</span> <code>${esc(tl.name)}</code></span><span class="cx-t">${esc(tl.result || '')}</span></div></div>`).join('');
    }
    // 棋子录的语音：只有音频。辞的语音回复：文字＋音频都给，她可以读也可以听。
    const bubble = m.type === 'voice'
      ? `<audio controls preload="none" style="max-width:210px" src="${apiUrl('/api/chat/voice/' + m.id)}"></audio>`
      : esc(m.content) + (m.voice_id ? `<audio class="cx-tts" controls preload="none" src="${MW.audioUrl(m.voice_id)}"></audio>` : '');
    const st = statusOf(m, i, lastCy);
    h += `<div class="cx-row${isAi ? '' : ' me'}">${avHtml(isAi ? 'cy' : 'nor')}
      <div class="cx-bw${isAi ? '' : ' me'}"><div class="cx-bubble ${isAi ? 'ai' : 'mine'}">${bubble}</div>
      <span class="cx-time"${m.sender === 'nor' ? ` data-st="${esc(m.id)}"` : ''} data-time="${time}">${time}${st ? ' · ' + st : ''}</span></div></div>`;
    return h;
  }

  // forceBottom：刚打开 / 刚发完。其余时候只有本来就在底部附近才跟着滚，往上翻着的不打扰。
  function paintMessages(forceBottom) {
    const box = $('#cx-msgs'); if (!box) return;
    if (!msgs.length) {
      box.innerHTML = '<div class="cx-empty">还没有留言。<br>发一条，辞醒来会看到。</div>';
      renderedIds = []; dirty = false; return;
    }
    const ids = msgs.map(m => m.id);
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const lastCy = lastCyIndex();
    const canAppend = renderedIds.length > 0 && renderedIds.length <= ids.length && renderedIds.every((id, i) => id === ids[i]);
    if (canAppend) {
      let h = '';
      for (let i = renderedIds.length; i < msgs.length; i++) h += rowHtml(msgs[i], i, lastCy);
      if (h) box.insertAdjacentHTML('beforeend', h);
    } else {
      const top = box.scrollTop;
      let h = '';
      for (let i = 0; i < msgs.length; i++) h += rowHtml(msgs[i], i, lastCy);
      box.innerHTML = h;
      box.scrollTop = top;
    }
    renderedIds = ids;
    dirty = false;
    refreshStatuses();
    if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
  }
  function refreshStatuses() {
    const lastCy = lastCyIndex();
    const idx = new Map(msgs.map((m, i) => [m.id, i]));
    document.querySelectorAll('#cx-msgs .cx-time[data-st]').forEach(n => {
      const i = idx.get(n.dataset.st); if (i == null) return;
      const st = statusOf(msgs[i], i, lastCy);
      const txt = n.dataset.time + (st ? ' · ' + st : '');
      if (n.textContent !== txt) n.textContent = txt;
    });
  }

  function applyLook() {
    const root = $('#chat-root .cx'); if (!root) return;
    const c = cfg(), t = THEMES[c.theme] || THEMES.sakura;
    root.style.background = c.bg ? `url("${c.bg}") center/cover` : t.bg;
    const v = {
      '--cx-ai': t.ai, '--cx-me': t.me, '--cx-text': t.text, '--cx-accent': t.accent, '--cx-time': t.time,
      '--cx-input': t.input, '--cx-head': t.head, '--cx-name': t.name, '--cx-think-bg': t.thinkBg, '--cx-think-bd': t.thinkBd,
      '--cx-av-bg': t.accent + '28', '--cx-radius': c.radius + 'px', '--cx-font': c.fontSize + 'px',
      '--cx-set-bg': t.dark ? 'rgba(40,40,55,.96)' : 'rgba(255,255,255,.96)'
    };
    for (const k in v) root.style.setProperty(k, v[k]);
    root.classList.toggle('no-av', !c.avatars);
  }

  function buildShell() {
    const root = $('#chat-root'); if (!root) return false;
    root.innerHTML = `<div class="cx">
      <div class="cx-head">
        <div style="display:flex;align-items:center;gap:10px">${avHtml('cy')}
          <div><div class="cx-title">小辞</div><div class="cx-sub">何辞 · 不在线时也会看到</div></div></div>
        <button class="cx-gear" onclick="CX.settings()">✧</button>
      </div>
      <div class="cx-msgs" id="cx-msgs"></div>
      <div class="cx-input-wrap">
        <div class="cx-input">
          <input id="cx-text" type="text" placeholder="说点什么…" enterkeyhint="send">
          <button class="cx-btn" id="cx-rec" onclick="CX.rec()">●</button>
          <button class="cx-btn cx-send" onclick="CX.send()">↑</button>
        </div>
        <div id="cx-msg" class="cx-hint"></div>
      </div>
      <div id="cx-set" class="cx-set" style="display:none"></div>
    </div>`;
    // 中文输入法按回车是在选字，这时候不能当成发送
    $('#cx-text').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) CX.send(); });
    built = true; renderedIds = [];
    applyLook();
    return true;
  }

  const CX = {
    // 只展开/收起这一条，不重画整个列表
    toggle(id) {
      expanded[id] = !expanded[id];
      const wrap = document.querySelector(`#cx-msgs [data-think="${CSS.escape(id)}"]`); if (!wrap) return;
      const arrow = wrap.querySelector('.cx-arrow'); if (arrow) arrow.classList.toggle('on', expanded[id]);
      const body = wrap.querySelector('.cx-think');
      const m = msgs.find(x => x.id === id);
      if (expanded[id] && !body && m) wrap.insertAdjacentHTML('beforeend', `<div class="cx-think">${esc(m.thinking)}</div>`);
      if (!expanded[id] && body) body.remove();
    },
    async send() {
      const inp = $('#cx-text'); const text = inp.value.trim(); if (!text) return;
      inp.value = '';
      try {
        const r = await fetch(apiUrl('/api/chat'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': TOKEN }, body: JSON.stringify({ sender: 'nor', type: 'text', content: text }) });
        if (!r.ok) throw new Error((await r.json()).error || '发不出去');
        await load();
        const box = $('#cx-msgs'); if (box) box.scrollTop = box.scrollHeight;
      } catch (e) { $('#cx-msg').textContent = '发不出去：' + e.message; inp.value = text; }
    },
    async rec() {
      const btn = $('#cx-rec'), msg = $('#cx-msg');
      if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
      if (!navigator.mediaDevices || !window.MediaRecorder) { msg.textContent = '这个浏览器不支持录音'; return; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        chunks = []; recStart = Date.now();
        recorder = new MediaRecorder(stream);
        recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        recorder.onstop = async () => {
          clearInterval(recTimer); btn.textContent = '●'; btn.classList.remove('on');
          stream.getTracks().forEach(t => t.stop());
          const dur = Math.round((Date.now() - recStart) / 1000);
          if (dur < 1) { msg.textContent = '太短了'; return; }
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          msg.textContent = '发送中…';
          const b64 = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).replace(/^data:[^;]+;base64,/, '')); fr.readAsDataURL(blob); });
          try {
            const r = await fetch(apiUrl('/api/chat'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': TOKEN }, body: JSON.stringify({ sender: 'nor', type: 'voice', voice_base64: b64, voice_mime: blob.type.split(';')[0], duration: dur }) });
            if (!r.ok) throw new Error((await r.json()).error || '发不出去');
            msg.textContent = ''; await load();
            const box = $('#cx-msgs'); if (box) box.scrollTop = box.scrollHeight;
          } catch (e) { msg.textContent = '语音发不出去：' + e.message; }
        };
        recorder.start();
        btn.textContent = '■'; btn.classList.add('on');
        recTimer = setInterval(() => { msg.textContent = `录音中 ${Math.round((Date.now() - recStart) / 1000)}s，再点一次结束`; }, 500);
      } catch (e) { msg.textContent = '录不了音：' + (e.message || '没给麦克风权限'); }
    },
    // keep=true：只刷新面板内容，不切换开关（改主题/头像开关之后用）
    settings(keep) {
      const box = $('#cx-set'); if (!box) return;
      if (!keep && box.style.display === 'block') { box.style.display = 'none'; return; }
      box.style.display = 'block';
      const c = cfg();
      box.innerHTML = `<div style="font-size:13px;font-weight:600;margin-bottom:10px">聊天外观</div>
        <div class="cx-set-l">主题</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          ${Object.entries(THEMES).map(([k, t]) => `<button class="cx-sw" style="background:${t.bg};border-color:${c.theme === k ? t.accent : 'transparent'};color:${t.dark ? '#bbb' : t.text}" onclick="CX.set('theme','${k}')">${t.name}</button>`).join('')}
        </div>
        <div class="cx-set-row"><span>显示头像</span>
          <button class="cx-tg${c.avatars ? ' on' : ''}" onclick="CX.set('avatars',${!c.avatars})"><i></i></button></div>
        <div class="cx-set-l">气泡圆角 <span id="cx-v-radius">${c.radius}</span>px</div>
        <input type="range" min="4" max="24" value="${c.radius}" oninput="CX.slide('radius',this.value)">
        <div class="cx-set-l">字号 <span id="cx-v-fontSize">${c.fontSize}</span>px</div>
        <input type="range" min="12" max="20" value="${c.fontSize}" oninput="CX.slide('fontSize',this.value)">
        <div class="cx-set-l">背景图</div>
        <label class="cx-file">选图片<input type="file" accept="image/*" style="display:none" onchange="CX.bg(this)"></label>
        ${c.bg ? `<span class="cx-clear" onclick="CX.set('bg','')">清除</span>` : ''}
        <div class="cx-set-l" style="margin-top:10px">头像在木屋首页点头像那里换（两边共用）</div>`;
    },
    set(k, v) { const c = cfg(); c[k] = v; saveCfg(c); CX.settings(true); },
    // 滑块 oninput 一秒几十次：只改 CSS 变量，而且一帧最多改一次
    slide(k, v) {
      slidePending[k] = Number(v);
      const s = $('#cx-v-' + k); if (s) s.textContent = v;
      if (slideRaf) return;
      slideRaf = requestAnimationFrame(() => { slideRaf = 0; const c = Object.assign(cfg(), slidePending); slidePending = {}; saveCfg(c); });
    },
    bg(input) {
      const f = input.files && input.files[0]; if (!f) return;
      const fr = new FileReader(); fr.onload = () => { const c = cfg(); c.bg = String(fr.result); saveCfg(c); CX.settings(true); }; fr.readAsDataURL(f);
    },
    async onShow() {
      open = true;
      if (!built && !buildShell()) return;
      setTimer(10000);
      const fresh = await MW.loadPrefs().catch(() => ({}));
      const avChanged = JSON.stringify(fresh) !== JSON.stringify(avatars);
      avatars = fresh;
      if (avChanged) refreshAvatars();
      if (dirty || !renderedIds.length) paintMessages(true);
      await load();
      markRead();
    },
    onHide() { open = false; setTimer(20000); },
    init() { load(true); setTimer(20000); }
  };
  window.CX = CX;
})();
