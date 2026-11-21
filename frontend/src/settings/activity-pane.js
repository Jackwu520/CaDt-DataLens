// activity-pane.js：操作记录页（docs/unfinished-plans/operation-audit-log.md §6.4）。
//
// 宿主：2026-11-22 起本页是「应用页面」标签页（core/app-pages.js 的 activity），
// 由 mount(host) 建骨架并绑定；设置页原内嵌位置已移除，只留两个真·设置项
// （启用开关 / 保留月数）供 settings-tree 反射。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。

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

const activityView = {entries: [], truncated: false, oldestTs: 0, loading: false};
const ACTIVITY_PAGE_SIZE = 200;

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
        const empty = document.createElement('div');
        empty.className = 'activity-empty';
        empty.textContent = '当前版本不支持操作记录（旧版后端）';
        listEl.appendChild(empty);
        return;
    }
    activityView.loading = true;
    try {
        const query = {limit: ACTIVITY_PAGE_SIZE, ...activityFilterOf()};
        if (opts.append && activityView.oldestTs > 0) query.beforeTs = activityView.oldestTs;
        const parsed = JSON.parse(await deps.backend.ActivityRead(JSON.stringify(query)));
        const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
        activityView.entries = opts.append ? activityView.entries.concat(entries) : entries;
        activityView.truncated = !!parsed.truncated;
        const last = activityView.entries[activityView.entries.length - 1];
        activityView.oldestTs = last && last.ts ? last.ts : 0;
        renderActivityList(listEl);
        if (statusEl) {
            statusEl.textContent = activityView.entries.length
                ? '已加载 ' + activityView.entries.length + ' 条（新→旧）' + (activityView.truncated ? '；可能还有更早记录' : '')
                : '暂无记录（功能未开启或近期没有操作）';
        }
        if (moreBtn) moreBtn.classList.toggle('hidden', !activityView.entries.length || !activityView.truncated);
    } catch (e) {
        if (statusEl) statusEl.textContent = '读取失败：' + ((e && e.message) || e);
    } finally {
        activityView.loading = false;
    }
}

const ACTIVITY_ACTOR_LABEL = {user: '用户', ai: 'AI', system: '系统'};

function activityTimeText(ts) {
    const d = new Date(ts || 0);
    if (!d.getTime()) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function renderActivityList(listEl) {
    listEl.textContent = '';
    if (!activityView.entries.length) {
        const empty = document.createElement('div');
        empty.className = 'activity-empty';
        empty.textContent = '暂无记录';
        listEl.appendChild(empty);
        return;
    }
    const frag = document.createDocumentFragment();
    for (const entry of activityView.entries) {
        frag.appendChild(buildActivityRow(entry));
    }
    listEl.appendChild(frag);
}

function buildActivityRow(entry) {
    const row = document.createElement('div');
    row.className = 'activity-row';

    const time = document.createElement('span');
    time.className = 'act-time';
    time.textContent = activityTimeText(entry.ts);

    const badge = document.createElement('span');
    badge.className = 'act-badge act-badge-' + (ACTIVITY_ACTOR_LABEL[entry.actor] ? entry.actor : 'system');
    badge.textContent = ACTIVITY_ACTOR_LABEL[entry.actor] || '系统';

    const action = document.createElement('span');
    action.className = 'act-action';
    action.textContent = entry.action || '?';

    const target = document.createElement('span');
    target.className = 'act-target';
    target.textContent = entry.target || '';

    row.append(time, badge, action, target);

    const detailText = entry.detail && Object.keys(entry.detail).length ? JSON.stringify(entry.detail) : '';
    if (detailText) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'act-detail-btn dlg-btn';
        toggle.textContent = '详情';
        const detail = document.createElement('div');
        detail.className = 'act-detail hidden';
        detail.textContent = detailText;
        toggle.addEventListener('click', () => {
            detail.classList.toggle('hidden');
            toggle.textContent = detail.classList.contains('hidden') ? '详情' : '收起';
        });
        row.appendChild(toggle);
        row.appendChild(detail);
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
    host.innerHTML = activitySkeleton();
    hostEl = host;
    const bind = (id, event, handler) => {
        const el = host.querySelector('#' + id);
        if (!el) return null;
        el.addEventListener(event, handler);
        return () => el.removeEventListener(event, handler);
    };
    const offs = [
        bind('activity-filter-domain', 'change', () => renderActivityPane()),
        bind('activity-filter-actor', 'change', () => renderActivityPane()),
        bind('activity-filter-keyword', 'keydown', (e) => { if (e.key === 'Enter') renderActivityPane(); }),
        bind('activity-refresh', 'click', () => renderActivityPane()),
        bind('activity-more', 'click', () => renderActivityPane({append: true})),
        bind('opt-open-activity', 'click', openActivityDir),
        bind('opt-export-activity-json', 'click', () => exportActivityRecords('json')),
        bind('opt-export-activity-csv', 'click', () => exportActivityRecords('csv')),
        bind('opt-clear-activity', 'click', clearActivity),
    ].filter(Boolean);
    renderActivityPane();
    return () => {
        for (const off of offs) off();
        hostEl = null;
        activityView.entries = [];
        activityView.oldestTs = 0;
        activityView.truncated = false;
    };
}

    return {mount, renderActivityPane};
}
