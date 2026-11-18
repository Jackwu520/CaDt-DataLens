// app-links-readonly.test.mjs —— 内置法律文档只读视图接线护栏。
// 用户协议 / 隐私协议是内嵌的虚拟文档（无真实路径、无法保存），必须以固定只读
// （readOnlyFixed）打开：不可解锁、右键不出现解锁入口，与审阅快照同一机制。
// app-links.js 顶层 import 了 ?raw 文本，Node 无法直接执行，故按仓库惯例做源码接线断言。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const src = readFileSync(new URL('../../src/shell/app-links.js', import.meta.url), 'utf8');

test('openBundledDoc 把 readOnlyFixed 标记透传给 openVirtualDoc', () => {
    assert.match(src,
        /openVirtualDoc\(name,\s*text,\s*readOnlyFixed\s*\?\s*\{readOnlyFixed:\s*true\}\s*:\s*undefined\)/,
        'openBundledDoc 必须在 readOnlyFixed 时以 {readOnlyFixed: true} 建虚拟文档');
});

test('用户协议与隐私协议以固定只读打开', () => {
    const terms = src.match(/function showTerms\(\)\s*\{([\s\S]*?)\}/);
    const privacy = src.match(/function showPrivacy\(\)\s*\{([\s\S]*?)\}/);
    assert.ok(terms, '必须存在 showTerms');
    assert.ok(privacy, '必须存在 showPrivacy');
    assert.match(terms[1], /openBundledDoc\([\s\S]*?,\s*true\)/, 'showTerms 必须传 readOnlyFixed=true');
    assert.match(privacy[1], /openBundledDoc\([\s\S]*?,\s*true\)/, 'showPrivacy 必须传 readOnlyFixed=true');
});
