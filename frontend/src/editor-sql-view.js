// editor-sql-view.js：从 editor-groups.js 拆出的域模块（factory + 显式依赖注入）。
// 大文件只读 SQL 查询视图：查询执行、状态条、结果表渲染、文档销毁。
//
// deps 经 Object.create 委托继承 editor-groups 的 getter 集，另接
// updateStatus（核心）与 exitSplitView（分屏预览域）的转发箭头。
export function createEditorSqlView(deps) {

// ---------- 大文件只读 SQL 查询视图 ----------

function sqlKindFor(doc) {
    if (!doc) return '';
    if (doc.format && doc.format.id === 'jsonl') return 'jsonl';
    const ext = String(doc.name || '').split('.').pop().toLowerCase();
    return ext === 'tsv' ? 'tsv' : 'csv';
}

function currentSqlSourceText(doc) {
    try {
        if (doc && doc.editor) {
            const sourceMode = doc.sqlSourceMode || doc.mode;
            if (sourceMode === 'tree' && doc.format && typeof doc.format.stringify === 'function') {
                return doc.format.stringify(doc.editor.get());
            }
            return doc.editor.getText();
        }
    } catch (e) {}
    return (doc && (doc.text || doc.savedText || doc.content)) || '';
}

function createSqlView(doc) {
    if (!doc || !doc.pane || doc.sqlEl) return;
    const wrap = document.createElement('div');
    wrap.className = 'sql-view';
    const bar = document.createElement('div');
    bar.className = 'sql-bar';
    const meta = document.createElement('span');
    meta.className = 'sql-meta';
    meta.textContent = '尚未导入';
    const hint = document.createElement('span');
    hint.className = 'sql-hint';
    hint.textContent = '查询临时副本，不会修改原文件';
    const limit = document.createElement('select');
    limit.className = 'sql-limit opt-select';
    for (const n of [100, 500, 1000, 5000]) {
        const option = document.createElement('option');
        option.value = String(n);
        option.textContent = '最多 ' + n + ' 行';
        limit.appendChild(option);
    }
    limit.value = '500';
    const reimport = document.createElement('button');
    reimport.type = 'button';
    reimport.className = 'sql-btn';
    reimport.textContent = '重新导入';
    bar.append(meta, hint, limit, reimport);
    const queryWrap = document.createElement('div');
    queryWrap.className = 'sql-query-wrap';
    const input = document.createElement('textarea');
    input.className = 'sql-query';
    input.spellcheck = false;
    input.placeholder = 'SELECT * FROM t LIMIT 100;';
    input.value = 'SELECT * FROM t LIMIT 100;';
    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'sql-btn primary';
    run.textContent = '运行 (Ctrl+Enter)';
    queryWrap.append(input, run);
    const status = document.createElement('div');
    status.className = 'sql-status';
    const result = document.createElement('div');
    result.className = 'sql-result-wrap';
    wrap.append(bar, queryWrap, status, result);
    doc.pane.appendChild(wrap);
    doc.sqlEl = {wrap, meta, input, run, status, result, limit, reimport};
    run.addEventListener('click', () => runSqlQuery(doc));
    reimport.addEventListener('click', () => importSqlDoc(doc, true));
    input.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            runSqlQuery(doc);
        }
    });
    limit.addEventListener('change', () => {
        if (doc.sqlInfo) runSqlQuery(doc);
    });
}

function sqlSetStatus(doc, text, isError) {
    if (!doc || !doc.sqlEl) return;
    doc.sqlEl.status.textContent = text || '';
    doc.sqlEl.status.classList.toggle('error', !!isError);
}

async function importSqlDoc(doc, force) {
    if (!doc || !doc.sqlEl || doc.sqlImporting) return;
    if (doc.sqlInfo && !force) return;
    if (!deps.backend.SQLImport) {
        sqlSetStatus(doc, '当前版本不支持 SQL 查询', true);
        return;
    }
    if (doc.sqlInfo) {
        try { await deps.backend.SQLClose(doc.sqlInfo.id); } catch (e) {}
        doc.sqlInfo = null;
    }
    doc.sqlImporting = true;
    sqlSetStatus(doc, '正在导入临时副本…', false);
    if (doc.sqlEl.run) doc.sqlEl.run.disabled = true;
    try {
        const kind = sqlKindFor(doc);
        const useText = !doc.path || !!doc.dirty;
        const text = useText ? currentSqlSourceText(doc) : '';
        const info = await deps.backend.SQLImport(doc.path || '', kind, doc.enc || 'utf-8', text, useText);
        doc.sqlInfo = info;
        doc.sqlEl.meta.textContent = info.rows + ' 行 × ' + (info.columns || []).length + ' 列 · 导入 ' +
            info.elapsedMs + ' ms' + (info.truncated ? ' · 已截断' : '');
        doc.sqlEl.input.value = doc.sqlQuery || 'SELECT * FROM t LIMIT 100;';
        doc.sqlQuery = doc.sqlEl.input.value;
        sqlSetStatus(doc, useText ? '已导入编辑器当前内容（含未保存修改）' : '已导入磁盘文件', false);
        await runSqlQuery(doc);
    } catch (e) {
        sqlSetStatus(doc, '导入失败：' + ((e && e.message) || e), true);
    } finally {
        doc.sqlImporting = false;
        if (doc.sqlEl && doc.sqlEl.run) doc.sqlEl.run.disabled = false;
    }
}

async function runSqlQuery(doc) {
    if (!doc || !doc.sqlEl || !doc.sqlInfo) return;
    if (!deps.backend.SQLQuery) {
        sqlSetStatus(doc, '当前版本不支持 SQL 查询', true);
        return;
    }
    const query = doc.sqlEl.input.value.trim();
    if (!query) {
        sqlSetStatus(doc, '请输入 SQL', true);
        return;
    }
    doc.sqlQuery = doc.sqlEl.input.value;
    const limit = Number(doc.sqlEl.limit.value) || 500;
    doc.sqlEl.run.disabled = true;
    sqlSetStatus(doc, '查询中…', false);
    try {
        const result = await deps.backend.SQLQuery(doc.sqlInfo.id, query, limit);
        renderSqlResult(doc, result);
    } catch (e) {
        doc.sqlEl.result.textContent = '';
        sqlSetStatus(doc, '查询失败：' + ((e && e.message) || e), true);
    } finally {
        doc.sqlEl.run.disabled = false;
    }
}

function renderSqlResult(doc, result) {
    const box = doc.sqlEl.result;
    box.textContent = '';
    const columns = (result && result.columns) || [];
    const rows = (result && result.rows) || [];
    const nulls = (result && result.nulls) || [];
    const meta = rows.length + ' 行 × ' + columns.length + ' 列 · ' + (result.elapsedMs || 0) + ' ms' +
        (result.truncated ? ' · 已截断（可加 LIMIT 或调大上限）' : '') +
        (result.message ? ' · ' + result.message : '');
    sqlSetStatus(doc, meta, false);
    if (!columns.length) {
        const empty = document.createElement('div');
        empty.className = 'sql-empty';
        empty.textContent = result.message || '语句已执行（无结果集）';
        box.appendChild(empty);
        return;
    }
    const table = document.createElement('table');
    table.className = 'sql-result-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const column of columns) {
        const th = document.createElement('th');
        th.textContent = column;
        headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (let r = 0; r < rows.length; r++) {
        const tr = document.createElement('tr');
        for (let c = 0; c < columns.length; c++) {
            const td = document.createElement('td');
            const isNull = !!(nulls[r] && nulls[r][c]);
            if (isNull) {
                const span = document.createElement('span');
                span.className = 'sql-null';
                span.textContent = 'NULL';
                td.appendChild(span);
            } else {
                const value = rows[r][c] == null ? '' : String(rows[r][c]);
                td.textContent = value;
                if (value) td.title = value.length > 200 ? value.slice(0, 200) + '…' : value;
            }
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);
}

function disposeSqlDoc(doc) {
    if (!doc || !doc.sqlInfo) return;
    const id = doc.sqlInfo.id;
    doc.sqlInfo = null;
    try {
        if (deps.backend.SQLClose) Promise.resolve(deps.backend.SQLClose(id)).catch(() => {});
    } catch (e) {}
}

// SQL 查询是可开关的覆盖层（类似搜索栏）：打开时盖在当前视图上，视图选中态不变；
// 关闭时直接移除覆盖层，底层视图原样恢复，无需重新解析。
function enterSqlView(doc) {
    if (!doc || !deps.isSqlSupportedDoc(doc) || !doc.editor) return;
    if (doc.splitActive) deps.exitSplitView(doc);
    doc.sqlSourceMode = deps.currentMode;
    doc.pane.classList.add('sql-active');
    doc.sqlActive = true;
    createSqlView(doc);
    deps.updateStatus();
    deps.updateSearchState();
    if (!doc.sqlInfo) importSqlDoc(doc, false);
    else if (doc.dirty) sqlSetStatus(doc, '文件有未保存修改；点「重新导入」可生效', false);
    setTimeout(() => {
        if (doc.sqlEl && doc.sqlEl.input) doc.sqlEl.input.focus();
    }, 0);
}

function closeSqlView(doc) {
    if (!doc || !doc.sqlActive || !doc.pane) return;
    doc.pane.classList.remove('sql-active');
    doc.sqlActive = false;
    deps.updateStatus();
    deps.updateSearchState();
}

    return {
        sqlKindFor,
        createSqlView,
        renderSqlResult,
        disposeSqlDoc,
        closeSqlView,
        enterSqlView,
    };
}
