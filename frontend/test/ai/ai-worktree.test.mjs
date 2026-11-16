import test from 'node:test';
import assert from 'node:assert/strict';
import {
    WORKTREE_REL_DIR,
    WORKTREE_PATCH_LIMIT,
    normalizeWorktreeState,
    worktreeRelPath,
    worktreeBlockText,
    formatWorktreeList,
    agentWorktreeWriteVerdict,
    resolveWorktreeTarget,
} from '../../src/ai/ai-worktree.js';

test('normalizeWorktreeState：合法 / 缺 name / 非对象', () => {
    const wt = normalizeWorktreeState({
        name: 'refactor-cdef1234',
        branch: 'cadt/wt/refactor-cdef1234',
        path: 'D:/repo/.cadt/worktree/refactor-cdef1234',
        baseSha: 'abc1234567',
        createdAt: 100,
    });
    assert.equal(wt.name, 'refactor-cdef1234');
    assert.equal(wt.branch, 'cadt/wt/refactor-cdef1234');
    assert.equal(wt.path, 'D:/repo/.cadt/worktree/refactor-cdef1234');
    assert.equal(wt.baseSha, 'abc1234567');
    assert.equal(wt.createdAt, 100);

    assert.equal(normalizeWorktreeState(null), null);
    assert.equal(normalizeWorktreeState('x'), null);
    assert.equal(normalizeWorktreeState({name: '  '}), null);
    assert.equal(normalizeWorktreeState({name: 'ok', extra: 'ignored'}).extra, undefined);
    assert.equal(normalizeWorktreeState({}), null); // 缺 name 整体归一成 null
});

test('worktreeRelPath 与常量口径', () => {
    assert.equal(WORKTREE_REL_DIR, '.cadt/worktree');
    assert.equal(worktreeRelPath('demo-ab12'), '.cadt/worktree/demo-ab12');
    assert.ok(WORKTREE_PATCH_LIMIT > 0);
});

test('worktreeBlockText：写清前缀 / 分支 / 不承诺测试 / export 收尾', () => {
    const block = worktreeBlockText({name: 'demo-ab12', branch: 'cadt/wt/demo-ab12'});
    assert.ok(block.startsWith('<worktree>'));
    assert.ok(block.includes('.cadt/worktree/demo-ab12'));
    assert.ok(block.includes('cadt/wt/demo-ab12'));
    assert.ok(block.includes('action=export'));
    assert.ok(block.includes('discard'));
    assert.ok(block.includes('不要改主根同名文件'));
    // 没有 worktree 时为空串（不注入）
    assert.equal(worktreeBlockText(null), '');
    assert.equal(worktreeBlockText({}), '');
});

test('formatWorktreeList：orphan 判定由会话登记算出', () => {
    const result = {
        available: true,
        items: [
            {path: 'D:/repo/.cadt/worktree/mine', relPath: '.cadt/worktree/mine', branch: 'cadt/wt/mine', underCadt: true},
            {path: 'D:/repo/.cadt/worktree/orphan', relPath: '.cadt/worktree/orphan', branch: 'cadt/wt/orphan', underCadt: true},
            {path: 'D:/elsewhere/wt', relPath: '../../elsewhere/wt', branch: 'main', underCadt: false},
        ],
    };
    const sessions = [
        {id: 's1', worktree: {name: 'mine', path: 'D:/repo/.cadt/worktree/mine'}},
        {id: 's2', _stub: true, worktree: null}, // 占位会话没有 worktree，不参与登记
    ];
    const text = formatWorktreeList(result, sessions);
    assert.ok(text.includes('.cadt/worktree/mine'));
    assert.ok(text.includes('.cadt/worktree/orphan'));
    assert.ok(!text.includes('孤儿（无会话登记') || text.split('\n').find((l) => l.includes('mine') && l.includes('孤儿')) === undefined,
        '本会话登记的 worktree 不应标孤儿');
    const orphanLine = text.split('\n').find((l) => l.includes('orphan'));
    assert.ok(orphanLine.includes('孤儿'), '孤儿条目应标记：' + orphanLine);
    // 非 .cadt/worktree 下的条目不标孤儿（用户自己的 worktree 不归我们管）
    const userLine = text.split('\n').find((l) => l.includes('elsewhere'));
    assert.ok(!userLine.includes('孤儿'));
});

test('formatWorktreeList：git 不可用时优雅降级', () => {
    const text = formatWorktreeList({available: false, reason: '不在 git 仓库内'}, []);
    assert.ok(text.includes('不在 git 仓库内'));
    const empty = formatWorktreeList({available: true, items: []}, []);
    assert.ok(empty.includes('0 个'));
});

test('formatWorktreeList：stats 参数给每个隔离区附改动统计（对比 lite）', () => {
    const result = {
        available: true,
        items: [
            {path: 'D:/repo/.cadt/worktree/a', relPath: '.cadt/worktree/a', branch: 'cadt/wt/a', underCadt: true},
            {path: 'D:/repo/.cadt/worktree/b', relPath: '.cadt/worktree/b', branch: 'cadt/wt/b', underCadt: true},
        ],
    };
    const text = formatWorktreeList(result, [], {'.cadt/worktree/a': ' 2 files changed, 5 insertions(+), 1 deletion(-)', '.cadt/worktree/b': ''});
    const aLine = text.split('\n').find((l) => l.includes('.cadt/worktree/a'));
    const bLine = text.split('\n').find((l) => l.includes('.cadt/worktree/b'));
    const aStat = text.split('\n').find((l) => l.includes('2 files changed'));
    assert.ok(aLine && aStat, '有统计的条目应附一行改动');
    assert.ok(!bLine.includes('改动'), '空统计不附加行');
    // 不传 stats（一期调用形态）不附统计、不报错
    const plain = formatWorktreeList(result, []);
    assert.ok(!plain.includes('改动：'));
});

test('agentWorktreeWriteVerdict：子代理写闸——前缀内放行、前缀外确定性拒绝', () => {
    const wt = {name: 'sub-ab12', baseSha: 'abc'};
    // 前缀内（大小写 / 反斜杠归一）
    assert.equal(agentWorktreeWriteVerdict(wt, '.cadt/worktree/sub-ab12/src/a.js').verdict, 'allow');
    assert.equal(agentWorktreeWriteVerdict(wt, '.CADT/WORKTREE/SUB-AB12/a.js').verdict, 'allow');
    assert.equal(agentWorktreeWriteVerdict(wt, '.cadt/worktree/sub-ab12').verdict, 'allow');
    // 前缀外：主根其他路径、同名前缀目录、别的隔离区
    assert.equal(agentWorktreeWriteVerdict(wt, 'src/main.js').verdict, 'deny');
    assert.equal(agentWorktreeWriteVerdict(wt, '.cadt/worktree/sub-ab12-x/a.js').verdict, 'deny');
    assert.equal(agentWorktreeWriteVerdict(wt, '.cadt/worktree/other/a.js').verdict, 'deny');
    // 没登记 → 拒绝（write 工具本不该挂，双保险）
    assert.equal(agentWorktreeWriteVerdict(null, '.cadt/worktree/x/a.js').verdict, 'deny');
    assert.ok(agentWorktreeWriteVerdict(wt, 'src/main.js').message.includes('WORKTREE_SCOPE'));
});

test('resolveWorktreeTarget：by-name 只认本会话拥有的隔离区', () => {
    const own = {name: 'mine-ab12', branch: 'cadt/wt/mine-ab12', path: 'D:/r/.cadt/worktree/mine-ab12', baseSha: 'sha-own'};
    const subs = [{name: 'sub-1', baseSha: 'sha-1'}, {name: 'sub-2', baseSha: 'sha-2'}];
    // 缺省 = 自己的
    const def = resolveWorktreeTarget(own, subs, '');
    assert.equal(def.wt.name, 'mine-ab12');
    assert.equal(def.own, true);
    // name 命中自己 / 子代理
    assert.equal(resolveWorktreeTarget(own, subs, 'mine-ab12').own, true);
    const subHit = resolveWorktreeTarget(own, subs, 'sub-1');
    assert.equal(subHit.wt.name, 'sub-1');
    assert.equal(subHit.own, false);
    assert.equal(subHit.wt.baseSha, 'sha-1');
    // 大小写不敏感
    assert.equal(resolveWorktreeTarget(own, subs, 'SUB-2').wt.name, 'sub-2');
    // 归属外 / 不存在 → null
    assert.equal(resolveWorktreeTarget(own, subs, 'other-session'), null);
    // 没有自己的隔离区时缺省 → null；带 name 命中子代理仍可用
    assert.equal(resolveWorktreeTarget(null, subs, ''), null);
    assert.equal(resolveWorktreeTarget(null, subs, 'sub-1').wt.name, 'sub-1');
    // baseSha 缺失的登记不可信（不进命中）
    assert.equal(resolveWorktreeTarget(own, [{name: 'sub-3'}], 'sub-3'), null);
});
