// AI 回答里的可视化卡片（svg / html / mermaid / echarts / graph / wordcloud 围栏代码块）。
// mermaid / echarts 走异步引擎：动态 import 渲染模块、vendor 按需加载，产物仍是静态 SVG，
// 之后与 svg 卡片走同一条 sanitize → Shadow DOM 管线；主题切换（data-theme）触发重渲染。
//
// 安全边界（不可放松）：
// - 只有 AI 消息显式标注 svg / html 的围栏才会变成卡片；普通 Markdown 内嵌 HTML 仍由
//   markdown.js 的 html:false 规则转义，原始 HTML 不执行这条硬要求不变。
// - 代码块内容先经 DOMPurify 清洗（去掉 script / 事件属性 / javascript: 协议），
//   再放进 Shadow DOM：样式不外泄、主界面不受影响，脚本也不会执行。
// - 卡片内的链接由外层拦截后交给系统浏览器，其它导航一律阻止。
import DOMPurify from 'dompurify';
import {SHADOW_STYLE, VISUAL_BUDGET} from './visual-spec.js';

const WIDGET_LANGS = new Set(['svg', 'html', 'htm', 'mermaid', 'echarts', 'chart', 'graph', 'wordcloud']);
// 限额与 Shadow 基础样式来自 core/visual-spec.js（规范单一来源，代码与提示词共用一份预算）。
const MAX_WIDGET_CHARS = VISUAL_BUDGET.maxWidgetChars;
const MAX_WIDGETS_PER_MESSAGE = VISUAL_BUDGET.maxPerMessage;
const MAX_WIDGET_CSS_CHARS = VISUAL_BUDGET.maxCssChars;

// kind 分类（方案 §3.1）：只影响卡片标签、规范段落与无障碍描述，不是新引擎。
// chart 是 echarts 的兼容别名；显式 kind= 修饰优先于按语言推导的默认形态。
export const WIDGET_KINDS = new Set(['diagram', 'chart', 'mockup', 'card']);
const KIND_LABELS = {diagram: '图示', chart: '图表', mockup: '示意', card: '卡片'};
const LANG_LABELS = {svg: 'SVG', html: 'HTML', mermaid: 'Mermaid', echarts: 'ECharts', graph: 'Graph', wordcloud: 'WordCloud'};
const LANG_DEFAULT_KIND = {svg: 'diagram', mermaid: 'diagram', echarts: 'chart', graph: 'diagram', wordcloud: 'chart', html: 'card'};

// 语言归一化：chart 是 echarts 的兼容别名；不在集合里返回空串。
function normalizeWidgetLang(lang) {
    const l = String(lang || '').toLowerCase();
    if (!WIDGET_LANGS.has(l)) return '';
    return l === 'chart' ? 'echarts' : l;
}

export function widgetLangOf(info) {
    return normalizeWidgetLang(String(info || '').trim().split(/\s+/)[0]);
}

// widgetKindOf 解析围栏信息里的语言与 kind 修饰，返回 {lang, kind}；不是可视化围栏返回 null。
// 围栏信息示例：`svg`、`html kind=mockup`、`mermaid`、`echarts`、`chart`（= echarts）。
export function widgetKindOf(info) {
    const text = String(info || '').trim();
    if (!text) return null;
    const lang = widgetLangOf(text);
    if (!lang) return null;
    const m = text.match(/\bkind=([A-Za-z-]+)/i);
    const kind = m && WIDGET_KINDS.has(m[1].toLowerCase()) ? m[1].toLowerCase() : LANG_DEFAULT_KIND[lang];
    return {lang, kind};
}

export function escapeWidgetText(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 轻量滚动 hash：用于标记同一段代码，重渲染时可据此判断要不要重建卡片。
export function widgetCacheKey(lang, code) {
    const text = String(code || '');
    let hash = 5381;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    return String(lang) + ':' + text.length + ':' + (hash >>> 0).toString(36);
}

// 占位 HTML：由 markdown.js 的 fence 规则插入，增强阶段再从 .ai-widget-src 读回源码。
// 源码放在 pre/code 里（已转义），即使增强失败也能看到原始内容。
export function buildWidgetPlaceholder(code, lang, kind) {
    const text = String(code || '');
    const safeLang = normalizeWidgetLang(lang) || 'html';
    const safeKind = WIDGET_KINDS.has(kind) ? kind : (LANG_DEFAULT_KIND[safeLang] || 'card');
    return '<div class="ai-widget" data-widget-lang="' + safeLang + '" data-widget-kind="' + safeKind +
        '" data-widget-key="' + widgetCacheKey(safeLang, text) + '">' +
        '<div class="ai-widget-src" hidden><pre><code class="language-' + safeLang + '">' +
        escapeWidgetText(text) + '</code></pre></div></div>\n';
}

// CSS 清洗：卡片本身在 shadow 里、脚本已被禁，这里只处理能越过边界的几类写法。
// - 外链资源（@import / url(http…)）会发网络请求，去掉；文档内引用 url(#id) 与 data: 保留。
// - position:fixed 在 shadow 内仍相对视口，会盖住整个应用，降级为 absolute。
// - expression()/behavior/-moz-binding 是历史执行入口，直接删。
export function sanitizeWidgetCss(css) {
    let text = String(css || '');
    if (!text.trim()) return '';
    if (text.length > MAX_WIDGET_CSS_CHARS) text = text.slice(0, MAX_WIDGET_CSS_CHARS);
    return text
        .replace(/<\/?style\b[^>]*>/gi, '')
        .replace(/@import[^;\n]*;?/gi, '')
        .replace(/expression\s*\(/gi, '(')
        .replace(/javascript\s*:/gi, '')
        // [^;\n] 而不是 [^;]：后者会跨行吞掉下一条规则，把无关样式整段删掉。
        .replace(/-moz-binding\s*:[^;\n]*;?/gi, '')
        .replace(/behavior\s*:[^;\n]*;?/gi, '')
        .replace(/position\s*:\s*fixed/gi, 'position:absolute')
        // 用回调判断而不是负向断言：`(['"]?)` 这类可选引号会发生回溯，导致 data: 被误杀。
        .replace(/url\s*\(\s*(['"]?)([\s\S]*?)\1\s*\)/gi, (match, quote, target) => {
            const value = String(target || '').trim();
            return /^(#|data:)/i.test(value) ? match : 'none';
        });
}

// 从围栏源码里抽出 <style> 块。
// 必要性：DOMPurify 会把 HTML 里的 <style> 连同内容一起剥掉（svg 内的反而保留），
// 若只在 sanitize 之后拼装，HTML 卡片会丢掉全部样式。这里先取出 CSS 文本单独清洗，
// 再和卡片基础样式一起塞进 shadow 的 <style>，作用域仍然只有卡片内部。
export function extractWidgetCss(code) {
    const styles = [];
    const body = String(code || '').replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (match, css) => {
        styles.push(css);
        return '';
    });
    return {code: body, css: sanitizeWidgetCss(styles.join('\n'))};
}

// html 卡片的本地图片：DOMPurify 的 URI 白名单会剥掉盘符 src（原始 HTML 不执行是硬要求），
// 清洗前把本地 src 抄一份到 data-ai-src（data-* 属性默认放行且不做 URI 校验），挂载后由外层
// resolveImages 经后端 ReadImageAsDataURL 换成 data URL。只加属性不重排 DOM，正则足够且无脚本面。
export function preserveLocalImageSrc(code) {
    let text = String(code || '');
    if (!/<img\b[\s>]/i.test(text)) return text;
    return text.replace(/(<img\b[^>]*?\bsrc\s*=\s*)("[^"]*"|'[^']*')/gi, (match, head, attr) => {
        const src = attr.slice(1, -1);
        if (/^(https?:|data:|blob:)/i.test(src)) return match;
        return head + attr + ' data-ai-src="' + escapeWidgetText(src) + '"';
    });
}

export function sanitizeWidgetHtml(code, lang) {
    let source = String(code || '');
    // 裸 SVG 片段补命名空间与默认视口，否则部分渲染路径会得到 0 尺寸。
    if (lang === 'svg' && !/^\s*<svg[\s>]/i.test(source)) {
        source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 400">' + source + '</svg>';
    }
    return DOMPurify.sanitize(source, {
        USE_PROFILES: {html: true, svg: true, svgFilters: true, mathMl: true},
        // form 禁掉：无脚本的表单只会把卡片导航走；checkbox / details 等仍保留，纯 CSS 交互照常可用。
        FORBID_TAGS: [
            'script', 'iframe', 'frame', 'frameset', 'object', 'embed',
            'link', 'meta', 'base', 'form', 'audio', 'video', 'source', 'track',
        ],
        FORBID_ATTR: ['srcdoc'],
    });
}

function widgetButton(label, title, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ai-widget-btn';
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick(button);
    });
    return button;
}

function ensureShadow(host) {
    return host.shadowRoot || host.attachShadow({mode: 'open'});
}

// fillShadow 只负责填充内容；主题重渲染（异步卡片）会重复调用，不改监听器。
function fillShadow(host, code, lang) {
    const shadow = ensureShadow(host);
    // html 卡片先抄本地图片 src 到 data-ai-src（见 preserveLocalImageSrc 注释）；
    // svg / 引擎产物不处理（SSR 输出不含外链 img）。
    const extracted = extractWidgetCss(lang === 'html' ? preserveLocalImageSrc(code) : code);
    shadow.innerHTML = '<style>' + SHADOW_STYLE + extracted.css + '</style>' +
        sanitizeWidgetHtml(extracted.code, lang);
}

function mountShadow(host, code, lang, opts) {
    const shadow = ensureShadow(host);
    // 链接交给系统浏览器；其余导航（相对路径、javascript:、表单）一律拦下。
    // 主题重渲染会重复进入，守卫只绑一次。
    if (!host.dataset.shadowGuards) {
        host.dataset.shadowGuards = '1';
        shadow.addEventListener('click', (event) => {
            const link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
            if (!link) return;
            event.preventDefault();
            const href = String(link.getAttribute('href') || '').trim();
            if (/^(https?:\/\/|mailto:)/i.test(href) && typeof opts.openExternal === 'function') {
                opts.openExternal(href);
            }
        }, true);
        shadow.addEventListener('submit', (event) => event.preventDefault(), true);
    }
    fillShadow(host, code, lang);
}

function mountCard(node, lang, kind, code, opts) {
    node.dataset.widgetReady = '1';
    const srcPanel = node.querySelector('.ai-widget-src');

    const bar = document.createElement('div');
    bar.className = 'ai-widget-bar';
    const tag = document.createElement('span');
    tag.className = 'ai-widget-tag';
    tag.textContent = LANG_LABELS[lang] || String(lang).toUpperCase();
    const label = document.createElement('span');
    label.className = 'ai-widget-label';
    label.textContent = KIND_LABELS[kind] || '可视化';
    const actions = document.createElement('div');
    actions.className = 'ai-widget-actions';

    const srcButton = widgetButton('源码', '查看 / 收起源码', () => {
        const show = !!srcPanel && srcPanel.hidden;
        if (srcPanel) srcPanel.hidden = !show;
        srcButton.textContent = show ? '收起' : '源码';
        node.classList.toggle('show-src', show);
    });
    const copyButton = widgetButton('复制', '复制源码', () => {
        if (typeof opts.copyText === 'function') opts.copyText(code, LANG_LABELS[lang] || String(lang).toUpperCase());
    });
    actions.append(srcButton, copyButton);
    // 另存为：异步卡片导出渲染后的 SVG（源码只是文本 / JSON，离线打不开），svg / html 卡导源码。
    if (typeof opts.saveAs === 'function') {
        const saveButton = widgetButton('另存为', '保存到工作区 .cadt/answers/', () => {
            const isAsync = !!ASYNC_RENDERERS[lang];
            const ext = (isAsync || lang === 'svg') ? 'svg' : 'html';
            const content = isAsync ? (asyncSvg.get(node) || code) : code;
            Promise.resolve(opts.saveAs({lang, kind, ext, content})).catch((e) => {
                // 尽力而为：实现侧已 flash 提示，这里兜住避免 unhandled rejection
            });
        });
        actions.append(saveButton);
    }
    bar.append(tag, label, actions);

    const body = document.createElement('div');
    body.className = 'ai-widget-body';
    node.insertBefore(bar, node.firstChild);
    node.insertBefore(body, srcPanel || null);
    if (ASYNC_RENDERERS[lang]) {
        mountAsyncCard(node, body, lang, code, opts);
        return;
    }
    mountShadow(body, code, lang, opts);
    // html 卡片里抄到 data-ai-src 的本地图片：由外层实现（复用 AI 消息的图片解析）换成 data URL。
    if (typeof opts.resolveImages === 'function' && body.shadowRoot) opts.resolveImages(body.shadowRoot);
}

// ---- 异步渲染引擎（mermaid / echarts / graph / wordcloud） ----
// 引擎模块动态 import：卡片首次挂载该类语言才加载，vendor 脚本随之按需注入，不进 Vite 主包。
const ASYNC_RENDERERS = {
    mermaid: () => import('./mermaid-render.js').then((m) => m.renderMermaidToSvg),
    echarts: () => import('./chart-render.js').then((m) => m.renderEchartsToSvg),
    graph: () => import('./layout-render.js').then((m) => m.renderGraphToSvg),
    wordcloud: () => import('./wordcloud-render.js').then((m) => m.renderWordCloudToSvg),
};
const asyncCards = new Set(); // 已挂载的异步卡片节点，主题切换时逐个重渲染
const asyncOpts = new Map();  // node → enhanceWidgets opts（重渲染时复用 openExternal 等）
const asyncSvg = new Map();   // node → 最近一次渲染的 SVG（另存为导出用）

// 消息整段重渲染会销毁旧节点：三张登记表以 node 为键，断连节点在下次 enhanceWidgets 清掉，
// 避免长会话里持有已销毁 DOM。
function sweepAsyncMaps() {
    for (const node of Array.from(asyncCards)) {
        if (!node.isConnected) {
            asyncCards.delete(node);
            asyncOpts.delete(node);
            asyncSvg.delete(node);
        }
    }
}

function currentThemeId() {
    return document.documentElement.dataset.theme || '';
}

let themeObserver = null;
// 主题切换走 documentElement 的 data-theme 属性（settings-ui 切主题的唯一出口），懒注册监听；
// 异步引擎产物是具体色值的静态 SVG，主题换了必须重新渲染（缓存按主题区分，旧主题条目自然淘汰）。
function ensureThemeObserver() {
    if (themeObserver || typeof MutationObserver === 'undefined') return;
    themeObserver = new MutationObserver(() => rerenderAsyncCards());
    themeObserver.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
}

async function renderAsyncCard(lang, code) {
    const render = await ASYNC_RENDERERS[lang]();
    return render(code, currentThemeId());
}

async function mountAsyncCard(node, body, lang, code, opts) {
    asyncCards.add(node);
    asyncOpts.set(node, opts);
    ensureThemeObserver();
    body.innerHTML = '<div class="ai-widget-loading">正在渲染可视化…</div>';
    try {
        const svg = await renderAsyncCard(lang, code);
        // 消息整段重渲染会销毁重建卡片节点：任务完成时节点已不在文档里就丢弃（不挂孤儿）。
        if (!node.isConnected) {
            asyncCards.delete(node);
            asyncOpts.delete(node);
            return;
        }
        body.innerHTML = '';
        mountShadow(body, svg, 'svg', asyncOpts.get(node) || opts);
        asyncSvg.set(node, svg);
        if (typeof asyncOpts.get(node)?.resolveImages === 'function' && body.shadowRoot) {
            asyncOpts.get(node).resolveImages(body.shadowRoot);
        }
    } catch (e) {
        if (!node.isConnected) {
            asyncCards.delete(node);
            asyncOpts.delete(node);
            return;
        }
        // 失败降级：放出源码，与超限卡片的处理一致。
        body.innerHTML = '';
        node.classList.add('ai-widget-error');
        const srcPanel = node.querySelector('.ai-widget-src');
        if (srcPanel) srcPanel.hidden = false;
        const msg = document.createElement('div');
        msg.className = 'ai-widget-error-text';
        msg.textContent = '渲染失败，已显示源码：' + ((e && e.message) || e);
        body.appendChild(msg);
    }
}

async function rerenderAsyncCards() {
    for (const node of Array.from(asyncCards)) {
        if (!node.isConnected) {
            asyncCards.delete(node);
            asyncOpts.delete(node);
            continue;
        }
        const lang = node.getAttribute('data-widget-lang');
        const body = node.querySelector('.ai-widget-body');
        if (!ASYNC_RENDERERS[lang] || !body) continue;
        const code = node.querySelector('.ai-widget-src code');
        try {
            const svg = await renderAsyncCard(lang, code ? (code.textContent || '') : '');
            if (!node.isConnected) {
                asyncCards.delete(node);
                asyncOpts.delete(node);
                continue;
            }
            fillShadow(body, svg, 'svg');
            asyncSvg.set(node, svg);
        } catch (e) {
            // 尽力而为路径：重渲染失败保留旧图（旧主题色好过空白），不打断用户。
        }
    }
}

// 把 markdown 渲染出的 .ai-widget 占位升级成卡片。
// streaming 为真时只标记「生成中」，等整轮结束再挂载——流式期间每次增量都会整段重渲染，
// 此时建卡片会被反复销毁重建（闪烁且浪费）。返回实际挂载的数量。
export function enhanceWidgets(root, opts = {}) {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;
    sweepAsyncMaps();
    const nodes = root.querySelectorAll('.ai-widget[data-widget-lang]');
    let mounted = 0;
    nodes.forEach((node, index) => {
        if (node.dataset.widgetReady === '1') return;
        const lang = node.getAttribute('data-widget-lang') || 'html';
        const kind = node.getAttribute('data-widget-kind') || LANG_DEFAULT_KIND[lang] || 'card';
        const src = node.querySelector('.ai-widget-src code');
        const code = src ? (src.textContent || '') : '';
        if (!code.trim()) return;
        if (index >= MAX_WIDGETS_PER_MESSAGE || code.length > MAX_WIDGET_CHARS) {
            node.classList.add('ai-widget-oversize');
            // 不渲染卡片，但必须把源码放出来，否则用户只看到一句提示
            const srcPanel = node.querySelector('.ai-widget-src');
            if (srcPanel) srcPanel.hidden = false;
            return;
        }
        node.classList.remove('ai-widget-oversize');
        if (opts.streaming) {
            node.classList.add('ai-widget-pending');
            return;
        }
        node.classList.remove('ai-widget-pending');
        mountCard(node, lang, kind, code, opts);
        mounted++;
    });
    return mounted;
}
