// core/scratch.js 纯函数用例：草稿目录 / 命名 / 扩展名 / 空白判定 / 草稿架列表。
// 方案：docs/finished-plans/scratch-file.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_SCRATCH_EXT, SCRATCH_SUBDIR,
    isBlankDraftText, isScratchPath, listScratchDrafts, normalizeScratchExt,
    scratchDir, scratchDraftName, scratchExtFromName, scratchStamp,
} from '../../src/core/scratch.js';

test('normalizeScratchExt：统一成小写带点的扩展名，非法值回落默认', () => {
    assert.equal(normalizeScratchExt('md'), '.md');
    assert.equal(normalizeScratchExt('.MD'), '.md');
    assert.equal(normalizeScratchExt('  .Json  '), '.json');
    assert.equal(normalizeScratchExt('.c'), '.c'); // 单字母扩展名要留着
    assert.equal(normalizeScratchExt(''), DEFAULT_SCRATCH_EXT);
    assert.equal(normalizeScratchExt(null), DEFAULT_SCRATCH_EXT);
    assert.equal(normalizeScratchExt('.'), DEFAULT_SCRATCH_EXT);
    // 路径分隔符 / 通配符后面的部分一律丢掉，不拼出跨目录的文件名
    assert.equal(normalizeScratchExt('md/evil'), '.md');
    assert.equal(normalizeScratchExt('.md|x'), '.md');
    assert.equal(normalizeScratchExt('.md '), '.md');
});

test('scratchExtFromName：从文档名取扩展名，无扩展名回落 .txt（选区建草稿用）', () => {
    assert.equal(scratchExtFromName('data.json'), '.json');
    assert.equal(scratchExtFromName('C:\\ws\\x\\Script.PY'), '.py');
    assert.equal(scratchExtFromName('no-ext'), '.txt');
    assert.equal(scratchExtFromName('Dockerfile'), '.txt');
    assert.equal(scratchExtFromName('.gitignore'), '.txt'); // 隐藏文件名不是扩展名
    assert.equal(scratchExtFromName('trailing.'), '.txt');
    assert.equal(scratchExtFromName(''), '.txt');
});

test('scratchDir / isScratchPath：草稿目录固定在工作区 .cadt/scratch 下', () => {
    assert.equal(SCRATCH_SUBDIR, '.cadt/scratch');
    assert.equal(scratchDir('D:\\ws'), 'D:/ws/.cadt/scratch');
    assert.equal(scratchDir('D:/ws/'), 'D:/ws/.cadt/scratch');
    assert.equal(scratchDir(''), '');
    assert.equal(scratchDir(null), '');

    assert.equal(isScratchPath('D:\\ws', 'D:\\ws\\.cadt\\scratch\\scratch_1.md'), true);
    assert.equal(isScratchPath('D:/ws', 'D:/WS/.cadt/scratch/a.txt'), true); // 大小写不敏感
    assert.equal(isScratchPath('D:/ws', 'D:/ws/.cadt/scratch'), false); // 目录本身不算文件
    assert.equal(isScratchPath('D:/ws', 'D:/ws/.cadt/tmp/a.md'), false); // AI 免审写区不算草稿
    assert.equal(isScratchPath('D:/ws', 'D:/ws/src/a.md'), false);
    assert.equal(isScratchPath('', 'D:/ws/.cadt/scratch/a.md'), false);
    assert.equal(isScratchPath('D:/ws', ''), false);
});

test('scratchStamp / scratchDraftName：JetBrains 风格 scratch[-N].<ext>', () => {
    const at = new Date(2026, 10, 21, 16, 46, 5); // 本地时间 2026-11-21 16:46:05
    assert.equal(scratchStamp(at), '20261121-164605');
    assert.equal(scratchDraftName('md'), 'scratch.md');
    assert.equal(scratchDraftName('.JSON'), 'scratch.json');
    assert.equal(scratchDraftName('.md', 0), 'scratch.md');
    assert.equal(scratchDraftName('.md', 1), 'scratch_1.md');
    assert.equal(scratchDraftName('.md', 2), 'scratch_2.md');
    // 个位数月/日/时/分/秒必须补零，否则文件名排序会错乱
    assert.equal(scratchStamp(new Date(2026, 0, 2, 3, 4, 5)), '20260102-030405');
});

test('isBlankDraftText：空白草稿判据（BOM / 全角空格也算空）', () => {
    assert.equal(isBlankDraftText(''), true);
    assert.equal(isBlankDraftText(null), true);
    assert.equal(isBlankDraftText(undefined), true);
    assert.equal(isBlankDraftText('   \r\n\t '), true);
    assert.equal(isBlankDraftText('\uFEFF'), true);
    assert.equal(isBlankDraftText('\u3000'), true);
    assert.equal(isBlankDraftText('a'), false);
    assert.equal(isBlankDraftText('\uFEFFx'), false);
});

test('listScratchDrafts：按 mtime 倒序、跳过目录、IO 失败当没有草稿', async () => {
    const seen = [];
    const io = {
        readDir: async (path, limit) => {
            seen.push({path, limit});
            return {
                entries: [
                    {name: '旧.md', path: 'D:/ws/.cadt/scratch/旧.md', isDir: false, mtime: 100, size: 3},
                    {name: 'sub', path: 'D:/ws/.cadt/scratch/sub', isDir: true, mtime: 900},
                    {name: '新.txt', path: 'D:/ws/.cadt/scratch/新.txt', isDir: false, mtime: 800, size: 12},
                ],
            };
        },
    };
    const rows = await listScratchDrafts(io, 'D:\\ws');
    assert.deepEqual(seen, [{path: 'D:/ws/.cadt/scratch', limit: 200}]);
    assert.deepEqual(rows.map((row) => row.name), ['新.txt', '旧.md']);
    assert.deepEqual(rows[0], {name: '新.txt', path: 'D:/ws/.cadt/scratch/新.txt', size: 12, mtime: 800});

    // 没有工作区 / 没有 readDir / 读取抛错：一律空列表，草稿架不该因此报错
    assert.deepEqual(await listScratchDrafts(io, ''), []);
    assert.deepEqual(await listScratchDrafts(null, 'D:/ws'), []);
    assert.deepEqual(await listScratchDrafts({readDir: async () => { throw new Error('ENOENT'); }}, 'D:/ws'), []);
    assert.deepEqual(await listScratchDrafts({readDir: async () => null}, 'D:/ws'), []);
});
