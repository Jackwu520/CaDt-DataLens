// db-create-table.js：结构化「新建表」表单——SQLite editable 会话从零建表（方案 §11.9）。
// 生成 CREATE TABLE 走控制台同一条 DBQuery 通道（guard 分类、editable 门、DDL 能力位全部生效），
// 不做旁路；表名/列名先做保守校验（字母数字下划线、不以数字开头），双引号包裹只是兜底。
// 弹层收口与 db-ui 的插件表单同款：close() 与 onClose 双路径自清理（dispose() 不触发 onClose）。

import {iconSvg} from '../core/icons.js';
import {createInput, createSelect, createSwitch} from '../core/form-controls.js';
import {overlayStack} from '../core/overlay-stack.js';

export const COLUMN_TYPES = ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC'];

// isValidIdent 保守标识符校验（SQLite 关键字冲突也一并避开——双引号虽能包，但明防线更直观）
export function isValidIdent(name) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ''));
}

// buildCreateTableSQL 纯函数：单主键放列内（INTEGER 主键可吃到 rowid 别名），
// 复合主键用表级 PRIMARY KEY 声明；主键列隐含 NOT NULL。
export function buildCreateTableSQL(table, columns) {
    if (!isValidIdent(table)) {
        throw new Error('表名只能是字母、数字、下划线，且不以数字开头');
    }
    if (!Array.isArray(columns) || !columns.length) {
        throw new Error('至少要有一列');
    }
    const seen = new Set();
    for (const c of columns) {
        if (!isValidIdent(c.name)) {
            throw new Error('列名只能是字母、数字、下划线，且不以数字开头：' + JSON.stringify(c.name));
        }
        if (seen.has(c.name)) {
            throw new Error('列名重复：' + c.name);
        }
        seen.add(c.name);
        if (!COLUMN_TYPES.includes(c.type)) {
            throw new Error('不支持的列类型：' + c.type);
        }
    }
    const pks = columns.filter((c) => c.pk);
    if (pks.length > 1) {
        // 复合主键：列内不写 PRIMARY KEY（SQLite 只允许一个主键声明），统一表级声明
        const defs = columns.map((c) => {
            const parts = ['"' + c.name + '"', c.type];
            if (c.notNull || c.pk) parts.push('NOT NULL');
            return parts.join(' ');
        });
        defs.push('PRIMARY KEY (' + pks.map((c) => '"' + c.name + '"').join(', ') + ')');
        return 'CREATE TABLE "' + table + '" (' + defs.join(', ') + ')';
    }
    const defs = columns.map((c) => {
        const parts = ['"' + c.name + '"', c.type];
        if (c.notNull || c.pk) parts.push('NOT NULL');
        if (c.pk) parts.push('PRIMARY KEY');
        return parts.join(' ');
    });
    return 'CREATE TABLE "' + table + '" (' + defs.join(', ') + ')';
}

// openCreateTableForm 结构化建表弹层。deps：
//   backend（会话门面或宿主绑定）、info（SessionInfo）、logActivity?、onCreated(table)?（成功后刷新清单）
export function openCreateTableForm({backend, info, logActivity, onCreated}) {
    const panel = document.createElement('div');
    panel.className = 'db-preview db-conn-dialog';
    const head = document.createElement('div');
    head.className = 'db-preview-head';
    head.textContent = '新建表 · ' + (info && info.name || 'SQLite');
    const form = document.createElement('div');
    form.className = 'db-conn-form';

    const nameInput = createInput({placeholder: '表名（字母数字下划线）', spellcheck: false});
    formRow('表名', nameInput.element);

    const colList = document.createElement('div');
    colList.className = 'db-ct-cols';
    form.appendChild(colList);
    const addColBtn = document.createElement('button');
    addColBtn.type = 'button';
    addColBtn.className = 'db-btn';
    addColBtn.innerHTML = iconSvg('plus', 11) + '<span>加一列</span>';
    addColBtn.addEventListener('click', () => addColumnRow());
    form.appendChild(addColBtn);

    // 列行控件引用：读取走闭包引用，不猜 DOM 结构
    const colRefs = [];

    function formRow(label, control) {
        const row = document.createElement('label');
        row.className = 'db-conn-rowline';
        const text = document.createElement('span');
        text.className = 'db-conn-label';
        text.textContent = label;
        row.append(text, control);
        form.appendChild(row);
    }

    function wrapFlag(label, el) {
        const wrap = document.createElement('label');
        wrap.className = 'db-ct-flag';
        wrap.title = label;
        const text = document.createElement('span');
        text.textContent = label;
        wrap.append(el, text);
        return wrap;
    }

    function addColumnRow(initial) {
        const row = document.createElement('div');
        row.className = 'db-ct-row';
        const name = createInput({placeholder: '列名', spellcheck: false, value: initial && initial.name || ''});
        const type = createSelect({options: COLUMN_TYPES.map((t) => ({value: t, label: t, selected: t === (initial && initial.type || 'TEXT')}))});
        const pk = createSwitch({checked: !!(initial && initial.pk)});
        const notNull = createSwitch({checked: !!(initial && initial.notNull)});
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'db-tree-act';
        rm.title = '删除此列';
        rm.innerHTML = iconSvg('close', 11);
        const refs = {row, name, type, pk, notNull};
        colRefs.push(refs);
        rm.addEventListener('click', () => {
            const at = colRefs.indexOf(refs);
            if (at >= 0) colRefs.splice(at, 1);
            row.remove();
            if (!colRefs.length) addColumnRow();
        });
        row.append(name.element, type.element, wrapFlag('主键', pk.element), wrapFlag('必填', notNull.element), rm);
        colList.appendChild(row);
    }

    addColumnRow({name: 'id', type: 'INTEGER', pk: true});
    addColumnRow({name: 'name', type: 'TEXT'});

    const foot = document.createElement('div');
    foot.className = 'db-preview-foot';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'db-btn';
    cancelBtn.textContent = '取消';
    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'db-btn primary';
    createBtn.textContent = '创建';
    foot.append(cancelBtn, createBtn);
    const msgEl = document.createElement('div');
    msgEl.className = 'db-ds-msg';
    const setMsg = (text, kind) => {
        msgEl.textContent = String(text || '');
        msgEl.className = 'db-ds-msg' + (kind ? ' ' + kind : '');
    };
    panel.append(head, form, msgEl, foot);

    // 遮罩弹层（overlayStack 注册）。close() 必须自己做 DOM 清理——dispose() 不触发
    // onClose，只 dispose 会把 mask 留在 DOM（与 db-connections.js 同款收口）
    const mask = document.createElement('div');
    mask.className = 'db-preview-mask';
    mask.appendChild(panel);
    let handle = null;
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        mask.remove();
        panel.remove();
    };
    const close = () => {
        if (cleaned) return;
        if (handle) handle.dispose();
        cleanup();
    };
    handle = overlayStack.open({
        id: 'db-create-table',
        kind: 'dialog',
        el: panel,
        underEl: mask,
        onClose: () => {
            // Esc 路径：先出栈再清 DOM（dispose 不触发 onClose，无递归）
            if (handle) handle.dispose();
            cleanup();
        },
    });
    document.body.appendChild(mask);
    mask.addEventListener('click', (ev) => {
        if (ev.target === mask) close();
    });
    cancelBtn.addEventListener('click', close);

    createBtn.addEventListener('click', async () => {
        createBtn.disabled = true;
        const columns = colRefs.map((r) => ({
            name: r.name.control.value.trim(),
            type: r.type.control.value,
            pk: r.pk.control.checked,
            notNull: r.notNull.control.checked,
        }));
        let sql = '';
        try {
            sql = buildCreateTableSQL(nameInput.control.value.trim(), columns);
        } catch (e) {
            createBtn.disabled = false;
            setMsg(e.message, 'error');
            return;
        }
        try {
            const out = await backend.DBQuery(info.id, 'ct' + Date.now(), sql, false, 1);
            if (out && out.status === 'confirm') {
                createBtn.disabled = false;
                setMsg('语句被拦截等待确认（CREATE 非危险语句，不应出现）——请改用控制台执行', 'error');
                return;
            }
            if (logActivity) {
                logActivity('db.exec', info.kind + ':' + info.name + '/CREATE TABLE ' + sql.match(/"([^"]+)"/)[1],
                    {kind: info.kind, writes: out && out.writes || 0, statements: 1});
            }
            cleanup();
            if (onCreated) onCreated();
        } catch (e) {
            createBtn.disabled = false;
            setMsg('建表失败：' + (e && e.message || e), 'error');
        }
    });
    nameInput.control.focus();
}
