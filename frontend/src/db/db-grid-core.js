// db-grid-core.js：数据库结果的虚拟滚动表格——表数据网格与 SQL 控制台结果区共用。
//
// 只做「列头 + 可视窗口行渲染 + 单元格事件」，不含业务：排序/筛选/编辑状态归
// db-table-grid.js，查询状态条归 db-query-editor.js。行高固定，只渲染可视窗口 ±overscan，
// 500 行默认页 / 5000 行上限都不会整段铺 DOM。
//
// 结构：head（横向滚动随 body 同步）+ body（纵向滚动）+ canvas（占位高度）+ window（绝对定位行窗）。
// 单元格一律 textContent 写入（数据是不可信输入，不走 innerHTML）。

const ROW_HEIGHT = 26;
const OVERSCAN = 6;

export function createDbGrid(opts = {}) {
    const onCellActivate = typeof opts.onCellActivate === 'function' ? opts.onCellActivate : null;
    const onCellClick = typeof opts.onCellClick === 'function' ? opts.onCellClick : null;
    const onHeaderClick = typeof opts.onHeaderClick === 'function' ? opts.onHeaderClick : null;
    const onRowNumberClick = typeof opts.onRowNumberClick === 'function' ? opts.onRowNumberClick : null;
    const rowClassOf = typeof opts.rowClass === 'function' ? opts.rowClass : null;
    const cellClassOf = typeof opts.cellClass === 'function' ? opts.cellClass : null;
    const rowNumberLabel = opts.rowNumberLabel === false ? false : true;
    let sortColumn = '';
    let sortDesc = false;

    const el = document.createElement('div');
    el.className = 'db-grid';
    const head = document.createElement('div');
    head.className = 'db-grid-head';
    const headInner = document.createElement('div');
    headInner.className = 'db-grid-head-inner';
    head.appendChild(headInner);
    const body = document.createElement('div');
    body.className = 'db-grid-body';
    const canvas = document.createElement('div');
    canvas.className = 'db-grid-canvas';
    const win = document.createElement('div');
    win.className = 'db-grid-win';
    canvas.appendChild(win);
    body.appendChild(canvas);
    el.append(head, body);

    let columns = [];
    let rows = [];
    let nulls = [];
    let startRow = 0; // 行号展示基数（分页时 = 页内偏移 + 1）
    let template = '';

    function rebuildTemplate() {
        const n = Math.max(columns.length, 1);
        template = '44px repeat(' + n + ', minmax(130px, 1fr))';
        headInner.style.gridTemplateColumns = template;
        win.style.gridTemplateColumns = template;
        // 行窗与列头同宽：取列头自然宽度（grid minmax 展开后的值）
        headInner.style.width = '';
        win.style.width = '100%';
        // 列头
        headInner.textContent = '';
        if (rowNumberLabel) {
            const num = document.createElement('div');
            num.className = 'db-grid-hcell db-grid-num';
            num.textContent = '#';
            headInner.appendChild(num);
        }
        for (const col of columns) {
            const cell = document.createElement('div');
            cell.className = 'db-grid-hcell' + (col === sortColumn ? (sortDesc ? ' sort-desc' : ' sort-asc') : '');
            cell.textContent = col;
            cell.title = col;
            if (onHeaderClick) {
                cell.addEventListener('click', () => onHeaderClick(col));
            }
            headInner.appendChild(cell);
        }
    }

    function buildRow(rowIdx) {
        const row = rows[rowIdx];
        const rowNulls = nulls[rowIdx] || [];
        const elRow = document.createElement('div');
        elRow.className = 'db-grid-row' + (rowClassOf ? ' ' + (rowClassOf(rowIdx) || '') : '');
        if (rowNumberLabel) {
            const num = document.createElement('div');
            num.className = 'db-grid-cell db-grid-num';
            num.textContent = String(startRow + rowIdx + 1);
            if (onRowNumberClick) {
                num.addEventListener('click', () => onRowNumberClick(rowIdx));
            }
            elRow.appendChild(num);
        }
        for (let c = 0; c < columns.length; c++) {
            const cell = document.createElement('div');
            const isNull = !!(rowNulls && rowNulls[c]);
            cell.className = 'db-grid-cell' + (isNull ? ' db-null' : '') +
                (cellClassOf ? ' ' + (cellClassOf(rowIdx, c) || '') : '');
            cell.textContent = isNull ? 'NULL' : row[c];
            if (onCellActivate || onCellClick) {
                cell.addEventListener('click', () => {
                    if (onCellClick) onCellClick(rowIdx, c, cell);
                });
                cell.addEventListener('dblclick', () => {
                    if (onCellActivate) onCellActivate(rowIdx, c, cell);
                });
            }
            elRow.appendChild(cell);
        }
        return elRow;
    }

    function renderWindow() {
        const viewH = body.clientHeight || 0;
        const scrollY = body.scrollTop;
        const first = Math.max(0, Math.floor(scrollY / ROW_HEIGHT) - OVERSCAN);
        const last = Math.min(rows.length, Math.ceil((scrollY + viewH) / ROW_HEIGHT) + OVERSCAN);
        win.style.transform = 'translateY(' + first * ROW_HEIGHT + 'px)';
        win.textContent = '';
        for (let i = first; i < last; i++) {
            win.appendChild(buildRow(i));
        }
    }

    body.addEventListener('scroll', () => {
        headInner.style.transform = 'translateX(' + (-body.scrollLeft) + 'px)';
        renderWindow();
    });

    return {
        el,
        /** 设置列并重建列头。 */
        setColumns(cols) {
            columns = cols || [];
            rebuildTemplate();
            renderWindow();
        },
        /** 设置数据行（startRow：行号展示基数，0 起）。 */
        setRows(data, nullMatrix, base = 0) {
            rows = data || [];
            nulls = nullMatrix || [];
            startRow = Number(base) || 0;
            canvas.style.height = rows.length * ROW_HEIGHT + 'px';
            body.scrollTop = 0;
            headInner.style.transform = 'translateX(0)';
            renderWindow();
        },
        /** 外部数据变化后重绘（如单元格编辑态）。 */
        refresh() {
            renderWindow();
        },
        /** 排序标记（列名 + 方向；空串清除）。 */
        setSort(col, desc) {
            sortColumn = col || '';
            sortDesc = !!desc;
            rebuildTemplate();
            renderWindow();
        },
        /** 行数（供空态判断）。 */
        rowCount() {
            return rows.length;
        },
    };
}
