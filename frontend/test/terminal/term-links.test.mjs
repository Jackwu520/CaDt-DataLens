// 终端链接检测纯函数测试：URL 提取与尾巴修剪、跨软换行行拼接的坐标换算
// （含宽字符 cell 映射）、指针命中判定。用法：npm test（package.json 的 test 脚本里显式列出本文件）
import test from 'node:test';
import assert from 'node:assert/strict';

import {matchLinks, trimLinkTail, linkRangeInRows, linkHitAt} from '../../src/terminal/term-links.js';

test('trimLinkTail：普通标点与引号剪掉，配对括号保留、未配对括号剪掉', () => {
    assert.equal(trimLinkTail('http://x.com/a.'), 'http://x.com/a');
    assert.equal(trimLinkTail('http://x.com/a,'), 'http://x.com/a');
    assert.equal(trimLinkTail('http://x.com/a:'), 'http://x.com/a');
    assert.equal(trimLinkTail('http://x.com/a\''), 'http://x.com/a');
    // 配对括号是 URL 本体（Wikipedia 风格）
    assert.equal(trimLinkTail('https://x.com/Foo_(bar)'), 'https://x.com/Foo_(bar)');
    assert.equal(trimLinkTail('https://x.com/a)'), 'https://x.com/a');
    assert.equal(trimLinkTail('https://x.com/a),'), 'https://x.com/a');
    assert.equal(trimLinkTail('https://x.com/a]'), 'https://x.com/a');
});

test('matchLinks：vite 输出行提取 localhost 链接', () => {
    const links = matchLinks('Local:   http://localhost:5173/');
    assert.equal(links.length, 1);
    assert.equal(links[0].text, 'http://localhost:5173/');
    assert.equal(links[0].start, 9);
    assert.equal(links[0].end, 31);
});

test('matchLinks：无链接行返回空、多链接各自成段、尾巴标点入剪', () => {
    assert.deepEqual(matchLinks('Network: use --host to expose'), []);
    assert.deepEqual(matchLinks('press h + enter to show help'), []);
    const two = matchLinks('a http://a.io mid https://b.io/c.');
    assert.equal(two.length, 2);
    assert.equal(two[0].text, 'http://a.io');
    assert.equal(two[1].text, 'https://b.io/c');
});

test('matchLinks：scheme:// 后无 host 剔除、单字符 host 合法', () => {
    assert.deepEqual(matchLinks('http:// alone'), []);
    const one = matchLinks('go http://x');
    assert.equal(one.length, 1);
    assert.equal(one[0].text, 'http://x');
});

test('linkRangeInRows：跨软换行的长 URL 拼成一段（坐标按各行给出）', () => {
    const rows = [
        {y: 5, text: 'see http://exam', colOf: null, wideAt: null},
        {y: 6, text: 'ple.com/a ok', colOf: null, wideAt: null},
    ];
    // 拼接文本 'see http://example.com/a ok'，URL 占 [4, 24)
    const range = linkRangeInRows(rows, {start: 4, end: 24});
    assert.deepEqual(range, {start: {x: 5, y: 5}, end: {x: 9, y: 6}});
});

test('linkRangeInRows：宽字符（中文）按 cell 列换算，URL 末字符是宽字符时含住后半格', () => {
    // '中 http://a/文'：中占 cell0-1、空格 cell2、URL 从 cell3 起、文占 cell12-13
    const rows = [{
        y: 7,
        text: '中 http://a/文',
        colOf: [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        wideAt: new Set([0, 11]),
    }];
    const range = linkRangeInRows(rows, {start: 2, end: 12});
    assert.deepEqual(range, {start: {x: 4, y: 7}, end: {x: 14, y: 7}});
});

test('linkRangeInRows：URL 前有宽字符时起点按 cell 列右移', () => {
    // '中文 http://a'：中 cell0-1、文 cell2-3、空格 cell4、URL 占 cell5-12
    const rows = [{
        y: 1,
        text: '中文 http://a',
        colOf: [0, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        wideAt: new Set([0, 1]),
    }];
    const range = linkRangeInRows(rows, {start: 3, end: 11});
    assert.deepEqual(range, {start: {x: 6, y: 1}, end: {x: 13, y: 1}});
});

test('linkRangeInRows：软换行序列中间有空行时偏移落到后继行', () => {
    const rows = [
        {y: 1, text: 'http://a', colOf: null, wideAt: null},
        {y: 2, text: '', colOf: null, wideAt: null},
        {y: 3, text: '/b', colOf: null, wideAt: null},
    ];
    const range = linkRangeInRows(rows, {start: 0, end: 10});
    assert.deepEqual(range, {start: {x: 1, y: 1}, end: {x: 2, y: 3}});
});

test('linkRangeInRows：结构异常返回 null', () => {
    assert.equal(linkRangeInRows(null, {start: 0, end: 1}), null);
    assert.equal(linkRangeInRows([], {start: 0, end: 1}), null);
    assert.equal(linkRangeInRows([{y: 1, text: 'ab', colOf: null, wideAt: null}], {start: 1, end: 1}), null);
});

test('linkHitAt：单行链接按行列命中，端点含、范围外与异行不命中', () => {
    const links = [{text: 'http://a.io', range: {start: {x: 5, y: 3}, end: {x: 15, y: 3}}}];
    assert.equal(linkHitAt(links, 3, 5, 80), 'http://a.io');
    assert.equal(linkHitAt(links, 3, 15, 80), 'http://a.io');
    assert.equal(linkHitAt(links, 3, 4, 80), '');
    assert.equal(linkHitAt(links, 3, 16, 80), '');
    assert.equal(linkHitAt(links, 2, 5, 80), '');
    assert.equal(linkHitAt(links, 4, 5, 80), '');
});

test('linkHitAt：跨行链接首末行按端点收窄、中段整行命中', () => {
    const two = [{text: 'http://example.com/a', range: {start: {x: 5, y: 1}, end: {x: 9, y: 2}}}];
    assert.equal(linkHitAt(two, 1, 5, 80), 'http://example.com/a');
    assert.equal(linkHitAt(two, 1, 4, 80), '');
    assert.equal(linkHitAt(two, 2, 1, 80), 'http://example.com/a');
    assert.equal(linkHitAt(two, 2, 9, 80), 'http://example.com/a');
    assert.equal(linkHitAt(two, 2, 10, 80), '');
    // 三行链接：中段整行（首尾列都算）
    const three = [{text: 'http://example.com/long', range: {start: {x: 3, y: 1}, end: {x: 6, y: 3}}}];
    assert.equal(linkHitAt(three, 2, 1, 80), 'http://example.com/long');
    assert.equal(linkHitAt(three, 2, 80, 80), 'http://example.com/long');
    assert.equal(linkHitAt(three, 2, 4, 80), 'http://example.com/long');
});

test('linkHitAt：多链接各按自己的 range 判定', () => {
    const links = [
        {text: 'http://a.io', range: {start: {x: 1, y: 2}, end: {x: 10, y: 2}}},
        {text: 'https://b.io/c', range: {start: {x: 20, y: 2}, end: {x: 33, y: 2}}},
    ];
    assert.equal(linkHitAt(links, 2, 1, 80), 'http://a.io');
    assert.equal(linkHitAt(links, 2, 20, 80), 'https://b.io/c');
    assert.equal(linkHitAt(links, 2, 15, 80), '');
});

test('linkHitAt：空输入与异常结构返回空串', () => {
    assert.equal(linkHitAt(null, 1, 1, 80), '');
    assert.equal(linkHitAt(undefined, 1, 1, 80), '');
    assert.equal(linkHitAt([], 1, 1, 80), '');
    assert.equal(linkHitAt([{text: 'x', range: null}], 1, 1, 80), '');
    assert.equal(linkHitAt([{}], 1, 1, 80), '');
});
