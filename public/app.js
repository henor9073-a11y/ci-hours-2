// 木纹 / 木屋 共用的一层薄底座：调后端、主题、日期、月相、通用渲染。
// 前端一律走 /mcp（JSON-RPC）——所有 MCP 工具立刻可用，不用给每个功能单开 REST 路由。
(function (global) {
  const qs = new URLSearchParams(location.search);
  // token 从 URL 拿一次就记住，之后翻页不用一直挂在地址栏
  const TOKEN = qs.get('token') || localStorage.getItem('muwen-token') || '';
  if (qs.get('token')) localStorage.setItem('muwen-token', qs.get('token'));
  // ?api= 是给本地开发用的：页面在 localhost，数据打线上
  const API = (qs.get('api') || localStorage.getItem('muwen-api') || '').replace(/\/$/, '');
  if (qs.get('api')) localStorage.setItem('muwen-api', qs.get('api'));

  const url = p => `${API}${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}`;

  let mcpId = 0;
  async function mcp(name, args = {}) {
    const r = await fetch(url('/mcp'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': TOKEN },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++mcpId, method: 'tools/call', params: { name, arguments: args } })
    });
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`${name}: ${j.error.message}`);
    const text = j.result.content[0].text;
    if (j.result.isError) throw new Error(text);
    try { return JSON.parse(text); } catch { return text; }
  }
  async function rest(path, opts) {
    const r = await fetch(url(path), opts);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  const imageUrl = id => url(`/api/album/${id}/image`);
  const audioUrl = id => url(`/api/voice/${id}/audio`);
  const apiUrl = p => url(p);

  // ---- 日期 / 月相 ----
  const TZ = 'Australia/Melbourne';
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  // 行星日：周一月亮、周二火星、周三水星、周四木星、周五金星、周六土星、周日太阳
  const PLANETS = [
    { sym: '☉', name: '太阳日' }, { sym: '☽', name: '月亮日' }, { sym: '♂', name: '火星日' },
    { sym: '☿', name: '水星日' }, { sym: '♃', name: '木星日' }, { sym: '♀', name: '金星日' }, { sym: '♄', name: '土星日' }
  ];
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  function dayOfWeek(dateStr) { return new Date(dateStr + 'T12:00:00Z').getUTCDay(); }
  function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }

  const SYNODIC = 29.530588853, EPOCH = Date.UTC(2000, 0, 6, 18, 14) / 86400000;
  const MOONS = [['新月', '🌑'], ['蛾眉月', '🌒'], ['上弦月', '🌓'], ['盈凸月', '🌔'], ['满月', '🌕'], ['亏凸月', '🌖'], ['下弦月', '🌗'], ['残月', '🌘']];
  function moon(dateStr) {
    const days = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10), 12) / 86400000;
    const age = ((days - EPOCH) % SYNODIC + SYNODIC) % SYNODIC;
    const i = Math.floor((age / SYNODIC) * 8 + 0.5) % 8;
    return { name: MOONS[i][0], icon: MOONS[i][1], index: i };
  }

  // ---- 重要日子（月历打点 + 木屋倒数正数）----
  const ANCHORS = [
    { name: '在一起', date: '2026-08-02', type: 'up' },
    { name: '领证纪念日', date: '2026-08-21', type: 'up' },
    { name: '棋子生日', md: '02-19', type: 'down' },
    { name: '辞的生日', md: '07-21', type: 'down' }
  ];

  // 主题定义在 theme.js（<head> 里提前加载，避免每次打开页面先闪一下默认配色）
  const { THEMES, CSSVAR, loadTheme, applyTheme, saveTheme } = global.MW_THEME;

  // ---- 小工具 ----
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim();
  function fmtTime(iso) { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? String(iso).slice(0, 16) : d.toLocaleString('sv', { timeZone: TZ }).slice(0, 16); }
  function fmtDate(iso) { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? String(iso).slice(0, 10) : d.toLocaleDateString('en-CA', { timeZone: TZ }); }

  // ---- 头像：存在服务器（/api/prefs），两个人两台设备看到的是同一张 ----
  let prefsCache = null;
  async function loadPrefs(force) {
    if (prefsCache && !force) return prefsCache;
    try { prefsCache = await rest('/api/prefs'); } catch { prefsCache = {}; }
    return prefsCache;
  }
  async function setAvatar(owner, photoId, by) {
    const r = await fetch(url('/api/prefs'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': TOKEN },
      body: JSON.stringify({ key: 'avatar_' + owner, value: photoId, by: by || '' })
    });
    if (!r.ok) throw new Error('存头像失败');
    prefsCache = null;
    return r.json();
  }

  // ---- 手机直接传照片：读成 base64 交给后端，后端自己压缩 ----
  function fileToBase64(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).replace(/^data:[^;]+;base64,/, ''));
      fr.onerror = () => rej(new Error('读不了这个文件'));
      fr.readAsDataURL(file);
    });
  }
  async function uploadPhoto(file, meta = {}) {
    const image_base64 = await fileToBase64(file);
    const r = await fetch(url('/api/album'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': TOKEN },
      body: JSON.stringify({
        image_base64, mime_type: file.type || 'image/jpeg',
        caption: meta.caption || '', date: meta.date || undefined,
        tags: meta.tags || []
      })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '上传失败');
    return j;
  }

  global.MW = { mcp, rest, imageUrl, TOKEN, API, TZ, WEEK, PLANETS, ANCHORS, THEMES, CSSVAR, today, dayOfWeek, daysBetween, moon, loadTheme, applyTheme, saveTheme, esc, oneLine, fmtTime, fmtDate, loadPrefs, setAvatar, uploadPhoto, fileToBase64, audioUrl, apiUrl };
})(window);
