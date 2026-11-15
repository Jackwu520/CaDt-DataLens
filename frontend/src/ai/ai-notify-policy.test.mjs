// ai-notify-policy.js 的语义护栏：三个通道的前提各不相同，别让后续改动悄悄合并回去。
import test from 'node:test';
import assert from 'node:assert/strict';
import {desktopNotifyTargets} from './ai-notify-policy.js';

test('后台：弹系统卡片 + 闪任务栏，不弹应用内 toast（看不到软件，弹了也没意义）', () => {
    assert.deepEqual(
        desktopNotifyTargets({inApp: true, system: true, foreground: false, viewingOther: true}),
        {systemToast: true, inAppToast: false, taskbarFlash: true});
});

test('前台但看的是别的会话：弹应用内 toast，不弹系统卡片', () => {
    assert.deepEqual(
        desktopNotifyTargets({inApp: true, system: true, foreground: true, viewingOther: true}),
        {systemToast: false, inAppToast: true, taskbarFlash: false});
});

test('前台且正看着这个会话：什么都不弹（内容就在眼前）', () => {
    assert.deepEqual(
        desktopNotifyTargets({inApp: true, system: true, foreground: true, viewingOther: false}),
        {systemToast: false, inAppToast: false, taskbarFlash: false});
});

test('任务完成：即使开了应用内通知也不弹，只留消息中心', () => {
    assert.deepEqual(
        desktopNotifyTargets({inApp: true, system: true, foreground: true, viewingOther: true, completion: true}),
        {systemToast: false, inAppToast: false, taskbarFlash: false});
    // 后台时系统卡片仍要弹（人不在电脑前，回来能看见）
    assert.deepEqual(
        desktopNotifyTargets({inApp: true, system: true, foreground: false, viewingOther: true, completion: true}),
        {systemToast: true, inAppToast: false, taskbarFlash: false});
});

test('开关全关 / 缺字段：一律不弹，不因字段缺失误开', () => {
    assert.deepEqual(
        desktopNotifyTargets({inApp: false, system: false, foreground: false, viewingOther: true}),
        {systemToast: false, inAppToast: false, taskbarFlash: false});
    assert.deepEqual(desktopNotifyTargets({}), {systemToast: false, inAppToast: false, taskbarFlash: false});
    assert.deepEqual(desktopNotifyTargets(null), {systemToast: false, inAppToast: false, taskbarFlash: false});
});

test('foreground 只认严格 true（缺字段视为后台，宁可多弹一条）', () => {
    assert.deepEqual(
        desktopNotifyTargets({inApp: true, system: true}),
        {systemToast: true, inAppToast: false, taskbarFlash: true});
    assert.deepEqual(
        desktopNotifyTargets({inApp: true, system: true, foreground: 'true'}),
        {systemToast: true, inAppToast: false, taskbarFlash: true});
});
