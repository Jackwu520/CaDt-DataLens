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

// applyThemeToOption 注入主题（纯函数，供测试）：调色板、文本色、强制关动画、透明背景。
// 模型没写的字段补默认值，写了的具体色值保留（模型可以显式指定颜色）。
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
