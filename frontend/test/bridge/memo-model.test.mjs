// memo-model 纯函数护栏：归一化（坏数据兜底 / 超限截断 / 状态枚举纠正）、
// 增删改移（上限报错、id 生成、自动建块、移动语义）与 AI 文本格式（id 可回溯）。
// 视图（bridge-todo-view）与 AI 工具共用这套函数，上限口径在这里统一卡。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
    MEMO_LIMITS,
    addBlock,
    addItem,
    attachImage,
    collectImageRefs,
    cycleStatus,
    defaultMemoData,
    exportMemoMarkdown,
    formatMemoForAI,
    findItem,
    moveItemToBlock,
    normalizeMemoData,
    parseMemoDoc,
    removeById,
    removeImageById,
    memoId,
    updateById,
} from '../../src/bridge/memo-model.js';

function sampleDoc() {
    const r1 = addBlock(defaultMemoData(), '阶段一');
    const r2 = addItem(r1.doc, r1.id, '实现 token 流');
    const r3 = addItem(r2.doc, r1.id, '修复转义 bug', {status: 'in_progress'});
    const r4 = addItem(r3.doc, r1.id, '写单元测试', {status: 'completed'});
    return r4;
}

test('normalizeMemoData：非对象输入回默认结构', () => {
    for (const bad of [null, undefined, 42, 'x', {}, {blocks: 'no'}]) {
        const doc = normalizeMemoData(bad);
        assert.deepEqual(doc, defaultMemoData());
    }
});

test('normalizeMemoData：补 id、纠状态、截断超限', () => {
    const longText = 'x'.repeat(MEMO_LIMITS.textMax + 100);
    const doc = normalizeMemoData({
        blocks: [
            {
                title: 't'.repeat(MEMO_LIMITS.blockTitleMax + 50),
                items: [
                    {text: longText, status: 'bogus', images: ['img/a.png', 42, null, 'img/b.png']},
                    {text: '第二条', status: 'completed', images: Array(20).fill('img/c.png')},
                ],
            },
            null,
            {items: Array(MEMO_LIMITS.itemsPerBlock + 5).fill({text: 'y'})},
        ],
    });
    assert.equal(doc.blocks.length, 2);
    const [b1, b2] = doc.blocks;
    assert.ok(b1.id.startsWith('blk-'));
    assert.equal(b1.title.length, MEMO_LIMITS.blockTitleMax);
    assert.equal(b1.items[0].status, 'pending');
    assert.equal(b1.items[0].text.length, MEMO_LIMITS.textMax);
    assert.deepEqual(b1.items[0].images, ['img/a.png', 'img/b.png']);
    assert.equal(b1.items[1].images.length, MEMO_LIMITS.imagesPerItem);
    assert.equal(b1.items[1].status, 'completed');
    assert.equal(b2.items.length, MEMO_LIMITS.itemsPerBlock);
});

test('parseMemoDoc：坏 JSON 不炸，回默认结构', () => {
    assert.deepEqual(parseMemoDoc('{broken'), defaultMemoData());
    assert.deepEqual(parseMemoDoc(''), defaultMemoData());
    assert.equal(parseMemoDoc('{"blocks":[{"title":"ok"}]}').blocks[0].title, 'ok');
});

test('addBlock / addItem：id 前缀、自动建块、上限报错', () => {
    const d = defaultMemoData();
    const a = addBlock(d, '');
    assert.ok(a.ok && a.id.startsWith('blk-'));
    assert.equal(a.doc.blocks[0].title, '新建分组');

    // 无块时加条目自动建「待办」块
    const b = addItem(d, '', '第一条');
    assert.ok(b.ok);
    assert.equal(b.doc.blocks[0].title, '便签');
    assert.ok(b.id.startsWith('it-'));
    assert.equal(b.blockId, b.doc.blocks[0].id);

    // 指定块加条目：position top
    const c = addItem(a.doc, a.id, '顶部条目', {position: 'top'});
    assert.equal(c.doc.blocks.find((x) => x.id === a.id).items[0].text, '顶部条目');

    // 找不到块报错；空文本报错
    assert.equal(addItem(a.doc, 'blk-none', 'x').ok, false);
    assert.equal(addItem(a.doc, a.id, '   ').ok, false);

    // 条目上限
    let doc = a.doc;
    for (let i = 0; i < MEMO_LIMITS.itemsPerBlock; i++) {
        doc = addItem(doc, a.id, '条目 ' + i).doc;
    }
    assert.equal(addItem(doc, a.id, '再一条').ok, false);

    // 块上限
    let many = defaultMemoData();
    for (let i = 0; i < MEMO_LIMITS.blocks; i++) many = addBlock(many, '块' + i).doc;
    assert.equal(addBlock(many, '再一块').ok, false);
});

test('updateById：条目与块共用 id 入口', () => {
    const base = sampleDoc();
    const it = base.doc.blocks[0].items[0];

    // 改条目文本与状态
    const u1 = updateById(base.doc, it.id, {text: '改过的', status: 'completed'});
    assert.ok(u1.ok && u1.kind === 'item');
    assert.equal(u1.doc.blocks[0].items[0].text, '改过的');
    assert.equal(u1.doc.blocks[0].items[0].status, 'completed');

    // 非法状态报错
    assert.equal(updateById(base.doc, it.id, {status: 'done'}).ok, false);

    // 改块标题：text 即标题
    const blk = base.doc.blocks[0];
    const u2 = updateById(base.doc, blk.id, {text: '新标题'});
    assert.ok(u2.ok && u2.kind === 'block');
    assert.equal(u2.doc.blocks[0].title, '新标题');

    // 块没有状态
    assert.equal(updateById(base.doc, blk.id, {status: 'completed'}).ok, false);

    // index 移动：把第 0 条挪到末尾
    const u3 = updateById(base.doc, blk.items[0].id, {index: 99});
    assert.ok(u3.ok);
    assert.equal(u3.doc.blocks[0].items[u3.doc.blocks[0].items.length - 1].id, blk.items[0].id);

    // 未知 id 报错
    assert.equal(updateById(base.doc, 'it-none', {text: 'x'}).ok, false);
});

test('removeById：删块连带条目并回传贴图引用', () => {
    let doc = sampleDoc().doc;
    const blk = doc.blocks[0];
    const it0 = blk.items[0];
    doc = attachImage(doc, it0.id, 'img/x.png').doc;
    const rmItem = removeById(doc, it0.id);
    assert.ok(rmItem.ok && rmItem.removedItems === 1);
    assert.deepEqual(rmItem.removedImages, ['img/x.png']);

    const rmBlock = removeById(rmItem.doc, blk.id);
    assert.ok(rmBlock.ok);
    assert.equal(rmBlock.doc.blocks.length, 0);
    assert.equal(rmBlock.removedItems, 2);
    assert.equal(removeById(rmBlock.doc, 'it-none').ok, false);
});

test('moveItemToBlock：跨块移动与上限', () => {
    const a = addBlock(defaultMemoData(), 'A');
    const b = addBlock(a.doc, 'B');
    const item = addItem(b.doc, a.id, '要挪的');
    const moved = moveItemToBlock(item.doc, item.id, b.id);
    assert.ok(moved.ok);
    assert.equal(moved.doc.blocks[1].items.length, 1);
    assert.equal(moveItemToBlock(item.doc, item.id, 'blk-none').ok, false);
    assert.equal(moveItemToBlock(item.doc, 'it-none', b.id).ok, false);
});

test('attachImage / removeImageById：贴图引用上限', () => {
    const base = sampleDoc();
    const it = base.doc.blocks[0].items[0];
    let doc = base.doc;
    for (let i = 0; i < MEMO_LIMITS.imagesPerItem; i++) {
        doc = attachImage(doc, it.id, 'img/' + i + '.png').doc;
    }
    assert.equal(attachImage(doc, it.id, 'img/more.png').ok, false);
    const rm = removeImageById(doc, it.id, 'img/0.png');
    assert.ok(rm.ok);
    assert.equal(rm.doc.blocks[0].items[0].images.length, MEMO_LIMITS.imagesPerItem - 1);
    assert.equal(removeImageById(doc, it.id, 'img/none.png').ok, false);
});

test('cycleStatus：三态循环', () => {
    assert.equal(cycleStatus('pending'), 'in_progress');
    assert.equal(cycleStatus('in_progress'), 'completed');
    assert.equal(cycleStatus('completed'), 'pending');
});

test('formatMemoForAI：含 id 与计数，空面板有引导语', () => {
    const empty = formatMemoForAI(defaultMemoData(), '工作区快捷便签');
    assert.match(empty, /是空的/);

    const base = sampleDoc();
    const text = formatMemoForAI(base.doc, '工作区快捷便签');
    assert.match(text, /共 1 块 3 项/);
    assert.match(text, /完成 1 \/ 进行中 1 \/ 待办 1/);
    for (const item of base.doc.blocks[0].items) {
        assert.ok(text.includes('[' + item.id + ']'), '缺条目 id：' + item.id);
    }
    assert.ok(text.includes('[x]'));
    assert.ok(text.includes('[~]'));
    assert.ok(text.includes('[ ]'));
});

test('memoId：同批调用不重复', () => {
    const ids = new Set(Array.from({length: 100}, () => memoId('it')));
    assert.equal(ids.size, 100);
});

test('findItem：定位返回块与索引', () => {
    const base = sampleDoc();
    const it = base.doc.blocks[0].items[1];
    const found = findItem(base.doc, it.id);
    assert.equal(found.blockIndex, 0);
    assert.equal(found.itemIndex, 1);
    assert.equal(findItem(base.doc, 'it-none'), null);
});

test('updateById：块 collapsed 独立生效（折叠按钮只传 collapsed 也必须折叠）', () => {
    const base = sampleDoc();
    const blk = base.doc.blocks[0];
    const u1 = updateById(base.doc, blk.id, {collapsed: true});
    assert.ok(u1.ok);
    assert.equal(u1.doc.blocks[0].collapsed, true);
    const u2 = updateById(u1.doc, blk.id, {collapsed: false});
    assert.equal(u2.doc.blocks[0].collapsed, false);
    // 改标题与折叠互不干扰
    const u3 = updateById(base.doc, blk.id, {text: '新标题', collapsed: true});
    assert.equal(u3.doc.blocks[0].title, '新标题');
    assert.equal(u3.doc.blocks[0].collapsed, true);
});

test('updateById：index 是移动后的目标下标（下移一格 = idx+1，不是 idx+2）', () => {
    const base = sampleDoc();
    const blk = base.doc.blocks[0];
    const four = addItem(base.doc, blk.id, '第四条');
    const doc = four.doc;
    const ids = doc.blocks[0].items.map((it) => it.id);
    assert.equal(ids.length, 4);
    // 下移一格：第 2 条（idx=1）与第 3 条交换
    const down = updateById(doc, ids[1], {index: 1 + 1});
    assert.deepEqual(down.doc.blocks[0].items.map((it) => it.id), [ids[0], ids[2], ids[1], ids[3]]);
    // 传 idx+2 会跳过相邻项——视图菜单曾经就是这个形态
    const skip = updateById(doc, ids[1], {index: 1 + 2});
    assert.deepEqual(skip.doc.blocks[0].items.map((it) => it.id), [ids[0], ids[2], ids[3], ids[1]]);
});

// 守卫：便签视图菜单的「下移」必须把 idx+1 交给 updateById（曾被写成 idx+2，跳两格且末条无效）。
test('bridge-memo-view 的下移不传 idx + 2', () => {
    const src = readFileSync(new URL('../../src/bridge/bridge-memo-view.js', import.meta.url), 'utf8');
    assert.equal(/index:\s*idx \+ 2/.test(src), false);
    assert.ok(/index:\s*idx \+ 1/.test(src), '下移应传 idx + 1');
});

test('addItem：kind=md 与 afterId 智能插入', () => {
    const base = sampleDoc();
    const blk = base.doc.blocks[0];
    const second = blk.items[1];
    // kind=md 保留
    const md = addItem(base.doc, blk.id, '# 标题\n正文', {kind: 'md'});
    assert.ok(md.ok);
    assert.equal(md.doc.blocks[0].items[md.doc.blocks[0].items.length - 1].kind, 'md');
    // afterId：插到第二条之后
    const ins = addItem(base.doc, blk.id, '插队', {afterId: second.id});
    const items = ins.doc.blocks[0].items;
    assert.equal(items[2].id, ins.id);
    assert.equal(items[2].text, '插队');
    // afterId 找不到时落到末尾
    const fall = addItem(base.doc, blk.id, '兜底', {afterId: 'it-none'});
    assert.equal(fall.doc.blocks[0].items[fall.doc.blocks[0].items.length - 1].text, '兜底');
});

test('normalizeMemoData：md kind 保留，其他值纠正为 text', () => {
    const doc = normalizeMemoData({blocks: [{items: [{text: 'a', kind: 'md'}, {text: 'b', kind: 'bogus'}, {text: 'c'}]}]});
    assert.equal(doc.blocks[0].items[0].kind, 'md');
    assert.equal(doc.blocks[0].items[1].kind, 'text');
    assert.equal(doc.blocks[0].items[2].kind, 'text');
});

test('formatMemoForAI：md 条目带 [md] 标记', () => {
    const base = sampleDoc();
    const blk = base.doc.blocks[0];
    const md = addItem(base.doc, blk.id, '# 小节', {kind: 'md'});
    const text = formatMemoForAI(md.doc, '工作区快捷便签');
    assert.match(text, /\[md\] \[it-[^\]]+\] # 小节/);
});

test('collectImageRefs：item.images 与正文占位符合并收集', () => {
    const base = sampleDoc();
    const blk = base.doc.blocks[0];
    let doc = base.doc;
    doc = addItem(doc, blk.id, '看图 ![图](img/inner.png) 完', {kind: 'md'}).doc;
    doc = attachImage(doc, blk.items[0].id, 'img/attached.png').doc;
    const refs = collectImageRefs(doc);
    assert.ok(refs.has('img/inner.png'), '正文占位符要收集');
    assert.ok(refs.has('img/attached.png'), '缩略图挂载要收集');
    assert.equal(refs.size, 2);
});

test('exportMemoMarkdown：任务清单 + md 原样 + 图片统一收集', () => {
    let doc = addBlock(defaultMemoData(), '阶段一').doc;
    const blkId = doc.blocks[0].id;
    doc = addItem(doc, blkId, '223s 速度 ![图](img/a.png) 完成', {status: 'completed'}).doc;
    doc = addItem(doc, blkId, '进行中任务', {status: 'in_progress'}).doc;
    doc = attachImage(doc, doc.blocks[0].items[1].id, 'img/b.png').doc;
    doc = addItem(doc, blkId, '## 小节' + String.fromCharCode(10) + '- 列表', {kind: 'md'}).doc;

    const out = exportMemoMarkdown(doc, '工作区');
    assert.match(out.content, /# 快捷便签 · 工作区/);
    assert.match(out.content, /## 1\. 阶段一/);
    assert.match(out.content, /- \[x\] 223s 速度 !\[图\]\(img\/a\.png\) 完成/);
    assert.match(out.content, /- \[~\] 进行中任务/);
    assert.match(out.content, /  !\[b\.png\]\(img\/b\.png\)/, '缩略图挂载补成图片语法');
    assert.ok(out.content.includes('## 小节' + String.fromCharCode(10) + '- 列表'), 'md 条目原样嵌入');
    assert.deepEqual(out.images.sort(), ['img/a.png', 'img/b.png']);
});

test('formatMemoForAI：按状态过滤（首行保留全局面板计数 + 尾部命中汇总）', () => {
    const base = sampleDoc(); // 3 项：1 完成 / 1 进行中 / 1 待办
    const text = formatMemoForAI(base.doc, '工作区快捷便签', {status: 'in_progress'});
    assert.match(text, /共 1 块 3 项/, '首行保留全局视野');
    assert.match(text, /status=in_progress/, '注明过滤条件');
    assert.match(text, /1\/3 项命中/);
    assert.ok(!text.includes('223s'), '未命中的待办条目不显示');
    assert.match(text, /修复转义 bug/);
    assert.match(text, /以上 1 项为过滤命中；其余 2 项未显示/);
});

test('formatMemoForAI：按 blockId 只读某分组 + 按 q 文本包含（不区分大小写）', () => {
    let doc = addBlock(defaultMemoData(), 'A组').doc;
    doc = addItem(doc, doc.blocks[0].id, 'Alpha 任务').doc;
    doc = addBlock(doc, 'B组').doc;
    doc = addItem(doc, doc.blocks[1].id, 'Beta 任务').doc;

    const byBlock = formatMemoForAI(doc, '工作区', {blockId: doc.blocks[0].id});
    assert.match(byBlock, /A组/);
    assert.ok(!byBlock.includes('B组'), 'blockId 过滤不显示其他块');
    assert.match(byBlock, /Alpha 任务/);

    const byQ = formatMemoForAI(doc, '工作区', {q: 'beta'});
    assert.match(byQ, /q=beta/);
    assert.match(byQ, /Beta 任务/);
    assert.ok(!byQ.includes('Alpha 任务'), 'q 过滤不显示未命中');

    const none = formatMemoForAI(doc, '工作区', {q: '不存在的内容xyz'});
    assert.match(none, /没有匹配过滤条件的条目（面板总数不变：2 项）/, '无命中也汇报总口径');
});
