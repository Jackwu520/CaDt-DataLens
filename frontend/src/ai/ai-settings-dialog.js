// ai-settings-dialog.js：AI 设置页（权限规则/偏好/模型编辑器/导入导出/绑定接线 + 状态条）。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移。
// config 为重赋值 let（经 getConfig() 读）；sessions 写经 setSessions；modelEditorState 与
// settingsStatusTimer 为本域私有 let 随域迁入；skillsCache/permissionAudit 经访问器触达。
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

export function createAISettingsDialog(ctx) {
    const el = ctx.el;
    const panel = ctx.panel;
    const opt = ctx.opt;
    const settings = ctx.settings;
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
    window.addEventListener('cadt-plugins-loaded', renderLocalClassifierSettings);
    let semanticAutoRecheckDone = false; // 注册表空时的自动补扫，每会话一次（见 renderLocalClassifierSettings）
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
    const messageQueue = ctx.messageQueue;
    const getSessions = ctx.getSessions;
    const updateCtxBanner = ctx.updateCtxBanner;

    // —— 随域迁入的设置编辑器状态（原 ai-panel.js 闭包级）——
    let modelEditorState = null;
    let settingsStatusTimer = 0;

    function renderApprovedSettings() {
        if (!opt.approved) return;
        opt.approved.innerHTML = '';
        const paths = getConfig().approvedPaths || [];
        if (!paths.length) {
            const empty = document.createElement('span');
            empty.className = 'ai-approved-empty';
            empty.textContent = '（无，所有写操作每次询问）';
            opt.approved.appendChild(empty);
        } else {
            for (const path of paths) {
                const row = document.createElement('div');
                row.className = 'ai-approved-row';
                const text = document.createElement('span');
                text.className = 'ai-approved-path';
                text.textContent = path;
                text.title = path;
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'ai-approved-remove';
                remove.title = '移除授权';
                remove.textContent = '×';
                remove.addEventListener('click', () => {
                    getConfig().approvedPaths = getConfig().approvedPaths.filter((item) => aiPathKey(item) !== aiPathKey(path));
                    saveAIConfig();
                    renderApprovedSettings();
                    flash('已移除授权：' + path);
                });
                row.append(text, remove);
                opt.approved.appendChild(row);
            }
        }
        if (opt.approvedClear) opt.approvedClear.disabled = !(getConfig().approvedPaths || []).length;
    }

    const PERMISSION_KIND_LABELS = {command: 'Bash', write: 'Write', web: 'Web'};
    const AUDIT_SOURCE_LABELS = {
        readonly: '只读命令',
        family: '已知命令族',
        classifier: 'AI 分类器',
        'local-classifier': '端侧分类器',
        session: '本会话授权',
        project: '项目规则',
        full: '完全权限',
        dangerous: '危险命令',
        risky: '风险路径',
        scope: '逐次询问',
        default: '默认放行',
        user: '用户批准',
    };

    function sessionRulePattern(rule) {
        if (!rule) return '';
        return rule.mode === 'family'
            ? String(rule.signature || '') + ':*'
            : commandText(rule.command);
    }

    function auditRulePattern(entry) {
        if (!entry) return '';
        if (entry.kind === 'command') {
            const family = commandFamilySignature(entry.subject);
            return family ? family.signature + ':*' : commandText(entry.subject);
        }
        if (entry.kind === 'write') return writeRuleSubject(entry.subject);
        if (entry.kind === 'web') {
            return entry.subject.startsWith('domain:')
                ? entry.subject
                : (webRuleSubject(entry.subject) || entry.subject);
        }
        return '';
    }

    function removeCommandApprovalRule(session, rule) {
        if (!session || !session.id) return false;
        const list = commandRulesFor(session);
        const index = list.indexOf(rule);
        if (index < 0) return false;
        list.splice(index, 1);
        if (!list.length) commandApprovalRules.delete(session.id);
        return true;
    }

    async function removeProjectRule(kind, behavior, rule) {
        return enqueueProjectRulesMutation(async () => {
            const current = await ensureProjectRules(true);
            const next = normalizePermissionRules(current);
            const list = next[kind] && next[kind][behavior];
            if (!list) return false;
            const index = list.findIndex((item) => item.toLowerCase() === String(rule || '').toLowerCase());
            if (index < 0) return false;
            list.splice(index, 1);
            await saveProjectRules(next);
            renderPermissionSettings();
            refreshPermissionEditors().catch(() => {});
            return true;
        });
    }

    function projectRuleRow(kind, behavior, rule) {
        const row = document.createElement('div');
        row.className = 'ai-perm-row';
        const kindLabel = document.createElement('span');
        kindLabel.className = 'ai-perm-kind';
        kindLabel.textContent = PERMISSION_KIND_LABELS[kind] || kind;
        const pattern = document.createElement('span');
        pattern.className = 'ai-perm-pattern';
        pattern.textContent = rule;
        pattern.title = rule;
        const badge = document.createElement('span');
        badge.className = 'ai-perm-decision ' + behavior;
        badge.textContent = behavior;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'ai-perm-mini';
        remove.title = '删除这条规则';
        remove.textContent = '×';
        remove.addEventListener('click', () => {
            removeProjectRule(kind, behavior, rule).then((removed) => {
                if (removed) flash('已删除项目规则：' + rule);
            }).catch((e) => flash('删除失败：' + ((e && e.message) || e), true));
        });
        row.append(kindLabel, pattern, badge, remove);
        return row;
    }

    function renderProjectRuleTable() {
        if (!opt.permissionTable) return;
        const rules = currentProjectRules();
        opt.permissionTable.innerHTML = '';
        let total = 0;
        for (const behavior of ['deny', 'ask', 'allow']) {
            for (const kind of ['command', 'write', 'web']) {
                for (const rule of rules[kind][behavior]) {
                    total += 1;
                    opt.permissionTable.appendChild(projectRuleRow(kind, behavior, rule));
                }
            }
        }
        if (!total) {
            const empty = document.createElement('span');
            empty.className = 'ai-approved-empty';
            empty.textContent = '（没有项目规则；可在下方添加，或从「最近审批」一键成规则）';
            opt.permissionTable.appendChild(empty);
        }
    }

    // 分类器模型下拉：跟随当前模型（默认）+ 所有账号下的模型条目。
    // logPermission 每条审批记录都会触发本页重渲，用签名比对避免重建下拉打断交互。
    function renderClassifierModelOptions() {
        if (!opt.permissionClassifierModel) return;
        const select = opt.permissionClassifierModel;
        const signature = getConfig().profiles.map((account) =>
            account.id + ':' + (account.models || []).map((entry) =>
                entry.id + ':' + (modelRefLabel(account, entry) || '')).join(',')).join('|');
        if (select.dataset.optionsSig !== signature) {
            select.dataset.optionsSig = signature;
            select.innerHTML = '';
            const follow = document.createElement('option');
            follow.value = '';
            follow.textContent = '跟随当前模型（默认）';
            select.appendChild(follow);
            for (const account of getConfig().profiles) {
                for (const entry of (account.models || [])) {
                    const option = document.createElement('option');
                    option.value = account.id + '|' + entry.id;
                    option.textContent = modelRefLabel(account, entry) || (account.id + '|' + entry.id);
                    select.appendChild(option);
                }
            }
        }
        const wanted = resolveModelRef(getConfig().autoClassifierModel, getConfig().profiles);
        if (select.value !== wanted) select.value = wanted;
    }

    // 端侧分类器设置区（docs/unfinished-plans/local-command-classifier.md §5/§7）：
    // 开关、严格度、个性化、测试框（不产生审批记录）、重置 / 清空 / 导出。
    let localClassifierTestTimer = 0;
    const LOCAL_CLASSIFIER_STRICTNESS_NAMES = {loose: '宽松', standard: '标准', strict: '严格'};

    function renderLocalClassifierSettings() {
        if (!opt.localClassifierStatus) return;
        if (opt.localLinear) opt.localLinear.value = getConfig().localClassifierLinear === 'off' ? 'off' : 'builtin';
        renderSemanticModelOptions();
        if (opt.localClassifierStrictness) opt.localClassifierStrictness.value = normalizeLocalClassifierStrictness(getConfig().localClassifierStrictness);
        if (opt.localClassifierPersonalize) opt.localClassifierPersonalize.checked = getConfig().localClassifierPersonalize === true;
        renderLocalClassifierStatus();
        // 时序兜底（实测事故：启动加载早已完成但注册表是空的，手动点刷新才出来）：
        // 渲染时注册表空且无加载错误 → 自动补一次重扫；每次会话只补一次防循环，
        // 完成后经 cadt-plugins-loaded 事件回填下拉与状态行
        const pluginsNow = typeof getPluginCommandClassifiers === 'function' ? getPluginCommandClassifiers() : [];
        const loadErrorsNow = getPluginLoadErrors ? getPluginLoadErrors() : [];
        if (!pluginsNow.length && !loadErrorsNow.length && !semanticAutoRecheckDone && refreshPlugins) {
            semanticAutoRecheckDone = true;
            Promise.resolve(refreshPlugins()).catch(() => {}); // loadPlugins 自己收集错误，完成后事件回填
        }
    }

    // 语义模型下拉：全部已装（默认）/ 各已注册分类器 / 关闭；当前值被卸载时补一条「未找到」保显示
    function renderSemanticModelOptions() {
        if (!opt.localSemantic) return;
        const plugins = typeof getPluginCommandClassifiers === 'function' ? getPluginCommandClassifiers() : [];
        const wanted = getConfig().localClassifierSemantic || '';
        opt.localSemantic.innerHTML = '';
        const add = (value, text) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = text;
            opt.localSemantic.appendChild(option);
        };
        add('', '全部已装（默认）');
        for (const item of plugins) add(item.id, item.label || item.id);
        add('off', '关闭');
        if (wanted && wanted !== 'off' && !plugins.some((item) => item.id === wanted)) add(wanted, wanted + '（未找到）');
        opt.localSemantic.value = wanted;
    }

    function renderLocalClassifierStatus() {
        if (!opt.localClassifierStatus) return;
        const plugins = typeof getPluginCommandClassifiers === 'function' ? getPluginCommandClassifiers() : [];
        const semanticSetting = getConfig().localClassifierSemantic || '';
        // 语义模型位按当前选择过滤：关闭 / 指定一个 / 全部
        const visibleSemantic = semanticSetting === 'off'
            ? []
            : (semanticSetting ? plugins.filter((item) => item.id === semanticSetting) : plugins);
        // 插件已安装但加载失败时如实显示原因，不误报「未安装」
        const loadErrors = getPluginLoadErrors ? getPluginLoadErrors() : [];
        // 语义模型跳转口：语义模型位无可用模型时显示，一键带 onnx 关键词跳插件市场搜索
        if (opt.localClassifierMarket) {
            opt.localClassifierMarket.classList.toggle('hidden', visibleSemantic.length > 0);
            opt.localClassifierMarket.onclick = () => openSettings('plugins', 'onnx');
        }
        let pluginPart;
        if (semanticSetting === 'off') pluginPart = '语义模型已关闭';
        else if (visibleSemantic.length) pluginPart = '插件：' + visibleSemantic.map((p) => p.label || p.id).join('、');
        else if (semanticSetting) pluginPart = '语义模型未找到（' + semanticSetting + '）';
        else pluginPart = loadErrors.length ? '插件加载失败：' + loadErrors[0] : '语义模型未安装';
        if (getConfig().localClassifierEnabled !== true) {
            opt.localClassifierStatus.textContent = pluginPart || '未启用';
            return;
        }
        const mod = typeof localClassifier === 'function' ? localClassifier() : null;
        if (!mod) {
            opt.localClassifierStatus.textContent = pluginPart || '不可用';
            return;
        }
        mod.ensureLoaded().then(() => {
            const st = mod.getStatus();
            const bits = [getConfig().localClassifierLinear === 'off' ? '线性已关闭' : '出厂 ' + (st.factoryVersion || '—')];
            if (getConfig().localClassifierPersonalize === true) {
                bits.push('样本 ' + st.sampleCount);
                bits.push('delta ' + st.deltaDims + ' 维');
                if (st.trainedAt) bits.push('最近学习 ' + new Date(st.trainedAt).toLocaleString());
            }
            if (st.disabled.length) bits.push('已熔断：' + st.disabled.join('、'));
            if (pluginPart) bits.push(pluginPart);
            opt.localClassifierStatus.textContent = bits.join(' · ');
        }).catch(() => {
            opt.localClassifierStatus.textContent = '权重加载失败';
        });
    }

    function runLocalClassifierTest() {
        if (!opt.localClassifierTestResult) return;
        const command = (opt.localClassifierTest.value || '').trim();
        if (!command) {
            opt.localClassifierTestResult.textContent = '';
            return;
        }
        if (getConfig().localClassifierEnabled !== true) {
            opt.localClassifierTestResult.textContent = '端侧分类器未启用';
            return;
        }
        const mod = typeof localClassifier === 'function' ? localClassifier() : null;
        if (!mod) return;
        mod.scoreText(command).then((r) => {
            opt.localClassifierTestResult.textContent = 'score=' + r.score.toFixed(2) + ' → '
                + (r.verdict.allow ? '放行' : '转人工') + '（' + LOCAL_CLASSIFIER_STRICTNESS_NAMES[normalizeLocalClassifierStrictness(getConfig().localClassifierStrictness)]
                + ' 阈值 ' + r.verdict.threshold + (r.deltaDims ? ' · delta ' + r.deltaDims + ' 维' : '') + '）';
        }).catch((e) => {
            opt.localClassifierTestResult.textContent = '打分失败：' + ((e && e.message) || e);
        });
    }

    function renderPermissionSettings() {
        if (opt.permissionsPath) {
            const path = projectRulesPath();
            opt.permissionsPath.textContent = path || '（未打开工作区）';
            opt.permissionsPath.title = path || '';
        }
        if (opt.permissionClassifier) opt.permissionClassifier.checked = getConfig().autoClassifier === true;
        renderClassifierModelOptions();
        renderLocalClassifierSettings();
        if (opt.permissionsSession) {
            opt.permissionsSession.innerHTML = '';
            const session = currentSession();
            const rules = session ? commandRulesFor(session) : [];
            if (!rules.length) {
                const empty = document.createElement('span');
                empty.className = 'ai-approved-empty';
                empty.textContent = '（无；审批卡里的「本会话允许」会出现在这里）';
                opt.permissionsSession.appendChild(empty);
            } else {
                for (const rule of rules.slice().reverse()) {
                    const row = document.createElement('div');
                    row.className = 'ai-approved-row';
                    const text = document.createElement('span');
                    text.className = 'ai-approved-path';
                    text.textContent = (rule.mode === 'family' ? '同类命令 ' : '相同命令 ') + (rule.signature || rule.command);
                    text.title = (rule.cwd || '') + ' · ' + (rule.signature || rule.command);
                    const cwd = document.createElement('span');
                    cwd.className = 'ai-perm-cwd';
                    cwd.textContent = rule.cwd || '';
                    cwd.title = rule.cwd || '';
                    const project = document.createElement('button');
                    project.type = 'button';
                    project.className = 'ai-perm-mini';
                    project.title = '把这条授权写入项目规则（allow）';
                    project.textContent = '存入项目';
                    project.addEventListener('click', () => {
                        const pattern = sessionRulePattern(rule);
                        if (!pattern) return;
                        addProjectRule('command', 'allow', pattern).then((added) => {
                            flash(added
                                ? '已加入项目规则：' + pattern + ' → allow'
                                : '项目规则已存在：' + pattern);
                        }).catch((e) => flash('保存失败：' + ((e && e.message) || e), true));
                    });
                    const remove = document.createElement('button');
                    remove.type = 'button';
                    remove.className = 'ai-perm-mini';
                    remove.title = '删除本会话这条授权';
                    remove.textContent = '×';
                    remove.addEventListener('click', () => {
                        if (!removeCommandApprovalRule(session, rule)) return;
                        renderPermissionSettings();
                        flash('已删除本会话授权');
                    });
                    row.append(text, cwd, project, remove);
                    opt.permissionsSession.appendChild(row);
                }
            }
            if (opt.permissionsSessionClear) opt.permissionsSessionClear.disabled = !rules.length;
        }
        if (opt.permissionsLog) {
            opt.permissionsLog.innerHTML = '';
            if (!getPermissionAudit().length) {
                const empty = document.createElement('span');
                empty.className = 'ai-approved-empty';
                empty.textContent = '（本次运行还没有审批记录）';
                opt.permissionsLog.appendChild(empty);
            } else {
                const labels = {allow: '放行', ask: '审批', deny: '拒绝', classify: '分类'};
                for (const entry of getPermissionAudit().slice(-20).reverse()) {
                    const row = document.createElement('div');
                    row.className = 'ai-approved-row';
                    const badge = document.createElement('span');
                    badge.className = 'ai-perm-decision ' + entry.decision;
                    badge.textContent = labels[entry.decision] || entry.decision;
                    const text = document.createElement('span');
                    text.className = 'ai-approved-path';
                    text.textContent = entry.subject;
                    text.title = entry.subject + (entry.rule ? ' · ' + entry.rule : '');
                    const source = document.createElement('span');
                    source.className = 'ai-perm-cwd';
                    source.textContent = AUDIT_SOURCE_LABELS[entry.source] || entry.source || '';
                    source.title = (AUDIT_SOURCE_LABELS[entry.source] || entry.source || '') + (entry.rule ? ' · ' + entry.rule : '');
                    const time = document.createElement('span');
                    time.className = 'ai-perm-time';
                    time.textContent = new Date(entry.at).toLocaleTimeString();
                    const actions = document.createElement('span');
                    actions.className = 'ai-perm-row-actions';
                    const pattern = auditRulePattern(entry);
                    if (pattern) {
                        for (const behavior of ['allow', 'ask', 'deny']) {
                            const button = document.createElement('button');
                            button.type = 'button';
                            button.className = 'ai-perm-mini';
                            button.textContent = '+' + behavior;
                            button.title = '加入项目规则：' + pattern + ' → ' + behavior;
                            button.addEventListener('click', () => {
                                addProjectRule(entry.kind, behavior, pattern).then((added) => {
                                    flash(added
                                        ? '已加入项目规则：' + pattern + ' → ' + behavior
                                        : '项目规则已存在：' + pattern);
                                }).catch((e) => flash('保存失败：' + ((e && e.message) || e), true));
                            });
                            actions.appendChild(button);
                        }
                    }
                    row.append(badge, text, source, time, actions);
                    opt.permissionsLog.appendChild(row);
                }
            }
        }
    }

    async function refreshPermissionEditors(force) {
        if (!opt.permissionsAllow) return;
        const rules = await ensureProjectRules(force === true);
        opt.permissionsAllow.value = formatRuleLines(rules, 'allow');
        if (opt.permissionsAsk) opt.permissionsAsk.value = formatRuleLines(rules, 'ask');
        if (opt.permissionsDeny) opt.permissionsDeny.value = formatRuleLines(rules, 'deny');
        renderProjectRuleTable();
    }

    function renderPreferenceSettings() {
        if (!opt.prefs) return;
        opt.prefs.innerHTML = '';
        const prefs = getConfig().preferences || [];
        const query = opt.prefFilter ? String(opt.prefFilter.value || '').trim().toLowerCase() : '';
        const shown = query ? prefs.filter((pref) => String(pref.text).toLowerCase().includes(query)) : prefs;
        if (!prefs.length) {
            const empty = document.createElement('span');
            empty.className = 'ai-pref-empty';
            empty.textContent = '（暂无偏好；例如「回答用中文，尽量简洁」）';
            opt.prefs.appendChild(empty);
        } else if (!shown.length) {
            const empty = document.createElement('span');
            empty.className = 'ai-pref-empty';
            empty.textContent = '没有匹配「' + query + '」的偏好';
            opt.prefs.appendChild(empty);
        } else {
            for (const pref of shown) {
                const row = document.createElement('div');
                row.className = 'ai-pref-row';
                const text = document.createElement('span');
                text.className = 'ai-pref-text';
                text.textContent = pref.text;
                text.title = pref.text;
                const src = document.createElement('span');
                src.className = 'ai-pref-src';
                src.textContent = pref.source === 'ai' ? 'AI' : '你';
                src.title = pref.source === 'ai' ? '由 AI 记录' : '由你添加';
                const edit = document.createElement('button');
                edit.type = 'button';
                edit.className = 'ai-pref-btn';
                edit.title = '编辑';
                edit.textContent = '✎';
                edit.addEventListener('click', () => editPreference(pref));
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'ai-pref-btn';
                remove.title = '删除';
                remove.textContent = '×';
                remove.addEventListener('click', () => {
                    getConfig().preferences = getConfig().preferences.filter((item) => item.id !== pref.id);
                    saveAIConfig();
                    renderPreferenceSettings();
                    flash('已删除偏好：' + pref.text);
                });
                row.append(text, src, edit, remove);
                opt.prefs.appendChild(row);
            }
        }
        if (opt.prefCount) {
            opt.prefCount.textContent = query
                ? shown.length + ' / ' + prefs.length + ' 条'
                : prefs.length + ' 条';
        }
        if (opt.prefAdd) opt.prefAdd.disabled = prefs.length >= AI_PREF_LIMIT;
    }

    function submitPreferenceText(title, value, okLabel, onSubmit) {
        const validate = (raw) => {
            const text = String(raw || '').trim();
            if (!text) throw new Error('偏好内容不能为空');
            if (text.length > AI_PREF_TEXT_LIMIT) throw new Error('偏好最多 ' + AI_PREF_TEXT_LIMIT + ' 字符');
            return text;
        };
        if (showNameDialog) {
            showNameDialog({title, label: '偏好内容', value: value || '', okLabel, onSubmit: (raw) => onSubmit(validate(raw))});
            return;
        }
        const raw = window.prompt(title, value || '');
        if (raw == null) return;
        try {
            onSubmit(validate(raw));
        } catch (e) {
            flash((e && e.message) || String(e), true);
        }
    }

    function editPreference(pref) {
        submitPreferenceText('编辑偏好', pref.text, '保存', (text) => {
            pref.text = text;
            pref.updatedAt = Date.now();
            saveAIConfig();
            renderPreferenceSettings();
        });
    }

    function addPreference() {
        if ((getConfig().preferences || []).length >= AI_PREF_LIMIT) {
            flash('偏好数量已达上限（' + AI_PREF_LIMIT + ' 条）', true);
            return;
        }
        submitPreferenceText('添加偏好', '', '添加', (text) => {
            if (getConfig().preferences.some((pref) => pref.text === text)) throw new Error('已存在相同偏好');
            getConfig().preferences.push({
                id: aiNowId('pref-'),
                text,
                source: 'user',
                createdAt: Date.now(),
                updatedAt: Date.now(),
            });
            saveAIConfig();
            renderPreferenceSettings();
        });
    }


    function aiAddUnique(list, value) {
        if (!Array.isArray(list) || !value) return;
        const key = aiPathKey(value);
        if (!list.some((item) => aiPathKey(item) === key)) list.push(value);
    }

    function isPathApproved(session, path) {
        const key = aiPathKey(path);
        if ((getConfig().approvedPaths || []).some((item) => aiPathKey(item) === key)) return true;
        return !!(session && (session.approvedPaths || []).some((item) => aiPathKey(item) === key));
    }

    // 终端命令的会话级放行只存内存：重启应用或重新加载对话后需要重新授权。
    const commandApprovalRules = new Map();

    function commandRulesFor(session) {
        if (!session || !session.id) return [];
        return commandApprovalRules.get(session.id) || [];
    }

    function addCommandApprovalRule(session, rule) {
        if (!session || !session.id || !rule) return;
        const cwdKey = aiPathKey(rule.cwd);
        const command = rule.mode === 'exact' ? commandText(rule.command) : '';
        const signature = rule.mode === 'family' ? String(rule.signature || '') : '';
        if (rule.mode === 'exact' && !command) return;
        if (rule.mode === 'family' && !signature) return;
        const list = commandRulesFor(session);
        const exists = list.some((item) => item.mode === rule.mode && item.cwdKey === cwdKey &&
            (item.mode === 'exact' ? item.command === command : item.signature === signature));
        if (exists) return;
        list.push({
            mode: rule.mode,
            command,
            signature,
            cwdKey,
            cwd: aiNormalizePath(rule.cwd),
            createdAt: Date.now(),
        });
        if (list.length > 30) list.splice(0, list.length - 30);
        commandApprovalRules.set(session.id, list);
    }

    function matchCommandApproval(session, command, cwd) {
        const rules = commandRulesFor(session);
        if (!rules.length) return null;
        return matchCommandRule(rules, command, aiPathKey(cwd));
    }

    // ---------- 项目级权限规则（<工作区>/.cadt/permissions.json） ----------

    function projectRulesPath() {
        const root = aiProjectRoot();
        return root ? aiJoinPath(root, '.cadt/permissions.json') : '';
    }

    function projectRulesKey() {
        return aiWorkspaceKey(aiProjectRoot());
    }

    let projectRulesCache = {key: '', rules: emptyPermissionRules(), at: 0};
    // 规则文件是读-改-写：连续添加/删除必须串行，否则后一次会把前一次的结果覆盖掉。
    let projectRulesMutation = Promise.resolve();
    const PROJECT_RULES_TTL = 3000;

    function enqueueProjectRulesMutation(task) {
        const next = projectRulesMutation.then(task, task);
        projectRulesMutation = next.catch(() => {});
        return next;
    }

    function currentProjectRules() {
        if (projectRulesCache.key !== projectRulesKey()) return emptyPermissionRules();
        return projectRulesCache.rules;
    }

    async function ensureProjectRules(force) {
        const key = projectRulesKey();
        const path = projectRulesPath();
        if (!path) {
            projectRulesCache = {key, rules: emptyPermissionRules(), at: Date.now()};
            return projectRulesCache.rules;
        }
        if (!force && projectRulesCache.key === key && Date.now() - projectRulesCache.at < PROJECT_RULES_TTL) {
            return projectRulesCache.rules;
        }
        let rules = emptyPermissionRules();
        try {
            const read = await readTextFile(path, 256 << 10);
            if (read && read.text && read.text.trim()) {
                let parsed = null;
                try {
                    parsed = JSON.parse(read.text);
                } catch (e) {
                    parsed = null;
                }
                if (parsed && typeof parsed === 'object') rules = normalizePermissionRules(parsed);
            }
        } catch (e) {
            // 文件不存在 / 没有工作区：按空规则处理
        }
        projectRulesCache = {key, rules, at: Date.now()};
        return rules;
    }

    async function saveProjectRules(rules) {
        const path = projectRulesPath();
        if (!path) throw new Error('当前没有工作区，无法保存项目权限规则');
        const payload = {
            version: PERMISSION_VERSION,
            command: rules.command,
            write: rules.write,
            web: rules.web,
        };
        const text = JSON.stringify(payload, null, 2) + '\n';
        if (backend.AIEnsureDir) {
            try { await backend.AIEnsureDir(aiPathDir(path)); } catch (e) {}
        }
        await backend.SaveFile(path, text, 'lf', false, 'utf-8');
        projectRulesCache = {key: projectRulesKey(), rules: normalizePermissionRules(payload), at: Date.now()};
        return path;
    }

    async function addProjectRule(kind, behavior, rule) {
        return enqueueProjectRulesMutation(async () => {
            const current = await ensureProjectRules(true);
            const next = normalizePermissionRules(current);
            const list = next[kind] && next[kind][behavior];
            const text = String(rule || '').trim();
            if (!list || !text) return false;
            if (list.some((item) => item.toLowerCase() === text.toLowerCase())) return false;
            list.push(text);
            await saveProjectRules(next);
            renderPermissionSettings();
            refreshPermissionEditors().catch(() => {});
            return true;
        });
    }

    // ---------- 审批记录（内存，最多 60 条） ----------


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
        for (const node of [opt.name, opt.provider, opt.baseURL, opt.apiKey, opt.model, opt.temp, opt.maxTokens, opt.reasoning, opt.thinking, opt.budget, opt.contextWindow, opt.proxy, opt.proxyURL, opt.headers, opt.test, opt.models, opt.entryAdd, opt.entryDel]) {
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
        const entry = editorEntryOf(profile);
        const anthropic = !!profile && profile.provider === 'anthropic';
        if (opt.thinkingGroup) opt.thinkingGroup.classList.toggle('hidden', !anthropic);
        if (opt.reasoningGroup) opt.reasoningGroup.classList.toggle('hidden', !profile || anthropic);
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
    function editorEntryOf(profile) {
        if (!profile) return null;
        if (modelEditorState && modelEditorState.entryId) {
            const found = (profile.models || []).find((item) => item.id === modelEditorState.entryId);
            if (found) return found;
        }
        if (profile.id === getConfig().activeProfileId) return modelEntryOf(profile, getConfig().activeModelId);
        return modelEntryOf(profile, profile.lastModelId);
    }

    function refreshSettingsPane() {
        const profile = activeProfile();
        const entry = editorEntryOf(profile);
        renderProfileSelect();
        refreshThinkingVisibility();
        settingsFormDisabled(!profile);
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
            renderModelEntries();
            return;
        }
        if (opt.name) opt.name.value = profile.name;
        if (opt.provider) opt.provider.value = profile.provider;
        if (opt.baseURL) opt.baseURL.value = profile.baseURL;
        if (opt.apiKey) opt.apiKey.value = profile.apiKey;
        if (opt.model) opt.model.value = entry.model;
        if (opt.temp) opt.temp.value = String(profile.temperature);
        if (opt.tempVal) opt.tempVal.textContent = String(profile.temperature);
        if (opt.maxTokens) opt.maxTokens.value = formatTokenAmount(entry.outputWindow);
        if (opt.reasoning) opt.reasoning.value = entry.reasoningEffort || '';
        if (opt.thinking) opt.thinking.checked = entry.thinking === true;
        if (opt.budget) opt.budget.value = String(entry.thinkingBudget);
        if (opt.contextWindow) opt.contextWindow.value = formatTokenAmount(entry.contextWindow);
        if (opt.modalities) {
            for (const node of opt.modalities.querySelectorAll('input[data-modality]')) {
                node.checked = entry.modalities[node.dataset.modality] !== false;
            }
        }
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
        renderModelEntries();
    }

    function refreshChatSettings() {
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
        if (opt.assistantCard) opt.assistantCard.checked = settings.aiAssistantCard === true;
        if (opt.inlineWidgets) opt.inlineWidgets.checked = settings.aiInlineWidgets !== false;
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
        renderApprovedSettings();
        renderPreferenceSettings();
        renderPermissionSettings();
        refreshPermissionEditors().catch(() => {});
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

    function renderPresetSelect() {
        if (!opt.preset) return;
        opt.preset.innerHTML = '';
        for (const preset of AI_PRESETS) {
            const option = document.createElement('option');
            option.value = preset.id;
            option.textContent = preset.name;
            opt.preset.appendChild(option);
        }
    }

    function refreshPromptSettings() {
        if (!opt.prompt) return;
        const previous = opt.prompt.value;
        opt.prompt.innerHTML = '';
        for (const prompt of getConfig().prompts) {
            const option = document.createElement('option');
            option.value = prompt.id;
            option.textContent = prompt.name + (prompt.builtin ? '（内置）' : '') +
                (prompt.id === getConfig().activePromptId ? ' · 默认' : '');
            opt.prompt.appendChild(option);
        }
        if (previous && promptById(previous)) opt.prompt.value = previous;
        else opt.prompt.value = getConfig().activePromptId || (getConfig().prompts[0] && getConfig().prompts[0].id) || '';
        const selected = promptById(opt.prompt.value);
        if (opt.promptText) opt.promptText.value = selected ? selected.content : '';
        if (opt.promptDel) opt.promptDel.disabled = !selected || !!selected.builtin;
    }

    function addPresetProfile() {
        if (!opt.preset) return;
        const preset = AI_PRESETS.find((item) => item.id === opt.preset.value);
        if (!preset) return;
        const profile = defaultProfile();
        profile.name = preset.name;
        profile.provider = preset.provider;
        profile.baseURL = preset.baseURL;
        profile.models[0].model = preset.model;
        getConfig().profiles.push(profile);
        getConfig().activeProfileId = profile.id;
        saveAIConfig();
        renderProfileSelect();
        renderModelList();
        openModelEditor(profile.id);
        setSettingsStatus('预设已添加：' + preset.name + '，请填写 API Key', 'ok');
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
            empty.textContent = '还没有模型账号。点击下方「新建账号」，或选择一个预设后添加。';
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
        refreshSettingsPane();
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
            setSettingsStatus('至少需要一个模型 ID', 'error');
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
                setSettingsStatus('账号名称不能为空', 'error');
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
            refreshSettingsPane();
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
        refreshSettingsPane();
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
                refreshSettingsPane();
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
        refreshSettingsPane();
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
            setSettingsStatus('账号至少保留一个模型', 'error');
            return;
        }
        const current = editorEntryOf(profile);
        if (!current) return;
        profile.models = profile.models.filter((entry) => entry.id !== current.id);
        const next = profile.models[0];
        if (modelEditorState) modelEditorState.entryId = next.id;
        if (profile.id === getConfig().activeProfileId) getConfig().activeModelId = next.id;
        saveAIConfig();
        refreshSettingsPane();
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
        refreshSettingsPane();
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
            refreshSettingsPane();
            renderProfileSelect();
            renderModelList();
            updateComposerState();
            flash('已删除模型账号：' + (profile.name || '未命名'));
        }, '删除', '删除模型账号');
    }

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
                aiAddUnique(getConfig().approvedPaths, pathValue);
            }
            for (const name of Array.isArray(data.disabledSkills) ? data.disabledSkills : []) {
                aiAddUnique(getConfig().disabledSkills, name);
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
            refreshSettingsPane();
            refreshChatSettings();
            refreshPromptSettings();
            renderProfileSelect();
            updateComposerState();
            renderModelList();
            if (isOpen()) renderMessages(true);
            setSettingsStatus('已导入 ' + importedProfiles + ' 个模型账号', 'ok');
        } catch (e) {
            flash('导入失败：' + ((e && e.message) || e), true);
        }
    }

    // 账号级字段写入口（模型级字段走 editorEntryOf + 各自 handler）
    function updateProfileField(field, value) {
        const profile = activeProfile();
        if (!profile) return;
        profile[field] = value;
        saveAIConfig();
        if (field === 'name' || field === 'provider') renderProfileSelect();
        if (field === 'provider') refreshThinkingVisibility();
        if (['name', 'provider', 'baseURL', 'apiKey'].includes(field) && opt.modelList) renderModelList();
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
            updateProfileField('provider', opt.provider.value === 'anthropic' ? 'anthropic' : 'openai');
            const profile = activeProfile();
            const entry = editorEntryOf(profile);
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
            const entry = editorEntryOf(profile);
            if (!profile || !entry) return;
            entry.model = String(opt.model.value || '').trim();
            saveAIConfig();
            if (opt.modelEntries) renderModelEntries();
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
            const entry = editorEntryOf(profile);
            if (!profile || !entry) return;
            entry.outputWindow = windowValue(opt.maxTokens.value, OUTPUT_WINDOW_MIN, OUTPUT_WINDOW_MAX, entry.outputWindow);
            clampThinkingBudget(profile, entry, 'outputWindow');
            opt.maxTokens.value = formatTokenAmount(entry.outputWindow);
            saveAIConfig();
            refreshSettingsPane();
        });
        if (opt.reasoning) opt.reasoning.addEventListener('change', () => {
            const profile = activeProfile();
            const entry = editorEntryOf(profile);
            if (!profile || !entry) return;
            entry.reasoningEffort = opt.reasoning.value || '';
            saveAIConfig();
            renderModelChip();
        });
        if (opt.thinking) opt.thinking.addEventListener('change', () => {
            const profile = activeProfile();
            const entry = editorEntryOf(profile);
            if (!profile || !entry) return;
            entry.thinking = !!opt.thinking.checked;
            clampThinkingBudget(profile, entry, 'thinking');
            saveAIConfig();
            refreshSettingsPane();
            if (entry.thinking) setSettingsStatus('扩展思考已开启：请求省略 temperature，预算 ' + entry.thinkingBudget, 'ok');
        });
        if (opt.budget) opt.budget.addEventListener('change', () => {
            const profile = activeProfile();
            const entry = editorEntryOf(profile);
            if (!profile || !entry) return;
            entry.thinkingBudget = aiClampInt(opt.budget.value, 1024, 393215, 8000);
            clampThinkingBudget(profile, entry, 'thinkingBudget');
            saveAIConfig();
            refreshSettingsPane();
            setSettingsStatus('思考预算已设为 ' + entry.thinkingBudget + ' tokens', 'ok');
        });
        if (opt.contextWindow) opt.contextWindow.addEventListener('change', () => {
            const profile = activeProfile();
            const entry = editorEntryOf(profile);
            if (!profile || !entry) return;
            entry.contextWindow = windowValue(opt.contextWindow.value, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX, entry.contextWindow);
            opt.contextWindow.value = formatTokenAmount(entry.contextWindow);
            saveAIConfig();
            renderModelEntries();
            updateContextCount();
        });
        if (opt.modalities) {
            opt.modalities.addEventListener('change', () => {
                const profile = activeProfile();
                const entry = editorEntryOf(profile);
                if (!profile || !entry) return;
                for (const node of opt.modalities.querySelectorAll('input[data-modality]')) {
                    entry.modalities[node.dataset.modality] = !!node.checked;
                }
                saveAIConfig();
                updateComposerState();
            });
        }
        if (opt.entryAdd) opt.entryAdd.addEventListener('click', addEditorEntry);
        if (opt.entryDel) opt.entryDel.addEventListener('click', deleteEditorEntry);
        if (opt.keyToggle) opt.keyToggle.addEventListener('click', () => {
            if (!opt.apiKey) return;
            const show = opt.apiKey.type === 'password';
            opt.apiKey.type = show ? 'text' : 'password';
            opt.keyToggle.textContent = show ? '隐藏' : '显示';
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
        if (opt.prefAdd) opt.prefAdd.addEventListener('click', () => addPreference());
        if (opt.scheduleAdd) opt.scheduleAdd.addEventListener('click', () => openScheduleEditor(null));
        if (opt.prefFilter) opt.prefFilter.addEventListener('input', () => renderPreferenceSettings());
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
                renderApprovedSettings();
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
            renderLocalClassifierStatus();
            setSettingsStatus(getConfig().localClassifierLinear === 'off' ? '线性模型：已关闭' : '线性模型：内置线性模型', 'ok');
        });
        if (opt.localSemantic) opt.localSemantic.addEventListener('change', () => {
            getConfig().localClassifierSemantic = opt.localSemantic.value;
            saveAIConfig();
            renderLocalClassifierStatus();
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
            renderLocalClassifierSettings();
            setSettingsStatus('已重新扫描插件与模型注册状态', 'ok');
        });
        if (opt.localClassifierStrictness) opt.localClassifierStrictness.addEventListener('change', () => {
            getConfig().localClassifierStrictness = normalizeLocalClassifierStrictness(opt.localClassifierStrictness.value);
            saveAIConfig();
            setSettingsStatus('端侧分类器严格度：' + LOCAL_CLASSIFIER_STRICTNESS_NAMES[getConfig().localClassifierStrictness], 'ok');
        });
        if (opt.localClassifierPersonalize) opt.localClassifierPersonalize.addEventListener('change', () => {
            getConfig().localClassifierPersonalize = !!opt.localClassifierPersonalize.checked;
            saveAIConfig();
            renderLocalClassifierStatus();
            setSettingsStatus(getConfig().localClassifierPersonalize
                ? '个性化学习：已开启（学习你在端侧审批卡上的裁定）'
                : '个性化学习：已关闭', 'ok');
        });
        if (opt.localClassifierTest) opt.localClassifierTest.addEventListener('input', () => {
            if (localClassifierTestTimer) clearTimeout(localClassifierTestTimer);
            localClassifierTestTimer = setTimeout(runLocalClassifierTest, 250);
        });
        if (opt.localClassifierReset) opt.localClassifierReset.addEventListener('click', () => {
            const mod = typeof localClassifier === 'function' ? localClassifier() : null;
            if (!mod) return;
            askConfirm('重置端侧分类器？丢弃个性化修正，回到出厂权重（学习样本保留，可重训）。', () => {
                mod.resetToFactory().then(() => {
                    renderLocalClassifierStatus();
                    setSettingsStatus('端侧分类器已重置回出厂权重', 'ok');
                }).catch((e) => setSettingsStatus('重置失败：' + ((e && e.message) || e), 'error'));
            }, '重置', '重置分类器');
        });
        if (opt.localClassifierClear) opt.localClassifierClear.addEventListener('click', () => {
            const mod = typeof localClassifier === 'function' ? localClassifier() : null;
            if (!mod) return;
            askConfirm('清空端侧分类器的全部学习数据（样本 + 个性化修正）？该操作不可撤销。', () => {
                mod.clearLearningData().then(() => {
                    renderLocalClassifierStatus();
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
            enqueueProjectRulesMutation(() => saveProjectRules(rules)).then(() => {
                setSettingsStatus('项目权限规则已保存（' + countPermissionRules(rules) + ' 条）', 'ok');
                renderPermissionSettings();
                refreshPermissionEditors(true).catch(() => {});
            }).catch((e) => {
                setSettingsStatus('保存失败：' + ((e && e.message) || e), 'error');
            });
        });
        if (opt.permissionsReload) opt.permissionsReload.addEventListener('click', () => {
            refreshPermissionEditors(true).then(() => {
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
            addProjectRule(kind, behavior, pattern).then((added) => {
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
            if (!session || !commandRulesFor(session).length) return;
            commandApprovalRules.delete(session.id);
            renderPermissionSettings();
            setSettingsStatus('已清除本会话命令授权', 'ok');
        });
        if (opt.presetAdd) opt.presetAdd.addEventListener('click', addPresetProfile);
        if (opt.modelCreate) opt.modelCreate.addEventListener('click', () => openModelEditor(null));
        if (opt.modelEditorClose) opt.modelEditorClose.addEventListener('click', () => closeModelEditor(false));
        if (opt.modelEditorMask) opt.modelEditorMask.addEventListener('click', () => closeModelEditor(false));
        if (opt.modelEditorCancel) opt.modelEditorCancel.addEventListener('click', () => closeModelEditor(false));
        if (opt.modelEditorSave) opt.modelEditorSave.addEventListener('click', () => closeModelEditor(true));
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modelEditorState) {
                e.preventDefault();
                e.stopPropagation();
                closeModelEditor(false);
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
            refreshPromptSettings();
            updateContextCount();
            setSettingsStatus('模板已保存：' + selected.name, 'ok');
        });
        if (opt.promptNew) opt.promptNew.addEventListener('click', () => {
            const content = String((opt.promptText && opt.promptText.value) || '').trim() || AI_DEFAULT_SYSTEM_PROMPT;
            const create = (name) => {
                const prompt = {id: aiNowId('prompt-'), name: String(name || '').trim().slice(0, 40) || '新模板', content, builtin: false};
                getConfig().prompts.push(prompt);
                saveAIConfig();
                refreshPromptSettings();
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
                refreshPromptSettings();
                updateContextCount();
                setSettingsStatus('已删除模板：' + selected.name, 'ok');
            }, '删除', '删除模板');
        });
        if (opt.promptDefault) opt.promptDefault.addEventListener('click', () => {
            const selected = promptById(opt.prompt && opt.prompt.value);
            if (!selected) return;
            getConfig().activePromptId = selected.id;
            saveAIConfig();
            refreshPromptSettings();
            updateContextCount();
            setSettingsStatus('默认提示词模板：' + selected.name, 'ok');
        });
        if (opt.exportBtn) opt.exportBtn.addEventListener('click', exportAIConfig);
        if (opt.importBtn) opt.importBtn.addEventListener('click', importAIConfig);
        if (opt.clearSessions) opt.clearSessions.addEventListener('click', () => {
            askConfirm('清空全部 AI 会话（含消息、任务清单与变更记录）？', () => {
                setSessions([createSessionData()]);
                commandApprovalRules.clear();
                messageQueue.length = 0;
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
        renderPresetSelect();
        refreshPromptSettings();
    }
    return {
        renderApprovedSettings,
        renderProjectRuleTable,
        renderPermissionSettings,
        refreshPermissionEditors,
        renderPreferenceSettings,
        submitPreferenceText,
        editPreference,
        addPreference,
        aiAddUnique,
        commandRulesFor,
        enqueueProjectRulesMutation,
        saveProjectRules,
        addProjectRule,
        setSettingsStatus,
        settingsFormDisabled,
        refreshThinkingVisibility,
        clampThinkingBudget,
        editorEntryOf,
        refreshSettingsPane,
        renderPresetSelect,
        refreshPromptSettings,
        renderModelList,
        openModelEditor,
        closeModelEditor,
        exportAIConfig,
        importAIConfig,
        bindSettingsPane,
        isPathApproved,
        addCommandApprovalRule,
        matchCommandApproval,
        projectRulesPath,
        ensureProjectRules,
        refreshChatSettings,
        refreshMemoryPath,
        providerLabelFor,
        commandApprovalRules,
    };
}
