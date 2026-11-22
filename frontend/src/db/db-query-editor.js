// db-query-editor.js：SQL 控制台——输入 + 执行/取消 + 确认横幅 + 结果表。
// 会话绑定由 db-page.js 切换（查询随连接会话走，不另开标签页，方案 §5.1 决策 2）。
// 危险/缺 WHERE 语句走两阶段确认：Status=confirm 时出横幅，确认后带 confirmed=true 重发。

import {iconSvg} from '../core/icons.js';
import {createTextarea, createSelect} from '../core/form-controls.js';
import {createDbGrid} from './db-grid-core.js';
import {formatElapsed, confirmReasonLabel} from './db-model.js';

export function createDbQueryEditor(deps) {

const el = document.createElement('div');
el.className = 'db-query';

let session = null;
let runningQueryID = 0; // 自增查询号：取消与两阶段确认都对准这一次
let lastSQL = '';   // 被确认横幅锁定的语句：确认执行只跑这条（编辑输入框即失效）

// 工具行：执行 / 取消 / 行数上限
const toolbar = document.createElement('div');
toolbar.className = 'db-query-toolbar';
const runBtn = document.createElement('button');
runBtn.type = 'button';
runBtn.className = 'db-btn primary';
runBtn.innerHTML = iconSvg('play', 12) + '<span>执行</span>';
runBtn.dataset.tip = '执行（Ctrl+Enter）';
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
// 走设置页同款浮层增强（原生 select 仍是值真源）；db-limit-select 只管宽度
if (typeof deps.enhanceSelect === 'function') deps.enhanceSelect(limitSel.element);
limitSel.element.classList.add('db-limit-select');
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
// 横幅弹出后改动输入框 = 被锁定的语句作废，横幅收起，重新执行走完整分类
sqlInput.control.addEventListener('input', () => {
    if (!confirmBar.classList.contains('hidden')) hideConfirm();
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
    lastSQL = '';
    confirmBar.classList.add('hidden');
    status.textContent = s ? '' : '没有活动连接';
}

function setRunning(running) {
    runBtn.disabled = running;
    cancelBtn.hidden = !running;
}

function showConfirm(reason, message) {
    confirmMsg.textContent = '【' + confirmReasonLabel(reason) + '】' + (message || '');
    confirmBar.classList.remove('hidden');
}

function hideConfirm() {
    lastSQL = ''; // 横幅失效 = 锁定的语句作废（用户改了输入框或主动放弃）
    confirmBar.classList.add('hidden');
}

async function run(forceConfirm) {
    if (!session) {
        deps.flash('没有活动连接', true);
        return;
    }
    if (runBtn.disabled) return; // Ctrl+Enter 不受 disabled 按钮保护，这里显式防重入
    // 两阶段确认锁语句：确认横幅弹出后用户改了输入框，确认执行的必须是**被拦截的那条**，
    // 不能让新语句带着 confirmed=true 直通后端
    const sql = (forceConfirm && lastSQL) ? lastSQL : sqlInput.control.value.trim();
    if (!sql) return;
    hideConfirm();
    lastSQL = sql;
    const queryID = 'q' + (++runningQueryID);
    const myRun = runningQueryID;
    setRunning(true);
    status.textContent = '执行中…';
    try {
        const outcome = await deps.backend.DBQuery(session.id, queryID, sql, !!forceConfirm, Number(limitSel.control.value) || 500);
        if (myRun !== runningQueryID) return; // 已有更新的执行出发：旧结果整体丢弃
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
        if (myRun !== runningQueryID) return;
        status.textContent = '';
        resultGrid.setColumns([]);
        resultGrid.setRows([], [], 0);
        empty.hidden = false;
        empty.textContent = String(e && e.message || e);
        deps.flash('SQL 执行失败：' + (e && e.message || e), true);
    } finally {
        if (myRun === runningQueryID) setRunning(false);
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

return {el, setSession, refresh: () => resultGrid.refresh()};
}
