// db-grid-core.js：数据库结果的虚拟滚动表格——表数据网格与 SQL 控制台结果区共用。
//
// 只做「列头 + 可视窗口行渲染 + 单元格事件」，不含业务：排序/筛选/编辑状态归
// db-table-grid.js，查询状态条归 db-query-editor.js。行高固定，只渲染可视窗口 ±overscan，
// 500 行默认页 / 5000 行上限都不会整段铺 DOM。
//
// 结构：head（横向滚动随 body 同步）+ body（纵向滚动）+ canvas（占位高度）+ window（绝对定位行窗）。
// 单元格一律 textContent 写入（数据是不可信输入，不走 innerHTML）。

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
    let rowHeight = opts.rowHeight || 26; // 行高档位（紧凑/常规/宽松），setRowHeight 切换
    const colWidths = new Map(); // 列下标 → px（拖拽调整；未拖过的列保持 minmax 弹性）

    const el = document.createElement('div');
    el.className = 'db-grid';
    el.style.setProperty('--db-grid-rowh', rowHeight + 'px');
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

    function columnTrack(i) {
        // 拖拽过的列用固定 px，其余保持 minmax 弹性
        if (colWidths.has(i)) return colWidths.get(i) + 'px';
        return 'minmax(130px, 1fr)';
    }

    function rebuildTemplate() {
        const n = Math.max(columns.length, 1);
        const tracks = [];
        for (let i = 0; i < n; i++) tracks.push(columnTrack(i));
        template = '44px ' + tracks.join(' ');
        // 列模板挂在网格根的 CSS 变量上，表头与每个行窗内的行继承同一份
        // （行是动态重建的，无法逐个 style 赋值；直接设在 win 上管不到行内部的 grid）
        el.style.setProperty('--db-grid-cols', template);
        headInner.style.gridTemplateColumns = 'var(--db-grid-cols)';
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
        for (let ci = 0; ci < columns.length; ci++) {
            const col = columns[ci];
            const cell = document.createElement('div');
            cell.className = 'db-grid-hcell' + (col === sortColumn ? (sortDesc ? ' sort-desc' : ' sort-asc') : '');
            cell.textContent = col;
            cell.title = col;
            if (onHeaderClick) {
                cell.addEventListener('click', (ev) => {
                    // 拖拽手柄的 click 不触发排序（拖完松手落把手处会被当成点击）
                    if (ev.target.closest('.db-grid-colresize')) return;
                    onHeaderClick(col);
                });
            }
            // 列宽拖拽手柄：右缘 5px 命中区，横向拖动 = 调列宽（行窗与列头同模板联动）
            const grip = document.createElement('span');
            grip.className = 'db-grid-colresize';
            grip.addEventListener('mousedown', (ev) => startColResize(ev, ci));
            grip.addEventListener('dblclick', (ev) => {
                ev.stopPropagation();
                colWidths.delete(ci);
                rebuildTemplate();
                renderWindow();
            });
            cell.appendChild(grip);
            headInner.appendChild(cell);
        }
    }

    function startColResize(ev, ci) {
        ev.preventDefault();
        ev.stopPropagation();
        const startX = ev.clientX;
        const startW = colWidths.get(ci) || (ev.target.closest('.db-grid-hcell') || {}).offsetWidth || 130;
        const onMove = (e2) => {
            const w = Math.max(56, startW + e2.clientX - startX);
            colWidths.set(ci, w);
            const tracks = [];
            for (let i = 0; i < Math.max(columns.length, 1); i++) tracks.push(columnTrack(i));
            el.style.setProperty('--db-grid-cols', '44px ' + tracks.join(' '));
            headInner.style.gridTemplateColumns = 'var(--db-grid-cols)';
            renderWindow();
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
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
        const first = Math.max(0, Math.floor(scrollY / rowHeight) - OVERSCAN);
        const last = Math.min(rows.length, Math.ceil((scrollY + viewH) / rowHeight) + OVERSCAN);
        win.style.transform = 'translateY(' + first * rowHeight + 'px)';
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
        /**
         * 设置数据行（startRow：行号展示基数，0 起）。
         * keepScroll=true 保留纵向滚动位置（单元格编辑等本地状态变化；换页/换表走默认滚顶）。
         */
        setRows(data, nullMatrix, base = 0, keepScroll = false) {
            const prevScroll = body.scrollTop;
            rows = data || [];
            nulls = nullMatrix || [];
            startRow = Number(base) || 0;
            canvas.style.height = rows.length * rowHeight + 'px';
            body.scrollTop = keepScroll ? prevScroll : 0;
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
        /** 行高（紧凑 22 / 常规 26 / 宽松 32）：canvas 高度与可视窗口重算，行内文字随之居中 */
        setRowHeight(h) {
            rowHeight = Math.max(18, Number(h) || 26);
            el.style.setProperty('--db-grid-rowh', rowHeight + 'px');
            canvas.style.height = rows.length * rowHeight + 'px';
            renderWindow();
        },
        /** 行数（供空态判断）。 */
        rowCount() {
            return rows.length;
        },
    };
}
