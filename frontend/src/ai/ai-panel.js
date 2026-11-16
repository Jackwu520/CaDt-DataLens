// ai-panel.js：右侧 AI 助手面板（批次 2–6：会话 / 流式聊天 / 思考链 / 三形态 / 工具桥 / 记忆 / 技能 / 写审批 / Todolist / 变更记录 / 提示词 / 压缩 / 设置）
// 设计文档见 docs/finished-plans/ai-panel.md。
import {iconSvg} from '../core/icons.js';
import {createContextMenu} from '../shell/contextmenu.js';
import {mergePluginAIRequest, pluginAIAccounts} from '../shell/plugin-ai-providers.js';
import {copyImageUrlToClipboard} from '../core/image-clipboard.js';
import {createImageLightbox} from '../shell/image-lightbox.js';
import {createFileIcon} from '../core/fileicons.js';
import {buildSessionOutlineItems} from './session-outline.js';
import {createSessionDiskStore} from './ai-session-disk.js';
import {
    AI_MASCOT_PHRASES, mascotPhraseIndex, phrasesForPhase, randomMascotSalt,
} from './ai-mascot-phrases.js';
import {createModelCatalogStore} from './model-catalog.js';
import {replaySessionLog, isSilentInjection, isTurnBoundaryMessage, sessionActivityTs} from './ai-session-store.js';
import {formatSessionSearchResult, sessionLogDigest} from './ai-session-tools.js';
import {formatTerminalList, formatTerminalRead, terminalSendLabel} from './ai-terminal-tools.js';
import {
    globMatchPath,
    humanSizeBytes,
    locateEditTarget,
    normalizeFileUrlTarget,
    normalizeReadWindow,
    readWindowOf,
    renderDirTreeText,
} from './ai-file-tools.js';
import {redactScopePaths} from './ai-scope-redact.js';
import {createLoopGuard} from './ai-loop-guard.js';
import {createSystemTakeoverHost} from './ai-system-takeover.js';
import {buildNotifyActivationPayload, desktopNotifyTargets} from './ai-notify-policy.js';
import {prepareImagePayload} from './ai-image-encode.js';
import {
    DEFAULT_PROVIDER_BASE_URL,
    defaultExternalToolsConfig,
    defaultSearchCount,
    effectiveExternalMode,
    externalCapabilityUsable,
    formatAsrOutput,
    formatMcpSourceLine,
    formatOcrOutput,
    formatTtsOutput,
    normalizeExternalToolsConfig,
} from './ai-external-tools.js';
import {arrayBufferToBase64, isDirectAsrPath, transcodeAudioToWav16k} from './ai-audio-transcode.js';
import {
    addReadRoot,
    hardReadDenyReason,
    normalizeReadRoot,
    normalizeReadRoots,
    readRootCoversAny,
    userNamedPath,
} from './ai-read-roots.js';
import {
    analyzeDangerousCommand,
    analyzeEnvValueExposure,
    analyzeReadOnlyCommand,
    collectCommandFamilies,
    commandFamilySignature,
    commandText,
    gitFlowSafeCommand,
    matchCommandRule,
} from './ai-command-rules.js';
import {
    PERMISSION_VERSION,
    countPermissionRules,
    decidePermission,
    emptyPermissionRules,
    formatRuleLines,
    isWebApproval,
    normalizeDefaultScope,
    normalizeLocalClassifierStrictness,
    normalizePermissionRules,
    parseRuleLines,
    webRuleSubject,
    writeRuleSubject,
} from './ai-permissions.js';
import {createAILocalClassifier, hasVerdictDisagreement} from './ai-local-classifier.js';
import {parseClassifierVerdict} from './ai-classifier-verdict.js';
import {GIT_ACTIONS, buildGitActionPrompt} from './ai-git.js';
import {createAIReminders, normalizeReminders, remindersForPrompt, reminderAddBlocked} from './ai-reminders.js';
import {normalizeAppMessage, appMessageIcon, detectAppMessage} from './ai-app-message.js';
import {inspectToolArguments, safeToolArguments} from './ai-tool-args.js';
import {patchErrorParts} from './ai-patch-error.js';
import {patchAllowApply, lastUserTextOf} from './ai-patch-policy.js';
import {
    CONTEXT_WINDOW_MAX,
    CONTEXT_WINDOW_MIN,
    MODALITY_KEYS,
    MODALITY_LABELS,
    OUTPUT_WINDOW_MAX,
    OUTPUT_WINDOW_MIN,
    applyOutputWindowLimit,
    configForModel,
    ctxLimitTiersFor,
    effectiveContextWindow,
    findModelEntry,
    formatTokenAmount,
    migrateAccountModels,
    modelEntryOf,
    modelRefLabel,
    normalizeCtxLimit,
    normalizeModalities,
    normalizeModelEntry,
    parseTokenAmount,
    reasoningLevelInfo,
    resolveModelId,
    resolveModelRef,
    windowValue,
} from './ai-config-model.js';
import {
    classifyGenRef,
    dataURLBytes,
    GEN_REF_BYTES_LIMIT,
    GEN_REF_LIMIT,
    genModelByRef,
    isAsyncGenModel,
    mergeGenModelEntry,
    normalizeGenModels,
    normalizeGenSnapshot,
} from './ai-gen-model.js';
import {createAIGenJobs} from './ai-gen-jobs.js';
import {
    AI_CONFIG_KEY,
    AI_SESSIONS_KEY,
    AI_STORAGE_MODE_KEY,
    AI_CONFIG_MODE_KEY,
    AI_SESSION_MIGRATED_AT_KEY,
    AI_SESSION_MIGRATED_IDS_KEY,
    AI_LEGACY_KEEP_DAYS,
    TOOL_INTERRUPTED_TEXT,
    TOOL_INTERRUPTED_RE,
    AI_TOOL_ROUND_LIMIT,
    AI_CHAT_INPUT_LIMIT,
    AI_ARCHIVE_LIMIT,
    AI_LEGACY_SESSION_LIMIT,
    AI_WRITE_LIMIT,
    AI_PATCH_LIMIT,
    AI_PATCH_MAX_ATTEMPTS,
    AI_DIFF_MAX_LINES,
    AI_DIFF_PREVIEW_LIMIT,
    AI_CHANGES_LIMIT,
    AI_SCOPES,
    AI_WRITE_SCOPES,
    AI_TODO_LIMIT,
    AI_PREF_LIMIT,
    AI_PREF_TEXT_LIMIT,
    AI_SESSION_HISTORY_SNIPPET,
    AI_SESSION_HISTORY_OUTPUT,
    AI_SESSION_HISTORY_SCAN_MAX,
    AI_REMINDER_LIMIT,
    AI_REMINDER_TITLE_MAX,
    AI_REMINDER_DETAIL_MAX,
    AI_INJECT_OPTION_MAP,
    AI_IMAGE_LIMIT,
    AI_IMAGE_MAX_INPUT_BYTES,
    AI_IMAGE_MAX_DIM,
    AI_IMAGE_MAX_BASE64,
    AI_IMAGE_MESSAGE_BUDGET,
    AI_IMAGE_MIMES,
    AI_VIDEO_LIMIT,
    AI_VIDEO_ESTIMATE_TOKENS,
    AI_DEFAULT_SYSTEM_PROMPT,
    AI_LEGACY_DEFAULT_PROMPTS,
    aiNormalizedPromptText,
    AI_BUILTIN_SKILLS,
    AI_BUILTIN_PROMPTS,
    AI_PRESETS,
    AI_COMPACT_SYSTEM_PROMPT,
    AI_TITLE_SYSTEM_PROMPT,
    AI_COMMANDS,
    aiClamp,
    aiClampInt,
    aiNowId,
    aiTextOf,
    aiIsCJK,
    aiEstimateTokens,
    aiFormatTime,
    aiFormatLocalMs,
    describeAISchedule,
    aiFormatDuration,
    aiFormatLiveDuration,
    aiFormatSessionTime,
    aiNormalizeImage,
    aiImageSrc,
    aiImageFromSrc,
    aiImageExt,
    aiEstimateImageTokens,
    aiImageStats,
    aiNormalizeVideo,
    aiVideoFromSrc,
    isReadableVideoPath,
    aiEstimateVideoTokens,
    aiMsgActionsStepMode,
    aiSafeFileStem,
} from './ai-constants.js';
import {recordRead, recordWrite, checkWriteFresh} from './ai-write-guard.js';
import {createAIToolDefs} from './ai-tool-defs.js';
import {createAISystemContext} from './ai-system-context.js';
import {createAIWorktree, normalizeWorktreeState, agentWorktreeWriteVerdict} from './ai-worktree.js';
import {createAITodos, shouldSendTodosCheck, todosCheckText} from './ai-todos.js';
import {createScrollGesture, createShrinkBurst, nextStickState, shouldRefollowGrowth, STRICT_BOTTOM_PX} from './ai-scroll-follow.js';
import {createAIChangesUI} from './ai-changes-ui.js';
import {createAIGitUi} from './ai-git-ui.js';
import {createAISlash} from './ai-slash.js';
import {createAIMessageQueue} from './ai-message-queue.js';
import {createAISchedule} from './ai-schedule.js';
import {createAITimer} from './ai-timer.js';
import {createAISessionList} from './ai-session-list.js';
import {createAIComposer} from './ai-composer.js';
import {quoteMarkupFromAttachments, splitQuotePrefix, quoteExcerpt, quoteLabel, quoteChipLabel, AI_QUOTE_KIND} from './ai-quote.js';
import {parseFileRef, pickOpenFileMatch, applyFileRefChip} from './ai-file-refs.js';
import {createAIToolCards} from './ai-tool-cards.js';
import {createAITakeover} from './ai-takeover.js';
import {
    PLAN_DIR_REL,
    isPlanMessage,
    planFileBody,
    planFileRelPath,
} from './ai-plan-file.js';
import {createAIManageDialogs} from './ai-manage-dialogs.js';
import {createAISettingsDialog} from './ai-settings-dialog.js';
import {createAISubagents} from './ai-subagents.js';
import {createAIAgentNotices} from './ai-agent-notices.js';
import {createAISidechat} from './ai-sidechat.js';
import {forkMessages, forkSettings} from './ai-session-fork.js';
import {createAISessionSend} from './ai-session-send.js';
import {compactTranscriptOf, computeCompactCutoff, buildCompactSummary, applyCompactToSession, buildCompactMessages, compactThresholdOf, COMPACT_KEEP_TAIL} from './ai-compact.js';
import {createAIMcp} from './ai-mcp.js';
import {mcpConfigView, mcpServerCommandPreview, mergeMcpServerConfig, planMcpServerDelete} from './ai-mcp-config.js';
import {createAIMcpSettings} from './ai-mcp-settings.js';
import {
    escapeXmlText, normalizePersona, personaSegments, resolveAssistantName,
} from './ai-persona.js';

export function createAIPanel(options) {
    const opts = options || {};
    const panel = opts.panel;
    if (!panel) throw new Error('AI 面板节点不存在');
    const dockParent = opts.dockParent;
    const overlayParent = opts.overlayParent;
    const backend = opts.backend || {};
    const settings = opts.settings || {};
    const saveSettings = typeof opts.saveSettings === 'function' ? opts.saveSettings : () => {};
    // 模型配置表（内置快照 + 远端缓存）：同步、过期判断、合并全在 model-catalog.js，
    // 这里只持有实例，设置页与模型编辑器都经 ctx 拿它。
    const modelCatalog = createModelCatalogStore({
        backend,
        getSettings: () => settings,
        now: () => Date.now(),
    });
    const flash = typeof opts.flash === 'function' ? opts.flash : () => {};
    const copyText = typeof opts.copyText === 'function' ? opts.copyText : async () => {};
    const renderMarkdown = typeof opts.renderMarkdown === 'function'
        ? opts.renderMarkdown
        : (text) => '<pre>' + String(text || '').replace(/[&<>]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c])) + '</pre>';
    // mermaid 渲染（main.js 由 writing-ui 提供）：AI 回复里的 ```mermaid 占位渲染成图，
    // 为空时占位保持原样（退化成不可见图块，与功能验证报告 §1.3.3 一致的兜底）
    const renderMermaidBlocks = typeof opts.renderMermaidBlocks === 'function' ? opts.renderMermaidBlocks : null;
    const askConfirm = typeof opts.confirm === 'function'
        ? opts.confirm
        : (message, action) => { if (window.confirm(message)) action(); };
    const showNameDialog = typeof opts.nameDialog === 'function' ? opts.nameDialog : null;
    const openSettings = typeof opts.openSettings === 'function' ? opts.openSettings : () => {};
    // 行式下拉增强器（settings/settings-select.js）：设置页里的原生 select 会被扫描增强，
    // 但设置页弹窗（生图条目编辑器等）不在 .settings-pane 里，得由弹窗自己逐个调。
    const enhanceSelect = typeof opts.enhanceSelect === 'function' ? opts.enhanceSelect : null;
    const setDragCursor = typeof opts.setDragCursor === 'function' ? opts.setDragCursor : () => {};
    const commandOutput = typeof opts.commandOutput === 'function' ? opts.commandOutput : null;
    const onLayout = typeof opts.onLayout === 'function' ? opts.onLayout : () => {};
    // 面板状态（开合 / 显示方式 / 消息流）变化的宿主通知：结构面板据此决定
    // 「文件结构 / 会话结构」的可见性与内容
    const onPanelStateChange = typeof opts.onPanelStateChange === 'function' ? opts.onPanelStateChange : null;
    // 会话回合开始 / 结束的宿主通知（attachStream / detachStream 处触发，零延迟）。
    // 宿主据此做布局让位（编辑区自动收起）。isCurrent 表示这个回合是否属于用户正在查看的
    // 会话——后台会话在跑不该改变当前布局，由宿主自行决定是否理会。
    // 只挂真正的会话回合：上下文压缩（oneShot）是后台动作，不改变布局。
    const onTurnStateChange = typeof opts.onTurnStateChange === 'function' ? opts.onTurnStateChange : null;
    const getWorkspaceContext = typeof opts.getWorkspaceContext === 'function' ? opts.getWorkspaceContext : () => ({workspaceFolder: '', activeFile: null, openFiles: []});
    const getGitRepo = typeof opts.getGitRepo === 'function' ? opts.getGitRepo : () => null;
    const openWorkspaceFolder = typeof opts.openWorkspaceFolder === 'function' ? opts.openWorkspaceFolder : null;
    const getScopeRoot = typeof opts.getScopeRoot === 'function' ? opts.getScopeRoot : () => '';
    const getSelection = typeof opts.getSelection === 'function' ? opts.getSelection : () => null;
    const pickFiles = typeof opts.pickFiles === 'function' ? opts.pickFiles : null;
    const showContextMenu = typeof opts.showContextMenu === 'function' ? opts.showContextMenu : null;
    const openPath = typeof opts.openPath === 'function' ? opts.openPath : () => {};
    // 打开文件并跳行（main.js 的 openTargets）：read_file 卡路径超链接用
    const openTargets = typeof opts.openTargets === 'function' ? opts.openTargets : null;
    // 虚拟只读文档（main.js 提供）：汇总卡「审阅」用它打开拼接后的 diff
    const openVirtualDoc = typeof opts.openVirtualDoc === 'function' ? opts.openVirtualDoc : null;
    const isFileDirty = typeof opts.isFileDirty === 'function' ? opts.isFileDirty : () => false;
    const onFileChanged = typeof opts.onFileChanged === 'function' ? opts.onFileChanged : () => {};
    const runHostAppAction = typeof opts.runAppAction === 'function' ? opts.runAppAction : null;
    // 后台终端在内容区的标签页打开器（main.js 提供，docs/unfinished-plans/ai-head-agents-terminal.md）
    const openTermTab = typeof opts.openTermTab === 'function' ? opts.openTermTab : null;
    // AI 终端桥（terminal 工具）：main.js 以 getter 注入（延迟求值，避免 terminal-ui 工厂的 TDZ）。
    // 取不到时 terminal 工具直接报「当前版本不支持」，不抛异常拖垮对话。
    const terminalHostOf = () => {
        try {
            const host = opts.terminalHost;
            return host && typeof host === 'object' ? host : null;
        } catch (e) {
            return null;
        }
    };
    // 子代理详情视图的宿主出口（main.js 的 openAgentTab）：在内容区标签页打开，不遮挡面板
    const openAgentTab = typeof opts.openAgentTab === 'function' ? opts.openAgentTab : null;
    // 支线对话的宿主出口（main.js 的 openSideChatTab）：完整会话渲染在内容区标签页，
    // 面板继续显示主对话——这是「支线不切走」的实现基础
    const openSideChatTab = typeof opts.openSideChatTab === 'function' ? opts.openSideChatTab : null;
    const browserHost = opts.browserHost || null;
    // 可视化卡片里的外链交给系统浏览器（main.js 注入，走 BrowserOpenURL）
    const openExternal = typeof opts.openExternal === 'function'
        ? opts.openExternal
        : (url) => { try { window.open(url, '_blank', 'noopener'); } catch (e) {} };
    const hostAppActions = typeof opts.hostAppActions === 'function' ? opts.hostAppActions : null;
    const isMock = !!opts.isMock;
    const floatWindow = !!opts.floatWindow;
    const mockEmpty = !!opts.mockEmpty;
    const activityButton = opts.activityButton || null;
    const toolbarButton = opts.toolbarButton || null;
    // 操作留痕服务（main.js 传入）：AI 审批/工具/会话动作落盘（activity-log.js）。
    const activity = opts.activity && typeof opts.activity.log === 'function' ? opts.activity : null;
    // 插件命令分类器列表（main.js 传入，plugins.js 域不反向 import）
    const getPluginCommandClassifiers = typeof opts.getPluginCommandClassifiers === 'function'
        ? opts.getPluginCommandClassifiers
        : () => [];
    // 插件加载错误（状态行区分「未安装」与「加载失败」）
    const getPluginLoadErrors = typeof opts.getPluginLoadErrors === 'function'
        ? opts.getPluginLoadErrors
        : () => [];
    // 重新扫描插件源并重放注册（设置页「刷新」按钮用）
    const refreshPlugins = typeof opts.refreshPlugins === 'function' ? opts.refreshPlugins : null;

    function logActivity(action, target, detail, extra = {}) {
        if (!activity) return;
        try {
            activity.log(action, target, detail, {actor: 'ai', source: 'ai', ...extra});
        } catch (e) {}
    }

    // 支线对话的标签页出口（createAISidechat 构造时才赋值）与会话切换订阅。
    // 两者都提前声明：switchSession 在初始化路径里也可能被调用，用 const 放在后面会踩 TDZ。
    let sideChatTabOutlet = null;
    const sessionSwitchListeners = new Set();

    const el = {
        head: panel.querySelector('#ai-head'),
        headTitle: panel.querySelector('#ai-session-title'),
        chipAgents: panel.querySelector('#ai-chip-agents'),
        chipTerms: panel.querySelector('#ai-chip-terms'),
        chipTimers: panel.querySelector('#ai-chip-timers'),
        chipSchedules: panel.querySelector('#ai-chip-schedules'),
        chipWorktree: panel.querySelector('#ai-chip-worktree'),
        headSearch: panel.querySelector('#ai-head-search'),
        chipsPop: panel.querySelector('#ai-chips-pop'),
        agentView: panel.querySelector('#ai-agent-view'),
        close: panel.querySelector('#ai-close'),
        newBtn: panel.querySelector('#ai-new-session'),
        gitBtn: panel.querySelector('#ai-git'),
        changesBtn: panel.querySelector('#ai-changes'),
        changesCount: panel.querySelector('#ai-changes-count'),
        moreBtn: panel.querySelector('#ai-more'),
        changesPop: panel.querySelector('#ai-changes-pop'),
        sideBtn: panel.querySelector('#ai-side-btn'),
        floatFullscreen: panel.querySelector('#ai-float-fullscreen'),
        floatCollapse: panel.querySelector('#ai-float-collapse'),
        todos: panel.querySelector('#ai-todos'),
        bottomStack: panel.querySelector('.ai-bottom-stack'),
        messages: panel.querySelector('#ai-messages'),
        scrollBtn: panel.querySelector('#ai-scroll-btn'),
        slash: panel.querySelector('#ai-slash'),
        ctxBanner: panel.querySelector('#ai-ctx-banner'),
        ctxBannerText: panel.querySelector('#ai-ctx-banner-text'),
        ctxBannerClose: panel.querySelector('#ai-ctx-close'),
        ctxCompact: panel.querySelector('#ai-ctx-compact'),
        dialog: panel.querySelector('#ai-dialog'),
        dialogTitle: panel.querySelector('#ai-dialog-title'),
        dialogBody: panel.querySelector('#ai-dialog-body'),
        dialogFoot: panel.querySelector('#ai-dialog-foot'),
        dialogClose: panel.querySelector('#ai-dialog-close'),
        dialogCard: panel.querySelector('.ai-dialog-card'),
        composer: panel.querySelector('.ai-composer'),
        queue: panel.querySelector('#ai-queue'),
        takeover: panel.querySelector('#ai-takeover'),
        attach: panel.querySelector('#ai-attach'),
        attachBtn: panel.querySelector('#ai-attach-btn'),
        permission: panel.querySelector('#ai-permission'),
        plan: panel.querySelector('#ai-plan'),
        modelChip: panel.querySelector('#ai-model-chip'),
        input: panel.querySelector('#ai-input'),
        hint: panel.querySelector('#ai-hint'),
        send: panel.querySelector('#ai-send'),
        stop: panel.querySelector('#ai-stop'),
        statsWrap: panel.querySelector('.ai-stats-wrap'),
        stats: panel.querySelector('#ai-stats'),
        statsTurns: panel.querySelector('#ai-stats-turns'),
        statsSpeed: panel.querySelector('#ai-stats-speed'),
        statsTotal: panel.querySelector('#ai-stats-total'),
        statsCache: panel.querySelector('#ai-stats-cache'),
        statsSessionBtn: panel.querySelector('#ai-stats-session'),
        statsTokenBtn: panel.querySelector('#ai-stats-token'),
        statsSep: panel.querySelector('#ai-stats-sep'),
        sessionPop: panel.querySelector('#ai-session-pop'),
        sessionPopTurns: panel.querySelector('#ai-session-pop-turns'),
        sessionModel: panel.querySelector('#ai-session-model'),
        sessionTools: panel.querySelector('#ai-session-tools'),
        sessionTtft: panel.querySelector('#ai-session-ttft'),
        sessionTps: panel.querySelector('#ai-session-tps'),
        tokenPop: panel.querySelector('#ai-token-pop'),
        tokenPopTotal: panel.querySelector('#ai-token-pop-total'),
        tokenHit: panel.querySelector('#ai-token-hit'),
        tokenUncached: panel.querySelector('#ai-token-uncached'),
        tokenCached: panel.querySelector('#ai-token-cached'),
        tokenOutput: panel.querySelector('#ai-token-output'),
        ctxBtn: panel.querySelector('#ai-ctx-btn'),
        ctxRing: panel.querySelector('#ai-ctx-ring'),
        statsCtxPct: panel.querySelector('#ai-stats-ctx-pct'),
        ctxPop: panel.querySelector('#ai-ctx-pop'),
        ctxPopPct: panel.querySelector('#ai-ctx-pop-pct'),
        ctxPopSize: panel.querySelector('#ai-ctx-pop-size'),
        ctxSegSystem: panel.querySelector('#ai-ctx-seg-system'),
        ctxSegTools: panel.querySelector('#ai-ctx-seg-tools'),
        ctxSegMessages: panel.querySelector('#ai-ctx-seg-messages'),
        ctxTokSystem: panel.querySelector('#ai-ctx-tok-system'),
        ctxTokTools: panel.querySelector('#ai-ctx-tok-tools'),
        ctxTokMessages: panel.querySelector('#ai-ctx-tok-messages'),
        ctxTokSaved: panel.querySelector('#ai-ctx-tok-saved'),
        ctxPopCompact: panel.querySelector('#ai-ctx-pop-compact'),
    };
    if (el.gitBtn) el.gitBtn.innerHTML = iconSvg('git', 14);

    // 头部 HUD 状态（声明在闭包顶部：renderSessionList 等早期调用点经 updateHeadHud 触达，避免 TDZ）
    const agentRegistry = new Map();  // toolCallId -> 子代理元数据（本运行期，含已结束）
    const bgJobIndex = new Map();     // jobId -> {session, message, command, cwd, startedAt}（运行期）
    const bgUpdateListeners = new Set();
    let chipsPopKind = '';

    const sessionListEl = document.getElementById('ai-session-list');
    // 会话侧栏顶部操作区（标题栏的 [+] 已并入）：新建会话 / 自动化
    const sessionActionNewBtn = document.getElementById('ai-session-action-new');
    const sessionActionAutoBtn = document.getElementById('ai-session-action-auto');
    const sessionActionSendBtn = document.getElementById('ai-session-action-send');
    const sessionToolSendBtn = document.getElementById('ai-session-tool-send');
    const sessionMoreBtn = document.getElementById('ai-session-more');

    const opt = {
        modelList: document.getElementById('ai-model-list'),
        modelCreate: document.getElementById('ai-model-create'),
        modelEditorMask: document.getElementById('dlg-model-editor-mask'),
        modelEditor: document.getElementById('dlg-model-editor'),
        modelTitle: document.getElementById('dlg-model-title'),
        modelEditorClose: document.getElementById('ai-model-editor-close'),
        modelEditorCancel: document.getElementById('ai-model-editor-cancel'),
        modelEditorSave: document.getElementById('ai-model-editor-save'),
        preset: document.getElementById('ai-opt-preset'),
        presetAdd: document.getElementById('ai-opt-preset-add'),
        name: document.getElementById('ai-opt-name'),
        provider: document.getElementById('ai-opt-provider'),
        baseURL: document.getElementById('ai-opt-baseurl'),
        apiKey: document.getElementById('ai-opt-apikey'),
        keyToggle: document.getElementById('ai-opt-key-toggle'),
        modelEntries: document.getElementById('ai-opt-entries'),
        modelCount: document.getElementById('ai-opt-model-count'),
        catalogNote: document.getElementById('ai-opt-catalog-note'),
        catalogText: document.getElementById('ai-opt-catalog-text'),
        catalogFill: document.getElementById('ai-opt-catalog-fill'),
        catalogSync: document.getElementById('ai-catalog-sync'),
        catalogAuto: document.getElementById('ai-catalog-auto'),
        catalogUrl: document.getElementById('ai-catalog-url'),
        catalogStatus: document.getElementById('ai-catalog-status'),
        entryAdd: document.getElementById('ai-opt-entry-add'),
        modalities: document.getElementById('ai-opt-modalities'),
        model: document.getElementById('ai-opt-model'),
        models: document.getElementById('ai-opt-models'),
        temp: document.getElementById('ai-opt-temp'),
        tempVal: document.getElementById('ai-opt-temp-val'),
        maxTokens: document.getElementById('ai-opt-maxtokens'),
        maxTokensHuman: document.getElementById('ai-opt-maxtokens-human'),
        rpm: document.getElementById('ai-opt-rpm'),
        contextHuman: document.getElementById('ai-opt-context-human'),
        reasoningGroup: document.getElementById('ai-opt-reasoning-group'),
        reasoning: document.getElementById('ai-opt-reasoning'),
        thinkingGroup: document.getElementById('ai-opt-thinking-group'),
        thinking: document.getElementById('ai-opt-thinking'),
        thinkingHint: document.getElementById('ai-opt-thinking-hint'),
        budget: document.getElementById('ai-opt-budget'),
        contextWindow: document.getElementById('ai-opt-context'),
        test: document.getElementById('ai-opt-test'),
        status: document.getElementById('ai-opt-status'),
        dir: document.getElementById('ai-opt-dir'),
        proxy: document.getElementById('ai-opt-proxy'),
        proxyURL: document.getElementById('ai-opt-proxy-url'),
        headers: document.getElementById('ai-opt-headers'),
        memoryMode: document.getElementById('ai-opt-memory-mode'),
        memoryPath: document.getElementById('ai-opt-memory-path'),
        threshold: document.getElementById('ai-opt-threshold'),
        autoCompact: document.getElementById('ai-opt-autocompact'),
        openMemory: document.getElementById('ai-opt-open-memory'),
        openSkills: document.getElementById('ai-opt-open-skills'),
        injectRoot: document.getElementById('ai-opt-inject-root'),
        injectActive: document.getElementById('ai-opt-inject-active'),
        injectCaret: document.getElementById('ai-opt-inject-caret'),
        injectViewport: document.getElementById('ai-opt-inject-viewport'),
        injectOpenFiles: document.getElementById('ai-opt-inject-openfiles'),
        injectAgents: document.getElementById('ai-opt-inject-agents'),
        injectMemory: document.getElementById('ai-opt-inject-memory'),
        injectSkills: document.getElementById('ai-opt-inject-skills'),
        injectPrefs: document.getElementById('ai-opt-inject-prefs'),
        injectEnvVars: document.getElementById('ai-opt-inject-envvars'),
        injectPersona: document.getElementById('ai-opt-inject-persona'),
        sendKey: document.getElementById('ai-opt-sendkey'),
        outputLang: document.getElementById('ai-opt-output-lang'),
        displayMode: document.getElementById('ai-opt-display-mode'),
        chatFont: document.getElementById('ai-opt-chatfont'),
        chatFontVal: document.getElementById('ai-opt-chatfont-val'),
        chatFontEn: document.getElementById('ai-opt-chatfont-en'),
        chatFontCjk: document.getElementById('ai-opt-chatfont-cjk'),
        chatFontCode: document.getElementById('ai-opt-chatfont-code'),
        showThinking: document.getElementById('ai-opt-show-thinking'),
        showUsage: document.getElementById('ai-opt-show-usage'),
        msgActions: document.getElementById('ai-opt-msg-actions'),
        turnMetaAll: document.getElementById('ai-opt-turn-meta-all'),
        contextSlim: document.getElementById('ai-opt-context-slim'),
        assistantCard: document.getElementById('ai-opt-assistant-card'),
        inlineWidgets: document.getElementById('ai-opt-inline-widgets'),
        todosExpanded: document.getElementById('ai-opt-todos-expanded'),
        autoCollapseEditor: document.getElementById('ai-opt-auto-collapse-editor'),
        expandEditorOnTab: document.getElementById('ai-opt-expand-editor-on-tab'),
        autoTitle: document.getElementById('ai-opt-auto-title'),
        defaultScope: document.getElementById('ai-opt-default-scope'),
        logEnabled: document.getElementById('ai-opt-log-enabled'),
        worklog: document.getElementById('ai-opt-worklog'),
        appControl: document.getElementById('ai-opt-app-control'),
        notifyInApp: document.getElementById('ai-opt-notify-inapp'),
        notifySystem: document.getElementById('ai-opt-notify-system'),
        notifyTest: document.getElementById('ai-opt-notify-test'),
        notifyFinish: document.getElementById('ai-opt-notify-finish'),
        notifyError: document.getElementById('ai-opt-notify-error'),
        notifyAsk: document.getElementById('ai-opt-notify-ask'),
        notifyApprove: document.getElementById('ai-opt-notify-approve'),
        notifySound: document.getElementById('ai-opt-notify-sound'),
        retryMax: document.getElementById('ai-opt-retry-max'),
        subAgentMax: document.getElementById('ai-opt-subagent-max'),
        subAgentMaxDepth: document.getElementById('ai-opt-subagent-depth'),
        schedules: document.getElementById('ai-opt-schedules'),
        scheduleAdd: document.getElementById('ai-opt-schedule-add'),
        askTimeout: document.getElementById('ai-opt-ask-timeout'),
        askTimeoutAction: document.getElementById('ai-opt-ask-action'),
        logPath: document.getElementById('ai-opt-log-path'),
        openLogs: document.getElementById('ai-opt-open-logs'),
        prompt: document.getElementById('ai-opt-prompt'),
        promptText: document.getElementById('ai-opt-prompt-text'),
        promptSave: document.getElementById('ai-opt-prompt-save'),
        promptNew: document.getElementById('ai-opt-prompt-new'),
        promptDel: document.getElementById('ai-opt-prompt-del'),
        promptDefault: document.getElementById('ai-opt-prompt-default'),
        exportKeys: document.getElementById('ai-opt-export-keys'),
        exportPersona: document.getElementById('ai-opt-export-persona'),
        exportBtn: document.getElementById('ai-opt-export'),
        importBtn: document.getElementById('ai-opt-import'),
        clearSessions: document.getElementById('ai-opt-clear-sessions'),
        approved: document.getElementById('ai-opt-approved'),
        approvedClear: document.getElementById('ai-opt-approved-clear'),
        permissionClassifier: document.getElementById('ai-opt-auto-classifier'),
        permissionClassifierModel: document.getElementById('ai-opt-classifier-model'),
        localLinear: document.getElementById('ai-opt-local-linear'),
        localSemantic: document.getElementById('ai-opt-local-semantic'),
        localRefresh: document.getElementById('ai-opt-local-refresh'),
        localClassifierStrictness: document.getElementById('ai-opt-local-strictness'),
        localClassifierPersonalize: document.getElementById('ai-opt-local-personalize'),
        localClassifierStatus: document.getElementById('ai-opt-local-status'),
        localClassifierMarket: document.getElementById('ai-opt-local-market'),
        localClassifierTest: document.getElementById('ai-opt-local-test'),
        localClassifierTestResult: document.getElementById('ai-opt-local-test-result'),
        localClassifierReset: document.getElementById('ai-opt-local-reset'),
        localClassifierClear: document.getElementById('ai-opt-local-clear'),
        localClassifierExport: document.getElementById('ai-opt-local-export'),
        permissionsAllow: document.getElementById('ai-opt-perm-allow'),
        permissionsAsk: document.getElementById('ai-opt-perm-ask'),
        permissionsDeny: document.getElementById('ai-opt-perm-deny'),
        permissionsSave: document.getElementById('ai-opt-perm-save'),
        permissionsReload: document.getElementById('ai-opt-perm-reload'),
        permissionTable: document.getElementById('ai-opt-perm-table'),
        permissionAddKind: document.getElementById('ai-opt-perm-add-kind'),
        permissionAddBehavior: document.getElementById('ai-opt-perm-add-behavior'),
        permissionAddPattern: document.getElementById('ai-opt-perm-add-pattern'),
        permissionAddBtn: document.getElementById('ai-opt-perm-add-btn'),
        permissionsPath: document.getElementById('ai-opt-perm-path'),
        permissionsSession: document.getElementById('ai-opt-perm-session'),
        permissionsSessionClear: document.getElementById('ai-opt-perm-session-clear'),
        permissionsLog: document.getElementById('ai-opt-perm-log'),
        prefs: document.getElementById('ai-opt-prefs'),
        prefAdd: document.getElementById('ai-opt-pref-add'),
        prefFilter: document.getElementById('ai-opt-pref-filter'),
        prefCount: document.getElementById('ai-opt-pref-count'),
    };

    let config = loadAIConfig();
    let sessions = loadAISessions();

    // 个性化展示名：GUI 与注入共用同一解析（自定义名 > en > zh/auto）。
    // 历史消息气泡保留渲染时的名字，不随改名重绘；空态 / 状态条 / 会话列表等即时更新。
    function assistantName() {
        return resolveAssistantName(config.persona, config.outputLanguage).name;
    }

    // 状态条与欢迎语里写死的是品牌名：改名时统一替换，默认名（甜澄）时逐字不变。
    function personaText(text) {
        return String(text).replace(/甜澄/g, assistantName());
    }
    // 会话级「正在生成」注册表：每个会话各自一条流，切换会话不共享状态。
    // 后端 AISendChat 按 session.id#round 独立取消，天然支持多会话并发生成。
    // stream 只作为「当前查看会话的流」的镜像（由 syncStreamView 维护），
    // 渲染与 composer 相关的读取点直接用它；跨会话判断一律走 streams。
    const streams = new Map();
    let stream = null;
    let oneShot = null;
    let titleJob = null;
    const titleAttempted = new Set();
    let compactSeq = 0;
    let mode = floatWindow ? 'dock' : normalizeFloatMode(settings.aiFloatMode);
    let floatCollapsed = false;
    let floatSizeBeforeCollapse = null;
    let stickBottom = true;
    // 消息区上一次滚动位置：滚动监听靠它区分「向上滚」（解除贴底）与「向下滚 / 内容增长」
    let scrollLastTop = 0;
    // 用户手势窗口：只有滚轮 / 触摸 / 滚动条拖拽 / 键盘翻页期间的变化才算「用户接管滚动」。
    // 任务清单 / 审批卡出现后消息区靠 padding-bottom 让位、底部 overlay 收起会把 scrollTop
    // 钳小，这些布局变化会改 scrollTop 与距底距离，但都不是用户的意图（判定收在
    // ai-scroll-follow.js，切底 / 补底的口径见那里）。
    const scrollGesture = createScrollGesture();
    // 兜底：没有手势事件时凭「连续多次 scrollTop 减小」认出真实拖动（见 ai-scroll-follow.js）
    const shrinkBurst = createShrinkBurst();
    let processFoldState = new Map();
    // 应用消息（Git 快捷操作 / 定时任务）默认收起指令全文；展开状态按消息 key 记住，避免重渲染后弹回。
    const appMsgExpanded = new Set();
    // 用户超长消息默认折叠：手动展开/收起的状态按消息 key 记住（内存即可，重渲染不弹回）。
    const userFoldExpanded = new Set();
    const AI_USER_FOLD_LINES = 12;
    const AI_USER_FOLD_CHARS = 800;

    function isLongUserMessage(content) {
        const text = aiTextOf(content);
        return text.split('\n').length > AI_USER_FOLD_LINES || text.length > AI_USER_FOLD_CHARS;
    }
    // 流式期间被手动折叠/展开过的轮次 key：轮次结束后要丢弃这些记忆，
    // 否则「处理中点过折叠条」会把状态带进完成态，压掉“完成后默认展开/收起”的判断。
    const processFoldTouched = new Set();
    const thinkFoldState = new Map();
    // 思考链滚动跟随：默认贴底，流式时实时停在最新一行；用户手动上滑即暂停跟随，
    // 滚回底部（或流式期间重新展开）时恢复。key 是 .ai-think-body 元素。
    const thinkScrollFollow = new WeakMap();
    // 消息懒加载：每会话记录当前渲染窗口起点；首屏至少覆盖约 1M tokens 上下文，上滑触顶再往前补。
    const renderWindows = new Map();
    const AI_RENDER_INITIAL_TOKENS = 1000000;
    const AI_RENDER_STEP_TOKENS = 250000;
    // 已压缩会话在消息流顶部常驻一张摘要卡：压缩本身不再"凭空消失"，
    // 归档消息可就地展开回看（只读，不参与请求）。key = session.id，value = 是否展开。
    const archivedFlowOpen = new Map();
    let loadingEarlier = false;
    let processTicker = 0;
    let pendingEdit = null;
    let attachSeq = 0;
    let appDirPromise = null;
    let memoryFallbackNotified = false;
    let logSaveErrorShown = false;
    // 上下文占用估算依赖「真正会发给模型的系统提示词」：面板重开 / 切换会话 / 注入开关变化后
    // 需要异步重建，否则会沿用默认或旧值，显示偏小或带着旧工作区上下文。
    // 按会话缓存：并发生成 / 来回切会话时，A 的提示词不能拿去估 B 的占用。
    const promptCache = new Map();      // sessionId -> {text, meta, at}
    const promptJobs = new Map();       // sessionId -> in-flight Promise
    let drag = null;
    let fontSaveTimer = 0;
    let lastApplied = {font: 0, thinking: null, usage: null, widgets: null};
    let slashState = {open: false, index: 0, items: []};
    let noteSeq = 0;
    const pendingApprovals = new Map();
    // 工具卡折叠偏好（toolCallId -> collapsed）：手动展开/收起后跨重渲保留，
    // 否则一轮内每次新输出触发 renderMessages 全量重建都会把手动展开的卡片折叠回去。
    const toolFoldState = new Map();
    // 文件改动汇总卡的「再显示 N 个文件」展开记忆（key = message 标识）
    const changesSummaryFold = new Map();
    const pendingAsks = new Map();
    const pendingEnvCreations = new Map();
    const askDrafts = new Map();
    // 系统接管（应用发起、模型不可见）：与 ask / 审批共用 composer 位置，但结算只回给调用方，
    // 不生成任何喂回模型的消息。onChange 只做 UI 收敛，运行时才取后面的渲染函数。
    const systemTakeoverHost = createSystemTakeoverHost({
        onChange: () => {
            updateComposerTakeover(true);
            renderSessionList();
        },
    });
    const LOOP_GUARD_TIMEOUT_SEC = 30;
    const LOOP_GUARD_RECHECK_MS = 2 * 60 * 1000;
    const todoStates = new Map();
    // 后台命令作业的实时输出状态：jobId -> {session, message, lines, text, timer}
    // cmd-out 广播驱动追加；面板不可见时只更新 message.bgLog，切回后由重渲恢复。
    const bgJobLive = new Map();
    // check_command 的增量读取游标：jobId -> 上次读到的逻辑字节偏移
    const bgJobCursors = new Map();
    const AI_BG_LIVE_MAX_LINES = 200;
    const AI_BG_LIVE_MAX_CHARS = 8192;
    let dismissedPlanApproval = '';
    // 消息排队 / 插话状态已迁入 ai-message-queue.js（队列模块持有，panel 经 queueMod 的
    // hasInterject / clearInterject / items 等 API 访问，见阶段 A 的所有权迁移）。
    let archiveOverflowAt = 0;
    let autoCompactCount = new Map();
    let autoCompactWarnedAt = 0;

    // ---------- 配置与会话持久化 ----------

    function defaultModelEntry() {
        // autoFilled=true：新条目还没被手改，填模型 ID 时允许配置表接管窗口/能力
        return normalizeModelEntry({autoFilled: true}, () => aiNowId('model-'));
    }

    // 账号（profile）保存连接信息；模型条目放 models[]，每条有独立窗口/能力/推理配置。
    // 旧版单模型字段由 migrateAccountModels 迁移并回写镜像。
    function defaultProfile() {
        return {
            id: aiNowId('profile-'),
            name: '配置',
            provider: 'openai',
            baseURL: '',
            apiKey: '',
            temperature: 0.7,
            proxy: '',
            extraHeaders: {},
            models: [defaultModelEntry()],
            lastModelId: '',
            // 旧字段镜像（仅旧版本 exe 回滚时读取）
            model: '',
            maxTokens: 4096,
            thinking: false,
            thinkingBudget: 8000,
            reasoningEffort: '',
            contextWindow: 128000,
        };
    }

    function normalizeProfile(raw, index) {
        if (!raw || typeof raw !== 'object') return null;
        const account = {
            id: aiTextOf(raw.id) || aiNowId('profile-'),
            name: aiTextOf(raw.name) || ('配置 ' + (index + 1)),
            provider: ['anthropic', 'responses'].includes(raw.provider) ? raw.provider : 'openai',
            baseURL: aiTextOf(raw.baseURL),
            apiKey: aiTextOf(raw.apiKey),
            temperature: aiClamp(Number(raw.temperature) || 0, 0, 2),
            proxy: aiTextOf(raw.proxy),
            extraHeaders: raw.extraHeaders && typeof raw.extraHeaders === 'object' ? raw.extraHeaders : {},
            models: Array.isArray(raw.models) ? raw.models : [],
            lastModelId: aiTextOf(raw.lastModelId),
            // 旧字段先原样带入，migrateAccountModels 会迁移成 models[] 并回写镜像
            model: aiTextOf(raw.model),
            maxTokens: aiClampInt(raw.maxTokens, 1, 393216, 4096),
            thinking: raw.thinking === true,
            thinkingBudget: aiClampInt(raw.thinkingBudget, 1024, 393215, 8000),
            reasoningEffort: ['low', 'medium', 'high'].includes(raw.reasoningEffort) ? raw.reasoningEffort : '',
            contextWindow: aiClampInt(raw.contextWindow, 2048, 1048576, 128000),
        };
        migrateAccountModels(account, account.lastModelId, () => aiNowId('model-'));
        if (!findModelEntry(account, account.lastModelId)) account.lastModelId = account.models[0].id;
        return account;
    }

    function normalizeAIConfig(rawStored) {
        const stored = rawStored && typeof rawStored === 'object' ? rawStored : {};
        const out = {
            profiles: [],
            activeProfileId: '',
            // 激活账号下激活的模型条目 id；配合 profiles[].lastModelId 记住每个账号的选择
            activeModelId: aiTextOf(stored.activeModelId),
            activeSessionId: aiTextOf(stored.activeSessionId),
            memoryMode: stored.memoryMode === 'app' ? 'app' : 'workspace',
            // 新会话默认权限档（设置 → AI → 权限 → 新会话）；只对新建会话生效，历史会话保持各自设置
            defaultScope: normalizeDefaultScope(stored.defaultScope),
            approvedPaths: Array.isArray(stored.approvedPaths) ? stored.approvedPaths : [],
            // 全局「总是允许」的工作区外读根（读审批卡「总是」档；判定见 ai-read-roots.js）
            approvedReadRoots: normalizeReadRoots(stored.approvedReadRoots),
            disabledSkills: Array.isArray(stored.disabledSkills) ? stored.disabledSkills : [],
            prompts: [],
            preferences: [],
            activePromptId: aiTextOf(stored.activePromptId),
            autoCompactThreshold: aiClamp(Number(stored.autoCompactThreshold) || 0.8, 0.5, 0.95),
            autoCompact: stored.autoCompact !== false,
            autoTitle: stored.autoTitle !== false,
            outputLanguage: ['zh', 'en', 'auto'].includes(stored.outputLanguage) ? stored.outputLanguage : 'zh',
            logEnabled: stored.logEnabled !== false,
            // AI 工作日志（write_worklog 工具，写入工作区 .cadt/logs/）；默认开启
            worklogEnabled: stored.worklogEnabled !== false,
            appControlEnabled: stored.appControlEnabled !== false,
            retryMax: aiClampInt(stored.retryMax, 0, 10, 5),
            // 子代理总数（含递归派出的全部层级，不含主代理）；递归层级 0 = 不设限
            subAgentMax: aiClampInt(stored.subAgentMax, 1, 20, 20),
            subAgentMaxDepth: aiClampInt(stored.subAgentMaxDepth, 0, 20, 0),
            autoClassifier: stored.autoClassifier === true,
            // 自动审批分类器的请求模型：'账号id|模型id'；空串 = 跟随当前模型
            autoClassifierModel: aiTextOf(stored.autoClassifierModel),
            // 端侧命令分类器（内置线性模型，离线毫秒级；docs/finished-plans/local-command-classifier.md）
            // 默认启用（作者拍板）。总开关保留为迁移兼容：旧配置显式 false 时迁移为「线性关闭」
            // （新 UI 没有总开关位，用户经线性/语义两个模型位重新开启），新配置直接用两个模型位
            localClassifierEnabled: stored.localClassifierEnabled !== false,
            localClassifierLinear: stored.localClassifierLinear
                ? (stored.localClassifierLinear === 'off' ? 'off' : 'builtin')
                : (stored.localClassifierEnabled === false ? 'off' : 'builtin'),
            // 语义模型位：'' = 全部已装（默认）；'off' = 关闭；否则为指定分类器的 fullId（插件id:分类器id）
            localClassifierSemantic: typeof stored.localClassifierSemantic === 'string' ? stored.localClassifierSemantic : '',
            localClassifierStrictness: normalizeLocalClassifierStrictness(stored.localClassifierStrictness),
            // 个性化蒸馏学习：端侧只学大模型的判定（云端 AI 分类器结论 / 语义插件结论）；
            // 用户的允许 / 拒绝不回流——审批是一次性授权语境，回流会把临时授权学成永久放行
            localClassifierPersonalize: stored.localClassifierPersonalize !== false,
            // 应用内 toast 默认关（作者反馈：太烦人）；开关存值要如实生效——「任务完成不弹」
            // 由 ai-notify-policy 的 completion 档管，不在这里一刀切（否则设置页开关是死的）
            notifyInApp: stored.notifyInApp === true,
            notifySystem: stored.notifySystem === true,
            notifyFinish: stored.notifyFinish !== false,
            notifyError: stored.notifyError !== false,
            notifyAsk: stored.notifyAsk !== false,
            notifyApprove: stored.notifyApprove !== false,
            notifySound: stored.notifySound !== false,
            askTimeout: aiClampInt(stored.askTimeout, 0, 3600, 300),
            askTimeoutAction: ['recommended', 'wait', 'abort', 'ai_decide'].includes(stored.askTimeoutAction)
                ? stored.askTimeoutAction
                : 'recommended',
            // 个性化（身份命名 / 回复风格 / 人设 / 长期指令）：旧配置缺该字段即默认态，升级零迁移
            persona: normalizePersona(stored.persona),
            // 生图/视频生成条目（generate_image / generate_video 工具的服务商配置）：同上零迁移
            genModels: normalizeGenModels(stored.genModels, () => aiNowId('gen-')),
        };
        if (Array.isArray(stored.prompts)) {
            stored.prompts.forEach((raw, index) => {
                if (!raw || typeof raw !== 'object') return;
                const id = aiTextOf(raw.id);
                const content = aiTextOf(raw.content);
                if (!id || !content.trim()) return;
                out.prompts.push({
                    id,
                    name: aiTextOf(raw.name) || ('模板 ' + (index + 1)),
                    content,
                    builtin: !!raw.builtin,
                });
            });
        }
        for (const builtin of AI_BUILTIN_PROMPTS) {
            const existing = out.prompts.find((prompt) => prompt.id === builtin.id);
            if (existing) {
                existing.builtin = true;
                if (!existing.name) existing.name = builtin.name;
                // 只升级未被用户改过的旧默认模板；用户自定义内容保持原样
                if (builtin.id === 'builtin-default' &&
                    AI_LEGACY_DEFAULT_PROMPTS.some((legacy) => aiNormalizedPromptText(existing.content) === aiNormalizedPromptText(legacy))) {
                    existing.content = builtin.content;
                }
            } else {
                out.prompts.push({...builtin});
            }
        }
        if (!out.prompts.some((prompt) => prompt.id === out.activePromptId)) {
            out.activePromptId = out.prompts[0] ? out.prompts[0].id : '';
        }
        if (Array.isArray(stored.preferences)) {
            const seenPrefIds = new Set();
            for (const raw of stored.preferences) {
                if (!raw || typeof raw !== 'object') continue;
                const text = aiTextOf(raw.text).trim().slice(0, AI_PREF_TEXT_LIMIT);
                if (!text) continue;
                let id = aiTextOf(raw.id).trim().slice(0, 64) || aiNowId('pref-');
                while (seenPrefIds.has(id)) id = aiNowId('pref-');
                seenPrefIds.add(id);
                out.preferences.push({
                    id,
                    text,
                    source: raw.source === 'ai' ? 'ai' : 'user',
                    createdAt: Number(raw.createdAt) || Date.now(),
                    updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now(),
                });
                if (out.preferences.length >= AI_PREF_LIMIT) break;
            }
        }
        if (Array.isArray(stored.profiles)) {
            const seen = new Set();
            stored.profiles.forEach((raw, index) => {
                const profile = normalizeProfile(raw, index);
                if (!profile) return;
                let id = profile.id;
                let suffix = 2;
                while (seen.has(id)) id = profile.id + '-' + suffix++;
                profile.id = id;
                seen.add(id);
                out.profiles.push(profile);
            });
        }
        // 浏览器 dev mock 下给一个可点开即用的演示配置；真实应用首次运行保持空态。
        if (isMock && !mockEmpty && !out.profiles.length) {
            out.profiles.push(normalizeProfile({
                id: 'mock-demo',
                name: '演示配置',
                provider: 'openai',
                baseURL: 'https://api.deepseek.com/v1',
                apiKey: '',
                model: 'deepseek-flash',
                temperature: 0.7,
                maxTokens: 4096,
                contextWindow: 1048576,
            }, 0));
        }
        // 插件注册的 AI provider 以虚拟账号进入模型选择器；只存在于内存，
        // saveAIConfig 会剔除它们，用户 ai-config.json 不会被写入插件数据。
        {
            const seenPluginIds = new Set(out.profiles.map((p) => p.id));
            for (const account of pluginAIAccounts()) {
                if (seenPluginIds.has(account.id)) continue;
                out.profiles.push(account);
                seenPluginIds.add(account.id);
            }
        }
        if (!out.profiles.some((p) => p.id === out.activeProfileId)) {
            out.activeProfileId = out.profiles.length ? out.profiles[0].id : '';
        }
        // 激活模型条目必须落在激活账号下；旧 id 失效时依次回该账号记住的条目、首条目。
        // 用 resolveModelId 而非 modelEntryOf——后者找不到就返回首条，会让校验恒真、永远不回落。
        const activeAccount = out.profiles.find((p) => p.id === out.activeProfileId);
        if (activeAccount) {
            out.activeModelId = resolveModelId(activeAccount, out.activeModelId, activeAccount.lastModelId);
        } else {
            out.activeModelId = '';
        }
        // 分类器指定的模型已不存在（被删除 / 导入半程）时回退为跟随当前模型；
        // 旧格式（纯账号 id）在这里升级为 '账号id|模型id'
        out.autoClassifierModel = resolveModelRef(out.autoClassifierModel, out.profiles);
        return out;
    }

    let configFallback = false;
    let configLoaded = false;
    let lastConfigText = '';
    let lastConfigLoadAt = 0;
    let configWriteChain = Promise.resolve();
    let configStoreErrorAt = 0;

    function configUseDisk() {
        if (configFallback) return false;
        if (!backend.AIConfigRead || !backend.AIConfigWrite) return false;
        try {
            return localStorage.getItem(AI_CONFIG_MODE_KEY) !== 'legacy';
        } catch (e) {
            return true;
        }
    }

    function notifyConfigStoreError(error) {
        const now = Date.now();
        if (now - configStoreErrorAt < 30000) return;
        configStoreErrorAt = now;
        try {
            if (typeof flash === 'function') flash('AI 配置保存失败：' + ((error && error.message) || error), true);
        } catch (e) {}
    }

    function loadAIConfig() {
        let stored = {};
        try {
            stored = JSON.parse(localStorage.getItem(AI_CONFIG_KEY) || '{}') || {};
        } catch (e) {
            stored = {};
        }
        return normalizeAIConfig(stored);
    }

    function saveAIConfig() {
        // 磁盘配置还没加载完时先别写，避免用启动瞬间的 localStorage 旧值覆盖文件/镜像。
        if (configUseDisk() && !configLoaded) return;
        syncActiveMirror();
        let text = '';
        try {
            // 插件虚拟账号只在内存里，绝不写进磁盘配置 / localStorage 镜像
            const forSave = config.profiles.some((p) => p.pluginAI)
                ? {...config, profiles: config.profiles.filter((p) => !p.pluginAI)}
                : config;
            text = JSON.stringify(forSave);
        } catch (e) {
            return;
        }
        // localStorage 永远保留一份镜像：旧版本回退、WebView2 重置、降级路径都靠它。
        try {
            localStorage.setItem(AI_CONFIG_KEY, text);
        } catch (e) {}
        if (!configUseDisk()) return;
        if (!text || text === lastConfigText) return;
        lastConfigText = text;
        configWriteChain = configWriteChain
            .then(() => backend.AIConfigWrite(text))
            .catch((e) => {
                lastConfigText = '';
                notifyConfigStoreError(e);
            });
    }

    // 插件启用/禁用后原位增删虚拟账号，不动用户已保存的配置。
    function syncPluginAIAccounts() {
        const keep = config.profiles.filter((p) => !p.pluginAI);
        const seen = new Set(keep.map((p) => p.id));
        for (const account of pluginAIAccounts()) {
            if (seen.has(account.id)) continue;
            keep.push(account);
            seen.add(account.id);
        }
        const changed = keep.length !== config.profiles.length ||
            keep.some((p, i) => p !== config.profiles[i]);
        config.profiles = keep;
        if (!keep.some((p) => p.id === config.activeProfileId)) {
            const first = keep[0];
            config.activeProfileId = first ? first.id : '';
            config.activeModelId = first && first.models[0] ? first.models[0].id : '';
        }
        return changed;
    }

    function applyLoadedAIConfig() {
        syncPluginAIAccounts();
        refreshSettingsPane();
        refreshChatSettings();
        refreshPromptSettings();
        renderProfileSelect();
        updateComposerState();
        refreshSystemPromptEstimate(true);
        // 模型配置表：先读磁盘缓存，过期才静默同步；拿到后刷新一次模型页（状态行 + 命中提示）
        modelCatalog.autoSync().then(() => refreshSettingsPane()).catch(() => {});
    }

    // 插件加载常晚于首次配置读取；注册表重建后按当前启用列表刷新虚拟账号。
    // 磁盘配置尚未就绪时不动，bootstrapAIConfig 走到 applyLoadedAIConfig 会合并一次。
    window.addEventListener('cadt-plugins-loaded', () => {
        if (configUseDisk() && !configLoaded) return;
        if (!syncPluginAIAccounts()) return;
        renderProfileSelect();
        updateComposerState();
    });

    async function bootstrapAIConfig() {
        if (!configUseDisk()) {
            configLoaded = true;
            return config;
        }
        try {
            const text = await backend.AIConfigRead();
            if (text && text.trim()) {
                let stored = null;
                try {
                    stored = JSON.parse(text);
                } catch (e) {
                    stored = null;
                }
                if (stored && typeof stored === 'object') {
                    config = normalizeAIConfig(stored);
                    lastConfigText = JSON.stringify(config);
                } else {
                    configLoaded = true;
                    notifyConfigStoreError(new Error('ai-config.json 内容损坏，已使用本地缓存'));
                    saveAIConfig();
                }
            } else {
                // 首次升级：把 localStorage 的配置写成文件。
                configLoaded = true;
                saveAIConfig();
            }
            configLoaded = true;
            lastConfigLoadAt = Date.now();
            applyLoadedAIConfig();
            // 配置与会话是两条独立的启动链：会话先读完时，面板已经按 localStorage 镜像里的
            // activeSessionId 画过一次；磁盘配置才是真值，不一致就把视图切回真正的当前会话
            //（只在首次读盘这一个点做，后续 2s 节流的重读不碰视图，免得打断用户手动切换）。
            if (sessionsLoaded && isOpen()) {
                const viewing = currentSession();
                if (viewing && viewing.id !== lastRenderedSessionId) {
                    stickBottom = true;
                    renderMessages(true);
                    updateComposerState();
                }
            }
        } catch (e) {
            configFallback = true;
            configLoaded = true;
            notifyConfigStoreError(e);
            try {
                if (typeof flash === 'function') flash('AI 配置磁盘存储不可用，已回退到本地缓存', true);
            } catch (e2) {}
        }
        return config;
    }

    let configReady = null;
    function whenConfigReady() {
        if (!configReady) configReady = bootstrapAIConfig();
        return configReady;
    }

    async function reloadAIConfigFromDisk() {
        await whenConfigReady();
        if (!configUseDisk()) return;
        if (Date.now() - lastConfigLoadAt < 2000) return;
        try {
            const text = await backend.AIConfigRead();
            if (!text || !text.trim()) return;
            const stored = JSON.parse(text);
            config = normalizeAIConfig(stored);
            lastConfigText = JSON.stringify(config);
            lastConfigLoadAt = Date.now();
            applyLoadedAIConfig();
        } catch (e) {}
    }

    // 浮窗是独立进程（ai_float.go 用 --new-window --ai-float 起 exe），配置各存一份内存。
    // 主窗口「打开面板即重读」由 open() 的 reloadStoredAIState 分支覆盖，但那条路对浮窗硬短路，
    // 所以这里给浮窗补一条：窗口重新聚焦时按 2s 节流重读磁盘配置（个性化设定 / 模型设置都跟着更新）。
    if (floatWindow) {
        window.addEventListener('focus', () => {
            if (!anyStreaming()) reloadAIConfigFromDisk();
        });
    }

    function inferApprovalActor(raw, state) {
        if (state !== 'approved') return '';
        if (raw.autoRule === 'auto') return 'auto';
        if (raw.autoRule === 'exact' || raw.autoRule === 'family') return 'user';
        if (raw.remember === 'auto' || raw.remember === 'pre') return 'auto';
        return 'user';
    }

    function normalizeApproval(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const state = ['pending', 'approved', 'denied', 'cancelled', 'failed'].includes(raw.state) ? raw.state : 'cancelled';
        const kind = raw.kind === 'command' ? 'command' : 'file';
        // 命令类审批的 tool 只回这三个值；read_image 的网图审批带 web 标记，要按原样留住，
        // 否则会话重开后卡文案退回「在工作目录执行命令」、记住粒度也变成「相同命令」。
        let tool = 'run_command';
        if (kind === 'command') {
            if (raw.tool === 'background_command') tool = 'background_command';
            else if (raw.tool === 'web_fetch') tool = 'web_fetch';
            else if (raw.web === true && raw.tool === 'read_image') tool = 'read_image';
        } else {
            tool = raw.tool === 'edit_file' ? 'edit_file' : 'write_file';
        }
        return {
            state,
            kind,
            error: aiTextOf(raw.error),
            command: aiTextOf(raw.command).slice(0, 8000),
            cwd: aiTextOf(raw.cwd),
            tool,
            // 网络类审批（web_fetch / read_image 网图）：卡文案与「记住」粒度按网址走
            web: raw.web === true,
            path: aiTextOf(raw.path),
            relPath: aiTextOf(raw.relPath),
            added: Math.max(0, Number(raw.added) || 0),
            removed: Math.max(0, Number(raw.removed) || 0),
            newFile: !!raw.newFile,
            dirty: !!raw.dirty,
            truncated: !!raw.truncated,
            diff: Array.isArray(raw.diff)
                ? raw.diff.map((line) => ({
                    t: line && ['+', '-', '…'].includes(line.t) ? line.t : ' ',
                    text: aiTextOf(line && line.text),
                })).slice(0, AI_DIFF_PREVIEW_LIMIT + 8)
                : [],
            remember: ['session', 'always', 'family', 'pre', 'auto', 'project'].includes(raw.remember) ? raw.remember : '',
            autoRule: ['exact', 'family', 'auto', 'readonly', 'classifier', 'session', 'project', 'full', 'dangerous'].includes(raw.autoRule) ? raw.autoRule : '',
            // 旧会话没有 actor：老语义里 autoRule=auto / remember=auto|pre 都是自动放行，
            // autoRule=exact|family 是「用户批准并记住」，其余已批准项按用户批准处理。
            actor: ['auto', 'user'].includes(raw.actor) ? raw.actor : inferApprovalActor(raw, state),
            danger: raw.danger && typeof raw.danger === 'object' && raw.danger.ruleId
                ? {ruleId: aiTextOf(raw.danger.ruleId), label: aiTextOf(raw.danger.label)}
                : null,
            singleUse: !!raw.singleUse,
            classifyNote: aiTextOf(raw.classifyNote),
            askSource: aiTextOf(raw.askSource),
            classifyScore: Math.min(1, Math.max(0, Number(raw.classifyScore) || 0)),
            classifyInfo: normalizeClassifyInfo(raw.classifyInfo),
            denyRule: aiTextOf(raw.denyRule),
        };
    }

    function parseAskQuestions(input) {
        if (!input || typeof input !== 'object') return [];
        const source = Array.isArray(input.questions)
            ? input.questions
            : (input.question ? [{
                id: 'q1',
                question: input.question,
                options: input.options,
                allow_custom: input.allow_custom,
            }] : []);
        const questions = [];
        const usedIds = new Set();
        source.slice(0, 5).forEach((raw, index) => {
            if (!raw || typeof raw !== 'object') return;
            const question = aiTextOf(raw.question).trim().slice(0, 1000);
            if (!question) return;
            let id = aiTextOf(raw.id).trim().slice(0, 64) || ('q' + (index + 1));
            while (usedIds.has(id)) id = id + '-' + (index + 1);
            usedIds.add(id);
            const options = (Array.isArray(raw.options) ? raw.options : [])
                .map((option) => ({
                    label: aiTextOf(option && option.label).trim().slice(0, 160),
                    description: aiTextOf(option && option.description).trim().slice(0, 300),
                    recommended: !!(option && option.recommended),
                }))
                .filter((option) => option.label)
                .slice(0, 8);
            const allowCustom = raw.allow_custom !== false && raw.allowCustom !== false;
            if (!options.length && !allowCustom) return;
            questions.push({
                id,
                question,
                header: aiTextOf(raw.header).trim().slice(0, 80),
                detail: aiTextOf(raw.detail).trim().slice(0, 500),
                options,
                multiSelect: raw.multiSelect === true || raw.multi_select === true,
                allowCustom,
            });
        });
        return questions;
    }

    function normalizeAsk(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const questions = parseAskQuestions(raw);
        if (!questions.length) return null;
        const answersRaw = Array.isArray(raw.answers) ? raw.answers : [];
        const answers = questions.map((question, index) => {
            const found = answersRaw.find((answer) => answer && aiTextOf(answer.id) === question.id) || answersRaw[index];
            let selected = Array.isArray(found && found.selected)
                ? found.selected.map((label) => aiTextOf(label)).filter((label) => question.options.some((option) => option.label === label))
                : [];
            selected = [...new Set(selected)];
            if (!question.multiSelect) selected = selected.slice(0, 1);
            let custom = aiTextOf(found && found.custom).slice(0, 500);
            // 兼容旧版单问题记录：raw.answer 是选项标签或自定义文本。
            if (raw.answer && index === 0 && !selected.length && !custom) {
                const legacy = aiTextOf(raw.answer);
                if (question.options.some((option) => option.label === legacy)) selected = [legacy];
                else if (legacy) custom = legacy.slice(0, 500);
            }
            return {id: question.id, selected, custom};
        });
        const states = ['pending', 'answered', 'skipped', 'timeout', 'timeout_abort', 'cancelled', 'expired'];
        return {
            questions,
            answers,
            state: states.includes(raw.state) ? raw.state : 'cancelled',
            answer: aiTextOf(raw.answer).slice(0, 1000),
            source: aiTextOf(raw.source),
            deadline: Number(raw.deadline) || 0,
            answeredAt: Number(raw.answeredAt) || 0,
            timeoutSec: Math.max(0, Number(raw.timeoutSec) || 0),
            timeoutAction: ['recommended', 'wait', 'abort', 'ai_decide'].includes(raw.timeoutAction)
                ? raw.timeoutAction
                : 'recommended',
            timeoutCustom: !!raw.timeoutCustom,
            // timeoutAction=wait 会忽略 timeoutSec；恢复历史时保留这个事实，
            // 否则面板不再提示"已忽略 N 秒"，用户会以为当初没设超时
            ignoredSec: Math.max(0, Number(raw.ignoredSec) || 0),
        };
    }

    // 思考循环守卫记录：pending 只在流存活时有意义，页面重开后一律收敛为 ended，
    // 避免历史消息上出现一个永远等不到回答的「待确认」。
    function normalizeGuard(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const states = ['warned', 'pending', 'continued', 'stopped', 'ended', 'cancelled'];
        if (!states.includes(raw.state)) return null;
        return {
            state: raw.state === 'pending' ? 'ended' : raw.state,
            key: aiTextOf(raw.key).slice(0, 160),
            action: aiTextOf(raw.action).slice(0, 32),
            source: aiTextOf(raw.source).slice(0, 32),
            repeats: Math.max(0, Number(raw.repeats) || 0),
            ratio: Math.max(0, Math.min(1, Number(raw.ratio) || 0)),
            chars: Math.max(0, Number(raw.chars) || 0),
            lines: Math.max(0, Number(raw.lines) || 0),
            detectedAt: Number(raw.detectedAt) || 0,
            answeredAt: Number(raw.answeredAt) || 0,
        };
    }

    function normalizeEnvAsk(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const name = aiTextOf(raw.name).trim().slice(0, 128);
        if (!name) return null;
        const state = ['pending', 'approved', 'cancelled', 'failed'].includes(raw.state) ? raw.state : 'cancelled';
        return {
            state,
            name,
            description: aiTextOf(raw.description).slice(0, 500),
        };
    }

    function normalizeTodos(raw) {
        if (!Array.isArray(raw)) return [];
        const list = [];
        for (const item of raw.slice(0, AI_TODO_LIMIT)) {
            if (!item || typeof item !== 'object') continue;
            const content = aiTextOf(item.content).replace(/\s+/g, ' ').trim().slice(0, 200);
            if (!content) continue;
            const status = ['pending', 'in_progress', 'completed'].includes(item.status) ? item.status : 'pending';
            list.push({content, status});
        }
        return list;
    }

    function normalizeChange(raw) {
        if (!raw || typeof raw !== 'object' || !raw.path) return null;
        return {
            path: aiTextOf(raw.path),
            relPath: aiTextOf(raw.relPath) || aiTextOf(raw.path),
            tool: raw.tool === 'edit_file' ? 'edit_file' : 'write_file',
            added: Math.max(0, Number(raw.added) || 0),
            removed: Math.max(0, Number(raw.removed) || 0),
            time: Number(raw.time) || Date.now(),
        };
    }

    // 每轮结束的「已编辑文件」汇总卡数据（Qoder 风格）
    function normalizeChangesSummary(raw) {
        const source = raw && typeof raw === 'object' ? raw : {};
        const files = (Array.isArray(source.files) ? source.files : [])
            .map((file) => ({
                relPath: aiTextOf(file && file.relPath),
                path: aiTextOf(file && file.path),
                added: Math.max(0, Math.round(Number(file && file.added) || 0)),
                removed: Math.max(0, Math.round(Number(file && file.removed) || 0)),
            }))
            .filter((file) => file.relPath)
            .slice(0, 50);
        return {files};
    }

    function normalizeMessage(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const role = ['user', 'assistant', 'tool'].includes(raw.role) ? raw.role : '';
        if (!role) return null;
        const message = {
            role,
            content: aiTextOf(raw.content),
            ts: Number(raw.ts) || Date.now(),
        };
        if (raw._mid) message._mid = aiTextOf(raw._mid);
        if (role === 'user') {
            message.turnStartedAt = Number(raw.turnStartedAt) || 0;
            message.systemNote = raw.systemNote === true;
            // 历史会话没有 silent 字段：按内容识别机械提醒注入块并回填，旧数据同样隐藏
            message.silent = raw.silent === true || isSilentInjection(message.content);
            message.dedupeKey = aiTextOf(raw.dedupeKey).slice(0, 40);
            if (raw.kind === 'model-switch') {
                message.kind = 'model-switch';
                if (raw.modelNote && typeof raw.modelNote === 'object') {
                    message.modelNote = {
                        from: aiTextOf(raw.modelNote.from),
                        to: aiTextOf(raw.modelNote.to),
                        account: aiTextOf(raw.modelNote.account),
                        effort: aiTextOf(raw.modelNote.effort),
                    };
                }
            }
            if (raw.app && typeof raw.app === 'object') {
                // 应用注入的指令（Git 快捷操作 / 定时任务 / 其他功能）：聊天里按应用消息卡片展示，不当用户胶囊。
                message.app = normalizeAppMessage(raw.app);
            } else if (message.content) {
                // 旧会话没有 app 元数据：按固定前缀补标识，避免历史注入消息继续显示成用户胶囊。
                const detected = detectAppMessage(message.content);
                if (detected) message.app = detected;
            }
            message.images = Array.isArray(raw.images)
                ? raw.images.map(aiNormalizeImage).filter(Boolean).slice(0, AI_IMAGE_LIMIT)
                : [];
            message.videos = Array.isArray(raw.videos)
                ? raw.videos.map(aiNormalizeVideo).filter(Boolean).slice(0, AI_VIDEO_LIMIT)
                : [];
        }
        if (role === 'tool') {
            message.toolCallId = aiTextOf(raw.toolCallId);
            message.name = aiTextOf(raw.name);
            message.arguments = safeToolArguments(raw.arguments);
            message.status = ['running', 'pending', 'done', 'error'].includes(raw.status) ? raw.status : 'done';
            message.interrupted = raw.interrupted === true ||
                (message.status === 'error' && TOOL_INTERRUPTED_RE.test(message.content));
            message.approval = normalizeApproval(raw.approval);
            if (message.approval && message.approval.state === 'pending') {
                message.approval.state = 'cancelled';
                message.status = 'done';
                message._recovered = true;
                if (!message.content) message.content = '审批已取消（会话重新加载）';
            }
            message.ask = normalizeAsk(raw.ask);
            if (message.ask && message.ask.state === 'pending') {
                message.ask.state = 'expired';
                message.ask.answeredAt = Date.now();
                message.status = 'done';
                message._recovered = true;
                if (!message.content) message.content = '用户未回答（页面已关闭）';
            } else if (raw.ask && !message.ask && message.status === 'pending') {
                message.status = 'done';
                message._recovered = true;
                if (!message.content) message.content = '问题数据无效，已取消';
            }
            message.envAsk = normalizeEnvAsk(raw.envAsk);
            if (message.envAsk && message.envAsk.state === 'pending') {
                // 会话重新加载后弹窗已不存在，挂起的变量创建统一降级为已取消
                message.envAsk.state = 'cancelled';
                message.status = 'done';
                message._recovered = true;
                if (!message.content) message.content = '变量创建已取消（会话重新加载）';
            }
            // 崩溃/关窗时正在执行的工具：结果未知，按 dsh 的 TOOL_OUTCOME_UNKNOWN 语义收尾，
            // 让模型知道不要盲目假定成功，也避免界面永远转圈。
            if (message.status === 'running' || message.status === 'pending') {
                message.status = 'error';
                message.interrupted = true;
                message._recovered = true;
                if (!message.content) {
                    message.content = TOOL_INTERRUPTED_TEXT;
                }
            }
            // 子代理元数据：转录不落盘（内存态），恢复后只保留小元数据；
            // 上次退出时仍在运行的子代理按「已停止」收敛（子代理不跨进程存活）。
            if (raw.agent && typeof raw.agent === 'object') {
                const agentState = ['done', 'error', 'stopped'].includes(raw.agent.state) ? raw.agent.state : 'stopped';
                message.agent = {
                    name: aiTextOf(raw.agent.name).slice(0, 16),
                    task: aiTextOf(raw.agent.task),
                    state: agentState,
                    rounds: Math.max(0, Number(raw.agent.rounds) || 0),
                    ms: Math.max(0, Number(raw.agent.ms) || 0),
                    tokens: Math.max(0, Number(raw.agent.tokens) || 0),
                    summary: aiTextOf(raw.agent.summary),
                    note: aiTextOf(raw.agent.note),
                };
                if (raw.agent.state === 'running') {
                    message._recovered = true;
                    message.agent.summary = message.agent.summary || '（应用重启，子对话已丢失）';
                }
            }
            // 后台命令作业：应用重启后作业已丢失，运行中的作业收敛为已停止。
            if (raw.bg && typeof raw.bg === 'object') {
                message.bg = {
                    jobId: aiTextOf(raw.bg.jobId),
                    state: ['exited', 'stopped'].includes(raw.bg.state) ? raw.bg.state : 'stopped',
                    code: raw.bg.code == null ? null : Number(raw.bg.code),
                };
                if (raw.bg.state === 'running') {
                    message._recovered = true;
                    if (!message.bg.state || message.bg.state === 'stopped') message.bg.code = -1;
                }
            }
            // 生成任务快照（generate_image / generate_video）：轮询不跨重启，运行中收敛为失败。
            if (raw.gen && typeof raw.gen === 'object') {
                message.gen = normalizeGenSnapshot(raw.gen);
                if (message.gen.status === 'running') {
                    message._recovered = true;
                    message.gen.status = 'failed';
                    message.gen.error = message.gen.error || '应用重启，生成任务已丢失';
                }
            }
            if (raw.bgLog) message.bgLog = aiTextOf(raw.bgLog).slice(0, AI_BG_LIVE_MAX_CHARS);
            return message;
        }
        if (role === 'assistant') {
            message.reasoning = aiTextOf(raw.reasoning);
            message.thinkingSignature = aiTextOf(raw.thinkingSignature);
            message.model = aiTextOf(raw.model);
            message.modelAccount = aiTextOf(raw.modelAccount);
            message.planMode = raw.planMode === true;
            // 计划落盘路径：随会话持久化，重启重放后仍能一键回到标签页看正文
            message.planFile = aiTextOf(raw.planFile);
            message.guard = normalizeGuard(raw.guard);
            message.thinkMs = Number(raw.thinkMs) || 0;
            message.finishedAt = Number(raw.finishedAt) || 0;
            message.turnMs = Math.max(0, Number(raw.turnMs) || 0);
            message.status = ['done', 'stopped', 'error', 'streaming'].includes(raw.status) ? raw.status : 'done';
            if (message.status === 'streaming') {
                // 流式消息不落盘；能读到说明上次进程在生成中被杀，按“已中断”收尾。
                message.status = 'stopped';
                message._recovered = true;
            }
            message.error = aiTextOf(raw.error);
            message.toolCalls = Array.isArray(raw.toolCalls)
                ? raw.toolCalls.map((call) => ({
                    id: aiTextOf(call && call.id),
                    name: aiTextOf(call && call.name),
                    // 历史会话可能存过非法参数（模型多写括号/截断），恢复时先修成合法 JSON。
                    arguments: safeToolArguments(call && call.arguments),
                })).filter((call) => call.id && call.name)
                : [];
            message.usage = raw.usage && typeof raw.usage === 'object'
                ? {
                    promptTokens: Number(raw.usage.promptTokens) || 0,
                    completionTokens: Number(raw.usage.completionTokens) || 0,
                    totalTokens: Number(raw.usage.totalTokens) || 0,
                    cachedTokens: Number(raw.usage.cachedTokens) || 0,
                    cacheWriteTokens: Number(raw.usage.cacheWriteTokens) || 0,
                }
                : null;
            // 每轮结束的文件改动汇总卡：随 JSONL 持久化，重放后照常渲染
            if (raw.kind === 'changes-summary') {
                message.kind = 'changes-summary';
                message.changes = normalizeChangesSummary(raw.changes);
            }
            if (message.status === 'done' && !message.kind && !message.content && !message.reasoning && !message.toolCalls.length) return null;
        }
        return message;
    }

    function normalizeSession(raw, index) {
        if (!raw || typeof raw !== 'object') return null;
        const messages = Array.isArray(raw.messages)
            ? raw.messages.map(normalizeMessage).filter(Boolean)
            : [];
        return {
            id: aiTextOf(raw.id) || aiNowId('session-'),
            title: aiTextOf(raw.title) || ('会话 ' + (index + 1)),
            createdAt: Number(raw.createdAt) || Date.now(),
            updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now(),
            _recovered: messages.some((message) => message && message._recovered),
            scope: AI_SCOPES.includes(raw.scope) ? raw.scope : 'read',
            workspace: aiTextOf(raw.workspace),
            profileId: aiTextOf(raw.profileId),
            // 会话级模型：账号 + 条目 id（未选择时回落到窗口默认）
            modelId: aiTextOf(raw.modelId),
            // 本次会话上下文上限（模型选择器档位；0 = 不设限，生效值取 min(上限, 模型窗口)）
            ctxLimit: normalizeCtxLimit(raw.ctxLimit),
            systemPrompt: aiTextOf(raw.systemPrompt),
            promptTemplateId: aiTextOf(raw.promptTemplateId),
            messages,
            summary: raw.summary && typeof raw.summary === 'object' ? raw.summary : null,
            archived: Array.isArray(raw.archived) ? raw.archived : [],
            archivedAt: Number(raw.archivedAt) || 0,
            pinned: raw.pinned === true,
            // 会话在后台结束（用户没在看它 / 面板关着）时置位，用于列表右侧的「未查看」圆点。
            unread: raw.unread === 'error' ? 'error' : (raw.unread === 'done' || raw.unread === true ? 'done' : ''),
            planMode: raw.planMode === true,
            browserTabId: aiTextOf(raw.browserTabId),
            round: Number(raw.round) || 0,
            logFile: aiTextOf(raw.logFile),
            logSavedAt: Number(raw.logSavedAt) || 0,
            todos: normalizeTodos(raw.todos),
            // 本会话任务提醒（AI 经 reminder_* 工具 / 面板弹层维护，随会话持久化）
            reminders: normalizeReminders(raw.reminders),
            changes: Array.isArray(raw.changes)
                ? raw.changes.map(normalizeChange).filter(Boolean).slice(-AI_CHANGES_LIMIT)
                : [],
            approvedPaths: Array.isArray(raw.approvedPaths)
                ? raw.approvedPaths.filter((path) => typeof path === 'string' && path).slice(0, 200)
                : [],
            // 已批准的工作区外读根（读审批卡「本会话记住」；目录树语义，判定见 ai-read-roots.js）
            readRoots: normalizeReadRoots(raw.readRoots),
            // 支线对话：指向母会话 id（普通会话为空）。不嵌套——读盘时也压成一层的语义。
            sideOf: aiTextOf(raw.sideOf),
            // 隔离 worktree 会话态（唯一归属凭证；fork/支线/投递产生的新会话不继承——
            // 它们走 createSessionData 新建，raw 里没有这个字段就归一成 null）
            worktree: normalizeWorktreeState(raw.worktree),
        };
    }

    // ---------- 懒加载会话（对齐 dsh 的「列表行 vs 打开后的会话」分层）----------
    // dsh 用类型把这两层分开：列表行（SessionSummary）类型上就没有 events 字段，正文只在
    // open() 时才整份校验读一次。这里是原生 JS、没有类型，等价物是运行时标记 `_stub`：
    //   · `_stub` 会话只有 meta，`messages` 恒为空数组（不是 undefined——很多读取点直接 .length）；
    //   · 条数等展示一律走 sessionMessageCount()，它读 meta 缓存的 `_msgCount`；
    //   · 「当会话用」的入口只有三个：switchSession / startSessionTurn / bridgeSwitchSession，
    //     它们先 ensureSessionLoaded() 再继续，所以界面永远拿不到半加载的会话；
    //   · 写盘侧另有硬护栏（ai-session-disk.js）：占位只允许写 meta，整份重写一律拒绝。
    function sessionMessageCount(session) {
        if (!session) return 0;
        if (session._stub) return Math.max(0, Number(session._msgCount) || 0);
        return (session.messages || []).length;
    }

    // 新会话要继承的模型：优先「当前这个会话实际在用的」账号+条目，没有才回落窗口默认。
    // 只看 config.active*（上次显式切换的结果）会与实际脱节——切到一个 pin 着别的模型的
    // 旧会话、或点开设置页里另一个账号的模型编辑器（openModelEditor 会把窗口默认改成该账号），
    // config.active* 都能停在首条目上，于是新会话莫名回到第一个模型。
    function inheritModelRef() {
        let ref = null;
        try {
            ref = sessionModelRef();
        } catch (e) {
            // 启动期 `let sessions = loadAISessions()` 的初始化过程中就会建占位会话，
            // 此时 sessions 还在 TDZ，问不到当前会话，只能用窗口默认。
            ref = null;
        }
        return {
            profileId: aiTextOf(ref && ref.profile && ref.profile.id) || aiTextOf(config.activeProfileId),
            modelId: aiTextOf(ref && ref.entry && ref.entry.id) || aiTextOf(config.activeModelId),
        };
    }

    // 新会话要继承的模型对象（账号 + 条目）：复用空会话时要按它重新 pin。
    function inheritModelTarget() {
        const ids = inheritModelRef();
        const profile = config.profiles.find((item) => item.id === ids.profileId) || null;
        return {profile, entry: profile ? modelEntryOf(profile, ids.modelId) : null};
    }

    function createSessionData(title) {
        // 继承而不是留空等回落——留空会让 sessionModelRef 走「无 pin」分支，chip 直接吃到 models[0]。
        // 分支会话随后会被 forkSettings 覆盖成母会话的选择，不受此处影响。
        const inherited = inheritModelRef();
        return {
            id: aiNowId('session-'),
            title: title || '新会话',
            // 还没落过盘：打开面板时的 meta 对账据此区分「磁盘上没有」是新建还是别处删了
            _unsaved: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            pinned: false,
            unread: '',
            // 新会话取「设置 → AI → 权限 → 新会话默认读写权限」；缺省回退只读访问（历史默认）
            scope: normalizeDefaultScope(config.defaultScope),
            workspace: currentWorkspacePath(),
            profileId: inherited.profileId,
            modelId: inherited.modelId,
            ctxLimit: 0,
            systemPrompt: '',
            promptTemplateId: '',
            messages: [],
            summary: null,
            archived: [],
            archivedAt: 0,
            planMode: false,
            round: 0,
            todos: [],
            reminders: [],
            changes: [],
            approvedPaths: [],
            readRoots: [],
            sideOf: '',
        };
    }

    function sessionImageBytes(images) {
        let bytes = 0;
        for (const image of images || []) bytes += image && image.data ? image.data.length : 0;
        return bytes;
    }

    // ---------- 存储模式与会话加载 ----------

    function storageMode() {
        try {
            return localStorage.getItem(AI_STORAGE_MODE_KEY) === 'legacy' ? 'legacy' : 'disk';
        } catch (e) {
            return 'disk';
        }
    }

    let storageFallback = false;
    function effectiveStorageMode() {
        return storageFallback ? 'legacy' : storageMode();
    }

    function legacySessionsRaw() {
        try {
            const raw = JSON.parse(localStorage.getItem(AI_SESSIONS_KEY) || '[]');
            return Array.isArray(raw) ? raw : [];
        } catch (e) {
            return [];
        }
    }

    function loadLegacySessions(rawList) {
        const raw = Array.isArray(rawList) ? rawList : legacySessionsRaw();
        const out = [];
        const seen = new Set();
        raw.forEach((item, index) => {
            const session = normalizeSession(item, index);
            if (!session) return;
            let id = session.id;
            let suffix = 2;
            while (seen.has(id)) id = session.id + '-' + suffix++;
            session.id = id;
            seen.add(id);
            out.push(session);
        });
        while (out.length > AI_LEGACY_SESSION_LIMIT) {
            out.splice(pickSessionToDrop(out, config.activeSessionId), 1);
        }
        // 老会话没有 workspace：用其他会话已知的工作区 + 本会话的变更路径做一次温和回填。
        const knownWorkspaces = [];
        for (const session of out) {
            if (session.workspace && !knownWorkspaces.includes(session.workspace)) knownWorkspaces.push(session.workspace);
        }
        for (const session of out) {
            if (!session.workspace) session.workspace = inferSessionWorkspace(session, knownWorkspaces);
        }
        return out;
    }

    function loadAISessions() {
        const out = loadLegacySessions();
        if (!out.length) out.push(createSessionData());
        return out;
    }

    function migratedSessionIDs() {
        try {
            const raw = JSON.parse(localStorage.getItem(AI_SESSION_MIGRATED_IDS_KEY) || '[]');
            return new Set(Array.isArray(raw) ? raw.map((id) => aiTextOf(id)).filter(Boolean) : []);
        } catch (e) {
            return new Set();
        }
    }

    function markMigratedSessionIDs(ids) {
        try {
            const set = migratedSessionIDs();
            for (const id of ids || []) if (id) set.add(aiTextOf(id));
            localStorage.setItem(AI_SESSION_MIGRATED_IDS_KEY, JSON.stringify(Array.from(set).slice(-2000)));
        } catch (e) {}
    }

    // 旧 localStorage 数据保留 30 天供回退；到期后清理（回退开关置 legacy 时不清理）。
    function cleanupLegacySessions() {
        if (storageMode() === 'legacy') return;
        try {
            const at = Number(localStorage.getItem(AI_SESSION_MIGRATED_AT_KEY)) || 0;
            if (!at || Date.now() - at < AI_LEGACY_KEEP_DAYS * 86400000) return;
            localStorage.removeItem(AI_SESSIONS_KEY);
            localStorage.removeItem(AI_SESSION_MIGRATED_IDS_KEY);
        } catch (e) {}
    }

    let sessionStoreErrorAt = 0;
    function notifySessionStoreError(error) {
        const now = Date.now();
        if (now - sessionStoreErrorAt < 30000) return;
        sessionStoreErrorAt = now;
        try {
            if (typeof flash === 'function') {
                flash('会话保存失败：' + ((error && error.message) || error), true);
            }
        } catch (e) {}
    }

    const sessionStore = createSessionDiskStore({
        backend,
        genId: aiNowId,
        onError: notifySessionStoreError,
        // 懒加载补正文时也要走同一套消息归一化（否则补上来的消息形状和启动读盘不一致）
        normalizeMessage,
    });
    let sessionsLoaded = storageMode() === 'legacy';
    let sessionsReady = null;
    let pendingPersist = false;
    let lastDiskLoadAt = 0;
    // 上一次真正画进面板的会话 id：配置从磁盘读回后用它判断「视图是不是还留在旧会话上」。
    let lastRenderedSessionId = '';

    // 启动瞬间（磁盘会话还没读出来）sessions 只是占位：老 localStorage 快照或一个空会话。
    // 这时按它渲染就会先闪一个错误的会话、几秒后再跳到真正上次打开的会话——
    // 所以这段时间只给加载态，等 bootstrapSessionStorage 结束时的 refreshSessionUI 一次性画真内容。
    function sessionsPending() {
        return !sessionsLoaded && effectiveStorageMode() === 'disk';
    }

    function refreshSessionUI() {
        renderSessionList();
        if (isOpen()) {
            renderMessages(true);
            updateComposerState();
        }
        updateScopeUI();
        updateSendState();
    }

    function whenSessionsReady() {
        if (!sessionsReady) sessionsReady = bootstrapSessionStorage();
        return sessionsReady;
    }

    // 「完全没动过的空会话」：无消息、无任务/变更/提醒/摘要，标题还是默认。
    // 用于新建会话前的复用判定与加载后的存量去重。
    function isVirginSession(session) {
        if (!session || session.archivedAt) return false;
        // 懒加载占位不能当「没动过」判：它的 messages 是空的只是因为正文还没读
        if (session._stub) return false;
        if ((session.messages || []).length) return false;
        if ((session.todos || []).length || (session.changes || []).length || (session.reminders || []).length) return false;
        if (session.summary) return false;
        const title = aiTextOf(session.title).trim();
        return !title || title === '新会话';
    }

    // 存量去重：主窗口与悬浮窗是两个进程，各自启动都会落一个占位空会话，磁盘上
    // 可能攒下多个「新会话 · 0 条消息」。按工作区分组，每组只留最新的一个空会话
    //（当前正在看的会话优先保留），其余静默剔除——空会话没有任何用户数据。
    function dedupeVirginSessions() {
        const spare = sessions.filter(isVirginSession);
        if (spare.length < 2) return;
        const current = currentSession();
        const groups = new Map();
        for (const session of spare) {
            const key = aiWorkspaceKey(sessionWorkspacePath(session));
            const list = groups.get(key) || [];
            list.push(session);
            groups.set(key, list);
        }
        const survivors = new Set();
        for (const list of groups.values()) {
            const sorted = list.slice().sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
            survivors.add(current && sorted.includes(current) ? current : sorted[0]);
        }
        const dropped = spare.filter((session) => !survivors.has(session));
        if (!dropped.length) return;
        sessions = sessions.filter((session) => !dropped.includes(session));
        if (config.activeSessionId && !sessions.some((session) => session.id === config.activeSessionId)) {
            config.activeSessionId = sessions[0] ? sessions[0].id : '';
        }
        persistSessions();
        renderSessionList();
    }

    async function bootstrapSessionStorage() {
        if (storageMode() === 'legacy') {
            sessionsLoaded = true;
            return sessions;
        }
        try {
            // 列表只要 meta：meta.json 里有标题/时间/条数/未读/置顶/待办/摘要，一次 IPC 全拿到。
            // 正文（整份 JSONL 重放）留到「真的要看这个会话」时再读——见 ensureSessionLoaded。
            let metas = await sessionStore.loadMetas();
            // 只有磁盘读取成功后才允许清理旧缓存；磁盘不可用时保留 localStorage 作为最后一份数据。
            cleanupLegacySessions();
            const legacy = legacySessionsRaw();
            if (legacy.length) {
                const known = new Set(metas.map((meta) => meta.id));
                const migrated = migratedSessionIDs();
                const pending = [];
                for (const raw of legacy) {
                    const session = normalizeSession(raw, pending.length);
                    if (!session || known.has(session.id) || migrated.has(session.id)) continue;
                    pending.push(session);
                }
                for (const session of pending) await sessionStore.rewriteSession(session);
                if (pending.length) {
                    await sessionStore.flush();
                    // 迁移后按磁盘重新读一遍 meta：多窗口同时迁移时以落盘结果为准，避免 mids 各写各的。
                    metas = await sessionStore.loadMetas();
                }
                markMigratedSessionIDs(metas.map((meta) => meta.id));
                try {
                    if (!localStorage.getItem(AI_SESSION_MIGRATED_AT_KEY)) {
                        localStorage.setItem(AI_SESSION_MIGRATED_AT_KEY, String(Date.now()));
                    }
                } catch (e) {}
            }
            if (metas.length) {
                sessions = sessionStore.toStubs(metas, normalizeSession);
            } else {
                // 磁盘为空就是真的空（包括用户删光）：不能把启动时用于占位的 legacy 会话再写回去。
                sessions = [createSessionData()];
            }
            if (!sessions.some((session) => session.id === config.activeSessionId)) {
                config.activeSessionId = sessions[0] ? sessions[0].id : '';
            }
            sessionsLoaded = true;
            lastDiskLoadAt = Date.now();
            if (pendingPersist) {
                pendingPersist = false;
                persistSessions();
            }
            // 空会话去重只看已载体的（占位不能当「没动过」判，见 isVirginSession）
            dedupeVirginSessions();
            refreshSessionUI();
            // 列表已经画出来了：正文只补「当前会话 + 最近若干条」，其余等点开/被唤醒时再读
            hydrateStartupSessions();
        } catch (e) {
            storageFallback = true;
            sessionsLoaded = true;
            notifySessionStoreError(e);
            try {
                if (typeof flash === 'function') flash('会话磁盘存储不可用，已回退到本地缓存', true);
            } catch (e2) {}
            // 启动时渲染被「读盘中」的加载态挡掉了：失败回退也要把面板画出来，不能一直停在加载态
            refreshSessionUI();
        }
        return sessions;
    }

    // 启动补正文的范围：当前会话 + 最近若干条（正好覆盖列表首页，再多也没有意义）。
    // 与 dsh 一致：列表永不打开冷日志，只有「要用」的才读正文。
    const AI_STARTUP_HYDRATE = 12;

    function startupHydrateTargets() {
        const out = [];
        const active = sessions.find((session) => session.id === config.activeSessionId);
        if (active && active._stub) out.push(active);
        const recent = sessions.slice().sort((a, b) => sessionActivityTs(b) - sessionActivityTs(a));
        for (const session of recent) {
            if (out.length >= AI_STARTUP_HYDRATE) break;
            if (session._stub && !out.includes(session)) out.push(session);
        }
        return out;
    }

    async function hydrateStartupSessions() {
        const targets = startupHydrateTargets();
        if (!targets.length) return;
        try {
            // store 内部 6 路并发；单条失败只会打 _loadError，不影响其余会话
            await sessionStore.hydrateSessions(targets);
        } catch (e) {
            return;
        }
        renderSessionList();
        if (isOpen()) {
            stickBottom = true;
            renderMessages(true);
            updateComposerState();
            refreshSystemPromptEstimate(true);
        }
        // 补完才算「真知道」哪些会话是空的：启动时的去重跳过占位，这里补一次
        dedupeVirginSessions();
        // 上次进程在生成/工具执行中被杀过：正文补上后尽早把收尾状态写回（等价 dsh 的 recovery closer）
        for (const session of targets) {
            if (session && session._needsRewrite) sessionStore.persistSession(session);
        }
        const failed = targets.filter((session) => session._loadError);
        if (failed.length && typeof flash === 'function') {
            flash('部分会话读取失败：' + failed[0]._loadError, true);
        }
    }

    // 按需补正文（用户点开 / 要发消息 / 桥切会话时）：同一个会话并发只读一次。
    const hydrateJobs = new Map();

    function ensureSessionLoaded(session) {
        if (!session || !session._stub) return Promise.resolve(true);
        const running = hydrateJobs.get(session.id);
        if (running) return running;
        const job = Promise.resolve()
            .then(() => sessionStore.hydrateSession(session))
            .then((ok) => {
                if (ok && session._needsRewrite) sessionStore.persistSession(session);
                return ok;
            })
            .catch(() => false)
            .then((ok) => {
                hydrateJobs.delete(session.id);
                scheduleSessionListRefresh();
                if (ok && isOpen() && currentSession() === session) {
                    renderMessages(true);
                    updateComposerState();
                }
                return ok;
            });
        hydrateJobs.set(session.id, job);
        return job;
    }

    // 补水会改变列表上的「待审批 / 计划待批准」徽标：攒一下再画，别每条都整树重建
    let listRefreshTimer = 0;
    function scheduleSessionListRefresh() {
        if (listRefreshTimer) return;
        listRefreshTimer = setTimeout(() => {
            listRefreshTimer = 0;
            renderSessionList();
        }, 150);
    }

    // 归档入栈：超过 AI_ARCHIVE_LIMIT 会丢弃最旧的归档，这里主动提示，避免静默。
    function pushArchivedMessages(session, moved) {
        if (!session || !moved || !moved.length) return 0;
        const list = (session.archived || []).concat(moved);
        const overflow = Math.max(0, list.length - AI_ARCHIVE_LIMIT);
        session.archived = overflow ? list.slice(-AI_ARCHIVE_LIMIT) : list;
        if (overflow) notifyArchiveOverflow(overflow);
        return overflow;
    }

    function notifyArchiveOverflow(dropped) {
        const now = Date.now();
        if (now - archiveOverflowAt < 30000) return; // 30 秒内不重复打扰
        archiveOverflowAt = now;
        try {
            if (typeof flash === 'function') {
                flash('已归档消息超过 ' + AI_ARCHIVE_LIMIT + ' 条上限，最旧的 ' + dropped +
                    ' 条已被丢弃；建议先「导出 Markdown」留存历史', true);
            }
        } catch (e) {}
    }

    // 仅 legacy 回退路径使用：旧 localStorage 整包容量有限，需要淘汰。
    // 优先已归档里最久没动的，其次最久没动的非归档会话。
    function pickSessionToDrop(list, protectedId) {
        if (!list.length) return -1;
        const oldest = (pool) => {
            let best = -1;
            let bestAt = Infinity;
            pool.forEach((session, index) => {
                const at = sessionActivity(session) || Number(session.createdAt) || 0;
                if (at < bestAt) {
                    bestAt = at;
                    best = index;
                }
            });
            return best;
        };
        const archivedIndexes = [];
        const liveIndexes = [];
        list.forEach((session, index) => {
            (session && session.archivedAt ? archivedIndexes : liveIndexes).push(index);
        });
        const archivedPick = oldest(archivedIndexes.map((index) => list[index]));
        if (archivedPick >= 0) return archivedIndexes[archivedPick];
        const safeLive = liveIndexes.filter((index) => !protectedId || list[index].id !== protectedId);
        const pick = oldest(safeLive.map((index) => list[index]));
        if (pick >= 0) return safeLive[pick];
        return safeLive.length ? safeLive[0] : (liveIndexes[0] ?? 0);
    }

    let storageFailAt = 0;
    function persistLegacySessions() {
        try {
            localStorage.setItem(AI_SESSIONS_KEY, JSON.stringify(sessions, (key, value) => (
                key && key.startsWith('_') ? undefined : value
            )));
        } catch (e) {
            notifyStorageFailed();
        }
        saveAIConfig();
    }

    function sessionUseDisk() {
        return sessionsLoaded && effectiveStorageMode() === 'disk';
    }

    function persistSessions() {
        if (!sessionsLoaded) {
            pendingPersist = true;
            return;
        }
        if (effectiveStorageMode() === 'legacy') {
            persistLegacySessions();
            return;
        }
        for (const session of sessions) {
            if (!session || !session.id) continue;
            sessionStore.persistSession(session).catch(notifySessionStoreError);
        }
        saveAIConfig();
    }

    // 会话日志是追加式的：工具消息首次落盘后再就地改审批对象（自动放行 / 用户裁定 /
    // 失败 / 取消）不会被覆盖。这里先标记该消息待截断重写（store.invalidateMessage），
    // 再触发持久化，保证 JSONL 与内存一致——否则分类器放行来源、用户裁定结果等
    // 会永远留在旧状态（如「pending」或根本没有 approval）。
    function persistApprovalMutation(session, toolMessage) {
        if (sessionStore && session && toolMessage) {
            try {
                sessionStore.invalidateMessage(session, toolMessage);
            } catch (e) {}
        }
        persistSessions();
    }

    function notifyStorageFailed() {
        const now = Date.now();
        if (now - storageFailAt < 30000) return;
        storageFailAt = now;
        try {
            if (typeof showNote === 'function') {
                showNote('会话保存失败。请检查应用数据目录是否可写，或导出 Markdown 留存当前会话；未写盘的消息仅存在于内存中。', true);
            }
        } catch (e) {}
    }

    function currentSession() {
        return sessions.find((s) => s.id === config.activeSessionId) || sessions[0] || null;
    }

    // ---------- 会话级流注册表 ----------
    // 每个会话一条独立的流：A 会话在生成时切到 B 会话，B 的 composer 应该是「发送」而不是「停止」，
    // 并且可以独立发起新一轮（后端按 sessionId 隔离，互不打断）。

    function streamOf(sessionId) {
        return sessionId ? (streams.get(sessionId) || null) : null;
    }

    function anyStreaming() {
        return streams.size > 0;
    }

    // 上下文压缩（oneShot）同一时间只允许一个，但 UI 与发送判定必须按会话：
    // 后台会话在压缩，不该让当前会话的输入框变成「停止 / 排队」。
    function compactOf(sessionId) {
        return oneShot && sessionId && oneShot.sessionId === sessionId ? oneShot : null;
    }

    // 把镜像 stream 对齐到「当前查看会话」的流；所有依赖 stream 的 UI 读取点先调它。
    function syncStreamView() {
        const session = currentSession();
        stream = session ? (streams.get(session.id) || null) : null;
        return stream;
    }

    // 回合运行态广播：异常必须吞掉，宿主回调不能影响流本身的生命周期。
    function notifyTurnState(running, sessionId, isCurrent) {
        if (!onTurnStateChange) return;
        try { onTurnStateChange(!!running, sessionId || '', !!isCurrent); } catch (e) {}
    }

    // 注册 / 注销会话流，并立即刷新镜像与 composer 状态。
    function attachStream(next) {
        streams.set(next.sessionId, next);
        // 正在看的会话开始新一轮：上一轮留下的「已完成未查看」已经没有意义，
        // 否则列表里会先显示绿点、要等用户再点一次条目才变成运行中。
        const viewed = currentSession();
        if (viewed && viewed.id === next.sessionId) clearSessionUnread(viewed);
        syncStreamView();
        notifyTurnState(true, next.sessionId, !!(viewed && viewed.id === next.sessionId));
        return next;
    }

    function detachStream(next) {
        if (next && streams.get(next.sessionId) === next) streams.delete(next.sessionId);
        syncStreamView();
        if (next) {
            const viewed = currentSession();
            notifyTurnState(false, next.sessionId, !!(viewed && viewed.id === next.sessionId));
        }
    }

    // ---------- 每会话系统提示词缓存 ----------
    // 占用估算用的是「这一轮真会发给模型的系统提示词」；A 会话的注入上下文（工作区 / 附件 / 记忆）
    // 不能拿去估 B 会话，所以缓存与 in-flight 任务都按 sessionId 分开。

    function promptTextOf(sessionId) {
        const hit = sessionId ? promptCache.get(sessionId) : null;
        return (hit && hit.text) || AI_DEFAULT_SYSTEM_PROMPT;
    }

    function promptCachedAt(sessionId) {
        const hit = sessionId ? promptCache.get(sessionId) : null;
        return hit ? Number(hit.at) || 0 : 0;
    }

    function rememberPrompt(sessionId, bundle) {
        if (!sessionId || !bundle) return;
        promptCache.set(sessionId, {
            text: bundle.text || AI_DEFAULT_SYSTEM_PROMPT,
            meta: bundle.meta || null,
            at: Date.now(),
        });
    }

    function forgetPrompt(sessionId) {
        if (sessionId) promptCache.delete(sessionId);
    }

    function activeProfile() {
        const found = config.profiles.find((p) => p.id === config.activeProfileId);
        return found || config.profiles[0] || null;
    }

    // 当前激活的模型条目（激活账号下按 activeModelId 精确匹配，缺省首条目）。
    function activeModelEntry() {
        const profile = activeProfile();
        return profile ? modelEntryOf(profile, config.activeModelId) : null;
    }

    // ---------- 会话级模型 ----------
    // 参考 dsh：模型选择属于会话（随会话持久化），没选过的会话回落到窗口默认；
    // 手动切换会同时更新「这个会话的选择」与「窗口默认」（新会话继承上次用的）。
    function sessionModelRef(session) {
        const target = session === undefined ? currentSession() : session;
        const pinnedProfile = target && target.profileId
            ? config.profiles.find((p) => p.id === target.profileId)
            : null;
        if (!pinnedProfile) return {profile: activeProfile(), entry: activeModelEntry(), pinned: false};
        let modelId = aiTextOf(target.modelId);
        if (!modelId) {
            // 旧会话只有账号没有条目：按窗口当前条目 / 账号记住的条目回落
            modelId = pinnedProfile.id === config.activeProfileId ? config.activeModelId : pinnedProfile.lastModelId;
        }
        return {profile: pinnedProfile, entry: modelEntryOf(pinnedProfile, modelId), pinned: true};
    }

    function profileOf(session) {
        return sessionModelRef(session).profile;
    }

    function entryOf(session) {
        return sessionModelRef(session).entry;
    }

    // 会话自己的上下文窗口（预算 / 压缩估算用）：模型条目窗口被「本次会话上下文上限」
    // 收窄（取 min，永不放大）。用量百分比 / auto-compact / 发送预检等消费方全部经此单点。
    function contextWindowOf(session) {
        const target = session === undefined ? currentSession() : session;
        const entry = entryOf(target);
        return effectiveContextWindow((entry && entry.contextWindow) || 128000, target && target.ctxLimit);
    }

    // 把选择固定到会话上（发送时 / 手动切换模型时）。
    function pinSessionModel(session, profile, entry) {
        if (!session) return;
        session.profileId = profile ? profile.id : '';
        session.modelId = entry ? entry.id : '';
    }

    // 窗口默认跟着「实际在用的」模型走：切换会话后把该会话的账号+条目写回 config，
    // 否则 config.active* 会一直停在最后一次显式切换的值上（新会话继承、设置页「当前」
    // 徽标、旧版本镜像全都跟实际在用的模型不一致）。
    // 插件虚拟账号只活在内存里，不写进窗口默认——落盘后就是悬空 id，下次启动被归一化成首条目。
    function syncActiveFromSession(session) {
        const ref = sessionModelRef(session);
        if (!ref.profile || !ref.entry) return;
        if (ref.profile.pluginAI) return;
        config.activeProfileId = ref.profile.id;
        config.activeModelId = ref.entry.id;
    }

    // 激活账号的旧字段镜像 = 激活条目；saveAIConfig 每次保存前同步，
    // 旧版本 exe 回滚后仍能读到与保存时一致的一份可用配置。
    function syncActiveMirror() {
        const profile = activeProfile();
        const entry = activeModelEntry();
        if (!profile || !entry) return;
        profile.model = entry.model;
        profile.maxTokens = entry.outputWindow;
        profile.contextWindow = entry.contextWindow;
        profile.reasoningEffort = entry.reasoningEffort;
        profile.thinking = entry.thinking;
        profile.thinkingBudget = entry.thinkingBudget;
    }

    function providerLabel(profile) {
        return profile && profile.provider === 'anthropic' ? 'Anthropic'
            : (profile && profile.provider === 'responses' ? 'Responses' : 'OpenAI 兼容');
    }

    function promptById(id) {
        return config.prompts.find((prompt) => prompt.id === id) || null;
    }

    function effectiveSystemPrompt(session) {
        const own = aiTextOf(session && session.systemPrompt).trim();
        if (own) return own;
        const bySession = promptById(session && session.promptTemplateId);
        if (bySession && bySession.content.trim()) return bySession.content;
        const active = promptById(config.activePromptId);
        if (active && active.content.trim()) return active.content;
        return AI_DEFAULT_SYSTEM_PROMPT;
    }

    // 组装请求配置：连接字段取账号；模型字段取条目。激活账号用 activeModelId，
    // 其他账号（如分类器引用）用其 lastModelId 记住的条目。
    function configForProfile(profile, entry) {
        let cfg;
        if (!profile) cfg = configForModel(null, null);
        else if (entry) cfg = configForModel(profile, entry);
        else {
            const isActive = profile.id === (activeProfile() && activeProfile().id);
            const fallback = modelEntryOf(profile, isActive ? config.activeModelId : profile.lastModelId);
            cfg = configForModel(profile, fallback);
        }
        // 插件 provider 的每轮动态补丁（请求头 / 请求体）在这里统一合并；
        // 普通账号原样返回，prepare 抛异常时插件模块内部降级忽略。
        return mergePluginAIRequest(cfg, {
            accountId: profile ? profile.id : '',
            sessionId: config.activeSessionId || '',
        });
    }

    function updateSessionTitleFromText(session, text) {
        if (session.title && session.title !== '新会话' && session.title !== '会话') return;
        const title = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 24);
        if (title) session.title = title;
    }

    function generatedTitle(text) {
        let value = aiTextOf(text).trim();
        if (!value) return '';
        value = value.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();
        value = value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
        value = value.replace(/^#+\s*/, '');
        value = value.replace(/^(标题|会话标题|title)\s*[:：]\s*/i, '');
        value = value.replace(/^[*_]+|[*_]+$/g, '');
        value = value.replace(/^["'“”‘’「」『』《》]+|["'“”‘’「」『』《》]+$/g, '');
        value = value.replace(/[。．.!！?？,，;；:：]+$/g, '');
        value = value.replace(/\s+/g, ' ').trim();
        if (value.length < 2) return '';
        return value.slice(0, 24);
    }

    function finishTitleJob() {
        const job = titleJob;
        titleJob = null;
        if (job) {
            const session = sessionById(job.sessionId);
            const title = session && session.title === job.titleBase ? generatedTitle(job.buffer) : '';
            if (title && title !== session.title) {
                session.title = title;
                persistSessions();
                renderSessionList();
                queueLogSave(session);
            }
        }
        // 结束（无论成败）后再处理排队的会话：多会话同时收尾时都能拿到标题
        drainTitleQueue();
    }

    // 标题任务同一时间只跑一个（后端也要按 id 路由事件），但排队的会话不能丢：
    // 以前 titleJob 忙时第二个会话的标题会被静默跳过，要等它下一轮才补。
    const pendingTitleSessions = [];

    function drainTitleQueue() {
        while (!titleJob && pendingTitleSessions.length) {
            const session = sessionById(pendingTitleSessions.shift());
            if (session) maybeAutoTitle(session);
        }
    }

    // 首轮结束后额外请求一次模型生成标题；失败/用户已改名时保留原标题。
    function maybeAutoTitle(session) {
        if (!config.autoTitle) return false;
        if (!session || session.archivedAt || !backend.AISendChat) return false;
        if (titleAttempted.has(session.id)) return false;
        const messages = session.messages || [];
        if (messages.length < 2) return false;
        const user = messages[0];
        if (!user || user.role !== 'user' || user.systemNote) return false;
        const text = aiTextOf(user.content).trim();
        if (!text) return false;
        const fallback = text.replace(/\s+/g, ' ').trim().slice(0, 24);
        if (session.title !== fallback) return false;
        const profile = profileOf(session);
        if (!profile) return false;
        // 已经有标题任务在跑：排队，等它结束后再补（多会话并发生成时很常见）
        if (titleJob) {
            if (!pendingTitleSessions.includes(session.id)) pendingTitleSessions.push(session.id);
            return false;
        }
        titleAttempted.add(session.id);
        const id = session.id + '#title-' + Date.now();
        titleJob = {id, sessionId: session.id, buffer: '', titleBase: session.title};
        const requestMessages = [
            {role: 'system', content: AI_TITLE_SYSTEM_PROMPT},
            {role: 'user', content: text.slice(0, 4000)},
        ];
        const titleConfig = Object.assign(configForProfile(profile, entryOf(session)), {
            maxTokens: 64,
            temperature: 0.3,
            thinking: false,
            reasoningEffort: '',
        });
        Promise.resolve(backend.AISendChat(id, titleConfig, requestMessages, [], 0)).catch(() => {
            if (titleJob && titleJob.id === id) {
                titleJob = null;
                drainTitleQueue();
            }
        });
        return true;
    }

    // ---------- 面板基础渲染 ----------

    function isOpen() {
        return !panel.classList.contains('hidden');
    }

    function ensureOpen() {
        if (!isOpen()) open(true);
    }

    // ---------- 会话视图宿主 ----------
    // 会话内容视图可以同时被多个宿主渲染（AI 面板 / 内容区支线对话标签页）。所有
    // 「这条渲染要不要落到 DOM 上」的判定都收敛到 hasHost()：渲染函数不再假设「面板
    // 当前查看的会话就是唯一渲染目标」——旧守卫 `currentSession() !== session` 会让
    // 面板显示母会话时吞掉支线标签页里的流式与工具卡更新。
    // 当前只有面板一个宿主，本实现与旧守卫逐字节等价（isOpen + 会话相同）；支线标签
    // 页接入时只需把本函数换成查 viewHosts 登记表，调用点不必再动。
    function hasHost(sessionId) {
        if (!sessionId) return false;
        if (!isOpen()) return false;
        const viewed = currentSession();
        return !!viewed && viewed.id === sessionId;
    }

    function updateEntryButtons() {
        const open = isOpen();
        for (const button of [activityButton, toolbarButton]) {
            if (!button) continue;
            button.classList.toggle('active', open);
            button.setAttribute('aria-pressed', String(open));
        }
    }


    // ---------- Todolist / 变更记录 / 授权清单 ----------

    // Todolist UI（阶段 3 拆出：ai-todos.js）
    const todosMod = createAITodos({
        todoStates,
        el,
        currentSession,
        positionOverlays,
        settings,
    });
    const renderTodos = () => todosMod.renderTodos();

    // 变更记录 UI（阶段 3 拆出：ai-changes-ui.js）
    const changesMod = createAIChangesUI({
        changesSummaryFold,
        el,
        panel,
        currentSession,
        openPath,
        openVirtualDoc,
        getScopeRoot,
        backend,
        flash,
        askConfirm,
        // 轮尾汇总卡的「撤销」：回滚本轮编辑的文件到 HEAD（main.js 的 gitRollbackPaths）
        rollbackGitPaths: (...args) => opts.rollbackGitPaths(...args),
    });
    const updateChangesUI = () => changesMod.updateChangesUI();
    const showChangesPopover = () => changesMod.showChangesPopover();
    const hideChangesPopover = () => changesMod.hideChangesPopover();
    const changesSnapshot = (session) => changesMod.changesSnapshot(session);
    const appendChangesSummary = (session, mark) => changesMod.appendChangesSummary(session, mark);
    const renderChangesSummaryCard = (message, session) => changesMod.renderChangesSummaryCard(message, session);
    const changesSummaryBlock = (message, session) => changesMod.changesSummaryBlock(message, session);

    // 会话列表域（阶段 3 拆出：ai-session-list.js；sessions 只读经 getSessions，stickBottom 经 setStickBottom）
    const sessionListMod = createAISessionList({
        el,
        sessionListEl,
        sessionMoreBtn,
        renderWindows,
        streams,
        backend,
        // 支线对话（阶段 F）与会话信箱（阶段 H）：构造在本模块之后，惰性转发
        openSideChat: (...args) => sidechatMod.openSideChat(...args),
        promoteSideChat: (...args) => sidechatMod.promoteSideChat(...args),
        clearMailbox: (...args) => noticesMod.clearMailbox(...args),
        pendingNoticeCount: (...args) => noticesMod.pendingCount(...args),
        // 后台轮次的停止入口（§4.14.2）：streams 按会话隔离，停谁都不用切视图
        flash,
        stopSessionTurn: (sessionId) => {
            const target = streamOf(sessionId);
            if (target) stopGeneration(target);
        },
        aiWorkspaceKey,
        aiWorkspaceName,
        sessionWorkspacePath,
        sessionUseDisk,
        // 首次读盘未完成：列表给加载态，别把占位会话当列表画出来（启动闪烁的根因之一）
        sessionsPending,
        // 条数单一来源：懒加载占位读 meta 缓存，已载体的现算
        messageCount: sessionMessageCount,
        currentSession,
        currentWorkspacePath,
        isOpen,
        ensureOpen,
        persistSessions,
        renderMessages,
        renderModelChip,
        sessionById,
        // 惰性转发：sessionHasLiveBgJob 别名随子代理域构造于本模块之后
        sessionHasLiveBgJob: (...args) => sessionHasLiveBgJob(...args),
        switchSession,
        updateHeadHud: (...args) => updateHeadHud(...args),
        toggleSessionPin,
        renameSession,
        exportSession,
        showSessionDiagnostics,
        archiveSession,
        deleteSession,
        newSession,
        newSessionInWorkspace,
        openAILogDir,
        showContextMenu,
        getSessions: () => sessions,
        setStickBottom: (value) => { stickBottom = value; },
    });
    const renderProfileSelect = () => sessionListMod.renderProfileSelect();
    const sessionActivity = (...args) => sessionListMod.sessionActivity(...args);
    const setSessionUnread = (...args) => sessionListMod.setSessionUnread(...args);
    const renderSessionList = () => sessionListMod.renderSessionList();
    const showSessionMenu = (...args) => sessionListMod.showSessionMenu(...args);
    const showSessionListMenu = (...args) => sessionListMod.showSessionListMenu(...args);
    const clearSessionUnread = (...args) => sessionListMod.clearSessionUnread(...args);

    // AI 设置页（阶段 3 拆出：ai-settings-dialog.js；config 经 getConfig 读，sessions 写经 setSessions）
    const settingsMod = createAISettingsDialog({
        el, panel, opt, settings, saveSettings, flash, askConfirm, backend, readTextFile,
        modelCatalog,
        isOpen, currentSession, persistSessions, saveAIConfig,
        renderMessages, updateContextCount, updateSendState, updateComposerState, queueLogSave,
        renderModelChip, renderProfileSelect, renderSessionList, sessionActivity, sessionTitleById: (...args) => sessionTitleById(...args),
        newSession, open, switchSession, compactOf, streamOf, sendAppMessage,
        activeProfile, appControlOn, defaultModelEntry, defaultProfile, normalizeProfile,
        configForProfile, promptById, emptyState, dialogButton, openAIDialog, closeAIDialog,
        invalidateSkillsCache, resolveMemoryDir, getAILogRoot, openAILogDir,
        aiNormalizePath, aiJoinPath, aiPathDir, aiPathKey, aiProjectRoot, aiWorkspaceKey,
        queryUsageForAccount, showModelListPicker, switchProfile,
        showNameDialog, setAIChatFont, applyPanelSettings, createSessionData,
        sessionStore, sessionUseDisk,
        // 队列所有权在 ai-message-queue.js：这里只给「清空」这一个动作（惰性转发，
        // 队列模块构造于本模块之后，取数组本体会在构造期触发 TDZ）
        clearMessageQueue: () => queueMod.clearAll(),
        getSessions: () => sessions,
        updateCtxBanner: (...args) => updateCtxBanner(...args),
        // 设置页切「任务清单默认展开」后，让既有会话的收起态立即跟随
        applyTodosCollapseDefault: () => todosMod.applyDefaultCollapse(),
        getConfig: () => config,
        // 端侧分类器（本模块构造于设置对话框之后，经 getter 惰性触达）
        localClassifier: () => localClassifierMod,
        openSettings,
        enhanceSelect,
        getPluginCommandClassifiers,
        getPluginLoadErrors,
        refreshPlugins,
        setSessions: (value) => { sessions = value; },
        getSkillsCache: () => skillsCache,
        getPermissionAudit: () => permissionAudit,
        setMemoryFallbackNotified: (value) => { memoryFallbackNotified = value; },
        // 惰性转发：三别名构造于本模块之后（对话框 / 定时任务互引）
        showMemoryDialog: (...args) => showMemoryDialog(...args),
        // 操作留痕：个性化改动只记字段名，不记正文（activity 为空时各子域自行降级）
        activity,
        // 个性化页用：展示当前生效的助手名（与气泡 / 状态条同一解析）
        assistantName,
        showSkillsDialog: (...args) => showSkillsDialog(...args),
        openScheduleEditor: (...args) => openScheduleEditor(...args),
        // 显示方式设置行：setMode 兼管 'float'（打开独立悬浮窗）
        setMode: (...args) => setMode(...args),
    });
    const renderApprovedSettings = (...args) => settingsMod.renderApprovedSettings(...args);
    const renderProjectRuleTable = (...args) => settingsMod.renderProjectRuleTable(...args);
    const renderPermissionSettings = (...args) => settingsMod.renderPermissionSettings(...args);
    const refreshPermissionEditors = (...args) => settingsMod.refreshPermissionEditors(...args);
    const renderPreferenceSettings = (...args) => settingsMod.renderPreferenceSettings(...args);
    const submitPreferenceText = (...args) => settingsMod.submitPreferenceText(...args);
    const editPreference = (...args) => settingsMod.editPreference(...args);
    const addPreference = (...args) => settingsMod.addPreference(...args);
    const aiAddUnique = (...args) => settingsMod.aiAddUnique(...args);
    const commandRulesFor = (...args) => settingsMod.commandRulesFor(...args);
    const enqueueProjectRulesMutation = (...args) => settingsMod.enqueueProjectRulesMutation(...args);
    const saveProjectRules = (...args) => settingsMod.saveProjectRules(...args);
    const addProjectRule = (...args) => settingsMod.addProjectRule(...args);
    const setSettingsStatus = (...args) => settingsMod.setSettingsStatus(...args);
    const settingsFormDisabled = (...args) => settingsMod.settingsFormDisabled(...args);
    const refreshThinkingVisibility = (...args) => settingsMod.refreshThinkingVisibility(...args);
    const clampThinkingBudget = (...args) => settingsMod.clampThinkingBudget(...args);
    const editorEntryOf = (...args) => settingsMod.editorEntryOf(...args);
    const refreshSettingsPane = (...args) => settingsMod.refreshSettingsPane(...args);
    const renderPresetSelect = (...args) => settingsMod.renderPresetSelect(...args);
    const refreshPromptSettings = (...args) => settingsMod.refreshPromptSettings(...args);
    const renderModelList = (...args) => settingsMod.renderModelList(...args);
    const openModelEditor = (...args) => settingsMod.openModelEditor(...args);
    const closeModelEditor = (...args) => settingsMod.closeModelEditor(...args);
    const exportAIConfig = (...args) => settingsMod.exportAIConfig(...args);
    const importAIConfig = (...args) => settingsMod.importAIConfig(...args);
    const bindSettingsPane = (...args) => settingsMod.bindSettingsPane(...args);
    // 以下函数随 O 区段被卷入设置模块（阶段 2 遗留的权限规则/偏好基建），别名回接
    const isPathApproved = (...args) => settingsMod.isPathApproved(...args);
    const addCommandApprovalRule = (...args) => settingsMod.addCommandApprovalRule(...args);
    const matchCommandApproval = (...args) => settingsMod.matchCommandApproval(...args);
    const projectRulesPath = (...args) => settingsMod.projectRulesPath(...args);
    const ensureProjectRules = (...args) => settingsMod.ensureProjectRules(...args);
    const refreshChatSettings = (...args) => settingsMod.refreshChatSettings(...args);
    const refreshMemoryPath = (...args) => settingsMod.refreshMemoryPath(...args);
    const providerLabelFor = (...args) => settingsMod.providerLabelFor(...args);
    const commandApprovalRules = settingsMod.commandApprovalRules;

    // 任务提醒域（ai-reminders.js）：自带按钮与弹层，挂在面板标题栏；数据存 session.reminders
    const remindersMod = createAIReminders({
        panel,
        currentSession,
        persistSessions,
        flash,
        // 创建对话框用居中弹窗（openAIDialog 三件套；函数声明提升，此处引用安全）
        openDialog: openAIDialog,
        closeDialog: closeAIDialog,
        dialogNode,
        dialogButton,
    });
    remindersMod.mount();
    // reminder_* 工具改完清单后同步徽标与弹层（非当前会话时跳过，切回时由 switchSession 刷新）
    function syncRemindersUI(session) {
        if (session && currentSession() === session) remindersMod.refresh();
    }

    // 隔离 worktree 域（ai-worktree.js）：工具执行、会话态、胶囊与启动 reconcile。
    // requestPatchApproval / patchResultText 构造于本模块之后，一律惰性转发。
    const worktreeMod = createAIWorktree({
        backend,
        getScopeRoot,
        currentSession,
        currentScopeOf,
        persistSessions,
        flash,
        requestPatchApproval: (...args) => requestPatchApproval(...args),
        patchResultText: (...args) => patchResultText(...args),
        recordChange,
        notifyFileChanged,
        refreshToolWrap: (...args) => refreshToolWrap(...args),
        toolHalted: (...args) => toolHalted(...args),
        logPermission,
        getSessions: () => sessions,
        // 本会话派生的子代理隔离区（含终态记录）：export/discard by name 的归属判定
        getSubWorktrees: (...args) => subagentsMod.worktreeNamesForSession(...args),
        joinPath: (...args) => aiJoinPath(...args),
        openDialog: openAIDialog,
        closeDialog: closeAIDialog,
        dialogNode,
        dialogButton,
        dialogEl: el.dialog,
        chip: el.chipWorktree,
    });
    worktreeMod.mountChip();
    worktreeMod.pruneStartup();
    // 启动即按当前会话同步胶囊（恢复的会话 meta 里有 worktree 字段，占位也能显示）
    worktreeMod.syncChip(currentSession());



    // 定时任务域（阶段 3 拆出：ai-schedule.js；sessions 模块内只读，经 getSessions 访问）
    const scheduleMod = createAISchedule({
        opt,
        el,
        backend,
        flash,
        askConfirm,
        openAIDialog,
        closeAIDialog,
        dialogButton,
        sessionTitleById: (...args) => sessionTitleById(...args),
        sessionActivity,
        currentSession,
        getSessions: () => sessions,
        open,
        newSession,
        persistSessions,
        renderSessionList,
        switchSession,
        streamOf,
        compactOf,
        sendAppMessage,
        // 静默注入（阶段 I）：定时任务改走会话信箱，不切视图、不强开面板
        deliverAgentNotice: (...args) => noticesMod.deliverAgentNotice(...args),
        // 头部定时任务胶囊与弹层（kind=schedules，与计时器胶囊同机制）
        chipSchedules: el.chipSchedules,
        togglePop: (chip) => toggleChipsPop('schedules', chip),
        hideChipsPop: () => hideChipsPop(),
        openSettings,
        // 会话归属判定：自动化弹层只展示本工作区会话的任务（跨工作区的折叠成提示行）
        isSessionLocal: (session) => !session || !session.workspace
            || aiWorkspaceKey(session.workspace) === aiWorkspaceKey(currentWorkspacePath()),
        // 胶囊 = 当前会话口径（与计时胶囊一致）
        getSessionId: () => {
            const session = currentSession();
            return session ? session.id : '';
        },
        onSchedulesChanged: () => {
            if (chipsPopKind === 'schedules') renderChipsPop('schedules');
        },
    });
    const renderScheduleSettings = () => scheduleMod.renderScheduleSettings();
    const openScheduleEditor = (...args) => scheduleMod.openScheduleEditor(...args);
    const aiDelay = (...args) => scheduleMod.aiDelay(...args);
    const handleScheduleFire = (...args) => scheduleMod.handleScheduleFire(...args);

    // 计时器（类一-11）：Go 侧计时 + 头部单胶囊（点开弹层列表）；到点经系统消息唤醒启动它的会话
    const timerMod = createAITimer({
        getBackend: () => backend,
        getSessionId: () => {
            const session = currentSession();
            return session ? session.id : '';
        },
        getChip: () => el.chipTimers,
        flash,
        // 创建对话框用居中弹窗（openAIDialog 三件套；函数声明提升，此处引用安全）
        openDialog: openAIDialog,
        closeDialog: closeAIDialog,
        dialogNode,
        dialogButton,
        // 弹层复用 chips-pop 机制（kind=timers），内容经 renderChipsPopExtra 钩子由本域提供
        togglePop: (chip) => toggleChipsPop('timers', chip),
        onTimersChanged: () => {
            if (chipsPopKind === 'timers') renderChipsPop('timers');
        },
        onFire: (payload) => {
            // 不能空 catch：唤醒链路的异常必须可见，否则用户只看到胶囊消失、没有任何提示
            // （track 过一次真实事故：getSessions 未定义被这里吞掉，到点永远静默无反应）。
            Promise.resolve(wakeSessionByTimer(payload)).catch((e) => {
                flash('计时器「' + String((payload && payload.label) || '计时器') + '」唤醒失败：' + ((e && e.message) || e), true);
            });
        },
    });
    timerMod.syncFromBackend();
    // 头部定时任务胶囊初查（无启用任务时保持隐藏）
    scheduleMod.renderChip();

    // 生图/视频生成任务运行时（ai-gen-jobs.js）：模板渲染在纯函数层，Go 侧是哑通道。
    // 工具卡刷新与完成唤醒经回调进本域（wakeSessionByGenDone 走 ai-agent-notices 信箱）。
    const genJobsMod = createAIGenJobs({
        getBackend: () => backend,
        getConfig: () => config,
        flash,
        onJobUpdate: (job) => {
            const owner = sessionById(job.sessionId);
            if (owner && job.toolMessage) refreshToolWrap(owner, job.toolMessage);
        },
        onJobDone: (job) => {
            Promise.resolve(wakeSessionByGenDone(job)).catch((e) => {
                flash('生成任务通知失败：' + String((e && e.message) || e), true);
            });
        },
    });

    // 端侧命令分类器：内置线性模型（懒加载权重）+ 插件分类器聚合、失败熔断、个性化学习。
    // 纯离线；只产出危险概率，判定在 approveCommandForRun 按严格度阈值完成。
    const localClassifierMod = createAILocalClassifier({
        getBackend: () => backend,
        getAIAppDir,
        readTextFile,
        getConfig: () => config,
        getPluginClassifiers: getPluginCommandClassifiers,
        flash,
    });

    // 计时器到点：向启动它的会话注入系统消息并唤醒一轮（与定时任务同一投递通道）
    // 正计时停止通知的抑制表：AI 用 stop_timer 工具停止时，工具结果已带时长文本，
    // 广播回来的 ai-timer-stopped 不再重复投系统消息（用户手动停止才投）。
    const suppressCountupStopIds = new Set();

    // timerMarksText 计时器标记时间线（停止/到点投递用）：T+偏移 + 可选备注，分号连接。
    function timerMarksText(info) {
        const marks = Array.isArray(info && info.marks) ? info.marks : [];
        if (!marks.length) return '';
        const startMs = Number(info.startMs) || 0;
        const pad = (n) => String(n).padStart(2, '0');
        const offset = (mark) => {
            const s = Math.max(0, Math.round(((Number(mark.atMs) || 0) - startMs) / 1000));
            const hh = Math.floor(s / 3600);
            return (hh > 0 ? hh + ':' : '') + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
        };
        return marks.map((mark) => 'T+' + offset(mark) + (mark.note ? ' ' + String(mark.note) : '')).join('；');
    }

    // wakeSessionByCountupStop 正计时被停止（用户手动 / 到点自动）时给绑定会话投系统消息：
    // AI 启动「盯耗时」的正计时后，停止发生时 AI 就能拿到实际时长（与标记时间线）并接话分析——
    // countup 与 countdown 一样的感知闭环。
    async function wakeSessionByCountupStop(sessionId, info) {
        const label = String((info && info.label) || '正计时');
        const session = sessions.find((s) => s.id === sessionId);
        if (!session) return; // 会话已删除或不在本窗口：静默丢弃
        try {
            if (session.archivedAt) {
                session.archivedAt = 0;
                persistSessions();
                renderSessionList();
            }
            const seconds = Math.max(0, Math.round(Number(info && info.startMs) ? (Date.now() - info.startMs) / 1000 : 0));
            const desc = seconds >= 60 && seconds % 60 === 0 ? (seconds / 60) + ' 分钟' : seconds + ' 秒';
            const marksText = timerMarksText(info);
            const stopKind = info && info.auto ? '（到点自动停止）' : '';
            await sendAppMessage({
                kind: 'timer',
                label: '正计时 · ' + label,
                content: '[正计时已停止' + stopKind + ' · ' + label + ']\n已计时长 ' + desc + '。' +
                    (marksText ? '期间标记时间线：' + marksText + '。\n' : '') +
                    '若此前在等待该事项的耗时结果，请基于时长与标记继续分析或简短向用户确认；无需展开无关内容。',
            });
            flash('正计时「' + label + '」已停止' + stopKind + '，已计 ' + desc + '（已通知会话）');
        } catch (e) {
            flash('正计时「' + label + '」停止通知失败：' + ((e && e.message) || e), true);
        }
    }

    // 计时器到点（§4.13.3 #6）：与定时任务走**同一份**静默注入——不 open、不 switchSession、
    // 不忙等；目标空闲就起一轮，忙就排到它下一轮边界。
    async function wakeSessionByTimer(payload) {
        const label = String((payload && payload.label) || '计时器');
        const sessionId = String((payload && payload.sessionId) || '');
        // 本文件里会话列表就是 sessions（getSessions 只是给域模块的 ctx 访问器，此处不可用；
        // 早期写成 getSessions() 会抛 ReferenceError，被 onFire 的 catch 吞掉 → 到点静默无反应）
        const session = sessions.find((s) => s.id === sessionId);
        if (!session) return; // 会话已删除或不在本窗口：静默丢弃
        try {
            if (session.archivedAt) {
                // 绑定会话被归档：自动取消归档再唤醒（与定时任务一致）
                session.archivedAt = 0;
                persistSessions();
                renderSessionList();
            }
            // 跨工作区口径同定时任务（§4.13.4）：按本窗口工作区解析系统上下文，跨区目标保持失败
            if (session.workspace && aiWorkspaceKey(session.workspace) !== aiWorkspaceKey(currentWorkspacePath())) {
                flash('计时器「' + label + '」到点，但目标会话属于其他工作区，请到对应窗口处理', true);
                return;
            }
            const seconds = Math.max(1, Math.round(Number(payload && payload.endMs && payload.startMs ? (payload.endMs - payload.startMs) / 1000 : 0)));
            const desc = seconds >= 60 && seconds % 60 === 0 ? (seconds / 60) + ' 分钟' : seconds + ' 秒';
            const marksText = timerMarksText(payload);
            const receipt = deliverAgentNotice(session, {
                kind: 'timer',
                label: '计时器 · ' + label,
                content: '[计时器到点 · ' + label + ']\n设定为 ' + desc + ' 的倒计时已结束。' +
                    (marksText ? '期间标记时间线：' + marksText + '。\n' : '') +
                    '请继续处理之前等待的事项；若已无可继续的步骤，简短告知用户计时结束即可。',
            });
            if (!receipt || !receipt.ok) {
                flash('计时器「' + label + '」到点但未能注入：' + ((receipt && receipt.reason) || '未知'), true);
                return;
            }
            flash('计时器「' + label + '」已到点' + (receipt.woke ? '并唤醒' : '，已排入会话信箱'));
        } catch (e) {
            flash('计时器「' + label + '」唤醒失败：' + ((e && e.message) || e), true);
        }
    }

    // 生成任务完成/失败唤醒（异步 generate_image / generate_video）：对齐计时器到点的信箱投递。
    function wakeSessionByGenDone(job) {
        const sessionId = String((job && job.sessionId) || '');
        const session = sessions.find((s) => s.id === sessionId);
        if (!session) return; // 会话已删除或不在本窗口：静默丢弃
        try {
            if (session.archivedAt) {
                // 归档会话自动恢复再唤醒（与计时器/定时任务一致）
                session.archivedAt = 0;
                persistSessions();
                renderSessionList();
            }
            if (session.workspace && aiWorkspaceKey(session.workspace) !== aiWorkspaceKey(currentWorkspacePath())) {
                flash('生成任务已结束，但目标会话属于其他工作区，请到对应窗口处理', true);
                return;
            }
            const kindLabel = job.kind === 'video' ? '视频' : '图片';
            let content;
            if (job.status === 'done') {
                const lines = (job.files || []).map((file) => '- ' + file.path + '（' + file.mime + '，' + file.bytes + ' 字节）').join('\n');
                content = '[生成完成 · ' + kindLabel + ']\n「' + job.entryName + '」的任务已完成，产物：\n' + lines +
                    '\n请把上述路径告知用户（可在回复中用 Markdown 图片语法引用），或继续后续步骤。';
            } else {
                content = '[生成失败 · ' + kindLabel + ']\n「' + job.entryName + '」的任务失败：' + (job.error || '未知原因') +
                    '\n请向用户说明失败原因；如需重试请调整参数或检查生成条目配置。';
            }
            const receipt = deliverAgentNotice(session, {
                kind: 'gen',
                label: '生成任务 · ' + job.entryName,
                content,
            });
            if (!receipt || !receipt.ok) {
                flash('生成任务已结束但未能注入：' + ((receipt && receipt.reason) || '未知'), true);
                return;
            }
            flash('生成任务已结束' + (receipt.woke ? '并唤醒会话' : '，已排入会话信箱'));
        } catch (e) {
            flash('生成任务唤醒失败：' + ((e && e.message) || e), true);
        }
    }

    function emptyState(kind) {
        const box = document.createElement('div');
        box.className = 'ai-empty';
        if (kind === 'no-profile') {
            const title = document.createElement('strong');
            title.textContent = '尚未配置 AI';
            const text = document.createElement('span');
            text.textContent = '未配置模型';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'dlg-btn primary';
            button.textContent = '打开 AI 设置';
            button.addEventListener('click', () => openSettings('models'));
            box.append(title, text, button);
        } else {
            // 看板娘默认形象（costume-midautumn，512px WebP 仅 20KB）。data-default-src
            // 记录内置默认图，mascot-wardrobe 插件据此做点击换装与恢复。
            const mascot = document.createElement('img');
            mascot.className = 'ai-empty-mascot';
            mascot.src = '/brand/mascot-empty.webp';
            mascot.alt = '';
            mascot.draggable = false;
            mascot.dataset.defaultSrc = mascot.src;
            const title = document.createElement('strong');
            title.textContent = '开始新的对话';
            const text = document.createElement('span');
            // 空态副标题带助手名：克制、不随回复风格加梗（默认名时即「甜澄在这儿 · 输入问题开始对话」）
            text.textContent = assistantName() + '在这儿 · 输入问题开始对话';
            box.append(mascot, title, text);
        }
        return box;
    }

    // 首次读盘期间的占位：消息区不要空着（空面板像「会话丢了」），也不要用占位会话渲染。
    function renderSessionsLoading() {
        const host = msgHost();
        if (!host) return;
        host.innerHTML = '';
        const box = document.createElement('div');
        box.className = 'ai-empty';
        const title = document.createElement('strong');
        title.textContent = '正在读取会话…';
        const text = document.createElement('span');
        text.textContent = '历史对话较多时会稍等一下';
        box.append(title, text);
        host.appendChild(box);
        stickBottom = true;
        lastRenderedSessionId = '';
    }

    function messageWindowTokens(message) {
        if (!message) return 0;
        let text = aiTextOf(message.content);
        if (message.reasoning) text += message.reasoning;
        if (message.arguments) text += message.arguments;
        return aiEstimateTokens(text);
    }

    function alignWindowToTurn(session, start) {
        if (start <= 0) return 0;
        for (let i = start; i >= 0; i--) {
            // 与 groupTurns 同一套边界判定：窗口起点不落在截图附加这类中途注入消息上。
            if (isTurnBoundaryMessage(session.messages[i])) return i;
        }
        return 0;
    }

    function windowStartFrom(session, fromIndex, needTokens) {
        let tokens = 0;
        let start = 0;
        for (let i = fromIndex - 1; i >= 0; i--) {
            tokens += messageWindowTokens(session.messages[i]);
            start = i;
            if (tokens >= needTokens) break;
        }
        return alignWindowToTurn(session, start);
    }

    function renderWindowState(session) {
        const len = session.messages.length;
        let state = renderWindows.get(session.id);
        // 消息变少（/compact、编辑重发、清空）时旧窗口索引失效，重新计算。
        if (state && len < state.len) state = null;
        if (!state) {
            const need = Math.max(AI_RENDER_INITIAL_TOKENS, contextWindowOf(session));
            state = {start: windowStartFrom(session, len, need), len};
            renderWindows.set(session.id, state);
        }
        state.len = len;
        if (state.start > len) state.start = 0;
        return state;
    }

    // 压缩摘要卡：常驻消息流顶部，让「已压缩」这件事看得见、历史可回看。
    // 压缩本身会砍掉几十上百条消息，原来界面上毫无痕迹，用户只会觉得「对话突然没了」。
    function renderArchivedSummaryCard(session) {
        const archived = Array.isArray(session.archived) ? session.archived : [];
        const summaryText = aiTextOf(session && session.summary && session.summary.text).trim();
        if (!archived.length && !summaryText) return;
        const open = !!archivedFlowOpen.get(session.id);

        const card = document.createElement('div');
        card.className = 'ai-archived-card' + (open ? ' open' : '');

        const head = document.createElement('div');
        head.className = 'ai-archived-head';

        const dot = document.createElement('span');
        dot.className = 'ai-archived-dot';
        dot.setAttribute('aria-hidden', 'true');

        const text = document.createElement('span');
        text.className = 'ai-archived-text';
        const parts = ['上下文已压缩'];
        if (archived.length) parts.push('归档 ' + archived.length + ' 条');
        parts.push('保留 ' + session.messages.length + ' 条');
        text.textContent = parts.join(' · ');
        // 触发依据：事后能看出「凭什么压的」——自动/手动、当时窗口、估算占比。
        const trigger = session.summary && session.summary.trigger;
        const storageArchive = session.storageArchive;
        let detailText = '';
        // 存储降级归档：与上下文压缩无关，单独标注，避免再被误认为「凭空压缩」。
        if (storageArchive && storageArchive.moved) {
            detailText = '本地存储告急 · 降级归档 ' + storageArchive.moved + ' 条（与上下文压缩无关）';
        }
        if (!detailText && trigger && trigger.windowSize) {
            const pct = trigger.estimate > 0 ? Math.round(trigger.estimate / trigger.windowSize * 100) : 0;
            detailText = (trigger.kind === 'auto' ? '自动触发' : '手动触发') +
                ' · 当时窗口 ' + aiFormatCompactTokens(trigger.windowSize) +
                ' · 估算 ' + aiFormatCompactTokens(trigger.estimate) + '（' + pct + '%）' +
                (trigger.threshold ? ' · 阈值 ' + Math.round(trigger.threshold * 100) + '%' : '') +
                (trigger.model ? ' · ' + trigger.model : '');
        }

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ai-archived-btn';
        btn.textContent = open ? '收起历史' : '展开历史';
        btn.addEventListener('click', () => {
            archivedFlowOpen.set(session.id, !open);
            renderMessages(true);
        });

        head.append(dot, text, btn);
        card.appendChild(head);

        const meta = document.createElement('div');
        meta.className = 'ai-archived-meta';
        const created = session.summary && session.summary.createdAt
            ? new Date(session.summary.createdAt).toLocaleString() : '';
        const lines = [];
        if (detailText) lines.push(detailText);
        if (created) lines.push('压缩于 ' + created);
        meta.textContent = lines.join(' · ');
        if (lines.length) card.appendChild(meta);

        if (open) {
            const body = document.createElement('div');
            body.className = 'ai-archived-body';
            if (summaryText) {
                const sum = document.createElement('div');
                sum.className = 'ai-archived-summary';
                const sumTitle = document.createElement('div');
                sumTitle.className = 'ai-archived-summary-title';
                sumTitle.textContent = '会话摘要（当前上下文以此代替更早的消息）';
                const sumBody = document.createElement('div');
                sumBody.className = 'ai-md';
                sumBody.innerHTML = renderMarkdown(summaryText);
                sum.append(sumTitle, sumBody);
                body.appendChild(sum);
            }
            if (archived.length) {
                const note = document.createElement('div');
                note.className = 'ai-archived-note';
                note.textContent = '以下 ' + archived.length + ' 条为压缩前原文，仅供参考，不再发送给模型';
                body.appendChild(note);
                const list = document.createElement('div');
                list.className = 'ai-archived-list';
                // 伪 session id：让折叠记忆（processFoldState 以 session.id 为键）不与当前消息串味。
                const archivedSession = Object.assign({}, session,
                    {id: session.id + '#archived', messages: archived});
                const groups = groupTurns(archivedSession, 0);
                groups.forEach((group) => renderTurn(group, archivedSession, false, list, {archived: true}));
                body.appendChild(list);
            }
            card.appendChild(body);
        }
        msgHost().appendChild(card);
    }

    function renderLoadEarlier(start) {
        const row = document.createElement('div');
        row.className = 'ai-load-earlier';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ai-load-earlier-btn';
        btn.textContent = '↑ 上方还有 ' + start + ' 条更早消息';
        btn.addEventListener('click', () => loadEarlierMessages());
        row.appendChild(btn);
        msgHost().appendChild(row);
    }

    function loadEarlierMessages() {
        if (loadingEarlier) return;
        const session = currentSession();
        if (!session) return;
        const state = renderWindows.get(session.id);
        if (!state || state.start <= 0) return;
        loadingEarlier = true;
        try {
            const oldStart = state.start;
            const newStart = windowStartFrom(session, oldStart, AI_RENDER_STEP_TOKENS);
            const row = el.messages.querySelector('.ai-load-earlier');
            if (newStart >= oldStart) {
                if (row) row.remove();
                return;
            }
            const prevHeight = el.messages.scrollHeight;
            const prevTop = el.messages.scrollTop;
            state.start = newStart;
            const fragment = document.createDocumentFragment();
            const groups = groupTurns(session, newStart, oldStart);
            groups.forEach((group) => renderTurn(group, session, false, fragment));
            el.messages.insertBefore(fragment, row ? row.nextSibling : el.messages.firstChild);
            if (row) {
                if (newStart <= 0) row.remove();
                else {
                    const btn = row.querySelector('.ai-load-earlier-btn');
                    if (btn) btn.textContent = '↑ 上方还有 ' + newStart + ' 条更早消息';
                }
            }
            // 保持视口内容不动：新增内容在顶部，补偿对应高度。
            el.messages.scrollTop = prevTop + (el.messages.scrollHeight - prevHeight);
        } finally {
            loadingEarlier = false;
        }
        updateScrollButton();
    }

    // ---------- 渲染目标（多宿主） ----------
    // 内容区「支线对话」标签页复用面板的渲染函数，但不能让它们写到面板的消息区里。
    // 渲染期间把消息区容器与会话临时指向宿主，其余单例 UI（todos / 改动汇总 / 统计行 /
    // 接管区 / 滚动钮 / 结构面板）一律跳过——那些属于面板外壳。
    // 全量渲染是同步的，用 try/finally 复位；异步路径（流式增量）不走这里。
    let renderTarget = null;
    function msgHost() {
        return (renderTarget && renderTarget.container) || el.messages;
    }
    function renderSessionOf() {
        return (renderTarget && renderTarget.session) || currentSession();
    }
    function withRenderTarget(target, fn) {
        const prev = renderTarget;
        renderTarget = target || null;
        try {
            return fn();
        } finally {
            renderTarget = prev;
        }
    }

    function renderMessages(keepScroll) {
        // 首次读盘未完成：此时 sessions 只是占位（老快照 / 一个空会话），任何来源的重绘
        // 都只会画出一个错误会话再被替换。统一压成加载态，读盘结束后 refreshSessionUI 画真内容。
        if (sessionsPending()) {
            renderSessionsLoading();
            return;
        }
        renderMessagesInner(keepScroll);
        // 消息流变了：结构面板的会话大纲要跟着更新（新增轮次 / 切换会话 / 压缩 / 编辑重发）
        notifyStructure();
        scheduleOutlineSync();
    }

    // 内容区「支线对话」标签页的渲染入口：宿主给容器，面板用自己的渲染函数画进去。
    // 不调 renderMessages 外壳——那会顺手刷新面板的结构面板与大纲，跟这个会话无关。
    function renderSideChatInto(root, sessionId) {
        if (!root) return false;
        const session = sessionById(sessionId);
        if (!session) {
            root.textContent = '这个对话已不存在（可能已被删除）';
            root.classList.add('empty');
            return false;
        }
        withRenderTarget({container: root, session}, () => renderMessagesInner(false));
        return true;
    }

    // ---------- 支线对话标签页的桥（状态 / 发送 / 停止 / 胶囊 / 会话切换通知） ----------
    // 标签页是「另一个视图」，但会话状态、流、审批登记表都在面板闭包里：这里只做薄转发，
    // 不复制任何状态。失联态靠 sessionSwitchListeners 通知各标签页重新判定。

    function sideChatState(sessionId) {
        const session = sessionById(sessionId);
        if (!session) return {ok: false, reason: 'gone'};
        const ownerId = aiTextOf(session.sideOf).trim();
        const owner = ownerId ? sessionById(ownerId) : null;
        const viewing = currentSession();
        return {
            ok: true,
            sessionId: session.id,
            title: session.title || '支线对话',
            ownerId,
            ownerTitle: owner ? (owner.title || '主对话') : '',
            ownerGone: !!ownerId && !owner,
            // 无 sideOf（转正后的独立会话）不受「与母会话同场」约束，视为在位
            inPlace: ownerId ? (!!owner && !!viewing && viewing.id === owner.id) : true,
            streaming: !!streamOf(session.id),
            scope: session.scope || 'read',
            count: (session.messages || []).length,
        };
    }

    async function sendSideChatMessage(sessionId, text) {
        const session = sessionById(sessionId);
        if (!session) return {ok: false, reason: 'gone'};
        return await startSessionTurn(session, text, {});
    }

    function stopSideChatMessage(sessionId) {
        const live = streamOf(sessionId);
        if (!live) return {ok: false, reason: 'idle'};
        stopGeneration(live);
        return {ok: true};
    }

    function sideChatChipsOf(sessionId) {
        const session = sessionById(sessionId);
        let terms = 0;
        if (session) {
            for (const entry of bgJobIndex.values()) if (entry.session === session) terms++;
        }
        let timers = 0;
        try {
            const snap = timerMod.snapshot([sessionId]);
            timers = Array.isArray(snap) ? snap.length : 0;
        } catch (e) {}
        return {agents: activeSubCount(), terms, timers};
    }

    // 胶囊点击：回到面板并展开对应的头部弹层（列表与定位都由面板那套负责）
    function openSideChatChip(kind) {
        ensureOpen();
        const chip = kind === 'agents' ? el.chipAgents
            : kind === 'terms' ? el.chipTerms
                : kind === 'timers' ? el.chipTimers
                    : el.chipSchedules;
        if (!chip) return false;
        toggleChipsPop(kind, chip);
        return true;
    }

    // 失联横幅的两个动作：回到母会话 / 把支线转正（母会话已删除时的唯一出路）
    function returnToSideChatOwner(sessionId) {
        const session = sessionById(sessionId);
        const ownerId = session ? aiTextOf(session.sideOf).trim() : '';
        if (!ownerId) return false;
        ensureOpen();
        switchSession(ownerId);
        return true;
    }

    function promoteSideChatFromTab(sessionId) {
        const session = sessionById(sessionId);
        if (!session) return false;
        return promoteSideChat(session);
    }

    // 标签页里的接管区（写审批 / ask / env / 计划批准）：把面板那套渲染按会话画进宿主容器。
    // 支线要「工具完整」，写文件审批就必须能在标签页里点，否则支线一遇到写操作就卡死。
    function renderSideChatTakeover(root, sessionId) {
        const session = sessionById(sessionId);
        if (!root || !session) return false;
        takeoverMod.updateComposerTakeover(false, session, root);
        return true;
    }

    // 标签页里的消息点击代理：审批 / 环境变量 / 用量徽标（其余动作无响应，避免误伤母会话）
    function sideChatClick(e, sessionId) {
        const session = sessionById(sessionId);
        if (!session) return;
        const target = e.target;
        if (!target || !target.closest) return;
        if (!target.closest('[data-ai-approve],[data-ai-env],[data-ai-act="usage"]')) return;
        handleMessageClick(e, session);
    }

    // 面板单例 UI 的收尾刷新：外部宿主渲染时跳过（宿主自己管滚动与状态条）
    function finishRender(forPanel) {
        if (!forPanel) return;
        updateContextCount();
        updateScrollButton();
        updateComposerTakeover();
    }

    function renderMessagesInner(keepScroll) {
        const host = msgHost();
        if (!host) return;
        const forPanel = !renderTarget;
        // 重绘会换掉消息节点，用量浮层的锚点随即失效
        if (forPanel) {
            closeTurnUsagePop();
            syncStreamView();
        }
        const session = renderSessionOf();
        // 面板视图落点：配置从磁盘读回后据此判断要不要把视图切到真正的当前会话
        //（支线标签页借用同一套渲染，不能覆盖这个标记）
        if (forPanel) lastRenderedSessionId = session ? session.id : '';
        // 全量重建会把 scrollTop 钳到 0；keepScroll=true 时记录并在重建后恢复，
        // 否则像切换计划模式这类重渲染会把当前对话弹到顶部。
        const prevTop = host.scrollTop;
        host.innerHTML = '';
        slashState.open = false;
        if (forPanel) {
            renderTodos();
            updateChangesUI();
        }
        if (!session) return;
        // 懒加载会话：正文还没从磁盘读上来（正常路径不会走到这里——switchSession /
        // startSessionTurn 都会先 ensureSessionLoaded）。留着兜底：宁可显示「正在载入」，
        // 也不能把「空 messages」当成「这个会话没有消息」画出来。
        if (session._stub) {
            const box = document.createElement('div');
            box.className = 'ai-empty';
            const title = document.createElement('strong');
            title.textContent = '正在载入对话…';
            box.appendChild(title);
            host.appendChild(box);
            finishRender(forPanel);
            return;
        }
        if (!profileOf(session) && !session.messages.length) {
            host.appendChild(emptyState('no-profile'));
            finishRender(forPanel);
            return;
        }
        if (!session.messages.length) {
            host.appendChild(emptyState('empty'));
            finishRender(forPanel);
            return;
        }
        const state = renderWindowState(session);
        renderArchivedSummaryCard(session);
        if (state.start > 0) renderLoadEarlier(state.start);
        const groups = groupTurns(session, state.start);
        groups.forEach((group, groupIndex) => {
            renderTurn(group, session, groupIndex === groups.length - 1);
        });
        const live = streamOf(session.id);
        if (live) {
            // 流式状态条钉在消息区最底部（任务清单卡片上方）：看板娘 + 随机开场文案 + 实时计时
            const bar = document.createElement('div');
            bar.className = 'ai-streaming-bar';
            bar.dataset.processStart = String(Number(live.startedAt) || 0);
            // 开场即定随机偏移与全局基准；阶段切换不清零，索引随 8 秒 tick 连续漂移。
            const waitPhrases = phrasesForPhase('wait');
            const phraseSalt = randomMascotSalt(waitPhrases.length);
            bar.dataset.phraseBaseAt = String(Date.now());
            bar.dataset.phraseSalt = String(phraseSalt);
            const mascot = document.createElement('img');
            mascot.className = 'ai-process-mascot';
            mascot.src = '/brand/mascot.png';
            mascot.alt = '';
            mascot.draggable = false;
            const label = document.createElement('span');
            label.className = 'ai-streaming-label';
            label.textContent = personaText(waitPhrases[mascotPhraseIndex(0, phraseSalt, waitPhrases.length)]);
            const dots = document.createElement('span');
            dots.className = 'ai-process-dots';
            dots.innerHTML = '<i></i><i></i><i></i>';
            const timer = document.createElement('span');
            timer.className = 'ai-process-timer';
            timer.textContent = aiFormatLiveDuration(Math.max(0, Date.now() - (Number(live.startedAt) || 0)));
            bar.append(mascot, label, dots, timer);
            host.appendChild(bar);
            // 走表针（进程中计时）只服务面板：外部宿主的流式条自己刷新，否则面板的
            // ticker 会来清一条它这边根本不存在的 bar
            if (forPanel) ensureProcessTicker();
        }
        if (!forPanel) {
            // 外部宿主自己管滚动：保持原位 or 贴底，不碰面板的 stickBottom / 滚动钮
            host.scrollTop = keepScroll ? prevTop : host.scrollHeight;
            return;
        }
        if (!keepScroll || stickBottom) {
            scrollToBottom(false);
        } else {
            host.scrollTop = prevTop;
        }
        updateContextCount();
        updateScrollButton();
        updateComposerTakeover();
    }

    // 回合分组按 isTurnBoundaryMessage 切轮（判定与列表排序键同源，见 ai-session-store.js）。
    function groupTurns(session, startIndex = 0, endIndex = session.messages.length) {
        const groups = [];
        let current = null;
        for (let i = Math.max(0, startIndex); i < endIndex; i++) {
            const message = session.messages[i];
            if (!current || isTurnBoundaryMessage(message)) {
                const boundary = isTurnBoundaryMessage(message);
                current = {
                    user: boundary ? message : null,
                    startIndex: i,
                    items: [],
                };
                groups.push(current);
                if (boundary) continue;
            }
            current.items.push({message, index: i});
        }
        return groups;
    }

    // 工具消息是否仍在等用户 / 外部事件（审批、回答、后台作业）：
    // 只有这类「组尾是 tool」才真是未完成。工具已执行完的轮次（典型：start_timer
    // 设好后等计时器到点）不该被 processFoldLabel 误标成「未完成」。
    function toolMessageWaiting(message) {
        if (!message || message.role !== 'tool') return false;
        if (message.status === 'pending' || message.status === 'running') return true;
        if (message.approval && message.approval.state === 'pending') return true;
        if (message.agent && message.agent.state === 'running') return true;
        if (message.bg && message.bg.state === 'running') return true;
        return false;
    }

    function turnFinalItem(group, turnRunning) {
        // 组尾是 tool 且仍在流式 / 等审批 / 等回答：本轮确实未完成，最后一条 assistant
        // 的正文与思考必须留在过程时间线里按顺序展示，不能抽出来当「最终回答」排到工具卡后。
        // 工具已执行完则回退找最后的 assistant 作为终项（状态 / 用时），让折叠条显示真实结果。
        const last = group.items[group.items.length - 1];
        if (last && last.message.role === 'tool' && (turnRunning || toolMessageWaiting(last.message))) return null;
        // 回退找最后的 assistant；带工具调用但正文为空的 assistant（工具回合）也算有效终结。
        for (let i = group.items.length - 1; i >= 0; i--) {
            const item = group.items[i];
            if (item.message.kind === 'changes-summary') continue;
            if (item.message.role !== 'assistant') continue;
            const message = item.message;
            const valid = message.status === 'streaming' || message.content || message.status === 'error' ||
                message.status === 'stopped' || message.reasoning || (Array.isArray(message.toolCalls) && message.toolCalls.length);
            return valid ? item : null;
        }
        return null;
    }

    function turnStartMs(group) {
        if (!group.user) return 0;
        return Number(group.user.turnStartedAt) || Number(group.user.ts) || 0;
    }

    function turnDurationMs(group, finalItem, live) {
        if (live && finalItem) return Math.max(0, Date.now() - (Number(live.startedAt) || turnStartMs(group)));
        if (finalItem && finalItem.message.turnMs) return finalItem.message.turnMs;
        return 0;
    }

    function processFoldLabel(group, finalItem, turnRunning, live) {
        const ms = turnRunning && live
            ? Math.max(0, Date.now() - (Number(live.startedAt) || turnStartMs(group)))
            : turnDurationMs(group, finalItem, null);
        const duration = ms ? '，用时 ' + aiFormatDuration(ms) : '';
        if (turnRunning) return '处理中' + duration;
        if (!finalItem) return '未完成' + duration;
        if (finalItem.message.status === 'error') return '已失败' + duration;
        if (finalItem.message.status === 'stopped') return '已停止' + duration;
        return '已完成' + duration;
    }

    function aiThinkKey(message, index) {
        const session = currentSession();
        const ts = Number(message && message.ts) || 0;
        return (session ? session.id : '') + ':' + (ts || (index != null ? 'i' + index : '0'));
    }

    // 思考循环守卫的头部短标签：低阈值只是提示，停止后才占用「思考循环」说法。
    function loopGuardLabel(message) {
        const guard = message && message.guard;
        if (!guard) return '';
        if (guard.state === 'warned') return '重复思考';
        if (guard.state === 'pending') return '重复思考 · 待确认';
        if (guard.state === 'continued') return '重复思考 · 已继续';
        if (guard.state === 'stopped') return '思考循环 · 已停止';
        return '';
    }

    function aiThinkLabel(message, streaming) {
        const guard = loopGuardLabel(message);
        const suffix = guard ? ' · ' + guard : '';
        if (streaming) return '正在思考…' + suffix;
        const chars = String(message && message.reasoning || '').length;
        const ms = Number(message && message.thinkMs) || 0;
        const time = ms > 0 ? (ms < 1000 ? '<1 秒' : Math.max(1, Math.round(ms / 1000)) + ' 秒') : '';
        return '已深度思考' + (time ? ' · ' + time : '') + ' · ' + chars + ' 字' + suffix;
    }

    // 思考体比 .ai-think-body 的 max-height 高时出现内滚动条。默认跟随底部，
    // 这样流式输出时新内容始终在视野里，不用手动往下翻。
    const AI_THINK_BOTTOM_SLACK = 24;

    function aiThinkScrollState(body) {
        let st = thinkScrollFollow.get(body);
        if (!st) {
            st = {pinned: true, expectedTop: 0, bound: false};
            thinkScrollFollow.set(body, st);
        }
        return st;
    }

    function aiThinkAtBottom(body) {
        return body.scrollHeight - body.scrollTop - body.clientHeight <= AI_THINK_BOTTOM_SLACK;
    }

    // 只在滚动位置偏离我们上次写入的值时才改变跟随状态：
    // 否则每次流式重渲染（innerHTML 重建会把 scrollTop 钳回 0）都会被误判成「用户上滑」。
    function bindThinkScroll(body) {
        const st = aiThinkScrollState(body);
        if (st.bound) return;
        st.bound = true;
        body.addEventListener('scroll', () => {
            if (Math.abs(body.scrollTop - st.expectedTop) <= 2) return;
            st.pinned = aiThinkAtBottom(body);
        }, {passive: true});
    }

    function renderThinkBody(body, message, streaming) {
        if (!body) return;
        bindThinkScroll(body);
        const st = aiThinkScrollState(body);
        const text = (message && message.reasoning) || '';
        // 同类防抖：工具参数接收帧里 reasoning 没变，别每 80ms 重写整块思考体
        // （里面的代码块 / 图片 / 打字动画会被反复重建）。签名带 streaming，
        // 轮结束时仍会重渲染一次以补上代码高亮等收尾增强。
        const sig = (streaming ? 's' : 'd') + text.length + ':' + text.slice(-64);
        if (body.dataset.renderSig === sig) return;
        const prevTop = body.scrollTop;
        body.classList.add('ai-md');
        body.innerHTML = renderMarkdown(text);
        // 思考链是弱化的灰色区域：代码块只留代码区，不挂「js + 复制」工具栏（那行比代码本身还跳）
        if (!streaming) enhanceAICodeBlocks(body, {noBar: true});
        resolveAIImages(body);
        // 流式中且仍处于跟随状态 → 贴底；用户上滑过就保留他看的位置。
        if (streaming && st.pinned) body.scrollTop = body.scrollHeight;
        else body.scrollTop = prevTop;
        st.expectedTop = body.scrollTop;
        body.dataset.renderSig = sig;
    }

    // resolveAIImages 把 AI 消息 Markdown 里的本地图片引用换成后端读取的 data URL。
    // 路径规则与 read_file 一致：相对路径按范围根解析；绝对路径仅完全权限；越界/失败显示占位说明。
    function resolveAIImages(scopeEl) {
        if (!scopeEl) return;
        for (const img of scopeEl.querySelectorAll('img')) {
            if (img.dataset.aiZoomable !== '1') {
                img.dataset.aiZoomable = '1';
                img.addEventListener('click', () => openMarkdownImage(img));
            }
            if (!backend.ReadImageAsDataURL) continue;
            // data-ai-src 由 markdown-it 图片渲染钩子写入（本地路径可能被 DOMPurify 从 src 删掉）
            const raw = img.getAttribute('data-ai-src') || img.getAttribute('src') || '';
            if (!raw || img.dataset.aiResolved === '1') continue;
            if (/^(https?:|data:|blob:)/i.test(raw)) continue;
            img.dataset.aiResolved = '1';
            let abs;
            try {
                abs = aiResolveScopePath(raw, currentSession());
            } catch (e) {
                // 越界图片：已批准读根（会话/父会话/全局）则放行展示；渲染时机没有轮次上下文，
                // 不弹审批。敏感目录判定只在读取链路（resolveReadPathWithApproval）做——这里
                // 同步拿不到 appDir，且展示放行不产生读取面，不对称可接受。
                const session = currentSession();
                const parent = session && session.parentSessionId ? sessionById(session.parentSessionId) : null;
                const covered = e && e.outOfWorkspace &&
                    (readRootCoversAny(readRootsOf(session), raw) ||
                        (parent ? readRootCoversAny(readRootsOf(parent), raw) : false) ||
                        readRootCoversAny(config.approvedReadRoots, raw));
                if (!covered) {
                    img.classList.add('ai-img-broken');
                    img.dataset.tip = '图片无法加载：' + ((e && e.message) || e);
                    continue;
                }
                abs = aiNormalizePath(raw);
            }
            backend.ReadImageAsDataURL(abs).then((url) => {
                if (url) {
                    img.src = url;
                    img.dataset.aiLocalName = String(abs).split(/[\\/]/).pop() || '';
                } else {
                    img.classList.add('ai-img-broken');
                    img.dataset.tip = '图片无法加载（格式不支持或超过 30MB）：' + abs;
                }
            }).catch((e) => {
                img.classList.add('ai-img-broken');
                img.dataset.tip = '图片无法加载：' + abs + ((e && e.message) ? '（' + e.message + '）' : '');
            });
        }
    }

    // ---------- 文件引用链接 ----------
    // enhanceAIFileRefs 把 AI 回复 inline code 里的文件引用升级成可点击的文件链接：
    // 形状判定（parseFileRef，纯函数）→ 解析绝对路径（裸文件名先按已开标签页匹配，
    // 其余走 aiResolveScopePath 工作区相对解析）→ GetPathInfo 校验真实存在（不存在的
    // 保持普通 code，零误伤）→ 点击 openTargets 在编辑器打开并跳行。
    // stat 结果按绝对路径缓存：流式期间每帧重渲染会重建 code 节点，缓存避免同一路径反复 stat。
    const aiRefStatCache = new Map();

    function markFileRefChip(code, abs, ref, ok) {
        if (!ok) {
            code.dataset.aiRefState = 'none';
            return;
        }
        // 上 class / dataset 交给 ai-file-refs（那里刻意不检查 isConnected：重放渲染时
        // 节点还没 append，缓存命中又是同步调用，检查就会把引用永久退化成普通 code）
        applyFileRefChip(code, abs, ref);
    }

    function enhanceAIFileRefs(scopeEl) {
        if (!scopeEl) return;
        for (const code of scopeEl.querySelectorAll('code')) {
            if (code.closest('pre')) continue; // 围栏代码块不做文件引用
            if (code.dataset.aiRefState) continue;
            const ref = parseFileRef(code.textContent);
            if (!ref) continue;
            code.dataset.aiRefState = 'pending';
            let abs = pickOpenFileMatch(ref, (getWorkspaceContext() || {}).openFiles);
            if (!abs) {
                try {
                    abs = aiResolveScopePath(ref.path, currentSession());
                } catch (e) {
                    code.dataset.aiRefState = 'none';
                    continue;
                }
            }
            const cached = aiRefStatCache.get(abs);
            if (cached !== undefined) {
                markFileRefChip(code, abs, ref, cached);
                continue;
            }
            if (!backend.GetPathInfo) {
                code.dataset.aiRefState = 'none';
                continue;
            }
            Promise.resolve(backend.GetPathInfo(abs)).then((info) => {
                const ok = !!(info && !info.isDir);
                if (aiRefStatCache.size > 512) aiRefStatCache.clear();
                aiRefStatCache.set(abs, ok);
                markFileRefChip(code, abs, ref, ok);
            }).catch(() => {
                // 尽力而为：stat 失败（不存在/越界/虚拟文档）保持普通 code 样式
                if (aiRefStatCache.size > 512) aiRefStatCache.clear();
                aiRefStatCache.set(abs, false);
                code.dataset.aiRefState = 'none';
            });
        }
    }

    function toggleThink(think) {
        if (!think) return;
        const collapsed = !think.classList.contains('collapsed');
        think.classList.toggle('collapsed', collapsed);
        const key = think.dataset.thinkKey;
        if (key) thinkFoldState.set(key, collapsed);
        // 流式展开：回到最新内容并恢复跟随；已结束的展开保持从头看。
        if (!collapsed && think.classList.contains('thinking')) {
            const body = think.querySelector('.ai-think-body');
            if (body) {
                const st = aiThinkScrollState(body);
                st.pinned = true;
                body.scrollTop = body.scrollHeight;
                st.expectedTop = body.scrollTop;
            }
        }
    }

    function renderProcessThinking(message, index) {
        const think = document.createElement('div');
        think.className = 'ai-think';
        const key = aiThinkKey(message, index);
        think.dataset.thinkKey = key;
        if (thinkFoldState.get(key) === true) think.classList.add('collapsed');
        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'ai-think-head';
        const chev = document.createElement('span');
        chev.className = 'ai-think-chev';
        chev.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        const label = document.createElement('span');
        label.className = 'ai-think-label';
        label.textContent = aiThinkLabel(message, false);
        label.classList.toggle('ai-think-guard', !!loopGuardLabel(message));
        head.append(chev, label);
        head.addEventListener('click', () => toggleThink(think));
        const body = document.createElement('div');
        body.className = 'ai-think-body';
        renderThinkBody(body, message, false);
        think.append(head, body);
        return think;
    }

    function renderTurn(group, session, isLastGroup, parent, extraOptions) {
        const host = parent || msgHost();
        const turnOptions = extraOptions || {};
        const live = streamOf(session.id);
        const turnRunning = !!(live && isLastGroup);
        const finalItem = turnFinalItem(group, turnRunning);
        // 本轮文件改动汇总卡固定在轮次末尾（final answer 之后），不进过程折叠区。
        // 取组内最后一张汇总卡，而不是只认「组内最后一项」——重放的历史数据里
        // 卡片后面可能还跟着收尾消息，硬绑最后一项会让卡片在重开对话后消失。
        let summaryItem = null;
        for (let i = group.items.length - 1; i >= 0; i--) {
            if (group.items[i].message.kind === 'changes-summary') {
                summaryItem = group.items[i];
                break;
            }
        }
        const processAll = (finalItem ? group.items.filter((item) => item !== finalItem) : group.items.slice())
            .filter((item) => item.message.kind !== 'changes-summary');
        const streamingFinal = turnRunning && finalItem && live.assistant === finalItem.message;
        // 最终回答是否有正文可展示（流式/出错/停止都算；纯工具调用的 done 不算）。
        const finalHasBody = !!(finalItem && (finalItem.message.content || finalItem.message.status !== 'done'));
        // 最终回答的思考链平时挂在「最后一个 items 段」的折叠体里；轮次进行中若最终回答本身
        // 不渲染（纯工具调用、等待终端执行/审批），也必须挂过去，否则思考链会在工具执行期间消失。
        const finalReasoning = !!(finalItem && finalItem.message.reasoning && settings.aiShowThinking !== false &&
            (!turnRunning || !finalHasBody));
        const duration = turnRunning && live
            ? Math.max(0, Date.now() - (Number(live.startedAt) || turnStartMs(group)))
            : turnDurationMs(group, finalItem, false);
        // 按「已回答的提问卡」把过程内容切成多段：提问卡按时间序插在段之间。
        // 分段只是为了守住时间序，**折叠状态与折叠头都是轮级唯一的**——否则同一轮会出
        // 多条「已完成 · 用时 X」的过程条，看起来像好几轮（提问卡是折叠区外的整卡，
        // 它只把 body 隔开，不该切出第二个开关）。
        const segments = [];
        {
            let cur = [];
            for (const item of processAll) {
                if (item.message.ask && item.message.ask.state !== 'pending') {
                    if (cur.length) {
                        segments.push({items: cur});
                        cur = [];
                    }
                    segments.push({ask: item});
                } else {
                    cur.push(item);
                }
            }
            if (cur.length) segments.push({items: cur});
        }
        if (!segments.length) segments.push({items: []});
        // 注入卡（计时器到点 / 定时任务 / 会话投递）本身就是本轮轮首 user 消息，直接渲染全宽卡。
        // 不要再做「整轮外壳 + 过程开关」：外壳会把用户自己的消息一起折叠，且与内部过程条
        // 形成两级折叠（2026-11-16 实测后回滚，方案见 docs/unfinished-plans/turn-fold-redesign.md）。
        if (group.user) renderMessage(group.user, group.startIndex, session, host, turnOptions);
        // 完成后默认收起；但最终回答没有正文时（如工具轮收尾、以工具调用结束），
        // 过程行是唯一信息载体，默认展开以免「全部折叠」看起来没有任何输出。
        // 最终回答的思考链跟随「最后一个 items 段」的折叠体（与完成后收起的设计一致）；
        // 尾部是提问卡时同样挂在它前面的末段，不额外暴露在折叠区外。
        const lastItemsIndex = segments.reduce((acc, seg, idx) => (seg.ask ? acc : idx), -1);
        // 折叠状态的 key 只到轮：段号不进 key，否则每段一个开关、一轮被切成好几条。
        const turnFoldKey = session.id + ':' + (group.user ? 'u' + group.user.ts : 'g' + group.startIndex);
        // 段是否有可展示内容（仅末段可能只挂最终回答的思考链）。
        const segHasBody = (seg, segIndex) => seg.items.length > 0 ||
            (segIndex === lastItemsIndex && !!finalReasoning);
        // 只有「收尾但无正文、也无可展开内容」的那一条退化过程条才允许空 body。
        const segRenderable = (seg, segIndex) => segHasBody(seg, segIndex) ||
            (segments.length === 1 && !!finalItem && !!duration);
        // 折叠头只出一次：落在第一个真正渲染出来的 items 段上（前面的空段会被跳过）。
        const foldHeadIndex = segments.findIndex((seg, idx) => !seg.ask && segRenderable(seg, idx));
        // 展开/收起时要把同一轮所有段的 body 建起来（每段的 ensureBody 是各自闭包）。
        const segEnsureBody = [];
        segments.forEach((seg, segIndex) => {
            if (seg.ask) {
                // 已答提问卡按时间序插在过程段之间，始终整卡渲染（不参与任何折叠）：
                // 问答记录是用户自己的答复凭据，收起来就等于「没问过」。
                renderMessage(seg.ask.message, seg.ask.index, session, host, turnOptions);
                return;
            }
            const processItems = seg.items;
            const segReasoning = segIndex === lastItemsIndex && !!finalReasoning;
            const hasBody = segHasBody(seg, segIndex);
            if (!segRenderable(seg, segIndex)) return;
            const key = turnFoldKey;
            const isFoldHead = segIndex === foldHeadIndex;
            const fold = document.createElement('div');
            // 只有首个段带折叠头；其余段只是「无头的 body 容器」，与首段共享同一个开合状态，
            // 视觉上仍是一条折叠流被提问卡隔开（不再逐段吐一条「已完成 · 用时」）。
            fold.className = 'ai-process' + (turnRunning ? ' streaming' : '') + (isFoldHead ? '' : ' cont');
            fold.dataset.processKey = key;
            if (turnRunning) fold.dataset.processStart = String(Number(live.startedAt) || turnStartMs(group));
            // 轮次已结束：丢掉「处理中点过折叠条」留下的记忆，回到完成后默认值。
            if (!turnRunning && processFoldTouched.has(key)) {
                processFoldTouched.delete(key);
                processFoldState.delete(key);
            }
            const expanded = turnRunning
                ? (processFoldState.has(key) ? processFoldState.get(key) : true)
                : (processFoldState.has(key) ? processFoldState.get(key) : !finalHasBody);
            fold.classList.toggle('collapsed', !expanded);
            let body = null;
            const ensureBody = () => {
                if (body) return body;
                body = document.createElement('div');
                body.className = 'ai-process-body';
                for (const item of processItems) {
                    // 过程折叠展开时，中间轮次的思考链也一并展开（与最终回答的思考链保持一致）。
                    renderMessage(item.message, item.index, session, body, Object.assign({}, turnOptions,
                        item.message.role === 'assistant' ? {expandThinking: true} : null));
                }
                if (segReasoning) {
                    body.appendChild(renderProcessThinking(finalItem.message, finalItem.index));
                }
                fold.appendChild(body);
                return body;
            };
            segEnsureBody.push(ensureBody);
            if (isFoldHead) {
                const head = document.createElement('button');
                head.type = 'button';
                head.className = 'ai-process-head';
                head.disabled = !hasBody;
                const chev = document.createElement('span');
                chev.className = 'ai-process-chev';
                chev.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
                if (!hasBody) chev.style.visibility = 'hidden';
                const label = document.createElement('span');
                label.className = 'ai-process-label';
                // 流式时计时器在底部状态条（.ai-streaming-bar），fold 头只显示状态文本
                label.textContent = turnRunning ? '处理中' : processFoldLabel(group, finalItem, turnRunning, live);
                head.append(chev, label);
                head.addEventListener('click', () => {
                    if (!hasBody) return;
                    const next = fold.classList.contains('collapsed');
                    processFoldState.set(key, next);
                    // 轮次还在跑时记下「用户手动碰过」，等轮次结束后丢弃这条记忆。
                    if (turnRunning) processFoldTouched.add(key);
                    else processFoldTouched.delete(key);
                    // 同一轮被提问卡隔开的所有段落一起开合：只有一条折叠条，不能各段不同步。
                    // next = true 表示即将展开——先把各段懒建的 body 补齐，再统一撤掉 collapsed。
                    if (next) segEnsureBody.forEach((fn) => fn());
                    for (const node of host.querySelectorAll('.ai-process')) {
                        if (node.dataset.processKey === key) node.classList.toggle('collapsed', !next);
                    }
                });
                fold.appendChild(head);
            }
            if (expanded && hasBody) ensureBody();
            host.appendChild(fold);
        });
        if (finalItem) {
            const showFinal = finalHasBody;
            if (showFinal) renderMessage(finalItem.message, finalItem.index, session, host,
                Object.assign({}, turnOptions, {hideThinking: !streamingFinal}));
        }
        if (summaryItem && (!turnRunning || !live || live.assistant !== summaryItem.message)) {
            host.appendChild(changesSummaryBlock(summaryItem.message, session));
        }
    }


    // 看板娘文案池与轮换索引见 ai-mascot-phrases.js（纯逻辑 + 单测护栏），此处只做接线。

    // 当前流的工作阶段：等待审批/回答 > 工具执行 > 思考 > 作答 > 往返等待
    function streamPhaseOf(sessionId, live) {
        const pendingHere = (map) => {
            for (const entry of map.values()) {
                if (entry && entry.session && entry.session.id === sessionId) return true;
            }
            return false;
        };
        if (pendingHere(pendingApprovals)) return 'approval';
        if (pendingHere(pendingAsks)) return 'ask';
        if (pendingHere(pendingEnvCreations)) return 'env';
        if (live.toolCalls && live.toolCalls.size > 0) return 'tool';
        const session = sessionById(sessionId);
        const last = session && session.messages.length ? session.messages[session.messages.length - 1] : null;
        if (last && last.role === 'tool') return 'tool';
        if (live.assistant && live.assistant.content) return 'talk';
        return live.thinkStartedAt ? 'think' : 'wait';
    }

    // 按 phase 选池刷新状态条文案：phase 只决定用哪组，时间与偏移基准在整条流式内不动，
    // 换阶段不清零 → 索引随 8 秒 tick 连续漂移；开场随机偏移 → 每次开场第一条都不同。
    function refreshStreamingPhrase(bar) {
        const label = bar.querySelector('.ai-streaming-label');
        if (!label) return;
        const session = currentSession();
        const live = session ? streamOf(session.id) : null;
        if (!live) return;
        const phase = streamPhaseOf(session.id, live);
        const now = Date.now();
        // 兜底：基准/偏移缺失时补一次（正常路径在状态条创建时已定）。
        if (bar.dataset.phraseBaseAt === undefined) {
            bar.dataset.phraseBaseAt = String(now);
            bar.dataset.phraseSalt = String(randomMascotSalt(phrasesForPhase(phase).length));
        }
        bar.dataset.phase = phase;
        const baseAt = Number(bar.dataset.phraseBaseAt) || now;
        const salt = Number(bar.dataset.phraseSalt) || 0;
        const phrases = phrasesForPhase(phase);
        const text = personaText(phrases[mascotPhraseIndex(now - baseAt, salt, phrases.length)]);
        if (label.textContent !== text) label.textContent = text;
    }

    function ensureProcessTicker() {
        if (processTicker || !anyStreaming()) return;
        processTicker = setInterval(() => {
            if (!anyStreaming() || !isOpen()) {
                stopProcessTicker();
                return;
            }
            for (const bar of el.messages.querySelectorAll('.ai-streaming-bar')) {
                const timer = bar.querySelector('.ai-process-timer');
                const start = Number(bar.dataset.processStart) || 0;
                if (timer && start) timer.textContent = aiFormatLiveDuration(Date.now() - start);
                tickRetryNote(bar);
                refreshStreamingPhrase(bar);
            }
        }, 100);
    }

    function stopProcessTicker() {
        if (!processTicker) return;
        clearInterval(processTicker);
        processTicker = 0;
    }

    // 图片预览：复制到剪贴板 / 另存为；右键图片也弹同一组操作
    let imagePreviewMenu = null;

    async function copyPreviewImage(image) {
        const ok = await copyImageUrlToClipboard(aiImageSrc(image));
        flash(ok ? '已复制图片' : '剪贴板不支持图片', !ok);
        return ok;
    }

    async function savePreviewImage(image) {
        if (!backend.SaveFileDialog || !backend.SaveDataURL) {
            flash('当前版本不支持保存图片', true);
            return;
        }
        const src = aiImageSrc(image);
        if (!src) return;
        const name = aiSafeFileStem(image.name || '图片') + '.' + aiImageExt(image.mime);
        let dest = '';
        try {
            dest = await backend.SaveFileDialog(name);
        } catch (e) {
            return;
        }
        if (!dest) return;
        try {
            await backend.SaveDataURL(dest, src);
            flash('已保存图片：' + String(dest).replace(/^.*[\\/]/, ''));
        } catch (e) {
            flash('保存图片失败：' + ((e && e.message) || e), true);
        }
    }

    function showImagePreviewMenu(image, x, y) {
        if (!image || !image.data) return;
        if (!imagePreviewMenu) imagePreviewMenu = createContextMenu();
        imagePreviewMenu.open([
            {label: '复制图片', icon: 'copy', action: () => { copyPreviewImage(image); }},
            {label: '另存为…', icon: 'save', action: () => { savePreviewImage(image); }},
        ], x, y);
    }

    function showImagePreview(image) {
        if (!image || !image.data) return;
        const img = document.createElement('img');
        img.className = 'ai-image-preview';
        img.src = aiImageSrc(image);
        img.alt = image.name || '图片';
        img.addEventListener('click', () => showImageFullscreen(image));
        img.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showImagePreviewMenu(image, e.clientX, e.clientY);
        });
        openAIDialog('图片预览 · ' + (image.name || '图片'), [img], [
            dialogButton('复制', 'dlg-btn', () => { copyPreviewImage(image); }),
            dialogButton('关闭', 'dlg-btn primary', closeAIDialog),
        ]);
    }

    // 面板内全屏看图：查看层铺满图片所在容器（AI 面板 / 子代理详情标签页），不覆盖窗口其他区域。
    // 每个宿主只建一个实例——查看层挂了 window 级 Esc/resize 监听且不会解绑，重复创建会泄漏。
    const hostLightboxes = new WeakMap();

    function lightboxForHost(host) {
        let box = hostLightboxes.get(host);
        if (!box) {
            box = createImageLightbox(host, {
                onContextMenu: (target, x, y) => showImagePreviewMenu(target, x, y),
            });
            hostLightboxes.set(host, box);
        }
        return box;
    }

    function closeHostLightbox(host) {
        const box = hostLightboxes.get(host);
        if (box) box.close();
    }

    function showImageFullscreen(image) {
        if (!image || !image.data) return;
        lightboxForHost(panel).open(image, aiImageSrc(image), (image.name || '图片') +
            (image.width && image.height ? ' · ' + image.width + '×' + image.height : ''));
    }

    // 正文 Markdown 图片限高展示，点击进查看层看原图；本地图片仍可右键复制 / 另存为。
    function openMarkdownImage(img) {
        const src = img.src || '';
        if (!src || img.classList.contains('ai-img-broken')) return;
        const image = aiImageFromSrc(src, img.dataset.aiLocalName || img.alt);
        const size = img.naturalWidth && img.naturalHeight ? ' · ' + img.naturalWidth + '×' + img.naturalHeight : '';
        lightboxForHost(img.closest('.agentview-pane') || panel)
            .open(image, src, ((image && image.name) || '图片') + size);
    }

    function buildImageStrip(images, stripClass, imgClass) {
        if (!Array.isArray(images) || !images.length) return null;
        const strip = document.createElement('div');
        strip.className = stripClass;
        for (const image of images) {
            if (!image.data) {
                if (!image.logFile) continue;
                const missing = document.createElement('div');
                missing.className = 'ai-user-image-missing';
                missing.textContent = '图片已归档';
                strip.appendChild(missing);
                continue;
            }
            const img = document.createElement('img');
            img.className = imgClass;
            img.src = aiImageSrc(image);
            img.alt = image.name || '图片';
            img.loading = 'lazy';
            img.addEventListener('click', () => showImagePreview(image));
            strip.appendChild(img);
        }
        return strip.childNodes.length ? strip : null;
    }

    function appendUserImages(wrap, images) {
        const strip = buildImageStrip(images, 'ai-user-images', 'ai-user-image');
        if (strip) wrap.appendChild(strip);
    }

    // 视频附件只渲染文件名 chip：不做 <video> 预览（16 MB 级 blob 进 DOM 得不偿失，
    // 且气泡里自动播放没有任何安全边界）。
    function appendUserVideos(wrap, videos) {
        for (const video of videos || []) {
            if (!video) continue;
            const chip = document.createElement('div');
            chip.className = 'ai-user-video';
            const label = document.createElement('span');
            label.className = 'ai-user-video-name';
            label.textContent = (video.name || '视频') + ' · ' + video.mime;
            chip.appendChild(label);
            wrap.appendChild(chip);
        }
    }

    // 对话内模型切换记录：分隔线 + 文案 + 信息图标（悬停看账号 / 推理等级 / 时间）。
    function renderModelSwitchNote(wrap, message) {
        const note = message.modelNote && typeof message.modelNote === 'object' ? message.modelNote : {};
        const row = document.createElement('div');
        row.className = 'ai-model-switch';
        const text = document.createElement('span');
        text.className = 'ai-model-switch-text';
        text.textContent = message.content || '模型已切换';
        const info = document.createElement('span');
        info.className = 'ai-model-switch-info';
        info.innerHTML = iconSvg('info', 12);
        info.setAttribute('aria-label', '模型切换信息');
        row.append(text, info);
        wrap.appendChild(row);
    }

    // 回复头「AI 模型 时间」信息行的稀疏显示判定（默认关）：只在**轮次开头**（上一条
    // 非工具消息不是 AI 回复——用户消息 / 系统注记等）与**模型切换**时显示；连续工具轮
    // 的中间回复全部隐藏，时间跳变不算节点（连续对话隔几分钟很正常）。设置
    // 「每条回复都显示 AI 信息行」开启后恢复全显。
    function shouldShowTurnMeta(session, index, message) {
        if (settings.aiShowEveryTurnMeta === true) return true;
        const messages = (session && session.messages) || [];
        for (let i = index - 1; i >= 0; i -= 1) {
            const prev = messages[i];
            if (!prev || prev.role === 'tool') continue;
            if (prev.role !== 'assistant') return true;
            return aiTextOf(prev.model) !== aiTextOf(message.model);
        }
        return true;
    }

    function renderMessage(message, index, session, parent, options) {
        const wrap = document.createElement('div');
        wrap.className = 'ai-msg ' + message.role;
        // silent 机械提醒（给模型的注入块）：保留 DOM 与索引（buildApiMessages / 定位都用），
        // 视觉隐藏——用户不需要看模型上下文的内部维护信息
        if (message.silent) wrap.classList.add('msg-silent');
        // 归档回看：索引指向的是「当前 messages」，直接复用会让复制/编辑重发/重新生成
        // 打到错误的条目。标记只读并清掉索引，appendActions 会据此跳过全部操作按钮。
        const archivedView = !!(options && options.archived);
        if (archivedView) {
            wrap.classList.add('archived');
            wrap.dataset.aiArchived = '1';
        } else {
            wrap.dataset.aiIdx = String(index);
        }
        // 文件改动汇总卡：任何渲染路径（正常轮尾 / 防御性兜底）都按卡片呈现
        if (message.role === 'assistant' && message.kind === 'changes-summary') {
            wrap.appendChild(renderChangesSummaryCard(message, session));
            return wrap;
        }
        if (message.role === 'tool') {
            renderToolMessage(wrap, message, options);
        } else if (message.role === 'assistant') {
            if (message.status === 'error') wrap.classList.add('error');
            if (message.status === 'streaming') wrap.classList.add('streaming');
            // 回复头「AI 模型 时间」信息行稀疏显示（默认关）：连续工具轮的中间回复隐藏，
            // 只在轮次开头与模型切换时出现；设置「每条回复都显示 AI 信息行」恢复全显
            const sparseMeta = !shouldShowTurnMeta(session, index, message);
            if (!sparseMeta) {
                const meta = document.createElement('div');
                meta.className = 'ai-msg-meta';
                wrap.appendChild(meta);
            }
            // 连续工具轮的空回复（无正文无思考、非流式非错误）整条压没——信息行没了但
            // 空 wrap 还占一格 gap，视觉上「不显示了还隔这么远」；display:none 后只剩
            // 工具卡之间的标准间距。流式期间正常渲染（内容到达即显示）。
            if (sparseMeta && message.status !== 'streaming' && message.status !== 'error'
                && !aiTextOf(message.content) && !aiTextOf(message.reasoning)) {
                wrap.classList.add('turn-blank');
            }
            const bubble = document.createElement('div');
            bubble.className = 'ai-bubble';
            const md = document.createElement('div');
            md.className = 'ai-md';
            bubble.appendChild(md);
            wrap.appendChild(bubble);
            updateAssistantElement(wrap, message, message.status === 'streaming', options);
        } else if (message.kind === 'model-switch') {
            wrap.classList.add('model-switch');
            renderModelSwitchNote(wrap, message);
        } else if (message.app) {
            renderAppMessage(wrap, message, index, session);
        } else {
            const bubble = document.createElement('div');
            bubble.className = 'ai-user-bubble' + (message.systemNote ? ' system-note' : '');
            appendUserImages(bubble, message.images);
            appendUserVideos(bubble, message.videos);
            // 引用块拆出来单独渲染：截断成单行摘要，title 悬浮看全文；消息正文只显示追问本身
            const parsedQuote = splitQuotePrefix(message.content || '');
            if (parsedQuote.quotes.length) {
                const quoteBox = document.createElement('div');
                quoteBox.className = 'ai-user-quote';
                for (const quote of parsedQuote.quotes) {
                    const row = document.createElement('div');
                    row.className = 'ai-user-quote-row';
                    const quoteLabelEl = document.createElement('span');
                    quoteLabelEl.className = 'ai-user-quote-label';
                    quoteLabelEl.textContent = quoteLabel(quote);
                    const excerpt = document.createElement('span');
                    excerpt.className = 'ai-user-quote-excerpt';
                    excerpt.textContent = quoteExcerpt(quote.text);
                    excerpt.dataset.tip = quote.text;
                    row.append(quoteLabelEl, excerpt);
                    quoteBox.appendChild(row);
                }
                bubble.appendChild(quoteBox);
            }
            const shownText = parsedQuote.quotes.length ? parsedQuote.body : (message.content || '');
            if (shownText) {
                const text = document.createElement('div');
                text.className = 'ai-user-text';
                text.textContent = shownText;
                bubble.appendChild(text);
                // 超长消息默认折叠：只露出开头一段 + 渐隐，点「展开全文」看完整内容
                //（展开后全文可选中复制）；手动展开/收起按消息 key 记住，重渲染不弹回。
                if (isLongUserMessage(shownText)) {
                    const foldKey = (session ? session.id : '') + ':' + (Number(message.ts) || 0) + ':' + shownText.length;
                    text.classList.add('foldable');
                    text.classList.toggle('folded', !userFoldExpanded.has(foldKey));
                    const toggle = document.createElement('button');
                    toggle.type = 'button';
                    toggle.className = 'ai-user-fold-btn';
                    const syncToggle = () => {
                        const folded = text.classList.contains('folded');
                        toggle.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" style="transform:rotate(' + (folded ? '0' : '180') + 'deg)"><path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg><span>' + (folded ? '展开全文' : '收起') + '</span>';
                    };
                    syncToggle();
                    toggle.addEventListener('click', () => {
                        const nextFolded = text.classList.contains('folded');
                        if (nextFolded) userFoldExpanded.add(foldKey);
                        else userFoldExpanded.delete(foldKey);
                        text.classList.toggle('folded', !nextFolded);
                        syncToggle();
                    });
                    bubble.appendChild(toggle);
                }
            }
            wrap.appendChild(bubble);
            // 时间和操作仿 dsh：平时隐藏，hover 用户消息时显示在胶囊下方。
            const foot = document.createElement('div');
            foot.className = 'ai-user-foot';
            const meta = document.createElement('div');
            meta.className = 'ai-msg-meta';
            meta.textContent = aiFormatTime(message.ts);
            foot.appendChild(meta);
            wrap.appendChild(foot);
            appendActions(wrap, message, index, session, foot);
        }
        (parent || msgHost()).appendChild(wrap);
    }

    // 应用注入的消息（Git 快捷操作 / 定时任务）：全宽卡片 + 来源标识，不用用户胶囊；
    // 指令全文默认收起，点「查看指令」展开。
    function appMessageKey(message, index, session) {
        return (session ? session.id : '') + ':' + index + ':' + (Number(message.ts) || 0);
    }

    function renderAppMessage(wrap, message, index, session) {
        wrap.classList.add('ai-app-msg');
        const app = message.app || {};
        const card = document.createElement('div');
        card.className = 'ai-app-msg-card';

        const head = document.createElement('div');
        head.className = 'ai-app-msg-head';
        const icon = document.createElement('span');
        icon.className = 'ai-app-msg-icon';
        icon.innerHTML = iconSvg(appMessageIcon(app), 12);
        const label = document.createElement('span');
        label.className = 'ai-app-msg-label';
        label.textContent = app.label || '应用消息';
        const tag = document.createElement('span');
        tag.className = 'ai-app-msg-tag';
        tag.textContent = '应用消息';
        const time = document.createElement('span');
        time.className = 'ai-app-msg-time';
        time.textContent = aiFormatTime(message.ts);
        head.append(icon, label, tag, time);
        card.appendChild(head);

        // 带图片的应用消息（浏览器截图）：直接铺图片，不显示「查看指令」折叠区
        const images = Array.isArray(message.images) ? message.images : [];
        const videos = Array.isArray(message.videos) ? message.videos : [];
        if (videos.length) {
            appendUserVideos(card, videos);
            const hint = document.createElement('div');
            hint.className = 'ai-app-msg-hint';
            hint.textContent = '视频已自动附加到对话，模型可直接查看';
            card.appendChild(hint);
        }
        if (images.length) {
            const strip = buildImageStrip(images, 'ai-app-msg-images', 'ai-app-msg-image');
            if (strip) {
                card.appendChild(strip);
                const hint = document.createElement('div');
                hint.className = 'ai-app-msg-hint';
                hint.textContent = app.kind === 'browser'
                    ? '由浏览器工具截图后自动附加，模型可直接查看'
                    : (app.kind === 'app'
                        ? '应用窗口截图，已自动附加到对话'
                        // 其它带图应用消息（read_image）用正文做页脚，去掉注入用的方括号
                        : String(message.content || '').trim().replace(/^\[|\]$/g, ''));
                card.appendChild(hint);
                wrap.appendChild(card);
                return;
            }
        }

        const key = appMessageKey(message, index, session);
        const expanded = appMsgExpanded.has(key);

        const foot = document.createElement('div');
        foot.className = 'ai-app-msg-foot';
        const hint = document.createElement('span');
        hint.className = 'ai-app-msg-hint';
        // 会话投递两种身份在接收方语义相反：模型投递只是参考，用户投递是用户指令
        hint.textContent = app.kind === 'session'
            ? '由应用自动注入 · 其他会话的模型消息，仅供参考'
            : (app.kind === 'session-user'
                ? '由应用自动注入 · 你发出的消息，AI 按这条指令执行'
                : (app.kind === 'plan'
                    // 计划批准是应用代按「执行计划」，不是用户手打的指令
                    ? '由应用自动注入 · 计划已批准，AI 按上面的计划开始执行'
                    : '由应用自动注入，AI 按这条指令执行'));
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'ai-app-msg-toggle' + (expanded ? ' expanded' : '');
        const chev = document.createElement('span');
        chev.className = 'ai-app-msg-chev';
        chev.innerHTML = iconSvg('chevron-down', 11);
        const toggleText = document.createElement('span');
        toggleText.textContent = expanded ? '收起指令' : '查看指令';
        toggle.append(chev, toggleText);
        foot.append(hint, toggle);

        const body = document.createElement('div');
        body.className = 'ai-app-msg-body' + (expanded ? '' : ' hidden');
        const pre = document.createElement('pre');
        pre.className = 'ai-app-msg-text';
        pre.textContent = message.content || '';
        body.appendChild(pre);

        toggle.addEventListener('click', () => {
            const next = !appMsgExpanded.has(key);
            if (next) appMsgExpanded.add(key);
            else appMsgExpanded.delete(key);
            body.classList.toggle('hidden', !next);
            toggle.classList.toggle('expanded', next);
            toggleText.textContent = next ? '收起指令' : '查看指令';
        });

        card.append(foot, body);
        wrap.appendChild(card);
    }

    function toolArgsSummary(value) {
        const text = aiTextOf(value);
        if (!text) return '';
        try {
            const parsed = JSON.parse(text);
            return JSON.stringify(parsed).slice(0, 120);
        } catch (e) {
            return text.replace(/\s+/g, ' ').slice(0, 120);
        }
    }

    function toolStateText(message) {
        if (message.name === 'spawn_agent' && message.agent) {
            if (message.agent.state === 'running') return '运行中…';
            if (message.agent.state === 'stopped') return '已停止';
            if (message.agent.state === 'error') return '失败';
            if (message.agent.state === 'done') return '完成';
        }
        if (message.name === 'background_command' && message.bg) {
            if (message.bg.state === 'running') return '后台运行中…';
            if (message.bg.state === 'stopped') return '已停止（退出码 ' + message.bg.code + '）';
            if (message.bg.state === 'exited') return '已结束（退出码 ' + message.bg.code + '）';
        }
        const approval = message.approval;
        if (approval) {
            const command = approval.kind === 'command';
            if (approval.state === 'pending') return '等待审批…';
            if (approval.state === 'approved') {
                if (message.interrupted) return '已停止';
                if (message.status === 'running') return command ? '执行中…' : '应用中…';
                return command ? '已执行' : '已应用';
            }
            if (approval.state === 'denied') return '已放弃';
            if (approval.state === 'cancelled') return '已取消';
            if (approval.state === 'failed') return command ? '执行失败' : '应用失败';
        }
        if (message.status === 'pending') return '等待审批…';
        if (message.status === 'running') return '执行中…';
        if (message.interrupted) return '中断';
        return message.status === 'error' ? '失败' : '完成';
    }

    // renderPendingApprovalPlaceholder 待审批时消息流只留占位：
    // 完整 diff 与「放弃 / 应用」在 composer 接管区（renderApprovalTakeover），
    // 避免长 diff 把消息流撑高、按钮被推到底部视野外。
    function renderPendingApprovalPlaceholder(container, approval) {
        const hint = document.createElement('div');
        hint.className = 'ai-approval-placeholder';
        const isCommand = approval.kind === 'command';
        const dot = document.createElement('span');
        dot.className = 'ai-approval-placeholder-dot';
        const text = document.createElement('span');
        text.className = 'ai-approval-placeholder-text';
        text.textContent = isCommand
            ? '命令待审批，请在下方输入区确认执行'
            : '更改待审批，请在下方输入区确认应用';
        hint.append(dot, text);
        container.appendChild(hint);
    }

    const APPROVAL_SOURCE_LABELS = {
        readonly: '只读命令',
        family: '已知命令族',
        classifier: 'AI 分类器',
        session: '本会话授权',
        project: '项目规则',
        full: '完全权限',
    };

    function approvalTraceNote(approval) {
        if (!approval) return '';
        if (approval.actor === 'auto') {
            const label = APPROVAL_SOURCE_LABELS[approval.autoRule] || '';
            return label ? '（自动放行：' + label + '）' : '（自动放行）';
        }
        if (approval.actor === 'user') {
            if (approval.remember === 'family') return '（你已批准；本会话同类命令已记住）';
            if (approval.remember === 'session' || approval.remember === 'project' || approval.remember === 'always') {
                return '（你已批准；已记住本次授权）';
            }
            return '（你已批准）';
        }
        return '';
    }


    function appendActions(wrap, message, index, session, target) {
        // 归档消息只读：没有可信的 messages 索引，任何操作都会指错条目。
        if (wrap && wrap.dataset.aiArchived === '1') return;
        // 系统注记（工具轮次提醒 / 模型切换记录）不是用户输入：不给复制、编辑重发。
        if (message && message.systemNote) return;
        const sessionNow = session || currentSession();
        const lastAssistant = sessionNow ? lastAssistantIndex(sessionNow) : -1;
        const lastUser = sessionNow ? lastUserIndex(sessionNow) : -1;
        // 回复操作按钮颗粒度（设置 → AI 助手 → 回复操作按钮）：'last-only' 时中间步骤
        // 整行不出现——早退放在元素创建之前；中间步骤 'basic' 档在按钮分支里收敛。
        if (message && message.role !== 'user' &&
            aiMsgActionsStepMode(settings.aiMsgActions, index === lastAssistant) === 'none') return;
        const host = target || wrap;
        let actions = host.querySelector(':scope > .ai-msg-actions');
        if (!actions) {
            actions = document.createElement('div');
            actions.className = 'ai-msg-actions';
            host.appendChild(actions);
        }
        actions.innerHTML = '';
        // 只有「这条消息所属会话」在生成时才收起改写类操作：其他会话在跑不影响这里。
        const sessionBusy = !!(sessionNow && streamOf(sessionNow.id));
        const icon = (path) => '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
        const icons = {
            copy: icon('<rect x="5.2" y="5.2" width="7.6" height="7.6" rx="1.4"/><path d="M3.6 10.2V3.9c0-.7.6-1.3 1.3-1.3h6.3"/>'),
            edit: icon('<path d="M3.2 12.8l.6-2.7L10.6 3.3c.5-.5 1.3-.5 1.8 0l.3.3c.5.5.5 1.3 0 1.8L5.9 12.2l-2.7.6z"/><path d="M9.6 4.4l2 2"/>'),
            regenerate: icon('<path d="M12.6 6.4A5 5 0 1 1 3.4 9.6"/><path d="M12.8 3.2v3.4H9.4"/>'),
            retry: icon('<path d="M12.6 6.4A5 5 0 1 1 3.4 9.6"/><path d="M12.8 3.2v3.4H9.4"/>'),
            rewind: icon('<path d="M6.2 4.4L2.8 7.8l3.4 3.4"/><path d="M3 7.8h6.2a4 4 0 1 1 0 8H6.6"/>'),
            branch: icon('<circle cx="4.6" cy="3.4" r="1.7"/><circle cx="4.6" cy="12.6" r="1.7"/><circle cx="11.5" cy="6.4" r="1.7"/><path d="M4.6 5.1v5.8"/><path d="M4.6 8.9c0-1.7 1.3-2.5 3-2.5h2.2"/>'),
            database: icon('<ellipse cx="8" cy="4.2" rx="4.5" ry="1.7"/><path d="M3.5 4.2v3.7c0 .94 2.01 1.7 4.5 1.7s4.5-.76 4.5-1.7V4.2"/><path d="M3.5 7.9v3.7c0 .94 2.01 1.7 4.5 1.7s4.5-.76 4.5-1.7V7.9"/>'),
            sidechat: icon('<path d="M13.2 9.2a2 2 0 0 1-2 2H6.8L3.6 13.8v-3.2"/><path d="M12.4 10.4h-.4"/><path d="M3 6.2A2 2 0 0 1 5 4.2h6a2 2 0 0 1 2 2v.6a2 2 0 0 1-2 2H7l-2.8 2.2V8.2H5a2 2 0 0 1-2-2z"/><path d="M11 7.4h.6"/>'),
            bringback: icon('<path d="M3 8h8.6"/><path d="M8.4 4.6L11.8 8l-3.4 3.4"/><path d="M13 3.2v9.6"/>'),
            deliver: icon('<path d="M3.2 8l9.2-4.6v9.2z"/><path d="M12.4 8h1.9"/><path d="M3.2 8h1.2"/>'),
        };
        const add = (act, label, disabled) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'ai-msg-action';
            button.dataset.aiAct = act;
            button.setAttribute('aria-label', label);
            // 纯图标按钮：tooltip 运行时只认 data-tip，aria-label 不会弹气泡。
            // 沿用 label 作文案——它本就是每个动作的准确说明（与无障碍名同源）。
            button.dataset.tip = label;
            button.innerHTML = icons[act] || label;
            button.disabled = !!disabled;
            actions.appendChild(button);
        };
        if (message.role === 'user') {
            add('copy', '复制');
            if (index === lastUser && !sessionBusy) add('edit', '编辑重发');
        } else {
            // 中间步骤按颗粒度收敛：'basic' 只留复制 + 回退（回合收尾信息也只属于最后一条）
            const stepMode = aiMsgActionsStepMode(settings.aiMsgActions, index === lastAssistant);
            const isLast = index === lastAssistant;
            add('copy', '复制');
            if (message.status === 'error') {
                if (!sessionBusy && (isLast || stepMode === 'full')) add('retry', '重试');
            } else if (isLast && !sessionBusy) {
                add('regenerate', '重新生成');
            }
            if (!sessionBusy && !compactOf(sessionNow.id) && index < sessionNow.messages.length - 1) {
                add('rewind', '回退到此轮（丢弃之后的消息）');
            }
            // 回合收尾信息：分支 / 本轮用量 / 耗时。生成中与失败轮不显示（还没得看、也没意义）
            const finished = message.status !== 'streaming' && message.status !== 'error';
            if (finished && (isLast || stepMode === 'full')) {
                if (!sessionBusy) add('branch', '在新对话中分支');
                // 支线对话（旁路追问）：轻关联，不复制历史，只把这条消息作为引用带入新会话
                if (!sessionBusy) add('sidechat', '新建支线对话（带这条引用追问）');
                // 这条消息在支线会话里：一键把结论送回母会话的信箱
                if (sessionNow && sessionNow.sideOf) add('bringback', '把这条结论带回主对话');
                // 会话间投递（§4.12.3）：把这条消息作为「挂号信」发给另一个会话
                add('deliver', '投递到会话…');
                if (settings.aiShowUsage !== false && turnUsageTotal(message) > 0) {
                    actions.appendChild(turnUsageChip(message, icons));
                }
                const clock = turnClockLabel(message);
                if (clock) {
                    const duration = document.createElement('span');
                    duration.className = 'ai-msg-duration';
                    duration.textContent = clock;
                    actions.appendChild(duration);
                }
            }
        }
    }

    // 本轮用量合计（totalTokens 缺失时用输入 + 输出兜底）
    function turnUsageTotal(message) {
        const usage = message && message.usage;
        if (!usage) return 0;
        const prompt = Number(usage.promptTokens) || 0;
        const completion = Number(usage.completionTokens) || 0;
        return Math.max(0, Number(usage.totalTokens) || (prompt + completion));
    }

    // 本轮耗时 → 00:34 / 1:02:03（不足 1 秒不显示）
    function turnClockLabel(message) {
        const ms = Math.max(0, Number(message && message.turnMs) || 0);
        if (ms < 1000) return '';
        const total = Math.round(ms / 1000);
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const seconds = total % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return hours > 0 ? (hours + ':' + pad(minutes) + ':' + pad(seconds)) : (pad(minutes) + ':' + pad(seconds));
    }

    function turnUsageChip(message, icons) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ai-msg-usage';
        button.dataset.aiAct = 'usage';
        button.setAttribute('aria-label', '本轮用量');
        const glyph = document.createElement('span');
        glyph.className = 'ai-msg-usage-icon';
        glyph.innerHTML = (icons && icons.database) || '';
        const text = document.createElement('span');
        text.textContent = '用量 ' + aiFormatCompactTokens(turnUsageTotal(message)) + ' tok';
        button.append(glyph, text);
        return button;
    }

    // ---------- 本轮用量浮层 ----------

    let turnUsagePop = null;
    let turnUsageAnchor = null;
    let turnUsageDismiss = null;

    function closeTurnUsagePop() {
        if (turnUsageDismiss) {
            const dispose = turnUsageDismiss;
            turnUsageDismiss = null;
            dispose();
        }
        if (turnUsagePop) {
            turnUsagePop.remove();
            turnUsagePop = null;
        }
        turnUsageAnchor = null;
    }

    function showTurnUsagePop(anchor, message) {
        closeTurnUsagePop();
        if (!anchor || !message) return;
        const usage = message.usage || {};
        const prompt = Math.max(0, Number(usage.promptTokens) || 0);
        const cached = Math.max(0, Number(usage.cachedTokens) || 0);
        const cacheWrite = Math.max(0, Number(usage.cacheWriteTokens) || 0);
        const completion = Math.max(0, Number(usage.completionTokens) || 0);
        const total = turnUsageTotal(message);
        const uncached = Math.max(0, prompt - cached);
        const hitRate = prompt > 0 && cached > 0 ? Math.min(100, cached / prompt * 100) : -1;

        const pop = document.createElement('div');
        pop.className = 'ai-turn-usage';
        const head = document.createElement('div');
        head.className = 'ai-turn-usage-head';
        const title = document.createElement('span');
        title.className = 'ai-turn-usage-title';
        const glyph = document.createElement('span');
        glyph.className = 'ai-turn-usage-icon';
        glyph.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="8" cy="4.2" rx="4.5" ry="1.7"/><path d="M3.5 4.2v3.7c0 .94 2.01 1.7 4.5 1.7s4.5-.76 4.5-1.7V4.2"/><path d="M3.5 7.9v3.7c0 .94 2.01 1.7 4.5 1.7s4.5-.76 4.5-1.7V7.9"/></svg>';
        title.append(glyph, document.createTextNode('本轮用量'));
        const sum = document.createElement('b');
        sum.textContent = aiFormatExactCount(total) + ' tok';
        head.append(title, sum);
        pop.appendChild(head);

        const rows = document.createElement('div');
        rows.className = 'ai-turn-usage-rows';
        const row = (label, value, mono) => {
            const line = document.createElement('div');
            line.className = 'ai-turn-usage-row';
            const name = document.createElement('span');
            name.textContent = label;
            const val = document.createElement('span');
            val.className = 'ai-turn-usage-value' + (mono ? ' num' : '');
            val.textContent = value;
            line.append(name, val);
            rows.appendChild(line);
        };
        const provider = [message.modelAccount, message.model].filter(Boolean).join(' / ');
        row('提供方 / 模型', provider || '—');
        row('缓存命中', hitRate >= 0 ? hitRate.toFixed(1) + '%' : '—');
        row('未缓存输入', aiFormatExactCount(uncached) + ' tok', true);
        row('缓存读取', aiFormatExactCount(cached) + ' tok', true);
        row('缓存写入', aiFormatExactCount(cacheWrite) + ' tok', true);
        row('输出', aiFormatExactCount(completion) + ' tok', true);
        pop.appendChild(rows);
        document.body.appendChild(pop);

        const rect = anchor.getBoundingClientRect();
        const width = pop.offsetWidth || 300;
        const height = pop.offsetHeight || 200;
        const left = Math.min(Math.max(8, rect.left - 6), Math.max(8, window.innerWidth - width - 8));
        let top = rect.top - height - 8;
        if (top < 8) top = Math.min(rect.bottom + 8, Math.max(8, window.innerHeight - height - 8));
        pop.style.left = Math.round(left) + 'px';
        pop.style.top = Math.round(top) + 'px';
        turnUsagePop = pop;
        turnUsageAnchor = anchor;

        // 面板滚动 / 换会话 / 点别处 / Esc 都收起；滚轮滚动时浮层会脱锚，直接关。
        const onDown = (e) => {
            if (pop.contains(e.target)) return;
            if (e.target && e.target.closest && e.target.closest('[data-ai-act="usage"]')) return;
            closeTurnUsagePop();
        };
        const onKey = (e) => {
            if (e.key === 'Escape') closeTurnUsagePop();
        };
        const onScroll = () => closeTurnUsagePop();
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onScroll);
        turnUsageDismiss = () => {
            document.removeEventListener('mousedown', onDown, true);
            document.removeEventListener('keydown', onKey, true);
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onScroll);
        };
    }

    function isStreamingMessage(session, index) {
        const live = session ? streamOf(session.id) : null;
        return !!(live && index === session.messages.length - 1);
    }

    function lastAssistantIndex(session) {
        for (let i = session.messages.length - 1; i >= 0; i--) {
            if (session.messages[i].role === 'assistant') return i;
        }
        return -1;
    }

    function lastUserIndex(session) {
        for (let i = session.messages.length - 1; i >= 0; i--) {
            const message = session.messages[i];
            if (message.role === 'user' && !message.systemNote) return i;
        }
        return -1;
    }

    // ---------- 结构面板的「会话结构」（用户消息定位条） ----------
    // 结构面板在「内容区只有 AI 助手」时，或用户在两者间切换时，展示当前会话的用户消息。
    // 这里只提供数据与跳转能力，渲染在 session-outline.js / structure.js。

    const OUTLINE_MAX_ITEMS = 400;
    let outlineActiveIndex = -1;
    let outlineFrame = 0;
    let outlineTimer = 0;

    function sessionOutlineSnapshot() {
        const session = currentSession();
        if (!session) return {sessionId: '', items: [], activeIndex: -1};
        const built = buildSessionOutlineItems(session.messages, {max: OUTLINE_MAX_ITEMS});
        return {
            sessionId: session.id,
            total: built.total,
            truncated: built.truncated,
            items: built.items,
            activeIndex: outlineActiveIndex,
        };
    }

    // 视口顶部所在的那一轮：scrollTop 落在某条用户消息之内时就认为定位到它
    function outlineActiveFromView() {
        if (!el.messages) return -1;
        const nodes = el.messages.querySelectorAll('.ai-msg.user:not(.archived):not(.ai-app-msg):not(.model-switch)');
        if (!nodes.length) return -1;
        const top = el.messages.getBoundingClientRect().top;
        const pick = (node) => {
            const idx = Number(node.dataset.aiIdx);
            return Number.isFinite(idx) ? idx : -1;
        };
        for (const node of nodes) {
            if (node.getBoundingClientRect().bottom > top + 4) return pick(node);
        }
        return pick(nodes[nodes.length - 1]);
    }

    function scheduleOutlineSync() {
        if (outlineFrame) return;
        outlineFrame = requestAnimationFrame(() => {
            outlineFrame = 0;
            const next = outlineActiveFromView();
            if (next === outlineActiveIndex) return;
            outlineActiveIndex = next;
            notifyStructure();
        });
    }

    // 结构面板要跟着变的时机（开合 / 显示方式 / 消息变化）统一从这里通知
    function notifyStructure() {
        if (!onPanelStateChange) return;
        clearTimeout(outlineTimer);
        outlineTimer = setTimeout(() => {
            try {
                onPanelStateChange();
            } catch (e) {}
        }, 140);
    }

    // 跳到某一轮用户消息：目标在窗口之外时先把更早的消息放进来
    function jumpToSessionMessage(index) {
        const session = currentSession();
        const idx = Math.round(Number(index));
        if (!session || !Number.isFinite(idx) || idx < 0 || idx >= session.messages.length) return false;
        const state = renderWindowState(session);
        if (idx < state.start) {
            state.start = Math.max(0, idx - 8);
            state.len = session.messages.length;
            renderWindows.set(session.id, state);
            renderMessages(true);
        }
        const node = el.messages ? el.messages.querySelector('.ai-msg[data-ai-idx="' + idx + '"]') : null;
        if (!node) return false;
        if (node.scrollIntoView) node.scrollIntoView({block: 'center', behavior: 'smooth'});
        node.classList.remove('ai-msg-flash');
        void node.offsetWidth;
        node.classList.add('ai-msg-flash');
        setTimeout(() => node.classList.remove('ai-msg-flash'), 1600);
        outlineActiveIndex = idx;
        notifyStructure();
        return true;
    }

    function turnStartAt(session, assistantIndex) {
        for (let i = Math.min(assistantIndex, session.messages.length - 1); i >= 0; i--) {
            const message = session.messages[i];
            if (message.role === 'user' && !message.systemNote) return Number(message.turnStartedAt) || Number(message.ts) || 0;
        }
        return 0;
    }

    // 消息区滚动条槽宽交给 CSS：.ai-bottom-stack::before 用它让位。
    // 堆叠区 z-index 高于消息区，若铺底整块铺满就会把滚动条下半截一起盖住——看不见也拖不动。
    // 滚动条有两种形态：经典（占布局宽度，实测 >0）与 Edge Fluent 式浮层（不占宽度，实测 0），
    // 两种都得让位，所以取实测值与浮层宽度（12px）的较大者——多让出的几像素只是同色 --bg，看不出来。
    // 值没变就不写，避免流式帧里反复触发样式重算。声明放在所有调用点之前（含顶部 syncMessagesUnderflow）
    let lastScrollbarGutter = -1;
    // 平滑滚动宽限期（时间戳）：动画中间帧距底很远，不能被误判成「贴底态被布局挤离底部」。
    // 只有 scrollToBottom(true) 开启，瞬时贴底清零。
    let smoothScrollUntil = 0;

    function syncScrollbarGutter() {
        if (!el.messages) return;
        const measured = Math.round(el.messages.offsetWidth - el.messages.clientWidth);
        const sbw = Math.max(12, measured);
        if (sbw === lastScrollbarGutter) return;
        lastScrollbarGutter = sbw;
        panel.style.setProperty('--ai-sbw', sbw + 'px');
    }

    function scrollToBottom(smooth) {
        if (!el.messages) return;
        const top = Math.max(0, el.messages.scrollHeight - el.messages.clientHeight);
        // 平滑滚动的宽限期：动画中间的帧距底还很远，不能被当成「贴底态被布局挤离底部」
        // 再补一次瞬时跳底（那动画就没了）
        smoothScrollUntil = smooth ? performance.now() + 800 : 0;
        if (smooth && el.messages.scrollTo) el.messages.scrollTo({top, behavior: 'smooth'});
        else el.messages.scrollTop = top;
        stickBottom = true;
        // 同步基准位置：scroll 事件是异步派发的，等它派发前若来了下一次判定（流式帧、
        // 补底），旧的基准会把这次程序贴底当成「scrollTop 变大」，反过来把用户紧跟着的
        // 一次上滚吞掉
        scrollLastTop = el.messages.scrollTop;
        updateScrollButton();
    }

    // 距底距离（小于 0 的 overscroll 归零）：滚动跟随的所有判定共用这一个口径
    function messagesBottomGap() {
        if (!el.messages) return 0;
        const gap = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight;
        return gap > 0 ? gap : 0;
    }

    function updateScrollButton() {
        // 滚动条随内容增长才出现/消失：贴在这里同步槽宽，流式增长与重排都不会漏。
        syncScrollbarGutter();
        if (!el.scrollBtn || !el.messages) return;
        el.scrollBtn.classList.toggle('hidden', messagesBottomGap() <= 200);
    }

    function positionOverlays() {
        syncMessagesUnderflow();
        if (!el.composer) return;
        const panelRect = panel.getBoundingClientRect();
        const composerRect = el.composer.getBoundingClientRect();
        if (!panelRect.height) return;
        // composer 下面还有统计行：以 composer 上方最靠上的可见覆盖物为基准
        // （上下文警告条 → 任务清单 → composer），避免按钮/菜单压在它们上面。
        const overlay = [el.ctxBanner, el.todos, el.composer].find((node) =>
            node && !node.classList.contains('hidden') && node.getBoundingClientRect().height > 0);
        const refRect = overlay ? overlay.getBoundingClientRect() : composerRect;
        const bottom = Math.max(8, panelRect.bottom - refRect.top + 8);
        if (el.slash) {
            el.slash.style.bottom = bottom + 'px';
            el.slash.style.left = Math.max(9, composerRect.left - panelRect.left) + 'px';
            el.slash.style.right = Math.max(9, panelRect.right - composerRect.right) + 'px';
        }
        if (el.scrollBtn) {
            el.scrollBtn.style.bottom = bottom + 'px';
            // 居中挂在覆盖物正上方（CSS 里用 translateX(-50%) 对齐中心）。
            const center = composerRect.left - panelRect.left + composerRect.width / 2;
            el.scrollBtn.style.left = center + 'px';
            el.scrollBtn.style.right = 'auto';
        }
            if (openStatsPop) positionStatsPop(openStatsPop);
    }

    // 消息区占满面板全高（滚动条轨道随之占满），底部堆叠区浮在其上：
    // 消息内容 padding-bottom 跟随堆叠区实际高度。刷新统一走 positionOverlays
    // （todos/警告条渲染、会话切换、窗口缩放都会调它），打字增行走 input 事件。
    // 不用 ResizeObserver：部分宿主（IAB 节流渲染帧）不派发 RO 回调。
    // 留白二次校准的帧句柄：底部浮层一次性长高（展开任务清单、审批卡首帧）时，
    // 这一帧量到的盒高可能还没定型，下一帧再校一次
    let underflowResyncRaf = 0;

    function syncMessagesUnderflow() {
        if (!el.bottomStack || !el.messages) return;
        const h = Math.round(el.bottomStack.getBoundingClientRect().height);
        const pad = h > 0 ? (h + 12) + 'px' : '';
        if (el.messages.style.paddingBottom !== pad) {
            // 补底判定要在写留白之前取：写完 padding 就「不贴底」了
            const gap = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight;
            el.messages.style.paddingBottom = pad;
            // 留白变化直接改「距底距离」（scrollHeight 变大），但 scrollTop 不动、也不派发
            // scroll 事件——贴底态就地补回去。否则任务清单 / 审批卡出现后要等下一个流式帧
            // 才跟到底，流已结束（正在等审批）时就永远停在被顶上去的位置。
            // 严格贴底（gap ≈ 0）也算贴底并顺手把 stickBottom 修回来：旧版本被布局误判掉
            // 的贴底态不必等用户手动再滚一次才恢复
            if (stickBottom || gap <= STRICT_BOTTOM_PX) {
                stickBottom = true;
                scrollToBottom(false);
            }
            // 展开任务清单 / 审批卡首帧这类一次性长高，量到的可能还是展开前的盒高
            // （子树这帧才建立、字体行高还没定型）：下一帧再校一次，别让留白差一截、
            // 末条消息被浮层压住。校完没变化就不再排。
            if (!underflowResyncRaf) {
                underflowResyncRaf = requestAnimationFrame(() => {
                    underflowResyncRaf = 0;
                    syncMessagesUnderflow();
                });
            }
        }
        syncScrollbarGutter();
    }
    syncMessagesUnderflow();

    // ---------- 上下文估算 ----------

    // 最近一次 buildApiMessages 的实时瘦身省略量（token 估算，统计浮层展示用）。
    // 每次组装重置——浮层打开时自己会组装一遍，读到的就是当前会话的新鲜值。
    let lastBuildSavedTokens = 0;

    function buildApiMessages(session, endIndex, systemText) {
        const messages = [{role: 'system', content: systemText || AI_DEFAULT_SYSTEM_PROMPT}];
        if (!session) return messages;
        if (session.summary && aiTextOf(session.summary.text).trim()) {
            messages.push({
                role: 'system',
                content: '<conversation_summary>\n' + aiTextOf(session.summary.text).trim() + '\n</conversation_summary>',
            });
        }
        const limit = endIndex == null ? session.messages.length : endIndex;
        // 瞬态注入块去重（实时压缩式剔除）：同类 dedupeKey 的注入只保留**最新一条**发
        // 给模型——旧条目已过时（如清单状态早变了），重发既浪费上下文又可能用旧状态
        // 误导模型。会话历史里照常保留（用户可查），只是组装请求时跳过。
        const lastTransient = new Map();
        for (let i = 0; i < limit; i++) {
            const m = session.messages[i];
            if (m && m.dedupeKey) lastTransient.set(m.dedupeKey, i);
        }
        // tool 消息必须一对一响应最近一条已发送 assistant 的 tool_calls（OpenAI 校验，
        // Anthropic 同理）。停止生成、压缩截断、历史恢复都可能留下孤立 tool 消息——
        // 不跳过会让后续每一轮请求都被 HTTP 400 拒收。
        let pendingCalls = new Set();
        // —— 实时瘦身（组装视角剔除，会话历史原样保留）——
        // 总开关 settings.aiContextSlim（默认开，dsh 同款思路：清理是部署策略恒开）。
        // 轮起点 = 用户消息（非 systemNote）；保留最近 2 轮原文，更早的算「过时区」。
        const slim = settings.aiContextSlim !== false;
        let recentStart = slim ? 0 : -1; // -1 = 全部视为「当轮」，各剔除点自然全跳过
        let userTurnsSeen = 0;
        let savedTokens = 0; // 本次组装剔除的 token（旧思考 / stub 工具结果 / 过期注入）
        if (slim) {
            for (let i = limit - 1; i >= 0; i--) {
                const m = session.messages[i];
                if (m && m.role === 'user' && !m.systemNote) {
                    userTurnsSeen += 1;
                    if (userTurnsSeen === 3) {
                        recentStart = i + 1;
                        break;
                    }
                }
            }
        }
        for (let i = 0; i < limit; i++) {
            const message = session.messages[i];
            if (!message) continue;
            // 文件改动汇总卡是纯 UI 载体，不发给模型
            if (message.kind === 'changes-summary') continue;
            // 模型切换记录只是对话里的可视注记，不进入模型上下文
            if (message.kind === 'model-switch') continue;
            // 瞬态注入块的旧条目：只发最新一条（见 lastTransient）。瘦身关闭时仍去重——
            // 同内容多份纯冗余，与「是否清理上下文」是两回事
            if (message.dedupeKey && lastTransient.get(message.dedupeKey) !== i) {
                savedTokens += aiEstimateTokens(aiTextOf(message.content));
                continue;
            }
            // 轮次提醒注记（如「工具调用轮次已达 N」）：只在产生时随下一请求有效，
            // 之后是纯噪音，历史里不再发
            if (slim && message.systemNote && !message.dedupeKey) {
                savedTokens += aiEstimateTokens(aiTextOf(message.content));
                continue;
            }
            if (message.role === 'tool') {
                if (message.status === 'running') continue;
                if (!pendingCalls.has(message.toolCallId)) continue;
                pendingCalls.delete(message.toolCallId);
                let toolContent = message.content || '';
                // 过时的大工具结果修剪（参数对齐 dsh tool-result-pruner 默认值：阈值
                // 8192 字符、保留头 4096 + 尾 1024，中间打标记——头部上下文重要，
                // 命令/搜索的结论常在尾部，read_file 的结构信息在头部）。
                if (slim && i < recentStart && toolContent.length > 8192 &&
                    (message.name === 'read_file' || message.name === 'web_fetch' ||
                        message.name === 'run_command' || message.name === 'background_command' ||
                        message.name === 'search_text')) {
                    const before = toolContent.length;
                    toolContent = toolContent.slice(0, 4096) +
                        '\n\n[... 中间内容已修剪：原文 ' + before + ' 字符，读取于较早轮次、大概率已过时，如需请重新读取 ...]\n\n' +
                        toolContent.slice(-1024);
                    savedTokens += aiEstimateTokens('x'.repeat(Math.max(0, before - toolContent.length)));
                }
                messages.push({
                    role: 'tool',
                    toolCallId: message.toolCallId,
                    name: message.name || '',
                    content: toolContent,
                });
                continue;
            }
            const hasCalls = message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length;
            const hasImages = message.role === 'user' && Array.isArray(message.images) && message.images.some((image) => image && image.data);
            const hasVideos = message.role === 'user' && Array.isArray(message.videos) && message.videos.some((video) => video && video.data);
            let content = message.content;
            if (!content && !hasImages && !hasVideos && message.role === 'user' &&
                ((Array.isArray(message.images) && message.images.length) || (Array.isArray(message.videos) && message.videos.length))) {
                content = '（图片/视频已归档，原始内容见对话日志）';
            }
            if (!content && !hasCalls && !hasImages && !hasVideos) continue;
            if (message.role === 'assistant' && message.status === 'error') continue;
            const item = {role: message.role, content};
            if (hasImages) {
                item.images = message.images.filter((image) => image && image.data)
                    .map((image) => ({mime: image.mime, data: image.data}));
            }
            if (hasVideos) {
                item.videos = message.videos.filter((video) => video && video.data)
                    .map((video) => ({mime: video.mime, data: video.data}));
            }
            if (message.role === 'assistant' && message.reasoning && (!slim || i >= recentStart)) {
                // 历史 reasoning 只保留最近 2 轮：思考只服务于当轮行动，旧轮的思考
                // 重发动辄数千 token 且零价值（文件/状态早变了）
                item.thinking = message.reasoning;
                item.thinkingSignature = message.thinkingSignature || '';
            } else if (message.role === 'assistant' && message.reasoning) {
                savedTokens += aiEstimateTokens(message.reasoning);
            }
            // 只保留「确有 tool 响应」的调用：多工具批次中途停止/中断会留下残缺批次
            // （如 2 个 calls 只有 1 个执行），OpenAI/Anthropic 会以
            // "insufficient tool messages following tool_calls" 拒收整轮请求。
            let usableCalls = null;
            if (hasCalls) {
                const responded = new Set();
                for (let j = i + 1; j < limit; j++) {
                    const next = session.messages[j];
                    if (!next) continue;
                    if (next.role !== 'tool') break;
                    if (next.status === 'running') continue;
                    if (next.toolCallId) responded.add(next.toolCallId);
                }
                usableCalls = message.toolCalls.filter((call) => responded.has(call.id));
                if (usableCalls.length) {
                    item.toolCalls = usableCalls.map((call) => ({
                        id: call.id,
                        name: call.name,
                        // 后端会整轮校验：参数不合法时先修复，避免一条坏历史让后续每轮 400。
                        arguments: safeToolArguments(call.arguments),
                    }));
                } else if (!content) {
                    // 全部无响应且无正文：整条不发，避免模型看到悬空的 calls。
                    continue;
                }
            }
            messages.push(item);
            // 维护「待响应工具调用」集合：assistant 重置为可用 calls，user 清空。
            // 被跳过的 assistant（空内容/错误）不更新集合，其后的孤立 tool 消息自然被跳过。
            if (message.role === 'assistant') {
                pendingCalls = (usableCalls && usableCalls.length) ? new Set(usableCalls.map((call) => call.id)) : new Set();
            } else {
                pendingCalls = new Set();
            }
        }
        lastBuildSavedTokens = savedTokens;
        return messages;
    }

    async function contextSummaryText() {
        const session = currentSession();
        const profile = profileOf(session);
        const bundle = await assembleSystemContext(session, getAttachments());
        rememberPrompt(session && session.id, bundle);
        const apiMessages = buildApiMessages(session, null, bundle.text);
        let chars = 0;
        let cjk = 0;
        for (const message of apiMessages) {
            const text = aiTextOf(message.content);
            chars += text.length;
            for (const ch of text) if (aiIsCJK(ch.codePointAt(0))) cjk++;
        }
        const tokens = estimateApiMessagesTokens(apiMessages);
        const imageStats = aiImageStats(apiMessages);
        const totalTokens = tokens;
        const windowSize = contextWindowOf(session);
        const percent = windowSize > 0 ? (totalTokens / windowSize * 100) : 0;
        const userCount = session ? session.messages.filter((m) => m.role === 'user' && !m.systemNote).length : 0;
        const assistantCount = session ? session.messages.filter((m) => m.role === 'assistant').length : 0;
        const toolCount = session ? session.messages.filter((m) => m.role === 'tool').length : 0;
        let lastUsage = null;
        if (session) {
            for (let i = session.messages.length - 1; i >= 0; i--) {
                const message = session.messages[i];
                if (message.role === 'assistant' && message.usage) {
                    lastUsage = message.usage;
                    break;
                }
            }
        }
        const lines = [
            '上下文估算（字符近似，非精确 tokenizer）',
            '消息：' + userCount + ' 条用户 / ' + assistantCount + ' 条助手 / ' + toolCount + ' 条工具结果（共 ' + apiMessages.length + ' 条发送项，含 system）',
            '字符：' + chars + '（其中 CJK ' + cjk + '）',
            '图片：' + imageStats.count + ' 张（估算 ' + imageStats.tokens + ' tokens）',
            '估算 tokens：' + totalTokens + ' / 窗口 ' + windowSize + '（' + percent.toFixed(1) + '%）',
            '系统注入：AGENTS.md ' + (bundle.meta.agents.loaded ? '✓ ' + bundle.meta.agents.chars + ' 字符' : '—') +
                ' · 记忆 ' + (bundle.meta.memory.loaded ? '✓ ' + bundle.meta.memory.mode + ' ' + bundle.meta.memory.chars + ' 字符' : '—') +
                ' · 技能 ' + bundle.meta.skills.count + ' 个' +
                ' · 环境变量 ' + (bundle.meta.env.count || 0) + ' 个' +
                ' · 附加 ' + bundle.meta.attachments.count + ' 项',
        ];
        if (bundle.meta.memory.error && bundle.meta.memory.error !== '') {
            lines.push('记忆未注入：' + bundle.meta.memory.error);
        }
        if (lastUsage) {
            lines.push('最近一次 API 实际用量：输入 ' + (lastUsage.promptTokens || 0) +
                ' · 输出 ' + (lastUsage.completionTokens || 0) +
                ' · 合计 ' + (lastUsage.totalTokens || 0));
        } else {
            lines.push('尚无 API 用量数据（接口返回 usage 后显示）。');
        }
        if (session && session.summary && session.summary.text) {
            lines.push('已压缩：摘要 ' + session.summary.text.length + ' 字符，归档 ' +
                ((session.archived || []).length) + ' 条（归档不发送；命令面板「AI： 查看已归档消息」或导出 Markdown 可查看）。');
        }
        if (percent >= 80) lines.push('上下文接近窗口上限。');
        return lines.join('\n');
    }

    function updateContextCount() {
        if (el.contextCount) {
            const session = currentSession();
            const messages = buildApiMessages(session, null, promptTextOf(session && session.id));
            const chars = messages.reduce((sum, message) => sum + aiTextOf(message.content).length, 0);
            const extra = getAttachments().reduce((sum, item) => sum + aiTextOf(item.content).length, 0);
            const imageCount = aiImageStats(messages).count + getAttachments().filter((item) => item.kind === 'image').length;
            const videoCount = getAttachments().filter((item) => item.kind === 'video').length;
            el.contextCount.textContent = '上下文约 ' + (chars + extra) + ' 字符' +
                (imageCount ? ' · 图片 ' + imageCount + ' 张' : '') +
                (videoCount ? ' · 视频 ' + videoCount + ' 个' : '');
        }
        updateCtxBanner();
        renderStats();
    }

    // 重开面板 / 切会话 / 注入开关变化后，按当前环境重建系统提示词并刷新占用估算。
    // 生成中不重建：本轮请求用的是 stream.systemPrompt，避免覆盖为下一轮的估算。
    function refreshSystemPromptEstimate(force) {
        const session = currentSession();
        if (!session) return Promise.resolve();
        const sessionId = session.id;
        // 本会话正在生成/压缩时跳过：本轮用的是它自己的快照，不会被这次估算覆盖
        if (streamOf(sessionId) || compactOf(sessionId) || !isOpen()) return Promise.resolve();
        if (!force && Date.now() - promptCachedAt(sessionId) < 2000) return Promise.resolve();
        // in-flight 也按会话去重：A 的估算在飞不该让 B 直接复用它
        const running = promptJobs.get(sessionId);
        if (running) return running;
        const job = Promise.resolve()
            .then(() => assembleSystemContext(session, getAttachments()))
            .then((bundle) => {
                if (streamOf(sessionId) || compactOf(sessionId)) return;
                rememberPrompt(sessionId, bundle);
                const viewing = currentSession();
                if (!viewing || viewing.id !== sessionId) return;
                updateContextCount();
            })
            .catch(() => {})
            .then(() => {
                if (promptJobs.get(sessionId) === job) promptJobs.delete(sessionId);
            });
        promptJobs.set(sessionId, job);
        return job;
    }

    // ---------- Composer 统计行 / 上下文弹层 ----------

    function toolsTokenEstimate(session) {
        return aiEstimateTokens(JSON.stringify(toolsForScope(currentScopeOf(session), !!(session && session.planMode))));
    }

    function aiFormatCompactTokens(value) {
        const num = Math.max(0, Math.round(Number(value) || 0));
        if (num < 1000) return String(num);
        if (num < 1000000) {
            const k = num / 1000;
            return (k < 100 ? k.toFixed(1) : k.toFixed(0)).replace(/\.0$/, '') + 'K';
        }
        const m = num / 1000000;
        return (m < 10 ? m.toFixed(1) : m.toFixed(0)).replace(/\.0$/, '') + 'M';
    }

    function aiFormatExactCount(value) {
        return Math.max(0, Math.round(Number(value) || 0)).toLocaleString('en-US');
    }

    function aiFormatCompactDuration(ms) {
        const total = Math.max(0, Math.round(Number(ms) / 1000));
        if (total < 1) return '不到 1 秒';
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const seconds = total % 60;
        if (hours) return hours + '小时' + (minutes ? minutes + '分' : '');
        if (minutes) return minutes + '分' + (seconds ? seconds + '秒' : '');
        return seconds + '秒';
    }

    // TPS 采样下限：单轮生成窗口过短（<200ms）时除法的量化误差太大，改走端到端兜底。
    const MIN_TPS_WINDOW_MS = 200;

    function sessionUsageTotals(session) {
        const all = ((session && session.archived) || []).concat((session && session.messages) || []);
        let rounds = 0;
        let steps = 0;
        let prompt = 0;
        let completion = 0;
        let total = 0;
        let cached = 0;
        let turnMs = 0;
        let modelMs = 0;
        let toolMs = 0;
        let genMs = 0;
        let genCompletion = 0;
        let e2eMs = 0;
        let e2eCompletion = 0;
        let ttftMs = 0;
        let ttftCount = 0;
        let hasTools = false;
        for (const message of all) {
            if (!message) continue;
            if (message.role === 'user' && !message.systemNote) rounds++;
            if (message.role === 'tool') {
                hasTools = true;
                continue;
            }
            if (message.role !== 'assistant') continue;
            steps++;
            let messageCompletion = 0;
            const usage = message.usage;
            if (usage) {
                const p = Number(usage.promptTokens) || 0;
                const c = Number(usage.completionTokens) || 0;
                prompt += p;
                completion += c;
                messageCompletion = c;
                total += Number(usage.totalTokens) || (p + c);
                cached += Number(usage.cachedTokens) || 0;
            }
            const messageModelMs = Number(message.modelMs) || 0;
            const messageTurnMs = Number(message.turnMs) || 0;
            modelMs += messageModelMs;
            toolMs += Number(message.toolMs) || 0;
            turnMs += messageTurnMs;
            const firstTokenMs = Number(message.firstTokenMs) || 0;
            if (firstTokenMs > 0) {
                ttftMs += firstTokenMs;
                ttftCount++;
            }
            // TPS 的分子分母必须同源，否则多步任务会把速度算到极低：
            //  · 分母只用 modelMs（本轮模型往返），绝不回退 turnMs —— turnMs 从用户发消息算起，
            //    包含本轮之前所有步骤与工具调用耗时，几十步的任务会得到几十秒的分母；
            //  · 分母扣掉 TTFT：排队 + 预填充 + 首 token 延迟不属于「生成速度」；
            //  · 没有 usage 的轮次直接跳过，避免「分母涨、分子不涨」稀释均值。
            if (usage && messageCompletion > 0 && messageModelMs > 0) {
                const windowMs = Math.max(0, messageModelMs - firstTokenMs);
                if (windowMs >= MIN_TPS_WINDOW_MS) {
                    genMs += windowMs;
                    genCompletion += messageCompletion;
                } else {
                    // 非流式一次性返回（TTFT ≈ 总耗时）或仅吐了几个 token：
                    // 用它算生成速度会得到天文数字，退化为端到端吞吐计权。
                    e2eMs += messageModelMs;
                    e2eCompletion += messageCompletion;
                }
            }
        }
        // 有真实生成窗口就优先用它；否则退化为端到端吞吐（含 TTFT），仍远好过混入 turnMs。
        let speed = 0;
        if (genCompletion > 0 && genMs > 0) {
            speed = Math.round(genCompletion / (genMs / 1000));
        } else if (e2eCompletion > 0 && e2eMs > 0) {
            speed = Math.round(e2eCompletion / (e2eMs / 1000));
        }
        return {
            rounds, steps, prompt, completion, total, cached, turnMs,
            modelMs, toolMs, hasTools,
            ttftAvg: ttftCount ? ttftMs / ttftCount : 0,
            speed,
            speedKind: genCompletion > 0 && genMs > 0 ? 'gen' : (speed > 0 ? 'e2e' : ''),
        };
    }

    function setStatItem(node, text) {
        if (!node) return;
        node.textContent = text;
        node.classList.toggle('hidden', !text);
    }

    function renderStats() {
        if (!el.stats) return;
        const session = currentSession();
        const show = !!(session && ((session.messages && session.messages.length) || (session.archived && session.archived.length)));
        el.stats.classList.toggle('hidden', !show);
        if (!show) {
            hideStatsPops();
            return;
        }
        const totals = sessionUsageTotals(session);
        setStatItem(el.statsTurns, totals.rounds + ' 轮 ' + totals.steps + ' 步');
        setStatItem(el.statsSpeed, totals.speed > 0 ? totals.speed + ' tok/s' : '');
        setStatItem(el.statsTotal, totals.total > 0 ? aiFormatCompactTokens(totals.total) + ' tok' : '');
        const cacheRate = totals.prompt > 0 && totals.cached > 0 ? Math.round(totals.cached / totals.prompt * 100) : 0;
        setStatItem(el.statsCache, cacheRate > 0 ? '缓存命中 ' + cacheRate + '%' : '');
        const tokenVisible = totals.total > 0 || totals.prompt > 0 || totals.completion > 0;
        if (el.statsTokenBtn) el.statsTokenBtn.classList.toggle('hidden', !tokenVisible);
        if (el.statsSep) el.statsSep.classList.toggle('hidden', !tokenVisible);
        const {percent} = estimateCurrentTokens();
        const pct = Math.max(0, Math.round(percent * 100));
        if (el.statsCtxPct) el.statsCtxPct.textContent = pct + '%';
        if (el.ctxRing) el.ctxRing.style.setProperty('--ctx-pct', String(Math.min(100, pct)));
        if (openStatsPop === 'ctx') void renderCtxPopover(false);
        else if (openStatsPop === 'session') renderSessionPopover();
        else if (openStatsPop === 'token') renderTokenPopover();
    }

    let openStatsPop = '';

    function statsPopEl(kind) {
        if (kind === 'session') return el.sessionPop;
        if (kind === 'token') return el.tokenPop;
        return el.ctxPop;
    }

    function statsPopBtn(kind) {
        if (kind === 'session') return el.statsSessionBtn;
        if (kind === 'token') return el.statsTokenBtn;
        return el.ctxBtn;
    }

    function hideStatsPops() {
        for (const kind of ['session', 'token', 'ctx']) {
            const pop = statsPopEl(kind);
            if (pop) pop.classList.add('hidden');
        }
        openStatsPop = '';
    }

    function hideCtxPop() {
        hideStatsPops();
    }

    function positionStatsPop(kind) {
        const pop = statsPopEl(kind);
        const btn = statsPopBtn(kind);
        if (!pop || !btn || !el.statsWrap) return;
        const wrapRect = el.statsWrap.getBoundingClientRect();
        const btnRect = btn.getBoundingClientRect();
        const width = pop.offsetWidth || 308;
        const left = Math.max(0, Math.min(Math.max(0, wrapRect.width - width), btnRect.left - wrapRect.left));
        pop.style.left = left + 'px';
        pop.style.right = 'auto';
    }

    function renderSessionPopover() {
        if (!el.sessionPop) return;
        const session = currentSession();
        if (!session) return;
        const totals = sessionUsageTotals(session);
        if (el.sessionPopTurns) el.sessionPopTurns.textContent = totals.rounds + ' 轮 ' + totals.steps + ' 步';
        if (el.sessionModel) el.sessionModel.textContent = totals.modelMs > 0 ? aiFormatCompactDuration(totals.modelMs) : '—';
        if (el.sessionTools) el.sessionTools.textContent = totals.hasTools ? aiFormatCompactDuration(totals.toolMs) : '—';
        if (el.sessionTtft) {
            el.sessionTtft.textContent = totals.ttftAvg > 0
                ? (totals.ttftAvg < 1000 ? (totals.ttftAvg / 1000).toFixed(2) : (totals.ttftAvg / 1000).toFixed(1)) + ' 秒'
                : '—';
        }
        if (el.sessionTps) {
            el.sessionTps.textContent = totals.speed > 0 ? totals.speed + ' tok/s' : '—';
            // gen = 纯生成速度（已扣除首 token 延迟）；e2e = 端到端吞吐（无流式时间戳时的兜底）
            el.sessionTps.dataset.tip = totals.speedKind === 'gen'
                ? '生成速度：输出 tokens ÷（模型往返耗时 − 首 token 延迟）'
                : (totals.speedKind === 'e2e'
                    ? '端到端吞吐：输出 tokens ÷ 模型往返耗时（含首 token 延迟）'
                    : '');
        }
    }

    function renderTokenPopover() {
        if (!el.tokenPop) return;
        const session = currentSession();
        if (!session) return;
        const totals = sessionUsageTotals(session);
        const total = totals.total || (totals.prompt + totals.completion);
        const uncached = Math.max(0, totals.prompt - totals.cached);
        const hitRate = totals.prompt > 0 && totals.cached > 0 ? Math.round(totals.cached / totals.prompt * 100) : -1;
        if (el.tokenPopTotal) el.tokenPopTotal.textContent = total > 0 ? aiFormatExactCount(total) + ' tok' : '—';
        if (el.tokenHit) el.tokenHit.textContent = hitRate >= 0 ? hitRate + '%' : '—';
        if (el.tokenUncached) el.tokenUncached.textContent = totals.prompt > 0 ? aiFormatExactCount(uncached) + ' tok' : '—';
        if (el.tokenCached) el.tokenCached.textContent = totals.cached > 0 ? aiFormatExactCount(totals.cached) + ' tok' : '—';
        if (el.tokenOutput) el.tokenOutput.textContent = totals.completion > 0 ? aiFormatExactCount(totals.completion) + ' tok' : '—';
    }

    function toggleStatsPop(kind) {
        if (openStatsPop === kind) {
            hideStatsPops();
            return;
        }
        hideStatsPops();
        const pop = statsPopEl(kind);
        if (!pop) return;
        pop.classList.remove('hidden');
        openStatsPop = kind;
        positionStatsPop(kind);
        if (kind === 'ctx') void renderCtxPopover(true);
        else if (kind === 'session') renderSessionPopover();
        else renderTokenPopover();
    }

    function toggleCtxPop() {
        toggleStatsPop('ctx');
    }

    let ctxPopSeq = 0;
    async function renderCtxPopover(refreshSystem) {
        const seq = ++ctxPopSeq;
        const session = currentSession();
        if (!session || !el.ctxPop || el.ctxPop.classList.contains('hidden')) return;
        let systemText = promptTextOf(session.id);
        if (refreshSystem) {
            try {
                const bundle = await assembleSystemContext(session, getAttachments());
                rememberPrompt(session.id, bundle);
                systemText = bundle.text;
            } catch (e) {}
        }
        if (seq !== ctxPopSeq || !hasHost(session && session.id) || el.ctxPop.classList.contains('hidden')) return;
        const windowSize = contextWindowOf(session);
        const messages = buildApiMessages(session, null, systemText);
        let systemTokens = 0;
        let messageTokens = 0;
        // 与 estimateCurrentTokens（状态栏角标 / auto-compact）同口径：
        // content + 思考链 + 工具调用参数 + 图片。此前这里只累加 content，
        // 重工具会话漏掉约 1/3，弹层百分比会明显低于角标（如 5% vs 9%）。
        messages.forEach((message, index) => {
            const tokens = estimateMessageTokens(message);
            if (index === 0 && message.role === 'system') systemTokens += tokens;
            else messageTokens += tokens;
        });
        for (const item of getAttachments()) {
            if (item.kind === 'image') messageTokens += aiEstimateImageTokens(item);
            else if (item.kind === 'video') messageTokens += aiEstimateVideoTokens();
            else messageTokens += aiEstimateTokens(aiTextOf(item.content));
        }
        const toolTokens = toolsTokenEstimate(session);
        const total = systemTokens + messageTokens + toolTokens;
        const pct = windowSize > 0 ? Math.round(total / windowSize * 100) : 0;
        if (el.ctxPopPct) el.ctxPopPct.textContent = pct + '%';
        // 分母是生效窗口（可能被「本次会话上下文上限」收窄），收窄时标注来源
        const baseWindow = (entryOf(session) && entryOf(session).contextWindow) || 128000;
        if (el.ctxPopSize) {
            el.ctxPopSize.textContent = '~' + aiFormatCompactTokens(total) + ' / ' + aiFormatCompactTokens(windowSize) +
                (windowSize < baseWindow ? '（会话上限 ' + formatTokenAmount(windowSize) + '）' : '');
        }
        const raw = [systemTokens, toolTokens, messageTokens].map((tokens) => windowSize > 0 ? tokens / windowSize * 100 : 0);
        const sum = raw.reduce((a, b) => a + b, 0);
        const scale = sum > 100 ? 100 / sum : 1;
        const nodes = [el.ctxSegSystem, el.ctxSegTools, el.ctxSegMessages];
        nodes.forEach((node, index) => {
            if (node) node.style.width = (raw[index] * scale).toFixed(2) + '%';
        });
        if (el.ctxTokSystem) el.ctxTokSystem.textContent = '~' + aiFormatCompactTokens(systemTokens);
        if (el.ctxTokTools) el.ctxTokTools.textContent = '~' + aiFormatCompactTokens(toolTokens);
        if (el.ctxTokMessages) el.ctxTokMessages.textContent = '~' + aiFormatCompactTokens(messageTokens);
        if (el.ctxTokSaved) el.ctxTokSaved.textContent = '~' + aiFormatCompactTokens(lastBuildSavedTokens);
    }

    // ---------- 路径 / 记忆 / 技能 ----------

    function aiNormalizePath(value) {
        const raw = aiTextOf(value).replace(/\\/g, '/');
        if (!raw) return '';
        const scheme = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
        let prefix = '';
        let rest = raw;
        if (scheme) {
            prefix = scheme[1] + '://';
            rest = raw.slice(scheme[0].length);
        } else {
            const drive = raw.match(/^[A-Za-z]:/);
            if (drive) {
                prefix = drive[0];
                rest = raw.slice(2);
            }
        }
        const absolute = rest.startsWith('/');
        const parts = [];
        for (const segment of rest.split('/')) {
            if (!segment || segment === '.') continue;
            if (segment === '..') {
                if (parts.length) parts.pop();
                continue;
            }
            parts.push(segment);
        }
        return prefix + (absolute ? '/' : '') + parts.join('/');
    }

    function aiPathDir(value) {
        return aiTextOf(value).replace(/[\\/][^\\/]*$/, '');
    }

    function aiIsAbsolutePath(value) {
        const text = aiTextOf(value);
        return /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('/') || text.startsWith('\\\\') || text.startsWith('mock://');
    }

    function aiJoinPath(root, rel) {
        const base = aiTextOf(root).replace(/[\\/]+$/, '');
        if (!rel || rel === '.') return base;
        if (aiIsAbsolutePath(rel)) return rel;
        const useBackslash = base.includes('\\') && !base.startsWith('mock://');
        return base + (useBackslash ? '\\' : '/') + String(rel).replace(/^\.?[\\/]+/, '');
    }

    function aiProjectRoot() {
        const context = getWorkspaceContext() || {};
        const workspace = aiTextOf(context.workspaceFolder);
        if (workspace) return workspace;
        if (context.activeFile && context.activeFile.path) return aiPathDir(context.activeFile.path);
        return getScopeRoot() || '';
    }

    function aiWorkspaceKey(value) {
        return aiNormalizePath(value).replace(/\/+$/, '').toLowerCase();
    }

    // ---- 计划落盘（计划模式：正文进 .cadt/plan/，对话区只留入口卡） ----
    // 路径与正文由消息自身推导（ai-plan-file.js），同一消息任何一次渲染 / 重启重放都指向
    // 同一个文件，不依赖内存里记过的路径。

    function planFileTarget(message, sessionOverride) {
        if (!isPlanMessage(message)) return null;
        const ts = Number(message.ts) || Number(message.finishedAt) || 0;
        // 没有时间戳就没法给出稳定文件名——不落盘，对话里退回原文渲染
        if (!ts) return null;
        const session = sessionOverride || currentSession();
        // 根优先取会话记下的工作区：用户后来换了工作区也不会把旧计划写到新目录去
        const root = aiTextOf(session && session.workspace) || getScopeRoot() || aiProjectRoot();
        if (!root) return null;
        const rel = planFileRelPath(ts, message.content);
        return {
            rel,
            abs: aiNormalizePath(aiJoinPath(root, rel)),
            dir: aiNormalizePath(aiJoinPath(root, PLAN_DIR_REL)),
            body: planFileBody(message.content, {
                ts,
                title: (session && session.title) || '',
                model: message.model || '',
            }),
        };
    }

    // 先把路径记到消息上（同步）：轮次收尾的渲染立刻就能出卡片，写文件是异步副作用。
    function markPlanFile(message, session) {
        if (!message || message.planFile) return null;
        const target = planFileTarget(message, session);
        if (!target) return null;
        message.planFile = target.abs;
        return target;
    }

    function writePlanFile(target) {
        if (!target || !backend.AIEnsureDir || !backend.SaveFile) return Promise.resolve(false);
        return Promise.resolve()
            .then(() => backend.AIEnsureDir(target.dir))
            .then(() => backend.SaveFile(target.abs, target.body, 'lf', false, 'utf-8'))
            .then(() => {
                if (typeof onFileChanged === 'function') onFileChanged(target.abs);
                return true;
            });
    }

    // 打开计划文件。路径优先用消息上记下的绝对值——用户可能已经换了工作区，重算会把
    // 同一份计划写到新工作区去。只有从没落过盘的历史计划才按当前工作区推导。
    // 文件已存在就不重写：用户或许已经在标签页里改过它。
    async function openPlanFile(message) {
        if (!message) return false;
        const stored = aiTextOf(message.planFile);
        const target = stored
            ? {abs: stored, dir: aiPathDir(stored), body: null}
            : planFileTarget(message);
        if (!target || !target.abs) {
            flash('没有可打开的计划文件（计划只留在对话里）', true);
            return false;
        }
        try {
            if (message.planFile !== target.abs) {
                message.planFile = target.abs;
                persistSessions();
            }
            const stat = backend.GetFileStat ? await backend.GetFileStat(target.abs).catch(() => null) : null;
            if (!stat || !stat.exists) {
                // 补写正文：与首次落盘同一份内容（路径被删 / 上次写失败 / 历史计划）
                await writePlanFile(Object.assign({}, target, {
                    body: target.body != null ? target.body : planFileBody(message.content, {
                        ts: Number(message.ts) || Number(message.finishedAt) || 0,
                        title: (currentSession() && currentSession().title) || '',
                        model: message.model || '',
                    }),
                }));
            }
        } catch (e) {
            flash('计划文件写入失败：' + ((e && e.message) || e), true);
            return false;
        }
        openPath(target.abs);
        return true;
    }

    function aiWorkspaceName(value) {
        const normalized = aiNormalizePath(value).replace(/\/+$/, '');
        const index = normalized.lastIndexOf('/');
        return index >= 0 ? (normalized.slice(index + 1) || normalized) : normalized;
    }

    // 老会话没有 workspace 时，若其变更记录落在某个已知工作区内，就按最长前缀归属。
    function inferSessionWorkspace(session, knownWorkspaces) {
        const paths = (session && Array.isArray(session.changes) ? session.changes : [])
            .map((change) => aiWorkspaceKey(change && change.path))
            .filter(Boolean);
        if (!paths.length || !Array.isArray(knownWorkspaces) || !knownWorkspaces.length) return '';
        let best = '';
        let bestLength = 0;
        for (const workspace of knownWorkspaces) {
            const key = aiWorkspaceKey(workspace);
            if (!key) continue;
            const hit = paths.some((path) => path === key || path.startsWith(key + '/'));
            if (hit && key.length > bestLength) {
                best = workspace;
                bestLength = key.length;
            }
        }
        return best;
    }

    function currentWorkspacePath() {
        const context = getWorkspaceContext() || {};
        const folder = aiTextOf(context.workspaceFolder);
        if (folder) return aiNormalizePath(folder);
        if (context.activeFile && context.activeFile.path) {
            return aiNormalizePath(aiPathDir(context.activeFile.path));
        }
        return '';
    }

    function sessionWorkspacePath(session) {
        return session && session.workspace ? aiNormalizePath(session.workspace) : '';
    }

    // 打开/切换到某个会话时对齐应用工作区：会话有工作区就切过去，
    // 老会话没有工作区则绑定到当前工作区（只绑定一次）。
    function syncWorkspaceToSession(session) {
        if (!session) return '';
        const target = sessionWorkspacePath(session);
        if (!target) {
            const current = currentWorkspacePath();
            if (!current) return '';
            session.workspace = current;
            return 'assigned';
        }
        const current = currentWorkspacePath();
        if (current && aiWorkspaceKey(current) === aiWorkspaceKey(target)) return '';
        if (!openWorkspaceFolder) return '';
        try {
            const result = openWorkspaceFolder(target, session.id);
            if (result === false) return '';
            if (result === 'window') {
                flash('已在新窗口打开工作区：' + (aiWorkspaceName(target) || target) + '（会话将在该窗口继续）');
                return 'window';
            }
            flash('已切换到工作区：' + (aiWorkspaceName(target) || target));
            return 'switched';
        } catch (e) {
            flash('切换工作区失败：' + (e && e.message || e), true);
            return '';
        }
    }

    function aiPathInside(root, path) {
        const r = aiNormalizePath(root).replace(/\/+$/, '').toLowerCase();
        const p = aiNormalizePath(path).toLowerCase();
        if (!r) return false;
        return p === r || p.startsWith(r + '/');
    }

    function aiResolveScopePath(value, session) {
        const root = getScopeRoot() || '';
        const rel = aiTextOf(value).trim() || '.';
        const absolute = aiIsAbsolutePath(rel);
        if (currentScopeOf(session || currentSession()) === 'full') {
            if (!root && !absolute) throw new Error('完全权限下没有工作区，请提供绝对路径');
            return absolute ? aiNormalizePath(rel) : aiNormalizePath(aiJoinPath(root, rel));
        }
        if (!root) throw new Error('当前没有工作区范围，请先打开文件或文件夹');
        const path = absolute ? aiNormalizePath(rel) : aiNormalizePath(aiJoinPath(root, rel));
        if (!aiPathInside(root, path)) {
            // 读工具（read_file/list_dir）捕获该标记走授权链 resolveReadPathWithApproval
            // （点名直读 / 已批准读根 / 按档审批）；写工具不捕获，行为与文案保持不变。
            const err = new Error('路径超出工作区范围：' + rel);
            err.outOfWorkspace = true;
            err.absPath = path;
            throw err;
        }
        return path;
    }

    function readRootsOf(session) {
        return normalizeReadRoots(session && session.readRoots);
    }

    // 审批记住的目录粒度：越界文件的父目录；父目录是盘符根时退化为文件自身
    // （避免一次批准整个盘）。
    function readRootDirOf(abs) {
        const path = normalizeReadRoot(abs);
        const idx = path.lastIndexOf('/');
        if (idx < 0) return path;
        const parent = path.slice(0, idx);
        return /^[A-Za-z]:$/.test(parent) ? path : parent;
    }

    // 工作区外读取的授权链（各读类工具共用）。按「谁想读」分流：
    // ① 应用数据目录任何档位硬拒（密钥不进转录落盘）；
    // ② 用户点名（含子代理回查父会话）直接读——审批只区分「谁想读」；
    // ③ 已批准读根（会话 readRoots / config.approvedReadRoots / 项目规则 Read(...)）直接读；
    // ④ auto 档直接读（契约即非风险自主执行，命令通道本就绕行）；read/edit 档弹审批卡；
    // ⑤ 子代理永不弹卡（接管卡按 currentSession 匹配，子会话不可达会永久悬挂），指引报回主代理。
    // full 档在 aiResolveScopePath 就已放行（应用数据目录硬拒仍先于放行执行）。留痕口径：
    // 点名/已批准的例行读不记审计，只记「模型起意」的放行（auto / 项目规则）与全部拒绝。
    // opts.scanRoot：扫描类工具（search_text / glob）的目录起点——多挡一层「起点包含应用数据目录」，
    // 且审批「记住」的粒度是目录本身（单文件读取记父目录）。
    async function resolveReadPathWithApproval(ctx, toolName, inputPath, opts) {
        const session = ctx && ctx.session;
        let abs = '';
        let inScope = false;
        try {
            abs = aiResolveScopePath(inputPath, session);
            inScope = true;
        } catch (e) {
            if (!e || !e.outOfWorkspace) throw e;
            abs = e.absPath;
        }
        // 硬拒先于「在范围内」提前返回：full 档与工作区内路径同样不能读应用数据目录
        //（full 档曾因提前返回绕过此检查，2026-11-16 实测修复）。
        const denyReason = hardReadDenyReason(abs, await getAIAppDir(), opts);
        if (denyReason) return {ok: false, message: denyReason};
        if (inScope) return {ok: true, path: abs};
        const parent = session && session.parentSessionId ? sessionById(session.parentSessionId) : null;
        const named = userNamedPath(session, abs) || (parent ? userNamedPath(parent, abs) : false);
        const covered = readRootCoversAny(readRootsOf(session), abs) ||
            (parent ? readRootCoversAny(readRootsOf(parent), abs) : false) ||
            readRootCoversAny(config.approvedReadRoots, abs);
        const decision = decidePermission({
            scope: currentScopeOf(session),
            kind: 'read',
            rules: await ensureProjectRules(false),
            subject: writeRuleSubject(abs),
            sessionAllow: named || covered,
        });
        if (decision.decision === 'deny') {
            logPermission('read', abs, 'deny', decision.source, decision.rule);
            return {ok: false, message: '项目权限规则禁止读取该路径（' + decision.rule + '）。'};
        }
        if (decision.decision === 'allow') {
            if (!named && !covered) logPermission('read', abs, 'allow', decision.source, decision.rule);
            return {ok: true, path: abs};
        }
        if (session && session.parentSessionId) {
            return {ok: false, message: '该路径在工作区外且未获授权（权限档 ' + currentScopeOf(session) +
                '）。子代理不弹审批卡：请通过 agent_send 向主代理说明需要读取的目录，' +
                '由主代理发起授权；获准后重试本读取。'};
        }
        const answer = await requestReadApproval(ctx, toolName, abs, opts);
        if (!answer || !answer.approved) {
            return {ok: false, message: '用户未授权读取工作区外路径：' + abs +
                '。不要重复尝试该路径；如确有必要，向用户说明需要读取该目录并等待其授权。'};
        }
        return {ok: true, path: abs};
    }

    function requestReadApproval(ctx, toolName, abs, opts) {
        const session = ctx && ctx.session;
        const toolMessage = ctx && ctx.toolMessage;
        if (!session || !toolMessage) return Promise.resolve({approved: false});
        const approval = {
            state: 'pending',
            kind: 'read',
            tool: toolName || 'read_file',
            path: abs,
            relPath: abs,
            // 扫描类工具的授权对象就是目录本身，记住它；单文件读取记住父目录
            rootDir: opts && opts.scanRoot ? normalizeReadRoot(abs) : readRootDirOf(abs),
            isDir: !!(opts && opts.scanRoot),
            remember: '',
        };
        // scanRoot 只是「授权粒度记目录本身」；动词按工具名取——递归 list_dir 也走 scanRoot，
        // 但它不是搜索（此前会误弹「想搜索工作区外…」）
        const verb = toolName === 'list_dir' ? '列目录' : (opts && opts.scanRoot ? '搜索' : '读取');
        return registerPendingApproval(session, toolMessage, approval,
            (session.title || '会话') + ' · 想' + verb + '工作区外 ' + abs + '，需要你确认');
    }

    // 扫描类工具（search_text / glob）的起点解析：缺省用范围根；显式 path 走 read_file
    // 同一条授权链（点名 / 已批准根 / 按档审批），并额外要求是已存在目录——Go 扫描
    // 会把文件路径静默改成父目录，实际范围会比模型预期的大。目录校验放在审批之前，
    // 避免让用户批准一个不存在的路径。两条路径都先过 hardReadDenyReason
    //（应用数据目录内 / 包含应用数据目录的起点一律拒绝）。
    async function resolveScanRoot(ctx, toolName, inputPath) {
        const start = aiTextOf(inputPath).trim();
        if (!start) {
            const scopeRoot = getScopeRoot() || '';
            if (!scopeRoot) {
                return {ok: false, message: '当前没有工作区范围，请先打开文件或文件夹，或用 path 指定目录'};
            }
            // 默认扫描根也受硬拒约束：工作区若覆盖应用数据目录，不能整树扫进密钥与会话数据
            const denyReason = hardReadDenyReason(scopeRoot, await getAIAppDir(), {scanRoot: true});
            if (denyReason) return {ok: false, message: denyReason};
            return {ok: true, path: scopeRoot};
        }
        let abs = '';
        try {
            abs = aiResolveScopePath(start, ctx && ctx.session);
        } catch (e) {
            if (!e || !e.outOfWorkspace) throw e;
            abs = e.absPath;
        }
        if (backend.GetPathInfo) {
            let info = null;
            try {
                info = await backend.GetPathInfo(abs);
            } catch (e) {
                info = null;
            }
            if (!info) return {ok: false, message: '目录不存在或不可访问：' + abs};
            if (!info.isDir) {
                return {ok: false, message: 'path 必须是目录：' + start + '（读单个文件请用 read_file）'};
            }
        }
        return resolveReadPathWithApproval(ctx, toolName, start, {scanRoot: true});
    }

    function getAIAppDir() {
        if (!appDirPromise) {
            appDirPromise = Promise.resolve(backend.AIAppDir ? backend.AIAppDir() : '').catch(() => '');
        }
        return appDirPromise;
    }

    async function resolveMemoryDir() {
        const project = aiProjectRoot();
        if (config.memoryMode === 'workspace' && project) {
            return {dir: aiNormalizePath(aiJoinPath(project, '.cadt/memory')), mode: 'workspace', project};
        }
        const app = aiNormalizePath(await getAIAppDir());
        if (!app) throw new Error('无法定位应用数据目录');
        if (config.memoryMode === 'workspace' && !project && !memoryFallbackNotified) {
            memoryFallbackNotified = true;
            flash('未打开工作区，记忆临时使用应用数据目录');
        }
        return {dir: aiNormalizePath(aiJoinPath(app, 'ai-memory')), mode: 'app', project};
    }

    // 技能扫描顺序对齐 dsh 的本地提供方：rank 越小越优先。
    const AI_SKILL_RANKS = {workspace: 100, workspaceAgents: 200, app: 400, userAgents: 500, builtin: 600};

    let homeDirPromise = null;
    function getAIHomeDir() {
        if (!homeDirPromise) {
            homeDirPromise = Promise.resolve(backend.AIHomeDir ? backend.AIHomeDir() : '')
                .then((dir) => aiNormalizePath(dir || ''))
                .catch(() => '');
        }
        return homeDirPromise;
    }

    let builtinSkillsDirPromise = null;
    function getAIBuiltinSkillsDir() {
        if (!builtinSkillsDirPromise) {
            builtinSkillsDirPromise = Promise.resolve(backend.AIBuiltinSkillsDir ? backend.AIBuiltinSkillsDir() : '')
                .then((dir) => aiNormalizePath(dir || ''))
                .catch(() => '');
        }
        return builtinSkillsDirPromise;
    }

    async function resolveSkillDirs() {
        const dirs = [];
        const project = aiProjectRoot();
        if (project) {
            dirs.push({source: 'workspace', dir: aiNormalizePath(aiJoinPath(project, '.cadt/skills')), rank: AI_SKILL_RANKS.workspace});
            dirs.push({source: 'workspace-agents', dir: aiNormalizePath(aiJoinPath(project, '.agents/skills')), rank: AI_SKILL_RANKS.workspaceAgents});
        }
        const app = aiNormalizePath(await getAIAppDir());
        if (app) dirs.push({source: 'app', dir: aiNormalizePath(aiJoinPath(app, 'ai-skills')), rank: AI_SKILL_RANKS.app});
        const home = await getAIHomeDir();
        if (home) dirs.push({source: 'user-agents', dir: aiNormalizePath(aiJoinPath(home, '.agents/skills')), rank: AI_SKILL_RANKS.userAgents});
        const builtin = await getAIBuiltinSkillsDir();
        if (builtin) dirs.push({source: 'builtin', dir: builtin, rank: AI_SKILL_RANKS.builtin});
        return dirs;
    }

    async function readTextFile(path, maxChars) {
        if (!backend.OpenFile) throw new Error('当前版本不支持读取文件');
        const data = await backend.OpenFile(path, 'auto');
        if (!data) throw new Error('读取失败');
        if (data.isDir) throw new Error('这是目录，不是文件');
        if (data.large) throw new Error('文件过大（>10 MB）');
        if (data.binary) throw new Error('二进制文件不可作为文本读取');
        let text = aiTextOf(data.content);
        if (maxChars && text.length > maxChars) text = text.slice(0, maxChars) + '\n…（已截断）';
        return {text, data};
    }

    // 视频附件/ read_video 的读取通道：Go 侧 ReadVideoAsDataURL（mp4 白名单 + ftyp 魔数 + 16 MB 上限）
    async function readVideoFile(path) {
        if (!backend.ReadVideoAsDataURL) throw new Error('当前版本不支持读取视频');
        return backend.ReadVideoAsDataURL(path);
    }

    function parseSkillText(text, fallbackName) {
        let name = fallbackName;
        let description = '';
        let body = text;
        if (text.startsWith('---')) {
            const end = text.indexOf('\n---', 3);
            if (end > 0) {
                const front = text.slice(3, end);
                body = text.slice(end + 4).replace(/^\r?\n/, '');
                for (const line of front.split(/\r?\n/)) {
                    const nameMatch = line.match(/^\s*name:\s*(.*)$/i);
                    const descMatch = line.match(/^\s*description:\s*(.*)$/i);
                    if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, '') || name;
                    if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, '');
                }
            }
        }
        if (!description) {
            for (const line of body.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#') || trimmed === '---') continue;
                description = trimmed.slice(0, 80);
                break;
            }
        }
        return {name: name || fallbackName, description: description || '（无描述）', content: text};
    }

    let skillsCache = {at: 0, list: []};

    let exePathPromise = null;
    function getAIExePath() {
        if (!exePathPromise) {
            exePathPromise = Promise.resolve(backend.AIExePath ? backend.AIExePath() : '').catch(() => '');
        }
        return exePathPromise;
    }

    async function builtinSkillText(text) {
        if (!text.includes('{{EXE_PATH}}')) return text;
        const exe = String(await getAIExePath() || '').trim();
        return text.split('{{EXE_PATH}}').join(exe || 'datalens.exe');
    }

    function skillSourceLabel(source) {
        if (source === 'builtin') return '内置';
        if (source === 'workspace') return '工作区';
        if (source === 'workspace-agents') return '工作区·通用';
        if (source === 'user-agents') return '用户·通用';
        return '应用';
    }

    async function listSkillsRaw(force) {
        if (!force && Date.now() - skillsCache.at < 5000) return skillsCache.list;
        const candidates = [];
        for (let index = 0; index < AI_BUILTIN_SKILLS.length; index += 1) {
            const builtin = AI_BUILTIN_SKILLS[index];
            // 应用操作关闭时 cadt-ui 技能一并隐藏（避免模型加载用不到的动作表）
            if (builtin.name === 'cadt-ui' && !appControlOn()) continue;
            candidates.push({
                name: builtin.name,
                description: builtin.description,
                path: '',
                source: 'builtin',
                content: await builtinSkillText(builtin.content),
                builtin: true,
                rank: AI_SKILL_RANKS.builtin,
                rootOrder: 0,
                localOrder: index,
            });
        }
        let rootOrder = 0;
        for (const root of await resolveSkillDirs()) {
            rootOrder += 1;
            let listing;
            try {
                listing = await backend.ReadDir(root.dir, 500);
            } catch (e) {
                continue;
            }
            const entries = ((listing && listing.entries) || [])
                .filter((entry) => entry && entry.isDir !== undefined)
                .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
            let localOrder = 0;
            for (const entry of entries) {
                let path = null;
                let fallback = entry.name;
                if (entry.isDir) {
                    path = aiJoinPath(entry.path, 'SKILL.md');
                    if (!entry.name) fallback = 'skill';
                } else if (String(entry.name || '').toLowerCase().endsWith('.md')) {
                    path = entry.path;
                    fallback = String(entry.name).replace(/\.md$/i, '');
                }
                if (!path) continue;
                let read;
                try {
                    read = await readTextFile(path, 64 << 10);
                } catch (e) {
                    continue;
                }
                const skill = parseSkillText(read.text, fallback);
                candidates.push({
                    name: skill.name,
                    description: skill.description,
                    path,
                    source: root.source,
                    content: read.text,
                    builtin: false,
                    rank: root.rank,
                    rootOrder,
                    localOrder,
                });
                localOrder += 1;
            }
        }
        // rank 小者优先；同 rank 按根注册顺序，再按根内条目名顺序，先到先得。
        candidates.sort((a, b) => a.rank - b.rank || a.rootOrder - b.rootOrder || a.localOrder - b.localOrder);
        const merged = new Map();
        for (const candidate of candidates) {
            if (!merged.has(candidate.name)) merged.set(candidate.name, candidate);
        }
        const disabled = new Set((config.disabledSkills || []).map((name) => String(name).toLowerCase()));
        const list = [...merged.values()].map((skill) => ({
            ...skill,
            disabled: disabled.has(skill.name.toLowerCase()),
        })).sort((a, b) => a.name.localeCompare(b.name));
        skillsCache = {at: Date.now(), list};
        return list;
    }

    async function listSkills(force) {
        return (await listSkillsRaw(force)).filter((skill) => !skill.disabled);
    }

    function invalidateSkillsCache() {
        skillsCache = {at: 0, list: []};
    }


    // 应用操作开关（设置 → AI → 权限 → AI 工具权限）：关闭时工具从列表移除、执行器硬拒绝、cadt-ui 技能隐藏
    function appControlOn() {
        return config.appControlEnabled !== false;
    }

    // ---- 外部工具来源（设置 → AI → 外部工具；config 真源在 Go 的 external-tools.json）----
    // 工具可见性与执行路由共用这一份缓存：provider 缺 key / MCP 绑定失效都按 off 处理。
    let externalToolsConfig = defaultExternalToolsConfig();
    let externalToolsConfigLoaded = false;
    let externalToolsConfigPending = null;

    async function loadExternalToolsConfig(force = false) {
        if (!force && externalToolsConfigLoaded) return externalToolsConfig;
        if (!externalToolsConfigPending) {
            externalToolsConfigPending = (async () => {
                try {
                    if (typeof backend.WebToolsConfigGet === 'function') {
                        externalToolsConfig = normalizeExternalToolsConfig(await backend.WebToolsConfigGet());
                        externalToolsConfigLoaded = true;
                    }
                } catch (e) {
                    // 读取失败保留默认值（搜索/抓取内置、其余关闭），不阻塞面板
                } finally {
                    externalToolsConfigPending = null;
                }
                return externalToolsConfig;
            })();
        }
        return externalToolsConfigPending;
    }

    function externalMcpToolNames() {
        return mcpMod.mcpToolDefs().map((def) => def.name);
    }

    function externalModeOf(capability) {
        return effectiveExternalMode(externalToolsConfig, capability, externalMcpToolNames());
    }

    function externalProviderHost() {
        try {
            return new URL(externalToolsConfig.baseUrl || DEFAULT_PROVIDER_BASE_URL).host;
        } catch (e) {
            return 'api.deepseek.com';
        }
    }

    // 工具定义表与权限档工具清单（阶段 3 拆出：ai-tool-defs.js）
    // MCP 客户端前端逻辑层（ai-mcp.js）：registry 只被 Go 的整代快照替换（§5.4）
    const mcpMod = createAIMcp({backend, flash});
    // MCP 设置页（ai-mcp-settings.js）：配置读写走 Go，状态走 mcpMod 快照
    const mcpSettingsMod = createAIMcpSettings({
        backend,
        flash,
        confirmAction: askConfirm,
        getMcpState: () => mcpMod.getState(),
        onChanged: () => Promise.resolve(mcpMod.refresh()).catch(() => {}), // 尽力而为：保存后拉一次新配置的快照
        // 服务器编辑器走独立弹层（与「添加生图模型」同一套居中弹窗）
        openAIDialog,
        closeAIDialog,
        dialogButton,
    });
    const toolDefsMod = createAIToolDefs({
        appControlOn,
        mcpToolDefs: () => mcpMod.mcpToolDefs(),
        // 生图/视频：配置了启用条目才下发 generate_image / generate_video / check_gen
        genModelsOn: () => (config.genModels || []).some((item) => item && item.enabled !== false),
        // 外部工具：按能力的实际来源（off/provider/mcp/builtin）与权限档决定是否下发
        externalToolsOn: (capability, scope, planMode) =>
            externalCapabilityUsable(capability, externalModeOf(capability), scope, planMode),
    });
    const toolsForScope = (scope, planMode) => toolDefsMod.toolsForScope(scope, planMode);
    // 系统提示词组装域（ai-system-context.js）：面板闭包状态经 getter 注入——config 是可变 let、
    // settings 属性可变，必须走活引用而不是值快照（splitRoot 教训）。
    const systemCtxMod = createAISystemContext({
        get settings() { return settings; },
        get config() { return config; },
        get effectiveSystemPrompt() { return effectiveSystemPrompt; },
        get aiProjectRoot() { return aiProjectRoot; },
        get aiJoinPath() { return aiJoinPath; },
        get readTextFile() { return readTextFile; },
        get resolveMemoryDir() { return resolveMemoryDir; },
        get aiDisplayPath() { return aiDisplayPath; },
        get aiDisplayRootLabel() { return aiDisplayRootLabel; },
        get aiNormalizePath() { return aiNormalizePath; },
        get listSkills() { return listSkills; },
        get skillSourceLabel() { return skillSourceLabel; },
        get listEnvVarsForAI() { return listEnvVarsForAI; },
        get toolCatalogText() { return toolDefsMod.toolCatalogText; },
        get currentScopeOf() { return currentScopeOf; },
        get getWorkspaceContext() { return getWorkspaceContext; },
        get getScopeRoot() { return getScopeRoot; },
        // 支线定性块要显示主对话标题（<side_chat> 里点名「主对话：「X」」），按 id 查会话
        get sessionById() { return sessionById; },
        // 隔离 worktree 块：会话持有活跃 worktree 时每轮注入（含目录存在性校验与失效清登记）
        get worktreeBlock() { return worktreeMod.blockFor; },
    });
    const assembleSystemContext = (session, attachmentList) => systemCtxMod.assembleSystemContext(session, attachmentList);
    const planModeBlock = () => systemCtxMod.planModeBlock();

    const MEMORY_NAME_RULE = /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,64}\.md$/i;

    // ---- 浏览器使用（每会话独立标签页 + 独立 profile）----

    async function ensureBrowserTab(session) {
        if (!browserHost) throw new Error('浏览器宿主不可用');
        if (session.browserTabId) {
            try {
                const st = await backend.BrowserState(session.browserTabId);
                if (st && st.id) return {id: session.browserTabId, state: st};
            } catch (e) {}
            session.browserTabId = '';
        }
        const opened = await runHostAppAction('open_browser_tab', {
            url: 'about:blank',
            profileKey: 'sess-' + session.id,
        });
        session.browserTabId = opened && opened.browserTab ? opened.browserTab.id : '';
        if (!session.browserTabId) throw new Error('浏览器标签页创建失败');
        persistSessions();
        return {id: session.browserTabId, state: null};
    }

    // ExecuteScript 返回 {result:{value:"<json>"}}；把脚本结果对象解出来
    function browserEvalObject(raw) {
        // WebView2 ExecuteScript 的返回就是「脚本结果值的 JSON 序列化」——不是 CDP
        // Runtime.evaluate 的 {result:{value}} 包装（CallCDP 通道已禁用，见
        // browser_windows.go BrowserEval 上方注释）。此前按 CDP 形态解包导致
        // 恒为 undefined：browser_evaluate 的 .slice、browser_click 的「点击失败」
        // browser_snapshot 的 reading 'title' 都是这一个根因（2026-11-14）。
        // 脚本若 return JSON.stringify(...) 会得到二次编码的字符串，这里再解一层。
        let outer;
        try {
            outer = JSON.parse(raw);
        } catch (e) {
            throw new Error('脚本结果解析失败（外层）');
        }
        if (typeof outer === 'string') {
            try {
                return JSON.parse(outer);
            } catch (e) {
                return outer;
            }
        }
        return outer;
    }

    function browserSnapshotText(page) {
        const lines = [
            '页面：' + (page.title || '（无标题）') + ' — ' + (page.url || ''),
        ];
        const text = String(page.text || '').replace(/\s+/g, ' ').trim();
        if (text) {
            lines.push('文本摘要：' + (text.length > 1500 ? text.slice(0, 1500) + '…（已截断）' : text));
        }
        if (Array.isArray(page.inputs) && page.inputs.length) {
            lines.push('可交互元素：');
            for (const el of page.inputs.slice(0, 30)) {
                lines.push('- ' + el.tag + (el.type ? '[' + el.type + ']' : '') +
                    (el.id ? '#' + el.id : '') + (el.name ? '[name=' + el.name + ']' : '') +
                    (el.value ? ' 值=' + el.value : '') + (el.selector ? ' 选择器=' + el.selector : ''));
            }
        }
        if (Array.isArray(page.links) && page.links.length) {
            lines.push('链接（前 ' + Math.min(page.links.length, 30) + ' 个）：');
            for (const link of page.links.slice(0, 30)) {
                if (link.text || link.href) lines.push('- ' + (link.text || '(无文本)') + ' → ' + link.href);
            }
        }
        if (lines.length === 1) lines.push('（页面为空）');
        return lines.join(String.fromCharCode(10));
    }

    // 环境变量（AI 视角）：只取名称/描述/启用状态，值永远不出现在 AI 可见文本里
    async function listEnvVarsForAI() {
        if (!backend.GetEnvVars) return [];
        const snap = await backend.GetEnvVars();
        const vars = (snap && Array.isArray(snap.vars)) ? snap.vars : [];
        return vars
            .filter((v) => v && v.name)
            .map((v) => ({
                name: String(v.name),
                description: String(v.description || ''),
                enabled: v.enabled !== false,
            }));
    }

    // env_list 中启用中的变量名（命令审批的密钥泄漏硬拦截名单；只取名字，值不可见）。
    // 未启用的变量不注入终端子进程，引用它拿不到值，不进名单。
    async function managedEnvVarNames() {
        try {
            const vars = await listEnvVarsForAI();
            return vars.filter((v) => v.enabled).map((v) => v.name);
        } catch (e) {
            return [];
        }
    }

    function memoryFileName(value) {
        const name = String(value == null ? '' : value).trim();
        if (!MEMORY_NAME_RULE.test(name) || name.includes('..')) throw new Error('记忆文件名无效（仅允许安全字符且以 .md 结尾）');
        return name;
    }

    // ---------- 行 diff 与写审批 ----------

    function aiPathKey(path) {
        return aiNormalizePath(path).replace(/\/+$/, '').toLowerCase();
    }

    function aiRelPath(root, path) {
        const base = aiNormalizePath(root).replace(/\/+$/, '');
        const full = aiNormalizePath(path);
        if (base && full.toLowerCase().startsWith(base.toLowerCase() + '/')) return full.slice(base.length + 1);
        return full;
    }

    // 给模型看的路径：工作区内用相对路径；工作区外只留文件名，避免把用户名/盘符/目录结构发出去。
    function aiDisplayPath(value, root) {
        const full = aiNormalizePath(value);
        if (!full) return '';
        const base = aiNormalizePath(root == null ? getScopeRoot() : root).replace(/\/+$/, '');
        if (base) {
            if (full.toLowerCase() === base.toLowerCase()) return '.';
            if (full.toLowerCase().startsWith(base.toLowerCase() + '/')) return full.slice(base.length + 1);
        }
        const parts = full.split('/').filter(Boolean);
        return parts.length ? '（范围外）' + parts[parts.length - 1] : '（范围外）';
    }

    // 成段文本给模型看的口径：非完全权限档下把工具报错里的真实绝对路径收敛掉
    //（Go 的 `GetFileAttributesEx D:/…` 会把盘符与目录结构一起带回模型）。
    // 单条路径走 aiDisplayPath；两者边界口径一致：只有 full 档不设边界。
    function redactToolText(text, session) {
        return redactScopePaths(text, getScopeRoot(), currentScopeOf(session || currentSession()));
    }

    function aiDisplayRootLabel(root) {
        const parts = aiNormalizePath(root).replace(/\/+$/, '').split('/').filter(Boolean);
        return parts.length ? parts[parts.length - 1] : '（未打开工作区）';
    }

    const permissionAudit = [];
    const PERMISSION_AUDIT_LIMIT = 60;

    function logPermission(kind, subject, decision, source, rule) {
        permissionAudit.push({
            at: Date.now(),
            kind,
            subject: String(subject || '').slice(0, 300),
            decision,
            source: source || '',
            rule: rule || '',
        });
        if (permissionAudit.length > PERMISSION_AUDIT_LIMIT) {
            permissionAudit.splice(0, permissionAudit.length - PERMISSION_AUDIT_LIMIT);
        }
        // 操作留痕：审批判定落盘（allow/deny 才是终局判定，ask 只是弹窗提示）。
        if (decision === 'allow' || decision === 'deny') {
            logActivity(decision === 'allow' ? 'ai.approve' : 'ai.deny', subject, {
                kind,
                rule: rule || undefined,
            }, {actor: 'user', source: source || 'user'});
        }
        renderPermissionSettings();
    }

    // 用户裁定的留痕要带审批卡上下文（端侧 score / 远程复核结论）：否则「拒绝」这条最重要的
    // 个性化学习信号在留痕里完全不可追溯——分不清是模型判险、解析失败还是别的规则接住。
    function approvalAuditRule(approval) {
        if (!approval || !approval.classifyNote) return '';
        return aiTextOf(approval.classifyNote).replace(/\s+/g, ' ').slice(0, 160);
    }

    function diffLinesOf(text) {
        const normalized = aiTextOf(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (!normalized) return [];
        const lines = normalized.split('\n');
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        return lines;
    }

    function computeLineDiff(oldText, newText) {
        const a = diffLinesOf(oldText);
        const b = diffLinesOf(newText);
        const ops = [];
        if (a.length + b.length > AI_DIFF_MAX_LINES || a.length * b.length > 4000000) {
            let start = 0;
            while (start < a.length && start < b.length && a[start] === b[start]) start++;
            let endA = a.length;
            let endB = b.length;
            while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
                endA--;
                endB--;
            }
            for (let i = 0; i < start; i++) ops.push({t: ' ', text: a[i]});
            for (let i = start; i < endA; i++) ops.push({t: '-', text: a[i]});
            for (let j = start; j < endB; j++) ops.push({t: '+', text: b[j]});
            for (let i = endA; i < a.length; i++) ops.push({t: ' ', text: a[i]});
            return ops;
        }
        const n = a.length;
        const m = b.length;
        const dp = new Array(n + 1);
        for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                dp[i][j] = a[i] === b[j]
                    ? dp[i + 1][j + 1] + 1
                    : Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < n && j < m) {
            if (a[i] === b[j]) {
                ops.push({t: ' ', text: a[i]});
                i++;
                j++;
            } else if (dp[i + 1][j] >= dp[i][j + 1]) {
                ops.push({t: '-', text: a[i]});
                i++;
            } else {
                ops.push({t: '+', text: b[j]});
                j++;
            }
        }
        while (i < n) ops.push({t: '-', text: a[i++]});
        while (j < m) ops.push({t: '+', text: b[j++]});
        return ops;
    }

    function diffStats(ops) {
        let added = 0;
        let removed = 0;
        for (const op of ops) {
            if (op.t === '+') added++;
            else if (op.t === '-') removed++;
        }
        return {added, removed};
    }

    function buildDiffPreview(ops) {
        const keep = new Array(ops.length).fill(false);
        let changed = false;
        for (let i = 0; i < ops.length; i++) {
            if (ops[i].t === ' ') continue;
            changed = true;
            for (let k = Math.max(0, i - 2); k <= Math.min(ops.length - 1, i + 2); k++) keep[k] = true;
        }
        if (!changed && ops.length) keep[0] = true;
        const lines = [];
        let last = -1;
        let truncated = false;
        for (let i = 0; i < ops.length; i++) {
            if (!keep[i]) continue;
            if (last >= 0 && i > last + 1) {
                if (lines.length >= AI_DIFF_PREVIEW_LIMIT) {
                    truncated = true;
                    break;
                }
                lines.push({t: '…', text: ''});
            }
            if (lines.length >= AI_DIFF_PREVIEW_LIMIT) {
                truncated = true;
                break;
            }
            lines.push({t: ops[i].t, text: ops[i].text});
            last = i;
        }
        return {lines, truncated};
    }

    async function readOptionalText(path) {
        try {
            const read = await readTextFile(path, null);
            return {exists: true, text: read.text, data: read.data};
        } catch (e) {
            const message = String((e && e.message) || e);
            if (/not exist|no such file|cannot find|找不到|不存在/i.test(message)) {
                return {exists: false, text: '', data: null};
            }
            throw e;
        }
    }

    // 等待用户拍板的统一提醒（读/写审批、命令审批、环境变量待填写共用）。
    // 只有「AI 面板开着、停在这个会话、且软件在前台」才算人就在看，否则打未读并通知——
    // 这些等待**都没有超时**，不提醒等于让这一轮挂在用户看不见的地方永不结束。
    // 系统通知的实际弹出还受 notifySystem 与「前台不弹」约束（见 notifyDesktop）。
    function markWaitingOnUser(session, approval, title, body) {
        if (!session) return;
        setSessionUnread(session, 'done');
        if (config.notifyApprove === false) return;
        // 口径与「AI 提问」一致：消息中心**一律**记一条（可事后查、点击跳转），
        // 弹不弹系统卡片由 notifyDesktop 的前台判断决定。别把「要不要记」也交给前台条件——
        // 那样人在前台看着面板时审批会一点痕迹都不留（实测就是这么漏的）。
        notifyDesktop({kind: 'error', title, body, sessionId: session.id});
        // 人正看着这张卡（面板开着该会话 + 软件在前台）就不用再排 60 秒催办。
        appReallyForeground().then((active) => {
            if (active && isOpen() && currentSession() === session) return;
            setTimeout(() => {
                if (approval && approval.state && approval.state !== 'pending') return;
                notifyDesktop({
                    kind: 'error',
                    title: title + '（仍在等待）',
                    body: (session.title || '会话') + ' · 已等待超过 1 分钟，后台轮次被卡住',
                    sessionId: session.id,
                });
            }, 60000);
        });
    }

    // 审批登记的公共路径（write 与 read 审批共用）：登记 pendingApprovals、刷新接管区与列表；
    // 后台轮次（用户没在看该会话）打未读 + 桌面通知，60 秒后再提醒一次——不自动放行。
    function registerPendingApproval(session, toolMessage, approval, notifyBody) {
        toolMessage.approval = approval;
        toolMessage.status = 'pending';
        toolMessage.content = '等待用户审批…';
        persistSessions();
        refreshToolWrap(session, toolMessage);
        const key = toolMessage.toolCallId || aiNowId('approval-');
        const entry = {session, toolMessage, resolve: null, approval};
        pendingApprovals.set(key, entry);
        // 先登记再刷新接管区：查找逻辑依赖 pendingApprovals 已有条目。
        updateComposerTakeover(true);
        // 列表条目的「待确认」状态跟着审批走（用户可能正在看别的会话）。
        renderSessionList();
        // 后台轮次触发审批（§4.14.1）：接管卡只渲染「当前查看会话」的审批，而写操作审批没有
        // 超时——不通知就等于让这一轮挂在用户看不见的输入区里永不结束。**不自动放行**，
        // 只做「可见 + 可跳转」：桌面通知带 sessionId（消息中心点击即跳），条目打未读。
        markWaitingOnUser(session, approval, 'AI 待审批', notifyBody);
        return new Promise((resolve) => {
            entry.resolve = resolve;
        });
    }

    function requestApproval(session, toolMessage, info) {
        const approval = {
            state: 'pending',
            tool: info.tool,
            path: info.path,
            relPath: info.relPath,
            added: info.added,
            removed: info.removed,
            newFile: info.newFile,
            dirty: isFileDirty(info.path),
            truncated: info.truncated,
            diff: info.diff,
            remember: '',
        };
        return registerPendingApproval(session, toolMessage, approval,
            (session.title || '会话') + ' · ' + (info.relPath || info.tool || '操作') + ' 需要你确认');
    }

    // ---- 后台命令（background_command）----
    // 实时输出：cmd-out 广播 → bgLog（限长）→ 节流重渲卡片；面板关闭时只更新数据。

    function bgLiveAppend(session, message, stream, data) {
        if (!message || !message.bg) return;
        let live = bgJobLive.get(message.bg.jobId);
        if (!live) {
            live = {session, message, lines: [], text: '', timer: 0};
            bgJobLive.set(message.bg.jobId, live);
        }
        live.session = session;
        live.message = message;
        live.lines.push((stream === 'err' ? '[stderr] ' : '') + data);
        if (live.lines.length > AI_BG_LIVE_MAX_LINES) live.lines.splice(0, live.lines.length - AI_BG_LIVE_MAX_LINES);
        live.text = live.lines.join('\n');
        if (live.text.length > AI_BG_LIVE_MAX_CHARS) live.text = '…（早期输出已省略）\n' + live.text.slice(-AI_BG_LIVE_MAX_CHARS);
        message.bgLog = live.text;
        if (!live.timer) {
            live.timer = setTimeout(() => {
                live.timer = 0;
                refreshToolWrap(session, message);
                notifyBgListeners(message.bg && message.bg.jobId);
            }, 250);
        }
    }

    function bgLiveFinish(jobId, code) {
        const key = String(jobId || '');
        const live = bgJobLive.get(key);
        const entry = bgJobIndex.get(key);
        // bgJobLive 只在首次收到 cmd-out 时由 bgLiveAppend 创建；完全没有输出的作业
        //（如 sleep 2; exit 0）从出生到结束都没有该条目，旧实现直接 return 导致卡片
        // 永远停在 running。这里退回 bgJobIndex（作业启动时已登记）取消息对象。
        const target = (live && live.message && live.message.bg)
            ? live
            : (entry && entry.message && entry.message.bg
                ? {session: entry.session, message: entry.message}
                : null);
        if (!target) return;
        const bg = target.message.bg;
        // 退出码可能以字符串到达（cmd-exit 广播 / 后端返回值），统一换算成数字再判 -1
        const codeNum = (code == null || code === '') ? null : Number(code);
        if (bg.state === 'running') {
            bg.state = codeNum === -1 ? 'stopped' : 'exited';
            bg.code = codeNum;
        } else {
            bg.code = codeNum;
        }
        if (live && live.timer) {
            clearTimeout(live.timer);
            live.timer = 0;
        }
        refreshToolWrap(target.session, target.message);
        notifyBackgroundActivity();
        notifyBgListeners(key);
    }

    // check_command / stop_command 的结果同步回作业卡片状态
    function syncBgCardState(jobId, st) {
        if (!st || st.state !== 'exited') return;
        bgLiveFinish(jobId, st.code);
    }

    // 「后台终端」弹层对账：running 只来自内存里的 message.bg.state，靠 cmd-exit 事件推进。
    // 事件一旦错过（修复前结束的作业、或事件早于登记到达），卡片会永久停在「后台运行中…」，
    // 而事件不会重放。打开弹层时按需向后端确认一次真实状态。
    // 注意：不写 bgJobCursors —— 那是 check_command 的增量游标，读走会吞掉模型端未读输出。
    let bgReconcileAt = 0;
    async function reconcileBgJobs() {
        if (!backend.AICommandStatus) return;
        const now = Date.now();
        if (now - bgReconcileAt < 1000) return;
        bgReconcileAt = now;
        const pending = [];
        let changed = false;
        for (const [jobId, entry] of bgJobIndex) {
            if (bgJobStateOf(entry) === 'running') pending.push(jobId);
        }
        for (const jobId of pending) {
            let st = null;
            try {
                st = await backend.AICommandStatus(jobId, bgJobCursors.get(jobId) || 0);
            } catch (e) {
                continue; // 查询失败保持原状，下次打开弹层再试
            }
            if (!st) continue;
            if (st.state === 'exited') {
                syncBgCardState(jobId, st);
            } else if (st.state === 'notfound') {
                // 应用重启后作业表已清空：收敛为已停止，避免永久转圈
                const entry = bgJobIndex.get(jobId);
                const bg = entry && entry.message && entry.message.bg;
                if (bg && bg.state === 'running') {
                    bg.state = 'stopped';
                    bg.code = -1;
                    refreshToolWrap(entry.session, entry.message);
                    changed = true;
                }
            }
        }
        if (changed) notifyBackgroundActivity();
    }

    // ---------- Git 快捷操作一次性窄豁免（2026-11-16） ----------
    // 点 Git 快捷操作时给当前会话打一个令牌（git 根 + 过期时间），auto 档下常规 git 写命令
    // 在危险检测与项目规则通过后免逐条审批。令牌按会话归属、TTL 15 分钟、不持久化。
    const GIT_FLOW_TOKEN_TTL_MS = 15 * 60 * 1000;
    const gitFlowTokens = new Map(); // sessionId -> {root, expiresAt}

    function setGitFlowToken(sessionId, root) {
        if (!sessionId || !root) return;
        gitFlowTokens.set(sessionId, {root, expiresAt: Date.now() + GIT_FLOW_TOKEN_TTL_MS});
    }

    function gitFlowTokenFor(sessionId) {
        const token = gitFlowTokens.get(sessionId);
        if (!token) return null;
        if (Date.now() > token.expiresAt) {
            gitFlowTokens.delete(sessionId);
            return null;
        }
        return token;
    }

    // run_command / background_command 共用审批：项目规则 → 危险命令单次确认 → 会话/项目放行
    // → 完全权限 → 自动审批（只读命令 / 已知命令族 / Git 快捷操作豁免 / 可选分类器）→ 逐次询问.
    async function approveCommandForRun(session, toolMessage, command, cwd, toolName) {
        // 判定胶囊一律按会话归属投递：后台会话在跑命令时，别的会话不该冒出它的放行/转人工提示。
        const note = (text) => noteForSession(session && session.id, text);
        const scope = currentScopeOf(session);
        const rules = await ensureProjectRules(false);
        const readOnly = analyzeReadOnlyCommand(command).readOnly;
        const dangerBase = analyzeDangerousCommand(command);
        // 作者拍板（2026-11-16）：命令引用 env_list 存储的变量名或整表 dump 环境变量时
        // 强制人工审批——并入 dangerous 通道，decidePermission 在会话/项目授权与分类器
        // 之前直接 ask singleUse，端侧与 AI 分类器均无权放行；没存在软件里的变量走正常流程。
        const envLeak = analyzeEnvValueExposure(command, await managedEnvVarNames());
        const danger = dangerBase.dangerous ? dangerBase : envLeak;
        const sessionRule = matchCommandApproval(session, command, cwd);
        const family = commandFamilySignature(command);
        // Git 快捷操作一次性窄豁免：令牌有效 + 命令静态安全（危险检测与项目规则已在上方判定）。
        // 显式排除 terminal 通道——它走同一审批链但 cwd 实参是「终端 <id>」而非路径，
        // 不能依赖「cwd 不是路径」这一偶然事实挡住豁免。
        const gitToken = gitFlowTokenFor(session && session.id);
        const gitFlowSafe = toolName !== 'terminal' && !!(gitToken && gitFlowSafeCommand(command, gitToken.root, cwd));
        const decision = decidePermission({
            scope,
            kind: 'command',
            rules,
            subject: command,
            sessionAllow: !!sessionRule,
            familyAuto: !!family,
            readOnly,
            dangerous: danger.dangerous,
            classifierEnabled: config.autoClassifier === true,
            gitFlowSafe,
        });
        if (decision.decision !== 'classify') {
            logPermission('command', command, decision.decision, decision.source, decision.rule);
        }
        if (decision.decision === 'deny') {
            toolMessage.approval = {
                state: 'denied',
                kind: 'command',
                tool: toolName || 'run_command',
                command,
                cwd,
                denyRule: decision.rule,
            };
            toolMessage.status = 'done';
            toolMessage.content = '项目权限规则禁止执行该命令';
            persistApprovalMutation(session, toolMessage);
            refreshToolWrap(session, toolMessage);
            return {approved: false, denied: true, rule: decision.rule};
        }
        if (decision.decision === 'classify') {
            // 端侧分类器先行（线性与语义插件同时生效、保守合并取 max）：离线毫秒级，产出危险概率，
            // 按严格度阈值统一判 allow/ask。无可用分类器（未启用/加载失败/全部熔断）→ 回退远程。
            const local = await localClassifierMod.classifyAll(command, {
                cwd,
                toolName: toolName || 'run_command',
                sessionId: (session && session.id) || '',
            });
            // 调试探针：端侧分类器各层结果（线性 / 语义插件）输出到调试控制台。
            // 排查「端侧判险但远程放行」时看这里：每层 score、allow、以及聚合后的 final。
            if (local) {
                console.debug('[classifier:local] cmd=' + commandText(command).slice(0, 120) +
                    ' final=' + (local.allow ? 'allow' : 'ask') +
                    ' score=' + local.score.toFixed(3) + ' threshold=' + local.threshold +
                    ' degraded=' + (local.degraded ? 'yes' : 'no') +
                    ' layers=' + JSON.stringify((local.layers || []).map((l) => ({
                        id: l.id, score: Number(l.score).toFixed(3), allow: l.allow ? 'allow' : 'ask',
                    }))));
            } else {
                console.debug('[classifier:local] cmd=' + commandText(command).slice(0, 120) + ' final=unavailable');
            }
            if (local && local.allow) {
                const localNote = local.sourceLabel + ' score=' + local.score.toFixed(2) +
                    (local.reason ? '：' + local.reason : '') +
                    (local.classifierCount > 1 ? '（' + local.classifierCount + ' 个分类器合并）' : '');
                logPermission('command', command, 'allow', 'local-classifier', 'score=' + local.score.toFixed(2));
                note('端侧分类器已放行：' + localNote);
                markCommandAutoApproved(session, toolMessage, command, cwd, toolName, 'local-classifier', localNote);
                return {approved: true};
            }
            if (local) {
                // 端侧未放行：远程分类器启用时交大模型二次判定（提示词注入端侧结果供参考）；
                // 远程未启用 → 直接转人工（fail-closed）。
                const localSummary = local.sourceLabel + ' score=' + local.score.toFixed(2) + ' ≥ 阈值 ' + local.threshold +
                    (local.reason ? '（' + local.reason + '）' : '');
                if (config.autoClassifier === true) {
                    const verdict = await classifyCommandForAuto(session, command, cwd, {
                        source: local.sourceLabel,
                        score: local.score,
                        threshold: local.threshold,
                        reason: local.reason,
                    });
                    // 调试探针：远程 AI 分类器复核结果输出到调试控制台。
                    // 端侧判险但这里 allow 时，就是「端侧拦截、远程放行」的现场。
                    console.debug('[classifier:ai] cmd=' + commandText(command).slice(0, 120) +
                        ' verdict=' + (verdict.allow ? 'allow' : 'ask') +
                        ' reason=' + (verdict.reason || '').slice(0, 80) +
                        ' local_score=' + local.score.toFixed(3) + ' local_threshold=' + local.threshold);
                    logPermission('command', command, verdict.allow ? 'allow' : 'ask', 'classifier',
                        localSummary + ' · 复核' + (verdict.allow ? '放行' : '未放行'));
                    if (verdict.allow) {
                        note('端侧未放行（' + localSummary + '），AI 分类器复核放行：' + (verdict.reason || '未说明原因'));
                        markCommandAutoApproved(session, toolMessage, command, cwd, toolName, 'classifier', '端侧未放行，AI 复核放行：' + (verdict.reason || ''));
                        return {approved: true};
                    }
                    note('端侧（' + localSummary + '）与 AI 分类器复核均未放行：' + (verdict.reason || '转人工'));
                    return await requestCommandApproval(session, toolMessage, {
                        command,
                        cwd,
                        tool: toolName || 'run_command',
                        classifyNote: '端侧 ' + localSummary + '；AI 分类器复核未放行：' + (verdict.reason || ''),
                        classifyInfo: {
                            engine: localEngineOf(local),
                            score: local.score,
                            threshold: local.threshold,
                            aiReason: verdict.reason || '',
                            aiVerdict: 'ask',
                            verdicts: local.verdicts || {},
                        },
                        askSource: 'local-classifier',
                        classifyScore: local.score,
                    });
                }
                logPermission('command', command, 'ask', 'local-classifier', 'score=' + local.score.toFixed(2) + ' ≥ ' + local.threshold);
                note('端侧分类器转人工：' + localSummary);
                return await requestCommandApproval(session, toolMessage, {
                    command,
                    cwd,
                    tool: toolName || 'run_command',
                    classifyNote: localSummary,
                    classifyInfo: {
                        engine: localEngineOf(local),
                        score: local.score,
                        threshold: local.threshold,
                        verdicts: local.verdicts || {},
                    },
                    askSource: 'local-classifier',
                    classifyScore: local.score,
                });
            }
            toolMessage.content = '等待 AI 分类器判定…';
            refreshToolWrap(session, toolMessage);
            const verdict = await classifyCommandForAuto(session, command, cwd);
            logPermission('command', command, verdict.allow ? 'allow' : 'ask', 'classifier', verdict.reason);
            if (verdict.allow) {
                note('AI 分类器已放行：' + (verdict.reason || '未说明原因'));
                markCommandAutoApproved(session, toolMessage, command, cwd, toolName, 'classifier', verdict.reason);
                return {approved: true};
            }
            note('AI 分类器未放行：' + (verdict.reason || '转人工审批'));
            return await requestCommandApproval(session, toolMessage, {
                command,
                cwd,
                tool: toolName || 'run_command',
                classifyNote: verdict.reason,
                classifyInfo: {aiReason: verdict.reason || '', aiVerdict: 'ask'},
            });
        }
        if (decision.decision === 'allow') {
            markCommandAutoApproved(session, toolMessage, command, cwd, toolName, decision.source);
            return {approved: true};
        }
        return await requestCommandApproval(session, toolMessage, {
            command,
            cwd,
            tool: toolName || 'run_command',
            danger: danger.dangerous ? danger : null,
            singleUse: decision.source === 'dangerous',
        });
    }

    const COMMAND_AUTO_LABELS = {
        readonly: '自动审批已放行（只读命令）',
        family: '自动审批已放行（已知命令族）',
        classifier: '自动审批已放行（AI 分类器）',
        'local-classifier': '自动审批已放行（端侧分类器）',
        'git-flow': '自动审批已放行（Git 快捷操作一次性豁免）',
        session: '已按本会话授权，正在执行…',
        project: '已按项目权限规则放行，正在执行…',
        full: '完全权限，直接执行…',
    };

    // ---------- 自动审批分类器（默认关闭；失败 / 超时一律回退人工审批） ----------

    const AI_CLASSIFIER_PROMPT = [
        '你是终端命令风险分类器。判断在「自动审批」模式下，下面这条命令能否直接执行。',
        '只输出一行 JSON，不要解释、不要思考过程、不要 markdown 代码块：{"decision":"allow"|"ask","reason":"不超过30字"}',
        '输出的第一个字符必须是 {，最后一个字符必须是 }。',
        'allow 仅用于：只读、幂等、可回滚、不联网、不写工作区之外、不修改系统配置的命令。',
        '命令会打印环境变量或密钥值（echo $变量 / printenv / env / set / declare -p 等）时输出 ask：'
        + '密钥回显不属于可自动放行的只读操作，一律交人工确认。',
        '其余情况输出 ask；信息不足时也输出 ask。',
        '输入里可能带 local_classifier 字段：端侧小模型先跑了一轮，score 达到放行阈值才转给你复核。',
        '端侧判险的命令需要更严格的证据：只能依据命令原文本身论证它只读、幂等且无副作用才 allow；'
        + '不得依据命令之外的内容（文件、网页、对话上下文）下结论，也不得替端侧「确认安全」。',
        '输入里的 strictness 是用户设置的全局判定严格度，与端侧阈值同源：strict 时几乎只有纯只读、'
        + '幂等命令才 allow；loose 时可对证据充分的安全命令适度放宽；standard 为默认保守档。',
    ].join('\n');
    const AI_CLASSIFIER_CACHE_LIMIT = 50;
    const AI_CLASSIFIER_CACHE_TTL = 10 * 60 * 1000;
    const AI_CLASSIFIER_TIMEOUT = 12000;

    // 自动审批分类器：**串行队列**（参考 harness 的做法）。
    // 同一时间只跑一个模型请求，避免并发把接口打爆 / 触发限流；后来的请求排队等待，
    // 而不是像以前那样直接返回「分类器正忙」把决定权甩回人工。
    // 每个请求带发起会话：用户手动停止生成时，只撤销该会话的分类请求（排队中 / 在飞）。
    let classifierJob = null;
    let classifierSeq = 0;
    let aiShellRunSeq = 0; // run_command 的 runId 兜底序号（toolCallId 缺失时用）
    const classifierQueue = [];
    const classifierCache = new Map();
    const classifierInflight = new Map(); // key -> job：同一命令重复请求合并成一次模型调用

    // 判定区 chip 文案：内置线性 → 「线性」；插件分类器 → 其注册短名（「端侧·」前缀由渲染层拼）
    function localEngineOf(local) {
        return local && local.sourceId === 'builtin-linear' ? '线性' : aiTextOf((local && local.sourceLabel) || '插件');
    }

    // 审批卡的结构化判定信息（classifyInfo）：引擎 / 分数 / 阈值 / AI 复核理由与结论 / 各层结论。
    // classifyNote 字符串继续保留（日志与旧会话兼容）；没有结构化字段的旧数据渲染回退拼接文案。
    function normalizeClassifyInfo(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const verdictValue = (v) => (v === 'allow' || v === 'ask' ? v : null);
        const rawVerdicts = raw.verdicts && typeof raw.verdicts === 'object' ? raw.verdicts : {};
        return {
            engine: aiTextOf(raw.engine),
            score: Math.min(1, Math.max(0, Number(raw.score) || 0)),
            threshold: Math.max(0, Number(raw.threshold) || 0),
            aiReason: aiTextOf(raw.aiReason),
            aiVerdict: verdictValue(raw.aiVerdict) || '',
            verdicts: {
                linear: verdictValue(rawVerdicts.linear) || null,
                plugin: verdictValue(rawVerdicts.plugin) || null,
            },
        };
    }

    // 判定解析在 ai-classifier-verdict.js：括号配对扫描取全部顶层对象、从后往前试解析、
    // 短答复纯文本兜底、失败带片段便于排障。放在独立模块里也给这个已超线的文件减负。

    // 结算一个分类请求：唤醒全部等待方、写缓存（撤销/失败不写）、放行队列。
    function settleClassifierJob(job, verdict, options) {
        if (!job || job.settled) return;
        job.settled = true;
        if (job.timer) clearTimeout(job.timer);
        job.timer = 0;
        if (classifierInflight.get(job.key) === job) classifierInflight.delete(job.key);
        if (classifierJob === job) classifierJob = null;
        const cache = !(options && options.cache === false) && verdict && job.key;
        if (cache) {
            classifierCache.set(job.key, {verdict, at: Date.now()});
            if (classifierCache.size > AI_CLASSIFIER_CACHE_LIMIT) {
                const first = classifierCache.keys().next();
                if (!first.done) classifierCache.delete(first.value);
            }
        }
        for (const resolve of job.waiters.splice(0)) {
            try { resolve(verdict); } catch (e) {}
        }
        if (!(options && options.skipPump)) pumpClassifierQueue();
    }

    function resolveClassifierJob(job, verdict) {
        settleClassifierJob(job, verdict);
    }

    // 启动队列里的下一个请求（一次只发一个）。
    function pumpClassifierQueue() {
        if (classifierJob) return;
        while (classifierQueue.length) {
            const job = classifierQueue.shift();
            if (!job) continue;
            if (job.settled) continue;
            if (job.cancelled) {
                settleClassifierJob(job, {allow: false, reason: '已取消分类，改由人工确认'}, {cache: false, skipPump: true});
                continue;
            }
            classifierJob = job;
            noteForSession(job.sessionId, 'AI 分类器判定中：' + job.command.replace(/\s+/g, ' ').slice(0, 80));
            job.timer = setTimeout(() => {
                try { if (backend.AIStop) backend.AIStop(job.id); } catch (e) {}
                settleClassifierJob(job, {allow: false, reason: '分类器超时'});
            }, AI_CLASSIFIER_TIMEOUT);
            Promise.resolve(backend.AISendChat(job.id, job.cfg, job.messages, [], 0)).catch(() => {
                settleClassifierJob(job, {allow: false, reason: '分类器请求失败'});
            });
            return;
        }
    }

    // 用户停止某个会话的生成：撤销它排队中与在飞的分类请求（工具随后走人工确认）。
    function cancelClassifierJobs(sessionId) {
        if (!sessionId) return;
        for (let i = classifierQueue.length - 1; i >= 0; i--) {
            const job = classifierQueue[i];
            if (!job || job.sessionId !== sessionId) continue;
            classifierQueue.splice(i, 1);
            job.cancelled = true;
            settleClassifierJob(job, {allow: false, reason: '生成已停止，改由人工确认'}, {cache: false, skipPump: true});
        }
        const running = classifierJob;
        if (running && running.sessionId === sessionId) {
            running.cancelled = true;
            try { if (backend.AIStop) backend.AIStop(running.id); } catch (e) {}
            settleClassifierJob(running, {allow: false, reason: '生成已停止，改由人工确认'}, {cache: false});
        }
    }

    // 分类器请求模型：设置了专用模型引用（设置 → AI → 权限 → 模式与判定顺序）且仍存在时
    // 用它的完整连接信息（账号连接 + 条目模型参数），否则跟随「发起命令的会话」的模型。
    function classifierModelRef(session) {
        const ref = resolveModelRef(config.autoClassifierModel, config.profiles);
        if (ref) {
            const sep = ref.indexOf('|');
            const account = config.profiles.find((profile) => profile.id === ref.slice(0, sep));
            const entry = account ? modelEntryOf(account, ref.slice(sep + 1)) : null;
            if (account && entry) return {account, entry};
        }
        return {account: profileOf(session), entry: entryOf(session)};
    }

    // localContext：端侧分类器未放行时的复核场景（作者拍板的「端侧 + 大模型结合」），
    // 把端侧结果（来源 / score / 阈值 / 理由）注入提示词，供大模型参考后做二次判定。
    function classifyCommandForAuto(session, command, cwd, localContext) {
        const fallback = {allow: false, reason: '分类器不可用'};
        if (config.autoClassifier !== true || !backend.AISendChat) return Promise.resolve(fallback);
        const modelRef = classifierModelRef(session);
        if (!modelRef || !modelRef.account || !modelRef.entry) return Promise.resolve(fallback);
        const key = aiTextOf(cwd) + '\u0000' + commandText(command);
        const cached = classifierCache.get(key);
        if (cached && Date.now() - cached.at < AI_CLASSIFIER_CACHE_TTL) return Promise.resolve(cached.verdict);
        // 同一条命令已经在判定：共用一次模型调用，只是多挂一个等待方
        const inflight = classifierInflight.get(key);
        if (inflight) return new Promise((resolve) => { inflight.waiters.push(resolve); });
        const sessionId = (session && session.id) || '';
        const id = (sessionId || 'session') + '#classifier-' + (++classifierSeq);
        // 走 configForProfile：插件 provider 的虚拟账号同样要拿到每轮动态补丁
        const cfg = Object.assign(configForProfile(modelRef.account, modelRef.entry), {
            // 512 而非小预算：部分兼容网不认「关闭思考」参数时，思考链也烧不完预算，
            // 正文仍能产出（JSON 判定本身 <60 token）
            maxTokens: 512,
            temperature: 0,
            thinking: false,
            reasoningEffort: '',
        });
        const userPayload = {
            command: commandText(command).slice(0, 2000),
            cwd: aiDisplayPath(cwd, getScopeRoot()),
            workspace: aiDisplayRootLabel(getScopeRoot()),
            // 用户设置的判定严格度与端侧共用（loose 0.30 / standard 0.15 / strict 0.07）
            strictness: normalizeLocalClassifierStrictness(config.localClassifierStrictness),
        };
        if (localContext) {
            // 端侧结果注入：score 已达阈值才到这里复核；注明「非最终判定」，避免模型盲从
            userPayload.local_classifier = {
                source: aiTextOf(localContext.source),
                score: Number(Number(localContext.score).toFixed(3)),
                threshold: Number(localContext.threshold),
                note: '端侧模型判险（非最终判定），请独立复核',
            };
            if (localContext.reason) userPayload.local_classifier.reason = aiTextOf(localContext.reason).slice(0, 80);
        }
        const messages = [
            {role: 'system', content: AI_CLASSIFIER_PROMPT},
            {role: 'user', content: JSON.stringify(userPayload)},
        ];
        const job = {
            id, key, sessionId, cfg, messages,
            command: commandText(command),
            // 端侧确实转险复核时才带 true：云端蒸馏需要「线性 ask + 云 allow」的分歧语义，
            // 端侧未参与判定（分类器关闭/全熔断）时没有对照，不蒸馏（红队链A）
            localReviewed: !!localContext,
            buffer: '',
            think: '',
            waiters: [],
            timer: 0,
            settled: false,
            cancelled: false,
        };
        classifierInflight.set(key, job);
        classifierQueue.push(job);
        const promise = new Promise((resolve) => { job.waiters.push(resolve); });
        pumpClassifierQueue();
        return promise;
    }

    function markCommandAutoApproved(session, toolMessage, command, cwd, toolName, source, detail) {
        toolMessage.approval = {
            state: 'approved',
            kind: 'command',
            tool: toolName || 'run_command',
            command,
            cwd,
            remember: 'pre',
            autoRule: source,
            actor: 'auto',
        };
        if (toolHalted(toolMessage)) {
            // 停止后才回来的自动放行（分类器 / 规则 await 期间用户按了停止）：
            // 审批记录照写（审计要用），但绝不把卡片点回 running —— 见 toolHalted 注释。
            persistApprovalMutation(session, toolMessage);
            refreshToolWrap(session, toolMessage);
            return;
        }
        toolMessage.status = 'running';
        let text = COMMAND_AUTO_LABELS[source] || '自动审批已放行，正在执行…';
        if (source === 'classifier' || source === 'local-classifier') {
            const reason = aiTextOf(detail).replace(/\s+/g, ' ').slice(0, 80);
            const label = source === 'classifier' ? 'AI 分类器' : '端侧分类器';
            text = reason ? '自动审批已放行（' + label + '：' + reason + '）' : '自动审批已放行（' + label + '）';
        }
        toolMessage.content = text;
        // 消息可能已被排队中的持久化任务以「未审批」状态落盘：标记重写，保住放行来源。
        persistApprovalMutation(session, toolMessage);
        refreshToolWrap(session, toolMessage);
    }

    function requestCommandApproval(session, toolMessage, info) {
        // 已停止的轮不再弹审批接管：停止之后迟到的分类器 / 规则结论一律按「取消」处理，
        // 否则用户先看到「已停止」，几秒后又冒出待审批卡片。
        if (toolHalted(toolMessage)) return Promise.resolve({approved: false, cancelled: true});
        const danger = info.danger && info.danger.dangerous
            ? {ruleId: info.danger.ruleId, label: info.danger.label || info.danger.ruleId}
            : null;
        const approval = {
            state: 'pending',
            kind: 'command',
            tool: info.tool || 'run_command',
            // 网络类审批（web_fetch / read_image 网图）：审批卡按「访问网址」渲染，审计记 kind web
            web: info.web === true,
            command: info.command,
            cwd: info.cwd,
            remember: '',
            danger,
            singleUse: info.singleUse === true || !!danger,
            classifyNote: aiTextOf(info.classifyNote),
            classifyInfo: normalizeClassifyInfo(info.classifyInfo),
            // 端侧分类器转人工的来源标记（审计与导出用；用户裁定已不再回流学习）
            askSource: aiTextOf(info.askSource),
            classifyScore: Number(info.classifyScore) || 0,
        };
        toolMessage.approval = approval;
        toolMessage.status = 'pending';
        toolMessage.content = '等待用户审批命令…';
        persistSessions();
        refreshToolWrap(session, toolMessage);
        const key = toolMessage.toolCallId || aiNowId('approval-');
        const entry = {session, toolMessage, resolve: null, approval};
        pendingApprovals.set(key, entry);
        updateComposerTakeover(true);
        renderSessionList();
        markWaitingOnUser(session, approval, 'AI 待审批',
            (session.title || '会话') + ' · 命令待批准：' + appToastPreview(info.command || '', 60));
        return new Promise((resolve) => {
            entry.resolve = resolve;
        });
    }

    function decideApproval(toolMessage, approved, remember) {
        if (!toolMessage) return;
        const key = toolMessage.toolCallId;
        const entry = pendingApprovals.get(key);
        if (!entry) return;
        pendingApprovals.delete(key);
        // 审批已决定：丢弃接管卡的收起状态（下一条审批恢复默认展开）
        approvalTakeoverKey = '';
        approvalTakeoverCollapsed = false;
        const approval = entry.approval;
        approval.state = approved ? 'approved' : 'denied';
        approval.actor = 'user';
        approval.remember = typeof remember === 'string' ? remember : '';
        if (approval.kind === 'command') {
            approval.remember = '';
            const wants = remember && typeof remember === 'object' ? remember : null;
            // 危险命令只执行这一次：不落任何长期放行规则，项目规则也压不过它。
            if (approved && !approval.singleUse && !approval.danger && wants) {
                const family = commandFamilySignature(approval.command);
                if (family && wants.family) {
                    addCommandApprovalRule(entry.session, {
                        mode: 'family',
                        signature: family.signature,
                        cwd: approval.cwd,
                    });
                    approval.remember = 'family';
                } else if (wants.exact) {
                    addCommandApprovalRule(entry.session, {
                        mode: 'exact',
                        command: approval.command,
                        cwd: approval.cwd,
                    });
                    approval.remember = 'session';
                }
                if (family && wants.projectFamily && entry.session) {
                    addProjectRule('command', 'allow', family.signature + ':*').then((added) => {
                        if (added) flash('已加入项目权限规则：' + family.signature + ':*');
                    }).catch((e) => flash('项目权限规则保存失败：' + ((e && e.message) || e), true));
                }
            } else if (approved && !approval.singleUse && !approval.danger && remember === 'session') {
                addCommandApprovalRule(entry.session, {
                    mode: 'exact',
                    command: approval.command,
                    cwd: approval.cwd,
                });
                approval.remember = 'session';
            }
        } else if (approval.kind === 'read') {
            // 读授权的「记住」：目录粒度（rootDir），进已批准读根而不是 approvedPaths（写路径）。
            if (approved && approval.rootDir) {
                if (remember === 'session' && entry.session) {
                    entry.session.readRoots = addReadRoot(entry.session.readRoots, approval.rootDir);
                } else if (remember === 'always') {
                    config.approvedReadRoots = addReadRoot(config.approvedReadRoots, approval.rootDir);
                    saveAIConfig();
                } else if (remember === 'project') {
                    addProjectRule('read', 'allow', writeRuleSubject(approval.rootDir) + '/**').then((added) => {
                        if (added) flash('已加入项目权限规则：Read(' + writeRuleSubject(approval.rootDir) + '/**)');
                    }).catch((e) => flash('项目权限规则保存失败：' + ((e && e.message) || e), true));
                }
            }
        } else if (approved && remember === 'always') {
            aiAddUnique(config.approvedPaths, approval.path);
            saveAIConfig();
            renderApprovedSettings();
        } else if (approved && remember === 'session' && entry.session) {
            aiAddUnique(entry.session.approvedPaths, approval.path);
        } else if (approved && remember === 'project' && approval.relPath) {
            addProjectRule('write', 'allow', writeRuleSubject(approval.relPath)).then((added) => {
                if (added) flash('已加入项目权限规则：Write(' + writeRuleSubject(approval.relPath) + ')');
            }).catch((e) => flash('项目权限规则保存失败：' + ((e && e.message) || e), true));
        }
        // 放弃 / 拒绝不是「执行中」：状态落 cancelled（此前无条件 running，卡片会转圈 + 已放弃同框）
        // 已停止的轮（用户点停止与点击执行撞在一起的竞态）同理：保持终止态，别把卡片点亮。
        const halted = toolHalted(toolMessage);
        toolMessage.status = halted ? 'error' : (approved ? 'running' : 'cancelled');
        toolMessage.content = halted
            ? '用户已停止生成，本次审批未执行。'
            : approval.kind === 'command'
                ? (approved ? '正在执行命令…' : '用户取消了本次命令')
                : approval.kind === 'read'
                    ? (approved ? '用户已授权，正在读取…' : '用户未授权本次读取')
                    : (approved ? '正在应用更改…' : '用户放弃了本次更改');
        // 用户裁定也进审批记录：来源标 user，避免只看到「待审批」看不到结果。
        const auditKind = approval.kind === 'command'
            ? (isWebApproval(approval) ? 'web' : 'command')
            : (approval.kind === 'read' ? 'read' : 'write');
        const auditSubject = approval.kind === 'command'
            ? (isWebApproval(approval)
                ? (webRuleSubject(approval.command) || approval.command)
                : approval.command)
            : (approval.relPath || approval.path || '');
        logPermission(auditKind, auditSubject, approved ? 'allow' : 'deny', 'user', approvalAuditRule(approval));
        // 用户裁定的唯一学习点 = **三层结论分歧**（线性 / 语义 / 云端 AI 放行结论不一致）：
        // 此时不一致的是模型之间，用户的允许 / 拒绝是在裁决「谁对谁错」，值得回流；
        // 结论一致时（如写文件场景端侧与云端都转人工，用户允许只是执行预期行为）不学——
        // 否则一次性授权会被学成永久放行。模型蒸馏路径不变（云端结论 / 语义结论随时可学）。
        if (approval.kind === 'command' && config.localClassifierPersonalize === true && localClassifierMod) {
            const info = approval.classifyInfo || {};
            const verdicts = {
                linear: (info.verdicts && info.verdicts.linear) || null,
                plugin: (info.verdicts && info.verdicts.plugin) || null,
                cloud: info.aiVerdict || null,
            };
            if (hasVerdictDisagreement(verdicts)) {
                Promise.resolve(localClassifierMod.recordDecision(approval.command, approved, {source: 'user'}))
                    .catch((e) => flash('分类器学习失败：' + ((e && e.message) || e), true));
            }
        }
        persistApprovalMutation(entry.session, toolMessage);
        refreshToolWrap(entry.session, toolMessage);
        entry.resolve({approved: !!approved, remember: remember || ''});
        updateComposerTakeover(true);
        // 用户已经在处理这个会话了，「未查看」圆点顺手清掉。
        if (entry.session) clearSessionUnread(entry.session);
        renderSessionList();
    }

    // sessionId 提供时只取消该会话的待审批：多会话并发生成时停 A 不能连坐 B。
    function cancelPendingApprovals(reason, sessionId) {
        for (const [key, entry] of pendingApprovals) {
            if (sessionId && !(entry.session && entry.session.id === sessionId)) continue;
            entry.approval.state = 'cancelled';
            entry.toolMessage.status = 'done';
            entry.toolMessage.content = reason || '审批已取消';
            pendingApprovals.delete(key);
            entry.resolve({approved: false, cancelled: true});
            if (sessionStore && entry.session) {
                try { sessionStore.invalidateMessage(entry.session, entry.toolMessage); } catch (e) {}
            }
            refreshToolWrap(entry.session, entry.toolMessage);
        }
        if (!sessionId && pendingApprovals.size) pendingApprovals.clear();
        persistSessions();
        updateComposerTakeover(true);
        renderSessionList();
    }

    // ---- env_create：AI 提供名称与描述，值由用户在卡片里亲自填写（值不进对话） ----

    function requestEnvCreation(session, toolMessage, info) {
        const envAsk = {
            state: 'pending',
            name: info.name,
            description: info.description || '',
        };
        toolMessage.envAsk = envAsk;
        toolMessage.status = 'pending';
        toolMessage.content = '等待用户填写变量值…';
        persistSessions();
        refreshToolWrap(session, toolMessage);
        const key = toolMessage.toolCallId || aiNowId('env-ask-');
        const entry = {session, toolMessage, resolve: null};
        pendingEnvCreations.set(key, entry);
        // 先登记再刷新接管区：查找逻辑依赖 pendingEnvCreations 已有条目。
        updateComposerTakeover(true);
        renderSessionList();
        markWaitingOnUser(session, envAsk, 'AI 待填写',
            (session.title || '会话') + ' · 需要你填写环境变量 ' + (info.name || '') + ' 的值');
        return new Promise((resolve) => {
            entry.resolve = resolve;
        });
    }

    function decideEnvCreation(toolMessage, approved, value) {
        if (!toolMessage) return;
        const entry = pendingEnvCreations.get(toolMessage.toolCallId);
        if (!entry) return;
        pendingEnvCreations.delete(toolMessage.toolCallId);
        const envAsk = toolMessage.envAsk;
        if (envAsk) envAsk.state = approved ? 'approved' : 'cancelled';
        toolMessage.status = 'running';
        toolMessage.content = approved ? '正在创建变量…' : '用户取消了变量创建';
        persistSessions();
        refreshToolWrap(entry.session, toolMessage);
        // value 只经此 Promise 传给执行器，不写入 toolMessage / 会话持久化
        entry.resolve({approved: !!approved, value: approved ? String(value == null ? '' : value) : ''});
        updateComposerTakeover(true);
        renderSessionList();
    }

    function cancelPendingEnvCreations(reason, sessionId) {
        for (const [key, entry] of pendingEnvCreations) {
            if (sessionId && !(entry.session && entry.session.id === sessionId)) continue;
            if (entry.toolMessage.envAsk) entry.toolMessage.envAsk.state = 'cancelled';
            entry.toolMessage.status = 'done';
            entry.toolMessage.content = reason || '变量创建已取消';
            pendingEnvCreations.delete(key);
            entry.resolve({approved: false, cancelled: true});
            refreshToolWrap(entry.session, entry.toolMessage);
        }
        if (!sessionId && pendingEnvCreations.size) pendingEnvCreations.clear();
        persistSessions();
        updateComposerTakeover(true);
        renderSessionList();
    }

    function askTimeoutActionOf(ask) {
        const hasRecommended = (ask.questions || []).some((question) => question.options.some((option) => option.recommended));
        if (ask.timeoutAction === 'recommended' && !hasRecommended) {
            return 'ai_decide';
        }
        return ask.timeoutAction || 'recommended';
    }

    function askAnswerSummary(ask, answers) {
        for (const answer of answers || []) {
            if (answer && answer.selected && answer.selected.length) return answer.selected.join('、');
            if (answer && answer.custom) return answer.custom;
        }
        return '';
    }

    function formatAskAnswers(ask, answers, prefix) {
        const lines = [prefix];
        ask.questions.forEach((question, index) => {
            const answer = (answers || []).find((item) => item && item.id === question.id) || (answers || [])[index] || {selected: [], custom: ''};
            lines.push((index + 1) + '. ' + question.question);
            const selected = Array.isArray(answer.selected) ? answer.selected : [];
            if (selected.length) lines.push('   选择：' + selected.join('、'));
            if (answer.custom) lines.push('   补充：' + answer.custom);
            if (!selected.length && !answer.custom) lines.push('   未回答');
        });
        return lines.join('\n');
    }

    function removeAskDraft(key) {
        askDrafts.delete(key);
    }

    function askCountdownText(ask) {
        if (!ask || ask.state !== 'pending') return '';
        if (!ask.deadline) {
            // timeoutAction=wait（或显式 0 秒）没有倒计时。若这次还传了秒数，
            // 必须说清它没生效：wait 会把 timeoutSec 静默忽略，否则用户只看到"没设超时"。
            return ask.ignoredSec > 0 ? '本次不限时（已忽略 ' + ask.ignoredSec + ' 秒超时）' : '';
        }
        const left = Math.max(0, Math.ceil((ask.deadline - Date.now()) / 1000));
        if (!left) return '';
        const action = askTimeoutActionOf(ask);
        const label = {recommended: '按 AI 推荐项继续', abort: '停止本轮', ai_decide: '交给 AI 决定'}[action] || '继续';
        const mm = Math.floor(left / 60);
        const ss = left % 60;
        // 本次超时由 AI 定制时标注出来，避免用户以为时间不对
        const custom = ask.timeoutCustom ? '（本次自定义 ' + ask.timeoutSec + ' 秒）' : '';
        return '超时后' + label + custom + ' · 剩余 ' + mm + ':' + String(ss).padStart(2, '0');
    }

    function updateAskCountdown(entry) {
        if (!entry || !hasHost(entry.session && entry.session.id)) return;
        const key = entry.toolMessage.toolCallId || entry.key;
        panel.querySelectorAll('.ai-ask-countdown').forEach((node) => {
            if (node.dataset.askKey === key) node.textContent = askCountdownText(entry.ask);
        });
    }

    function clearAskTimers(entry) {
        if (!entry) return;
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.ticker) clearInterval(entry.ticker);
        entry.timer = 0;
        entry.ticker = 0;
    }

    function settleAsk(key, data) {
        const entry = pendingAsks.get(key);
        if (!entry) return;
        pendingAsks.delete(key);
        clearAskTimers(entry);
        removeAskDraft(key);
        const ask = entry.ask;
        ask.state = data.state;
        ask.answers = Array.isArray(data.answers) ? data.answers : (ask.answers || []);
        ask.answer = data.answer || askAnswerSummary(ask, ask.answers);
        ask.source = data.source || '';
        ask.answeredAt = Date.now();
        ask.deadline = 0;
        entry.toolMessage.status = 'done';
        entry.toolMessage.content = data.result;
        persistSessions();
        refreshToolWrap(entry.session, entry.toolMessage);
        updateComposerTakeover();
        renderSessionList();
        entry.resolve(data.result);
        if (data.stop && entry.stream) {
            entry.stream.stopped = true;
            setTimeout(() => {
                if (streams.get(entry.stream.sessionId) === entry.stream) stopGeneration(entry.stream);
            }, 0);
        }
    }

    function handleAskTimeout(entry) {
        if (!entry || !pendingAsks.has(entry.key)) return;
        const action = askTimeoutActionOf(entry.ask);
        if (action === 'abort') {
            settleAsk(entry.key, {
                state: 'timeout_abort',
                result: '用户未在时限内回答（超时），已停止本轮。',
                stop: true,
            });
            return;
        }
        if (action === 'recommended') {
            const answers = entry.ask.questions.map((question) => {
                const recommended = question.options.filter((option) => option.recommended).map((option) => option.label);
                return {
                    id: question.id,
                    selected: question.multiSelect ? recommended : recommended.slice(0, 1),
                    custom: '',
                };
            });
            if (answers.some((answer) => answer.selected.length)) {
                settleAsk(entry.key, {
                    state: 'timeout',
                    answers,
                    answer: askAnswerSummary(entry.ask, answers),
                    source: 'timeout_recommended',
                    result: formatAskAnswers(entry.ask, answers, '用户未在时限内回答（超时），已自动采用推荐项：'),
                });
                return;
            }
        }
        settleAsk(entry.key, {
            state: 'timeout',
            source: 'timeout_ai',
            result: '用户未在时限内回答（超时）。请根据上下文自行决定每个问题的答案，并继续执行。',
        });
    }

    function setupAskTimer(entry) {
        if (!entry || !entry.ask.deadline) return;
        const delay = Math.max(0, entry.ask.deadline - Date.now());
        entry.timer = setTimeout(() => handleAskTimeout(entry), delay);
        entry.ticker = setInterval(() => updateAskCountdown(entry), 1000);
    }

    function submitAskAnswers(entry, answers) {
        if (!entry || !entry.ask || entry.ask.state !== 'pending') return;
        const normalized = entry.ask.questions.map((question, index) => {
            const source = answers && answers[index] ? answers[index] : {};
            let selected = Array.isArray(source.selected)
                ? source.selected.map((label) => aiTextOf(label)).filter((label) => question.options.some((option) => option.label === label))
                : [];
            selected = [...new Set(selected)];
            if (!question.multiSelect) selected = selected.slice(0, 1);
            let custom = aiTextOf(source.custom).trim().slice(0, 500);
            if (!question.multiSelect && custom) selected = [];
            return {id: question.id, selected, custom};
        });
        if (!normalized.some((answer) => answer.selected.length || answer.custom)) {
            flash('请至少回答一个问题', true);
            return;
        }
        settleAsk(entry.key, {
            state: 'answered',
            answers: normalized,
            answer: askAnswerSummary(entry.ask, normalized),
            source: 'user',
            result: formatAskAnswers(entry.ask, normalized, '用户回答：'),
        });
    }

    // 跳过：不回答问题，但也不中断本轮，把「用户选择不回答」作为工具结果交还给模型。
    function skipAsk(entry) {
        if (!entry || !entry.ask || entry.ask.state !== 'pending') return;
        settleAsk(entry.key, {
            state: 'skipped',
            source: 'skip',
            answers: entry.ask.questions.map((question) => ({id: question.id, selected: [], custom: ''})),
            answer: '',
            result: '用户跳过了提问（选择不回答）。请基于现有上下文继续执行，不要重复追问同一问题；确实缺少关键信息时，可换更简单的方式再问一次，或做出合理假设并在结果中说明。',
        });
    }

    function cancelPendingAsks(reason, sessionId) {
        for (const [key, entry] of pendingAsks) {
            if (sessionId && !(entry.session && entry.session.id === sessionId)) continue;
            clearAskTimers(entry);
            removeAskDraft(key);
            entry.ask.state = 'cancelled';
            entry.ask.answers = [];
            entry.ask.answer = '';
            entry.ask.source = 'cancelled';
            entry.ask.answeredAt = Date.now();
            entry.ask.deadline = 0;
            entry.toolMessage.status = 'done';
            entry.toolMessage.content = reason || '用户未回答';
            pendingAsks.delete(key);
            entry.resolve(reason || '用户未回答');
            refreshToolWrap(entry.session, entry.toolMessage);
        }
        if (!sessionId && pendingAsks.size) pendingAsks.clear();
        persistSessions();
        updateComposerTakeover();
        renderSessionList();
    }

    function notifyAskRequested(session, toolMessage) {
        if (config.notifyAsk === false || !toolMessage.ask) return;
        const ask = toolMessage.ask;
        const first = ask.questions[0];
        const prefix = ask.questions.length > 1 ? ask.questions.length + ' 个问题：' : '';
        notifyDesktop({
            kind: 'ask',
            title: 'AI 需要你的回答',
            body: (session.title || '会话') + ' · ' + prefix + appToastPreview(first ? first.question : '', 80),
            sessionId: session.id,
        });
    }

    const ASK_TIMEOUT_ACTIONS = ['recommended', 'wait', 'abort', 'ai_decide'];

    // 本次提问的超时设置：工具可传 timeoutSec / timeoutAction 逐次覆盖，不写回 config。
    // 未传（undefined/null/空串）才回落到设置里的默认值；0 表示本次不限时。
    function resolveAskTimeout(input) {
        const rawSec = input ? input.timeoutSec : undefined;
        const hasOwnSec = rawSec !== undefined && rawSec !== null && String(rawSec).trim() !== '';
        const timeoutSec = hasOwnSec
            ? aiClampInt(rawSec, 0, 3600, config.askTimeout)
            : aiClampInt(config.askTimeout, 0, 3600, 300);
        const rawAction = input ? timeoutActionOf(input) : '';
        const timeoutAction = ASK_TIMEOUT_ACTIONS.includes(rawAction)
            ? rawAction
            : (ASK_TIMEOUT_ACTIONS.includes(config.askTimeoutAction) ? config.askTimeoutAction : 'recommended');
        return {timeoutSec, timeoutAction, custom: hasOwnSec || !!rawAction};
    }

    function timeoutActionOf(input) {
        const value = String((input && (input.timeoutAction || input.timeout_action)) || '').trim();
        return value;
    }

    async function runAskQuestion(input, ctx) {
        if (!ctx || !ctx.session || !ctx.toolMessage) throw new Error('ask_user 缺少会话上下文');
        const questions = parseAskQuestions(input);
        if (!questions.length) throw new Error('ask_user 至少需要一个有效问题');
        const {timeoutSec, timeoutAction, custom} = resolveAskTimeout(input);
        const useTimer = timeoutSec > 0 && timeoutAction !== 'wait';
        const ask = {
            questions,
            answers: questions.map((question) => ({id: question.id, selected: [], custom: ''})),
            state: 'pending',
            answer: '',
            source: '',
            deadline: useTimer ? Date.now() + timeoutSec * 1000 : 0,
            answeredAt: 0,
            timeoutSec,
            timeoutAction,
            timeoutCustom: custom,
            // wait 时不启动计时器：记住被忽略的秒数，面板据此提示"本次不限时"
            ignoredSec: useTimer ? 0 : timeoutSec,
        };
        const toolMessage = ctx.toolMessage;
        toolMessage.ask = ask;
        toolMessage.status = 'pending';
        toolMessage.content = '等待用户回答…';
        persistSessions();
        return new Promise((resolve) => {
            const key = toolMessage.toolCallId || aiNowId('ask-');
            const entry = {key, session: ctx.session, toolMessage, ask, resolve, stream: ctx.stream, timer: 0, ticker: 0};
            pendingAsks.set(key, entry);
            setupAskTimer(entry);
            if (isOpen() && currentSession() === ctx.session) renderMessages(true);
            else refreshToolWrap(ctx.session, toolMessage);
            updateComposerTakeover();
            renderSessionList();
            notifyAskRequested(ctx.session, toolMessage);
        });
    }

    function recordChange(session, info) {
        if (!session) return;
        session.changes.push({
            path: info.path,
            relPath: info.relPath,
            tool: info.tool,
            added: info.added,
            removed: info.removed,
            time: Date.now(),
        });
        if (session.changes.length > AI_CHANGES_LIMIT) {
            session.changes = session.changes.slice(-AI_CHANGES_LIMIT);
        }
        persistSessions();
        updateChangesUI();
    }

    function notifyFileChanged(path) {
        try {
            onFileChanged(path);
        } catch (e) {}
    }

    function isAutoWriteRisky(path) {
        const rel = aiRelPath(getScopeRoot(), path).toLowerCase();
        if (rel === 'agents.md' || rel.endsWith('/agents.md')) return true;
        if (rel === '.git' || rel.startsWith('.git/') || rel.includes('/.git/')) return true;
        // .cadt/worktree 是 AI 隔离 worktree（草稿区，炸了不伤主根）：auto 档免逐写审批。
        // 豁免必须精确到 worktree/ 前缀——.cadt/permissions.json、.cadt/patches/ 仍 risky。
        // 脏文件仍 risky；免审的安全债由回灌 patch 卡（全档必弹）偿还（ai-worktree.js）。
        if (rel === '.cadt/worktree' || rel.startsWith('.cadt/worktree/')) return false;
        // .cadt/tmp 是约定的临时产物区（纯文本中间产物，可被存储清理整目录回收）：
        // auto 档免审批放行；.cadt 其余部分仍 risky——permissions.json 是 AI 自己的权限规则、
        // patches/ 是补丁索引，都不能让 AI 免审自改。豁免必须精确到 tmp/ 前缀。
        if (rel === '.cadt/tmp' || rel.startsWith('.cadt/tmp/')) return false;
        if (rel === '.cadt' || rel.startsWith('.cadt/') || rel.includes('/.cadt/')) return true;
        if (rel === '.agents' || rel.startsWith('.agents/') || rel.includes('/.agents/')) return true;
        return false;
    }

    async function applyWorkspaceWrite(session, toolMessage, info) {
        const scope = currentScopeOf(session);
        const dirty = isFileDirty(info.path);
        const risky = dirty || isAutoWriteRisky(info.path);
        const rules = await ensureProjectRules(false);
        // 规则 / 审批 await 期间用户可能已按停止：不再落盘（同 run_command 的停止闸门）
        if (toolHalted(toolMessage)) {
            toolMessage.status = 'error';
            toolMessage.content = '用户已停止生成，写入已取消。';
            refreshToolWrap(session, toolMessage);
            return '用户已停止生成，写入已取消。';
        }
        const rel = writeRuleSubject(aiRelPath(getScopeRoot(), info.path));
        // 子代理隔离 worktree 写：子代理永不弹卡（没人可答），隔离区即审批边界——
        // 本子代理前缀内的写确定性放行（自动应用），前缀外确定性拒绝；回灌由主代理经
        // worktree_manage(action=export, name=…) 走人工 patch 卡。run_command 不挂
        // （命令通道归 subagent-sandbox 方案）。没有隔离区的子代理维持只读（write 工具不挂）。
        let decision;
        const subWorktree = session.parentSessionId ? normalizeWorktreeState(session.worktree) : null;
        if (subWorktree) {
            const verdict = agentWorktreeWriteVerdict(subWorktree, rel);
            if (verdict.verdict === 'deny') {
                logPermission('write', rel, 'deny', 'agent-worktree', '');
                toolMessage.status = 'done';
                toolMessage.content = '超出子代理隔离前缀';
                refreshToolWrap(session, toolMessage);
                return verdict.message;
            }
            decision = {decision: 'allow', source: 'agent-worktree', rule: ''};
        } else {
            decision = decidePermission({
                scope,
                kind: 'write',
                rules,
                subject: rel,
                sessionAllow: isPathApproved(session, info.path),
                risky,
            });
        }
        logPermission('write', rel, decision.decision, decision.source, decision.rule);
        if (decision.decision === 'deny') {
            toolMessage.approval = {
                state: 'denied',
                tool: info.tool,
                path: info.path,
                relPath: info.relPath,
                added: info.added,
                removed: info.removed,
                newFile: info.newFile,
                dirty,
                truncated: info.truncated,
                diff: info.diff,
                denyRule: decision.rule,
            };
            toolMessage.status = 'done';
            toolMessage.content = '项目权限规则禁止写入该文件';
            persistApprovalMutation(session, toolMessage);
            refreshToolWrap(session, toolMessage);
            return '项目权限规则禁止写入：' + info.relPath + '（规则 ' + decision.rule + '）';
        }
        if (decision.decision === 'allow') {
            toolMessage.approval = {
                state: 'approved',
                tool: info.tool,
                path: info.path,
                relPath: info.relPath,
                added: info.added,
                removed: info.removed,
                newFile: info.newFile,
                dirty,
                truncated: info.truncated,
                diff: info.diff,
                remember: decision.source === 'auto' ? 'auto' : 'pre',
                autoRule: decision.source,
                actor: 'auto',
            };
            toolMessage.status = 'running';
            toolMessage.content = decision.source === 'auto' ? '自动审批已放行，正在应用更改…' : '已授权，正在应用更改…';
            // 消息可能已被排队中的持久化任务以「未审批」状态落盘：标记重写，保住放行来源。
            persistApprovalMutation(session, toolMessage);
            refreshToolWrap(session, toolMessage);
        } else {
            const answer = await requestApproval(session, toolMessage, info);
            if (!answer.approved) {
                return answer.cancelled
                    ? '用户已停止生成，写操作已取消。'
                    : '用户放弃了本次更改，文件未修改。';
            }
        }
        try {
            if (info.newFile && backend.AIEnsureDir) {
                // 新文件可能位于尚不存在的目录（如 .cadt/）：SaveFile 只写文件、不建父目录。
                try { await backend.AIEnsureDir(aiPathDir(info.path)); } catch (e) {}
            }
            if (typeof backend.SaveFileChecked === 'function') {
                // 与编辑器保存同一道防线（app.go SaveFileChecked）：读取到落盘的瞬间若磁盘被
                // 其他会话/外部程序改过（expectMtime 不一致）→ 拒绝覆盖，绝不静默清掉他人改动。
                // 会话级陈旧性闸门在 write_file case（ai-write-guard.js），这里是最后一道竞态兜底。
                const result = await backend.SaveFileChecked(
                    info.path, info.content, info.eol || '', !!info.hasBom, info.enc || 'utf-8', info.expectMtime || '');
                if (result && (result.conflict || result.deleted)) {
                    throw new Error(result.deleted
                        ? '文件已被外部删除，写入取消：' + info.relPath + '（如需重建请重新发起写入）'
                        : '落盘前检测到文件刚被外部修改，写入取消：' + info.relPath + '（请 read_file 重读后再试）');
                }
                // 回写指纹：同会话对该文件的后续写入不需重读
                recordWrite(session, info.path, result && result.mtime);
            } else {
                await backend.SaveFile(info.path, info.content, info.eol || '', !!info.hasBom, info.enc || 'utf-8');
            }
        } catch (e) {
            if (toolMessage.approval) {
                toolMessage.approval.state = 'failed';
                toolMessage.approval.error = String((e && e.message) || e);
                persistApprovalMutation(session, toolMessage);
            }
            throw e;
        }
        recordChange(session, info);
        notifyFileChanged(info.path);
        return '已应用更改：' + info.relPath + '（+' + info.added + ' −' + info.removed + '）';
    }

    function webToolLimit(value, min, max, fallback) {
        const n = Math.round(Number(value));
        if (!Number.isFinite(n) || n <= 0) return fallback;
        return Math.max(min, Math.min(max, n));
    }

    function formatWebSearchOutput(query, result) {
        const results = (result && Array.isArray(result.results)) ? result.results : [];
        if (!results.length) {
            return '搜索「' + query + '」没有找到结果。换更短的关键词，或直接用 web_fetch 打开已知 URL。';
        }
        const engine = String((result && result.engine) || 'bing');
        const engineLabel = {bing: '内置 Bing', deepseek: 'DeepSeek', mcp: '本地 MCP'}[engine] || engine;
        const lines = ['搜索「' + query + '」（' + engineLabel + '）：共 ' + results.length + ' 条', ''];
        results.forEach((item, index) => {
            lines.push((index + 1) + '. ' + (item.title || '（无标题）'));
            if (item.url) lines.push('   ' + item.url);
            if (item.snippet) lines.push('   ' + item.snippet);
            if (item.published) lines.push('   日期：' + item.published);
        });
        lines.push('', '需要正文时用 web_fetch 打开具体 URL；引用时附上来源链接。');
        return lines.join('\n');
    }

    function formatWebFetchOutput(result) {
        if (!result) return '抓取失败：没有返回内容。';
        const lines = ['网页：' + (aiTextOf(result.title).trim() || '（无标题）')];
        if (result.finalUrl) lines.push('URL：' + result.finalUrl);
        const meta = [];
        if (result.status) meta.push('HTTP ' + result.status);
        if (result.contentType) meta.push(result.contentType);
        if (result.charset) meta.push(result.charset);
        if (result.bytes) meta.push(result.bytes + ' 字节');
        if (meta.length) lines.push(meta.join(' · '));
        if (result.engine === 'deepseek') lines.push('来源：DeepSeek 抓取（Markdown 正文）');
        if (result.truncated) lines.push('（正文已截断；可提高 maxChars 后重试，最大 60000）');
        lines.push('', '---', aiTextOf(result.text).trim() || '（页面没有可读正文）', '---');
        const links = Array.isArray(result.links) ? result.links.slice(0, 20) : [];
        if (links.length) {
            lines.push('', '页面链接：');
            links.forEach((link, index) => {
                lines.push((index + 1) + '. ' + (link.text || '') + ' — ' + (link.url || ''));
            });
        }
        return lines.join('\n');
    }

    // ---------- session_history：查询本会话原始历史（上下文压缩后找回早期内容） ----------

    // sessionHistoryMessageText 拼一条消息的可搜索文本：正文优先；无正文时退回工具名与参数摘要。
    function sessionHistoryMessageText(message) {
        const content = aiTextOf(message && message.content);
        if (content.trim()) return content;
        if (message && message.role === 'tool') return aiTextOf(message.name);
        if (message && Array.isArray(message.toolCalls)) {
            return message.toolCalls.map((call) => aiTextOf(call && call.name)).join(' ');
        }
        return '';
    }

    // runSessionHistoryQuery 数据源优先磁盘 JSONL（唯一真源，含已归档消息），
    // 读取失败退回内存会话（archived + messages 同源）。硬预算：扫描 ≤2000 条、
    // 单条摘要 ≤600 字、总输出 ≤48KB，超限截断并在结果里注明。
    async function runSessionHistoryQuery(session, input) {
        const query = aiTextOf(input && input.query).trim().toLowerCase();
        const from = Math.max(0, Math.round(Number(input && input.from) || 0));
        const limit = aiClampInt(input && input.limit, 1, 50, 20);
        let messages = null;
        let source = '内存会话';
        if (sessionUseDisk() && backend.AISessionRead) {
            try {
                const raw = await backend.AISessionRead(session.id) || '';
                const replay = replaySessionLog(raw);
                if (replay.archived.length || replay.messages.length) {
                    messages = replay.archived.concat(replay.messages);
                    source = '磁盘 JSONL';
                }
            } catch (e) { /* 落盘读取失败时退回内存会话 */ }
        }
        if (!messages) {
            messages = (session.archived || []).concat(session.messages || []);
        }
        if (messages.length > AI_SESSION_HISTORY_SCAN_MAX) {
            messages = messages.slice(0, AI_SESSION_HISTORY_SCAN_MAX);
        }
        const archivedCount = Array.isArray(session.archived) ? session.archived.length : (source === '磁盘 JSONL' ? undefined : 0);
        const matched = [];
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            const text = sessionHistoryMessageText(message);
            if (!text) continue;
            if (query && !text.toLowerCase().includes(query)) continue;
            matched.push({index: i, message, text});
        }
        if (!matched.length) {
            return '会话「' + (session.title || '') + '」共 ' + messages.length + ' 条原始消息' +
                (query ? '，没有匹配「' + query + '」的内容。' : '（无正文消息）。');
        }
        const lines = ['会话「' + (session.title || '') + '」原始历史（' + source +
            '）：共 ' + messages.length + ' 条，匹配 ' + matched.length + ' 条' +
            '，显示第 ' + Math.min(from + 1, matched.length) + '–' + Math.min(from + limit, matched.length) + ' 条：', ''];
        let outputChars = lines.join('\n').length;
        let shown = 0;
        let truncated = false;
        for (let i = from; i < matched.length && shown < limit; i++, shown++) {
            const item = matched[i];
            const role = item.message.role === 'user' ? '用户'
                : (item.message.role === 'assistant' ? 'AI'
                    : (item.message.role === 'tool' ? '工具:' + (item.message.name || '') : item.message.role));
            const time = item.message.ts ? new Date(Number(item.message.ts)).toLocaleString() : '';
            let snippet = aiTextOf(item.text);
            if (snippet.length > AI_SESSION_HISTORY_SNIPPET) {
                snippet = snippet.slice(0, AI_SESSION_HISTORY_SNIPPET) + '…（已截断）';
            }
            const block = '[#' + item.index + ' ' + role + (time ? ' ' + time : '') + ']\n' + snippet;
            if (outputChars + block.length > AI_SESSION_HISTORY_OUTPUT && shown > 0) {
                truncated = true;
                break;
            }
            lines.push(block, '');
            outputChars += block.length + 2;
        }
        const nextFrom = from + shown;
        if (truncated) lines.push('…（输出达到上限，已停止）');
        if (nextFrom < matched.length) {
            lines.push('…还有 ' + (matched.length - nextFrom) + ' 条命中：用 from=' + nextFrom + ' 继续翻页。');
        }
        if (archivedCount > 0) lines.push('（其中前 ' + archivedCount + ' 条已被上下文压缩归档，不在当前上下文里。）');
        return lines.join('\n');
    }

    // MCP 工具执行（§10.2/§15.4）：审批走与 write_file 同源的判定链（归入写权限档），
    // 调用后留痕只记结构不记值（顶层键名 + 字节数 + 8 位 hash）——MCP 参数里出现
    // token/密码/连接串是常态，不记值是硬线；需要原文走会话 JSONL（留痕是索引，会话是真源）。
    // 返回值统一 {ok, text} 或 {ok:false, denied, message}：能力来源路由要区分「用户拒绝」
    // （不回退，直接作答）与「调用失败」（搜索/抓取回退内置）。
    async function invokeMcpToolWithApproval(name, input, ctx, approvalText) {
        const session = ctx && ctx.session;
        const scope = currentScopeOf(session);
        const rules = await ensureProjectRules(false);
        const decision = decidePermission({
            scope,
            kind: 'write',
            rules,
            subject: name,
            sessionAllow: !!(session && matchCommandRule(commandRulesFor(session), name, 'MCP 工具')),
        });
        logPermission('write', name, decision.decision, decision.source, decision.rule);
        if (decision.decision === 'deny') {
            return {ok: false, denied: true, message: '项目权限规则禁止调用：' + name + '（规则 ' + decision.rule + '）'};
        }
        if (decision.decision === 'ask') {
            if (!session || !ctx.toolMessage) throw new Error('MCP 工具缺少会话上下文，无法请求审批');
            const argsPreview = JSON.stringify(input || {}).slice(0, 2048);
            const answer = await requestCommandApproval(session, ctx.toolMessage, {
                command: approvalText || (name + (argsPreview === '{}' ? '' : ' ' + argsPreview)),
                cwd: 'MCP 工具',
                tool: 'run_command',
            });
            if (!answer.approved) {
                return {
                    ok: false,
                    denied: true,
                    message: answer.cancelled
                        ? '用户已停止生成，未调用 MCP 工具。'
                        : '用户未允许调用：' + name,
                };
            }
        }
        const startedAt = Date.now();
        const route = mcpMod.routeInfo(name);
        try {
            const text = await mcpMod.callTool(name, input);
            mcpLogActivity(route, name, input, 'ok', Date.now() - startedAt);
            return {ok: true, text};
        } catch (e) {
            mcpLogActivity(route, name, input, 'error', Date.now() - startedAt);
            throw e;
        }
    }

    async function executeMcpTool(name, input, ctx) {
        const result = await invokeMcpToolWithApproval(name, input, ctx);
        return result.ok ? result.text : result.message;
    }

    // 能力来源=MCP：调用户绑定的 MCP 公开工具；调用前校验绑定仍在快照里。
    async function invokeExternalMcp(capability, input, ctx) {
        const binding = String((externalToolsConfig.mcpBindings || {})[capability] || '');
        if (!binding) throw new Error('未绑定 MCP 工具（设置 → AI → 外部工具）');
        if (!externalMcpToolNames().includes(binding)) {
            throw new Error('绑定的 MCP 工具不可用：' + binding + '（服务器被禁用 / 删除，或工具未勾选）');
        }
        return await invokeMcpToolWithApproval(binding, input, ctx,
            'MCP 能力来源 · ' + capability + ' → ' + binding);
    }

    // 服务提供商上传审批（OCR / ASR）：kind:'web' 沿用域名规则；默认放行，项目规则可 ask / deny。
    async function approveExternalProviderUpload(toolName, ctx, command) {
        const session = ctx && ctx.session;
        const host = externalProviderHost();
        const rules = await ensureProjectRules(false);
        const sessionRule = session
            ? matchCommandRule(commandRulesFor(session), host, aiPathKey('网络请求'))
            : null;
        const decision = decidePermission({
            scope: currentScopeOf(session),
            kind: 'web',
            rules,
            subject: host,
            sessionAllow: !!sessionRule,
        });
        logPermission('web', host, decision.decision, decision.source, decision.rule);
        if (decision.decision === 'deny') {
            throw new Error('项目权限规则禁止上传到外部服务：' + host + '（规则 ' + decision.rule + '）');
        }
        if (decision.decision === 'ask') {
            if (!session || !ctx || !ctx.toolMessage) throw new Error('外部工具缺少会话上下文，无法请求审批');
            const answer = await requestCommandApproval(session, ctx.toolMessage, {
                command: command,
                cwd: '外部服务上传 · ' + host,
                tool: toolName,
            });
            if (!answer.approved) {
                return answer.cancelled ? '用户已停止生成，未上传。' : '用户未允许上传到外部服务：' + host;
            }
        }
        return '';
    }

    // TTS 产物写工作区：审批按写工具档（read/edit 弹卡、auto/full 直发），与生图同口径。
    async function approveExternalWrite(toolName, ctx, command) {
        const session = ctx && ctx.session;
        const rules = await ensureProjectRules(false);
        const sessionRule = session
            ? matchCommandRule(commandRulesFor(session), toolName, aiPathKey('生成请求'))
            : null;
        const decision = decidePermission({
            scope: currentScopeOf(session),
            kind: 'write',
            rules,
            subject: toolName,
            sessionAllow: !!sessionRule,
        });
        logPermission('write', toolName, decision.decision, decision.source, decision.rule);
        if (decision.decision === 'deny') {
            throw new Error('项目权限规则禁止语音合成（规则 ' + decision.rule + '）');
        }
        if (decision.decision === 'ask') {
            if (!session || !ctx || !ctx.toolMessage) throw new Error('语音合成缺少会话上下文');
            const answer = await requestCommandApproval(session, ctx.toolMessage, {
                command: command,
                cwd: '生成请求',
                tool: toolName,
            });
            if (!answer.approved) {
                return answer.cancelled ? '用户已停止生成，未执行。' : '用户未允许语音合成。';
            }
        }
        return '';
    }

    function fileNameOf(path) {
        return String(path || '').split(/[\\/]/).pop() || '文件';
    }

    // ---------- 生图/视频（generate_image / generate_video / check_gen，ai-gen-models.md §3.4） ----------
    // 审批按写工具档：decidePermission kind:'write'（read/edit 弹卡、auto/full 直发），项目规则
    // Write(generate_image) 形态可覆写；prompt 发往用户配置的服务商并可能产生费用。

    function genKindLabel(kind) {
        return kind === 'video' ? '视频' : '图片';
    }

    // review: true 时把首张生成图回传对话（browser_screenshot 同款注入链；仅多模态输入模型有意义）。
    async function genReviewImages(session, files) {
        const chatEntry = entryOf(session);
        if (!chatEntry || !chatEntry.modalities || chatEntry.modalities.image !== true) {
            return '当前聊天模型未启用图像输入，已跳过图片回传。';
        }
        const imageFile = (files || []).find((file) => file && file.mime && file.mime.startsWith('image/') && file.bytes <= 6 << 20);
        if (!imageFile) return '没有适合回传的图片（超过 6MB 或非图片产物）。';
        const dataURL = await backend.ReadImageAsDataURL(imageFile.path);
        if (!dataURL || dataURL.indexOf('base64,') < 0) throw new Error('读取生成图片失败');
        const b64 = dataURL.slice(dataURL.indexOf('base64,') + 7);
        // 图片过大：跳过回传（保护上下文预算），产物已正常保存——这是有意跳过，不是失败
        if (dataURLBytes(dataURL) > AI_IMAGE_MAX_BASE64) {
            return '生成图较大（约 ' + (dataURLBytes(dataURL) / (1 << 20)).toFixed(1) +
                'MB），已跳过图片回传；产物已正常保存，可用 read_image 查看。';
        }
        const normalized = aiNormalizeImage({mime: imageFile.mime, data: b64, name: '生成图'});
        if (!normalized) throw new Error('生成图片数据无法解析');
        queueSessionImage(session, {
            role: 'user',
            content: '[生成图片（generate_image review 自动附加）]',
            images: [normalized],
            app: normalizeAppMessage({kind: 'app', label: '生成图片', icon: 'image'}),
            ts: Date.now(),
        });
        return '';
    }

    // 参考图解析（图生图 / edits，ai-gen-image-edit.md §3.1）：元素二选一——
    // http(s) 图片 URL 原样透传（由服务商拉取），本地图片走 read_file 同一条授权链读成 Data URL。
    // labels = 审批卡与工具卡上给用户看的清单（本地图用绝对路径，重启后仍能现读缩略图）；
    // values = 真正塞进请求体的值（Data URL / URL）。任何一张失败整单失败（不静默丢图）。
    async function resolveGenReferences(ctx, raw) {
        const list = Array.isArray(raw) ? raw : (raw == null || raw === '' ? [] : [raw]);
        if (!list.length) return {ok: true, labels: [], values: []};
        if (list.length > GEN_REF_LIMIT) {
            return {ok: false, message: '参考图至多 ' + GEN_REF_LIMIT + ' 张（当前 ' + list.length + ' 张）。请挑最关键的几张重试。'};
        }
        if (!backend.ReadImageAsDataURL) {
            return {ok: false, message: '当前版本不支持读取本地图片（请重新构建或更新应用）。'};
        }
        const labels = [];
        const values = [];
        for (const item of list) {
            const ref = classifyGenRef(item);
            if (ref.kind === 'empty') continue;
            if (ref.kind === 'invalid') {
                return {ok: false, message: '参考图只接受 http(s) 图片 URL 或本地图片路径：' + ref.value};
            }
            if (ref.kind === 'url') {
                labels.push(ref.value);
                values.push(ref.value);
                continue;
            }
            const resolved = await resolveReadPathWithApproval(ctx, 'generate_image', ref.value);
            if (!resolved.ok) return {ok: false, message: resolved.message};
            let dataURL = '';
            try {
                dataURL = await backend.ReadImageAsDataURL(resolved.path);
            } catch (e) {
                return {ok: false, message: '读取参考图失败：' + resolved.path + '（' + ((e && e.message) || e) + '）'};
            }
            if (!dataURL || dataURL.indexOf('base64,') < 0) {
                return {ok: false, message: '读取参考图失败：' + resolved.path + '（不是可用的图片数据）'};
            }
            const bytes = dataURLBytes(dataURL);
            if (bytes > GEN_REF_BYTES_LIMIT) {
                return {
                    ok: false,
                    message: '参考图「' + resolved.path + '」约 ' + (bytes / (1 << 20)).toFixed(1) +
                        'MB，超过单张 4MB 上限。请先压缩再重试（不自动压缩，避免构图与画质被悄悄改掉）。',
                };
            }
            labels.push(resolved.path);
            values.push(dataURL);
        }
        return {ok: true, labels, values};
    }

    async function runGenerateTool(kind, input, ctx) {
        const toolName = kind === 'video' ? 'generate_video' : 'generate_image';
        const session = ctx && ctx.session;
        const modelRef = aiTextOf(input.model);
        const entry = genModelByRef(config.genModels, kind, modelRef);
        if (!entry) {
            throw new Error('没有可用的' + genKindLabel(kind) + '条目' +
                (modelRef ? '：「' + modelRef + '」未找到或未启用' : '（请在 设置 → AI → 生图与视频模型 里配置）'));
        }
        const workspace = getScopeRoot();
        if (!workspace) throw new Error('当前没有工作区，无法保存生成产物');
        // 参考图（图生图 / edits）：只有配了 editPath 的同步型生图条目能承载。
        // 空白元素先剔掉——否则 reference: "" 这种输入会误触发「未配编辑端点」。
        const refList = (Array.isArray(input.reference)
            ? input.reference
            : (input.reference == null ? [] : [input.reference]))
            .filter((item) => classifyGenRef(item).kind !== 'empty');
        let refs = {ok: true, labels: [], values: []};
        if (refList.length) {
            if (kind !== 'image') throw new Error('generate_video 暂不支持参考图（服务商形态各家差异大，另行评估）。');
            if (isAsyncGenModel(entry)) {
                throw new Error('该条目是异步型（配了提交/轮询端点），暂不支持参考图：已知的编辑端点均为同步型。');
            }
            if (!entry.editPath) {
                throw new Error('该条目未配置编辑端点（editPath），不支持参考图。' +
                    '请让用户在 设置 → AI → 生图与视频 → 编辑 里填写编辑端点，或换一个配了编辑端点的条目。');
            }
            // multipart 型编辑端点（Qwen-Image / OpenAI 官方 /v1/images/edits）的图片走独立的
            // image 文件字段，不经过请求体模板，所以不要求 {{images}} 占位符。
            if (entry.editFormat !== 'multipart' && !/\{\{\s*images\s*\}\}/.test(entry.bodyTemplate || '')) {
                throw new Error('该条目的请求体模板没有 {{images}} 占位符，参考图进不了请求体；请先补上 {{images}}。');
            }
            refs = await resolveGenReferences(ctx, refList);
            if (!refs.ok) throw new Error(refs.message);
        }
        // 审批卡 command 是单行文本（.ai-cmd-text 不保留换行）：参考图清单用括号内联，
        // 用户在批准这一刻能看清哪几张图会被外传（本地图显示绝对路径，远程图显示 URL）。
        const refNote = refs.labels.length
            ? '（参考图 ' + refs.labels.length + ' 张：' + refs.labels.join('、') + '）'
            : '';
        const rules = await ensureProjectRules(false);
        const sessionRule = session
            ? matchCommandRule(commandRulesFor(session), entry.baseURL, aiPathKey('生成请求'))
            : null;
        const decision = decidePermission({
            scope: currentScopeOf(session),
            kind: 'write',
            rules,
            subject: toolName,
            sessionAllow: !!sessionRule,
        });
        logPermission('write', toolName, decision.decision, decision.source, decision.rule);
        if (decision.decision === 'deny') {
            throw new Error('项目权限规则禁止生成（规则 ' + decision.rule + '）');
        }
        if (decision.decision === 'ask') {
            if (!session || !ctx.toolMessage) throw new Error('生成工具缺少会话上下文');
            const brief = aiTextOf(input.prompt).slice(0, 120);
            const answer = await requestCommandApproval(session, ctx.toolMessage, {
                command: toolName + ' · ' + (entry.name || entry.id) + '：' + brief + refNote,
                cwd: '生成请求',
                tool: toolName,
            });
            if (!answer.approved) {
                return answer.cancelled
                    ? '用户已停止生成，未执行。'
                    : '用户未允许' + genKindLabel(kind) + '生成：' + brief;
            }
        }
        const params = {
            prompt: aiTextOf(input.prompt),
            // model 必须填服务商模型 id（entry.defaultModel），不是条目内部 id（entry.id）：
            // 请求体模板的 {{model}} 直接发给服务商，填内部 id 会得到 "model is not found"。
            // 条目未配 defaultModel（自定义条目）时回落 entry.id，保持旧行为。
            model: entry.defaultModel || entry.id,
            size: aiTextOf(input.size),
            n: input.n,
            outputPath: aiTextOf(input.outputPath),
            // 参考图的值（Data URL / URL）只进请求体：不落日志、不进模型上下文
            references: refs.values,
        };
        // 留痕：只记条目名与参数摘要（prompt 记长度不记原文），产物计数
        if (activity) {
            activity.log('ai', toolName, {
                entry: entry.name || entry.id,
                promptLen: params.prompt.length,
                size: params.size || entry.defaultSize || '',
                n: kind === 'image' ? Math.max(1, Math.round(Number(input.n) || entry.defaultN || 1)) : undefined,
                refCount: refs.labels.length || undefined,
                output: params.outputPath || '',
            }, {actor: 'ai', noRel: true});
        }
        // 异步型：提交即返回，完成经信箱唤醒本会话（wakeSessionByGenDone）
        if (isAsyncGenModel(entry)) {
            const jobId = await genJobsMod.submitJob(workspace, session.id, entry, params, ctx.toolMessage);
            return '已提交' + genKindLabel(kind) + '生成任务（' + (entry.name || entry.id) + '）。\n任务 id：' + jobId +
                '\n完成后会自动通知本会话；期间可用 check_gen(jobId="' + jobId + '") 查询进度。';
        }
        // 同步型：等待完成（Go 侧超时保护），产物落盘后返回清单
        const files = await genJobsMod.runSync(workspace, entry, params);
        if (ctx.toolMessage) {
            ctx.toolMessage.gen = normalizeGenSnapshot({
                kind, entryName: entry.name || entry.id, status: 'done', files, references: refs.labels,
            });
            const owner = sessionById(session.id);
            if (owner) refreshToolWrap(owner, ctx.toolMessage);
        }
        let reviewNote = '';
        if (input.review === true && kind === 'image' && files.length) {
            try {
                reviewNote = await genReviewImages(session, files);
            } catch (e) {
                reviewNote = '图片回传失败：' + ((e && e.message) || e);
            }
        }
        const lines = files.map((file) => '- ' + file.path + '（' + file.mime + '，' + file.bytes + ' 字节）').join('\n');
        return '已生成 ' + files.length + ' 个产物（' + (entry.name || entry.id) +
            (refs.labels.length ? ' · 参考图 ' + refs.labels.length + ' 张（走编辑端点 ' + entry.editPath + '）' : '') + '）：\n' + lines +
            (reviewNote ? '\n' + reviewNote : '') +
            '\n可在回复中用 Markdown 图片语法（![](' + '相对路径)）向用户展示产物。';
    }

    function mcpLogActivity(route, name, input, status, ms) {
        if (!activity) return;
        const keys = input && typeof input === 'object' ? Object.keys(input).sort() : [];
        let bytes = 0;
        let hash = '';
        try {
            const raw = JSON.stringify(input || {});
            bytes = raw.length;
            // FNV-1a 8 位 hex：仅用于事后比对「是不是同一个调用」，不接触原文
            let h = 0x811c9dc5;
            for (let i = 0; i < raw.length; i++) {
                h ^= raw.charCodeAt(i);
                h = Math.imul(h, 0x01000193) >>> 0;
            }
            hash = h.toString(16).padStart(8, '0');
        } catch (e) {}
        activity.log('mcp.tool', (route ? route.server + '/' + route.rawName : name), {
            keys, bytes, hash, openWorld: !!(route && route.openWorld), status, ms,
        }, {actor: 'ai', noRel: true});
    }

    // 工具执行期间产生的「图片消息」（read_image / generate_image review）不立即 push：
    // 直接插进去会落在 assistant(tool_calls) 与后续 tool 结果之间，OpenAI 侧会以
    // 「must be followed by tool messages」拒收整轮请求。统一排到工具批次结束再落盘，
    // 由 flushToolImages 在轮边界（连同新 assistant 的 renderMessages 一起）挂上。
    const pendingToolImages = new WeakMap(); // session -> [message]

    function queueSessionImage(session, message) {
        if (!session || !message) return;
        const list = pendingToolImages.get(session);
        if (list) list.push(message);
        else pendingToolImages.set(session, [message]);
    }

    function flushToolImages(session) {
        const list = session && pendingToolImages.get(session);
        if (!list || !list.length) return 0;
        pendingToolImages.delete(session);
        for (const message of list) session.messages.push(message);
        persistSessions();
        return list.length;
    }

    // ---- MCP 配置桥（app_control：get_mcp_servers / set_mcp_server / delete_mcp_server）----
    // 与生图条目同构，但边界更严：env 键可由 AI 登记（值留空）、env 值不可写、
    // enabledTools 永远由用户勾选；新增/修改/删除每次都要用户确认本机命令。
    const MCP_CONFIG_ACTIONS = ['get_mcp_servers', 'list_mcp_samples', 'install_mcp_sample', 'set_mcp_server', 'delete_mcp_server'];

    async function runMcpConfigAction(action, params, ctx) {
        if (action === 'list_mcp_samples') {
            if (typeof backend.MCPSamplesList !== 'function') {
                throw new Error('当前后端版本不支持内置 MCP 示例（请重新构建或更新应用）');
            }
            return {samples: await backend.MCPSamplesList()};
        }
        if (typeof backend.MCPGetConfig !== 'function' || typeof backend.MCPWriteConfig !== 'function') {
            throw new Error('当前后端版本不支持 MCP 配置（请重新构建或更新应用）');
        }
        const current = await backend.MCPGetConfig();
        if (action === 'get_mcp_servers') {
            return mcpConfigView(current, mcpMod.getState(), externalToolsConfig.mcpBindings);
        }
        const session = ctx && ctx.session;
        if (!session || !ctx.toolMessage) throw new Error('MCP 配置缺少会话上下文，无法请求确认');
        if (session.planMode === true) throw new Error('计划模式不修改 MCP 配置；退出计划模式后再操作');
        if (action === 'install_mcp_sample') {
            if (typeof backend.MCPSamplesList !== 'function' || typeof backend.MCPInstallSample !== 'function') {
                throw new Error('当前后端版本不支持内置 MCP 示例（请重新构建或更新应用）');
            }
            const id = aiTextOf(params.id).trim();
            if (!id) throw new Error('install_mcp_sample 需要 id');
            const list = await backend.MCPSamplesList();
            const sample = (list || []).find((item) => item.id === id);
            if (!sample) throw new Error('未知内置示例：' + id);
            if (sample.installed) return {installed: false, note: '该示例已经安装（同名服务器已存在）。'};
            const answer = await requestCommandApproval(session, ctx.toolMessage, {
                command: '安装内置 MCP 示例「' + sample.name + '」：\n' + sample.commandPreview +
                    '\n将启用工具 ' + sample.toolName + '（本机执行）。',
                cwd: 'MCP 内置示例',
                tool: 'install_mcp_sample',
            });
            if (!answer.approved) {
                return answer.cancelled ? '用户已停止生成，未安装示例。' : '用户未允许安装该内置示例。';
            }
            const result = await backend.MCPInstallSample(id);
            Promise.resolve(mcpMod.refresh()).catch(() => {});
            if (mcpSettingsMod) mcpSettingsMod.renderAll();
            flash('AI 已安装内置 MCP 示例「' + sample.name + '」');
            return result;
        }
        if (action === 'set_mcp_server') {
            const source = params.server && typeof params.server === 'object' ? params.server : params;
            const plan = mergeMcpServerConfig(current, source);
            const preview = mcpServerCommandPreview(plan.server);
            const envKeys = Object.keys(plan.server.env || {}).sort();
            const answer = await requestCommandApproval(session, ctx.toolMessage, {
                command: (plan.created ? '新增' : '修改') + ' MCP 服务器「' + plan.name + '」\n' + preview +
                    (envKeys.length ? '\n环境变量键（值由你填写）：' + envKeys.join(', ') : '') +
                    '\n该命令会在本机执行；工具授权仍需你在设置里勾选。',
                cwd: 'MCP 服务器（本机）',
                tool: 'set_mcp_server',
            });
            if (!answer.approved) {
                return answer.cancelled ? '用户已停止生成，MCP 配置未修改。' : '用户未允许修改 MCP 配置。';
            }
            await backend.MCPWriteConfig(plan.config);
            Promise.resolve(mcpMod.refresh()).catch(() => {});
            if (mcpSettingsMod) mcpSettingsMod.renderAll();
            flash('AI 已' + (plan.created ? '新增' : '修改') + ' MCP 服务器「' + plan.name + '」');
            return {
                ok: true,
                created: plan.created,
                name: plan.name,
                command: plan.server.command,
                argCount: plan.server.args.length,
                envKeys,
                note: '配置已保存。请让用户在 设置 → AI → 外部工具 → MCP 服务器 → 该行「工具」里勾选要授权给 AI 的工具（默认全不勾）' +
                    (envKeys.length ? '，并在「编辑」里填写环境变量的值' : '') +
                    (plan.config.enabled === false ? '；MCP 客户端总开关当前是关闭的，需要用户开启' : '') + '。',
            };
        }
        if (action === 'delete_mcp_server') {
            const plan = planMcpServerDelete(current, params.name);
            if (!plan.deleted) return {deleted: false, note: plan.note};
            const answer = await requestCommandApproval(session, ctx.toolMessage, {
                command: '删除 MCP 服务器「' + plan.name + '」：' + mcpServerCommandPreview(plan.server) +
                    '\n其进程会停止，配置将被删除。',
                cwd: 'MCP 服务器（本机）',
                tool: 'delete_mcp_server',
            });
            if (!answer.approved) {
                return answer.cancelled ? '用户已停止生成，未删除。' : '用户未允许删除该 MCP 服务器。';
            }
            await backend.MCPWriteConfig(plan.config);
            Promise.resolve(mcpMod.refresh()).catch(() => {});
            if (mcpSettingsMod) mcpSettingsMod.renderAll();
            flash('AI 已删除 MCP 服务器「' + plan.name + '」');
            return {deleted: true, name: plan.name};
        }
        throw new Error('未知 MCP 配置动作：' + action);
    }

    // gateWebTarget 联网工具共用的目标闸门：联网开关 → 项目域名规则（deny 直接拒绝、ask 弹审批）。
    // 返回 null 表示放行，返回字符串表示本次调用要原样回给模型的说明。内网 / 保留地址不在这里判，
    // 由 Go 侧 webValidateURL 兜底（两处入口都过它）。
    async function gateWebTarget(target, ctx, toolName) {
        const isImage = toolName === 'read_image';
        const subject = isImage ? '读取网络图片' : '网页抓取';
        if (externalModeOf('fetch') === 'off') {
            throw new Error(isImage
                ? '读取网络图片已被用户关闭（设置 → AI → 外部工具：「网页抓取」为关闭时网图一并停用）'
                : subject + '已被用户关闭（设置 → AI → 外部工具）');
        }
        const hostSubject = webRuleSubject(target);
        if (!hostSubject) return null;
        const rules = await ensureProjectRules(false);
        const session = ctx && ctx.session;
        const sessionRule = session
            ? matchCommandRule(commandRulesFor(session), target, aiPathKey('网络请求'))
            : null;
        const decision = decidePermission({
            scope: currentScopeOf(session),
            kind: 'web',
            rules,
            subject: hostSubject,
            sessionAllow: !!sessionRule,
        });
        logPermission('web', hostSubject, decision.decision, decision.source, decision.rule);
        if (decision.decision === 'deny') {
            throw new Error('项目权限规则禁止访问该域名：' + hostSubject + '（规则 ' + decision.rule + '）');
        }
        if (decision.decision === 'ask') {
            if (!session || !ctx.toolMessage) throw new Error(subject + '缺少会话上下文');
            const answer = await requestCommandApproval(session, ctx.toolMessage, {
                command: target,
                cwd: '网络请求',
                tool: toolName,
                web: true,
            });
            if (!answer.approved) {
                return answer.cancelled
                    ? '用户已停止生成，未抓取网页。'
                    : (isImage ? '用户未允许读取该地址：' : '用户未允许抓取该网页：') + target;
            }
        }
        return null;
    }

    async function executeTool(name, args, ctx) {
        const input = args && typeof args === 'object' ? args : {};
        // MCP 转发：公开名 mcp__ 前缀走审批判定后直通 Go 路由（查表发原始名），零侵入现有 switch
        if (name.startsWith('mcp__')) return executeMcpTool(name, input, ctx);
        // 外部工具执行前确保来源配置已读入（缓存命中时只是微任务；首次失败会重试）
        if (name === 'web_search' || name === 'web_fetch' || name === 'ocr' ||
            name === 'text_to_speech' || name === 'transcribe_audio') {
            await loadExternalToolsConfig();
        }
        switch (name) {
            case 'list_dir': {
                const rel = aiTextOf(input.path).trim() || '.';
                const depth = Math.max(1, Math.min(8, Math.round(Number(input.depth) || 1)));
                // 递归时整个子树都在授权范围内：授权粒度记目录本身，与 search_text 的起点同语义
                const resolved = await resolveReadPathWithApproval(ctx, 'list_dir', rel, depth > 1 ? {scanRoot: true} : undefined);
                if (!resolved.ok) return resolved.message;
                const path = resolved.path;
                if (depth > 1) {
                    const tree = await backend.ReadDirTree(path, depth);
                    const lines = ['目录：' + redactToolText(rel, ctx && ctx.session) + '（递归 ' + (tree ? tree.depth : depth) + ' 层）'];
                    const treeLines = renderDirTreeText(tree && tree.root ? tree.root.children : null);
                    if (treeLines.length) lines.push(...treeLines);
                    else lines.push('（空目录）');
                    if (tree && tree.truncated) {
                        lines.push('…（条目超预算已截断：共收录 ' + tree.total + ' 项，树不完整；可收窄 path 或改用 glob）');
                    }
                    return lines.join('\n');
                }
                const listing = await backend.ReadDir(path, 200);
                const entries = (listing && listing.entries) || [];
                const lines = ['目录：' + redactToolText(rel, ctx && ctx.session)];
                for (const entry of entries) {
                    const sizeText = entry.isDir ? '' : humanSizeBytes(entry.size);
                    lines.push((entry.isDir ? '[D] ' : '[F] ') + entry.name + (sizeText ? '（' + sizeText + '）' : ''));
                }
                if (!entries.length) lines.push('（空目录）');
                if (listing && listing.truncated) {
                    lines.push('…（条目过多已截断：共 ' + (listing.total != null ? listing.total : entries.length + '+') + ' 项，只列前 ' + entries.length + ' 项）');
                }
                return lines.join('\n');
            }
            case 'read_file': {
                const resolved = await resolveReadPathWithApproval(ctx, 'read_file', input.path);
                if (!resolved.ok) return resolved.message;
                const path = resolved.path;
                const read = await readTextFile(path, null);
                // 记录读取时磁盘指纹：write_file 陈旧性防护的基线（见 ai-write-guard.js）
                recordRead(ctx && ctx.session, path, read.data && read.data.mtime, read.data && read.data.size);
                const view = readWindowOf(read.text, normalizeReadWindow(input));
                // 卡片路径超链接的跳转行：窗口起始行（1-based）挂到工具卡
                if (ctx && ctx.toolMessage) {
                    ctx.toolMessage.targetPath = path;
                    ctx.toolMessage.targetLine = view.targetLine;
                }
                let head = '文件：' + redactToolText(input.path || path, ctx && ctx.session) + '（' + read.data.size + ' 字节';
                if (view.startLine != null) head += '，行 ' + view.startLine + '-' + view.endLine + '，共 ' + view.totalLines + ' 行';
                head += '）\n\n';
                return head + view.text + (view.hint ? '\n' + view.hint : '');
            }
            case 'read_image': {
                const target = aiTextOf(input.path).trim();
                // 公网图片直接传 URL：与本地文件共用同一条「图片进对话」注入链，只有取字节的通道不同
                const remote = /^https?:\/\//i.test(target);
                const session = ctx && ctx.session;
                if (!session) throw new Error('当前没有会话，无法把图片附加到对话');
                let path = '';
                let shown = '';
                if (remote) {
                    // 联网开关与域名规则与 web_fetch 同源；内网 / 保留地址由 Go 侧 webValidateURL 兜底
                    const blocked = await gateWebTarget(target, ctx, 'read_image');
                    if (blocked) return blocked;
                    shown = target;
                } else {
                    // 与 read_file 同一条路径授权链（工作区外 read/edit 档弹卡、auto/full 直读、点名直读）
                    const resolved = await resolveReadPathWithApproval(ctx, 'read_image', input.path);
                    if (!resolved.ok) return resolved.message;
                    path = resolved.path;
                    shown = redactToolText(input.path || path, session);
                }
                // modalities.image === false 才是「明确不支持」；字段缺省表示不清楚，放行由服务商判定
                const chatEntry = entryOf(session);
                if (chatEntry && chatEntry.modalities && chatEntry.modalities.image === false) {
                    return '当前聊天模型未启用图像输入（设置 → AI → 该模型条目的「图像输入」），图片无法交给它看。' +
                        '不要重试：请让用户换用支持图像输入的模型，或改用文字/代码方式说明。';
                }
                let dataURL = '';
                let label = '图片';
                try {
                    if (remote) {
                        if (!backend.WebFetchImage) throw new Error('当前版本不支持读取网络图片（请重新构建或更新应用）');
                        const fetched = await backend.WebFetchImage(target);
                        dataURL = aiTextOf(fetched && fetched.dataUrl).trim();
                        if (!dataURL) throw new Error('没有取到图片内容');
                        label = aiTextOf(fetched && fetched.name).trim() || '网络图片';
                    } else {
                        if (!backend.ReadImageAsDataURL) throw new Error('当前版本不支持读取图片');
                        dataURL = await backend.ReadImageAsDataURL(path);
                        label = String(input.path || path).split(/[\\/]/).pop() || '图片';
                    }
                } catch (e) {
                    const reason = (e && e.message) || String(e || '');
                    if (remote) {
                        throw new Error('抓不了这张网图：' + reason +
                            '。只支持公网可直链访问的 png / jpg / webp / gif / bmp / svg（需要登录或防盗链的地址取不到）；' +
                            '文本页面请用 web_fetch。');
                    }
                    if (/不支持的图片格式|图片过大/.test(reason)) {
                        throw new Error('读不了这张图：' + reason + '（read_image 支持 png / jpg / webp / gif / bmp / svg）。' +
                            '文本内容请用 read_file。');
                    }
                    throw e;
                }
                const payload = await prepareImagePayload(dataURL, {
                    maxDim: AI_IMAGE_MAX_DIM,
                    maxBase64: AI_IMAGE_MAX_BASE64,
                    name: label,
                });
                const normalized = aiNormalizeImage(payload);
                if (!normalized) throw new Error('图片数据无法解析（格式不支持或压缩后仍然过大）');
                queueSessionImage(session, {
                    role: 'user',
                    content: '[图片：' + shown + '（read_image 自动附加）]',
                    images: [normalized],
                    app: normalizeAppMessage({kind: 'read-image', label: remote ? '读取网络图片' : '读取图片', icon: 'image'}),
                    ts: Date.now(),
                });
                if (ctx && ctx.toolMessage) {
                    if (remote) ctx.toolMessage.targetUrl = target;
                    else ctx.toolMessage.targetPath = path;
                }
                return '已把图片附加到对话：' + shown + '（' + payload.width + '×' + payload.height + '，' +
                    payload.mime + '，' + humanSizeBytes(payload.bytes) + '）。图片作为独立消息挂在工具结果之后，' +
                    '直接按画面内容回答即可；不要再用 read_file 读它。';
            }
            case 'read_video': {
                const target = aiTextOf(input.path).trim();
                if (/^https?:\/\//i.test(target)) {
                    return 'read_video 不支持公网 URL：只读本地/工作区 mp4 文件（网页视频无法直链转存）。';
                }
                const session = ctx && ctx.session;
                if (!session) throw new Error('当前没有会话，无法把视频附加到对话');
                // 与 read_file 同一条路径授权链（工作区外 read/edit 档弹卡、auto/full 直读、点名直读）
                const resolved = await resolveReadPathWithApproval(ctx, 'read_video', input.path);
                if (!resolved.ok) return resolved.message;
                const path = resolved.path;
                const shown = redactToolText(input.path || path, session);
                // modalities.video === false 才是「明确不支持」；字段缺省表示不清楚，放行由服务商判定
                const chatEntry = entryOf(session);
                if (chatEntry && chatEntry.modalities && chatEntry.modalities.video === false) {
                    return '当前聊天模型未启用视频输入（设置 → AI → 该模型条目的「视频输入」），视频无法交给它看。' +
                        '不要重试：请让用户换用支持视频输入的模型，或改用文字方式描述视频内容。';
                }
                if (!backend.ReadVideoAsDataURL) throw new Error('当前版本不支持读取视频');
                const dataURL = await backend.ReadVideoAsDataURL(path);
                const payload = aiVideoFromSrc(dataURL, String(path).split(/[\\/]/).pop());
                if (!payload) throw new Error('视频数据无法解析（当前仅支持 mp4，且不超过 16 MB）');
                const normalized = aiNormalizeVideo(payload);
                if (!normalized) throw new Error('视频数据无法解析（格式不支持或超过大小上限）');
                queueSessionImage(session, {
                    role: 'user',
                    content: '[视频：' + shown + '（read_video 自动附加）]',
                    videos: [normalized],
                    app: normalizeAppMessage({kind: 'read-video', label: '读取视频', icon: 'play'}),
                    ts: Date.now(),
                });
                if (ctx && ctx.toolMessage) ctx.toolMessage.targetPath = path;
                return '已把视频附加到对话：' + shown + '（' + payload.mime + '，' +
                    humanSizeBytes(payload.bytes) + '）。视频作为独立消息挂在工具结果之后，' +
                    '直接按视频内容回答即可；不要再用 read_file 读它。';
            }
            case 'search_text': {
                const query = aiTextOf(input.query).trim();
                if (!query) throw new Error('搜索内容为空');
                const start = aiTextOf(input.path).trim();
                const resolvedRoot = await resolveScanRoot(ctx, 'search_text', start);
                if (!resolvedRoot.ok) return resolvedRoot.message;
                const root = resolvedRoot.path;
                const pattern = aiTextOf(input.filePattern).trim();
                // 有文件过滤时把 Go 侧命中窗口放大到上限（1000），过滤后再截，避免先截 200 漏掉目标文件的命中。
                // 新版本把 filePattern 下推到搜索层（rg --glob / 内置扫描过滤）；旧后端回退到「取大窗再前端过滤」。
                const result = (pattern && backend.SearchWorkspaceFiltered)
                    ? await backend.SearchWorkspaceFiltered(root, query, !!input.caseSensitive, 1000, pattern)
                    : await backend.SearchWorkspace(root, query, !!input.caseSensitive, pattern ? 1000 : 200);
                let hits = (result && result.hits) || [];
                let truncated = !!(result && result.truncated);
                let filterNote = '';
                const rootNorm = aiNormalizePath(root).replace(/\/+$/, '');
                if (pattern) {
                    const before = hits.length;
                    hits = hits.filter((hit) => {
                        const shown = aiNormalizePath(hit.path);
                        const rel = rootNorm && shown.toLowerCase().startsWith(rootNorm.toLowerCase() + '/')
                            ? shown.slice(rootNorm.length + 1)
                            : shown;
                        return globMatchPath(pattern, rel, hit.name);
                    });
                    filterNote = '按 "' + pattern + '" 过滤：命中 ' + hits.length + '（过滤前 ' + before + '）';
                    if (hits.length > 200) {
                        hits = hits.slice(0, 200);
                        truncated = true;
                    }
                }
                if (!hits.length) {
                    return '没有找到匹配：' + query + (start ? '（起点：' + start + '）' : '') +
                        (filterNote ? '（' + filterNote + '）' : '');
                }
                const lines = hits.map((hit) => {
                    let shown = aiNormalizePath(hit.path);
                    if (rootNorm && shown.toLowerCase().startsWith(rootNorm.toLowerCase() + '/')) {
                        shown = shown.slice(rootNorm.length + 1);
                    }
                    return shown + ':' + hit.line + ': ' + hit.preview;
                });
                if (start) lines.unshift('搜索起点：' + start + '；以下路径相对该起点');
                if (filterNote) lines.push('（' + filterNote + '）');
                if (truncated) lines.push('…（结果已截断）');
                if (result && result.artifactSkipped) {
                    lines.push('…（源码命中已占满窗口，产物档 dist/build 等未检索）');
                }
                return lines.join('\n');
            }
            case 'glob': {
                // 文件发现：Go FindFiles 只列名字与大小（不读内容），跳过表与时间预算与 search_text 共用。
                const pattern = aiTextOf(input.pattern).trim();
                if (!pattern) throw new Error('pattern 不能为空（如 *.go、src/**/*.ts）');
                if (!backend.FindFiles) throw new Error('当前版本不支持文件发现（请重新构建或更新应用）');
                const start = aiTextOf(input.path).trim();
                const resolvedRoot = await resolveScanRoot(ctx, 'glob', start);
                if (!resolvedRoot.ok) return resolvedRoot.message;
                const root = resolvedRoot.path;
                const maxResults = aiClampInt(input.maxResults, 1, 1000, 300);
                const result = await backend.FindFiles(root, pattern, maxResults);
                const files = (result && result.files) || [];
                if (!files.length) {
                    return '没有匹配的文件：' + pattern + (start ? '（起点：' + start + '）' : '') +
                        '；可放宽 pattern，或确认目录存在且已获授权。';
                }
                // Go 侧返回的 path 已相对 root（斜杠分隔）；起点不是范围根时在头部说明口径，避免误当工作区相对路径
                const head = '匹配 ' + files.length + ' 个文件（pattern: ' + pattern +
                    (start ? '，起点：' + start : '') + '）' +
                    (start ? '；以下路径相对该起点' : '；以下路径相对工作区根') + '：';
                const lines = files.map((file) => file.path + (file.size ? '  ' + humanSizeBytes(file.size) : ''));
                if (result && result.truncated) lines.push('…（结果已截断：缩小 pattern 或用 path 限定目录）');
                return head + '\n' + lines.join('\n');
            }
            case 'web_search': {
                const query = aiTextOf(input.query).trim();
                if (!query) throw new Error('搜索词为空');
                const mode = externalModeOf('search');
                if (mode === 'off') throw new Error('网页搜索已被用户关闭（设置 → AI → 外部工具）');
                const maxResults = webToolLimit(input.maxResults, 1, 10, defaultSearchCount(externalToolsConfig));
                if (mode === 'mcp') {
                    const routed = await invokeExternalMcp('search', {query, count: maxResults}, ctx);
                    if (!routed.ok) return routed.message;
                    return formatMcpSourceLine(externalToolsConfig.mcpBindings.search) + '\n\n' + routed.text;
                }
                let fallbackNote = '';
                if (mode === 'provider') {
                    try {
                        if (!backend.ExternalSearch) throw new Error('外部搜索通道不可用（请重新构建或更新应用）');
                        const result = await backend.ExternalSearch(query, maxResults);
                        return formatWebSearchOutput(query, result);
                    } catch (e) {
                        fallbackNote = '外部搜索失败（' + ((e && e.message) || e) + '），已回退内置 Bing';
                    }
                }
                if (!backend.WebSearch) throw new Error('联网搜索通道不可用（请重新构建或更新应用）');
                const result = await backend.WebSearch(query, maxResults);
                const output = formatWebSearchOutput(query, result);
                return fallbackNote ? output + '\n（' + fallbackNote + '）' : output;
            }
            case 'web_fetch': {
                const target = aiTextOf(input.url).trim();
                if (!/^https?:\/\//i.test(target)) throw new Error('URL 无效（需以 http:// 或 https:// 开头）');
                // 目标域名规则对所有来源都生效（项目规则 deny 仍应拦住）；返回非空即本次不抓
                const blocked = await gateWebTarget(target, ctx, 'web_fetch');
                if (blocked) return blocked;
                const mode = externalModeOf('fetch');
                const maxChars = webToolLimit(input.maxChars, 1000, 60000, 12000);
                if (mode === 'mcp') {
                    try {
                        const routed = await invokeExternalMcp('fetch', {url: target}, ctx);
                        if (!routed.ok) return routed.message;
                        return formatMcpSourceLine(externalToolsConfig.mcpBindings.fetch) + '\n\n' + routed.text;
                    } catch (e) {
                        // 本地 MCP 抓取失败：回退内置并注明
                        if (!backend.WebFetch) throw new Error('本地 MCP 抓取失败（' + ((e && e.message) || e) + '），且内置通道不可用');
                        const result = await backend.WebFetch(target, maxChars);
                        return formatWebFetchOutput(result) + '\n（本地 MCP 抓取失败：' + ((e && e.message) || e) + '；已回退内置抓取）';
                    }
                }
                let fallbackNote = '';
                if (mode === 'provider') {
                    try {
                        if (!backend.ExternalFetch) throw new Error('外部抓取通道不可用（请重新构建或更新应用）');
                        const result = await backend.ExternalFetch(target, maxChars);
                        return formatWebFetchOutput(result);
                    } catch (e) {
                        fallbackNote = '外部抓取失败（' + ((e && e.message) || e) + '），已回退内置抓取';
                    }
                }
                if (!backend.WebFetch) throw new Error('网页抓取通道不可用（请重新构建或更新应用）');
                const result = await backend.WebFetch(target, maxChars);
                const output = formatWebFetchOutput(result);
                return fallbackNote ? output + '\n（' + fallbackNote + '）' : output;
            }
            case 'ocr': {
                const resolved = await resolveReadPathWithApproval(ctx, 'ocr', input.path);
                if (!resolved.ok) return resolved.message;
                const path = resolved.path;
                const mode = externalModeOf('ocr');
                if (mode === 'off') throw new Error('OCR 未启用（设置 → AI → 外部工具）');
                const purpose = input.purpose === 'rich_layout_recognition' ? 'rich_layout_recognition' : 'text_recognition';
                if (mode === 'mcp') {
                    const routed = await invokeExternalMcp('ocr', {path, purpose}, ctx);
                    if (!routed.ok) return routed.message;
                    return formatMcpSourceLine(externalToolsConfig.mcpBindings.ocr) + '\n\n' + routed.text;
                }
                const denied = await approveExternalProviderUpload('ocr', ctx,
                    'ocr · ' + fileNameOf(path) + ' → ' + externalProviderHost() + '（按页计费）');
                if (denied) return denied;
                if (!backend.ExternalOCR) throw new Error('外部 OCR 通道不可用（请重新构建或更新应用）');
                const result = await backend.ExternalOCR(path, purpose);
                return formatOcrOutput(result);
            }
            case 'text_to_speech': {
                const text = aiTextOf(input.text).trim();
                if (!text) throw new Error('朗读文本为空');
                if ([...text].length > 5000) throw new Error('文本超过 5000 字符，请分段后再试');
                const mode = externalModeOf('tts');
                if (mode === 'off') throw new Error('语音合成未启用（设置 → AI → 外部工具）');
                const voice = input.voice === 'tide' ? 'tide' : 'stella';
                if (mode === 'mcp') {
                    const routed = await invokeExternalMcp('tts', {text, voice}, ctx);
                    if (!routed.ok) return routed.message;
                    return formatMcpSourceLine(externalToolsConfig.mcpBindings.tts) + '\n\n' + routed.text;
                }
                const denied = await approveExternalWrite('text_to_speech', ctx,
                    'text_to_speech · voice=' + voice + '：' + text.slice(0, 80) + (text.length > 80 ? '…' : ''));
                if (denied) return denied;
                const workspace = getScopeRoot();
                if (!workspace) throw new Error('当前没有工作区，无法保存语音产物');
                if (!backend.ExternalTTS) throw new Error('外部语音合成通道不可用（请重新构建或更新应用）');
                const result = await backend.ExternalTTS(workspace, text, voice);
                if (ctx && ctx.toolMessage && result && result.path) ctx.toolMessage.targetPath = result.path;
                return formatTtsOutput(result);
            }
            case 'transcribe_audio': {
                const resolved = await resolveReadPathWithApproval(ctx, 'transcribe_audio', input.path);
                if (!resolved.ok) return resolved.message;
                const path = resolved.path;
                const mode = externalModeOf('asr');
                if (mode === 'off') throw new Error('语音识别未启用（设置 → AI → 外部工具）');
                const name = fileNameOf(path);
                if (mode === 'mcp') {
                    const routed = await invokeExternalMcp('asr', {path}, ctx);
                    if (!routed.ok) return routed.message;
                    return formatMcpSourceLine(externalToolsConfig.mcpBindings.asr) + '\n\n' + routed.text;
                }
                const denied = await approveExternalProviderUpload('transcribe_audio', ctx,
                    'transcribe_audio · ' + name + ' → ' + externalProviderHost() + '（按音频时长计费）');
                if (denied) return denied;
                if (!backend.ExternalASR) throw new Error('外部语音识别通道不可用（请重新构建或更新应用）');
                let wavBase64 = '';
                if (!isDirectAsrPath(path)) {
                    if (!backend.ReadAudioDataURL) throw new Error('当前版本不支持音频转码（请重新构建或更新应用）');
                    const dataURL = await backend.ReadAudioDataURL(path);
                    const wav = await transcodeAudioToWav16k(dataURL);
                    wavBase64 = arrayBufferToBase64(wav);
                }
                const result = await backend.ExternalASR(name, path, wavBase64);
                return formatAsrOutput(result);
            }
            case 'generate_image': {
                return await runGenerateTool('image', input, ctx);
            }
            case 'generate_video': {
                return await runGenerateTool('video', input, ctx);
            }
            case 'check_gen': {
                const hit = genJobsMod.checkJob(aiTextOf(input.jobId));
                if (!hit) {
                    return '未找到任务：' + aiTextOf(input.jobId) + '（应用重启后任务不保留；请核对 id 或直接告知用户无法追踪）。';
                }
                const s = hit.snapshot;
                const statusText = {running: '进行中', done: '已完成', failed: '已失败', stopped: '已停止'}[s.status] || s.status;
                let text = '任务 ' + s.jobId + '（' + s.entryName + ' · ' + genKindLabel(s.kind) + '）：' + statusText;
                if (s.status === 'running') text += '\n进度：' + (s.progressText || '—');
                if (s.error) text += '\n失败原因：' + s.error;
                if (s.files && s.files.length) {
                    text += '\n产物：\n' + s.files.map((file) => '- ' + file.path + '（' + file.mime + '，' + file.bytes + ' 字节）').join('\n');
                }
                if (s.status === 'running') text += '\n可稍后再次 check_gen 查询；完成后会自动通知本会话。';
                return text;
            }
            case 'memory_list': {
                const mem = await resolveMemoryDir();
                if (backend.AIEnsureDir) await backend.AIEnsureDir(mem.dir);
                let listing;
                try {
                    listing = await backend.ReadDir(mem.dir, 200);
                } catch (e) {
                    return '记忆目录为空：' + mem.dir;
                }
                const files = (listing.entries || []).filter((entry) => !entry.isDir && /\.md$/i.test(entry.name));
                if (!files.length) return '记忆目录为空：' + mem.dir;
                return '记忆目录（' + mem.mode + '）：' + mem.dir + '\n' + files.map((file) => '- ' + file.name).join('\n');
            }
            case 'memory_read': {
                const name = memoryFileName(input.name);
                const mem = await resolveMemoryDir();
                const read = await readTextFile(aiJoinPath(mem.dir, name), 64 << 10);
                return '记忆文件：' + name + '\n\n' + read.text;
            }
            case 'memory_write': {
                const name = memoryFileName(input.name);
                let content = aiTextOf(input.content);
                if (!content.trim()) throw new Error('记忆内容为空');
                if (content.length > 60 << 10) {
                    content = content.slice(0, 60 << 10) + '\n…（内容过长，已截断到 60KB）';
                }
                const mem = await resolveMemoryDir();
                if (backend.AIEnsureDir) await backend.AIEnsureDir(mem.dir);
                await backend.SaveFile(aiJoinPath(mem.dir, name), content, 'lf', false, 'utf-8');
                return '已写入记忆 ' + name + '（' + content.length + ' 字符，' + mem.mode + '）';
            }
            case 'write_worklog': {
                // AI 工作日志：只写标题 + 一句话摘要，正文与敏感信息一律不落盘（Go 侧再做一次清洗）。
                if (config.worklogEnabled === false) {
                    throw new Error('工作日志已被用户关闭（设置 → AI → 权限 → AI 工具权限）');
                }
                if (!backend.AIWorklogAppend) throw new Error('当前版本不支持工作日志');
                const worklogRoot = aiProjectRoot() || getScopeRoot();
                if (!worklogRoot) throw new Error('当前没有工作区，无法写工作日志');
                const worklogTitle = aiTextOf(input.title).trim();
                if (!worklogTitle) throw new Error('日志标题为空');
                const worklogDay = await backend.AIWorklogAppend(worklogRoot, worklogTitle, aiTextOf(input.summary).trim());
                return '已记录工作日志：' + worklogDay + '（索引见 .cadt/logs/INDEX.md）';
            }
            // ---------- 任务提醒（reminder_*）：只改会话自身状态，不碰工作区文件 ----------
            case 'notify_send': {
                const title = aiTextOf(input.title).trim().slice(0, 80);
                if (!title) throw new Error('消息标题为空');
                const body = aiTextOf(input.body).trim().slice(0, 500);
                const toast = input.toast === true;
                if (typeof opts.addMessage !== 'function') throw new Error('当前版本不支持消息中心');
                opts.addMessage({kind: 'ai', title, body, sessionId: ctx.session ? ctx.session.id : ''}, {toast});
                return toast
                    ? '消息已弹出并送入状态栏【消息】中心：' + title
                    : '消息已送入状态栏【消息】中心：' + title;
            }
            case 'reminder_add': {
                if (!ctx || !ctx.session) throw new Error('缺少会话上下文');
                const title = aiTextOf(input.title).trim().slice(0, AI_REMINDER_TITLE_MAX);
                if (!title) throw new Error('提醒标题为空');
                const blocked = reminderAddBlocked(ctx.session.reminders);
                if (blocked) throw new Error(blocked);
                if (!Array.isArray(ctx.session.reminders)) ctx.session.reminders = [];
                ctx.session.reminders = normalizeReminders(ctx.session.reminders.concat([{
                    id: aiNowId('rem-'),
                    title,
                    detail: aiTextOf(input.detail).trim().slice(0, AI_REMINDER_DETAIL_MAX),
                    status: 'open',
                    createdAt: Date.now(),
                }]));
                persistSessions();
                syncRemindersUI(ctx.session);
                return '已添加任务提醒 [' + ctx.session.reminders[ctx.session.reminders.length - 1].id + ']：' + title +
                    '（清单 ' + ctx.session.reminders.length + '/' + AI_REMINDER_LIMIT + '，每轮对话开始会注入给你）';
            }
            case 'reminder_list': {
                if (!ctx || !ctx.session) throw new Error('缺少会话上下文');
                const list = Array.isArray(ctx.session.reminders) ? ctx.session.reminders : [];
                if (!list.length) return '任务提醒清单为空（可用 reminder_add 添加，上限 ' + AI_REMINDER_LIMIT + ' 条）。';
                return '任务提醒（' + list.length + '/' + AI_REMINDER_LIMIT + '）：\n' + list.map((item) =>
                    '- [' + item.id + '] ' + (item.status === 'done' ? '（已完成）' : '') + item.title +
                    (item.detail ? ' — ' + item.detail : '')
                ).join('\n');
            }
            case 'reminder_update': {
                if (!ctx || !ctx.session) throw new Error('缺少会话上下文');
                const id = aiTextOf(input.id).trim();
                const list = Array.isArray(ctx.session.reminders) ? ctx.session.reminders : [];
                const item = list.find((entry) => entry && entry.id === id);
                if (!item) throw new Error('提醒不存在：' + id + '（先用 reminder_list 查看 id）');
                if (input.status !== undefined) {
                    if (input.status !== 'open' && input.status !== 'done') throw new Error('status 只能是 open 或 done');
                    item.status = input.status;
                }
                if (input.title !== undefined) {
                    const nextTitle = aiTextOf(input.title).trim();
                    if (!nextTitle) throw new Error('提醒标题不能为空');
                    item.title = nextTitle.slice(0, AI_REMINDER_TITLE_MAX);
                }
                if (input.detail !== undefined) item.detail = aiTextOf(input.detail).trim().slice(0, AI_REMINDER_DETAIL_MAX);
                ctx.session.reminders = normalizeReminders(list);
                persistSessions();
                syncRemindersUI(ctx.session);
                return '已更新任务提醒 [' + item.id + ']：' + item.title + (item.status === 'done' ? '（已完成）' : '（进行中）');
            }
            case 'reminder_remove': {
                if (!ctx || !ctx.session) throw new Error('缺少会话上下文');
                const id = aiTextOf(input.id).trim();
                const list = Array.isArray(ctx.session.reminders) ? ctx.session.reminders : [];
                const index = list.findIndex((entry) => entry && entry.id === id);
                if (index < 0) throw new Error('提醒不存在：' + id + '（先用 reminder_list 查看 id）');
                const removed = list.splice(index, 1)[0];
                ctx.session.reminders = normalizeReminders(list);
                persistSessions();
                syncRemindersUI(ctx.session);
                return '已删除任务提醒 [' + removed.id + ']：' + removed.title;
            }
            // ---------- 计时器（timer_list / start_timer / stop_timer）：Go 侧计时，到点系统消息唤醒 ----------
            // timer_list：主代理与子/孙代理共享的只读时钟（按会话树过滤，只有读权）
            case 'timer_list': {
                const s = ctx && ctx.session ? ctx.session : null;
                const sessionIds = s ? [s.id, s.parentSessionId, s.rootSessionId, s.originSessionId].filter(Boolean) : [];
                const list = timerMod.snapshot(sessionIds);
                if (!list.length) return '本会话树没有运行中的计时器（计时器不跨应用重启，重启后全部消失）。';
                const clock = (ms) => {
                    const total = Math.max(0, Math.round(Number(ms) / 1000));
                    const m = Math.floor(total / 60);
                    return m ? m + ' 分 ' + (total % 60) + ' 秒' : total + ' 秒';
                };
                const lines = ['运行中的计时器（只读快照 · ' + new Date().toLocaleTimeString() + '）：'];
                for (const t of list) {
                    const read = t.mode === 'countup'
                        ? '已计 ' + clock(t.elapsedMs) + (t.autoStopMs ? '，' + new Date(t.autoStopMs).toLocaleTimeString() + ' 自动停止' : '')
                        : '剩余 ' + clock(t.remainingMs);
                    lines.push('- [' + t.id + '] ' + (t.mode === 'countup' ? '正计时' : '倒计时') + '「' + t.label + '」：' + read +
                        (t.marks ? '，' + t.marks + ' 条时刻标记' : ''));
                }
                lines.push('（这是调用瞬间的读数，不会阻塞等待；子代理仅可读取，启动 / 停止 / 打标记由主代理操作。）');
                return lines.join('\n');
            }
            case 'start_timer': {
                const mode = input.mode === 'countup' ? 'countup' : 'countdown';
                const seconds = Math.max(0, Math.round(Number(input.seconds) || 0));
                const label = aiTextOf(input.label).trim().slice(0, 60);
                if (!label) throw new Error('计时目的（label）不能为空');
                if (mode === 'countdown' && seconds < 1) throw new Error('倒计时必须提供大于 0 的秒数（seconds）');
                const created = await timerMod.start(mode, seconds, label);
                // 返回值必须带 id：stop_timer 在多计时器并存时按 id 停止（功能验证报告 §2.3.2）
                if (mode === 'countdown') {
                    const total = Math.round((created.endMs - created.startMs) / 1000);
                    const desc = total >= 60 && total % 60 === 0 ? (total / 60) + ' 分钟' : total + ' 秒';
                    return '已启动倒计时「' + created.label + '」（' + desc + '）。到点会自动以系统消息唤醒你继续本会话，期间无需轮询等待，可以先做其他事或结束本轮。[id: ' + created.id + ']';
                }
                return '已启动正计时「' + created.label + '」' + (created.autoStopMs ? '（' + new Date(created.autoStopMs).toLocaleTimeString() + ' 自动停止）' : '') + '。需要结果时用 stop_timer 停止并读取已计时长与标记时间线；用户手动停止或到点自动停止时会以系统消息告知，无需轮询等待。[id: ' + created.id + ']';
            }
            case 'stop_timer': {
                const stopId = aiTextOf(input.id).trim();
                // 抑制广播回来的重复投递：工具结果已带时长文本（事件晚于 await 到达，成功才留在集合里由事件消费）
                suppressCountupStopIds.add(stopId);
                let stopped;
                try {
                    stopped = await timerMod.stop(stopId);
                } catch (e) {
                    suppressCountupStopIds.delete(stopId); // 没停成：事件不会来，回收抑制标记
                    throw e;
                }
                if (stopped.mode === 'countup') {
                    const elapsed = Math.max(0, Math.round((Date.now() - stopped.startMs) / 1000));
                    const marksText = timerMarksText(stopped);
                    return '已停止正计时「' + stopped.label + '」，已计时长 ' + Math.floor(elapsed / 60) + ' 分 ' + (elapsed % 60) + ' 秒。' +
                        (marksText ? '\n期间标记时间线：' + marksText + '。' : '');
                }
                const firedMarks = timerMarksText(stopped);
                return '已停止倒计时「' + stopped.label + '」。' + (firedMarks ? '\n期间标记时间线：' + firedMarks + '。' : '');
            }
            case 'preference_list': {
                const prefs = config.preferences || [];
                if (!prefs.length) return '用户偏好为空（可用 preference_write 新增）。';
                return '用户偏好（共 ' + prefs.length + ' 条）：\n' + prefs.map((pref) =>
                    '- [' + pref.id + '] ' + pref.text + (pref.source === 'ai' ? '（AI 记录）' : '')
                ).join('\n');
            }
            case 'preference_write': {
                const text = aiTextOf(input.text).trim().slice(0, AI_PREF_TEXT_LIMIT);
                if (!text) throw new Error('偏好内容为空');
                const id = aiTextOf(input.id).trim();
                let entry = id ? config.preferences.find((pref) => pref.id === id) : null;
                if (id && !entry) throw new Error('偏好不存在：' + id + '（先用 preference_list 查看 id）');
                const updating = !!entry;
                if (!entry) {
                    const dup = config.preferences.find((pref) => pref.text === text);
                    if (dup) return '已存在相同偏好 [' + dup.id + ']，无需重复添加。';
                    if (config.preferences.length >= AI_PREF_LIMIT) {
                        throw new Error('偏好数量已达上限（' + AI_PREF_LIMIT + ' 条），请先删除不用的条目');
                    }
                    entry = {id: aiNowId('pref-'), text, source: 'ai', createdAt: Date.now(), updatedAt: Date.now()};
                    config.preferences.push(entry);
                } else {
                    entry.text = text;
                    entry.source = 'ai';
                    entry.updatedAt = Date.now();
                }
                saveAIConfig();
                renderPreferenceSettings();
                return (updating ? '已更新用户偏好 [' : '已记录用户偏好 [') + entry.id + ']：' + entry.text;
            }
            case 'preference_remove': {
                const id = aiTextOf(input.id).trim();
                const text = aiTextOf(input.text).trim();
                if (!id && !text) throw new Error('请提供偏好 id 或 text');
                const index = id
                    ? config.preferences.findIndex((pref) => pref.id === id)
                    : config.preferences.findIndex((pref) => pref.text === text);
                if (index < 0) throw new Error('偏好不存在（先用 preference_list 查看）');
                const removed = config.preferences.splice(index, 1)[0];
                saveAIConfig();
                renderPreferenceSettings();
                return '已删除用户偏好：' + removed.text;
            }
            case 'skill_use': {
                const name = aiTextOf(input.name).trim();
                if (!name) throw new Error('技能名称为空');
                const skills = await listSkills(true);
                const skill = skills.find((item) => item.name.toLowerCase() === name.toLowerCase());
                if (!skill) throw new Error('技能不存在：' + name);
                const baseDir = skill.path ? aiPathDir(skill.path) : '';
                return '技能：' + skill.name + '（' + skillSourceLabel(skill.source) + '）' +
                    (baseDir ? '\n技能目录：' + baseDir : '') +
                    '\n\n' + skill.content + '\n\n请遵循该技能指令。';
            }
            case 'session_history': {
                if (!ctx || !ctx.session) throw new Error('缺少会话上下文');
                return await runSessionHistoryQuery(ctx.session, input);
            }
            case 'session_search': {
                // 跨会话检索：Go 侧 AISessionSearchScoped 只搜未归档会话，硬预算 100 条 / 3 秒。
                // 结果可能来自别的工作区，渲染时由 formatSessionSearchResult 统一标注。
                const query = aiTextOf(input.query).trim();
                if (!query) throw new Error('搜索内容为空');
                if (!backend.AISessionSearchScoped) throw new Error('当前版本不支持会话检索（请重新构建或更新应用）');
                const limit = aiClampInt(input.limit, 1, 100, 20);
                const brief = input.full !== true;
                const result = await backend.AISessionSearchScoped(query, limit, brief);
                return formatSessionSearchResult(query, result);
            }
            case 'session_read': {
                const id = aiTextOf(input.id).trim();
                if (!id) throw new Error('id 不能为空（先用 session_search 或 session_list 取会话 id）');
                if (!backend.AISessionRead) throw new Error('当前版本不支持读取会话日志（请重新构建或更新应用）');
                const raw = await backend.AISessionRead(id);
                if (!raw) {
                    return '会话没有可读的日志：' + id + '（可能已被删除，或还没落盘）。先用 session_search 重新找 id。';
                }
                return sessionLogDigest(raw, {
                    limit: aiClampInt(input.limit, 1, 50, 20),
                    query: aiTextOf(input.query).trim(),
                    workspace: getScopeRoot(),
                    id,
                });
            }
            case 'ask_user': {
                // 子代理提问（原语 6）：子代理没有用户 UI，问题转交父代理作答。
                // 判据：子会话不进 sessions 表且带 agentDepth——不能用「有 parentSessionId」，
                // 支线会话也是普通持久化会话（F 阶段）。
                if (ctx && ctx.agentDepth > 0 && ctx.session && !sessionById(ctx.session.id)) {
                    return await subagentsMod.runSubAskQuestion(input, ctx);
                }
                return await runAskQuestion(input, ctx);
            }
            case 'plan_mode': {
                if (!ctx || !ctx.session) throw new Error('缺少会话上下文');
                const enabled = input.enabled === true;
                if (ctx.session.planMode === enabled) {
                    return enabled ? '当前已处于计划模式。' : '当前不在计划模式。';
                }
                const ok = setPlanMode(enabled, false, true);
                if (!ok) throw new Error('切换失败（会话不存在或正在生成）');
                return enabled
                    ? '已进入计划模式：下一轮起只保留只读探索与规划类工具；请输出完整计划并等待用户批准。'
                    : '已退出计划模式：下一轮起恢复当前权限档的完整工具集；写操作仍按权限档审批。';
            }
            case 'app_control': {
                if (!appControlOn()) throw new Error('应用操作已被禁用（设置 → AI → 权限 → AI 工具权限）');
                if (typeof runHostAppAction !== 'function') throw new Error('当前宿主不支持应用操作桥');
                const action = aiTextOf(input.action).trim();
                if (!action) throw new Error('action 为空；先用 skill_use 加载 cadt-ui 获取动作表');
                const params = (input.params && typeof input.params === 'object' && !Array.isArray(input.params)) ? input.params : {};
                // open_browser_tab 的 file:// 与 browser_navigate 同一条读权限链：这条 UI 动作
                // 不能成为绕过工作区外读取审批的旁路（用户手动在地址栏打开不受影响）
                if (action === 'open_browser_tab') {
                    const rawUrl = aiTextOf(params.url).trim();
                    if (/^file:/i.test(rawUrl)) {
                        const local = normalizeFileUrlTarget(rawUrl);
                        if (!local.ok) throw new Error(local.reason);
                        const resolved = await resolveReadPathWithApproval(ctx, 'open_browser_tab', local.path);
                        if (!resolved.ok) throw new Error(resolved.message);
                        params.url = local.url;
                    }
                }
                let result;
                try {
                    result = MCP_CONFIG_ACTIONS.includes(action)
                        ? await runMcpConfigAction(action, params, ctx)
                        : await runHostAppAction(action, params, currentScopeOf(ctx && ctx.session));
                } catch (e) {
                    const known = typeof hostAppActions === 'function' ? hostAppActions() : null;
                    const hint = Array.isArray(known) && known.length ? '可用动作：' + known.join(', ') : '可用动作见 cadt-ui 技能';
                    throw new Error(((e && e.message) || String(e)) + '（' + hint + '）');
                }
                // 视觉动作（screenshot）：宿主回传 base64 PNG，转成图片消息附加给模型
                if (result && typeof result === 'object' && result.image) {
                    if (!ctx || !ctx.session) throw new Error('缺少会话上下文');
                    const normalized = aiNormalizeImage({
                        mime: result.mime || 'image/png',
                        data: result.image,
                        name: result.name || '应用截图',
                    });
                    if (!normalized) throw new Error('截图数据无法解析（可能超过图片大小上限）');
                    ctx.session.messages.push({
                        role: 'user',
                        content: '[应用窗口截图（app_control · screenshot 自动附加）]',
                        images: [normalized],
                        app: normalizeAppMessage({kind: 'app', label: '应用截图', icon: 'camera'}),
                        ts: Date.now(),
                    });
                    persistSessions();
                    return '截图已捕获并作为图片附加到对话（下一轮请求模型可见）。';
                }
                return result === undefined ? 'OK' : (typeof result === 'string' ? result : JSON.stringify(result));
            }
            case 'env_list': {
                const vars = await listEnvVarsForAI();
                if (!vars.length) {
                    return '尚未配置任何环境变量。可以让用户在 设置 → 环境变量 中添加，或用 env_create（你提供名称与描述，值由用户填写）。';
                }
                return '已配置的环境变量（值不可见）：\n' + vars.map((v) =>
                    '- ' + v.name + (v.description ? ' — ' + v.description : '') + (v.enabled ? '' : '（未启用，不注入）')
                ).join('\n');
            }
            case 'env_create': {
                if (!ctx || !ctx.session || !ctx.toolMessage) throw new Error('缺少会话上下文');
                const name = aiTextOf(input.name).trim();
                if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
                    throw new Error('变量名无效（字母/数字/下划线，字母或下划线开头，最长 128）');
                }
                const description = aiTextOf(input.description).trim().slice(0, 500);
                const existing = await listEnvVarsForAI();
                const found = existing.find((v) => v.name.toLowerCase() === name.toLowerCase());
                if (found) {
                    return '环境变量 ' + found.name + ' 已存在' + (found.enabled ? '' : '（当前未启用）') +
                        '；如需修改值或描述，请让用户在 设置 → 环境变量 中编辑。';
                }
                const decision = await requestEnvCreation(ctx.session, ctx.toolMessage, {name, description});
                if (!decision.approved) {
                    return decision.cancelled ? '用户已停止生成，变量创建已取消。' : '用户放弃了变量创建，未做修改。';
                }
                const value = decision.value;
                if (!value) {
                    return '用户没有填写变量值，未创建。';
                }
                // 值只在这里使用一次，不写入 toolMessage / 会话
                const snap = backend.GetEnvVars ? await backend.GetEnvVars() : null;
                const current = (snap && Array.isArray(snap.vars)) ? snap.vars.filter((v) => v && v.name) : [];
                try {
                    await backend.SetEnvVars(current
                        .map((v) => ({name: v.name, value: v.value, description: v.description || '', enabled: v.enabled !== false}))
                        .concat([{name, value, description, enabled: true}]));
                } catch (e) {
                    if (ctx.toolMessage.envAsk) ctx.toolMessage.envAsk.state = 'failed';
                    throw new Error('保存环境变量失败：' + ((e && e.message) || e));
                }
                return '已创建环境变量 ' + name + (description ? '（' + description + '）' : '') +
                    '；值由用户填写，未包含在对话中。变量已注入终端与命令桥，命令里可直接引用。';
            }
            case 'browser_navigate': {
                let url = aiTextOf(input.url).trim();
                if (/^file:/i.test(url)) {
                    // 本地文件走读权限链（与 read_file 同口径）：工作区内直开；工作区外
                    // 点名/已批准读根/auto·full 直开，read/edit 弹审批，应用数据目录硬拒。
                    // 否则 browser_snapshot/evaluate 能读页面内容，等于绕开工作区外读取审批。
                    const local = normalizeFileUrlTarget(url);
                    if (!local.ok) throw new Error(local.reason);
                    const resolved = await resolveReadPathWithApproval(ctx, 'browser_navigate', local.path);
                    if (!resolved.ok) throw new Error(resolved.message);
                    url = local.url;
                } else if (!/^(https?|about|data):/i.test(url)) {
                    throw new Error('URL 无效（需以 http/https/about/data 开头；本地文件用 file://）');
                }
                const tab = await ensureBrowserTab(ctx.session);
                await backend.BrowserNavigate(tab.id, url);
                await new Promise((resolve) => setTimeout(resolve, 400));
                let st = null;
                try { st = await backend.BrowserState(tab.id); } catch (e) {}
                return '已导航：' + url + (st ? (String.fromCharCode(10) + '当前页面：' + (st.title || '（加载中）') + ' — ' + (st.url || url)) : '');
            }
            case 'browser_back': {
                const tab = await ensureBrowserTab(ctx.session);
                await backend.BrowserGoBack(tab.id);
                return '已后退一页。';
            }
            case 'browser_forward': {
                const tab = await ensureBrowserTab(ctx.session);
                await backend.BrowserGoForward(tab.id);
                return '已前进一页。';
            }
            case 'browser_reload': {
                const tab = await ensureBrowserTab(ctx.session);
                await backend.BrowserReload(tab.id);
                return '已重新加载页面。';
            }
            case 'browser_snapshot': {
                const tab = await ensureBrowserTab(ctx.session);
                const script = [
                    'JSON.stringify({',
                    'title: document.title,',
                    'url: location.href,',
                    'text: document.body ? document.body.innerText.slice(0, 4000) : "",',
                    'inputs: [...document.querySelectorAll("input,textarea,select,button,[role=button]")].slice(0, 30).map((el, i) => ({',
                    'tag: el.tagName,',
                    'type: el.type || "",',
                    'name: el.name || "",',
                    'id: el.id || "",',
                    'value: el.tagName === "INPUT" && el.type === "password" ? "(password)" : String(el.value || "").slice(0, 40),',
                    'selector: el.id ? ("#" + el.id) : (el.name ? ("[name=" + el.name + "]") : (el.tagName.toLowerCase() + ":nth-of-type(" + (i + 1) + ")"))',
                    '})),',
                    'links: [...document.querySelectorAll("a")].slice(0, 30).map((a) => ({text: a.innerText.trim().slice(0, 60), href: a.href}))',
                    '})',
                ].join(' ');
                const raw = await backend.BrowserEval(tab.id, script);
                return browserSnapshotText(browserEvalObject(raw));
            }
            case 'browser_screenshot': {
                const tab = await ensureBrowserTab(ctx.session);
                if (!backend.BrowserCaptureScreenshot) throw new Error('截图通道不可用');
                const base64 = await backend.BrowserCaptureScreenshot(tab.id);
                if (!base64 || base64.length < 50) throw new Error('截图数据为空');
                const normalized = aiNormalizeImage({mime: 'image/png', data: base64, name: '浏览器截图'});
                if (!normalized) throw new Error('截图数据无法解析');
                const imageMessage = {
                    role: 'user',
                    content: '[浏览器截图（browser_screenshot 工具自动附加）]',
                    images: [normalized],
                    app: normalizeAppMessage({kind: 'browser', label: '浏览器截图', icon: 'camera'}),
                    ts: Date.now(),
                };
                ctx.session.messages.push(imageMessage);
                persistSessions();
                return '截图已捕获并作为图片附加到对话（下一轮请求模型可见）。';
            }
            case 'browser_click': {
                const selector = aiTextOf(input.selector).trim();
                if (!selector) throw new Error('selector 为空');
                const tab = await ensureBrowserTab(ctx.session);
                const script = '(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return JSON.stringify({ok: false, message: "未找到元素"}); el.scrollIntoView({block: "center"}); el.click(); return JSON.stringify({ok: true, tag: el.tagName, text: String(el.innerText || "").slice(0, 60)}); })()';
                const raw = await backend.BrowserEval(tab.id, script);
                const result = browserEvalObject(raw);
                if (!result || result.ok === false) throw new Error(result && result.message ? result.message : '点击失败');
                return '已点击：' + (result.tag || '元素') + (result.text ? '（' + result.text + '）' : '');
            }
            case 'browser_type': {
                const selector = aiTextOf(input.selector).trim();
                const text = aiTextOf(input.text);
                if (!selector) throw new Error('selector 为空');
                const tab = await ensureBrowserTab(ctx.session);
                const script = '(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return JSON.stringify({ok: false, message: "未找到元素"}); el.focus(); el.value = ' + JSON.stringify(text) + '; el.dispatchEvent(new Event("input", {bubbles: true})); el.dispatchEvent(new Event("change", {bubbles: true})); return JSON.stringify({ok: true, tag: el.tagName}); })()';
                const raw = await backend.BrowserEval(tab.id, script);
                const result = browserEvalObject(raw);
                if (!result || result.ok === false) throw new Error(result && result.message ? result.message : '填入失败');
                return '已填入：' + (result.tag || '输入框');
            }
            case 'browser_press_key': {
                const key = aiTextOf(input.key).trim() || 'Enter';
                const tab = await ensureBrowserTab(ctx.session);
                const script = '(() => { const el = document.activeElement || document.body; el.dispatchEvent(new KeyboardEvent("keydown", {key: ' + JSON.stringify(key) + ', bubbles: true})); el.dispatchEvent(new KeyboardEvent("keyup", {key: ' + JSON.stringify(key) + ', bubbles: true})); return JSON.stringify({ok: true}); })()';
                const raw = await backend.BrowserEval(tab.id, script);
                browserEvalObject(raw);
                return '已派发按键：' + key;
            }
            case 'browser_evaluate': {
                const script = aiTextOf(input.script);
                if (!script.trim()) throw new Error('script 为空');
                const tab = await ensureBrowserTab(ctx.session);
                const raw = await backend.BrowserEval(tab.id, script);
                const result = browserEvalObject(raw);
                return '脚本结果：' + (typeof result === 'string' ? result : JSON.stringify(result)).slice(0, 4000);
            }
            case 'browser_resize': {
                const width = Math.round(Number(input.width));
                const height = Math.round(Number(input.height));
                if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error('width / height 必须是数字');
                if (width < 200 || width > 8000 || height < 200 || height > 8000) {
                    throw new Error('宽高需在 200–8000 像素之间');
                }
                const tab = await ensureBrowserTab(ctx.session);
                const applied = browserHost && typeof browserHost.applyViewport === 'function'
                    ? await browserHost.applyViewport(tab.id, {mode: 'fixed', width, height})
                    : null;
                if (!applied || !applied.applied) throw new Error('浏览器标签页不在当前窗口，无法调整视口');
                return '浏览器视口已调整为 ' + width + '×' + height + '（固定尺寸居中显示，可通过工具条按钮恢复自适应）。';
            }
            case 'browser_close': {
                const tabId = ctx.session.browserTabId;
                if (!tabId) return '本会话没有绑定的浏览器标签页。';
                if (runHostAppAction) {
                    await runHostAppAction('close_browser_tab', {id: tabId});
                }
                ctx.session.browserTabId = '';
                persistSessions();
                return '已关闭浏览器标签页。';
            }
            case 'propose_patch': {
                if (!ctx || !ctx.session || !ctx.toolMessage) throw new Error('补丁工具缺少会话上下文');
                const patchText = aiTextOf(input.patch);
                const summary = aiTextOf(input.summary).trim() || '补丁';
                if (!patchText.trim()) {
                    return patchErrorText('PATCH_EMPTY', '补丁内容为空：至少要有一个 @@ hunk', '', false);
                }
                if (patchText.length > AI_PATCH_LIMIT) {
                    return patchErrorText('PATCH_LIMIT', '补丁超过 256 KB：请拆成 2–3 个补丁分批提交', '当前 ' + Math.round(patchText.length / 1024) + ' KB', false);
                }
                const root = getScopeRoot();
                if (!root) {
                    return patchErrorText('PATCH_PATH_DENIED', '当前没有工作区范围：请先打开文件夹再生成补丁', '', false);
                }
                // 计划模式（或显式 dry_run）：只预检不落地——不生成 .patch、不写索引、不弹审批卡。
                // 计划模式的契约是「零副作用」，而 PatchSave 会写 .cadt/patches；这里改走
                // PatchPreviewText（仅内存计划 + 预检结果），批准计划后再真正出补丁。
                const dryRun = input.dry_run === true || !!(ctx.session && ctx.session.planMode === true);
                if (dryRun) {
                    if (!backend.PatchPreviewText) {
                        return patchErrorText('PATCH_BACKEND', '当前版本不支持补丁预检，请重启应用', '', false);
                    }
                    let preview;
                    try {
                        preview = await backend.PatchPreviewText(patchText, root);
                    } catch (e) {
                        const info = patchErrorParts(String((e && e.message) || e));
                        return patchErrorText(info.code,
                            info.code === 'PATCH_PARSE' ? '补丁无法解析或路径不合法' : info.text,
                            info.code === 'PATCH_PARSE' ? String((e && e.message) || e) : '',
                            info.retryable);
                    }
                    const files = preview.files || [];
                    const okFiles = files.filter((f) => f.status === 'ok');
                    const lines = ['【patch:preview】dry_run=yes files=' + files.length + ' applicable=' + okFiles.length
                        + ' added=' + (preview.added || 0) + ' removed=' + (preview.removed || 0)];
                    for (const f of files) {
                        lines.push((f.status === 'ok' ? '可应用' : '不可应用') + '：' + (f.relPath || '(路径未知)')
                            + (f.reason ? '（' + f.reason + '）' : ''));
                    }
                    lines.push('计划模式下只做预检：没有生成 .patch、没有写 .cadt/patches、没有改动任何文件；批准计划后再出补丁。');
                    return lines.join('\n');
                }
                // 完全权限档不再拦补丁：补丁是可分享/可转交的交付物，与"直接改"并不冲突。
                // 默认仍优先 edit_file / write_file，但需要留一份可审阅、可分享的 patch 时随时可以出。
                // 熔断：同一补丁连续失败 3 次就停手
                const hash = patchHashOf(patchText);
                const attempt = patchAttempts.get(hash) || {count: 0, lastCode: ''};
                if (attempt.count >= AI_PATCH_MAX_ATTEMPTS) {
                    return patchErrorText('PATCH_GIVEUP', '同一补丁已连续失败 ' + attempt.count + ' 次（最近：' + (attempt.lastCode || '未知') + '），已停止自动重试', '请向用户说明失败原因，并改用 write_file / edit_file 逐文件修改，不要重复提交同一补丁。', false);
                }
                if (!backend.PatchSave) {
                    return patchErrorText('PATCH_BACKEND', '当前版本不支持补丁能力，请重启应用', '', false);
                }
                let preview;
                try {
                    preview = await backend.PatchSave(root, summary, patchText);
                } catch (e) {
                    const msg = String((e && e.message) || e);
                    // 还原后端错误码：确定性失败（空补丁/越界/超限）标 retryable=no，
                    // 也不计入「同一补丁连续失败」的熔断计数——否则模型会照着"可重试"白试一轮
                    const info = patchErrorParts(msg);
                    attempt.lastCode = info.code;
                    if (info.retryable) attempt.count += 1;
                    patchAttempts.set(hash, attempt);
                    return patchErrorText(
                        info.code,
                        info.code === 'PATCH_PARSE' ? '补丁无法解析或路径不合法' : info.text,
                        info.code === 'PATCH_PARSE' ? msg : '',
                        info.retryable,
                    );
                }
                const okFiles = (preview.files || []).filter((f) => f.status === 'ok');
                // 内容与库里已有补丁完全一致时后端直接复用（不新建文件）；告诉模型，
                // 免得它以为每次重试都产出了新补丁
                const reusedNote = preview.reused
                    ? '（内容与已有补丁 ' + (preview.patchId || '') + ' 完全相同，已复用该补丁，未新建文件）'
                    : '';
                if (!okFiles.length) {
                    const first = (preview.files || []).find((f) => f.reason) || {};
                    attempt.count += 1;
                    attempt.lastCode = 'PATCH_HUNK_CONFLICT';
                    patchAttempts.set(hash, attempt);
                    return patchErrorText('PATCH_HUNK_CONFLICT',
                        '补丁已保存但没有任何文件可直接应用：' + (first.relPath || '') + (first.reason ? '（' + first.reason + '）' : ''),
                        '建议重新 read_file 目标文件后重写对应 hunk；' + (preview.patchPath ? '补丁文件：' + preview.patchPath : ''),
                        true);
                }
                const allowApply = patchAllowApply(input, currentScopeOf(ctx.session), lastUserTextOf(ctx.session && ctx.session.messages));
                if (!allowApply) {
                    // 完全权限档默认走到这里：只产出可分享的 .patch，不弹审批卡打断流程
                    const fullNote = input.apply === false
                        ? ''
                        : '（完全权限档：只产出文件、未弹审批卡；要当场应用就说「应用这个补丁」，或直接打开补丁视图点应用）';
                    return '已生成补丁 ' + (preview.patchPath || '') + '（' + (preview.files || []).length + ' 文件 +' + preview.added + ' −' + preview.removed + '）' + reusedNote + fullNote + '\n'
                        + '预检：' + okFiles.length + ' 个文件可应用。用户可打开该文件在补丁视图中应用。';
                }
                const decision = await requestPatchApproval(ctx.session, ctx.toolMessage, preview, allowApply);
                if (!decision.approved) {
                    return decision.cancelled
                        ? patchErrorText('PATCH_USER_DENIED', '用户停止了生成，补丁未应用', '补丁文件已保留：' + (preview.patchPath || ''), false)
                        : patchErrorText('PATCH_USER_DENIED', '用户放弃了本次补丁，文件未修改', '补丁文件已保留：' + (preview.patchPath || ''), false);
                }
                // 停止之后不再落盘（同 run_command 的停止闸门）：审批 await 期间用户可能已按停止
                if (toolHalted(ctx.toolMessage)) {
                    return patchErrorText('PATCH_USER_DENIED', '用户停止了生成，补丁未应用', '补丁文件已保留：' + (preview.patchPath || ''), false);
                }
                const approvalRef = ctx.toolMessage.approval || {};
                const mode = approvalRef.mode === 'atomic' ? 'atomic' : 'partial';
                const selected = Array.isArray(approvalRef.selected) && approvalRef.selected.length
                    ? approvalRef.selected
                    : okFiles.map((f) => f.relPath);
                ctx.toolMessage.status = 'running';
                ctx.toolMessage.content = '正在应用补丁…';
                refreshToolWrap(ctx.session, ctx.toolMessage);
                let result;
                try {
                    result = await backend.PatchApply(approvalRef.planId, selected, null, mode);
                } catch (e) {
                    const msg = String((e && e.message) || e);
                    attempt.count += 1;
                    attempt.lastCode = 'PATCH_APPLY_IO';
                    patchAttempts.set(hash, attempt);
                    return patchErrorText('PATCH_APPLY_IO', '写入失败', msg, false);
                }
                if (ctx.toolMessage.approval) {
                    ctx.toolMessage.approval.result = result;
                    ctx.toolMessage.approval.state = 'approved';
                }
                for (const f of result.files || []) {
                    if (f.status === 'applied') {
                        recordChange(ctx.session, {path: aiJoinPath(root, f.relPath), relPath: f.relPath, tool: 'propose_patch', added: f.added || 0, removed: f.removed || 0});
                        notifyFileChanged(aiJoinPath(root, f.relPath));
                    }
                }
                if (result.code === 'PATCH_ROLLBACK_FAILED') {
                    attempt.count += 1;
                    attempt.lastCode = result.code;
                    patchAttempts.set(hash, attempt);
                } else if (result.applied > 0) {
                    patchAttempts.delete(hash);
                } else {
                    attempt.count += 1;
                    attempt.lastCode = result.code || 'PATCH_HUNK_CONFLICT';
                    patchAttempts.set(hash, attempt);
                }
                return (reusedNote ? reusedNote + '\n' : '') + patchResultText(result);
            }
            case 'worktree_manage':
                return worktreeMod.manageTool(ctx, input);
            case 'write_file': {
                if (!ctx || !ctx.session || !ctx.toolMessage) throw new Error('写操作缺少会话上下文');
                const path = aiResolveScopePath(input.path, ctx.session);
                const relPath = aiRelPath(getScopeRoot(), path);
                const content = aiTextOf(input.content);
                if (!content.trim()) throw new Error('文件内容为空');
                if (content.length > AI_WRITE_LIMIT) throw new Error('内容过长（上限 256KB）');
                const existing = await readOptionalText(path);
                const oldText = existing.exists ? existing.text : '';
                if (existing.exists && oldText === content) return '文件内容未变化：' + relPath;
                if (existing.exists) {
                    // 陈旧缓冲防护：本会话没读过、或读取后文件已被外部修改 → 拒绝整体覆盖
                    const fresh = checkWriteFresh(ctx.session, path, {
                        exists: true,
                        mtime: existing.data && existing.data.mtime,
                        size: existing.data && existing.data.size,
                    }, relPath);
                    if (!fresh.ok) throw new Error(fresh.message);
                }
                const ops = computeLineDiff(oldText, content);
                const stats = diffStats(ops);
                const preview = buildDiffPreview(ops);
                return applyWorkspaceWrite(ctx.session, ctx.toolMessage, {
                    tool: 'write_file',
                    path,
                    relPath,
                    content,
                    eol: existing.exists ? existing.data.eol : '',
                    hasBom: existing.exists ? !!existing.data.hasBom : false,
                    enc: existing.exists ? existing.data.enc : 'utf-8',
                    expectMtime: existing.exists ? (existing.data && existing.data.mtime) || '' : '',
                    newFile: !existing.exists,
                    added: stats.added,
                    removed: stats.removed,
                    truncated: preview.truncated,
                    diff: preview.lines,
                });
            }
            case 'edit_file': {
                if (!ctx || !ctx.session || !ctx.toolMessage) throw new Error('写操作缺少会话上下文');
                const path = aiResolveScopePath(input.path, ctx.session);
                const relPath = aiRelPath(getScopeRoot(), path);
                const oldString = aiTextOf(input.oldString);
                const newString = aiTextOf(input.newString);
                if (!oldString) throw new Error('oldString 不能为空');
                if (oldString === newString) throw new Error('oldString 与 newString 相同，无需修改');
                if (newString.length > AI_WRITE_LIMIT) throw new Error('newString 过长（上限 256KB）');
                const existing = await readOptionalText(path);
                if (!existing.exists) throw new Error('文件不存在：' + relPath + '（新建文件请用 write_file）');
                const text = existing.text;
                const located = locateEditTarget(text, oldString, newString, !!input.replaceAll);
                if (located.error) throw new Error(located.error);
                const next = located.next;
                if (next === text) return '文件内容未变化：' + relPath;
                const ops = computeLineDiff(text, next);
                const stats = diffStats(ops);
                const preview = buildDiffPreview(ops);
                const msg = await applyWorkspaceWrite(ctx.session, ctx.toolMessage, {
                    tool: 'edit_file',
                    path,
                    relPath,
                    content: next,
                    eol: existing.data.eol,
                    hasBom: !!existing.data.hasBom,
                    enc: existing.data.enc,
                    // 不设会话级闸门（执行时已重读盘）；expectMtime 仅做落盘竞态兜底
                    expectMtime: (existing.data && existing.data.mtime) || '',
                    newFile: false,
                    added: stats.added,
                    removed: stats.removed,
                    truncated: preview.truncated,
                    diff: preview.lines,
                });
                return located.count > 1 ? msg + '（已替换 ' + located.count + ' 处）' : msg;
            }
            case 'todo_write': {
                if (!ctx || !ctx.session) throw new Error('todo_write 缺少会话上下文');
                if (!Array.isArray(input.todos)) throw new Error('todos 必须是数组');
                if (input.todos.length > AI_TODO_LIMIT) throw new Error('任务过多（上限 ' + AI_TODO_LIMIT + ' 项）');
                const list = [];
                for (const item of input.todos) {
                    const content = aiTextOf(item && item.content).replace(/\s+/g, ' ').trim();
                    if (!content) throw new Error('任务内容不能为空');
                    const status = item && item.status;
                    if (!['pending', 'in_progress', 'completed'].includes(status)) {
                        throw new Error('任务状态无效：' + aiTextOf(status));
                    }
                    list.push({content: content.slice(0, 200), status});
                }
                const session = ctx.session;
                session.todos = list;
                const state = todoStates.get(session.id);
                if (state) {
                    // 只重置「全部完成 3 秒折叠」的计时，保留用户手动收起的 collapsed 偏好，
                    // 否则每次 todo_write 更新进度都会把面板重新展开（扰民）。
                    clearTimeout(state.timer);
                    state.timer = 0;
                    state.doneCollapsed = false;
                }
                persistSessions();
                if (isOpen() && currentSession() === session) renderTodos();
                // 写入反馈带三分计数（dsh 同款）：模型每次写完都知道清单全貌，及时纠偏；
                // 多个 in_progress 时温和提醒（并行子代理场景合法，不做硬拒）
                const doing = list.filter((todo) => todo.status === 'in_progress').length;
                // done 必须在这里算出来：8f4bbd7 引入三分计数时漏了这行，
                // 直接引用未定义的 done → 每次 todo_write 都抛 ReferenceError，
                // 表现就是模型那边「工具总是失败」，清单永远不更新。
                const done = list.filter((todo) => todo.status === 'completed').length;
                const pending = list.length - done - doing;
                let note = '任务清单已更新：' + pending + ' 项待处理、' + doing + ' 项进行中、' + done + ' 项已完成。';
                if (doing > 1) note += '注意：多个任务同时 in_progress——串行工作应只保留一个，其余先标 pending 或 completed。';
                if (done === list.length) note += '清单已全部完成。';
                return note;
            }
            case 'terminal': {
                // 内置终端（ConPTY 持久会话）：与用户看到的底部终端共用同一份 UI 状态与输出流。
                // 写操作复用命令审批链（approveCommandForRun），read / list 只读免审批。
                if (!ctx || !ctx.session || !ctx.toolMessage) throw new Error('终端操作缺少会话上下文');
                const host = terminalHostOf();
                if (!host) throw new Error('当前版本不支持终端操作（请重新构建或更新应用）');
                const action = aiTextOf(input.action).trim().toLowerCase();
                if (!action) throw new Error('action 不能为空（list / open / send / read / signal / close）');
                const approve = async (what, subject) => {
                    const decision = await approveCommandForRun(ctx.session, ctx.toolMessage, what, subject, 'terminal');
                    if (decision.approved) return null;
                    return decision.denied
                        ? '被项目权限规则禁止，未执行（规则 ' + decision.rule + '）。'
                        : (decision.cancelled ? '用户已停止生成，未执行。' : '用户取消了本次终端操作。');
                };

                if (action === 'list') {
                    const local = host.list();
                    const infos = backend.TermList ? await backend.TermList() : [];
                    return formatTerminalList(local, infos);
                }

                if (action === 'open') {
                    const shell = aiTextOf(input.shell).trim();
                    const denied = await approve('创建终端' + (shell ? '（' + shell + '）' : ''), '内置终端');
                    if (denied) return denied;
                    if (toolHalted(ctx.toolMessage)) return '用户已停止生成，终端未创建。';
                    const created = await host.open(shell);
                    return '已创建终端：' + created.id + '（' + created.shell + '），底部终端面板已打开。' +
                        '写入命令用 terminal send（文本自带 \\r 才回车），读输出用 terminal read。';
                }

                const id = aiTextOf(input.id).trim();
                if (!id) throw new Error('id 不能为空（先用 terminal list 取 id）');

                if (action === 'send') {
                    const text = aiTextOf(input.text);
                    if (!text) throw new Error('text 不能为空（需要回车请自带 \\r）');
                    const denied = await approve(terminalSendLabel(text), '终端 ' + id);
                    if (denied) return denied;
                    if (toolHalted(ctx.toolMessage)) return '用户已停止生成，未写入终端。';
                    await host.send(id, text);
                    return '已向终端 ' + id + ' 写入 ' + text.length + ' 个字符。交互式程序可能需要等一会，用 terminal read 看输出。';
                }

                if (action === 'signal') {
                    const denied = await approve('Ctrl+C（中断前台程序）', '终端 ' + id);
                    if (denied) return denied;
                    await host.send(id, '\u0003');
                    return '已向终端 ' + id + ' 发送 Ctrl+C。';
                }

                if (action === 'read') {
                    if (!backend.TermRead) throw new Error('当前版本不支持读取终端输出（请重新构建或更新应用）');
                    const maxChars = aiClampInt(input.maxChars, 200, 20000, 4000);
                    const res = await backend.TermRead(id, maxChars);
                    return formatTerminalRead(id, res, maxChars);
                }

                if (action === 'close') {
                    const denied = await approve('关闭终端 ' + id, '终端 ' + id);
                    if (denied) return denied;
                    await host.close(id);
                    return '已关闭终端 ' + id + '。';
                }
                throw new Error('未知的 action：' + action + '（可用 list / open / send / read / signal / close）');
            }
            case 'run_command': {
                if (!ctx || !ctx.session || !ctx.toolMessage) throw new Error('命令执行缺少会话上下文');
                const command = aiTextOf(input.command).trim();
                if (!command) throw new Error('命令不能为空');
                if (!backend.AIRunShellCommand) throw new Error('当前版本不支持执行命令');
                const cwd = aiResolveScopePath(aiTextOf(input.cwd).trim() || '.', ctx.session);
                const timeoutMs = aiClampInt(input.timeoutMs, 1000, 600000, 60000);
                const decision = await approveCommandForRun(ctx.session, ctx.toolMessage, command, cwd, 'run_command');
                if (!decision.approved) {
                    return decision.denied
                        ? '命令被项目权限规则禁止，未执行（规则 ' + decision.rule + '）。'
                        : (decision.cancelled
                            ? '用户已停止生成，命令未执行。'
                            : '用户取消了本次命令，未执行。');
                }
                // 审批 / 分类器 await 期间用户可能已按停止：命令绝不能在停止之后才拉起进程。
                // 旧实现漏了这道闸，进程照跑而结算分支被 s.stopped 拦住 → 卡片永久「执行中」+ spinner。
                if (toolHalted(ctx.toolMessage)) return '用户已停止生成，命令未执行。';
                ctx.toolMessage.status = 'running';
                ctx.toolMessage.content = '执行中…';
                // runId 注册到 Go 取消注册表：用户停止会话时按 id 杀进程树（AIStopShellRun）
                ctx.toolMessage.runId = (ctx.session.id || 'session') + '#shell-' + (ctx.toolMessage.toolCallId || (++aiShellRunSeq));
                refreshToolWrap(ctx.session, ctx.toolMessage);
                let result;
                try {
                    result = await backend.AIRunShellCommand(command, cwd, timeoutMs, ctx.toolMessage.runId);
                } catch (e) {
                    if (ctx.toolMessage.interrupted) {
                        // 用户已停止：进程已被 AIStopShellRun 杀掉，卡片保持终止态，不再标注失败细节
                        return '用户已停止生成，命令已终止。';
                    }
                    const approval = ctx.toolMessage.approval;
                    if (approval && approval.kind === 'command') {
                        approval.state = 'failed';
                        approval.error = String((e && e.message) || e);
                        persistApprovalMutation(ctx.session, ctx.toolMessage);
                    }
                    throw e;
                }
                if (ctx.toolMessage.interrupted) {
                    // 进程在停止后才自然结束：输出丢弃，卡片保持终止态
                    return '用户已停止生成，命令输出已丢弃。';
                }
                const clip = (text) => {
                    const value = aiTextOf(text).replace(/\r\n/g, '\n').trimEnd();
                    return value.length > 16000 ? value.slice(0, 16000) + '\n…（输出已截断）' : value;
                };
                const lines = [
                    '命令：' + command,
                    'Shell：' + ((result && result.shell) || '未知') +
                        ' · 退出码：' + (result && result.code != null ? result.code : -1) +
                        ' · 用时：' + ((result && result.durationMs) || 0) + ' ms',
                ];
                if (result && result.timedOut) lines.push('（命令超时，已终止；以下为已捕获输出）');
                const stdout = clip(result && result.stdout);
                const stderr = clip(result && result.stderr);
                if (stdout) lines.push('stdout：\n' + stdout);
                if (stderr) lines.push('stderr：\n' + stderr);
                if (!stdout && !stderr) lines.push('（无输出）');
                return lines.join('\n');
            }
            case 'background_command': {
                if (!ctx || !ctx.session || !ctx.toolMessage) throw new Error('后台命令缺少会话上下文');
                const command = aiTextOf(input.command).trim();
                if (!command) throw new Error('命令不能为空');
                if (!backend.AICommandStart) throw new Error('当前版本不支持后台命令');
                const cwd = aiResolveScopePath(aiTextOf(input.cwd).trim() || '.', ctx.session);
                const decision = await approveCommandForRun(ctx.session, ctx.toolMessage, command, cwd, 'background_command');
                if (!decision.approved) {
                    return decision.denied
                        ? '命令被项目权限规则禁止，未启动（规则 ' + decision.rule + '）。'
                        : (decision.cancelled
                            ? '用户已停止生成，命令未启动。'
                            : '用户取消了本次后台命令，未启动。');
                }
                // 同 run_command：停止之后不再拉起后台作业
                if (toolHalted(ctx.toolMessage)) return '用户已停止生成，命令未启动。';
                ctx.toolMessage.status = 'running';
                ctx.toolMessage.content = '正在启动…';
                refreshToolWrap(ctx.session, ctx.toolMessage);
                let job;
                try {
                    job = await backend.AICommandStart(command, cwd);
                } catch (e) {
                    const approval = ctx.toolMessage.approval;
                    if (approval && approval.kind === 'command') {
                        approval.state = 'failed';
                        approval.error = String((e && e.message) || e);
                        persistApprovalMutation(ctx.session, ctx.toolMessage);
                    }
                    throw e;
                }
                ctx.toolMessage.bg = {jobId: job.jobId, state: 'running', code: null};
                ctx.toolMessage.bgLog = '';
                bgJobCursors.set(job.jobId, 0);
                // 头部「终端」chip 与内容区标签页的数据源（运行期）
                bgJobIndex.set(job.jobId, {
                    session: ctx.session, rootSessionId: rootSessionIdOf(ctx.session),
                    message: ctx.toolMessage, command, cwd, startedAt: Date.now(),
                });
                notifyBackgroundActivity();
                // 实时输出：cmd-out 广播 → 卡片；面板关闭时只更新 bgLog，切回可见即恢复
                if (commandOutput) {
                    commandOutput(job.jobId, {
                        onOut: (data) => bgLiveAppend(ctx.session, ctx.toolMessage, 'out', data),
                        onErr: (data) => bgLiveAppend(ctx.session, ctx.toolMessage, 'err', data),
                        onExit: (code) => bgLiveFinish(job.jobId, code),
                    });
                }
                refreshToolWrap(ctx.session, ctx.toolMessage);
                return '已在后台启动：jobId=' + job.jobId + '（Shell：' + (job.shell || '未知') + '）\n' +
                    '不要用 run_command 重复执行它。用 check_command 轮询进度，作业结束后向用户汇报结果；需提前终止用 stop_command（jobId 传 ' + job.jobId + '）。';
            }
            case 'check_command': {
                const jobId = aiTextOf(input.jobId).trim();
                if (!jobId) throw new Error('jobId 不能为空');
                if (!backend.AICommandStatus) throw new Error('当前版本不支持查询后台命令');
                const since = bgJobCursors.get(jobId) || 0;
                const st = await backend.AICommandStatus(jobId, since);
                bgJobCursors.set(jobId, Number(st.cursor) || since);
                syncBgCardState(jobId, st);
                const stateText = st.state === 'running' ? '运行中' : (st.state === 'exited' ? '已退出' : '不存在');
                const lines = [
                    '作业：' + jobId + (st.command ? '（' + st.command + '）' : ''),
                    '状态：' + stateText +
                        (st.state === 'exited' ? ' · 退出码：' + st.code : '') +
                        ' · ' + (Number(st.durationMs) || 0) + ' ms',
                ];
                if (st.truncated) lines.push('（最早的部分输出因超出缓冲已被丢弃）');
                const clip = (text) => {
                    const value = aiTextOf(text).replace(/\r\n/g, '\n').trimEnd();
                    return value.length > 16000 ? value.slice(0, 16000) + '\n…（输出已截断）' : value;
                };
                const out = clip(st.output);
                if (st.state === 'notfound') {
                    lines.push('（作业不存在：可能编号无效，或应用重启后作业已丢失）');
                } else if (out) {
                    lines.push('新增输出：\n' + out);
                } else {
                    lines.push('（无新增输出）');
                }
                return lines.join('\n');
            }
            case 'stop_command': {
                const jobId = aiTextOf(input.jobId).trim();
                if (!jobId) throw new Error('jobId 不能为空');
                if (!backend.AICommandStop) throw new Error('当前版本不支持停止后台命令');
                const st = await backend.AICommandStop(jobId);
                bgJobCursors.set(jobId, Number(st.cursor) || 0);
                syncBgCardState(jobId, st);
                const lines = ['作业：' + jobId + (st.command ? '（' + st.command + '）' : '')];
                if (st.state === 'notfound') {
                    lines.push('状态：不存在（可能已经结束并被清理，或编号无效）');
                    return lines.join('\n');
                }
                lines.push('状态：' + (st.code === -1 ? '已终止' : '已退出') + ' · 退出码：' + st.code + ' · ' + (Number(st.durationMs) || 0) + ' ms');
                const clip = (text) => {
                    const value = aiTextOf(text).replace(/\r\n/g, '\n').trimEnd();
                    return value.length > 16000 ? value.slice(0, 16000) + '\n…（输出已截断）' : value;
                };
                const out = clip(st.output);
                if (out) lines.push('已捕获输出：\n' + out);
                else lines.push('（无已捕获输出）');
                return lines.join('\n');
            }
            case 'schedule_create': {
                if (!backend.AIScheduleCreate) throw new Error('当前版本不支持定时任务');
                // 目标会话：显式 sessionId 优先；否则默认绑定当前会话（到点唤醒本对话）；newSession=true 才每次新建
                const explicitTarget = aiTextOf(input.sessionId).trim();
                // 默认绑定「发起这次调用的会话」而不是当前查看的会话：后台会话建的定时任务
                // 不该被塞到用户正看着的另一个对话里。
                const callerSession = (ctx && ctx.session) || currentSession();
                const resolvedTarget = input.newSession === true
                    ? ''
                    : (explicitTarget || (callerSession ? callerSession.id : ''));
                const created = await backend.AIScheduleCreate({
                    name: aiTextOf(input.name).trim(),
                    kind: aiTextOf(input.kind).trim() || 'once',
                    at: aiTextOf(input.at).trim(),
                    delayMinutes: aiClampInt(input.delayMinutes, 0, 525600, 0),
                    intervalMinutes: aiClampInt(input.intervalMinutes, 0, 525600, 0),
                    cron: aiTextOf(input.cron).trim(),
                    prompt: aiTextOf(input.prompt),
                    sessionId: resolvedTarget,
                    scope: ['chat', 'read', 'edit'].includes(input.scope) ? input.scope : 'chat',
                    maxRuns: aiClampInt(input.maxRuns, 0, 1000000, 0),
                });
                // 工具卡在过程折叠体里，创建成功后再给一个过程外的可见提示，并刷新设置列表。
                flash('已创建定时任务：' + created.name + '（' + describeAISchedule(created) + '）');
                renderScheduleSettings();
                return '已创建定时任务：' + created.name + '（id=' + created.id + '）\n' +
                    describeAISchedule(created) + ' · 权限档：' + (created.scope === 'edit' ? 'edit' : created.scope) +
                    (created.sessionId ? ' · 唤醒会话 ' + (sessionTitleById(created.sessionId) || created.sessionId) : ' · 每次新建会话') +
                    (created.scope === 'edit' ? '\n注意：edit 档任务触发时若无人在场处理写审批会一直挂起。' : '');
            }
            case 'schedule_list': {
                if (!backend.AIScheduleList) throw new Error('当前版本不支持定时任务');
                const list = await backend.AIScheduleList();
                if (!list.length) return '当前没有定时任务。需要「每 N 分钟 / 每天某时刻 / 单次提醒」时可用 schedule_create 创建。';
                return list.map((s, i) =>
                    (i + 1) + '. ' + s.name + '（id=' + s.id + '）\n' +
                    '   ' + describeAISchedule(s) + ' · ' + (s.enabled ? '启用' : '停用') +
                    ' · ' + (s.sessionId ? '唤醒会话「' + (sessionTitleById(s.sessionId) || s.sessionId) + '」' : '每次新建会话') +
                    ' · 已触发 ' + (s.runCount || 0) + ' 次' +
                    (s.lastResult ? '\n   最近：' + s.lastResult : '')
                ).join('\n');
            }
            case 'schedule_delete': {
                if (!backend.AIScheduleDelete) throw new Error('当前版本不支持定时任务');
                const id = aiTextOf(input.id).trim();
                if (!id) throw new Error('id 不能为空');
                await backend.AIScheduleDelete(id);
                flash('已删除定时任务：' + id);
                renderScheduleSettings();
                return '已删除定时任务 ' + id;
            }
            case 'schedule_toggle': {
                if (!backend.AIScheduleToggle) throw new Error('当前版本不支持定时任务');
                const id = aiTextOf(input.id).trim();
                if (!id) throw new Error('id 不能为空');
                const enabled = input.enabled !== false;
                const s = await backend.AIScheduleToggle(id, enabled);
                flash('已' + (enabled ? '启用' : '停用') + '定时任务：' + s.name);
                renderScheduleSettings();
                return '已' + (enabled ? '启用' : '停用') + '定时任务「' + s.name + '」（id=' + s.id + '）' +
                    (enabled ? '\n' + describeAISchedule(s) : '');
            }
            case 'spawn_agent': {
                if (!ctx || !ctx.session || !ctx.toolMessage) throw new Error('子代理缺少会话上下文 v2');
                const mode = String(aiTextOf(input && input.mode) || 'blocking').toLowerCase() === 'background'
                    ? 'background' : 'blocking';
                if (mode === 'background') {
                    // 后台派单：注册即返回，主代理继续自己的回合；结论以后续通知注入（§4.5 原语 1）
                    const started = await startSubAgent(ctx, input);
                    const sub = started.sub;
                    return '已派出后台子代理「' + sub.name + '」（id=' + sub.id + '，第 ' + sub.depth + ' 层，轮次上限 ' +
                        sub.maxRounds + '）。\n完成后会自动通知你；期间可继续其他工作，需要补充线索就 agent_send' +
                        '（urgent=true 插队）。要等它的结论用 wait_agent；不需要了用 agent_stop 停止并收集记录。';
                }
                const outcome = await runSubAgent(ctx, input);
                const meta = ctx.toolMessage.agent || {};
                const head = '子代理「' + (meta.name || '') + '」' +
                    ({done: '已完成', stopped: '已被用户停止', error: '失败'}[meta.state] || meta.state) +
                    '（轮次 ' + (meta.rounds || 0) + ' · 用时 ' + Math.round((meta.ms || 0) / 1000) + 's' +
                    (meta.tokens ? ' · ' + meta.tokens + ' tokens' : '') + '）';
                return head + '\n' + (outcome || '（无结论）');
            }
            // —— 会话消息化工具面（agent_send / agent_stop / wait_agent / agent_compact /
            // session_list / session_send）：执行体按阶段落在 ai-subagents.js 与 ai-agent-notices.js，
            // panel 只做这个薄分发（§4.11.2「施工即搬迁」）。
            case 'agent_send':
            case 'agent_stop':
            case 'wait_agent':
            case 'agent_compact':
            case 'session_list':
            case 'session_send': {
                if (typeof agentToolHandler !== 'function') throw new Error('当前版本不支持工具：' + name);
                return agentToolHandler(name, input, ctx);
            }
            default:
                throw new Error('未知工具：' + name);
        }
    }

    function currentScopeOf(session) {
        const scope = session && session.scope;
        return AI_SCOPES.includes(scope) ? scope : 'read';
    }

    // ---------- 流式对话 ----------

    // 「发送 / 停止」按钮显隐：空闲显示发送；生成中若输入区已有内容（文字 / 图片），
    // 保持「发送」——点击排队、Ctrl+点击 插话；输入区为空才切回「停止」（要停止先清空输入）。
    function syncSendStopButtons(busy) {
        const hasContent = !!(el.input && el.input.value.trim())
            || getAttachments().some((item) => item.kind === 'image');
        const showStop = busy && !hasContent;
        if (el.stop) el.stop.classList.toggle('hidden', !showStop);
        if (el.send) el.send.classList.toggle('hidden', showStop);
        if (el.send) el.send.dataset.tip = (busy && hasContent)
            ? '排队发送；Ctrl+点击 = 插话（停止当前回复并立即发送）'
            : '发送';
    }

    // composer 的「发送 / 停止」始终只看当前查看会话自己的流：
    // 别的会话在生成不影响这里（每个会话一条独立流），因此无需外部传入 active。
    function setStreamingUI() {
        syncStreamView();
        const viewing = currentSession();
        const compact = compactOf(viewing && viewing.id);
        const busy = !!stream || !!compact;
        syncSendStopButtons(busy);
        if (el.input) {
            el.input.placeholder = busy
                ? '输入消息：Enter/点击发送 排队，Ctrl+点击发送 插话'
                : '发消息或粘贴图片；/ 调用指令，@ 提及文件';
        }
        updateSendState();
        updateComposerTakeover();
        if (stream) {
            // 提示本轮实际使用的模型；对话中切换模型要到下一条消息才生效
            const running = (stream.profileCfg && stream.profileCfg.model) || (entryOf(currentSession()) || {}).model || '';
            if (el.hint) el.hint.textContent = '生成中 · Enter/点击发送排队 · Ctrl+Enter/Ctrl+点击发送 插话' + (running ? ' · ' + running : '');
        } else if (compact) {
            if (el.hint) el.hint.textContent = '正在压缩上下文…';
        }
        renderMessageQueue();
    }

    function updateSendState() {
        if (!el.send) return;
        if (sessionsPending()) {
            // 会话列表还没读回来：此时发送会落到占位会话上，读盘一完成就被替换掉（消息丢失）。
            // 只读盘最初几百毫秒，直接禁用并说明原因。
            el.send.disabled = true;
            syncSendStopButtons(false);
            el.send.dataset.tip = '正在读取会话…';
            if (el.hint) el.hint.textContent = '正在读取会话…';
            return;
        }
        syncStreamView();
        const hasProfile = !!profileOf(currentSession());
        const viewingId = (currentSession() || {}).id;
        const busy = !!stream || !!compactOf(viewingId);
        const session = currentSession();
        const archived = !!(session && session.archivedAt);
        const loadFailed = !!(session && session._loadError);
        const hasText = !!(el.input && el.input.value.trim());
        const attachedItems = getAttachments();
        const hasImages = attachedItems.some((item) => item.kind === 'image');
        const hasVideos = attachedItems.some((item) => item.kind === 'video');
        const hasTextAttachments = attachedItems.some((item) => item.kind !== 'image' && item.kind !== 'video');
        const imageEntry = (hasImages || hasVideos) ? entryOf(currentSession()) : null;
        const imageBlocked = !!imageEntry && imageEntry.modalities && imageEntry.modalities.image === false;
        // 视频与图像共用发送门禁：附加后模型条目被改掉能力位时在这里兜底拦下
        const videoBlocked = hasVideos && !!imageEntry && imageEntry.modalities && imageEntry.modalities.video === false;
        el.send.disabled = !hasProfile || archived || loadFailed || imageBlocked || videoBlocked ||
            (!hasText && !hasImages && !hasVideos && !hasTextAttachments);
        syncSendStopButtons(busy);
        if (!busy && el.hint) {
            // 本会话空闲但别的会话在跑：给出提示，但发送按钮仍然是「发送」
            const others = streams.size;
            el.hint.textContent = loadFailed
                ? '会话正文读取失败，已禁止追加；可清空该会话或检查 ai-sessions 目录'
                : (archived ? '会话已归档，取消归档后可继续'
                    : (imageBlocked ? '当前模型未勾选图像输入：请移除图片或在模型设置中开启'
                        : (videoBlocked ? '当前模型未勾选视频输入：请移除视频或在模型设置中开启'
                            : (hasProfile ? (others ? '其他会话正在生成（' + others + ' 个）· Enter 发送到本会话' : '') : '未配置 AI'))));
        }
    }

    function scheduleStreamRender(target) {
        const s = target || syncStreamView();
        if (!s || s.renderTimer) return;
        s.renderTimer = setTimeout(() => {
            s.renderTimer = 0;
            if (!isOpen()) return;
            const session = currentSession();
            if (!session || session.id !== s.sessionId) return;
            const index = session.messages.indexOf(s.assistant);
            if (index < 0) return;
            let wrap = el.messages.querySelector('.ai-msg.assistant[data-ai-idx="' + index + '"]');
            if (!wrap) return;
            // 流式中的工具调用占位（name 已到、参数还在增量接收）随帧一起更新；
            // key = toolCalls 的序号，供占位行缓存 ± 统计与旧文件基线
            const liveTools = [];
            for (const [key, call] of s.toolCalls.entries()) {
                if (call.name) liveTools.push({key, name: call.name, arguments: call.arguments});
            }
            updateAssistantElement(wrap, s.assistant, true, liveTools.length ? {liveTools} : undefined);
            positionOverlays();
            if (stickBottom) scrollToBottom(false);
            else updateScrollButton();
        }, 80);
    }

    function newAssistantMessage(profile, entry) {
        // 不传 entry 时按当前会话解析（后台会话调用点都显式传）
        const resolved = entry === undefined ? entryOf(currentSession()) : entry;
        const entryRef = resolved;
        return {
            role: 'assistant',
            content: '',
            reasoning: '',
            thinkingSignature: '',
            model: entryRef && entryRef.model ? entryRef.model : (profile && profile.name ? profile.name : ''),
            // 记录当轮账号名：每轮用量浮层要显示「提供方 / 模型」，切模型后老消息仍要显示对的账号
            modelAccount: profile && profile.name ? profile.name : '',
            ts: Date.now(),
            status: 'streaming',
            usage: null,
            error: '',
            toolCalls: [],
        };
    }

    function sessionById(id) {
        return sessions.find((session) => session.id === id) || null;
    }

    // 工具循环增量挂卡：新工具消息只 append 自己的卡，不全量重建消息区——
    // renderMessages 的全量重建会把前面所有工具卡的 spinner 动画重启
    // （AI 连续跑工具时当前执行中的卡疯狂闪烁）。
    function appendToolCard(session, toolMessage) {
        if (!hasHost(session && session.id) || !el.messages) return;
        const index = session.messages.indexOf(toolMessage);
        if (index < 0) return;
        const wrap = document.createElement('div');
        wrap.className = 'ai-msg tool';
        wrap.dataset.aiIdx = String(index);
        renderToolMessage(wrap, toolMessage);
        // 流式状态条（看板娘条）钉在消息区最底：新工具卡插到它之前，别把它顶上去
        const bar = el.messages.querySelector('.ai-streaming-bar');
        if (bar) el.messages.insertBefore(wrap, bar);
        else el.messages.appendChild(wrap);
        notifyStructure();
        scheduleOutlineSync();
        if (stickBottom) scrollToBottom(false);
        else updateScrollButton();
    }

    function refreshToolWrap(session, toolMessage) {        if (!hasHost(session && session.id)) return;
        const index = session.messages.indexOf(toolMessage);
        const wrap = el.messages.querySelector('.ai-msg.tool[data-ai-idx="' + index + '"]');
        if (!wrap) {
            renderMessages(true);
            return;
        }
        wrap.innerHTML = '';
        renderToolMessage(wrap, toolMessage);
        // 卡片原位更新后高度可能变化（如 diff 展开）：跟随底部，避免把文档末尾的流式状态条顶出视口
        if (stickBottom) scrollToBottom(false);
        else updateScrollButton();
    }

    // 通用应用消息：任意功能向当前会话注入一条带来源标识的「应用消息」卡片，交给 AI 执行。
    // 调用：aiPanel.sendAppMessage({kind: 'git', label: 'Git 快捷操作 · 提交代码', content: prompt})
    // kind 决定默认图标（见 ai-app-message.js），也可用 icon 指定 icons.js 里登记的图标。
    function sendAppMessage(options) {
        const source = options || {};
        const content = aiTextOf(source.content).trim();
        if (!content) return Promise.resolve(false);
        return submitText(content, null, {app: normalizeAppMessage(source)});
    }

    // 会话级启动内核（阶段 A 抽取，纯重构）：给定会话直接起一轮——不读 currentSession、
    // 不碰输入区 / 附件快照 / 滑出菜单，后台注入（定时任务、计时器、通知唤醒、支线带回）
    // 全部走这条路径。submitText 只保留 UI 部分（读输入区附件、清空、渲染当前会话）后转调。
    // 返回 {ok, reason, run, ended}：reason 供调用方决定提示文案（内核不 flash 校验类错误）。
    async function startSessionTurn(session, text, options) {
        const opts = options || {};
        let value = String(text == null ? '' : text).trim();
        const source = opts.attachments || {};
        const imageAttachments = (source.images || []).map(aiNormalizeImage).filter(Boolean);
        const videoAttachments = (source.videos || []).map(aiNormalizeVideo).filter(Boolean);
        const textAttachments = (source.texts || []).slice();
        if (!value && !imageAttachments.length && !videoAttachments.length && !textAttachments.length) return {ok: false, reason: 'empty'};
        // 纯文本附件 + 空输入：给一个极短占位，避免向 API 发送空 content（Anthropic 不接受空文本块）
        if (!value && textAttachments.length) value = '（已附加引用/文件，见 <attachments>）';
        if (value.length > AI_CHAT_INPUT_LIMIT) return {ok: false, reason: 'too_long'};
        if (!session) return {ok: false, reason: 'no_session'};
        // 首次读盘未完成时 session 是占位对象：消息落上去会被读盘结果整份替换掉（等于丢消息）。
        if (sessionsPending()) return {ok: false, reason: 'sessions_pending'};
        // 懒加载会话：正文还没读上来（后台唤醒 / 投递到没点开过的会话会走到这里）。
        // 必须在任何 messages 写入之前补完，否则这一轮会落到空数组上、写盘又只写 meta，等于丢消息。
        if (session._stub) {
            const ok = await ensureSessionLoaded(session);
            if (!ok || session._stub) return {ok: false, reason: 'load_failed'};
        }
        // 只有「本会话」在生成 / 压缩时才拒绝；别的会话在跑不影响这里（各自独立）。
        if (streamOf(session.id) || compactOf(session.id)) return {ok: false, reason: 'busy'};
        if (session.archivedAt) return {ok: false, reason: 'archived'};
        if (!session.workspace) {
            const current = currentWorkspacePath();
            if (current) session.workspace = current;
        }
        const profile = profileOf(session);
        const entry = entryOf(session);
        if (!profile) return {ok: false, reason: 'no_profile'};
        if (!backend.AISendChat) return {ok: false, reason: 'no_backend'};
        // 视频只有 OpenAI 兼容 chat completions 有公认内容段：Anthropic / Responses 协议在
        // 这里拦下并说明（Go 传输层对这两套协议遇 videos 也会报错，双保险）。
        if (videoAttachments.length && profile.provider && profile.provider !== 'openai') {
            return {ok: false, reason: 'video_protocol'};
        }

        // 重发 / 编辑态的截断只在 UI 路径生效：注入路径恒传 truncateAt=null 且
        // allowPendingEdit=false，否则用户正在编辑的那条会被后台唤醒顺手砍掉（§4.4 唤醒防护）。
        let cut = opts.truncateAt == null ? null : opts.truncateAt;
        if (cut == null && opts.allowPendingEdit && pendingEdit && pendingEdit.index != null &&
            (!pendingEdit.sessionId || pendingEdit.sessionId === session.id)) cut = pendingEdit.index;
        const windowSize = contextWindowOf(session);
        try {
            const previewBundle = await assembleSystemContext(session, textAttachments);
            const previewMessages = buildApiMessages(session, cut != null && cut >= 0 ? cut : null, previewBundle.text);
            let previewTokens = estimateApiMessagesTokens(previewMessages) +
                aiEstimateTokens(value);
            for (const item of imageAttachments) previewTokens += aiEstimateImageTokens(item);
            for (const item of videoAttachments) previewTokens += aiEstimateVideoTokens();
            for (const item of textAttachments) previewTokens += aiEstimateTokens(aiTextOf(item.content));
            previewTokens += toolsTokenEstimate(session);
            if (windowSize > 0 && previewTokens > windowSize * 0.9) {
                updateCtxBanner();
                return {ok: false, reason: 'over_budget', tokens: previewTokens, windowSize};
            }
        } catch (e) {}
        // 预检的 assembleSystemContext 是异步点：两次极快连发可能都通过了上面的忙检查（此时
        // 双方都还没注册流），各自起轮后后者顶掉前者的流注册，落败方在下方守卫处退出——
        // 它的 assistant 占位没人收尾，永远停在流式「…」。真正落消息前再查一次忙，
        // 把这个窗口关死；队列冲刷对 busy 会自动重新入队，不会丢消息。
        if (streamOf(session.id) || compactOf(session.id)) return {ok: false, reason: 'busy'};

        if (cut != null && cut >= 0) session.messages = session.messages.slice(0, cut);
        if (opts.allowPendingEdit) pendingEdit = null;
        // 上一次切换的模型从这条消息开始生效：先把切换记录落到本条消息之前
        flushModelSwitchNote(session);

        const turnStartedAt = Date.now();
        // 上一轮清单已全部完成：新轮开工即收走（dsh 的 turn/start 语义）——
        // 不指望 AI 清理，旧清单也不跨轮挂在底部
        if (Array.isArray(session.todos) && session.todos.length && session.todos.every((t) => t.status === 'completed')) {
            session.todos = [];
            persistSessions();
            if (isOpen() && currentSession() === session) renderTodos();
        }
        const userMessage = {
            role: 'user',
            content: value,
            images: imageAttachments,
            videos: videoAttachments,
            ts: turnStartedAt,
            turnStartedAt,
        };
        if (opts.app && typeof opts.app === 'object') {
            userMessage.app = normalizeAppMessage(opts.app);
        }
        session.messages.push(userMessage);
        // 消费点 3（§4.14.4）：起轮前把信箱里的待投通知一并带上——覆盖「通知刚挂上、用户同时
        // 手动发了一条」的滞留竞态。顺序固定为「用户消息 → notices → 系统提醒」。
        foldNoticesBeforeTurn(session);
        updateSessionTitleFromText(session, value || '图片对话');
        // 用户在这个会话里说话了：之前后台结束留下的未读标记立刻作废。
        clearSessionUnread(session);
        renderSessionList();
        // 这条消息用哪个模型，就把它固定成该会话自己的选择（其他会话不受影响）
        pinSessionModel(session, profile, entry);
        queueLogSave(session);
        const scope = currentScopeOf(session);
        session.scope = scope;
        const assistant = newAssistantMessage(profile, entry);
        assistant.planMode = !!session.planMode;
        session.messages.push(assistant);
        session.round = (Number(session.round) || 0) + 1;
        const baseRound = session.round;

        const run = attachStream({
            sessionId: session.id,
            baseRound,
            roundNo: 0,
            roundId: session.id + '#' + baseRound + '-0',
            assistant,
            startedAt: turnStartedAt,
            // 本轮改动记录的起点：收尾时据此切出「本轮」写过的文件。
            changesMark: changesSnapshot(session),
            thinkStartedAt: 0,
            roundStartedAt: 0,
            firstTokenAt: 0,
            renderTimer: 0,
            finished: false,
            stopped: false,
            toolCalls: new Map(),
            tools: toolsForScope(scope, !!session.planMode),
            profileCfg: configForProfile(profile, entry),
            // 本轮实际使用的模型条目（对象引用即 config.profiles 里的那条）：
            // 服务端给出 max_tokens 上界时用它精确回写输出窗口，不靠模型名反查。
            modelEntry: entry,
            systemPrompt: AI_DEFAULT_SYSTEM_PROMPT,
            baseSystemPrompt: AI_DEFAULT_SYSTEM_PROMPT,
            scope,
            plan: !!session.planMode,
        });
        // 只渲染「用户正在看的会话」：后台注入不改用户视图、不强开面板，
        // 完成经会话列表未读标记提示（§4.13.2）。
        const viewed = isOpen() && currentSession() === session;
        if (viewed) {
            if (opts.preserveScroll) {
                // 后台唤醒（通知冲刷 / 排队消息轮末发送）：用户可能正上翻阅读，不抢滚动位置——
                // 贴底态照常跟随（stickBottom 为 true 时 keepScroll 渲染仍会贴底），上翻态保持原位，
                // 底下靠滚动按钮提示有新内容。
                renderMessages(true);
            } else {
                stickBottom = true;
                renderMessages();
            }
            setStreamingUI();
            positionOverlays();
        }
        // 会话列表立刻出现「生成中」标记（按会话独立显示，其他会话的流不受影响）
        renderSessionList();
        // 先把用户消息与占位 assistant 落盘：即使流事件丢失、应用崩溃或磁盘重读打断，
        // 会话也不会只剩一个空壳（定时任务/后台注入尤其明显）。
        persistSessions();
        // UI 侧同点动作（清输入框、收起斜杠菜单）：由 submitText 传入，内核不碰 DOM 输入区。
        if (typeof opts.onStarted === 'function') opts.onStarted();

        let bundle = {text: AI_DEFAULT_SYSTEM_PROMPT, meta: null};
        const attachmentList = textAttachments.slice();
        try {
            bundle = await assembleSystemContext(session, attachmentList);
        } catch (e) {
            noteForSession(session.id, '上下文注入失败：' + ((e && e.message) || e), true);
        }
        rememberPrompt(session.id, bundle);
        if (viewed) updateContextCount();
        if (streams.get(session.id) !== run || run.stopped) {
            // 兜底不变量：被顶替 / 已停止的轮，占位 assistant 不能留在 'streaming'——
            // 否则消息区的「…」永远转下去（忙复查在位时这条只是保险）。
            if (run.assistant.status === 'streaming') {
                run.assistant.status = 'stopped';
                persistSessions();
                if (isOpen() && currentSession() && currentSession().id === session.id) renderMessages();
            }
            return {ok: true, run, ended: true};
        }
        run.baseSystemPrompt = bundle.text;
        run.systemPrompt = bundle.text;
        startRound(run);
        return {ok: true, run};
    }

    // UI 路径：读输入区（正文 + 附件）→ 交内核起轮 → 清空输入区并刷新当前视图。
    // 会话 / 预算 / 后端校验全在内核里，这里只把失败原因翻成用户提示。
    async function submitText(text, truncateAt, extra) {
        let value = String(text == null ? '' : text).trim();
        const attached = getAttachments();
        // 对话引用拼进 user content 前缀：随消息落盘、压缩不丢，且不重复注入 <attachments>。
        const quoteMarkup = quoteMarkupFromAttachments(attached);
        if (quoteMarkup) value = value ? quoteMarkup + '\n\n' + value : quoteMarkup;
        const session = currentSession();
        const result = await startSessionTurn(session, value, {
            truncateAt,
            allowPendingEdit: true,
            app: extra && extra.app,
            // 排队消息轮末冲刷等代发路径：用户可能正上翻阅读，不抢滚动位置（贴底态照常跟随）
            preserveScroll: !!(extra && extra.preserveScroll),
            attachments: {
                images: attached.filter((item) => item.kind === 'image'),
                videos: attached.filter((item) => item.kind === 'video'),
                texts: attached.filter((item) => item.kind !== 'image' && item.kind !== 'video' && item.kind !== 'message_quote'),
            },
            // 起轮成功、落盘之后立刻清输入区（与原实现同一时点）；附件要等系统提示组装完再清，
            // 因为 assembleSystemContext 会读它们。
            onStarted: () => {
                if (el.input) {
                    el.input.value = '';
                    resizeInput();
                }
                hideSlash();
            },
        });
        if (!result.ok) {
            if (result.reason === 'too_long') flash('消息过长（上限 ' + AI_CHAT_INPUT_LIMIT + ' 字符）', true);
            else if (result.reason === 'sessions_pending') flash('正在读取会话，稍等一下再发送', true);
            else if (result.reason === 'load_failed') flash('会话正文读取失败，请检查 ai-sessions 目录', true);
            else if (result.reason === 'archived') flash('该会话已归档，请先在会话菜单中取消归档', true);
            else if (result.reason === 'no_backend') showNote('当前版本不支持 AI 对话（后端方法缺失）。', true);
            else if (result.reason === 'no_profile') {
                renderMessages();
                updateSendState();
            } else if (result.reason === 'over_budget') {
                flash('上下文预计约 ' + result.tokens + ' tokens，超过窗口 ' + result.windowSize +
                    ' 的 90%，请先 /compact 或减少附加内容', true);
            } else if (result.reason === 'video_protocol') {
                flash('当前账号协议（Anthropic / Responses）不支持视频输入：请改用 OpenAI 兼容协议的模型条目，或移除视频附件', true);
            }
            return false;
        }
        setAttachments([]);
        attachSeq = 0;
        renderAttachments();
        return true;
    }

    function startRound(target) {
        const s = target || syncStreamView();
        if (!s) return;
        // 已被同一会话的新请求顶替，或该会话的流已注销：不再续轮
        if (streams.get(s.sessionId) !== s) return;
        const session = sessionById(s.sessionId);
        if (!session) {
            finishStream(s);
            return;
        }
        if (s.stopped) {
            if (s.assistant.status === 'streaming') s.assistant.status = 'stopped';
            finishStream(s);
            return;
        }
        // 对齐 harness：无硬性轮数上限。每 AI_TOOL_ROUND_LIMIT 轮注入一次轻提醒，
        // 停止只由用户中止、上下文压缩或模型自然结束触发。
        if (s.roundNo > 0 && s.roundNo % AI_TOOL_ROUND_LIMIT === 0 && s.lastRoundNote !== s.roundNo) {
            s.lastRoundNote = s.roundNo;
            session.messages.push({
                role: 'user',
                content: '（系统提示）工具调用轮次已达 ' + s.roundNo + '。长任务可以继续执行；如已接近完成，建议适时总结收尾。',
                status: 'done',
                ts: Date.now(),
                systemNote: true,
            });
            noteForSession(s.sessionId, '工具轮次已达 ' + s.roundNo + '，长任务可继续…');
        }
        s.roundNo += 1;
        s.roundId = session.id + '#' + s.baseRound + '-' + s.roundNo;
        s.thinkStartedAt = 0;
        s.roundStartedAt = Date.now();
        s.firstTokenAt = 0;
        s.toolCalls.clear();
        // 每轮单独判定：上一轮的重复不能把新 Assistant 消息直接拖进确认卡。
        s.loopGuard = createLoopGuard();
        s.loopGuardDisarmedUntil = 0;
        // 每轮刷新计划状态、工具集与系统提示：plan_mode 工具可在流中途切换会话状态。
        s.plan = !!session.planMode;
        s.tools = toolsForScope(currentScopeOf(session), !!session.planMode);
        s.systemPrompt = (s.baseSystemPrompt || AI_DEFAULT_SYSTEM_PROMPT) +
            (session.planMode ? '\n\n' + planModeBlock() : '');
        // 一轮对话固定使用启动时的模型配置：对话中切换模型从下一条消息开始生效，
        // 本轮剩余的工具轮仍走旧模型；消息头标签跟随本轮实际请求的模型。
        if (s.assistant && s.profileCfg && s.profileCfg.model) s.assistant.model = s.profileCfg.model;
        const index = session.messages.indexOf(s.assistant);
        if (index < 0) {
            finishStream(s);
            return;
        }
        if (isOpen() && currentSession() === session) {
            const wrap = el.messages.querySelector('.ai-msg.assistant[data-ai-idx="' + index + '"]');
            if (wrap) updateAssistantElement(wrap, s.assistant, true);
        }
        const apiMessages = buildApiMessages(session, index, s.systemPrompt);
        try {
            const result = backend.AISendChat(s.roundId, s.profileCfg, apiMessages, s.tools, config.retryMax);
            if (result && typeof result.then === 'function') {
                result.catch((e) => {
                    if (streams.get(s.sessionId) !== s) return;
                    finishStreamError((e && e.message) || String(e || '请求失败'), s);
                });
            }
        } catch (e) {
            finishStreamError((e && e.message) || String(e || '请求失败'), s);
        }
    }

    function finishStreamError(message, target) {
        const current = target || syncStreamView();
        if (!current) return;
        current.assistant.status = 'error';
        current.assistant.error = String(message || '请求失败');
        finishStream(current);
    }

    function appToastPreview(text, max) {
        const clean = String(text || '')
            .replace(/```[\s\S]*?```/g, ' [代码] ')
            .replace(/[#>*_`~]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return clean.length > max ? clean.slice(0, max) + '…' : clean;
    }

    // 页面级焦点判断：只能当兜底。WebView2 在嵌入场景下 hasFocus 会滞留
    //（切走了还报 true），所以真正说了算的是后端的 AppWindowActive（GetForegroundWindow）。
    function appInForeground() {
        if (document.hidden) return false;
        if (typeof document.hasFocus === 'function') return document.hasFocus();
        return true;
    }

    // 「本进程有没有窗口在前台」——后端系统级判定优先，拿不到（旧构建 / 非 Windows）再退回页面判断。
    function appReallyForeground() {
        const ask = backend.AppWindowActive;
        if (typeof ask !== 'function') return Promise.resolve(appInForeground());
        try {
            return Promise.resolve(ask()).then((value) => value === true).catch(() => appInForeground());
        } catch (e) {
            return Promise.resolve(appInForeground());
        }
    }

    function notifyDesktop(options) {
        const inApp = config.notifyInApp === true;
        const system = config.notifySystem === true;
        const sessionId = String(options.sessionId || '');
        const kind = options.kind === 'error' ? 'error' : (options.kind === 'success' ? 'success' : 'info');
        const title = options.title || 'CaDt-DataLens';
        const body = options.body || '';
        // 「你看得见这条会话吗」：面板开着且就停在这个会话才算看得见（没有 sessionId 的一律算看不见）
        const current = currentSession();
        const viewingOther = !(sessionId && isOpen() && current && current.id === sessionId);
        const completion = options.completion === true;
        const deliver = (targets) => {
            // 消息中心只记「需要你回来处理」的（可事后查、可点开跳转）；例行任务完成不记——
            // 一轮一条会把【消息】列表刷成流水账，会话列表已有「已完成未查看」角标。
            // 只有「人在软件里但看的是别的会话」才额外右下角弹。
            if (targets.centerRecord !== false && typeof opts.addMessage === 'function') {
                opts.addMessage({kind, title, body, sessionId}, {toast: !!targets.inAppToast});
            }
            if (targets.systemToast && backend.NotifySystemToast) {
                // 未在系统登记过应用标识时，Windows 会「返回成功但不显示」——后端会主动登记，
                // 并把登记失败 / 用户关掉本应用通知这类错误返回来；以前这里静默吞掉，
                // 只能看到「开关开着但从来不弹」，现在至少留一条可查的日志。
                // payload（ai-session=<id>）在点击通知时由 Go 侧原样回传，前端据此跳会话。
                try {
                    const sent = backend.NotifySystemToast(title, body, buildNotifyActivationPayload(sessionId), config.notifySound === false);
                    if (sent && typeof sent.then === 'function') {
                        sent.catch((e) => console.warn('[系统通知] 发送失败：', (e && e.message) || e));
                    }
                } catch (e) {
                    console.warn('[系统通知] 发送失败：', (e && e.message) || e);
                }
            }
            // 任务栏闪烁只在人离开了软件时才有意义
            if (targets.taskbarFlash && backend.NotifyAttention) {
                try {
                    backend.NotifyAttention(!!config.notifySound);
                } catch (e) {}
            }
        };
        if (!inApp && !system) {
            // 两个弹层开关都关着也照样走一遍：消息中心仍要记「需要处理」的那几条
            deliver({centerRecord: !completion, systemToast: false, inAppToast: false, taskbarFlash: false});
            return;
        }
        appReallyForeground().then((foreground) => {
            deliver(desktopNotifyTargets({
                inApp, system, foreground, viewingOther,
                completion,
            }));
        });
    }

    function notifyTurnFinished(session, assistant, stopped) {
        if (!session || !assistant || stopped || assistant.status === 'stopped') return;
        if (assistant.status === 'error') {
            if (config.notifyError === false) return;
            notifyDesktop({
                kind: 'error',
                title: 'AI 任务失败',
                body: (session.title || '会话') + ' · ' + (assistant.error || '请求失败'),
                sessionId: session.id,
            });
            return;
        }
        if (assistant.status !== 'done' || !String(assistant.content || '').trim()) return;
        // 计划模式下这一轮产出的是「等你批准的计划」，不是「跑完的任务」：发一条待批准提醒
        // 就够了，别再叠一条「任务完成」（两条通知说的是同一次落地）。
        if (session && session.planMode && assistant.planMode) {
            if (config.notifyApprove === false) return;
            notifyDesktop({
                kind: 'info',
                title: 'AI 计划待批准',
                body: (session.title || '会话') + ' · 计划已生成，等你批准后开始执行',
                sessionId: session.id,
            });
            return;
        }
        if (config.notifyFinish === false) return;
        // completion: true —— 这条只可能落到「软件在后台时的系统卡片 / 任务栏闪烁」，
        // 不进消息中心（一轮一条会把【消息】列表刷成流水账，见 ai-notify-policy.js）。
        notifyDesktop({
            kind: 'success',
            title: 'AI 任务完成',
            completion: true,
            body: (session.title || '会话') + ' · ' + appToastPreview(assistant.content, 90),
            sessionId: session.id,
        });
    }

    function commitThinkTime(s) {
        if (!s || !s.assistant || !s.thinkStartedAt || s.assistant.thinkMs) return;
        s.assistant.thinkMs = Math.max(0, Date.now() - s.thinkStartedAt);
    }

    function markFirstToken(s) {
        if (s && !s.firstTokenAt) s.firstTokenAt = Date.now();
    }

    function commitRoundTiming(s) {
        if (!s || !s.assistant) return;
        const started = Number(s.roundStartedAt) || 0;
        if (!started) return;
        s.assistant.modelMs = Math.max(0, Date.now() - started);
        s.assistant.firstTokenMs = s.firstTokenAt ? Math.max(0, s.firstTokenAt - started) : 0;
        s.roundStartedAt = 0;
    }

    function finishStream(target) {
        // 只收尾指定的那条流：别的会话可能还在生成，不能碰它们的注册与 UI。
        const current = target || syncStreamView();
        if (!current) return;
        // 流已结束：挂起的循环确认卡直接收敛，避免用户对着已结束的轮次点停止。
        cancelLoopGuardPrompt(current, 'stream-ended');
        if (current.renderTimer) {
            clearTimeout(current.renderTimer);
            current.renderTimer = 0;
        }
        current.finished = true;
        const wasViewed = !!(currentSession() && currentSession().id === current.sessionId);
        commitThinkTime(current);
        commitRoundTiming(current);
        if (current.assistant.status === 'streaming') current.assistant.status = 'done';
        const session = sessionById(current.sessionId);
        if (session) {
            const idx = session.messages.indexOf(current.assistant);
            if (idx >= 0) {
                current.assistant.finishedAt = Date.now();
                const started = turnStartAt(session, idx);
                if (started) current.assistant.turnMs = Math.max(0, current.assistant.finishedAt - started);
            }
        }
        notifyTurnFinished(session, current.assistant, current.stopped);
        // 计划模式的最终计划默认落盘 <工作区>/.cadt/plan/：对话区只留一张入口卡，
        // 正文去标签页看（计划不再整段铺进对话）。写盘是异步副作用，不拖住收尾。
        if (session && !current.stopped && current.assistant.status === 'done') {
            const planTarget = markPlanFile(current.assistant, session);
            if (planTarget) {
                writePlanFile(planTarget).catch((e) => {
                    current.assistant.planFile = '';
                    if (wasViewed && isOpen()) renderMessages(true);
                    flash('计划文件写入失败：' + ((e && e.message) || e), true);
                });
            }
        }
        const shouldFlush = queueMod.hasInterject(current.sessionId) || (!current.stopped && current.assistant.status === 'done');
        queueMod.clearInterject(current.sessionId);
        detachStream(current);
        if (!anyStreaming()) {
            stopProcessTicker();
        }
        // 本轮文件改动汇总卡（Qoder 风格）：在落盘前追加，保证重放后仍显示
        appendChangesSummary(session, current.changesMark);
        // 用户在别的会话或面板关着时结束：条目上留一个「已完成未查看」，切回来（或打开面板）才清掉。
        if (session && !current.stopped && (!wasViewed || !isOpen())) {
            if (current.assistant.status === 'done') setSessionUnread(session, 'done');
            else if (current.assistant.status === 'error') setSessionUnread(session, 'error');
        }
        persistSessions();
        renderSessionList();
        queueLogSave(session);
        if (session) maybeAutoTitle(session);
        if (session && wasViewed && isOpen()) {
            // 正在看的这一轮结束了才重建消息区；后台会话只更新列表与未读标记。
            renderMessages(true);
        }
        if (wasViewed) {
            setStreamingUI();
            updateContextCount();
            // 本轮发送时的提示词含当次附件；结束后按下一轮重新估算（附件已清空）。
            refreshSystemPromptEstimate(true);
            updateScrollButton();
            updateComposerTakeover(true);
        }
        if (shouldFlush) {
            if (session) flushMessageQueue(session.id);
            const viewing = currentSession();
            if (viewing && (!session || viewing.id !== session.id)) flushMessageQueue(viewing.id);
        }
        // 消费点 2（§4.4 时机 3）：流已注销，残余通知交给空闲唤醒——目标此时空闲就起新一轮，
        // 否则按忙排队。放在消息队列冲刷之后，保证「用户排队消息优先于后台通知」。
        if (session) flushAgentNotices(session.id);
        // 一轮结束后检查上下文预算：超阈值则自动压缩（不打断生成，此处已无 stream）。
        if (session && !current.stopped && current.assistant.status === 'done') {
            autoCompactCount.delete(session.id);
            setTimeout(() => {
                if (!anyStreaming() && !oneShot && !currentQueueItems().length) maybeAutoCompact(session);
            }, 0);
        }
    }

    function toolArgsErrorText(name, raw) {
        const snippet = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, 240);
        return '工具调用参数不是合法 JSON，本次「' + (name || '工具') + '」未执行。' +
            '请重新发起调用，并输出完整、合法的 JSON 参数。' +
            (snippet ? '\n原始参数片段：' + snippet : '');
    }

    async function handleToolRound(s, calls, argErrors) {
        if (streams.get(s.sessionId) !== s) return;
        const session = sessionById(s.sessionId);
        if (!session) {
            finishStream(s);
            return;
        }
        commitThinkTime(s);
        persistSessions();
        const requestingAssistant = s.assistant;
        const toolStartedAt = Date.now();
        let toolTimingSaved = false;
        const saveToolTiming = () => {
            if (toolTimingSaved) return;
            toolTimingSaved = true;
            stopToolHeartbeat();
            if (!requestingAssistant) return;
            requestingAssistant.toolMs = (Number(requestingAssistant.toolMs) || 0) + Math.max(0, Date.now() - toolStartedAt);
            persistSessions();
        };
        // 工具执行/等待用户输入期间没有网络数据，Go 侧 120s 空闲看门狗会误杀挂起的流
        // （ask_user 回答慢必触发）。心跳定期重置看门狗，直到工具循环结束。
        let toolHeartbeat = 0;
        const startToolHeartbeat = () => {
            if (toolHeartbeat || !backend.AITouchStream) return;
            toolHeartbeat = setInterval(() => {
                if (streams.get(s.sessionId) !== s) {
                    stopToolHeartbeat();
                    return;
                }
                try {
                    if (backend.AITouchStream) backend.AITouchStream(s.sessionId);
                } catch (e) {}
            }, 45000);
        };
        const stopToolHeartbeat = () => {
            if (toolHeartbeat) {
                clearInterval(toolHeartbeat);
                toolHeartbeat = 0;
            }
        };
        startToolHeartbeat();
        const allowedTools = new Set((s.tools || toolsForScope(s.scope, s.plan)).map((tool) => tool.name));
        for (const call of calls) {
            if (streams.get(s.sessionId) !== s || s.stopped) {
                saveToolTiming();
                return;
            }
            const toolMessage = {
                role: 'tool',
                toolCallId: call.id,
                name: call.name,
                arguments: call.arguments,
                content: '',
                status: 'running',
                ts: Date.now(),
            };
            session.messages.push(toolMessage);
            if (isOpen() && currentSession() === session) appendToolCard(session, toolMessage);
            // 参数彻底无法修复：不执行工具，把错误作为工具结果回给模型，让它重新发起调用。
            const invalidArgs = argErrors && argErrors.get(call.id);
            if (invalidArgs) {
                toolMessage.status = 'error';
                toolMessage.content = invalidArgs;
                // 操作留痕：参数非法未执行。
                logActivity('ai.tool', call.name + ' ' + toolArgsSummary(call.arguments), {status: 'error', ms: 0, error: invalidArgs.slice(0, 120)});
                persistSessions();
                refreshToolWrap(session, toolMessage);
                continue;
            }
            const toolExecStart = Date.now();
            let result = null;
            try {
                if (!allowedTools.has(call.name)) throw new Error('当前范围不允许工具：' + call.name);
                const parsed = call.arguments ? JSON.parse(call.arguments) : {};
                result = await executeTool(call.name, parsed, {session, toolMessage, stream: s});
            } catch (e) {
                if (streams.get(s.sessionId) === s) {
                    toolMessage.status = 'error';
                    toolMessage.content = '工具执行失败：' + redactToolText((e && e.message) || e, session);
                    if (call.name === 'spawn_agent' && toolMessage.agent && toolMessage.agent.state === 'running') {
                        toolMessage.agent.state = 'error';
                        toolMessage.agent.summary = '子代理启动失败：' + redactToolText((e && e.message) || e, session);
                    }
                }
            }
            if (streams.get(s.sessionId) !== s || s.stopped) {
                saveToolTiming();
                settleInterruptedTool(session, toolMessage);
                return;
            }
            if (result != null) {
                toolMessage.status = 'done';
                toolMessage.content = String(result);
            }
            // 操作留痕：工具执行摘要（不记返回正文；命令沿用审批展示口径截 120 字）。
            logActivity('ai.tool', call.name + ' ' + toolArgsSummary(call.arguments), {
                status: toolMessage.status === 'error' ? 'error' : 'done',
                ms: Math.max(0, Date.now() - toolExecStart),
                error: toolMessage.status === 'error' ? String(toolMessage.content || '').slice(0, 120) : undefined,
            });
            persistSessions();
            refreshToolWrap(session, toolMessage);
        }
        if (streams.get(s.sessionId) !== s || s.stopped) {
            saveToolTiming();
            return;
        }
        // 工具批次全部结束才挂 read_image / 生图 review 的图片消息：批次中途 push 会插在
        // assistant(tool_calls) 与 tool 结果之间，整轮请求会被服务商拒收。
        flushToolImages(session);
        // 轮末清单同步提醒（系统提示里的 <task_todos> 是轮开始快照，长工具链中模型对
        // 被动提醒依从性低——在离行动点最近的地方（收尾请求前）再催一次；systemNote
        // 会随 buildApiMessages 进入收尾请求）。清单全完成不催；文案与节流是 ai-todos.js
        // 的纯函数（todosCheckText / shouldSendTodosCheck），口径与 <task_todos> 对齐。
        const todosAll = Array.isArray(session.todos) ? session.todos : [];
        if (todosAll.some((t) => t.status !== 'completed')) {
            const turnStart = turnStartAt(session, session.messages.length - 1) || toolStartedAt;
            const turnToolNames = session.messages
                .filter((m) => m.role === 'tool' && (Number(m.ts) || 0) >= turnStart)
                .map((m) => m.name);
            let lastCheckText = '';
            for (let i = session.messages.length - 1; i >= 0; i--) {
                if (session.messages[i].dedupeKey === 'task_todos_check') {
                    lastCheckText = String(session.messages[i].content || '');
                    break;
                }
            }
            const checkText = todosCheckText(todosAll);
            if (shouldSendTodosCheck({text: checkText, lastText: lastCheckText, toolNames: turnToolNames})) {
                session.messages.push({
                    role: 'user',
                    content: checkText,
                    systemNote: true,
                    silent: true, // 给模型的机械提醒，不在消息流里渲染（纯噪音）
                    dedupeKey: 'task_todos_check', // 瞬态注入：发请求时同类只保留最新一条
                    ts: Date.now(),
                });
                persistSessions();
            }
        }
        // 消费点 1（§4.4 时机 1）：工具轮边界把信箱里的通知折叠成 user 消息，随收尾请求进入
        // 上下文——此刻流还在跑，不能起新轮，所以只折叠不唤醒。
        foldAgentNotices(session.id);
        // 轮次轻提醒统一在 startRound 注入；工具循环不再有硬性上限。
        const profile = profileOf(session);
        const assistant = newAssistantMessage(profile, entryOf(session));
        assistant.planMode = !!s.plan;
        session.messages.push(assistant);
        s.assistant = assistant;
        s.thinkStartedAt = 0;
        if (isOpen() && currentSession() === session) {
            renderMessages(true);
            setStreamingUI();
        }
        saveToolTiming();
        startRound(s);
    }

    // 请求重试提示：显示在流式状态条内（429/5xx/网络错误指数退避时），收到数据后清除
    function clearRetryNote() {
        const note = el.messages && el.messages.querySelector('.ai-retry-note');
        if (note) note.remove();
    }

    // 本地限流排队提示。必须显示：排队发生在 Go 侧 goroutine 里，前端在这段时间收不到
    // 任何流，不提示的话用户看到的是纯空转——比 429 更像卡死。waitMs=0 是「已放行」的
    // 清除信号（Go 侧发完请求后补发一次）。
    function showQueueNote(payload) {
        const waitMs = Math.max(0, Number(payload && payload.waitMs) || 0);
        if (waitMs <= 0) {
            clearQueueNote();
            return;
        }
        const bar = el.messages && el.messages.querySelector('.ai-streaming-bar');
        if (!bar) return;
        let note = bar.querySelector('.ai-queue-note');
        if (!note) {
            note = document.createElement('span');
            note.className = 'ai-queue-note';
            const icon = document.createElement('span');
            icon.className = 'ai-queue-icon';
            icon.innerHTML = iconSvg('refresh', 11);
            note.append(icon);
            const timer = bar.querySelector('.ai-process-timer');
            bar.insertBefore(note, timer || null);
        }
        note.dataset.waitMs = String(waitMs);
        const label = note.querySelector('.ai-queue-text') || document.createElement('span');
        label.className = 'ai-queue-text';
        label.textContent = (String((payload && payload.reason) || '').trim() || '排队中')
            + ' · 约 ' + (waitMs / 1000).toFixed(1) + ' 秒';
        if (!label.parentNode) note.append(label);
    }

    function clearQueueNote() {
        const note = el.messages && el.messages.querySelector('.ai-queue-note');
        if (note) note.remove();
    }

    // 重试倒计时原位刷新：note.dataset.retryAt 记录到点时刻，表针每 100ms 重写剩余秒数
    function tickRetryNote(bar) {
        const note = bar.querySelector('.ai-retry-note');
        if (!note) return;
        const retryAt = Number(note.dataset.retryAt) || 0;
        if (!retryAt) return;
        const remain = Math.max(0, (retryAt - Date.now()) / 1000);
        const label = note.querySelector('.ai-retry-text');
        if (label) label.textContent = (note.dataset.reason || '请求失败') + ' · ' + remain.toFixed(1) + ' 秒后重试 ' + (note.dataset.attempt || 1) + '/' + (note.dataset.max || 1);
    }

    function showRetryNote(payload) {
        const bar = el.messages && el.messages.querySelector('.ai-streaming-bar');
        if (!bar) return;
        let note = bar.querySelector('.ai-retry-note');
        if (!note) {
            note = document.createElement('span');
            note.className = 'ai-retry-note';
            const icon = document.createElement('span');
            icon.className = 'ai-retry-icon';
            icon.innerHTML = iconSvg('refresh', 11);
            note.append(icon);
            const timer = bar.querySelector('.ai-process-timer');
            bar.insertBefore(note, timer || null);
        }
        const attempt = Math.max(1, Math.round(Number(payload && payload.attempt) || 1));
        const max = Math.max(1, Math.round(Number(payload && payload.max) || 1));
        const delayMs = Math.max(0, Number(payload && payload.delayMs) || 0);
        const reason = String((payload && payload.reason) || '').trim() || '请求失败';
        note.dataset.reason = reason;
        note.dataset.attempt = String(attempt);
        note.dataset.max = String(max);
        note.dataset.retryAt = String(Date.now() + delayMs);
        const label = note.querySelector('.ai-retry-text') || document.createElement('span');
        label.className = 'ai-retry-text';
        label.textContent = reason + ' · ' + (delayMs / 1000).toFixed(1) + ' 秒后重试 ' + attempt + '/' + max;
        if (!label.parentNode) note.append(label);
    }

    // 服务端参数校验给出上限时（如 max_tokens 超模型上限），Go 侧已自动收敛并重试一次；
    // 这里给出可见提示，并把本轮实际使用的模型条目的输出窗口回写，避免下次继续触雷。
    function handleParamAdjust(current, payload, onScreen) {
        const message = String((payload && payload.message) || '').trim()
            || '模型参数超出服务端上限，已自动调整并重试';
        const model = String((payload && payload.model) || '').trim();
        const entry = current && current.modelEntry;
        const editorOpen = !!(el.modelEditor && !el.modelEditor.classList.contains('hidden'));
        // 编辑器开着时用户可能有在途输入，别把旧值写回去覆盖编辑；条目被删掉同理。
        const linked = entry && entry.model === model &&
            config.profiles.some((p) => Array.isArray(p.models) && p.models.includes(entry));
        const saved = !editorOpen && !!linked && applyOutputWindowLimit(entry, payload && payload.value);
        if (saved) {
            saveAIConfig();
            refreshSettingsPane();
            refreshChatSettings();
        }
        const text = saved
            ? message + '；设置里该模型的「最大输出」已更新。'
            : message + '（设置未改动，可在模型设置里手动调整「最大输出」）';
        flash(text);
        if (onScreen) showNote(text);
    }

    // ---------- 思考循环守卫 ----------

    function loopGuardStatsText(stats) {
        return '同一句已重复 ' + stats.maxRepeat + ' 次，最近 ' + stats.lines +
            ' 行里只有 ' + stats.uniq + ' 个不同行。';
    }

    function loopGuardRecord(stats, state) {
        return {
            state,
            repeats: stats.maxRepeat,
            ratio: stats.ratio,
            chars: stats.chars,
            lines: stats.lines,
            detectedAt: Date.now(),
        };
    }

    function requestLoopGuardTakeover(s, assistant, stats, onScreen) {
        let request = null;
        try {
            request = systemTakeoverHost.request({
                key: 'loop:' + s.roundId,
                kind: 'loop-guard',
                sessionId: s.sessionId,
                priority: 100,
                title: '检测到思考循环',
                detail: loopGuardStatsText(stats),
                meta: LOOP_GUARD_TIMEOUT_SEC + ' 秒内未选择将停止本轮；继续观察后 2 分钟内仍重复也会自动停止。',
                actions: [
                    {value: 'stop', label: '停止本轮', default: true, tone: 'danger'},
                    {value: 'continue', label: '继续观察'},
                ],
                timeoutSec: LOOP_GUARD_TIMEOUT_SEC,
                timeoutValue: 'stop',
            });
        } catch (e) {
            // key 冲突等异常不能打断流：退化为静默提示，交给超时 / 用户手动停止。
            noteForSession(s.sessionId, '思考循环守卫启动失败：' + ((e && e.message) || e), true);
            return;
        }
        assistant.guard = Object.assign(loopGuardRecord(stats, 'pending'), {key: request.key});
        persistSessions();
        if (onScreen) {
            updateComposerTakeover(true);
            scheduleStreamRender(s);
        } else {
            const session = sessionById(s.sessionId);
            notifyDesktop({
                kind: 'error',
                title: '检测到思考循环',
                body: (session && session.title || '会话') + ' · ' + loopGuardStatsText(stats) +
                    LOOP_GUARD_TIMEOUT_SEC + ' 秒未确认将停止本轮',
                sessionId: s.sessionId,
            });
        }
        request.done.then((outcome) => applyLoopGuardOutcome(s, assistant, outcome));
    }

    function applyLoopGuardOutcome(s, assistant, outcome) {
        const guard = assistant && assistant.guard;
        if (!guard || guard.state !== 'pending') return;
        const answeredAt = Date.now();
        if (outcome.source === 'cancelled') {
            assistant.guard = Object.assign({}, guard, {
                state: outcome.reason === 'stream-ended' ? 'ended' : 'cancelled',
                action: '',
                source: outcome.reason || 'cancelled',
                answeredAt,
            });
            persistSessions();
            if (isOpen() && currentSession() && currentSession().id === s.sessionId) scheduleStreamRender(s);
            return;
        }
        if (outcome.value === 'continue') {
            assistant.guard = Object.assign({}, guard, {
                state: 'continued',
                action: 'continue',
                source: outcome.source,
                answeredAt,
            });
            s.loopGuardDisarmedUntil = answeredAt + LOOP_GUARD_RECHECK_MS;
            persistSessions();
            noteForSession(s.sessionId, '已继续观察；2 分钟后仍在重复思考将自动停止本轮');
            if (isOpen() && currentSession() && currentSession().id === s.sessionId) scheduleStreamRender(s);
            return;
        }
        assistant.guard = Object.assign({}, guard, {
            state: 'stopped',
            action: 'stop',
            source: outcome.source,
            answeredAt,
        });
        persistSessions();
        noteForSession(s.sessionId, outcome.source === 'timeout'
            ? '思考循环：' + LOOP_GUARD_TIMEOUT_SEC + ' 秒未确认，已停止本轮'
            : '思考循环：已停止本轮', true);
        if (!s.finished) stopGeneration(s);
    }

    // 流 / 轮结束时收掉待确认卡：结果只落 guard.state，不影响已完成的这一轮。
    function cancelLoopGuardPrompt(s, reason) {
        const guard = s && s.assistant && s.assistant.guard;
        if (!guard || guard.state !== 'pending' || !guard.key) return;
        systemTakeoverHost.cancel(guard.key, reason);
    }

    function handleThinkLoopGuard(s, delta, onScreen) {
        if (!s.loopGuard) s.loopGuard = createLoopGuard();
        s.loopGuard.push(delta);
        const assistant = s.assistant;
        // 迟到增量 / 已停止 / 已收尾：不再对旧消息挂新卡。
        if (!assistant || s.stopped || assistant.status !== 'streaming') return;
        const level = s.loopGuard.verdict();
        if (!level) return;
        const stats = s.loopGuard.stats();
        const guard = assistant.guard;
        if (level === 'warn') {
            if (!guard) {
                assistant.guard = loopGuardRecord(stats, 'warned');
                persistSessions();
                if (onScreen) scheduleStreamRender(s);
            }
            return;
        }
        if (guard && (guard.state === 'pending' || guard.state === 'stopped')) return;
        if (guard && guard.state === 'continued') {
            const until = Number(s.loopGuardDisarmedUntil) || 0;
            if (Date.now() < until) return;
            assistant.guard = Object.assign({}, guard, {
                state: 'stopped',
                action: 'stop',
                source: 'recheck',
                answeredAt: Date.now(),
            });
            persistSessions();
            noteForSession(s.sessionId, '思考循环：继续观察后仍在重复，已自动停止本轮', true);
            if (!s.finished) stopGeneration(s);
            return;
        }
        requestLoopGuardTakeover(s, assistant, stats, onScreen);
    }

    function handleEvent(name, payload) {
        // 降档事件若来自分类器 / 标题 / 子代理等非会话流，下面的 roundId 路由找不到宿主；
        // 至少给一条状态栏提示（自动降档与重试已在 Go 侧完成，非会话流不回写配置）。
        if (name === 'ai-param-adjust' && payload && payload.id) {
            let routed = false;
            for (const candidate of streams.values()) {
                if (candidate.roundId === payload.id) { routed = true; break; }
            }
            if (!routed) {
                flash(String(payload.message || '模型参数超出服务端上限，已自动调整并重试'));
                return;
            }
        }
        if (classifierJob && payload && payload.id === classifierJob.id) {
            const job = classifierJob;
            if (name === 'ai-chunk' && payload.delta) job.buffer += payload.delta;
            else if (name === 'ai-think' && payload.delta) job.think += payload.delta;
            else if (name === 'ai-done') {
                let verdict = parseClassifierVerdict(job.buffer);
                if (!job.buffer) {
                    const finish = aiTextOf(payload.finishReason) || 'unknown';
                    // 思考型模型会把 512 预算全烧在 reasoning_content 上（中文思考 1200 字
                    // 就超预算，部分兼容网预算耗尽还报 finish=stop），正文一个 delta 都没有。
                    // 兜底：从思考文本提取判定——parseClassifierVerdict 对长段落里的 allow
                    // 字样 fail-closed，只有思考里落了完整 JSON / 结尾短答才认。
                    const fromThink = job.think ? parseClassifierVerdict(job.think) : null;
                    if (fromThink && (fromThink.allow || fromThink.reason === '分类器建议人工确认') && fromThink.reason !== '分类器输出为空') {
                        console.info('[classifier] 正文为空（finish=' + finish + ' thinkChars=' + job.think.length + '），从思考链提取判定：'
                            + (fromThink.allow ? 'allow' : 'ask'));
                        verdict = fromThink;
                    } else {
                        verdict.reason = job.think
                            ? '分类器输出为空：模型思考 ' + job.think.length + ' 字后预算耗尽（finish=' + finish + '），正文未产出'
                            : '分类器输出为空（finish=' + finish + '）';
                        console.info('[classifier] 空输出 finish=' + finish + ' thinkChars=' + job.think.length);
                    }
                }
                resolveClassifierJob(job, verdict);
                // 云端蒸馏：端侧向大模型的判定学习（开启个性化学习且线性模型参与时）。
                // 只学模型结论，不学用户的允许 / 拒绝——审批是一次性授权语境，回流会把
                // 临时授权学成永久放行（用户 2026-11-14 设计修正）。
                // 门禁（红队链A）：只在「端侧转险复核 + 云端放行」的**分歧**场景蒸馏
                // （线性误报修正）；两端一致 ask 无信息量，端侧未参与判定时无对照，都不学。
                if (config.localClassifierPersonalize === true
                    && config.localClassifierEnabled === true && config.localClassifierLinear !== 'off'
                    && job.localReviewed && verdict.allow && job.command) {
                    Promise.resolve(localClassifierMod.recordDecision(job.command, true, {source: 'cloud'}))
                        .catch(() => {});
                }
            }
            else if (name === 'ai-error') resolveClassifierJob(job, {allow: false, reason: '分类器请求失败'});
            return;
        }
        if (titleJob && payload && payload.id === titleJob.id) {
            if (name === 'ai-chunk' && payload.delta) titleJob.buffer += payload.delta;
            else if (name === 'ai-done') finishTitleJob();
            else if (name === 'ai-error') {
                titleJob = null;
                drainTitleQueue();
            }
            return;
        }
        if (oneShot && payload && payload.id === oneShot.id) {
            if (name === 'ai-chunk' && payload.delta) {
                oneShot.buffer += payload.delta;
                const viewing = currentSession();
                if (el.hint && viewing && viewing.id === oneShot.sessionId) {
                    el.hint.textContent = '正在压缩上下文… 已生成 ' + oneShot.buffer.length + ' 字符';
                }
            } else if (name === 'ai-done') {
                finishCompact(payload);
            } else if (name === 'ai-error') {
                const message = String(payload.message || '请求失败');
                const compactedId = oneShot.sessionId;
                const viewed = !!(currentSession() && currentSession().id === compactedId);
                oneShot = null;
                setStreamingUI();
                updateSendState();
                if (viewed) showNote('压缩失败：' + message, true);
            }
            return;
        }
        // 子代理压缩事件：**必须先于 subAgents 分支**（§4.10.1）。压缩 roundId 是
        // `subId#compact-…`，落到 handleSubEvent 会因 roundId 不匹配被静默丢弃。
        if (payload && payload.id) {
            const compactJob = subCompacts.get(String(payload.id));
            if (compactJob) {
                handleSubCompactEvent(name, payload, compactJob);
                return;
            }
        }
        // 子代理事件按轮次 id 前缀路由（子会话 id 独立，不查主 stream）
        if (payload && payload.id) {
            const sub = subAgents.get(String(payload.id).split('#')[0]);
            if (sub) {
                handleSubEvent(name, payload, sub);
                return;
            }
        }
        if (!payload || !payload.id) return;
        // 按轮次 id 精确路由到所属会话的流：多会话并发生成时各走各的，互不抢事件。
        let current = null;
        for (const candidate of streams.values()) {
            if (candidate.roundId === payload.id) {
                current = candidate;
                break;
            }
        }
        if (!current) return;
        // 只更新「当前查看会话」可见的流式状态条 / 提示条
        const onScreen = !!(currentSession() && currentSession().id === current.sessionId);
        switch (name) {
            case 'ai-retry': {
                if (onScreen) showRetryNote(payload);
                break;
            }
            case 'ai-queue': {
                if (onScreen) showQueueNote(payload);
                break;
            }
            case 'ai-param-adjust': {
                handleParamAdjust(current, payload, onScreen);
                break;
            }
            case 'ai-chunk':
                if (payload.delta) {
                    if (onScreen) { clearRetryNote(); clearQueueNote(); }
                    markFirstToken(current);
                    current.assistant.content += payload.delta;
                    scheduleStreamRender(current);
                }
                break;
            case 'ai-think':
                if (payload.delta) {
                    if (onScreen) { clearRetryNote(); clearQueueNote(); }
                    markFirstToken(current);
                    if (!current.thinkStartedAt) current.thinkStartedAt = Date.now();
                    current.assistant.reasoning += payload.delta;
                    handleThinkLoopGuard(current, payload.delta, onScreen);
                    scheduleStreamRender(current);
                }
                break;
            case 'ai-toolcall': {
                markFirstToken(current);
                const index = Number(payload.index) || 0;
                let call = current.toolCalls.get(index);
                if (!call) {
                    call = {id: '', name: '', arguments: ''};
                    current.toolCalls.set(index, call);
                }
                if (payload.callId) call.id = payload.callId;
                if (payload.name) call.name = payload.name;
                if (payload.argsDelta) call.arguments += payload.argsDelta;
                // 流式期间就把工具调用亮出来（写大文件时不再像卡住，参数增量可见）
                if (call.name) scheduleStreamRender(current);
                break;
            }
            case 'ai-done': {
                if (onScreen) { clearRetryNote(); clearQueueNote(); }
                // 本轮思考已结束：挂起的循环确认卡没有继续等待的意义。
                cancelLoopGuardPrompt(current, 'round-ended');
                if (current.renderTimer) {
                    clearTimeout(current.renderTimer);
                    current.renderTimer = 0;
                }
                commitRoundTiming(current);
                if (payload.thinkingSignature) current.assistant.thinkingSignature = payload.thinkingSignature;
                if (payload.usage) current.assistant.usage = payload.usage;
                if (payload.finishReason === 'stopped') {
                    current.assistant.status = 'stopped';
                    finishStream(current);
                    return;
                }
                const argErrors = new Map();
                const calls = [...current.toolCalls.values()]
                    .filter((call) => call.name)
                    .map((call, index) => {
                        const check = inspectToolArguments(call.arguments);
                        const id = call.id || ('call_' + current.roundNo + '_' + index);
                        if (!check.valid && !check.repaired) {
                            argErrors.set(id, toolArgsErrorText(call.name, call.arguments));
                        }
                        return {id, name: call.name, arguments: check.text};
                    });
                if (payload.finishReason === 'tool' && calls.length) {
                    current.assistant.status = 'done';
                    current.assistant.toolCalls = calls;
                    const session = sessionById(current.sessionId);
                    const idx = session ? session.messages.indexOf(current.assistant) : -1;
                    const wrap = idx >= 0 && onScreen ? el.messages.querySelector('.ai-msg.assistant[data-ai-idx="' + idx + '"]') : null;
                    if (wrap) updateAssistantElement(wrap, current.assistant, false);
                    handleToolRound(current, calls, argErrors);
                    return;
                }
                // 空回复兜底：模型偶发返回 finishReason=stop 且无任何内容（ask_user 回答后
                // 的续轮尤其常见）。移除空 assistant 自动重试一轮，而不是静默「已完成」。
                if (payload.finishReason === 'stop' && !calls.length &&
                    !String(current.assistant.content || '').trim() &&
                    !String(current.assistant.reasoning || '').trim() &&
                    !current.emptyRetried) {
                    const session = sessionById(current.sessionId);
                    if (session) {
                        const idx = session.messages.indexOf(current.assistant);
                        if (idx >= 0) session.messages.splice(idx, 1);
                        const profile = profileOf(session);
                        const assistant = newAssistantMessage(profile, entryOf(session));
                        session.messages.push(assistant);
                        current.assistant = assistant;
                        current.emptyRetried = true;
                        current.thinkStartedAt = 0;
                        current.firstTokenAt = 0;
                        current.roundStartedAt = Date.now();
                        if (onScreen) showNote('模型返回了空回复，已自动重试…');
                        persistSessions();
                        if (isOpen() && currentSession() === session) renderMessages(true);
                        setStreamingUI();
                        startRound(current);
                        return;
                    }
                }
                current.assistant.status = 'done';
                finishStream(current);
                break;
            }
            case 'ai-error':
                if (onScreen) { clearRetryNote(); clearQueueNote(); }
                finishStreamError(payload.message || '请求失败', current);
                break;
            default:
                break;
        }
    }

    // 用户按下停止后，卡片可能仍被「迟到」的审批 / 分类器回调点亮回 running：
    // markCommandAutoApproved / decideApproval 都在 await 之后才执行，无条件写 status='running'
    // 会把终止态盖掉——头部「已停止」+ spinner 继续转 + 正文「正在执行命令…」同框的自相矛盾卡片。
    // 一旦 interrupted 落地，任何回调都只许收口，不许复活；渲染侧同口径见 ai-tool-cards.toolIsLive。
    function toolHalted(toolMessage) {
        return !!(toolMessage && toolMessage.interrupted);
    }

    // 停止后仍然落地的工具消息收口：stopRunningToolMessages 只扫「停止那一刻在跑」的消息，
    // 若 status 被迟到回调改回 running，结算分支又因 s.stopped 直接 return，卡片就永久停在
    // 「执行中」+ spinner（用户看到的就是「已停止但还在转」）。这里补最后一道收口。
    function settleInterruptedTool(session, toolMessage) {
        if (!toolMessage || toolMessage.status !== 'running') return;
        toolMessage.status = 'error';
        toolMessage.interrupted = true;
        toolMessage.content = '用户已停止生成';
        try { refreshToolWrap(session, toolMessage); } catch (e) {}
        persistSessions();
    }

    // 终止一个会话里所有运行中的工具卡：run_command 按 runId 杀进程（AIStopShellRun），
    // 其余标 error + interrupted（spawn_agent 由 stopSubAgentsOf 管理、后台命令有意跨会话存活，均跳过）。
    function stopRunningToolMessages(sessionId, reason) {
        const session = sessionById(sessionId);
        if (!session) return;
        for (const message of session.messages) {
            if (message.role !== 'tool' || message.status !== 'running') continue;
            if (message.name === 'spawn_agent' || message.name === 'background_command') continue;
            if (message.runId && backend.AIStopShellRun) {
                try { backend.AIStopShellRun(message.runId); } catch (e) {}
            }
            message.status = 'error';
            message.error = reason || '用户已停止';
            message.content = reason || '用户已停止';
            message.interrupted = true;
            refreshToolWrap(session, message);
        }
        persistSessions();
    }

    function stopGeneration(target) {
        const current = target || syncStreamView();
        if (!current) {
            const viewing = currentSession();
            if (compactOf(viewing && viewing.id)) cancelOneShot();
            return;
        }
        const sessionId = current.sessionId;
        current.stopped = true;
        stopSubAgentsOf(sessionId);
        // 排队的 / 在飞的自动审批分类请求也一并撤销：工具会转人工确认，不会白等 12 秒
        cancelClassifierJobs(sessionId);
        cancelPendingApprovals('用户已停止生成，写操作已取消', sessionId);
        cancelPendingAsks('用户已停止生成，问题未回答', sessionId);
        cancelPendingEnvCreations('用户已停止生成，变量创建已取消', sessionId);
        // 用户主动停止（或守卫自身结算后的收尾）：挂起的系统接管一并取消。
        systemTakeoverHost.cancelBySession(sessionId, '已停止生成');
        try {
            if (backend.AIStop) backend.AIStop(sessionId);
        } catch (e) {}
        // 运行中的工具卡立即终止（不等命令自然跑完）：run_command 按 runId 杀进程树，
        // 其余标「中断」——此前只在兜底循环里处理且被流守卫挡住，命令卡会一直转圈显示运行中
        stopRunningToolMessages(sessionId, '用户已停止生成');
        // 后端若没有及时回 ai-done，兜底结束，避免界面一直卡在“生成中”。
        setTimeout(() => {
            if (streams.get(sessionId) !== current) return;
            const session = sessionById(sessionId);
            if (session) {
                for (const message of session.messages) {
                    if (message.role === 'tool' && message.status === 'running') {
                        // interrupted 一并落：只改 status 的话头部徽标会按 status==='error' 显示
                        // 「已执行/已应用」，与前一步刚打上的终止语义不一致。
                        message.status = 'error';
                        message.interrupted = true;
                        message.content = '用户已停止';
                    }
                }
            }
            if (current.assistant.status === 'streaming') current.assistant.status = 'stopped';
            if (session && currentSession() === session) renderMessages(true);
            finishStream(current);
        }, 1200);
    }

    // ---------- 范围与附加内容 ----------

    let editHintShown = new Set();

    function currentScope() {
        return currentScopeOf(currentSession());
    }

    function scopeLabel(scope) {
        if (scope === 'full') return '完全权限';
        if (scope === 'auto') return '自动审批';
        if (scope === 'edit') return '每次询问';
        return '只读访问';
    }

    function scopeDescription(scope) {
        if (scope === 'full') return '不再询问，可自由访问你的文件、终端和网络';
        if (scope === 'auto') return '仅在检测到潜在风险时询问';
        if (scope === 'edit') return '执行命令、修改工作区文件前，始终询问';
        return '只能查看文件与页面，不执行修改';
    }

    function updateScopeUI() {
        const session = currentSession();
        if (el.permission) {
            const scope = currentScope();
            el.permission.textContent = scopeLabel(scope);
            const root = getScopeRoot() || '';
            el.permission.dataset.tip = '权限：' + scopeLabel(scope) + '（' + scopeDescription(scope) + '）\n' + (root ? '范围根：' + root : '未打开工作区');
            el.permission.classList.toggle('active', scope === 'auto' || scope === 'full');
        }
        if (el.plan) {
            const plan = !!(session && session.planMode);
            el.plan.classList.toggle('active', plan);
            el.plan.setAttribute('aria-pressed', String(plan));
            el.plan.textContent = plan ? '计划 · 开' : '计划';
            el.plan.dataset.tip = plan
                ? '计划模式已开启：AI 只读探索并给出计划，批准后再执行'
                : '计划模式：先只读探索并给出计划，批准后执行';
        }
    }

    function applyScope(scope) {
        const session = currentSession();
        if (!session) return;
        session.scope = scope;
        persistSessions();
        updateScopeUI();
        updateSendState();
        if (scope !== 'full' && !getScopeRoot()) {
            showNote('当前没有工作区范围：请先打开文件或文件夹，工具才能执行。', true);
        }
        if (scope === 'edit' && !editHintShown.has(session.id)) {
            editHintShown.add(session.id);
            flash('已切换为「每次询问」：AI 写文件前会显示 diff、执行命令前会请求确认');
        }
        if (scope === 'auto' && !editHintShown.has('auto-' + session.id)) {
            editHintShown.add('auto-' + session.id);
            flash('已启用「自动审批」：工作区写操作自动应用，低风险命令自动执行，风险操作仍会询问');
        }
        if (scope === 'full' && !editHintShown.has('full-' + session.id)) {
            editHintShown.add('full-' + session.id);
            flash('已启用「完全权限」：写操作与终端命令不再审批，且可访问工作区外路径');
        }
    }

    function confirmFullPermission(onConfirm) {
        const intro = dialogNode('div', 'ai-perm-intro',
            '开启后，AI 可以在当前设备上直接执行高权限操作，包括文件处理、命令执行和联网访问。主要范围包括：');
        const list = dialogNode('div', 'ai-perm-list');
        const rows = [
            {icon: 'folder', title: '文件和文件夹', desc: '查看、新建、更新、上传或移除设备上的文件与文件夹'},
            {icon: 'terminal', title: '终端命令', desc: '执行终端命令、安装依赖，并调整必要的系统配置'},
            {icon: 'globe', title: '互联网和已连接的应用', desc: '打开网页、传输数据，并调用你已启用的插件或连接应用'},
        ];
        for (const item of rows) {
            const row = dialogNode('div', 'ai-perm-row');
            const icon = dialogNode('span', 'ai-perm-row-icon');
            icon.innerHTML = iconSvg(item.icon, 18);
            const text = dialogNode('div', 'ai-perm-row-text');
            text.append(
                dialogNode('div', 'ai-perm-row-title', item.title),
                dialogNode('div', 'ai-perm-row-desc', item.desc),
            );
            row.append(icon, text);
            list.appendChild(row);
        }
        const note = dialogNode('div', 'ai-perm-note',
            '请只在信任当前任务和上下文时开启；该权限可能增加敏感数据暴露、误操作或提示注入风险，可随时关闭。');
        const cancel = dialogButton('取消', 'dlg-btn', closeAIDialog);
        const enable = dialogButton('确认', 'dlg-btn danger', () => {
            closeAIDialog();
            onConfirm();
        });
        openAIDialog('允许 AI 使用完全权限？', [intro, list, note], [cancel, enable]);
        el.dialog.classList.add('ai-permission-dialog');
        if (el.dialogTitle) {
            el.dialogTitle.textContent = '';
            const icon = document.createElement('i');
            icon.className = 'ai-dialog-title-icon';
            icon.innerHTML = iconSvg('warn', 15);
            el.dialogTitle.append(icon, document.createTextNode('允许 AI 使用完全权限？'));
        }
    }

    function setScope(scope) {
        if (!AI_SCOPES.includes(scope)) return;
        const session = currentSession();
        if (!session) return;
        if (scope === 'full') {
            if (currentScopeOf(session) === 'full') return;
            confirmFullPermission(() => applyScope('full'));
            return;
        }
        applyScope(scope);
    }

    function setPlanMode(on, announce, force) {
        const session = currentSession();
        if (!session) return false;
        syncStreamView();
        if ((stream || compactOf(session.id)) && force !== true) {
            if (announce !== false) flash('生成中不能切换计划模式', true);
            return false;
        }
        session.planMode = !!on;
        persistSessions();
        updateScopeUI();
        updateSendState();
        if (!stream) renderMessages(true);
        renderMessageQueue();
        if (announce !== false) {
            flash(session.planMode ? '已开启计划模式：AI 只读探索后给出计划' : '已关闭计划模式');
        }
        return true;
    }

    function togglePlanMode() {
        const session = currentSession();
        if (!session) return;
        setPlanMode(!session.planMode);
        if (el.input) el.input.focus();
    }

    function handlePlanCommand(arg) {
        const value = String(arg || '').trim();
        if (value.toLowerCase() === 'off' || value === '关闭') {
            setPlanMode(false);
            return;
        }
        if (!setPlanMode(true, !value)) return;
        if (value) void submitText(value);
    }

    function showPermissionMenu() {
        if (!el.permission || !showContextMenu) return;
        const rect = el.permission.getBoundingClientRect();
        const scope = currentScope();
        const items = AI_SCOPES.map((value) => ({
            label: scopeLabel(value),
            description: scopeDescription(value),
            icon: value === 'read' ? 'eye' : (value === 'edit' ? 'shield' : (value === 'auto' ? 'zap' : 'warn')),
            selected: scope === value,
            danger: value === 'full',
            // 分类器开启时在「自动审批」旁标注 AI 胶囊，提示该档位会额外请求模型判定
            ...(value === 'auto' && config.autoClassifier === true ? {badge: 'AI'} : {}),
            ...(value === 'auto' && config.localClassifierEnabled === true ? {badgeIcon: 'zap'} : {}),
            action: () => setScope(value),
        }));
        showContextMenu(items, rect.left, rect.top - 280);
    }

    // 思考等级推导统一走数据层 reasoningLevelInfo（单一来源：档位表 / 中文标签 / 徽标 tone）
    function effortLabel(account, entry) {
        if (!account) return '';
        return reasoningLevelInfo(account, entry).label;
    }

    const AI_CHEVRON_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    // 单行模型 chip：图标 + 模型名 + 推理等级 + 展开箭头（不显示「模型 / 推理等级」文字标签）
    function renderModelChip() {
        if (!el.modelChip) return;
        // chip 是「这个会话」的模型，不是窗口默认
        const profile = profileOf(currentSession());
        if (!profile) {
            el.modelChip.textContent = '选择模型';
            return;
        }
        const entry = entryOf(currentSession());
        const model = (entry && entry.model) || profile.name || '未命名模型';
        const effort = effortLabel(profile, entry);
        // 本次会话上下文上限生效中（低于模型窗口）时在等级旁挂一枚档位徽标
        const session = currentSession();
        const baseWindow = (entry && entry.contextWindow) || 128000;
        const capActive = session && session.ctxLimit > 0 && session.ctxLimit < baseWindow ? session.ctxLimit : 0;
        el.modelChip.innerHTML = '';
        const icon = document.createElement('span');
        icon.className = 'ai-model-ico';
        icon.innerHTML = iconSvg('sparkles', 12);
        const name = document.createElement('b');
        name.className = 'ai-model-name';
        name.textContent = model;
        const level = document.createElement('span');
        level.className = 'ai-model-effort';
        level.textContent = effort;
        const chev = document.createElement('span');
        chev.className = 'ai-chip-chev';
        chev.innerHTML = AI_CHEVRON_SVG;
        el.modelChip.append(icon, name, level);
        if (capActive) {
            const cap = document.createElement('span');
            cap.className = 'ai-model-cap';
            cap.textContent = formatTokenAmount(capActive);
            el.modelChip.append(cap);
        }
        el.modelChip.append(chev);
    }

    // 对话内切换模型 / 账号的留痕：切换只在下一条消息发出时生效，
    // 分隔记录也在那一刻落到对话里（不进入模型上下文，重放后仍在）。
    const pendingModelSwitches = new Map();

    function modelSwitchLabel(profile, entry) {
        return (entry && entry.model) || (profile && profile.name) || '';
    }

    function appendModelSwitchNote(session, note) {
        session.messages.push({
            role: 'user',
            kind: 'model-switch',
            systemNote: true,
            content: '模型已从 ' + note.from + ' 更改为 ' + note.to,
            modelNote: {
                from: note.from,
                to: note.to,
                account: note.account || '',
                effort: note.effort || '',
            },
            ts: Date.now(),
            turnStartedAt: 0,
        });
    }

    function recordModelSwitch(fromProfile, fromEntry, toProfile, toEntry) {
        const session = currentSession();
        if (!session || session.archivedAt || session._loadError || !session.messages.length) return;
        const from = modelSwitchLabel(fromProfile, fromEntry);
        const to = modelSwitchLabel(toProfile, toEntry);
        if (!from || !to || from === to) return;
        // 连续多次切换合并成「起点 → 最终选择」；切回起点则不留记录。
        const pending = pendingModelSwitches.get(session.id);
        const note = {
            from: pending ? pending.from : from,
            to,
            account: (toProfile && toProfile.name) || '',
            effort: toProfile ? effortLabel(toProfile, toEntry) : '',
        };
        if (note.from === note.to) pendingModelSwitches.delete(session.id);
        else pendingModelSwitches.set(session.id, note);
    }

    // 发送下一条消息时把挂起的切换记录落进对话（在本条用户消息之前）。
    function flushModelSwitchNote(session) {
        if (!session) return false;
        const note = pendingModelSwitches.get(session.id);
        if (!note) return false;
        pendingModelSwitches.delete(session.id);
        appendModelSwitchNote(session, note);
        return true;
    }

    // 切换账号：恢复该账号记住的模型条目（lastModelId）
    function switchProfile(id) {
        const profile = config.profiles.find((item) => item.id === id);
        if (!profile) return;
        const session = currentSession();
        const prev = sessionModelRef(session);
        const prevProfile = prev.profile;
        const prevEntry = prev.entry;
        const entry = modelEntryOf(profile, profile.lastModelId);
        // 窗口默认（新会话继承）与当前会话的选择一起写
        config.activeProfileId = id;
        config.activeModelId = entry ? entry.id : '';
        pinSessionModel(session, profile, entry);
        saveAIConfig();
        if (session) persistSessions();
        renderProfileSelect();
        refreshSettingsPane();
        updateComposerState();
        renderModelChip();
        closeModelPicker();
        recordModelSwitch(prevProfile, prevEntry, profile, entry);
        if (isOpen()) renderMessages(true);
    }

    // 切换当前账号下的具体模型条目（模型菜单 / 设置页）
    function switchModel(accountId, entryId) {
        const profile = config.profiles.find((item) => item.id === accountId);
        if (!profile) return;
        const entry = (profile.models || []).find((item) => item.id === entryId);
        if (!entry) return;
        const session = currentSession();
        const prev = sessionModelRef(session);
        const prevProfile = prev.profile;
        const prevEntry = prev.entry;
        // 只改当前会话 + 记成窗口默认；其他会话各自保留自己的模型
        config.activeProfileId = accountId;
        config.activeModelId = entry.id;
        profile.lastModelId = entry.id;
        pinSessionModel(session, profile, entry);
        saveAIConfig();
        if (session) persistSessions();
        renderProfileSelect();
        refreshSettingsPane();
        updateComposerState();
        renderModelChip();
        renderModelList();
        closeModelPicker();
        recordModelSwitch(prevProfile, prevEntry, profile, entry);
        if (isOpen()) renderMessages(true);
        flash('已切换模型：' + (entry.model || profile.name || '未命名'));
    }

    // 写入指定模型条目的思考等级（模型选择器行内档位条点档）：
    // 非 Anthropic 写 reasoningEffort；Anthropic 把档位换算成思考预算。
    // 弹层内改档不关闭选择器，写完刷新配置、设置页与 chip；提示由调用方带模型名给出。
    function setReasoningLevelFor(profile, entry, level) {
        if (!profile || !entry) return;
        if (profile.provider !== 'anthropic') {
            entry.reasoningEffort = ['low', 'medium', 'high'].includes(level) ? level : '';
        } else if (level === 'off') {
            entry.thinking = false;
        } else {
            entry.thinking = true;
            entry.thinkingBudget = level === 'low' ? 1024 : (level === 'high' ? 16000 : 8000);
            clampThinkingBudget(profile, entry, 'thinking');
        }
        saveAIConfig();
        refreshSettingsPane();
        renderModelChip();
    }

    // 本次会话上下文上限（模型选择器档位）：只写当前会话并随会话持久化，不动模型条目配置；
    // 生效值 = min(上限, 模型窗口)（contextWindowOf 单点消费）。value = 0 恢复默认。
    function applyCtxLimit(value) {
        const session = currentSession();
        if (!session) return;
        const entry = entryOf(session);
        const base = (entry && entry.contextWindow) || 128000;
        session.ctxLimit = normalizeCtxLimit(value);
        persistSessions();
        renderModelChip();
        renderStats();
        updateCtxBanner();
        const applied = effectiveContextWindow(base, session.ctxLimit);
        if (applied < base) {
            flash('本次会话上下文上限：' + formatTokenAmount(applied));
            // 调低上限当场生效：占用已过阈值就不用等下一轮，直接尝试压缩（内部有流式/连压守卫）
            maybeAutoCompact(session);
        } else {
            flash('本次会话上下文上限：默认（' + formatTokenAmount(base) + '）');
        }
    }

    // ---------- 双层级模型选择器（搜索 + 按账号分组 + 推理等级） ----------

    let modelPickerEl = null;
    let modelPickerDismiss = null;
    let modelListPickerEl = null;
    let modelListPickerDismiss = null;
    let usagePopoverEl = null;
    let usagePopoverDismiss = null;

    function closeModelListPicker() {
        if (modelListPickerDismiss) {
            const dispose = modelListPickerDismiss;
            modelListPickerDismiss = null;
            dispose();
        }
        if (modelListPickerEl) {
            modelListPickerEl.remove();
            modelListPickerEl = null;
        }
    }

    function closeModelPicker() {
        if (modelPickerDismiss) {
            const dispose = modelPickerDismiss;
            modelPickerDismiss = null;
            dispose();
        }
        if (modelPickerEl) {
            modelPickerEl.remove();
            modelPickerEl = null;
        }
    }

    function showModelPicker() {
        if (!el.modelChip) return;
        if (modelPickerEl) {
            closeModelPicker();
            return;
        }
        if (!config.profiles.length) {
            openSettings('models');
            return;
        }
        const rect = el.modelChip.getBoundingClientRect();
        // 选择器展示 / 勾选的都是「当前会话」的模型（各会话独立）
        const sessionRef = sessionModelRef(currentSession());
        const activeAccountId = (sessionRef.profile && sessionRef.profile.id) || '';
        const activeEntryId = (sessionRef.entry && sessionRef.entry.id) || '';
        const picker = document.createElement('div');
        picker.className = 'ai-model-picker';
        modelPickerEl = picker;

        const searchWrap = document.createElement('div');
        searchWrap.className = 'ai-model-picker-searchwrap';
        const searchIco = document.createElement('span');
        searchIco.className = 'ai-model-picker-searchico';
        searchIco.innerHTML = iconSvg('search', 13);
        const search = document.createElement('input');
        search.type = 'text';
        search.className = 'ai-model-picker-search';
        search.placeholder = '搜索模型…';
        search.spellcheck = false;
        searchWrap.append(searchIco, search);
        const listBox = document.createElement('div');
        listBox.className = 'ai-model-picker-list';
        const limitRow = document.createElement('div');
        limitRow.className = 'ai-model-picker-limits';
        const foot = document.createElement('div');
        foot.className = 'ai-model-picker-foot';
        const settingsBtn = document.createElement('button');
        settingsBtn.type = 'button';
        settingsBtn.className = 'ai-model-picker-settings';
        settingsBtn.textContent = '模型设置…';
        settingsBtn.addEventListener('click', () => {
            closeModelPicker();
            openSettings('models');
        });
        foot.appendChild(settingsBtn);
        picker.append(searchWrap, listBox, limitRow, foot);

        let flatItems = [];
        let navIndex = -1;
        // 行内展开的思考等级档位条（accountId|entryId）；搜索重建列表时收起
        let expandedKey = '';

        function renderList() {
            const query = search.value.trim().toLowerCase();
            const tokens = query.split(/\s+/).filter(Boolean);
            listBox.innerHTML = '';
            flatItems = [];
            for (const account of config.profiles) {
                const entries = (account.models || []).filter((entry) => {
                    if (!tokens.length) return true;
                    const haystack = ((entry.model || '') + ' ' + (account.name || '')).toLowerCase();
                    return tokens.every((token) => haystack.includes(token));
                });
                if (!entries.length) continue;
                const group = document.createElement('div');
                group.className = 'ai-model-picker-group';
                const head = document.createElement('div');
                head.className = 'ai-model-picker-group-head';
                const headName = document.createElement('span');
                headName.textContent = account.name || '未命名账号';
                const headTag = document.createElement('span');
                headTag.className = 'ai-model-picker-tag';
                headTag.textContent = providerLabelFor(account);
                head.append(headName, headTag);
                group.appendChild(head);
                for (const entry of entries) {
                    const isActive = account.id === activeAccountId && entry.id === activeEntryId;
                    const item = document.createElement('button');
                    item.type = 'button';
                    item.className = 'ai-model-picker-item' + (isActive ? ' active' : '');
                    const name = document.createElement('span');
                    name.className = 'ai-model-picker-name';
                    name.textContent = entry.model || '（未填写模型 ID）';
                    // 思考等级徽标：每个模型条目自己的等级（分色见 --ai-lv-*），
                    // 点击在行下展开档位条直接改该模型 —— 弹层不关，可连续配置多个
                    const info = reasoningLevelInfo(account, entry);
                    const effort = document.createElement('button');
                    effort.type = 'button';
                    effort.className = 'ai-model-picker-effort';
                    effort.dataset.tone = info.tone;
                    effort.textContent = info.label;
                    effort.addEventListener('click', (e) => {
                        e.stopPropagation();
                        toggleQuickBar(account, entry);
                    });
                    const win = document.createElement('span');
                    win.className = 'ai-model-picker-win';
                    win.textContent = formatTokenAmount(entry.contextWindow || 128000);
                    const check = document.createElement('span');
                    check.className = 'ai-model-picker-check';
                    check.innerHTML = isActive ? iconSvg('check', 13) : '';
                    item.append(name, effort, win, check);
                    item.addEventListener('click', () => {
                        closeModelPicker();
                        switchModel(account.id, entry.id);
                    });
                    flatItems.push(item);
                    group.appendChild(item);
                    // 档位条是 item 的兄弟节点（按钮不能嵌套），展开态单开
                    if (account.id + '|' + entry.id === expandedKey) group.appendChild(buildQuickBar(account, entry));
                }
                listBox.appendChild(group);
            }
            if (!flatItems.length) {
                const empty = document.createElement('div');
                empty.className = 'ai-model-picker-empty';
                empty.textContent = query
                    ? '没有匹配「' + search.value.trim() + '」的模型'
                    : '还没有模型';
                listBox.appendChild(empty);
            }
            navIndex = -1;
        }

        // 展开 / 收起某模型行下的思考等级档位条（同弹层内只开一个）
        function toggleQuickBar(account, entry) {
            const key = account.id + '|' + entry.id;
            expandedKey = expandedKey === key ? '' : key;
            renderList();
            const bar = expandedKey ? listBox.querySelector('.ai-model-picker-quick') : null;
            if (bar && bar.scrollIntoView) bar.scrollIntoView({block: 'nearest'});
        }

        // 思考等级档位条：连体分段控件，点档写该模型条目（不关弹层、徽标即时刷新）
        function buildQuickBar(account, entry) {
            const info = reasoningLevelInfo(account, entry);
            const bar = document.createElement('div');
            bar.className = 'ai-model-picker-quick ai-model-picker-seggroup';
            for (const [value, label] of info.options) {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'ai-model-picker-seg' + (info.value === value ? ' active' : '');
                chip.textContent = label;
                chip.addEventListener('click', () => {
                    setReasoningLevelFor(account, entry, value);
                    flash('已更新 ' + (entry.model || '未命名模型') + ' 思考等级：' + reasoningLevelInfo(account, entry).label);
                    expandedKey = account.id + '|' + entry.id;
                    renderList();
                });
                bar.appendChild(chip);
            }
            return bar;
        }

        function setNav(next) {
            if (!flatItems.length) return;
            navIndex = (next + flatItems.length) % flatItems.length;
            flatItems.forEach((item, index) => item.classList.toggle('nav', index === navIndex));
            const target = flatItems[navIndex];
            if (target && target.scrollIntoView) target.scrollIntoView({block: 'nearest'});
        }

        // 本次会话上下文上限（会话级，不动模型条目）：档位只列 < 模型窗口的固定档
        //（CTX_LIMIT_TIERS），模型窗口不大于最小档（如上限就 256K 的模型）时整行隐藏。
        // 思考等级已收进模型行的行内徽标 + 档位条，这里不再有全局推理等级行。
        function renderLimits() {
            const session = currentSession();
            const entry = entryOf(session);
            const base = (entry && entry.contextWindow) || 128000;
            const tiers = ctxLimitTiersFor(base);
            limitRow.innerHTML = '';
            if (!session || !entry || !tiers.length) {
                limitRow.style.display = 'none';
                return;
            }
            limitRow.style.display = '';
            const lab = document.createElement('span');
            lab.className = 'ai-model-picker-limits-label';
            lab.textContent = '上下文上限';
            limitRow.appendChild(lab);
            const seg = document.createElement('div');
            seg.className = 'ai-model-picker-seggroup';
            const currentEffective = effectiveContextWindow(base, session.ctxLimit);
            const options = [[0, '默认']].concat(tiers.map((tier) => [tier, formatTokenAmount(tier)]));
            for (const [value, label] of options) {
                const effective = effectiveContextWindow(base, value);
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'ai-model-picker-seg' + (effective === currentEffective ? ' active' : '');
                chip.textContent = label;
                chip.addEventListener('click', () => {
                    closeModelPicker();
                    applyCtxLimit(value);
                });
                seg.appendChild(chip);
            }
            limitRow.appendChild(seg);
        }

        search.addEventListener('input', () => {
            expandedKey = '';
            renderList();
        });
        search.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setNav(navIndex < 0 ? 0 : navIndex + 1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setNav(navIndex < 0 ? flatItems.length - 1 : navIndex - 1);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const target = flatItems[navIndex >= 0 ? navIndex : 0];
                if (target) target.click();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeModelPicker();
            }
        });

        const onDocMouseDown = (e) => {
            if (modelPickerEl && picker.contains(e.target)) return;
            if (el.modelChip && el.modelChip.contains(e.target)) return;
            closeModelPicker();
        };
        modelPickerDismiss = () => {
            document.removeEventListener('mousedown', onDocMouseDown, true);
        };
        document.addEventListener('mousedown', onDocMouseDown, true);

        renderList();
        renderLimits();
        document.body.appendChild(picker);
        picker.style.visibility = 'hidden';
        const width = Math.min(360, window.innerWidth - 16);
        const height = picker.offsetHeight;
        const top = rect.top - height - 8 >= 8 ? rect.top - height - 8 : Math.max(8, rect.bottom + 8);
        picker.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + 'px';
        picker.style.top = top + 'px';
        picker.style.width = width + 'px';
        picker.style.visibility = '';
        search.focus();
    }

    // 获取列表的多选弹层：勾选模型 ID 批量添加为该账号的模型条目
    function showModelListPicker(profile, list) {
        if (!opt.models) return;
        closeModelListPicker();
        const rect = opt.models.getBoundingClientRect();
        const pop = document.createElement('div');
        pop.className = 'ai-model-list-pop';
        modelListPickerEl = pop;
        const listBox = document.createElement('div');
        listBox.className = 'ai-model-list-pop-items';
        const existing = new Set((profile.models || []).map((entry) => entry.model).filter(Boolean));
        const boxes = [];
        for (const id of list) {
            const label = document.createElement('label');
            label.className = 'ai-model-list-pop-item';
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.value = id;
            box.checked = false;
            const text = document.createElement('span');
            text.textContent = id + (existing.has(id) ? '（已添加）' : '');
            label.append(box, text);
            listBox.appendChild(label);
            boxes.push(box);
        }
        const foot = document.createElement('div');
        foot.className = 'ai-model-list-pop-foot';
        const count = document.createElement('span');
        count.className = 'ai-model-list-pop-count';
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'dlg-btn primary';
        addBtn.textContent = '添加选中';
        const syncCount = () => {
            const picked = boxes.filter((box) => box.checked).length;
            count.textContent = '已选 ' + picked + ' 个';
            addBtn.disabled = picked === 0;
        };
        listBox.addEventListener('change', syncCount);
        addBtn.addEventListener('click', () => {
            const picked = boxes.filter((box) => box.checked).map((box) => box.value)
                .filter((id) => !existing.has(id));
            for (const id of picked) {
                const entry = normalizeModelEntry({model: id, autoFilled: true}, () => aiNowId('model-'));
                // 拉下来的 ID 直接在配置表里有的，顺手把窗口/能力填好——这是「智能填充」命中率最高的一步
                modelCatalog.fill(entry, id);
                profile.models.push(entry);
            }
            closeModelListPicker();
            saveAIConfig();
            refreshSettingsPane();
            renderModelList();
            if (picked.length) setSettingsStatus('已添加 ' + picked.length + ' 个模型条目', 'ok');
        });
        foot.append(count, addBtn);
        pop.append(listBox, foot);
        listBox.style.maxHeight = '260px';
        document.body.appendChild(pop);
        const width = Math.min(320, window.innerWidth - 16);
        let top = rect.bottom + 6;
        if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - pop.offsetHeight - 6);
        pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + 'px';
        pop.style.top = top + 'px';
        pop.style.width = width + 'px';
        const onDocMouseDown = (e) => {
            if (modelListPickerEl && pop.contains(e.target)) return;
            closeModelListPicker();
        };
        const onKey = (e) => {
            if (e.key === 'Escape') closeModelListPicker();
        };
        modelListPickerDismiss = () => {
            document.removeEventListener('mousedown', onDocMouseDown, true);
            document.removeEventListener('keydown', onKey, true);
        };
        document.addEventListener('mousedown', onDocMouseDown, true);
        document.addEventListener('keydown', onKey, true);
        syncCount();
    }

    // 用量查询（cc-switch 式）：按账号 baseURL 匹配内置端点，返回余额/用量明细
    async function queryUsageForAccount(profile, anchor) {
        if (!backend.AIUsageQuery) {
            flash('当前版本不支持用量查询', true);
            return;
        }
        if (!anchor || !anchor.currentTarget) {
            flash('正在查询「' + (profile.name || '账号') + '」用量…');
        }
        try {
            const result = await backend.AIUsageQuery(configForProfile(profile));
            showUsagePopover(profile, result, anchor && anchor.currentTarget);
        } catch (e) {
            flash('用量查询失败：' + ((e && e.message) || e), true);
        }
    }

    function showUsagePopover(profile, result, anchor) {
        closeUsagePopover();
        const pop = document.createElement('div');
        pop.className = 'ai-usage-pop';
        usagePopoverEl = pop;
        const head = document.createElement('div');
        head.className = 'ai-usage-pop-head';
        const title = document.createElement('span');
        title.textContent = '用量 · ' + (profile.name || '未命名账号');
        const provider = document.createElement('span');
        provider.className = 'ai-usage-pop-provider';
        provider.textContent = result && result.provider ? result.provider : providerLabelFor(profile);
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'ai-usage-pop-close';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', closeUsagePopover);
        head.append(title, provider, closeBtn);
        const body = document.createElement('div');
        body.className = 'ai-usage-pop-body';
        if (result && result.error) {
            const err = document.createElement('div');
            err.className = 'ai-usage-pop-error';
            err.textContent = '查询失败：' + result.error;
            body.appendChild(err);
        } else if (!result || !result.supported) {
            const note = document.createElement('div');
            note.className = 'ai-usage-pop-note';
            note.textContent = '该服务商暂不支持用量查询（已内置 DeepSeek / OpenRouter / SiliconFlow）。';
            body.appendChild(note);
        } else {
            for (const item of (result.items || [])) {
                const row = document.createElement('div');
                row.className = 'ai-usage-pop-row';
                const label = document.createElement('span');
                label.textContent = item.label;
                const value = document.createElement('b');
                value.textContent = item.value;
                row.append(label, value);
                body.appendChild(row);
            }
        }
        pop.append(head, body);
        document.body.appendChild(pop);
        const width = Math.min(340, window.innerWidth - 16);
        let left = window.innerWidth / 2 - width / 2;
        let top = window.innerHeight / 2 - pop.offsetHeight / 2;
        if (anchor && anchor.getBoundingClientRect) {
            const rect = anchor.getBoundingClientRect();
            left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
            top = rect.bottom + 6;
            if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - pop.offsetHeight - 6);
        }
        pop.style.left = Math.max(8, left) + 'px';
        pop.style.top = Math.max(8, top) + 'px';
        pop.style.width = width + 'px';
        const onDocMouseDown = (e) => {
            if (usagePopoverEl && pop.contains(e.target)) return;
            closeUsagePopover();
        };
        usagePopoverDismiss = () => {
            document.removeEventListener('mousedown', onDocMouseDown, true);
        };
        document.addEventListener('mousedown', onDocMouseDown, true);
    }

    function closeUsagePopover() {
        if (usagePopoverDismiss) {
            const dispose = usagePopoverDismiss;
            usagePopoverDismiss = null;
            dispose();
        }
        if (usagePopoverEl) {
            usagePopoverEl.remove();
            usagePopoverEl = null;
        }
    }

    function showAttachMenu() {
        if (!el.attachBtn || !showContextMenu) return;
        const rect = el.attachBtn.getBoundingClientRect();
        showContextMenu([
            {label: '当前文件', icon: 'doc', action: () => attachCurrentFile()},
            {label: '选中内容', icon: 'select-all', action: () => attachSelection()},
            {label: '附加文件…', icon: 'file', action: () => attachFilesDialog()},
            {label: '技能…', icon: 'sparkles', action: () => showSkillPicker()},
            // 手动创建计时器：与 AI 的 start_timer 同一条 Go 侧计时链路
            {label: '计时器', icon: 'clock', submenu: [
                {label: '倒计时…', action: () => timerMod.openCreateDialog('countdown')},
                {label: '正计时…', action: () => timerMod.openCreateDialog('countup')},
            ]},
            {label: '任务提醒…', icon: 'bell', action: () => remindersMod.openCreateDialog()},
            {sep: true},
            // 协作：投递 / 支线都在这里——不进输入框、不改当前会话，先选人再写内容
            {label: '投递到会话…', icon: 'forward', action: () => openDeliverComposer()},
            {label: '新建支线对话', icon: 'bookmark', action: () => openSideChat({session: currentSession()})},
            {sep: true},
            {label: '指令', icon: 'terminal', submenu: [
                {label: '压缩上下文', action: () => startCompact()},
                {label: '初始化 AGENTS.md', action: () => runInitAgentsMd()},
                {label: '提示词…', action: () => showPromptDialog()},
                {label: '记忆管理…', action: () => showMemoryDialog()},
                {label: '技能管理…', action: () => showSkillsDialog()},
            ]},
        ], rect.left, rect.top - 240);
    }

    function showMoreMenu() {
        if (!el.moreBtn || !showContextMenu) return;
        const rect = el.moreBtn.getBoundingClientRect();
        const items = floatWindow ? [
            {label: '新建会话', icon: 'plus', action: () => newSession()},
            {label: '重命名会话…', icon: 'rename', action: () => renameSession()},
            {label: '删除会话', icon: 'trash', action: () => deleteSession()},
            {label: '导出会话…', icon: 'export', action: () => exportSession()},
            {label: '会话数据诊断…', icon: 'info', action: () => showSessionDiagnostics(currentSession())},
            {sep: true},
        ] : [];
        // 显示方式收进二级菜单：头部不再常驻三形态切换按钮（默认停靠，调整走这里或设置页）
        if (!floatWindow) {
            items.push(
                {label: '显示方式', icon: 'layout-dock', submenu: [
                    {label: '停靠分屏（无文件时占满）', checked: mode === 'dock', action: () => setMode('dock')},
                    {label: '全屏（仅覆盖文件内容区）', checked: mode === 'fullscreen', action: () => setMode('fullscreen')},
                    {label: '在独立悬浮窗打开', action: () => setMode('float')},
                ]},
            );
        }
        // 头部宽度不足（浮窗最小宽 360 也会触发）时换侧按钮与 Git 入口都已收起，在菜单里补回
        const head = panel.querySelector('.ai-head-title-row');
        if (head && head.classList.contains('ai-head-compact')) {
            if (!floatWindow) items.push({label: '换到另一侧', icon: 'swap-side', action: togglePanelSide});
            // Git 快捷操作的唯一入口就是头部按钮，仅 Git 可用时补回（与按钮显隐条件一致）
            if (el.gitBtn && !el.gitBtn.classList.contains('hidden')) {
                items.push({label: 'Git 操作', icon: 'git', submenu: GIT_ACTIONS.map((a) => ({
                    label: a.label,
                    icon: a.icon,
                    action: () => gitUiMod.runGitAction(a.id),
                }))});
            }
        }
        if (!floatWindow) items.push({sep: true});
        items.push(
            {label: '新建支线对话（旁路追问）', icon: 'bookmark', action: () => openSideChat({session: currentSession()})},
            {label: '通知运行中的会话…', icon: 'bell', action: () => notifyRunningSessions()},
            {sep: true},
            {label: '提示词…', icon: 'doc', action: () => showPromptDialog()},
            {label: '记忆管理…', icon: 'save', action: () => showMemoryDialog()},
            {label: '技能管理…', icon: 'sparkles', action: () => showSkillsDialog()},
            {sep: true},
            {label: '会话数据诊断…', icon: 'info', action: () => showSessionDiagnostics(currentSession())},
            {label: '对话日志目录…', icon: 'open-folder', action: openAILogDir},
            {label: '个性化设置…', icon: 'star', action: () => openSettings('persona')},
            {label: '模型设置…', icon: 'gear', action: () => openSettings('models')},
        );
        showContextMenu(items, rect.left - 160, rect.bottom + 4);
    }

    // Git 快捷操作 UI（阶段 3 拆出：ai-git-ui.js；gitEntryState 随域迁入模块）
    const gitUiMod = createAIGitUi({
        el,
        getGitRepo,
        currentWorkspacePath,
        currentScopeOf,
        syncStreamView,
        compactOf,
        currentSession,
        flash,
        ensureOpen,
        showNote,
        sendAppMessage,
        showContextMenu,
        // Git 快捷操作一次性窄豁免：动作发送前给会话打令牌（auto 档常规 git 写命令免逐条审批）
        setGitFlowToken,
    });
    const refreshGitEntry = () => gitUiMod.refreshGitEntry();
    const showGitMenu = () => gitUiMod.showGitMenu();


    function refreshContext() {
        updateScopeUI();
        updateContextCount();
        refreshMemoryPath();
        refreshSystemPromptEstimate(true);
    }

    // ---------- 常用消息操作 ----------

    function findMessageWrap(index) {
        return el.messages.querySelector('.ai-msg[data-ai-idx="' + index + '"]');
    }

    function copyMessage(message) {
        if (!message) return;
        copyText(message.content || '', 'AI 消息');
    }

    function selectAllAIText() {
        if (!el.messages || !window.getSelection) return;
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el.messages);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    // ---------- 输入框右键编辑菜单（撤销/重做/剪切/复制/粘贴/全选） ----------

    function editableHasSelection(target) {
        if (typeof target.selectionStart === 'number') return target.selectionEnd > target.selectionStart;
        const selection = window.getSelection ? window.getSelection() : null;
        return !!(selection && selection.rangeCount && !selection.isCollapsed);
    }

    function execEditable(target, command) {
        target.focus();
        try {
            return !!document.execCommand(command);
        } catch (e) {
            return false;
        }
    }

    // data URL → File：右键菜单粘贴到的图片由后端以 data URL 返回，复用粘贴/拖拽的压缩管线。
    function dataUrlToFile(dataUrl, name) {
        const raw = String(dataUrl || '');
        const comma = raw.indexOf(',');
        if (comma < 0) return null;
        const header = raw.slice(0, comma);
        const mime = (header.slice(header.indexOf(':') + 1).split(';')[0] || 'image/png').trim() || 'image/png';
        let binary = '';
        try {
            binary = atob(raw.slice(comma + 1));
        } catch (e) {
            return null;
        }
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        if (!bytes.length) return null;
        try {
            return new File([bytes], name || '粘贴的图片', {type: mime});
        } catch (e) {
            return null;
        }
    }

    // 右键菜单的「粘贴」拿不到 paste 事件（菜单点击不会触发剪贴板事件），
    // 图片只能请后端回读系统剪贴板，再走和 Ctrl+V 一样的附件流程。
    async function pasteImageFromClipboard() {
        if (!backend.GetClipboardImage) return false;
        let dataUrl = '';
        try {
            dataUrl = String((await backend.GetClipboardImage()) || '');
        } catch (e) {
            return false;
        }
        if (!dataUrl) return false;
        const file = dataUrlToFile(dataUrl, '粘贴的图片.png');
        if (!file) return false;
        try {
            const prepared = await prepareImageAttachment(file);
            prepared.kind = 'image';
            prepared.label = prepared.name;
            return addAttachment(prepared);
        } catch (err) {
            flash('图片处理失败：' + ((err && err.message) || err), true);
            return false;
        }
    }

    async function pasteIntoEditable(target) {
        let text = '';
        try {
            if (backend.GetClipboardText) text = String((await backend.GetClipboardText()) || '');
        } catch (e) {}
        if (!text && navigator.clipboard && navigator.clipboard.readText) {
            try {
                text = await navigator.clipboard.readText();
            } catch (e) {}
        }
        if (!text) {
            // 剪贴板里没有文字：按图片粘贴（Ctrl+V 走 paste 事件，菜单粘贴只能这样回读）。
            await pasteImageFromClipboard();
            return;
        }
        target.focus();
        // execCommand('insertText') 会进 undo 栈（菜单粘贴也能 Ctrl+Z 撤销）；不可用时回退 setRangeText
        let ok = false;
        try {
            ok = document.execCommand('insertText', false, text);
        } catch (e) {}
        if (!ok) {
            if (typeof target.selectionStart === 'number') {
                target.setRangeText(text, target.selectionStart, target.selectionEnd, 'end');
            } else {
                target.value += text;
            }
            target.dispatchEvent(new Event('input', {bubbles: true}));
        }
    }

    function showAIEditMenu(event, target) {
        if (!showContextMenu) return;
        const hasSel = editableHasSelection(target);
        showContextMenu([
            {label: '撤销', shortcut: 'Ctrl+Z', icon: 'E7A7', action: () => execEditable(target, 'undo')},
            {label: '重做', shortcut: 'Ctrl+Y', icon: 'E7A6', action: () => execEditable(target, 'redo')},
            {sep: true},
            {label: '剪切', shortcut: 'Ctrl+X', icon: 'E8C6', disabled: !hasSel, action: () => execEditable(target, 'cut')},
            {label: '复制', shortcut: 'Ctrl+C', icon: 'E8C8', disabled: !hasSel, action: () => execEditable(target, 'copy')},
            {label: '粘贴', shortcut: 'Ctrl+V', icon: 'E77F', action: () => pasteIntoEditable(target)},
            {sep: true},
            {label: '全选', shortcut: 'Ctrl+A', icon: 'E8B3', action: () => execEditable(target, 'selectAll')},
        ], event.clientX, event.clientY);
    }

    function showAIMessageContextMenu(event) {
        if (!showContextMenu) return;
        const selection = window.getSelection ? window.getSelection() : null;
        const selectedText = selection ? String(selection.toString() || '') : '';
        const anchor = selection && selection.anchorNode;
        const selectionInside = !!(anchor && el.messages && (el.messages === anchor || el.messages.contains(anchor)));
        const wrap = event.target && event.target.closest ? event.target.closest('.ai-msg') : null;
        const index = wrap ? Number(wrap.dataset.aiIdx) : -1;
        const session = currentSession();
        const message = session && Number.isInteger(index) && index >= 0 ? session.messages[index] : null;
        const codeEl = event.target && event.target.closest ? event.target.closest('.ai-md pre, .ai-md code') : null;
        const codeText = codeEl ? String(codeEl.textContent || '') : '';
        const items = [];
        if (selectedText.trim() && selectionInside) {
            items.push({label: '复制所选', shortcut: 'Ctrl+C', icon: 'E8C8', action: () => copyText(selectedText, '所选文本')});
        }
        // 对话引用：与编辑器右键的「引用该文件 / 引用选取」（只给路径、让模型自己读）区分，
        // 这里把消息正文/选区带进输入区附件条，发送时拼成 user content 前缀的 <quote>。
        if (message && (message.role === 'assistant' || message.role === 'user')) {
            const quoteOf = (text, scope) => addMessageQuote({
                source: message.role, index, scope, content: text,
            });
            if (selectedText.trim() && selectionInside) {
                items.push({label: '引用所选到输入框', icon: 'E8C8', action: () => quoteOf(selectedText, 'selection')});
            }
            items.push({
                label: message.role === 'assistant' ? '引用整条回复' : '引用整条消息',
                icon: 'E8C8',
                disabled: !aiTextOf(message.content).trim(),
                action: () => quoteOf(message.content || '', 'message'),
            });
        }
        if (codeText.trim()) {
            items.push({label: '复制代码', icon: 'E8C8', action: () => copyText(codeText, '代码')});
        }
        if (message) {
            const label = message.role === 'assistant' ? '复制整条回复' : (message.role === 'user' ? '复制这条消息' : '复制工具输出');
            items.push({label, icon: 'E8C8', action: () => copyMessage(message)});
        }
        if (items.length) items.push({sep: true});
        items.push({label: '全选对话', action: selectAllAIText});
        showContextMenu(items, event.clientX, event.clientY);
    }

    function attachmentsFromImages(images) {
        return (images || []).filter((image) => image && image.data).map((image) => ({
            kind: 'image',
            label: image.name || '图片',
            mime: image.mime,
            data: image.data,
            width: image.width,
            height: image.height,
        }));
    }

    function attachmentsFromVideos(videos) {
        return (videos || []).filter((video) => video && video.data).map((video) => ({
            kind: 'video',
            label: video.name || '视频',
            mime: video.mime,
            data: video.data,
            bytes: video.bytes,
        }));
    }

    function regenerateLast() {
        const session = currentSession();
        if (!session || streamOf(session.id)) return;
        const assistantIndex = lastAssistantIndex(session);
        if (assistantIndex < 0) return;
        const userIndex = lastUserIndex(session);
        if (userIndex < 0) return;
        const userMessage = session.messages[userIndex];
        const userText = userMessage.content;
        const media = attachmentsFromImages(userMessage.images).concat(attachmentsFromVideos(userMessage.videos));
        session.messages = session.messages.slice(0, userIndex);
        setAttachments(media);
        renderAttachments();
        persistSessions();
        submitText(userText, userIndex);
    }

    function retryLast() {
        regenerateLast();
    }

    // 回退到某条 assistant 回复：保留它及之前的消息，丢弃之后的所有轮次。
    function rewindToMessage(session, index) {
        const target = session || currentSession();
        if (!target) return;
        if (streams.has(target.id)) {
            flash('请先停止当前会话的生成', true);
            return;
        }
        if (oneShot && oneShot.sessionId === target.id) {
            flash('该会话正在压缩上下文，请先停止', true);
            return;
        }
        const messages = target.messages || [];
        if (!Number.isInteger(index) || index < 0 || index >= messages.length) return;
        if (!messages[index] || messages[index].role !== 'assistant') return;
        const removed = messages.length - (index + 1);
        if (removed <= 0) return;
        askConfirm('回退到此轮？之后的 ' + removed + ' 条消息将被删除（已归档内容不受影响）。', () => {
            // 内存截断后由持久化层追加 truncate 事件，磁盘历史同步裁掉。
            target.messages = target.messages.slice(0, index + 1);
            pendingEdit = null;
            clearQueueForSession(target.id);
            renderWindows.delete(target.id);
            persistSessions();
            queueLogSave(target);
            if (currentSession() === target) {
                stickBottom = true;
                renderMessages(true);
                updateContextCount();
                updateComposerState();
                updateComposerTakeover(true);
            }
            renderSessionList();
            flash('已回退到该轮，删除 ' + removed + ' 条消息');
        }, '回退', '回退到该轮');
    }

    // 在当前轮收尾处分叉出一条新对话：把 [0..index] 的历史复制过去，再切到新会话。
    // 原会话完全不动（和「回退」相反），适合「从这里换条路试试」。
    function branchSessionAt(session, index) {
        const source = session || currentSession();
        if (!source) return;
        if (streams.has(source.id)) {
            flash('请先停止当前会话的生成再分支', true);
            return;
        }
        if (oneShot && oneShot.sessionId === source.id) {
            flash('该会话正在压缩上下文，请先停止', true);
            return;
        }
        const messages = source.messages || [];
        if (!Number.isInteger(index) || index < 0 || index >= messages.length) return;
        if (!messages[index] || messages[index].role !== 'assistant') return;
        // 快照与设置统一走 ai-session-fork（支线对话共用同一份）。顺带补上授权凭据：
        // 以前只拷消息与四个设置，approvedPaths / readRoots / modelId 全丢——分叉出来的
        // 会话第一次写文件要全部重新审批，模型也会回落到默认档。
        const forked = forkMessages(source, index);
        if (!forked.ok) {
            flash('分支失败：消息快照无法深拷贝', true);
            return;
        }
        // 标题派生自母会话（与支线对话「支线 · X」同一思路），别留成「新会话」——列表里
        // 一眼看不出是哪条会话分出来的。母会话还没自动生成标题时退化为「分支」。
        const sourceTitle = source.title && source.title !== '新会话' && source.title !== '会话'
            ? source.title : '';
        const branch = createSessionData(sourceTitle ? '分支 · ' + sourceTitle : '分支');
        Object.assign(branch, forkSettings(source));
        branch.workspace = branch.workspace || currentWorkspacePath();
        branch.messages = forked.messages;
        branch.updatedAt = Date.now();
        saveComposerDraft(currentSession() && currentSession().id);
        pendingEdit = null;
        sessions.push(branch);
        config.activeSessionId = branch.id;
        persistSessions();
        logActivity('ai.session', branch.id, {op: 'branch', title: branch.title, from: source.id}, {actor: 'user', source: 'user'});
        renderSessionList();
        switchSession(branch.id);
        flash('已在新对话中分支（复制 ' + branch.messages.length + ' 条消息）');
    }

    function editLast() {
        const session = currentSession();
        if (!session || streamOf(session.id)) return;
        const userIndex = lastUserIndex(session);
        if (userIndex < 0) return;
        const message = session.messages[userIndex];
        if (!el.input) return;
        const parsedQuote = splitQuotePrefix(message.content);
        el.input.value = parsedQuote.quotes.length ? parsedQuote.body : message.content;
        // 引用还原成附件条：编辑重发时不把 <quote> 标记原文暴露在输入框里。
        // 走 addAttachment 让 chip 拿到稳定 id，否则移除按钮会连带删掉所有无 id 附件。
        setAttachments(attachmentsFromImages(message.images).concat(attachmentsFromVideos(message.videos)));
        for (const quote of parsedQuote.quotes) {
            addAttachment({
                kind: AI_QUOTE_KIND,
                label: quoteChipLabel(quote),
                source: quote.source,
                index: quote.index,
                scope: quote.scope,
                content: quote.text,
            });
        }
        renderAttachments();
        pendingEdit = {index: userIndex, sessionId: session.id};
        resizeInput();
        updateSendState();
        if (el.hint) el.hint.textContent = '编辑中：发送将从这条消息重新开始';
        el.input.focus();
        const end = el.input.value.length;
        el.input.setSelectionRange(end, end);
    }

    // sessionOverride：内容区支线对话标签页里的点击（宿主不是面板，不能用「当前会话」反查）。
    // 无参调用 = 面板消息区，行为不变。
    function handleMessageClick(e, sessionOverride) {
        const approveBtn = e.target.closest('[data-ai-approve]');
        if (approveBtn) {
            const wrap = approveBtn.closest('.ai-msg');
            const session = sessionOverride || currentSession();
            const index = wrap ? Number(wrap.dataset.aiIdx) : -1;
            const message = session && index >= 0 ? session.messages[index] : null;
            if (message) {
                const card = approveBtn.closest('.ai-tool-card');
                const always = card && card.querySelector('input[data-ai-remember="always"]');
                const sessionBox = card && card.querySelector('input[data-ai-remember="session"]');
                const remember = always && always.checked ? 'always' : (sessionBox && sessionBox.checked ? 'session' : '');
                decideApproval(message, approveBtn.dataset.aiApprove === 'apply', remember);
            }
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        const envBtn = e.target.closest('[data-ai-env]');
        if (envBtn) {
            const wrap = envBtn.closest('.ai-msg');
            const session = sessionOverride || currentSession();
            const index = wrap ? Number(wrap.dataset.aiIdx) : -1;
            const message = session && index >= 0 ? session.messages[index] : null;
            if (message) {
                const card = envBtn.closest('.ai-tool-card');
                const input = card && card.querySelector('[data-ai-env-value]');
                decideEnvCreation(message, envBtn.dataset.aiEnv === 'create', input ? input.value : '');
            }
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        // 本轮用量徽标：开关浮层（不算 .ai-msg-action，单独处理）
        const usageChip = e.target.closest('[data-ai-act="usage"]');
        if (usageChip) {
            e.preventDefault();
            e.stopPropagation();
            const usageWrap = usageChip.closest('.ai-msg');
            const usageIndex = usageWrap ? Number(usageWrap.dataset.aiIdx) : -1;
            const usageSession = sessionOverride || currentSession();
            const usageMessage = usageSession && usageIndex >= 0 ? usageSession.messages[usageIndex] : null;
            if (usageMessage) {
                if (turnUsagePop && turnUsageAnchor === usageChip) closeTurnUsagePop();
                else showTurnUsagePop(usageChip, usageMessage);
            }
            return;
        }
        const button = e.target.closest('.ai-msg-action');
        if (!button) return;
        const wrap = button.closest('.ai-msg');
        if (!wrap) return;
        const index = Number(wrap.dataset.aiIdx);
        const session = sessionOverride || currentSession();
        const message = session && session.messages[index];
        if (!message) return;
        const action = button.dataset.aiAct;
        if (action === 'copy') copyMessage(message);
        else if (action === 'edit') editLast();
        else if (action === 'regenerate') regenerateLast();
        else if (action === 'retry') retryLast();
        else if (action === 'rewind') rewindToMessage(session, index);
        else if (action === 'branch') branchSessionAt(session, index);
        else if (action === 'sidechat') openSideChat({session, quote: message.content});
        else if (action === 'bringback') bringBackToParent(session, message.content);
        else if (action === 'deliver') deliverMessageToSession(session, message, button);
    }

    // 用户向投递 / 广播：交互都在 ai-session-send.js（多选 + 搜索 + 键盘），这里只转调。
    // 旧的「单选菜单」与「借输入框当通知内容」两版实现已废弃——选择器自带内容预览与计数。
    function deliverMessageToSession(session, message) {
        sessionSendMod.openDeliver(message, session);
    }

    // 不带来源消息的投递：内容由用户在面板里自己写（+ 菜单 / 侧栏「投递」/ 会话行图标共用）。
    // options.session 是「发起方」（自己不能被投），options.picked 预选目标。
    function openDeliverComposer(options) {
        const opts = options || {};
        sessionSendMod.openDeliver(null, opts.session || currentSession(), {
            picked: opts.picked || [],
        });
    }

    function notifyRunningSessions() {
        sessionSendMod.openBroadcast();
    }

    // ---------- 会话管理 ----------

    // 每个会话各自的输入草稿：输入框里的文字与附件都属于「当前会话」，
    // 切到别的会话要各自保留、互不夹带（否则在 A 粘的图片 / 写了一半的话会被发到 B）。
    // 文本草稿额外持久化到 localStorage（键名带会话 id）：重开面板 / 重启后切换回来仍能恢复；
    // 附件可能含大体积 dataURL，不落盘，只留在内存。
    const drafts = new Map(); // sessionId -> {text, attachments}

    const AI_DRAFT_KEY_PREFIX = 'datalens-ai-draft:';

    function draftLSKey(sessionId) {
        return AI_DRAFT_KEY_PREFIX + sessionId;
    }

    function saveComposerDraft(sessionId) {
        if (!sessionId) return;
        const text = el.input ? String(el.input.value || '') : '';
        const items = getAttachments().slice();
        if (!text.trim() && !items.length) {
            // 输入框已被清空（用户主动清空 / 发送后清空）：删除该会话草稿，而不是存一条空的。
            drafts.delete(sessionId);
            try { localStorage.removeItem(draftLSKey(sessionId)); } catch (e) {}
            return;
        }
        drafts.set(sessionId, {text, attachments: items});
        try {
            if (text.trim()) localStorage.setItem(draftLSKey(sessionId), JSON.stringify({text}));
            else localStorage.removeItem(draftLSKey(sessionId));
        } catch (e) {}
    }

    function loadComposerDraft(sessionId) {
        let draft = sessionId ? drafts.get(sessionId) : null;
        if (!draft && sessionId) {
            // 内存里没有（重开面板 / 重启后的首次切换）：从 localStorage 兜底恢复文本草稿
            try {
                const raw = localStorage.getItem(draftLSKey(sessionId));
                if (raw) {
                    const parsed = JSON.parse(raw);
                    const text = parsed && typeof parsed.text === 'string' ? parsed.text : '';
                    if (text.trim()) {
                        draft = {text, attachments: []};
                        drafts.set(sessionId, draft);
                    }
                }
            } catch (e) {}
        }
        setAttachments(draft ? draft.attachments.slice() : []);
        if (el.input) el.input.value = draft ? draft.text : '';
        resizeInput();
        renderAttachments();
        hideSlash();
    }

    function dropComposerDraft(sessionId) {
        if (!sessionId) return;
        drafts.delete(sessionId);
        try { localStorage.removeItem(draftLSKey(sessionId)); } catch (e) {}
    }

    // 给「还没切过去」的会话预填草稿（支线对话的引用块）：写内存 + localStorage，
    // switchSession 里的 loadComposerDraft 会照常恢复。
    function setComposerDraft(sessionId, text) {
        if (!sessionId) return;
        const value = String(text == null ? '' : text);
        drafts.set(sessionId, {text: value, attachments: []});
        try {
            if (value.trim()) localStorage.setItem(draftLSKey(sessionId), JSON.stringify({text: value}));
            else localStorage.removeItem(draftLSKey(sessionId));
        } catch (e) {}
    }

    // 正在等正文补上来的目标会话：连点多个未加载会话时，只让最后一次点击落地
    let pendingSwitchId = '';

    function switchSession(id) {
        const target = sessions.find((s) => s.id === id);
        if (!target) return;
        // 懒加载会话：正文还没读上来（启动只补了当前会话 + 最近若干条）。先补正文再走切换流程，
        // 界面永远看不到「空对话」；同时避免任何一次写盘把还没读完的历史当成空内容写出去。
        if (target._stub) {
            pendingSwitchId = id;
            ensureSessionLoaded(target).then((ok) => {
                if (pendingSwitchId !== id) return; // 期间又点了别的会话，以最后那次为准
                pendingSwitchId = '';
                if (!ok) {
                    flash('会话正文读取失败：' + (target._loadError || '未知原因'), true);
                    return;
                }
                switchSession(id);
            });
            return;
        }
        pendingSwitchId = '';
        const sync = syncWorkspaceToSession(target);
        // 软切换：目标会话属于另一个工作区，新窗口会带着该会话启动，本窗口保持原状态。
        if (sync === 'window') return;
        if (sync === 'assigned') persistSessions();
        // 不变量：支线对话不在面板里显示。目标是支线时重定向为「切母会话 + 在内容区
        // 开/激活支线标签页」——六个入口（列表、投递跳转、重启恢复、工具跳转、跨工作区
        // 软切换之后、通知唤醒）全靠这一处收口；母会话已删除时清 sideOf 按普通会话继续。
        // 没有标签页出口（悬浮窗）时不重定向：否则会切回母会话，用户就再也看不到这条支线。
        const sideOfId = aiTextOf(target.sideOf).trim();
        if (sideOfId && sideOfId !== id && sideChatTabOutlet) {
            const owner = sessionById(sideOfId);
            if (owner) {
                if (sideChatTabOutlet) {
                    sideChatTabOutlet({
                        sessionId: target.id,
                        title: target.title || '支线对话',
                        ownerTitle: owner.title || '',
                        snapAt: Number(target.createdAt) || Date.now(),
                    });
                }
                return switchSession(owner.id);
            }
            target.sideOf = '';
            persistSessions();
        }
        const previous = currentSession();
        if (previous && previous.id !== id) saveComposerDraft(previous.id);
        config.activeSessionId = id;
        // 切会话即「我改用这个模型了」：窗口默认同步成该会话的账号+条目，新会话才继承得对
        syncActiveFromSession(target);
        saveAIConfig();
        clearSessionUnread(target);
        logActivity('ai.session', id, {op: 'switch', title: target.title || ''}, {actor: 'user', source: 'user'});
        stickBottom = true;
        pendingEdit = null;
        // 输入框 / 附件换成目标会话自己的草稿（各会话互不夹带）
        loadComposerDraft(id);
        renderSessionList();
        syncStreamView();
        renderMessages();
        updateComposerState();
        // 目标会话自己的流决定「发送 / 停止」与占位文案，其他会话在跑不干扰
        setStreamingUI();
        // 状态栏写入徽标也切到目标会话自己的（后台会话的写入不在这里闪）
        // 任务提醒徽标随目标会话刷新
        syncRemindersUI(target);
        // 计时胶囊按目标会话重新过滤（显示与上限都是会话隔离的）
        timerMod.render();
        // 隔离 worktree 胶囊随目标会话切换（显示 / 隐藏 / 名称）
        worktreeMod.syncChip(target);
        // 头部弹层（智能体团队 / 后台终端）是「上个会话的」列表：切会话就收起来
        if (chipsPopKind) hideChipsPop();
        refreshSystemPromptEstimate(true);
        setTimeout(() => flushMessageQueue(id), 0);
        // 面板切了会话：支线标签页据此重新判定「在位 / 失联」
        for (const cb of sessionSwitchListeners) {
            try { cb(id); } catch (e) {}
        }
    }

    function newSession() {
        const current = currentSession();
        // 当前会话还没发过消息时复用它，避免连点新建刷出一堆空会话。
        if (current && !current.archivedAt && !(current.messages || []).length) {
            const target = sessionWorkspacePath(current);
            const now = currentWorkspacePath();
            if (!target || !now || aiWorkspaceKey(target) === aiWorkspaceKey(now)) {
                if (!target && now) {
                    current.workspace = now;
                    persistSessions();
                    renderSessionList();
                }
                pendingEdit = null;
                flash('当前会话为空，已复用');
                if (el.input) el.input.focus();
                return;
            }
        }
        // 列表里已有当前工作区（或未绑定工作区）的空会话：直接切换过去复用，
        // 不再新建。主窗口与悬浮窗进程各建过占位空会话、或空会话不是当前会话时，
        // 旧逻辑会再攒一个「新会话 · 0 条消息」。
        const nowKey = aiWorkspaceKey(currentWorkspacePath());
        const spare = sessions
            .filter((item) => item !== current && isVirginSession(item))
            .filter((item) => {
                const key = aiWorkspaceKey(sessionWorkspacePath(item));
                return !key || !nowKey || key === nowKey;
            })
            .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))[0];
        if (spare) {
            saveComposerDraft(current && current.id);
            if (!sessionWorkspacePath(spare) && currentWorkspacePath()) {
                spare.workspace = currentWorkspacePath();
                persistSessions();
            }
            // 复用的空会话可能很早就 pin 了当时的模型（启动占位 / 另一个进程建的占位），
            // 既然当成「新会话」用，就按当前在用的模型重新 pin，否则又回到旧模型。
            const inherited = inheritModelTarget();
            pinSessionModel(spare, inherited.profile, inherited.entry);
            pendingEdit = null;
            switchSession(spare.id);
            flash('已复用空会话');
            if (el.input) el.input.focus();
            return;
        }
        const session = createSessionData();
        saveComposerDraft(current && current.id);
        pendingEdit = null;
        sessions.push(session);
        config.activeSessionId = session.id;
        loadComposerDraft(session.id);
        persistSessions();
        logActivity('ai.session', session.id, {op: 'create', title: session.title || ''}, {actor: 'user', source: 'user'});
        renderSessionList();
        if (sessionListEl) sessionListEl.scrollTop = 0;
        syncStreamView();
        renderMessages();
        updateComposerState();
        setStreamingUI();
        if (el.input) el.input.focus();
    }

    // 分组头「+」：当前工作区直接新建；其他工作区把会话建在它的名下，
    // 落盘后走软切换（目标工作区在新窗口打开并选中该会话），避免会话落到错误的分组。
    function newSessionInWorkspace(group) {
        const path = group && group.path ? aiNormalizePath(group.path) : '';
        const now = currentWorkspacePath();
        if (!path || !now || aiWorkspaceKey(path) === aiWorkspaceKey(now)) {
            newSession();
            return;
        }
        const session = createSessionData();
        session.workspace = path;
        pendingEdit = null;
        sessions.push(session);
        persistSessions();
        logActivity('ai.session', session.id, {op: 'create', title: session.title || ''}, {actor: 'user', source: 'user'});
        renderSessionList();
        // 先等新会话落盘，目标工作区的新窗口才能按 --ai-session 恢复它。
        Promise.resolve(sessionStore && sessionStore.flush ? sessionStore.flush() : null)
            .catch(() => {})
            .then(() => switchSession(session.id));
    }

    function renameSession(target) {
        const session = target && target.id ? target : currentSession();
        if (!session) return;
        if (!showNameDialog) {
            const next = window.prompt('重命名会话', session.title);
            if (next && next.trim()) {
                session.title = next.trim().slice(0, 60);
                persistSessions();
                renderSessionList();
                queueLogSave(session);
            }
            return;
        }
        showNameDialog({
            title: '重命名会话',
            label: '会话名称',
            value: session.title,
            okLabel: '重命名',
            onSubmit: (value) => {
                const next = String(value || '').trim();
                if (!next) throw new Error('会话名称不能为空');
                session.title = next.slice(0, 60);
                persistSessions();
                renderSessionList();
                queueLogSave(session);
            },
        });
    }

    function archiveSession(target, archived) {
        const session = target && target.id ? target : currentSession();
        if (!session) return;
        if (streams.has(session.id)) {
            flash('请先停止当前会话的生成', true);
            return;
        }
        if (oneShot && oneShot.sessionId === session.id) {
            flash('该会话正在压缩上下文，请先停止', true);
            return;
        }
        session.archivedAt = archived ? Date.now() : 0;
        if (archived) clearQueueForSession(session.id);
        logActivity('ai.session', session.id, {op: archived ? 'archive' : 'unarchive', title: session.title || ''}, {actor: 'user', source: 'user'});
        const isCurrent = currentSession() && currentSession().id === session.id;
        if (archived && isCurrent) {
            const next = sessions
                .filter((item) => item.id !== session.id && !item.archivedAt)
                .sort((a, b) => sessionActivity(b) - sessionActivity(a))[0];
            if (!next) {
                const fresh = createSessionData();
                sessions.push(fresh);
                persistSessions();
                switchSession(fresh.id);
            } else {
                persistSessions();
                switchSession(next.id);
            }
            flash('已归档会话：' + (session.title || '新会话'));
            return;
        }
        persistSessions();
        renderSessionList();
        updateComposerState();
        flash((archived ? '已归档会话：' : '已取消归档：') + (session.title || '新会话'));
    }

    // 置顶会话：固定显示在会话列表最上方（工作区分组之前），随会话 meta 持久化。
    // 已归档会话不允许置顶（归档本身就把会话移出活动列表）。
    function toggleSessionPin(target) {
        const session = target && target.id ? target : currentSession();
        if (!session) return;
        if (session.archivedAt) {
            flash('已归档会话不能置顶，请先取消归档', true);
            return;
        }
        session.pinned = session.pinned !== true;
        logActivity('ai.session', session.id, {op: session.pinned ? 'pin' : 'unpin', title: session.title || ''}, {actor: 'user', source: 'user'});
        persistSessions();
        renderSessionList();
        flash((session.pinned ? '已置顶会话：' : '已取消置顶：') + (session.title || '新会话'));
    }

    function deleteSession(target) {
        const session = target && target.id ? target : currentSession();
        if (!session) return;
        if (streams.has(session.id)) {
            flash('请先停止当前会话的生成', true);
            return;
        }
        if (oneShot && oneShot.sessionId === session.id) {
            flash('该会话正在压缩上下文，请先停止', true);
            return;
        }
        askConfirm('删除会话「' + (session.title || '新会话') + '」及其全部消息？', () => {
            sessions = sessions.filter((s) => s.id !== session.id);
            commandApprovalRules.delete(session.id);
            pendingModelSwitches.delete(session.id);
            dropComposerDraft(session.id);
            forgetPrompt(session.id);
            stopSubAgentsOf(session.id);
            // clearQueueForSession 同时清该会话的排队消息与「插话待发」标记；信箱与子代理记录随会话删除丢弃
            clearQueueForSession(session.id);
            noticesMod.dropSession(session.id);
            dropSubAgentRecordsOf(session.id);
            logActivity('ai.session', session.id, {op: 'delete', title: session.title || ''}, {actor: 'user', source: 'user'});
            // 删除的是当前会话：跳到**新建的空白会话**——此前 fallback 到 sessions[0]
            // （数组头 = 最旧的会话，列表里看着像「跳到了最后一个对话」）；删对话的意图
            // 通常是「从这里开新的」。删别的会话时当前选中不变。
            if (!sessions.some((s) => s.id === config.activeSessionId)) {
                const fresh = createSessionData();
                sessions.push(fresh);
                config.activeSessionId = fresh.id;
            }
            if (sessionUseDisk()) {
                sessionStore.removeSession(session.id).catch(notifySessionStoreError);
            }
            persistSessions();
            renderSessionList();
            renderMessages();
            updateComposerState();
        }, '删除', '删除会话');
    }

    function exportSession(target) {
        const session = target && target.id ? target : currentSession();
        if (!session) return;
        // 懒加载会话：正文还没读上来，直接导出会是一份空文档
        if (session._stub) {
            ensureSessionLoaded(session).then((ok) => {
                if (!ok) {
                    flash('会话正文读取失败，无法导出：' + (session._loadError || ''), true);
                    return;
                }
                exportSession(session);
            });
            return;
        }
        const markdown = buildSessionMarkdown(session);
        if (!backend.SaveFileDialog || !backend.SaveFile) {
            flash('当前版本不支持导出会话', true);
            return;
        }
        Promise.resolve(backend.SaveFileDialog(aiSafeFileStem(session.title) + '.md')).then((path) => {
            if (!path) {
                flash('已取消导出');
                return;
            }
            return backend.SaveFile(path, markdown, 'lf', false, 'utf-8').then(() => {
                flash('已导出会话：' + path);
            });
        }).catch((e) => {
            flash('导出会话失败：' + ((e && e.message) || e), true);
        });
    }

    function buildSessionMarkdown(session) {
        const lines = ['# ' + (session.title || 'AI 会话'), '', '> 导出时间：' + new Date().toLocaleString(), ''];
        if (session.summary && session.summary.text) {
            lines.push('## 会话摘要', '', session.summary.text, '');
        }
        for (const message of session.messages) {
            if (message.role === 'tool') {
                lines.push('## 工具调用：' + (message.name || 'tool'), '');
                if (message.arguments) lines.push('参数：`' + message.arguments + '`', '');
                if (message.ask) appendAskMarkdown(lines, message.ask);
                lines.push('```text', message.content || '（无输出）', '```', '');
            } else if (message.role === 'user') {
                lines.push('## ' + (message.app && message.app.label ? '应用 · ' + message.app.label : '用户'), '', message.content || '', '');
                for (const image of message.images || []) {
                    const src = aiImageSrc(image);
                    if (src) lines.push('![图片](<' + src + '>)', '');
                    else if (image.logFile) lines.push('（图片已归档：`' + image.logFile + '`）', '');
                }
                for (const video of message.videos || []) {
                    if (video.file || video.logFile) lines.push('（视频已归档：`' + (video.file || video.logFile) + '`）', '');
                    else lines.push('（视频附件：' + (video.name || video.mime || 'video') + '）', '');
                }
            } else {
                lines.push('## AI' + (message.model ? '（' + message.model + '）' : ''), '');
                if (message.reasoning) {
                    lines.push('> 思考过程：', '>', '> ' + message.reasoning.replace(/\n/g, '\n> '), '');
                }
                lines.push(message.content || '', '');
                if (message.status === 'error' && message.error) lines.push('> 错误：' + message.error, '');
            }
            lines.push('---', '');
        }
        if (Array.isArray(session.changes) && session.changes.length) {
            lines.push('## 变更记录', '');
            for (const change of session.changes) {
                lines.push('- `' + (change.relPath || change.path) + '` +' + change.added + ' −' + change.removed +
                    ' · ' + new Date(change.time).toLocaleString());
            }
            lines.push('');
        }
        if (Array.isArray(session.archived) && session.archived.length) {
            lines.push('## 已归档消息（压缩前，不发送）', '');
            for (const message of session.archived) {
                if (!message || !message.role) continue;
                const label = message.role === 'user'
                    ? (message.app && message.app.label ? '应用 · ' + message.app.label : '用户')
                    : (message.role === 'tool' ? ('工具：' + (message.name || '')) : 'AI');
                lines.push('### ' + label, '', message.content || '（无内容）', '');
            }
        }
        return lines.join('\n');
    }

    // ---------- 对话日志（自动落盘） ----------

    async function getAILogRoot() {
        const root = aiNormalizePath(await getAIAppDir());
        if (!root) throw new Error('无法定位应用数据目录');
        return aiJoinPath(root, 'ai-logs');
    }

    async function ensureAILogDir() {
        const dir = await getAILogRoot();
        if (backend.AIEnsureDir) await backend.AIEnsureDir(dir);
        return dir;
    }

    function logTimestamp(ts) {
        return new Date(Number(ts) || Date.now()).toLocaleString();
    }

    function logTruncate(text, max) {
        const value = aiTextOf(text);
        if (value.length <= max) return value;
        return value.slice(0, max) + '\n…（已截断 ' + (value.length - max) + ' 字符）';
    }

    function appendAskMarkdown(lines, ask) {
        if (!ask) return;
        (ask.questions || []).forEach((question, index) => {
            lines.push('问题 ' + (index + 1) + '：' + question.question, '');
            for (const option of question.options || []) {
                lines.push('- ' + option.label + (option.recommended ? '（推荐）' : '') +
                    (option.description ? ' — ' + option.description : ''));
            }
            const answer = (ask.answers || []).find((item) => item.id === question.id) || {};
            const selected = Array.isArray(answer.selected) ? answer.selected : [];
            if (selected.length) lines.push('回答：' + selected.join('、'));
            if (answer.custom) lines.push('补充：' + answer.custom);
            if (!selected.length && !answer.custom) lines.push('回答：（未回答）');
            lines.push('');
        });
        const result = askResultText(ask);
        if (result) lines.push('状态：' + askStateLabel(ask) + ' · ' + result, '');
    }

    function appendLogMessage(lines, message, level) {
        if (!message || !message.role) return;
        if (message.role === 'user') {
            if (message.kind === 'model-switch') {
                if (message.content) lines.push('> ' + message.content, '');
                return;
            }
            const images = (message.images || []).map(aiNormalizeImage).filter(Boolean);
            const videos = (message.videos || []).filter((video) => video && (video.data || video.file));
            if (!message.content && !images.length && !videos.length) return;
            lines.push(level + ' 用户 · ' + logTimestamp(message.ts), '');
            if (message.content) lines.push(message.content, '');
            for (const image of images) {
                if (image.logFile) lines.push('![图片](<' + image.logFile + '>)', '');
            }
            for (const video of videos) {
                lines.push('（视频附件：' + (video.file || video.name || 'video') + '）', '');
            }
            return;
        }
        if (message.role === 'tool') {
            lines.push(level + ' 工具：' + (message.name || 'tool') + ' · ' + (message.status || 'done'), '');
            if (message.arguments) lines.push('参数：`' + logTruncate(message.arguments, 4000) + '`', '');
            if (message.ask) appendAskMarkdown(lines, message.ask);
            lines.push('```text', logTruncate(message.content || '（无输出）', 50000), '```', '');
            return;
        }
        if (!message.content && !message.reasoning && !(message.toolCalls || []).length && !message.error) return;
        lines.push(level + ' AI' + (message.model ? '（' + message.model + '）' : '') + ' · ' + logTimestamp(message.ts), '');
        if (message.turnMs) lines.push('用时：' + aiFormatDuration(message.turnMs), '');
        if (message.reasoning) {
            lines.push('<details>', '<summary>思考过程</summary>', '', message.reasoning, '', '</details>', '');
        }
        if (message.content) lines.push(message.content, '');
        if (Array.isArray(message.toolCalls) && message.toolCalls.length) {
            lines.push('工具调用：' + message.toolCalls.map((call) => call.name).filter(Boolean).join('、'), '');
        }
        if (message.usage && message.usage.totalTokens) {
            lines.push('tokens：输入 ' + (message.usage.promptTokens || 0) + ' · 输出 ' + (message.usage.completionTokens || 0) +
                ' · 合计 ' + message.usage.totalTokens, '');
        }
        if (message.status === 'error' && message.error) lines.push('> 错误：' + message.error, '');
    }

    function buildConversationLogMarkdown(session) {
        const lines = ['# ' + (session.title || 'AI 会话'), ''];
        lines.push('- 会话 ID：`' + session.id + '`');
        lines.push('- 创建时间：' + new Date(Number(session.createdAt) || Date.now()).toLocaleString());
        lines.push('- 最近更新：' + new Date().toLocaleString());
        const profile = config.profiles.find((item) => item.id === session.profileId);
        if (profile) lines.push('- 最后配置：' + profile.name + (profile.model ? '（' + profile.model + '）' : ''));
        lines.push('');
        if (session.summary && session.summary.text) {
            lines.push('## 会话摘要', '', session.summary.text, '');
        }
        const archived = Array.isArray(session.archived) ? session.archived : [];
        if (archived.length) {
            lines.push('## 已归档消息（压缩前，不进入当前上下文）', '');
            for (const message of archived) appendLogMessage(lines, message, '###');
            lines.push('');
        }
        lines.push('## 当前对话', '');
        for (const message of session.messages) appendLogMessage(lines, message, '###');
        if (Array.isArray(session.changes) && session.changes.length) {
            lines.push('', '## 变更记录', '');
            for (const change of session.changes) {
                lines.push('- `' + (change.relPath || change.path) + '` +' + change.added + ' −' + change.removed +
                    ' · ' + new Date(change.time).toLocaleString());
            }
        }
        return lines.join('\n');
    }

    async function saveConversationLog(session) {
        if (!config.logEnabled || !session) return;
        if (!backend.SaveFile || !backend.SaveDataURL) return;
        try {
            const dir = await ensureAILogDir();
            if (!session.logFile) {
                session.logFile = aiSafeFileStem(session.title || 'AI 会话') + '-' + String(session.id).slice(-8) + '.md';
            }
            const archived = Array.isArray(session.archived) ? session.archived : [];
            const messages = archived.concat(session.messages);
            const imagesDir = aiJoinPath(dir, 'images');
            let imagesSaved = false;
            let imagesDirReady = false;
            for (const message of messages) {
                if (!message || message.role !== 'user' || !Array.isArray(message.images)) continue;
                for (let i = 0; i < message.images.length; i++) {
                    const image = aiNormalizeImage(message.images[i]);
                    if (!image) continue;
                    message.images[i] = image;
                    if (!image.logFile && image.data) {
                        if (!imagesDirReady) {
                            if (backend.AIEnsureDir) await backend.AIEnsureDir(imagesDir);
                            imagesDirReady = true;
                        }
                        const name = aiSafeFileStem(String(session.id).slice(-16) + '-' + (image.id || aiNowId('img-')))
                            .replace(/\s+/g, '_').slice(0, 100) + '.' + aiImageExt(image.mime);
                        const rel = 'images/' + name;
                        await backend.SaveDataURL(aiJoinPath(imagesDir, name), aiImageSrc(image));
                        image.logFile = rel;
                        imagesSaved = true;
                    }
                }
            }
            if (imagesSaved) persistSessions();
            const markdown = buildConversationLogMarkdown(session);
            await backend.SaveFile(aiJoinPath(dir, session.logFile), markdown, 'lf', false, 'utf-8');
            session.logSavedAt = Date.now();
            persistSessions();
        } catch (e) {
            if (!logSaveErrorShown) {
                logSaveErrorShown = true;
                flash('对话日志保存失败：' + ((e && e.message) || e), true);
            }
        }
    }

    const logTimers = new Map();
    const logQueues = new Map();

    function queueLogSave(session) {
        if (!config.logEnabled || !session) return;
        const existing = logTimers.get(session.id);
        if (existing) clearTimeout(existing);
        logTimers.set(session.id, setTimeout(() => {
            logTimers.delete(session.id);
            const previous = logQueues.get(session.id) || Promise.resolve();
            const next = previous.catch(() => {}).then(() => saveConversationLog(session));
            logQueues.set(session.id, next);
            next.finally(() => {
                if (logQueues.get(session.id) === next) logQueues.delete(session.id);
            });
        }, 400));
    }

    async function openAILogDir() {
        try {
            const dir = await ensureAILogDir();
            if (backend.ShowInFolder) await backend.ShowInFolder(dir);
            else flash('日志目录：' + dir);
        } catch (e) {
            flash('打开日志目录失败：' + ((e && e.message) || e), true);
        }
    }

    async function showSessionDiagnostics(session) {
        const target = session || currentSession();
        if (!target) return;
        ensureOpen();
        if (!backend.AISessionRead) {
            showNote('当前版本不支持会话诊断。', true);
            return;
        }
        let raw = '';
        let readError = '';
        try {
            raw = await backend.AISessionRead(target.id) || '';
        } catch (e) {
            readError = (e && e.message) || String(e);
        }
        const replay = replaySessionLog(raw);
        const bytes = raw ? new TextEncoder().encode(raw).length : 0;
        const lines = raw ? raw.split('\n').filter((line) => line.trim()).length : 0;
        const counts = new Map();
        for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try {
                const event = JSON.parse(line);
                const type = aiTextOf(event && event.t) || '?';
                counts.set(type, (counts.get(type) || 0) + 1);
            } catch (e) {}
        }
        const eventText = Array.from(counts.entries()).map(([type, count]) => type + '×' + count).join(' · ') || '—';
        let indexLine = '搜索索引：未建立';
        if (backend.AISessionIndexStats) {
            try {
                const stats = await backend.AISessionIndexStats();
                if (!stats.exists) {
                    indexLine = '搜索索引：未建立（首次搜索时创建）';
                } else {
                    indexLine = '搜索索引：' + Number(stats.sessions || 0) + ' 会话 / ' + Number(stats.messages || 0) + ' 条 / 脏 ' +
                        Number(stats.dirty || 0) + ' / ' + Math.round(Number(stats.bytes || 0) / 1024) + ' KB' +
                        (stats.trigram ? ' / trigram' : ' / LIKE');
                }
            } catch (e) {
                indexLine = '搜索索引：不可用（' + ((e && e.message) || e) + '）';
            }
        }
        const text = [
            '会话：' + (target.title || '新会话'),
            'ID：' + target.id,
            '工作区：' + (target.workspace || '（未绑定）'),
            '存储模式：' + effectiveStorageMode(),
            '正文：' + bytes + ' 字节 / ' + lines + ' 行',
            '事件：' + eventText,
            '重放：live ' + replay.messages.length + ' / archived ' + replay.archived.length +
                ' / issue ' + replay.issues + ' / 撕裂尾 ' + (replay.torn ? '是' : '否'),
            '内存：live ' + (target._stub ? '(未载入)' : (target.messages || []).length) + ' / archived ' +
                (target._stub ? '(未载入)' : (target.archived || []).length) +
                ' / mids ' + ((target._mids || []).length + '/' + (target._archivedMids || []).length),
            '摘要：' + (target.summary && target.summary.text ? target.summary.text.length + ' 字符' : '无'),
            '加载错误：' + (readError || target._loadError || '无'),
            indexLine,
        ].join('\n');
        const pre = dialogNode('pre', 'ai-diagnostic-pre', text);
        openAIDialog('会话数据诊断', [pre], [
            dialogButton('重建搜索索引', 'dlg-btn', async () => {
                if (!backend.AISessionReindex) return;
                try {
                    const count = await backend.AISessionReindex();
                    flash('搜索索引已重建：' + count + ' 个会话');
                } catch (e) {
                    flash('重建索引失败：' + ((e && e.message) || e), true);
                }
            }),
            dialogButton('复制诊断信息', 'dlg-btn', () => {
                Promise.resolve(copyText(text)).then(() => flash('诊断信息已复制')).catch(() => flash('复制失败', true));
            }),
            dialogButton('关闭', 'dlg-btn primary', closeAIDialog),
        ]);
    }

    // ---------- 管理对话框 / 提示词 / 记忆 / 技能 ----------

    // 从设置窗打开记忆 / 技能管理时，把对话框临时挂到 body 顶层（盖在设置窗之上），
    // 不再为了显示对话框而关闭设置窗；关闭后放回 AI 面板原位。
    let dialogOnTop = false;
    let dialogHome = null;

    function attachDialogTop() {
        if (!el.dialog || dialogOnTop) return;
        if (!dialogHome) dialogHome = el.dialog.parentElement;
        dialogOnTop = true;
        el.dialog.classList.add('ai-dialog-top');
        document.body.appendChild(el.dialog);
    }

    function detachDialogTop() {
        if (!el.dialog || !dialogOnTop) return;
        dialogOnTop = false;
        el.dialog.classList.remove('ai-dialog-top');
        if (dialogHome) dialogHome.appendChild(el.dialog);
    }

    function openAIDialog(title, bodyNodes, footerNodes, options) {
        if (!el.dialog) return;
        if (floatWindow && floatCollapsed) setFloatCollapsed(false);
        if (options && options.top) attachDialogTop();
        else if (dialogOnTop) detachDialogTop();
        if (options && options.top) attachDialogTop();
        else if (dialogOnTop) detachDialogTop();
        el.dialog.classList.remove('ai-permission-dialog');
        // 宽弹窗：内容密集的编辑器（生成条目等）在 560px 里太挤，调用方传 options.wide 加宽
        if (el.dialogCard) el.dialogCard.classList.toggle('ai-dialog-card-wide', !!(options && options.wide));
        if (el.dialogTitle) el.dialogTitle.textContent = title || '';
        if (el.dialogBody) {
            el.dialogBody.innerHTML = '';
            for (const node of bodyNodes || []) if (node) el.dialogBody.appendChild(node);
        }
        if (el.dialogFoot) {
            el.dialogFoot.innerHTML = '';
            for (const node of footerNodes || []) if (node) el.dialogFoot.appendChild(node);
        }
        el.dialog.classList.remove('hidden');
    }

    function closeAIDialog() {
        if (!el.dialog) return;
        el.dialog.classList.remove('ai-permission-dialog');
        el.dialog.classList.add('hidden');
        if (el.dialogCard) el.dialogCard.classList.remove('ai-dialog-card-wide');
        if (el.dialogBody) el.dialogBody.innerHTML = '';
        if (el.dialogFoot) el.dialogFoot.innerHTML = '';
        detachDialogTop();
    }

    function dialogNode(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function dialogButton(label, className, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className || 'dlg-btn';
        button.textContent = label;
        button.addEventListener('click', onClick);
        return button;
    }

    function injectionStatusText(meta) {
        if (!meta) return '注入状态：—';
        const agents = meta.agents && meta.agents.loaded ? '✓ ' + meta.agents.chars + ' 字符' : '—';
        const memory = meta.memory && meta.memory.loaded ? '✓ ' + meta.memory.mode + ' ' + meta.memory.chars + ' 字符' : '—';
        const workspace = meta.workspace && meta.workspace.loaded ? '✓ ' + meta.workspace.files + ' 个文件' : '—';
        const skills = meta.skills ? meta.skills.count + ' 个' : '0 个';
        return '注入状态：AGENTS.md ' + agents + ' · 记忆 ' + memory + ' · 技能 ' + skills + ' · 上下文 ' + workspace;
    }

    // 提示词 / 记忆 / 技能管理对话框（阶段 3 拆出：ai-manage-dialogs.js；config 经 getConfig() 读）
    const dialogsMod = createAIManageDialogs({
        el,
        flash,
        askConfirm,
        backend,
        openPath,
        openSettings,
        showNote,
        currentSession,
        persistSessions,
        saveAIConfig,
        positionOverlays,
        updateContextCount,
        buildApiMessages,
        assembleSystemContext,
        effectiveSystemPrompt,
        contextWindowOf,
        toolsTokenEstimate,
        promptById,
        promptTextOf,
        injectionStatusText,
        dialogNode,
        dialogButton,
        openAIDialog,
        closeAIDialog,
        resolveMemoryDir,
        getAIAppDir,
        skillSourceLabel,
        listSkillsRaw,
        invalidateSkillsCache,
        aiNormalizePath,
        aiJoinPath,
        aiPathDir,
        MEMORY_NAME_RULE,
        getConfig: () => config,
        setMemoryFallbackNotified: (value) => { memoryFallbackNotified = value; },
        getAttachments: (...args) => getAttachments(...args),
    });
    const showPromptDialog = (...args) => dialogsMod.showPromptDialog(...args);
    const showMemoryDialog = (...args) => dialogsMod.showMemoryDialog(...args);
    const createAppSkill = (...args) => dialogsMod.createAppSkill(...args);
    const showSkillsDialog = (...args) => dialogsMod.showSkillsDialog(...args);
    const updateCtxBanner = (...args) => dialogsMod.updateCtxBanner(...args);
    const showArchivedDialog = (...args) => dialogsMod.showArchivedDialog(...args);
    const estimateMessageTokens = (...args) => dialogsMod.estimateMessageTokens(...args);
    const estimateApiMessagesTokens = (...args) => dialogsMod.estimateApiMessagesTokens(...args);
    const estimateCurrentTokens = (...args) => dialogsMod.estimateCurrentTokens(...args);

    // 压缩转录与请求组装已归位 ai-compact.js（主会话与子代理共用一份）
    function compactTranscript(session) {
        return compactTranscriptOf(session);
    }

    // options.auto = true：自动压缩。不弹窗打断、用状态栏提示，且不要求用户在当前会话。
    function startCompact(options) {
        const auto = !!(options && options.auto);
        const notify = (text, isError) => {
            if (auto) {
                try {
                    if (typeof flash === 'function') flash(text, isError);
                } catch (e) {}
            } else {
                showNote(text, isError);
            }
        };
        if (anyStreaming()) {
            if (!auto) notify('请先停止当前生成，再压缩上下文。', true);
            return false;
        }
        if (oneShot) {
            if (!auto) notify('已有压缩任务在进行中。', true);
            return false;
        }
        const session = (options && options.session) || currentSession();
        const profile = profileOf(session);
        if (!session || !profile) {
            if (!auto) notify('请先配置 AI 并创建会话。', true);
            return false;
        }
        if (session.archivedAt) {
            if (!auto) notify('该会话已归档，请先取消归档再压缩。', true);
            return false;
        }
        if (session.messages.length <= 6) {
            if (!auto) notify('消息太少（≤6 条），无需压缩。');
            return false;
        }
        if (!backend.AISendChat) {
            notify('当前版本不支持压缩。', true);
            return false;
        }
        const id = session.id + '#compact-' + Date.now() + '-' + (++compactSeq);
        // Codex 风格压缩焦点指令：/compact 保住补丁库方案 —— 摘要器按指令决定取舍
        const instruction = aiTextOf(options && options.instruction).slice(0, 500);
        // 记下触发快照：压缩会砍掉几十上百条消息，事后必须能回答「凭什么压的」。
        const triggerWindow = contextWindowOf(session);
        const triggerThreshold = compactThresholdOf(config);
        const triggerEstimate = estimateCurrentTokens().tokens;
        const triggerEntry = entryOf(session);
        oneShot = {
            id, kind: 'compact', sessionId: session.id, buffer: '', startedAt: Date.now(), auto,
            trigger: {
                kind: auto ? 'auto' : 'manual',
                windowSize: triggerWindow,
                threshold: triggerThreshold,
                estimate: triggerEstimate,
                profileName: profile.name || '',
                model: triggerEntry && triggerEntry.model ? triggerEntry.model : '',
                instruction: instruction || '',
            },
        };
        notify(auto ? '上下文接近上限，正在自动压缩…' : '正在压缩上下文…（可点停止取消）');
        setStreamingUI(true);
        updateSendState();
        const messages = buildCompactMessages(session, AI_COMPACT_SYSTEM_PROMPT, instruction);
        Promise.resolve(backend.AISendChat(id, configForProfile(profile, entryOf(session)), messages, [], config.retryMax)).catch((e) => {
            if (!oneShot || oneShot.id !== id) return;
            const message = (e && e.message) || String(e);
            const wasAuto = oneShot.auto;
            oneShot = null;
            setStreamingUI(false);
            updateSendState();
            if (wasAuto) {
                try {
                    if (typeof flash === 'function') flash('自动压缩失败：' + message, true);
                } catch (err) {}
            } else {
                showNote('压缩失败：' + message, true);
            }
        });
        return true;
    }

    // 自动压缩：上下文占用达到 autoCompactThreshold 时触发一次 /compact。
    function maybeAutoCompact(session) {
        const target = session || currentSession();
        if (!target) return false;
        if (!config.autoCompact) return false;
        if (anyStreaming() || oneShot) return false;
        if (target.archivedAt) return false;
        // 用户正在被提问 / 计划待批准时不要抢走 composer
        if (currentPendingAskEntry() || planApprovalMessage(target)) return false;
        if ((target.messages || []).length <= 6) return false;
        const profile = profileOf(target);
        if (!profile) return false;
        const windowSize = contextWindowOf(target);
        if (windowSize <= 0) return false;
        const threshold = compactThresholdOf(config);
        const bundle = promptTextOf(target.id);
        const apiMessages = buildApiMessages(target, null, bundle);
        let tokens = estimateApiMessagesTokens(apiMessages);
        tokens += toolsTokenEstimate(target);
        if (tokens < windowSize * threshold) return false;
        const c = autoCompactCount.get(target.id) || 0;
        if (c >= 2) {
            const now = Date.now();
            if (now - autoCompactWarnedAt > 60000) {
                autoCompactWarnedAt = now;
                try {
                    if (typeof flash === 'function') {
                        flash('上下文已连续自动压缩 ' + c + ' 次仍接近上限，建议开启新会话或减少附件', true);
                    }
                } catch (e) {}
            }
            return false;
        }
        autoCompactCount.set(target.id, c + 1);
        return startCompact({auto: true, session: target});
    }

    function finishCompact(payload) {
        const current = oneShot;
        if (!current || current.kind !== 'compact') return;
        const session = sessionById(current.sessionId);
        oneShot = null;
        setStreamingUI(false);
        updateSendState();
        if (!session) return;
        const viewed = !!(currentSession() && currentSession().id === session.id);
        const text = String(current.buffer || '').trim();
        if (!text) {
            if (viewed) showNote('压缩失败：模型没有返回摘要。', true);
            else notifyDesktop({kind: 'error', title: '自动压缩失败', body: (session.title || '会话') + ' · 模型没有返回摘要', sessionId: session.id});
            return;
        }
        // cutoff / summary 形状 / 裁剪内核在 ai-compact.js（子代理压缩共用同一份）
        const cutoff = computeCompactCutoff(session.messages, COMPACT_KEEP_TAIL);
        const archived = session.messages.slice(0, cutoff);
        const summary = buildCompactSummary(text, cutoff, current.trigger, archived.length + session.messages.length);
        // 归档事件要在裁剪内存之前登记：内部捕获的是裁剪前的消息快照。
        if (sessionUseDisk()) sessionStore.archiveSession(session, cutoff, summary);
        applyCompactToSession(session, summary, cutoff);
        pushArchivedMessages(session, archived);
        persistSessions();
        queueLogSave(session);
        if (isOpen() && currentSession() === session) renderMessages(true);
        if (viewed) {
            updateContextCount();
            updateComposerTakeover(true);
            showNote('已压缩上下文：摘要 ' + text.length + ' 字符，保留最近 ' + session.messages.length + ' 条，归档 ' + archived.length + ' 条。');
        }
        flushMessageQueue(session.id);
    }

    function cancelOneShot() {
        const current = oneShot;
        if (!current) return;
        oneShot = null;
        try {
            if (backend.AIStop) backend.AIStop(current.id);
        } catch (e) {}
        setStreamingUI(false);
        updateSendState();
        showNote('已取消压缩。');
    }

    async function runInitAgentsMd() {
        if (syncStreamView() || compactOf((currentSession() || {}).id)) {
            showNote('请先停止当前生成，再生成 AGENTS.md。', true);
            return;
        }
        const project = aiProjectRoot();
        if (!project) {
            showNote('没有工作区，无法生成 AGENTS.md。', true);
            return;
        }
        const path = aiJoinPath(project, 'AGENTS.md');
        try {
            const read = await readTextFile(path, 1024);
            if (read && read.text != null) {
                showNote('AGENTS.md 已存在：' + path + '\n如需修改请直接在编辑器中打开。', true);
                return;
            }
        } catch (e) {
            // 文件不存在时继续创建。
        }
        const session = currentSession();
        if (!session) return;
        const content = [
            '# AGENTS.md',
            '',
            '## 项目概述',
            '（一句话说明这个项目/目录是做什么的。）',
            '',
            '## 目录结构',
            '- `src/`：',
            '- `docs/`：',
            '',
            '## 约定',
            '- 回答使用中文；代码注明语言。',
            '- 修改文件前先读取确认；不要改动与任务无关的内容。',
            '- 新增依赖或改变目录结构时说明原因。',
            '',
            '## 常用命令',
            '```bash',
            '# 构建 / 测试命令',
            '```',
        ].join('\n');
        const ops = computeLineDiff('', content);
        const stats = diffStats(ops);
        const preview = buildDiffPreview(ops);
        const callId = aiNowId('call_init_');
        // /init 是用户主动发起的回合：必须带 user 消息开新组，否则 groupTurns 会把它
        // 并进上一回合（组尾是 tool 消息 → turnFinalItem 为空 → 显示「未完成」）。
        session.messages.push({
            role: 'user',
            content: '/init（生成 AGENTS.md 模板）',
            ts: Date.now(),
        });
        const assistantMessage = {
            role: 'assistant',
            content: '',
            reasoning: '',
            thinkingSignature: '',
            toolCalls: [{id: callId, name: 'write_file', arguments: JSON.stringify({path: 'AGENTS.md'})}],
            model: '',
            status: 'done',
            ts: Date.now(),
        };
        const toolMessage = {
            role: 'tool',
            toolCallId: callId,
            name: 'write_file',
            arguments: JSON.stringify({path: 'AGENTS.md'}),
            content: '',
            status: 'pending',
            ts: Date.now(),
        };
        session.messages.push(assistantMessage, toolMessage);
        if (isOpen() && currentSession() === session) renderMessages(true);
        const result = await applyWorkspaceWrite(session, toolMessage, {
            tool: 'write_file',
            path,
            relPath: 'AGENTS.md',
            content,
            eol: 'lf',
            hasBom: false,
            enc: 'utf-8',
            newFile: true,
            added: stats.added,
            removed: stats.removed,
            truncated: preview.truncated,
            diff: preview.lines,
        });
        toolMessage.status = 'done';
        toolMessage.content = result;
        persistSessions();
        queueLogSave(session);
        if (isOpen() && currentSession() === session) renderMessages(true);
    }

    // 斜杠命令（阶段 3 拆出：ai-slash.js；slashState 与输入区共享同一对象）
    const slashMod = createAISlash({
        el,
        slashState,
        positionOverlays,
        // 惰性转发：两别名随输入区域构造于本模块之后
        resizeInput: (...args) => resizeInput(...args),
        updateSendState,
        contextSummaryText,
        startCompact,
        clearCurrentSession,
        showNote,
        showModelPicker,
        exportSession,
        showMemoryDialog,
        openSettings,
        attachSkillByName: (...args) => attachSkillByName(...args),
        showSkillsDialog,
        handlePlanCommand,
        runInitAgentsMd,
    });
    const hideSlash = () => slashMod.hideSlash();
    const updateSlash = () => slashMod.updateSlash();
    const runSlashCommand = (command) => slashMod.runSlashCommand(command);
    const handleSlashText = (text) => slashMod.handleSlashText(text);

    function clearCurrentSession() {
        const session = currentSession();
        if (!session) return;
        if (streamOf(session.id) || compactOf(session.id)) {
            showNote('请先停止当前生成，再清空会话。', true);
            return;
        }
        askConfirm('清空当前会话的全部消息？', () => {
            // 正文没载入时既不能清（内存里是空的）也不能重置日志（会被护栏拦下）
            if (session._stub) {
                showNote('这个会话还没载入，稍等一下再试', true);
                return;
            }
            session.messages = [];
            commandApprovalRules.delete(session.id);
            pendingModelSwitches.delete(session.id);
            session.summary = null;
            session.archived = [];
            archivedFlowOpen.delete(session.id);
            // 清空要真正抹掉磁盘上的历史，而不是追加 reset 事件继续留着明文。
            if (sessionUseDisk()) sessionStore.resetSession(session);
            session._loadError = '';
            session._mids = [];
            session._archivedMids = [];
            persistSessions();
            renderMessages();
            updateComposerState();
        }, '清空', '清空会话');
    }

    // 后台会话（没被查看）的流事件不要往当前消息区塞提示，否则会串台。
    function noteForSession(sessionId, text, isError) {
        const viewing = currentSession();
        if (viewing && sessionId && viewing.id !== sessionId) return;
        showNote(text, isError);
    }

    function showNote(text, isError) {
        if (!el.messages) return;
        // 用户已上滚阅读时不强制拉底（判定胶囊/系统提示出现不该劫持滚动位置）：贴底态才跟随。
        // 判贴底只看 stickBottom——它已按用户手势维护，布局变化（任务清单/审批卡出现）不算上翻
        const stick = stickBottom;
        const empty = el.messages.querySelector('.ai-empty');
        if (empty) empty.remove();
        const note = document.createElement('div');
        note.className = 'ai-note' + (isError ? ' error' : '');
        note.textContent = text;
        note.dataset.aiNote = String(++noteSeq);
        // 流式状态条（看板娘条）钉在消息区最底：提示插到它之前，别让胶囊掉到看板娘下面
        const bar = el.messages.querySelector('.ai-streaming-bar');
        if (bar) el.messages.insertBefore(note, bar);
        else el.messages.appendChild(note);
        while (el.messages.querySelectorAll('.ai-note').length > 6) {
            const first = el.messages.querySelector('.ai-note');
            if (first) first.remove();
        }
        if (stick) scrollToBottom(true);
    }

    // ---------- 显示方式与几何 ----------

    function normalizeFloatMode(value) {
        return value === 'fullscreen' ? 'fullscreen' : 'dock';
    }

    // 停靠模式自适应：内容区没有打开文件时占满内容区，打开文件后回到分屏宽度。
    function refreshDockFill() {
        if (floatWindow || !dockParent) return;
        const ctx = getWorkspaceContext() || {};
        const fill = mode === 'dock' && isOpen() && !ctx.activeFile;
        dockParent.classList.toggle('ai-dock-fill', fill);
        if (mode !== 'dock') return;
        if (fill) {
            panel.style.width = '';
        } else {
            const width = aiClamp(Number(settings.aiPanelWidth) || 380, 280, Math.max(640, Math.round(window.innerWidth * 0.6)));
            settings.aiPanelWidth = width;
            panel.style.width = width + 'px';
        }
        positionOverlays();
    }

    // 面板形态唯一的落地点，只由用户手势触发（面板 […] 菜单 / 设置页 / 视图菜单）。
    function applyMode(nextMode, persist) {
        mode = normalizeFloatMode(nextMode);
        if (persist) {
            settings.aiFloatMode = mode;
            saveSettings();
        }
        panel.classList.remove('ai-dock', 'ai-snap', 'ai-float', 'ai-maximized', 'ai-fullscreen');
        panel.style.left = '';
        panel.style.top = '';
        panel.style.right = '';
        panel.style.bottom = '';
        panel.style.width = '';
        panel.style.height = '';
        if (mode === 'fullscreen') {
            if (dockParent) dockParent.classList.remove('ai-dock-fill');
            if (overlayParent && panel.parentElement !== overlayParent) overlayParent.appendChild(panel);
            panel.classList.add('ai-fullscreen');
        } else {
            if (dockParent && panel.parentElement !== dockParent) dockParent.appendChild(panel);
            panel.classList.add('ai-dock');
        }
        refreshDockFill();
        positionOverlays();
        notifyStructure();
        setTimeout(() => {
            onLayout();
            if (stickBottom) scrollToBottom(false);
            else updateScrollButton();
        }, 0);
    }

    function openFloatWindow() {
        if (floatWindow) return;
        if (!backend.OpenAIFloatWindow) {
            flash('当前版本不支持独立窗口', true);
            return;
        }
        const root = getScopeRoot() || '';
        Promise.resolve(backend.OpenAIFloatWindow(root)).then(() => {
            flash('已在独立窗口打开 AI 助手');
            open(false);
        }).catch((e) => flash('打开独立窗口失败：' + ((e && e.message) || e), true));
    }

    function setMode(next) {
        if (next === 'float') {
            openFloatWindow();
            return;
        }
        if (next === 'snap') next = 'dock';
        if (!['dock', 'fullscreen'].includes(next)) return;
        applyMode(next, true);
        if (isOpen()) requestAnimationFrame(() => el.input && el.input.focus());
    }

    // ---------- 悬浮窗专用：全屏 / 收起（只保留标题栏） ----------

    async function toggleFloatFullscreen() {
        if (!floatWindow) return;
        const rt = window.runtime || {};
        if (!rt.WindowFullscreen) return;
        let full = false;
        try {
            if (rt.WindowIsFullscreen) full = !!(await rt.WindowIsFullscreen());
        } catch (e) {}
        try {
            if (full) {
                if (rt.WindowUnfullscreen) rt.WindowUnfullscreen();
            } else {
                rt.WindowFullscreen();
            }
            if (el.floatFullscreen) el.floatFullscreen.dataset.tip = full ? '全屏（当前窗口）' : '退出全屏';
        } catch (e) {}
    }

    function setFloatCollapsed(next) {
        if (!floatWindow) return;
        const rt = window.runtime || {};
        const collapsed = !!next;
        if (collapsed === floatCollapsed) return;
        if (collapsed) {
            const apply = (size) => {
                const w = size && (size.w || size.width);
                const h = size && (size.h || size.height);
                if (w && h) floatSizeBeforeCollapse = {w, h};
                const headH = Math.max(40, Math.ceil((el.head && el.head.getBoundingClientRect().height) || 44));
                if (rt.WindowSetMinSize) rt.WindowSetMinSize(300, headH);
                if (rt.WindowSetSize) rt.WindowSetSize(w || window.outerWidth || 560, headH);
            };
            floatCollapsed = true;
            document.body.classList.add('ai-float-collapsed');
            if (el.floatCollapse) {
                el.floatCollapse.dataset.tip = '展开（恢复面板）';
                const path = el.floatCollapse.querySelector('path');
                if (path) path.setAttribute('d', 'M4.2 6 8 9.8 11.8 6');
            }
            if (rt.WindowGetSize) Promise.resolve(rt.WindowGetSize()).then(apply).catch(() => apply(null));
            else apply(null);
            return;
        }
        floatCollapsed = false;
        document.body.classList.remove('ai-float-collapsed');
        if (el.floatCollapse) {
            el.floatCollapse.dataset.tip = '收起（只保留标题栏）';
            const path = el.floatCollapse.querySelector('path');
            if (path) path.setAttribute('d', 'M4.2 10 8 6.2 11.8 10');
        }
        if (rt.WindowSetMinSize) rt.WindowSetMinSize(360, 480);
        const size = floatSizeBeforeCollapse || {w: window.outerWidth || 560, h: window.outerHeight || 760};
        if (rt.WindowSetSize) rt.WindowSetSize(size.w, size.h);
        floatSizeBeforeCollapse = null;
    }

    function applyLoadedSessions(next) {
        if (!next || !next.length) return;
        // 生成中绝不替换 sessions 数组：新会话的 user/占位 assistant 只存在内存里（磁盘可能还是空会话），
        // 替换后 stream 指向被丢弃的对象，后续 ai-chunk/ai-done 全部落空，消息丢失。
        // 典型触发：定时任务 open() 触发的磁盘重读恰好在 submitText 之后完成。
        if (anyStreaming() || oneShot) return;
        // 磁盘可能落后于内存（上一轮收尾追加的消息还在写盘队列里）：此时用磁盘覆盖内存
        // 会让「本轮文件改动汇总卡」这类轮尾追加的内容在重开面板后凭空消失。
        // 只对当前会话做保护，且仅在内存消息更全时保留内存版本，并把差异补写回磁盘。
        const active = currentSession();
        const diskActive = active ? next.find((session) => session.id === active.id) : null;
        if (diskActive && Array.isArray(active.messages) && active.messages.length > diskActive.messages.length) {
            diskActive.messages = active.messages;
            diskActive.archived = active.archived;
            diskActive._mids = active._mids;
            diskActive._archivedMids = active._archivedMids;
            diskActive.changes = active.changes;
            diskActive.todos = active.todos;
            diskActive.summary = active.summary;
            // 让下一次持久化整份重写，把内存里领先磁盘的消息补齐。
            diskActive._needsRewrite = true;
        }
        sessions = next;
        if (!sessions.some((session) => session.id === config.activeSessionId)) {
            config.activeSessionId = sessions[0] ? sessions[0].id : '';
        }
        // 磁盘重读会把别处写下的「已完成未查看」带回来，而用户此刻正看着这个会话：
        // 不清掉就会出现「明明在看却一直挂绿点，点一下才恢复」的现象。
        if (isOpen()) {
            const viewing = sessions.find((session) => session.id === config.activeSessionId);
            if (viewing && viewing.unread) viewing.unread = '';
        }
        renderSessionList();
        renderProfileSelect();
        renderMessages(true);
        updateComposerState();
        refreshSystemPromptEstimate(true);
        // 上一步保留了内存里更全的会话时，立刻补写磁盘，避免下次读盘又回到旧内容。
        if (diskActive && diskActive._needsRewrite) persistSessions();
    }

    // 磁盘 meta 与内存是否一致：只比「列表看得见」的那些字段 + 增删。
    // 一致就什么都不用读——否则每次打开面板都要把那几十个会话的正文全量重放一遍，
    // 懒加载等于白做。
    function sessionMetaMatches(meta, session) {
        if (!meta || !session) return false;
        if (aiTextOf(meta.title) !== aiTextOf(session.title)) return false;
        if ((Number(meta.updatedAt) || 0) !== (Number(session.updatedAt) || 0)) return false;
        if ((Number(meta.archivedAt) || 0) !== (Number(session.archivedAt) || 0)) return false;
        if (!!meta.pinned !== !!session.pinned) return false;
        const unread = meta.unread === 'error' ? 'error' : (meta.unread === 'done' || meta.unread === true ? 'done' : '');
        if (unread !== (session.unread || '')) return false;
        if (aiTextOf(meta.workspace) !== aiTextOf(session.workspace)) return false;
        if ((Number(meta.messageCount) || 0) !== sessionMessageCount(session)) return false;
        return true;
    }

    function metasDiffer(metas) {
        const diskIds = new Set();
        for (const meta of metas || []) {
            diskIds.add(meta.id);
            const session = sessions.find((item) => item.id === meta.id);
            // 两边都有：只看列表看得见的字段（内存里正文可能领先磁盘，那不是「变了」）
            if (session && !sessionMetaMatches(meta, session)) return true;
        }
        for (const session of sessions) {
            if (diskIds.has(session.id)) continue;
            // 磁盘上没有：还没落过盘的新会话不算差异；其余说明别处删了它，得重读
            if (!session._unsaved) return true;
        }
        return false;
    }

    function reloadStoredAIState() {
        if (floatWindow) return;
        if (!configUseDisk()) {
            config = loadAIConfig();
        } else if (configLoaded) {
            reloadAIConfigFromDisk();
        }
        if (effectiveStorageMode() === 'legacy') {
            applyLoadedSessions(loadAISessions());
            return;
        }
        if (!sessionsLoaded) return; // 首次磁盘加载还没完成，bootstrap 结束后会自行刷新
        // 磁盘是唯一真源：打开面板时按节流重读，顺便合并其他窗口的写入。
        if (Date.now() - lastDiskLoadAt < 2000) {
            renderSessionList();
            return;
        }
        if (anyStreaming() || oneShot || pendingEdit) return;
        // 先只读 meta（一次 IPC）：没有变化就到此为止；只有真变了（别的窗口写了东西 /
        // 会话被增删）才走全量读+合并那条重路。
        sessionStore.loadMetas()
            .then((metas) => {
                lastDiskLoadAt = Date.now();
                if (!metasDiffer(metas)) {
                    renderSessionList();
                    return null;
                }
                return sessionStore.flush()
                    .then(() => sessionStore.loadAll((raw) => normalizeSession(raw, 0)))
                    .then((loaded) => {
                        if (loaded.length) applyLoadedSessions(loaded);
                        return null;
                    });
            })
            .catch(() => {});
    }

    function open(force) {
        const show = floatWindow ? true : (typeof force === 'boolean' ? force : !isOpen());
        if (show) {
            if (!floatWindow) {
                if (anyStreaming() || oneShot) renderSessionList();
                else reloadStoredAIState();
            } else if (!anyStreaming()) {
                // 浮窗：只重读配置（不动会话），主窗口改完设定后切回来就能拿到新名字 / 新风格
                reloadAIConfigFromDisk();
            }
            if (window.innerWidth < 900 && settings.showSidebar && typeof opts.collapseSidebar === 'function') {
                opts.collapseSidebar();
            }
            panel.classList.remove('hidden');
            applyMode(mode, false);
            // 面板重新可见时，当前会话视为已查看。
            clearSessionUnread(currentSession());
            renderSessionList();
            renderProfileSelect();
            stickBottom = true;
            // 启动后几秒内点开面板时可能还在读盘：renderMessages 会自己退成加载态
            renderMessages(false);
            updateComposerState();
            refreshSystemPromptEstimate();
            positionOverlays();
            refreshMemoryPath();
            refreshGitEntry();
            setTimeout(() => {
                if (el.input) el.input.focus();
                if (stickBottom) scrollToBottom(false);
            }, 0);
        } else {
            panel.classList.add('hidden');
            if (dockParent) dockParent.classList.remove('ai-dock-fill');
            hideSlash();
            hideCtxPop();
            closeTurnUsagePop();
            closeAIDialog();
            closeHostLightbox(panel);
        }
        if (!floatWindow) {
            settings.aiPanelOpen = show;
            saveSettings();
        }
        updateEntryButtons();
        updateContextCount();
        onLayout();
        notifyStructure();
    }

    function toggle(force) {
        open(force);
    }

    // ---------- 停靠分屏的左右互换 ----------

    function panelSide() {
        return settings.aiPanelSide === 'left' ? 'left' : 'right';
    }

    function applyPanelSide() {
        if (dockParent) dockParent.classList.toggle('ai-left', panelSide() === 'left');
        if (el.sideBtn) {
            el.sideBtn.dataset.tip = panelSide() === 'left'
                ? 'AI 面板在左侧，点击换到右侧'
                : 'AI 面板在右侧，点击换到左侧';
        }
    }

    function togglePanelSide() {
        if (floatWindow) return;
        settings.aiPanelSide = panelSide() === 'left' ? 'right' : 'left';
        applyPanelSide();
        saveSettings();
        onLayout();
        flash('AI 面板已移到' + (panelSide() === 'left' ? '左侧' : '右侧'));
    }

    function startResize(e, dir) {
        if (floatWindow || mode !== 'dock') return;
        if (dir !== 'l' && !(dir === 'r' && panelSide() === 'left')) return;
        if (dockParent && dockParent.classList.contains('ai-dock-fill')) return;
        const rect = panel.getBoundingClientRect();
        drag = {
            kind: 'resize',
            pointerId: e.pointerId,
            startX: e.clientX,
            startWidth: rect.width,
        };
        const target = e.currentTarget;
        if (target && target.setPointerCapture) {
            try { target.setPointerCapture(e.pointerId); } catch (err) {}
        }
        setDragCursor('ew');
        document.body.style.userSelect = 'none';
        e.preventDefault();
        e.stopPropagation();
    }

    function moveResize(e) {
        if (!drag || drag.kind !== 'resize') return;
        // 面板在右：向左拖变宽（-dx）；面板在左：向右拖变宽（+dx）。
        // 上限不写死：大屏分屏用 AI 面板常要拖到半屏宽（此前硬顶 640px 被卡）——
        // 给视口 60%，至少 640 保底小窗体验。
        const delta = e.clientX - drag.startX;
        const maxWidth = Math.max(640, Math.round(window.innerWidth * 0.6));
        const width = panelSide() === 'left'
            ? aiClamp(drag.startWidth + delta, 280, maxWidth)
            : aiClamp(drag.startWidth - delta, 280, maxWidth);
        panel.style.width = width + 'px';
    }

    function endResize() {
        if (!drag) return;
        if (drag.kind === 'resize') {
            settings.aiPanelWidth = aiClamp(panel.offsetWidth, 280, Math.max(640, Math.round(window.innerWidth * 0.6)));
            saveSettings();
            onLayout();
        }
        drag = null;
        setDragCursor(null);
        document.body.style.userSelect = '';
    }

    function onWindowResize() {
        if (!isOpen()) return;
        if (mode === 'dock' && !floatWindow) applyMode('dock', false);
    }

    // ---------- 设置页 ----------


    // ---------- 绑定面板交互 ----------


    // 悬浮窗强制退出：优先 ForceClose（后端置 forceClose 后 Quit，不受 dirty/aiRunning
    // 的 beforeClose 拦截影响）；绑定不可用时退回 runtime.Quit 兜底。
    function forceQuitFloatWindow() {
        try {
            if (backend.ForceClose) {
                backend.ForceClose();
                return;
            }
        } catch (e) {}
        try {
            if (window.runtime && window.runtime.Quit) window.runtime.Quit();
        } catch (e) {}
    }

    function bindPanelInteractions() {
        for (const button of [activityButton, toolbarButton]) {
            if (button) button.addEventListener('click', () => toggle());
        }
        if (el.close) el.close.addEventListener('click', () => {
            if (floatWindow) {
                // 悬浮窗关闭不走 runtime.Quit：它会经过 Go 的 beforeClose，AI 运行中会被
                // 静默拦下（只 emit confirm-close 再弹主对话框，收起态下还看不见），窗口
                // 就像空壳一样点不动。这里自行判定：空闲直接 ForceClose；有进行中的回合
                // 先弹面板内确认框，用户裁定后再 ForceClose。
                if (!(streams.size > 0 || !!oneShot) || !el.dialog) {
                    forceQuitFloatWindow();
                    return;
                }
                const body = dialogNode('div', 'ai-note', 'AI 会话正在进行中，关闭窗口会中断当前任务。');
                const ok = dialogButton('中断并关闭', 'dlg-btn primary', () => {
                    closeAIDialog();
                    forceQuitFloatWindow();
                });
                const cancel = dialogButton('取消', 'dlg-btn', () => closeAIDialog());
                openAIDialog('关闭悬浮窗', [body], [cancel, ok]);
                return;
            }
            open(false);
        });
        if (el.sideBtn) el.sideBtn.addEventListener('click', togglePanelSide);
        if (el.floatFullscreen) el.floatFullscreen.addEventListener('click', toggleFloatFullscreen);
        if (el.floatCollapse) el.floatCollapse.addEventListener('click', () => setFloatCollapsed(!floatCollapsed));
        if (el.newBtn) el.newBtn.addEventListener('click', () => newSession());
        if (el.gitBtn) el.gitBtn.addEventListener('click', showGitMenu);
        if (sessionActionNewBtn) sessionActionNewBtn.addEventListener('click', () => {
            ensureOpen();
            newSession();
        });
        if (sessionActionAutoBtn) sessionActionAutoBtn.addEventListener('click', () => {
            ensureOpen();
            scheduleMod.openAutomationDialog();
        });
        // 投递（侧栏按钮 / 列表头部图标同一份）：先选目标、内容自己写。
        // 对话框挂在面板 DOM 里，所以与「自动化」一样先确保面板打开。
        if (sessionActionSendBtn) sessionActionSendBtn.addEventListener('click', () => {
            ensureOpen();
            openDeliverComposer();
        });
        if (sessionToolSendBtn) sessionToolSendBtn.addEventListener('click', () => {
            ensureOpen();
            openDeliverComposer();
        });
        if (sessionMoreBtn) sessionMoreBtn.addEventListener('click', () => showSessionListMenu());
        // 会话搜索框已删：搜索入口在头部放大镜（开全局搜索并只勾选「AI 会话」分类）
        if (el.headSearch) el.headSearch.addEventListener('click', () => {
            ensureOpen();
            if (typeof opts.onHeadSearch === 'function') opts.onHeadSearch();
        });
        if (el.moreBtn) el.moreBtn.addEventListener('click', showMoreMenu);
        if (el.attachBtn) el.attachBtn.addEventListener('click', showAttachMenu);
        if (el.permission) el.permission.addEventListener('click', showPermissionMenu);
        if (el.plan) el.plan.addEventListener('click', togglePlanMode);
        if (el.modelChip) el.modelChip.addEventListener('click', showModelPicker);
        if (el.promptsBtn) el.promptsBtn.addEventListener('click', () => showPromptDialog());
        if (el.memoryBtn) el.memoryBtn.addEventListener('click', () => showMemoryDialog());
        if (el.skillsBtn) el.skillsBtn.addEventListener('click', () => showSkillsDialog());
        if (el.ctxCompact) el.ctxCompact.addEventListener('click', startCompact);
        if (el.ctxBannerClose) el.ctxBannerClose.addEventListener('click', () => dialogsMod.dismissCtxBanner());
        if (el.statsSessionBtn) el.statsSessionBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleStatsPop('session');
        });
        if (el.statsTokenBtn) el.statsTokenBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleStatsPop('token');
        });
        if (el.ctxBtn) el.ctxBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleCtxPop();
        });
        if (el.ctxPopCompact) el.ctxPopCompact.addEventListener('click', () => {
            hideCtxPop();
            startCompact();
        });
        if (el.dialogClose) el.dialogClose.addEventListener('click', closeAIDialog);
        if (el.changesBtn) {
            el.changesBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (el.changesPop && el.changesPop.classList.contains('hidden')) showChangesPopover();
                else hideChangesPopover();
            });
        }
        document.addEventListener('pointerdown', (e) => {
            if (openStatsPop) {
                const pop = statsPopEl(openStatsPop);
                const inPop = pop && pop.contains(e.target);
                const onTrigger = e.target.closest('#ai-ctx-btn') || e.target.closest('#ai-stats-session') || e.target.closest('#ai-stats-token');
                if (!inPop && !onTrigger) hideStatsPops();
            }
            if (!el.changesPop || el.changesPop.classList.contains('hidden')) return;
            if (e.target.closest('#ai-changes') || e.target.closest('#ai-changes-pop')) return;
            hideChangesPopover();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                hideCtxPop();
                hideChangesPopover();
                if (el.dialog && !el.dialog.classList.contains('hidden')) closeAIDialog();
            }
        });
        if (el.messages) {
            el.messages.addEventListener('click', handleMessageClick);
            // 文件引用芯片：点击在编辑器打开（带 :行:列 时同步跳行）
            el.messages.addEventListener('click', (e) => {
                const chip = e.target.closest && e.target.closest('.ai-file-ref[data-ai-ref-path]');
                if (!chip || typeof openTargets !== 'function') return;
                openTargets([{path: chip.dataset.aiRefPath, line: Number(chip.dataset.aiRefLine) || 0, column: Number(chip.dataset.aiRefCol) || 0}]);
            });
            el.messages.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                showAIMessageContextMenu(e);
            });
            el.messages.addEventListener('scroll', () => {
                const top = el.messages.scrollTop;
                const distance = el.messages.scrollHeight - top - el.messages.clientHeight;
                // 判定收在 ai-scroll-follow.js：只有用户手势里的上滚才解除贴底。
                // 任务清单 / 审批卡出现后底部留白变高（.ai-bottom-stack 是 overlay，消息区靠
                // padding-bottom 让位），滚动条 thumb 被顶上去；overlay 收起 / 面板缩放还会把
                // scrollTop 钳小。这些都不是用户在滚——照旧按「距底 > 80 或 scrollTop 变小」
                // 判上翻就再也不跟随触底了。贴底态被挤离底部时这里直接补回去。
                const shrunk = top < scrollLastTop - 0.5;
                let byUser = scrollGesture.active();
                // observing：非手势的单发减小——先观望再决定是不是补底，否则「补底」会立刻
                // 把 scrollTop 顶回去，连续减小的兜底永远攒不起来（无 wheel 的环境上翻失效）
                let observing = false;
                if (!byUser && shrunk) {
                    byUser = shrinkBurst.push();
                    observing = !byUser;
                } else {
                    shrinkBurst.reset();
                }
                const next = nextStickState(
                    {stickBottom, lastTop: scrollLastTop, byUser},
                    {top, distance},
                );
                stickBottom = next.stickBottom;
                // 平滑滚动动画期间的中间帧、以及正在观望的减小都不算「被挤离底部」
                if (next.refollow && !observing && performance.now() > smoothScrollUntil) scrollToBottom(false);
                scrollLastTop = el.messages.scrollTop;
                updateScrollButton();
                if (el.messages.scrollTop <= 24) loadEarlierMessages();
                scheduleOutlineSync();
            });
            // 用户滚动意图（判定的另一半）：滚轮 / 触摸移动按次刷新宽限期，
            // 滚动条与触屏拖拽用 begin/end 覆盖整段手势（拖拽期间不产生 wheel）。
            el.messages.addEventListener('wheel', () => scrollGesture.note(), {passive: true});
            el.messages.addEventListener('touchstart', () => scrollGesture.begin(), {passive: true});
            el.messages.addEventListener('touchmove', () => scrollGesture.note(), {passive: true});
            el.messages.addEventListener('touchend', () => scrollGesture.end(), {passive: true});
            el.messages.addEventListener('touchcancel', () => scrollGesture.end(), {passive: true});
            // WebView2/Chromium 把滚动条上的指针事件派发到被滚动的元素本身：只有按在
            // 滚动条槽里才进入拖拽态，点消息正文不该开启「用户在滚」的窗口
            el.messages.addEventListener('pointerdown', (e) => {
                const rect = el.messages.getBoundingClientRect();
                const x = e.clientX - rect.left - el.messages.clientLeft;
                if (x >= el.messages.clientWidth) scrollGesture.begin();
            });
            const endScrollGesture = () => scrollGesture.end();
            window.addEventListener('pointerup', endScrollGesture);
            window.addEventListener('pointercancel', endScrollGesture);
            // 内容异步长高（工具卡自动展开、截图/图片 onload、widget 出图）不产生 scroll 事件：
            // 贴底态只靠渲染帧跟随的话，帧走完之后的长高就再也补不回来——滚动条卡在半空、
            // 距底几百像素，也没有任何事件把它拉回去（用户看到的就是「定死」）。
            // 盯每个消息节点的高度，长高时若仍贴底就补一次；改 scrollTop 不改节点尺寸，
            // 不会自激。图片 load 再兜一路（少数宿主不派发 RO 回调）。
            const refollowAfterGrowth = () => {
                if (!shouldRefollowGrowth(stickBottom, messagesBottomGap(), scrollGesture.active())) return;
                scrollToBottom(false);
            };
            if (typeof ResizeObserver === 'function') {
                const growthRO = new ResizeObserver(refollowAfterGrowth);
                const watch = (node) => {
                    if (node && node.nodeType === 1) growthRO.observe(node);
                };
                for (const child of el.messages.children) watch(child);
                new MutationObserver((records) => {
                    for (const record of records) {
                        for (const node of record.removedNodes) {
                            if (node.nodeType === 1) growthRO.unobserve(node);
                        }
                        for (const node of record.addedNodes) watch(node);
                    }
                }).observe(el.messages, {childList: true});
            }
            el.messages.addEventListener('load', refollowAfterGrowth, true);
        }
        panel.addEventListener('contextmenu', (e) => {
            if (el.messages && el.messages.contains(e.target)) return;
            // 全屏模式下 AI 面板挂在主编辑区内：阻止事件落到主编辑区的空白右键菜单
            e.stopPropagation();
            const editTarget = e.target.closest ? e.target.closest('input, textarea, [contenteditable="true"]') : null;
            if (editTarget && panel.contains(editTarget)) {
                // WebView2 没有可依赖的原生编辑菜单：composer 等输入框给撤销/重做/剪贴/复制/粘贴/全选
                e.preventDefault();
                showAIEditMenu(e, editTarget);
                return;
            }
            if (e.target.closest && e.target.closest('select')) return;
            e.preventDefault();
        });
        // 关窗 / 重载前把还没落盘的会话再冲一次：工具结果、轮次收尾这些消息都是异步追加的，
        // 用户刚看到结果就退出时不能只留在内存里（磁盘模式才有意义，legacy 走 localStorage）。
        window.addEventListener('pagehide', () => {
            if (!sessionsLoaded || effectiveStorageMode() !== 'disk') return;
            try {
                persistSessions();
                if (sessionStore && sessionStore.flush) sessionStore.flush();
            } catch (e) {}
        });
        if (el.scrollBtn) el.scrollBtn.addEventListener('click', () => scrollToBottom(true));
        if (el.input) {
            el.input.addEventListener('input', () => {
                resizeInput();
                updateSendState();
                updateSlash();
            });
            el.input.addEventListener('keydown', handleComposerKey);
            el.input.addEventListener('paste', handleInputPaste);
            el.input.addEventListener('blur', () => {
                setTimeout(() => {
                    if (document.activeElement !== el.input) hideSlash();
                }, 150);
            });
        }
        if (el.send) el.send.addEventListener('click', (e) => submitFromComposer(e));
        // 注意：不能直接传函数引用，click 会把 MouseEvent 当第一个参数（会被当成要停止的流）
        if (el.stop) el.stop.addEventListener('click', () => stopGeneration());
        panel.querySelectorAll('.ai-resize').forEach((handle) => {
            handle.addEventListener('pointerdown', (e) => startResize(e, handle.dataset.aiResize));
        });
        window.addEventListener('pointermove', moveResize);
        window.addEventListener('pointerup', endResize);
        window.addEventListener('pointercancel', endResize);
        window.addEventListener('resize', onWindowResize);
    }

    function aiFontFace(id) {
        if (!id || id === 'follow') return '';
        const fonts = opts.fonts || {};
        const pick = (list, key) => {
            const face = (list || []).find((item) => item.id === key);
            return face ? face.family : '';
        };
        if (id.startsWith('ui:')) return pick(fonts.latin, id.slice(3));
        if (id.startsWith('mono:')) return pick(fonts.mono, id.slice(5));
        if (id.startsWith('cjk:')) return pick(fonts.cjk, id.slice(4));
        return '';
    }

    function aiChatFontStacks() {
        const fonts = opts.fonts || {};
        const faces = (list) => list || [];
        const uiEn = (faces(fonts.latin).find((face) => face.id === settings.uiFont) || {}).family || '"Inter"';
        const editorEn = (faces(fonts.mono).find((face) => face.id === settings.editorFontFamily) || {}).family || uiEn;
        const uiCjk = (faces(fonts.cjk).find((face) => face.id === settings.uiCjkFont) || {}).family || '"Microsoft YaHei UI", "微软雅黑"';
        const en = aiFontFace(settings.aiChatFontEn) || uiEn;
        const cjk = aiFontFace(settings.aiChatFontCjk) || uiCjk;
        const code = aiFontFace(settings.aiChatCodeFont) || editorEn;
        return {
            chat: en + ', ' + cjk + ', sans-serif',
            code: code + ', ' + cjk + ', monospace',
        };
    }

    function syncChatFontControls() {
        const value = aiClampInt(settings.aiChatFont, 10, 32, 13);
        if (opt.chatFont) opt.chatFont.value = String(value);
        if (opt.chatFontVal) opt.chatFontVal.value = String(value);
    }

    function scheduleFontSave() {
        if (fontSaveTimer) clearTimeout(fontSaveTimer);
        fontSaveTimer = setTimeout(() => {
            fontSaveTimer = 0;
            saveSettings();
        }, 300);
    }

    function setAIChatFont(value, options) {
        const next = aiClampInt(value, 10, 32, 13);
        const current = aiClampInt(settings.aiChatFont, 10, 32, 13);
        if (next !== current) {
            settings.aiChatFont = next;
            applyPanelSettings();
            syncChatFontControls();
        }
        if (options && options.deferSave) scheduleFontSave();
        else saveSettings();
    }

    function applyPanelSettings() {
        if (!panel) return;
        const font = aiClampInt(settings.aiChatFont, 10, 32, 13);
        panel.style.setProperty('--ai-chat-font', font + 'px');
        const stacks = aiChatFontStacks();
        panel.style.setProperty('--ai-chat-font-family', stacks.chat);
        panel.style.setProperty('--ai-chat-code-font', stacks.code);
        const thinking = settings.aiShowThinking !== false;
        const usage = settings.aiShowUsage !== false;
        const widgets = settings.aiInlineWidgets !== false;
        panel.classList.toggle('ai-assistant-card', settings.aiAssistantCard === true);
        const changed = lastApplied.thinking !== thinking || lastApplied.usage !== usage ||
            lastApplied.widgets !== widgets;
        lastApplied = {font, thinking, usage, widgets};
        if (changed && isOpen()) renderMessages(true);
        updateSendState();
        positionOverlays();
        // 注入开关 / 输出语言等设置变化会影响系统提示词：面板可见时按节流重建估算。
        refreshSystemPromptEstimate(false);
    }

    // ---------- 底部 composer 接管：提问 / 计划批准 ----------

    // 待办查找一律带会话：多宿主之后「待办属于哪个视图」必须由调用方指定，
    // 否则支线标签页的接管区会显示母会话的待审批项——在 A 会话的视图里批准 B 会话
    // 的写操作。无参调用 = 面板当前会话，与改动前逐字节等价。
    function pendingSessionOf(sessionId) {
        return sessionId ? sessionById(sessionId) : currentSession();
    }

    function currentSystemTakeoverEntry(sessionId) {
        const session = pendingSessionOf(sessionId);
        if (!session) return null;
        return systemTakeoverHost.pick(session.id);
    }

    function currentPendingAskEntry(sessionId) {
        const session = pendingSessionOf(sessionId);
        if (!session) return null;
        for (const entry of pendingAsks.values()) {
            if (entry.session === session && entry.ask && entry.ask.state === 'pending') return entry;
        }
        return null;
    }

    function currentPendingEnvEntry(sessionId) {
        const session = pendingSessionOf(sessionId);
        if (!session) return null;
        for (const entry of pendingEnvCreations.values()) {
            if (entry.session === session && entry.toolMessage && entry.toolMessage.envAsk && entry.toolMessage.envAsk.state === 'pending') return entry;
        }
        return null;
    }

    function currentPendingApprovalEntry(sessionId) {
        const session = pendingSessionOf(sessionId);
        if (!session) return null;
        for (const entry of pendingApprovals.values()) {
            if (entry.session === session && entry.toolMessage && entry.approval && entry.approval.state === 'pending') return entry;
        }
        return null;
    }

    // renderApprovalTakeover 审批接管：写文件 / 终端命令的待审批项直接在 composer 位置展开，
    // 消息流里只留一条「等待审批…」占位。这样 diff 可以吃满可用高度，
    // 「放弃 / 应用」固定在底部操作条，不会被长 diff 推到视野外。
    // 审批接管卡的临时收起状态：仅影响显示，不取消审批；换一条审批或决定后自动复位
    let approvalTakeoverKey = '';
    let approvalTakeoverCollapsed = false;

    // ---- 补丁审批（propose_patch） ----
    // 与 write_file 审批共用 pendingApprovals 通道，但卡片形态不同：
    // 多文件 + 模式选择（整体成功 / 允许部分成功，AI 侧默认后者）+ 逐文件勾选。

    const patchAttempts = new Map(); // patchHash -> {count, lastCode, at}

    function patchHashOf(text) {
        let h = 2166136261;
        const s = String(text || '');
        for (let i = 0; i < s.length; i += 1) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(16) + '-' + s.length;
    }

    function patchErrorText(code, message, detail, retryable) {
        const lines = ['【patch:error】code=' + code + ' retryable=' + (retryable ? 'yes' : 'no'), message || ''];
        if (detail) lines.push(detail);
        return lines.join('\n');
    }

    function patchResultText(res) {
        const lines = ['【patch:result】mode=' + (res.mode || 'atomic') + ' applied=' + (res.applied || 0) + ' skipped=' + (res.skipped || 0) + ' added=' + (res.added || 0) + ' removed=' + (res.removed || 0)];
        for (const f of res.files || []) {
            const label = {applied: '已应用', skipped: '已跳过', failed: '失败', notapplied: '未执行'}[f.status] || f.status;
            lines.push(label + '：' + f.relPath + (f.reason ? '（' + f.reason + '）' : ''));
        }
        if (res.message) lines.push(res.message);
        return lines.join('\n');
    }

    // 输入区接管卡（阶段 3 拆出：ai-takeover.js；approvalTakeover* / dismissedPlanApproval / stickBottom 经访问器读写）
    const takeoverMod = createAITakeover({
        el,
        flash,
        openPath,
        // 计划卡「在标签页打开」：先补写 .cadt/plan/ 下的文件再开标签页（正文不在卡里铺）
        openPlanFile,
        compactOf,
        currentSession,
        currentScopeOf,
        persistSessions,
        decideApproval,
        decideEnvCreation,
        currentPendingApprovalEntry,
        currentPendingAskEntry,
        currentPendingEnvEntry,
        currentSystemTakeoverEntry,
        systemTakeoverHost,
        refreshToolWrap,
        projectRulesPath,
        lastAssistantIndex,
        scrollToBottom,
        setScope,
        skipAsk,
        submitAskAnswers,
        askCountdownText,
        streamOf,
        positionOverlays,
        pendingApprovals,
        askDrafts,
        AI_CHEVRON_SVG,
        // 惰性转发：渲染别名构造于本模块之后（工具卡 / 消息队列互引）
        renderDiffInto: (...args) => renderDiffInto(...args),
        renderMessageQueue: (...args) => renderMessageQueue(...args),
        renderSessionList,
        getApprovalTakeoverKey: () => approvalTakeoverKey,
        setApprovalTakeoverKey: (value) => { approvalTakeoverKey = value; },
        getApprovalTakeoverCollapsed: () => approvalTakeoverCollapsed,
        setApprovalTakeoverCollapsed: (value) => { approvalTakeoverCollapsed = value; },
        getDismissedPlanApproval: () => dismissedPlanApproval,
        setDismissedPlanApproval: (value) => { dismissedPlanApproval = value; },
        getStickBottom: () => stickBottom,
        // 惰性转发：toolMeta / acceptPlan 别名随工具卡模块构造于其后
        toolMeta: (...args) => toolMeta(...args),
        acceptPlan: (...args) => acceptPlan(...args),
        // 补丁审批的等待提醒（补丁在 ai-takeover.js 里自行登记，走同一条提醒口径）
        notifyWaiting: (...args) => markWaitingOnUser(...args),
    });
    const requestPatchApproval = (...args) => takeoverMod.requestPatchApproval(...args);
    const renderPatchTakeover = (...args) => takeoverMod.renderPatchTakeover(...args);
    const renderPatchApprovalBody = (...args) => takeoverMod.renderPatchApprovalBody(...args);
    const renderApprovalTakeover = (...args) => takeoverMod.renderApprovalTakeover(...args);
    const renderAskTakeover = (...args) => takeoverMod.renderAskTakeover(...args);
    const renderPlanTakeover = (...args) => takeoverMod.renderPlanTakeover(...args);
    // 补落盘：升级前留下的待批准计划、或上次写盘失败时，接管区在画计划卡之前先把
    // .cadt/plan/ 下的文件补出来（先同步记路径，卡片直接带「在标签页打开」；
    // 正文写盘完成后再重建一次消息区，让消息里的卡片接替原文渲染）。
    function ensurePlanFileForPendingPlan() {
        const session = currentSession();
        if (!session) return;
        const message = takeoverMod.planApprovalMessage(session);
        if (!message || message.planFile) return;
        const target = markPlanFile(message, session);
        if (!target) return;
        persistSessions();
        writePlanFile(target).then(() => {
            if (currentSession() && currentSession().id === session.id) renderMessages(true);
        }).catch(() => {});
    }
    const updateComposerTakeover = (...args) => {
        ensurePlanFileForPendingPlan();
        return takeoverMod.updateComposerTakeover(...args);
    };
    const planApprovalMessage = (...args) => takeoverMod.planApprovalMessage(...args);
    const planApprovalKey = (...args) => takeoverMod.planApprovalKey(...args);

    // 输入区与附件域（阶段 3 拆出：ai-composer.js；attachments/queueSeq 随域迁入，attachSeq 经 nextAttachSeq 取号）
    const composerMod = createAIComposer({
        el,
        compactOf,
        currentSession,
        flash,
        getSelection,
        getWorkspaceContext,
        listSkills,
        pickFiles,
        readTextFile,
        readVideoFile,
        settings,
        showContextMenu,
        showImagePreview,
        showNote,
        syncStreamView,
        updateContextCount,
        updateSendState,
        updateSlash,
        hideSlash,
        runSlashCommand,
        handleSlashText,
        // 惰性转发：queueMod 构造于本模块之后（composer 提交流与队列互引）
        enqueueComposerMessage: (...args) => queueMod.enqueueComposerMessage(...args),
        interjectComposerMessage: (...args) => queueMod.interjectComposerMessage(...args),
        renderMessageQueue: (...args) => queueMod.renderMessageQueue(...args),
        entryOf,
        sessionImageBytes,
        // 排队消息的读写一律经队列模块（所有权在 ai-message-queue.js，阶段 A 迁移）
        queue: {
            itemsForSession: (...args) => queueMod.itemsForSession(...args),
            indexOfItem: (...args) => queueMod.indexOfItem(...args),
            pushItem: (...args) => queueMod.pushItem(...args),
            removeItem: (...args) => queueMod.removeItem(...args),
        },
        slashState,
        submitText,
        nextAttachSeq: () => ++attachSeq,
    });
    // 打字增行（composer 自动长高）不经过任何渲染路径：input 事件带一次刷新。
    // defer 到本轮事件循环末尾——事件接线函数里的 resizeInput 监听注册得更晚，
    // 同步调用会量到长高前的堆叠区；贴底时顺带把末条消息保持可见
    if (el.input) {
        el.input.addEventListener('input', () => {
            setTimeout(() => {
                positionOverlays();
                if (stickBottom) scrollToBottom(false);
            }, 0);
        });
    }
    const renderAttachments = () => composerMod.renderAttachments();
    const addAttachment = (...args) => composerMod.addAttachment(...args);
    const prepareImageAttachment = (...args) => composerMod.prepareImageAttachment(...args);
    const attachPath = (...args) => composerMod.attachPath(...args);
    const attachSelection = (...args) => composerMod.attachSelection(...args);
    const referencePath = (...args) => composerMod.referencePath(...args);
    const referenceSelection = (...args) => composerMod.referenceSelection(...args);
    const addMessageQuote = (...args) => composerMod.addMessageQuote(...args);
    const attachFilesDialog = (...args) => composerMod.attachFilesDialog(...args);
    const showSkillPicker = (...args) => composerMod.showSkillPicker(...args);
    const attachSkillByName = (...args) => composerMod.attachSkillByName(...args);
    const resizeInput = (...args) => composerMod.resizeInput(...args);
    const submitFromComposer = (...args) => composerMod.submitFromComposer(...args);
    const handleComposerKey = (...args) => composerMod.handleComposerKey(...args);
    const currentQueueItems = (...args) => composerMod.currentQueueItems(...args);
    const captureComposerMessage = (...args) => composerMod.captureComposerMessage(...args);
    const editQueuedMessage = (...args) => composerMod.editQueuedMessage(...args);
    const handleInputPaste = (...args) => composerMod.handleInputPaste(...args);
    const attachCurrentFile = (...args) => composerMod.attachCurrentFile(...args);
    const getAttachments = () => composerMod.getAttachments();
    const setAttachments = (value) => composerMod.setAttachments(value);

    // 消息排队 / 插话（阶段 3 拆出：ai-message-queue.js；队列状态与所有权都在该模块内部，
    // attachments / dismissedPlanApproval / stream 经访问器读写）
    const queueMod = createAIMessageQueue({
        el,
        streams,
        flash,
        positionOverlays,
        compactOf,
        currentSession,
        syncStreamView,
        currentQueueItems,
        planApprovalMessage,
        planApprovalKey,
        updateComposerTakeover,
        editQueuedMessage,
        captureComposerMessage,
        handleSlashText,
        stopGeneration,
        renderAttachments,
        resizeInput,
        submitText,
        updateSendState,
        currentPendingAskEntry,
        getAttachments: () => composerMod.getAttachments(),
        setAttachments: (value) => composerMod.setAttachments(value),
        getDismissedPlanApproval: () => dismissedPlanApproval,
        setDismissedPlanApproval: (value) => { dismissedPlanApproval = value; },
        getStream: () => stream,
    });
    const renderMessageQueue = () => queueMod.renderMessageQueue();
    const enqueueComposerMessage = (...args) => queueMod.enqueueComposerMessage(...args);
    const interjectComposerMessage = (...args) => queueMod.interjectComposerMessage(...args);
    const flushMessageQueue = (...args) => queueMod.flushMessageQueue(...args);
    const clearQueueForSession = (...args) => queueMod.clearQueueForSession(...args);

    function updateComposerState() {
        renderProfileSelect();
        updateScopeUI();
        updateSendState();
        updateContextCount();
        updateSlash();
        updateComposerTakeover();
        renderMessageQueue();
    }

    // ---------- 初始化 ----------

    function init() {
        // 会话还没从磁盘读出来时不要替用户决定「当前会话」：占位列表的第一项不是上次打开的
        // 会话，写进 activeSessionId 会造成启动瞬间串台（真正的会话要等读盘完成才出现）。
        if (!sessionsPending() && (!config.activeSessionId || !sessions.some((s) => s.id === config.activeSessionId))) {
            config.activeSessionId = sessions[0].id;
            saveAIConfig();
        }
        renderSessionList();
        renderProfileSelect();
        renderAttachments();
        updateScopeUI();
        applyPanelSide();
        applyMode(mode, false);
        bindPanelInteractions();
        bindSettingsPane();
        applyPanelSettings();
        // 首次读盘没完成时 renderMessages 内部会画加载态，读盘结束后再画真内容
        renderMessages();
        updateComposerState();
        panel.classList.toggle('hidden', floatWindow ? false : !settings.aiPanelOpen);
        refreshDockFill();
        updateEntryButtons();
        // MCP 工具清单兜底拉取：防错过启动早期事件；Go 侧 MCPSnapshot 会触发惰性启动。
        // 尽力而为路径：旧后端 / MCP 未启用时 registry 留空，失败不影响面板初始化。
        Promise.resolve(mcpMod.refresh()).catch(() => {});
        // 外部工具来源：工具可见性依赖它，尽早拉一次；失败保留默认值
        void loadExternalToolsConfig();
        if (floatWindow || settings.aiPanelOpen) {
            stickBottom = true;
            refreshSystemPromptEstimate(true);
            setTimeout(() => {
                if (el.input) el.input.focus();
                scrollToBottom(false);
            }, 0);
        }
    }

    function paletteActions() {
        const actions = [
            {label: 'AI： 新建会话', action: () => { open(true); newSession(); }},
            {label: 'AI： 上下文统计（/context）', action: () => { open(true); contextSummaryText().then(showNote).catch((e) => showNote('上下文统计失败：' + ((e && e.message) || e), true)); }},
            {label: 'AI： 清空当前会话（/clear）', action: () => { open(true); clearCurrentSession(); }},
            {label: 'AI： 会话提示词…', action: () => { open(true); showPromptDialog(); }},
            {label: 'AI： 记忆管理…', action: () => { open(true); showMemoryDialog(); }},
            {label: 'AI： 技能管理…', action: () => { open(true); showSkillsDialog(); }},
            {label: 'AI： 个性化设置（/persona）', action: () => { open(true); openSettings('persona'); }},
            {label: 'AI： 压缩上下文（/compact）', action: () => { open(true); startCompact(); }},
            {label: 'AI： 查看已归档消息', action: () => { open(true); showArchivedDialog(); }},
            {label: 'AI： 生成 AGENTS.md（/init）', action: () => { open(true); runInitAgentsMd(); }},
            {label: 'AI： 导出会话为 Markdown', action: () => { open(true); exportSession(); }},
            {label: 'AI： 打开对话日志目录', action: openAILogDir},
        ];
        for (const profile of config.profiles) {
            const entry = modelEntryOf(profile, profile.lastModelId);
            actions.push({
                label: 'AI： 切换账号 ' + profile.name + (entry && entry.model ? '（' + entry.model + '）' : ''),
                action: () => switchProfile(profile.id),
            });
        }
        return actions;
    }

    // 会话信箱 / 后台注入通道（阶段 B：docs/finished-plans/session-messaging.md §4.4）。
    // 一条管道 N 个发送方：子代理结算与提问、支线带回、会话间投递、定时任务与计时器。
    // 三态投递（忙→排队 / 压缩中→排队 / 空闲→startSessionTurn 唤醒）都在模块内部，
    // panel 只保留三个消费点与工具执行处的薄调用。
    const noticesMod = createAIAgentNotices({
        sessionById,
        streamOf,
        compactOf,
        startSessionTurn,
        currentSession,
        isOpen,
        renderMessages,
        renderSessionList,
        setSessionUnread,
        notifyDesktop,
        flash,
        persistSessions,
        getPendingEdit: () => pendingEdit,
        // 会话间投递（阶段 H）：选址列表按工作区过滤，默认只列同工作区
        getSessions: () => sessions,
        workspaceKeyOf: (session) => aiWorkspaceKey(sessionWorkspacePath(session)),
    });
    const deliverAgentNotice = (...args) => noticesMod.deliverAgentNotice(...args);
    const foldAgentNotices = (...args) => noticesMod.foldNotices(...args);
    const flushAgentNotices = (...args) => noticesMod.flushNotices(...args);
    const foldNoticesBeforeTurn = (...args) => noticesMod.foldBeforeTurn(...args);
    const pendingNoticeCount = (...args) => noticesMod.pendingCount(...args);

    // 会话投递的选择器 UI（ai-session-send.js）：多选 + 搜索 + 键盘 + 内容预览。
    // 传输仍走上面的信箱（deliverToSessions），本模块只管「选谁、写什么、回执怎么说」。
    const sessionSendMod = createAISessionSend({
        openDialog: (...args) => openAIDialog(...args),
        closeDialog: () => closeAIDialog(),
        node: (...args) => dialogNode(...args),
        flash,
        // 用户主动投递不受「同工作区」限制（跨工作区也能投），行上会标出工作区名
        listSessions: () => noticesMod.listSessionsForSend({allWorkspaces: true}),
        stateOf: (session) => (streamOf(session.id) ? 'streaming' : (compactOf(session.id) ? 'compacting' : 'idle')),
        workspaceName: (path) => (path ? aiWorkspaceName(path) : ''),
        deliverToSessions: (...args) => noticesMod.deliverToSessions(...args),
        getComposerText: () => (el.input ? el.input.value : ''),
        clearComposer: () => {
            if (!el.input) return;
            el.input.value = '';
            resizeInput();
            updateSendState();
        },
    });
    const openDeliverDialog = (...args) => sessionSendMod.openDeliver(...args);
    const openBroadcastDialog = (...args) => sessionSendMod.openBroadcast(...args);

    // 支线对话域（阶段 F：普通持久化会话 + sideOf 元数据；动作在 ai-sidechat.js，
    // 列表缩进/徽标与排序在 ai-session-list.js，结论带回走上面的信箱通道）
    // 支线对话在内容区标签页打开；悬浮窗没有内容区，置 null 让调用方退回面板内切换（不动面板形态）。
    sideChatTabOutlet = !openSideChatTab || window.__aiFloatWindow ? null : (spec) => openSideChatTab(spec);

    const sidechatMod = createAISidechat({
        getSessions: () => sessions,
        sessionById,
        currentSession,
        createSessionData,
        persistSessions,
        switchSession,
        renderSessionList,
        setDraft: setComposerDraft,
        deliverAgentNotice,
        flash,
        logActivity,
        // 在内容区标签页打开（返回 null 表示无内容区可用，调用方退回 switchSession）
        openSideChatTab: (spec) => (sideChatTabOutlet ? sideChatTabOutlet(spec) : null),
    });
    const openSideChat = (...args) => sidechatMod.openSideChat(...args);
    const bringBackToParent = (...args) => sidechatMod.bringBackToParent(...args);
    const promoteSideChat = (...args) => sidechatMod.promoteSideChat(...args);

    // 会话消息化工具的执行分发（agent_send / agent_stop / wait_agent / agent_compact /
    // session_list / session_send）：执行体按阶段落在 ai-subagents.js 与 ai-agent-notices.js，
    // panel 只保留这一个薄分发。各工具在自己阶段才进 AI_TOOL_DEFS，未启用阶段模型调不到。
    function agentToolHandler(name, input, ctx) {
        // 会话间投递（阶段 H）：执行体在 ai-agent-notices.js（信箱的正式化）
        if (name === 'session_list') return noticesMod.sessionListText(input);
        if (name === 'session_send') return noticesMod.sendToSessions(input, ctx);
        return subagentsMod.handleAgentTool(name, input, ctx);
    }

    // 子代理域（阶段 3 拆出：ai-subagents.js；hudReady/chipsPopKind 经访问器，注册表经 ctx 注入）
    const subagentsMod = createAISubagents({
        el,
        panel,
        backend,
        flash,
        renderMarkdown,
        openTermTab,
        // 隔离 worktree（spawn isolation='worktree'）：子代理草稿区建在主根 .cadt/worktree/ 下
        getScopeRoot,
        // 子代理详情落在内容区标签页（编辑区收起时由 main.js 的 revealEditorForContent 展开；
        // 不动面板形态）。悬浮窗没有内容区，置 null 让调用方退回面板内覆盖层。
        openAgentTab: !openAgentTab || window.__aiFloatWindow ? null : (spec) => openAgentTab(spec),
        // 悬浮窗没有内容区：详情视图退回面板内覆盖层（与改造前的表现一致）
        isFloatWindow: () => !!window.__aiFloatWindow,
        // 子代理正文与主消息区同一条增强链（代码复制钮 / 本地图片 / 可视化卡片）
        enhanceAnswerBody: (...args) => toolCardsMod.enhanceAnswerBody(...args),
        currentSession,
        persistSessions,
        sessionById,
        // 子代理详情头部兜底：所属会话还是懒加载占位时只补它一个（见 ai-subagents 的
        // requestAgentRecordHydrate），不为了一个徽标扫全部会话的正文
        ensureSessionLoaded,
        entryOf,
        profileOf,
        configForProfile,
        executeTool,
        flushToolImages,
        buildApiMessages,
        refreshToolWrap,
        renderSessionList,
        aiDelay,
        syncBgCardState,
        reconcileBgJobs,
        toolArgsErrorText,
        newAssistantMessage,
        getSessions: () => sessions,
        agentRegistry,
        logActivity,
        bgJobIndex,
        bgJobLive,
        bgJobCursors,
        bgUpdateListeners,
        getChipsPopKind: () => chipsPopKind,
        setChipsPopKind: (value) => { chipsPopKind = value; },
        // 计时器 / 定时任务弹层（kind=timers / schedules）由各自域提供内容，这里只做转发
        renderChipsPopExtra: (kind, host) => {
            if (kind === 'timers') { timerMod.renderPop(host); return true; }
            if (kind === 'schedules') { scheduleMod.renderSchedulePop(host); return true; }
            return false;
        },
        getConfig: () => config,
        contextWindowOf,
        estimateApiMessagesTokens: (...args) => estimateApiMessagesTokens(...args),
        // 结算通知走会话信箱（惰性：noticesMod 构造在上方，运行时才取值，无 TDZ 风险）
        getNotices: () => noticesMod,
    });
    const subAgentLimit = (...args) => subagentsMod.subAgentLimit(...args);
    const subAgentMaxDepth = (...args) => subagentsMod.subAgentMaxDepth(...args);
    const subAgentCanSpawn = (...args) => subagentsMod.subAgentCanSpawn(...args);
    const subSystemPromptFor = (...args) => subagentsMod.subSystemPromptFor(...args);
    const subToolsForScope = (...args) => subagentsMod.subToolsForScope(...args);
    const activeSubCount = (...args) => subagentsMod.activeSubCount(...args);
    const subTranscriptPush = (...args) => subagentsMod.subTranscriptPush(...args);
    const subThrottleRender = (...args) => subagentsMod.subThrottleRender(...args);
    const sessionTitleOf = (...args) => subagentsMod.sessionTitleOf(...args);
    const sessionTitleById = (...args) => subagentsMod.sessionTitleById(...args);
    const updateHeadIdentity = (...args) => subagentsMod.updateHeadIdentity(...args);
    const bgJobStateOf = (...args) => subagentsMod.bgJobStateOf(...args);
    const rootSessionIdOf = (...args) => subagentsMod.rootSessionIdOf(...args);
    const hudSessionId = (...args) => subagentsMod.hudSessionId(...args);
    const bgEntryOwnerId = (...args) => subagentsMod.bgEntryOwnerId(...args);
    const isBgEntryOfHud = (...args) => subagentsMod.isBgEntryOfHud(...args);
    const hudBgEntries = (...args) => subagentsMod.hudBgEntries(...args);
    const sessionHasLiveBgJob = (...args) => subagentsMod.sessionHasLiveBgJob(...args);
    const runningBgCount = (...args) => subagentsMod.runningBgCount(...args);
    const listAgentsForHud = (...args) => subagentsMod.listAgentsForHud(...args);
    const setChipCount = (...args) => subagentsMod.setChipCount(...args);
    const notifyBackgroundActivity = (...args) => subagentsMod.notifyBackgroundActivity(...args);
    const refreshHeadChips = (...args) => subagentsMod.refreshHeadChips(...args);
    const updateHeadHud = (...args) => subagentsMod.updateHeadHud(...args);
    const hideChipsPop = (...args) => subagentsMod.hideChipsPop(...args);
    const positionChipsPop = (...args) => subagentsMod.positionChipsPop(...args);
    const agentStateBadge = (...args) => subagentsMod.agentStateBadge(...args);
    const agentStatusIcon = (...args) => subagentsMod.agentStatusIcon(...args);
    const bgJobFirstLine = (...args) => subagentsMod.bgJobFirstLine(...args);
    const taskSnippet = (...args) => subagentsMod.taskSnippet(...args);
    const openBgTermInContent = (...args) => subagentsMod.openBgTermInContent(...args);
    const renderChipsPop = (...args) => subagentsMod.renderChipsPop(...args);
    const toggleChipsPop = (...args) => subagentsMod.toggleChipsPop(...args);
    const mountAgentView = (...args) => subagentsMod.mountAgentView(...args);
    const unmountAgentView = (...args) => subagentsMod.unmountAgentView(...args);
    const parentSessionOfSub = (...args) => subagentsMod.parentSessionOfSub(...args);
    const runSubAgent = (...args) => subagentsMod.runSubAgent(...args);
    const startSubAgent = (...args) => subagentsMod.startSubAgent(...args);
    const runSubRound = (...args) => subagentsMod.runSubRound(...args);
    const handleSubEvent = (...args) => subagentsMod.handleSubEvent(...args);
    const finalizeSubAgent = (...args) => subagentsMod.finalizeSubAgent(...args);
    const stopSubAgentsOf = (...args) => subagentsMod.stopSubAgentsOf(...args);
    const subAgents = subagentsMod.subAgents;
    const subAgentRecords = subagentsMod.subAgentRecords;
    const pushSubAgentRecord = (...args) => subagentsMod.pushSubAgentRecord(...args);
    const unseenInboxCount = (...args) => subagentsMod.unseenInboxCount(...args);
    const dropSubAgentRecordsOf = (...args) => subagentsMod.dropSubAgentRecordsOf(...args);
    const handleSubCompactEvent = (...args) => subagentsMod.handleSubCompactEvent(...args);
    const subCompacts = subagentsMod.subCompacts;
    const bgJobSnapshot = (...args) => subagentsMod.bgJobSnapshot(...args);
    const notifyBgListeners = (...args) => subagentsMod.notifyBgListeners(...args);
    const bridgeStopBgJob = (...args) => subagentsMod.bridgeStopBgJob(...args);

    // 工具卡 / 审批卡渲染（阶段 3 拆出：ai-tool-cards.js；构造置于 init 之前（init 的渲染路径会触达工具卡与 HUD 别名））
    const toolCardsMod = createAIToolCards({
        copyText,
        flash,
        backend,
        genStopJob: (jobId) => genJobsMod.stopJob(jobId),
        renderMarkdown,
        renderMermaidBlocks,
        openExternal,
        openTargets,
        // 计划卡「在标签页打开」：与接管区同一条落盘 + 打开路径
        openPlanFile: (...args) => openPlanFile(...args),
        settings,
        getScopeRoot,
        currentSession,
        currentScopeOf,
        persistSessions,
        renderMessages,
        submitText,
        streamOf,
        updateScopeUI,
        addCommandApprovalRule,
        appendActions,
        renderPatchApprovalBody,
        renderPendingApprovalPlaceholder,
        renderThinkBody,
        aiThinkKey,
        aiThinkLabel,
        resolveAIImages,
        enhanceAIFileRefs,
        toggleThink,
        toolArgsSummary,
        toolStateText,
        approvalTraceNote,
        renderMessageQueue,
        updateComposerTakeover: (...args) => takeoverMod.updateComposerTakeover(...args),
        readOptionalText,
        computeLineDiff,
        thinkFoldState,
        toolFoldState,
        subAgentTranscripts: subagentsMod.subAgentTranscripts,
        setDismissedPlanApproval: (value) => { dismissedPlanApproval = value; },
        // 助手气泡头的角色标签：跟随个性化命名（默认名即「甜澄」），文本产物仍写 'AI'
        assistantName,
    });
    const renderCommandApprovalBody = (...args) => toolCardsMod.renderCommandApprovalBody(...args);
    const renderApprovalBody = (...args) => toolCardsMod.renderApprovalBody(...args);
    const renderEnvAskBody = (...args) => toolCardsMod.renderEnvAskBody(...args);
    const renderAskCard = (...args) => toolCardsMod.renderAskCard(...args);
    const renderDiffInto = (...args) => toolCardsMod.renderDiffInto(...args);
    const renderToolMessage = (...args) => toolCardsMod.renderToolMessage(...args);
    const updateAssistantElement = (...args) => toolCardsMod.updateAssistantElement(...args);
    // toolMeta / acceptPlan：随工具卡提取段带入的相邻函数（接管区审批卡与计划批准在用）
    const toolMeta = (...args) => toolCardsMod.toolMeta(...args);
    const acceptPlan = (...args) => toolCardsMod.acceptPlan(...args);
    const askStateLabel = (...args) => toolCardsMod.askStateLabel(...args);
    const askResultText = (...args) => toolCardsMod.askResultText(...args);
    const enhanceAICodeBlocks = (...args) => toolCardsMod.enhanceAICodeBlocks(...args);

    init();
    whenConfigReady();
    whenSessionsReady();
    subagentsMod.initHud();



    return {
        toggle,
        open,
        isOpen,
        // 消息中心 / 系统通知点击跳会话用（main.js focusSession）：不导出的话调用抛
        // TypeError 被 try/catch 吞掉，面板开了却永远停在原会话——「toast 点了没反应」的根因
        switchSession,
        whenReady: () => Promise.all([whenConfigReady(), whenSessionsReady()]).then(() => undefined),
        setMode,
        applySettings: applyPanelSettings,
        refreshSettings: () => {
            refreshSettingsPane();
            refreshChatSettings();
            refreshPromptSettings();
            renderPresetSelect();
            renderModelList();
            refreshMemoryPath();
            mcpSettingsMod.render();
            // 来源矩阵在设置页可能刚被改过：重读一次，保证下一轮工具可见性正确
            void loadExternalToolsConfig(true);
        },
        // 外部工具（设置 → AI → 外部工具 / 能力来源路由）
        getMcpToolDefs: () => mcpMod.mcpToolDefs(),
        getExternalToolsConfig: () => externalToolsConfig,
        refreshExternalTools: () => loadExternalToolsConfig(true),
        refreshMcpConfig: () => Promise.resolve(mcpMod.refresh()).then(() => {
            if (mcpSettingsMod) mcpSettingsMod.renderAll();
        }).catch(() => {}),
        handleEvent,
        // localClassifierMod 不再进 return（红队链C）：经 main.js 的 window.__lens.aiPanel
        // 会把 recordDecision / classifyAll 连带暴露给插件运行时同窗 JS，可伪造 source 灌样本；
        // 设置页走注入的 localClassifier() getter，不需要这个引用。
        // 触发执行后刷新头部定时任务胶囊（once 任务触发后停用、lastResult 更新）
        handleScheduleFire: (fire) => {
            Promise.resolve(handleScheduleFire(fire)).catch(() => {}).then(() => scheduleMod.renderChip());
        },
        // 计时器事件（ai-timer-fired / ai-timer-stopped）：main.js 从 Go 侧广播转发进来
        handleTimerEvent: (name, info) => {
            if (!timerMod) return;
            if (name === 'ai-timer-fired') {
                timerMod.onFired(info);
                return;
            }
            if (name === 'ai-timer-stopped') {
                // 正计时停止：归属会话在此窗口才投递（其他窗口无归属，天然去重）；
                // AI 工具停止已在工具结果里带时长，抑制不重复投
                const owner = timerMod.onStopped(info);
                if (owner && info && info.mode === 'countup' && !suppressCountupStopIds.delete(info.id)) {
                    Promise.resolve(wakeSessionByCountupStop(owner, info)).catch((e) => {
                        flash('正计时停止通知失败：' + ((e && e.message) || e), true);
                    });
                }
            }
        },
        // MCP 事件（mcp-tools-changed / mcp-status-changed，都携带全量快照）：整表替换 + 设置页状态灯刷新
        handleMcpEvent: (snapshot) => {
            mcpMod.applySnapshot(snapshot);
            mcpSettingsMod.renderAll();
        },
        // 计时器注册表（调试 / 插件作者可经 window.__lens.aiPanel.timerMod 驱动）
        timerMod,
        // 定时任务域（调试驱动：renderChip / openAutomationDialog / renderScheduleSettings）
        scheduleMod,
        // 任务提醒域（调试驱动：openCreateDialog / refresh）
        remindersMod,
        // 端侧分类器不进 return：经 window.__lens.aiPanel 会把 recordDecision/classifyAll
        // 连带暴露给同窗 JS（红队链C，可伪造 source 灌样本）；设置页走 1988 行注入的
        // localClassifier() getter，无需此引用。
        refreshScheduleSettings: renderScheduleSettings,
        refreshContext,
        closeModelEditor,
        attachPath,
        attachSelection,
        referencePath,
        referenceSelection,
        addMessageQuote,
        paletteActions,
        getMode: () => mode,
        // 是否有会话正在生成/压缩（关窗二次确认依据，main.js 轮询后经 SetAIRunning 同步给 Go）
        hasActiveTurn: () => streams.size > 0 || !!oneShot,
        refreshDockFill,
        refreshSessionList: () => renderSessionList(),
        refreshGitEntry,
        sendAppMessage,
        getScope: currentScope,
        bridgeNewSession: async (opts2) => {
            const title = String((opts2 && opts2.title) || '').trim();
            const message = String((opts2 && opts2.message) || '').trim();
            if (typeof newSession !== 'function' || typeof submitText !== 'function') throw new Error('会话桥不可用');
            open(true);
            newSession();
            const session = currentSession();
            if (title && session) {
                session.title = title.slice(0, 60);
                persistSessions();
                renderSessionList();
            }
            if (message) await submitText(message);
            return session ? {id: session.id, title: session.title} : null;
        },
        bridgeSwitchSession: async (id) => {
            if (typeof switchSession !== 'function') throw new Error('会话桥不可用');
            const target = sessions.find((s) => s.id === String(id || ''));
            // 懒加载会话要先补正文：切完再返回，调用方（全局搜索命中 / app_control）拿到的
            // 一定是「已打开」的会话，紧接着的按 mid 定位消息才不会落空。
            if (target && target._stub && !(await ensureSessionLoaded(target))) {
                throw new Error('会话正文读取失败：' + (target._loadError || '未知原因'));
            }
            switchSession(String(id || ''));
            return currentSession() ? {id: currentSession().id, title: currentSession().title} : null;
        },
        bridgeRenameSession: async (id, title) => {
            if (typeof renameSession !== 'function') throw new Error('会话桥不可用');
            const target = sessions.find((s) => s.id === String(id || ''));
            if (!target) throw new Error('找不到会话：' + id);
            // 懒加载会话要先补正文：改名后的 queueLogSave 会把 md 日志写盘，不能把
            // 没读完的历史当成空内容写出去（同 bridgeSwitchSession / exportSession 的护栏）。
            if (target._stub && !(await ensureSessionLoaded(target))) {
                throw new Error('会话正文读取失败：' + (target._loadError || '未知原因'));
            }
            const next = String(title || '').trim();
            if (!next) throw new Error('会话名称不能为空');
            target.title = next.slice(0, 60);
            persistSessions();
            renderSessionList();
            queueLogSave(target);
            return {id: target.id, title: target.title};
        },
        // ---------- 生成条目桥（app_control：get_gen_models / set_gen_model / delete_gen_model） ----------
        // AI 可代填除 API Key 外的全部字段（mergeGenModelEntry 保证密钥只来自 existing）；
        // 新建后用户在设置里填 Key 并核对 baseURL。列表/返回值一律不带密钥。
        bridgeGenModelsList: () => {
            const models = (config.genModels || []).map((item) => ({
                id: item.id,
                name: item.name,
                kind: item.kind,
                enabled: item.enabled !== false,
                baseURL: item.baseURL,
                path: item.path,
                editPath: item.editPath,
                editImageWrap: item.editImageWrap,
                editFormat: item.editFormat,
                resultType: item.resultType,
                defaultModel: item.defaultModel,
                defaultSize: item.defaultSize,
                hasKey: !!item.apiKey,
            }));
            const firstEnabled = (kind) => {
                const hit = models.find((item) => item.kind === kind && item.enabled);
                return hit ? hit.name : '';
            };
            return {models, defaults: {image: firstEnabled('image'), video: firstEnabled('video')}};
        },
        bridgeGenModelUpsert: (entry) => {
            const incoming = entry && typeof entry === 'object' ? entry : {};
            const name = aiTextOf(incoming.name || incoming.id).trim();
            if (!name) throw new Error('生成条目需要 name（建议直接用服务商的模型 id 命名）');
            const list = config.genModels = config.genModels || [];
            const lower = name.toLowerCase();
            const existing = list.find((item) => item.id.toLowerCase() === lower || item.name.toLowerCase() === lower);
            const merged = mergeGenModelEntry(existing, {...incoming, name}, () => aiNowId('gen-'));
            if (existing) {
                list[list.indexOf(existing)] = merged;
            } else {
                list.push(merged);
            }
            saveAIConfig();
            if (settingsMod && typeof settingsMod.renderGenList === 'function') settingsMod.renderGenList();
            flash('AI 已' + (existing ? '更新' : '新建') + '生成条目「' + name + '」，请核对 baseURL' +
                (merged.apiKey ? '' : ' 并在设置里填写 API Key'));
            return {
                saved: {
                    id: merged.id, name: merged.name, kind: merged.kind, enabled: merged.enabled !== false,
                    baseURL: merged.baseURL, path: merged.path, editPath: merged.editPath,
                    editFormat: merged.editFormat,
                    resultType: merged.resultType,
                    defaultModel: merged.defaultModel, defaultSize: merged.defaultSize,
                },
                apiKeyFilled: !!merged.apiKey,
                note: merged.apiKey
                    ? 'API Key 已保留（AI 不可读写密钥）。'
                    : 'API Key 留空：请提醒用户在 设置 → AI → 生图与视频 → 编辑 里填写，并核对 baseURL 是否与官方文档一致。',
            };
        },
        bridgeGenModelDelete: (ref) => {
            const key = aiTextOf(ref).trim().toLowerCase();
            if (!key) throw new Error('delete_gen_model 需要 name 或 id');
            const list = config.genModels || [];
            const index = list.findIndex((item) =>
                item.id.toLowerCase() === key || item.name.toLowerCase() === key);
            if (index < 0) return {deleted: false, note: '没有找到该条目'};
            // 已填密钥的条目是用户亲手配的资产：AI 不可删，让用户手动操作
            if (list[index].apiKey) {
                throw new Error('「' + list[index].name + '」已填写 API Key，不可由 AI 删除；请让用户在设置里手动删除');
            }
            const removed = list.splice(index, 1)[0];
            saveAIConfig();
            if (settingsMod && typeof settingsMod.renderGenList === 'function') settingsMod.renderGenList();
            flash('AI 已删除生成条目「' + removed.name + '」');
            return {deleted: true, name: removed.name};
        },
        // 全局搜索跳转：按 mid（优先）/ liveIndex 兜底定位当前会话里的消息并滚动高亮。
        // 返回 false 表示没定位到（索引滞后或消息已变），调用方自行提示。
        bridgeLocateMessage: (mid, liveIndex) => {
            const session = currentSession();
            if (!session || !Array.isArray(session.messages)) return false;
            let index = -1;
            const midText = String(mid || '');
            if (midText) {
                index = session.messages.findIndex((message) => message && message._mid === midText);
            }
            if (index < 0) {
                const fallback = Math.round(Number(liveIndex));
                if (Number.isFinite(fallback) && fallback >= 0 && fallback < session.messages.length &&
                    (!session.messages[fallback] || !session.messages[fallback]._mid || session.messages[fallback]._mid === midText)) {
                    index = fallback;
                }
            }
            if (index < 0) return false;
            return jumpToSessionMessage(index);
        },
        // 只把文本放进输入框，不自动发送：外部功能（如运行面板「发给 AI 分析」）用。
        // 触发原生 input 事件让自动高度 / 发送按钮 / 斜杠命令提示跟着更新。
        bridgeSetDraft: (text) => {
            if (!el.input) return false;
            open(true);
            el.input.value = String(text || '');
            el.input.dispatchEvent(new Event('input', {bubbles: true}));
            try {
                el.input.focus();
                const end = el.input.value.length;
                if (typeof el.input.setSelectionRange === 'function') el.input.setSelectionRange(end, end);
            } catch (e) { /* 焦点不可用时草稿仍已填入 */ }
            return true;
        },
        // 后台终端标签页（内容区）用的桥：快照 / 输出订阅 / 停止
        bridgeBgJob: (jobId) => bgJobSnapshot(String(jobId || '')),
        // 子代理详情标签页（内容区）用的桥：挂载/卸载视图根节点。正文渲染留在面板内，
        // 因为运行态、收件箱与插话输入行都在面板闭包里（标签页只提供容器与标签）。
        bridgeMountAgentView: (root, spec) => mountAgentView(root, spec),
        bridgeUnmountAgentView: (root) => unmountAgentView(root),
        // 内容区「支线对话」标签页：把会话渲染进宿主容器（复用面板渲染函数，
        // 面板单例 UI 在外渲染时跳过；滚动由宿主自己管）
        bridgeRenderSideChat: (root, sessionId) => renderSideChatInto(root, sessionId),
        // 支线标签页的状态与动作（薄转发，状态仍在面板闭包里）
        bridgeSideChatState: (id) => sideChatState(id),
        bridgeSideChatSend: (id, text) => sendSideChatMessage(id, text),
        bridgeSideChatStop: (id) => stopSideChatMessage(id),
        bridgeSideChatChips: (id) => sideChatChipsOf(id),
        bridgeSideChatChip: (kind) => openSideChatChip(kind),
        bridgeSideChatReturnToOwner: (id) => returnToSideChatOwner(id),
        bridgeSideChatPromote: (id) => promoteSideChatFromTab(id),
        bridgeSideChatTakeover: (root, id) => renderSideChatTakeover(root, id),
        bridgeSideChatClick: (e, id) => sideChatClick(e, id),
        // 面板切换会话（支线标签页据此判定在位 / 失联）；返回取消订阅
        bridgeOnSessionSwitch: (cb) => {
            if (typeof cb !== 'function') return () => {};
            sessionSwitchListeners.add(cb);
            return () => sessionSwitchListeners.delete(cb);
        },
        bridgeOnBgUpdate: (cb) => {
            if (typeof cb !== 'function') return () => {};
            bgUpdateListeners.add(cb);
            return () => bgUpdateListeners.delete(cb);
        },
        bridgeStopBgJob: async (jobId) => bridgeStopBgJob(String(jobId || '')),
        bridgeListSessions: () => (sessions || []).map((s) => ({
            id: s.id,
            title: s.title,
            scope: s.scope || 'read',
            workspace: s.workspace || '',
            planMode: !!s.planMode,
            messages: sessionMessageCount(s),
            active: s.id === (config && config.activeSessionId),
        })),
        // 结构面板的「会话结构」数据源：当前会话里的用户消息（用户消息定位条）
        bridgeSessionOutline: () => sessionOutlineSnapshot(),
        bridgeJumpToMessage: (index) => jumpToSessionMessage(index),
        bridgeGetState: () => {
            const session = currentSession();
            const profile = profileOf(session);
            const entry = entryOf(session);
            return {
                open: isOpen(),
                mode,
                scope: session ? currentScopeOf(session) : '',
                planMode: !!(session && session.planMode),
                profile: profile ? {
                    id: profile.id,
                    name: profile.name,
                    provider: profile.provider,
                    model: entry && entry.model ? entry.model : '',
                    contextWindow: entry ? entry.contextWindow : 0,
                } : null,
                activeProfileId: config.activeProfileId || '',
                activeModelId: config.activeModelId || '',
                profiles: (config.profiles || []).map((item) => ({
                    id: item.id,
                    name: item.name,
                    provider: item.provider,
                    models: (item.models || []).map((model) => ({
                        id: model.id,
                        model: model.model,
                    })),
                })),
                memoryMode: config.memoryMode === 'app' ? 'app' : 'workspace',
                preferences: (config.preferences || []).length,
                session: session ? {
                    id: session.id,
                    title: session.title,
                    workspace: session.workspace || '',
                    messages: sessionMessageCount(session),
                    round: Number(session.round) || 0,
                    archived: !!session.archivedAt,
                } : null,
            };
        },
    };
}
