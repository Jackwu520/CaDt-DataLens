// 插件专属设置面板注册表护栏（cadt.registerSettingsPanel）：注册 → 列举/按插件筛选 →
// pane key 生成 → 重载清空 → 非法注册报错。面板内容渲染由宿主注入 ctx，本模块只管声明。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    clearPluginSettingsPanels, getPluginSettingsPanel, getPluginSettingsPanels,
    panelPaneKey, panelsOfPlugin, registerPluginSettingsPanel,
} from '../../src/shell/plugin-settings-panels.js';

test('面板注册：pane key + 列举 + 按插件筛选', () => {
    clearPluginSettingsPanels();
    registerPluginSettingsPanel('p1', {id: 'main', label: '主面板', render() {}});
    registerPluginSettingsPanel('p1', {id: 'logs', render() {}});
    registerPluginSettingsPanel('p2', {id: 'main', label: '另一个', render() {}});

    assert.equal(panelPaneKey('p1', 'main'), 'plugin-p1-main');
    assert.equal(getPluginSettingsPanels().length, 3);
    assert.equal(panelsOfPlugin('p1').length, 2);
    assert.equal(panelsOfPlugin('p2').length, 1);
    const found = getPluginSettingsPanel('plugin-p1-main');
    assert.equal(found.pluginId, 'p1');
    assert.equal(found.label, '主面板');
    assert.equal(typeof found.render, 'function');
    assert.equal(getPluginSettingsPanel('plugin-p1-logs').label, 'logs', 'label 缺省退回 id');
});

test('面板注册：重载清空', () => {
    clearPluginSettingsPanels();
    registerPluginSettingsPanel('p', {id: 'main', render() {}});
    assert.equal(getPluginSettingsPanels().length, 1);
    clearPluginSettingsPanels();
    assert.equal(getPluginSettingsPanels().length, 0);
    assert.equal(getPluginSettingsPanel('plugin-p-main'), null);
});

test('面板注册：非法声明报错', () => {
    clearPluginSettingsPanels();
    assert.throws(() => registerPluginSettingsPanel('p', {id: 'BAD', render() {}}), /id 无效/);
    assert.throws(() => registerPluginSettingsPanel('p', {id: 'main'}), /缺少 render/);
    assert.throws(() => registerPluginSettingsPanel('p', null), /需要一个设置面板对象/);
    registerPluginSettingsPanel('p', {id: 'main', render() {}});
    assert.throws(() => registerPluginSettingsPanel('p', {id: 'main', render() {}}), /已注册/);
    assert.equal(getPluginSettingsPanels().length, 1);
});

test('pane key 只含 [a-z0-9-]，避免 CSS 选择器转义', () => {
    const key = panelPaneKey('my-plugin', 'settings');
    assert.match(key, /^[a-z0-9-]+$/);
});
