// editor-menus.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 编辑器右键菜单：选区采集、全选/查找/折叠项、编辑器菜单与空白处菜单、
// 右键菜单初始化（含选中文本时的 AI 联动入口与阅读模式控制器创建）。
//
// deps 由 main.js 显式传入（getter 延迟求值）；原裸标识符引用已重写为 deps.X，
// 对象简写位展开为 key: deps.X。
import {isDocReadOnly} from '../core/readonly.js';
import {renderCodeShot, planCodeShot} from '../core/code-shot.js';
import {copyImageBlobToClipboard} from '../core/image-clipboard.js';

export function createEditorMenus(deps) {

function selectedText() {
    if (!deps.editor) return '';
    if ((deps.currentMode === 'code' || deps.currentMode === 'split') && deps.editor.aceEditor) return deps.editor.aceEditor.getSelectedText();
    if (deps.currentMode === 'text') {
        const ta = deps.textArea();
        if (ta) return ta.value.slice(ta.selectionStart, ta.selectionEnd);
    }
    return '';
}

async function ctxCopy() {
    const text = selectedText();
    if (text) await deps.copyText(text, '所选内容');
}

async function ctxCut() {
    if (!deps.editor || deps.file.binary || deps.file.large) return;
    if (deps.currentMode === 'code' && deps.editor.aceEditor) {
        const ace = deps.editor.aceEditor;
        const text = ace.getSelectedText();
        if (!text) return;
        if (!(await deps.copyText(text, '所选内容'))) return;
        ace.session.replace(ace.getSelectionRange(), '');
        ace.focus();
    } else if (deps.currentMode === 'text') {
        const ta = deps.textArea();
        if (!ta) return;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        if (start === end) return;
        if (!(await deps.copyText(ta.value.slice(start, end), '所选内容'))) return;
        ta.setRangeText('', start, end, 'end');
        ta.dispatchEvent(new Event('input', {bubbles: true}));
        ta.focus();
    }
}

async function ctxPaste() {
    if (!deps.editor || deps.file.binary || deps.file.large) return;
    if (!deps.backend.GetClipboardText) return;
    let text = '';
    try {
        text = await deps.backend.GetClipboardText();
    } catch (e) {
        deps.flash('读取剪贴板失败：' + e, true);
        return;
    }
    if (!text) return;
    if (deps.currentMode === 'code' && deps.editor.aceEditor) {
        deps.editor.aceEditor.focus();
        deps.editor.aceEditor.insert(text);
    } else if (deps.currentMode === 'text') {
        const ta = deps.textArea();
        if (!ta) return;
        ta.focus();
        ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input', {bubbles: true}));
    }
}

function ctxSelectAll() {
    if (deps.currentMode === 'code' && deps.editor && deps.editor.aceEditor) {
        deps.editor.aceEditor.focus();
        deps.editor.aceEditor.selectAll();
    } else if (deps.currentMode === 'text') {
        const ta = deps.textArea();
        if (ta) {
            ta.focus();
            ta.select();
        }
    }
}

function ctxFind() {
    deps.openFindBar();
}

function ctxFold(command) {
    if (deps.currentMode === 'code' && deps.editor && deps.editor.aceEditor) {
        deps.editor.aceEditor.execCommand(command);
    }
}

// —— 代码截图：有选区取涉及的所有整行，无选区取全文；当前主题/代码风格所见即所得 ——
function codeShotInfo() {
    const ace = deps.editor && deps.editor.aceEditor;
    if (!ace) return null;
    const session = ace.session || (ace.getSession && ace.getSession());
    if (!session) return null;
    const selected = ace.getSelectedText ? String(ace.getSelectedText() || '') : '';
    const plan = planCodeShot({
        range: ace.getSelectionRange ? ace.getSelectionRange() : null,
        hasSelection: !!selected,
        lineCount: session.getLength(),
    });
    return {ace, selected, plan};
}

async function makeCodeShot() {
    const info = codeShotInfo();
    if (!info) throw new Error('当前没有可用的代码编辑器');
    if (info.plan.error) throw new Error(info.plan.error);
    const shot = deps.settings || {};
    return renderCodeShot({
        ace: info.ace,
        name: (deps.file && deps.file.name) || '代码',
        rangeLabel: info.selected
            ? '第 ' + (info.plan.startRow + 1) + '–' + (info.plan.endRow + 1) + ' 行'
            : '全文 ' + info.plan.lines + ' 行',
        title: shot.codeShotTitle === true,
        lineNumbers: shot.codeShotLineNumbers !== false,
        radius: Number(shot.codeShotRadius),
        scale: Number(shot.codeShotScale),
        fontSize: info.ace.getFontSize ? (parseFloat(info.ace.getFontSize()) || 0) : 0,
        lineHeight: (info.ace.renderer && Number(info.ace.renderer.lineHeight)) || 0,
    });
}

function toggleCodeShotTitle() {
    deps.settings.codeShotTitle = !deps.settings.codeShotTitle;
    deps.applySettings();
    deps.flash('代码截图标题：' + (deps.settings.codeShotTitle ? '开' : '关'));
}

async function copyCodeShot() {
    try {
        const blob = await makeCodeShot();
        const ok = await copyImageBlobToClipboard(blob);
        deps.flash(ok ? '已复制代码图片' : '剪贴板不支持图片', !ok);
    } catch (e) {
        deps.flash('复制失败：' + ((e && e.message) || e), true);
    }
}

async function exportCodeShot() {
    try {
        const blob = await makeCodeShot();
        const dataUrl = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => resolve('');
            reader.readAsDataURL(blob);
        });
        if (!dataUrl) throw new Error('PNG 数据生成失败');
        const raw = (deps.file && (deps.file.name || deps.file.path)) || '代码';
        const stem = String(raw).split(/[\\/]/).pop().replace(/\.[^.]+$/, '') || '代码';
        let dest = '';
        try {
            dest = await deps.backend.SaveFileDialog(stem + '.png');
        } catch (e) {
            return;
        }
        if (!dest) return;
        await deps.backend.SaveDataURL(dest, dataUrl);
        deps.flash('已导出 PNG：' + String(dest).split(/[\\/]/).pop());
    } catch (e) {
        deps.flash('导出失败：' + ((e && e.message) || e), true);
    }
}

function showEditorMenu(x, y) {
    if (!deps.ctxMenu || !deps.file) return;
    const code = deps.currentMode === 'code' && !!deps.editor && !!deps.editor.aceEditor;
    const canShot = (deps.currentMode === 'code' || deps.currentMode === 'split') &&
        !!(deps.editor && deps.editor.aceEditor);
    const text = deps.currentMode === 'text';
    const editable = code || text;
    const readonly = isDocReadOnly(deps.file, deps.settings);
    const hasPath = !!deps.file.path;
    const referenceItems = deps.aiEditorReferenceMenuItems();
    // 代码视图下提供运行入口，可用状态与标题栏 ▶ / 工具菜单一致
    const runSupported = !!deps.runController && !readonly &&
        deps.runController.isSupported({name: deps.file.name, path: deps.file.path});
    deps.ctxMenu.open([
        {label: '撤销', shortcut: 'Ctrl+Z', icon: 'E7A7', disabled: readonly, action: deps.doUndo},
        {label: '重做', shortcut: 'Ctrl+Y', icon: 'E7A6', disabled: readonly, action: deps.doRedo},
        {sep: true},
        {label: '剪切', shortcut: 'Ctrl+X', icon: 'E8C6', disabled: !editable || readonly, action: ctxCut},
        {label: '复制', shortcut: 'Ctrl+C', icon: 'E8C8', disabled: !editable, action: ctxCopy},
        {label: '粘贴', shortcut: 'Ctrl+V', icon: 'E77F', disabled: !editable || readonly, action: ctxPaste},
        {label: '全选', shortcut: 'Ctrl+A', icon: 'E8B3', disabled: !editable, action: ctxSelectAll},
        ...(canShot ? [{
            label: '代码截图',
            icon: 'E74E',
            submenu: [
                {label: '带标题', checked: !!deps.settings.codeShotTitle, action: toggleCodeShotTitle},
                {sep: true},
                {label: '复制为图片', icon: 'E8C8', action: copyCodeShot},
                {label: '导出为 PNG…', icon: 'E74E', action: exportCodeShot},
            ],
        }] : []),
        {sep: true},
        {label: '查找…', shortcut: 'Ctrl+F', icon: 'E721', disabled: !editable, action: ctxFind},
        {label: '格式化', shortcut: 'Ctrl+Alt+L', disabled: !deps.file || readonly || !!deps.file.format.rawOnly, action: deps.formatDocument},
        {label: '重新加载', icon: 'E72C', disabled: !hasPath, action: deps.requestReload},
        ...(code ? [{sep: true}, {label: '运行', shortcut: 'F5', icon: 'E768', disabled: !runSupported, action: () => deps.runController.run()}] : []),
        {sep: true},
        {
            label: '折叠',
            icon: 'E70D',
            disabled: !code,
            submenu: [
                {label: '折叠当前', action: () => ctxFold('fold')},
                {label: '展开当前', action: () => ctxFold('unfold')},
                {sep: true},
                {label: '全部折叠', action: () => ctxFold('foldall')},
                {label: '全部展开', action: () => ctxFold('unfoldall')},
            ],
        },
        {sep: true},
        {
            label: '书签',
            icon: 'bookmark',
            disabled: !editable,
            submenu: [
                {label: '切换当前行书签', shortcut: 'F11', action: deps.toggleBookmark},
                {label: '书签总览…', shortcut: 'Shift+F11', action: deps.openBookmarkList},
                {label: '清除本文档书签', action: deps.clearCurrentDocBookmarks},
            ],
        },
        {sep: true},
        ...referenceItems,
        ...(referenceItems.length ? [{sep: true}] : []),
        {label: '复制文件路径', icon: 'E8C8', disabled: !hasPath, action: () => deps.copyText(deps.file.path, '路径')},
        {label: '打开文件位置', icon: 'E8B7', disabled: !hasPath, action: deps.showInFolder},
    ], x, y);
}

function showBlankMenu(x, y) {
    if (!deps.ctxMenu) return;
    const items = [
        {label: '新建', shortcut: 'Ctrl+N', icon: 'E710', action: deps.newDocument},
        {label: '打开文件…', shortcut: 'Ctrl+O', icon: 'E8E5', action: deps.openDialog},
        {label: '打开文件夹…', icon: 'E8B7', action: deps.openFolderDialog},
    ];
    if (deps.workspaceFolder) items.push({label: '关闭文件夹', icon: 'E8BB', action: deps.closeFolder});
    items.push({sep: true}, {label: '设置…', shortcut: 'Ctrl+,', icon: 'E713', action: () => deps.openSettings('general')});
    deps.ctxMenu.open(items, x, y);
}

function initContextMenus() {
    deps.ctxMenu = deps.createContextMenu();
    deps.palette = deps.createPalette({mask: deps.els.paletteMask, input: deps.els.paletteInput, list: deps.els.paletteList, getActions: deps.paletteActions});
    // ---- 阅读模式（docs/finished-plans/reading-mode.md）：视图容器 + 控制器，只读 ----
    const readingContainer = document.getElementById('reading-view');
    if (readingContainer) {
        deps.readingMode = deps.createReadingMode({
            container: readingContainer,
            getBackend: () => deps.backend,
            getSetting: (key, dflt) => {
                const v = deps.settings[key];
                return v === undefined ? dflt : v;
            },
            setSetting: (key, value) => {
                deps.settings[key] = value;
                deps.applySettings();
            },
            getWorkspace: () => deps.workspaceFolder || '',
            isDarkTheme: () => /dark|darcula|night/i.test(String(deps.settings.theme)),
            isDialogOpen: deps.isDialogOpen,
            openInEditor: (path, line) => {
                deps.closeReadingForEditor();
                deps.openPath(path);
                if (line && line > 0) {
                    setTimeout(() => {
                        try {
                            deps.jumpToPosition(line, 1);
                        } catch (e) {}
                    }, 250);
                }
            },
            showFlash: (msg) => deps.flash(msg),
            chooseDirectory: async () => {
                try {
                    return await deps.backend.OpenFolderDialog(deps.defaultFolderDir());
                } catch (e) {
                    return '';
                }
            },
            showInFolder: (path) => deps.backend.ShowInFolder(path).catch(() => {}),
        });
    }
    if (!deps.els.mainPane) return;
    deps.els.mainPane.addEventListener('contextmenu', (e) => {
        if (e.target.closest && e.target.closest('.ctx-menu')) return;
        if (!deps.file) {
            e.preventDefault();
            e.stopPropagation();
            showBlankMenu(e.clientX, e.clientY);
            return;
        }
        // Markdown 预览区（完整预览或分屏右栏）：专用右键菜单
        const paneEl = e.target.closest && e.target.closest('.jsoneditor-pane');
        const pd = paneEl ? deps.docs.find((d) => d.pane === paneEl) : null;
        if (pd && pd.previewBody && e.target.closest && e.target.closest('.md-preview-view')) {
            e.preventDefault();
            e.stopPropagation();
            deps.showMdPreviewMenu(pd, e.clientX, e.clientY);
            return;
        }
        if (pd && pd.svgRenderEl && e.target.closest && e.target.closest('.svg-render-view')) {
            e.preventDefault();
            e.stopPropagation();
            deps.showSvgMenu(pd, e.clientX, e.clientY);
            return;
        }
        if (pd && pd.imageEl && e.target.closest && e.target.closest('.image-preview-view')) {
            e.preventDefault();
            e.stopPropagation();
            deps.showImageMenu(pd, e.clientX, e.clientY);
            return;
        }
        if (deps.currentMode === 'tree' || deps.currentMode === 'table' || deps.currentMode === 'preview' ||
            deps.currentMode === 'image' || deps.currentMode === 'video' || deps.currentMode === 'audio' || deps.currentMode === 'binary') return;
        e.preventDefault();
        e.stopPropagation();
        showEditorMenu(e.clientX, e.clientY);
    });
}

    return {
        selectedText,
        ctxCopy,
        ctxCut,
        ctxPaste,
        ctxSelectAll,
        ctxFind,
        ctxFold,
        showEditorMenu,
        showBlankMenu,
        initContextMenus,
    };
}
