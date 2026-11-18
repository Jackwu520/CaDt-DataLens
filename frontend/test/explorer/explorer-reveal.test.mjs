// explorer-reveal.test.mjs —— 文件树「只垂直 reveal、横向滚动条不动」的护栏。
// 对齐 IDEA：打开文件把当前行滚进垂直视野即可，不该挪动横向滚动条。
// 纯函数 verticalScrollFor 决定垂直目标；revealRowVertically 用它且不碰 scrollLeft。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verticalScrollFor} from '../../src/explorer/explorer.js';

test('verticalScrollFor：行在可视区上方 → 贴顶', () => {
    // 行 0–20，可视区从 100 开始
    assert.equal(verticalScrollFor(0, 20, 100, 300), 0);
});

test('verticalScrollFor：行在可视区下方 → 贴底', () => {
    // 行 400–426，可视区 100–400（viewH=300），行底超出 26
    assert.equal(verticalScrollFor(400, 426, 100, 300), 126);
});

test('verticalScrollFor：行完全可见 → 保持当前 scrollTop', () => {
    assert.equal(verticalScrollFor(150, 176, 100, 300), 100);
    // 行正好贴住上下边界也算可见
    assert.equal(verticalScrollFor(100, 400, 100, 300), 100);
});

test('verticalScrollFor：viewH<=0 兜底返回当前 scrollTop（不产生非法滚动）', () => {
    assert.equal(verticalScrollFor(0, 20, 50, 0), 50);
    assert.equal(verticalScrollFor(0, 20, 50, -10), 50);
});

test('revealRowVertically 接线：文件树不再用 scrollIntoView 挪横向', () => {
    // 读源码确认三处 reveal 都走 revealRowVertically，且文件树区域无 scrollIntoView
    const src = readFileSync(new URL('../../src/explorer/explorer.js', import.meta.url), 'utf8');
    const treeReveals = src.match(/revealRowVertically\(body, row\)/g) || [];
    assert.ok(treeReveals.length >= 3, 'scrollToActive/selectPath/selectPaths 三处应走 revealRowVertically');
    // 除注释外不应再有 scrollIntoView 调用
    const calls = (src.match(/\.scrollIntoView\(/g) || []).length;
    assert.equal(calls, 0, '文件树不应再调用 scrollIntoView（它会连横向一起滚动）');
});

// 对齐 JetBrains：切换标签页只更新文件树的当前行高亮，不展开目录、不滚进视野；
// 「定位当前文件」是用户显式动作（侧栏 sb-reveal 按钮 → revealActiveFile）。
test('切标签不抢文件树：activateDoc 以 reveal:false 同步活动文件', () => {
    const src = readFileSync(new URL('../../src/editor/editor-groups.js', import.meta.url), 'utf8');
    assert.match(src, /deps\.syncExplorerActive\(\{reveal: false\}\)/,
        'activateDoc 必须传 reveal:false，否则切标签会把文件树展开并滚走');
});

test('setActive 支持 reveal 开关，并暴露 revealActiveFile 显式定位入口', () => {
    const src = readFileSync(new URL('../../src/explorer/explorer.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.match(src, /function setActive\(path, opts = \{\}\)/, 'setActive 需要 opts 参数');
    assert.match(src, /const reveal = opts\.reveal !== false;/, 'setActive 需按 opts.reveal 决定是否滚动');
    assert.match(src, /function revealActiveFile\(\)/, '缺少显式定位入口 revealActiveFile（侧栏「定位当前文件」用它）');
    assert.match(src, /\n        revealActiveFile,\n/, 'revealActiveFile 必须出现在宿主可见的返回面里');
});

// 删除文件后不能全量重建文件树：那会丢掉展开态并让整棵树闪一下。
// 正确路径是 removePath 就地摘除 + notifyFileChange 按目录标脏走差量刷新。
test('删除后不做全量刷新：performDelete 不调 explorer.refresh()', () => {
    const src = readFileSync(new URL('../../src/explorer/explorer-ops.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf('async function performDelete(');
    assert.ok(start > 0, '找不到 performDelete');
    const end = src.indexOf('\n}\n', start);
    const body = src.slice(start, end > start ? end : undefined);
    assert.doesNotMatch(body, /deps\.explorer\.refresh\(\)/,
        'performDelete 里不要再调 explorer.refresh()：全量重建会折叠已展开目录并闪烁');
    assert.match(body, /deps\.explorer\.notifyFileChange\(/, '删除后应把所在目录标脏走差量刷新');
});

// 其余「自己写盘 / 定位」的入口同样不许整树重建（刷新按钮与切工作区除外）。
test('外部拖入复制的收尾不整树重建（refreshDir + notifyDirChange）', () => {
    const src = readFileSync(new URL('../../src/shell/app-actions.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf('async function copyExternalIntoDir(');
    assert.ok(start > 0, '找不到 copyExternalIntoDir');
    const end = src.indexOf('\n}\n', start);
    const body = src.slice(start, end > start ? end : undefined);
    assert.doesNotMatch(body, /explorer\.refresh\(\)/,
        '复制完成后不要调 explorer.refresh()：应只重读目标目录');
    assert.match(body, /explorer\.refreshDir\(destDir\)/, '复制完成后应重读目标目录');
    assert.match(body, /explorer\.notifyDirChange\(destDir\)/, '列表 / 未展开目录靠 notifyDirChange 差量刷新');
});

test('reveal_in_explorer 不再先整树刷新（revealPath 自己逐层重读）', () => {
    const src = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf("case 'reveal_in_explorer':");
    assert.ok(start > 0, '找不到 reveal_in_explorer 分支');
    const end = src.indexOf('case ', start + 10);
    const body = src.slice(start, end > start ? end : undefined);
    assert.doesNotMatch(body, /explorer\.refresh\(\)/,
        'reveal_in_explorer 不应先调 explorer.refresh()：那会折叠用户已展开的目录');
    assert.match(body, /explorer\.revealPath\(target\)/, '仍应走 revealPath 展开目标');
});

test('文件监听溢出的大批量重建保留展开态', () => {
    const src = readFileSync(new URL('../../src/explorer/explorer.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.match(src, /async function rebuildTreeKeepingExpansion\(\)/, '缺少保留展开态的重建函数');
    const start = src.indexOf('if (externalOverflow) {');
    assert.ok(start > 0, '找不到溢出分支');
    const body = src.slice(start, src.indexOf('\n        }', start));
    assert.match(body, /rebuildTreeKeepingExpansion\(\)/, '溢出分支应走保留展开态的重建');
    assert.doesNotMatch(body, /tree = null;/, '溢出分支不要再直接丢弃整棵树');
});
