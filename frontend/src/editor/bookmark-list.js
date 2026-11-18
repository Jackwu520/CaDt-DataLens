// bookmark-list.js：书签总览的数据聚合与 AI 文本格式（纯函数，无 DOM）。
// 渲染复用 quick-switch 的 bookmarks 层级；app_control 的 list_bookmarks 走 formatBookmarkListText。
// 口径说明：书签随会话快照只持久化「打开中的标签页」（serializeSession 会把 knownDocViews
// 修剪到当前打开的文档），所以聚合只看打开中的 docs，与功能真实持久化语义一致。
const PREVIEW_MAX = 72;

function docLines(doc) {
    try {
        if (doc && doc.editor && typeof doc.editor.getText === 'function') {
            return String(doc.editor.getText() || '').split('\n');
        }
    } catch (e) {}
    const content = doc && doc.content;
    return typeof content === 'string' ? content.split('\n') : null;
}

// linePreview：行内容去缩进截断，供总览与 AI 判断书签落点；越界行返回空串。
export function linePreview(lines, line, max = PREVIEW_MAX) {
    if (!Array.isArray(lines) || !(line >= 1) || line > lines.length) return '';
    const text = String(lines[line - 1] || '').trim();
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// bookmarkOverview：按路径排序的书签分组，行号对外一律 1-based（line），内部 0-based（row）。
export function bookmarkOverview(docs) {
    const list = Array.isArray(docs) ? docs : [];
    const groups = [];
    for (const doc of list) {
        const rows = [...((doc && doc.bookmarks) || [])]
            .filter((n) => Number.isInteger(n) && n >= 0)
            .sort((a, b) => a - b);
        if (!doc || !doc.path || !rows.length) continue;
        const lines = docLines(doc);
        groups.push({
            path: doc.path,
            name: doc.name || String(doc.path).split(/[\\/]/).pop(),
            rows: rows.map((row) => ({row, line: row + 1, preview: linePreview(lines, row + 1)})),
        });
    }
    groups.sort((a, b) => a.path.localeCompare(b.path));
    return groups;
}

// formatBookmarkListText：给 AI 的紧凑文本（动作返回字符串直通模型）。
export function formatBookmarkListText(groups) {
    const list = Array.isArray(groups) ? groups : [];
    if (!list.length) return '当前没有书签。在代码/文本视图把光标放到目标行按 F11 添加；或用 add_bookmark 指定文件与行。';
    const out = [];
    let total = 0;
    for (const group of list) {
        out.push(group.path);
        for (const row of group.rows) {
            total++;
            out.push('  - ' + row.line + (row.preview ? ': ' + row.preview : ''));
        }
    }
    out.push('共 ' + list.length + ' 个文件 ' + total + ' 个书签（行号 1 起；跨文件跳转用 goto_bookmark，当前文件内跳行用 goto_line）。');
    return out.join('\n');
}
