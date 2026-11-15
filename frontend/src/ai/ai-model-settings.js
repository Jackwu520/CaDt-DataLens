// AI 设置 → 模型：条目列表、编辑器状态机（新建/编辑/收起）、窗口与思考预算、导入条目、模型账号增删复制。
// 从 ai-settings-dialog.js 拆出；modelEditorState / editorEntryOf 随模型域迁入，宿主经 extras 触达状态栏与整页刷新。
import {
    findModelEntry,
    formatTokenAmount,
    modelEntryOf,
    resolveModelId,
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
        return profile && profile.provider === 'anthropic' ? 'Anthropic 原生'
            : (profile && profile.provider === 'responses' ? 'OpenAI Responses' : 'OpenAI 兼容');
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
            // 编辑器打开的是该账号上次记住的条目，与「当前窗口选择」解耦；
            // 用 resolveModelId 保证失效 id 回落到真实存在的条目。
            modelEditorState = {
                isCreate: false,
                editingId: profile.id,
                previousActiveId,
                entryId: resolveModelId(profile, profile.lastModelId, ''),
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
        // 密钥每次打开都回到掩码态，避免上次「显示」把明文留在下一次编辑里
        if (opt.apiKey) opt.apiKey.type = 'password';
        if (opt.keyToggle) {
            opt.keyToggle.setAttribute('aria-pressed', 'false');
            opt.keyToggle.setAttribute('aria-label', '显示密钥');
            opt.keyToggle.dataset.tip = '显示密钥';
        }
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
                if (!findModelEntry(profile, profile.lastModelId)) profile.lastModelId = entries[0].id;
            }
            if (state.isCreate) getConfig().activeProfileId = profile ? profile.id : getConfig().activeProfileId;
            else getConfig().activeProfileId = state.previousActiveId || (profile ? profile.id : '');
            const activeAccount = getConfig().profiles.find((item) => item.id === getConfig().activeProfileId);
            if (activeAccount && !findModelEntry(activeAccount, getConfig().activeModelId)) {
                getConfig().activeModelId = resolveModelId(activeAccount, activeAccount.lastModelId, '');
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
        if (activeAccount && !findModelEntry(activeAccount, getConfig().activeModelId)) {
            getConfig().activeModelId = resolveModelId(activeAccount, activeAccount.lastModelId, '');
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

    // 编辑器内的模型条目 strip（选中态 + 计数）；删除走 chip 内联 ×，账号只剩一个模型时不显示
    function renderModelEntries() {
        const profile = activeProfile();
        const models = profile && Array.isArray(profile.models) ? profile.models : [];
        if (opt.modelCount) opt.modelCount.textContent = String(models.length);
        if (!opt.modelEntries) return;
        opt.modelEntries.innerHTML = '';
        if (!profile) return;
        const current = editorEntryOf(profile);
        for (const entry of models) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ai-entry-chip' + (current && entry.id === current.id ? ' active' : '');
            const name = document.createElement('span');
            name.className = 'ai-entry-chip-name';
            name.textContent = entry.model || '（未填写）';
            chip.appendChild(name);
            chip.dataset.tip = (entry.model || '（未填写）')
                + ' · 上下文 ' + (formatTokenAmount(entry.contextWindow) || '—')
                + ' · 输出 ' + (formatTokenAmount(entry.outputWindow) || '—');
            chip.addEventListener('click', () => {
                if (modelEditorState) modelEditorState.entryId = entry.id;
                // 两个字段必须一起写：activeModelId 是窗口选择，lastModelId 是账号记忆。
                // 只写前者会让下次 switchProfile / openModelEditor 用 stale 的 lastModelId 覆盖回来。
                profile.lastModelId = entry.id;
                if (profile.id === getConfig().activeProfileId) getConfig().activeModelId = entry.id;
                saveAIConfig();
                extras.refreshSettingsPane();
            });
            // chip 本身是 button，删除钮用 span+role 以免嵌套按钮（HTML 不允许）
            if (models.length > 1) {
                const remove = document.createElement('span');
                remove.className = 'ai-entry-chip-x';
                remove.setAttribute('role', 'button');
                remove.setAttribute('tabindex', '0');
                remove.setAttribute('aria-label', '删除模型 ' + (entry.model || '未填写'));
                remove.dataset.tip = '删除该模型';
                remove.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
                remove.addEventListener('click', (event) => {
                    event.stopPropagation();
                    deleteEditorEntry(entry.id);
                });
                remove.addEventListener('keydown', (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    event.stopPropagation();
                    deleteEditorEntry(entry.id);
                });
                chip.appendChild(remove);
            }
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

    // 删除模型条目：chip 内联 × 传条目 id，独立按钮（无参）删当前选中条目
    function deleteEditorEntry(entryId) {
        const profile = activeProfile();
        if (!profile || !profile.models) return;
        if (profile.models.length <= 1) {
            extras.setSettingsStatus('账号至少保留一个模型', 'error');
            return;
        }
        const wanted = typeof entryId === 'string' ? entryId : '';
        const target = (wanted && profile.models.find((entry) => entry.id === wanted)) || editorEntryOf(profile);
        if (!target) return;
        profile.models = profile.models.filter((entry) => entry.id !== target.id);
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
