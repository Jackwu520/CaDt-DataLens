// 轮次过程折叠的结构护栏：一轮只能有一条折叠条（一个头 + 一个折叠状态）。
//
// 背景：过程内容会按「已回答的提问卡」切成多段以守住时间序，但提问卡是折叠区外的整卡，
// 它只该把 body 隔开，不该切出第二个开关。2026-11-17 前是「每段一个 .ai-process 头」，
// 结果同一轮里「已完成 · 用时 13 分 9 秒」重复出现三次，看起来像跑了三轮。
//
// 这些不变量写在渲染函数里（renderTurn 依赖 DOM 与后端，无法直接单测），所以按项目惯例
// 用源码断言钉住，改动时先确认是不是真的要拆掉它们：
//   R1 折叠状态 key 不带段号（带段号就等于每段一个开关）
//   R2 折叠头只在 isFoldHead 段创建，续段只出无头 body 容器
//   R3 点头后同一轮所有段同步开合
//   R4 续段收起时不占位（否则空容器把卡片间距翻倍）
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function read(rel) {
    return readFileSync(join(SRC, rel), 'utf8');
}

test('轮次折叠：key 只到轮，段号不进折叠状态', () => {
    const panel = read('ai/ai-panel.js');
    assert.ok(!/\+\s*':s'\s*\+\s*segIndex/.test(panel),
        '折叠状态 key 不许再拼段号——那一轮就会按段数长出多个独立开关');
    assert.match(panel, /const turnFoldKey = session\.id \+ ':' \+ \(group\.user \? 'u' \+ group\.user\.ts : 'g' \+ group\.startIndex\)/);
    // 同一个 key 同时用于状态记忆、DOM 标记与点击同步
    assert.match(panel, /const key = turnFoldKey;/);
});

test('轮次折叠：折叠头只在首个可渲染段创建', () => {
    const panel = read('ai/ai-panel.js');
    assert.match(panel, /const foldHeadIndex = segments\.findIndex\(\(seg, idx\) => !seg\.ask && segRenderable\(seg, idx\)\)/);
    // head 的创建必须在 isFoldHead 分支里，续段只挂 body
    const headBlock = panel.match(/if \(isFoldHead\) \{[\s\S]*?fold\.appendChild\(head\);\s*\}/);
    assert.ok(headBlock, '折叠头应当被 isFoldHead 包住');
    assert.match(headBlock[0], /className = 'ai-process-head'/);
    // 续段靠 cont 类区分：无头、共享同一个开合状态
    assert.match(panel, /\(isFoldHead \? '' : ' cont'\)/);
});

test('轮次折叠：点头同步同一轮所有段', () => {
    const panel = read('ai/ai-panel.js');
    assert.match(panel, /for \(const node of host\.querySelectorAll\('\.ai-process'\)\) \{/);
    assert.match(panel, /if \(node\.dataset\.processKey === key\) node\.classList\.toggle\('collapsed', !next\)/);
    // 展开时每个段各自的懒建 body 都要补上（各段 ensureBody 是独立闭包）
    assert.match(panel, /segEnsureBody\.push\(ensureBody\)/);
    assert.match(panel, /if \(next\) segEnsureBody\.forEach\(\(fn\) => fn\(\)\)/);
});

test('轮次折叠：续段收起不占位，展开与首段同缩进', () => {
    const css = read('style.css');
    assert.match(css, /\.ai-process\.cont\.collapsed \{ display: none; \}/);
    assert.match(css, /\.ai-process\.cont > \.ai-process-body \{ margin-top: 0; \}/);
});

test('分支会话：标题派生自母会话，不留成「新会话」', () => {
    const panel = read('ai/ai-panel.js');
    const start = panel.indexOf('function branchSessionAt');
    const block = panel.slice(start, panel.indexOf('function editLast', start));
    assert.ok(block.length > 100, 'branchSessionAt 源码切片失效');
    // 派生标题必须真的传给 createSessionData，而不是再调一次空的
    assert.match(block, /createSessionData\(sourceTitle \? '分支 · ' \+ sourceTitle : '分支'\)/,
        '分支标题须带上母会话标题，母会话无标题时退化为「分支」');
    // 占位标题（新会话 / 会话）不能派生出「分支 - 新会话」这种无意义标题
    assert.match(block, /source\.title !== '新会话' && source\.title !== '会话'/);
});

test('消息操作栏：纯图标按钮必须挂 data-tip，否则悬停无气泡', () => {
    const panel = read('ai/ai-panel.js');
    const append = panel.slice(panel.indexOf('function appendActions'));
    assert.ok(append.length > 100, 'appendActions 源码切片失效');
    const addFn = append.match(/const add = \(act, label, disabled\) => \{[\s\S]*?\n        \};/);
    assert.ok(addFn, '找不到 appendActions 里的 add() 按钮工厂');
    // tooltip 运行时只认 data-tip；只设 aria-label 不会弹气泡（2026-11-17 用户反馈「分不清按钮干啥的」）
    assert.match(addFn[0], /button\.dataset\.tip = label/, 'add() 必须把 label 同时写进 data-tip');
    // 文案与无障碍名同源：两处都还留着，别顾此失彼
    assert.match(addFn[0], /setAttribute\('aria-label', label\)/, '无障碍名不能因为加了 tooltip 就丢');
});
