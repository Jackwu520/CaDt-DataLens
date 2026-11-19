// 设置对话框家族的弹层栈护栏（2026-11-21）：删条目 / 确认框关闭后标题栏与工具栏被遮罩蒙住、
// 按 Esc 才恢复的回归。
// 根因（留档）：overlay-stack 的 z-index 是 open 写内联、dispose 还原，遮罩 #dialog-mask 与
// 设置窗共享同一条目池。旧 disposeFamilyHandlesExcept 无条件把所有兄弟出栈——包括 keepSettings
// 下仍然可见的设置窗本身，于是设置窗的内联 z 被撤、回落到 CSS 兜底，遮罩随即被确认框重新钉在
// dialog 档地板上，压住标题栏/工具栏；设置窗同时脱离栈，Esc 只能落到 main.js 的栈空兜底。
// 无法在 node 里跑真实 DOM 家族编排，按项目惯例用源码断言钉住三条不变量。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');

test('disposeFamilyHandlesExcept：只出栈已隐藏的兄弟，可见的设置窗留在栈里', () => {
    const dialogs = read('settings/settings-dialogs.js');
    const fnAt = dialogs.indexOf('function disposeFamilyHandlesExcept(');
    assert.ok(fnAt >= 0, '家族出栈函数应存在');
    const body = dialogs.slice(fnAt, dialogs.indexOf('function openDialogEl(', fnAt));
    const visibleSkipAt = body.indexOf("if (!el.classList.contains('hidden')) continue;");
    assert.ok(visibleSkipAt >= 0,
        '必须跳过仍可见的兄弟——否则 keepSettings 下的设置窗被出栈，共享遮罩的 z 被连带撤销');
    const handleAt = body.indexOf('familyHandles.get(el)');
    assert.ok(visibleSkipAt < handleAt, '可见性判定必须先于取句柄出栈');
});

test('openDialogEl：入栈前先撤掉同一对话框的旧句柄，不重复叠层', () => {
    const dialogs = read('settings/settings-dialogs.js');
    const openAt = dialogs.indexOf('function openDialogEl(');
    const body = dialogs.slice(openAt, dialogs.indexOf('function closeTopDialog()', openAt));
    const staleAt = body.indexOf('familyHandles.get(dlg)');
    const pushAt = body.indexOf('overlayStack.open(');
    assert.ok(staleAt >= 0 && pushAt > staleAt, 'dlg 自己的旧句柄要在 open 之前撤掉');
    assert.match(body.slice(staleAt, pushAt), /stale\.dispose\(\)/, '旧句柄必须 dispose 而不是覆盖丢弃');
});

test('closeDialogs：强制收场要把 runDirty / runConfirm 一并藏起来', () => {
    const dialogs = read('settings/settings-dialogs.js');
    const at = dialogs.indexOf('function closeDialogs()');
    const body = dialogs.slice(at, dialogs.indexOf('function openAbout()', at));
    // 「只出栈已隐藏」之后，漏 hidden 的成员会既不隐藏也不出栈（既露在屏上又占着 Esc）
    for (const key of ['runDirty', 'runConfirm']) {
        assert.match(body, new RegExp('deps\\.elsDialogs\\.' + key + '\\.classList\\.add\\(\'hidden\'\\)'),
            `closeDialogs 要隐藏 ${key}，与 familyDlgList 清单对齐`);
    }
});
