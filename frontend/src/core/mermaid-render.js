// mermaid-render.js：AI 可视化卡片的 mermaid 渲染（方案 L1，零新增字节）。
// 懒加载与 editor/markdown-mermaid.js 共用同一份 /vendor/mermaid 脚本，但各自独立实现、
// 不跨域引用（core→editor 反向依赖）。strict 模式 + DOMPurify SVG 档兜底与主界面预览一致。
// 产物是静态 SVG 字符串，由 widget.js 走 sanitizeWidgetHtml → Shadow DOM 现有管线。

import DOMPurify from 'dompurify';
import {mermaidThemeIdFor, svgSanitizeConfig} from './visual-spec.js';
import {createLruCache} from './render-cache.js';

const cache = createLruCache(30);

let loadPromise = null;

/**
 * 确保 mermaid 脚本已加载（懒加载，单飞：并发调用共用一个 Promise）。
 * 加载失败会把单飞句柄清空，下次调用可重试。
 * @returns {Promise<object>} window.mermaid 实例
 */
function ensureMermaid() {
    if (window.mermaid) return Promise.resolve(window.mermaid);
    if (loadPromise) return loadPromise;
    loadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/vendor/mermaid/mermaid.min.js';
        script.onload = () => {
            if (!window.mermaid) {
                loadPromise = null;
                reject(new Error('mermaid 库加载失败'));
                return;
            }
            resolve(window.mermaid);
        };
        script.onerror = () => {
            loadPromise = null;
            reject(new Error('mermaid 库加载失败'));
        };
        document.head.appendChild(script);
    });
    return loadPromise;
}

/**
 * 把 mermaid 源码渲染成净化后的 SVG 字符串。
 * 结果按「主题 + 源码」进 LRU（30 条）；渲染或加载失败直接抛错，由卡片降级显示源码。
 * @param {string} code mermaid 源码
 * @param {string} themeId 应用主题 id（经 mermaidThemeIdFor 映射成 mermaid 主题）
 * @returns {Promise<string>} 已 sanitize 的 SVG 字符串
 */
export async function renderMermaidToSvg(code, themeId) {
    const theme = mermaidThemeIdFor(themeId);
    const cacheKey = theme + ':' + code;
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit;
    const mermaid = await ensureMermaid();
    try {
        mermaid.initialize({startOnLoad: false, securityLevel: 'strict', theme});
    } catch (e) {}
    const {svg} = await mermaid.render('mmd-' + Math.random().toString(36).slice(2), String(code || ''));
    // mermaid strict 已自净化，再过一遍 DOMPurify 兜底；配置来自 visual-spec 的单一来源
    // （必须保留 foreignObject 与其 HTML 集成点，否则节点文字会被剥掉，只剩空框）。
    const clean = DOMPurify.sanitize(svg, svgSanitizeConfig());
    cache.set(cacheKey, clean);
    return clean;
}
