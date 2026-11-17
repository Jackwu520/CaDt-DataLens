// ai-group-sidebar.js：AI 侧栏「会话 | 群聊」分段、群聊列表与新建群聊弹窗（含兼容性预检）。
// 列表只读 meta（快照来自 runtime.subscribe）；创建弹窗用面板对话框三件套，
// 表单控件一律走 core/form-controls.js（表单控件硬规范）。
// 预检纯函数与内置主持人模板在 ai-group-model.js。
import {createInput, createSelect, createSwitch, createTextarea} from '../core/form-controls.js';
import {iconSvg} from '../core/icons.js';
import {aiNowId} from './ai-constants.js';
import {AGENT_COLOR_HEX} from './ai-agent-model.js';
import {agentsUpsert} from './ai-agent-model.js';
import {
    BRIEF_BOARD_TOKEN_BUDGET,
    BUILTIN_CHAIR,
    CHAIR_KINDS,
    CHAIR_POLICIES,
    GROUP_GOALS,
    estimateDiscussionCalls,
    preflightGroup,
} from './ai-group-model.js';

export function createAIGroupSidebar(deps) {
    const runtime = deps.runtime;
    const getAIConfig = deps.getAIConfig || (() => null);
    const saveConfig = deps.saveConfig || (() => {});
    const flash = deps.flash || (() => {});
    const dialog = deps.dialog || {};
    const openDialog = dialog.open || (() => {});
    const closeDialog = dialog.close || (() => {});
    const node = dialog.node || ((tag, className, text) => {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text != null) el.textContent = text;
        return el;
    });
    const dialogButton = dialog.button || null;
    const enhanceSelect = dialog.enhanceSelect || null;
    // 弹窗左下角齿轮：直达 设置 → AI → 智能体（宿主注入 openSettings）
    const openSettings = typeof deps.openSettings === 'function' ? deps.openSettings : null;

    const els = {
        segment: document.getElementById('ai-list-segment'),
        sessionList: document.getElementById('ai-session-list'),
        sessionActions: document.getElementById('ai-session-actions'),
        groupList: document.getElementById('ai-group-list'),
        groupActions: document.getElementById('ai-group-actions'),
        groupNew: document.getElementById('ai-group-action-new'),
    };

    // ---------- 分段与列表 ----------

    function bindSidebar() {
        if (els.segment && !els.segment.dataset.gcBound) {
            els.segment.dataset.gcBound = '1';
            for (const button of els.segment.querySelectorAll('button[data-list]')) {
                button.addEventListener('click', () => {
                    runtime.setListMode(button.dataset.list);
                    if (!runtime.groupList().length && button.dataset.list === 'groups') {
                        // 切到空列表时兜底刷一次（首次进入可能还没拉完）
                        runtime.refreshList().catch(() => {});
                    }
                });
            }
        }
        if (els.groupNew && !els.groupNew.dataset.gcBound) {
            els.groupNew.dataset.gcBound = '1';
            els.groupNew.addEventListener('click', () => openCreateDialog());
        }
        runtime.subscribe((snap) => {
            applyListMode(snap.listMode);
            renderGroupList(snap.groups);
        });
        applyListMode(runtime.getListMode());
        renderGroupList(runtime.groupList());
    }

    function applyListMode(mode) {
        const groups = mode === 'groups';
        if (els.segment) {
            // 分段控件的滑动指示块由 data-mode 驱动（thumb 的 transform 过渡）
            els.segment.dataset.mode = groups ? 'groups' : 'sessions';
            for (const button of els.segment.querySelectorAll('button[data-list]')) {
                button.classList.toggle('active', button.dataset.list === mode);
            }
        }
        if (els.sessionList) els.sessionList.classList.toggle('hidden', groups);
        if (els.sessionActions) els.sessionActions.classList.toggle('hidden', groups);
        if (els.groupList) els.groupList.classList.toggle('hidden', !groups);
        if (els.groupActions) els.groupActions.classList.toggle('hidden', !groups);
    }

    function renderGroupList(metas) {
        if (!els.groupList) return;
        els.groupList.innerHTML = '';
        if (!metas || !metas.length) {
            const empty = node('div', 'gc-list-empty');
            empty.textContent = '还没有群聊。新建一个圆桌，让多个智能体就一个议题多轮讨论。';
            els.groupList.appendChild(empty);
            return;
        }
        const config = getAIConfig();
        const agents = (config && Array.isArray(config.agents)) ? config.agents : [];
        for (const meta of metas) {
            els.groupList.appendChild(groupRow(meta, agents));
        }
    }

    function groupRow(meta, agents) {
        const row = node('div', 'ai-session-item gc-list-row');
        const head = node('div', 'gc-list-head');
        head.appendChild(node('span', 'gc-list-title', meta.title || '未命名群聊'));
        head.appendChild(node('span', 'gc-badge gc-badge-mode', modeLabel(meta.mode)));
        if (meta.chair && meta.chair.kind === 'user') head.appendChild(node('span', 'gc-badge', '我主持'));
        const dots = node('div', 'gc-list-dots');
        for (const id of meta.memberIds) {
            const agent = agents.find((item) => item && item.id === id);
            const dot = node('span', 'gc-dot');
            dot.style.backgroundColor = AGENT_COLOR_HEX[agent && agent.color] || '#989898';
            dot.dataset.tip = agent ? agent.name : '已删除成员';
            dots.appendChild(dot);
        }
        row.appendChild(head);
        row.appendChild(dots);
        const foot = node('div', 'gc-list-foot');
        foot.appendChild(node('span', 'gc-list-meta',
            `${goalLabel(meta.goal)} · ${meta.memberIds.length} 成员 · ${new Date(meta.updatedAt || 0).toLocaleDateString()}`));
        const del = node('button', 'gc-list-del', '删除');
        del.type = 'button';
        del.dataset.tip = '删除群聊（回收站可撤销）';
        del.addEventListener('click', (e) => {
            e.stopPropagation();
            askDeleteGroup(meta);
        });
        foot.appendChild(del);
        row.appendChild(foot);
        row.addEventListener('click', () => runtime.openGroup(meta.id));
        return row;
    }

    function modeLabel(mode) {
        return mode === 'task' ? '任务' : mode === 'free' ? '自由' : '圆桌';
    }

    function goalLabel(goal) {
        return (GROUP_GOALS.find((g) => g.id === goal) || {label: '探索'}).label;
    }

    function askDeleteGroup(meta) {
        if (typeof deps.confirm === 'function') {
            deps.confirm(`删除群聊「${meta.title || '未命名群聊'}」？共享对话与各成员私有过程一起进回收站。`, async () => {
                const result = await runtime.deleteGroup(meta.id);
                if (result.ok) flash('群聊已删除（回收站可撤销）');
            }, '删除', '删除群聊');
        } else {
            runtime.deleteGroup(meta.id);
        }
    }

    // ---------- 新建群聊弹窗 ----------

    // 弹窗控件表；collectDraft 读取。成员勾选用开关列表（form-controls 规范）。
    let createControls = null;

    function openCreateDialog() {
        const config = getAIConfig();
        const agents = (config && Array.isArray(config.agents)) ? config.agents.filter((a) => a && a.enabled) : [];
        const profiles = (config && Array.isArray(config.profiles)) ? config.profiles : [];
        if (!agents.length) {
            flash('还没有可用智能体：先到 设置 → AI → 智能体 创建成员', true);
            return;
        }

        const body = node('div', 'gc-create-form');
        // factory 是 core/form-controls 的 {element, control}：挂 .element，返回 factory 供取值
        const row = (labelText, factory, className) => {
            const wrap = node('div', 'gc-form-row' + (className ? ' ' + className : ''));
            wrap.appendChild(node('span', 'gc-form-label', labelText));
            wrap.appendChild(factory.element);
            body.appendChild(wrap);
            return factory;
        };

        const titleCtl = row('群名', createInput({value: '', placeholder: '例如：存储方案评审', maxlength: String(60)}));
        const topicCtl = row('议题', createTextarea({rows: 2, value: '', placeholder: '要讨论的问题与背景约束（进入主持人开场）'}), 'gc-form-row-top');
        const goalCtl = row('目标', createSelect({options: GROUP_GOALS.map((g) => ({value: g.id, label: g.label, selected: g.id === 'decide'}))}));
        const modeCtl = row('模式', createSelect({options: [
            {value: 'roundtable', label: '圆桌讨论（推荐）', selected: true},
            {value: 'task', label: '任务协作（主持人拆任务板）'},
        ]}));
        // 预设（§1.4）：辩论/评审给成员分配角色，发言顺序按 正 → 反 → 评审 交替
        const presetCtl = row('预设', createSelect({options: [
            {value: 'standard', label: '标准圆桌', selected: true},
            {value: 'debate', label: '辩论（正—反—评审）'},
            {value: 'review', label: '评审团'},
        ]}));

        // 成员勾选（开关列表 + 能力徽标）
        const memberWrap = node('div', 'gc-member-list');
        const memberSwitches = [];
        const roleInputs = {};
        for (const agent of agents) {
            const item = node('div', 'gc-member-item');
            const dot = node('span', 'gc-dot gc-dot-lg');
            dot.style.backgroundColor = AGENT_COLOR_HEX[agent.color] || '#989898';
            item.appendChild(dot);
            const textCol = node('div', 'gc-member-text');
            textCol.appendChild(node('div', 'set-title', agent.name));
            textCol.appendChild(node('div', 'set-desc', agent.role || agentCapabilityLabel(agent, profiles)));
            item.appendChild(textCol);
            const cap = preflightGroup({agents, profiles, memberIds: [agent.id], sharedTokens: 0, boardTokens: BRIEF_BOARD_TOKEN_BUDGET})[0];
            const badge = node('span', 'gc-badge gc-level-' + (cap ? cap.level : 'red'), cap ? capLevelText(cap.level) : '红');
            item.appendChild(badge);
            const sw = createSwitch({checked: false});
            item.appendChild(sw.element);
            // 辩论/评审预设的角色输入（勾选后显示；占位按序号给正/反/评审提示）
            const roleInput = createInput({placeholder: '角色（如 正方 / 反方 / 评审）', maxlength: '80'});
            roleInput.element.classList.add('gc-member-role');
            roleInput.element.classList.add('hidden');
            item.appendChild(roleInput.element);
            roleInputs[agent.id] = roleInput;
            memberSwitches.push({agentId: agent.id, control: sw.control, index: memberSwitches.length});
            sw.control.addEventListener('change', () => {
                roleInput.element.classList.toggle('hidden', !sw.control.checked);
                if (!sw.control.checked) roleInput.control.value = '';
                refreshDerived();
            });
            memberWrap.appendChild(item);
        }
        body.appendChild(wrapRow('成员', memberWrap, 'gc-form-row-top'));

        // 主持人
        const chairAgents = agents.filter((agent) => agent.chair);
        const chairKindCtl = row('主持', createSelect({
            options: CHAIR_KINDS.map((k) => ({value: k.id, label: k.label, selected: k.id === 'ai'})),
        }));
        const chairAgentWrap = node('div', 'gc-form-row');
        chairAgentWrap.appendChild(node('span', 'gc-form-label', '主持人'));
        let chairAgentOptions = chairAgents.map((agent) => ({value: agent.id, label: agent.name}));
        if (!chairAgentOptions.length) chairAgentOptions = [{value: '', label: '没有主持人智能体'}];
        const chairAgentCtl = createSelect({options: chairAgentOptions});
        chairAgentWrap.appendChild(chairAgentCtl.element);
        const chairCreateBtn = node('button', 'dlg-btn', '一键创建默认主持人');
        chairCreateBtn.type = 'button';
        chairCreateBtn.addEventListener('click', () => {
            const created = createDefaultChairAgent();
            if (!created.ok) {
                flash(created.error, true);
                return;
            }
            chairAgentCtl.control.innerHTML = '';
            for (const option of [{value: created.agent.id, label: created.agent.name}]) {
                const item = document.createElement('option');
                item.value = option.value;
                item.textContent = option.label;
                chairAgentCtl.control.appendChild(item);
            }
            chairCreateBtn.classList.add('hidden');
            flash('已创建默认主持人智能体（设置 → AI → 智能体 可编辑）');
        });
        if (chairAgents.length) chairCreateBtn.classList.add('hidden');
        chairAgentWrap.appendChild(chairCreateBtn);
        body.appendChild(chairAgentWrap);

        const policyCtl = row('策略', createSelect({options: CHAIR_POLICIES.map((p) => ({value: p.id, label: p.label, selected: p.id === 'round-plan'}))}));
        const roundsCtl = row('轮数', createSelect({options: [1, 2, 3].map((n) => ({value: String(n), label: n + ' 轮' + (n === 2 ? '（推荐）' : ''), selected: n === 2}))}));
        const timeoutCtl = row('超时', createSelect({options: [
            {value: 'standard', label: '标准（首次 45s / 总 180s）', selected: true},
            {value: 'lenient', label: '宽松（首次 90s / 总 300s）'},
        ]}));

        const preflightBox = node('div', 'gc-preflight');
        body.appendChild(preflightBox);
        const estLine = node('div', 'gc-est-line');
        body.appendChild(estLine);

        const statusLine = node('div', 'set-desc');
        statusLine.style.minHeight = '14px';

        createControls = {title: titleCtl, topic: topicCtl, goal: goalCtl, mode: modeCtl, preset: presetCtl,
            memberSwitches, roleInputs,
            chairKind: chairKindCtl, chairAgent: chairAgentCtl, policy: policyCtl,
            rounds: roundsCtl, timeout: timeoutCtl};

        const refreshDerived = () => {
            refreshChairVisibility();
            refreshPresetDefaults();
            refreshPreflight(preflightBox, estLine, agents, profiles);
        };
        chairKindCtl.control.addEventListener('change', refreshDerived);
        for (const sw of memberSwitches) sw.control.addEventListener('change', refreshDerived);
        modeCtl.control.addEventListener('change', refreshDerived);
        presetCtl.control.addEventListener('change', refreshDerived);
        refreshDerived();

        const cancelBtn = dialogButton('取消', 'dlg-btn', () => {
            createControls = null;
            closeDialog();
        });
        const createBtn = dialogButton('创建群聊', 'dlg-btn primary', async () => {
            const draft = collectCreateDraft();
            const result = await runtime.createGroup(draft);
            if (!result.ok) {
                statusLine.textContent = result.error || '创建失败';
                return;
            }
            createControls = null;
            closeDialog();
        });
        // 左下角齿轮：先去设置里把智能体备齐，再回来建群（跳到 设置 → AI → 智能体）
        const settingsBtn = node('button', 'dlg-btn gc-settings-btn');
        settingsBtn.type = 'button';
        settingsBtn.dataset.tip = '设置 → AI → 智能体';
        settingsBtn.setAttribute('aria-label', '打开设置 · 智能体');
        settingsBtn.innerHTML = iconSvg('gear', 14);
        settingsBtn.addEventListener('click', () => {
            if (!openSettings) return;
            createControls = null;
            closeDialog();
            openSettings('agents');
        });

        openDialog('新建群聊',
            [body],
            [settingsBtn, estLine, statusLine, cancelBtn, createBtn],
            {top: true, wide: true});
        if (typeof enhanceSelect === 'function') {
            // 与设置页/面板弹窗同一套行式下拉（原生 select 会露出系统下拉，和自绘控件混成两套）
            for (const ctl of [goalCtl, modeCtl, presetCtl, chairKindCtl, chairAgentCtl, policyCtl, roundsCtl, timeoutCtl]) {
                enhanceSelect(ctl.control);
            }
        }
    }

    function wrapRow(labelText, control, className) {
        const wrap = node('div', 'gc-form-row' + (className ? ' ' + className : ''));
        wrap.appendChild(node('span', 'gc-form-label', labelText));
        wrap.appendChild(control);
        return wrap;
    }

    function agentCapabilityLabel(agent, profiles) {
        const cap = preflightGroup({agents: [agent], profiles, memberIds: [agent.id], sharedTokens: 0, boardTokens: BRIEF_BOARD_TOKEN_BUDGET})[0];
        return cap && cap.detail ? cap.detail : '';
    }

    function capLevelText(level) {
        return level === 'red' ? '红' : level === 'yellow' ? '黄' : '绿';
    }

    function refreshChairVisibility() {
        void 0; // kind=ai 与 member 共用同一选择器，选项含义在 change 时重算
    }

    // 辩论/评审预设（§1.4）：切预设时按勾选顺序填默认角色（正方/反方/评审…）并调目标
    function refreshPresetDefaults() {
        if (!createControls) return;
        const preset = createControls.preset.control.value;
        if (preset === 'standard') return;
        const picked = createControls.memberSwitches.filter((sw) => sw.control.checked);
        const defaults = preset === 'debate'
            ? ['正方', '反方', '评审', '领域专家', '评审', '正方补充', '反方补充', '评审']
            : ['评审', '领域专家', '被评审方', '评审', '领域专家', '评审', '领域专家', '评审'];
        picked.forEach((sw, index) => {
            const input = createControls.roleInputs[sw.agentId];
            if (input && !input.control.value.trim()) {
                input.control.value = defaults[index % defaults.length] || '';
                input.element.classList.remove('hidden');
            }
        });
        if (picked.length) {
            if (preset === 'review') createControls.goal.control.value = 'review';
            else if (preset === 'debate') createControls.goal.control.value = 'decide';
        }
    }

    // 辩论/评审的角色表（§1.4）：发言顺序由主持人按角色交替安排，角色进成员提示词
    function collectRoles() {
        if (!createControls) return {};
        const roles = {};
        for (const sw of createControls.memberSwitches) {
            if (!sw.control.checked) continue;
            const input = createControls.roleInputs[sw.agentId];
            const role = input ? String(input.control.value || '').trim() : '';
            if (role) roles[sw.agentId] = role.slice(0, 80);
        }
        return roles;
    }

    function pickedMemberIds() {
        if (!createControls) return [];
        return createControls.memberSwitches
            .filter((sw) => sw.control.checked)
            .map((sw) => sw.agentId);
    }

    function refreshPreflight(box, estLine, agents, profiles) {
        if (!box) return;
        box.innerHTML = '';
        const memberIds = pickedMemberIds();
        const chairKind = createControls ? createControls.chairKind.control.value : 'ai';
        let chairAgentId = createControls ? createControls.chairAgent.control.value : '';
        // 成员兼任：主持人即所选成员之一（只影响标注，不参与预检差异）
        if (chairKind === 'member' && !memberIds.includes(chairAgentId)) chairAgentId = memberIds[0] || '';
        const items = preflightGroup({agents, profiles, memberIds, sharedTokens: 0, boardTokens: BRIEF_BOARD_TOKEN_BUDGET});
        const summary = node('div', 'gc-preflight-summary');
        const counts = {green: 0, yellow: 0, red: 0};
        for (const item of items) counts[item.level]++;
        summary.appendChild(node('span', 'gc-badge gc-level-green', `绿 ${counts.green}`));
        summary.appendChild(node('span', 'gc-badge gc-level-yellow', `黄 ${counts.yellow}`));
        summary.appendChild(node('span', 'gc-badge gc-level-red', `红 ${counts.red}`));
        summary.appendChild(node('span', 'gc-preflight-note', '红 = 共享对话超出窗口将停止参与；黄 = 接近上限'));
        box.appendChild(summary);
        const detail = node('div', 'gc-preflight-detail');
        for (const item of items) {
            const line = node('div', 'gc-preflight-item gc-level-' + item.level);
            line.textContent = `${item.name}：${item.detail}`;
            detail.appendChild(line);
        }
        box.appendChild(detail);
        if (estLine) {
            const policy = createControls ? createControls.policy.control.value : 'round-plan';
            const rounds = createControls ? Number(createControls.rounds.control.value) || 2 : 2;
            const calls = estimateDiscussionCalls(memberIds.length, rounds, policy);
            estLine.textContent = memberIds.length >= 2
                ? `预计调用量：约 ${calls} 次（${memberIds.length} 成员 × ${rounds} 轮）`
                : '勾选 2–8 位成员后开始讨论';
        }
    }

    function collectCreateDraft() {
        if (!createControls) return {memberIds: []};
        const chairKind = createControls.chairKind.control.value;
        const memberIds = pickedMemberIds();
        let chairAgentId = createControls.chairAgent.control.value;
        if (chairKind === 'member' && !memberIds.includes(chairAgentId)) {
            chairAgentId = memberIds[0] || '';
        }
        return {
            title: String(createControls.title.control.value || '').trim(),
            topic: String(createControls.topic.control.value || '').trim(),
            goal: createControls.goal.control.value,
            mode: createControls.mode.control.value === 'task' ? 'task' : 'roundtable',
            roles: collectRoles(),
            memberIds,
            chair: {kind: chairKind, agentId: chairKind === 'user' ? '' : chairAgentId, policy: createControls.policy.control.value},
            maxRounds: Number(createControls.rounds.control.value) || 2,
            timeoutPreset: createControls.timeout.control.value,
        };
    }

    // 「一键创建默认主持人」（§16.2）：写内置模板进 agents[]，模型让用户后续自选。
    function createDefaultChairAgent() {
        const config = getAIConfig();
        if (!config) return {ok: false, error: '配置不可用'};
        const result = agentsUpsert(config.agents || [], {...BUILTIN_CHAIR, modelRef: ''}, () => aiNowId('agent-'));
        if (!result.ok) return {ok: false, error: result.error || '创建失败'};
        saveConfig();
        return {ok: true, agent: result.agent};
    }

    return {bindSidebar, renderGroupList, openCreateDialog};
}
