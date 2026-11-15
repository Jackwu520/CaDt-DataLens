// Markdown 渲染管线与 mermaid 出图：共享渲染器实例、mermaid 脚本按需注入与主题、块渲染、图片路径解析。
// 从 writing-ui.js 拆出（放 editor/ 与 markdown.js 同域）。

import DOMPurify from 'dompurify';
import {createMarkdownRenderer, decodeMermaidSource, encodeMermaidSource} from '../core/markdown.js';
import {svgSanitizeConfig} from '../core/visual-spec.js';

export function createMarkdownMermaid(deps) {

let markdownRenderer;
const sharedMarkdown = createMarkdownRenderer({
    mdLineNumbers: () => deps.settings.mdLineNumbers,
    mermaidPlaceholder: (text) => renderMermaidPlaceholder(text),
});
markdownRenderer = sharedMarkdown.markdownRenderer;
const renderMarkdownHtml = sharedMarkdown.renderMarkdownHtml;

// renderMermaidPlaceholder mermaid 图表占位：渲染后异步替换为 SVG。
// 源码存 base64（见 markdown.js 编解码注释），明文换行会被 DOMPurify 3.4.x 剥属性。
function renderMermaidPlaceholder(text) {
    return '<div class="md-mermaid" data-src="' + encodeMermaidSource(text) + '"></div>';
}

let mermaidScriptLoading = false;

function ensureMermaidScript() {
    if (window.mermaid || mermaidScriptLoading) return;
    mermaidScriptLoading = true;
    const script = document.createElement('script');
    script.src = '/vendor/mermaid/mermaid.min.js';
    script.onload = () => {
        mermaidScriptLoading = false;
        try {
            window.mermaid.initialize({startOnLoad: false, securityLevel: 'strict'});
        } catch (e) {}
        if (deps.file && deps.currentMode === 'preview') deps.renderMarkdownPreview(deps.file);
    };
    script.onerror = () => {
        mermaidScriptLoading = false;
        for (const el of document.querySelectorAll('.md-mermaid')) {
            el.textContent = 'mermaid 库加载失败';
        }
    };
    document.head.appendChild(script);
}

function mermaidThemeForCurrent() {
    const id = deps.currentTheme().id;
    // night 背景是深色（#16181f），必须落到 dark（功能验证报告 §1.4.1：误判 neutral 导致图表配色脱节）
    return /dark|darcula|night/.test(id) ? 'dark' : 'neutral';
}

async function renderMermaidBlocks(root) {
    const blocks = (root || document).querySelectorAll('.md-mermaid:not([data-rendered])');
    if (!blocks.length) return;
    if (!window.mermaid) {
        ensureMermaidScript();
        if (!window.mermaid) return;
    }
    try {
        window.mermaid.initialize({startOnLoad: false, securityLevel: 'strict', theme: mermaidThemeForCurrent()});
    } catch (e) {}
    for (const block of blocks) {
        block.dataset.rendered = '1';
        let msrc = '';
        try {
            msrc = decodeMermaidSource(block.dataset.src || '');
        } catch (e) {
            block.classList.add('md-mermaid-error');
            block.textContent = 'mermaid 源码解码失败';
            continue;
        }
        if (!msrc.trim()) continue;
        try {
            const {svg} = await window.mermaid.render('mmd-' + Math.random().toString(36).slice(2), msrc);
            // mermaid strict 已自净化，这里再过一遍 DOMPurify 兜底；配置来自 visual-spec 的单一来源
            // （必须保留 foreignObject 与其 HTML 集成点，否则节点文字会被剥掉，只剩空框）。
            block.innerHTML = DOMPurify.sanitize(svg, svgSanitizeConfig());
        } catch (e) {
            block.classList.add('md-mermaid-error');
            block.textContent = 'mermaid 图表渲染失败：' + (e && e.message || e);
        }
    }
}

// renderMarkdownCodeBlock / fence / link_open 规则已随渲染器抽到 markdown.js。

// resolveMarkdownImages 把 Markdown 预览里相对路径/本地绝对路径的图片换成后端读取的 data URL。
function resolveMarkdownImages(doc) {
    if (!doc || !doc.previewBody) return;
    const BS = String.fromCharCode(92); // 反斜杠（避免注入层转义问题）
    const raw0 = doc.path || '';
    const cut = Math.max(raw0.lastIndexOf('/'), raw0.lastIndexOf(BS));
    const base = cut >= 0 ? raw0.slice(0, cut) : '';
    for (const img of doc.previewBody.querySelectorAll('img')) {
        const raw = img.getAttribute('data-ai-src') || img.getAttribute('src') || '';
        if (!raw || /^(https?:|data:|blob:)/i.test(raw)) continue;
        let p = raw;
        if (/^file:/i.test(p)) p = p.slice(7);
        p = p.replace(/^\/+/, '');
        try { p = decodeURIComponent(p); } catch (e) {}
        p = p.split('/').join(BS);
        let abs;
        if (/^[A-Za-z]:/.test(p)) abs = p;
        else if (base) abs = base + BS + p;
        else continue;
        const parts = [];
        for (const seg of abs.split(BS)) {
            if (seg === '.' || seg === '') continue;
            if (seg === '..') { parts.pop(); continue; }
            parts.push(seg);
        }
        abs = parts.join(BS);
        if (!deps.backend.ReadImageAsDataURL) continue;
        deps.backend.ReadImageAsDataURL(abs).then((url) => { if (url) img.src = url; }).catch(() => {});
    }
}


return {markdownRenderer, renderMarkdownHtml, renderMermaidBlocks, resolveMarkdownImages};
}
