// 图片灯箱交互护栏（2026-11-21）：锁住「点空白可关闭 / 放大不漂移」两处修复，
// 防止后续改动把 setPointerCapture 提前、或把缩放锚点退回 stage 可视区硬算。
// 灯箱是 DOM 密集组件，这里用源码断言钉住关键契约（与 overlay-esc-guard 同风格）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'src', 'shell', 'image-lightbox.js'), 'utf8');

test('单击不捕获指针：setPointerCapture 只在真正拖动后才调用', () => {
    const down = SRC.match(/stage\.addEventListener\('pointerdown'[\s\S]*?\n        \}\);/);
    assert.ok(down, '应存在 stage 的 pointerdown 监听');
    assert.ok(!/setPointerCapture/.test(down[0]), 'pointerdown 里不得直接 setPointerCapture——会改写 click.target 让关闭判定失真');

    const move = SRC.match(/stage\.addEventListener\('pointermove'[\s\S]*?\n        \}\);/);
    assert.ok(move, '应存在 stage 的 pointermove 监听');
    assert.ok(/dragMoved/.test(move[0]) && /setPointerCapture/.test(move[0]),
        'setPointerCapture 应放在 dragMoved 判定之后的拖动分支里');
});

test('点空白关闭用 pointerdown 记下的原始 target，且 dragMoved 判断后即清', () => {
    assert.ok(/downTarget\s*=\s*e\.target/.test(SRC), 'pointerdown 应记录原始 target');
    const click = SRC.match(/root\.addEventListener\('click'[\s\S]*?\n        \}\);/);
    assert.ok(click, '应存在 root 的 click 关闭监听');
    assert.ok(/downTarget/.test(click[0]), 'click 关闭判定应基于 downTarget，而非被捕获改写的 e.target');
    assert.ok(/dragMoved\s*=\s*false/.test(click[0]), 'click 处理后应清 dragMoved，避免残留标志让后续单击关不掉');
});

test('缩放锚点基于图片实际渲染框（getBoundingClientRect），不拿 stage 可视区硬算', () => {
    const zoom = SRC.match(/function zoomAt\([\s\S]*?\n    \}/);
    assert.ok(zoom, '应存在 zoomAt');
    assert.ok(/img\.getBoundingClientRect\(\)/.test(zoom[0]), '缩放前后应取图片实际渲染框算锚点比例');
    assert.ok(/stage\.scrollLeft\s*\+=/.test(zoom[0]) && /stage\.scrollTop\s*\+=/.test(zoom[0]),
        '应把缩放后的锚点位移补进 scroll，而不是旧式 scrollLeft = contentX * ratio 覆盖');
});
