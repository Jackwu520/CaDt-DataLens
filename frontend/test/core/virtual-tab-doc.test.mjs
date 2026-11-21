// virtual-tab-doc.test.mjs —— 虚拟标签页 doc 工厂的字段契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createVirtualTabDoc} from '../../src/core/virtual-tab-doc.js';

const FMT = {id: 'memo', name: '快捷便签', extensions: [], aceMode: 'text', rawOnly: true};

test('公共字段：虚拟标签页一律无路径、未命名、无脏标记', () => {
    const doc = createVirtualTabDoc({id: 'memo-panel', name: '快捷便签', format: FMT, mode: 'memo', marker: 'memo', key: 'panel'});
    assert.equal(doc.path, null);
    assert.equal(doc.content, '');
    assert.equal(doc.size, 0);
    assert.equal(doc.eol, 'lf');
    assert.equal(doc.hasBom, false);
    assert.equal(doc.large, false);
    assert.equal(doc.enc, 'utf-8');
    assert.equal(doc.treeAvailable, false);
    assert.equal(doc.dirty, false);
    assert.equal(doc.untitled, false);
    assert.deepEqual(doc.bases, {});
    assert.equal(doc.savedText, '');
    assert.equal(doc.mode, 'memo');
    assert.equal(doc.format, FMT);
});

test('标记位：marker + key 成对落成 doc 上的一个字段', () => {
    const doc = createVirtualTabDoc({id: 'x', name: 'x', format: FMT, mode: 'm', marker: 'bgTerm', key: 'job-7'});
    assert.equal(doc.bgTerm, 'job-7');
    // 不该顺手写别的标记位
    assert.equal(doc.browser, undefined);
    assert.equal(doc.memo, undefined);
});

test('省略 marker 时不写任何标记位（文本型走这条）', () => {
    const doc = createVirtualTabDoc({id: 'x', name: 'x', format: FMT, mode: 'm'});
    for (const key of ['browser', 'bgTerm', 'agentView', 'agentTeam', 'sideChat', 'groupMember', 'memo']) {
        assert.equal(doc[key], undefined, key + ' 不该出现');
    }
});

test('extra：域私有字段原样合并', () => {
    const doc = createVirtualTabDoc({
        id: 'browser-user',
        name: '我的浏览器',
        format: FMT,
        mode: 'browser',
        marker: 'browser',
        key: true,
        extra: {browserPersist: true, browserUrl: 'about:blank', browserProfile: 'user'},
    });
    assert.equal(doc.browser, true);
    assert.equal(doc.browserPersist, true);
    assert.equal(doc.browserUrl, 'about:blank');
    assert.equal(doc.browserProfile, 'user');
});

test('extra 不得覆盖公共字段（防止误传 path 破坏「虚拟文档」语义）', () => {
    // 这是防呆：调用方手滑传 path 会让 doc 被当成磁盘文件参与保存 / 重载。
    // 工厂允许 extra 覆盖，所以这里钉住「各域不要传这几个键」的边界——
    // 断言的是当前实现的行为，改实现时必须有意识地改这条测试。
    const doc = createVirtualTabDoc({id: 'x', name: 'x', format: FMT, mode: 'm', extra: {path: '/evil.json'}});
    assert.equal(doc.path, '/evil.json', 'extra 是直接 Object.assign 的；调用方须自查不传 path');
});

test('7 类真实调用形态：字段集与改造前逐字段一致', () => {
    const cases = [
        {id: 'browser-abc', name: 'https://a.com', mode: 'browser', marker: 'browser', key: true,
            extra: {browserPersist: false, browserUrl: 'https://a.com', browserProfile: 'tab-browser-abc'}},
        {id: 'bgterm-job-1', name: 'npm run dev', mode: 'bgterm', marker: 'bgTerm', key: 'job-1',
            extra: {bgTermCommand: 'npm run dev'}},
        {id: 'agentview-sub1', name: '调查', mode: 'agentview', marker: 'agentView', key: 'sub1',
            extra: {agentViewSpec: {subId: 'sub1', name: '调查'}}},
        {id: 'agentteam-s1', name: '团队', mode: 'agentteam', marker: 'agentTeam', key: 's1',
            extra: {agentTeamSpec: {sessionId: 's1', title: '团队'}}},
        {id: 'sidechat-s2', name: '支线', mode: 'sidechat', marker: 'sideChat', key: 's2',
            extra: {sideChatMeta: {ownerTitle: '', snapAt: 0}}},
        {id: 'groupmember-g1-a1', name: '成员', mode: 'groupmember', marker: 'groupMember', key: 'g1:a1',
            extra: {groupMemberSpec: {groupId: 'g1', agentId: 'a1', name: '成员', groupTitle: ''}}},
        {id: 'memo-panel', name: '快捷便签', mode: 'memo', marker: 'memo', key: 'panel'},
    ];
    for (const c of cases) {
        const doc = createVirtualTabDoc({...c, format: FMT});
        assert.equal(doc.id, c.id);
        assert.equal(doc.name, c.name);
        assert.equal(doc.mode, c.mode);
        assert.equal(doc.path, null);
        assert.equal(doc[c.marker], c.key, c.marker + ' 标记位没落上');
        for (const [k, v] of Object.entries(c.extra || {})) {
            assert.deepEqual(doc[k], v, c.marker + ' 的 extra 字段 ' + k + ' 丢了');
        }
    }
});
