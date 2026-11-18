// 标题栏运行配置 widget 的数据模型测试：runConfigMenuModel 组装下拉面板所需的三段数据。
// 纯函数本体在 src/terminal/run.js（activeRunConfig / recentConfigs / resolveRunWidgetLabel），
// 这里验证 shell 模块对 widget 标签 / 最近的配置 / 所有配置 的组装口径。
// 用法：npm test（package.json 的 test 脚本里显式列出本文件）
import test from 'node:test';
import assert from 'node:assert/strict';

import {runConfigMenuModel} from '../../src/shell/titlebar-run-config.js';

test('runConfigMenuModel：无配置时标签落到当前文件名，三段数据为空', () => {
    const model = runConfigMenuModel({runProfiles: [], runActiveProfile: ''}, 'main.py');
    assert.equal(model.active, null);
    assert.equal(model.label, 'main.py');
    assert.deepEqual(model.recents, []);
    assert.deepEqual(model.all, []);
});

test('runConfigMenuModel：激活绑定配置时标签用配置名，最近配置按 lastUsedAt 排序', () => {
    const settings = {
        runActiveProfile: 'b',
        runProfiles: [
            {id: 'a', name: '旧预设', lang: 'python', lastUsedAt: 0},
            {id: 'b', name: 'run', file: 'D:/w/main.py', lastUsedAt: 100},
            {id: 'c', name: 'tests', file: 'D:/w/test.go', lastUsedAt: 200},
        ],
    };
    const model = runConfigMenuModel(settings, 'notes.md');
    assert.equal(model.active.id, 'b');
    assert.equal(model.label, 'run');
    assert.deepEqual(model.recents.map((p) => p.id), ['c', 'b'], '旧预设 lastUsedAt=0 不进最近');
    assert.equal(model.all.length, 3);
});

test('runConfigMenuModel：settings 缺字段时不抛错（保守归一）', () => {
    const model = runConfigMenuModel({}, null);
    assert.equal(model.active, null);
    assert.equal(model.label, '当前文件');
    assert.deepEqual(model.recents, []);
    assert.deepEqual(model.all, []);
});
