// 主题要在 <head> 里同步套上，不能等到页面底部的 app.js 才套——那样每次打开、
// 木纹木屋互相跳转，都会先用默认配色画一帧再换，暗色主题就是一闪白。
// 这个文件只做这一件事，很小，放在 <head> 里阻塞加载不影响速度。
(function (global) {
  // ---- 主题：7 套预设 + 自定义，木纹木屋共用同一份 localStorage ----
  // 樱海石夜雾：跟聊天页那五套同名、同调子，选了全站一起变（设置页会让聊天页跟着切）
  const THEMES = {
    sakura: { label: '樱', vars: { bg: '#fdf1f6', card: '#FFFFFF', primary: '#c9a0b2', primaryLight: '#f6e3ec', accent: '#a88a98', accentLight: '#f1e4ea', text: '#5a4a55', textSecondary: '#8a7480', textLight: '#cdbdc5', border: '#eedde6' } },
    ocean: { label: '海', vars: { bg: '#e9f1f5', card: '#FFFFFF', primary: '#89b0c2', primaryLight: '#dcebf2', accent: '#5f8595', accentLight: '#e2edf2', text: '#3d5562', textSecondary: '#6f8a97', textLight: '#b0c5d0', border: '#d9e6ec' } },
    stone: { label: '石', dark: true, vars: { bg: '#34343f', card: '#3d3d48', primary: '#9a9ec4', primaryLight: '#464657', accent: '#b8bcd8', accentLight: '#4a4a5c', text: '#cdccd8', textSecondary: '#9898b0', textLight: '#6e6e82', border: '#4a4a58' } },
    night: { label: '夜', dark: true, vars: { bg: '#161628', card: '#1f1f36', primary: '#a0a4d4', primaryLight: '#2c2c48', accent: '#c2c5e8', accentLight: '#33335a', text: '#d8d6e2', textSecondary: '#9090b0', textLight: '#5a5a72', border: '#2e2e4a' } },
    mist: { label: '雾', vars: { bg: '#f3f1ed', card: '#FFFFFF', primary: '#9e998e', primaryLight: '#e8e5df', accent: '#7d786d', accentLight: '#ebe8e2', text: '#4a4742', textSecondary: '#7a7568', textLight: '#c5c0b8', border: '#e2ded8' } },
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
    return { preset: t.preset || 'current', custom: t.custom || {}, ui: Object.assign({ radius: 16, fontSize: 16, lineHeight: 1.6, opacity: 100, blur: 20, chromeAlpha: 82, wallpaper: '', wallpaperAlpha: 100, iconSize: 52, iconRadius: 16, cardBlur: 0 }, t.ui || {}) };
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
    if (ui.chromeAlpha != null) root.style.setProperty('--chrome-alpha', ui.chromeAlpha + '%');
    if (ui.opacity != null) root.style.setProperty('--card-alpha', ui.opacity + '%');
    if (ui.wallpaperAlpha != null) root.style.setProperty('--wallpaper-alpha', (ui.wallpaperAlpha / 100));
    if (ui.iconSize) root.style.setProperty('--icon-size', ui.iconSize + 'px');
    if (ui.iconRadius != null) root.style.setProperty('--icon-radius', ui.iconRadius + 'px');
    if (ui.cardBlur != null) root.style.setProperty('--card-blur', ui.cardBlur + 'px');
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
