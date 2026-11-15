// chart-render.js：ECharts option JSON → SSR 静态 SVG（方案 L2，+1.07 MiB 懒加载）。
// 模型给的是数据不是代码：纯 JSON、禁 formatter / rich、强制 animation:false、背景透明、禁外链。
// 库在应用侧跑、renderToSVGString 产出静态 SVG 后仍走 sanitizeWidgetHtml → Shadow DOM 管线，
// 卡片里从头到尾没有可执行代码，禁脚本边界不变。静态 SVG 不支持 CSS 变量，
// 主题色在渲染时经 resolveThemeColors 注入具体色值；主题切换由 widget.js 触发重渲染。

import {resolveThemeColors} from './visual-spec.js';
import {createLruCache} from './render-cache.js';

// 白名单校验阈值：防止极端 JSON 拖住渲染进程。
const MAX_OPTION_NODES = 20000;
const MAX_OPTION_DEPTH = 12;
// 禁字段：formatter 是可执行字符串入口，rich 是 HTML 富文本入口（方案 §3.5）。
const FORBIDDEN_KEYS = new Set(['formatter', 'rich']);

// SSR 画布尺寸：显式给 width/height，输出带 viewBox，由卡片 CSS 缩放。
const SSR_WIDTH = 640;
const SSR_HEIGHT = 360;

const cache = createLruCache(40);

let echartsLoadPromise = null;

function ensureEcharts() {
    if (window.echarts) return Promise.resolve(window.echarts);
    if (echartsLoadPromise) return echartsLoadPromise;
    echartsLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/vendor/echarts/echarts.min.js';
        script.onload = () => {
            if (!window.echarts) {
                echartsLoadPromise = null;
                reject(new Error('echarts 库加载失败'));
                return;
            }
            resolve(window.echarts);
        };
        script.onerror = () => {
            echartsLoadPromise = null;
            reject(new Error('echarts 库加载失败'));
        };
        document.head.appendChild(script);
    });
    return echartsLoadPromise;
}

// validateEchartsOption 解析并校验 option（纯函数，供测试）。
// 返回 {ok:true, option} 或 {ok:false, error}；校验不过由卡片降级显示源码。
export function validateEchartsOption(text) {
    let option;
    try {
        option = JSON.parse(String(text || ''));
    } catch (e) {
        return {ok: false, error: 'option 不是合法 JSON：' + ((e && e.message) || e)};
    }
    if (!option || typeof option !== 'object' || Array.isArray(option)) {
        return {ok: false, error: 'option 必须是 JSON 对象'};
    }
    let nodes = 0;
    const walk = (value, key, depth) => {
        if (nodes++ > MAX_OPTION_NODES) throw new Error('option 过大');
        if (depth > MAX_OPTION_DEPTH) throw new Error('option 嵌套过深');
        if (key && FORBIDDEN_KEYS.has(key)) throw new Error('禁止使用 ' + key + ' 字段（可执行 / 富文本入口）');
        if (typeof value === 'string') {
            if (/^(https?:)?\/\//i.test(value.trim())) throw new Error('禁止外链资源：' + value.slice(0, 80));
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value) walk(item, null, depth + 1);
            return;
        }
        if (value && typeof value === 'object') {
            for (const k of Object.keys(value)) walk(value[k], k, depth + 1);
        }
    };
    try {
        walk(option, null, 0);
    } catch (e) {
        return {ok: false, error: (e && e.message) || String(e)};
    }
    return {ok: true, option};
}

// option 里的 var(--xxx) 字符串 → 当前主题具体色值；识别不了的变量保留原值。
const VAR_SLOT = {
    '--text': 'text', '--muted': 'muted', '--panel': 'panel', '--panel2': 'panel2',
    '--bg': 'bg', '--border': 'border', '--accent': 'accent', '--on-accent': 'onAccent',
    '--green': 'green', '--red': 'red', '--warn': 'warn',
};
const VAR_RE = /^var\((--[A-Za-z0-9-]+)\s*(?:,\s*([^)]+))?\)$/;

function resolveVarValue(text, colors) {
    const m = String(text).trim().match(VAR_RE);
    if (!m) return null;
    const slot = VAR_SLOT[m[1]];
    if (slot) return colors[slot];
    const fallback = m[2] ? m[2].trim() : '';
    return fallback || null;
}

// —— 主题可读性工具（WCAG 相对亮度 / 对比度）——
// ECharts 自带的默认配色是给「白底浅灰界面」设计的：轴标签 #54555a、分割线 #dbdee4、
// 轴线 #54555a、系列标签「深灰字 + 白色描边」。整套直接搬到深色卡片上会同时翻车：
// 轴标签几乎看不见（#54555a 在 #303236 上约 1.5:1）、分割线刺眼（#dbdee4 约 15:1）、
// 数值标签糊成一团（深灰字被白描边包住）。所以主题注入除了填色，还要做「对比度体检」。
function srgbToLinear(channel) {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// parseColor 解析 #rgb / #rrggbb / #rrggbbaa / rgb() / rgba()；解析不了返回 null。
function parseColor(value) {
    const text = String(value == null ? '' : value).trim().toLowerCase();
    if (!text) return null;
    if (text[0] === '#') {
        const hex = text.slice(1);
        const expand = (s) => parseInt(s.length === 1 ? s + s : s, 16);
        if (hex.length === 3 || hex.length === 4) {
            return {
                r: expand(hex[0]), g: expand(hex[1]), b: expand(hex[2]),
                a: hex.length === 4 ? expand(hex[3]) / 255 : 1,
            };
        }
        if (hex.length === 6 || hex.length === 8) {
            return {
                r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16),
                b: parseInt(hex.slice(4, 6), 16), a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
            };
        }
        return null;
    }
    const m = text.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
        const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        if (parts.length >= 3 && parts.slice(0, 3).every((n) => !Number.isNaN(n))) {
            return {
                r: parts[0], g: parts[1], b: parts[2],
                a: parts.length > 3 && !Number.isNaN(parts[3]) ? parts[3] : 1,
            };
        }
    }
    return null;
}

function relativeLuminance(color) {
    const c = parseColor(color);
    if (!c) return null;
    return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
}

// contrastRatio 算前景 / 背景对比度；半透明色先按背景合成。
export function contrastRatio(foreground, background) {
    const bg = parseColor(background);
    if (!bg) return null;
    const fg = parseColor(foreground);
    if (!fg) return null;
    let fr = fg.r, fgc = fg.g, fb = fg.b;
    if (fg.a < 1) {
        fr = fg.r * fg.a + bg.r * (1 - fg.a);
        fgc = fg.g * fg.a + bg.g * (1 - fg.a);
        fb = fg.b * fg.a + bg.b * (1 - fg.a);
    }
    const lum = (r, g, b) => 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
    const l1 = lum(fr, fgc, fb);
    const l2 = lum(bg.r, bg.g, bg.b);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
}

// TEXT_MIN_CONTRAST 文字与卡片底色的最低对比度（WCAG AA 正文 4.5:1）。
const TEXT_MIN_CONTRAST = 4.5;

// enforceReadable 检查文字色在卡片底色上是否够清楚；不够就换成兜底色。
// 模型偶尔会写死 #333 / #000 这类浅底专用色，深色主题下等于隐形——这里兜住。
export function enforceReadableText(node, key, colors, fallback) {
    if (!node || typeof node !== 'object') return;
    const value = node[key];
    if (typeof value !== 'string' || !value.trim()) return;
    const ratio = contrastRatio(value, colors.panel2);
    if (ratio === null || ratio >= TEXT_MIN_CONTRAST) return;
    node[key] = fallback || colors.text;
}

// ensureObject 取 host[key] 子对象；不存在就建，存在但不是对象（如 false）返回 null。
function ensureObject(host, key) {
    if (!host || typeof host !== 'object') return null;
    if (host[key] === undefined || host[key] === null) {
        host[key] = {};
    }
    return typeof host[key] === 'object' && !Array.isArray(host[key]) ? host[key] : null;
}

// themeLineStyle 给轴线 / 刻度 / 分割线填主题边框色；显式设了颜色的不动。
function themeLineStyle(host, key, colors) {
    const node = ensureObject(host, key);
    if (!node) return;
    const style = ensureObject(node, 'lineStyle');
    if (style && style.color === undefined) style.color = colors.border;
}

// 分类轴的标签是「名字」（主信息），用正文色；数值轴标签是刻度数字（次要信息），用次要色。
const AXIS_TYPE_VALUE = new Set(['value', 'log', 'time']);

function themeAxis(axis, colors) {
    if (!axis || typeof axis !== 'object' || Array.isArray(axis)) return;
    const type = String(axis.type || 'value');
    const isCategory = type === 'category';

    const label = ensureObject(axis, 'axisLabel');
    if (label) {
        const fallback = isCategory ? colors.text : colors.muted;
        if (label.color === undefined) label.color = fallback;
        enforceReadableText(label, 'color', colors, fallback);
    }
    const nameStyle = ensureObject(axis, 'nameTextStyle');
    if (nameStyle) {
        if (nameStyle.color === undefined) nameStyle.color = colors.text;
        enforceReadableText(nameStyle, 'color', colors, colors.text);
    }
    themeLineStyle(axis, 'axisLine', colors);
    themeLineStyle(axis, 'axisTick', colors);
    // 分类轴默认不画分割线，别凭空造出来；数值轴的分割线是默认可见的，填主题边框色。
    if (axis.splitLine !== false && (axis.splitLine !== undefined || AXIS_TYPE_VALUE.has(type))) {
        themeLineStyle(axis, 'splitLine', colors);
    }
}

function themeAxes(option, colors) {
    for (const key of ['xAxis', 'yAxis', 'angleAxis', 'radiusAxis', 'singleAxis']) {
        const value = option[key];
        if (!value) continue;
        const list = Array.isArray(value) ? value : [value];
        for (const axis of list) themeAxis(axis, colors);
    }
}

function themeTitle(option, colors) {
    const title = option.title;
    if (!title || typeof title !== 'object') return;
    const style = ensureObject(title, 'textStyle');
    if (style) {
        if (style.color === undefined) style.color = colors.text;
        enforceReadableText(style, 'color', colors, colors.text);
    }
    const sub = ensureObject(title, 'subtextStyle');
    if (sub) {
        if (sub.color === undefined) sub.color = colors.muted;
        enforceReadableText(sub, 'color', colors, colors.muted);
    }
}

function themeLegend(option, colors) {
    const legend = option.legend;
    if (!legend || typeof legend !== 'object') return;
    const list = Array.isArray(legend) ? legend : [legend];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const style = ensureObject(item, 'textStyle');
        if (style) {
            if (style.color === undefined) style.color = colors.text;
            enforceReadableText(style, 'color', colors, colors.text);
        }
        const itemStyle = ensureObject(item, 'itemStyle');
        if (itemStyle && itemStyle.borderColor === undefined) itemStyle.borderColor = colors.border;
    }
}

function themeSeriesLabels(option, colors) {
    const series = option.series;
    if (!Array.isArray(series)) return;
    for (const item of series) {
        if (!item || typeof item !== 'object') continue;
        const label = item.label;
        if (!label || typeof label !== 'object') continue;
        const inside = String(label.position == null ? '' : label.position).toLowerCase().startsWith('inside');
        if (!inside) {
            // 外侧标签默认是「深灰字 + 白色描边」：深色主题下白描边会糊成一团，
            // 描边改成卡片底色 → 只剩干净的一行字（浅色主题里白描边本就看不见）。
            if (label.color === undefined) label.color = colors.text;
            if (label.textBorderColor === undefined) label.textBorderColor = colors.panel2;
            // 外侧标签的背景就是卡片底色，可以按对比度体检；内侧标签压在色块上，
            // 背景色未知，动了反而可能把白字改成黑字——保持模型给的原样。
            enforceReadableText(label, 'color', colors, colors.text);
        }
    }
}

function themeRadar(option, colors) {
    const radar = option.radar;
    if (!radar || typeof radar !== 'object') return;
    const name = ensureObject(radar, 'axisName');
    if (name) {
        if (name.color === undefined) name.color = colors.text;
        enforceReadableText(name, 'color', colors, colors.text);
    }
    themeLineStyle(radar, 'axisLine', colors);
    themeLineStyle(radar, 'splitLine', colors);
    const area = ensureObject(radar, 'splitArea');
    const areaStyle = area && ensureObject(area, 'areaStyle');
    if (areaStyle && areaStyle.color === undefined) areaStyle.color = [colors.bg, colors.panel];
}

function themeVisualMap(option, colors) {
    const visualMap = option.visualMap;
    if (!visualMap) return;
    const list = Array.isArray(visualMap) ? visualMap : [visualMap];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const style = ensureObject(item, 'textStyle');
        if (style) {
            if (style.color === undefined) style.color = colors.muted;
            enforceReadableText(style, 'color', colors, colors.muted);
        }
    }
}

// applyThemeToOption 注入主题（纯函数，供测试）：调色板、文本色、强制关动画、透明背景，
// 并把坐标轴 / 标签 / 图例 / 标题的默认配色换成主题色（模型显式指定的色值保留，只做对比度体检）。
export function applyThemeToOption(option, colors) {
    option.animation = false;
    option.animationDuration = 0;
    if (!option.backgroundColor) option.backgroundColor = 'transparent';
    if (!option.textStyle) option.textStyle = {};
    if (!option.textStyle.color) option.textStyle.color = colors.text;
    if (!option.color) {
        option.color = [colors.accent, colors.green, colors.warn, colors.red, colors.muted, colors.border];
    }
    resolveVarDeep(option, colors);
    themeAxes(option, colors);
    themeTitle(option, colors);
    themeLegend(option, colors);
    themeSeriesLabels(option, colors);
    themeRadar(option, colors);
    themeVisualMap(option, colors);
    return option;
}

function resolveVarDeep(node, colors) {
    if (typeof node === 'string') return;
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
            if (typeof node[i] === 'string') {
                const resolved = resolveVarValue(node[i], colors);
                if (resolved !== null) node[i] = resolved;
            } else resolveVarDeep(node[i], colors);
        }
        return;
    }
    if (node && typeof node === 'object') {
        for (const key of Object.keys(node)) {
            const value = node[key];
            if (typeof value === 'string') {
                const resolved = resolveVarValue(value, colors);
                if (resolved !== null) node[key] = resolved;
            } else resolveVarDeep(value, colors);
        }
    }
}

// renderEchartsToSvg 校验 + 注入主题 + SSR 出静态 SVG 字符串；失败抛错由卡片降级显示源码。
// SSR 实例用完即 dispose，不持有活动实例；结果按「内容 + 主题」缓存（消息重渲染 / 主题切换都命中）。
export async function renderEchartsToSvg(code, themeId) {
    const {ok, option, error} = validateEchartsOption(code);
    if (!ok) throw new Error(error);
    const cacheKey = (themeId || '') + ':' + code;
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit;
    const colors = resolveThemeColors();
    applyThemeToOption(option, colors);
    const echarts = await ensureEcharts();
    const chart = echarts.init(null, null, {renderer: 'svg', ssr: true, width: SSR_WIDTH, height: SSR_HEIGHT});
    let svg;
    try {
        chart.setOption(option);
        svg = chart.renderToSVGString();
    } finally {
        chart.dispose();
    }
    if (/<script/i.test(svg)) throw new Error('SSR 产物包含脚本，已拒绝');
    cache.set(cacheKey, svg);
    return svg;
}
