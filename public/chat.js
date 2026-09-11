// 木屋里的异步留言。UI 照 chat mockup v4：五个主题、thinking 折叠、工具调用卡片、
// 头像开关、气泡圆角/字号可调。棋子随时发，辞苏醒时读未读并回复。
// 以后要换成实时聊天的话，这层不用重做——只是轮询换成推送。
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
  function saveCfg(c) { localStorage.setItem('muwen-chat-cfg', JSON.stringify(c)); render(); }

  let msgs = [], lastId = '', timer = null, open = false, expanded = {}, avatars = {}, recorder = null, chunks = [], recStart = 0, recTimer = null;

  async function load(initial) {
    try {
      const list = await rest('/api/chat?limit=300');
      const changed = list.length !== msgs.length || (list.length && list[list.length - 1].id !== lastId);
      msgs = list;
      lastId = list.length ? list[list.length - 1].id : '';
      if (changed || initial) { render(); if (open) markRead(); }
      updateBadge();
    } catch { /* 网络抖一下不刷屏 */ }
  }
  async function markRead() {
    const un = msgs.filter(m => m.sender === 'cy' && !m.read);
    if (!un.length) return;
    try { await fetch(apiUrl('/api/chat/read'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': TOKEN }, body: JSON.stringify({ who: 'nor', ids: un.map(m => m.id) }) }); un.forEach(m => m.read = true); }
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
  function statusOf(m, i) {
    if (m.sender !== 'nor') return '';
    if (msgs.slice(i + 1).some(x => x.sender === 'cy')) return '辞已回复';
    if (m.read) return '辞已读';
    return '已发送';
  }

  function render() {
    const root = $('#chat-root'); if (!root) return;
    const c = cfg(), t = THEMES[c.theme] || THEMES.sakura;
    const av = (who) => {
      const id = avatars['avatar_' + who];
      const inner = id ? `<img src="${imageUrl(id)}">` : (who === 'cy' ? '辞' : '棋');
      return `<div class="cx-av" style="background:${id ? 'transparent' : t.accent + '28'};color:${t.accent}">${inner}</div>`;
    };
    let body = '';
    let lastDate = '';
    msgs.forEach((m, i) => {
      if (m.date !== lastDate) { lastDate = m.date; body += `<div class="cx-day" style="color:${t.time}">— ${esc(m.date)} —</div>`; }
      const isAi = m.sender === 'cy';
      if (isAi && m.thinking) {
        const on = expanded[m.id];
        body += `<div class="cx-think-wrap" style="padding-left:${c.avatars ? 40 : 0}px">
          <button class="cx-think-btn" style="background:${t.thinkBg};border-color:${t.thinkBd};color:${t.name}" onclick="CX.toggle('${m.id}')">
            <span style="transform:rotate(${on ? 90 : 0}deg)">▶</span><i>thinking…</i><span style="color:${t.time}">${esc(fmtTime(m.at).slice(11))}</span></button>
          ${on ? `<div class="cx-think" style="background:${t.thinkBg};border-color:${t.thinkBd};color:${t.name}">${esc(m.thinking)}</div>` : ''}</div>`;
      }
      if (isAi && (m.tools || []).length) {
        body += (m.tools || []).map(tl => `<div class="cx-tool-wrap" style="padding-left:${c.avatars ? 40 : 0}px">
          <div class="cx-tool" style="background:${t.thinkBg};border-color:${t.thinkBd}">
            <span><span style="color:${t.accent};opacity:.7">⚡</span> <code style="color:${t.name}">${esc(tl.name)}</code></span>
            <span style="color:${t.time}">${esc(tl.result || '')}</span></div></div>`).join('');
      }
      // 棋子录的语音：只有音频。辞的语音回复：文字＋音频都给，她可以读也可以听。
      const bubble = m.type === 'voice'
        ? `<audio controls preload="none" style="max-width:210px" src="${apiUrl('/api/chat/voice/' + m.id)}"></audio>`
        : esc(m.content) + (m.voice_id ? `<audio class="cx-tts" controls preload="none" src="${MW.audioUrl(m.voice_id)}"></audio>` : '');
      const st = statusOf(m, i);
      body += `<div class="cx-row${isAi ? '' : ' me'}">
        ${c.avatars ? av(isAi ? 'cy' : 'nor') : ''}
        <div class="cx-bw${isAi ? '' : ' me'}">
          <div class="cx-bubble" style="border-radius:${c.radius}px;background:${isAi ? t.ai : t.me};color:${t.text};font-size:${c.fontSize}px">${bubble}</div>
          <span class="cx-time" style="color:${t.time}">${esc(fmtTime(m.at).slice(11))}${st ? ' · ' + st : ''}</span>
        </div></div>`;
    });
    if (!msgs.length) body = `<div class="cx-empty" style="color:${t.time}">还没有留言。<br>发一条，辞醒来会看到。</div>`;

    root.innerHTML = `<div class="cx" style="background:${c.bg ? `url(${c.bg}) center/cover` : t.bg}">
      <div class="cx-head" style="background:${t.head};border-color:${t.thinkBd}">
        <div style="display:flex;align-items:center;gap:10px">${c.avatars ? av('cy') : ''}
          <div><div style="font-size:17px;font-weight:600;color:${t.text}">小辞</div>
          <div style="font-size:11px;color:${t.name}">何辞 · 不在线时也会看到</div></div></div>
        <button class="cx-gear" style="color:${t.accent}" onclick="CX.settings()">✧</button>
      </div>
      <div class="cx-msgs" id="cx-msgs">${body}</div>
      <div class="cx-input-wrap" style="background:${t.head}">
        <div class="cx-input" style="background:${t.input};border-color:${t.thinkBd}">
          <input id="cx-text" type="text" placeholder="说点什么…" style="color:${t.text}" enterkeyhint="send">
          <button class="cx-btn" id="cx-rec" style="background:${t.thinkBg};color:${t.accent}" onclick="CX.rec()">●</button>
          <button class="cx-btn" style="background:${t.accent}" onclick="CX.send()">↑</button>
        </div>
        <div id="cx-msg" class="cx-hint" style="color:${t.time}"></div>
      </div>
      <div id="cx-set" class="cx-set" style="display:none;background:${t.dark ? 'rgba(40,40,55,.96)' : 'rgba(255,255,255,.96)'};color:${t.text}"></div>
    </div>`;
    const inp = $('#cx-text');
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') CX.send(); });
    const box = $('#cx-msgs'); if (box) box.scrollTop = box.scrollHeight;
  }

  const CX = {
    toggle(id) { expanded[id] = !expanded[id]; render(); },
    async send() {
      const inp = $('#cx-text'); const text = inp.value.trim(); if (!text) return;
      inp.value = '';
      try {
        const r = await fetch(apiUrl('/api/chat'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': TOKEN }, body: JSON.stringify({ sender: 'nor', type: 'text', content: text }) });
        if (!r.ok) throw new Error((await r.json()).error || '发不出去');
        await load();
      } catch (e) { $('#cx-msg').textContent = '发不出去：' + e.message; inp.value = text; }
    },
    async rec() {
      const btn = $('#cx-rec'), msg = $('#cx-msg');
      if (recorder && recorder.state === 'recording') {
        recorder.stop(); return;
      }
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
          } catch (e) { msg.textContent = '语音发不出去：' + e.message; }
        };
        recorder.start();
        btn.textContent = '■'; btn.classList.add('on');
        recTimer = setInterval(() => { msg.textContent = `录音中 ${Math.round((Date.now() - recStart) / 1000)}s，再点一次结束`; }, 500);
      } catch (e) { msg.textContent = '录不了音：' + (e.message || '没给麦克风权限'); }
    },
    settings() {
      const box = $('#cx-set'); const c = cfg();
      if (box.style.display === 'block') { box.style.display = 'none'; return; }
      box.style.display = 'block';
      box.innerHTML = `<div style="font-size:13px;font-weight:600;margin-bottom:10px">聊天外观</div>
        <div class="cx-set-l">主题</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          ${Object.entries(THEMES).map(([k, t]) => `<button class="cx-sw" style="background:${t.bg};border-color:${c.theme === k ? t.accent : 'transparent'};color:${t.dark ? '#bbb' : t.text}" onclick="CX.set('theme','${k}')">${t.name}</button>`).join('')}
        </div>
        <div class="cx-set-row"><span>显示头像</span>
          <button class="cx-tg${c.avatars ? ' on' : ''}" onclick="CX.set('avatars',${!c.avatars})"><i></i></button></div>
        <div class="cx-set-l">气泡圆角 ${c.radius}px</div>
        <input type="range" min="4" max="24" value="${c.radius}" oninput="CX.set('radius',this.value,1)">
        <div class="cx-set-l">字号 ${c.fontSize}px</div>
        <input type="range" min="12" max="20" value="${c.fontSize}" oninput="CX.set('fontSize',this.value,1)">
        <div class="cx-set-l">背景图</div>
        <label class="cx-file">选图片<input type="file" accept="image/*" style="display:none" onchange="CX.bg(this)"></label>
        ${c.bg ? `<span class="cx-clear" onclick="CX.set('bg','')">清除</span>` : ''}
        <div class="cx-set-l" style="margin-top:10px">头像在木屋首页点头像那里换（两边共用）</div>`;
    },
    set(k, v, keepOpen) {
      const c = cfg(); c[k] = (k === 'radius' || k === 'fontSize') ? Number(v) : v; saveCfg(c);
      if (keepOpen) CX.settings(), CX.settings();
    },
    bg(input) {
      const f = input.files && input.files[0]; if (!f) return;
      const fr = new FileReader(); fr.onload = () => { const c = cfg(); c.bg = String(fr.result); saveCfg(c); }; fr.readAsDataURL(f);
    },
    async onShow() {
      open = true;
      avatars = await MW.loadPrefs().catch(() => ({}));
      await load(true);
      markRead();
      if (!timer) timer = setInterval(load, 10000);
    },
    onHide() { open = false; },
    init() { load(true); if (!timer) timer = setInterval(load, 20000); }
  };
  window.CX = CX;
})();
