// memo-term 纯函数护栏：shell argv 拼接、输出截断、状态行文案、运行 id 规则。
// 编排层（run/stop/事件路由）依赖 Wails 桥与 DOM，由浏览器 mock 复测覆盖；这里卡纯逻辑。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    TERM_MAX_LINES,
    TERM_RUN_ID_PREFIX,
    TERM_TIMEOUT_MS,
    buildShellArgv,
    createMemoTerm,
    formatTermDuration,
    formatTermStatus,
    termRunId,
    trimTermLines,
} from '../../src/bridge/memo-term.js';

test('buildShellArgv：按 shell 名给 argv（PowerShell/GitBash/cmd），未知兜底 cmd 语义', () => {
    assert.deepEqual(
        buildShellArgv('PowerShell 7', 'git status'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'git status']);
    assert.deepEqual(
        buildShellArgv('Windows PowerShell', 'dir'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'dir']);
    assert.deepEqual(
        buildShellArgv('Git Bash', 'ls -la'),
        ['--login', '-c', 'ls -la']);
    assert.deepEqual(
        buildShellArgv('Command Prompt', 'echo hi'),
        ['/d', '/s', '/c', 'echo hi']);
    assert.deepEqual(
        buildShellArgv('未知 shell', 'echo hi'),
        ['/d', '/s', '/c', 'echo hi'],
        '未知名字兜底按 cmd 语义');
    // 多行命令整段交给 shell（多语句脚本语义）
    assert.equal(buildShellArgv('PowerShell 7', 'a\nb')[4], 'a\nb');
});

test('trimTermLines：超限裁掉头部返回丢弃数，未超限返回 0', () => {
    const lines = Array.from({length: TERM_MAX_LINES + 3}, (_, i) => ({text: String(i)}));
    const dropped = trimTermLines(lines, TERM_MAX_LINES);
    assert.equal(dropped, 3);
    assert.equal(lines.length, TERM_MAX_LINES);
    assert.equal(lines[0].text, '3', '保留的是尾部');
    assert.equal(trimTermLines([{text: 'a'}], TERM_MAX_LINES), 0);
});

test('formatTermDuration：短毫秒两位小数 / 中段一位 / 分钟进位 / 非法返回空', () => {
    assert.equal(formatTermDuration(1250), '1.25 s');
    assert.equal(formatTermDuration(12345), '12.3 s');
    assert.equal(formatTermDuration(125000), '2 m 05 s');
    assert.equal(formatTermDuration(0), '0.00 s');
    assert.equal(formatTermDuration(-1), '');
    assert.equal(formatTermDuration(null), '');
    assert.equal(formatTermDuration(NaN), '');
});

test('formatTermStatus：各状态文案（超时含「不支持挂起任务」）', () => {
    const base = {state: 'exit', code: 2, durationMs: 1250, startedAt: Date.now()};
    assert.equal(formatTermStatus(null), '');
    assert.match(formatTermStatus({...base, state: 'running'}), /^运行中 ⋅ \d/);
    assert.equal(formatTermStatus({...base, state: 'done'}), '完成 ⋅ 退出码 0 ⋅ 1.25 s');
    assert.equal(formatTermStatus(base), '退出码 2 ⋅ 1.25 s');
    assert.equal(formatTermStatus({...base, state: 'timeout'}), '已超时终止（不支持挂起任务） ⋅ 1.25 s');
    assert.equal(formatTermStatus({...base, state: 'stopped'}), '已停止 ⋅ 1.25 s');
    assert.equal(formatTermStatus({state: 'exit', code: 7}), '退出码 7');
});

test('termRunId：memo 前缀（与 F5 的 run-N 隔离）+ 超时常量', () => {
    assert.equal(termRunId('it-42'), TERM_RUN_ID_PREFIX + 'it-42');
    assert.match(TERM_RUN_ID_PREFIX, /^memo-$/);
    assert.equal(TERM_TIMEOUT_MS, 120000);
});

// ===== 编排层（用假 backend/rt 驱动，不碰 DOM） =====

function makeDeps() {
    const flashLog = [];
    let outHandler = null;
    let exitHandler = null;
    const deps = {
        flash: (msg, isErr) => flashLog.push({msg, isErr: !!isErr}),
        // 事件桥（生产由 main.js 注入；测试用假桥捕获处理器）
        appEvents: {
            onApp: (name, cb) => {
                if (name === 'run-out') outHandler = cb;
                if (name === 'run-exit') exitHandler = cb;
            },
        },
        normalizeTermText: (t) => String(t || '').replace(/\r\n/g, '\n'),
        backend: {
            ResolveRunShell: async (kind) => kind === 'pwsh'
                ? {path: 'C:/pwsh.exe', name: 'PowerShell 7'}
                : {path: 'powershell.exe', name: 'Windows PowerShell'},
            RunExec: async (id, exe, args, cwd, prepend, timeoutMs) => {
                deps.lastExec = {id, exe, args, cwd, timeoutMs};
            },
            RunStop: async () => {},
        },
        // 触发事件（测试驱动用）
        emitOut: (payload) => outHandler(payload),
        emitExit: (payload) => exitHandler(payload),
        flashLog,
    };
    return deps;
}

test('run：防重入 / 空 / 无 backend 报错；RunExec 收到 memo- 前缀 id 与 120s 超时', async () => {
    const deps = makeDeps();
    const term = createMemoTerm(deps);
    const empty = await term.run('it-a', '   ', '');
    assert.ok(!empty.ok && empty.error === '命令为空');

    const ok = await term.run('it-a', 'git status', 'D:/ws');
    assert.ok(ok);
    assert.equal(deps.lastExec.id, 'memo-it-a');
    assert.equal(deps.lastExec.timeoutMs, TERM_TIMEOUT_MS);
    assert.equal(deps.lastExec.cwd, 'D:/ws');
    assert.equal(deps.lastExec.args[4], 'git status');

    const busy = await term.run('it-a', 'other', '');
    assert.ok(!busy.ok && /正在运行/.test(busy.error), '运行中防重入');

    await term.stop('it-a');
    const again = await term.run('it-a', 'other', '');
    assert.ok(again.ok, '停止后可再次运行');
});

test('run-out / run-exit：状态机与停止保留（stopped 不被 exit 覆盖）', async () => {
    const deps = makeDeps();
    const term = createMemoTerm(deps);
    await term.run('it-1', 'ping x', '');
    assert.equal(term.entryOf('it-1').state, 'running');

    deps.emitOut({id: 'memo-it-1', stream: 'out', data: 'hello\r\nworld'});
    assert.deepEqual(term.entryOf('it-1').lines.map((l) => l.text), ['hello', 'world']);

    // 外来 id 与未知条目被忽略
    deps.emitOut({id: 'run-3-run', stream: 'out', data: 'noise'});
    deps.emitOut({id: 'memo-it-x', stream: 'out', data: 'noise'});
    assert.deepEqual(term.entryOf('it-1').lines.map((l) => l.text), ['hello', 'world']);

    deps.emitExit({id: 'memo-it-1', code: 0, durationMs: 1250, reason: ''});
    assert.equal(term.entryOf('it-1').state, 'done');
    assert.equal(term.entryOf('it-1').code, 0);

    // 超时：Go 侧 reason=timeout
    await term.run('it-2', 'npm run dev', '');
    deps.emitExit({id: 'memo-it-2', code: -1, durationMs: 120000, reason: 'timeout'});
    assert.equal(term.entryOf('it-2').state, 'timeout');

    // 手动停止：stop 立刻翻 stopped，随后到达的 exit 不覆盖
    await term.run('it-3', 'ping x', '');
    await term.stop('it-3');
    assert.equal(term.entryOf('it-3').state, 'stopped');
    deps.emitExit({id: 'memo-it-3', code: -1, durationMs: 500, reason: ''});
    assert.equal(term.entryOf('it-3').state, 'stopped');
    assert.equal(term.entryOf('it-3').durationMs, 500);
});

test('run 失败（backend 抛错）：清掉 running 态 + flash，可再次运行', async () => {
    const deps = makeDeps();
    // 撞 id（同窗口防重入已挡，走到这基本是另一窗口在跑）：映射成友好文案
    deps.backend.RunExec = async () => { throw new Error('任务 id "memo-it-1" 已在运行'); };
    const term = createMemoTerm(deps);
    const res = await term.run('it-1', 'x', '');
    assert.ok(!res.ok);
    assert.equal(term.entryOf('it-1'), null, '失败不留 running 僵尸态');
    assert.ok(deps.flashLog.some((f) => f.isErr && /已在运行（可能正在另一窗口）/.test(f.msg)), '撞 id 映射友好文案');
    // 非「已在运行」类错误保持原始信息
    deps.flashLog.length = 0;
    deps.backend.RunExec = async () => { throw new Error('临时目录不可写'); };
    const res2 = await term.run('it-1', 'y', '');
    assert.ok(!res2.ok);
    assert.ok(deps.flashLog.some((f) => f.isErr && /运行失败：临时目录不可写/.test(f.msg)), '其他错误保留原文');
});

test('stopAll：running 的停掉、全部清空（关面板语义）', async () => {
    const deps = makeDeps();
    const stops = [];
    deps.backend.RunStop = async (id) => { stops.push(id); };
    const term = createMemoTerm(deps);
    await term.run('it-1', 'a', '');
    await term.run('it-2', 'b', '');
    deps.emitExit({id: 'memo-it-2', code: 0, durationMs: 10, reason: ''});
    await term.stopAll();
    assert.deepEqual(stops, ['memo-it-1'], '只停还在跑的');
    assert.equal(term.entryOf('it-1'), null);
    assert.equal(term.entryOf('it-2'), null);
    assert.equal(term.runningCount(), 0);
});

test('shell 解析全失败：flash 报错且不进入运行态', async () => {
    const deps = makeDeps();
    deps.backend.ResolveRunShell = async () => { throw new Error('未找到'); };
    const term = createMemoTerm(deps);
    const res = await term.run('it-1', 'x', '');
    assert.ok(!res.ok && /shell/.test(res.error));
    assert.equal(term.entryOf('it-1'), null);
});

test('done 后可再次运行（新一轮 running）', async () => {
    const deps = makeDeps();
    const term = createMemoTerm(deps);
    await term.run('it-1', 'a', '');
    deps.emitExit({id: 'memo-it-1', code: 0, durationMs: 10, reason: ''});
    assert.equal(term.entryOf('it-1').state, 'done');
    const again = await term.run('it-1', 'b', '');
    assert.ok(again.ok);
    assert.equal(term.entryOf('it-1').state, 'running');
    assert.deepEqual(term.entryOf('it-1').lines, [], '新一轮输出应清空');
});

test('stderr 的 data 落 lines 时带 err 标记', async () => {
    const deps = makeDeps();
    const term = createMemoTerm(deps);
    await term.run('it-1', 'a', '');
    deps.emitOut({id: 'memo-it-1', stream: 'err', data: 'boom'});
    assert.deepEqual(term.entryOf('it-1').lines, [{text: 'boom', stream: 'err'}]);
});

test('deps.normalizeTermText 缺失时降级为原文透传（不清洗 \\r）', async () => {
    const deps = makeDeps();
    delete deps.normalizeTermText;
    const term = createMemoTerm(deps);
    await term.run('it-1', 'a', '');
    deps.emitOut({id: 'memo-it-1', stream: 'out', data: 'raw\r\ntext'});
    assert.deepEqual(term.entryOf('it-1').lines, [
        {text: 'raw\r', stream: 'out'},
        {text: 'text', stream: 'out'},
    ]);
});

test('trimTermLines：max=1 只留最后一行；空数组返回 0', () => {
    const lines = [{text: 'a'}, {text: 'b'}, {text: 'c'}];
    assert.equal(trimTermLines(lines, 1), 2);
    assert.deepEqual(lines, [{text: 'c'}]);
    const empty = [];
    assert.equal(trimTermLines(empty, 5), 0);
    assert.deepEqual(empty, []);
});

test('formatTermStatus：truncated 追加「输出已截断」标记', () => {
    const base = {state: 'exit', code: 1, durationMs: 100, startedAt: Date.now()};
    assert.equal(formatTermStatus(base), '退出码 1 ⋅ 0.10 s');
    assert.equal(formatTermStatus({...base, truncated: true}), '退出码 1 ⋅ 0.10 s（输出已截断）');
    assert.ok(/（输出已截断）$/.test(formatTermStatus({...base, state: 'running', truncated: true})));
});
