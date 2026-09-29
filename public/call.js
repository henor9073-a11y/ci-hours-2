// 木屋持续通话：通话状态走 ci-hours，语句仍送进 GPD 上辞当前的 Claude Code channel。
(function () {
  const { rest, apiUrl, TOKEN, esc, loadPrefs, imageUrl } = MW;
  const post = async (p, body = {}) => {
    const r = await fetch(apiUrl(p), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': TOKEN }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j;
  };
  const DEFLOOK = { bg: '', bgAlpha: 70, panelAlpha: 44, blur: 20, fontSize: 18, text: '#ffffff', subText: '#ded7df', buttonSize: 62, accept: '#55b982', hangup: '#d85858', normal: '#6e687d' };
  const look = () => { try { return { ...DEFLOOK, ...JSON.parse(localStorage.getItem('muwen-call-look') || '{}') }; } catch { return { ...DEFLOOK }; } };
  const saveLook = x => { localStorage.setItem('muwen-call-look', JSON.stringify(x)); paintLook(); };
  let state = null, seen = new Set(), minimized = false, muted = false, timer = null, tickTimer = null, lastUnlockAt = 0;
  let stream = null, ctx = null, analyser = null, detector = null, recorder = null, speechAt = 0, captureStartedAt = 0, micStopping = false;
  let audio = new Audio(), subtitle = [], needsAudioUnlock = false;
  let playCtx = null, playGain = null, playKeeper = null, voiceSource = null;
  const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
  let audioUnlocked = false;

  function unlockAudio() {
    // iOS 会把每个新 MP3 当成一次新播放。用户点一次后保持一个 Web Audio 通道常驻，
    // 后续每句话都在这个通道里播，不再逐句索要手势。
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (IS_IOS && AudioCtx && !playCtx) {
      playCtx = new AudioCtx(); playGain = playCtx.createGain(); playGain.gain.value = 1; playGain.connect(playCtx.destination);
      playKeeper = playCtx.createOscillator(); const quiet = playCtx.createGain(); quiet.gain.value = .000001;
      playKeeper.connect(quiet); quiet.connect(playCtx.destination); playKeeper.start();
    }
    const resumed = playCtx ? playCtx.resume() : Promise.reject(new Error('Web Audio unavailable'));
    resumed.then(() => { audioUnlocked = true; needsAudioUnlock = false; paint(); }).catch(() => {});
    // 同时解锁普通 audio，供不支持 Web Audio 的浏览器备用。
    audio.src = SILENT;
    const p = audio.play();
    if (p && p.then) p.then(() => { audioUnlocked = true; needsAudioUnlock = false; paint(); }).catch(() => { if (!playCtx || playCtx.state !== 'running') audioUnlocked = false; paint(); });
    return resumed;
  }

  function ensure() {
    if (document.getElementById('call-layer')) return;
    document.body.insertAdjacentHTML('beforeend', `<div id="call-layer" hidden></div><div id="call-mini" hidden></div>`);
    const layer = document.getElementById('call-layer');
    const unlockOnPress = e => {
      const hit = e.target && e.target.closest && e.target.closest('.call-unlock,.call-subtitles[role="button"],.call-sound-toggle');
      if (!hit || Date.now() - lastUnlockAt < 600) return;
      lastUnlockAt = Date.now(); e.preventDefault();
      if (hit.matches('.call-sound-toggle')) { hit.textContent = '正在开启…'; CALL.enableSound(); return; }
      const button = hit.matches('.call-unlock') ? hit : hit.querySelector('.call-unlock');
      if (button) button.textContent = '正在开启…';
      CALL.unlockAndReplay();
    };
    // 监听稳定的最外层，而不是每两秒会重画的按钮；pointerdown 也能保住 iPhone 要求的直接用户手势。
    layer.addEventListener('pointerdown', unlockOnPress, true);
    layer.addEventListener('touchstart', unlockOnPress, { capture: true, passive: false });
  }
  function paintLook() {
    ensure(); const l = look(), root = document.documentElement;
    const vars = { '--call-bg': l.bg ? `url("${l.bg}")` : 'linear-gradient(145deg,#292632,#12131a)', '--call-bg-a': l.bgAlpha / 100, '--call-panel-a': l.panelAlpha / 100, '--call-blur': l.blur + 'px', '--call-font': l.fontSize + 'px', '--call-text': l.text, '--call-sub': l.subText, '--call-btn': l.buttonSize + 'px', '--call-accept': l.accept, '--call-hang': l.hangup, '--call-normal': l.normal };
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  }
  const elapsed = c => {
    const t = c && c.accepted_at ? Date.parse(c.accepted_at) : 0; if (!t) return '00:00';
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  async function avatar() { const p = await loadPrefs().catch(() => ({})); return p.avatar_cy ? imageUrl(p.avatar_cy) : ''; }
  function buttons(active) {
    return active ? `<div class="call-actions"><button class="call-btn normal${muted ? ' on' : ''}" onclick="CALL.mute()">${muted ? '取消静音' : '静音'}</button><button class="call-btn hang" onclick="CALL.act('hangup')">挂断</button><button class="call-btn normal" onclick="CALL.minimize()">缩小</button></div>` : '';
  }
  async function paint() {
    ensure(); paintLook(); const c = state && state.call, layer = document.getElementById('call-layer'), mini = document.getElementById('call-mini');
    if (!c || !state.active) { layer.hidden = mini.hidden = true; stopMic(); return; }
    const incoming = c.status === 'ringing' && c.caller === 'cy';
    const outgoing = c.status === 'ringing' && c.caller === 'nor';
    if (minimized) {
      layer.hidden = true; mini.hidden = false;
      mini.innerHTML = `<div onclick="CALL.expand()"><b>小辞 · ${outgoing ? '等待接听' : incoming ? '来电等待' : elapsed(c)}</b><span>${esc(subtitle.at(-1) || (incoming ? '点击接听' : '正在通话'))}</span></div><button onclick="CALL.mute()">${muted ? '已静音' : '静音'}</button><button onclick="CALL.act('hangup')">挂断</button>`;
      return;
    }
    mini.hidden = true; layer.hidden = false; const av = await avatar();
    const status = incoming ? '小辞来电' : outgoing ? '正在呼叫小辞…' : c.status === 'reconnecting' ? '正在重新连接…' : elapsed(c);
    layer.innerHTML = `<div class="call-bg"></div><div class="call-screen"><div class="call-time" data-call-time>${status}</div>
      <div class="call-avatar">${av ? `<img src="${av}" alt="">` : '辞'}</div><div class="call-name">小辞</div>
      <button type="button" class="call-sound-toggle${audioUnlocked ? ' on' : ''}" aria-pressed="${audioUnlocked}">${audioUnlocked ? '声音已开启' : '提前开启声音'}</button>
      <div class="call-subtitles"${needsAudioUnlock ? ' role="button" aria-label="开启声音"' : ''}>${subtitle.length ? subtitle.slice(-3).map(x => `<div>${esc(x)}</div>`).join('') : `<div class="quiet">${incoming ? '在自动挂断前都可以接听' : outgoing ? '等他接听…' : '正在听…'}</div>`}${needsAudioUnlock ? '<button type="button" class="call-unlock">开启声音</button>' : ''}</div>
      ${incoming ? `<div class="call-actions incoming"><button class="call-btn hang" onclick="CALL.act('reject')">拒绝</button><button class="call-btn accept" onclick="CALL.act('accept')">接听</button><button class="call-btn normal" onclick="CALL.minimize()">等待</button></div>` : outgoing ? `<div class="call-actions"><button class="call-btn hang" onclick="CALL.act('hangup')">取消</button><button class="call-btn normal" onclick="CALL.minimize()">缩小</button></div>` : buttons(true)}</div>`;
  }
  async function poll() {
    try {
      const next = await rest('/api/call/state'); state = next;
      for (const e of next.events || []) {
        if (seen.has(e.id)) continue; seen.add(e.id);
        if (e.type === 'utterance' && e.by === 'cy') { subtitle.push(e.text); if (next.settings.subtitles !== false) paint(); play(e.id); }
      }
      const c = next.call;
      if (c && c.status === 'active' && !stream) startMic();
      await paint();
    } catch { /* 下一轮重连 */ }
  }
  async function play(id) {
    if (audioUnlocked && playCtx) {
      try {
        if (playCtx.state !== 'running') await playCtx.resume();
        const r = await fetch(apiUrl('/api/call/audio/' + id)); if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const decoded = await playCtx.decodeAudioData(await r.arrayBuffer());
        if (voiceSource) try { voiceSource.stop(); } catch {}
        voiceSource = playCtx.createBufferSource(); voiceSource.buffer = decoded; voiceSource.connect(playGain); voiceSource.start();
        needsAudioUnlock = false; paint(); return;
      } catch (e) {
        if (playCtx.state === 'suspended') { audioUnlocked = false; needsAudioUnlock = true; paint(); return; }
        subtitle.push('这一句声音生成失败'); paint(); return;
      }
    }
    audio.pause(); audio.src = apiUrl('/api/call/audio/' + id); audio.preload = 'auto';
    try { await audio.play(); needsAudioUnlock = false; paint(); }
    catch {
      needsAudioUnlock = true;
      if (subtitle.at(-1) !== '声音被手机拦住了，点一下“开启声音”') subtitle.push('声音被手机拦住了，点一下“开启声音”');
      paint();
    }
  }
  async function startMic() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      micStopping = false;
      ctx = new AudioContext(); const src = ctx.createMediaStreamSource(stream); analyser = ctx.createAnalyser(); analyser.fftSize = 1024; src.connect(analyser);
      beginCapture();
      const data = new Uint8Array(analyser.fftSize); let speaking = false;
      detector = setInterval(() => {
        if (muted || !state || !state.call || state.call.status !== 'active') return;
        analyser.getByteTimeDomainData(data); let sum = 0; for (const v of data) { const x = (v - 128) / 128; sum += x * x; }
        const loud = Math.sqrt(sum / data.length) > .018, now = Date.now();
        if (loud) {
          speechAt = now;
          if (!speaking && recorder && recorder.state === 'recording') { speaking = true; audio.pause(); if (voiceSource) try { voiceSource.stop(); } catch {} }
        }
        if (speaking && !loud && now - speechAt >= (state.pause_ms || 1500)) { speaking = false; if (recorder && recorder.state === 'recording') { recorder._send = true; recorder.stop(); } }
        // 空闲时每四秒换一段，始终保留本轮开口前最多四秒，避免吞掉句首又不无限积累静音。
        if (!speaking && !loud && recorder && recorder.state === 'recording' && now - captureStartedAt > 4000) { recorder._send = false; recorder.stop(); }
      }, 80);
    } catch (e) { subtitle.push('麦克风没有开启：' + e.message); paint(); }
  }
  function beginCapture() {
    if (micStopping || !stream || !state || !state.call || state.call.status !== 'active') return;
    const rec = new MediaRecorder(stream), parts = []; rec._send = false;
    rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
    rec.onstop = () => { if (rec._send) sendRecording(parts, rec.mimeType); if (!micStopping) beginCapture(); };
    recorder = rec; captureStartedAt = Date.now(); rec.start(200);
  }
  function stopMic() { micStopping = true; if (detector) clearInterval(detector); detector = null; if (recorder && recorder.state !== 'inactive') try { recorder._send = false; recorder.stop(); } catch {} recorder = null; if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; if (ctx) ctx.close().catch(() => {}); ctx = null; }
  async function sendRecording(parts, mime) {
    const blob = new Blob(parts, { type: mime || 'audio/webm' }); if (blob.size < 1000) return;
    const b64 = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(blob); });
    try { await post('/api/call/transcribe', { audio_base64: b64, mime: blob.type }); } catch { subtitle.push('这一句没有听清'); paint(); }
  }
  async function setSetting(k, v) { const s = await post('/api/call/settings', { [k]: v }); state = state || {}; state.settings = s; renderSettings('st-call-settings'); renderSettings('cx-call-settings', true); }
  async function renderSettings(id, compact) {
    const el = document.getElementById(id); if (!el) return; const s = state && state.settings || await rest('/api/call/settings').catch(() => ({}));
    const row = (label, k) => `<div class="cx-set-row" style="font-size:${compact ? 12 : 14}px"><span>${label}</span><button class="cx-tg${s[k] ? ' on' : ''}" onclick="CALL.setting('${k}',${!s[k]})"><i></i></button></div>`;
    el.innerHTML = `${row('允许辞来电','allowIncoming')}${row('安静时间','quietEnabled')}${row('普通留言推送','messagePush')}${row('来电推送','callPush')}${row('辞的滚动字幕','subtitles')}${row('允许插话打断','interrupt')}${row('断线自动重连','reconnect')}
      <div class="call-setting-line"><label>安静时段 <input type="time" value="${s.quietStart || '23:30'}" onchange="CALL.setting('quietStart',this.value)">—<input type="time" value="${s.quietEnd || '08:00'}" onchange="CALL.setting('quietEnd',this.value)"></label></div>
      <div class="call-setting-line"><label>判断我说完 <select onchange="CALL.setting('endPause',this.value)"><option value="fast"${s.endPause==='fast'?' selected':''}>快 · 0.8 秒</option><option value="standard"${s.endPause==='standard'?' selected':''}>标准 · 1.5 秒</option><option value="slow"${s.endPause==='slow'?' selected':''}>慢 · 2.5 秒</option><option value="very_slow"${s.endPause==='very_slow'?' selected':''}>很慢 · 4 秒</option></select></label></div>
      <div class="call-setting-line"><label>通话用量 <select onchange="CALL.setting('tokenMode',this.value)"><option value="economy"${s.tokenMode==='economy'?' selected':''}>省 token · 合并短句</option><option value="balanced"${s.tokenMode==='balanced'?' selected':''}>平衡</option><option value="low_latency"${s.tokenMode==='low_latency'?' selected':''}>低延迟</option></select></label></div>
      <div class="call-setting-line"><label>来电等待 <select onchange="CALL.setting('ringSeconds',+this.value)">${[30,60,90,120].map(n=>`<option${s.ringSeconds===n?' selected':''}>${n}</option>`).join('')}</select> 秒</label></div>
      <div class="call-setting-line"><label>来电补发提醒 <select onchange="CALL.setting('barkRepeats',+this.value)">${[0,1,2].map(n=>`<option value="${n}"${s.barkRepeats===n?' selected':''}>${n===0?'不补发':n+' 次'}</option>`).join('')}</select></label></div>
      <div class="call-setting-line"><button class="btn ghost" onclick="CALL.lookPanel()">通话界面美化</button></div>`;
  }
  function lookPanel() {
    const l = look(), wrap = document.createElement('div'); wrap.className = 'call-look-pop';
    wrap.innerHTML = `<div class="call-look-card"><button class="call-look-x" onclick="this.closest('.call-look-pop').remove()">✕</button><h3>通话界面美化</h3>
      <label class="cx-file">更换背景<input type="file" accept="image/*" hidden onchange="CALL.bg(this)"></label>
      ${[['bgAlpha','背景透明度',0,100],['panelAlpha','面板透明度',0,100],['blur','磨砂',0,30],['fontSize','字体大小',13,28],['buttonSize','按钮大小',48,82]].map(([k,n,a,b])=>`<label>${n} <span>${l[k]}</span><input type="range" min="${a}" max="${b}" value="${l[k]}" oninput="CALL.look('${k}',this.value,this.previousElementSibling)"></label>`).join('')}
      ${[['text','字体颜色'],['subText','次要文字'],['accept','接听按钮'],['hangup','挂断按钮'],['normal','普通按钮']].map(([k,n])=>`<label>${n}<input type="color" value="${l[k]}" onchange="CALL.look('${k}',this.value)"></label>`).join('')}</div>`;
    document.body.appendChild(wrap);
  }
  const CALL = {
    confirmDial() {
      const wrap=document.createElement('div'); wrap.className='call-dial-confirm';
      wrap.innerHTML=`<div class="call-dial-card"><div class="call-dial-title">给小辞打电话？</div><div class="call-dial-sub">选择拨通后才会开始呼叫</div><div><button class="dial" onclick="CALL.dial();this.closest('.call-dial-confirm').remove()">拨通</button><button onclick="this.closest('.call-dial-confirm').remove()">退出</button></div></div>`;
      document.body.appendChild(wrap);
    },
    async dial() { unlockAudio(); try { await post('/api/call/start'); minimized = false; poll(); } catch(e) { alert(e.message); } },
    async act(action) { try { if (action === 'accept') unlockAudio(); await post('/api/call/action', { action }); if (action === 'accept') minimized = false; poll(); } catch(e) { alert(e.message); } },
    enableSound() { unlockAudio(); },
    unlockAndReplay() { needsAudioUnlock = false; const cy=[...(state&&state.events||[])].reverse().find(e=>e.type==='utterance'&&e.by==='cy'); if(cy) play(cy.id); else { unlockAudio(); paint(); } },
    minimize() { minimized = true; paint(); }, expand() { minimized = false; paint(); },
    mute() { muted = !muted; if (stream) stream.getAudioTracks().forEach(t => t.enabled = !muted); paint(); },
    setting: setSetting, renderSettings, lookPanel,
    look(k,v,out) { const l=look(); l[k] = ['text','subText','accept','hangup','normal'].includes(k) ? v : Number(v); saveLook(l); if(out) out.textContent=v; },
    bg(input) { const f=input.files&&input.files[0]; if(!f)return; const r=new FileReader(); r.onload=()=>{const l=look();l.bg=r.result;saveLook(l)};r.readAsDataURL(f); }
  };
  window.CALL = CALL; ensure(); paintLook(); poll(); timer = setInterval(poll, 2000); tickTimer = setInterval(() => { const n=document.querySelector('[data-call-time]'); if(n&&state&&state.call&&state.call.status==='active')n.textContent=elapsed(state.call); },1000);
})();
