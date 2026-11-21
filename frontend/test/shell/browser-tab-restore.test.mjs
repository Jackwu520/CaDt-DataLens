// browser-tab-restore.test.mjs：个人浏览器标签页的关闭保存与启动恢复。
//
// 覆盖（docs/finished-plans/browser-tab-restore.md §7）：
//   · 地址列表归一化 / 序列化往返 / 坏数据容错
//   · owner 租约：无 owner 获取并恢复、未过期跳过、过期接管、释放后他人可接管
//   · 写权判据：只有持有过个人浏览器实例的窗口才写 key（其它窗口退出不覆盖）
//   · 开 / 导航 / 关生命周期与退出兜底冲刷；悬浮窗不写
//   · 接线护栏：main.js getter 注入、browser-nav 通知、bridge-ui 恢复调用点、
//     editor-groups 关标签通知点必须存在（参照 session-restore.test.mjs 的护栏写法）
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {
    BROWSER_TABS_KEY,
    BROWSER_TABS_LIMIT,
    BROWSER_TABS_OWNER_KEY,
    PERSONAL_BROWSER_ID,
    createBrowserTabRestore,
    leaseAlive,
    normalizeBrowserUrls,
    parseBrowserUrls,
    serializeBrowserTabs,
} from '../../src/shell/browser-tab-restore.js';

const src = (rel) => readFileSync(fileURLToPath(new URL('../../src/' + rel, import.meta.url)), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const BROWSER_SAVE_WAIT_MS = 800; // 防抖 500ms + 余量（重载机器上也不 flaky）

function makeStore() {
    const m = new Map();
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
        _map: m,
    };
}

// 每个模块实例挂在自己的 window 桩上，pagehide 监听可手动触发
function makeMod(store, {backend, open} = {}) {
    const listeners = {};
    globalThis.window = {
        __aiFloatWindow: false,
        addEventListener(type, fn) { listeners[type] = fn; },
    };
    globalThis.localStorage = store;
    const opens = [];
    const logs = [];
    const mod = createBrowserTabRestore({
        get backend() { return backend; },
        get logFrontend() { return (level, msg) => logs.push([level, msg]); },
        // open: null 表示组合根未接线（不是用默认记录器）
        get openBrowserTab() { return open === undefined ? (url, profileKey, opts) => opens.push([url, profileKey, opts]) : open; },
    });
    return {mod, opens, logs, listeners};
}

function savedUrls(store) {
    return parseBrowserUrls(store.getItem(BROWSER_TABS_KEY));
}

// ---- 纯函数 ----

test('归一化：trim、滤空白与 about:blank、去重保序、截断上限', () => {
    assert.deepEqual(
        normalizeBrowserUrls([' https://a.example ', '', '  ', 'about:blank', 'https://a.example', 'https://b.example']),
        ['https://a.example', 'https://b.example'],
    );
    const many = Array.from({length: 30}, (_, i) => 'https://x' + i + '.example');
    const out = normalizeBrowserUrls(many);
    assert.equal(out.length, BROWSER_TABS_LIMIT);
    assert.deepEqual(out, many.slice(0, BROWSER_TABS_LIMIT));
    assert.deepEqual(normalizeBrowserUrls('不是数组'), []);
    assert.deepEqual(normalizeBrowserUrls(null), []);
});

test('序列化往返；坏数据一律当空列表', () => {
    const urls = ['https://a.example', 'file:///D:/docs/a.html'];
    assert.deepEqual(parseBrowserUrls(serializeBrowserTabs(urls)), urls);
    const snap = JSON.parse(serializeBrowserTabs(urls));
    assert.ok(Number(snap.savedAt) > 0, '快照带 savedAt');
    assert.deepEqual(parseBrowserUrls('不是 JSON'), []);
    assert.deepEqual(parseBrowserUrls(''), []);
    assert.deepEqual(parseBrowserUrls('null'), []);
    assert.deepEqual(parseBrowserUrls('"字符串"'), []);
    assert.deepEqual(parseBrowserUrls('[1,2]'), [], '数组不是合法快照形状');
    assert.deepEqual(parseBrowserUrls(JSON.stringify({urls: [42, null]})), [], '非字符串条目被滤掉');
});

test('owner 租约存活判定：缺失 / 过期 / 未来时间戳都算不存活', () => {
    const now = 1000000;
    assert.equal(leaseAlive(null, now), false);
    assert.equal(leaseAlive({}, now), false);
    assert.equal(leaseAlive({id: 'w1'}, now), false);
    assert.equal(leaseAlive({id: 'w1', ts: now - 14999}, now), true, 'TTL 内存活');
    assert.equal(leaseAlive({id: 'w1', ts: now - 15000}, now), false, '恰好 TTL 过期');
    assert.equal(leaseAlive({id: 'w1', ts: now + 1000}, now), false, '时钟回拨的未来 ts 视为过期');
});

// ---- 写权判据与生命周期 ----

test('只有持有实例的窗口写 key：B 窗口退出不覆盖 A 的地址', async () => {
    const store = makeStore();
    const a = makeMod(store);
    a.mod.notePersonalOpened('https://a.example');
    a.listeners.pagehide(); // 退出兜底立即冲刷（不等防抖）
    assert.deepEqual(savedUrls(store), ['https://a.example'], '持有窗口退出写入');

    const b = makeMod(store); // B 从未持有个人浏览器实例
    b.listeners.pagehide();
    assert.deepEqual(savedUrls(store), ['https://a.example'], '未持有窗口退出不能抹掉 A 的地址');
});

test('悬浮窗共享 localStorage：不写快照也不覆盖', async () => {
    const store = makeStore();
    const mod = makeMod(store);
    globalThis.window.__aiFloatWindow = true; // 创建后翻转成悬浮窗语境
    mod.mod.notePersonalOpened('https://float.example');
    await wait(BROWSER_SAVE_WAIT_MS);
    assert.deepEqual(savedUrls(store), [], '悬浮窗的导航通知不落盘');
    mod.listeners.pagehide();
    assert.deepEqual(savedUrls(store), [], '悬浮窗退出兜底也不写');
});

test('开 / 导航 / 关生命周期：关标签立即清空并释放自己的租约', async () => {
    const store = makeStore();
    const mod = makeMod(store);
    try {
        mod.mod.notePersonalOpened('https://a.example');
        mod.mod.notePersonalNav('https://a.example'); // 同地址 nav 不重复写
        mod.mod.notePersonalNav('https://b.example');
        await wait(BROWSER_SAVE_WAIT_MS);
        assert.deepEqual(savedUrls(store), ['https://b.example'], '导航更新地址');

        // 他人（已过期）的租约不能被释放路径偷走：释放仅当 owner 是自己的 id
        store.setItem(BROWSER_TABS_OWNER_KEY, JSON.stringify({id: 'someone-else', ts: Date.now() - 20000}));
        mod.mod.notePersonalClosed();
        assert.deepEqual(savedUrls(store), [], '关标签 = 从恢复列表移除（立即写）');
        assert.equal(JSON.parse(store.getItem(BROWSER_TABS_OWNER_KEY)).id, 'someone-else',
            '不偷别人的租约（让它随 TTL 过期）');

        // 自己经恢复路径持有租约后关标签 → 释放
        store.setItem(BROWSER_TABS_KEY, serializeBrowserTabs(['https://r.example']));
        assert.equal(await mod.mod.restoreOnStartup(), 1);
        assert.ok(JSON.parse(store.getItem(BROWSER_TABS_OWNER_KEY)).id, '恢复者持有租约');
        mod.mod.notePersonalClosed();
        assert.equal(store.getItem(BROWSER_TABS_OWNER_KEY), null, '关标签释放自己的租约');
    } finally {
        mod.mod.releaseLease();
    }
});

test('about:blank 开启不覆盖已有存档', async () => {
    const store = makeStore();
    store.setItem(BROWSER_TABS_KEY, serializeBrowserTabs(['https://keep.example']));
    const mod = makeMod(store);
    try {
        mod.mod.notePersonalOpened('about:blank');
        await wait(BROWSER_SAVE_WAIT_MS);
        assert.deepEqual(savedUrls(store), ['https://keep.example'], '空白页不算「用户在看某网页」');
    } finally {
        mod.mod.releaseLease();
    }
});

test('退出兜底冲刷防抖中的地址', async () => {
    const store = makeStore();
    const mod = makeMod(store);
    mod.mod.notePersonalOpened('https://pending.example'); // 防抖未到就退出
    mod.listeners.pagehide();
    assert.deepEqual(savedUrls(store), ['https://pending.example'], 'pagehide 立即落盘');
});

// ---- 写权 = 实例确认打开成功（onOpened 才置位）----

test('打开失败回滚不置写权：未确认打开的关闭通知不清存档', async () => {
    const store = makeStore();
    store.setItem(BROWSER_TABS_KEY, serializeBrowserTabs(['https://keep.example']));
    const mod = makeMod(store);
    // 模拟窗口 B 打开失败（实例被别的窗口占用）→ closeDocNow 回滚：从未走 onOpened
    mod.mod.notePersonalClosed();
    assert.deepEqual(savedUrls(store), ['https://keep.example'], '回滚不能抹掉（可能是别的窗口写下的）存档');
});

test('实例确认前的竞态导航不落盘', async () => {
    const store = makeStore();
    store.setItem(BROWSER_TABS_KEY, serializeBrowserTabs(['https://keep.example']));
    const mod = makeMod(store);
    mod.mod.notePersonalNav('https://race.example'); // 打开完成前的广播导航
    await wait(BROWSER_SAVE_WAIT_MS);
    assert.deepEqual(savedUrls(store), ['https://keep.example'], '写权未置位时不写盘');
});

// ---- 恢复与租约 ----

test('恢复：无存档不开标签', async () => {
    const store = makeStore();
    const mod = makeMod(store);
    assert.equal(await mod.mod.restoreOnStartup(), 0);
    assert.deepEqual(mod.opens, []);
});

test('恢复：无 owner 时获取租约并按地址恢复', async () => {
    const store = makeStore();
    store.setItem(BROWSER_TABS_KEY, serializeBrowserTabs(['https://r1.example', 'https://r1.example', 'about:blank']));
    const mod = makeMod(store);
    try {
        assert.equal(await mod.mod.restoreOnStartup(), 1, '归一化后只剩 1 个地址');
        assert.deepEqual(mod.opens, [['https://r1.example', 'user', {personal: true}]]);
        const owner = JSON.parse(store.getItem(BROWSER_TABS_OWNER_KEY));
        assert.ok(owner && owner.id && Number(owner.ts) > Date.now() - 1000, '恢复者持有租约');
    } finally {
        mod.mod.releaseLease();
    }
});

test('恢复：租约未过期时跳过（别的窗口正在恢复）', async () => {
    const store = makeStore();
    store.setItem(BROWSER_TABS_KEY, serializeBrowserTabs(['https://r.example']));
    store.setItem(BROWSER_TABS_OWNER_KEY, JSON.stringify({id: 'other-window', ts: Date.now()}));
    const mod = makeMod(store);
    assert.equal(await mod.mod.restoreOnStartup(), 0);
    assert.deepEqual(mod.opens, [], '不与持有方抢实例');
    assert.equal(JSON.parse(store.getItem(BROWSER_TABS_OWNER_KEY)).id, 'other-window', '租约未被抢走');
});

test('恢复：租约过期后接管', async () => {
    const store = makeStore();
    store.setItem(BROWSER_TABS_KEY, serializeBrowserTabs(['https://r.example']));
    store.setItem(BROWSER_TABS_OWNER_KEY, JSON.stringify({id: 'dead-window', ts: Date.now() - 20000}));
    const mod = makeMod(store);
    try {
        assert.equal(await mod.mod.restoreOnStartup(), 1);
        const owner = JSON.parse(store.getItem(BROWSER_TABS_OWNER_KEY));
        assert.notEqual(owner.id, 'dead-window', '过期租约被接管');
    } finally {
        mod.mod.releaseLease();
    }
});

test('恢复：释放租约后他人可接管', async () => {
    const store = makeStore();
    store.setItem(BROWSER_TABS_KEY, serializeBrowserTabs(['https://r.example']));
    const a = makeMod(store);
    assert.equal(await a.mod.restoreOnStartup(), 1);
    a.mod.releaseLease();
    assert.equal(store.getItem(BROWSER_TABS_OWNER_KEY), null, '释放后租约清空');

    const b = makeMod(store);
    try {
        assert.equal(await b.mod.restoreOnStartup(), 1);
        assert.ok(JSON.parse(store.getItem(BROWSER_TABS_OWNER_KEY)).id, 'B 接管成功');
    } finally {
        b.mod.releaseLease();
    }
});

test('恢复：Go 侧实例已在别的窗口活着时跳过（BrowserState 可查到）', async () => {
    const store = makeStore();
    store.setItem(BROWSER_TABS_KEY, serializeBrowserTabs(['https://r.example']));
    let stateCalls = 0;
    const mod = makeMod(store, {
        backend: {BrowserState: async () => { stateCalls += 1; return {id: 'browser-user', url: 'https://x'}; }},
    });
    assert.equal(await mod.mod.restoreOnStartup(), 0);
    assert.equal(stateCalls, 1, '先问后端实例状态');
    assert.deepEqual(mod.opens, [], '实例已在（别的窗口开着），恢复必失败所以跳过');
    assert.equal(store.getItem(BROWSER_TABS_OWNER_KEY), null, '跳过路径不占租约');
});

test('恢复：openBrowserTab 缺失时放弃并释放租约', async () => {
    const store = makeStore();
    store.setItem(BROWSER_TABS_KEY, serializeBrowserTabs(['https://r.example']));
    const mod = makeMod(store, {
        backend: {BrowserState: async () => { throw new Error('不存在'); }},
        open: null, // 组合根未接线
    });
    assert.equal(await mod.mod.restoreOnStartup(), 0);
    assert.equal(store.getItem(BROWSER_TABS_OWNER_KEY), null, '放弃路径必须释放租约');
});

test('PERSONAL_BROWSER_ID 两处定义同值（防改一处漏一处）', () => {
    assert.equal(PERSONAL_BROWSER_ID, 'browser-user');
    assert.match(src('bridge/bridge-ui.js'), /const PERSONAL_BROWSER_ID = 'browser-user';/,
        'bridge-ui 的固定实例 id 必须与 browser-tab-restore.js 的同值');
});

// ---- 接线护栏（源码断言，参照 session-restore.test.mjs）----

test('接线：main.js 注入 getter、browser-nav 通知、bridge-ui 恢复调用、editor-groups 关闭通知', () => {
    const main = src('main.js');
    const getters = main.match(/get browserTabRestore\(\) \{ return browserTabRestore; \}/g) || [];
    assert.ok(getters.length >= 2, 'main.js 必须把 browserTabRestore 以 getter 注入 editor-groups 与 bridge-ui 两处 deps');
    assert.match(main, /import \{createBrowserTabRestore\} from '\.\/shell\/browser-tab-restore\.js';/,
        'main.js 必须引入 browser-tab-restore 模块');
    assert.match(main, /if \(doc\.browserPersist && browserTabRestore\) browserTabRestore\.notePersonalNav\(data\.url\);/,
        'browser-nav 事件必须把个人浏览器地址变化通知恢复模块');

    const bridge = src('bridge/bridge-ui.js');
    assert.match(bridge, /if \(!floatWindow && deps\.browserTabRestore\) \{/,
        '启动编排必须仅主窗口调用恢复');
    assert.match(bridge, /await deps\.browserTabRestore\.restoreOnStartup\(\)/,
        '启动编排必须在 restoreSession 之后调用 restoreOnStartup');
    assert.match(bridge, /const onOpened = \(info\) => \{[\s\S]*?if \(doc\.browserPersist && deps\.browserTabRestore\) \{\s*deps\.browserTabRestore\.notePersonalOpened\(target\);/,
        '建个人标签必须在实例确认打开成功（onOpened）后才通知恢复模块——写权 = 真持有实例');
    assert.match(bridge, /if \(deps\.browserTabRestore\) deps\.browserTabRestore\.notePersonalOpened\(target\);/,
        '已开着再导航的分支必须同步恢复列表');
    assert.doesNotMatch(bridge, /if \(personal && deps\.browserTabRestore\)/,
        '建标签本身不得提前通知（打开失败回滚不能置写权）');

    const groups = src('editor/editor-groups.js');
    assert.match(groups, /if \(doc\.browser && doc\.browserPersist && deps\.browserTabRestore\) \{\s*deps\.browserTabRestore\.notePersonalClosed\(\);/,
        'closeDocNow 必须在个人浏览器分支通知移除地址');
});
