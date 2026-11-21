// db-query-editor.js：SQL 控制台——输入 + 执行/取消 + 确认横幅 + 结果表。
// 会话绑定由 db-page.js 切换（查询随连接会话走，不另开标签页，方案 §5.1 决策 2）。
// 危险/缺 WHERE 语句走两阶段确认：Status=confirm 时出横幅，确认后带 confirmed=true 重发。

import {iconSvg} from '../core/icons.js';
import {createTextarea, createSelect} from '../core/form-controls.js';
import {overlayStack} from '../core/overlay-stack.js';
import {createDbGrid} from './db-grid-core.js';
import {formatElapsed, confirmReasonLabel} from './db-model.js';

export function createDbQueryEditor(deps) {

const el = document.createElement('div');
el.className = 'db-query';

let session = null;
let runningQueryID = 0; // 自增查询号：取消与两阶段确认都对准这一次
let lastSQL = '';
let lastConfirm = '';
let confirmed = false;

// 工具行：执行 / 取消 / 行数上限
const toolbar = document.createElement('div');
toolbar.className = 'db-query-toolbar';
const runBtn = document.createElement('button');
runBtn.type = 'button';
runBtn.className = 'db-btn primary';
runBtn.innerHTML = iconSvg('play', 12) + '<span>执行</span><kbd>Ctrl+Enter</kbd>';
const cancelBtn = document.createElement('button');
cancelBtn.type = 'button';
cancelBtn.className = 'db-btn';
cancelBtn.textContent = '取消';
cancelBtn.hidden = true;
const limitSel = createSelect({
    options: [
        {value: '100', label: '100 行'},
        {value: '500', label: '500 行', selected: true},
        {value: '2000', label: '2000 行'},
        {value: '5000', label: '5000 行'},
    ],
    title: '结果行数上限',
});
limitSel.element.className = 'db-limit-select';
toolbar.append(runBtn, cancelBtn, limitSel.element);

// 确认横幅（两阶段确认）
const confirmBar = document.createElement('div');
confirmBar.className = 'db-query-confirm hidden';
const confirmMsg = document.createElement('span');
confirmMsg.className = 'db-query-confirm-msg';
const confirmOk = document.createElement('button');
confirmOk.type = 'button';
confirmOk.className = 'db-btn danger';
confirmOk.textContent = '确认执行';
const confirmNo = document.createElement('button');
confirmNo.type = 'button';
confirmNo.className = 'db-btn';
confirmNo.textContent = '放弃';
confirmBar.append(confirmMsg, confirmOk, confirmNo);

// SQL 输入（form-controls 统一封装，禁裸 textarea）
const sqlInput = createTextarea({
    rows: 5,
    placeholder: 'SELECT … （Ctrl+Enter 执行；多条语句逐条分类，任一条非只读即整批拒）',
    spellcheck: false,
});
sqlInput.control.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
        ev.preventDefault();
        run(false);
    }
});

// 状态条 + 结果
const status = document.createElement('div');
status.className = 'db-query-status';
const resultGrid = createDbGrid({rowNumberLabel: true});
const empty = document.createElement('div');
empty.className = 'db-query-empty';
empty.textContent = '连接会话的查询结果在这里显示；选中对象树里的表也可直接浏览数据。';

el.append(toolbar, confirmBar, sqlInput.element, status, resultGrid.el, empty);

function setSession(s) {
    session = s;
    lastConfirm = '';
    confirmed = false;
    confirmBar.classList.add('hidden');
    status.textContent = s ? '' : '没有活动连接';
}

function setRunning(running) {
    runBtn.disabled = running;
    cancelBtn.hidden = !running;
}

function showConfirm(reason, message) {
    lastConfirm = reason;
    confirmed = false;
    confirmMsg.textContent = '【' + confirmReasonLabel(reason) + '】' + (message || '');
    confirmBar.classList.remove('hidden');
}

function hideConfirm() {
    lastConfirm = '';
    confirmed = false;
    confirmBar.classList.add('hidden');
}

async function run(forceConfirm) {
    if (!session) {
        deps.flash('没有活动连接', true);
        return;
    }
    const sql = sqlInput.control.value.trim();
    if (!sql) return;
    hideConfirm();
    const queryID = 'q' + (++runningQueryID);
    setRunning(true);
    status.textContent = '执行中…';
    try {
        const outcome = await deps.backend.DBQuery(session.id, queryID, sql, !!forceConfirm, Number(limitSel.control.value) || 500);
        if (outcome && outcome.status === 'confirm') {
            showConfirm(outcome.confirm, outcome.message);
            status.textContent = '已拦截，等待确认';
            return;
        }
        const r = (outcome && outcome.result) || {};
        resultGrid.setColumns(r.columns || []);
        resultGrid.setRows(r.rows || [], r.nulls || [], 0);
        empty.hidden = (r.columns || []).length > 0 || !!(r.message);
        const parts = [];
        if (outcome && outcome.statements) parts.push(outcome.statements + ' 条语句');
        if (r.rows && r.rows.length) parts.push(r.rows.length + ' 行' + (r.truncated ? '（截断）' : ''));
        if (r.message) parts.push(r.message);
        parts.push(formatElapsed(r.elapsedMs));
        status.textContent = parts.join(' · ');
        // 写语句留痕：连接/库/类型摘要，不含参数值（方案 §5.3）
        if (outcome && outcome.writes > 0 && deps.logActivity) {
            deps.logActivity('db.exec', sessionLabel(session), {kind: session.kind, writes: outcome.writes, statements: outcome.statements});
        }
    } catch (e) {
        status.textContent = '';
        resultGrid.setColumns([]);
        resultGrid.setRows([], [], 0);
        empty.hidden = false;
        empty.textContent = String(e && e.message || e);
        deps.flash('SQL 执行失败：' + (e && e.message || e), true);
    } finally {
        setRunning(false);
    }
}

function sessionLabel(s) {
    return s ? (s.kind + ':' + s.name + (s.server ? '@' + s.server : '')) : '';
}

runBtn.addEventListener('click', () => run(false));
cancelBtn.addEventListener('click', () => {
    if (!session) return;
    deps.backend.DBCancel(session.id, 'q' + runningQueryID).catch(() => {});
});
confirmOk.addEventListener('click', () => run(true));
confirmNo.addEventListener('click', hideConfirm);

return {el, setSession};
}
