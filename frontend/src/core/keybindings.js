// keybindings.js：快捷键动作的单一来源（显示 + 分发共用同一张表）。
//
// 背景：设置页快捷键表原先是 index.html 里手抄的一份静态 HTML，与 main.js 的真实绑定
// 各自维护、已经漂移——表里写「全屏 F11」「重命名 F2 / Shift+F6」，而代码里 F11 实为
// 「切换行书签」、F2/Shift+F2 实为「跳书签」，重命名根本没有键盘快捷键（只有右键菜单）。
// 现在这张表由本文件生成，文案只有一份；护栏测试再把它与 main.js 的真实绑定对账。
//
// 三套风格（settings.keyStyle；运行时由 core/keymap.js 查表分发，切换立即生效）：
//   - candysweet（默认）：本软件当前实际生效的键位（JetBrains / VS Code 混合体）。
//     **这一列必须与真实绑定逐字一致**，否则表格又会骗人。
//   - jetbrains：对齐 IDEA / DataGrip。
//   - vscode：对齐 VS Code。
//
// 一个动作可以绑多个组合：keys[style] 是数组，数组里每一项都能独立触发该动作
// （例：重做 = Ctrl+Y / Ctrl+Shift+Z；VS Code 风格的全局搜索 = Ctrl+P / Ctrl+Shift+F）。
// 非组合键的特殊触发（双击 Shift）用 DOUBLE_SHIFT 表示，不进分发索引，由
// core/shift-double-tap.js 单独结算——该风格不含 DOUBLE_SHIFT 时双击 Shift 不触发。
//
// kind：
//   - 'key'  真实键盘组合，参与风格内冲突检测；**在风格间有差异时必须能被 keymap 分发**
//   - 'text' 描述性文本（鼠标手势 / 菜单路径 / 多键组合说明），不参与冲突检测

export const KEY_STYLE_CANDYSWEET = 'candysweet';
export const KEY_STYLE_JETBRAINS = 'jetbrains';
export const KEY_STYLE_VSCODE = 'vscode';
export const DEFAULT_KEY_STYLE = KEY_STYLE_CANDYSWEET;

// 特殊触发（非组合键）：双击 Shift → 全局搜索
export const DOUBLE_SHIFT = '双击 Shift';

export const KEY_STYLES = [
    {id: KEY_STYLE_CANDYSWEET, name: 'CandySweet（默认）'},
    {id: KEY_STYLE_JETBRAINS, name: 'IDEA / JetBrains'},
    {id: KEY_STYLE_VSCODE, name: 'VS Code'},
];

// 分组顺序 = 设置页表格的展示顺序
export const KEY_GROUPS = ['文件', '编辑', '运行', '视图与窗口', 'AI 助手', '文件树', '编辑器'];

// 漂移已修正：全屏无键（菜单操作）、重命名无键（右键菜单）、书签 F11 / F2 / Shift+F2 补录。
export const KEY_BINDINGS = [
    // —— 文件 ——
    {id: 'file.new', group: '文件', label: '新建', kind: 'key', keys: {candysweet: ['Ctrl+N'], jetbrains: ['Ctrl+N'], vscode: ['Ctrl+N']}},
    {id: 'file.newWindow', group: '文件', label: '新建窗口', kind: 'key', keys: {candysweet: ['Ctrl+Shift+N'], jetbrains: ['Ctrl+Shift+N'], vscode: ['Ctrl+Shift+N']}},
    {id: 'file.newBrowserTab', group: '文件', label: '新建浏览器标签页', kind: 'key', keys: {candysweet: ['Ctrl+Alt+B'], jetbrains: ['Ctrl+Alt+B'], vscode: ['Ctrl+Alt+B']}},
    {id: 'file.newMemo', group: '文件', label: '快捷便签面板', kind: 'key', keys: {candysweet: ['Ctrl+Alt+M'], jetbrains: ['Ctrl+Alt+M'], vscode: ['Ctrl+Alt+M']}},
    {id: 'file.open', group: '文件', label: '打开', kind: 'key', keys: {candysweet: ['Ctrl+O'], jetbrains: ['Ctrl+O'], vscode: ['Ctrl+O']}},
    {id: 'file.save', group: '文件', label: '保存', kind: 'key', keys: {candysweet: ['Ctrl+S'], jetbrains: ['Ctrl+S'], vscode: ['Ctrl+S']}},
    {id: 'file.saveAs', group: '文件', label: '另存为', kind: 'key', keys: {candysweet: ['Ctrl+Shift+S'], jetbrains: ['Ctrl+Shift+S'], vscode: ['Ctrl+Shift+S']}},
    {id: 'file.closeTab', group: '文件', label: '关闭标签', kind: 'key', keys: {candysweet: ['Ctrl+W'], jetbrains: ['Ctrl+W'], vscode: ['Ctrl+W']}},
    {id: 'file.reopenTab', group: '文件', label: '重新打开关闭的标签页', kind: 'key', keys: {candysweet: ['Ctrl+Shift+T'], jetbrains: ['Ctrl+Shift+T'], vscode: ['Ctrl+Shift+T']}},
    {id: 'file.settings', group: '文件', label: '设置', kind: 'key', keys: {candysweet: ['Ctrl+,'], jetbrains: ['Ctrl+Alt+S'], vscode: ['Ctrl+,']}},
    {id: 'file.openInNewWindow', group: '文件', label: '在独立窗口打开当前文件', kind: 'key', keys: {candysweet: ['Shift+F4'], jetbrains: ['Shift+F4'], vscode: ['Shift+F4']}},

    // —— 编辑 ——
    {id: 'edit.undo', group: '编辑', label: '撤销', kind: 'key', keys: {candysweet: ['Ctrl+Z'], jetbrains: ['Ctrl+Z'], vscode: ['Ctrl+Z']}},
    {id: 'edit.redo', group: '编辑', label: '重做', kind: 'key', keys: {candysweet: ['Ctrl+Y', 'Ctrl+Shift+Z'], jetbrains: ['Ctrl+Y', 'Ctrl+Shift+Z'], vscode: ['Ctrl+Y', 'Ctrl+Shift+Z']}},
    {id: 'edit.format', group: '编辑', label: '格式化', kind: 'key', keys: {candysweet: ['Ctrl+Alt+L'], jetbrains: ['Ctrl+Alt+L'], vscode: ['Alt+Shift+F']}},
    {id: 'edit.find', group: '编辑', label: '查找', kind: 'key', keys: {candysweet: ['Ctrl+F'], jetbrains: ['Ctrl+F'], vscode: ['Ctrl+F']}},
    {id: 'edit.globalSearch', group: '编辑', label: '全局搜索', kind: 'key', keys: {candysweet: [DOUBLE_SHIFT], jetbrains: [DOUBLE_SHIFT], vscode: ['Ctrl+P', 'Ctrl+Shift+F']}},
    {id: 'edit.gotoLine', group: '编辑', label: '代码/文本视图转到行:列', kind: 'key', keys: {candysweet: ['Ctrl+G'], jetbrains: ['Ctrl+G'], vscode: ['Ctrl+G']}},
    {id: 'edit.toggleBookmark', group: '编辑', label: '切换当前行书签', kind: 'key', keys: {candysweet: ['F11'], jetbrains: ['F11'], vscode: ['F11']}},
    {id: 'edit.nextBookmark', group: '编辑', label: '跳到下一个书签', kind: 'key', keys: {candysweet: ['F2'], jetbrains: ['F2'], vscode: ['F2']}},
    {id: 'edit.prevBookmark', group: '编辑', label: '跳到上一个书签', kind: 'key', keys: {candysweet: ['Shift+F2'], jetbrains: ['Shift+F2'], vscode: ['Shift+F2']}},
    {id: 'edit.bookmarkList', group: '编辑', label: '书签总览（跨文件，Delete 删除选中项）', kind: 'key', keys: {candysweet: ['Shift+F11'], jetbrains: ['Shift+F11'], vscode: ['Shift+F11']}},

    // —— 运行 ——
    {id: 'run.current', group: '运行', label: '运行当前文件', kind: 'key', keys: {candysweet: ['F5'], jetbrains: ['Shift+F10'], vscode: ['F5']}},
    {id: 'run.stop', group: '运行', label: '停止运行', kind: 'key', keys: {candysweet: ['Shift+F5'], jetbrains: ['Ctrl+F10'], vscode: ['Shift+F5']}},
    {id: 'run.project', group: '运行', label: '运行项目', kind: 'key', keys: {candysweet: ['Ctrl+F5'], jetbrains: ['Ctrl+F5'], vscode: ['Ctrl+F5']}},
    {id: 'run.panel', group: '运行', label: '运行面板', kind: 'key', keys: {candysweet: ['Alt+F11'], jetbrains: ['Alt+F11'], vscode: ['Ctrl+J']}},

    // —— 视图与窗口 ——
    {id: 'view.sidebar', group: '视图与窗口', label: '文件侧边栏', kind: 'key', keys: {candysweet: ['Ctrl+B', 'Alt+1'], jetbrains: ['Alt+1'], vscode: ['Ctrl+B']}},
    {id: 'view.structure', group: '视图与窗口', label: '结构视图', kind: 'key', keys: {candysweet: ['Alt+7'], jetbrains: ['Alt+7'], vscode: ['Ctrl+Shift+O']}},
    {id: 'view.chats', group: '视图与窗口', label: '群聊侧栏', kind: 'key', keys: {candysweet: ['Alt+8'], jetbrains: ['Alt+8'], vscode: ['Alt+8']}},
    {id: 'view.terminal', group: '视图与窗口', label: '终端', kind: 'key', keys: {candysweet: ['Alt+F12'], jetbrains: ['Alt+F12'], vscode: ['Ctrl+`']}},
    {id: 'view.debug', group: '视图与窗口', label: '调试控制台（开发者模式）', kind: 'key', keys: {candysweet: ['F12'], jetbrains: ['F12'], vscode: ['F12']}},
    {id: 'view.quickSwitch', group: '视图与窗口', label: '快速切换（主题 / 视图 / 字体）', kind: 'key', keys: {candysweet: ['Ctrl+`'], jetbrains: ['Ctrl+`'], vscode: ['Ctrl+Shift+`']}},
    {id: 'view.palette', group: '视图与窗口', label: '命令面板', kind: 'key', keys: {candysweet: ['Ctrl+Shift+P'], jetbrains: ['Ctrl+Shift+A'], vscode: ['Ctrl+Shift+P']}},
    {id: 'view.jsonQuery', group: '视图与窗口', label: 'JSON 查询', kind: 'key', keys: {candysweet: ['Ctrl+Shift+J'], jetbrains: ['Ctrl+Shift+J'], vscode: ['Ctrl+Shift+J']}},
    {id: 'view.fontSize', group: '视图与窗口', label: '编辑器字号', kind: 'text', keys: {candysweet: ['Ctrl+滚轮'], jetbrains: ['Ctrl+滚轮'], vscode: ['Ctrl+滚轮']}},
    {id: 'view.fullscreen', group: '视图与窗口', label: '全屏 / 退出全屏', kind: 'text', keys: {candysweet: ['菜单操作'], jetbrains: ['菜单操作'], vscode: ['菜单操作']}},

    // —— AI 助手 ——
    {id: 'ai.togglePanel', group: 'AI 助手', label: '打开 / 关闭 AI 面板', kind: 'key', keys: {candysweet: ['Alt+9'], jetbrains: ['Alt+9'], vscode: ['Alt+9']}},
    {id: 'ai.send', group: 'AI 助手', label: '发送 / 换行', kind: 'text', keys: {candysweet: ['Enter / Shift+Enter'], jetbrains: ['Enter / Shift+Enter'], vscode: ['Enter / Shift+Enter']}},
    {id: 'ai.sendToggle', group: 'AI 助手', label: '切换为 Ctrl+Enter 发送', kind: 'text', keys: {candysweet: ['设置 · AI 助手'], jetbrains: ['设置 · AI 助手'], vscode: ['设置 · AI 助手']}},

    // —— 文件树 ——
    {id: 'tree.open', group: '文件树', label: '打开 / 展开', kind: 'text', keys: {candysweet: ['双击'], jetbrains: ['双击'], vscode: ['双击']}},
    {id: 'tree.toggleDir', group: '文件树', label: '展开 / 收起目录', kind: 'text', keys: {candysweet: ['单击箭头'], jetbrains: ['单击箭头'], vscode: ['单击箭头']}},
    {id: 'tree.multi', group: '文件树', label: '多选', kind: 'text', keys: {candysweet: ['Ctrl+单击'], jetbrains: ['Ctrl+单击'], vscode: ['Ctrl+单击']}},
    {id: 'tree.range', group: '文件树', label: '连续选择', kind: 'text', keys: {candysweet: ['Shift+单击'], jetbrains: ['Shift+单击'], vscode: ['Shift+单击']}},
    {id: 'tree.addRange', group: '文件树', label: '追加范围选择', kind: 'text', keys: {candysweet: ['Ctrl+Shift+单击'], jetbrains: ['Ctrl+Shift+单击'], vscode: ['Ctrl+Shift+单击']}},
    {id: 'tree.rename', group: '文件树', label: '重命名', kind: 'text', keys: {candysweet: ['右键菜单'], jetbrains: ['右键菜单'], vscode: ['右键菜单']}},
    {id: 'tree.copy', group: '文件树', label: '复制选中项', kind: 'key', keys: {candysweet: ['Ctrl+C'], jetbrains: ['Ctrl+C'], vscode: ['Ctrl+C']}},
    {id: 'tree.cut', group: '文件树', label: '剪切选中项', kind: 'key', keys: {candysweet: ['Ctrl+X'], jetbrains: ['Ctrl+X'], vscode: ['Ctrl+X']}},
    {id: 'tree.paste', group: '文件树', label: '粘贴', kind: 'key', keys: {candysweet: ['Ctrl+V'], jetbrains: ['Ctrl+V'], vscode: ['Ctrl+V']}},
    {id: 'tree.delete', group: '文件树', label: '删除选中项', kind: 'key', keys: {candysweet: ['Delete'], jetbrains: ['Delete'], vscode: ['Delete']}},

    // —— 编辑器 ——
    {id: 'editor.multiCursor', group: '编辑器', label: '多光标（添加 / 列光标）', kind: 'text', keys: {candysweet: ['Alt+单击 / 中键拖动'], jetbrains: ['Alt+单击 / 中键拖动'], vscode: ['Alt+单击 / 中键拖动']}},
    {id: 'editor.fold', group: '编辑器', label: '展开 / 收起节点（树视图）', kind: 'key', keys: {candysweet: ['Ctrl+=', 'Ctrl+-'], jetbrains: ['Ctrl+=', 'Ctrl+-'], vscode: ['Ctrl+=', 'Ctrl+-']}},
    {id: 'editor.foldAll', group: '编辑器', label: '全部展开 / 收起', kind: 'key', keys: {candysweet: ['Ctrl+Shift+=', 'Ctrl+Shift+-'], jetbrains: ['Ctrl+Shift+=', 'Ctrl+Shift+-'], vscode: ['Ctrl+Shift+=', 'Ctrl+Shift+-']}},
];

export function isValidKeyStyleId(id) {
    return KEY_STYLES.some((s) => s.id === id);
}

export function keyStyleName(id) {
    const style = KEY_STYLES.find((s) => s.id === id);
    return style ? style.name : id;
}

// 某个动作在某风格下的键位列表（数组；可能含 DOUBLE_SHIFT 这类特殊触发）。
export function keyListFor(binding, style = DEFAULT_KEY_STYLE) {
    if (!binding || !binding.keys) return [];
    const list = binding.keys[style];
    if (!list) return binding.keys[DEFAULT_KEY_STYLE] || [];
    return Array.isArray(list) ? list : [list];
}

// 展示用文案：多组合用 ' / ' 连接（'Ctrl+Y / Ctrl+Shift+Z'）。
export function getShortcut(id, style = DEFAULT_KEY_STYLE) {
    const binding = KEY_BINDINGS.find((b) => b.id === id);
    if (!binding) return '';
    return keyListFor(binding, style).join(' / ');
}

export function shortcutsByGroup(style = DEFAULT_KEY_STYLE) {
    const groups = new Map(KEY_GROUPS.map((g) => [g, []]));
    for (const binding of KEY_BINDINGS) {
        if (!groups.has(binding.group)) groups.set(binding.group, []);
        groups.get(binding.group).push({
            id: binding.id,
            label: binding.label,
            key: keyListFor(binding, style).join(' / '),
        });
    }
    return groups;
}

// 生成设置页「快捷键」表格内容（.popover-shortcuts 的内部 HTML）。
export function renderShortcutsTable(style = DEFAULT_KEY_STYLE) {
    let html = '';
    for (const [group, rows] of shortcutsByGroup(style)) {
        if (!rows.length) continue;
        html += '<div class="settings-section-title">' + group + '</div>';
        for (const row of rows) {
            html += '<div><span>' + row.label + '</span><span class="kbd">' + row.key + '</span></div>';
        }
    }
    return html;
}

// 供测试做风格内冲突检测：只返回真实键盘组合，跳过描述性文本与特殊触发。
export function keyBindingsForStyle(style = DEFAULT_KEY_STYLE) {
    const out = [];
    for (const b of KEY_BINDINGS) {
        if (b.kind !== 'key') continue;
        for (const combo of keyListFor(b, style)) {
            if (combo === DOUBLE_SHIFT) continue;
            out.push({id: b.id, combo});
        }
    }
    return out;
}

// 同一风格内两个动作抢同一个组合 → 返回冲突清单（正常应为空）。
export function findStyleConflicts(style = DEFAULT_KEY_STYLE) {
    const seen = new Map();
    const conflicts = [];
    for (const {id, combo} of keyBindingsForStyle(style)) {
        if (seen.has(combo)) {
            const hit = conflicts.find((c) => c.combo === combo);
            if (hit) hit.ids.push(id);
            else conflicts.push({combo, ids: [seen.get(combo), id]});
        } else {
            seen.set(combo, id);
        }
    }
    return conflicts;
}

// 该动作在各风格下的键位（不一致 = 风格切换会改变行为，必须能被 keymap 分发）。
export function styleVariants(id) {
    const binding = KEY_BINDINGS.find((b) => b.id === id);
    if (!binding) return {};
    const out = {};
    for (const style of KEY_STYLES) out[style.id] = keyListFor(binding, style.id).join(' / ');
    return out;
}

export function variesByStyle(id) {
    const values = Object.values(styleVariants(id));
    return values.some((v) => v !== values[0]);
}
