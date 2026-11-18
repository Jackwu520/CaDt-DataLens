// 插件运行时：加载插件 JS、提供 cadt.* API、管理格式/命令/主题的注册生命周期。
// 与 main.js 通过 initPluginRuntime(hooks) 单向注入，避免循环依赖。
import {registerPluginFormat, unregisterAllPluginFormats} from '../core/formats.js';
import {clearPluginAIProviders, getPluginAIProviders, registerPluginAIProvider} from './plugin-ai-providers.js';

const host = {
    flash: () => {},
    getActiveFile: () => null,
    getActiveText: () => null,
    openPath: () => {},
    addPluginTheme: () => {},
    onPluginsChanged: () => {},
    readPluginAsset: () => Promise.reject(new Error('当前版本不支持读取插件资产')),
};

let commands = [];
const themeStyles = new Map();
// 命令风险分类器（docs/finished-plans/local-command-classifier.md §4）：
// 插件可注册 {id, label, classify(command, ctx) → {score, reason}}（可返回 Promise）。
// score = 危险概率 [0,1]；无 deny 权——判定统一由 AI 面板按严格度阈值转 allow/ask。
const commandClassifiers = new Map();
// 文档格式转换器（通用 doc 能力）：插件注册 Word/PDF 等重格式生成器，任何核心
// 导出场景（便签面板、AI 回答另存、阅读导出……）按需消费——重依赖全在插件侧，
// 核心 exe 保持零依赖。ctx 由消费方组装（title/html/images + 落盘原语）。
const docConverters = new Map();

export function getPluginDocConverters() {
    return [...docConverters.values()];
}

export function initPluginRuntime(hooks) {
    Object.assign(host, hooks || {});
}

export function getPluginCommands() {
    return commands;
}

const iconThemes = {};

export function getPluginIconThemes() {
    return iconThemes;
}

export function getPluginCommandClassifiers() {
    return [...commandClassifiers.values()];
}

export function getPluginAIProviderList() {
    return getPluginAIProviders();
}

// 最近一次 loadPlugins 的加载错误（每个插件一条「名称：原因」），供诊断 UI 区分
// 「插件未安装」与「已安装但加载失败」——端侧分类器状态行据此不再误报「未安装」。
let lastLoadErrors = [];

export function getPluginLoadErrors() {
    return [...lastLoadErrors];
}

function pluginError(plugin, message) {
    return new Error(`[${plugin.name || plugin.id}] ${message}`);
}

function apiFor(plugin) {
    return {
        // 注册自定义文件格式：{id, name, extensions, parse(text), stringify(value), aceMode?, rawOnly?, table?, parseTable?, stringifyTable?}
        registerFormat(driver) {
            if (!driver || typeof driver !== 'object') {
                throw pluginError(plugin, 'registerFormat 需要一个格式对象');
            }
            return registerPluginFormat({...driver, pluginId: plugin.id});
        },
        // 注册工具菜单命令：{id, label, run()}
        addCommand(spec) {
            if (!spec || typeof spec !== 'object') {
                throw pluginError(plugin, 'addCommand 需要一个命令对象');
            }
            const id = String(spec.id || '').trim();
            const label = String(spec.label || '').trim();
            if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
                throw pluginError(plugin, `命令 id 无效：${JSON.stringify(spec.id)}`);
            }
            if (!label || typeof spec.run !== 'function') {
                throw pluginError(plugin, '命令缺少 label 或 run');
            }
            if (commands.some((c) => c.id === `${plugin.id}:${id}`)) {
                throw pluginError(plugin, `命令 ${id} 已注册`);
            }
            commands.push({id: `${plugin.id}:${id}`, pluginId: plugin.id, label, run: spec.run});
        },
        // 注册文件图标主题：{id, name, icons: {json: '<svg…>', default_file: '<svg…>', …}}
        // icons 缺失的类型自动回退到内置文字缩写图标
        registerIconTheme(spec) {
            if (!spec || typeof spec !== 'object') {
                throw pluginError(plugin, 'registerIconTheme 需要一个主题对象');
            }
            const id = String(spec.id || '').trim();
            if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
                throw pluginError(plugin, `图标主题 id 无效：${JSON.stringify(spec.id)}`);
            }
            if (!spec.icons || typeof spec.icons !== 'object') {
                throw pluginError(plugin, 'registerIconTheme 缺少 icons 映射');
            }
            const icons = {};
            for (const [k, v] of Object.entries(spec.icons)) {
                if (typeof v === 'string' && v.includes('<svg')) icons[k] = v;
            }
            if (!Object.keys(icons).length) {
                throw pluginError(plugin, 'registerIconTheme 的 icons 为空');
            }
            iconThemes[id] = {id, name: String(spec.name || id), icons};
            host.addPluginIconTheme({id, name: String(spec.name || id), icons});
        },
        // 注册主题：{id, name, bg, accent, css}，css 里用 html[data-theme="<id>"] 选择器
        addTheme(spec) {
            if (!spec || typeof spec !== 'object') {
                throw pluginError(plugin, 'addTheme 需要一个主题对象');
            }
            const id = String(spec.id || '').trim();
            if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
                throw pluginError(plugin, `主题 id 无效：${JSON.stringify(spec.id)}`);
            }
            if (themeStyles.has(id)) {
                throw pluginError(plugin, `主题 ${id} 已注册`);
            }
            const style = document.createElement('style');
            style.dataset.pluginTheme = id;
            style.textContent = String(spec.css || '');
            document.head.appendChild(style);
            themeStyles.set(id, style);
            host.addPluginTheme({id, name: String(spec.name || id), bg: spec.bg || '#1e1f24', accent: spec.accent || '#4f8cff'});
        },
        // 注册命令风险分类器：{id, label, classify(command, ctx) → {score, reason}}
        // ctx: {cwd, toolName, strictness, threshold, sessionId}；score = 危险概率 [0,1]，
        // 分类器只产出概率（无 deny 权），allow/ask 由核心按严格度阈值统一判定。
        registerCommandClassifier(spec) {
            if (!spec || typeof spec !== 'object') {
                throw pluginError(plugin, 'registerCommandClassifier 需要一个分类器对象');
            }
            const id = String(spec.id || '').trim();
            if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
                throw pluginError(plugin, `分类器 id 无效：${JSON.stringify(spec.id)}`);
            }
            if (typeof spec.classify !== 'function') {
                throw pluginError(plugin, '分类器缺少 classify 函数');
            }
            const fullId = `${plugin.id}:${id}`;
            if (commandClassifiers.has(fullId)) {
                throw pluginError(plugin, `分类器 ${id} 已注册`);
            }
            commandClassifiers.set(fullId, {
                id: fullId,
                pluginId: plugin.id,
                label: String(spec.label || id).trim().slice(0, 40),
                classify: spec.classify,
            });
        },
        // 注册可插拔 AI provider：{id, name, account, models, prepare(ctx)}。
        // 账号以虚拟 profile 进入模型选择器，prepare 在每轮组装请求配置时注入动态补丁。
        // 详见 docs/plugins/README.md「注册 AI provider」。
        registerAIProvider(spec) {
            return registerPluginAIProvider(plugin.id, spec);
        },
        // 注册文档格式转换器：{id, label, extensions, convert(ctx)}——通用导出能力，
        // 各导出场景（便签面板 / AI 回答另存 / 阅读导出…）把内容组装成统一 ctx 后调用
        // convert；Word/PDF 等生成依赖全在插件侧随插件分发。ctx：{title, suggestedName,
        // html(图片为相对 img/ 引用), images:[{name,mime,base64}], chooseSavePath(defaultName),
        // writeTextFile(path,content), writeBinaryFile(path,base64,mime), flash(msg,isErr)}。
        // 详见 docs/plugins/README.md「注册文档格式转换器」。
        registerDocConverter(spec) {
            if (!spec || typeof spec !== 'object') {
                throw pluginError(plugin, 'registerDocConverter 需要一个转换器对象');
            }
            const id = String(spec.id || '').trim();
            if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
                throw pluginError(plugin, `转换器 id 无效：${JSON.stringify(spec.id)}`);
            }
            if (typeof spec.convert !== 'function') {
                throw pluginError(plugin, '转换器缺少 convert 函数');
            }
            const fullId = `${plugin.id}:${id}`;
            if (docConverters.has(fullId)) {
                throw pluginError(plugin, `转换器 ${id} 已注册`);
            }
            docConverters.set(fullId, {
                id: fullId,
                pluginId: plugin.id,
                label: String(spec.label || id).trim().slice(0, 60),
                extensions: Array.isArray(spec.extensions) ? spec.extensions.map(String).filter(Boolean) : [],
                convert: spec.convert,
            });
        },
        getActiveFile() {
            return host.getActiveFile();
        },
        getActiveText() {
            return host.getActiveText();
        },
        openPath(path) {
            host.openPath(path);
        },
        // 同步执行命令：{exe, args, cwd, timeoutMs} → {code, stdout, stderr}
        runCommandSync(opts) {
            return host.runCommandSync(opts);
        },
        // 流式执行命令：{exe, args, cwd, onOut, onErr, onExit} → {stop()}
        runCommand(opts) {
            return host.runCommand(opts);
        },
        // 以只读虚拟文档打开文本（用于展示命令输出等）
        openVirtualDoc(name, content) {
            return host.openVirtualDoc(name, content);
        },
        // 读取插件目录内的图片资产：path 相对插件目录，返回 data URL
        readAsset(path) {
            return Promise.resolve(host.readPluginAsset(plugin.id, String(path || '')));
        },
        flash(message) {
            host.flash(String(message ?? ''));
        },
    };
}

// 清空上一轮注册并按当前启用列表重新执行插件代码；返回错误信息数组。
// 插件注册表状态变化广播：loadPlugins 每次完成（含清空 / 跳过 / 失败路径）都派发，
// 订阅方（如端侧模型设置的下拉与状态行）据此原位刷新，不必各自轮询
function notifyPluginsLoaded() {
    try { window.dispatchEvent(new CustomEvent('cadt-plugins-loaded')); } catch (e) {}
}

export async function loadPlugins(backend) {
    unregisterAllPluginFormats();
    clearPluginAIProviders();
    for (const style of themeStyles.values()) {
        style.remove();
    }
    themeStyles.clear();
    commands = [];
    commandClassifiers.clear();
    docConverters.clear();
    lastLoadErrors = [];
    host.onPluginsChanged();
    if (!backend || typeof backend.GetPluginSources !== 'function') {
        console.info('[plugins] 跳过加载：宿主无 GetPluginSources 绑定');
        notifyPluginsLoaded();
        return [];
    }
    let sources = [];
    try {
        sources = (await backend.GetPluginSources()) || [];
    } catch (e) {
        lastLoadErrors = [`读取插件失败：${e}`];
        console.info('[plugins] 读取插件源失败：' + lastLoadErrors[0]);
        notifyPluginsLoaded();
        return [...lastLoadErrors];
    }
    const errors = [];
    for (const source of sources) {
        try {
            const api = apiFor({id: source.id, name: source.name});
            new Function('cadt', `"use strict";\n${source.code || ''}`)(api);
        } catch (e) {
            const message = `${source.name || source.id}：${(e && e.message) || e}`;
            errors.push(message);
        }
    }
    lastLoadErrors = [...errors];
    // 诊断行：插件加载是静默失败高发区（源被 Go 侧跳过 / 入口早期 return 都不报错），
    // 进 F12 调试控制台与 jsonl，排查「分类器未注册」类问题从这里看起
    console.info('[plugins] 加载完成：源 ' + sources.length + ' 个（' +
        sources.map((s) => s.id).join('、') + '）· 命令分类器 ' + commandClassifiers.size +
        ' 个 · AI provider ' + getPluginAIProviders().length +
        ' 个 · 错误 ' + errors.length + (errors.length ? '：' + errors.join('；') : ''));
    host.onPluginsChanged();
    notifyPluginsLoaded();
    return errors;
}
