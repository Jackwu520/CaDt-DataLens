// ai-file-refs.test.mjs：文件引用识别纯函数的表驱动测试（与源码同目录）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {applyFileRefChip, parseFileRef, pickOpenFileMatch} from './ai-file-refs.js';

// 最简 inline code 桩：够 applyFileRefChip 用的 dataset / classList 两面
function stubCode(connected) {
    const added = [];
    return {
        dataset: {},
        isConnected: !!connected,
        classList: {add(name) { added.push(name); }},
        addedClasses: added,
    };
}

test('parseFileRef：可带 :行[:列] 后缀的路径', () => {
    assert.deepEqual(parseFileRef('src/main.js'), {path: 'src/main.js', line: 0, col: 0});
    assert.deepEqual(parseFileRef('frontend/src/ai/model-catalog.js'), {path: 'frontend/src/ai/model-catalog.js', line: 0, col: 0});
    assert.deepEqual(parseFileRef('src/main.js:42'), {path: 'src/main.js', line: 42, col: 0});
    assert.deepEqual(parseFileRef('src/main.js:42:8'), {path: 'src/main.js', line: 42, col: 8});
    assert.deepEqual(parseFileRef('model-catalog.js'), {path: 'model-catalog.js', line: 0, col: 0});
    assert.deepEqual(parseFileRef('./src/main.js'), {path: './src/main.js', line: 0, col: 0});
});

test('parseFileRef：Windows 路径与反斜杠归一', () => {
    assert.deepEqual(parseFileRef('D:/proj/src/main.js'), {path: 'D:/proj/src/main.js', line: 0, col: 0});
    assert.deepEqual(parseFileRef('D:\\proj\\src\\main.js'), {path: 'D:/proj/src/main.js', line: 0, col: 0});
    assert.deepEqual(parseFileRef('D:\\proj\\src\\main.js:42'), {path: 'D:/proj/src/main.js', line: 42, col: 0});
});

test('parseFileRef：拒绝 URL / 通配 / 空白 / 数字 / 无扩展名', () => {
    assert.equal(parseFileRef('https://example.com/a.js'), null);
    assert.equal(parseFileRef('http://x'), null);
    assert.equal(parseFileRef('mailto:a@b.c'), null);
    assert.equal(parseFileRef('src/*.js'), null);
    assert.equal(parseFileRef('src / main.js'), null);
    assert.equal(parseFileRef(''), null);
    assert.equal(parseFileRef(null), null);
    assert.equal(parseFileRef('v1.2'), null);
    assert.equal(parseFileRef('1.5'), null);
    assert.equal(parseFileRef('README'), null);
    assert.equal(parseFileRef('src/'), null);
    assert.equal(parseFileRef('foo.bar/baz'), null);
    assert.equal(parseFileRef('src/main.js:abc'), null);
    assert.equal(parseFileRef('src/main.js:'), null);
});

test('parseFileRef：超长路径不命中', () => {
    assert.equal(parseFileRef('a/'.repeat(160) + 'b.js'), null);
});

test('pickOpenFileMatch：裸文件名按打开标签页匹配（大小写不敏感、反斜杠兼容）', () => {
    const open = ['D:\\Ws\\frontend\\src\\ai\\model-catalog.js', 'D:/Ws/README.md', ''];
    assert.equal(pickOpenFileMatch(parseFileRef('model-catalog.js'), open), 'D:\\Ws\\frontend\\src\\ai\\model-catalog.js');
    assert.equal(pickOpenFileMatch(parseFileRef('MODEL-CATALOG.JS'), open), 'D:\\Ws\\frontend\\src\\ai\\model-catalog.js');
    assert.equal(pickOpenFileMatch(parseFileRef('readme.md'), open), 'D:/Ws/README.md');
    // 带目录的引用不走 basename 匹配（交给工作区相对解析）
    assert.equal(pickOpenFileMatch(parseFileRef('src/ai/model-catalog.js'), open), '');
    assert.equal(pickOpenFileMatch(parseFileRef('missing.js'), open), '');
    assert.equal(pickOpenFileMatch(null, open), '');
});

// 回归：整屏重放时 renderMessage 先建游离 wrap 再 append，而 stat 结果缓存命中时升级是
// **同步**调用——早期版本在 isConnected=false 时直接 return，且 state 停在 pending 不再重试，
// 于是「第一次进对话链接正常，切走再切回退化成普通代码」。这里钉死「游离节点也上 chip」。
test('applyFileRefChip：未挂载的节点同样升级（缓存命中同步路径）', () => {
    const code = stubCode(false);
    assert.equal(code.isConnected, false, '桩要模拟「还没 append」');
    applyFileRefChip(code, 'D:/Ws/frontend/src/core/wordcloud-render.js',
        parseFileRef('frontend/src/core/wordcloud-render.js:215'));
    assert.equal(code.dataset.aiRefState, 'file');
    assert.equal(code.dataset.aiRefPath, 'D:/Ws/frontend/src/core/wordcloud-render.js');
    assert.equal(code.dataset.aiRefLine, '215');
    assert.equal(code.dataset.aiRefCol, '0');
    assert.deepEqual(code.addedClasses, ['ai-file-ref']);
    assert.equal(code.dataset.tip, 'D:/Ws/frontend/src/core/wordcloud-render.js · 第 215 行');
});

test('applyFileRefChip：tooltip 带行与列，缺参数不抛', () => {
    const code = stubCode(true);
    applyFileRefChip(code, 'D:/a.js', {line: 12, col: 8});
    assert.equal(code.dataset.tip, 'D:/a.js · 第 12 行 第 8 列');
    const noLine = stubCode(true);
    applyFileRefChip(noLine, 'D:/a.js', {line: 0, col: 0});
    assert.equal(noLine.dataset.tip, 'D:/a.js');
    assert.equal(noLine.dataset.aiRefLine, '0');
    // 防御：没有节点 / 没有 dataset 都不炸（虚拟文档、测试桩可能没有 dataset）
    assert.doesNotThrow(() => applyFileRefChip(null, 'x', null));
    assert.doesNotThrow(() => applyFileRefChip({}, 'x', null));
});
