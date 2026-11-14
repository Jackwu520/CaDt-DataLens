// mermaid-render.js：AI 可视化卡片的 mermaid 渲染（方案 L1，零新增字节）。
// 懒加载与 editor/markdown-mermaid.js 共用同一份 /vendor/mermaid 脚本，但各自独立实现、
// 不跨域引用（core→editor 反向依赖）。strict 模式 + DOMPurify SVG 档兜底与主界面预览一致。
// 产物是静态 SVG 字符串，由 widget.js 走 sanitizeWidgetHtml → Shadow DOM 现有管线。

import DOMPurify from 'dompurify';
import {mermaidThemeIdFor} from './visual-spec.js';
import {createLruCache} from './render-cache.js';

const cache = createLruCache(30);

let loadPromise = null;

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

// renderMermaidToSvg 把 mermaid 源码渲染成净化后的 SVG 字符串；失败抛错由卡片降级显示源码。
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
    // mermaid strict 已自净化，再过一遍 DOMPurify（SVG 档）兜底；
    // style/foreignObject 是 mermaid 自带样式与 HTML 标签所需，保留但内容仍被消毒。
    const clean = DOMPurify.sanitize(svg, {
        USE_PROFILES: {svg: true, svgFilters: true},
        ADD_TAGS: ['style', 'foreignObject'],
    });
    cache.set(cacheKey, clean);
    return clean;
}
