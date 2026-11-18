// ai-wipeguard.test.mjs：工作区破坏防护检测控制器的纯函数与接线护栏。
// 哈希向量与 Go 侧 TestWorkspaceKey 共享（internal/wipeguard/fingerprint_test.go），防两端漂移。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
    WIPEGUARD_WINDOW_MS,
    WIPEGUARD_DELETE_THRESHOLD,
    WIPEGUARD_FINGERPRINT_DEBOUNCE_MS,
    wipeGuardSkipPath,
    registerDeleteEvents,
    shouldAlarmFromWatch,
    normalizeWsKey,
    createAIWipeguard,
} from '../../src/ai/ai-wipeguard.js';

// ---- 哈希口径（与 Go 共享向量）----

test('normalizeWsKey：与后端 WorkspaceKey 的归一化语义一致', () => {
    assert.equal(normalizeWsKey('D:\\OraSkyC\\Project\\CandySweet\\CaDt-DataLens\\'), 'd:/oraskyc/project/candysweet/cadt-datalens');
    assert.equal(normalizeWsKey('d:/oraskyc/project/candysweet/cadt-datalens'), 'd:/oraskyc/project/candysweet/cadt-datalens');
    assert.equal(normalizeWsKey(''), '');
});

test('共享测试向量：归一化 key 的 sha256 前 8 hex 与 Go TestWorkspaceKey 相同', () => {
    const key = normalizeWsKey('D:\\OraSkyC\\Project\\CandySweet\\CaDt-DataLens\\');
    assert.equal(createHash('sha256').update(key).digest('hex').slice(0, 8), '35dc7bd8');
    assert.equal(createHash('sha256').update('').digest('hex').slice(0, 8), 'e3b0c442');
});

// ---- watcher 计数 ----

test('wipeGuardSkipPath：忽略表顶层子树不计入（与 Go skipFingerprintDir 同口径）', () => {
    for (const p of ['.git/HEAD', '.git\\objects\\ab\\cd', '.cadt/tmp/x.txt', 'node_modules/pkg/i.js', '.cache/d']) {
        assert.ok(wipeGuardSkipPath(p), `${p} 应被排除`);
    }
    for (const p of ['frontend/src/ai/ai-panel.js', 'README.md', 'docs/a.md', 'internal/x/y.go']) {
        assert.ok(!wipeGuardSkipPath(p), `${p} 不应被排除`);
    }
    assert.ok(wipeGuardSkipPath(''), '空路径排除');
});

test('wipeGuardSkipPath：构建产物目录（顶层与二级）不计入——vite/wails 清产物是合法 churn', () => {
    for (const p of ['dist/index.js', 'build/bin/app.exe', 'frontend/dist/assets/x.js', 'tools/bin/a']) {
        assert.ok(wipeGuardSkipPath(p), `${p} 应被排除`);
    }
    // 三级及以下不排除：源码树深处的同名目录不算产物
    assert.ok(!wipeGuardSkipPath('src/plugins/dist-helper/x.js'), '源码树深处不排除');
    assert.ok(!wipeGuardSkipPath('src/a/building/x.js'), '前缀相似目录不排除');
});

test('wipeGuardSkipPath：临时/机械文件不计入——原子写与补丁的 temp「消失」是写入正常半程', () => {
    for (const p of [
        'frontend/src/terminal/terminal-sessions.js.tmp.29772.db48c7c22105', // atomfile 变体
        'docs/plugins/.cadt-patch-3970327745.tmp',                          // 补丁写入 temp
        'frontend/.cadt-patch-173752754.tmp',
        'src/a/keep.txt.1234.5678.tmp',                                     // atomfile 原生命名
        'ai-sessions.lock',                                                 // 跨进程锁
        '.cadt-workspace.gate',
    ]) {
        assert.ok(wipeGuardSkipPath(p), `${p} 应被排除`);
    }
    for (const p of ['frontend/src/terminal/terminal-sessions.js', 'docs/plugins/README.md', 'a.tmpx', 'lockfile']) {
        assert.ok(!wipeGuardSkipPath(p), `${p} 不应被排除`);
    }
});

test('registerDeleteEvents：同一路径窗口内去重——rename 的多条 action 不重复计数', () => {
    const now = 1000;
    const batch = [
        'frontend/src/terminal/terminal-sessions.js.tmp.29772.x',
        'frontend/src/terminal/terminal-sessions.js.tmp.29772.x',   // temp 重复
        'frontend/src/terminal',
        'frontend/src/terminal/terminal-sessions.js',
        'frontend/src/terminal/terminal-sessions.js',               // 目标重复
        'frontend/src/terminal',                                     // 目录重复
    ];
    const win = registerDeleteEvents(null, batch, now);
    // temp 被形态排除；目标与目录各计一次
    assert.deepEqual(win.events.map((e) => e.path), [
        'frontend/src/terminal',
        'frontend/src/terminal/terminal-sessions.js',
    ]);
    // 跨批次重复也去重（窗口滑动前）
    const win2 = registerDeleteEvents(win, ['frontend/src/terminal/terminal-sessions.js'], now + 100);
    assert.equal(win2.events.length, 2);
});

test('registerDeleteEvents：并入窗口、丢弃窗外旧条目、排除子树', () => {
    const now = 10000;
    let win = registerDeleteEvents(null, ['a.js', '.git/HEAD', 'b.js'], now);
    assert.equal(win.events.length, 2);
    win = registerDeleteEvents(win, ['c.js'], now + WIPEGUARD_WINDOW_MS - 100);
    assert.equal(win.events.length, 3);
    // 第一批已出窗（窗口滑动）
    win = registerDeleteEvents(win, [], now + WIPEGUARD_WINDOW_MS + 1);
    assert.deepEqual(win.events.map((e) => e.path), ['c.js']);
    // 纯函数：不改动入参
    const frozen = {events: [{at: 0, path: 'x'}]};
    registerDeleteEvents(frozen, ['y'], now);
    assert.equal(frozen.events.length, 1);
});

test('shouldAlarmFromWatch：删除数到阈值即 critical，静默时返回 null', () => {
    const now = 1000;
    const paths = Array.from({length: WIPEGUARD_DELETE_THRESHOLD}, (_, i) => `f${i}.js`);
    const win = registerDeleteEvents(null, paths, now);
    const verdict = shouldAlarmFromWatch(win, now);
    assert.equal(verdict.level, 'critical');
    assert.ok(verdict.reason.includes('40 个文件'));
    const quiet = registerDeleteEvents(null, ['only-one.js'], now);
    assert.equal(shouldAlarmFromWatch(quiet, now), null);
});

test('shouldAlarmFromWatch：排除子树后不够阈值不告警（git gc / npm churn）', () => {
    const now = 1000;
    const paths = Array.from({length: WIPEGUARD_DELETE_THRESHOLD + 10}, (_, i) => `node_modules/m${i}/x.js`);
    const win = registerDeleteEvents(null, paths, now);
    assert.equal(shouldAlarmFromWatch(win, now), null);
});

// ---- 控制器 ----

function fakeBackend() {
    const calls = {alarms: [], compares: [], configs: [], fingerprints: 0};
    return {
        calls,
        async WipeGuardConfigure(s) { calls.configs.push(s); return s; },
        async WipeGuardFingerprint() { calls.fingerprints++; return {rootEntries: 10, depth1Dirs: 5, markers: {'.git': true}, fileCount: 100, sampled: false}; },
        async WipeGuardCompare(before, after) {
            calls.compares.push([before, after]);
            if (after.rootEntries <= 1 && before.rootEntries >= 5) return {level: 'critical', reason: '整仓顶层条目被清空'};
            return {level: '', reason: ''};
        },
        async WipeGuardAlarm(level, reason, detail) { calls.alarms.push({level, reason, detail}); },
        async WipeGuardSnapshot() { return {mode: 'git', name: 'x.tar', bytes: 1, files: -1}; },
    };
}

function makeController(overrides = {}) {
    const backend = fakeBackend();
    const fired = {critical: [], warn: []};
    const ctrl = createAIWipeguard({
        getBackend: () => backend,
        getWsRoot: () => 'D:/demo',
        getSettings: () => ({wipeGuard: {enabled: true, snapshots: true}}),
        isAIActive: () => false,
        onCritical: (info) => fired.critical.push(info),
        onWarn: (info) => fired.warn.push(info),
        ...overrides,
    });
    return {ctrl, backend, fired};
}

test('控制器：watcher 判定 critical 且 AI 活跃 → 熔断 + onCritical；下一回合解除', async () => {
    const {ctrl, backend, fired} = makeController({isAIActive: () => true});
    const paths = Array.from({length: WIPEGUARD_DELETE_THRESHOLD}, (_, i) => `f${i}.js`);
    ctrl.handleWorkspaceEvent({root: 'D:/demo', removed: paths, overflow: false});
    assert.equal(fired.critical.length, 1);
    assert.equal(backend.calls.alarms.length, 1);
    assert.equal(backend.calls.alarms[0].level, 'critical');
    assert.ok(ctrl.isWriteBlocked(), 'AI 活跃时应熔断');
    ctrl.clearBlocked();
    assert.ok(!ctrl.isWriteBlocked(), '下一回合解除');
});

test('控制器：critical 但会话空闲 → 只提醒不熔断', async () => {
    const {ctrl, fired} = makeController({isAIActive: () => false});
    const paths = Array.from({length: WIPEGUARD_DELETE_THRESHOLD}, (_, i) => `f${i}.js`);
    ctrl.handleWorkspaceEvent({root: 'D:/demo', removed: paths, overflow: false});
    assert.equal(fired.critical.length, 1);
    assert.equal(fired.critical[0].aiActive, false);
    assert.ok(!ctrl.isWriteBlocked(), '空闲时不熔断（用户手动批量删除不误伤）');
});

test('控制器：总开关关闭时不消费事件、不取指纹', async () => {
    const {ctrl, backend} = makeController({
        getSettings: () => ({wipeGuard: {enabled: false}}),
    });
    const paths = Array.from({length: WIPEGUARD_DELETE_THRESHOLD + 5}, (_, i) => `f${i}.js`);
    ctrl.handleWorkspaceEvent({root: 'D:/demo', removed: paths, overflow: false});
    assert.equal(backend.calls.alarms.length, 0);
    assert.equal(await ctrl.preCommand('D:/demo'), null);
    assert.equal(backend.calls.fingerprints, 0);
});

test('控制器：preCommand/postCommand 前后指纹对比走 Go 判定（阈值不复制到前端）', async () => {
    const {ctrl, backend} = makeController();
    const before = await ctrl.preCommand('D:/demo');
    assert.ok(before, '应取到基线指纹');
    // 模拟命令后整仓清空
    backend.WipeGuardFingerprint = async () => ({rootEntries: 1, depth1Dirs: 0, markers: {}, fileCount: 0, sampled: false});
    await ctrl.postCommand('D:/demo', before);
    assert.equal(backend.calls.compares.length, 1);
    assert.equal(backend.calls.alarms.length, 1);
    assert.equal(backend.calls.alarms[0].level, 'critical');
});

test('控制器：切工作区重置窗口与基线（跨工作区不误判）', async () => {
    const {ctrl} = makeController();
    const paths = Array.from({length: WIPEGUARD_DELETE_THRESHOLD - 1}, (_, i) => `f${i}.js`);
    ctrl.handleWorkspaceEvent({root: 'D:/demo', removed: paths, overflow: false});
    // 换工作区：上一窗口的 39 条删除不应带入
    ctrl.handleWorkspaceEvent({root: 'E:/other', removed: ['one.js'], overflow: false});
    assert.equal(ctrl.handleWorkspaceEvent({root: 'E:/other', removed: ['two.js'], overflow: false}), undefined);
    const {backend} = {backend: null};
    void backend;
});

test('控制器：配置同步（开关对象原样发 Go）', async () => {
    const {ctrl, backend} = makeController();
    await ctrl.syncConfig();
    assert.equal(backend.calls.configs.length, 1);
    assert.deepEqual(backend.calls.configs[0], {enabled: true, snapshots: true, backupRoot: ''});
});

test('控制器：overflow 触发指纹重扫兜底', async () => {
    const {ctrl, backend} = makeController();
    ctrl.handleWorkspaceEvent({root: 'D:/demo', paths: [], removed: [], overflow: true});
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(backend.calls.fingerprints >= 1, 'overflow 应触发指纹重扫');
});

test('handleWorkspaceEvent：只计 removed 事件——added/modified（回灌/写入）不计数', () => {
    const {ctrl, backend, fired} = makeController({isAIActive: () => true});
    // 补丁回灌 70 个文件：paths 全量（added/modified 为主），removed 为空 → 不得告警
    const paths = Array.from({length: 70}, (_, i) => `src/f${i}.js`);
    ctrl.handleWorkspaceEvent({root: 'D:/demo', paths, removed: [], overflow: false});
    assert.equal(backend.calls.alarms.length, 0);
    assert.equal(fired.critical.length, 0);
    assert.ok(!ctrl.isWriteBlocked('D:/demo'), '回灌不熔断');
    // 同窗口真删除 41 个 → 立即告警
    const gone = Array.from({length: 41}, (_, i) => `src/gone${i}.js`);
    ctrl.handleWorkspaceEvent({root: 'D:/demo', removed: gone, overflow: false});
    assert.equal(backend.calls.alarms.length, 1);
});

test('熔断与止血按工作区收窄：本工作区拦，其它工作区不牵连', async () => {
    // fireAlarm 有 3s 告警去抖：用假时钟跨过去，否则第二次告警被早退吞掉
    const realNow = Date.now;
    let fake = 1000000;
    Date.now = () => fake;
    try {
        let activeRoot = '';
        const {ctrl} = makeController({isAIActive: (root) => root === activeRoot});
        activeRoot = 'D:/demo';
        ctrl.handleWorkspaceEvent({root: 'D:/demo', removed: Array.from({length: 41}, (_, i) => 'f' + i + '.js'), overflow: false});
        assert.ok(ctrl.isWriteBlocked('D:/demo'), '被告警的工作区拦');
        assert.ok(!ctrl.isWriteBlocked('E:/other'), '其它工作区不牵连');
        // 跨过去抖窗口后第二次告警：AI 已不在本工作区活跃 → 本次不新增判停，
        // 但第一次的熔断不撤销（破坏还在，持续到下回合 clearBlocked）
        fake += WIPEGUARD_FINGERPRINT_DEBOUNCE_MS + 100;
        activeRoot = 'E:/other';
        ctrl.handleWorkspaceEvent({root: 'D:/demo', removed: Array.from({length: 41}, (_, i) => 'g' + i + '.js'), overflow: false});
        assert.ok(ctrl.isWriteBlocked('D:/demo'), '已有熔断不被空闲告警撤销');
        assert.ok(!ctrl.isWriteBlocked('E:/other'), '其它工作区始终不牵连');
    } finally {
        Date.now = realNow;
    }
});
