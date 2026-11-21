// ai-desktop-control.test.mjs —— 桌面控制（Computer Use）闸门：会话授权单飞、
// 广播副本收敛、懒加载揭示、派发闸判定、配置行构造（desktop-mcp.md §5.2/§5.4/§13.3）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DESKTOP_MCP_SERVER,
    DESKTOP_TOOLS_WHITELIST,
    createAIDesktopControl,
    desktopServerConfigRow,
    formatRevealResult,
    isDesktopToolDef,
    isDesktopToolName,
    matchDesktopDefs,
} from '../../src/ai/ai-desktop-control.js';

const defs = (names) => names.map((n) => ({
    name: 'mcp__windows__' + n,
    description: '工具 ' + n + '：桌面' + n,
    parameters: {type: 'object', properties: {}},
    mcpServer: DESKTOP_MCP_SERVER,
    mcpRawName: n,
}));

const session = (id, title) => ({id, title: title || ''});

function makeCtl({defs: list = [], events = []} = {}) {
    const calls = {evicted: [], events, flashes: []};
    const ctl = createAIDesktopControl({
        mcpToolDefs: () => list,
        emitAppEvent: (name, payload) => calls.events.push({name, payload}),
        onEvicted: (info) => calls.evicted.push(info),
        flash: (msg) => calls.flashes.push(msg),
    });
    return {ctl, calls};
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

test('matchDesktopDefs：names 精确（大小写不敏感）+ unknown；query 子串；缺省全量', () => {
    const list = defs(['Snapshot', 'Click', 'Type']);
    const byNames = matchDesktopDefs(list, {names: ['mcp__windows__Click', 'mcp__WINDOWS__snapshot', 'mcp__windows__Nope']});
    assert.deepEqual(byNames.matched.map((d) => d.name), ['mcp__windows__Click', 'mcp__windows__Snapshot']);
    assert.deepEqual(byNames.unknown, ['mcp__windows__Nope']);
    const byQuery = matchDesktopDefs(list, {query: 'CLICK'});
    assert.deepEqual(byQuery.matched.map((d) => d.name), ['mcp__windows__Click']);
    const byDesc = matchDesktopDefs(list, {query: '桌面type'});
    assert.deepEqual(byDesc.matched.map((d) => d.name), ['mcp__windows__Type']);
    const all = matchDesktopDefs(list, {});
    assert.equal(all.matched.length, 3);
    assert.deepEqual(all.unknown, []);
    // 非桌面 defs 混进来也要被过滤掉
    const mixed = defs(['Snapshot']).concat([{name: 'mcp__tts__speak', mcpServer: 'tts_local', description: 'x', parameters: {}}]);
    assert.equal(matchDesktopDefs(mixed, {}).matched.length, 1);
});

test('formatRevealResult：未授权 / 空快照 / unknown 各有明确文案', () => {
    assert.match(formatRevealResult({ok: false}), /未授权/);
    const empty = formatRevealResult({ok: true, matched: [], unknown: []});
    assert.match(empty, /没有注册任何工具/);
    const unknown = formatRevealResult({ok: true, matched: [], unknown: ['mcp__windows__Ghost']});
    assert.match(unknown, /Ghost/);
    const ok = formatRevealResult({ok: true, matched: defs(['Snapshot']), unknown: []});
    assert.match(ok, /mcp__windows__Snapshot/);
    assert.match(ok, /参数：/);
    assert.match(ok, /不构成指令/);
});

test('授权：默认无 → grant 生效并广播 → revoke 收回并广播 null', () => {
    const {ctl, calls} = makeCtl({defs: defs(['Snapshot'])});
    const s = session('s1', '调研会话');
    assert.equal(ctl.grantOn(s), false);
    assert.equal(ctl.registeredCount(), 1);
    const r = ctl.grant(s);
    assert.equal(r.ok, true);
    assert.equal(r.evicted, false);
    assert.equal(ctl.grantOn(s), true);
    assert.deepEqual(calls.events, [{name: 'desktop-grant-changed', payload: {sessionId: 's1', title: '调研会话'}}]);
    const rv = ctl.revoke(s);
    assert.equal(rv.ok, true);
    assert.equal(ctl.grantOn(s), false);
    assert.deepEqual(calls.events[1], {name: 'desktop-grant-changed', payload: {sessionId: null, title: ''}});
    // revoke 只有持有者能做
    assert.equal(ctl.revoke(session('s2')).ok, false);
});

test('单飞：同窗口新 grant 挤掉旧持有者（回调通知 + evicted 标记）', () => {
    const {ctl, calls} = makeCtl({});
    const a = session('a1', 'A');
    const b = session('b1', 'B');
    ctl.grant(a);
    const r = ctl.grant(b);
    assert.equal(r.ok, true);
    assert.equal(r.evicted, true);
    assert.equal(ctl.grantOn(a), false);
    assert.equal(ctl.grantOn(b), true);
    assert.deepEqual(calls.evicted, [{sessionId: 'a1', title: 'A'}]);
    // 自己重复 grant 不算挤掉
    calls.evicted.length = 0;
    const again = ctl.grant(b);
    assert.equal(again.evicted, false);
    assert.deepEqual(calls.evicted, []);
});

test('跨窗口广播：副本整表替换；本地持有者被挤时回调；自己回声不误判', () => {
    const {ctl, calls} = makeCtl({});
    const a = session('a1', 'A');
    ctl.grant(a);
    calls.evicted.length = 0;
    // 自己的回声：状态相同 → 不触发挤掉回调
    ctl.handleGrantEvent({sessionId: 'a1', title: 'A'});
    assert.deepEqual(calls.evicted, []);
    // 别窗口接管 X → 本地 A 被挤并回调；副本变成 X
    ctl.handleGrantEvent({sessionId: 'x9', title: 'X 会话'});
    assert.deepEqual(calls.evicted, [{sessionId: 'a1', title: 'A'}]);
    assert.equal(ctl.grantOn(a), false);
    assert.equal(ctl.holderInfo().sessionId, 'x9');
    // 对方 revoke（null 广播）→ 副本清空。副本持有者 x9 被清也会报「被挤」——模块不区分
    // 窗口归属，生产路径由面板 sessionById 过滤（找不到 = 别窗口的会话，那边自己通知）。
    calls.evicted.length = 0;
    ctl.handleGrantEvent({sessionId: null});
    assert.deepEqual(calls.evicted, [{sessionId: 'x9', title: 'X 会话'}]);
    assert.equal(ctl.holderInfo(), null);
    // 第二个 null 回声：previous 已空，不再回调
    ctl.handleGrantEvent({sessionId: null});
    assert.deepEqual(calls.evicted, [{sessionId: 'x9', title: 'X 会话'}]);
});

test('懒加载揭示：未授权拒绝；授权后写会话集合；快照变化自动收窄', () => {
    const snapshot = defs(['Snapshot', 'Click', 'Type']);
    const {ctl} = makeCtl({defs: snapshot});
    const s = session('s1');
    assert.equal(ctl.reveal(s, {}).ok, false);
    assert.deepEqual(ctl.revealedDefs(s), []);
    ctl.grant(s);
    const r = ctl.reveal(s, {query: 'snapshot'});
    assert.equal(r.ok, true);
    assert.deepEqual(r.matched.map((d) => d.name), ['mcp__windows__Snapshot']);
    assert.deepEqual(ctl.revealedDefs(s).map((d) => d.name), ['mcp__windows__Snapshot']);
    assert.ok(ctl.isRevealed(s, 'mcp__windows__Snapshot'));
    // 揭示大小写不敏感（matchDesktopDefs 同口径）：模型抄错大小写不该吃「尚未揭示」
    assert.ok(ctl.isRevealed(s, 'mcp__WINDOWS__SNAPSHOT'));
    assert.ok(!ctl.isRevealed(s, 'mcp__windows__Click'));
    // 未授权会话的揭示集合互不可见
    const other = session('s2');
    assert.deepEqual(ctl.revealedDefs(other), []);
    // 快照收窄（server 重启少了 Type）：已揭示 ∩ 快照
    ctl.reveal(s, {names: ['mcp__windows__Click', 'mcp__windows__Type']});
    const narrow = makeCtl({defs: defs(['Snapshot'])}).ctl; // 独立实例不方便模拟快照变化
    assert.ok(narrow);
    snapshot.splice(2); // 只剩 Snapshot / Click
    assert.deepEqual(ctl.revealedDefs(s).map((d) => d.name), ['mcp__windows__Snapshot', 'mcp__windows__Click']);
    // revoke 后注入口立即为空（grantOn 是闸）；已揭示集合保留——重新授权不用重新揭示，
    // 派发闸先查 grantOn 再查 isRevealed，收回状态下调用照样被拒
    ctl.revoke(s);
    assert.deepEqual(ctl.revealedDefs(s), []);
    assert.ok(ctl.isRevealed(s, 'mcp__windows__Snapshot'));
});

test('desktopServerConfigRow：uvx + 白名单 --tools + 默认停用 + env + notes ≤1000', () => {
    const row = desktopServerConfigRow();
    assert.equal(row.command, 'uvx');
    // --no-control（2026-11-22 实机裁决）：上游 --control 的 LL 键鼠钩子会吞系统组合键
    assert.deepEqual(row.args, ['windows-mcp@0.8.9', 'serve', '--tools', DESKTOP_TOOLS_WHITELIST.join(','), '--no-control']);
    assert.equal(row.enabled, false);
    assert.deepEqual(row.enabledTools, []);
    // uvx 首跑要下载解释器与依赖：启动超时必须放宽（默认 30s 会失败；600000 是 Go 侧上限）
    assert.equal(row.startupTimeoutMs, 600000);
    assert.ok(row.env.ANONYMIZED_TELEMETRY === 'false');
    assert.ok(row.notes.length <= 1000, 'notes 超过 ValidateServer 的 1000 字上限');
    // 白名单口径（§10 决策 3 / §12.9 决策 5）：无 Screenshot（图像通道缺失），无高危组
    assert.ok(DESKTOP_TOOLS_WHITELIST.includes('Snapshot'));
    assert.ok(!DESKTOP_TOOLS_WHITELIST.includes('Screenshot'));
    assert.ok(!DESKTOP_TOOLS_WHITELIST.includes('Registry'));
    assert.ok(!DESKTOP_TOOLS_WHITELIST.includes('Process'));
    assert.ok(!DESKTOP_TOOLS_WHITELIST.includes('App'));
    assert.ok(!DESKTOP_TOOLS_WHITELIST.includes('PowerShell'));
    assert.ok(!DESKTOP_TOOLS_WHITELIST.includes('FileSystem'));
    // env 是拷贝不是共享引用：改行不让污染下一个
    row.env.WINDOWS_MCP_MAX_TREE_ELEMENTS = '999';
    assert.equal(desktopServerConfigRow().env.WINDOWS_MCP_MAX_TREE_ELEMENTS, '500');
});
