import test from 'node:test';
import assert from 'node:assert/strict';
import {isDocReadOnly, isTabReadOnlyFixed, isTabReadOnlyLocked} from './readonly.js';

test('全局只读锁覆盖所有标签', () => {
    const settings = {readOnlyMode: true};
    assert.equal(isDocReadOnly({}, settings), true);
    assert.equal(isDocReadOnly(null, settings), true);
    assert.equal(isDocReadOnly({readOnlyLocked: true}, settings), true);
});

test('标签页只读锁只作用于加了锁的 doc，与全局锁独立', () => {
    const settings = {readOnlyMode: false};
    const locked = {name: 'a.json', readOnlyLocked: true};
    const plain = {name: 'b.json'};
    assert.equal(isDocReadOnly(locked, settings), true);
    assert.equal(isDocReadOnly(plain, settings), false);
    // 解锁后立刻可编辑（不需要动全局设置）
    locked.readOnlyLocked = false;
    assert.equal(isDocReadOnly(locked, settings), false);
});

test('大文件 / 二进制天然只读，且不需要显式加锁', () => {
    const settings = {readOnlyMode: false};
    assert.equal(isDocReadOnly({large: true}, settings), true);
    assert.equal(isDocReadOnly({binary: true}, settings), true);
    assert.equal(isDocReadOnly({}, settings), false);
});

test('isTabReadOnlyLocked 只认用户显式加的标签锁', () => {
    assert.equal(isTabReadOnlyLocked({readOnlyLocked: true}), true);
    assert.equal(isTabReadOnlyLocked({readOnlyLocked: false, large: true}), false);
    assert.equal(isTabReadOnlyLocked(null), false);
});

test('settings 缺失时不误判', () => {
    assert.equal(isDocReadOnly({name: 'x'}, undefined), false);
    assert.equal(isDocReadOnly({readOnlyLocked: true}, undefined), true);
});

test('固定只读：即使普通标签锁被清掉，文档仍然不可编辑', () => {
    const settings = {readOnlyMode: false};
    const snapshot = {name: '审阅.diff', readOnlyFixed: true, readOnlyLocked: true};
    assert.equal(isDocReadOnly(snapshot, settings), true);
    snapshot.readOnlyLocked = false;
    assert.equal(isDocReadOnly(snapshot, settings), true, '固定锁不能随普通锁一起被解掉');
    assert.equal(isTabReadOnlyFixed(snapshot), true);
    assert.equal(isTabReadOnlyLocked(snapshot), true, '固定锁仍应显示标签锁角标');
});

test('isTabReadOnlyFixed 只认固定锁，普通标签锁不算', () => {
    assert.equal(isTabReadOnlyFixed({readOnlyFixed: true}), true);
    assert.equal(isTabReadOnlyFixed({readOnlyLocked: true}), false);
    assert.equal(isTabReadOnlyFixed(null), false);
});
