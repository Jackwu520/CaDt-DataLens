// ai-session-scope.js：会话归属哪个工作区的判定（纯函数，无副作用）。
//
// 背景：ai-config.json 里的 activeSessionId 是全局的（多窗口共享同一份配置），AI 面板启动
// 只校验「这个会话还在」，不校验它属于哪个工作区——新窗口打开另一个工作区时会沿用上一个
// 工作区那个会话，面板直接恢复成别人的对话（再经 syncWorkspaceToSession 把工作区切回去）。
// 判定放这里便于单测；绑定 / 切换 / 建空会话这些副作用留在 ai-panel。

import {aiTextOf} from './ai-constants.js';

// 与 Go 侧 normalizeWorkspacePath（internal/sessionstore/sessionstore.go）语义一致：
// 反斜杠归一为正斜杠、叠斜杠与 . / .. 段清理、协议或盘符前缀保留。
// 从 ai-panel.js 移出：ai-panel 35 处引用经 import 别名沿用原名，会话工作区归一
// 的哈希向量测试两端各锁一遍（frontend/test/ai/ai-session-scope.test.mjs ↔
// internal/sessionstore/sessionstore_test.go 的 TestWorkspaceBucketKeyVectors）。
export function normalizePath(value) {
    const raw = aiTextOf(value).replace(/\\/g, '/');
    if (!raw) return '';
    const scheme = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
    let prefix = '';
    let rest = raw;
    if (scheme) {
        prefix = scheme[1] + '://';
        rest = raw.slice(scheme[0].length);
    } else {
        const drive = raw.match(/^[A-Za-z]:/);
        if (drive) {
            prefix = drive[0];
            rest = raw.slice(2);
        }
    }
    const absolute = rest.startsWith('/');
    const parts = [];
    for (const segment of rest.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            if (parts.length) parts.pop();
            continue;
        }
        parts.push(segment);
    }
    return prefix + (absolute ? '/' : '') + parts.join('/');
}

// 会话工作区归一 key：去首尾空白 → 归一路径 → 去尾斜杠 → 小写（Windows 盘符大小写
// 不敏感）。Go 侧分桶哈希 WorkspaceBucketKey 以同一语义的 key 为输入（trim 在 key 这层，
// 不进 normalizePath——路径工具保持原语义）。
export function workspaceKey(value) {
    return normalizePath(aiTextOf(value).trim()).replace(/\/+$/, '').toLowerCase();
}

// 能成为「面板当前会话」的候选：未归档、非支线（支线有独立标签页承载）。
function isCandidate(session) {
    if (!session || session.archivedAt) return false;
    if (String(session.sideOf || '').trim()) return false;
    return true;
}

// 本工作区里最近更新的会话；没有返回 null。keyOf 把会话映射成归一化工作区 key。
export function pickWorkspaceSession(list, ownKey, keyOf, excludeId) {
    if (!ownKey) return null;
    let best = null;
    let bestAt = -1;
    for (const session of Array.isArray(list) ? list : []) {
        if (!isCandidate(session)) continue;
        if (excludeId && session.id === excludeId) continue;
        if (keyOf(session) !== ownKey) continue;
        const at = Number(session.updatedAt) || 0;
        if (at > bestAt) {
            best = session;
            bestAt = at;
        }
    }
    return best;
}

// 当前会话与本窗口工作区的关系 → 该做什么：
//   keep   不动（没有工作区 / 已属本工作区 / 有回合在跑）
//   bind   会话没有工作区归属（老会话）：按既有语义绑到当前工作区，不换会话
//   switch 改看本工作区最近的会话
//   create 本工作区还没有会话：新建空会话
export function decideSessionForWorkspace(current, ownKey, list, keyOf, opts = {}) {
    if (!ownKey || !current) return {action: 'keep'};
    // 正在生成 / 压缩的会话不能换走：回合还在跑，换了就看不见它了
    if (opts.busy) return {action: 'keep'};
    const currentKey = keyOf(current) || '';
    if (currentKey === ownKey) return {action: 'keep'};
    if (!currentKey) return {action: 'bind'};
    const next = pickWorkspaceSession(list, ownKey, keyOf, current.id);
    return next ? {action: 'switch', session: next} : {action: 'create'};
}
