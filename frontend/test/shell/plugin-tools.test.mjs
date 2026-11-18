// 插件 AI 工具注册表护栏（cadt.registerTool）：声明归一化 → 上限 → 命名解析 →
// 三层授权与 readOnly 只读档放行 → 计划模式恒不给 → 重载清空。
// 安全口径见 docs/unfinished-plans/plugin-tool-security.md（M2 定稿）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MAX_TOOLS_PER_PLUGIN, MAX_TOOLS_TOTAL,
    authorizedPluginToolDefs, clearPluginTools, getPluginTool, getPluginTools,
    isPluginToolName, normalizePluginTool, parsePluginToolName, pluginToolFullName,
    pluginToolsByPlugin, registerPluginTool, toolAuthState, toolIsAvailable,
} from '../../src/shell/plugin-tools.js';

const plain = (over) => ({name: 'query_x', description: '查询 X', execute: async () => 'ok', ...over});

function reset() {
    clearPluginTools();
}

const authOf = (over = {}) => ({
    enabled: true,
    plugins: {p1: {allow: true, tools: {query_x: {on: true, readOnlyOk: false}}}},
    ...over,
});

test('命名与解析：plugin__<id>__<tool>', () => {
    assert.equal(pluginToolFullName('p1', 'query_x'), 'plugin__p1__query_x');
    assert.equal(isPluginToolName('plugin__p1__a'), true);
    assert.equal(isPluginToolName('mcp__x__y'), false);
    assert.deepEqual(parsePluginToolName('plugin__p1__query_x'), {pluginId: 'p1', toolName: 'query_x'});
    assert.equal(parsePluginToolName('mcp__a__b'), null);
    assert.equal(parsePluginToolName('plugin__'), null);
    assert.equal(parsePluginToolName('plugin____x'), null);
    // 插件 id 含连字符也能正确解析
    assert.deepEqual(parsePluginToolName('plugin__my-plugin__do_it'), {pluginId: 'my-plugin', toolName: 'do_it'});
});

test('归一化：默认值与字段透传', () => {
    const tool = normalizePluginTool('p1', 'P1', plain());
    assert.equal(tool.fullName, 'plugin__p1__query_x');
    assert.equal(tool.pluginId, 'p1');
    assert.equal(tool.pluginName, 'P1');
    assert.equal(tool.name, 'query_x');
    assert.equal(tool.readOnly, false);
    assert.equal(tool.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.deepEqual(tool.parameters, {type: 'object', properties: {}});
    assert.equal(typeof tool.execute, 'function');

    const ro = normalizePluginTool('p1', 'P1', plain({readOnly: true, timeoutMs: 999999}));
    assert.equal(ro.readOnly, true);
    assert.equal(ro.timeoutMs, MAX_TIMEOUT_MS, '超上限钳到 MAX');
});

test('归一化：非法声明抛错', () => {
    assert.throws(() => normalizePluginTool('BAD_ID', 'P', plain()), /插件 id 无效/);
    assert.throws(() => normalizePluginTool('p1', 'P', plain({name: 'Bad Name'})), /工具名无效/);
    assert.throws(() => normalizePluginTool('p1', 'P', plain({name: 'a__b'})), /连续双下划线/);
    assert.throws(() => normalizePluginTool('p1', 'P', {name: 'x', execute() {}}), /缺少 description/);
    assert.throws(() => normalizePluginTool('p1', 'P', plain({description: 'x'.repeat(2001)})), /description 超过/);
    assert.throws(() => normalizePluginTool('p1', 'P', {name: 'x', description: 'd', execute: 'no'}), /缺少 execute/);
    assert.throws(() => normalizePluginTool('p1', 'P', plain({parameters: []})), /parameters 必须是 JSON 对象/);
    assert.throws(
        () => normalizePluginTool('p1', 'P', plain({parameters: {type: 'object', big: 'x'.repeat(20000)}})),
        /parameters 超过/);
});

test('注册：重复与上限', () => {
    reset();
    registerPluginTool('p1', 'P1', plain());
    assert.throws(() => registerPluginTool('p1', 'P1', plain()), /已注册/);

    reset();
    for (let i = 0; i < MAX_TOOLS_PER_PLUGIN; i += 1) {
        registerPluginTool('p1', 'P1', plain({name: 'tool_' + i}));
    }
    assert.equal(getPluginTools().length, MAX_TOOLS_PER_PLUGIN);
    assert.throws(() => registerPluginTool('p1', 'P1', plain({name: 'overflow'})), /单插件工具数超过上限/);

    reset();
    for (let i = 0; i < MAX_TOOLS_TOTAL; i += 1) {
        registerPluginTool('p' + i, 'P', plain({name: 'tool'}));
    }
    assert.throws(() => registerPluginTool('pover', 'P', plain({name: 'tool'})), /总数超过上限/);
});

test('注册：按插件分组 + 清空', () => {
    reset();
    registerPluginTool('p1', 'P1', plain({name: 'a'}));
    registerPluginTool('p1', 'P1', plain({name: 'b'}));
    registerPluginTool('p2', 'P2', plain({name: 'c'}));
    const groups = pluginToolsByPlugin();
    assert.equal(groups.length, 2);
    const g1 = groups.find((g) => g.pluginId === 'p1');
    assert.equal(g1.pluginName, 'P1');
    assert.deepEqual(g1.tools.map((t) => t.name), ['a', 'b']);
    assert.ok(getPluginTool('plugin__p2__c'));
    assert.equal(getPluginTool('plugin__p2__zzz'), null);
    clearPluginTools();
    assert.deepEqual(getPluginTools(), []);
});

test('授权状态读取：缺省一律关', () => {
    assert.deepEqual(toolAuthState(null, 'p1', 'query_x'),
        {globalOn: false, pluginAllow: false, toolOn: false, readOnlyOk: false});
    assert.deepEqual(toolAuthState({}, 'p1', 'query_x'),
        {globalOn: false, pluginAllow: false, toolOn: false, readOnlyOk: false});
    assert.deepEqual(toolAuthState(authOf(), 'p1', 'query_x'),
        {globalOn: true, pluginAllow: true, toolOn: true, readOnlyOk: false});
    // 插件存在但工具条目缺失
    assert.equal(toolAuthState(authOf(), 'p1', 'other').toolOn, false);
    // 插件不存在
    assert.equal(toolAuthState(authOf(), 'p9', 'query_x').pluginAllow, false);
});

test('下发判定：三层缺一不可', () => {
    reset();
    const tool = registerPluginTool('p1', 'P1', plain());
    // 全开
    assert.equal(toolIsAvailable(tool, authOf(), 'edit', false), true);
    assert.equal(toolIsAvailable(tool, authOf(), 'auto', false), true);
    assert.equal(toolIsAvailable(tool, authOf(), 'full', false), true);
    // 全局总闸关
    assert.equal(toolIsAvailable(tool, {...authOf(), enabled: false}, 'edit', false), false);
    // 插件级关
    assert.equal(toolIsAvailable(tool, authOf({plugins: {p1: {allow: false, tools: {query_x: {on: true}}}}}), 'edit', false), false);
    // 工具级关
    assert.equal(toolIsAvailable(tool, authOf({plugins: {p1: {allow: true, tools: {query_x: {on: false}}}}}), 'edit', false), false);
    // 计划模式恒不给
    assert.equal(toolIsAvailable(tool, authOf(), 'full', true), false);
});

test('下发判定：只读档需 readOnly 且用户显式开启', () => {
    reset();
    const rw = registerPluginTool('p1', 'P1', plain({name: 'write_thing'}));
    const ro = registerPluginTool('p1', 'P1', plain({name: 'query_x', readOnly: true}));

    // 普通工具：即使勾了只读档也不给
    const authRw = {enabled: true, plugins: {p1: {allow: true, tools: {write_thing: {on: true, readOnlyOk: true}}}}};
    assert.equal(toolIsAvailable(rw, authRw, 'read', false), false);
    assert.equal(toolIsAvailable(rw, authRw, 'edit', false), true);

    // 只读工具：未勾只读档 → read 不给、edit 给
    const authRoOff = {enabled: true, plugins: {p1: {allow: true, tools: {query_x: {on: true, readOnlyOk: false}}}}};
    assert.equal(toolIsAvailable(ro, authRoOff, 'read', false), false);
    assert.equal(toolIsAvailable(ro, authRoOff, 'edit', false), true);

    // 只读工具 + 用户勾了只读档 → read 给
    const authRoOn = {enabled: true, plugins: {p1: {allow: true, tools: {query_x: {on: true, readOnlyOk: true}}}}};
    assert.equal(toolIsAvailable(ro, authRoOn, 'read', false), true);
});

test('下发定义：形状对齐 AI_TOOL_DEFS，且按授权过滤', () => {
    reset();
    registerPluginTool('p1', 'P1', plain({name: 'a'}));
    registerPluginTool('p1', 'P1', plain({name: 'b'}));
    // 只授权 a（b 关闭），验证过滤按名字精确匹配
    const auth = {enabled: true, plugins: {p1: {allow: true, tools: {a: {on: true}, b: {on: false}}}}};
    const defs = authorizedPluginToolDefs(auth, 'edit', false);
    assert.equal(defs.length, 1);
    assert.deepEqual(Object.keys(defs[0]).sort(), ['description', 'name', 'parameters']);
    assert.equal(defs[0].name, 'plugin__p1__a');

    assert.deepEqual(authorizedPluginToolDefs(auth, 'edit', true), [], '计划模式不下发');
    assert.deepEqual(authorizedPluginToolDefs({enabled: false}, 'edit', false), [], '总闸关不下发');
    assert.deepEqual(authorizedPluginToolDefs(auth, 'read', false), [], '只读档默认不下发');
});
