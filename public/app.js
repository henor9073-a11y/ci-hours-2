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

  // ---- 主题：7 套预设 + 自定义，木纹木屋共用同一份 localStorage ----
  const THEMES = {
    current: { label: '当前（暖灰绿）', vars: { bg: '#F6F5F2', card: '#FFFFFF', primary: '#8FA39B', primaryLight: '#E4EBE8', accent: '#B49A7D', accentLight: '#F0E8DF', text: '#2D3130', textSecondary: '#7A827E', textLight: '#A8B0AC', border: '#E5E8E6' } },
    rain: { label: '雨天（浅灰蓝）', vars: { bg: '#EEF3F6', card: '#FFFFFF', primary: '#8fa5b3', primaryLight: '#cad5db', accent: '#5f7085', accentLight: '#e4ecf0', text: '#33414f', textSecondary: '#5f7085', textLight: '#9bacb8', border: '#dbe4ea' } },
    postrock: { label: '后摇（深灰）', dark: true, vars: { bg: '#1A202C', card: '#2D3748', primary: '#63B3ED', primaryLight: '#2c3f57', accent: '#9F7AEA', accentLight: '#3b3357', text: '#E2E8F0', textSecondary: '#A0AEC0', textLight: '#718096', border: '#3a4557' } },
    lavender: { label: '薰衣草（淡紫）', vars: { bg: '#F3EDF6', card: '#FFFFFF', primary: '#ceb8d6', primaryLight: '#e4d7ea', accent: '#7a6085', accentLight: '#EDE3F2', text: '#3d3143', textSecondary: '#7a6085', textLight: '#a692b0', border: '#e4d7ea' } },
    snow: { label: '雪地（白）', vars: { bg: '#EDF2F7', card: '#FFFFFF', primary: '#C4B5FD', primaryLight: '#E7E1FD', accent: '#FEB2B2', accentLight: '#FEE7E7', text: '#2D3748', textSecondary: '#718096', textLight: '#A0AEC0', border: '#E2E8F0' } },
    cabin: { label: '森林小屋（暖棕）', vars: { bg: '#FBF6EC', card: '#FFFFFF', primary: '#B7791F', primaryLight: '#F5E9CE', accent: '#744210', accentLight: '#EFE0C4', text: '#4a3208', textSecondary: '#8a6a2a', textLight: '#b49a6a', border: '#EADDC3' } },
    moonlight: { label: '月光（深蓝灰+暖金）', dark: true, vars: { bg: '#232B3A', card: '#2D3748', primary: '#D69E2E', primaryLight: '#40465a', accent: '#ECC94B', accentLight: '#4a4433', text: '#E2E8F0', textSecondary: '#A0AEC0', textLight: '#718096', border: '#3a4557' } }
  };
  const CSSVAR = { bg: '--bg', card: '--card', primary: '--primary', primaryLight: '--primary-light', accent: '--accent', accentLight: '--accent-light', text: '--text', textSecondary: '--text-secondary', textLight: '--text-light', border: '--border' };

  function loadTheme() {
    let t = {}; try { t = JSON.parse(localStorage.getItem('muwen-theme') || '{}'); } catch {}
    return { preset: t.preset || 'current', custom: t.custom || {}, ui: Object.assign({ radius: 16, fontSize: 16, lineHeight: 1.6, opacity: 100, blur: 20, wallpaper: '' }, t.ui || {}) };
  }
  function applyTheme(t) {
    t = t || loadTheme();
    const base = (THEMES[t.preset] || THEMES.current).vars;
    const vars = Object.assign({}, base, t.custom || {});
    const root = document.documentElement;
    for (const k in CSSVAR) if (vars[k]) root.style.setProperty(CSSVAR[k], vars[k]);
    const ui = t.ui || {};
    if (ui.radius != null) { root.style.setProperty('--radius', ui.radius + 'px'); root.style.setProperty('--radius-sm', Math.max(4, ui.radius - 4) + 'px'); }
    if (ui.fontSize) root.style.setProperty('--font-size', ui.fontSize + 'px');
    if (ui.lineHeight) root.style.setProperty('--line-height', ui.lineHeight);
    if (ui.blur != null) root.style.setProperty('--blur', ui.blur + 'px');
    if (ui.opacity != null) root.style.setProperty('--card-alpha', (ui.opacity / 100));
    // 壁纸既可能是渐变（linear-gradient(...)）也可能是图片 URL，分开处理
    const w = ui.wallpaper || '';
    root.style.setProperty('--wallpaper', !w ? 'none' : /^(linear|radial|conic)-gradient/.test(w) ? w : `url("${w}")`);
    document.documentElement.classList.toggle('dark', !!(THEMES[t.preset] || {}).dark);
    return t;
  }
  function saveTheme(t) { localStorage.setItem('muwen-theme', JSON.stringify(t)); applyTheme(t); }

  // ---- 小工具 ----
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim();
  function fmtTime(iso) { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? String(iso).slice(0, 16) : d.toLocaleString('sv', { timeZone: TZ }).slice(0, 16); }
  function fmtDate(iso) { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? String(iso).slice(0, 10) : d.toLocaleDateString('en-CA', { timeZone: TZ }); }

  global.MW = { mcp, rest, imageUrl, TOKEN, API, TZ, WEEK, PLANETS, ANCHORS, THEMES, CSSVAR, today, dayOfWeek, daysBetween, moon, loadTheme, applyTheme, saveTheme, esc, oneLine, fmtTime, fmtDate };
})(window);
