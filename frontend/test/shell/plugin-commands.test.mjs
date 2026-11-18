// 插件命令入口矩阵护栏（cadt.addCommand 的表单扩展）：声明归一化 → contexts 入口归属 →
// when 条件求值 → 快捷键校验与命中 → 旧式命令仍兼容 → 重载清空。
// 纯逻辑在 src/shell/plugin-commands-model.js；宿主（main.js / editor-menus.js）只消费判定结果。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    COMMAND_CATEGORY_LABELS, commandAppliesTo, commandCategoryLabel,
    evalCommandWhen, matchCommandShortcut, normalizeCommandShortcut, normalizePluginCommand,
} from '../../src/shell/plugin-commands-model.js';
import {initPluginRuntime, loadPlugins, getPluginCommands} from '../../src/shell/plugins.js';

const source = (code) => ({GetPluginSources: async () => [{id: 'p1', name: 'P1', code}]});

test('归一化：缺省值补齐（contexts=tools / category=plugin / 无图标描述）', () => {
    const cmd = normalizePluginCommand('p1', 'P1', {id: 'run-it', label: '跑一下', run() {}});
    assert.equal(cmd.id, 'p1:run-it', '全局 id 带插件前缀');
    assert.equal(cmd.pluginId, 'p1');
    assert.equal(cmd.pluginName, 'P1');
    assert.equal(cmd.label, '跑一下');
    assert.deepEqual(cmd.contexts, ['tools'], '缺省只进工具菜单');
    assert.equal(cmd.category, 'plugin');
    assert.equal(cmd.icon, '');
    assert.equal(cmd.description, '');
    assert.equal(cmd.when, null);
    assert.equal(cmd.shortcut, null);
    assert.equal(typeof cmd.run, 'function');
});

test('归一化：完整字段透传 + contexts 过滤白名单', () => {
    const when = () => true;
    const cmd = normalizePluginCommand('p1', 'P1', {
        id: 'fmt', label: '格式化', icon: 'wand', description: '格式化选中内容',
        category: 'format', contexts: ['tools', 'editorContext', 'bogus'], when,
        shortcut: {key: 'Ctrl+Alt+F', when: 'editorFocus'},
        run() {},
    });
    assert.deepEqual(cmd.contexts, ['tools', 'editorContext'], '未知入口被剔除');
    assert.equal(cmd.category, 'format');
    assert.equal(cmd.icon, 'wand');
    assert.equal(cmd.description, '格式化选中内容');
    assert.equal(cmd.when, when);
    assert.equal(cmd.shortcut.combo, 'Ctrl+Alt+F');
    assert.equal(cmd.shortcut.when, 'editorFocus');
});

test('归一化：非法声明抛错', () => {
    assert.throws(() => normalizePluginCommand('p1', 'P1', {id: 'BAD', label: 'x', run() {}}), /id 无效/);
    assert.throws(() => normalizePluginCommand('p1', 'P1', {id: 'ok', run() {}}), /缺少 label/);
    assert.throws(() => normalizePluginCommand('p1', 'P1', {id: 'ok', label: 'x'}), /缺少 run/);
    assert.throws(() => normalizePluginCommand('p1', 'P1', {id: 'ok', label: 'x', run() {}, when: 'nope'}), /when 必须是函数/);
    assert.throws(
        () => normalizePluginCommand('p1', 'P1', {id: 'ok', label: 'x', run() {}, contexts: ['bogus']}),
        /contexts 无效/);
    assert.throws(() => normalizePluginCommand('', 'P1', {id: 'ok', label: 'x', run() {}}), /缺少插件 id/);
});

test('快捷键：合法归一化 / 大小写不敏感 / when 只认 editorFocus', () => {
    assert.deepEqual(normalizeCommandShortcut({key: 'ctrl+alt+f'}), {combo: 'Ctrl+Alt+F', label: 'Ctrl+Alt+F', when: ''});
    assert.equal(normalizeCommandShortcut({key: 'F5', when: 'editorFocus'}).when, 'editorFocus');
    assert.equal(normalizeCommandShortcut(null), null);
    assert.throws(() => normalizeCommandShortcut({}), /缺少 key/);
    assert.throws(() => normalizeCommandShortcut({key: 'Ctrl+Nope'}), /无效/);
    assert.throws(() => normalizeCommandShortcut({key: 'Ctrl+F', when: 'somewhereElse'}), /只支持 'editorFocus'/);
});

test('入口归属：palette 对所有命令开放，tools/editorContext 按声明', () => {
    const onlyEditor = normalizePluginCommand('p1', 'P1', {id: 'e', label: 'e', run() {}, contexts: ['editorContext']});
    assert.equal(commandAppliesTo(onlyEditor, 'editorContext'), true);
    assert.equal(commandAppliesTo(onlyEditor, 'tools'), false);
    assert.equal(commandAppliesTo(onlyEditor, 'palette'), true, '命令面板是兜底入口');
    const dflt = normalizePluginCommand('p1', 'P1', {id: 'd', label: 'd', run() {}});
    assert.equal(commandAppliesTo(dflt, 'tools'), true);
    assert.equal(commandAppliesTo(dflt, 'editorContext'), false);
});

test('when 求值：无 when 为真，返回 false 生效，抛错当「不满足」', () => {
    assert.equal(evalCommandWhen({when: null}, {}), true);
    assert.equal(evalCommandWhen({when: () => false}, {}), false);
    assert.equal(evalCommandWhen({when: () => true}, {}), true);
    assert.equal(evalCommandWhen({when: () => { throw new Error('boom'); }}, {}), false, '插件抛错不得阻断菜单');
    // when 收到宿主给的环境快照
    let seen = null;
    evalCommandWhen({when: (env) => { seen = env; return true; }}, {hasFile: true, formatId: 'json'});
    assert.deepEqual(seen, {hasFile: true, formatId: 'json'});
});

test('快捷键命中：先注册优先 / editorFocus 需聚焦 / when 不满足跳过', () => {
    const a = normalizePluginCommand('p1', 'P1', {id: 'a', label: 'A', run() {}, shortcut: {key: 'Ctrl+Alt+1'}});
    const b = normalizePluginCommand('p1', 'P1', {id: 'b', label: 'B', run() {}, shortcut: {key: 'Ctrl+Alt+1'}});
    assert.equal(matchCommandShortcut([a, b], 'Ctrl+Alt+1', {}), a, '同键先注册者胜');

    const focusOnly = normalizePluginCommand('p1', 'P1', {
        id: 'f', label: 'F', run() {}, shortcut: {key: 'Ctrl+Alt+2', when: 'editorFocus'},
    });
    assert.equal(matchCommandShortcut([focusOnly], 'Ctrl+Alt+2', {editorFocused: false}), null);
    assert.equal(matchCommandShortcut([focusOnly], 'Ctrl+Alt+2', {editorFocused: true}), focusOnly);

    const gated = normalizePluginCommand('p1', 'P1', {
        id: 'g', label: 'G', run() {}, shortcut: {key: 'Ctrl+Alt+3'}, when: (env) => !!env.hasFile,
    });
    assert.equal(matchCommandShortcut([gated], 'Ctrl+Alt+3', {hasFile: false}), null);
    assert.equal(matchCommandShortcut([gated], 'Ctrl+Alt+3', {hasFile: true}), gated);

    assert.equal(matchCommandShortcut([a], 'Ctrl+Alt+9', {}), null, '无声明该键返回 null');
    assert.equal(matchCommandShortcut([a], '', {}), null);
});

test('分类标签：已知分组用中文名，未知回退插件', () => {
    assert.equal(commandCategoryLabel({category: 'format'}), COMMAND_CATEGORY_LABELS.format);
    assert.equal(commandCategoryLabel({category: 'plugin'}), '插件');
    assert.equal(commandCategoryLabel({}), '插件');
    assert.equal(commandCategoryLabel(null), '插件');
});

test('与 plugins.js 集成：新字段生效、旧式命令仍兼容、重复 id 报错', async () => {
    initPluginRuntime({});
    const errors = await loadPlugins(source(
        'cadt.addCommand({id: "plain", label: "旧式", run() {}});' +
        'cadt.addCommand({id: "rich", label: "新式", category: "view", contexts: ["tools", "editorContext"],' +
        ' shortcut: {key: "Ctrl+Alt+R"}, description: "描述", run() {}});'));
    assert.deepEqual(errors, []);
    const cmds = getPluginCommands();
    assert.equal(cmds.length, 2);
    const plain = cmds.find((c) => c.id === 'p1:plain');
    const rich = cmds.find((c) => c.id === 'p1:rich');
    assert.deepEqual(plain.contexts, ['tools'], '旧式命令按缺省进工具菜单');
    assert.equal(rich.category, 'view');
    assert.deepEqual(rich.contexts, ['tools', 'editorContext']);
    assert.equal(rich.shortcut.combo, 'Ctrl+Alt+R');
    assert.equal(rich.pluginName, 'P1');

    // 重载清空（禁用 / 卸载路径）
    await loadPlugins({GetPluginSources: async () => []});
    assert.deepEqual(getPluginCommands(), []);
});

test('与 plugins.js 集成：重复 id 与非法声明进加载错误，不炸运行时', async () => {
    initPluginRuntime({});
    const dup = await loadPlugins(source(
        'cadt.addCommand({id: "d", label: "A", run() {}});' +
        'cadt.addCommand({id: "d", label: "B", run() {}});'));
    assert.equal(dup.length, 1);
    assert.match(dup[0], /已注册/);
    assert.equal(getPluginCommands().length, 1);

    const bad = await loadPlugins(source('cadt.addCommand({id: "x", label: "X"});'));
    assert.equal(bad.length, 1);
    assert.match(bad[0], /缺少 run/);
});
