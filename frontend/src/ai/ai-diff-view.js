// ai-diff-view.js：行级 diff 纯函数域——LCS 行 diff、± 统计、审批卡预览裁剪。
// 方案 V4 从 ai-panel.js 逐字搬移（docs/unfinished-plans/side-chat-tab.md §7.3）；
// 写审批卡的「放弃 / 应用」外壳在 ai-takeover.js，消费这里产出的 ops / stats / preview。
// 上限常量沿用 ai-constants.js 的单一来源（AI_DIFF_MAX_LINES / AI_DIFF_PREVIEW_LIMIT）。
import {aiTextOf, AI_DIFF_MAX_LINES, AI_DIFF_PREVIEW_LIMIT} from './ai-constants.js';

export function diffLinesOf(text) {
    const normalized = aiTextOf(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!normalized) return [];
    const lines = normalized.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
}

export function computeLineDiff(oldText, newText) {
    const a = diffLinesOf(oldText);
    const b = diffLinesOf(newText);
    const ops = [];
    if (a.length + b.length > AI_DIFF_MAX_LINES || a.length * b.length > 4000000) {
        let start = 0;
        while (start < a.length && start < b.length && a[start] === b[start]) start++;
        let endA = a.length;
        let endB = b.length;
        while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
            endA--;
            endB--;
        }
        for (let i = 0; i < start; i++) ops.push({t: ' ', text: a[i]});
        for (let i = start; i < endA; i++) ops.push({t: '-', text: a[i]});
        for (let j = start; j < endB; j++) ops.push({t: '+', text: b[j]});
        for (let i = endA; i < a.length; i++) ops.push({t: ' ', text: a[i]});
        return ops;
    }
    const n = a.length;
    const m = b.length;
    const dp = new Array(n + 1);
    for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j]
                ? dp[i + 1][j + 1] + 1
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            ops.push({t: ' ', text: a[i]});
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            ops.push({t: '-', text: a[i]});
            i++;
        } else {
            ops.push({t: '+', text: b[j]});
            j++;
        }
    }
    while (i < n) ops.push({t: '-', text: a[i++]});
    while (j < m) ops.push({t: '+', text: b[j++]});
    return ops;
}

export function diffStats(ops) {
    let added = 0;
    let removed = 0;
    for (const op of ops) {
        if (op.t === '+') added++;
        else if (op.t === '-') removed++;
    }
    return {added, removed};
}

export function buildDiffPreview(ops) {
    const keep = new Array(ops.length).fill(false);
    let changed = false;
    for (let i = 0; i < ops.length; i++) {
        if (ops[i].t === ' ') continue;
        changed = true;
        for (let k = Math.max(0, i - 2); k <= Math.min(ops.length - 1, i + 2); k++) keep[k] = true;
    }
    if (!changed && ops.length) keep[0] = true;
    const lines = [];
    let last = -1;
    let truncated = false;
    for (let i = 0; i < ops.length; i++) {
        if (!keep[i]) continue;
        if (last >= 0 && i > last + 1) {
            if (lines.length >= AI_DIFF_PREVIEW_LIMIT) {
                truncated = true;
                break;
            }
            lines.push({t: '…', text: ''});
        }
        if (lines.length >= AI_DIFF_PREVIEW_LIMIT) {
            truncated = true;
            break;
        }
        lines.push({t: ops[i].t, text: ops[i].text});
        last = i;
    }
    return {lines, truncated};
}
