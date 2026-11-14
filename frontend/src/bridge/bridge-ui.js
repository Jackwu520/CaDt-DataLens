// bridge-ui.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 进程桥 / 虚拟文档 / 浏览器标签；后台终端视图、git 浅集成、CLI 转换已拆到同目录兄弟模块。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {loadPlugins} from '../shell/plugins.js';
import {createBridgeCliConvert} from './bridge-cli-convert.js';
import {createBridgeGit} from './bridge-git.js';
import {createBridgeTerminalView} from './bridge-terminal-view.js';

export function createBridgeUI(deps) {

const termMod = createBridgeTerminalView(deps);
// git 域要开虚拟文档标签：经 Object.create 委托原 deps（保持 getter 惰性），只补一个宿主函数
const gitDeps = Object.create(deps);
gitDeps.openVirtualDoc = openVirtualDoc;
const gitMod = createBridgeGit(gitDeps);
const cliMod = createBridgeCliConvert(deps);

function openVirtualDoc(name, content) {
    const doc = deps.createDoc({
        path: null,
        name,
        content,
        size: content.length,
        eol: 'lf',
        hasBom: false,
        large: false,
        enc: 'utf-8',
    });
    doc.untitled = true;
    deps.docs.push(doc);
    deps.activateDoc(doc);
    return doc;
}

// ===== 浏览器使用标签页 =====
let browserSeq = 0;

function openBrowserTab(url, profileKey) {
    browserSeq += 1;
    const target = (url || '').trim() || 'about:blank';
    const doc = {
        id: 'browser-' + Date.now().toString(36) + '-' + browserSeq,
        path: null,
        name: target !== 'about:blank' ? target : '新标签页',
        content: '',
        size: 0,
        eol: 'lf',
        hasBom: false,
        large: false,
        enc: 'utf-8',
        format: {id: 'browser', name: '网页', extensions: [], aceMode: 'text', rawOnly: true},
        browser: true,
        mode: 'browser',
        browserUrl: target,
        browserProfile: profileKey || '',
        treeAvailable: false,
        dirty: false,
        untitled: false,
        bases: {},
        savedText: '',
    };
    deps.docs.push(doc);
    deps.addDocToFocusedGroup(doc);
    deps.activateDoc(doc);
    if (deps.backend.BrowserOpen) {
        deps.backend.BrowserOpen(doc.id, target, doc.browserProfile || 'tab-' + doc.id).then((info) => {
            if (info && info.title) deps.updateBrowserTitle(doc, info.title);
            if (doc.browserEmpty) {
                doc.browserEmpty.remove();
                doc.browserEmpty = null;
            }
            deps.syncBrowserTab(doc);
        }).catch((e) => {
            const stack = String((e && e.stack) || '').split(String.fromCharCode(10)).slice(0, 4).join(' | ');
            deps.flash('浏览器标签页打开失败：' + ((e && e.message) || e) + ' @ ' + stack, true);
            deps.closeDocNow(doc, false);
        });
    } else {
        deps.flash('当前环境不支持内嵌浏览器', true);
    }
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
                    deps.aiPanel.bridgeSwitchSession(startupAISession);
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
        ...termMod, ...gitMod, ...cliMod,
        openBrowserTab, openVirtualDoc,
    };
}
