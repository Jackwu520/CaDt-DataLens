import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSessionOutlineItems} from '../../src/ai/session-outline.js';

// 会话结构（用户消息定位条）的数据整理规则：
// 只留用户说过的消息，轮次序号连续，超长文本压成一行，条数超上限只保留最近的。

test('只保留用户消息，系统注记 / 静默注入 / 应用注入 / 模型切换都不算一轮', () => {
    const messages = [
        {role: 'user', content: '第一条'},
        {role: 'assistant', content: '好的'},
        {role: 'tool', content: 'tool output'},
        {role: 'user', content: '系统注记', systemNote: true},
        {role: 'user', content: '静默注入', silent: true},
        {role: 'user', content: '定时任务指令', app: {label: '定时任务'}},
        {role: 'user', content: '切换模型', kind: 'model-switch'},
        {role: 'user', content: '第二条'},
    ];
    const out = buildSessionOutlineItems(messages);
    assert.equal(out.total, 2);
    assert.deepEqual(out.items.map((item) => item.index), [0, 7]);
    assert.deepEqual(out.items.map((item) => item.round), [1, 2]);
    assert.deepEqual(out.items.map((item) => item.text), ['第一条', '第二条']);
    assert.equal(out.truncated, false);
});

test('换行与连续空白压成单行，空文本用图片数量兜底', () => {
    const out = buildSessionOutlineItems([
        {role: 'user', content: '第一行\n\n第二行\t结束'},
        {role: 'user', content: '', images: [{}, {}]},
    ]);
    assert.equal(out.items[0].text, '第一行 第二行 结束');
    assert.equal(out.items[1].text, '（2 张图片）');
});

test('剥掉开头的宿主环境块，只预览用户正文', () => {
    const content = '<system-reminder>\n<workspace_context>\n当前活动文件：a.js\n</workspace_context>\n</system-reminder>\n\n真的改了吗我怎么没看见';
    const out = buildSessionOutlineItems([{role: 'user', content}]);
    assert.equal(out.items[0].text, '真的改了吗我怎么没看见');
});

test('只有环境块的纯注入消息不占行，带图片/视频仍以数量兜底', () => {
    const reminder = '<system-reminder>\n<workspace_context>\n当前活动文件：a.js\n</workspace_context>\n</system-reminder>';
    const out = buildSessionOutlineItems([
        {role: 'user', content: reminder},
        {role: 'user', content: reminder, images: [{}, {}]},
        {role: 'user', content: reminder, videos: [{}]},
        {role: 'user', content: '正文'},
    ]);
    assert.equal(out.total, 3);
    assert.deepEqual(out.items.map((item) => item.index), [1, 2, 3]);
    assert.deepEqual(out.items.map((item) => item.round), [1, 2, 3]);
    assert.deepEqual(out.items.map((item) => item.text), ['（2 张图片）', '（1 个视频）', '正文']);
});

test('超过上限只保留最近若干轮，并标记 truncated', () => {
    const messages = [];
    for (let i = 0; i < 10; i += 1) messages.push({role: 'user', content: '第 ' + i + ' 轮'});
    const out = buildSessionOutlineItems(messages, {max: 3});
    assert.equal(out.total, 10);
    assert.equal(out.truncated, true);
    assert.equal(out.items.length, 3);
    assert.deepEqual(out.items.map((item) => item.text), ['第 7 轮', '第 8 轮', '第 9 轮']);
    // 序号仍按全量计算，不因截断从 1 重新开始
    assert.deepEqual(out.items.map((item) => item.round), [8, 9, 10]);
});

test('空会话与非法输入不报错', () => {
    assert.deepEqual(buildSessionOutlineItems([]).items, []);
    assert.deepEqual(buildSessionOutlineItems(null).items, []);
    assert.deepEqual(buildSessionOutlineItems(undefined).items, []);
    assert.equal(buildSessionOutlineItems([{role: 'user', content: 'x'}], {max: 0}).items.length, 1);
});

test('时间戳取 ts，缺失时退回 turnStartedAt', () => {
    const out = buildSessionOutlineItems([
        {role: 'user', content: 'a', ts: 100},
        {role: 'user', content: 'b', turnStartedAt: 200},
        {role: 'user', content: 'c'},
    ]);
    assert.deepEqual(out.items.map((item) => item.ts), [100, 200, 0]);
});
