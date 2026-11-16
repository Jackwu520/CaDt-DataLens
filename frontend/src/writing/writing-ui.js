// writing-ui.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 写作模式
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import DOMPurify from 'dompurify';
import {WRITING_FONTS, formatWritingText, genName, SCENE_SEPARATOR} from '../core/writing.js';
import {isDocReadOnly} from '../core/readonly.js';
import {RECIPES, SELF_TEST} from '../terminal/run.js';
import {initPluginRuntime, loadPlugins} from '../shell/plugins.js';
import {iconSvg} from '../core/icons.js';
import {aceModeFor, formats} from '../core/formats.js';
import {createMarkdownRenderer, decodeMermaidSource, encodeMermaidSource} from '../core/markdown.js';

import {createWritingMode} from './writing-mode.js';
import {createMarkdownMermaid} from '../editor/markdown-mermaid.js';
import {createFootMenus} from '../editor/foot-menus.js';
import {createSettingsPaneRun} from '../settings/settings-pane-run.js';
import {createSettingsPanePlugins} from '../settings/settings-pane-plugins.js';
import {createSettingsPaneEnvvars} from '../settings/settings-pane-envvars.js';
import {createSettingsPaneLang} from '../settings/settings-pane-lang.js';
export function createWritingUI(deps) {



const LANG_DEFS = [
    {id: 'python', name: 'Python', tools: [{id: 'python', name: '解释器'}, {id: 'pip', name: 'pip', optional: true}], pkgs: [{id: 'env', label: '当前环境'}]},
    {id: 'node', name: 'Node.js', tools: [{id: 'node', name: 'Node'}, {id: 'npm', name: 'npm'}, {id: 'pnpm', name: 'pnpm', optional: true}, {id: 'yarn', name: 'yarn', optional: true}], pkgs: [{id: 'global', label: '全局（npm -g）'}, {id: 'project', label: '项目（node_modules）'}]},
    {id: 'go', name: 'Go', tools: [{id: 'go', name: 'Go 工具链'}], pkgs: [{id: 'project', label: '项目依赖（go.mod）'}]},
    {id: 'java', name: 'Java', tools: [{id: 'java', name: 'JDK'}, {id: 'maven', name: 'Maven', optional: true}, {id: 'gradle', name: 'Gradle', optional: true}]},
    {id: 'c', name: 'C', tools: [{id: 'c', name: '编译器（gcc / clang）'}, {id: 'cmake', name: 'CMake', optional: true}]},
    {id: 'cpp', name: 'C++', tools: [{id: 'cpp', name: '编译器（g++）'}, {id: 'cmake', name: 'CMake', optional: true}]},
    {id: 'rust', name: 'Rust', tools: [{id: 'rust', name: 'rustc'}, {id: 'cargo', name: 'cargo'}]},
    {id: 'php', name: 'PHP', tools: [{id: 'php', name: 'PHP'}, {id: 'composer', name: 'Composer', optional: true}]},
    {id: 'ruby', name: 'Ruby', tools: [{id: 'ruby', name: 'Ruby'}, {id: 'gem', name: 'gem'}]},
    {id: 'lua', name: 'Lua', tools: [{id: 'lua', name: 'Lua'}]},
];

// 命名运行配置：存的是「参数 + 命令模板 + 语言」预设，选中时载入到当前语言，
// 不是运行时的另一套分支——面板里看到的仍然是这次真正会用的值。

const ENCODINGS = [['auto', '自动'], ['utf-8', 'UTF-8'], ['gbk', 'GBK'], ['gb18030', 'GB18030'], ['iso-8859-1', 'ISO-8859-1'], ['us-ascii', 'US-ASCII']];
const CONVERT_ENCODINGS = [['utf-8', 'UTF-8'], ['gbk', 'GBK'], ['gb18030', 'GB18030'], ['iso-8859-1', 'ISO-8859-1'], ['us-ascii', 'US-ASCII']];
const INDENTS = [['2', '2 空格'], ['4', '4 空格'], ['tab', 'Tab']];
const EOLS = [['follow', '跟随原文件'], ['lf', 'LF'], ['crlf', 'CRLF']];
const VIEWS = [['tree', '树视图'], ['code', '代码视图'], ['text', '文本视图']];
const PATCH_VIEWS = [['patch', '补丁视图'], ['code', '代码视图'], ['text', '文本视图']];
const CSV_VIEWS = [['table', '表格视图'], ['sql', 'SQL 查询'], ['tree', '树视图'], ['text', '文本视图']];
const JSONL_VIEWS = [['tree', '树视图'], ['code', '代码视图'], ['text', '文本视图'], ['sql', 'SQL 查询']];
const MARKDOWN_VIEWS = [['split', '分屏'], ['preview', '预览'], ['code', '代码视图'], ['text', '文本视图']];
const HTML_VIEWS = [['split', '分屏'], ['code', '代码视图'], ['text', '文本视图']];
const IMAGE_VIEWS = [['image', '图片视图'], ['binary', '二进制视图'], ['text', '文本视图']];
const VIDEO_VIEWS = [['video', '视频视图'], ['binary', '二进制视图'], ['text', '文本视图']];
const BINARY_VIEWS = [['binary', '二进制视图'], ['text', '文本视图']];
const SVG_VIEWS = [['split', '分屏'], ['render', '渲染视图'], ['tree', '树视图'], ['code', '代码视图'], ['text', '文本视图']];

function isSvgDoc(doc) {
    return !!(doc && /\.svg$/i.test(doc.name || ''));
}

function isHtmlDoc(doc) {
    return !!(doc && /\.(html?|xhtml)$/i.test(doc.name || ''));
}

// 分屏种类：markdown / svg / html；其他格式暂不支持
function splitKindFor(doc) {
    if (!doc || !doc.format) return '';
    if (doc.format.preview) return 'markdown';
    if (isSvgDoc(doc)) return 'svg';
    if (isHtmlDoc(doc)) return 'html';
    return '';
}

function canSplitDoc(doc) {
    return !!doc && !doc.binary && !doc.large && !!splitKindFor(doc);
}
const CSV_ROW_NUM_WIDTH = 44;
const CSV_COL_MIN_WIDTH = 56;

function viewOptionsFor(fmt, doc) {
    if (doc && (doc.browser || doc.bgTerm || doc.agentView || doc.sideChat)) return [];
    if (fmt && fmt.image) return IMAGE_VIEWS;
    if (fmt && fmt.video) return VIDEO_VIEWS;
    if (fmt && fmt.id === 'bytes') return BINARY_VIEWS;
    if (isHtmlDoc(doc)) return HTML_VIEWS;
    if (fmt && fmt.id === 'markdown') return MARKDOWN_VIEWS;
    if (isSvgDoc(doc)) return SVG_VIEWS;
    if (fmt && fmt.id === 'jsonl') return JSONL_VIEWS;
    if (fmt && fmt.patch) return PATCH_VIEWS;
    return fmt && (fmt.table || fmt.id === 'csv') ? CSV_VIEWS : VIEWS;
}

function isSqlSupportedDoc(doc) {
    const id = doc && doc.format && doc.format.id;
    return id === 'csv' || id === 'jsonl';
}

// 旧版本把 sql 当视图模式持久化过；SQL 现在是覆盖层，恢复时归一为底层视图
function normalizeLegacySqlMode(doc) {
    if (doc && doc.mode === 'sql') {
        doc.mode = doc.sqlPrevMode || 'text';
        doc.sqlActive = false;
        if (doc.pane) doc.pane.classList.remove('sql-active');
    }
    return (doc && doc.mode) || 'tree';
}

function viewDisabled(mode) {
    if (!deps.file) return true;
    if (mode === 'image') return !deps.file.image;
    if (mode === 'video') return !deps.file.video;
    if (mode === 'binary') return !deps.file.binary;
    if (mode === 'tree') return !deps.file.treeAvailable;
    if (mode === 'text') return false;
    if (mode === 'preview') return !(deps.file.format && deps.file.format.preview) || !!deps.file.large;
    if (mode === 'render') return !isSvgDoc(deps.file);
    if (mode === 'split') return !canSplitDoc(deps.file);
    if (mode === 'sql') return !isSqlSupportedDoc(deps.file);
    return false;
}

function viewDisabledTitle(mode) {
    if (mode === 'preview' && deps.file && deps.file.large) return '大文件不支持预览';
    if (mode === 'sql') return 'SQL 查询仅支持 CSV / TSV / JSONL';
    return '当前文件只支持代码视图';
}

// text 组是兜底组（纯文本 + CMake/Make/Dockerfile/Git 规则等特殊文件名），
// 状态栏按 ace 语法模式细化显示，不再一律叫「纯文本」
const TEXT_MODE_NAMES = {
    cmake: 'CMake', dockerfile: 'Dockerfile', makefile: 'Makefile',
    diff: 'Diff', protobuf: 'Protobuf', graphqlschema: 'GraphQL', gitignore: 'Git 规则',
};

function formatDisplayName(doc) {
    if (doc && doc.format && doc.format.id === 'text' && doc.name) {
        try {
            const mode = aceModeFor(doc.name, doc.format).split('/').pop();
            if (TEXT_MODE_NAMES[mode]) return TEXT_MODE_NAMES[mode];
        } catch (e) {}
    }
    return (doc && doc.format && doc.format.name) || '';
}

function viewLabel(mode) {
    if (mode === 'browser') return '网页视图';
    if (mode === 'agentview') return '实时视图';
    if (mode === 'sidechat') return '支线对话';
    if (mode === 'split') return '分屏';
    if (mode === 'image') return '图片视图';
    if (mode === 'video') return '视频视图';
    if (mode === 'binary') return '二进制视图';
    if (mode === 'preview') return '预览';
    if (mode === 'render') return '渲染视图';
    if (mode === 'table') return '表格视图';
    if (mode === 'patch') return '补丁视图';
    if (mode === 'sql') return 'SQL 查询';
    if (mode === 'text') return '文本视图';
    if (mode === 'code') return '代码视图';
    return '树视图';
}

const TREE_MAX_CHILDREN = 10000;
const editorLocale = {
    'zh-CN': {
        showMoreStatus: '已显示 ${visibleChilds} / ${totalChilds} 项',
        showMore: '显示更多',
        showAll: '显示全部',
        'editor.tooltip.disable-editing': '只读模式下无法编辑',
    },
};

// 兜底：Ace 只读提示的内核文案是英文，观察器改写成中文（若语言包已生效则不会命中）。
// 注意：hoverTooltip 会把消息 <div> 作为子节点插入，addedNode 通常是内层 div 而不是
// .ace_tooltip 容器本身，所以这里要向上找容器。
const readonlyTipObserver = new MutationObserver((muts) => {
    for (const m of muts) {
        for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            const tip = node.classList.contains('ace_tooltip')
                ? node
                : (node.parentElement ? node.parentElement.closest('.ace_tooltip') : null);
            if (tip && tip.textContent === 'Editing is disabled') {
                tip.textContent = '只读模式下无法编辑';
            }
        }
    }
});
readonlyTipObserver.observe(document.body, {childList: true, subtree: true});

// 治本：把只读提示的中文文案直接注册进 Ace 的 nls。
// setMessages 是整表替换（不是合并）：必须带上默认英文表，否则其余键会逐个告警并回退。
// jsoneditor 的语言包不进 Ace nls，二进制 / 文本等只读编辑器此前一直是英文；
// 这里注册后所有 Ace 实例生效，观察器仅作兜底。
try {
    if (window.ace && ace.config && typeof ace.config.setMessages === 'function') {
        let base = null;
        try {
            const mod = ace.require('ace/lib/default_english_messages');
            base = mod && mod.defaultEnglishMessages;
        } catch (e) {}
        if (base && typeof base === 'object') {
            ace.config.setMessages(Object.assign({}, base, {'editor.tooltip.disable-editing': '只读模式下无法编辑'}));
        }
    }
} catch (e) {}

// 共享 Markdown 渲染层（frontend/src/markdown.js）：主界面与阅读模式共用，
// sanitize 规则单一来源（docs/finished-plans/reading-mode.md §10.2）。mermaid 脚本加载仍在 main.js。


function flash(msg, isError) {
    deps.els.stMessage.textContent = msg;
    deps.els.stMessage.classList.toggle('error', !!isError);
    clearTimeout(deps.flashTimer);
    deps.flashTimer = setTimeout(() => { deps.els.stMessage.textContent = ''; }, 5000);
    deps.logFrontend(isError ? 'error' : 'info', msg);
}

function updateWindowTitle() {
    // 没打开文件时显示工作区名字（目录名，不是绝对路径）
    const wsName = deps.workspaceFolder ? ((deps.baseNameOf && deps.baseNameOf(deps.workspaceFolder)) || deps.workspaceFolder) : '';
    const title = window.__aiFloatWindow
        ? 'AI 助手 · CaDt-DataLens'
        : (deps.file ? deps.file.name + ' - CaDt-DataLens' : (wsName ? wsName + ' - CaDt-DataLens' : 'CaDt-DataLens'));
    document.title = title;
    if (deps.rt && deps.rt.WindowSetTitle) {
        try {
            deps.rt.WindowSetTitle(title);
        } catch (e) {}
    }
}

function anyDirty() {
    return deps.docs.some((d) => d.dirty);
}

function updateBackendDirty() {
    deps.backend.SetDirty(anyDirty());
}

function setDirty(flag, opts = {}) {
    deps.dirty = flag;
    if (deps.file) deps.file.dirty = flag;
    updateBackendDirty();
    deps.els.stDirty.textContent = flag ? '未保存' : '';
    deps.els.filename.classList.toggle('dirty', flag);
    if (deps.file) updateTabDirty(deps.file);
    updateWindowTitle();
    if (flag && !opts.noAutoSave) scheduleAutoSave();
    else cancelAutoSave();
}

const autoSaveDelay = 1000;

function cancelAutoSave() {
    if (deps.autoSaveTimer) {
        clearTimeout(deps.autoSaveTimer);
        deps.autoSaveTimer = 0;
    }
}

function scheduleAutoSave() {
    cancelAutoSave();
    if (!deps.settings.autoSave || isDocReadOnly(deps.file, deps.settings) || !deps.dirty || !deps.file || !deps.file.path || !deps.editor) return;
    deps.autoSaveTimer = setTimeout(() => {
        deps.autoSaveTimer = 0;
        if (deps.dirty && deps.file && deps.settings.autoSave) deps.save({auto: true});
    }, autoSaveDelay);
}

function updateTabDirty(doc) {
    const el = document.querySelector('.etabs .tab[data-doc-id="' + doc.id + '"]');
    if (el) el.classList.toggle('dirty', !!doc.dirty);
}



// 写作模式 / markdown+mermaid（editor/）/ 底部弹出层（editor/）已拆为兄弟模块。
// 经 Object.create 委托原 deps（getter 惰性），只补它们要调用的宿主能力。
const wmDeps = Object.create(deps);
wmDeps.flash = flash;
const wmMod = createWritingMode(wmDeps);

const mmMod = createMarkdownMermaid(deps);

const fmDeps = Object.create(deps);
fmDeps.viewOptionsFor = viewOptionsFor;
fmDeps.viewDisabled = viewDisabled;
fmDeps.viewDisabledTitle = viewDisabledTitle;
fmDeps.viewLabel = viewLabel;
fmDeps.flash = flash;
fmDeps.setDirty = setDirty;
fmDeps.CONVERT_ENCODINGS = CONVERT_ENCODINGS;
fmDeps.EOLS = EOLS;
const fmMod = createFootMenus(fmDeps);


// 四个设置 pane（run/plugins/envvars/lang）。lang 先建（plugins 安装后要刷新它的两份 pane）。
const langDeps = Object.create(deps);
langDeps.viewOptionsFor = viewOptionsFor;
langDeps.flash = flash;
langDeps.LANG_DEFS = LANG_DEFS;
langDeps.ENCODINGS = ENCODINGS;
langDeps.INDENTS = INDENTS;
langDeps.EOLS = EOLS;
langDeps.makeSelect = fmMod.makeSelect;
const langMod = createSettingsPaneLang(langDeps);
// 这两份 pane 在初始化时就要建好交互（原文件里是紧跟函数定义执行的顶层调用）
langMod.setupFormatSettings();
langMod.setupLanguageSettings();

const runDeps = Object.create(deps);
runDeps.flash = flash;
runDeps.LANG_DEFS = LANG_DEFS;
const runMod = createSettingsPaneRun(runDeps);

const envDeps = Object.create(deps);
envDeps.flash = flash;
envDeps.openConfirmDialog = wmMod.openConfirmDialog;
const envMod = createSettingsPaneEnvvars(envDeps);

const plugDeps = Object.create(deps);
plugDeps.flash = flash;
plugDeps.openConfirmDialog = wmMod.openConfirmDialog;
plugDeps.setupFormatSettings = langMod.setupFormatSettings;
plugDeps.setupLanguageSettings = langMod.setupLanguageSettings;
const plugMod = createSettingsPanePlugins(plugDeps);

    return {
        ...runMod, ...plugMod, ...envMod, ...langMod,
        ...wmMod, ...mmMod, ...fmMod,
        CSV_COL_MIN_WIDTH, CSV_ROW_NUM_WIDTH, INDENTS, LANG_DEFS, TREE_MAX_CHILDREN, canSplitDoc, cancelAutoSave, editorLocale, flash, formatDisplayName, isSqlSupportedDoc, isSvgDoc, normalizeLegacySqlMode, scheduleAutoSave, setDirty, splitKindFor, updateBackendDirty, updateTabDirty, updateWindowTitle, viewDisabled, viewLabel, viewOptionsFor,
    };
}
