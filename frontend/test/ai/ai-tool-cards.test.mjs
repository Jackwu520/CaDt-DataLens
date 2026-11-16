// ai-tool-cards 纯函数测试：流式工具卡的增量摘要（liveToolSummary）、占位行顺序对齐、spinner CSS 接线、
// 「已停止但还在转」的运行态口径。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {liveToolSummary, liveToolParts, planLiveRowOrder, toolIsLive} from '../../src/ai/ai-tool-cards.js';

test('liveToolSummary：能从未闭合的参数 JSON 里捞出 path 与已接收体积', () => {
    // write_file 流式中途：content 字符串尚未闭合，path 已完整
    const partial = '{"path":"docs/笔记.md","content":"# 标题\\n正文第一段';
    const text = liveToolSummary(partial);
    assert.match(text, /^docs\/笔记\.md · 参数接收中 \d+(\.\d+)? (B|KB)$/);
    // 完整 JSON 也能取 path
    assert.match(liveToolSummary('{"path":"a/b.json","content":"{}"}'), /^a\/b\.json · /);
});

test('liveToolSummary：无 path 时只报体积；空参数报 0 B', () => {
    assert.equal(liveToolSummary('{"command":"git status"}'), '参数接收中 24 B');
    assert.equal(liveToolSummary(''), '参数接收中 0 B');
    assert.equal(liveToolSummary(null), '参数接收中 0 B');
    // 超过 1 KB 换算成 KB 显示
    const big = 'x'.repeat(2048);
    assert.match(liveToolSummary(big), /参数接收中 2\.0 KB$/);
});

test('liveToolSummary：path 含转义字符且未闭合时退回原文显示', () => {
    // \" 被截断在反斜杠处：JSON.parse 会失败，退回原文（不抛异常）
    const tricky = '{"path":"a\\\\b\\';
    const text = liveToolSummary(tricky);
    assert.match(text, /参数接收中 \d+ B$/);
});

test('liveToolParts：拆出文件名 / 目录 / 已接收体积与 content-so-far', () => {
    const partial = '{"path":"frontend/src/ai/ai-classifier-verdict.js","content":"// 注释\nexport function foo() {\n  return 1;';
    const parts = liveToolParts(partial);
    assert.equal(parts.name, 'ai-classifier-verdict.js');
    assert.equal(parts.dir, 'frontend/src/ai');
    assert.equal(parts.path, 'frontend/src/ai/ai-classifier-verdict.js');
    assert.match(parts.size, /^(\d+(\.\d+)? (B|KB))$/);
    // 未闭合的 content 字面量解码：\n 换行可用，截断处原文保留
    assert.equal(parts.content, '// 注释\nexport function foo() {\n  return 1;');
});

test('liveToolParts：Windows 反斜杠路径与无 path 场景', () => {
    const win = liveToolParts('{"path":"D:\\data\\样本.json","content":"{}"}');
    assert.equal(win.name, '样本.json');
    assert.equal(win.dir, 'D:\\data');
    const none = liveToolParts('{"command":"git status"}');
    assert.equal(none.path, '');
    assert.equal(none.name, '');
    assert.equal(none.content, null);
    assert.match(none.size, /^\d+ B$/);
});

test('liveToolParts：content 中途截断在转义序列上不抛异常', () => {
    // content 值以 \u 截断：decode 截掉悬空反斜杠后仍可能 parse 失败 → 退回手写替换
    const tricky = liveToolParts('{"path":"a.md","content":"x\\u00e9\\u0');
    assert.ok(typeof tricky.content === 'string');
});

test('planLiveRowOrder：顺序不变时零 DOM 操作（spinner 不会每帧回弹）', () => {
    const a = {id: 'a'}, b = {id: 'b'}, c = {id: 'c'};
    const same = planLiveRowOrder([a, b], [a, b]);
    assert.deepEqual(same.moves, [], '顺序没变却要移动节点 → 会重启 ::before 动画');
    assert.equal(same.trim, 0);
    assert.deepEqual(same.final, [a, b]);
    // 追加新行：只动新位置，已有行保持原位
    const add = planLiveRowOrder([a], [a, b]);
    assert.deepEqual(add.moves, [1]);
    assert.equal(add.trim, 0);
    assert.deepEqual(add.final, [a, b]);
    // 删除行：只裁尾部，不移动保留下来的行
    const del = planLiveRowOrder([a, b], [b]);
    assert.deepEqual(del.final, [b]);
    assert.equal(del.trim, 1);
    // 换序 / 反序：最小移动且最终顺序正确
    const swap = planLiveRowOrder([a, b], [b, a]);
    assert.deepEqual(swap.final, [b, a]);
    assert.ok(swap.moves.length <= 1);
    const rev = planLiveRowOrder([a, b, c], [c, b, a]);
    assert.deepEqual(rev.final, [c, b, a]);
    assert.equal(rev.trim, 0);
});

test('spinner 相位接线：CSS 周期与 JS 常量一致，且接受 --ai-spin-phase', () => {
    const css = readFileSync(new URL('../../src/style.css', import.meta.url), 'utf8');
    const rule = css.match(/\.ai-tool-spinner::before\s*\{[^}]*\}/);
    assert.ok(rule, '找不到 .ai-tool-spinner::before 规则');
    assert.match(rule[0], /animation:\s*ai-todo-spin\s+0\.9s/, '周期须与 AI_SPIN_MS = 900 同步');
    assert.match(rule[0], /animation-delay:\s*var\(--ai-spin-phase/, '负 delay 变量不能丢，否则重建仍会回弹');
});

test('toolIsLive：interrupted 是终止态最高优先级（「已停止」的卡片不许再算运行中）', () => {
    // 用户停止时先落 interrupted，status 可能被迟到的审批/分类器回调改回 running：
    // 只看 status 会让 spinner 继续转、正文继续写「执行中…」，与头部「已停止」自相矛盾。
    assert.equal(toolIsLive({status: 'running', interrupted: true}), false);
    assert.equal(toolIsLive({status: 'running'}), true);
    assert.equal(toolIsLive({status: 'pending', interrupted: true}), false);
    assert.equal(toolIsLive({status: 'done'}), false);
    assert.equal(toolIsLive({status: 'error', interrupted: true}), false);
    assert.equal(toolIsLive(null), false);
});

test('工具卡渲染统一走 toolIsLive：不再用裸 status === \'running\' 判定运行态', () => {
    const src = readFileSync(new URL('../../src/ai/ai-tool-cards.js', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export function createAIToolCards'));
    assert.ok(body.length > 1000, 'createAIToolCards 源码切片失效');
    assert.match(body, /const live = toolIsLive\(message\)/, 'renderToolMessage 必须先算一次 live');
    assert.equal(
        /message\.status\s*===\s*'running'/.test(body),
        false,
        'spinner / 「执行中…」/ 卡片状态色都要走 toolIsLive，否则停止后仍会转圈',
    );
});

test('停止闸门接线：审批 / 分类器回调不许把已停止的卡片点回 running', () => {
    const panel = readFileSync(new URL('../../src/ai/ai-panel.js', import.meta.url), 'utf8');
    assert.match(panel, /function toolHalted\(toolMessage\)/, '缺少 toolHalted 单一判定');
    // 自动放行、人工裁定、审批弹窗、run_command、background_command、写入、补丁：每处 await 之后都要查
    const guards = panel.match(/toolHalted\(/g) || [];
    assert.ok(guards.length >= 6, '停止闸门覆盖不足（只有 ' + guards.length + ' 处）');
    assert.match(panel, /if \(toolHalted\(ctx\.toolMessage\)\) return '用户已停止生成，命令未执行。'/, 'run_command 审批后必须停手');
    assert.match(panel, /function settleInterruptedTool\(/, '结束后仍停在 running 的卡片需要收口兜底');
});

test('liveToolParts：edit_file 的 old_string（闭合才算完整）与 new_string-so-far', () => {
    // old_string 已闭合、new_string 还在流式接收
    const streaming = liveToolParts('{"path":"a.js","old_string":"const a = 1;\nconst b = 2;","new_string":"const a = 1;\nconst b = 2;\nconst c = 3;');
    assert.equal(streaming.oldString, 'const a = 1;\nconst b = 2;');
    assert.equal(streaming.newString, 'const a = 1;\nconst b = 2;\nconst c = 3;');
    // 两个都闭合（new_string 未闭合正则照样能取完整值）
    const done = liveToolParts('{"path":"a.js","old_string":"x","new_string":"y"}');
    assert.equal(done.oldString, 'x');
    assert.equal(done.newString, 'y');
    // old_string 尚未闭合 → null（不产出 ± 统计的信号）
    const oldStreaming = liveToolParts('{"path":"a.js","old_string":"const a =');
    assert.equal(oldStreaming.oldString, null);
    assert.equal(oldStreaming.newString, null);
    // 无 edit 字段的工具不受影响
    assert.equal(liveToolParts('{"command":"git status"}').oldString, null);
});

test('审批正文：读类审批（无 added/removed）不渲染 ± 统计，避免出现 +undefined', () => {
    const src = readFileSync(new URL('../../src/ai/ai-tool-cards.js', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('function renderApprovalBody'));
    assert.ok(body.length > 100, 'renderApprovalBody 源码切片失效');
    // ± 统计必须有 added/removed 门卫（与工具卡头部统计同一判定）：read 审批
    // （read_file / 列目录 / 搜索起点）没有 diff 数字，直接拼会出「+undefined −undefined」
    assert.match(
        body,
        /if \(approval\.added \|\| approval\.removed\) \{\s*const stat = document\.createElement/,
        '审批 meta 的 ± 统计缺少 added/removed 门卫',
    );
    // 读类审批收尾文案按读取措辞，不写「已应用更改」
    assert.match(body, /readKind \? '已授权读取'/, '读类审批收尾文案应按读取措辞');
});
