// settings-tree.test.mjs：设置树的行 id 归一、危险分级与取值整形护栏。
// DOM 构建部分由 dev mock 冒烟覆盖；这里锁纯逻辑（get_settings_tree / set_setting_row 共用）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PROTECTED_SETTING_IDS,
    classifySettingsRisk,
    coerceSettingsValue,
    describeSettingsInput,
    describeSettingsValue,
    settingsRowId,
    settingsRiskReason,
} from '../../src/settings/settings-tree.js';

function fakeSelect(options, value) {
    const opts = options.map(([optionValue, label]) => ({value: optionValue, textContent: label}));
    return {
        tagName: 'SELECT',
        type: 'select-one',
        value,
        options: opts,
        selectedOptions: opts.filter((option) => option.value === value).slice(0, 1),
    };
}

function fakeInput(type, value, extra = {}) {
    return {tagName: 'INPUT', type, value, ...extra};
}

test('settingsRowId：控件 id 优先；无 id 时同页/组/标题稳定哈希', () => {
    assert.equal(settingsRowId({pane: 'ai', group: '子代理', title: '层级上限', controlId: 'ai-opt-subagent-depth'}), 'ai-opt-subagent-depth');
    const a = settingsRowId({pane: 'ai', group: '子代理', title: '层级上限', controlId: ''});
    const b = settingsRowId({pane: 'ai', group: '子代理', title: '层级上限', controlId: ''});
    assert.equal(a, b);
    assert.match(a, /^set-[0-9a-f]{8}$/);
    const c = settingsRowId({pane: 'ai', group: '子代理', title: '并发上限', controlId: ''});
    assert.notEqual(a, c);
});

test('危险分级：高（安全姿态）/ 中（资源保留）/ 低（观感）', () => {
    assert.equal(classifySettingsRisk('ai-opt-subagent-depth'), 'high');
    assert.equal(classifySettingsRisk('ai-opt-subagent-choice1'), 'high');
    assert.equal(classifySettingsRisk('ai-opt-default-scope'), 'high');
    assert.equal(classifySettingsRisk('plugin-path-mode'), 'high');
    assert.equal(classifySettingsRisk('ai-opt-threshold'), 'medium');
    assert.equal(classifySettingsRisk('opt-activity-retention'), 'medium');
    assert.equal(classifySettingsRisk('opt-code-wrap'), 'low');
    assert.equal(classifySettingsRisk('ai-opt-chatfont'), 'low');
    assert.ok(settingsRiskReason('ai-opt-subagent-depth').includes('层级'));
    assert.equal(settingsRiskReason('opt-code-wrap'), '');
    assert.ok(PROTECTED_SETTING_IDS.has('ai-opt-display-mode'), '布局形态行必须永久不可写');
});

test('开关整形：true/false 与中文别名，非法值报错', () => {
    for (const value of [true, 'true', 'on', '1', '开', '开启', '是', 'yes']) {
        assert.deepEqual(coerceSettingsValue('switch', fakeInput('checkbox', '', {checked: false}), value), {ok: true, value: true});
    }
    for (const value of [false, 'false', 'off', '0', '关', '关闭', '否', 'no']) {
        assert.deepEqual(coerceSettingsValue('switch', fakeInput('checkbox', '', {checked: true}), value), {ok: true, value: false});
    }
    assert.equal(coerceSettingsValue('switch', fakeInput('checkbox', ''), 'maybe').ok, false);
});

test('下拉整形：选项 value / 选项文案都认，非法值给可用清单', () => {
    const control = fakeSelect([['zh', '中文'], ['en', 'English']], 'zh');
    assert.deepEqual(coerceSettingsValue('select', control, 'en'), {ok: true, value: 'en'});
    assert.deepEqual(coerceSettingsValue('select', control, 'English'), {ok: true, value: 'en'});
    const bad = coerceSettingsValue('select', control, 'fr');
    assert.equal(bad.ok, false);
    assert.match(bad.error, /zh \/ en/);
    assert.equal(describeSettingsInput('select', control, 'en'), 'en（English）');
});

test('数字整形：min/max 越界与 NaN 报错', () => {
    const control = fakeInput('number', '3', {min: '1', max: '9'});
    assert.deepEqual(coerceSettingsValue('number', control, '7'), {ok: true, value: 7});
    assert.equal(coerceSettingsValue('number', control, '0').ok, false);
    assert.equal(coerceSettingsValue('number', control, '10').ok, false);
    assert.equal(coerceSettingsValue('number', control, 'abc').ok, false);
});

test('文本整形：maxlength 上限；展示值与审批新值文案', () => {
    const control = fakeInput('text', 'abc', {maxLength: 5});
    assert.deepEqual(coerceSettingsValue('text', control, 'hello'), {ok: true, value: 'hello'});
    assert.equal(coerceSettingsValue('text', control, 'toolong').ok, false);
    assert.equal(describeSettingsValue('switch', fakeInput('checkbox', '', {checked: true})), '开启');
    assert.equal(describeSettingsInput('switch', null, false), '关闭');
    assert.equal(describeSettingsInput('text', control, 'x'), 'x');
});
