// 设置 → 存储与清理：占用统计、一键清除缓存、按勾选清除数据。
// 条目表、体积统计与删除都在 Go 侧 internal/storage，这里只渲染与传 id；
// 缓存直删，数据进回收站，WebView2 相关的两项排到下次启动前执行。

import {createSwitch} from '../core/form-controls.js';

// ---- 纯函数（测试见 settings-pane-storage.test.mjs）----

// formatBytes：Go 侧 fmtSize 只到 MB，这里要能表达 1.1 GB 这种量级。
export function formatBytes(n) {
    const value = Number(n) || 0;
    if (value < 1024) return value + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value / 1024;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
    }
    // 100 KB 级别没必要两位小数，GB 级别要留精度
    return size.toFixed(size >= 100 ? 0 : 1) + ' ' + units[index];
}

// groupStorageItems：缓存段与数据段分开渲染；各自按体积从大到小，空的排最后。
export function groupStorageItems(items) {
    const list = Array.isArray(items) ? items : [];
    const bySize = (a, b) => (b.bytes || 0) - (a.bytes || 0);
    const cache = list.filter((item) => item.inCache).sort(bySize);
    const data = list.filter((item) => !item.inCache).sort(bySize);
    return {cache, data};
}

// cacheIDs：「清除缓存」按钮的范围由后端标记决定，前端不写死清单。
export function cacheIDs(items) {
    return groupStorageItems(items).cache.map((item) => item.id);
}

// prunePicked：重新统计后，已经不在表里或已经清空的条目要从勾选里掉出去。
export function prunePicked(items, picked) {
    const clearable = new Set((Array.isArray(items) ? items : [])
        .filter((item) => !item.inCache && (item.exists || item.pending))
        .map((item) => item.id));
    return [...(picked || [])].filter((id) => clearable.has(id));
}

// selectedBytes：按钮上写的「选中 N 项 · 大小」要用勾选后的数字，不是全表合计。
export function selectedBytes(items, picked) {
    const wanted = new Set(picked || []);
    return (Array.isArray(items) ? items : [])
        .filter((item) => wanted.has(item.id))
        .reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
}

// dangerPicked：这些条目删了拿不回来（会话、记忆、配置、界面状态），确认文案要逐个点名。
export function dangerPicked(items, picked) {
    const wanted = new Set(picked || []);
    return (Array.isArray(items) ? items : [])
        .filter((item) => wanted.has(item.id) && item.kind === 'danger');
}

// clearConfirmText：确认文案逐项列出要删什么、多大，危险项单独点名。
export function clearConfirmText(items, picked) {
    const wanted = new Set(picked || []);
    const chosen = (Array.isArray(items) ? items : []).filter((item) => wanted.has(item.id));
    const lines = ['将清除 ' + chosen.length + ' 项，约 ' + formatBytes(selectedBytes(items, picked)) + '：'];
    for (const item of chosen) {
        lines.push('· ' + item.label + '（' + formatBytes(item.bytes) + '）');
    }
    if (chosen.some((item) => item.scope === 'webview')) {
        lines.push('其中 WebView2 相关的项正被使用，会排到下次启动前执行。');
    }
    const danger = dangerPicked(items, picked);
    if (danger.length) {
        lines.push('以下条目删掉后拿不回来：' + danger.map((item) => item.label).join('、') + '。确定继续吗？');
    } else {
        lines.push('内容会送进回收站，误删可以取回。确定继续吗？');
    }
    return lines.join('\n');
}

// clearReportText：一次清除的回执，走 flash/状态栏。
export function clearReportText(report) {
    if (!report) return '清理完成';
    const parts = [];
    const freed = Number(report.freed) || 0;
    parts.push(freed > 0 ? '已释放 ' + formatBytes(freed) : '没有可清除的内容');
    if (Array.isArray(report.scheduled) && report.scheduled.length) {
        parts.push(report.scheduled.length + ' 项排到下次启动前清理');
    }
    const blocked = (Array.isArray(report.results) ? report.results : [])
        .reduce((sum, item) => sum + (Number(item.blocked) || 0), 0);
    if (blocked > 0) parts.push(blocked + ' 项使用中已跳过');
    if (Array.isArray(report.skipped) && report.skipped.length) {
        parts.push('部分条目没清干净：' + report.skipped.join('、'));
    }
    if (Array.isArray(report.failed) && report.failed.length) {
        parts.push('失败：' + report.failed.join('、'));
    }
    return parts.join(' · ');
}

// itemMetaText：一行右侧的数字说明。使用中由徽标表达，这里不再重复。
export function itemMetaText(item) {
    if (!item) return '—';
    const parts = [];
    if (item.entries > 0) parts.push(item.entries + ' 项');
    else if (item.files > 0) parts.push(item.files + ' 个文件');
    if (item.approx) parts.push('文件过多，数字为估算');
    return parts.length ? parts.join(' · ') : (item.exists ? '' : '无内容');
}

// tileText：汇总格里的一行小字。
export function tileText(tile) {
    if (!tile || !tile.path) return '位置不可用';
    const parts = [];
    if (tile.files > 0) parts.push(tile.files + ' 个文件');
    if (tile.otherBytes > 0) parts.push('其他 ' + formatBytes(tile.otherBytes));
    return parts.length ? parts.join(' · ') : '空';
}

// barSegments：占比条的三段（可释放缓存 / 用户数据 / 未登记的其他）。
export function barSegments(report) {
    const tiles = Array.isArray(report && report.tiles) ? report.tiles : [];
    const other = tiles.reduce((sum, tile) => sum + (Number(tile.otherBytes) || 0), 0);
    return [
        {key: 'cache', label: '可释放缓存', bytes: Number(report && report.cacheBytes) || 0},
        {key: 'data', label: '用户数据', bytes: Number(report && report.dataBytes) || 0},
        {key: 'other', label: '其他', bytes: other},
    ];
}

// ---- 渲染 ----

export function createSettingsPaneStorage(deps) {
    const els = {
        tiles: document.getElementById('stg-tiles'),
        bar: document.getElementById('stg-bar'),
        legend: document.getElementById('stg-legend'),
        summary: document.getElementById('stg-summary'),
        refresh: document.getElementById('stg-refresh'),
        cacheTotal: document.getElementById('stg-cache-total'),
        cacheList: document.getElementById('stg-cache-list'),
        clearCache: document.getElementById('stg-clear-cache'),
        dataList: document.getElementById('stg-data-list'),
        clearPicked: document.getElementById('stg-clear-picked'),
    };
    const picked = new Set();
    let report = null;
    let busy = false;
    let errorText = '';

    function workspaceRoot() {
        return typeof deps.root === 'function' ? (deps.root() || '') : (deps.root || '');
    }

    function span(className, text) {
        const el = document.createElement('span');
        el.className = className;
        if (text != null) el.textContent = text;
        return el;
    }

    function infoTip(text) {
        const tip = document.createElement('button');
        tip.type = 'button';
        tip.className = 'info-tip';
        tip.dataset.tip = text || '';
        tip.setAttribute('aria-label', '说明');
        return tip;
    }

    async function renderStoragePane() {
        if (!els.cacheList) return;
        if (!deps.backend.StorageScan) {
            errorText = '当前后端版本不支持存储统计';
            paint();
            return;
        }
        await rescan();
    }

    async function rescan() {
        if (busy) return;
        busy = true;
        errorText = '';
        paint();
        const previous = new Set(picked);
        try {
            report = await deps.backend.StorageScan(workspaceRoot());
            // 重新统计后按实际内容收敛勾选：已经清空的条目不能留在勾选态里
            picked.clear();
            for (const id of prunePicked(report.items, previous)) picked.add(id);
        } catch (e) {
            errorText = '统计失败：' + ((e && e.message) || e);
        } finally {
            busy = false;
            paint();
        }
    }

    function paint() {
        paintSummary();
        paintCache();
        paintData();
    }

    function paintSummary() {
        if (!els.tiles) return;
        els.tiles.textContent = '';
        const tiles = report && Array.isArray(report.tiles) ? report.tiles : [];
        for (const tile of tiles) els.tiles.appendChild(buildTile(tile));
        paintBar();
        if (els.summary) {
            els.summary.textContent = errorText || (busy ? '正在统计…' : '')
                || (report && report.truncated ? '文件过多，部分数字为估算值。' : '');
        }
    }

    function buildTile(tile) {
        const card = document.createElement('div');
        card.className = 'stg-tile';
        const head = span('stg-tile-head');
        head.append(span('stg-tile-label', tile.label));
        if (tile.path) {
            const open = document.createElement('button');
            open.type = 'button';
            open.className = 'stg-tile-open';
            open.dataset.tip = tile.path;
            open.setAttribute('aria-label', '打开' + tile.label);
            open.textContent = '打开';
            open.addEventListener('click', () => openPath(tile.path));
            head.appendChild(open);
        }
        const size = span('stg-tile-size', tile.path ? formatBytes(tile.bytes + tile.otherBytes) : '—');
        const meta = span('stg-tile-meta', tile.path ? tileText(tile) : (tile.scope === 'workspace' ? '未打开工作区' : '位置不可用'));
        card.append(head, size, meta);
        return card;
    }

    function paintBar() {
        if (!els.bar || !els.legend) return;
        els.bar.textContent = '';
        els.legend.textContent = '';
        const segments = barSegments(report);
        const total = segments.reduce((sum, seg) => sum + seg.bytes, 0);
        if (!total) {
            const empty = span('stg-bar-empty');
            els.bar.appendChild(empty);
            els.legend.appendChild(span('stg-legend-item', '没有可统计的内容'));
            return;
        }
        for (const seg of segments) {
            if (!seg.bytes) continue;
            const part = span('stg-seg stg-seg-' + seg.key);
            // 占比过小的段留 1px 存在感，否则用户以为漏算了
            part.style.flexGrow = String(Math.max(seg.bytes / total * 100, 0.4));
            part.dataset.tip = seg.label + ' ' + formatBytes(seg.bytes) + '（' + Math.round(seg.bytes / total * 100) + '%）';
            els.bar.appendChild(part);
            const item = span('stg-legend-item');
            item.append(span('stg-dot stg-dot-' + seg.key), span(null, seg.label + ' ' + formatBytes(seg.bytes)));
            els.legend.appendChild(item);
        }
    }

    function paintCache() {
        if (!els.cacheList) return;
        const {cache} = groupStorageItems(report && report.items);
        const bytes = cache.reduce((sum, item) => sum + (item.bytes || 0), 0);
        if (els.cacheTotal) {
            els.cacheTotal.textContent = busy ? '统计中…'
                : (bytes ? '共约 ' + formatBytes(bytes) + '，全部可再生，删除不影响任何内容与设置。' : '没有可清除的缓存。');
        }
        if (els.clearCache) {
            els.clearCache.disabled = busy || !bytes;
            els.clearCache.dataset.tip = bytes ? '清除下面列出的全部缓存' : '当前没有缓存';
        }
        els.cacheList.textContent = '';
        for (const item of cache) els.cacheList.appendChild(buildRow(item, null));
    }

    function paintData() {
        if (!els.dataList) return;
        const {data} = groupStorageItems(report && report.items);
        els.dataList.textContent = '';
        for (const item of data) {
            const control = createSwitch({
                checked: picked.has(item.id),
                disabled: busy || (!item.exists && !item.pending),
                title: item.exists || item.pending ? '勾选后计入「清除所选」' : '没有内容可清',
                onChange: (event) => {
                    if (event.target.checked) picked.add(item.id);
                    else picked.delete(item.id);
                    paintDataFooter();
                },
            });
            els.dataList.appendChild(buildRow(item, control));
        }
        paintDataFooter();
    }

    function paintDataFooter() {
        if (!els.clearPicked) return;
        const count = picked.size;
        const bytes = selectedBytes(report && report.items, picked);
        els.clearPicked.disabled = busy || !count;
        els.clearPicked.textContent = count
            ? '清除所选 ' + count + ' 项 · ' + formatBytes(bytes)
            : '清除所选';
    }

    function buildRow(item, control) {
        const row = document.createElement('div');
        row.className = 'stg-row' + (item.exists || item.pending ? '' : ' stg-row-empty');
        const main = document.createElement('div');
        main.className = 'stg-row-main';
        const title = span('stg-row-title');
        title.append(span(null, item.label));
        if (item.note) title.appendChild(infoTip(item.note));
        if (item.path) title.dataset.tip = item.path;
        main.appendChild(title);
        const meta = span('stg-row-meta', itemMetaText(item));
        main.appendChild(meta);
        for (const badge of rowBadges(item)) main.appendChild(badge);
        const size = span('stg-row-size', item.exists || item.pending ? formatBytes(item.bytes) : '—');
        row.append(main, size);
        if (control) {
            const holder = document.createElement('div');
            holder.className = 'stg-row-switch';
            holder.appendChild(control.element);
            row.appendChild(holder);
        }
        return row;
    }

    function rowBadges(item) {
        const out = [];
        if (item.pending) out.push(badge('已排下次启动', 'warn'));
        else if (item.blocked > 0) out.push(badge(item.blocked + ' 项使用中', 'muted'));
        if (item.kind === 'danger') out.push(badge('不可恢复', 'error'));
        else if (item.kind === 'data') out.push(badge('进回收站', 'muted'));
        return out;
    }

    function badge(text, tone) {
        return span('stg-badge stg-badge-' + tone, text);
    }

    async function openPath(path) {
        if (!path || !deps.backend.ShowInFolder) return;
        try {
            await deps.backend.ShowInFolder(path);
        } catch (e) {
            deps.flash('打开位置失败：' + ((e && e.message) || e), true);
        }
    }

    function items() {
        return report && Array.isArray(report.items) ? report.items : [];
    }

    function clearCache() {
        // 只把「此刻真有东西可删」的条目送进清除：全被占用的条目删不动，列进确认文案只会误导
        const cacheable = cacheIDs(items()).filter((id) => {
            const item = items().find((row) => row.id === id);
            return item && item.exists;
        });
        if (!cacheable.length) return;
        runClear(cacheable, {
            title: '清除缓存',
            okLabel: '清除缓存',
            message: cacheConfirmText(items(), cacheable),
        });
    }

    function clearPickedSelection() {
        const ids = prunePicked(items(), picked);
        if (!ids.length) return;
        runClear(ids, {
            title: '清除数据',
            okLabel: '删除',
            message: clearConfirmText(items(), ids),
        });
    }

    function runClear(ids, options) {
        if (busy) return;
        if (!deps.backend.StorageClear) {
            deps.flash('当前后端版本不支持清除', true);
            return;
        }
        const act = async () => {
            busy = true;
            paint();
            try {
                const result = await deps.backend.StorageClear(ids, workspaceRoot());
                deps.flash(clearReportText(result));
                for (const id of ids) picked.delete(id);
                report = await deps.backend.StorageScan(workspaceRoot());
            } catch (e) {
                deps.flash('清除失败：' + ((e && e.message) || e), true);
            } finally {
                busy = false;
                paint();
            }
        };
        // 缓存与数据都要确认：前者会让人退出网页登录，后者直接删内容
        if (typeof deps.openConfirmDialog === 'function') {
            deps.openConfirmDialog(options.message, act, options.okLabel, options.title, 'danger');
        } else {
            act();
        }
    }

    if (els.refresh) els.refresh.addEventListener('click', () => rescan());
    if (els.clearCache) els.clearCache.addEventListener('click', () => clearCache());
    if (els.clearPicked) els.clearPicked.addEventListener('click', () => clearPickedSelection());

    return {renderStoragePane, rescan, clearCache, clearPicked: clearPickedSelection};
}

// cacheConfirmText：缓存的范围逐项列出，避免用户以为「清除缓存」会连带删掉内容。
export function cacheConfirmText(items, ids) {
    const wanted = new Set(ids || []);
    const chosen = (Array.isArray(items) ? items : []).filter((item) => wanted.has(item.id) && item.exists);
    const bytes = chosen.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
    const lines = ['将清除 ' + chosen.length + ' 项缓存，约 ' + formatBytes(bytes) + '：'];
    for (const item of chosen) lines.push('· ' + item.label + '（' + formatBytes(item.bytes) + '）');
    if (chosen.some((item) => item.scope === 'webview')) {
        lines.push('界面浏览器缓存运行中删不掉，会排到下次启动前执行。');
    }
    if (chosen.some((item) => item.id === 'browser-profiles')) {
        lines.push('内嵌浏览器的网页登录态会一并清除。');
    }
    lines.push('缓存都可再生，不影响会话、记忆与设置。确定继续吗？');
    return lines.join('\n');
}
