// 插件自定义视图注册表护栏（cadt.registerViewer）：归一化 → 上限 → 模式串 →
// 归属匹配（格式 id / 扩展名两条路）→ 可用性判定 → 重载清空。
// 约束口径见 docs/unfinished-plans/plugin-extension-roadmap.md 2.2 节。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_VIEW_PRIORITY, MAX_VIEWERS_PER_PLUGIN, MAX_VIEWERS_TOTAL, MAX_VIEW_DOC_BYTES,
    clearPluginViewers, getPluginViewer, getPluginViewerByMode, getPluginViewers,
    isPluginViewMode, normalizePluginViewer, normalizeViewToken, pluginViewLabel, pluginViewMode,
    pluginViewOptions, pluginViewUnavailable, pluginViewerBlockedReason, registerPluginViewer,
    viewerIdFromMode, viewerMatches, viewersFor, viewMatchTokens,
} from '../../src/shell/plugin-viewers.js';

const mount = () => ({destroy() {}});
const plain = (over) => ({id: 'geo-map', label: '地图', formats: ['geojson'], mount, ...over});
const reset = () => clearPluginViewers();

test('模式串：plugin:<viewerId> 往返', () => {
    assert.equal(pluginViewMode('geo-map'), 'plugin:geo-map');
    assert.equal(isPluginViewMode('plugin:geo-map'), true);
    assert.equal(isPluginViewMode('geo-map'), false);
    assert.equal(isPluginViewMode('plugin:'), false, '空前缀不算插件模式');
    assert.equal(isPluginViewMode(null), false);
    assert.equal(viewerIdFromMode('plugin:geo-map'), 'geo-map');
    assert.equal(viewerIdFromMode('tree'), '');
});

test('归属 token 归一：去点、小写、去空白', () => {
    assert.equal(normalizeViewToken('.GeoJSON'), 'geojson');
    assert.equal(normalizeViewToken('  JSON '), 'json');
    assert.equal(normalizeViewToken(null), '');
});

test('归一化：默认值与字段透传', () => {
    const viewer = normalizePluginViewer('p1', 'P1', {id: 'geo-map', formats: ['.GeoJSON', 'geojson', 'topojson'], mount});
    assert.equal(viewer.pluginId, 'p1');
    assert.equal(viewer.pluginName, 'P1');
    assert.equal(viewer.id, 'geo-map');
    assert.equal(viewer.mode, 'plugin:geo-map');
    assert.equal(viewer.label, 'geo-map', '缺 label 时用 id');
    assert.equal(viewer.priority, DEFAULT_VIEW_PRIORITY);
    assert.deepEqual(viewer.formats, ['geojson', 'topojson'], '去重 + 归一');
    assert.equal(typeof viewer.mount, 'function');

    const sorted = normalizePluginViewer('p1', 'P1', plain({priority: 9999}));
    assert.equal(sorted.priority, 1000, '优先级钳到上限');
    const longLabel = normalizePluginViewer('p1', 'P1', plain({label: 'x'.repeat(80)}));
    assert.equal(longLabel.label.length, 40, 'label 截断');
});

test('归一化：非法声明抛错', () => {
    assert.throws(() => normalizePluginViewer('BAD', 'P', plain()), /插件 id 无效/);
    assert.throws(() => normalizePluginViewer('p1', 'P', 'nope'), /需要一个视图对象/);
    assert.throws(() => normalizePluginViewer('p1', 'P', plain({id: 'Geo Map'})), /id 无效/);
    assert.throws(() => normalizePluginViewer('p1', 'P', {id: 'v', formats: ['x']}), /缺少 mount/);
    assert.throws(() => normalizePluginViewer('p1', 'P', plain({formats: []})), /缺少 formats/);
    assert.throws(() => normalizePluginViewer('p1', 'P', plain({formats: ['x'.repeat(40)]})), /formats 项过长/);
    assert.throws(() => normalizePluginViewer('p1', 'P', plain({formats: Array.from({length: 40}, (_, i) => 'f' + i)})), /超过 32 项/);
});

test('注册：唯一 id 与上限', () => {
    reset();
    registerPluginViewer('p1', 'P1', plain());
    assert.throws(() => registerPluginViewer('p2', 'P2', plain()), /已注册/, 'id 全局唯一（模式串不能撞）');

    reset();
    for (let i = 0; i < MAX_VIEWERS_PER_PLUGIN; i += 1) {
        registerPluginViewer('p1', 'P1', plain({id: 'v' + i}));
    }
    assert.equal(getPluginViewers().length, MAX_VIEWERS_PER_PLUGIN);
    assert.throws(() => registerPluginViewer('p1', 'P1', plain({id: 'overflow'})), /单插件视图数超过上限/);
    // 另一个插件不受影响
    assert.ok(registerPluginViewer('p2', 'P2', plain({id: 'other'})));

    reset();
    for (let i = 0; i < MAX_VIEWERS_TOTAL; i += 1) {
        registerPluginViewer('p' + i, 'P', plain({id: 'v' + i}));
    }
    assert.throws(() => registerPluginViewer('pover', 'P', plain({id: 'last'})), /总数超过上限/);
});

test('匹配：格式 id 与扩展名两条路都算命中', () => {
    reset();
    // 内置 text 格式吃掉 .geojson 探测结果：只比格式 id 就匹配不上，扩展名这条路必须生效
    const textFormat = {id: 'text', extensions: ['txt', 'log']};
    const geo = registerPluginViewer('p1', 'P1', plain());
    assert.equal(viewerMatches(geo, textFormat, {name: 'roads.geojson'}), true);
    assert.equal(viewerMatches(geo, textFormat, {name: 'notes.txt'}), false);

    // 插件用 registerFormat 注册了 geojson 时按格式 id 命中（doc 还在加载，没有文件名）
    const geoFormat = {id: 'geojson', extensions: ['geojson']};
    assert.equal(viewerMatches(geo, geoFormat, null), true);
    assert.equal(viewerMatches(geo, {id: 'json', extensions: ['json']}, {name: 'a.json'}), false);
    assert.equal(viewerMatches(null, textFormat, {name: 'roads.geojson'}), false);
});

test('匹配 token 集合：格式 id + 格式扩展名 + 文件名扩展名', () => {
    const tokens = viewMatchTokens({id: 'text', extensions: ['TXT', '.log']}, {name: 'C:\\data\\a.GeoJSON'});
    assert.deepEqual([...tokens].sort(), ['geojson', 'log', 'text', 'txt']);
});

test('视图清单：按 priority 降序，同优先级按 label', () => {
    reset();
    registerPluginViewer('p1', 'P1', plain({id: 'low', label: 'B 低', priority: 1}));
    registerPluginViewer('p1', 'P1', plain({id: 'high', label: '高', priority: 99}));
    registerPluginViewer('p1', 'P1', plain({id: 'mid', label: 'A 中', priority: 5}));
    registerPluginViewer('p2', 'P2', plain({id: 'other', formats: ['csv'], priority: 100}));

    const order = viewersFor({id: 'text', extensions: []}, {name: 'x.geojson'}).map((v) => v.id);
    assert.deepEqual(order, ['high', 'mid', 'low']);

    const options = pluginViewOptions({id: 'text', extensions: []}, {name: 'x.geojson'});
    assert.deepEqual(options, [['plugin:high', '高'], ['plugin:mid', 'A 中'], ['plugin:low', 'B 低']]);
    // 只归 csv 的视图不会出现在 geojson 文档的清单里
    assert.deepEqual(pluginViewOptions({id: 'csv'}, {name: 'a.csv'}), [['plugin:other', '地图']]);
});

test('可用性判定：缺失 / 二进制 / 大文件 / 超限 / 归属不符', () => {
    reset();
    registerPluginViewer('p1', 'P1', plain());
    const textFormat = {id: 'text', extensions: []};

    assert.equal(pluginViewUnavailable({format: textFormat, name: 'a.geojson'}, 'plugin:geo-map'), '');
    assert.match(pluginViewUnavailable({format: textFormat, name: 'a.geojson'}, 'plugin:gone'), /未注册/);
    assert.equal(pluginViewUnavailable({format: textFormat, name: 'a.geojson'}, 'tree'), '该插件视图未注册（插件已禁用或卸载）');

    assert.match(pluginViewUnavailable({binary: true, name: 'a.geojson'}, 'plugin:geo-map'), /二进制/);
    assert.match(pluginViewUnavailable({format: {id: 'bytes'}, name: 'a.geojson'}, 'plugin:geo-map'), /二进制/);
    assert.match(pluginViewUnavailable({large: true, format: textFormat, name: 'a.geojson'}, 'plugin:geo-map'), /大文件/);
    assert.match(
        pluginViewUnavailable({size: MAX_VIEW_DOC_BYTES + 1, format: textFormat, name: 'a.geojson'}, 'plugin:geo-map'),
        /超过 10 MB/);
    assert.equal(
        pluginViewUnavailable({size: MAX_VIEW_DOC_BYTES, format: textFormat, name: 'a.geojson'}, 'plugin:geo-map'), '',
        '正好 10 MB 仍然放行');
    assert.match(pluginViewUnavailable({format: {id: 'json'}, name: 'a.json'}, 'plugin:geo-map'), /不适用于当前文件/);
    assert.match(pluginViewUnavailable(null, 'plugin:geo-map'), /未打开文件/);
    assert.equal(pluginViewerBlockedReason(null, {format: textFormat, name: 'a.geojson'}), '');
});

test('查找与标签：by id / by mode', () => {
    reset();
    const viewer = registerPluginViewer('p1', 'P1', plain());
    assert.equal(getPluginViewer('geo-map'), viewer);
    assert.equal(getPluginViewerByMode('plugin:geo-map'), viewer);
    assert.equal(getPluginViewerByMode('tree'), null);
    assert.equal(pluginViewLabel('plugin:geo-map'), '地图');
    assert.equal(pluginViewLabel('plugin:missing'), '插件视图');
});

test('清空：重载即消失（内存态，不落盘）', () => {
    reset();
    registerPluginViewer('p1', 'P1', plain());
    assert.equal(getPluginViewers().length, 1);
    clearPluginViewers();
    assert.deepEqual(getPluginViewers(), []);
    assert.deepEqual(pluginViewOptions({id: 'text'}, {name: 'a.geojson'}), []);
});
