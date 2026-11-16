// test-manifest.test.mjs —— `npm test` 清单守卫。
//
// 背景：`frontend/package.json` 的 test 脚本是**硬编码文件列表**（没有 glob），新增一个
// `.test.mjs` 忘了登记，测试就永远不会跑——本地绿、CI 绿，只有出错时才想起来它没跑过。
// 这条守卫双向核对：目录里的每个测试文件都在清单里，清单里的每一条都真实存在。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {dirname, join, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // frontend/test/core
const testRoot = join(here, '..'); // frontend/test
const frontendRoot = join(testRoot, '..'); // frontend

function walk(dir, out = []) {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith('.test.mjs')) out.push(full);
    }
    return out;
}

const toRel = (abs) => relative(frontendRoot, abs).split(sep).join('/');
const files = walk(testRoot).map(toRel).sort();
const script = JSON.parse(readFileSync(join(frontendRoot, 'package.json'), 'utf8')).scripts.test || '';
const listed = [...new Set([...script.matchAll(/(?:^|\s)(test\/[A-Za-z0-9_./-]+\.test\.mjs)(?=\s|$)/g)].map((m) => m[1]))].sort();

test('每个测试文件都登记进 npm test 清单', () => {
    const missing = files.filter((file) => !listed.includes(file));
    assert.deepEqual(missing, [],
        '这些测试文件没写进 frontend/package.json 的 test 脚本，永远不会被执行');
});

test('npm test 清单里没有指向不存在文件的条目', () => {
    const dangling = listed.filter((file) => !files.includes(file));
    assert.deepEqual(dangling, [], '清单里这些文件不存在（改名 / 删除后没清）');
});

test('清单没有重复条目', () => {
    const all = [...script.matchAll(/(?:^|\s)(test\/[A-Za-z0-9_./-]+\.test\.mjs)(?=\s|$)/g)].map((m) => m[1]);
    const dup = all.filter((file, index) => all.indexOf(file) !== index);
    assert.deepEqual([...new Set(dup)], [], '清单里同一文件登记了多次');
});
