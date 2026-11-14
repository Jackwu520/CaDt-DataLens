// wordcloud-render.js：```wordcloud 词云 → 静态 SVG（方案阶段 6）。
// 首选 echarts-wordcloud（16 KiB）SSR——官方未承诺 SSR 兼容，运行时检查产物含 <text>，
// 不含则退 d3-cloud（34 KiB）只算布局、应用自拼 SVG。两条路都不产生可执行代码、不放宽边界。

import {resolveThemeColors} from './visual-spec.js';
import {createLruCache} from './render-cache.js';

export const WORDCLOUD_LIMITS = {maxWords: 120, minFont: 11, maxFont: 34};

const cache = createLruCache(30);

// validateWordCloudSpec 校验 ```wordcloud 的 JSON（纯函数，供测试）。
// words 非空 ≤120；text 非空字符串；value 缺省 1、负值按 1 处理。
export function validateWordCloudSpec(text) {
    let spec;
    try {
        spec = JSON.parse(String(text || ''));
    } catch (e) {
        return {ok: false, error: 'wordcloud 不是合法 JSON：' + ((e && e.message) || e)};
    }
    if (!spec || typeof spec !== 'object' || !Array.isArray(spec.words) || !spec.words.length) {
        return {ok: false, error: 'words 必须是非空数组'};
    }
    if (spec.words.length > WORDCLOUD_LIMITS.maxWords) {
        return {ok: false, error: '词超过上限（' + WORDCLOUD_LIMITS.maxWords + '）'};
    }
    const words = [];
    for (const raw of spec.words) {
        if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string' || !raw.text.trim()) {
            return {ok: false, error: '每个词都要有非空字符串 text'};
        }
        let value = 1;
        if (raw.value != null && Number.isFinite(Number(raw.value))) {
            value = Math.max(1, Number(raw.value));
        }
        words.push({text: raw.text, value});
    }
    return {ok: true, words};
}

// paletteFor 按权重排名给色：权重高靠前（accent 优先），主题注入具体色值。
export function paletteFor(sortedWords, colors) {
    const palette = [colors.accent, colors.green, colors.warn, colors.red, colors.muted];
    return new Map(sortedWords.map((w, i) => [
        w.text,
        palette[Math.min(palette.length - 1, Math.floor((i / Math.max(1, sortedWords.length)) * palette.length))],
    ]));
}

// assembleWordCloudSvg 用给定坐标拼静态 SVG（纯函数，供测试）。
// layout: [{text, size, x, y}]（x/y 为词中心点，rotate 恒 0——横向可读性优先）。
// viewBox 按实际词边界 + 内边距计算，避免 d3-cloud 溢出 640×360 时被裁掉。
export function assembleWordCloudSvg(layout, colors) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const w of layout) {
        const halfW = Math.max(12, w.text.length * w.size * 0.35);
        minX = Math.min(minX, w.x - halfW); maxX = Math.max(maxX, w.x + halfW);
        minY = Math.min(minY, w.y - w.size); maxY = Math.max(maxY, w.y + w.size);
    }
    const pad = 12;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const sorted = layout.slice().sort((a, b) => b.size - a.size);
    const palette = paletteFor(sorted, colors);
    const parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + Math.round(minX) + ' ' + Math.round(minY) + ' ' +
        Math.round(maxX - minX) + ' ' + Math.round(maxY - minY) +
        '" role="img" aria-label="词云：' + layout.length + ' 个词">');
    parts.push('<title>词云</title>');
    for (const w of layout) {
        const fill = palette.get(w.text) || colors.text;
        parts.push('<text x="' + Math.round(w.x) + '" y="' + Math.round(w.y) +
            '" font-size="' + Math.round(w.size) + '" text-anchor="middle" dominant-baseline="central"' +
            ' fill="' + fill + '">' + escapeText(w.text) + '</text>');
    }
    parts.push('</svg>');
    return parts.join('');
}

function escapeText(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let echartsLoadPromise = null;
function ensureEcharts() {
    if (window.echarts) return Promise.resolve(window.echarts);
    if (echartsLoadPromise) return echartsLoadPromise;
    echartsLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/vendor/echarts/echarts.min.js';
        script.onload = () => {
            if (!window.echarts) { echartsLoadPromise = null; reject(new Error('echarts 库加载失败')); return; }
            resolve(window.echarts);
        };
        script.onerror = () => { echartsLoadPromise = null; reject(new Error('echarts 库加载失败')); };
        document.head.appendChild(script);
    });
    return echartsLoadPromise;
}

function loadScript(src, globalCheck) {
    if (globalCheck()) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => globalCheck() ? resolve() : reject(new Error(src + ' 加载失败'));
        script.onerror = () => reject(new Error(src + ' 加载失败'));
        document.head.appendChild(script);
    });
}

// renderWordCloudToSvg：校验 → SSR 出图（检查含 <text>）→ 失败退 d3-cloud 布局自拼。
export async function renderWordCloudToSvg(code, themeId) {
    const {ok, words, error} = validateWordCloudSpec(code);
    if (!ok) throw new Error(error);
    const cacheKey = (themeId || '') + ':' + code;
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit;
    const colors = resolveThemeColors();
    const sorted = words.slice().sort((a, b) => b.value - a.value);
    try {
        const echarts = await ensureEcharts();
        // echarts-wordcloud 注册 series 类型无独立全局可查；脚本加载成功即认为可用，
        // setOption 不认 type 会抛错 → 被 catch 落到 d3-cloud 兜底。
        await loadScript('/vendor/wordcloud/echarts-wordcloud.min.js', () => !!window.echarts);
        const chart = echarts.init(null, null, {renderer: 'svg', ssr: true, width: 640, height: 360});
        let svg;
        try {
            chart.setOption({
                silent: true,
                animation: false,
                series: [{
                    type: 'wordCloud',
                    shape: 'circle',
                    width: '100%',
                    height: '100%',
                    sizeRange: [WORDCLOUD_LIMITS.minFont, WORDCLOUD_LIMITS.maxFont],
                    rotationRange: [0, 0],
                    gridSize: 4,
                    layoutAnimation: false,
                    textStyle: {fontFamily: 'inherit'},
                    data: sorted.map((w) => ({name: w.text, value: w.value})),
                }],
            });
            svg = chart.renderToSVGString();
        } finally {
            chart.dispose();
        }
        // SSR 兼容性检查：产物必须真画出词（含 <text>），否则退 d3-cloud 自拼
        if (!/<text[\s>]/i.test(svg)) throw new Error('SSR 产物不含文本');
        if (/<script/i.test(svg)) throw new Error('SSR 产物包含脚本，已拒绝');
        cache.set(cacheKey, svg);
        return svg;
    } catch (e) {
        // 尽力而为路径：SSR 不兼容（官方未承诺）才走这里，d3-cloud 只算布局、应用自拼 SVG
    }
    const layout = await layoutWithD3Cloud(sorted);
    const svg = assembleWordCloudSvg(layout, colors);
    cache.set(cacheKey, svg);
    return svg;
}

// layoutWithD3Cloud 用 d3-cloud 算 {text, size, x, y} 布局；库不可用退网格散布（保证有产出）。
// 注意：d3-cloud@2 的 build 产物是 ES module（export 语句），<script> 加载会语法失败，
// 必须走 dynamic import。
async function layoutWithD3Cloud(sorted) {
    let cloud = null;
    try {
        // @vite-ignore + 运行时拼接：d3-cloud 是 public/ 下的 ES module（不进 Vite 依赖图），
        // 字面量 import 会被 Rollup 当构建期依赖解析而构建失败。
        const url = '/vendor/wordcloud/' + 'd3-cloud.js';
        const mod = await import(/* @vite-ignore */ url);
        const CloudLayout = mod.default || mod.CloudLayout;
        if (CloudLayout) cloud = () => new CloudLayout();
    } catch (e) {
        cloud = null;
    }
    const max = sorted[0] ? sorted[0].value : 1;
    const min = sorted.length > 1 ? sorted[sorted.length - 1].value : max;
    const span = Math.max(1e-9, max - min);
    const words = sorted.map((w) => ({
        text: w.text,
        size: WORDCLOUD_LIMITS.minFont + Math.round(((w.value - min) / span) * (WORDCLOUD_LIMITS.maxFont - WORDCLOUD_LIMITS.minFont)),
        rotate: 0,
    }));
    if (!cloud) {
        // 库不可用的最后兜底：网格散布，保证卡片有产出（比空白好）
        const positions = [];
        const cols = Math.ceil(Math.sqrt(words.length)) || 1;
        words.forEach((w, i) => positions.push({
            text: w.text, size: w.size,
            x: 60 + (i % cols) * 90 + (w.size % 7),
            y: 40 + Math.floor(i / cols) * 44 + (w.size % 5),
        }));
        return positions;
    }
    return new Promise((resolve) => {
        let done;
        try {
            done = cloud()
                .size([640, 360])
                .words(words)
                .padding(3)
                .rotate(() => 0)
                .font('sans-serif')
                .fontSize((w) => w.size)
                .on('end', (placed) => {
                    // d3-cloud 坐标以画布中心为原点，平移回左上角
                    resolve(placed.map((w) => ({text: w.text, size: w.size, x: 320 + w.x, y: 180 + w.y})));
                });
            done.start();
        } catch (e) {
            resolve(words.map((w, i) => ({text: w.text, size: w.size, x: 320, y: 40 + i * 26})));
        }
    });
}
