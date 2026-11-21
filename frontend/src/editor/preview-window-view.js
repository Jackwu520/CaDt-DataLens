// preview-window-view.js：实时预览外置窗的视图（辅助独立窗第二批）。
// 只读镜像：源文件在主窗口编辑（保存落盘后），这里轮询磁盘 mtime 跟随重渲染。
// 支持 markdown（共享渲染链）/ HTML（DOMPurify 清洗）/ SVG（img 隔离，脚本不执行）。
// 纯函数拆出可单测。

import DOMPurifyModule from 'dompurify';
import {createMarkdownRenderer} from '../core/markdown.js';

// 轮询间隔：磁盘 mtime 探测（毫秒）。跟随保存的延迟感与负载的折中。
const PREVIEW_POLL_MS = 1500;

// 外置预览的清洗口径：原始 HTML 不执行是硬要求。配置留在本模块（安全决策与
// 功能同处），DOMPurify 实例可注入——浏览器里 dompurify 自初始化为实例；Node
// 测试环境给工厂函数，经 deps.sanitize 注入假实例断言配置传递。
export const PREVIEW_SANITIZE_CONFIG = Object.freeze({
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick'],
});
const dompurify = DOMPurifyModule && typeof DOMPurifyModule.sanitize === 'function' ? DOMPurifyModule : null;

// pickPreviewKind 源文件 → 预览形态；null = 不支持外置预览（纯函数）。
export function pickPreviewKind(path) {
    const ext = String(path || '').replace(/^.*[\\/]/, '').replace(/^.*\./, '').toLowerCase();
    if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
    if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return 'html';
    if (ext === 'svg') return 'svg';
    if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'webp' || ext === 'bmp' || ext === 'ico') return 'image';
    return null;
}

// sanitizePreviewHtml HTML 清洗（纯函数）：sanitize 可注入（统一携带 FORBID 口径），
// 缺省用浏览器实例。
export function sanitizePreviewHtml(html, sanitize) {
    const src = String(html || '');
    const fn = typeof sanitize === 'function'
        ? (h) => sanitize(h, PREVIEW_SANITIZE_CONFIG)
        : (dompurify ? (h) => dompurify.sanitize(h, PREVIEW_SANITIZE_CONFIG) : null);
    return fn ? fn(src) : src;
}

// createPreviewWindowView 预览窗视图工厂：mount() 渲染并启动 mtime 轮询。
export function createPreviewWindowView(deps) {
    let bodyEl = null;
    let metaEl = null;
    let disposed = false;
    let lastMtime = -1;
    let pollTimer = 0;
    const markdownRenderer = createMarkdownRenderer().renderMarkdownHtml;

    async function readSource() {
        if (deps.kind === 'image') {
            return {kind: 'image', dataUrl: await deps.backend.ReadImageAsDataURL(deps.path)};
        }
        const data = await deps.backend.OpenFile(deps.path, 'auto');
        if (!data) throw new Error('文件不存在或无法读取');
        if (data.binary) throw new Error('二进制文件不支持预览');
        return {kind: deps.kind, text: String(data.content == null ? '' : data.content), mtime: data.mtime || ''};
    }

    function renderInto(result) {
        bodyEl.textContent = '';
        if (result.kind === 'image') {
            const img = document.createElement('img');
            img.className = 'preview-view-img';
            img.src = result.dataUrl;
            img.alt = deps.path;
            bodyEl.appendChild(img);
            return;
        }
        if (result.kind === 'markdown') {
            const wrap = document.createElement('div');
            wrap.className = 'preview-view-md';
            try { wrap.innerHTML = markdownRenderer(result.text); } catch (e) { wrap.textContent = result.text; }
            bodyEl.appendChild(wrap);
            return;
        }
        if (result.kind === 'html') {
            const wrap = document.createElement('div');
            wrap.className = 'preview-view-html';
            wrap.innerHTML = sanitizePreviewHtml(result.text);
            bodyEl.appendChild(wrap);
            return;
        }
        // svg：img 隔离渲染（SVG 内脚本/事件不执行）
        const img = document.createElement('img');
        img.className = 'preview-view-svg';
        img.alt = deps.path;
        // 解码失败不能静默留白：.svg 由浏览器的 XML 解析器读，一个未闭合标签（如把 `<br/>`
        // 写成 `<br>`）或 `&nbsp;` 这类 HTML 实体就能让整份文档加载失败——这时与直接用浏览器
        // 打开同一文件的表现一致，问题在文件本身，提示要指到源头而不是让人盯着空白页。
        img.onerror = () => {
            img.remove();
            if (disposed) return;
            const note = document.createElement('div');
            note.className = 'preview-view-error';
            note.textContent = 'SVG 无法显示：浏览器无法解码该文件。'
                + 'SVG 按 XML 解析，常见原因是标签没有闭合（例如把 <br/> 写成 <br>）'
                + '或用了 &nbsp; 这类 HTML 实体；用浏览器直接打开该文件也是同样结果。';
            bodyEl.appendChild(note);
        };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(result.text);
        bodyEl.appendChild(img);
    }

    async function refresh() {
        let result = null;
        let error = '';
        try {
            result = await readSource();
        } catch (e) {
            error = (e && e.message) || String(e);
        }
        if (disposed) return;
        if (error) {
            metaEl.textContent = '预览失败：' + error;
            return;
        }
        renderInto(result);
        metaEl.textContent = '跟随中 · ' + new Date().toLocaleTimeString('zh-CN', {hour12: false});
    }

    async function poll() {
        if (disposed) return;
        try {
            const info = deps.backend.GetPathInfo ? await deps.backend.GetPathInfo(deps.path) : null;
            const mtime = info && info.modified != null ? Number(info.modified) : -1;
            if (mtime !== lastMtime) {
                lastMtime = mtime;
                await refresh();
            }
        } catch (e) {
            // 文件被临时移动/占用：下一轮再试，不打断预览
        }
        if (!disposed) pollTimer = setTimeout(poll, PREVIEW_POLL_MS);
    }

    function mount() {
        const root = document.createElement('div');
        root.className = 'preview-view-root';
        metaEl = document.createElement('div');
        metaEl.className = 'light-view-meta';
        metaEl.textContent = '正在读取…';
        bodyEl = document.createElement('div');
        bodyEl.className = 'preview-view-body aux-window-body';
        root.append(metaEl, bodyEl);
        deps.container.textContent = '';
        deps.container.appendChild(root);
        lastMtime = -1;
        refresh();
        pollTimer = setTimeout(poll, PREVIEW_POLL_MS);
    }

    function dispose() {
        disposed = true;
        clearTimeout(pollTimer);
    }

    return {mount, dispose, refreshForTest: refresh};
}
