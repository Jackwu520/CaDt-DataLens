// git-graph-dialogs.js：Git 图谱的三个操作对话框——新建分支（IDEA 图4）、
// 分支重置（软/混合/硬三选一，图6）、签出冲突（强制/智能/不签出，图5）。
// 自持遮罩的轻量模态：不进全局设置对话框栈（图谱是底部面板域，生命周期自成一体），
// Esc / 遮罩点击 / 取消按钮一律按取消收场。
// 写操作是用户主动 UI 动作：走只读锁（调用方把关），不涉 AI 审批链。
import {iconSvg} from '../core/icons.js';
import {createInput, createSwitch} from '../core/form-controls.js';

export function createGitGraphDialogs(ctx) {

    // ---- 模态骨架 ----

    // openModal 建一个自持遮罩的模态卡片，返回 {card, close}。
    function openModal(title) {
        const overlay = document.createElement('div');
        overlay.className = 'gg-modal-overlay';
        const card = document.createElement('div');
        card.className = 'gg-modal';
        const head = document.createElement('div');
        head.className = 'gg-modal-head';
        const titleEl = document.createElement('div');
        titleEl.className = 'gg-modal-title';
        titleEl.textContent = title;
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'gg-modal-x';
        closeBtn.setAttribute('aria-label', '关闭');
        closeBtn.innerHTML = iconSvg('close', 14);
        closeBtn.addEventListener('click', close);
        head.append(titleEl, closeBtn);
        card.appendChild(head);
        overlay.appendChild(card);
        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close();
            }
        };
        window.addEventListener('keydown', onKey, true);
        overlay.addEventListener('mousedown', (e) => {
            if (e.target === overlay) close();
        });
        document.body.appendChild(overlay);
        return {card, close};

        function close() {
            overlay.remove();
            window.removeEventListener('keydown', onKey, true);
        }
    }

    // mkFooter 在卡片底部生成按钮行：[{label, primary, danger, onClick}]
    function mkFooter(card, buttons) {
        const foot = document.createElement('div');
        foot.className = 'gg-modal-foot';
        for (const b of buttons) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'gg-modal-btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '');
            btn.textContent = b.label;
            btn.addEventListener('click', b.onClick);
            foot.appendChild(btn);
        }
        card.appendChild(foot);
        return foot;
    }

    function mkErr(card) {
        const err = document.createElement('div');
        err.className = 'gg-modal-err hidden';
        card.appendChild(err);
        return err;
    }

    function showErr(err, msg) {
        err.textContent = msg;
        err.classList.remove('hidden');
    }

    // ---- 新建分支（IDEA 图4：分支名 + 签出分支勾选 + 创建/取消） ----
    function openBranchDialog(c, onDone) {
        const {card, close} = openModal('从 ' + (c.sha || '').slice(0, 7) + ' 创建分支');
        const row = document.createElement('div');
        row.className = 'gg-modal-row';
        const label = document.createElement('span');
        label.className = 'gg-modal-label';
        label.textContent = '分支名称:';
        const nameInput = createInput({placeholder: '分支名称…', spellcheck: false, autocomplete: 'off'});
        row.append(label, nameInput.element);
        card.appendChild(row);

        const checkRow = document.createElement('div');
        checkRow.className = 'gg-modal-row gg-modal-check';
        const sw = createSwitch({checked: true});
        const swLabel = document.createElement('span');
        swLabel.textContent = '签出分支';
        checkRow.append(sw.element, swLabel);
        card.appendChild(checkRow);

        const err = mkErr(card);
        const submit = async () => {
            const name = (nameInput.control.value || '').trim();
            if (!name) {
                showErr(err, '请填写分支名称');
                return;
            }
            try {
                const res = await ctx.backend.GitGraphCreateBranch(ctx.gitDir(), name, c.sha, sw.control.checked);
                if (res && res.success) {
                    close();
                    ctx.flash('已创建分支 ' + name);
                    if (onDone) onDone(name);
                } else {
                    showErr(err, (res && res.output) || '创建失败');
                }
            } catch (e) {
                showErr(err, '创建失败：' + e);
            }
        };
        nameInput.control.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submit();
            }
        });
        mkFooter(card, [
            {label: '创建', primary: true, onClick: submit},
            {label: '取消', onClick: close},
        ]);
        setTimeout(() => nameInput.control.focus(), 0);
    }

    // ---- 分支重置（IDEA 图6：当前分支 -> 提交，软/混合/硬三选一 + 说明） ----
    const RESET_MODES = [
        {mode: 'soft', name: '软', desc: '文件不会更改，差异将暂存以待提交。'},
        {mode: 'mixed', name: '混合', desc: '文件不会更改，差异也不进行暂存。'},
        {mode: 'hard', name: '硬', desc: '文件将还原为所选提交的状态。', warn: '警告: 任何本地更改都将丢失。'},
    ];
    function openResetDialog(c, onDone) {
        const {card, close} = openModal('Git 重置');
        const branch = (ctx.state.refs && ctx.state.refs.current) || 'HEAD';
        const sub = document.createElement('div');
        sub.className = 'gg-modal-sub';
        sub.textContent = branch + ' -> ' + (c.sha || '').slice(0, 8) + ' "' + (c.subject || '') + '"，作者 ' + (c.author || '');
        card.appendChild(sub);

        const desc = document.createElement('div');
        desc.className = 'gg-modal-desc';
        desc.textContent = '这会将当前分支 HEAD 重置为所选提交，并根据所选模式更新工作区和索引:';
        card.appendChild(desc);

        let picked = 'mixed';
        const group = document.createElement('div');
        group.className = 'gg-reset-options';
        const rows = [];
        for (const m of RESET_MODES) {
            const rowEl = document.createElement('button');
            rowEl.type = 'button';
            rowEl.className = 'gg-reset-opt' + (m.mode === 'hard' ? ' danger' : '');
            const radio = document.createElement('span');
            radio.className = 'gg-reset-radio' + (m.mode === picked ? ' on' : '');
            const box = document.createElement('span');
            box.className = 'gg-reset-opt-box';
            const nameEl = document.createElement('span');
            nameEl.className = 'gg-reset-opt-name';
            nameEl.textContent = m.name;
            const descEl = document.createElement('span');
            descEl.className = 'gg-reset-opt-desc';
            descEl.textContent = m.desc;
            box.append(nameEl, descEl);
            if (m.warn) {
                const warnEl = document.createElement('span');
                warnEl.className = 'gg-reset-opt-warn';
                warnEl.textContent = m.warn;
                box.appendChild(warnEl);
            }
            rowEl.append(radio, box);
            rowEl.addEventListener('click', () => {
                picked = m.mode;
                for (const r of rows) r.firstChild.classList.toggle('on', r.dataset.mode === picked);
            });
            rowEl.dataset.mode = m.mode;
            rows.push(rowEl);
            group.appendChild(rowEl);
        }
        card.appendChild(group);

        const err = mkErr(card);
        mkFooter(card, [
            {
                label: '重置',
                primary: true,
                danger: picked === 'hard',
                onClick: async () => {
                    try {
                        const res = await ctx.backend.GitGraphReset(ctx.gitDir(), c.sha, picked);
                        if (res && res.success) {
                            close();
                            ctx.flash('已重置（' + picked + '）到 ' + (c.sha || '').slice(0, 7));
                            if (onDone) onDone();
                        } else {
                            showErr(err, (res && res.output) || '重置失败');
                        }
                    } catch (e) {
                        showErr(err, '重置失败：' + e);
                    }
                },
            },
            {label: '取消', onClick: close},
        ]);
    }

    // ---- 签出冲突（IDEA 图5：列出会被覆盖的文件，强制/智能/不签出） ----
    function openCheckoutConflict(c, files, onDone) {
        const {card, close} = openModal('Git 签出 问题');
        const text = document.createElement('div');
        text.className = 'gg-modal-desc';
        text.textContent = '您对以下 ' + files.length + ' 个文件的本地更改将被签出覆盖。可以暂搁这些更改并签出（智能签出），之后自动恢复。';
        card.appendChild(text);

        const list = document.createElement('div');
        list.className = 'gg-conflict-list';
        for (const f of files) {
            const item = document.createElement('div');
            item.className = 'gg-conflict-file';
            item.textContent = f;
            list.appendChild(item);
        }
        card.appendChild(list);

        const err = mkErr(card);
        const run = (kind) => async () => {
            const bind = kind === 'force' ? ctx.backend.GitGraphCheckoutForce : ctx.backend.GitGraphCheckoutSmart;
            try {
                const res = await bind(ctx.gitDir(), c.sha);
                if (res && res.success) {
                    close();
                    const note = kind === 'smart' && /仍保留在 stash/.test(res.output || '') ? '（有改动保留在 stash）' : '';
                    ctx.flash('已签出 ' + ((res.branch) || (c.sha || '').slice(0, 7)) + note);
                    if (onDone) onDone();
                } else {
                    showErr(err, (res && res.output) || '签出失败');
                }
            } catch (e) {
                showErr(err, '签出失败：' + e);
            }
        };
        mkFooter(card, [
            {label: '强制签出', danger: true, onClick: run('force')},
            {label: '智能签出', primary: true, onClick: run('smart')},
            {label: '不签出', onClick: close},
        ]);
    }

    return {openBranchDialog, openResetDialog, openCheckoutConflict};
}
