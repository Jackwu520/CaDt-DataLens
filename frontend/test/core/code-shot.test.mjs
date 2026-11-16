// code-shot 护栏：行范围规划、token class 映射、探针取色与 Canvas 绘制桩集成。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CODE_SHOT_LIMITS, planCodeShot, tokenClasses, flattenLine, modeClassOf, renderCodeShot, shotStyleOptions,
} from '../../src/core/code-shot.js';

function makeDomStub() {
    const makeEl = (tag) => ({
        tag,
        className: '',
        textContent: '',
        style: {},
        children: [],
        parentNode: null,
        appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
        removeChild(child) { this.children = this.children.filter((c) => c !== child); child.parentNode = null; },
        remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    });
    const doc = {
        documentElement: makeEl('html'),
        body: makeEl('body'),
        createElement: makeEl,
        fonts: {load: async () => []},
    };
    const vars = {
        '--editor-font': '13px',
        '--editor-font-family': 'JetBrains Mono, monospace',
        '--panel': '#f4f6f8',
        '--bg': '#ffffff',
        '--border': '#d0d7de',
        '--text': '#1f2328',
        '--muted': '#6b7280',
        '--ace-gutter': '#8b949e',
    };
    const getComputedStyle = (el) => {
        if (el === doc.documentElement) {
            return {getPropertyValue: (name) => vars[name] || ''};
        }
        return {
            color: String(el.className || '').includes('ace_keyword') ? '#cf8e6d' : '#1f2328',
            fontWeight: '400',
            fontStyle: 'normal',
        };
    };
    return {doc, getComputedStyle};
}

function makeCanvasStub() {
    const texts = [];
    const ctx = {
        font: '', fillStyle: '', strokeStyle: '', lineWidth: 1,
        textBaseline: '', textAlign: '',
        shadowColor: '', shadowBlur: 0, shadowOffsetY: 0,
        measureText: (value) => ({width: String(value == null ? '' : value).length * 7}),
        fillText: (value, x, y) => texts.push({value: String(value), x, y, font: ctx.font, color: ctx.fillStyle}),
        fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {},
        closePath() {}, fill() {}, clip() {}, rect() {}, save() {}, restore() {},
        scale() {}, stroke() {},
    };
    const canvas = {
        width: 0,
        height: 0,
        getContext: () => ctx,
        toBlob: (cb, type) => cb({type, size: 123}),
    };
    return {canvas, texts};
}

function makeAce(lineCount = 5, selected = '', range = null) {
    return {
        session: {
            getLength: () => lineCount,
            getLine: (row) => 'line ' + row,
            getTokens: () => [
                {type: 'keyword', value: 'const '},
                {type: 'string', value: '"x"'},
                {type: 'keyword.operator', value: ' = 1'},
            ],
            getTabSize: () => 4,
            getMode: () => ({$id: 'ace/mode/javascript'}),
        },
        getSelectedText: () => selected,
        getSelectionRange: () => range || {start: {row: 0, column: 0}, end: {row: 0, column: 0}},
        renderer: {lineHeight: 20},
    };
}

async function draw(options) {
    const dom = makeDomStub();
    const shot = makeCanvasStub();
    const blob = await renderCodeShot({
        ...options,
        env: {
            document: dom.doc,
            getComputedStyle: dom.getComputedStyle,
            createCanvas: () => shot.canvas,
        },
    });
    return {blob, dom, shot};
}

test('planCodeShot：无选区取全文，行数至少 1', () => {
    assert.deepEqual(planCodeShot({hasSelection: false, lineCount: 12}), {
        startRow: 0, endRow: 11, lines: 12,
    });
    assert.equal(planCodeShot({hasSelection: false, lineCount: 0}).lines, 1);
});

test('planCodeShot：选区取整行，末行列 0 时去掉那一行', () => {
    assert.deepEqual(planCodeShot({
        hasSelection: true, lineCount: 20,
        range: {start: {row: 3, column: 5}, end: {row: 7, column: 2}},
    }), {startRow: 3, endRow: 7, lines: 5});
    assert.deepEqual(planCodeShot({
        hasSelection: true, lineCount: 20,
        range: {start: {row: 3, column: 0}, end: {row: 7, column: 0}},
    }), {startRow: 3, endRow: 6, lines: 4});
});

test('planCodeShot：超出行数上限明确拒绝，不静默截断', () => {
    const plan = planCodeShot({hasSelection: false, lineCount: CODE_SHOT_LIMITS.maxLines + 1});
    assert.equal(plan.startRow, undefined);
    assert.match(plan.error, /超过单次导出上限 600 行/);
    assert.equal(planCodeShot({
        hasSelection: false, lineCount: 40, limits: {...CODE_SHOT_LIMITS, maxLines: 10},
    }).error.includes('共 40 行'), true);
});

test('tokenClasses：点分类型转 ace_* class，空类型回默认文字色', () => {
    assert.equal(tokenClasses('keyword.operator'), 'ace_keyword ace_operator');
    assert.equal(tokenClasses('entity.name.function'), 'ace_entity ace_name ace_function');
    assert.equal(tokenClasses(''), '');
    assert.equal(tokenClasses(null), '');
});

test('flattenLine：tab 按 tabSize 展开成空格', () => {
    assert.deepEqual(flattenLine([
        {type: 'keyword', value: '\tlet'},
        {type: '', value: ' x'},
    ], 2), [
        {classes: 'ace_keyword', text: '  let'},
        {classes: '', text: ' x'},
    ]);
});

test('modeClassOf：ace/mode/xxx → ace-mode-xxx', () => {
    assert.equal(modeClassOf(makeAce().session), 'ace-mode-javascript');
    assert.equal(modeClassOf({getMode: () => ({$id: 'ace/mode/python'})}), 'ace-mode-python');
    assert.equal(modeClassOf(null), '');
});

test('shotStyleOptions：默认无标题带行号，radius/scale 超界回落默认档', () => {
    assert.deepEqual(shotStyleOptions(), {title: false, lineNumbers: true, radius: 10, scale: 2});
    assert.deepEqual(shotStyleOptions({title: true, lineNumbers: false, radius: 0, scale: 3}),
        {title: true, lineNumbers: false, radius: 0, scale: 3});
    assert.equal(shotStyleOptions({radius: 99}).radius, 10);
    assert.equal(shotStyleOptions({scale: 0}).scale, 2);
    assert.equal(shotStyleOptions({scale: '3'}).scale, 3);
});

test('renderCodeShot：全文出图默认无标题，行号与 token 都绘制，关键字用探针读到的主题色', async () => {
    const {blob, dom, shot} = await draw({ace: makeAce(5), name: 'demo.js', lineHeight: 20});
    assert.equal(blob.type, 'image/png');
    assert.ok(shot.canvas.width > 0 && shot.canvas.height > 0);
    const values = shot.texts.map((t) => t.value);
    for (const n of ['1', '2', '3', '4', '5']) assert.ok(values.includes(n), '缺少行号 ' + n);
    assert.ok(values.includes('const '));
    assert.ok(values.includes('"x"'));
    assert.ok(!values.some((t) => t.includes('demo.js')), '默认不应绘制标题');
    const keyword = shot.texts.find((t) => t.value === 'const ');
    assert.equal(keyword.color, '#cf8e6d');
    // 探针 DOM 用完即销毁，不在页面留残留节点
    assert.equal(dom.doc.body.children.length, 0);
});

test('renderCodeShot：title 开时绘制标题，lineNumbers 关时不画行号', async () => {
    const {shot} = await draw({ace: makeAce(5), name: 'demo.js', lineHeight: 20, title: true});
    const values = shot.texts.map((t) => t.value);
    assert.ok(values.some((t) => t.includes('demo.js')));
    const noGutter = await draw({ace: makeAce(5), lineHeight: 20, lineNumbers: false});
    const gutterValues = noGutter.shot.texts.map((t) => t.value);
    assert.ok(!gutterValues.includes('1') && !gutterValues.includes('5'), '关闭行号后不应绘制行号');
    assert.ok(gutterValues.includes('const '));
});

test('renderCodeShot：scale 1×/2× 等比影响画布物理尺寸', async () => {
    const one = await draw({ace: makeAce(3), lineHeight: 20, scale: 1});
    const two = await draw({ace: makeAce(3), lineHeight: 20, scale: 2});
    assert.equal(two.shot.canvas.width, one.shot.canvas.width * 2);
    assert.equal(two.shot.canvas.height, one.shot.canvas.height * 2);
});

test('renderCodeShot：选区只画涉及的行，标题带行范围', async () => {
    const ace = makeAce(20, 'selected', {start: {row: 4, column: 0}, end: {row: 6, column: 3}});
    const {shot} = await draw({ace, name: 'a.js', rangeLabel: '第 5–7 行', lineHeight: 20, title: true});
    const values = shot.texts.map((t) => t.value);
    assert.ok(values.includes('5') && values.includes('6') && values.includes('7'));
    assert.ok(!values.includes('1') && !values.includes('20'));
    assert.ok(values.some((t) => t.includes('第 5–7 行')));
});

test('renderCodeShot：画布超上限时抛错，且探针仍被清理', async () => {
    const dom = makeDomStub();
    const shot = makeCanvasStub();
    await assert.rejects(
        () => renderCodeShot({
            ace: makeAce(80),
            lineHeight: 20,
            limits: {...CODE_SHOT_LIMITS, maxHeight: 100},
            env: {document: dom.doc, getComputedStyle: dom.getComputedStyle, createCanvas: () => shot.canvas},
        }),
        /超过上限/,
    );
    assert.equal(dom.doc.body.children.length, 0);
});
