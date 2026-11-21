// db-table-grid.js：表数据网格面板——排序/筛选/分页下推 + 受控编辑。
//
// 编辑链路（方案 §5.3）：dirty model（客户端暂存，不发 SQL）→ 预览（内联展示值 SQL，只读弹层）
// → 用户确认 → 单事务提交（Go 侧乐观并发 + 整体回滚）→ 刷新（noCache 元数据）→ 留痕。
// 行定位只认主键；无主键/视图/只读会话/全局只读锁一律不可编辑，工具栏给出原因。
// 主键列本身不可编辑（改主键 = 改行身份，不支持）。

import {iconSvg} from '../core/icons.js';
import {createInput, createSelect, createSwitch} from '../core/form-controls.js';
import {overlayStack} from '../core/overlay-stack.js';
import {createDbGrid} from './db-grid-core.js';
import {
    rowKeyOf, rowKeysMap, FILTER_OPS, filterOpNeedsValue,
    rowEstimateLabel, dirtySummary, tableEditable, formatElapsed,
} from './db-model.js';

const PAGE_SIZE = 500;

export function createDbTablePane(deps, session, db, table) {

const el = document.createElement('div');
el.className = 'db-table-pane';

let meta = null;
let columns = [];
let serverRows = [];
let serverNulls = [];
let pageOffset = 0;
let hasMore = false;
let loading = false;
let error = '';
let sortCol = '';
let sortDesc = false;
let filters = [];
let editMode = false;
let loaded = false;

// dirty model：updates key → {keys, cells: Map(col → {old, new})}；deletes key 集合；inserts 数组
const updates = new Map();
const deletes = new Set();
let inserts = [];
let insertSeq = 0;
let keyIndex = new Map(); // 行键 → serverRows 下标

const globalReadonly = () => !!(deps.settings && deps.settings.readOnlyMode);
const isEditable = () => tableEditable(meta, session.editable, globalReadonly());
const editableReason = () => {
    if (!meta) return '';
    if (meta.kind === 'view') return '视图不可编辑';
    if (!session.editable) return '连接为只读（打开连接时未开启「允许编辑」）';
    if (!(meta.pk || []).length) return '无主键表一律只读';
    if (globalReadonly()) return '编辑器全局只读锁已开启';
    return '';
};

// ---------- DOM 骨架 ----------

const toolbar = document.createElement('div');
toolbar.className = 'db-table-toolbar';
const titleWrap = document.createElement('div');
titleWrap.className = 'db-table-title';
const titleIcon = document.createElement('span');
titleIcon.className = 'db-table-ic';
titleIcon.innerHTML = iconSvg('view-table', 13);
const titleName = document.createElement('span');
titleName.className = 'db-table-name';
titleName.textContent = (db && db !== 'main' ? db + '.' : '') + table;
const titleEst = document.createElement('span');
titleEst.className = 'db-table-est';
titleWrap.append(titleIcon, titleName, titleEst);

const actions = document.createElement('div');
actions.className = 'db-table-actions';
const refreshBtn = mkBtn('refresh', '刷新');
const filterBtn = mkBtn('filter', '筛选');
const pagePrev = mkBtn('chevron-left', '上一页');
const pageNext = mkBtn('chevron-right', '下一页');
const rangeLabel = document.createElement('span');
rangeLabel.className = 'db-table-range';
const editBtn = mkBtn('unlock', '编辑');
const addRowBtn = mkBtn('plus', '插入行');
const dropBtn = mkBtn('undo', '放弃');
const submitBtn = mkBtn('check', '预览并提交');
const pendingLabel = document.createElement('span');
pendingLabel.className = 'db-table-pending';
actions.append(refreshBtn, filterBtn, pagePrev, rangeLabel, pageNext);
el.append(toolbar);

// 筛选区（条件列表：列/算子/值，全部下推为参数化 WHERE）
const filterArea = document.createElement('div');
filterArea.className = 'db-table-filters hidden';
const filterList = document.createElement('div');
filterList.className = 'db-table-filter-list';
const addFilterBtn = document.createElement('button');
addFilterBtn.type = 'button';
addFilterBtn.className = 'db-btn';
addFilterBtn.innerHTML = iconSvg('plus', 11) + '<span>加条件</span>';
filterArea.append(filterList, addFilterBtn);

// 网格 + 状态条
const grid = createDbGrid({
    onHeaderClick(col) {
        if (sortCol === col && !sortDesc) { sortDesc = true; }
        else if (sortCol === col) { sortCol = ''; sortDesc = false; }
        else { sortCol = col; sortDesc = false; }
        pageOffset = 0;
        loadPage();
    },
    onCellActivate(rowIdx, colIdx, cellEl) { startCellEdit(rowIdx, colIdx, cellEl); },
    onRowNumberClick(rowIdx) { toggleRowDelete(rowIdx); },
    rowClass(i) {
        if (i >= serverRows.length) return 'db-row-inserted';
        const key = rowKeyOf(meta, serverRows[i], columns);
        return deletes.has(key) ? 'db-row-deleted' : '';
    },
    cellClass(i, c) {
        const col = columns[c];
        if (i >= serverRows.length) {
            const ins = inserts[i - serverRows.length];
            return ins && ins.edited.has(col) ? 'db-cell-dirty' : '';
        }
        const key = rowKeyOf(meta, serverRows[i], columns);
        const u = updates.get(key);
        return u && u.cells.has(col) ? 'db-cell-dirty' : '';
    },
});
const statusBar = document.createElement('div');
statusBar.className = 'db-table-status';
const gridHost = document.createElement('div');
gridHost.className = 'db-table-grid-host';
gridHost.appendChild(grid.el);
el.append(filterArea, gridHost, statusBar);

function mkBtn(icon, label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'db-btn';
    b.innerHTML = iconSvg(icon, 12) + '<span>' + label + '</span>';
    return b;
}

// ---------- 数据加载 ----------

async function loadMeta(noCache) {
    meta = await deps.backend.DBDescribe(session.id, db, table, !!noCache);
    titleEst.textContent = rowEstimateLabel(meta.rowEstimate);
    rebuildToolbar();
}

function rebuildKeyIndex() {
    keyIndex = new Map();
    serverRows.forEach((row, i) => keyIndex.set(rowKeyOf(meta, row, columns), i));
}

async function loadPage() {
    loading = true;
    error = '';
    renderStatus();
    try {
        const res = await deps.backend.DBBrowse(session.id, {
            database: db,
            table,
            sortColumn: sortCol,
            sortDesc,
            filters,
            offset: pageOffset,
            limit: PAGE_SIZE,
        });
        columns = res.columns || [];
        serverRows = res.rows || [];
        serverNulls = res.nulls || [];
        hasMore = !!res.truncated;
        rebuildKeyIndex();
    } catch (e) {
        error = String(e && e.message || e);
        deps.flash('表数据加载失败：' + error, true);
    } finally {
        loading = false;
        loaded = true;
        applyToGrid();
        renderStatus();
    }
}

function applyToGrid() {
    const displayRows = serverRows.concat(inserts.map((ins) => columns.map((c) => (ins.values[c] == null ? '' : ins.values[c]))));
    const displayNulls = serverNulls.concat(inserts.map(() => columns.map(() => false)));
    grid.setColumns(columns);
    grid.setSort(sortCol, sortDesc);
    grid.setRows(displayRows, displayNulls, pageOffset);
}

function renderStatus() {
    const parts = [];
    if (loading) parts.push('加载中…');
    if (error) parts.push('错误：' + error);
    if (!loading && loaded && !error) {
        if (!serverRows.length && !inserts.length) parts.push('无数据');
        else parts.push('第 ' + (pageOffset + 1) + '–' + (pageOffset + serverRows.length) + ' 行' + (hasMore ? '（还有更多）' : ''));
    }
    const hint = editableReason();
    if (hint) parts.push(hint);
    statusBar.textContent = parts.join(' · ');
}

function rebuildToolbar() {
    // 编辑簇只在「可编辑」时出现；不可编辑时状态条给出原因
    editBtn.hidden = !isEditable();
    editBtn.classList.toggle('primary', editMode);
    editBtn.innerHTML = iconSvg(editMode ? 'lock' : 'unlock', 12) + '<span>' + (editMode ? '退出编辑' : '编辑') + '</span>';
    addRowBtn.hidden = !editMode;
    dropBtn.hidden = !editMode;
    submitBtn.hidden = !editMode;
    submitBtn.classList.toggle('primary', editMode);
    pendingLabel.hidden = !editMode;
    const summary = dirtySummary({updates, deletes, inserts});
    pendingLabel.textContent = summary ? ('待提交：' + summary) : '';
    pagePrev.disabled = pageOffset <= 0;
    pageNext.disabled = !hasMore;
    titleEst.textContent = rowEstimateLabel(meta && meta.rowEstimate);
}

// ---------- 交互 ----------

refreshBtn.addEventListener('click', async () => {
    try {
        await loadMeta(true);
        await loadPage();
    } catch (e) {
        deps.flash('刷新失败：' + (e && e.message || e), true);
    }
});
filterBtn.addEventListener('click', () => {
    filterArea.classList.toggle('hidden');
    if (!filterArea.classList.contains('hidden') && !filters.length) addFilterRow();
});
pagePrev.addEventListener('click', () => {
    pageOffset = Math.max(0, pageOffset - PAGE_SIZE);
    loadPage();
});
pageNext.addEventListener('click', () => {
    if (!hasMore) return;
    pageOffset += PAGE_SIZE;
    loadPage();
});
editBtn.addEventListener('click', () => {
    editMode = !editMode;
    rebuildToolbar();
    renderStatus();
});
addRowBtn.addEventListener('click', () => {
    if (!isEditable()) return;
    inserts.push({values: {}, edited: new Set()});
    applyToGrid();
    rebuildToolbar();
});
dropBtn.addEventListener('click', () => {
    updates.clear();
    deletes.clear();
    inserts = [];
    applyToGrid();
    rebuildToolbar();
});
submitBtn.addEventListener('click', submitChanges);

addFilterBtn.addEventListener('click', () => addFilterRow());

function addFilterRow(initial) {
    const cond = initial || {column: (columns || [])[0] || '', op: 'contains', value: ''};
    filters.push(cond);
    const row = document.createElement('div');
    row.className = 'db-filter-cond';
    const colSel = createSelect({options: columns.map((c) => ({value: c, label: c, selected: c === cond.column}))});
    const opSel = createSelect({options: FILTER_OPS.map((o) => ({value: o.value, label: o.label, selected: o.value === cond.op}))});
    const valInput = createInput({value: cond.value, placeholder: '值'});
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'db-btn';
    rm.innerHTML = iconSvg('close', 11);
    const syncValue = () => {
        valInput.element.hidden = !filterOpNeedsValue(opSel.control.value);
    };
    colSel.control.addEventListener('change', () => { cond.column = colSel.control.value; applyFilters(); });
    opSel.control.addEventListener('change', () => { cond.op = opSel.control.value; syncValue(); applyFilters(); });
    valInput.control.addEventListener('input', () => { cond.value = valInput.control.value; applyFilters(); });
    rm.addEventListener('click', () => {
        const at = filters.indexOf(cond);
        if (at >= 0) filters.splice(at, 1);
        row.remove();
        if (!filters.length) filterArea.classList.add('hidden');
        applyFilters();
    });
    syncValue();
    row.append(colSel.element, opSel.element, valInput.element, rm);
    filterList.appendChild(row);
}

function applyFilters() {
    pageOffset = 0;
    loadPage();
}

// 行号点按 = 删除标记（编辑模式）
function toggleRowDelete(rowIdx) {
    if (!editMode || loading) return;
    if (rowIdx >= serverRows.length) {
        inserts.splice(rowIdx - serverRows.length, 1);
        applyToGrid();
        rebuildToolbar();
        return;
    }
    const key = rowKeyOf(meta, serverRows[rowIdx], columns);
    if (deletes.has(key)) {
        deletes.delete(key);
    } else {
        deletes.add(key);
        updates.delete(key); // 整行都删了，单格修改一并丢弃
    }
    applyToGrid();
    rebuildToolbar();
}

// 双击单元格 → 行内输入框
function startCellEdit(rowIdx, colIdx, cellEl) {
    if (!editMode || loading) return;
    const col = columns[colIdx];
    if (col == null) return;
    const editingInsert = rowIdx >= serverRows.length;
    if (!editingInsert) {
        if ((meta.pk || []).includes(col)) return; // 主键列不可编辑（改主键 = 改行身份）
        const key = rowKeyOf(meta, serverRows[rowIdx], columns);
        if (deletes.has(key)) return; // 已标记删除的行不再改
    }
    const current = cellEl.textContent === 'NULL' ? '' : cellEl.textContent;
    cellEl.textContent = '';
    const input = createInput({value: current, spellcheck: false});
    input.control.style.width = '100%';
    cellEl.appendChild(input.element);
    cellEl.classList.add('db-cell-editing');
    input.control.focus();
    input.control.select();

    const commit = () => {
        const value = input.control.value;
        cellEl.classList.remove('db-cell-editing');
        if (editingInsert) {
            const ins = inserts[rowIdx - serverRows.length];
            if (value === '') ins.values[col] = null;
            else ins.values[col] = value;
            if (value !== '') ins.edited.add(col);
            else ins.edited.delete(col);
        } else {
            const key = rowKeyOf(meta, serverRows[rowIdx], columns);
            const idx = keyIndex.get(key);
            const wasNull = !!(serverNulls[idx] && serverNulls[idx][colIdx]);
            const old = wasNull ? null : serverRows[rowIdx][colIdx];
            const newValue = value;
            if ((old == null && newValue === '') || old === newValue) {
                const u = updates.get(key);
                if (u) {
                    u.cells.delete(col);
                    if (!u.cells.size) updates.delete(key);
                }
            } else {
                let u = updates.get(key);
                if (!u) {
                    u = {keys: rowKeysMap(meta, serverRows[rowIdx], columns), cells: new Map()};
                    updates.set(key, u);
                }
                u.cells.set(col, {old, new: newValue});
            }
        }
        applyToGrid();
        rebuildToolbar();
    };
    const cancel = () => {
        cellEl.classList.remove('db-cell-editing');
        applyToGrid();
    };
    input.control.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            commit();
        } else if (ev.key === 'Escape') {
            ev.preventDefault();
            cancel();
        }
    });
    input.control.addEventListener('blur', commit);
}

// ---------- 预览与提交 ----------

function buildChanges() {
    const ch = {database: db, table, updates: [], deletes: [], inserts: []};
    for (const [key, u] of updates) {
        if (deletes.has(key)) continue;
        for (const [col, c] of u.cells) {
            ch.updates.push({keys: u.keys, column: col, oldValue: c.old, newValue: c.new});
        }
    }
    for (const key of deletes) {
        const idx = keyIndex.get(key);
        if (idx == null) continue;
        ch.deletes.push({keys: rowKeysMap(meta, serverRows[idx], columns)});
    }
    for (const ins of inserts) {
        ch.inserts.push({values: Object.assign({}, ins.values)});
    }
    if (!ch.updates.length && !ch.deletes.length && !ch.inserts.length) return null;
    return ch;
}

async function submitChanges() {
    if (!isEditable()) return;
    const changes = buildChanges();
    if (!changes) {
        deps.flash('没有待提交的修改');
        return;
    }
    let stmts = [];
    try {
        stmts = await deps.backend.DBPreviewChanges(session.id, changes) || [];
    } catch (e) {
        deps.flash('生成预览失败：' + (e && e.message || e), true);
        return;
    }
    openPreviewOverlay(stmts, changes);
}

function openPreviewOverlay(stmts, changes) {
    const mask = document.createElement('div');
    mask.className = 'db-preview-mask';
    const panel = document.createElement('div');
    panel.className = 'db-preview';
    const head = document.createElement('div');
    head.className = 'db-preview-head';
    head.textContent = '提交预览 · ' + stmts.length + ' 条语句 · 单事务（任一失败整体回滚）';
    const body = document.createElement('div');
    body.className = 'db-preview-body';
    for (const st of stmts) {
        const item = document.createElement('div');
        item.className = 'db-preview-item';
        const tag = document.createElement('span');
        tag.className = 'db-preview-kind ' + st.kind;
        tag.textContent = st.kind;
        const code = document.createElement('pre');
        code.className = 'db-preview-sql';
        code.textContent = st.sql;
        item.append(tag, code);
        body.appendChild(item);
    }
    const foot = document.createElement('div');
    foot.className = 'db-preview-foot';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'db-btn';
    cancelBtn.textContent = '取消';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'db-btn danger';
    okBtn.textContent = '提交（不可自动回滚）';
    foot.append(cancelBtn, okBtn);
    panel.append(head, body, foot);
    mask.appendChild(panel);

    const handle = overlayStack.open({
        id: 'db-apply-preview',
        kind: 'modal',
        el: panel,
        underEl: mask,
        onClose: () => {
            mask.remove();
            panel.remove();
        },
    });
    document.body.appendChild(mask);
    const close = () => handle.dispose();
    cancelBtn.addEventListener('click', close);
    mask.addEventListener('click', (ev) => {
        if (ev.target === mask) close();
    });
    okBtn.addEventListener('click', async () => {
        okBtn.disabled = true;
        try {
            const result = await deps.backend.DBApplyChanges(session.id, changes);
            close();
            updates.clear();
            deletes.clear();
            inserts = [];
            deps.flash('已提交：' + result.updates + ' 处修改、' + result.deletes + ' 行删除、' + result.inserts + ' 行插入（' + formatElapsed(result.elapsedMs) + '）');
            if (deps.logActivity) {
                deps.logActivity('db.apply', session.kind + ':' + session.name + '/' + table, {
                    kind: session.kind, table,
                    updates: result.updates, deletes: result.deletes, inserts: result.inserts,
                    elapsedMs: result.elapsedMs,
                });
            }
            await loadMeta(true);
            await loadPage();
        } catch (e) {
            okBtn.disabled = false;
            deps.flash('提交失败（已整体回滚）：' + (e && e.message || e), true);
            // 冲突/失败后刷新当前页，让用户看到最新数据
            await loadMeta(true);
            await loadPage();
            close();
        }
    });
}

// ---------- 启动 ----------

async function init() {
    try {
        await loadMeta(false);
    } catch (e) {
        error = String(e && e.message || e);
        renderStatus();
        return;
    }
    rebuildToolbar();
    await loadPage();
}

init();

return {
    el,
    /** 会话断开时由页面调用（隐藏编辑簇）。 */
    invalidate() {
        editMode = false;
        rebuildToolbar();
        renderStatus();
    },
};
}
