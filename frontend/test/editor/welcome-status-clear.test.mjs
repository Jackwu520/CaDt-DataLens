// welcome-status-clear.test.mjs —— 欢迎页状态栏残留守卫。
//
// 背景（用户实测）：关掉所有标签回到欢迎页后，状态栏仍挂着上一个文件的
// 「全文 4058 字」「1:1」——这三项（字数 stCount / 缩放 stZoom / 光标位置 stPos）
// 只在有文档时更新（updateStatus / updateWordCount），showWelcome 漏清就一直残留。
// showWelcome 依赖重（destroy 编辑器、渲染标签、刷新结构面板等），这里走源码守卫。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../../src/editor/editor-groups.js', import.meta.url)), 'utf8');

// 按大括号匹配切出顶层函数体（函数内无含花括号的字符串/注释）。
function extractFunction(signature) {
    const start = src.indexOf(signature);
    assert.ok(start >= 0, '找不到函数：' + signature);
    let depth = 0;
    let opened = false;
    for (let i = start; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') { depth++; opened = true; }
        else if (ch === '}') {
            depth--;
            if (opened && depth === 0) return src.slice(start, i + 1);
        }
    }
    assert.fail('函数大括号不闭合：' + signature);
}

test('showWelcome 关掉最后一个标签时清空字数/缩放/光标位置', () => {
    const body = extractFunction('function showWelcome()');
    for (const key of ['stCount', 'stZoom', 'stPos']) {
        assert.ok(body.includes('deps.els.' + key + '.textContent = '),
            'showWelcome 必须清空 deps.els.' + key + '.textContent，否则欢迎页状态栏残留上一个文档的值');
    }
    // stCount 是 span 且无 :empty 隐藏规则，清空文本后还需显式隐藏
    assert.ok(body.includes("deps.els.stCount.style.display = 'none'"),
        'stCount 清空文本后需显式 display:none，避免留下空占位');
});
