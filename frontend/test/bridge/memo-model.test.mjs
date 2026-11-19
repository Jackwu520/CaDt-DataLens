// memo-model 纯函数护栏：归一化（坏数据兜底 / 超限截断 / 标签去重限量）、
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
    normalizeTags,
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
    memoItemFoldHeight,
    shouldFoldMemoItem,
    updateById,
} from '../../src/bridge/memo-model.js';

function sampleDoc() {
    const r1 = addBlock(defaultMemoData(), '阶段一');
    const r2 = addItem(r1.doc, r1.id, '实现 token 流');
    const r3 = addItem(r2.doc, r1.id, '修复转义 bug', {tags: ['重要']});
    const r4 = addItem(r3.doc, r1.id, '写单元测试', {tags: ['已验收', '重要']});
    return r4;
}

test('normalizeMemoData：非对象输入回默认结构', () => {
    for (const bad of [null, undefined, 42, 'x', {}, {blocks: 'no'}]) {
        const doc = normalizeMemoData(bad);
        assert.deepEqual(doc, defaultMemoData());
    }
});

test('normalizeMemoData：补 id、归标签、截断超限', () => {
    const longText = 'x'.repeat(MEMO_LIMITS.textMax + 100);
    const doc = normalizeMemoData({
        blocks: [
            {
                title: 't'.repeat(MEMO_LIMITS.blockTitleMax + 50),
                items: [
                    {text: longText, tags: ['重要', '重要', '  ', 'x'.repeat(50)], images: ['img/a.png', 42, null, 'img/b.png']},
                    {text: '第二条', tags: ['已验收'], images: Array(20).fill('img/c.png')},
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
    assert.equal(b1.items[0].text.length, MEMO_LIMITS.textMax);
    assert.deepEqual(b1.items[0].images, ['img/a.png', 'img/b.png']);
    assert.equal(b1.items[1].images.length, MEMO_LIMITS.imagesPerItem);
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

    // 改条目文本与标签
    const u1 = updateById(base.doc, it.id, {text: '改过的', tags: ['已验收']});
    assert.ok(u1.ok && u1.kind === 'item');
    assert.equal(u1.doc.blocks[0].items[0].text, '改过的');
    assert.deepEqual(u1.doc.blocks[0].items[0].tags, ['已验收']);

    // 改块标题：text 即标题
    const blk = base.doc.blocks[0];
    const u2 = updateById(base.doc, blk.id, {text: '新标题'});
    assert.ok(u2.ok && u2.kind === 'block');
    assert.equal(u2.doc.blocks[0].title, '新标题');

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

test('normalizeTags：截断/去重/去空白/限量', () => {
    assert.deepEqual(normalizeTags(['重要', '重要', '  ', 'x'.repeat(50)]), ['重要', 'x'.repeat(12)]);
    assert.deepEqual(normalizeTags(null), []);
});

test('formatMemoForAI：含 id 与计数，空面板有引导语', () => {
    const empty = formatMemoForAI(defaultMemoData(), '工作区快捷便签');
    assert.match(empty, /是空的/);

    const base = sampleDoc();
    const text = formatMemoForAI(base.doc, '工作区快捷便签');
    assert.match(text, /共 1 块 3 项/);
    for (const item of base.doc.blocks[0].items) {
        assert.ok(text.includes('[' + item.id + ']'), '缺条目 id：' + item.id);
    }
    assert.ok(text.includes('{重要}'));
    assert.ok(text.includes('{已验收/重要}'));
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

// ===== 终端条目（kind=term）=====

test('kind=term：addItem / normalize / updateById 全链路放行', () => {
    // addItem 带回 kind
    const base = sampleDoc();
    const blk = base.doc.blocks[0];
    const term = addItem(base.doc, blk.id, 'git status', {kind: 'term'});
    assert.ok(term.ok);
    assert.equal(term.doc.blocks[0].items[term.doc.blocks[0].items.length - 1].kind, 'term');
    // normalizeMemoData 保留 term，非法值仍纠正为 text
    const norm = normalizeMemoData({blocks: [{items: [{text: 'a', kind: 'term'}, {text: 'b', kind: 'bogus'}]}]});
    assert.equal(norm.blocks[0].items[0].kind, 'term');
    assert.equal(norm.blocks[0].items[1].kind, 'text');
    // updateById 三向转换 + 非法 kind 报错文案
    const u1 = updateById(base.doc, blk.items[0].id, {kind: 'term'});
    assert.ok(u1.ok && u1.doc.blocks[0].items[0].kind === 'term');
    const u2 = updateById(base.doc, blk.items[0].id, {kind: 'wat'});
    assert.ok(!u2.ok && /text \/ md \/ term/.test(u2.error));
});

test('formatMemoForAI：term 条目带 [终端] 标记（命令原文可读）', () => {
    const base = sampleDoc();
    const blk = base.doc.blocks[0];
    const term = addItem(base.doc, blk.id, 'git status --short', {kind: 'term'});
    const text = formatMemoForAI(term.doc, '工作区快捷便签');
    assert.match(text, /\[终端\] \[it-[^\]]+\] git status --short/);
});

test('exportMemoMarkdown：term 条目按普通清单条目导出（命令原文，不含输出）', () => {
    let doc = addBlock(defaultMemoData(), '部署').doc;
    doc = addItem(doc, doc.blocks[0].id, 'npm run build', {kind: 'term'}).doc;
    const out = exportMemoMarkdown(doc, '工作区');
    assert.match(out.content, /- npm run build/);
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
    doc = addItem(doc, blkId, '223s 速度 ![图](img/a.png) 完成', {tags: ['已验收']}).doc;
    doc = addItem(doc, blkId, '进行中任务', {tags: ['重要']}).doc;
    doc = attachImage(doc, doc.blocks[0].items[1].id, 'img/b.png').doc;
    doc = addItem(doc, blkId, '## 小节' + String.fromCharCode(10) + '- 列表', {kind: 'md'}).doc;

    const out = exportMemoMarkdown(doc, '工作区');
    assert.match(out.content, /# 快捷便签 · 工作区/);
    assert.match(out.content, /## 1\. 阶段一/);
    assert.match(out.content, /- \{已验收\} 223s 速度 !\[图\]\(img\/a\.png\) 完成/);
    assert.match(out.content, /- \{重要\} 进行中任务/);
    assert.match(out.content, /  !\[b\.png\]\(img\/b\.png\)/, '缩略图挂载补成图片语法');
    assert.ok(out.content.includes('## 小节' + String.fromCharCode(10) + '- 列表'), 'md 条目原样嵌入');
    assert.deepEqual(out.images.sort(), ['img/a.png', 'img/b.png']);
});

test('formatMemoForAI：按标签过滤（首行保留全局面板计数 + 尾部命中汇总）', () => {
    const base = sampleDoc(); // 3 项：重要×2 / 已验收×1
    const text = formatMemoForAI(base.doc, '工作区快捷便签', {tag: '已验收'});
    assert.match(text, /共 1 块 3 项/, '首行保留全局视野');
    assert.match(text, /tag=已验收/, '注明过滤条件');
    assert.match(text, /1\/3 项命中/);
    assert.ok(!text.includes('修复转义 bug'), '未命中标签的条目不显示');
    assert.match(text, /写单元测试/);
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

test('addItem：往折叠块加条目自动展开（新条目不能藏在折叠里）', () => {
    const base = sampleDoc();
    const folded = updateById(base.doc, base.doc.blocks[0].id, {collapsed: true});
    assert.equal(folded.doc.blocks[0].collapsed, true);
    const added = addItem(folded.doc, base.doc.blocks[0].id, '新条目');
    assert.ok(added.ok);
    assert.equal(added.doc.blocks[0].collapsed, false, '加条目后块应展开');
    assert.equal(added.doc.blocks[0].items.at(-1).text, '新条目');
});

test('moveItemToBlock：移到折叠块自动展开', () => {
    let doc = addBlock(defaultMemoData(), 'A').doc;
    const aId = doc.blocks[0].id;
    doc = addBlock(doc, 'B').doc;
    const bId = doc.blocks[1].id;
    doc = addItem(doc, aId, '要挪的').doc;
    const itemId = doc.blocks[0].items[0].id;
    doc = updateById(doc, bId, {collapsed: true}).doc;
    const moved = moveItemToBlock(doc, itemId, bId);
    assert.ok(moved.ok);
    assert.equal(moved.doc.blocks[1].collapsed, false, '移入后目标块应展开');
    assert.equal(moved.doc.blocks[1].items.length, 1);
});

test('textMax：便签正文上限放宽到长笔记量级（>= 1 万字符）', () => {
    assert.ok(MEMO_LIMITS.textMax >= 10000, 'textMax 应足够放下报错栈/配置等长文本');
    const long = 'x'.repeat(3000);
    const added = addItem(defaultMemoData(), '', long);
    assert.equal(added.doc.blocks[0].items[0].text.length, long.length, '长文本不应被截断到 500');
});

// 守卫：便签全量重渲染必须保留 .memo-body 滚动位置，否则勾选待办/加条目/折叠后都跳回顶部。
// 顺序敏感：footer 必须在 scrollTop 恢复之前入树——footer 缺席时 .memo-body 被 flex 撑高一个
// footer 的高度，恢复的 scrollTop 会被 clamp 到偏小的 max（滚动条偏移 43px bug 的根因）。
test('bridge-memo-view：render 保留滚动位置', () => {
    const src = readFileSync(new URL('../../src/bridge/bridge-memo-view.js', import.meta.url), 'utf8');
    assert.ok(/prevBody\?\.scrollTop|\.scrollTop/.test(src), 'render 应读取并还原 .memo-body 的 scrollTop');
    assert.ok(/body\.scrollTop\s*=\s*scrollTop/.test(src), '重建后应把 scrollTop 还原到新 body');
    const footerAt = src.indexOf('root.appendChild(footer)');
    const restoreAt = src.indexOf('body.scrollTop = scrollTop');
    assert.ok(footerAt >= 0 && restoreAt >= 0, '应找到 footer 入树与滚动恢复两处代码');
    assert.ok(footerAt < restoreAt, 'footer 必须在滚动恢复之前入树（否则恢复值被 clamp，视口上移约 43px）');
});

// 守卫：块右键菜单的「折叠/展开」项必须可点（曾因误加 disabled 导致整个折叠功能不可用）。
test('bridge-memo-view：块菜单折叠项不带 disabled', () => {
    const src = readFileSync(new URL('../../src/bridge/bridge-memo-view.js', import.meta.url), 'utf8');
    const lines = src.split('\n');
    const foldLine = lines.find((l) => l.includes("'展开' : '折叠'") || l.includes('展开\' : \'折叠'));
    assert.ok(foldLine, '应找到折叠/展开菜单项定义');
    assert.ok(!/disabled\s*:/.test(foldLine), '折叠项不得带 disabled，否则整个折叠功能被禁用');
    assert.ok(/collapsed:\s*!block\.collapsed/.test(foldLine + lines[lines.indexOf(foldLine) + 1]), '折叠项应切换 collapsed');
});

// 守卫：便签面板右键必须掐断冒泡，否则事件冒到 mainPane 会弹出编辑器通用菜单
// （撤销/折叠/书签…），把便签自己的块/条目菜单覆盖掉——用户看到的是灰掉的「折叠」。
test('bridge-memo-view：root 的 contextmenu 阻止冒泡到编辑器', () => {
    const src = readFileSync(new URL('../../src/bridge/bridge-memo-view.js', import.meta.url), 'utf8');
    assert.ok(/addEventListener\('contextmenu',\s*onContextMenu\)/.test(src), 'root 应挂 contextmenu 处理器');
    assert.ok(/onContextMenu[\s\S]{0,200}stopPropagation\(\)/.test(src), '处理器必须 stopPropagation 掐断冒泡');
    assert.ok(/removeEventListener\('contextmenu',\s*onContextMenu\)/.test(src), '卸载时要解绑');
});

test('memoItemFoldHeight：按换行与每行字数估算渲染高度', () => {
    assert.equal(memoItemFoldHeight(''), 20, '空文本按一行算');
    assert.equal(memoItemFoldHeight('短文本'), 20, '一行内 20px');
    assert.equal(memoItemFoldHeight('a\nb\nc'), 60, '三行 60px');
    assert.equal(memoItemFoldHeight('x'.repeat(120)), 40, '120 字折两行 40px');
});

test('shouldFoldMemoItem：超过 1 个视窗高度才折叠', () => {
    const vh = 600; // 模拟 memo-body 可视高度
    assert.equal(shouldFoldMemoItem('短文本', vh), false);
    assert.equal(shouldFoldMemoItem('', vh), false);
    assert.equal(shouldFoldMemoItem('x'.repeat(1800), vh), false, '1800 字=30 行=600px，等于视窗不折叠');
    assert.equal(shouldFoldMemoItem('x'.repeat(1860), vh), true, '1860 字=31 行=620px，超过视窗折叠');
    assert.equal(shouldFoldMemoItem('x'.repeat(120), vh), false, '视窗省略时用默认 600');
    // 换行多的短文本也能触发折叠
    assert.equal(shouldFoldMemoItem(Array(31).fill('a').join('\n'), vh), true);
});

test('normalizeMemoData / updateById：tags 数据层（截断/去重/上限/替换）', () => {
    const doc = normalizeMemoData({blocks: [{items: [
        {text: 'a', tags: ['重要', ' 重要 ', '', '重要', '紧急', 'extra', 'more', 'even-more']},
    ]}]});
    const tags = doc.blocks[0].items[0].tags;
    assert.deepEqual(tags, ['重要', '紧急', 'extra', 'more'], 'trim/去空/去重/上限 4 个');

    const base = sampleDoc();
    const it = base.doc.blocks[0].items[0];
    const u = updateById(base.doc, it.id, {tags: ['灵感', '资料']});
    assert.deepEqual(u.doc.blocks[0].items[0].tags, ['灵感', '资料'], '整体替换');
    assert.equal(updateById(base.doc, it.id, {tags: '不是数组'}).ok, false, '非数组拒绝');
});

test('updateById：kind 转换（text ↔ md）', () => {
    const base = sampleDoc();
    const it = base.doc.blocks[0].items[0];
    const u1 = updateById(base.doc, it.id, {kind: 'md'});
    assert.equal(u1.doc.blocks[0].items[0].kind, 'md');
    const u2 = updateById(u1.doc, it.id, {kind: 'text'});
    assert.equal(u2.doc.blocks[0].items[0].kind, 'text');
    assert.equal(updateById(base.doc, it.id, {kind: 'html'}).ok, false, '非法 kind 拒绝');
});

test('formatMemoForAI：tags 显示 {a/b}', () => {
    const base = sampleDoc();
    const it = base.doc.blocks[0].items[0];
    const doc = updateById(base.doc, it.id, {tags: ['重要', '紧急']}).doc;
    const text = formatMemoForAI(doc, '工作区');
    assert.match(text, /\[it-[^\]]+\] \{重要\/紧急\}/);
});
