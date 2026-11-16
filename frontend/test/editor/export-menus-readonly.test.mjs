// 标签页右键菜单：固定只读（审阅快照）不给解锁入口，普通标签仍可锁定 / 解锁。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createEditorExportMenus} from '../../src/editor/editor-export-menus.js';

function tabMenuFor(doc, calls) {
    let items = null;
    const deps = {
        ctxMenu: {open: (list) => { items = list; }},
        groupOfDoc: () => ({id: 'g1'}),
        groupDocs: () => [doc],
        docs: [doc],
        closedTabs: [],
        aiReferenceFileMenuItems: () => [],
        requestCloseDoc: () => {},
        closeDocsWithConfirm: () => {},
        copyText: () => {},
        showPathInFolder: () => {},
        openDiffDialog: () => {},
        openInNewWindows: () => {},
        reopenClosedTab: () => {},
        setDocReadOnly: (target, locked) => calls.push([target, locked]),
    };
    const mod = createEditorExportMenus(deps);
    mod.showTabMenu(doc, 10, 10);
    return items;
}

const lockItems = (items) => items.filter((item) => item.label && item.label.includes('只读'));

// AI 引用统一入口后：标签页菜单不再有独立的「在 AI 中询问此文件」（防回归——引用路径与询问曾并排出现）
test('标签页右键菜单：不出现「在 AI 中询问此文件」', () => {
    const doc = {id: 3, name: 'sample.json', path: 'C:/data/sample.json'};
    const items = tabMenuFor(doc, []);
    assert.equal(items.filter((item) => item.label === '在 AI 中询问此文件').length, 0);
});

test('固定只读标签：只有禁用的「不可解锁」说明，没有任何解锁入口', () => {
    const doc = {id: 1, name: '本轮改动审阅.diff', path: null, readOnlyFixed: true, readOnlyLocked: true};
    const items = tabMenuFor(doc, []);
    const locks = lockItems(items);
    assert.equal(locks.length, 1);
    assert.match(locks[0].label, /不可解锁/);
    assert.equal(locks[0].disabled, true);
    assert.equal(typeof locks[0].action, 'undefined');
    assert.equal(items.some((item) => item.label === '解除本标签只读'), false);
});

test('普通标签：仍可锁定与解锁，动作参数正确', () => {
    const calls = [];
    const plain = {id: 2, name: 'a.json', path: 'D:/a.json'};
    const plainItems = tabMenuFor(plain, calls);
    const addLock = lockItems(plainItems)[0];
    assert.equal(addLock.label, '只读锁定本标签');
    assert.equal(!!addLock.disabled, false);
    addLock.action();
    assert.deepEqual(calls[0], [plain, true]);

    const lockedDoc = {...plain, readOnlyLocked: true};
    const lockedItems = tabMenuFor(lockedDoc, calls);
    const removeLock = lockItems(lockedItems)[0];
    assert.equal(removeLock.label, '解除本标签只读');
    removeLock.action();
    assert.deepEqual(calls[1], [lockedDoc, false]);
});

test('固定锁优先于普通锁：两者都在时也不出现解锁项', () => {
    const doc = {id: 3, name: 'snapshot.diff', path: null, readOnlyFixed: true, readOnlyLocked: false};
    const items = tabMenuFor(doc, []);
    assert.equal(items.some((item) => item.label === '解除本标签只读'), false);
    assert.match(lockItems(items)[0].label, /不可解锁/);
});
