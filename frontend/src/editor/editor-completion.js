// editor-completion.js：文件编辑器侧补全（editor 域，editor-ace-hooks.js 调用本模块挂载）。
// 候选分层见 docs/unfinished-plans/editor-completion.md §6：
//   结构感知（JSON/JSONL key、YAML 键、XML 标签/属性、INI/TOML 段/键）→ 关键词层（mode 的
//   $keywordList，vendored 多数 mode 没有，有则带上）→ 词法兜底（全文档词表）。
// 只读 doc（含大文件只读档）不挂；能力探测失败静默降级（core/completion.js）。

import {
    matchFilter,
    extractWords,
    extractJsonKeys,
    extractYamlKeys,
    extractIniSections,
    extractIniKeys,
    extractXmlTags,
    extractXmlAttrs,
    normalizeCompletionSettings,
    isAceCompletionCapable,
    enableAceCompletion,
} from '../core/completion.js';
import {isDocReadOnly} from '../core/readonly.js';
import {iconSvg} from '../core/icons.js';

const MAX_RESULT = 60;
// 词表节流：脏标记后 300ms 内复用旧表（live 模式每键触发，重建太频），超时即重建。
const WORDS_THROTTLE_MS = 300;
const WORDS_TTL_MS = 3000;

// aceModeFor 产出 'ace/mode/<x>'；结构感知路由只认数据格式，其余走词法兜底（§6.5 三层）。
export function routeForMode(modeId) {
    const m = String(modeId || '').replace(/^ace\/mode\//, '');
    if (m === 'json') return 'json';
    if (m === 'yaml') return 'yaml';
    if (m === 'xml') return 'xml';
    if (m === 'ini' || m === 'properties' || m === 'toml') return 'ini';
    return 'lexical';
}

// 启用判定：设置开关 + 非只读（core/readonly.js 单一来源，与 setReadOnly 同口径）。
export function shouldEnableFileCompletion(settings, doc) {
    const c = normalizeCompletionSettings(settings);
    if (!c.files) return false;
    if (!doc) return false;
    return !isDocReadOnly(doc, settings);
}

// mode 关键词（零成本顺带层）：vendored mode 多数没有 $keywordList（实测 python/js/go 均无），
// 有就带上并按 '|' 拆分；没有就只剩词法兜底（方案 §6.5 的既定降级路径）。
export function modeKeywords(session) {
    try {
        if (session.$cadtKeywords) return session.$cadtKeywords;
        const rules = session && session.$mode && session.$mode.$highlightRules;
        const raw = rules && rules.$keywordList;
        const list = Array.isArray(raw)
            ? raw.flatMap((x) => String(x).split('|')).filter(Boolean)
            : [];
        session.$cadtKeywords = list;
        return list;
    } catch (e) {
        return []; // $mode 内部结构异常：按无关键词表处理（词法兜底仍在）
    }
}

function sessionValue(session) {
    try { return String(session.getValue() || ''); } catch (e) { return ''; } // session 异常按空文档处理
}

// 词表（按 session 缓存；change 事件打脏标记见 setupEditorCompletion）。
export function wordsForSession(session, pos) {
    const now = Date.now();
    const cached = session.$cadtWords;
    const fresh = cached && (now - cached.at) < WORDS_TTL_MS;
    if (fresh && !session.$cadtWordsDirty) return cached.list;
    // 刚重建过不久且还是脏的：先复用旧表（节流，词表主体在几次击键间基本稳定）
    if (fresh && (now - cached.at) < WORDS_THROTTLE_MS) return cached.list;
    const row = pos && Number.isFinite(pos.row) ? pos.row : -1;
    const list = extractWords(sessionValue(session), {cursorRow: row});
    session.$cadtWords = {at: now, list};
    session.$cadtWordsDirty = false;
    return list;
}

// 组装某 session 的候选（route 决定结构感知来源，再叠关键词与词法兜底）。导出供测试。
// 按 caption 去重：结构层先到先得（JSON 键与文档词重名只出一行，避免弹窗重复）。
export function itemsForSession(session, pos) {
    const modeId = session && session.getMode ? session.getMode().$id : '';
    const route = routeForMode(modeId);
    const text = sessionValue(session);
    const out = [];
    const seen = new Set();
    const push = (caption, meta) => {
        if (seen.has(caption)) return;
        seen.add(caption);
        out.push({caption, value: caption, meta});
    };
    if (route === 'json') {
        for (const k of extractJsonKeys(text)) push(k, '键');
    } else if (route === 'yaml') {
        for (const k of extractYamlKeys(text)) push(k, '键');
    } else if (route === 'xml') {
        for (const t of extractXmlTags(text)) push(t, '标签');
        for (const a of extractXmlAttrs(text)) push(a, '属性');
    } else if (route === 'ini') {
        for (const s of extractIniSections(text)) push(s, '段');
        for (const k of extractIniKeys(text)) push(k, '键');
    }
    for (const kw of modeKeywords(session)) push(kw, '关键词');
    for (const w of wordsForSession(session, pos)) push(w, '文档');
    return out;
}

// 文件侧 completer（结构随模式分流 + 词法兜底；候选不带 tooltip 数据，Ace 的 tooltip 兜底
// 只渲染自带 docText 的候选，这里没有 → 不实现 getDocTooltip，留 bundle 默认行为）。
// 弹层行图标：**惰性挂 MutationObserver**——popup 是首次 showPopup 时才创建的（实测 setup 时
// completer 有而 popup 为 null），没挂上不置标记、下次触发重试；且 popup renderer 不发
// afterRender 事件（实测挂了不触发），MutationObserver 观察 container 才可靠。
// 每个编辑器一个 completer 实例，挂载标记随实例走。
export function createFileCompleter() {
    let decorHooked = false;
    const completer = {
        id: 'cadtFileCompleter',
        getCompletions(editor, session, pos, prefix, callback) {
            if (!decorHooked && editor) {
                const popup = editor.completer && editor.completer.popup;
                if (popup && popup.container && typeof MutationObserver === 'function') {
                    attachDecor(popup);
                } else {
                    // popup 晚于本回调创建（首开流程内）：本轮结束后补挂并装饰已渲染的行
                    setTimeout(() => {
                        if (decorHooked || !editor) return;
                        try {
                            const p2 = editor.completer && editor.completer.popup;
                            if (p2 && p2.container && typeof MutationObserver === 'function') {
                                attachDecor(p2);
                            }
                        } catch (e) {} // hook 不上退回纯文本行，候选照常
                    }, 0);
                }
            }
            let items;
            try {
                items = itemsForSession(session, pos);
            } catch (e) {
                items = []; // 候选组装失败：给空候选，不打断输入
            }
            callback(null, matchFilter(prefix || '', items, MAX_RESULT));
        },
    };
    // 挂载本体（popup 就绪后调用；幂等由 decorHooked 保证）
    function attachDecor(popup) {
        const obs = new MutationObserver(() => {
            try { decoratePopupRows(popup); } catch (e) {} // 装饰失败不影响候选
        });
        obs.observe(popup.container, {childList: true, subtree: true});
        decorHooked = true;
        decoratePopupRows(popup); // 已可见的行先补一轮
    }
    return completer;
}

// ── 弹层行图标（JetBrains 风格）：meta 文本 → iconSvg 装饰 ──

// meta 文本 → 图标与类型标（类型标进 data-attr 供 CSS 分色）；SQL 列的 meta 是类型串，走默认
const CMPL_ICON_MAP = {
    '关键词': {icon: 'code', type: 'keyword'},
    'SQL': {icon: 'code', type: 'keyword'},
    '文档': {icon: 'doc', type: 'word'},
    '键': {icon: 'braces', type: 'key'},
    '段': {icon: 'structured-dir', type: 'section'},
    '标签': {icon: 'tag', type: 'tag'},
    '属性': {icon: 'rename', type: 'attr'},
    '表': {icon: 'view-table', type: 'table'},
    '视图': {icon: 'eye', type: 'view'},
};
const CMPL_ICON_DEFAULT = {icon: 'database', type: 'column'};

// 给弹层可见行补图标（Ace 每次渲染重建行 DOM，由 popup renderer 的 afterRender 触发重跑，
// 与 python token 补色同机制）。doc 可注入（node 测试无 document）；导出供测试。
export function decoratePopupRows(popup, doc = typeof document !== 'undefined' ? document : null) {
    if (!popup || !popup.container || !doc) return;
    for (const row of popup.container.querySelectorAll('.ace_line')) {
        if (row.querySelector('.cadt-cmpl-icon')) continue;
        const metaEl = row.querySelector('.ace_completion-meta');
        if (!metaEl) continue;
        const meta = String(metaEl.textContent || '').trim();
        const spec = CMPL_ICON_MAP[meta] || CMPL_ICON_DEFAULT;
        const span = doc.createElement('span');
        span.className = 'cadt-cmpl-icon';
        span.dataset.cadtType = spec.type;
        span.innerHTML = iconSvg(spec.icon, 12);
        row.insertBefore(span, row.firstChild);
    }
}

// 幂等挂载：applyAceMode / activateDoc 反复调用无害。早期 return 不置标记，
// 后续重入（如全局只读锁解除后重新激活标签页）可再次尝试挂载。
export function setupEditorCompletion(aceEditor, doc, settings) {
    if (!aceEditor || aceEditor._cadtCompletionSetup) return false;
    const c = normalizeCompletionSettings(settings);
    if (!c.files) return false;
    if (!shouldEnableFileCompletion(settings, doc)) return false;
    // node 测试环境无 window；浏览器里 window.ace 由 jsoneditor.min.js 提供
    if (!isAceCompletionCapable(typeof window !== 'undefined' ? window.ace : null)) return false;
    const ok = enableAceCompletion(aceEditor, [createFileCompleter()], c.live);
    if (!ok) return false;
    aceEditor._cadtCompletionSetup = true;
    // 词表脏标记：session 内容变更后下次触发重建（缓存挂在 session 上，随 session 存亡）
    try {
        aceEditor.session.on('change', () => {
            const s = aceEditor.session;
            if (s) s.$cadtWordsDirty = true;
        });
    } catch (e) {} // session 事件挂不上只影响节流，补全功能不受影响
    // 弹层行图标不在 setup 时挂——completer/popup 首次触发才存在，见 createFileCompleter
    return true;
}

// 设置热生效：settings 变更后对已开编辑器即时更新——已挂载的只翻 live 选项；未挂载的
// （总开关后开）按需补挂。main.js 组合根注入 docs 调用（镜像 editorKeybindings.applyToAll
// 的接线方式）；关掉 files 不做运行时热卸载（方案 §8 豁免，重开标签/切模式后生效）。
export function refreshCompletionSettings(entries, settings) {
    const c = normalizeCompletionSettings(settings);
    for (const entry of entries || []) {
        const aceEditor = entry && entry.aceEditor;
        if (!aceEditor) continue;
        if (aceEditor._cadtCompletionSetup) {
            try { aceEditor.setOption('enableLiveAutocompletion', !!c.live); } catch (e) {} // 尽力而为
            continue;
        }
        if (c.files) setupEditorCompletion(aceEditor, entry.doc, settings);
    }
}
