// settings-pane-patches.js：补丁库（.cadt/patches 的最近补丁 + 删除）。
// 删除走 Go 的 PatchDelete：它把 .patch / backup / manifest / meta 送回收站，并从索引里
// 摘掉该 id 的全部历史行；已应用的补丁删掉后无法再撤销，所以删除前二次确认。
//
// 宿主：2026-11-22 起本页是「应用页面」标签页（core/app-pages.js 的 patches），
// 由 mount(root) 在标签页容器里建骨架并绑定。原来的设置 → 开发者 内嵌位置已移除。

// 状态徽标：文案与色调（tone 决定 CSS class）。未知状态按「未应用」展示原文更保险，
// 但索引只会有这几种，多余的走 default 兜底。
export function patchStatusLabel(status) {
    switch (status) {
        case 'applied': return {text: '已应用', tone: 'ok'};
        case 'partial': return {text: '部分应用', tone: 'warn'};
        case 'applying': return {text: '应用中', tone: 'warn'};
        case 'failed': return {text: '应用中断', tone: 'error'};
        case 'reverted': return {text: '已撤销', tone: 'muted'};
        default: return {text: '未应用', tone: 'muted'};
    }
}

// 行标题：摘要 + 文件数 + 增删统计（纯函数，便于测试）。
export function patchRowTitle(meta) {
    const m = meta || {};
    const files = Array.isArray(m.files) ? m.files.length : 0;
    const parts = [String(m.summary || '补丁')];
    if (files) parts.push(files + ' 个文件');
    parts.push('+' + (Number(m.added) || 0) + ' −' + (Number(m.removed) || 0));
    return parts.join(' · ');
}

// 删除确认文案：已应用的补丁必须点明「无法撤销」。
export function patchDeleteConfirmText(meta) {
    const m = meta || {};
    const base = '将删除补丁「' + String(m.summary || m.id || '') + '」及其补丁文件、备份与元数据（进回收站）。';
    if (m.status === 'applied' || m.status === 'partial') {
        return base + '它已经应用过，删除后无法再撤销，只能手工还原改动的文件。确定继续吗？';
    }
    return base + '确定继续吗？';
}

function patchTimeText(ms) {
    const d = new Date(Number(ms) * 1000 || 0);
    if (!d.getTime()) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 页面骨架：标签页宿主里由 mount() 注入（id 保持不变，纯渲染函数照常按 id 查询）。
export function patchStoreSkeleton() {
    return `
<div class="set-group-title">补丁库</div>
<div class="set-card">
    <div class="set-row">
        <div class="set-main">
            <div class="set-title">最近补丁<button type="button" class="info-tip" data-tip="AI 提交过的补丁（.cadt/patches）。删除会把补丁文件、备份与元数据送进回收站；已应用的补丁删除后无法再撤销。" aria-label="补丁库说明"></button></div>
            <div class="set-desc" id="patch-store-path">存储目录：—</div>
        </div>
        <div class="set-control">
            <button type="button" id="patch-store-refresh" class="dlg-btn">刷新</button>
        </div>
    </div>
    <div class="set-row-top">
        <div id="patch-store-list" class="patch-store-list"></div>
    </div>
</div>`;
}

export function createSettingsPanePatches(deps) {
    // 当前宿主里的元素（mount 时按 id 在宿主内查询，兼容多宿主的将来）
    let els = {listEl: null, pathEl: null, refreshBtn: null};
    let loading = false;

    function root() {
        return typeof deps.root === 'function' ? deps.root() : (deps.root || '');
    }

    function emptyText(text) {
        const listEl = els.listEl;
        if (!listEl) return;
        listEl.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'patch-store-empty';
        empty.textContent = text;
        listEl.appendChild(empty);
    }

    function buildRow(meta) {
        const row = document.createElement('div');
        row.className = 'patch-store-row';

        const time = document.createElement('span');
        time.className = 'ps-time';
        time.textContent = patchTimeText(meta.createdAt);

        const label = patchStatusLabel(meta.status);
        const badge = document.createElement('span');
        badge.className = 'ps-badge ps-badge-' + label.tone;
        badge.textContent = label.text;

        const summary = document.createElement('span');
        summary.className = 'ps-summary';
        summary.textContent = patchRowTitle(meta);

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'dlg-btn ps-del';
        del.textContent = '删除';
        del.addEventListener('click', () => deletePatchRecord(meta));

        row.append(time, badge, summary, del);
        return row;
    }

    async function refreshPatchStore() {
        const listEl = els.listEl;
        if (!listEl) return;
        if (!deps.backend.PatchList) {
            emptyText('当前版本不支持补丁库（旧版后端）');
            return;
        }
        if (loading) return;
        loading = true;
        try {
            const dir = root();
            if (els.pathEl && deps.backend.PatchStoreDir) {
                try {
                    const storeDir = await deps.backend.PatchStoreDir(dir);
                    els.pathEl.textContent = '存储目录：' + (storeDir || '—');
                } catch (e) {
                    els.pathEl.textContent = '存储目录：—';
                }
            }
            const list = await deps.backend.PatchList(dir, 50);
            if (!Array.isArray(list) || !list.length) {
                emptyText('还没有补丁记录');
                return;
            }
            listEl.textContent = '';
            const frag = document.createDocumentFragment();
            for (const meta of list) frag.appendChild(buildRow(meta));
            listEl.appendChild(frag);
        } catch (e) {
            emptyText('读取失败：' + ((e && e.message) || e));
        } finally {
            loading = false;
        }
    }

    function deletePatchRecord(meta) {
        if (!meta || !meta.id) return;
        if (!deps.backend.PatchDelete) {
            deps.flash('当前版本不支持删除补丁', true);
            return;
        }
        deps.openConfirmDialog(patchDeleteConfirmText(meta), async () => {
            try {
                await deps.backend.PatchDelete(meta.id, root());
                deps.flash('补丁已删除（文件已进回收站）');
            } catch (e) {
                deps.flash('删除失败：' + ((e && e.message) || e), true);
            }
            refreshPatchStore();
        }, '删除', '删除补丁', 'danger');
    }

    // 挂到宿主容器（应用页面标签页调用）：建骨架 → 按 id 取元素 → 绑定 → 首次加载。
    // 返回卸载函数（关标签时由 doc.tabUnmount 调用）。
    function mount(host) {
        if (!host) return null;
        host.innerHTML = patchStoreSkeleton();
        els = {
            listEl: host.querySelector('#patch-store-list'),
            pathEl: host.querySelector('#patch-store-path'),
            refreshBtn: host.querySelector('#patch-store-refresh'),
        };
        const onRefresh = () => refreshPatchStore();
        if (els.refreshBtn) els.refreshBtn.addEventListener('click', onRefresh);
        refreshPatchStore();
        return () => {
            if (els.refreshBtn) els.refreshBtn.removeEventListener('click', onRefresh);
            els = {listEl: null, pathEl: null, refreshBtn: null};
        };
    }

    return {mount, refreshPatchStore, deletePatchRecord};
}
