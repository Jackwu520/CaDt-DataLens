// diff-window-view.js：文件对比独立窗的视图（辅助独立窗第一批）。
// 从 diff-dialog.js 的比较内核拆出来供窗口形态复用：读两个文件 → 行级 diff
// （unifiedDiff）+ 可选语义差异（格式感知），只读展示。纯函数拆出可单测。

import {detectFormat} from '../core/formats.js';
import {unifiedDiff, semanticDiff, semanticEntryText} from '../core/diff.js';

const DIFF_LINE_LIMIT = 8000;

// formatDiffSummary 比较结果 → 摘要行（纯函数，配 diff-window-view.test.mjs）。
export function formatDiffSummary(result, semanticCount, hasParser) {
    if (!result || (!result.added && !result.removed)) return '文本内容相同';
    let summary = '文本差异：+' + result.added + ' 行 / -' + result.removed + ' 行';
    if (hasParser) {
        summary += semanticCount
            ? ' · 语义差异 ' + semanticCount + ' 处'
            : ' · 语义差异 0 处';
    } else {
        summary += ' · 当前格式无可用的数据感知比较';
    }
    return summary;
}

// parseForDiff 格式感知解析：无驱动 / 解析失败返回 null（对话框同款语义）。
export function parseForDiff(path, text) {
    const driver = detectFormat(path, text);
    if (!driver || typeof driver.parse !== 'function') return null;
    try {
        return {driver, value: driver.parse(text)};
    } catch (e) {
        return null;
    }
}

// createDiffWindowView 对比窗视图工厂：mount() 渲染摘要 + 差异行，run() 重比较。
export function createDiffWindowView(deps) {
    let outputEl = null;
    let summaryEl = null;
    let semanticListEl = null;
    let running = false;

    function buildSkeleton() {
        const wrap = document.createElement('div');
        wrap.className = 'diff-window-root';
        summaryEl = document.createElement('div');
        summaryEl.className = 'diff-window-summary';
        wrap.appendChild(summaryEl);
        semanticListEl = document.createElement('div');
        semanticListEl.className = 'diff-semantic-list hidden';
        wrap.appendChild(semanticListEl);
        outputEl = document.createElement('div');
        outputEl.className = 'diff-window-output';
        wrap.appendChild(outputEl);
        deps.container.textContent = '';
        deps.container.appendChild(wrap);
    }

    function renderDiffText(text) {
        outputEl.textContent = '';
        if (!text) {
            const same = document.createElement('div');
            same.className = 'diff-window-same';
            same.textContent = '两个文件内容相同。';
            outputEl.appendChild(same);
            return;
        }
        const lines = text.split('\n');
        const shown = lines.slice(0, DIFF_LINE_LIMIT);
        const fragment = document.createDocumentFragment();
        for (const line of shown) {
            const row = document.createElement('span');
            row.className = 'diff-line' + (line.startsWith('@@') ? ' diff-hunk' :
                line.startsWith('+') ? ' diff-add' :
                    line.startsWith('-') ? ' diff-del' : ' diff-ctx');
            row.textContent = line || ' ';
            fragment.appendChild(row);
        }
        if (lines.length > DIFF_LINE_LIMIT) {
            const more = document.createElement('span');
            more.className = 'diff-line diff-hunk';
            more.textContent = '… 仅显示前 ' + DIFF_LINE_LIMIT + ' 行';
            fragment.appendChild(more);
        }
        outputEl.appendChild(fragment);
    }

    async function run() {
        if (running) return;
        running = true;
        summaryEl.textContent = '正在读取并比较…';
        semanticListEl.textContent = '';
        semanticListEl.classList.add('hidden');
        try {
            const [a, b] = await Promise.all([
                deps.backend.OpenFile(deps.left, 'auto'),
                deps.backend.OpenFile(deps.right, 'auto'),
            ]);
            if (!a || a.binary || !b || b.binary) throw new Error('二进制文件不支持比较');
            const textA = String(a.content == null ? '' : a.content);
            const textB = String(b.content == null ? '' : b.content);
            const result = unifiedDiff(textA, textB);
            renderDiffText(result.text);
            const pa = parseForDiff(deps.left, textA);
            const pb = parseForDiff(deps.right, textB);
            let semanticCount = 0;
            if (pa && pb) {
                const entries = semanticDiff(pa.value, pb.value);
                semanticCount = entries.length;
                if (entries.length) {
                    const fragment = document.createDocumentFragment();
                    for (const entry of entries) {
                        const row = document.createElement('div');
                        row.className = 'diff-sem-row diff-sem-' + entry.kind;
                        const kind = document.createElement('span');
                        kind.className = 'diff-sem-kind';
                        kind.textContent = entry.kind === 'add' ? '新增' : (entry.kind === 'remove' ? '删除' : '修改');
                        const path = document.createElement('span');
                        path.className = 'diff-sem-path';
                        path.textContent = entry.path;
                        const value = document.createElement('span');
                        value.className = 'diff-sem-value';
                        value.textContent = semanticEntryText(entry);
                        row.append(kind, path, value);
                        row.addEventListener('click', () => {
                            try { navigator.clipboard.writeText(entry.path); } catch (e) {}
                        });
                        fragment.appendChild(row);
                    }
                    semanticListEl.appendChild(fragment);
                    semanticListEl.classList.remove('hidden');
                }
            }
            summaryEl.textContent = formatDiffSummary(result, semanticCount, !!(pa && pb));
            deps.onTitle && deps.onTitle((result.added || result.removed)
                ? '+' + result.added + '/-' + result.removed
                : '内容相同');
        } catch (e) {
            summaryEl.textContent = '比较失败：' + ((e && e.message) || e);
            renderDiffText('');
        } finally {
            running = false;
        }
    }

    function mount() {
        buildSkeleton();
        run();
    }

    return {mount, run};
}
