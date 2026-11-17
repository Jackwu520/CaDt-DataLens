// git-graph.js：底部面板「Git 图谱」视图的域模块（factory + 显式依赖注入）。
// 泳道拓扑由 Go 侧算好（GitGraphCommit.lane / throughLanes），这里只负责渲染 SVG、
// 提交列表虚拟滚动、ref 树过滤与详情面板操作（签出 / cherry-pick / 重置）。
// 写操作是用户主动 UI 动作：走只读锁 + 确认弹窗，不涉 AI 审批链。
import {iconSvg} from '../core/icons.js';
import {createInput} from '../core/form-controls.js';

const ROW_H = 26;        // 提交行高（px）
const LANE_W = 16;       // 每条泳道宽（px）
const LANE_PAD = 8;      // 泳道区左右留白
const DEFAULT_LIMIT = 500;

// 泳道配色：按 lane index 循环取主题色板（CSS 变量在 style.css 定义）
const LANE_COLORS = [
    'var(--gg-lane-0)', 'var(--gg-lane-1)', 'var(--gg-lane-2)', 'var(--gg-lane-3)',
    'var(--gg-lane-4)', 'var(--gg-lane-5)', 'var(--gg-lane-6)', 'var(--gg-lane-7)',
];
function laneColor(lane) {
    return LANE_COLORS[lane % LANE_COLORS.length];
}

// ===== 泳道 SVG 几何（纯函数，可单测） =====

// laneCenterX 返回第 lane 条泳道圆点的 x 坐标。
export function laneCenterX(lane) {
    return LANE_PAD + lane * LANE_W + LANE_W / 2;
}

// laneSvgWidth 返回容纳 laneCount 条泳道的 SVG 宽度。
export function laneSvgWidth(laneCount) {
    return LANE_PAD * 2 + Math.max(1, laneCount) * LANE_W;
}

// buildLaneSvg 渲染一页提交的泳道 SVG（新→旧，行 i 的 y 中心 = i*ROW_H + ROW_H/2）。
// 规则：
//   - 每行画一个圆点（当前提交所在 lane）。
//   - 每行的 lane 与 throughLanes 画竖线贯穿该行（从行顶到行底）。
//   - 父分支拐点：父 lane ≠ 当前行 lane 时，从当前行底部画弧线跨到父 lane（连到下一行顶）。
// 返回 <svg> 的 innerHTML 字符串（不含 <svg> 壳）。
export function buildLaneSvg(commits, laneCount) {
    const width = laneSvgWidth(laneCount);
    const height = commits.length * ROW_H;
    const parts = [];
    const line = (d, color, cls) => parts.push(`<path d="${d}" class="${cls}" stroke="${color}"/>`);

    for (let i = 0; i < commits.length; i++) {
        const c = commits[i];
        const yTop = i * ROW_H;
        const yMid = yTop + ROW_H / 2;
        const yBot = yTop + ROW_H;
        const cx = laneCenterX(c.lane);
        const color = laneColor(c.lane);

        // 竖线：本行 lane + 穿线泳道，各画一条贯穿线
        const lanesHere = new Set(c.throughLanes || []);
        lanesHere.add(c.lane);
        for (const l of lanesHere) {
            const lx = laneCenterX(l);
            line(`M${lx},${yTop} L${lx},${yBot}`, laneColor(l), 'gg-line');
        }

        // 父分支拐点：父 lane 与本行 lane 不同时画弧线（本行底 → 下一行顶）
        const next = commits[i + 1];
        if (next) {
            const drawnLanes = new Set();
            for (const p of (c.parents || [])) {
                const pi = next.sha === p ? i + 1 : -1;
                if (pi < 0) continue; // 父不在下一行（页边界或更远），不画拐点
                const px = laneCenterX(next.lane);
                if (px === cx || drawnLanes.has(px)) continue;
                drawnLanes.add(px);
                const midY = (yBot + (pi * ROW_H)) / 2;
                line(`M${cx},${yBot} C${cx},${midY} ${px},${midY} ${px},${pi * ROW_H}`, color, 'gg-curve');
            }
        }

        // 圆点
        parts.push(`<circle cx="${cx}" cy="${yMid}" r="4" class="gg-dot" fill="${color}"/>`);
    }
    return `<svg class="gg-lane-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">${parts.join('')}</svg>`;
}

// ===== 域模块 =====

export function createGitGraph(ctx) {
    const state = {
        refs: null,
        commits: [],
        laneCount: 0,
        hasMore: false,
        nextSkip: 0,
        loading: false,
        currentRef: '',       // 空串 = 当前 HEAD
        selectedSha: '',
        expandedGroups: {local: true, remote: false, tags: false, worktrees: false},
        initialized: false,
    };

    let els = null; // {root, refTree, commitList, laneCol, detail, hint, filterInput}

    // ---- 初始化 DOM ----
    function ensureEls() {
        if (els) return els;
        const root = document.getElementById('git-graph-view');
        if (!root) return null;
        root.innerHTML = '';
        root.classList.add('gg-root');

        // 顶栏：过滤 + 刷新 + 回到 HEAD
        const head = document.createElement('div');
        head.className = 'gg-head';
        const filterInput = createInput({
            className: 'gg-filter',
            placeholder: '过滤提交（文本或哈希）…',
            spellcheck: false,
            autocomplete: 'off',
            onInput: () => { filteredCache = null; renderCommitList(true); },
        }).element;
        const headActions = document.createElement('div');
        headActions.className = 'gg-head-actions';
        const backToHead = mkIconBtn('back', '回到当前分支', () => loadCommits(''));
        const refreshBtn = mkIconBtn('refresh', '刷新图谱', () => reload());
        const closeBtn = mkIconBtn('close', '关闭面板', () => ctx.toggleTerminalPanel(false));
        headActions.append(backToHead, refreshBtn, closeBtn);
        head.append(filterInput, headActions);

        // 主体：ref 树 | 提交列表 | 详情
        const body = document.createElement('div');
        body.className = 'gg-body';
        const refTree = document.createElement('div');
        refTree.className = 'gg-refs';
        const commitWrap = document.createElement('div');
        commitWrap.className = 'gg-commits';
        const laneCol = document.createElement('div');
        laneCol.className = 'gg-lane-col';
        const listCol = document.createElement('div');
        listCol.className = 'gg-list-col';
        commitWrap.append(laneCol, listCol);
        const detail = document.createElement('div');
        detail.className = 'gg-detail';
        body.append(refTree, commitWrap, detail);

        const hint = document.createElement('div');
        hint.className = 'gg-hint hidden';

        root.append(head, body, hint);

        commitWrap.addEventListener('scroll', onScroll);

        els = {root, refTree, commitList: listCol, laneCol, commitWrap, detail, hint, filterInput};
        return els;
    }

    function mkIconBtn(icon, tip, onClick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'gg-btn';
        b.dataset.tip = tip;
        b.setAttribute('aria-label', tip);
        b.innerHTML = iconSvg(icon, 14);
        b.addEventListener('click', onClick);
        return b;
    }

    // ---- 数据加载 ----
    function gitDir() {
        return ctx.gitStateCache.dir || ctx.workspaceFolder || '';
    }

    async function loadRefs() {
        if (!ctx.backend.GitGraphRefs) return;
        const dir = gitDir();
        if (!dir) return;
        try {
            state.refs = await ctx.backend.GitGraphRefs(dir);
        } catch (e) {
            state.refs = null;
        }
        renderRefTree();
    }

    async function loadCommits(ref, skip = 0) {
        if (!ctx.backend.GitGraphCommits) return;
        const dir = gitDir();
        if (!dir) {
            showHint('请先打开一个 git 仓库');
            return;
        }
        if (state.loading) return;
        state.loading = true;
        hideHint();
        try {
            const page = await ctx.backend.GitGraphCommits(dir, ref || '', DEFAULT_LIMIT, skip);
            if (!page || !page.available) {
                showHint(page && page.reason ? page.reason : '无法读取提交历史');
                state.loading = false;
                return;
            }
            if (skip === 0) {
                state.commits = page.commits;
                state.laneCount = page.laneCount;
                state.currentRef = ref || '';
            } else {
                state.commits = state.commits.concat(page.commits);
                state.laneCount = Math.max(state.laneCount, page.laneCount);
            }
            state.hasMore = page.hasMore;
            state.nextSkip = page.nextSkip;
            state.initialized = true;
            filteredCache = null; // 数据变了，清过滤缓存
            renderCommitList(true);
        } catch (e) {
            showHint('读取提交历史失败：' + e);
        }
        state.loading = false;
    }

    async function reload() {
        await Promise.all([loadRefs(), loadCommits(state.currentRef, 0)]);
    }

    // 首次切到该视图时调用（懒加载）
    async function show() {
        const e = ensureEls();
        if (!e) return;
        if (!state.initialized) await reload();
    }

    // ---- 渲染：ref 树 ----
    function renderRefTree() {
        if (!els || !els.refTree) return;
        const tree = els.refTree;
        tree.innerHTML = '';
        const refs = state.refs;
        if (!refs || !refs.available) {
            const empty = document.createElement('div');
            empty.className = 'gg-refs-empty';
            empty.textContent = (refs && refs.reason) || '不在 git 仓库内';
            tree.appendChild(empty);
            return;
        }
        // HEAD / 当前分支
        if (refs.current || refs.headSha) {
            const headGroup = document.createElement('div');
            headGroup.className = 'gg-ref-group';
            const headRow = mkRefRow({
                name: refs.current || 'HEAD（detached）',
                sha: refs.headSha,
                current: true,
            }, 'HEAD');
            headGroup.appendChild(headRow);
            tree.appendChild(headGroup);
        }
        // 分组：本地 / 远程 / 标签 / worktree
        addRefGroup(tree, 'local', '本地分支', refs.local, false);
        addRefGroup(tree, 'remote', '远程分支', refs.remote, true);
        addRefGroup(tree, 'tags', '标签', refs.tags, false);
        addRefGroup(tree, 'worktrees', 'Worktree', refs.worktrees, true);
    }

    function addRefGroup(tree, key, title, items, collapsedDefault) {
        if (!items || !items.length) return;
        if (!(key in state.expandedGroups)) state.expandedGroups[key] = !collapsedDefault;
        const group = document.createElement('div');
        group.className = 'gg-ref-group';
        const head = document.createElement('div');
        head.className = 'gg-ref-group-head';
        const chev = document.createElement('button');
        chev.type = 'button';
        chev.className = 'gg-chev';
        chev.setAttribute('aria-label', title + '（展开或收起）');
        chev.setAttribute('aria-expanded', String(state.expandedGroups[key]));
        chev.innerHTML = iconSvg(state.expandedGroups[key] ? 'chevron-down' : 'chevron-right', 12);
        const label = document.createElement('span');
        label.className = 'gg-ref-group-title';
        label.textContent = title + '（' + items.length + '）';
        head.append(chev, label);
        group.appendChild(head);
        if (state.expandedGroups[key]) {
            for (const r of items) group.appendChild(mkRefRow(r, r.name));
        }
        head.addEventListener('click', () => {
            state.expandedGroups[key] = !state.expandedGroups[key];
            renderRefTree();
        });
        tree.appendChild(group);
    }

    function mkRefRow(ref, displayName) {
        const row = document.createElement('div');
        row.className = 'gg-ref-row' + (ref.current ? ' current' : '');
        const name = document.createElement('span');
        name.className = 'gg-ref-name';
        name.textContent = displayName;
        row.appendChild(name);
        if (ref.worktree) {
            const wt = document.createElement('span');
            wt.className = 'gg-ref-wt';
            wt.textContent = ref.worktree;
            row.appendChild(wt);
        }
        row.addEventListener('click', () => {
            // 点 ref = 过滤到该分支（标签/提交则定位）
            const target = ref.worktree ? ref.name : ref.name;
            loadCommits(target);
        });
        return row;
    }

    // ---- 渲染：提交列表（虚拟滚动） ----
    // 缓存上次渲染的可见区与过滤结果，滚动时只在可见区变化时才重建 DOM
    let lastRange = {start: -1, end: -1};
    let lastFilter = '';
    let filteredCache = null;

    function visibleRange() {
        const wrap = els.commitWrap;
        const total = (filteredCache || state.commits).length;
        if (!wrap || total === 0) return {start: 0, end: 0, padTop: 0, padBottom: 0};
        const scrollTop = wrap.scrollTop;
        const viewH = wrap.clientHeight || 400;
        const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
        const end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + 10);
        return {start, end, padTop: start * ROW_H, padBottom: (total - end) * ROW_H};
    }

    function filterCommits() {
        const q = (els.filterInput.value || '').trim().toLowerCase();
        if (q === lastFilter && filteredCache) return filteredCache;
        lastFilter = q;
        if (!q) {
            filteredCache = state.commits;
        } else {
            filteredCache = state.commits.filter((c) =>
                (c.subject || '').toLowerCase().includes(q) ||
                (c.sha || '').toLowerCase().includes(q) ||
                (c.author || '').toLowerCase().includes(q)
            );
        }
        return filteredCache;
    }

    function renderCommitList(force) {
        if (!els || !els.commitList) return;
        const list = els.commitList;
        const laneCol = els.laneCol;
        const commits = filterCommits();
        if (!commits.length) {
            lastRange = {start: -1, end: -1};
            list.innerHTML = '';
            laneCol.innerHTML = '';
            if (state.initialized) showHint('没有匹配的提交');
            return;
        }
        hideHint();

        const {start, end, padTop, padBottom} = visibleRange();
        // 可见区没变且非强制刷新：跳过重建（滚动时大部分帧都命中这里，避免疯狂重建 DOM）
        if (!force && start === lastRange.start && end === lastRange.end) return;
        lastRange = {start, end};

        // 保存 scrollTop（重建 DOM 会重置）
        const savedScrollTop = els.commitWrap.scrollTop;
        list.innerHTML = '';
        laneCol.innerHTML = '';
        const slice = commits.slice(start, end);

        // spacer 维持滚动条高度
        if (padTop > 0) {
            const top = document.createElement('div');
            top.style.height = padTop + 'px';
            list.appendChild(top);
        }
        for (let i = start; i < end; i++) {
            const c = commits[i];
            list.appendChild(mkCommitRow(c, i));
        }
        if (padBottom > 0) {
            const bot = document.createElement('div');
            bot.style.height = padBottom + 'px';
            list.appendChild(bot);
        }

        // 恢复 scrollTop（虚拟滚动重建后必须恢复，否则滚动条会被拉回顶部）
        els.commitWrap.scrollTop = savedScrollTop;

        // 泳道 SVG（按过滤后的切片渲染，行号对齐 slice）
        // 注意：过滤会打乱 lane 连续性——过滤时泳道不准，只在无过滤时画泳道。
        const q = (els.filterInput.value || '').trim();
        if (!q) {
            laneCol.innerHTML = buildLaneSvg(slice, state.laneCount);
            laneCol.style.paddingTop = padTop + 'px';
            // 同步泳道列宽度到 CSS 变量，让文字列的 padding-left 匹配
            const laneWidth = laneSvgWidth(state.laneCount);
            els.commitWrap.style.setProperty('--gg-lane-col-w', laneWidth + 'px');
        } else {
            laneCol.innerHTML = '';
        }

        // 加载更多提示
        if (state.hasMore && !q) {
            const more = document.createElement('div');
            more.className = 'gg-load-more';
            more.textContent = state.loading ? '加载中…' : '滚动加载更多';
            list.appendChild(more);
        }
    }

    function mkCommitRow(c, idx) {
        const row = document.createElement('div');
        row.className = 'gg-row' + (c.sha === state.selectedSha ? ' selected' : '');
        row.style.height = ROW_H + 'px';

        const msg = document.createElement('span');
        msg.className = 'gg-msg';
        msg.textContent = c.subject || '(无消息)';

        const refs = document.createElement('span');
        refs.className = 'gg-refs-deco';
        refs.textContent = c.refs || '';

        const author = document.createElement('span');
        author.className = 'gg-author';
        author.textContent = c.author || '';

        const date = document.createElement('span');
        date.className = 'gg-date';
        date.textContent = c.date || '';

        row.append(msg, refs, author, date);
        row.addEventListener('click', () => selectCommit(c.sha));
        row.addEventListener('dblclick', () => selectCommit(c.sha));
        return row;
    }

    function onScroll() {
        if (!els) return;
        const wrap = els.commitWrap;
        const nearBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - ROW_H * 5;
        const q = (els.filterInput.value || '').trim();
        if (nearBottom && state.hasMore && !state.loading && !q) {
            loadCommits(state.currentRef, state.nextSkip);
        } else {
            renderCommitList();
        }
    }

    // ---- 详情面板 ----
    function selectCommit(sha) {
        state.selectedSha = sha;
        renderCommitList(true); // 选中高亮变了，强制刷新
        renderDetail();
    }

    function findCommit(sha) {
        return state.commits.find((c) => c.sha === sha) || null;
    }

    function renderDetail() {
        if (!els || !els.detail) return;
        const d = els.detail;
        d.innerHTML = '';
        const c = findCommit(state.selectedSha);
        if (!c) {
            const empty = document.createElement('div');
            empty.className = 'gg-detail-empty';
            empty.textContent = '选择一个提交查看详情';
            d.appendChild(empty);
            return;
        }

        // 完整提交消息（JetBrains 式：消息正文占据详情主视觉，不截断）
        const msg = document.createElement('div');
        msg.className = 'gg-detail-msg';
        msg.textContent = c.subject || '(无消息)';

        // 关闭按钮浮在详情右上角
        const closeBtn = mkIconBtn('close', '关闭详情', () => {
            state.selectedSha = '';
            renderCommitList(true);
            renderDetail();
        });
        closeBtn.classList.add('gg-detail-close');

        // 作者信息行：头像色块 + sha + 作者 <邮箱>, 日期
        const authorRow = document.createElement('div');
        authorRow.className = 'gg-detail-author';
        const avatar = document.createElement('span');
        avatar.className = 'gg-avatar';
        avatar.style.background = avatarColor(c.email || c.author || '');
        const authorText = document.createElement('span');
        authorText.className = 'gg-author-text';
        authorText.textContent = (c.sha || '').slice(0, 7) + ' 作者 ' + (c.author || '') +
            (c.email ? ' <' + c.email + '>, ' : '') + (c.date || '');
        authorRow.append(avatar, authorText);

        // 分支信息行：该提交在哪些分支上（从 refs 装饰器解析）
        const branchRow = mkBranchRow(c);

        // 操作按钮
        const actions = document.createElement('div');
        actions.className = 'gg-detail-actions';
        actions.appendChild(mkActionBtn('签出', () => doCheckout(c)));
        actions.appendChild(mkActionBtn('Cherry-Pick', () => doCherryPick(c)));
        const resetGroup = document.createElement('div');
        resetGroup.className = 'gg-reset-group';
        resetGroup.appendChild(mkActionBtn('重置 soft', () => doReset(c, 'soft')));
        resetGroup.appendChild(mkActionBtn('mixed', () => doReset(c, 'mixed')));
        resetGroup.appendChild(mkActionBtn('hard', () => doReset(c, 'hard'), 'danger'));
        actions.appendChild(resetGroup);

        d.append(closeBtn, msg, authorRow, branchRow, actions);
    }

    // avatarColor 由邮箱/作者名派生一个稳定的头像底色（JetBrains 式彩色首字母块）
    function avatarColor(seed) {
        let h = 0;
        for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
        const hue = h % 360;
        return 'hsl(' + hue + ' 45% 45%)';
    }

    // mkBranchRow 从 refs 装饰器（%D）解析该提交所在的分支，展示「在 N 个分支中: ...」
    function mkBranchRow(c) {
        const row = document.createElement('div');
        row.className = 'gg-detail-branch';
        const refs = (c.refs || '').trim();
        if (!refs) {
            row.textContent = '不在任何分支上（游离提交）';
            return row;
        }
        // %D 形如 "HEAD -> master, origin/master, tag: v1.0" —— 拆成列表展示
        const names = refs.split(',').map((s) => s.trim()).filter(Boolean);
        const label = document.createElement('span');
        label.textContent = '在 ' + names.length + ' 个引用中: ';
        const list = document.createElement('span');
        list.className = 'gg-branch-list';
        list.textContent = names.join(', ');
        row.append(label, list);
        row.title = names.join(', ');
        return row;
    }

    function mkActionBtn(label, onClick, variant) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'gg-action-btn' + (variant === 'danger' ? ' danger' : '');
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
    }

    // ---- 写操作（只读锁 + 确认） ----
    function readOnlyBlocked() {
        if (ctx.settings && ctx.settings.readOnlyMode) {
            ctx.flash('当前处于只读模式，无法执行 git 操作', true);
            return true;
        }
        return false;
    }

    async function doCheckout(c) {
        if (readOnlyBlocked()) return;
        const ref = state.refs && state.refs.current === c.sha ? c.sha : c.sha;
        const detached = !(state.refs && state.refs.local.some((r) => r.sha === c.sha));
        const msg = detached
            ? `签出到提交 ${c.sha.slice(0, 7)} 会进入 detached HEAD（不在任何分支上）。继续？`
            : `签出到 ${c.sha.slice(0, 7)}？`;
        ctx.openConfirmDialog(msg, async () => {
            try {
                const res = await ctx.backend.GitGraphCheckout(gitDir(), ref);
                if (res && res.success) {
                    ctx.flash('已签出 ' + (res.branch || c.sha.slice(0, 7)));
                    await reload();
                    if (ctx.refreshGitStatus) ctx.refreshGitStatus();
                } else {
                    ctx.flash('签出失败：' + ((res && res.output) || '未知错误'), true);
                }
            } catch (e) {
                ctx.flash('签出失败：' + e, true);
            }
        }, '签出', '签出提交', detached ? 'danger' : undefined);
    }

    async function doCherryPick(c) {
        if (readOnlyBlocked()) return;
        ctx.openConfirmDialog(
            `把提交 ${c.sha.slice(0, 7)}（${c.subject || ''}）摘到当前分支？冲突时会停在冲突状态。`,
            async () => {
                try {
                    const res = await ctx.backend.GitGraphCherryPick(gitDir(), c.sha);
                    if (res && res.success) {
                        ctx.flash('已 cherry-pick ' + c.sha.slice(0, 7));
                        await reload();
                        if (ctx.refreshGitStatus) ctx.refreshGitStatus();
                    } else {
                        ctx.flash('cherry-pick 失败：' + ((res && res.output) || '可能有冲突'), true);
                    }
                } catch (e) {
                    ctx.flash('cherry-pick 失败：' + e, true);
                }
            }, 'Cherry-Pick', 'Cherry-Pick 提交');
    }

    async function doReset(c, mode) {
        if (readOnlyBlocked()) return;
        const warn = mode === 'hard'
            ? `重置（hard）到 ${c.sha.slice(0, 7)} 会丢弃当前分支之后的所有提交与未提交改动，不可恢复。确定？`
            : `把当前分支重置（${mode}）到 ${c.sha.slice(0, 7)}？`;
        ctx.openConfirmDialog(warn, async () => {
            try {
                const res = await ctx.backend.GitGraphReset(gitDir(), c.sha, mode);
                if (res && res.success) {
                    ctx.flash('已重置（' + mode + '）到 ' + c.sha.slice(0, 7));
                    await reload();
                    if (ctx.refreshGitStatus) ctx.refreshGitStatus();
                } else {
                    ctx.flash('重置失败：' + ((res && res.output) || '未知错误'), true);
                }
            } catch (e) {
                ctx.flash('重置失败：' + e, true);
            }
        }, '重置', '重置分支', mode === 'hard' ? 'danger' : undefined);
    }

    // ---- 提示 ----
    function showHint(msg) {
        if (!els || !els.hint) return;
        els.hint.textContent = msg;
        els.hint.classList.remove('hidden');
    }
    function hideHint() {
        if (els && els.hint) els.hint.classList.add('hidden');
    }

    return {
        show, reload, loadCommits,
        get state() { return state; },
    };
}
