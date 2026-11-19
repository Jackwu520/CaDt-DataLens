// lifecycle-hooks.test.mjs —— 工作区生命周期钩子控制器护栏（自动执行 + AI 四动作的审批语义）。
// 重点锁两条安全不变量：写动作**无条件**过审批（不看档位，approval 通道缺失直接拒绝）、
// AI 只能碰当前工作区的条目。方案见 docs/finished-plans/workspace-lifecycle-hooks.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLifecycleHooks} from '../../src/shell/lifecycle-hooks.js';
import {LIFECYCLE_HOOK_MAX_PER_WS, LIFECYCLE_HOOK_MAX_TOTAL} from '../../src/core/lifecycle-hooks.js';

// ---- 测试脚手架 ----

function makeHarness(opts = {}) {
    const settings = {lifecycleHooks: opts.lifecycleHooks || [], lifecycleHooksEnabled: opts.enabled !== false};
    const calls = [];      // AIRunShellCommand(command, cwd, timeoutMs, runId, shell)
    const messages = [];   // messageCenter.add(msg, opts)
    const logs = [];       // activityLog.log(action, target, detail, opts)
    const approvals = [];  // 审批卡规格
    let applied = 0;
    let backendImpl = opts.backend
        || (async () => ({code: 0, stdout: '', stderr: '', timedOut: false}));
    const deps = {
        settings,
        applySettings() { applied += 1; },
        backend: {
            async AIRunShellCommand(...args) {
                calls.push(args);
                return await backendImpl(...args);
            },
        },
        sessionPathKey: (p) => String(p || '').replace(/\\/g, '/').replace(/[\\/]+$/, '').toLowerCase(),
        getWorkspace: () => (opts.workspace != null ? opts.workspace : 'D:\\ws'),
        addMessage(msg, msgOpts) { messages.push({msg, opts: msgOpts}); },
        activityLog: {log(...a) { logs.push(a); }},
    };
    // 审批通道：记录规格，按预置答案逐个消费，缺省批准
    const answers = (opts.approvals || []).slice();
    const requestActionApproval = async (spec) => {
        approvals.push(spec);
        return answers.length ? answers.shift() : {approved: true};
    };
    return {deps, settings, calls, messages, logs, approvals, get applied() { return applied; }, requestActionApproval, answers};
}

const entry = (over) => ({id: 'pc-x', ws: 'd:/ws', event: 'workspace-open', command: 'echo hi',
    timeoutMs: 30000, enabled: true, origin: 'user', createdAt: 1, ...over});

// ---- runForWorkspace：自动执行 ----

test('runForWorkspace：顺序执行，cwd / 超时 / runId 正确，回填与汇总齐备', async () => {
    const h = makeHarness({lifecycleHooks: [
        entry({id: 'pc-1', command: 'first', timeoutMs: 5000}),
        entry({id: 'pc-2', command: 'second', origin: 'ai'}),
    ]});
    const ctl = createLifecycleHooks(h.deps);
    const out = await ctl.runForWorkspace('D:\\WS');
    assert.deepEqual(out, {ran: 2, failed: 0});
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls[0], ['first', 'D:\\WS', 5000, 'lifecycle-pc-1', '']);
    assert.deepEqual(h.calls[1][3], 'lifecycle-pc-2');
    // 回填 + 落盘
    assert.ok(h.settings.lifecycleHooks[0].lastRunAt > 0);
    assert.equal(h.settings.lifecycleHooks[0].lastCode, 0);
    assert.ok(h.applied > 0);
    // 汇总：success 不 toast，AI 配置计数
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].msg.kind, 'success');
    assert.equal(h.messages[0].opts.toast, false);
    assert.match(h.messages[0].msg.body, /共 2 条/);
    assert.match(h.messages[0].msg.body, /其中 1 条为 AI 配置/);
    assert.ok(h.logs.some((a) => a[0] === 'lifecycle.run'));
});

test('runForWorkspace：单条异常 / 非零退出都算失败，但不阻断后续', async () => {
    const h = makeHarness({lifecycleHooks: [
        entry({id: 'pc-1', command: 'boom'}),
        entry({id: 'pc-2', command: 'exited'}),
        entry({id: 'pc-3', command: 'fine'}),
    ]});
    let n = 0;
    h.deps.backend.AIRunShellCommand = async () => {
        n += 1;
        if (n === 1) throw new Error('spawn fail');
        if (n === 2) return {code: 2, stdout: '', stderr: '', timedOut: false};
        return {code: 0, stdout: '', stderr: '', timedOut: false};
    };
    const ctl = createLifecycleHooks(h.deps);
    const out = await ctl.runForWorkspace('D:\\ws');
    assert.deepEqual(out, {ran: 3, failed: 2});
    assert.equal(h.messages[0].msg.kind, 'error');
    assert.equal(h.messages[0].opts.toast, true);
    assert.match(h.messages[0].msg.body, /执行失败：spawn fail/);
    assert.match(h.messages[0].msg.body, /退出码 2/);
});

test('runForWorkspace：同工作区执行中跳过重入，别的照常', async () => {
    let release;
    const h = makeHarness({lifecycleHooks: [entry({id: 'pc-1'})]});
    // 第一次调用挂起（制造「执行中」窗口），之后所有调用立即完成
    h.deps.backend.AIRunShellCommand = () => {
        if (release) return Promise.resolve({code: 0, stdout: '', stderr: '', timedOut: false});
        return new Promise((resolve) => { release = resolve; });
    };
    const ctl = createLifecycleHooks(h.deps);
    const first = ctl.runForWorkspace('D:\\ws');
    const second = await ctl.runForWorkspace('D:\\ws');
    assert.deepEqual(second, {ran: 0, skipped: 'running'});
    release({code: 0, stdout: '', stderr: '', timedOut: false});
    assert.deepEqual(await first, {ran: 1, failed: 0});
    // 已结束后再触发不再跳过（backend 已切换为立即完成，不会再挂起）
    const third = await ctl.runForWorkspace('D:\\ws');
    assert.deepEqual(third, {ran: 1, failed: 0});
});

test('runForWorkspace：总开关关闭 / 无匹配条目不执行', async () => {
    const off = makeHarness({lifecycleHooks: [entry({id: 'pc-1'})], enabled: false});
    const ctlOff = createLifecycleHooks(off.deps);
    assert.deepEqual(await ctlOff.runForWorkspace('D:\\ws'), {ran: 0, skipped: 'disabled'});
    assert.equal(off.calls.length, 0);

    const other = makeHarness({lifecycleHooks: [entry({id: 'pc-1', ws: 'd:/other'})]});
    const ctlOther = createLifecycleHooks(other.deps);
    assert.deepEqual(await ctlOther.runForWorkspace('D:\\ws'), {ran: 0});
    assert.equal(other.calls.length, 0);
});

test('runForWorkspace：停用条目与未知事件条目不执行', async () => {
    const h = makeHarness({lifecycleHooks: [
        entry({id: 'pc-1', enabled: false}),
        entry({id: 'pc-2', event: 'workspace-close'}),
    ]});
    const ctl = createLifecycleHooks(h.deps);
    assert.deepEqual(await ctl.runForWorkspace('D:\\ws'), {ran: 0});
});

// ---- 生命周期：workspace-close / session-start / 工具级事件 ----

test('runForEvent：工具级事件按 matchTools 过滤，空匹配器跑全部；runId 带条目 id', async () => {
    const h = makeHarness({lifecycleHooks: [
        entry({id: 'pc-a', command: 'on-any', event: 'pre-tool-use'}),
        entry({id: 'pc-b', command: 'on-write', event: 'pre-tool-use', matchTools: ['write_file']}),
        entry({id: 'pc-c', command: 'on-mcp', event: 'pre-tool-use', matchTools: ['mcp__*']}),
        entry({id: 'pc-o', command: 'on-open'}), // 非工具事件不参与
    ]});
    const ctl = createLifecycleHooks(h.deps);
    const out = await ctl.runForEvent('D:\\ws', 'pre-tool-use', 'write_file');
    assert.deepEqual(out, {ran: 2, failed: 0}); // on-any + on-write
    assert.deepEqual(h.calls.map((c) => c[0]).sort(), ['on-any', 'on-write']);
    assert.ok(h.calls.every((c) => c[3].startsWith('lifecycle-')));

    const out2 = await ctl.runForEvent('D:\\ws', 'pre-tool-use', 'mcp__server__tool');
    assert.deepEqual(out2, {ran: 2, failed: 0}); // on-any + on-mcp
});

test('runForEvent：工具级重入按工具名分键——同工具在跑时跳过、别的工具照常', async () => {
    let release;
    const h = makeHarness({lifecycleHooks: [
        entry({id: 'pc-a', command: 'on-write', event: 'pre-tool-use', matchTools: ['write_file']}),
        entry({id: 'pc-b', command: 'on-read', event: 'pre-tool-use', matchTools: ['read_file']}),
    ]});
    h.deps.backend.AIRunShellCommand = (command) => {
        if (command === 'on-write' && !release) return new Promise((r) => { release = r; });
        return Promise.resolve({code: 0, stdout: '', stderr: '', timedOut: false});
    };
    const ctl = createLifecycleHooks(h.deps);
    const first = ctl.runForEvent('D:\\ws', 'pre-tool-use', 'write_file'); // 挂起
    const sameTool = await ctl.runForEvent('D:\\ws', 'pre-tool-use', 'write_file');
    assert.deepEqual(sameTool, {ran: 0, skipped: 'running'}); // 同工具被重入护栏跳过
    const otherTool = await ctl.runForEvent('D:\\ws', 'pre-tool-use', 'read_file');
    assert.deepEqual(otherTool, {ran: 1, failed: 0}); // 不同工具不受影响
    release({code: 0, stdout: '', stderr: '', timedOut: false});
    assert.deepEqual(await first, {ran: 1, failed: 0});
});

test('runForEvent：post-tool-use / stop 等事件独立触发，互不串台', async () => {
    const h = makeHarness({lifecycleHooks: [
        entry({id: 'pc-a', command: 'post-cmd', event: 'post-tool-use', matchTools: ['write_file']}),
        entry({id: 'pc-b', command: 'stop-cmd', event: 'stop'}),
        entry({id: 'pc-c', command: 'submit-cmd', event: 'user-prompt-submit'}),
    ]});
    const ctl = createLifecycleHooks(h.deps);
    await ctl.runForEvent('D:\\ws', 'post-tool-use', 'write_file');
    assert.deepEqual(h.calls.map((c) => c[0]), ['post-cmd']);
    await ctl.runForEvent('D:\\ws', 'stop');
    assert.deepEqual(h.calls.map((c) => c[0]), ['post-cmd', 'stop-cmd']);
    await ctl.runForEvent('D:\\ws', 'user-prompt-submit');
    assert.deepEqual(h.calls.map((c) => c[0]), ['post-cmd', 'stop-cmd', 'submit-cmd']);
});

test('runForWorkspaceClose：只跑 close 条目，标题带事件标签', async () => {
    const h = makeHarness({lifecycleHooks: [
        entry({id: 'pc-o', command: 'on-open'}),
        entry({id: 'pc-c', command: 'on-close', event: 'workspace-close'}),
    ]});
    const ctl = createLifecycleHooks(h.deps);
    await ctl.runForWorkspaceClose('D:\\ws');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][0], 'on-close');
    assert.equal(h.calls[0][1], 'D:\\ws');
    assert.equal(h.messages[0].msg.title, '生命周期执行完成（关闭工作区 · ws）');
});

test('runForAISessionStart：跑 session-start 条目；backend 全炸也返回 failed 不抛', async () => {
    const h = makeHarness({lifecycleHooks: [
        entry({id: 'pc-a', command: 'prep', event: 'ai-session-start'}),
        entry({id: 'pc-o', command: 'on-open'}),
    ]});
    h.deps.backend.AIRunShellCommand = async (...args) => {
        h.calls.push(args); // 替换实现也要进账：断言「open 条目不参与」靠 calls 计数
        throw new Error('no shell');
    };
    const ctl = createLifecycleHooks(h.deps);
    const out = await ctl.runForAISessionStart('D:\\ws');
    assert.deepEqual(out, {ran: 1, failed: 1});
    assert.equal(h.messages[0].msg.kind, 'error');
    assert.match(h.messages[0].msg.title, /会话开始 · ws/);
    assert.equal(h.calls.length, 1); // open 条目不参与
});

test('重入护栏按事件分键：open 执行中不阻塞 close', async () => {
    let release;
    const h = makeHarness({lifecycleHooks: [
        entry({id: 'pc-o', command: 'open-cmd'}),
        entry({id: 'pc-c', command: 'close-cmd', event: 'workspace-close'}),
    ]});
    h.deps.backend.AIRunShellCommand = (command) => {
        if (command === 'open-cmd' && !release) return new Promise((r) => { release = r; });
        return Promise.resolve({code: 0, stdout: '', stderr: '', timedOut: false});
    };
    const ctl = createLifecycleHooks(h.deps);
    const openRun = ctl.runForWorkspace('D:\\ws');
    const closeRun = await ctl.runForWorkspaceClose('D:\\ws');
    assert.deepEqual(closeRun, {ran: 1, failed: 0});
    release({code: 0, stdout: '', stderr: '', timedOut: false});
    assert.deepEqual(await openRun, {ran: 1, failed: 0});
});

test('runForAISessionStart：执行中同事件重入跳过；空工作区直接返回', async () => {
    let release;
    const h = makeHarness({lifecycleHooks: [entry({id: 'pc-a', command: 'prep', event: 'ai-session-start'})]});
    h.deps.backend.AIRunShellCommand = () => new Promise((r) => { release = r; });
    const ctl = createLifecycleHooks(h.deps);
    const first = ctl.runForAISessionStart('D:\\ws');
    const second = await ctl.runForAISessionStart('D:\\ws');
    assert.deepEqual(second, {ran: 0, skipped: 'running'});
    release({code: 0, stdout: '', stderr: '', timedOut: false});
    assert.deepEqual(await first, {ran: 1, failed: 0});
    assert.deepEqual(await ctl.runForAISessionStart(''), {ran: 0});
});

// ---- get_lifecycle_hooks ----

test('get_lifecycle_hooks：返回当前工作区**全部事件**条目（含停用），别的工作区不可见', async () => {
    const h = makeHarness({lifecycleHooks: [
        entry({id: 'pc-1', command: 'mine-open'}),
        entry({id: 'pc-2', command: 'mine-close', event: 'workspace-close', enabled: false}),
        entry({id: 'pc-3', command: 'mine-start', event: 'ai-session-start'}),
        entry({id: 'pc-4', ws: 'd:/other', command: 'theirs'}),
    ]});
    const ctl = createLifecycleHooks(h.deps);
    const out = await ctl.handleAppAction('get_lifecycle_hooks', {}, null);
    assert.deepEqual(out.entries.map((e) => e.id), ['pc-1', 'pc-2', 'pc-3']);
    assert.equal(out.entries[1].enabled, false);
    assert.match(out.note, /run_command/);
});

test('get_lifecycle_hooks：无工作区报错', async () => {
    const h = makeHarness({workspace: ''});
    const ctl = createLifecycleHooks(h.deps);
    await assert.rejects(() => ctl.handleAppAction('get_lifecycle_hooks', {}, null), /没有打开工作区/);
});

// ---- add_lifecycle_hook：无条件审批 ----

test('add_lifecycle_hook：审批通道缺失直接拒绝（没有任何档位路由）', async () => {
    const h = makeHarness();
    const ctl = createLifecycleHooks(h.deps);
    await assert.rejects(
        () => ctl.handleAppAction('add_lifecycle_hook', {command: 'ls'}, null),
        /需要用户在界面审批/,
    );
    assert.equal(h.settings.lifecycleHooks.length, 0);
});

test('add_lifecycle_hook：拒绝则不写入；批准则写入 origin=ai 并绑定当前工作区', async () => {
    const denied = makeHarness({approvals: [{approved: false}]});
    const ctlDenied = createLifecycleHooks(denied.deps);
    const outDenied = await ctlDenied.handleAppAction('add_lifecycle_hook', {command: 'npm run dev'}, denied.requestActionApproval);
    assert.deepEqual(outDenied, {added: false, denied: true, note: '用户拒绝了本次新增'});
    assert.equal(denied.settings.lifecycleHooks.length, 0);

    const ok = makeHarness();
    const ctlOk = createLifecycleHooks(ok.deps);
    const out = await ctlOk.handleAppAction('add_lifecycle_hook', {command: 'npm run dev'}, ok.requestActionApproval);
    assert.equal(out.added, true);
    assert.equal(out.origin, 'ai');
    assert.equal(ok.settings.lifecycleHooks.length, 1);
    assert.equal(ok.settings.lifecycleHooks[0].ws, 'd:/ws');
    assert.equal(ok.settings.lifecycleHooks[0].origin, 'ai');
    // 审批卡：风险恒 high、命令全文在 target、警告含「无需再次审批」
    assert.equal(ok.approvals[0].risk, 'high');
    assert.equal(ok.approvals[0].target, 'npm run dev');
    assert.match(ok.approvals[0].warnings[0], /无需再次审批/);
});

test('add_lifecycle_hook：外部传入 id 一律忽略（防与既有条目撞 id，审查 P2）', async () => {
    const h = makeHarness({lifecycleHooks: [entry({id: 'pc-exist', command: 'old'})]});
    const ctl = createLifecycleHooks(h.deps);
    const out = await ctl.handleAppAction('add_lifecycle_hook', {command: 'new', id: 'pc-exist'}, h.requestActionApproval);
    assert.equal(out.added, true);
    assert.notEqual(out.id, 'pc-exist');                       // 重新生成
    assert.equal(h.settings.lifecycleHooks.length, 2);            // 没有同 id 重复
    assert.equal(h.settings.lifecycleHooks.filter((e) => e.id === 'pc-exist').length, 1);
});

test('update_lifecycle_hook：params.ws 被忽略，条目沿用原绑定（防跨工作区投毒，审查 P1-1）', async () => {
    const h = makeHarness({lifecycleHooks: [entry({id: 'pc-1', ws: 'd:/ws', command: 'old'})]});
    const ctl = createLifecycleHooks(h.deps);
    const out = await ctl.handleAppAction('update_lifecycle_hook',
        {id: 'pc-1', command: 'new', ws: 'c:/other-project'}, h.requestActionApproval);
    assert.equal(out.updated, true);
    const saved = h.settings.lifecycleHooks.find((e) => e.id === 'pc-1');
    assert.equal(saved.ws, 'd:/ws');       // 绑定不变
    assert.equal(saved.command, 'new');
});

test('add_lifecycle_hook：命令为空 / 全局与单工作区上限报错', async () => {
    const h = makeHarness();
    const ctl = createLifecycleHooks(h.deps);
    await assert.rejects(() => ctl.handleAppAction('add_lifecycle_hook', {command: '  '}, h.requestActionApproval), /命令不能为空/);

    const full = makeHarness({lifecycleHooks: Array.from({length: LIFECYCLE_HOOK_MAX_TOTAL}, (_, i) => entry({id: 'pc-' + i}))});
    const ctlFull = createLifecycleHooks(full.deps);
    await assert.rejects(() => ctlFull.handleAppAction('add_lifecycle_hook', {command: 'ls'}, full.requestActionApproval), /全局上限/);

    const wsFull = makeHarness({lifecycleHooks: Array.from({length: LIFECYCLE_HOOK_MAX_PER_WS}, (_, i) => entry({id: 'pc-w' + i}))});
    const ctlWsFull = createLifecycleHooks(wsFull.deps);
    await assert.rejects(() => ctlWsFull.handleAppAction('add_lifecycle_hook', {command: 'ls'}, wsFull.requestActionApproval), /上限 10 条/);
});

// ---- update_lifecycle_hook ----

test('update_lifecycle_hook：部分更新保留未传字段，origin 归 ai；id 不存在 / 别的工作区报错', async () => {
    const h = makeHarness({lifecycleHooks: [
        entry({id: 'pc-1', command: 'old', timeoutMs: 5000, origin: 'user'}),
        entry({id: 'pc-2', ws: 'd:/other', command: 'theirs'}),
    ]});
    const ctl = createLifecycleHooks(h.deps);
    await assert.rejects(() => ctl.handleAppAction('update_lifecycle_hook', {id: 'pc-9'}, h.requestActionApproval), /找不到/);
    await assert.rejects(() => ctl.handleAppAction('update_lifecycle_hook', {id: 'pc-2'}, h.requestActionApproval), /其他工作区/);

    const out = await ctl.handleAppAction('update_lifecycle_hook', {id: 'pc-1', enabled: false}, h.requestActionApproval);
    assert.equal(out.updated, true);
    const saved = h.settings.lifecycleHooks.find((e) => e.id === 'pc-1');
    assert.equal(saved.command, 'old');       // 未传沿用
    assert.equal(saved.timeoutMs, 5000);
    assert.equal(saved.enabled, false);
    assert.equal(saved.origin, 'ai');         // AI 写入 = 最后写入方
    // 审批卡带原值 → 新值
    assert.match(h.approvals[0].oldValue, /old/);
    assert.match(h.approvals[0].newValue, /停用/);
});

// ---- remove_lifecycle_hook ----

test('remove_lifecycle_hook：批准后删除；拒绝 / 别的工作区不动', async () => {
    const h = makeHarness({lifecycleHooks: [
        entry({id: 'pc-1', command: 'bye'}),
        entry({id: 'pc-2', ws: 'd:/other'}),
    ]});
    const ctl = createLifecycleHooks(h.deps);
    await assert.rejects(() => ctl.handleAppAction('remove_lifecycle_hook', {id: 'pc-2'}, h.requestActionApproval), /其他工作区/);

    const denied = makeHarness({lifecycleHooks: [entry({id: 'pc-1'})], approvals: [{approved: false}]});
    const ctlDenied = createLifecycleHooks(denied.deps);
    const out = await ctlDenied.handleAppAction('remove_lifecycle_hook', {id: 'pc-1'}, denied.requestActionApproval);
    assert.deepEqual(out, {removed: false, denied: true, note: '用户拒绝了本次删除'});
    assert.equal(denied.settings.lifecycleHooks.length, 1);

    const ok = await ctl.handleAppAction('remove_lifecycle_hook', {id: 'pc-1'}, h.requestActionApproval);
    assert.equal(ok.removed, true);
    assert.equal(h.settings.lifecycleHooks.length, 1);
    assert.equal(h.settings.lifecycleHooks[0].id, 'pc-2');
});

// ---- 旧名兼容（pre-command 时代）：技能表不再下发，但历史会话 / 记忆里的调用仍要命中 ----

test('旧动作名别名：get / add / update / remove_pre_command 走同一分支，审批语义不变', async () => {
    const h = makeHarness({lifecycleHooks: [entry({id: 'pc-1', command: 'old'})]});
    const ctl = createLifecycleHooks(h.deps);
    const listed = await ctl.handleAppAction('get_pre_commands', {}, null);
    assert.equal(listed.entries.length, 1);

    const added = await ctl.handleAppAction('add_pre_command', {command: 'via-legacy'}, h.requestActionApproval);
    assert.equal(added.added, true);
    // 同一实现：审批卡报的是新动作名，旧名不会绕过审批
    assert.equal(h.approvals[0].action, 'add_lifecycle_hook');

    const updated = await ctl.handleAppAction('update_pre_command',
        {id: added.id, command: 'via-legacy-2'}, h.requestActionApproval);
    assert.equal(updated.updated, true);
    assert.equal(h.settings.lifecycleHooks.find((e) => e.id === added.id).command, 'via-legacy-2');

    const removed = await ctl.handleAppAction('remove_pre_command', {id: added.id}, h.requestActionApproval);
    assert.equal(removed.removed, true);
    assert.equal(h.settings.lifecycleHooks.length, 1);
});

// ---- 未知动作 ----

test('handleAppAction：未知动作报错', async () => {
    const h = makeHarness();
    const ctl = createLifecycleHooks(h.deps);
    await assert.rejects(() => ctl.handleAppAction('bogus_action', {}, null), /未知动作/);
});
