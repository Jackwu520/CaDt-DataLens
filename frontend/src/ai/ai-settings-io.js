// AI 设置 → 导入导出：配置导出（可选是否含密钥）与导入（合并/覆盖、旧格式兼容）。
// 从 ai-settings-dialog.js 拆出；renderModelList / refreshPromptSettings / aiAddUnique 等由兄弟模块注入。
import {
    modelEntryOf, resolveModelRef,
} from './ai-config-model.js';
import {
    AI_PREF_LIMIT, AI_PREF_TEXT_LIMIT, aiClamp, aiClampInt, aiNowId, aiTextOf,
} from './ai-constants.js';
import {
    normalizeDefaultScope,
} from './ai-permissions.js';

export function createAISettingsIO(ctx, extras) {

    const opt = ctx.opt;
    const flash = ctx.flash;
    const backend = ctx.backend;
    const readTextFile = ctx.readTextFile;
    const isOpen = ctx.isOpen;
    const saveAIConfig = ctx.saveAIConfig;
    const renderMessages = ctx.renderMessages;
    const updateComposerState = ctx.updateComposerState;
    const renderProfileSelect = ctx.renderProfileSelect;
    const normalizeProfile = ctx.normalizeProfile;
    const promptById = ctx.promptById;
    const invalidateSkillsCache = ctx.invalidateSkillsCache;
    const getConfig = ctx.getConfig;

    function exportAIConfig() {
        const includeKeys = !!(opt.exportKeys && opt.exportKeys.checked);
        const data = {
            version: 1,
            exportedAt: new Date().toISOString(),
            profiles: getConfig().profiles.map((profile) => ({
                ...profile,
                apiKey: includeKeys ? profile.apiKey : '',
            })),
            prompts: getConfig().prompts.map((prompt) => ({
                id: prompt.id,
                name: prompt.name,
                content: prompt.content,
                builtin: !!prompt.builtin,
            })),
            activePromptId: getConfig().activePromptId,
            preferences: getConfig().preferences.map((pref) => ({
                id: pref.id,
                text: pref.text,
                source: pref.source,
                createdAt: pref.createdAt,
            })),
            memoryMode: getConfig().memoryMode,
            defaultScope: getConfig().defaultScope,
            approvedPaths: getConfig().approvedPaths,
            disabledSkills: getConfig().disabledSkills,
            autoCompactThreshold: getConfig().autoCompactThreshold,
            autoCompact: getConfig().autoCompact,
            autoTitle: getConfig().autoTitle !== false,
            autoClassifier: getConfig().autoClassifier === true,
            autoClassifierModel: getConfig().autoClassifierModel || '',
            outputLanguage: getConfig().outputLanguage || 'zh',
            logEnabled: getConfig().logEnabled !== false,
            worklogEnabled: getConfig().worklogEnabled !== false,
            subAgentMax: getConfig().subAgentMax,
            subAgentMaxDepth: getConfig().subAgentMaxDepth,
            notifyInApp: getConfig().notifyInApp === true,
            notifySystem: getConfig().notifySystem === true,
            notifyFinish: getConfig().notifyFinish !== false,
            notifyError: getConfig().notifyError !== false,
            notifyAsk: getConfig().notifyAsk !== false,
            notifySound: getConfig().notifySound !== false,
            askTimeout: getConfig().askTimeout,
            askTimeoutAction: getConfig().askTimeoutAction,
        };
        const json = JSON.stringify(data, null, 2);
        const defaultName = 'cadt-ai-getConfig().json';
        const save = async () => {
            let path = '';
            if (backend.ShowSaveFileDialog) path = await backend.ShowSaveFileDialog('导出 AI 配置', defaultName, '*.json');
            else if (backend.SaveFileDialog) path = await backend.SaveFileDialog(defaultName);
            else throw new Error('当前版本不支持保存对话框');
            if (!path) {
                flash('已取消导出');
                return;
            }
            await backend.SaveFile(path, json, 'lf', false, 'utf-8');
            flash('AI 配置已导出：' + path);
        };
        save().catch((e) => flash('导出失败：' + ((e && e.message) || e), true));
    }

    async function importAIConfig() {
        if (!backend.ShowOpenFileDialog) {
            flash('当前版本不支持导入对话框', true);
            return;
        }
        try {
            const path = await backend.ShowOpenFileDialog('导入 AI 配置', '*.json');
            if (!path) {
                flash('已取消导入');
                return;
            }
            const read = await readTextFile(path, 4 << 20);
            const data = JSON.parse(read.text);
            if (!data || typeof data !== 'object') throw new Error('配置格式无效');
            let importedProfiles = 0;
            for (const raw of Array.isArray(data.profiles) ? data.profiles : []) {
                const profile = normalizeProfile(raw, getConfig().profiles.length);
                if (!profile) continue;
                const existing = getConfig().profiles.find((item) => item.id === profile.id);
                if (existing) {
                    const keepKey = existing.apiKey;
                    Object.assign(existing, profile);
                    if (!profile.apiKey) existing.apiKey = keepKey;
                } else {
                    getConfig().profiles.push(profile);
                }
                importedProfiles++;
            }
            for (const raw of Array.isArray(data.prompts) ? data.prompts : []) {
                if (!raw || !aiTextOf(raw.id) || !aiTextOf(raw.content).trim()) continue;
                if (String(raw.id).startsWith('builtin-')) continue;
                const existing = getConfig().prompts.find((item) => item.id === raw.id);
                if (existing) {
                    if (existing.builtin) continue;
                    existing.name = aiTextOf(raw.name) || existing.name;
                    existing.content = aiTextOf(raw.content);
                } else {
                    getConfig().prompts.push({
                        id: aiTextOf(raw.id),
                        name: aiTextOf(raw.name) || '导入模板',
                        content: aiTextOf(raw.content),
                        builtin: false,
                    });
                }
            }
            if (data.activePromptId && promptById(aiTextOf(data.activePromptId))) {
                getConfig().activePromptId = aiTextOf(data.activePromptId);
            }
            for (const raw of Array.isArray(data.preferences) ? data.preferences : []) {
                if (!raw || typeof raw !== 'object') continue;
                const text = aiTextOf(raw.text).trim().slice(0, AI_PREF_TEXT_LIMIT);
                if (!text) continue;
                if (getConfig().preferences.some((pref) => pref.text === text)) continue;
                if (getConfig().preferences.length >= AI_PREF_LIMIT) break;
                getConfig().preferences.push({
                    id: aiTextOf(raw.id) || aiNowId('pref-'),
                    text,
                    source: raw.source === 'ai' ? 'ai' : 'user',
                    createdAt: Number(raw.createdAt) || Date.now(),
                    updatedAt: Number(raw.createdAt) || Date.now(),
                });
            }
            if (data.memoryMode === 'app' || data.memoryMode === 'workspace') getConfig().memoryMode = data.memoryMode;
            getConfig().defaultScope = normalizeDefaultScope(data.defaultScope);
            if (Number.isFinite(Number(data.autoCompactThreshold))) {
                getConfig().autoCompactThreshold = aiClamp(Number(data.autoCompactThreshold), 0.5, 0.95);
            }
            if (typeof data.autoCompact === 'boolean') getConfig().autoCompact = data.autoCompact;
            if (typeof data.autoTitle === 'boolean') getConfig().autoTitle = data.autoTitle;
            if (typeof data.autoClassifier === 'boolean') getConfig().autoClassifier = data.autoClassifier;
            getConfig().autoClassifierModel = resolveModelRef(
                aiTextOf(data.autoClassifierModel), getConfig().profiles);
            if (['zh', 'en', 'auto'].includes(data.outputLanguage)) getConfig().outputLanguage = data.outputLanguage;
            if (typeof data.logEnabled === 'boolean') getConfig().logEnabled = data.logEnabled;
            if (typeof data.worklogEnabled === 'boolean') getConfig().worklogEnabled = data.worklogEnabled;
            getConfig().subAgentMax = aiClampInt(data.subAgentMax, 1, 20, getConfig().subAgentMax);
            getConfig().subAgentMaxDepth = aiClampInt(data.subAgentMaxDepth, 0, 20, getConfig().subAgentMaxDepth);
            for (const key of ['notifyInApp', 'notifySystem', 'notifyFinish', 'notifyError', 'notifyAsk', 'notifySound']) {
                if (typeof data[key] === 'boolean') getConfig()[key] = data[key];
            }
            if (Number.isFinite(Number(data.askTimeout))) getConfig().askTimeout = aiClampInt(data.askTimeout, 0, 3600, 300);
            if (['recommended', 'wait', 'abort', 'ai_decide'].includes(data.askTimeoutAction)) {
                getConfig().askTimeoutAction = data.askTimeoutAction;
            }
            for (const pathValue of Array.isArray(data.approvedPaths) ? data.approvedPaths : []) {
                extras.aiAddUnique(getConfig().approvedPaths, pathValue);
            }
            for (const name of Array.isArray(data.disabledSkills) ? data.disabledSkills : []) {
                extras.aiAddUnique(getConfig().disabledSkills, name);
            }
            if (!getConfig().profiles.some((profile) => profile.id === getConfig().activeProfileId)) {
                getConfig().activeProfileId = getConfig().profiles[0] ? getConfig().profiles[0].id : '';
            }
            const activeAccount = getConfig().profiles.find((profile) => profile.id === getConfig().activeProfileId);
            if (activeAccount) {
                if (!modelEntryOf(activeAccount, getConfig().activeModelId)) {
                    getConfig().activeModelId = modelEntryOf(activeAccount, activeAccount.lastModelId).id;
                }
            } else {
                getConfig().activeModelId = '';
            }
            getConfig().autoClassifierModel = resolveModelRef(getConfig().autoClassifierModel, getConfig().profiles);
            saveAIConfig();
            invalidateSkillsCache();
            extras.refreshSettingsPane();
            extras.refreshChatSettings();
            extras.refreshPromptSettings();
            renderProfileSelect();
            updateComposerState();
            extras.renderModelList();
            if (isOpen()) renderMessages(true);
            extras.setSettingsStatus('已导入 ' + importedProfiles + ' 个模型账号', 'ok');
        } catch (e) {
            flash('导入失败：' + ((e && e.message) || e), true);
        }
    }

    // 账号级字段写入口（模型级字段走 extras.editorEntryOf + 各自 handler）

return {
        exportAIConfig,
        importAIConfig,
    };
}
