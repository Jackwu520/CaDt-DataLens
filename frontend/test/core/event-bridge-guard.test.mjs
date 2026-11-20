// 事件桥守卫：EventsOn 只允许出现在 core/app-events.js（和 dev mock），
// 并且桥注册的事件名必须已在 event-scope.js 分类。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {EVENT_SCOPES} from '../../src/core/event-scope.js';

const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url));

function listJS(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) listJS(full, out);
        else if (name.endsWith('.js')) out.push(full);
    }
    return out;
}

const allowEventsOn = new Set([
    join('core', 'app-events.js'),
    join('dev', 'mock-backend.js'),
]);

test('EventsOn 只允许出现在桥与 mock', () => {
    const violations = [];
    for (const file of listJS(srcRoot)) {
        const rel = relative(srcRoot, file);
        if (allowEventsOn.has(rel)) continue;
        const text = readFileSync(file, 'utf8');
        const lines = text.split(/\r?\n/);
        lines.forEach((line, i) => {
            // 只认真正的调用形态，注释里的普通叙述不算。
            if (/\.EventsOn\s*\(/.test(line)) violations.push(`${rel}:${i + 1}`);
        });
    }
    assert.deepEqual(violations, [], '发现绕过事件桥的 EventsOn：' + violations.join(', '));
});

test('桥注册的字面事件名必须已在 event-scope 分类', () => {
    const files = listJS(srcRoot);
    const re = /__appEvents\.[a-zA-Z]+\(\s*'([^']+)'|appEvents\.(onApp|onWindow|onWorkspace|onOwned|onResource)\(\s*'([^']+)'|bridge\.(onApp|onWindow|onWorkspace|onOwned|onResource)\(\s*'([^']+)'/g;
    const missing = [];
    for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(re)) {
            const name = m[1] || m[3] || m[5];
            if (name && !EVENT_SCOPES[name]) missing.push(`${relative(srcRoot, file)}: ${name}`);
        }
    }
    assert.deepEqual(missing, [], '未分类事件：' + missing.join(', '));
});

test('ai-* 动态注册列表与分类表一致', () => {
    const main = readFileSync(join(srcRoot, 'main.js'), 'utf8');
    const m = main.match(/for \(const eventName of \[([^\]]+)\]\)/);
    assert.ok(m, 'main.js 里找不到 ai-* 事件列表');
    const names = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    assert.deepEqual(names.sort(), ['ai-chunk', 'ai-done', 'ai-error', 'ai-param-adjust', 'ai-queue', 'ai-retry', 'ai-think', 'ai-toolcall']);
    for (const name of names) assert.ok(EVENT_SCOPES[name], '缺分类：' + name);
});
