// 子代理命令沙箱的接线护栏（方案 docs/unfinished-plans/subagent-sandbox.md）。
//
// 不变量：
//   P1 父权限档 → 沙箱档：edit 档不给写（子代理没有审批通道），full 档继承完全权限
//   P2 写根来源：隔离 worktree 的绝对路径优先，其次会话工作区；取不到就留空交给 Go
//      侧 fail-closed —— 绝不在这里悄悄降级成「不沙箱」
//   P3 主会话返回 null（主会话的边界是审批链，不是沙箱）
//   P4 子代理工具表挂 run_command，不挂 background_command（后台作业还没有沙箱版本）
//   P5 run_command 分支：沙箱时跳过审批、调 AIRunShellCommandConfined
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

import {subSandboxModeOf, subSandboxPolicy} from '../../src/ai/ai-subagents.js';
import {describeSandboxGrant, sandboxHasResidue, sandboxModeLabel} from '../../src/ai/ai-sandbox-grant.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function sourceOf(relPath) {
    return readFileSync(join(SRC, relPath), 'utf8');
}

// 截取一段源码：从 startMarker 起，到 endMarker 之前。
function sliceBetween(text, startMarker, endMarker) {
    const start = text.indexOf(startMarker);
    assert.ok(start >= 0, '找不到起始标记：' + startMarker);
    const end = endMarker ? text.indexOf(endMarker, start) : text.length;
    assert.ok(end > start, '找不到结束标记：' + endMarker);
    return text.slice(start, end);
}

test('P1 父权限档映射：edit 只读、auto 可写工作区、full 继承完全权限', () => {
    assert.equal(subSandboxModeOf('read'), 'read-only');
    assert.equal(subSandboxModeOf('edit'), 'read-only');
    assert.equal(subSandboxModeOf('auto'), 'workspace-write');
    assert.equal(subSandboxModeOf('full'), 'danger-full-access');
    // 未知 / 缺省档位一律按最窄处理
    assert.equal(subSandboxModeOf(undefined), 'read-only');
    assert.equal(subSandboxModeOf('yolo'), 'read-only');
});

test('P3 主会话不沙箱：没有 parentSessionId 就返回 null', () => {
    assert.equal(subSandboxPolicy(null), null);
    assert.equal(subSandboxPolicy({id: 'main', scope: 'auto', workspace: 'C:/ws'}), null);
});

test('P2 写根优先取隔离 worktree 的绝对路径', () => {
    const policy = subSandboxPolicy({
        id: 'sub-1',
        parentSessionId: 'main',
        scope: 'auto',
        workspace: 'C:/ws',
        worktree: {name: 'wt-a', path: 'C:/ws/.cadt/worktree/wt-a'},
    }, 'C:/fallback');
    assert.deepEqual(policy, {mode: 'workspace-write', workspaceRoot: 'C:/ws/.cadt/worktree/wt-a'});
});

test('P2 没有 worktree 时回落到会话工作区，再回落到范围根', () => {
    const byWorkspace = subSandboxPolicy({id: 'sub-1', parentSessionId: 'main', scope: 'auto', workspace: 'C:/ws'}, 'C:/fallback');
    assert.equal(byWorkspace.workspaceRoot, 'C:/ws');

    const byFallback = subSandboxPolicy({id: 'sub-1', parentSessionId: 'main', scope: 'auto'}, 'C:/fallback');
    assert.equal(byFallback.workspaceRoot, 'C:/fallback');
});

test('P2 三处都取不到根时留空（交给 Go 侧 fail-closed，不降级成不沙箱）', () => {
    const policy = subSandboxPolicy({id: 'sub-1', parentSessionId: 'main', scope: 'auto'}, '');
    assert.deepEqual(policy, {mode: 'workspace-write', workspaceRoot: ''});
});

test('P4 子代理工具表挂命令四件套（run / background / check / stop）', () => {
    const text = sourceOf('ai/ai-subagents.js');
    const tools = sliceBetween(text, 'function subToolsForScope(', 'function activeSubCount(');
    for (const name of ['run_command', 'background_command', 'check_command', 'stop_command']) {
        assert.ok(tools.includes('AI_TOOL_DEFS.' + name), '子代理必须能用 ' + name + '（沙箱档执行）');
    }
});

test('read_video 下发按会话视频能力裁剪，执行守卫用同一判定', () => {
    const src = sourceOf('ai/ai-subagents.js');
    const tools = sliceBetween(src, 'function subToolsForScope(', 'function activeSubCount(');
    assert.ok(tools.includes('videoCapableOf(session)'), '子代理 read_video 必须按会话视频能力注册');
    assert.ok(!/\[[^\]]*AI_TOOL_DEFS\.read_video[^\]]*\]/.test(tools),
        'read_video 不该在数组字面量里无条件注册，应按能力 splice');

    const panel = sourceOf('ai/ai-panel.js');
    const branch = sliceBetween(panel, "case 'read_video': {", "case 'search_text': {");
    assert.ok(branch.includes('videoCapableOf(session)'), 'read_video 执行守卫必须与下发同判定');
});

test('P6 background_command 分支：沙箱档走 AICommandStartConfined，且先过项目 deny 规则', () => {
    const text = sourceOf('ai/ai-panel.js');
    const branch = sliceBetween(text, "case 'background_command': {", "case 'check_command': {");

    assert.ok(branch.includes('subSandboxPolicy(ctx.session'), '后台命令也要按会话判定沙箱');
    const sandboxAt = branch.indexOf('if (sandbox) {');
    const elseAt = branch.indexOf('} else {');
    const approveAt = branch.indexOf('approveCommandForRun');
    assert.ok(sandboxAt >= 0 && elseAt > sandboxAt, '后台分支必须先判沙箱，再走 else 的审批链');
    assert.ok(approveAt > elseAt, '审批只能出现在非沙箱分支：子代理永远不问');
    assert.ok(!branch.slice(sandboxAt, elseAt).includes('approveCommandForRun'), '沙箱分支里不得出现审批');

    const denyAt = branch.indexOf('evaluatePermissionRules');
    const callAt = branch.indexOf('backend.AICommandStartConfined(');
    assert.ok(denyAt > 0 && callAt > denyAt, '沙箱分支必须先过项目 deny 规则，再起作业');
    assert.ok(branch.includes('job.sandboxMode'), '启动结果必须如实回显沙箱档位');
});

test('P7 留痕：沙箱拒绝 / 不可用各自成 status，主循环与子代理循环都按它记', () => {
    const panel = sourceOf('ai/ai-panel.js');
    assert.ok(panel.includes("activityStatus = 'sandbox-denied'"), '命令被沙箱拦住要标 sandbox-denied');
    assert.ok(panel.includes("activityStatus = 'sandbox-unavailable'"), '沙箱建不起来要标 sandbox-unavailable');
    assert.ok(panel.includes('const logStatus = toolMessage.activityStatus'),
        '主循环留痕必须让沙箱状态优先于 done/error');
    assert.ok(panel.includes('sandbox: toolMessage.sandbox'), '留痕要带沙箱档位');

    const sub = sourceOf('ai/ai-subagents.js');
    assert.ok(sub.includes('status: toolMessage.activityStatus ||'),
        '子代理工具循环也必须按沙箱状态留痕（子代理命令无人可问，留痕是唯一审计面）');
    assert.ok(sub.includes('sandbox: toolMessage.sandbox'), '子代理留痕同样带档位');

    // 字段名收口：activityStatus 是「留痕状态覆盖」，也承载作业归属拒绝（denied）——
    // 别退回沙箱专属命名，否则非沙箱的拒绝语义会无处安放。
    assert.ok(!panel.includes('sandboxStatus'), '不得残留 sandboxStatus 字段名');
    assert.ok(!sub.includes('sandboxStatus'), '不得残留 sandboxStatus 字段名');
});

test('P8 授权残留：文案如实列出三样痕迹，设置页有检查/清除入口', () => {
    const clean = {root: 'C:/ws', workspaceSid: 'S-1-4-1-2'};
    assert.equal(sandboxHasResidue(clean), false);
    assert.match(describeSandboxGrant(clean), /没有沙箱痕迹/);
    assert.equal(sandboxHasResidue(null), false);

    const all = {root: 'C:/ws', workspaceSid: 'S-1-4-1-2', granted: true, denyPresent: true, labeled: true};
    assert.equal(sandboxHasResidue(all), true);
    const text = describeSandboxGrant(all);
    assert.match(text, /写权授权/);
    assert.match(text, /删除子项 deny/);
    assert.match(text, /Low 完整性标签/);
    assert.match(text, /S-1-4-1-2/);

    // 只有其中一样也算残留（部分清理失败不能假装干净）
    assert.equal(sandboxHasResidue({root: 'C:/ws', labeled: true}), true);

    const settings = sourceOf('ai/ai-permission-settings.js');
    assert.ok(settings.includes('backend.SandboxScan('), '设置页要能检查残留');
    assert.ok(settings.includes('backend.SandboxRevoke('), '设置页要能清除授权');
});

test('P9 HUD 档位标签、后台拒绝分类与作业归属校验', () => {
    assert.equal(sandboxModeLabel('read-only'), '只读');
    assert.equal(sandboxModeLabel('workspace-write'), '可写');
    assert.equal(sandboxModeLabel('danger-full-access'), '完全');
    assert.equal(sandboxModeLabel('weird'), 'weird'); // 未知值原样回显，不猜

    const hud = sourceOf('ai/ai-head-hud.js');
    assert.ok(hud.includes('sandboxMode: sub.sandboxMode'), 'HUD 要读派出时定死的档位');
    assert.ok(hud.includes("'沙箱 ' + sandboxModeLabel(agent.sandboxMode)"), 'HUD 副标题要显示档位');

    const panel = sourceOf('ai/ai-panel.js');
    const check = sliceBetween(panel, "case 'check_command': {", "case 'stop_command': {");
    assert.ok(check.includes('st.sandboxDenied'), '后台作业的拒绝只能在轮询时分类');
    assert.ok(check.includes("ctx.toolMessage.activityStatus = 'sandbox-denied'"), '轮询到拒绝要留痕');

    const stop = sliceBetween(panel, "case 'stop_command': {", "case 'schedule_create': {");
    assert.ok(stop.includes('rootSessionIdOf(ctx.session)'), 'stop_command 必须校验作业归属，不能按 jobId 乱停');
});

test('P5 run_command 分支：沙箱时跳过审批并调 AIRunShellCommandConfined', () => {
    const text = sourceOf('ai/ai-panel.js');
    const branch = sliceBetween(text, "case 'run_command': {", "case 'background_command': {");

    assert.ok(branch.includes('subSandboxPolicy(ctx.session'), '分支必须按会话判定是否沙箱');
    const sandboxAt = branch.indexOf('if (sandbox) {');
    const elseAt = branch.indexOf('} else {');
    const approveAt = branch.indexOf('approveCommandForRun');
    assert.ok(sandboxAt >= 0 && elseAt > sandboxAt, '分支必须先判沙箱，再走 else 的审批链');
    assert.ok(approveAt > elseAt, '审批只能出现在「非沙箱」的 else 分支里：子代理永远不问');
    assert.ok(!branch.slice(sandboxAt, elseAt).includes('approveCommandForRun'), '沙箱分支里不得出现审批');
    assert.ok(branch.includes('AIRunShellCommandConfined('), '沙箱档必须走受限入口');
    assert.ok(branch.includes('result.sandboxMode'), '结果必须如实回显沙箱档位');

    // 项目 deny 规则是用户的明确禁令，不是「需要人判断」的事：子代理不弹审批，但仍须遵守。
    // 注意比对「调用点」（带括号），别被前面的能力探测 `!backend.AIRunShellCommandConfined` 命中。
    const denyAt = branch.indexOf('evaluatePermissionRules');
    const callAt = branch.indexOf('backend.AIRunShellCommandConfined(');
    assert.ok(denyAt > 0 && callAt > denyAt,
        '沙箱分支必须先过项目 deny 规则（只取 deny，不问、不跑分类器）');
});
