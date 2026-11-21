// ai-desktop-control.test.mjs —— 桌面控制（Computer Use）新模型：会话级启用 +
// 控制模式声明（2026-11-22 用户重设计）。旧模型的「应用级单飞」与「windows_desktop
// 懒加载揭示」已被移除，这里按新契约断言：
//   · 启用是会话字段（session.desktopEnabled），模块只做判定；
//   · 控制模式只存内存（重启即清空），进入要求「已启用 + 桌面 server 有工具」；
//   · 工具注入 = 仅控制模式期间；退出即移除；
//   · 配置行一步到位（enabled + 白名单勾选），供「安装…」按钮直接写。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DESKTOP_MCP_SERVER,
    DESKTOP_TOOLS_WHITELIST,
    controlModeActionOf,
    createAIDesktopControl,
    desktopServerConfigRow,
    isDesktopToolDef,
    isDesktopToolName,
} from '../../src/ai/ai-desktop-control.js';

const defs = (names) => names.map((n) => ({
    name: 'mcp__windows__' + n,
    description: '工具 ' + n,
    parameters: {type: 'object', properties: {}},
    mcpServer: DESKTOP_MCP_SERVER,
    mcpRawName: n,
}));

const session = (id, extra) => Object.assign({id}, extra || {});

function makeCtl(list = defs(['Snapshot', 'Click'])) {
    const changes = [];
    const ctl = createAIDesktopControl({
        mcpToolDefs: () => list,
        onControlChange: (s) => changes.push(s && s.id),
    });
    return {ctl, changes, list};
}

test('server 判定只认 def.mcpServer === windows', () => {
    assert.equal(DESKTOP_MCP_SERVER, 'windows');
    assert.ok(isDesktopToolName('mcp__windows__Snapshot'));
    assert.ok(!isDesktopToolName('mcp__other__Snapshot'));
    assert.ok(!isDesktopToolName('windows'));
    assert.ok(!isDesktopToolName(null));
    assert.ok(isDesktopToolDef({mcpServer: 'windows'}));
    assert.ok(!isDesktopToolDef({mcpServer: 'tts_local'}));
    assert.ok(!isDesktopToolDef(null));
});

test('controlModeActionOf：enter / exit / status 与中文别名，非法返回空串', () => {
    assert.equal(controlModeActionOf({action: 'enter'}), 'enter');
    assert.equal(controlModeActionOf({action: 'ENTER'}), 'enter');
    assert.equal(controlModeActionOf({action: '进入'}), 'enter');
    assert.equal(controlModeActionOf({action: 'exit'}), 'exit');
    assert.equal(controlModeActionOf({action: 'off'}), 'exit');
    assert.equal(controlModeActionOf({action: '退出'}), 'exit');
    assert.equal(controlModeActionOf({action: 'status'}), 'status');
    assert.equal(controlModeActionOf({action: 'wat'}), '');
    assert.equal(controlModeActionOf(null), '');
});

test('会话启用判定：只看 session.desktopEnabled，不做应用级单飞', () => {
    const {ctl} = makeCtl();
    const a = session('a');
    const b = session('b', {desktopEnabled: true});
    assert.equal(ctl.enabledOn(a), false);
    assert.equal(ctl.enabledOn(b), true);
    assert.equal(ctl.enabledOn(null), false);
    // 多个会话可以同时启用（会话字段各自独立，模块不持有任何全局授权）
    const c = session('c', {desktopEnabled: true});
    assert.equal(ctl.enabledOn(c), true);
    assert.equal(ctl.enabledOn(b), true);
});

test('进入控制模式：未启用拒绝；未安装拒绝；成功后 activeOn 为真且注入白名单工具', () => {
    const {ctl, changes} = makeCtl();
    const s = session('s1');
    assert.equal(ctl.activeOn(s), false);
    assert.deepEqual(ctl.defsForSession(s), []);

    // 未启用
    const denied = ctl.enter(s, '试一下');
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'not-enabled');

    // 已启用但桌面 server 没有注册工具（未安装 / 未启动）
    const empty = makeCtl([]);
    const s2 = session('s2', {desktopEnabled: true});
    const noTools = empty.ctl.enter(s2, '');
    assert.equal(noTools.ok, false);
    assert.equal(noTools.reason, 'not-installed');

    // 正常进入
    s.desktopEnabled = true;
    const ok = ctl.enter(s, '在记事本里输入配置');
    assert.equal(ok.ok, true);
    assert.equal(ok.already, false);
    assert.deepEqual(ok.tools, ['mcp__windows__Snapshot', 'mcp__windows__Click']);
    assert.equal(ctl.activeOn(s), true);
    assert.deepEqual(ctl.activeInfo(s).reason, '在记事本里输入配置');
    assert.equal(ctl.defsForSession(s).length, 2);
    assert.deepEqual(changes, ['s1']);

    // 重复进入幂等（不再触发回调、不再重复算「刚进入」）
    const again = ctl.enter(s, '');
    assert.equal(again.already, true);
    assert.deepEqual(changes, ['s1']);
});

test('退出控制模式：幂等、不审批；退出后工具立刻移除；会通知面板', () => {
    const {ctl, changes} = makeCtl();
    const s = session('s1', {desktopEnabled: true});
    ctl.enter(s, '');
    const out = ctl.exit(s);
    assert.equal(out.ok, true);
    assert.equal(out.wasActive, true);
    assert.equal(ctl.activeOn(s), false);
    assert.deepEqual(ctl.defsForSession(s), []);
    assert.deepEqual(changes, ['s1', 's1']);
    // 再退一次：不报错、不重复通知
    const twice = ctl.exit(s);
    assert.equal(twice.wasActive, false);
    assert.deepEqual(changes, ['s1', 's1']);
});

test('控制模式按会话隔离：A 处于控制模式不影响 B；clearSession 收尾', () => {
    const {ctl} = makeCtl();
    const a = session('a', {desktopEnabled: true});
    const b = session('b', {desktopEnabled: true});
    ctl.enter(a, '');
    assert.equal(ctl.activeOn(a), true);
    assert.equal(ctl.activeOn(b), false);
    assert.deepEqual(ctl.defsForSession(b), []);
    assert.deepEqual(ctl.snapshot().sessions, ['a']);
    ctl.clearSession('a');
    assert.equal(ctl.activeOn(a), false);
    assert.deepEqual(ctl.snapshot().sessions, []);
});

test('installedCount：只数 windows server 的工具（外部工具页开关的可用性判定）', () => {
    const mixed = defs(['Snapshot']).concat([
        {name: 'mcp__tts__speak', mcpServer: 'tts_local', description: 'x', parameters: {}},
        {name: 'mcp__ocr__read', mcpServer: 'ocr_windows', description: 'y', parameters: {}},
    ]);
    const {ctl} = makeCtl(mixed);
    assert.equal(ctl.installedCount(), 1);
    assert.equal(makeCtl([]).ctl.installedCount(), 0);
});

test('desktopServerConfigRow：一步到位（enabled + 白名单勾选）+ uvx + 超时放宽 + notes ≤1000', () => {
    const row = desktopServerConfigRow();
    assert.equal(row.command, 'uvx');
    // --no-control（2026-11-22 实机裁决）：上游 --control 的 LL 键鼠钩子会吞系统组合键
    assert.deepEqual(row.args, ['windows-mcp@0.8.9', 'serve', '--tools', DESKTOP_TOOLS_WHITELIST.join(','), '--no-control']);
    // 新契约：安装即用（旧形态是 enabled:false + 空勾选，装完还要用户手动勾）
    assert.equal(row.enabled, true);
    assert.deepEqual(row.enabledTools, DESKTOP_TOOLS_WHITELIST);
    // uvx 首跑要下载解释器与依赖：启动超时必须放宽（默认 30s 会失败；600000 是 Go 侧上限）
    assert.equal(row.startupTimeoutMs, 600000);
    assert.ok(row.env.ANONYMIZED_TELEMETRY === 'false');
    assert.ok(row.notes.length <= 1000, 'notes 超过 ValidateServer 的 1000 字上限');
    assert.match(row.notes, /windows_control_mode/, 'notes 要告诉模型任务结束时退出控制模式');
    // 白名单口径：无 Screenshot（图像通道缺失），无高危组
    assert.ok(DESKTOP_TOOLS_WHITELIST.includes('Snapshot'));
    for (const bad of ['Screenshot', 'Registry', 'Process', 'App', 'PowerShell', 'FileSystem']) {
        assert.ok(!DESKTOP_TOOLS_WHITELIST.includes(bad), bad + ' 不应在桌面白名单里');
    }
    // env / enabledTools 都是拷贝不是共享引用
    row.env.WINDOWS_MCP_MAX_TREE_ELEMENTS = '999';
    row.enabledTools.push('Screenshot');
    assert.equal(desktopServerConfigRow().env.WINDOWS_MCP_MAX_TREE_ELEMENTS, '500');
    assert.deepEqual(desktopServerConfigRow().enabledTools, DESKTOP_TOOLS_WHITELIST);
});
