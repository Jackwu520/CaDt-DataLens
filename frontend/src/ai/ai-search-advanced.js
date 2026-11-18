// ai-search-advanced.js —— search_text 高级参数的归一化与结果格式化（纯函数，无 DOM / 无后端依赖）。
// 与 Go internal/search 的选项口径一一对应：regex / wholeWord / pattern / excludePattern /
// outputMode / context / maxResults。两处改动必须同步（advanced_test.go + 本文件测试）。

const textOf = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));

const clampInt = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
};

/**
 * 归一化模型给出的高级参数。缺省值与 Go 侧一致：context=0、maxResults=200、outputMode=content。
 * 非法值一律回落默认值而不抛错——工具入参不该让整轮对话失败。
 */
export function normalizeSearchOptions(input = {}) {
    const mode = textOf(input.outputMode).toLowerCase();
    return {
        regex: input.regex === true || input.regex === 'true',
        wholeWord: input.wholeWord === true || input.wholeWord === 'true',
        pattern: textOf(input.pattern).trim(),
        excludePattern: textOf(input.excludePattern).trim(),
        outputMode: ['content', 'files', 'count'].includes(mode) ? mode : 'content',
        context: clampInt(input.context, 0, 0, 3),
        maxResults: clampInt(input.maxResults, 200, 1, 1000),
    };
}

const resultSize = (result) => {
    if (!result) return 0;
    // files/count 模式会把 hits 置空数组（mock 后端如此），不能先命中 hits 就当空结果。
    if (Array.isArray(result.hits) && result.hits.length > 0) return result.hits.length;
    if (Array.isArray(result.fileList)) return result.fileList.length;
    if (Array.isArray(result.counts)) return result.counts.length;
    return 0;
};

export function relativeToRoot(path, rootNorm) {
    const shown = textOf(path).replace(/\\/g, '/');
    const root = textOf(rootNorm).replace(/\\/g, '/').replace(/\/+$/, '');
    if (root && shown.toLowerCase().startsWith(root.toLowerCase() + '/')) {
        return shown.slice(root.length + 1);
    }
    return shown;
}

/**
 * filePattern 的前端兜底过滤（Go 侧已下推；旧后端 / mock 仍可能需要）。
 * glob 语义由调用方注入，避免本模块依赖 ai-file-tools.js。
 */
export function filterSearchResult(result, pattern, rootNorm, globMatchPath) {
    if (!pattern) return {result, note: ''};
    const before = resultSize(result);
    const next = {...(result || {})};
    if (Array.isArray(result && result.hits)) {
        next.hits = result.hits.filter((hit) => globMatchPath(pattern, relativeToRoot(hit.path, rootNorm), hit.name));
    }
    if (Array.isArray(result && result.fileList)) {
        next.fileList = result.fileList.filter((path) => globMatchPath(pattern, relativeToRoot(path, rootNorm), ''));
    }
    if (Array.isArray(result && result.counts)) {
        next.counts = result.counts.filter((item) => globMatchPath(pattern, relativeToRoot(item.path, rootNorm), ''));
    }
    let truncated = !!next.truncated;
    if (Array.isArray(next.hits) && next.hits.length > 200) {
        next.hits = next.hits.slice(0, 200);
        truncated = true;
    }
    next.truncated = truncated;
    return {result: next, note: '按 "' + pattern + '" 过滤：命中 ' + resultSize(next) + '（过滤前 ' + before + '）'};
}

// 命中路径 → 绝对路径（后端可能给绝对路径，也可能给相对 root 的路径）。
export function absoluteSearchPath(path, rootNorm) {
    const shown = textOf(path).replace(/\\/g, '/');
    if (/^[a-zA-Z]:\//.test(shown) || shown.startsWith('//')) return shown;
    const root = textOf(rootNorm).replace(/\\/g, '/').replace(/\/+$/, '');
    if (root && shown.toLowerCase().startsWith(root.toLowerCase() + '/')) return shown;
    return root ? root + '/' + shown.replace(/^\/+/, '') : shown;
}

// 单文件搜索：传文件作为 path 时，后端按父目录扫，结果缩到这一个文件。
export function filterSearchResultToFile(result, fileAbs, rootNorm) {
    const target = textOf(fileAbs).replace(/\\/g, '/').toLowerCase();
    const same = (path) => absoluteSearchPath(path, rootNorm).toLowerCase() === target;
    const next = {...(result || {})};
    if (Array.isArray(result && result.hits)) next.hits = result.hits.filter((hit) => same(hit.path));
    if (Array.isArray(result && result.fileList)) next.fileList = result.fileList.filter((path) => same(path));
    if (Array.isArray(result && result.counts)) next.counts = result.counts.filter((item) => same(item.path));
    return next;
}

/**
 * 把后端结果拼成给模型看的纯文本。
 * content: `相对路径:行号: 预览`，context>0 时每条命中附 `行号- / 行号+` 前后文；
 * files:   只要文件清单（大结果先拿清单再 read_file，省 token）；
 * count:   每文件命中数。
 */
export function formatSearchAnswer(result, opts = {}, meta = {}) {
    const rootNorm = textOf(meta.rootNorm);
    const start = textOf(meta.start);
    const scopeNote = textOf(meta.scopeNote);
    const filterNote = textOf(meta.filterNote);
    const lines = [];
    const mode = opts.outputMode || 'content';
    if (mode === 'files') {
        const files = (result && result.fileList) || [];
        lines.push('匹配文件（' + files.length + ' 个）：');
        for (const path of files) lines.push(relativeToRoot(path, rootNorm));
    } else if (mode === 'count') {
        const counts = (result && result.counts) || [];
        lines.push('每文件命中数（' + counts.length + ' 个文件）：');
        for (const item of counts) lines.push(relativeToRoot(item.path, rootNorm) + ': ' + item.count);
    } else {
        const hits = (result && result.hits) || [];
        for (const hit of hits) {
            lines.push(relativeToRoot(hit.path, rootNorm) + ':' + hit.line + ': ' + textOf(hit.preview));
            for (const ctx of hit.before || []) lines.push('    ' + ctx.line + '- ' + textOf(ctx.text));
            for (const ctx of hit.after || []) lines.push('    ' + ctx.line + '+ ' + textOf(ctx.text));
        }
    }
    if (resultSize(result) === 0) {
        return '没有找到匹配' + (meta.query ? '：' + meta.query : '') +
            (start ? '（起点：' + start + '）' : '') + (scopeNote ? '（' + scopeNote + '）' : '') +
            (filterNote ? '（' + filterNote + '）' : '');
    }
    if (scopeNote) lines.unshift(scopeNote);
    else if (start) lines.unshift('搜索起点：' + start + '；以下路径相对该起点');
    if (filterNote) lines.push('（' + filterNote + '）');
    if (result && result.truncated) lines.push('…（结果已截断）');
    if (result && result.artifactSkipped) lines.push('…（源码命中已占满窗口，产物档 dist/build 等未检索）');
    return lines.join('\n');
}
