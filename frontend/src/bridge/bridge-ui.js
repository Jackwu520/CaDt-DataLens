// bridge-ui.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 进程桥 / 虚拟文档 / 浏览器标签；后台终端视图、git 浅集成、CLI 转换已拆到同目录兄弟模块。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {loadPlugins} from '../shell/plugins.js';
import {createBridgeCliConvert} from './bridge-cli-convert.js';
import {createBridgeGit} from './bridge-git.js';
import {createBridgeTerminalView} from './bridge-terminal-view.js';
import {createBridgeAgentView} from './bridge-agent-view.js';
import {createBridgeSideChat} from './bridge-sidechat-view.js';

export function createBridgeUI(deps) {

const termMod = createBridgeTerminalView(deps);
const agentMod = createBridgeAgentView(deps);
const sideChatMod = createBridgeSideChat(deps);
// git 域要开虚拟文档标签：经 Object.create 委托原 deps（保持 getter 惰性），只补一个宿主函数
const gitDeps = Object.create(deps);
gitDeps.openVirtualDoc = openVirtualDoc;
const gitMod = createBridgeGit(gitDeps);
const cliMod = createBridgeCliConvert(deps);

// opts：readOnly（标签页只读锁）、readOnlyFixed（固定只读、不可解锁）、
// patchReview（只读审阅快照）、reviewNotes（无差异文件说明）
function openVirtualDoc(name, content, opts) {
    const options = opts || {};
    const fixed = !!options.readOnlyFixed;
    const doc = deps.createDoc({
        path: null,
        name,
        content,
        size: content.length,
        eol: 'lf',
        hasBom: false,
        large: false,
        enc: 'utf-8',
        readOnly: !!(options.readOnly || fixed),
        readOnlyFixed: fixed,
        patchReview: !!options.patchReview,
        reviewNotes: options.reviewNotes || [],
    });
    doc.untitled = true;
    deps.docs.push(doc);
    deps.activateDoc(doc);
    return doc;
}

// ===== 浏览器使用标签页 =====
let browserSeq = 0;

// 个人浏览器：固定实例 id ⇒ Go 侧 user data 目录固定（BrowserSessions/browser-user_user），
// cookie / 登录态随磁盘保留（关标签再开、重启应用都还在）。
// 任何时刻只允许一个实例：WebView2 规定同一个 user data folder 不能被两个 environment
// 同时使用，而每个实例各自建一个 environment——多开必然第二个初始化失败。
const PERSONAL_BROWSER_ID = 'browser-user';

function openBrowserTab(url, profileKey, opts) {
    const target = (url || '').trim() || 'about:blank';
    const personal = !!(opts && opts.personal);
    if (personal) {
        // 已开着就切过去（带地址时顺带导航），不重复建实例
        const opened = deps.docs.find((d) => d.browser && d.id === PERSONAL_BROWSER_ID);
        if (opened) {
            deps.activateDoc(opened);
            if (target !== 'about:blank' && deps.backend.BrowserNavigate) {
                opened.browserUrl = target;
                if (opened.browserAddr) opened.browserAddr.value = target;
                deps.backend.BrowserNavigate(opened.id, target).catch(() => {});
            }
            return opened;
        }
    }
    browserSeq += 1;
    const doc = {
        id: personal ? PERSONAL_BROWSER_ID : 'browser-' + Date.now().toString(36) + '-' + browserSeq,
        path: null,
        name: personal ? '我的浏览器' : (target !== 'about:blank' ? target : '新标签页'),
        content: '',
        size: 0,
        eol: 'lf',
        hasBom: false,
        large: false,
        enc: 'utf-8',
        format: {id: 'browser', name: '网页', extensions: [], aceMode: 'text', rawOnly: true},
        browser: true,
        // 个人浏览器（持久 profile）标记：新建标签页永远是隔离会话，两者语义不同
        browserPersist: personal,
        mode: 'browser',
        browserUrl: target,
        browserProfile: personal ? 'user' : (profileKey || ''),
        treeAvailable: false,
        dirty: false,
        untitled: false,
        bases: {},
        savedText: '',
    };
    deps.docs.push(doc);
    deps.addDocToFocusedGroup(doc);
    deps.activateDoc(doc);
    if (!deps.backend.BrowserOpen) {
        deps.flash('当前环境不支持内嵌浏览器', true);
        return doc;
    }
    const profileForOpen = doc.browserProfile || 'tab-' + doc.id;
    const onOpened = (info) => {
        if (info && info.title) deps.updateBrowserTitle(doc, info.title);
        if (doc.browserEmpty) {
            doc.browserEmpty.remove();
            doc.browserEmpty = null;
        }
        deps.syncBrowserTab(doc);
    };
    // 个人浏览器关掉后立刻重开：上一个 WebView2 浏览器进程可能还没退干净、同一 user data
    // 目录短暂被占，补一次重试（约 0.8s），别让「记住登录」的入口动辄弹打开失败。
    // browserOpenPromise：把创建完成暴露给等待方（AI 的 open_browser_tab 宿主动作）。
    // 之前完全 fire-and-forget，AI 拿到 id 立刻 BrowserNavigate——两个绑定调用在 Go 侧
    // 并发排队，导航任务先到就命中「不存在或未就绪」守卫，模型只能重试一次白烧 token
    // （2026-11-16）。约定：promise resolve ⇒ Go 侧 BrowserOpen 已返回、webview 已就绪。
    const runOpen = (retryLeft) => deps.backend.BrowserOpen(doc.id, target, profileForOpen).then(onOpened).catch((e) => {
        if (doc.browserPersist && retryLeft > 0 && deps.docs.includes(doc)) {
            return new Promise((resolve) => setTimeout(resolve, 800)).then(() => runOpen(retryLeft - 1));
        }
        const stack = String((e && e.stack) || '').split(String.fromCharCode(10)).slice(0, 4).join(' | ');
        deps.flash('浏览器标签页打开失败：' + ((e && e.message) || e) + ' @ ' + stack, true);
        deps.closeDocNow(doc, false);
        throw e; // 等待方要拿到确定失败；fire-and-forget 侧另行兜底吞掉 rejection
    });
    doc.browserOpenPromise = runOpen(doc.browserPersist ? 1 : 0);
    doc.browserOpenPromise.catch(() => {});
    return doc;
}


(async () => {
    if (await cliMod.maybeRunConvertJob()) return;
    // 独立调试控制台窗口：只渲染控制台面板，跳过正常的应用启动流程
    if (await deps.consoleWindowMode) {
        deps.startConsoleWindowMode();
        return;
    }
    let floatWindow = false;
    try {
        floatWindow = !!(deps.backend.IsAIFloatWindow && await deps.backend.IsAIFloatWindow());
    } catch (e) {
        floatWindow = false;
    }
    if (!floatWindow && !deps.hasWails && deps.mockScenario.has('aifloat')) floatWindow = true;
    if (floatWindow) {
        window.__aiFloatWindow = true;
        document.body.classList.add('ai-float-window');
        document.title = 'AI 助手 · CaDt-DataLens';
    }
    // 操作留痕：主窗口启动标记（悬浮窗/独立控制台/转换模式不记）。
    deps.activityLog.log('app.start', '', {mock: deps.hasWails ? undefined : true}, {actor: 'system', source: 'system'});
    deps.refreshDeveloperMode();
    deps.refreshLogPath();
    if (deps.backend.GetOpenMode) {
        try {
            const mode = await deps.backend.GetOpenMode();
            if (mode === 'tab' || mode === 'window') {
                deps.settings.openMode = mode;
                deps.syncedOpenMode = mode;
                deps.applySettings();
            }
        } catch (e) {}
    }
    if (deps.backend.GetPluginSources) {
        try {
            const errors = await loadPlugins(deps.backend);
            window.__pluginLoadErrors = errors;
            for (const err of errors) deps.flash(err, true);
        } catch (e) {
            window.__pluginLoadErrors = ['异常：' + (e && e.stack || e)];
            deps.flash('插件加载失败：' + e, true);
        }
    }
    deps.logFrontend('info', '前端启动完成：' + navigator.userAgent);
    let startupAISession = '';
    if (deps.backend.GetStartupAISession) {
        try {
            startupAISession = await deps.backend.GetStartupAISession() || '';
        } catch (e) {}
    }
    let targets = [];
    if (deps.backend.GetStartupTargets) {
        try {
            targets = await deps.backend.GetStartupTargets();
        } catch (e) {}
    }
    if (targets && targets.length) {
        // 先读取目标目录上次的工作区环境，再打开目标：打开目录会触发一次防抖保存，
        // 若先打开再读，空环境可能把旧环境覆盖掉。
        let workspaceSession = null;
        if (!floatWindow && deps.backend.GetPathInfo) {
            for (const target of targets) {
                if (!target || !target.path) continue;
                let info = null;
                try {
                    info = await deps.backend.GetPathInfo(target.path);
                } catch (e) {}
                if (info && info.isDir) {
                    workspaceSession = deps.readWorkspaceSession(info.path);
                    break;
                }
            }
        }
        await deps.openTargets(targets);
        if (workspaceSession) await deps.restoreSession(workspaceSession);
    } else {
        const files = await deps.backend.GetStartupFiles();
        if (files && files.length) await deps.openPaths(files);
        else {
            const sess = deps.readSession();
            if (sess) await deps.restoreSession(sess);
        }
    }
    if (floatWindow) {
        document.title = 'AI 助手 · CaDt-DataLens';
        if (!deps.aiPanel) deps.initAIPanel();
        if (deps.aiPanel) deps.aiPanel.open(true);
    } else {
        setTimeout(() => deps.autoCheckUpdateOnStart(), 2000);
        // 软切换新窗口：打开 AI 面板并选中目标会话（工作区已在上一步恢复）。
        if (startupAISession && deps.aiPanel && deps.aiPanel.bridgeListSessions) {
            try {
                if (deps.aiPanel.whenReady) await deps.aiPanel.whenReady();
            } catch (e) {}
            const session = deps.aiPanel.bridgeListSessions().find((item) => item.id === startupAISession);
            if (session && (!session.workspace || deps.sessionPathKey(session.workspace) === deps.sessionPathKey(deps.workspaceFolder))) {
                deps.aiPanel.open(true);
                try {
                    await deps.aiPanel.bridgeSwitchSession(startupAISession);
                } catch (e) {}
            }
        }
    }
    try {
        if (deps.backend.ConsumeStartupSettings) {
            const pane = await deps.backend.ConsumeStartupSettings();
            if (pane) deps.openSettings(String(pane));
        }
    } catch (e) {}
})();


    return {
        ...termMod, ...agentMod, ...sideChatMod, ...gitMod, ...cliMod,
        openBrowserTab, openVirtualDoc,
    };
}
