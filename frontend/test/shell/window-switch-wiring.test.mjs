// 窗口切换器接线护栏（v3 一进程多窗口）：
// quick-switch「窗口」层 ↔ Go 窗口注册表（WindowList / WindowFocusByName）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const quickSrc = read('../../src/shell/quick-switch.js');
const mainSrc = read('../../src/main.js');
const scopeSrc = read('../../src/core/event-scope.js');

test('quick-switch 有「窗口」层：入口、子项来源与动态刷新', () => {
    assert.match(quickSrc, /\{label: '窗口', enter: 'windows'\}/);
    assert.match(quickSrc, /level === 'windows'/);
    assert.match(quickSrc, /deps\.windowSwitchEntries\(\)/);
    assert.match(quickSrc, /refreshWindowSwitchEntries/);
});

test('main.js 维护窗口列表缓存并按 target 跳转', () => {
    assert.match(mainSrc, /async function refreshWindowSwitchEntries/);
    assert.match(mainSrc, /backend\.WindowList/);
    assert.match(mainSrc, /backend\.WindowFocusByName/);
    assert.match(mainSrc, /filter\(\(w\) => w && !w\.self\)/, '不列自己');
});

test('全局热键的目标事件已登记（app-open-terminal）', () => {
    assert.match(mainSrc, /onWindow\('app-open-terminal'/);
    assert.match(scopeSrc, /'app-open-terminal': 'window'/);
});
