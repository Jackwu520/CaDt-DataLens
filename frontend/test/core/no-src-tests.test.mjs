// 目录守卫：测试统一放 frontend/test/<域>/（镜像 src/），src 下不再允许散落 *.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

test('src/ 下禁止放 *.test.mjs（测试统一放 frontend/test/）', () => {
    const offenders = readdirSync(SRC, {recursive: true})
        .map((rel) => String(rel).replace(/\\/g, '/'))
        .filter((rel) => rel.endsWith('.test.mjs'));
    assert.deepEqual(offenders, [], `发现散落在 src/ 的测试文件：\n${offenders.join('\n')}`);
});