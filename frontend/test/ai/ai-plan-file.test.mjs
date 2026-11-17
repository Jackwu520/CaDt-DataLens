// ai-plan-file 纯函数测试：计划文件命名 / 落盘判定 / 展示摘要。
// 重点锁住三件事：同一消息算出的路径必须稳定（重渲染与重启重放要指向同一文件）、
// 文件名不能出现 Windows 非法字符、非最终稿（工具轮 / 半成品）不得当计划落盘。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PLAN_DIR_REL,
    isPlanMessage,
    planDigest,
    planDisplayPath,
    planFileBody,
    planFileRelPath,
    planReferenceBlock,
    planSessionSlug,
    planSlug,
    planStamp,
    planTitleOf,
} from '../../src/ai/ai-plan-file.js';

const PLAN_TEXT = '# 计划: 补齐 AI 工具的三块短板（终端 / glob / 会话搜索）\n\n## 0. 现状事实\n\n- 内置终端后端\n';

test('planTitleOf 取首个 ATX 标题，退化到首行非空文本', () => {
    assert.equal(planTitleOf(PLAN_TEXT), '计划: 补齐 AI 工具的三块短板（终端 / glob / 会话搜索）');
    assert.equal(planTitleOf('先做 A，再做 B\n\n- 细节'), '先做 A，再做 B');
    assert.equal(planTitleOf('- 第一步：读代码'), '第一步：读代码');
    assert.equal(planTitleOf('   \n\n'), '');
    assert.equal(planTitleOf(null), '');
});

test('planSlug：去 Markdown 记号 + 剔除 Windows 非法字符 + 长度截断', () => {
    // 大小写保留（AI / glob 原样，便于人读文件名）
    assert.equal(planSlug(PLAN_TEXT), '计划-补齐-AI-工具的三块短板（终端-glob-会话搜索）');
    // 非法字符 / 强调记号 / 链接语法
    assert.equal(planSlug('# **a/b:c**\\d `e`'), 'a-b-c-d-e');
    assert.equal(planSlug('# [标题](https://example.com/x)'), '标题');
    // 空标题与保留设备名
    assert.equal(planSlug(''), 'plan');
    assert.equal(planSlug('#   '), 'plan');
    assert.equal(planSlug('# nul'), 'nul-plan');
    // 超长截断且不留尾随连字符
    const long = planSlug('# ' + 'a'.repeat(80));
    assert.equal(long.length, 40);
});

test('planStamp：本地时间秒级（只用于来源注释，不参与文件名）', () => {
    const ts = new Date(2026, 10, 16, 5, 23, 7).getTime();
    assert.equal(planStamp(ts), '20261116-052307');
});

test('planSessionSlug：清洗为文件名安全字符，空值回落 session', () => {
    assert.equal(planSessionSlug('abc-123'), 'abc-123');
    assert.equal(planSessionSlug('session:with/slashes'), 'session-with-slashes');
    assert.equal(planSessionSlug('  '), 'session');
    assert.equal(planSessionSlug(null), 'session');
    assert.equal(planSessionSlug('---'), 'session');
});

test('planFileRelPath：按会话固定路径（同会话永远覆盖同一份）', () => {
    const rel = planFileRelPath('sess_plan-1');
    assert.equal(rel, PLAN_DIR_REL + '/plan-sess_plan-1.md');
    // 同一会话算出同一路径（不随时间 / 标题漂移）
    assert.equal(planFileRelPath('sess_plan-1'), rel);
    assert.equal(planFileRelPath(''), PLAN_DIR_REL + '/plan-session.md');
});

test('planDisplayPath：绝对路径切出 .cadt/plan 一段，其它回落文件名', () => {
    assert.equal(planDisplayPath('D:\\ws\\.cadt\\plan\\20261116-052307-x.md'), '.cadt/plan/20261116-052307-x.md');
    assert.equal(planDisplayPath('/home/u/ws/.cadt/plan/a.md'), '.cadt/plan/a.md');
    assert.equal(planDisplayPath('D:\\ws\\notes\\a.md'), 'a.md');
    assert.equal(planDisplayPath(''), '');
});

test('planDigest：行数与去空白字数', () => {
    const d = planDigest(PLAN_TEXT);
    assert.equal(d.lines, 6);
    assert.equal(d.chars, PLAN_TEXT.replace(/\s+/g, '').length);
    assert.equal(planDigest('').lines, 0);
    assert.equal(planDigest('').chars, 0);
});

test('planFileBody：正文保留原文并附来源注释', () => {
    const body = planFileBody(PLAN_TEXT, {ts: new Date(2026, 10, 16, 5, 23, 7).getTime(), title: '会话 A', model: 'gpt-x'});
    assert.ok(body.startsWith('# 计划:'));
    assert.ok(body.includes('<!-- 计划由 CaDt-DataLens 生成 · 20261116-052307 · 会话「会话 A」 · gpt-x -->'));
    // 无元信息也要有换行收尾（否则文件末尾会和原文粘在一起）
    assert.ok(planFileBody('正文').endsWith('\n'));
});

test('isPlanMessage：只有计划模式的最终答复才算计划', () => {
    const base = {role: 'assistant', planMode: true, status: 'done', content: PLAN_TEXT, toolCalls: []};
    assert.equal(isPlanMessage(base), true);
    assert.equal(isPlanMessage({...base, planMode: false}), false, '非计划模式不落盘');
    assert.equal(isPlanMessage({...base, status: 'streaming'}), false, '流式中不落盘');
    assert.equal(isPlanMessage({...base, status: 'stopped'}), false, '用户停止的半成品不落盘');
    assert.equal(isPlanMessage({...base, status: 'error'}), false, '失败不落盘');
    assert.equal(isPlanMessage({...base, toolCalls: [{id: 'c', name: 'read_file', arguments: '{}'}]}), false,
        '带工具调用的中间轮不是计划');
    assert.equal(isPlanMessage({...base, content: '   '}), false, '空正文不落盘');
    assert.equal(isPlanMessage({role: 'user', planMode: true, status: 'done', content: 'x', toolCalls: []}), false);
    assert.equal(isPlanMessage(null), false);
});

function planMsg(content, planFile) {
    return {role: 'assistant', planMode: true, status: 'done', content, toolCalls: [], planFile: planFile || ''};
}

test('planReferenceBlock：未压缩（无 summary）不注入——计划全文还在历史里', () => {
    assert.equal(planReferenceBlock(null), '');
    assert.equal(planReferenceBlock({summary: null, messages: [planMsg(PLAN_TEXT)]}), '');
    assert.equal(planReferenceBlock({summary: {text: '  '}, messages: [planMsg(PLAN_TEXT)]}), '');
});

test('planReferenceBlock：压缩后注入最近一条计划（archived 与 messages 都搜）', () => {
    const session = {
        summary: {text: '摘要'},
        archived: [planMsg('# 旧计划\n内容 A', 'D:/ws/.cadt/plan/plan-s1.md')],
        messages: [{role: 'user', content: 'hi'}, planMsg('# 新计划\n内容 B')],
    };
    const block = planReferenceBlock(session);
    assert.ok(block.startsWith('<plan_reference>') && block.endsWith('</plan_reference>'));
    // 取的是最近一条（messages 里的新计划），不是 archived 里的旧计划
    assert.ok(block.includes('内容 B'));
    assert.ok(!block.includes('内容 A'));
    // 新计划未批准（无 planFile）→ 未落盘提示；旧计划的路径不能串进来
    assert.ok(block.includes('尚未保存为文件'));
    assert.ok(!block.includes('.cadt/plan/plan-s1.md'));
    assert.ok(block.includes('不要重新规划'));
});

test('planReferenceBlock：已批准计划带文件路径提示', () => {
    const session = {
        summary: {text: '摘要'},
        messages: [planMsg(PLAN_TEXT, 'D:/ws/.cadt/plan/plan-s2.md')],
    };
    const block = planReferenceBlock(session);
    assert.ok(block.includes('已保存到工作区文件：D:/ws/.cadt/plan/plan-s2.md'));
    assert.ok(block.includes(PLAN_TEXT));
});

test('isPlanMessage：submit_plan 形态（计划在 planText，正文可空、带 toolCalls）', () => {
    const submitted = {
        role: 'assistant', planMode: true, status: 'done', content: '', planText: PLAN_TEXT,
        toolCalls: [{id: 'c1', name: 'submit_plan', arguments: '{}'}],
    };
    assert.equal(isPlanMessage(submitted), true, 'planText 有值即计划消息');
    assert.equal(isPlanMessage({...submitted, status: 'streaming'}), false, '流式中不算');
    assert.equal(isPlanMessage({...submitted, planText: '  '}), false, '无 planText 且正文为空不算');
});

test('planReferenceBlock：submit_plan 形态优先用 planText 回注', () => {
    const session = {
        summary: {text: '摘要'},
        messages: [{
            role: 'assistant', planMode: true, status: 'done', content: '（计划已提交）',
            planText: '# 计划\n只读正文在参数里', planFile: 'D:/ws/.cadt/plan/plan-s3.md',
            toolCalls: [{id: 'c1', name: 'submit_plan', arguments: '{}'}],
        }],
    };
    const block = planReferenceBlock(session);
    assert.ok(block.includes('只读正文在参数里'), '回注的是 planText 而非对话正文');
    assert.ok(!block.includes('（计划已提交）'));
    assert.ok(block.includes('.cadt/plan/plan-s3.md'));
});

test('planReferenceBlock：压缩后没有计划消息则不注入', () => {
    const session = {
        summary: {text: '摘要'},
        archived: [{role: 'user', content: 'x'}],
        messages: [{role: 'assistant', planMode: true, status: 'stopped', content: '半成品', toolCalls: []}],
    };
    assert.equal(planReferenceBlock(session), '');
});
