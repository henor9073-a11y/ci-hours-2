// 主题要在 <head> 里同步套上，不能等到页面底部的 app.js 才套——那样每次打开、
// 木纹木屋互相跳转，都会先用默认配色画一帧再换，暗色主题就是一闪白。
// 这个文件只做这一件事，很小，放在 <head> 里阻塞加载不影响速度。
(function (global) {
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

  applyTheme();
  global.MW_THEME = { THEMES, CSSVAR, loadTheme, applyTheme, saveTheme };
})(window);
