// 全局搜索「双击 Shift」判定护栏。
// 纯逻辑层：用可注入的 now 精确驱动各种时序，不 sleep。
// 接线层：源码断言 main.js 的 keydown 登记 / keyup 结算 / 文案，防漏接线和回退到旧的三击。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createShiftDoubleTap, DOUBLE_TAP_WINDOW_MS} from '../../src/core/shift-double-tap.js';
import {getShortcut, renderShortcutsTable} from '../../src/core/keybindings.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');

// 可控时钟 + 事件构造器（key 参数化：默认 Shift=全局搜索，Escape=AI 输入区停止生成）
function rig(windowMs = DOUBLE_TAP_WINDOW_MS, key = 'Shift') {
    let t = 1000;
    const det = createShiftDoubleTap({windowMs, now: () => t, key});
    const clean = {key, ctrlKey: false, altKey: false, metaKey: false, repeat: false};
    return {
        det,
        at(ms) { t = ms; },
        advance(ms) { t += ms; },
        down(over = {}) { return det.onKeyDown({...clean, ...over}); },
        up(over = {}) { return det.onKeyUp({...clean, ...over}); },
        key(over = {}) { return det.onKeyDown({key: 'a', ctrlKey: false, altKey: false, metaKey: false, repeat: false, ...over}); },
    };
}

// 一次完整的 Shift 轻按 = down + up
function tap(r, downOver, upOver) {
    r.down(downOver);
    return r.up(upOver);
}

test('两次干净轻按、间隔在窗口内 → 触发', () => {
    const r = rig();
    assert.equal(tap(r), false, '第一次轻按只登记，不触发');
    assert.equal(r.det.armed, true, '第一次完成后处于待配对态');
    r.advance(200);
    assert.equal(tap(r), true, '第二次轻按完成 → 双击成立');
    assert.equal(r.det.armed, false, '触发后状态清零');
});

test('两次轻按间隔超过窗口 → 不触发，第二次作为新的第一次', () => {
    const r = rig();
    tap(r);
    r.advance(DOUBLE_TAP_WINDOW_MS + 1);
    assert.equal(tap(r), false, '超时不算双击');
    assert.equal(r.det.armed, true, '第二次变成新的待配对第一次');
    r.advance(100);
    assert.equal(tap(r), true, '紧接着的第三次与第二次配对成立');
});

test('边界：间隔恰好等于窗口 → 触发', () => {
    const r = rig();
    tap(r);
    r.advance(DOUBLE_TAP_WINDOW_MS);
    assert.equal(tap(r), true);
});

test('中间夹任意按键 → 配对清零，后续不构成双击', () => {
    const r = rig();
    tap(r);
    assert.equal(r.det.armed, true);
    r.key(); // 打字字母
    assert.equal(r.det.armed, false, '中间按键必须清零待配对态');
    r.advance(50);
    assert.equal(tap(r), false, '被打断后这一下只是新的第一次');
    assert.equal(tap(r), true, '再一下才成立');
});

test('只有 keydown 没有 keyup（按住不放）→ 不成 tap', () => {
    const r = rig();
    r.down();
    r.advance(100);
    assert.equal(r.det.pendingDown, true);
    // 没有 up，直接再来一次 down/up
    assert.equal(tap(r), false, '第一次按住未抬起，不构成完整 tap');
});

test('带修饰键 / 长按 repeat 的 Shift → 清零，不计数', () => {
    const r = rig();
    tap(r);
    r.down({ctrlKey: true}); // Ctrl+Shift
    assert.equal(r.det.armed, false, '带修饰键的 Shift 打断配对');
    r.up({ctrlKey: true});

    tap(r);
    r.down({repeat: true}); // 长按自动重复
    assert.equal(r.det.armed, false, 'repeat 打断配对');
});

test('输入法组字态（isComposing / keyCode 229）→ 全部作废', () => {
    const r = rig();
    tap(r);
    r.down({isComposing: true});
    assert.equal(r.det.armed, false, 'isComposing 的 keydown 清零');
    assert.equal(r.det.pendingDown, false);

    tap(r);
    r.up({keyCode: 229});
    assert.equal(r.det.armed, false, 'keyCode 229 的 keyup 清零');
});

test('其它键的 keyup 也会清零，残留态不跨段生效', () => {
    const r = rig();
    tap(r);
    r.up({key: 'a'});
    assert.equal(r.det.armed, false);
});

test('reset 清空全部状态', () => {
    const r = rig();
    r.down();
    r.up();
    r.det.reset();
    assert.equal(r.det.armed, false);
    assert.equal(r.det.pendingDown, false);
});

// —— 键位参数化：AI 输入区「双击 Esc 停止生成」（ai-composer.js 接线） ——

test('key: Escape — 两次干净的 Esc 轻按成立', () => {
    const r = rig(DOUBLE_TAP_WINDOW_MS, 'Escape');
    assert.equal(tap(r), false, '第一次轻按只登记');
    assert.equal(r.det.armed, true);
    r.advance(200);
    assert.equal(tap(r), true, '第二次轻按完成 → 双击成立');
    assert.equal(r.det.armed, false, '触发后状态清零');
});

test('key: Escape — 非目标键（含 Shift）一律当「其它键」打断配对', () => {
    const r = rig(DOUBLE_TAP_WINDOW_MS, 'Escape');
    tap(r);
    r.down({key: 'Shift'});
    assert.equal(r.det.armed, false, 'Shift 不是该实例的目标键，清零待配对态');
    r.advance(50);
    assert.equal(tap(r), false, '被打断后这一下只是新的第一次');
    assert.equal(tap(r), true, '再一下才成立');
});

test('默认键位仍是 Shift，Escape 在默认实例里只是打断键（全局搜索接线不回归）', () => {
    const r = rig();
    assert.equal(tap(r), false);
    r.advance(200);
    assert.equal(tap(r), true);
    const s = rig();
    tap(s);
    s.down({key: 'Escape'});
    assert.equal(s.det.armed, false);
});

// —— 接线护栏 ——

test('main.js：import + 每个 keydown 登记 + keyup 结算接线', () => {
    const main = read('main.js');
    assert.match(main, /import \{createShiftDoubleTap\} from '\.\/core\/shift-double-tap\.js';/);
    assert.match(main, /const shiftDoubleTap = createShiftDoubleTap\(\);/);
    // keydown 捕获层：无条件把事件喂给状态机，且注释点明"中间任意键清零"
    const kd = main.match(/window\.addEventListener\('keydown', \(e\) => \{[\s\S]*?\}, \{capture: true\}\);/);
    assert.ok(kd, 'keydown 捕获监听应存在');
    assert.match(kd[0], /shiftDoubleTap\.onKeyDown\(e\);/);
    assert.ok(!/gsShiftCount|gsShiftAt/.test(kd[0]), '不得残留旧的三击计数变量');
    // keyup 捕获层：结算触发
    const ku = main.match(/window\.addEventListener\('keyup', \(e\) => \{[\s\S]*?\}, \{capture: true\}\);/);
    assert.ok(ku, 'keyup 捕获监听应存在');
    assert.match(ku[0], /shiftDoubleTap\.onKeyUp\(e\)/);
    assert.match(ku[0], /openGlobalSearch\(\)/);
    assert.match(ku[0], /if \(!tapped \|\| quickSwitch\.open\) return;/, '快速切换打开时仍不抢触发');
});

test('文案统一为「双击 Shift」，不再出现「连按 3 次」', () => {
    const main = read('main.js');
    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.html'), 'utf8');
    // 菜单里的快捷键文案跟随当前风格（单一来源，不再写死）
    assert.match(main, /shortcut: getShortcut\('edit\.globalSearch', keymap\.style\)/);
    // 快捷键表的文案单一来源在 keybindings.js（index.html 只留容器，由它渲染）
    assert.equal(getShortcut('edit.globalSearch'), '双击 Shift');
    assert.match(renderShortcutsTable(), /双击 Shift/);
    assert.ok(!/连按 3 次 Shift/.test(main + html + renderShortcutsTable()), '不得残留旧文案');
});
