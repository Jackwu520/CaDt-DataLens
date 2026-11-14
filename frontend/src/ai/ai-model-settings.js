// AI 设置 → 模型：条目列表、编辑器状态机（新建/编辑/收起）、窗口与思考预算、导入条目、模型账号增删复制。
// 从 ai-settings-dialog.js 拆出；modelEditorState / editorEntryOf 随模型域迁入，宿主经 extras 触达状态栏与整页刷新。
import {
    modelEntryOf,
} from './ai-config-model.js';
import {
    aiNowId,
} from './ai-constants.js';

export function createAIModelSettings(ctx, extras) {

    const opt = ctx.opt;
    const flash = ctx.flash;
    const askConfirm = ctx.askConfirm;
    const saveAIConfig = ctx.saveAIConfig;
    const updateComposerState = ctx.updateComposerState;

    // 模型编辑器的临时状态（原在 ai-settings-dialog.js 闭包级，随模型域迁入）
    let modelEditorState = null;
    const renderProfileSelect = ctx.renderProfileSelect;
    const activeProfile = ctx.activeProfile;
    const defaultModelEntry = ctx.defaultModelEntry;
    const defaultProfile = ctx.defaultProfile;
    const dialogButton = ctx.dialogButton;
    const queryUsageForAccount = ctx.queryUsageForAccount;
    const switchProfile = ctx.switchProfile;
    const getConfig = ctx.getConfig;

    function editorEntryOf(profile) {
        if (!profile) return null;
        if (modelEditorState && modelEditorState.entryId) {
            const found = (profile.models || []).find((item) => item.id === modelEditorState.entryId);
            if (found) return found;
        }
        if (profile.id === getConfig().activeProfileId) return modelEntryOf(profile, getConfig().activeModelId);
        return modelEntryOf(profile, profile.lastModelId);
    }

    function providerLabelFor(profile) {
        return profile && profile.provider === 'anthropic' ? 'Anthropic 原生' : 'OpenAI 兼容';
    }

    function renderModelList() {
        if (!opt.modelList) return;
        opt.modelList.innerHTML = '';
        if (!getConfig().profiles.length) {
            const empty = document.createElement('div');
            empty.className = 'ai-model-empty';
            empty.textContent = '还没有模型账号';
            opt.modelList.appendChild(empty);
            return;
        }
        for (const profile of getConfig().profiles) {
            const entry = modelEntryOf(profile, profile.id === getConfig().activeProfileId ? getConfig().activeModelId : profile.lastModelId);
            const card = document.createElement('div');
            card.className = 'ai-model-card' + (profile.id === getConfig().activeProfileId ? ' active' : '');
            const head = document.createElement('div');
            head.className = 'ai-model-card-head';
            const name = document.createElement('span');
            name.className = 'ai-model-name';
            name.textContent = profile.name || '未命名账号';
            const provider = document.createElement('span');
            provider.className = 'ai-model-provider';
            provider.textContent = providerLabelFor(profile);
            head.append(name, provider);
            if (profile.id === getConfig().activeProfileId) {
                const badge = document.createElement('span');
                badge.className = 'ai-model-badge';
                badge.textContent = '当前';
                head.appendChild(badge);
            }
            const meta = document.createElement('div');
            meta.className = 'ai-model-meta';
            meta.textContent = [
                (profile.models || []).length + ' 个模型' + (entry && entry.model ? ' · ' + entry.model : ' · 未填写模型 ID'),
                profile.baseURL || '未填写 Base URL',
                profile.apiKey ? 'Key 已配置' : 'Key 未配置',
            ].join(' · ');
            const actions = document.createElement('div');
            actions.className = 'ai-model-actions';
            if (profile.id !== getConfig().activeProfileId) {
                actions.appendChild(dialogButton('设为当前', 'dlg-btn', () => switchProfile(profile.id)));
            }
            actions.appendChild(dialogButton('查询用量', 'dlg-btn', (event) => queryUsageForAccount(profile, event)));
            actions.appendChild(dialogButton('编辑', 'dlg-btn', () => openModelEditor(profile.id)));
            actions.appendChild(dialogButton('复制', 'dlg-btn', () => duplicateModel(profile.id)));
            actions.appendChild(dialogButton('删除', 'dlg-btn', () => deleteModel(profile.id)));
            card.append(head, meta, actions);
            opt.modelList.appendChild(card);
        }
    }

    function setActiveModel(id) {
        // 兼容旧入口：设为当前 = 切换账号（保留账号记住的模型条目）
        switchProfile(id);
    }

    function openModelEditor(id) {
        if (!opt.modelEditor) return;
        let profile = id ? getConfig().profiles.find((item) => item.id === id) : null;
        if (id && !profile) return;
        const previousActiveId = getConfig().activeProfileId;
        if (profile) {
            modelEditorState = {
                isCreate: false,
                editingId: profile.id,
                previousActiveId,
                entryId: modelEntryOf(profile, profile.lastModelId).id,
                snapshot: JSON.parse(JSON.stringify(profile)),
            };
        } else {
            profile = defaultProfile();
            profile.name = '账号 ' + (getConfig().profiles.length + 1);
            getConfig().profiles.push(profile);
            modelEditorState = {
                isCreate: true,
                newId: profile.id,
                previousActiveId,
                entryId: profile.models[0].id,
                snapshot: null,
            };
        }
        getConfig().activeProfileId = profile.id;
        getConfig().activeModelId = modelEditorState.entryId;
        saveAIConfig();
        extras.refreshSettingsPane();
        renderModelList();
        if (opt.modelTitle) opt.modelTitle.textContent = modelEditorState.isCreate ? '新建模型账号' : '编辑模型账号';
        if (opt.modelEditorMask) opt.modelEditorMask.classList.remove('hidden');
        opt.modelEditor.classList.remove('hidden');
        setTimeout(() => {
            if (opt.name) {
                opt.name.focus();
                opt.name.select();
            }
        }, 50);
    }

    // 保存校验：账号名必填；至少一个模型条目带非空模型 ID（空条目自动丢弃）
    function collectEditorEntries(profile) {
        const entries = (profile.models || []).filter((entry) => String(entry.model || '').trim());
        if (!entries.length) {
            extras.setSettingsStatus('至少需要一个模型 ID', 'error');
            if (opt.model) opt.model.focus();
            return null;
        }
        return entries;
    }

    function closeModelEditor(save) {
        const state = modelEditorState;
        if (!state) {
            if (opt.modelEditor) opt.modelEditor.classList.add('hidden');
            return;
        }
        const profile = activeProfile();
        if (save) {
            const name = String((opt.name && opt.name.value) || '').trim();
            if (!name) {
                extras.setSettingsStatus('账号名称不能为空', 'error');
                if (opt.name) opt.name.focus();
                return;
            }
            const entries = profile ? collectEditorEntries(profile) : null;
            if (!entries) return;
            if (profile) {
                profile.name = name;
                profile.models = entries;
                if (!modelEntryOf(profile, profile.lastModelId)) profile.lastModelId = entries[0].id;
            }
            if (state.isCreate) getConfig().activeProfileId = profile ? profile.id : getConfig().activeProfileId;
            else getConfig().activeProfileId = state.previousActiveId || (profile ? profile.id : '');
            const activeAccount = getConfig().profiles.find((item) => item.id === getConfig().activeProfileId);
            if (activeAccount && !modelEntryOf(activeAccount, getConfig().activeModelId)) {
                getConfig().activeModelId = modelEntryOf(activeAccount, activeAccount.lastModelId).id;
            }
            saveAIConfig();
            modelEditorState = null;
            if (opt.modelEditor) opt.modelEditor.classList.add('hidden');
            if (opt.modelEditorMask) opt.modelEditorMask.classList.add('hidden');
            extras.refreshSettingsPane();
            renderProfileSelect();
            renderModelList();
            updateComposerState();
            flash('模型账号已保存：' + name + '（' + entries.length + ' 个模型）');
            return;
        }
        if (state.isCreate) {
            getConfig().profiles = getConfig().profiles.filter((item) => item.id !== state.newId);
            getConfig().activeProfileId = state.previousActiveId ||
                (getConfig().profiles[0] ? getConfig().profiles[0].id : '');
        } else {
            const editing = getConfig().profiles.find((item) => item.id === state.editingId);
            if (editing && state.snapshot) Object.assign(editing, state.snapshot);
            getConfig().activeProfileId = state.previousActiveId || (editing ? editing.id : '');
        }
        const activeAccount = getConfig().profiles.find((item) => item.id === getConfig().activeProfileId);
        if (activeAccount && !modelEntryOf(activeAccount, getConfig().activeModelId)) {
            getConfig().activeModelId = modelEntryOf(activeAccount, activeAccount.lastModelId).id;
        }
        modelEditorState = null;
        if (opt.modelEditor) opt.modelEditor.classList.add('hidden');
        if (opt.modelEditorMask) opt.modelEditorMask.classList.add('hidden');
        saveAIConfig();
        extras.refreshSettingsPane();
        renderProfileSelect();
        renderModelList();
        updateComposerState();
    }

    // 编辑器内的模型条目 strip（选中态 + 计数）；新增 / 删除条目
    function renderModelEntries() {
        const profile = activeProfile();
        if (opt.modelCount) opt.modelCount.textContent = String(profile && profile.models ? profile.models.length : 0);
        if (!opt.modelEntries) return;
        opt.modelEntries.innerHTML = '';
        if (!profile) return;
        const current = editorEntryOf(profile);
        for (const entry of profile.models) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ai-entry-chip' + (current && entry.id === current.id ? ' active' : '');
            const name = document.createElement('span');
            name.className = 'ai-entry-chip-name';
            name.textContent = entry.model || '（未填写）';
            chip.appendChild(name);
            chip.title = (entry.model || '（未填写）') + ' · 窗口 ' + (entry.contextWindow || 128000) + ' tokens';
            chip.addEventListener('click', () => {
                if (modelEditorState) modelEditorState.entryId = entry.id;
                if (profile.id === getConfig().activeProfileId) getConfig().activeModelId = entry.id;
                saveAIConfig();
                extras.refreshSettingsPane();
            });
            opt.modelEntries.appendChild(chip);
        }
    }

    function addEditorEntry() {
        const profile = activeProfile();
        if (!profile) return;
        const entry = defaultModelEntry();
        profile.models.push(entry);
        if (modelEditorState) modelEditorState.entryId = entry.id;
        if (profile.id === getConfig().activeProfileId) getConfig().activeModelId = entry.id;
        saveAIConfig();
        extras.refreshSettingsPane();
        renderModelList();
        if (opt.model) {
            opt.model.focus();
            opt.model.select();
        }
    }

    function deleteEditorEntry() {
        const profile = activeProfile();
        if (!profile || !profile.models) return;
        if (profile.models.length <= 1) {
            extras.setSettingsStatus('账号至少保留一个模型', 'error');
            return;
        }
        const current = editorEntryOf(profile);
        if (!current) return;
        profile.models = profile.models.filter((entry) => entry.id !== current.id);
        const next = profile.models[0];
        if (modelEditorState) modelEditorState.entryId = next.id;
        if (profile.id === getConfig().activeProfileId) getConfig().activeModelId = next.id;
        saveAIConfig();
        extras.refreshSettingsPane();
        renderModelList();
    }

    function duplicateModel(id) {
        const profile = getConfig().profiles.find((item) => item.id === id);
        if (!profile) return;
        const copy = JSON.parse(JSON.stringify(profile));
        copy.id = aiNowId('profile-');
        copy.name = (profile.name || '模型') + ' 副本';
        getConfig().profiles.push(copy);
        getConfig().activeProfileId = copy.id;
        saveAIConfig();
        extras.refreshSettingsPane();
        renderProfileSelect();
        renderModelList();
        openModelEditor(copy.id);
    }

    function deleteModel(id) {
        const profile = getConfig().profiles.find((item) => item.id === id);
        if (!profile) return;
        askConfirm('删除模型账号「' + (profile.name || '未命名') + '」（含其全部模型）？', () => {
            getConfig().profiles = getConfig().profiles.filter((item) => item.id !== id);
            if (getConfig().activeProfileId === id) {
                getConfig().activeProfileId = getConfig().profiles[0] ? getConfig().profiles[0].id : '';
                const next = activeProfile();
                getConfig().activeModelId = next ? modelEntryOf(next, next.lastModelId).id : '';
            }
            saveAIConfig();
            extras.refreshSettingsPane();
            renderProfileSelect();
            renderModelList();
            updateComposerState();
            flash('已删除模型账号：' + (profile.name || '未命名'));
        }, '删除', '删除模型账号');
    }

return {
        addEditorEntry,
        closeModelEditor,
        collectEditorEntries,
        deleteEditorEntry,
        deleteModel,
        duplicateModel,
        editorEntryOf,
        openModelEditor,
        providerLabelFor,
        renderModelEntries,
        renderModelList,
        setActiveModel,
    };
}
