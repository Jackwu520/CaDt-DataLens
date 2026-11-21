// event-scope / app-events 纯逻辑测试：范围表完整性与过滤语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import {EVENT_SCOPES, scopeOf, pathKey, acceptWorkspace} from '../../src/core/event-scope.js';
import {createAppEventBridge} from '../../src/core/app-events.js';

test('范围表：Go 发射的事件全部有分类', () => {
    const expected = [
        'ai-chunk', 'ai-think', 'ai-toolcall', 'ai-done', 'ai-error', 'ai-retry',
        'ai-param-adjust', 'ai-queue',
        'sched-fire', 'schedules-changed', 'mcp-tools-changed', 'mcp-status-changed', 'settings-changed',
        'ai-timer-fired', 'ai-timer-stopped',
        'workspace-changed', 'resource-changed',
        'confirm-close', 'open-targets', 'app-open-settings', 'app-open-memo', 'app-open-ai-session', 'ai-notify-activate',
        'term-out', 'term-exit', 'cmd-out', 'cmd-exit', 'run-out', 'run-exit',
        'browser-nav', 'browser-title', 'browser-error', 'reading-search-progress',
    ];
    for (const name of expected) assert.ok(EVENT_SCOPES[name], '缺分类：' + name);
    assert.equal(scopeOf('not-registered'), 'app');
});

test('pathKey / acceptWorkspace：分隔符与大小写归一', () => {
    assert.equal(pathKey('D:\\Work\\Proj\\'), 'd:/work/proj');
    assert.equal(pathKey('/home/u/proj/'), '/home/u/proj');
    assert.equal(acceptWorkspace({root: 'D:\\Work\\Proj'}, 'd:/work/proj'), true);
    assert.equal(acceptWorkspace({root: 'D:/other'}, 'd:/work/proj'), false);
    assert.equal(acceptWorkspace({}, 'd:/work/proj'), false);
    assert.equal(acceptWorkspace({root: 'd:/work/proj'}, ''), false);
});

function fakeRt() {
    const subs = new Map();
    return {
        subs,
        EventsOn(name, cb) {
            subs.set(name, cb);
            return () => subs.delete(name);
        },
        emit(name, payload, ev) {
            const cb = subs.get(name);
            if (cb) cb(payload, ev);
        },
    };
}

test('onWindow：只接受 sender === 本窗口；无 sender 丢弃', () => {
    const rt = fakeRt();
    const bridge = createAppEventBridge({rt, windowName: 'main'});
    const seen = [];
    bridge.onWindow('confirm-close', (p) => seen.push(p));
    rt.emit('confirm-close', {dirty: true}, {sender: 'float'});
    rt.emit('confirm-close', {dirty: false}, {sender: 'main'});
    rt.emit('confirm-close', {dirty: true}, undefined);
    assert.deepEqual(seen, [{dirty: false}]);
});

test('onWindow：无窗口名（mock）直通', () => {
    const rt = fakeRt();
    const bridge = createAppEventBridge({rt, windowName: null});
    const seen = [];
    bridge.onWindow('open-targets', (p) => seen.push(p));
    rt.emit('open-targets', ['a']);
    assert.deepEqual(seen, [['a']]);
});

test('onWorkspace：只接受本窗口工作区的 root', () => {
    const rt = fakeRt();
    const bridge = createAppEventBridge({rt, windowName: 'main'});
    const seen = [];
    bridge.onWorkspace('workspace-changed', () => 'D:/ws', (p) => seen.push(p.root));
    rt.emit('workspace-changed', {root: 'D:/other'});
    rt.emit('workspace-changed', {root: 'd:\\ws'});
    assert.deepEqual(seen, ['d:\\ws']);
});

test('onOwned：谓词命中才分发，解绑后不再收到', () => {
    const rt = fakeRt();
    const bridge = createAppEventBridge({rt, windowName: 'main'});
    const seen = [];
    const off = bridge.onOwned('cmd-out', (p) => p.id === 'mine', (p) => seen.push(p.data));
    rt.emit('cmd-out', {id: 'other', data: 'x'});
    rt.emit('cmd-out', {id: 'mine', data: 'y'});
    off();
    rt.emit('cmd-out', {id: 'mine', data: 'z'});
    assert.deepEqual(seen, ['y']);
});
