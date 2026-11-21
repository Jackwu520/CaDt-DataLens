// activity-pane.js：操作记录页（docs/unfinished-plans/operation-audit-log.md §6.4）。
//
// 宿主：2026-11-22 起本页是「应用页面」标签页（core/app-pages.js 的 activity），
// 由 mount(host) 建骨架并绑定；设置页原内嵌位置已移除，只留两个真·设置项
// （启用开关 / 保留月数）供 settings-tree 反射。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。

import {createSelect} from '../core/form-controls.js';
import {pageHeader, commandBar, stateBlock, copyButton, relativeTime, formatFullTime} from '../app-pages/ui-kit.js';

// 页面骨架：筛选栏 + 列表 + 状态 + 加载更早 + 记录管理动作。
// id 与原设置页保持一致（渲染函数按 id 在宿主内查询）。
export function activitySkeleton() {
    return `
<div class="set-group-title">记录</div>
<div class="set-card">
    <div class="set-row-top">
        <div class="activity-filters">
            <select id="activity-filter-domain" class="opt-select">
                <option value="">全部动作</option>
                <option value="file">文件</option>
                <option value="tab">标签页</option>
                <option value="workspace">工作区</option>
                <option value="view">视图</option>
                <option value="settings">设置</option>
                <option value="plugin">插件</option>
                <option value="ai">AI</option>
                <option value="app">应用</option>
                <option value="storage">存储</option>
                <option value="activity">记录管理</option>
            </select>
            <select id="activity-filter-actor" class="opt-select">
                <option value="">全部来源</option>
                <option value="user">用户</option>
                <option value="ai">AI</option>
                <option value="system">系统</option>
            </select>
            <input type="text" id="activity-filter-keyword" class="activity-filter-input" placeholder="关键字（动作 / 对象 / 详情）">
            <button type="button" id="activity-refresh" class="dlg-btn">刷新</button>
        </div>
        <div class="plugin-list-box activity-list-box">
            <div class="activity-list" id="activity-list"></div>
        </div>
        <div class="set-desc" id="activity-list-status">—</div>
        <button type="button" id="activity-more" class="dlg-btn hidden">加载更早记录</button>
    </div>
    <div class="set-row">
        <div class="set-main"><div class="set-title">记录管理</div><div class="set-desc">开关与保留月数在「设置 → 操作记录」</div></div>
        <div class="set-control">
            <button type="button" id="opt-open-activity" class="dlg-btn">打开记录目录</button>
            <button type="button" id="opt-export-activity-json" class="dlg-btn">导出 JSON</button>
            <button type="button" id="opt-export-activity-csv" class="dlg-btn">导出 CSV</button>
            <button type="button" id="opt-clear-activity" class="dlg-btn">清空…</button>
        </div>
    </div>
</div>`;
}

export function createActivityPane(deps) {

let hostEl = null;

const activityView = {entries: [], truncated: false, oldestTs: 0, oldestSeq: 0, loading: false};
const ACTIVITY_PAGE_SIZE = 200;
// 动作域 → 中文名（列表显示中文，导出仍保留原始 action）
const ACTIVITY_ACTION_LABEL = {
    file: '文件', tab: '标签页', workspace: '工作区', view: '视图',
    settings: '设置', plugin: '插件', ai: 'AI', app: '应用',
    storage: '存储', activity: '记录',
};

function node(id) {
    return hostEl ? hostEl.querySelector('#' + id) : document.getElementById(id);
}

function activityFilterOf() {
    const domain = node('activity-filter-domain');
    const actor = node('activity-filter-actor');
    const keyword = node('activity-filter-keyword');
    return {
        actions: domain && domain.value ? [domain.value] : [],
        actor: actor && actor.value ? actor.value : '',
        keyword: keyword ? keyword.value.trim() : '',
    };
}

async function renderActivityPane(opts = {}) {
    const listEl = node('activity-list');
    const statusEl = node('activity-list-status');
    const moreBtn = node('activity-more');
    if (!listEl || activityView.loading) return;
    if (!deps.backend.ActivityRead) {
        listEl.textContent = '';
        listEl.appendChild(stateBlock('info', '当前版本不支持操作记录（旧版后端）'));
        return;
    }
    activityView.loading = true;
    try {
        const query = {limit: ACTIVITY_PAGE_SIZE, ...activityFilterOf()};
        // 复合游标 ts+seq：同毫秒多条时精确切页，不重复/不漏
        if (opts.append && activityView.oldestTs > 0) {
            query.beforeTs = activityView.oldestTs;
            if (activityView.oldestSeq > 0) query.beforeSeq = activityView.oldestSeq;
        }
        const parsed = JSON.parse(await deps.backend.ActivityRead(JSON.stringify(query)));
        const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
        activityView.entries = opts.append ? activityView.entries.concat(entries) : entries;
        activityView.truncated = !!parsed.truncated;
        const last = activityView.entries[activityView.entries.length - 1];
        activityView.oldestTs = last && last.ts ? last.ts : 0;
        activityView.oldestSeq = last && last.seq ? last.seq : 0;
        renderActivityList(listEl);
        if (statusEl) {
            statusEl.textContent = activityView.entries.length
                ? '已加载 ' + activityView.entries.length + ' 条（新→旧）' + (activityView.truncated ? '；可加载更早记录' : '；已到最早')
                : '暂无记录（功能未开启或近期没有操作）';
        }
        if (moreBtn) moreBtn.classList.toggle('hidden', !activityView.entries.length || !activityView.truncated);
    } catch (e) {
        listEl.textContent = '';
        listEl.appendChild(stateBlock('error', '读取失败：' + ((e && e.message) || e)));
        if (statusEl) statusEl.textContent = '';
    } finally {
        activityView.loading = false;
    }
}

const ACTIVITY_ACTOR_LABEL = {user: '用户', ai: 'AI', system: '系统'};

function actionLabel(action) {
    const text = String(action || '');
    const domain = text.split('.')[0];
    const zh = ACTIVITY_ACTION_LABEL[domain];
    return zh ? zh + ' · ' + text.slice(domain.length + 1) : text;
}

// 格式化 detail：逐行缩进的 JSON（键值着色交给 CSS），替代裸 JSON.stringify 撑乱 flex 行。
function formatDetail(detail) {
    if (!detail || typeof detail !== 'object' || !Object.keys(detail).length) return '';
    try { return JSON.stringify(detail, null, 2); } catch (e) { return String(detail); }
}

function renderActivityList(listEl) {
    listEl.textContent = '';
    if (!activityView.entries.length) {
        listEl.appendChild(stateBlock('empty', '暂无记录（功能未开启或近期没有操作）'));
        return;
    }
    const frag = document.createDocumentFragment();
    let lastDay = '';
    for (const entry of activityView.entries) {
        const day = new Date(entry.ts || 0).toLocaleDateString();
        if (day !== lastDay) {
            lastDay = day;
            const group = document.createElement('div');
            group.className = 'act-day-group';
            group.textContent = day;
            frag.appendChild(group);
        }
        frag.appendChild(buildActivityRow(entry));
    }
    listEl.appendChild(frag);
}

function buildActivityRow(entry) {
    const row = document.createElement('div');
    row.className = 'activity-row';

    const time = document.createElement('span');
    time.className = 'act-time';
    time.textContent = relativeTime(entry.ts);
    time.dataset.tip = formatFullTime(entry.ts);

    const badge = document.createElement('span');
    badge.className = 'act-badge act-badge-' + (ACTIVITY_ACTOR_LABEL[entry.actor] ? entry.actor : 'system');
    badge.textContent = ACTIVITY_ACTOR_LABEL[entry.actor] || '系统';

    const action = document.createElement('span');
    action.className = 'act-action';
    action.textContent = actionLabel(entry.action);
    action.dataset.tip = entry.action || '';

    const target = document.createElement('span');
    target.className = 'act-target';
    target.textContent = entry.target || '';
    target.dataset.tip = entry.target || '';

    row.append(time, badge, action, target);

    const detailText = formatDetail(entry.detail);
    if (detailText) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'act-detail-btn dlg-btn';
        toggle.dataset.tip = '展开/收起详情';
        toggle.textContent = '详情';
        const detail = document.createElement('pre');
        detail.className = 'act-detail hidden';
        detail.textContent = detailText;
        toggle.addEventListener('click', () => {
            const hidden = detail.classList.toggle('hidden');
            toggle.textContent = hidden ? '详情' : '收起';
        });
        // 操作按钮包进一个格子（grid 第 5 列），否则详情钮+复制钮各占一列会挤掉对齐：
        // 无详情行只有 5 个子元素，有详情行若直接 append 两个按钮会变成 7 个，复制钮掉到下一行。
        const ops = document.createElement('span');
        ops.className = 'act-ops';
        ops.append(toggle, copyButton(() => detailText, {flash: deps.flash, tip: '复制详情'}));
        row.append(ops, detail);
    } else {
        // 无详情也占位，保持列对齐
        row.appendChild(document.createElement('span'));
    }
    return row;
}

function activityExportQuery() {
    return {limit: 500, ...activityFilterOf()};
}

function activityCsvCell(value) {
    const text = String(value == null ? '' : value);
    return '"' + text.replace(/"/g, '""') + '"';
}

async function exportActivityRecords(kind) {
    if (!deps.backend.ActivityRead) return deps.flash('当前版本不支持操作记录', true);
    if (!deps.backend.SaveFileDialog || !deps.backend.SaveFile) return deps.flash('当前版本不支持导出', true);
    try {
        const parsed = JSON.parse(await deps.backend.ActivityRead(JSON.stringify(activityExportQuery())));
        const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
        if (!entries.length) return deps.flash('没有可导出的记录（当前筛选条件下）', true);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        if (kind === 'csv') {
            const rows = [['时间', '来源', '判定来源', '动作', '对象', '详情']];
            for (const e of entries) {
                rows.push([
                    new Date(e.ts || 0).toLocaleString(),
                    ACTIVITY_ACTOR_LABEL[e.actor] || e.actor || '',
                    e.source || '',
                    e.action || '',
                    e.target || '',
                    e.detail && Object.keys(e.detail).length ? JSON.stringify(e.detail) : '',
                ]);
            }
            const csv = '\ufeff' + rows.map((row) => row.map(activityCsvCell).join(',')).join('\r\n');
            const path = await deps.backend.SaveFileDialog('activity-' + stamp + '.csv');
            if (path) await deps.backend.SaveFile(path, csv, 'crlf', true, 'utf-8');
        } else {
            const json = JSON.stringify({exportedAt: Date.now(), count: entries.length, entries}, null, 2);
            const path = await deps.backend.SaveFileDialog('activity-' + stamp + '.json');
            if (path) await deps.backend.SaveFile(path, json, 'lf', false, 'utf-8');
        }
        deps.flash('已导出 ' + entries.length + ' 条记录');
    } catch (e) {
        deps.flash('导出失败：' + ((e && e.message) || e), true);
    }
}

// 两个真·设置项留在设置页：控件在 index.html 的 .settings-pane[data-pane="activity"] 里，
// 由 settings-tree 反射成可写行（opt-activity-log / opt-activity-retention）。
if (deps.elsSettings.activityLog) {
    deps.elsSettings.activityLog.addEventListener('change', () => {
        deps.settings.activityLog = deps.elsSettings.activityLog.checked;
        deps.applySettings();
        deps.flash(deps.settings.activityLog ? '操作记录已开启' : '操作记录已关闭，不再新增记录');
    });
}
if (deps.elsSettings.activityRetention) {
    deps.elsSettings.activityRetention.addEventListener('change', () => {
        const n = Math.round(Number(deps.elsSettings.activityRetention.value) || 12);
        deps.settings.activityRetentionMonths = Math.min(60, Math.max(1, n));
        deps.applySettings();
    });
}

function openActivityDir() {
    if (!deps.backend.ActivityPath || !deps.backend.ShowInFolder) return deps.flash('当前版本不支持', true);
    Promise.resolve(deps.backend.ActivityPath()).then((dir) => deps.backend.ShowInFolder(dir))
        .catch((e) => deps.flash('打开记录目录失败：' + ((e && e.message) || e), true));
}

function clearActivity() {
    if (!deps.backend.ActivityClear) return deps.flash('当前版本不支持操作记录', true);
    deps.openConfirmDialog('将删除全部操作记录（包括按月分文件与滚动分段），只保留一条「已清空」标记。确定继续吗？', async () => {
        try {
            await deps.backend.ActivityClear();
            deps.flash('操作记录已清空');
            renderActivityPane();
        } catch (e) {
            deps.flash('清空失败：' + ((e && e.message) || e), true);
        }
    }, '清空', '清空操作记录', 'danger');
}

// 挂到宿主容器（应用页面标签页调用）：建骨架 → 按 id 在宿主内绑定 → 首次渲染。
// 返回卸载函数：摘掉监听并清空缓存，避免关标签后状态与 DOM 一起泄漏。
function mount(host) {
    if (!host) return null;
    host.textContent = '';

    // 页头：主操作区 = 去设置 / 打开目录 / 导出 JSON / 导出 CSV / 清空
    const goSettings = document.createElement('button');
    goSettings.type = 'button';
    goSettings.className = 'dlg-btn';
    goSettings.dataset.tip = '启用开关与保留月数仍在 设置 → 通用 → 操作记录';
    goSettings.textContent = '去设置';
    if (typeof deps.openActivitySettings === 'function') {
        goSettings.addEventListener('click', () => deps.openActivitySettings());
    } else {
        goSettings.classList.add('hidden');
    }
    const openDirBtn = document.createElement('button');
    openDirBtn.type = 'button';
    openDirBtn.className = 'dlg-btn';
    openDirBtn.textContent = '打开目录';
    openDirBtn.addEventListener('click', openActivityDir);
    const exportJsonBtn = document.createElement('button');
    exportJsonBtn.type = 'button';
    exportJsonBtn.className = 'dlg-btn';
    exportJsonBtn.textContent = '导出 JSON';
    exportJsonBtn.addEventListener('click', () => exportActivityRecords('json'));
    const exportCsvBtn = document.createElement('button');
    exportCsvBtn.type = 'button';
    exportCsvBtn.className = 'dlg-btn';
    exportCsvBtn.textContent = '导出 CSV';
    exportCsvBtn.addEventListener('click', () => exportActivityRecords('csv'));
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'dlg-btn';
    clearBtn.textContent = '清空…';
    clearBtn.addEventListener('click', clearActivity);
    host.appendChild(pageHeader({
        title: '操作记录',
        desc: '用户与 AI 的操作留痕（只记摘要，不记文件内容）。筛选后导出与列表同源。',
        actions: [goSettings, openDirBtn, exportJsonBtn, exportCsvBtn, clearBtn],
    }));

    // 命令栏：动作域 / 来源下拉 + 关键字搜索（防抖 200ms）+ 清空筛选
    const domainCtl = createSelect({
        id: 'activity-filter-domain',
        options: [['', '全部动作'], ['file', '文件'], ['tab', '标签页'], ['workspace', '工作区'], ['view', '视图'], ['settings', '设置'], ['plugin', '插件'], ['ai', 'AI'], ['app', '应用'], ['storage', '存储'], ['activity', '记录管理']]
            .map(([value, label]) => ({value, label})),
    }).control;
    const actorCtl = createSelect({
        id: 'activity-filter-actor',
        options: [['', '全部来源'], ['user', '用户'], ['ai', 'AI'], ['system', '系统']]
            .map(([value, label]) => ({value, label})),
    }).control;
    const clearFilterBtn = document.createElement('button');
    clearFilterBtn.type = 'button';
    clearFilterBtn.className = 'dlg-btn';
    clearFilterBtn.dataset.tip = '清除全部筛选条件';
    clearFilterBtn.textContent = '清除筛选';
    clearFilterBtn.addEventListener('click', () => {
        domainCtl.value = '';
        actorCtl.value = '';
        bar.setSearch('', true);
    });
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'dlg-btn';
    refreshBtn.textContent = '刷新';
    refreshBtn.addEventListener('click', () => renderActivityPane());
    const bar = commandBar({
        placeholder: '关键字（动作 / 对象 / 详情）',
        onSearch: () => renderActivityPane(),
        filters: [domainCtl, actorCtl, clearFilterBtn, refreshBtn],
    });
    // commandBar 自己带搜索框；给隐藏的旧 keyword input 一个 id 兼容 activityFilterOf
    bar.input.id = 'activity-filter-keyword';
    host.appendChild(bar.element);

    // 表头 + 列表 + 状态 + 加载更早
    const head = document.createElement('div');
    head.className = 'act-thead';
    for (const label of ['时间', '来源', '动作', '对象', '详情']) {
        const cell = document.createElement('span');
        cell.textContent = label;
        head.appendChild(cell);
    }
    host.appendChild(head);
    const listEl = document.createElement('div');
    listEl.className = 'activity-list';
    listEl.id = 'activity-list';
    host.appendChild(listEl);
    const statusEl = document.createElement('div');
    statusEl.className = 'act-status';
    statusEl.id = 'activity-list-status';
    host.appendChild(statusEl);
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'dlg-btn hidden';
    moreBtn.id = 'activity-more';
    moreBtn.textContent = '加载更早记录';
    moreBtn.addEventListener('click', () => renderActivityPane({append: true}));
    host.appendChild(moreBtn);

    hostEl = host;
    domainCtl.addEventListener('change', () => renderActivityPane());
    actorCtl.addEventListener('change', () => renderActivityPane());
    renderActivityPane();
    return () => {
        if (typeof bar.destroy === 'function') bar.destroy();
        hostEl = null;
        activityView.entries = [];
        activityView.oldestTs = 0;
        activityView.oldestSeq = 0;
        activityView.truncated = false;
    };
}

    return {mount, renderActivityPane};
}
