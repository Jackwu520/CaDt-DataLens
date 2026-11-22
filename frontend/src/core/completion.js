// completion.js：补全候选的纯函数层——打分排序、词表/结构提取、设置归一化、Ace 挂载助手。
// 不 import Ace 模块、不在模块顶层碰 window；Ace 侧两个消费方：
//   文件编辑器 editor/editor-completion.js、SQL 控制台 db/db-completion.js（域模块互不 import，
//   共同的 Ace 选项挂载走本文件的 enableAceCompletion）。
// 打分口径：前缀 > CamelHumps（驼峰边界子序列）> 子串 > 中缀散点（fuzzy），同档短者/靠前者优先。
// 方案见 docs/unfinished-plans/editor-completion.md §4。

// ── 打分 ──

// 单个候选对一个前缀的匹配分；null 表示不匹配。prefix 为空时视为「全量平铺」。
export function scoreMatch(prefix, text) {
    const p = String(prefix || '').toLowerCase();
    const t = String(text || '');
    if (!t) return null;
    if (!p) return {score: 0, kind: 'any'};
    const tl = t.toLowerCase();
    if (tl.startsWith(p)) {
        // 前缀命中：越短越靠前
        return {score: 1000 - Math.min(t.length, 200), kind: 'prefix'};
    }
    const camel = camelScore(p, t);
    if (camel !== null) return {score: 800 - camel, kind: 'camel'};
    const idx = tl.indexOf(p);
    if (idx >= 0) {
        // 子串（含中缀）：命中点越靠前越好
        return {score: 600 - Math.min(idx * 2, 200), kind: 'substring'};
    }
    const fuzzy = fuzzyScore(p, tl);
    if (fuzzy !== null) return {score: 300 - fuzzy, kind: 'fuzzy'};
    return null;
}

// CamelHumps：p 的字符按序落在 t 的驼峰边界上（词首 / 大写切换 / 非字母数字后），gap 越小越好。
function camelScore(p, t) {
    let pi = 0;
    let gapSum = 0;
    let lastIdx = -1;
    for (let i = 0; i < t.length && pi < p.length; i++) {
        const ch = t[i];
        const prev = t[i - 1] || '';
        const isBoundary = i === 0
            || (/[^A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(ch))
            || (/[A-Z]/.test(ch) && !/[A-Z]/.test(prev) && /[a-z]/.test(prev));
        if (isBoundary && ch.toLowerCase() === p[pi]) {
            if (lastIdx >= 0) gapSum += i - lastIdx - 1;
            lastIdx = i;
            pi++;
        }
    }
    if (pi < p.length) return null;
    return gapSum + Math.max(0, t.length - lastIdx - 1);
}

// 中缀散点：p 的字符按序散落在 t 中（连续命中更优）。
function fuzzyScore(p, tl) {
    let pi = 0;
    let gap = 0;
    let total = 0;
    for (let i = 0; i < tl.length && pi < p.length; i++) {
        if (tl[i] === p[pi]) {
            total += gap;
            gap = 0;
            pi++;
        } else {
            gap++;
        }
    }
    if (pi < p.length) return null;
    return total;
}

// 过滤 + 排序：items 为 [{caption, value, meta, ...}]，命中项带上 score，按分排序（稳定）。
export function matchFilter(prefix, items, limit = 60) {
    const cap = Math.max(0, Number.isFinite(limit) ? limit : 60);
    const scored = [];
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it || it.caption == null) continue;
        const m = scoreMatch(prefix, it.caption);
        if (m) scored.push({item: it, score: m.score, order: i});
    }
    scored.sort((a, b) => (b.score - a.score) || (a.order - b.order));
    const out = scored.slice(0, cap).map((s) => Object.assign({}, s.item, {score: s.score}));
    return out;
}

// ── 词表 / 结构提取（词法兜底与数据格式结构感知的候选来源）──

// 全文档词表（词法兜底）：≥minLen 的标识符词，去重、限量；大文本只扫光标附近窗口。
export function extractWords(text, opts = {}) {
    const minLen = Math.max(1, opts.minLen || 3);
    const maxWords = opts.maxWords || 8000;
    const maxBytes = opts.maxBytes || 2 * 1024 * 1024;
    let src = String(text || '');
    const row = Number.isFinite(opts.cursorRow) ? opts.cursorRow : -1;
    if (src.length > maxBytes) {
        const lines = src.split('\n');
        if (row >= 0 && row < lines.length) {
            const half = Math.max(200, Math.floor((opts.windowLines || 1000) / 2));
            const from = Math.max(0, row - half);
            const to = Math.min(lines.length, row + half + 1);
            src = lines.slice(from, to).join('\n');
        } else {
            src = src.slice(0, maxBytes);
        }
    }
    const out = new Set();
    const re = new RegExp('[A-Za-z_$][A-Za-z0-9_$]{' + (minLen - 1) + ',}', 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
        out.add(m[0]);
        if (out.size >= maxWords) break;
        re.lastIndex = m.index + m[0].length;
    }
    return Array.from(out);
}

// JSON / JSONL 的 key 候选：`"key":` 形态（容错，不要求整文档可解析）。
export function extractJsonKeys(text, opts = {}) {
    const maxBytes = opts.maxBytes || 1024 * 1024;
    const src = String(text || '').slice(0, maxBytes);
    const out = new Set();
    const re = /"((?:[^"\\\n]|\\.)+)"\s*:/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const raw = m[1];
        let key = raw;
        if (raw.indexOf('\\') >= 0) {
            try { key = JSON.parse('"' + raw + '"'); } catch (e) { continue; }
        }
        if (key) out.add(key);
    }
    return Array.from(out);
}

// YAML 的 key 候选：行首（可带 - ）到冒号后跟空白/行尾；http:// 这类 URL 不算。
export function extractYamlKeys(text) {
    const out = new Set();
    for (const line of String(text || '').split('\n')) {
        if (/^\s*#/.test(line)) continue;
        const m = line.match(/^\s*(?:-\s+)?["']?([^\s:#"'[\]{}][^:#]*?)["']?\s*:(?:\s|$)/);
        if (m && m[1].trim()) out.add(m[1].trim());
    }
    return Array.from(out);
}

// INI / TOML / Properties 的段名与键候选。
export function extractIniSections(text) {
    const out = new Set();
    const re = /^\s*\[([^\]]+)\]/gm;
    const src = String(text || '');
    let m;
    while ((m = re.exec(src)) !== null) out.add(m[1].trim());
    return Array.from(out);
}

export function extractIniKeys(text) {
    const out = new Set();
    const re = /^\s*([^#[;\s=][^=\n]*?)\s*=/gm;
    const src = String(text || '');
    let m;
    while ((m = re.exec(src)) !== null) out.add(m[1].trim());
    return Array.from(out);
}

// XML / SVG 的标签名与属性名候选。
export function extractXmlTags(text) {
    const out = new Set();
    const re = /<\/?\s*([A-Za-z_][\w.:-]*)/g;
    const src = String(text || '');
    let m;
    while ((m = re.exec(src)) !== null) out.add(m[1]);
    return Array.from(out);
}

export function extractXmlAttrs(text) {
    const out = new Set();
    const re = /\s([A-Za-z_][\w.:-]*)\s*=/g;
    const src = String(text || '');
    let m;
    while ((m = re.exec(src)) !== null) out.add(m[1]);
    return Array.from(out);
}

// ── 设置归一化（settings.completion 缺省 / 损坏回默认，不 throw）──

export function normalizeCompletionSettings(raw) {
    const src = raw && typeof raw === 'object' && raw.completion && typeof raw.completion === 'object'
        ? raw.completion
        : {};
    return {
        files: src.files !== false,
        sql: src.sql !== false,
        live: src.live === true, // 默认关：vendored bundle 的 live afterExec 路径实测不可靠（§15.2）
    };
}

// ── Ace 挂载助手（editor / db 两域共用）──

// vendored Ace（jsoneditor.min.js 内置）是否带补全引擎：能力探测，失败即静默降级。
export function isAceCompletionCapable(ace) {
    try {
        return !!(ace && typeof ace.require === 'function' && ace.require('ace/ext/language_tools'));
    } catch (e) {
        return false;
    }
}

// 为一个 Ace 编辑器实例挂补全：completers 数组会替换默认 completer 集，live 为输入即弹。
// 尽力而为路径：bundle 结构变化时静默放弃（无补全，不报错不打扰用户）。
export function enableAceCompletion(aceEditor, completers, live) {
    try {
        aceEditor.setOption('enableBasicAutocompletion', completers);
        aceEditor.setOption('enableLiveAutocompletion', !!live);
        return true;
    } catch (e) {
        return false;
    }
}
