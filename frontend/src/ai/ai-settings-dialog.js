// ai-settings-dialog.js：AI 设置页的壳——ctx 解包装、状态条与表单禁用、整页/聊天设置刷新、
// 以及 640 行的 bindSettingsPane 事件绑定器。权限 / 偏好 / 模型 / 导入导出四个子域已拆到同目录兄弟模块，
// 它们与宿主共享同一个 ctx，宿主函数经 extras 注入（不反向 import 本文件）。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移。
// config 为重赋值 let（经 getConfig() 读）；sessions 写经 setSessions；modelEditorState 与
// settingsStatusTimer 为本域私有 let 随域迁入；skillsCache/permissionAudit 经访问器触达。

import {createAIGenSettings} from './ai-gen-settings.js';
import {createAIModelSettings} from './ai-model-settings.js';
import {createAIPermissionSettings} from './ai-permission-settings.js';
import {createAIPreferenceSettings} from './ai-preference-settings.js';
import {createAISettingsIO} from './ai-settings-io.js';
import {createAIPersonalizationSettings} from './ai-personalization-ui.js';
import {
    AI_INJECT_OPTION_MAP, AI_DEFAULT_SYSTEM_PROMPT, AI_PREF_LIMIT, AI_PREF_TEXT_LIMIT, AI_PRESETS,
    aiClamp, aiClampInt, aiNowId, aiTextOf,
} from './ai-constants.js';
import {
    CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_MIN, OUTPUT_WINDOW_MAX, OUTPUT_WINDOW_MIN,
    configForModel, formatTokenAmount, modelEntryOf, modelRefLabel, resolveModelRef, windowValue,
} from './ai-config-model.js';
import {
    PERMISSION_VERSION, countPermissionRules, emptyPermissionRules, formatRuleLines,
    normalizeDefaultScope, normalizeLocalClassifierStrictness, normalizePermissionRules,
    parseRuleLines, webRuleSubject, writeRuleSubject,
} from './ai-permissions.js';
import {matchCommandRule, commandFamilySignature, commandText} from './ai-command-rules.js';
import {canAutoFill} from './model-catalog.js';

export function createAISettingsDialog(ctx) {
    const el = ctx.el;
    const panel = ctx.panel;
    const opt = ctx.opt;
    const settings = ctx.settings;
    // 面板显示方式（停靠/全屏/独立悬浮窗）：状态真源在 ai-panel 的 setMode，这里只接线
    const setMode = ctx.setMode;
    const saveSettings = ctx.saveSettings;
    const flash = ctx.flash;
    const askConfirm = ctx.askConfirm;
    const backend = ctx.backend;
    const readTextFile = ctx.readTextFile;
    const isOpen = ctx.isOpen;
    const currentSession = ctx.currentSession;
    const persistSessions = ctx.persistSessions;
    const saveAIConfig = ctx.saveAIConfig;
    const renderMessages = ctx.renderMessages;
    const updateContextCount = ctx.updateContextCount;
    const updateSendState = ctx.updateSendState;
    const updateComposerState = ctx.updateComposerState;
    const queueLogSave = ctx.queueLogSave;
    const renderModelChip = ctx.renderModelChip;
    const renderProfileSelect = ctx.renderProfileSelect;
    const renderSessionList = ctx.renderSessionList;
    const sessionActivity = ctx.sessionActivity;
    const sessionTitleById = ctx.sessionTitleById;
    const newSession = ctx.newSession;
    const open = ctx.open;
    const switchSession = ctx.switchSession;
    const compactOf = ctx.compactOf;
    const streamOf = ctx.streamOf;
    const sendAppMessage = ctx.sendAppMessage;
    const activeProfile = ctx.activeProfile;
    const appControlOn = ctx.appControlOn;
    const defaultModelEntry = ctx.defaultModelEntry;
    const defaultProfile = ctx.defaultProfile;
    const normalizeProfile = ctx.normalizeProfile;
    const configForProfile = ctx.configForProfile;
    const promptById = ctx.promptById;
    const emptyState = ctx.emptyState;
    const dialogButton = ctx.dialogButton;
    const openAIDialog = ctx.openAIDialog;
    const closeAIDialog = ctx.closeAIDialog;
    const invalidateSkillsCache = ctx.invalidateSkillsCache;
    const resolveMemoryDir = ctx.resolveMemoryDir;
    const getAILogRoot = ctx.getAILogRoot;
    const openAILogDir = ctx.openAILogDir;
    const aiNormalizePath = ctx.aiNormalizePath;
    const aiJoinPath = ctx.aiJoinPath;
    const aiPathDir = ctx.aiPathDir;
    const aiPathKey = ctx.aiPathKey;
    const aiProjectRoot = ctx.aiProjectRoot;
    const aiWorkspaceKey = ctx.aiWorkspaceKey;
    const queryUsageForAccount = ctx.queryUsageForAccount;
    const showModelListPicker = ctx.showModelListPicker;
    const switchProfile = ctx.switchProfile;
    const getConfig = ctx.getConfig;
    // 模型配置表：窗口/能力回填的来源，也是「推理强度 / 扩展思考」显示与否的判断依据
    const modelCatalog = ctx.modelCatalog;
    const setSessions = ctx.setSessions;
    // 端侧命令分类器（ai-panel 构造，getter 惰性触达）与插件分类器列表
    const localClassifier = ctx.localClassifier;
    const openSettings = ctx.openSettings;
    const getPluginCommandClassifiers = ctx.getPluginCommandClassifiers;
    const getPluginLoadErrors = typeof ctx.getPluginLoadErrors === 'function' ? ctx.getPluginLoadErrors : null;
    // 重新扫描插件源并重放注册（端侧模型「刷新」按钮）
    const refreshPlugins = typeof ctx.refreshPlugins === 'function' ? ctx.refreshPlugins : null;
    // 插件注册表可能在异步加载中变化（启动加载 / 市场装完 / 刷新）：loadPlugins 完成时广播
    // cadt-plugins-loaded，端侧模型位与状态行原位刷新——避免「装了插件下拉里没有、要手动刷新」
    const getSkillsCache = ctx.getSkillsCache;
    const getPermissionAudit = ctx.getPermissionAudit;
    const setMemoryFallbackNotified = ctx.setMemoryFallbackNotified;
    // 惰性转发：三别名构造于本模块之后（对话框 / 定时任务互引）
    const showMemoryDialog = ctx.showMemoryDialog;
    const showSkillsDialog = ctx.showSkillsDialog;
    const openScheduleEditor = ctx.openScheduleEditor;
    const showNameDialog = ctx.showNameDialog;
    const setAIChatFont = ctx.setAIChatFont;
    const applyPanelSettings = ctx.applyPanelSettings;
    const createSessionData = ctx.createSessionData;
    const sessionStore = ctx.sessionStore;
    const sessionUseDisk = ctx.sessionUseDisk;
    // 排队消息的所有权在 ai-message-queue.js（阶段 A 迁移）：这里只要「清空」动作
    const clearMessageQueue = ctx.clearMessageQueue;
    const getSessions = ctx.getSessions;
    const updateCtxBanner = ctx.updateCtxBanner;
    // 任务清单默认收起/展开切换后，让面板里已有的收起态立即跟随（惰性转发，todos 模块在同层构造）
    const applyTodosCollapseDefault = ctx.applyTodosCollapseDefault;

    // —— 随域迁入的设置编辑器状态（原 ai-panel.js 闭包级）——
    let modelEditorState = null;
    let settingsStatusTimer = 0;

    function setSettingsStatus(text, kind) {
        if (!opt.status) return;
        opt.status.textContent = text || '—';
        opt.status.classList.toggle('ok', kind === 'ok');
        opt.status.classList.toggle('error', kind === 'error');
        clearTimeout(settingsStatusTimer);
        if (kind) {
            settingsStatusTimer = setTimeout(() => {
                opt.status.classList.remove('ok', 'error');
            }, 8000);
        }
    }

    function settingsFormDisabled(disabled) {
        for (const node of [opt.name, opt.provider, opt.baseURL, opt.apiKey, opt.model, opt.temp, opt.maxTokens, opt.reasoning, opt.thinking, opt.budget, opt.contextWindow, opt.proxy, opt.proxyURL, opt.headers, opt.test, opt.models, opt.entryAdd]) {
            if (node) node.disabled = !!disabled;
        }
        if (opt.modalities) {
            for (const node of opt.modalities.querySelectorAll('input[data-modality]')) {
                node.disabled = !!disabled;
            }
        }
    }

    function refreshThinkingVisibility() {
        const profile = activeProfile();
        const entry = modelMod.editorEntryOf(profile);
        const anthropic = !!profile && profile.provider === 'anthropic';
        const model = entry && entry.model;
        // 配置表只做「收窄」：明确写了不支持才藏，没写就沿用按协议判断的旧规则。
        // 反过来说，表里写支持也不会让 Anthropic 账号冒出 reasoning_effort。
        const reasoningSupport = modelCatalog.support(model, 'reasoningEffort');
        const thinkingSupport = modelCatalog.support(model, 'thinking');
        if (opt.thinkingGroup) opt.thinkingGroup.classList.toggle('hidden', !anthropic || thinkingSupport === false);
        if (opt.reasoningGroup) opt.reasoningGroup.classList.toggle('hidden', !profile || anthropic || reasoningSupport === false);
        if (opt.reasoning && entry) opt.reasoning.value = entry.reasoningEffort || '';
    }

    function clampThinkingBudget(account, entry, editedField) {
        if (!account || !entry || account.provider !== 'anthropic' || !entry.thinking) return;
        entry.thinkingBudget = aiClampInt(entry.thinkingBudget, 1024, 393215, 8000);
        if (entry.outputWindow > entry.thinkingBudget) return;
        if (editedField === 'outputWindow') {
            entry.thinkingBudget = Math.max(1024, entry.outputWindow - 1024);
            if (entry.outputWindow <= entry.thinkingBudget) {
                entry.outputWindow = 2048;
                entry.thinkingBudget = 1024;
            }
        } else {
            entry.outputWindow = Math.min(OUTPUT_WINDOW_MAX, entry.thinkingBudget + 4096);
        }
    }

    // 编辑器当前正在编辑的模型条目：编辑器内选中的条目优先，其次激活条目。
    // 个性化页的刷新入口：子域在本文件末尾才构造，这里用可变引用避开 TDZ，
    // 也让 refreshSettingsPane 在「无模型账号提前返回」之前就能刷新该页。
    let refreshPersonaPane = null;

    // 窗口字段的可读回显：输入框里是「256K」这类紧凑写法，右侧给出精确 token 数，
    // 免得 1M 到底是多少全靠猜（换算唯一来源仍是 ai-config-model 的 parseTokenAmount）。
    function renderWindowHints(entry) {
        const fmt = (node, value) => {
            if (!node) return;
            const n = Math.round(Number(value) || 0);
            node.textContent = n > 0 ? n.toLocaleString('en-US') + ' tokens' : '—';
        };
        fmt(opt.contextHuman, entry && entry.contextWindow);
        fmt(opt.maxTokensHuman, entry && entry.outputWindow);
    }

    // 窗口/能力三个字段的界面回写：整页刷新与「配置表回填」共用，避免两处各写一份
    function syncModelFieldsFromEntry(entry) {
        if (!entry) return;
        if (opt.contextWindow) opt.contextWindow.value = formatTokenAmount(entry.contextWindow);
        if (opt.maxTokens) opt.maxTokens.value = formatTokenAmount(entry.outputWindow);
        if (opt.modalities) {
            for (const node of opt.modalities.querySelectorAll('input[data-modality]')) {
                node.checked = entry.modalities[node.dataset.modality] !== false;
            }
        }
        renderWindowHints(entry);
    }

    function relativeTime(ms) {
        const diff = Date.now() - Number(ms || 0);
        if (!(diff > 0)) return '刚刚';
        const minutes = Math.floor(diff / 60000);
        if (minutes < 1) return '刚刚';
        if (minutes < 60) return minutes + ' 分钟前';
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return hours + ' 小时前';
        return Math.floor(hours / 24) + ' 天前';
    }

    // 编辑器里的命中提示：这些窗口/能力是不是配置表给的，以及一个「按表重填」的出口
    function renderCatalogNote() {
        if (!opt.catalogNote) return;
        const profile = activeProfile();
        const entry = modelMod.editorEntryOf(profile);
        const hit = entry && entry.model ? modelCatalog.match(entry.model) : null;
        if (!hit) {
            opt.catalogNote.classList.add('hidden');
            return;
        }
        const label = hit.label || hit.id;
        const summary = [
            hit.contextWindow ? '上下文 ' + formatTokenAmount(hit.contextWindow) : '',
            hit.outputWindow ? '输出 ' + formatTokenAmount(hit.outputWindow) : '',
        ].filter(Boolean).join(' · ');
        const suffix = summary ? '（' + summary + '）' : '';
        if (canAutoFill(entry)) {
            if (opt.catalogText) opt.catalogText.textContent = '窗口与能力按配置表填充：' + label + suffix;
            if (opt.catalogFill) opt.catalogFill.classList.add('hidden');
        } else {
            if (opt.catalogText) opt.catalogText.textContent = '窗口或能力已手动调整，配置表有 ' + label + suffix;
            if (opt.catalogFill) opt.catalogFill.classList.remove('hidden');
        }
        opt.catalogNote.classList.remove('hidden');
    }

    // 设置页「模型配置表」状态行
    function refreshCatalogStatus() {
        if (!opt.catalogStatus) return;
        const status = modelCatalog.status();
        const parts = [(status.remote ? '远端' : '内置') + ' ' + status.count + ' 个模型', '版本 ' + status.version];
        parts.push(status.fetchedAt ? '同步于 ' + relativeTime(status.fetchedAt) : '尚未同步远端');
        opt.catalogStatus.textContent = parts.join(' · ');
        if (opt.catalogAuto) opt.catalogAuto.checked = status.autoSync;
        if (opt.catalogUrl && document.activeElement !== opt.catalogUrl) {
            opt.catalogUrl.value = String(settings.aiCatalogURL || '');
        }
    }

    // 新家族 Claude（Opus 4.6 起 / 5.x）只接受自适应思考，传固定预算会 400：
    // 预算输入留着只会误导，禁用并换一句说明。判定来源是模型配置表的 thinkingBudget 标记。
    function refreshThinkingHint() {
        const entry = modelMod.editorEntryOf(activeProfile());
        const model = entry && entry.model;
        const adaptive = modelCatalog.support(model, 'thinkingBudget') === false;
        if (opt.budget) {
            opt.budget.disabled = adaptive;
            opt.budget.dataset.tip = adaptive ? '该模型使用自适应思考，不接受固定思考预算' : '';
        }
        if (opt.thinkingHint) {
            opt.thinkingHint.textContent = adaptive
                ? '该模型使用自适应思考（深度由服务端决定），思考预算不生效；开启后请求省略 temperature。'
                : '仅 Anthropic 原生可用；开启后请求省略 temperature，预算须小于最大输出，调整时会自动修正。';
        }
    }

    function refreshSettingsPane() {
        if (refreshPersonaPane) refreshPersonaPane();
        if (genMod) genMod.renderGenList();
        const profile = activeProfile();
        const entry = modelMod.editorEntryOf(profile);
        renderProfileSelect();
        refreshThinkingVisibility();
        settingsFormDisabled(!profile);
        refreshThinkingHint();
        if (!profile || !entry) {
            if (opt.name) opt.name.value = '';
            if (opt.baseURL) opt.baseURL.value = '';
            if (opt.apiKey) opt.apiKey.value = '';
            if (opt.model) opt.model.value = '';
            if (opt.temp) opt.temp.value = '0.7';
            if (opt.tempVal) opt.tempVal.textContent = '0.7';
            if (opt.maxTokens) opt.maxTokens.value = '';
            if (opt.reasoning) opt.reasoning.value = '';
            if (opt.thinking) opt.thinking.checked = false;
            if (opt.budget) opt.budget.value = '8000';
            if (opt.contextWindow) opt.contextWindow.value = '';
            if (opt.provider) opt.provider.value = 'openai';
            if (opt.proxy) opt.proxy.value = 'system';
            if (opt.proxyURL) { opt.proxyURL.value = ''; opt.proxyURL.disabled = true; }
            if (opt.headers) opt.headers.value = '';
            renderWindowHints(null);
            renderCatalogNote();
            refreshCatalogStatus();
            modelMod.renderModelEntries();
            return;
        }
        if (opt.name) opt.name.value = profile.name;
        if (opt.provider) opt.provider.value = profile.provider;
        if (opt.baseURL) opt.baseURL.value = profile.baseURL;
        if (opt.apiKey) opt.apiKey.value = profile.apiKey;
        if (opt.model) opt.model.value = entry.model;
        if (opt.temp) opt.temp.value = String(profile.temperature);
        if (opt.tempVal) opt.tempVal.textContent = String(profile.temperature);
        if (opt.reasoning) opt.reasoning.value = entry.reasoningEffort || '';
        if (opt.thinking) opt.thinking.checked = entry.thinking === true;
        if (opt.budget) opt.budget.value = String(entry.thinkingBudget);
        syncModelFieldsFromEntry(entry);
        if (opt.proxy) {
            const proxy = aiTextOf(profile.proxy);
            const mode = proxy === 'direct' ? 'direct' : (proxy && proxy !== 'system' ? 'custom' : 'system');
            opt.proxy.value = mode;
            if (opt.proxyURL) {
                opt.proxyURL.value = mode === 'custom' ? proxy : '';
                opt.proxyURL.disabled = mode !== 'custom';
            }
        }
        if (opt.headers) {
            opt.headers.value = Object.entries(profile.extraHeaders || {})
                .map(([name, value]) => name + '=' + value).join('\n');
        }
        renderWindowHints(entry);
        renderCatalogNote();
        refreshCatalogStatus();
        modelMod.renderModelEntries();
    }

    function refreshChatSettings() {
        if (opt.displayMode) opt.displayMode.value = settings.aiFloatMode === 'fullscreen' ? 'fullscreen' : 'dock';
        if (opt.sendKey) opt.sendKey.value = settings.aiSendKey === 'ctrl-enter' ? 'ctrl-enter' : 'enter';
        if (opt.outputLang) opt.outputLang.value = ['zh', 'en', 'auto'].includes(getConfig().outputLanguage) ? getConfig().outputLanguage : 'zh';
        const chatFont = aiClampInt(settings.aiChatFont, 10, 32, 13);
        if (opt.chatFont) opt.chatFont.value = String(chatFont);
        if (opt.chatFontVal) opt.chatFontVal.value = String(chatFont);
        if (opt.chatFontEn) {
            opt.chatFontEn.value = settings.aiChatFontEn || 'follow';
            if (!opt.chatFontEn.value) opt.chatFontEn.value = 'follow';
        }
        if (opt.chatFontCjk) {
            opt.chatFontCjk.value = settings.aiChatFontCjk || 'follow';
            if (!opt.chatFontCjk.value) opt.chatFontCjk.value = 'follow';
        }
        if (opt.chatFontCode) {
            opt.chatFontCode.value = settings.aiChatCodeFont || 'follow';
            if (!opt.chatFontCode.value) opt.chatFontCode.value = 'follow';
        }
        if (opt.showThinking) opt.showThinking.checked = settings.aiShowThinking !== false;
        if (opt.showUsage) opt.showUsage.checked = settings.aiShowUsage === true;
        if (opt.turnMetaAll) opt.turnMetaAll.checked = settings.aiShowEveryTurnMeta === true;
        if (opt.contextSlim) opt.contextSlim.checked = settings.aiContextSlim !== false;
        if (opt.assistantCard) opt.assistantCard.checked = settings.aiAssistantCard === true;
        if (opt.inlineWidgets) opt.inlineWidgets.checked = settings.aiInlineWidgets !== false;
        if (opt.todosExpanded) opt.todosExpanded.checked = settings.aiTodosDefaultExpanded === true;
        if (opt.autoTitle) opt.autoTitle.checked = getConfig().autoTitle !== false;
        if (opt.defaultScope) opt.defaultScope.value = normalizeDefaultScope(getConfig().defaultScope);
        if (opt.logEnabled) opt.logEnabled.checked = getConfig().logEnabled !== false;
        if (opt.worklog) opt.worklog.checked = getConfig().worklogEnabled !== false;
        if (opt.appControl) opt.appControl.checked = appControlOn();
        if (opt.notifyInApp) opt.notifyInApp.checked = getConfig().notifyInApp === true;
        if (opt.notifySystem) opt.notifySystem.checked = getConfig().notifySystem === true;
        if (opt.notifyFinish) opt.notifyFinish.checked = getConfig().notifyFinish !== false;
        if (opt.retryMax) opt.retryMax.value = String(getConfig().retryMax);
        if (opt.subAgentMax) opt.subAgentMax.value = String(getConfig().subAgentMax);
        if (opt.subAgentMaxDepth) opt.subAgentMaxDepth.value = String(getConfig().subAgentMaxDepth);
        if (opt.notifyError) opt.notifyError.checked = getConfig().notifyError !== false;
        if (opt.notifyAsk) opt.notifyAsk.checked = getConfig().notifyAsk !== false;
        if (opt.notifySound) opt.notifySound.checked = getConfig().notifySound !== false;
        if (opt.askTimeout) opt.askTimeout.value = String(aiClampInt(getConfig().askTimeout, 0, 3600, 300));
        if (opt.askTimeoutAction) opt.askTimeoutAction.value = getConfig().askTimeoutAction || 'recommended';
        if (opt.logPath) {
            opt.logPath.textContent = '统计中…';
            getAILogRoot().then((dir) => {
                if (opt.logPath) opt.logPath.textContent = dir;
            }).catch(() => {
                if (opt.logPath) opt.logPath.textContent = '不可用';
            });
        }
        if (opt.memoryMode) opt.memoryMode.value = getConfig().memoryMode === 'app' ? 'app' : 'workspace';
        for (const [optKey, settingKey] of Object.entries(AI_INJECT_OPTION_MAP)) {
            if (opt[optKey]) opt[optKey].checked = settings[settingKey] !== false;
        }
        if (opt.threshold) opt.threshold.value = String(aiClamp(Number(getConfig().autoCompactThreshold) || 0.8, 0.5, 0.95));
        if (opt.autoCompact) opt.autoCompact.checked = getConfig().autoCompact !== false;
        permMod.renderApprovedSettings();
        prefMod.renderPreferenceSettings();
        permMod.renderPermissionSettings();
        permMod.refreshPermissionEditors().catch(() => {});
    }

    function refreshMemoryPath() {
        if (!opt.memoryPath) return;
        opt.memoryPath.textContent = '记忆目录：统计中…';
        resolveMemoryDir().then((mem) => {
            opt.memoryPath.textContent = '记忆目录（' + mem.mode + '）：' + mem.dir;
        }).catch((e) => {
            opt.memoryPath.textContent = '记忆目录：' + ((e && e.message) || e);
        });
    }

    function updateProfileField(field, value) {
        const profile = activeProfile();
        if (!profile) return;
        profile[field] = value;
        saveAIConfig();
        if (field === 'name' || field === 'provider') renderProfileSelect();
        if (field === 'provider') refreshThinkingVisibility();
        if (['name', 'provider', 'baseURL', 'apiKey'].includes(field) && opt.modelList) modelMod.renderModelList();
        updateComposerState();
    }

    function bindSettingsPane() {
        if (!opt.name && !opt.modelList) return;
        if (opt.name) opt.name.addEventListener('change', () => {
            const profile = activeProfile();
            if (!profile) return;
            const next = String(opt.name.value || '').trim();
            if (!next) {
                opt.name.value = profile.name;
                return;
            }
            updateProfileField('name', next.slice(0, 60));
            refreshSettingsPane();
        });
        if (opt.provider) opt.provider.addEventListener('change', () => {
            updateProfileField('provider', ['anthropic', 'responses'].includes(opt.provider.value) ? opt.provider.value : 'openai');
            const profile = activeProfile();
            const entry = modelMod.editorEntryOf(profile);
            if (profile && entry && profile.provider === 'anthropic' && entry.thinking) {
                clampThinkingBudget(profile, entry, 'thinking');
                saveAIConfig();
                refreshSettingsPane();
            }
        });
        for (const [node, field] of [[opt.baseURL, 'baseURL'], [opt.apiKey, 'apiKey']]) {
            if (!node) continue;
            node.addEventListener('input', () => updateProfileField(field, String(node.value || '').trim()));
        }
        // 模型 ID 输入：写当前编辑条目；激活条目同步旧字段镜像（saveAIConfig 内统一处理）
        if (opt.model) opt.model.addEventListener('input', () => {
            const profile = activeProfile();
            const entry = modelMod.editorEntryOf(profile);
            if (!profile || !entry) return;
            entry.model = String(opt.model.value || '').trim();
            // 没被手改过的条目跟着配置表走：换 ID 就重新识别窗口与能力。
            // 只回写这三个控件，不做整页刷新——整页刷新会把光标从 ID 输入框里踢出去。
            if (canAutoFill(entry)) modelCatalog.fill(entry);
            saveAIConfig();
            syncModelFieldsFromEntry(entry);
            if (opt.modelEntries) modelMod.renderModelEntries();
            refreshThinkingVisibility();
            refreshThinkingHint();
            renderCatalogNote();
            updateComposerState();
        });
        if (opt.temp) {
            const apply = () => {
                const value = aiClamp(Number(opt.temp.value) || 0, 0, 2);
                if (opt.tempVal) opt.tempVal.textContent = String(value);
                updateProfileField('temperature', value);
            };
            opt.temp.addEventListener('input', apply);
        }
        // 输出窗口 / 上下文窗口：支持 K/M 单位（256K、1M、131K），失焦解析并格式化回填
        if (opt.maxTokens) opt.maxTokens.addEventListener('change', () => {
            const profile = activeProfile();
            const entry = modelMod.editorEntryOf(profile);
            if (!profile || !entry) return;
            entry.outputWindow = windowValue(opt.maxTokens.value, OUTPUT_WINDOW_MIN, OUTPUT_WINDOW_MAX, entry.outputWindow);
            entry.autoFilled = false;
            clampThinkingBudget(profile, entry, 'outputWindow');
            opt.maxTokens.value = formatTokenAmount(entry.outputWindow);
            saveAIConfig();
            refreshSettingsPane();
        });
        if (opt.reasoning) opt.reasoning.addEventListener('change', () => {
            const profile = activeProfile();
            const entry = modelMod.editorEntryOf(profile);
            if (!profile || !entry) return;
            entry.reasoningEffort = opt.reasoning.value || '';
            saveAIConfig();
            renderModelChip();
        });
        if (opt.thinking) opt.thinking.addEventListener('change', () => {
            const profile = activeProfile();
            const entry = modelMod.editorEntryOf(profile);
            if (!profile || !entry) return;
            entry.thinking = !!opt.thinking.checked;
            clampThinkingBudget(profile, entry, 'thinking');
            saveAIConfig();
            refreshSettingsPane();
            if (entry.thinking) setSettingsStatus('扩展思考已开启：请求省略 temperature，预算 ' + entry.thinkingBudget, 'ok');
        });
        if (opt.budget) opt.budget.addEventListener('change', () => {
            const profile = activeProfile();
            const entry = modelMod.editorEntryOf(profile);
            if (!profile || !entry) return;
            entry.thinkingBudget = aiClampInt(opt.budget.value, 1024, 393215, 8000);
            clampThinkingBudget(profile, entry, 'thinkingBudget');
            saveAIConfig();
            refreshSettingsPane();
            setSettingsStatus('思考预算已设为 ' + entry.thinkingBudget + ' tokens', 'ok');
        });
        if (opt.contextWindow) opt.contextWindow.addEventListener('change', () => {
            const profile = activeProfile();
            const entry = modelMod.editorEntryOf(profile);
            if (!profile || !entry) return;
            entry.contextWindow = windowValue(opt.contextWindow.value, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX, entry.contextWindow);
            entry.autoFilled = false;
            opt.contextWindow.value = formatTokenAmount(entry.contextWindow);
            renderWindowHints(entry);
            saveAIConfig();
            modelMod.renderModelEntries();
            updateContextCount();
        });
        if (opt.modalities) {
            opt.modalities.addEventListener('change', () => {
                const profile = activeProfile();
                const entry = modelMod.editorEntryOf(profile);
                if (!profile || !entry) return;
                for (const node of opt.modalities.querySelectorAll('input[data-modality]')) {
                    entry.modalities[node.dataset.modality] = !!node.checked;
                }
                entry.autoFilled = false;
                saveAIConfig();
                renderCatalogNote();
                updateComposerState();
            });
        }
        if (opt.entryAdd) opt.entryAdd.addEventListener('click', modelMod.addEditorEntry);
        // 配置表命中时的手动回填（用户改过窗口后想拿回表里的口径）
        if (opt.catalogFill) opt.catalogFill.addEventListener('click', () => {
            const profile = activeProfile();
            const entry = modelMod.editorEntryOf(profile);
            if (!entry) return;
            entry.autoFilled = true;
            const result = modelCatalog.fill(entry);
            saveAIConfig();
            syncModelFieldsFromEntry(entry);
            renderCatalogNote();
            updateContextCount();
            if (result.changed) setSettingsStatus('已按配置表回填：' + (entry.model || '当前模型'), 'ok');
            else setSettingsStatus('配置表里没有这个模型的窗口数据', 'error');
        });
        if (opt.catalogSync) opt.catalogSync.addEventListener('click', async () => {
            opt.catalogSync.disabled = true;
            opt.catalogSync.textContent = '同步中…';
            try {
                const result = await modelCatalog.sync();
                setSettingsStatus('配置表已同步：' + result.count + ' 个模型（' + result.version + '）', 'ok');
            } catch (e) {
                setSettingsStatus('同步失败：' + ((e && e.message) || e), 'error');
            } finally {
                opt.catalogSync.disabled = false;
                opt.catalogSync.textContent = '立即同步';
                refreshCatalogStatus();
                refreshSettingsPane();
            }
        });
        if (opt.catalogAuto) opt.catalogAuto.addEventListener('change', () => {
            settings.aiCatalogAutoSync = !!opt.catalogAuto.checked;
            saveSettings();
            refreshCatalogStatus();
        });
        if (opt.catalogUrl) {
            opt.catalogUrl.placeholder = modelCatalog.defaultUrl();
            opt.catalogUrl.addEventListener('change', () => {
                const next = String(opt.catalogUrl.value || '').trim();
                if (next && !/^https?:\/\//i.test(next)) {
                    setSettingsStatus('同步地址必须是 http 或 https', 'error');
                    opt.catalogUrl.value = String(settings.aiCatalogURL || '');
                    return;
                }
                settings.aiCatalogURL = next;
                saveSettings();
                refreshCatalogStatus();
            });
        }
        if (opt.keyToggle) opt.keyToggle.addEventListener('click', () => {
            if (!opt.apiKey) return;
            const show = opt.apiKey.type === 'password';
            opt.apiKey.type = show ? 'text' : 'password';
            const label = show ? '隐藏密钥' : '显示密钥';
            opt.keyToggle.setAttribute('aria-pressed', show ? 'true' : 'false');
            opt.keyToggle.setAttribute('aria-label', label);
            opt.keyToggle.dataset.tip = label;
        });
        if (opt.test) opt.test.addEventListener('click', async () => {
            const profile = activeProfile();
            if (!profile) return;
            setSettingsStatus('测试中…');
            try {
                const message = await backend.AITestConnection(configForProfile(profile));
                setSettingsStatus(message || '连接成功', 'ok');
            } catch (e) {
                setSettingsStatus('失败：' + ((e && e.message) || e), 'error');
            }
        });
        // 获取列表：拉取账号可用模型，弹多选层勾选后批量添加为模型条目
        if (opt.models) opt.models.addEventListener('click', async () => {
            const profile = activeProfile();
            if (!profile) return;
            setSettingsStatus('获取中…');
            try {
                const models = await backend.AIListModels(configForProfile(profile));
                const list = (Array.isArray(models) ? models : [])
                    .map((item) => String(typeof item === 'string' ? item : (item && item.id) || '').trim())
                    .filter(Boolean);
                if (!list.length) {
                    setSettingsStatus('未返回模型');
                    return;
                }
                setSettingsStatus('可用模型 ' + list.length + ' 个，勾选后添加', 'ok');
                showModelListPicker(profile, list);
            } catch (e) {
                setSettingsStatus('失败：' + ((e && e.message) || e), 'error');
            }
        });
        if (opt.memoryMode) opt.memoryMode.addEventListener('change', () => {
            getConfig().memoryMode = opt.memoryMode.value === 'app' ? 'app' : 'workspace';
            setMemoryFallbackNotified(false);
            saveAIConfig();
            refreshMemoryPath();
            updateContextCount();
        });
        for (const [optKey, settingKey] of Object.entries(AI_INJECT_OPTION_MAP)) {
            const node = opt[optKey];
            if (!node) continue;
            node.addEventListener('change', () => {
                settings[settingKey] = !!node.checked;
                saveSettings();
                updateContextCount();
            });
        }
        if (opt.prefAdd) opt.prefAdd.addEventListener('click', () => prefMod.addPreference());
        if (opt.scheduleAdd) opt.scheduleAdd.addEventListener('click', () => openScheduleEditor(null, {top: true}));
        if (opt.prefFilter) opt.prefFilter.addEventListener('input', () => prefMod.renderPreferenceSettings());
        if (opt.outputLang) opt.outputLang.addEventListener('change', () => {
            getConfig().outputLanguage = ['zh', 'en', 'auto'].includes(opt.outputLang.value) ? opt.outputLang.value : 'zh';
            saveAIConfig();
            updateContextCount();
            setSettingsStatus('默认输出语言已更新（下一轮生效）', 'ok');
        });
        if (opt.sendKey) opt.sendKey.addEventListener('change', () => {
            settings.aiSendKey = opt.sendKey.value === 'ctrl-enter' ? 'ctrl-enter' : 'enter';
            saveSettings();
            updateSendState();
        });
        // 显示方式：dock/fullscreen 持久化；float 是动作（打开独立窗口），选完回弹到已持久化档位
        if (opt.displayMode) opt.displayMode.addEventListener('change', () => {
            setMode(opt.displayMode.value);
            refreshChatSettings();
        });
        if (opt.chatFont) {
            opt.chatFont.addEventListener('input', () => setAIChatFont(opt.chatFont.value));
        }
        if (opt.chatFontVal) {
            opt.chatFontVal.addEventListener('change', () => setAIChatFont(opt.chatFontVal.value));
            opt.chatFontVal.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    setAIChatFont(opt.chatFontVal.value);
                }
            });
        }
        const bindChatFontSelect = (node, key) => {
            if (!node) return;
            node.addEventListener('change', () => {
                settings[key] = node.value || 'follow';
                saveSettings();
                applyPanelSettings();
            });
        };
        bindChatFontSelect(opt.chatFontEn, 'aiChatFontEn');
        bindChatFontSelect(opt.chatFontCjk, 'aiChatFontCjk');
        bindChatFontSelect(opt.chatFontCode, 'aiChatCodeFont');
        if (panel) {
            panel.addEventListener('wheel', (e) => {
                if (!e.ctrlKey || e.altKey || e.metaKey || !e.deltaY) return;
                e.preventDefault();
                const step = e.deltaY < 0 ? 1 : -1;
                setAIChatFont(aiClampInt(settings.aiChatFont, 10, 32, 13) + step, {deferSave: true});
            }, {passive: false});
        }
        if (opt.showThinking) opt.showThinking.addEventListener('change', () => {
            settings.aiShowThinking = !!opt.showThinking.checked;
            saveSettings();
            applyPanelSettings();
        });
        if (opt.showUsage) opt.showUsage.addEventListener('change', () => {
            settings.aiShowUsage = !!opt.showUsage.checked;
            saveSettings();
            applyPanelSettings();
        });
        if (opt.turnMetaAll) opt.turnMetaAll.addEventListener('change', () => {
            settings.aiShowEveryTurnMeta = !!opt.turnMetaAll.checked;
            saveSettings();
            applyPanelSettings();
            if (isOpen() && currentSession()) renderMessages(true);
        });
        if (opt.contextSlim) opt.contextSlim.addEventListener('change', () => {
            settings.aiContextSlim = !!opt.contextSlim.checked;
            saveSettings();
            // 瘦身只影响下次组装请求；立即刷新统计让用户看到开关效果
            updateContextCount();
        });
        if (opt.assistantCard) opt.assistantCard.addEventListener('change', () => {
            settings.aiAssistantCard = !!opt.assistantCard.checked;
            saveSettings();
            applyPanelSettings();
        });
        if (opt.inlineWidgets) opt.inlineWidgets.addEventListener('change', () => {
            settings.aiInlineWidgets = !!opt.inlineWidgets.checked;
            saveSettings();
            applyPanelSettings();
        });
        if (opt.todosExpanded) opt.todosExpanded.addEventListener('change', () => {
            settings.aiTodosDefaultExpanded = !!opt.todosExpanded.checked;
            saveSettings();
            if (applyTodosCollapseDefault) applyTodosCollapseDefault();
            setSettingsStatus('任务清单：默认' + (opt.todosExpanded.checked ? '展开' : '收起'), 'ok');
        });
        if (opt.autoTitle) opt.autoTitle.addEventListener('change', () => {
            getConfig().autoTitle = !!opt.autoTitle.checked;
            saveAIConfig();
        });
        if (opt.logEnabled) opt.logEnabled.addEventListener('change', () => {
            getConfig().logEnabled = !!opt.logEnabled.checked;
            saveAIConfig();
            setSettingsStatus(getConfig().logEnabled ? '已开启自动对话日志' : '已关闭自动对话日志', 'ok');
            if (getConfig().logEnabled) queueLogSave(currentSession());
        });
        if (opt.worklog) opt.worklog.addEventListener('change', () => {
            getConfig().worklogEnabled = !!opt.worklog.checked;
            saveAIConfig();
            setSettingsStatus('AI 工作日志：' + (opt.worklog.checked ? '已开启' : '已关闭（write_worklog 工具停用）'), 'ok');
        });
        if (opt.defaultScope) opt.defaultScope.addEventListener('change', () => {
            getConfig().defaultScope = normalizeDefaultScope(opt.defaultScope.value);
            opt.defaultScope.value = getConfig().defaultScope;
            saveAIConfig();
            const labels = {read: '只读访问', edit: '每次询问', auto: '自动审批', full: '完全权限'};
            setSettingsStatus('新会话默认权限档：' + (labels[getConfig().defaultScope] || getConfig().defaultScope), 'ok');
        });
        const bindNotifyToggle = (node, key, label) => {
            if (!node) return;
            node.addEventListener('change', () => {
                getConfig()[key] = !!node.checked;
                saveAIConfig();
                setSettingsStatus(label + (node.checked ? '：已开启' : '：已关闭'), 'ok');
            });
        };
        bindNotifyToggle(opt.notifyInApp, 'notifyInApp', '应用内通知');
        bindNotifyToggle(opt.notifySystem, 'notifySystem', 'Windows 系统通知');
        bindNotifyToggle(opt.notifyFinish, 'notifyFinish', '任务完成通知');
        bindNotifyToggle(opt.notifyError, 'notifyError', '任务失败通知');
        bindNotifyToggle(opt.notifyAsk, 'notifyAsk', 'AI 提问通知');
        bindNotifyToggle(opt.notifySound, 'notifySound', '失焦提醒（闪烁/提示音）');
        // app_control 开关：切换后立即刷新技能列表缓存（cadt-ui 技能随开关显隐）
        if (opt.appControl) opt.appControl.addEventListener('change', () => {
            getConfig().appControlEnabled = !!opt.appControl.checked;
            saveAIConfig();
            getSkillsCache().at = 0;
            setSettingsStatus('应用操作（app_control）：' + (opt.appControl.checked ? '已开启' : '已关闭'), 'ok');
        });
        if (opt.retryMax) opt.retryMax.addEventListener('change', () => {
            getConfig().retryMax = aiClampInt(opt.retryMax.value, 0, 10, 5);
            opt.retryMax.value = String(getConfig().retryMax);
            saveAIConfig();
            setSettingsStatus(getConfig().retryMax > 0 ? '失败重试：' + getConfig().retryMax + ' 次（指数退避）' : '失败重试：关闭', 'ok');
        });
        if (opt.subAgentMax) opt.subAgentMax.addEventListener('change', () => {
            getConfig().subAgentMax = aiClampInt(opt.subAgentMax.value, 1, 20, 20);
            opt.subAgentMax.value = String(getConfig().subAgentMax);
            saveAIConfig();
            setSettingsStatus('子代理总数上限：' + getConfig().subAgentMax + '（含递归层级，不含主代理）', 'ok');
        });
        if (opt.subAgentMaxDepth) opt.subAgentMaxDepth.addEventListener('change', () => {
            getConfig().subAgentMaxDepth = aiClampInt(opt.subAgentMaxDepth.value, 0, 20, 0);
            opt.subAgentMaxDepth.value = String(getConfig().subAgentMaxDepth);
            saveAIConfig();
            setSettingsStatus(getConfig().subAgentMaxDepth > 0
                ? '子代理递归层级：最多 ' + getConfig().subAgentMaxDepth + ' 层'
                : '子代理递归层级：不设限', 'ok');
        });
        if (opt.askTimeout) opt.askTimeout.addEventListener('change', () => {
            getConfig().askTimeout = aiClampInt(opt.askTimeout.value, 0, 3600, 300);
            opt.askTimeout.value = String(getConfig().askTimeout);
            saveAIConfig();
            setSettingsStatus(getConfig().askTimeout > 0 ? 'AskQuestion 超时：' + getConfig().askTimeout + ' 秒' : 'AskQuestion 不超时', 'ok');
        });
        if (opt.askTimeoutAction) opt.askTimeoutAction.addEventListener('change', () => {
            getConfig().askTimeoutAction = ['recommended', 'wait', 'abort', 'ai_decide'].includes(opt.askTimeoutAction.value)
                ? opt.askTimeoutAction.value
                : 'recommended';
            opt.askTimeoutAction.value = getConfig().askTimeoutAction;
            saveAIConfig();
            const labels = {recommended: '按 AI 推荐项继续', wait: '继续阻塞等待', abort: '直接停止本轮', ai_decide: '交给 AI 决定'};
            setSettingsStatus('AskQuestion 超时处理：' + labels[getConfig().askTimeoutAction], 'ok');
        });
        if (opt.openLogs) opt.openLogs.addEventListener('click', openAILogDir);
        if (opt.approvedClear) opt.approvedClear.addEventListener('click', () => {
            if (!getConfig().approvedPaths.length) return;
            askConfirm('清除全部「总是允许」的文件写操作授权？清除后恢复逐次审批。', () => {
                getConfig().approvedPaths = [];
                saveAIConfig();
                permMod.renderApprovedSettings();
                flash('已清除全部写操作授权');
            }, '清除', '清除授权');
        });
        if (opt.permissionClassifier) opt.permissionClassifier.addEventListener('change', () => {
            getConfig().autoClassifier = !!opt.permissionClassifier.checked;
            saveAIConfig();
            setSettingsStatus(getConfig().autoClassifier
                ? '自动审批分类器：已开启（规则无法判定时额外请求一次模型）'
                : '自动审批分类器：已关闭', 'ok');
        });
        if (opt.permissionClassifierModel) opt.permissionClassifierModel.addEventListener('change', () => {
            const wanted = resolveModelRef(opt.permissionClassifierModel.value, getConfig().profiles);
            opt.permissionClassifierModel.value = wanted;
            getConfig().autoClassifierModel = wanted;
            saveAIConfig();
            const sep = wanted.indexOf('|');
            const selected = sep >= 0
                ? getConfig().profiles.find((profile) => profile.id === wanted.slice(0, sep))
                : null;
            const entry = selected ? modelEntryOf(selected, wanted.slice(sep + 1)) : null;
            const label = selected && entry ? (modelRefLabel(selected, entry) || wanted) : '当前模型';
            setSettingsStatus('自动审批分类器模型：' + label, 'ok');
        });
        if (opt.localLinear) opt.localLinear.addEventListener('change', () => {
            getConfig().localClassifierLinear = opt.localLinear.value === 'off' ? 'off' : 'builtin';
            saveAIConfig();
            permMod.renderLocalClassifierStatus();
            setSettingsStatus(getConfig().localClassifierLinear === 'off' ? '线性模型：已关闭' : '线性模型：内置线性模型', 'ok');
        });
        if (opt.localSemantic) opt.localSemantic.addEventListener('change', () => {
            getConfig().localClassifierSemantic = opt.localSemantic.value;
            saveAIConfig();
            permMod.renderLocalClassifierStatus();
            const picked = opt.localSemantic.options[opt.localSemantic.selectedIndex];
            setSettingsStatus('语义模型：' + ((picked && picked.textContent) || opt.localSemantic.value), 'ok');
        });
        if (opt.localRefresh) opt.localRefresh.addEventListener('click', async () => {
            if (!refreshPlugins) return;
            try {
                await refreshPlugins();
            } catch (e) {
                // loadPlugins 自己收集错误到状态行，这里不中断刷新后的重渲染
            }
            permMod.renderLocalClassifierSettings();
            setSettingsStatus('已重新扫描插件与模型注册状态', 'ok');
        });
        if (opt.localClassifierStrictness) opt.localClassifierStrictness.addEventListener('change', () => {
            getConfig().localClassifierStrictness = normalizeLocalClassifierStrictness(opt.localClassifierStrictness.value);
            saveAIConfig();
            setSettingsStatus('端侧分类器严格度：' + permMod.LOCAL_CLASSIFIER_STRICTNESS_NAMES[getConfig().localClassifierStrictness], 'ok');
        });
        if (opt.localClassifierPersonalize) opt.localClassifierPersonalize.addEventListener('change', () => {
            getConfig().localClassifierPersonalize = !!opt.localClassifierPersonalize.checked;
            saveAIConfig();
            permMod.renderLocalClassifierStatus();
            setSettingsStatus(getConfig().localClassifierPersonalize
                ? '个性化学习：已开启（学习你在端侧审批卡上的裁定）'
                : '个性化学习：已关闭', 'ok');
        });
        if (opt.localClassifierTest) opt.localClassifierTest.addEventListener('input', () => {
            permMod.scheduleLocalClassifierTest();
        });
        if (opt.localClassifierReset) opt.localClassifierReset.addEventListener('click', () => {
            const mod = typeof localClassifier === 'function' ? localClassifier() : null;
            if (!mod) return;
            askConfirm('重置端侧分类器？丢弃个性化修正，回到出厂权重。学习样本保留并会自动重训——若样本已被污染，权重会回弹到接近重置前；彻底清除请用「清空学习数据」。', () => {
                mod.resetToFactory().then(() => {
                    permMod.renderLocalClassifierStatus();
                    setSettingsStatus('端侧分类器已重置回出厂权重', 'ok');
                }).catch((e) => setSettingsStatus('重置失败：' + ((e && e.message) || e), 'error'));
            }, '重置', '重置分类器');
        });
        if (opt.localClassifierClear) opt.localClassifierClear.addEventListener('click', () => {
            const mod = typeof localClassifier === 'function' ? localClassifier() : null;
            if (!mod) return;
            askConfirm('清空端侧分类器的全部学习数据（样本 + 个性化修正）？该操作不可撤销。', () => {
                mod.clearLearningData().then(() => {
                    permMod.renderLocalClassifierStatus();
                    setSettingsStatus('已清空端侧分类器学习数据', 'ok');
                }).catch((e) => setSettingsStatus('清空失败：' + ((e && e.message) || e), 'error'));
            }, '清空', '清空学习数据');
        });
        if (opt.localClassifierExport) opt.localClassifierExport.addEventListener('click', () => {
            const mod = typeof localClassifier === 'function' ? localClassifier() : null;
            if (!mod) return;
            mod.exportData().then((dest) => {
                if (dest) {
                    setSettingsStatus('已导出：' + dest, 'ok');
                    flash('分类器数据已导出到 ' + dest);
                }
            }).catch((e) => setSettingsStatus('导出失败：' + ((e && e.message) || e), 'error'));
        });
        if (opt.permissionsSave) opt.permissionsSave.addEventListener('click', () => {
            const allow = parseRuleLines(opt.permissionsAllow ? opt.permissionsAllow.value : '', 'allow');
            const ask = parseRuleLines(opt.permissionsAsk ? opt.permissionsAsk.value : '', 'ask');
            const deny = parseRuleLines(opt.permissionsDeny ? opt.permissionsDeny.value : '', 'deny');
            const errors = [...allow.errors, ...ask.errors, ...deny.errors];
            if (errors.length) {
                setSettingsStatus('规则有误：' + errors[0] + (errors.length > 1 ? '（共 ' + errors.length + ' 处）' : ''), 'error');
                return;
            }
            const rules = emptyPermissionRules();
            for (const kind of Object.keys(rules)) {
                rules[kind].allow = allow.rules[kind].allow;
                rules[kind].ask = ask.rules[kind].ask;
                rules[kind].deny = deny.rules[kind].deny;
            }
            permMod.enqueueProjectRulesMutation(() => permMod.saveProjectRules(rules)).then(() => {
                setSettingsStatus('项目权限规则已保存（' + countPermissionRules(rules) + ' 条）', 'ok');
                permMod.renderPermissionSettings();
                permMod.refreshPermissionEditors(true).catch(() => {});
            }).catch((e) => {
                setSettingsStatus('保存失败：' + ((e && e.message) || e), 'error');
            });
        });
        if (opt.permissionsReload) opt.permissionsReload.addEventListener('click', () => {
            permMod.refreshPermissionEditors(true).then(() => {
                setSettingsStatus('已重新加载项目权限规则', 'ok');
            }).catch((e) => setSettingsStatus('加载失败：' + ((e && e.message) || e), 'error'));
        });
        const addPermissionRuleFromForm = () => {
            const kind = opt.permissionAddKind ? opt.permissionAddKind.value : 'command';
            const behavior = opt.permissionAddBehavior ? opt.permissionAddBehavior.value : 'allow';
            const pattern = opt.permissionAddPattern ? opt.permissionAddPattern.value.trim() : '';
            if (!pattern) {
                setSettingsStatus('规则内容不能为空', 'error');
                return;
            }
            permMod.addProjectRule(kind, behavior, pattern).then((added) => {
                if (added && opt.permissionAddPattern) opt.permissionAddPattern.value = '';
                setSettingsStatus(added
                    ? '已添加规则：' + pattern + ' → ' + behavior
                    : '规则已存在：' + pattern, added ? 'ok' : 'error');
            }).catch((e) => setSettingsStatus('保存失败：' + ((e && e.message) || e), 'error'));
        };
        if (opt.permissionAddBtn) opt.permissionAddBtn.addEventListener('click', addPermissionRuleFromForm);
        if (opt.permissionAddPattern) {
            opt.permissionAddPattern.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    addPermissionRuleFromForm();
                }
            });
        }
        if (opt.permissionsSessionClear) opt.permissionsSessionClear.addEventListener('click', () => {
            const session = currentSession();
            if (!session || !permMod.commandRulesFor(session).length) return;
            permMod.commandApprovalRules.delete(session.id);
            permMod.renderPermissionSettings();
            setSettingsStatus('已清除本会话命令授权', 'ok');
        });
        if (opt.presetAdd) opt.presetAdd.addEventListener('click', prefMod.addPresetProfile);
        if (opt.modelCreate) opt.modelCreate.addEventListener('click', () => modelMod.openModelEditor(null));
        if (opt.modelEditorClose) opt.modelEditorClose.addEventListener('click', () => modelMod.closeModelEditor(false));
        if (opt.modelEditorMask) opt.modelEditorMask.addEventListener('click', () => modelMod.closeModelEditor(false));
        if (opt.modelEditorCancel) opt.modelEditorCancel.addEventListener('click', () => modelMod.closeModelEditor(false));
        if (opt.modelEditorSave) opt.modelEditorSave.addEventListener('click', () => modelMod.closeModelEditor(true));
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modelEditorState) {
                e.preventDefault();
                e.stopPropagation();
                modelMod.closeModelEditor(false);
            }
        }, true);
        if (opt.openMemory) opt.openMemory.addEventListener('click', () => {
            // 设置窗保持打开：对话框临时挂到 body 顶层显示
            showMemoryDialog({top: true});
        });
        if (opt.openSkills) opt.openSkills.addEventListener('click', () => {
            showSkillsDialog({top: true});
        });
        if (opt.proxy) opt.proxy.addEventListener('change', () => {
            const profile = activeProfile();
            if (!profile) return;
            const mode = opt.proxy.value;
            if (opt.proxyURL) opt.proxyURL.disabled = mode !== 'custom';
            if (mode === 'system') profile.proxy = 'system';
            else if (mode === 'direct') profile.proxy = 'direct';
            else {
                profile.proxy = String((opt.proxyURL && opt.proxyURL.value) || '').trim() || 'http://';
                if (opt.proxyURL) opt.proxyURL.value = profile.proxy;
            }
            saveAIConfig();
            setSettingsStatus('代理已更新（下一轮生效）', 'ok');
        });
        if (opt.proxyURL) opt.proxyURL.addEventListener('change', () => {
            const profile = activeProfile();
            if (!profile || !opt.proxy || opt.proxy.value !== 'custom') return;
            profile.proxy = String(opt.proxyURL.value || '').trim();
            saveAIConfig();
            setSettingsStatus('代理地址已保存', 'ok');
        });
        if (opt.headers) opt.headers.addEventListener('change', () => {
            const profile = activeProfile();
            if (!profile) return;
            const lines = String(opt.headers.value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
            if (lines.length > 8) {
                setSettingsStatus('自定义请求头最多 8 条', 'error');
                refreshSettingsPane();
                return;
            }
            const headers = {};
            for (const line of lines) {
                const eq = line.indexOf('=');
                const colon = line.indexOf(':');
                const index = eq >= 0 ? eq : colon;
                if (index <= 0) {
                    setSettingsStatus('请求头格式：Header=value', 'error');
                    refreshSettingsPane();
                    return;
                }
                const name = line.slice(0, index).trim();
                const value = line.slice(index + 1).trim();
                if (name) headers[name] = value;
            }
            profile.extraHeaders = headers;
            saveAIConfig();
            setSettingsStatus('自定义请求头已保存（' + Object.keys(headers).length + ' 条）', 'ok');
            refreshSettingsPane();
        });
        if (opt.threshold) opt.threshold.addEventListener('change', () => {
            getConfig().autoCompactThreshold = aiClamp(Number(opt.threshold.value) || 0.8, 0.5, 0.95);
            opt.threshold.value = String(getConfig().autoCompactThreshold);
            saveAIConfig();
            updateCtxBanner();
        });
        if (opt.autoCompact) opt.autoCompact.addEventListener('change', () => {
            getConfig().autoCompact = !!opt.autoCompact.checked;
            saveAIConfig();
            setSettingsStatus(getConfig().autoCompact ? '已开启自动压缩上下文' : '已关闭自动压缩上下文', 'ok');
            updateCtxBanner();
        });
        if (opt.prompt) opt.prompt.addEventListener('change', () => {
            const selected = promptById(opt.prompt.value);
            if (opt.promptText) opt.promptText.value = selected ? selected.content : '';
            if (opt.promptDel) opt.promptDel.disabled = !selected || !!selected.builtin;
        });
        if (opt.promptSave) opt.promptSave.addEventListener('click', () => {
            const selected = promptById(opt.prompt && opt.prompt.value);
            if (!selected) return;
            const content = String((opt.promptText && opt.promptText.value) || '').trim();
            if (!content) {
                setSettingsStatus('模板内容不能为空', 'error');
                return;
            }
            selected.content = content;
            saveAIConfig();
            prefMod.refreshPromptSettings();
            updateContextCount();
            setSettingsStatus('模板已保存：' + selected.name, 'ok');
        });
        if (opt.promptNew) opt.promptNew.addEventListener('click', () => {
            const content = String((opt.promptText && opt.promptText.value) || '').trim() || AI_DEFAULT_SYSTEM_PROMPT;
            const create = (name) => {
                const prompt = {id: aiNowId('prompt-'), name: String(name || '').trim().slice(0, 40) || '新模板', content, builtin: false};
                getConfig().prompts.push(prompt);
                saveAIConfig();
                prefMod.refreshPromptSettings();
                if (opt.prompt) opt.prompt.value = prompt.id;
                if (opt.promptText) opt.promptText.value = prompt.content;
                setSettingsStatus('已新建模板：' + prompt.name, 'ok');
            };
            if (showNameDialog) {
                showNameDialog({title: '新建提示词模板', label: '模板名称', placeholder: '例如：数据解释（精简）', okLabel: '创建', onSubmit: create});
            } else {
                const name = window.prompt('模板名称', '新模板');
                if (name) create(name);
            }
        });
        if (opt.promptDel) opt.promptDel.addEventListener('click', () => {
            const selected = promptById(opt.prompt && opt.prompt.value);
            if (!selected) return;
            if (selected.builtin) {
                setSettingsStatus('内置模板不可删除', 'error');
                return;
            }
            askConfirm('删除模板「' + selected.name + '」？', () => {
                getConfig().prompts = getConfig().prompts.filter((prompt) => prompt.id !== selected.id);
                if (getConfig().activePromptId === selected.id) {
                    getConfig().activePromptId = getConfig().prompts[0] ? getConfig().prompts[0].id : '';
                }
                saveAIConfig();
                prefMod.refreshPromptSettings();
                updateContextCount();
                setSettingsStatus('已删除模板：' + selected.name, 'ok');
            }, '删除', '删除模板');
        });
        if (opt.promptDefault) opt.promptDefault.addEventListener('click', () => {
            const selected = promptById(opt.prompt && opt.prompt.value);
            if (!selected) return;
            getConfig().activePromptId = selected.id;
            saveAIConfig();
            prefMod.refreshPromptSettings();
            updateContextCount();
            setSettingsStatus('默认提示词模板：' + selected.name, 'ok');
        });
        if (opt.exportBtn) opt.exportBtn.addEventListener('click', ioMod.exportAIConfig);
        if (opt.importBtn) opt.importBtn.addEventListener('click', ioMod.importAIConfig);
        if (opt.clearSessions) opt.clearSessions.addEventListener('click', () => {
            askConfirm('清空全部 AI 会话（含消息、任务清单与变更记录）？', () => {
                setSessions([createSessionData()]);
                permMod.commandApprovalRules.clear();
                clearMessageQueue();
                getConfig().activeSessionId = getSessions()[0].id;
                if (sessionUseDisk()) {
                    // 先删干净旧目录，再把当前空会话写回去，避免清空后又被队列写回。
                    const fresh = getSessions()[0];
                    sessionStore.flush()
                        .then(() => sessionStore.removeAll())
                        .then(() => sessionStore.rewriteSession(fresh))
                        .catch(notifySessionStoreError);
                    saveAIConfig();
                } else {
                    persistSessions();
                }
                renderSessionList();
                renderMessages(true);
                updateComposerState();
                setSettingsStatus('已清空全部会话', 'ok');
            }, '清空', '清空全部会话');
        });
        if (backend.AIAppDir) {
            Promise.resolve(backend.AIAppDir()).then((dir) => {
                if (opt.dir && dir) opt.dir.textContent = '应用数据目录：' + dir;
            }).catch(() => {});
        }
        refreshChatSettings();
        refreshSettingsPane();
        prefMod.renderPresetSelect();
        prefMod.refreshPromptSettings();
        genMod.bindGenPane();
    }

    // —— 四个子域：顺序 model → pref（要 openModelEditor/renderModelList）
    //    → io（要 renderModelList/refreshPromptSettings/aiAddUnique）→ perm（无外部依赖，自注册插件广播监听）
    const modelMod = createAIModelSettings(ctx, {setSettingsStatus, refreshSettingsPane});
    // 生图与视频模型 pane：自管 DOM（列表 + 编辑器弹窗），refreshSettingsPane 驱动列表刷新
    const genMod = createAIGenSettings(ctx, {setSettingsStatus, refreshSettingsPane});
    const prefMod = createAIPreferenceSettings(ctx, {
        openModelEditor: modelMod.openModelEditor,
        renderModelList: modelMod.renderModelList,
        setSettingsStatus,
    });
    const ioMod = createAISettingsIO(ctx, {
        setSettingsStatus, refreshSettingsPane, refreshChatSettings,
        renderModelList: modelMod.renderModelList,
        refreshPromptSettings: prefMod.refreshPromptSettings,
        aiAddUnique: prefMod.aiAddUnique,
        editorEntryOf: modelMod.editorEntryOf,
    });
    const permMod = createAIPermissionSettings(ctx, {});
    // 个性化（称呼 / 名字 / 风格 / 人设 / 长期指令）：自管 DOM 与绑定，
    // 首次 render 时幂等 bind，之后由 refreshSettingsPane / 导航点击驱动
    const personaMod = createAIPersonalizationSettings(ctx, {setSettingsStatus});
    refreshPersonaPane = personaMod.refreshPersonalizationPane;

    return {
        ...permMod, ...prefMod, ...modelMod, ...ioMod, ...personaMod, ...genMod,
        setSettingsStatus, settingsFormDisabled, refreshThinkingVisibility, clampThinkingBudget, refreshSettingsPane, bindSettingsPane, refreshChatSettings, refreshMemoryPath,
    };
}
