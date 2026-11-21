// 窗口操作接线护栏（2026-11-22 多窗闪烁事故）：applySettings 是所有设置写入的高频统一出口，
// 跨窗口 settings-changed 同步 + 发送方回声让它在「没改任何东西」时也会被别的窗口触发。
// applyAlwaysOnTop 是 applySettings 里唯一的 OS 窗口操作，而 Wails 的 SetAlwaysOnTop 落到
// SetWindowPos(HWND_TOPMOST/NOTOPMOST) 时会无条件把窗口提到本档 Z 序最顶（值没变也一样，
// win32 实测）——没有「值未变不调用」守卫时，任一窗口点侧边栏图标都会让另一窗跳前台、
// 再被回声顶回，即「两个窗口来回闪一下」。无法在 node 里派发真实窗口消息，按项目惯例用源码断言钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PER_WINDOW_LAYOUT_KEYS} from '../../src/settings/settings-sync.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');

test('settings-ui.js：applyAlwaysOnTop 必须带「值未变不调用」守卫', () => {
    const src = read('settings/settings-ui.js');
    const at = src.indexOf('function applyAlwaysOnTop');
    assert.ok(at >= 0, 'applyAlwaysOnTop 应存在');
    const body = src.slice(at, src.indexOf('\n}', at));
    const callAt = body.indexOf('WindowSetAlwaysOnTop');
    assert.ok(callAt >= 0, '应有运行时调用');
    const guardAt = body.indexOf('lastAppliedAlwaysOnTop === next');
    assert.ok(guardAt >= 0, '必须记住上次应用的置顶值');
    assert.ok(guardAt < callAt, '守卫必须先于运行时调用');
    assert.ok(body.indexOf('lastAppliedAlwaysOnTop = next') > callAt,
        '调用成功后才更新 lastApplied，失败时保留重试语义');
});

test('settings-sync.js：对象键必须按值比较，Object.is 直通会被禁止', () => {
    const src = read('settings/settings-sync.js');
    const at = src.indexOf('export function mergeSettingsInto');
    assert.ok(at >= 0, 'mergeSettingsInto 应存在');
    const body = src.slice(at, src.indexOf('\n}', at));
    assert.ok(body.includes('sameValue(target[key], next)'),
        '逐键比较必须走 sameValue（JSON 快照的对象键引用永远不同）');
    assert.ok(!body.includes('Object.is(target[key]'),
        '不得直接用 Object.is 比较对象键——回声永远误报变更');
});

test('settings-ui.js：跨窗合并入口必须先剥布局键（侧栏状态不镜像到别的窗口）', () => {
    const src = read('settings/settings-ui.js');
    const at = src.indexOf('function applyRemoteSettings');
    assert.ok(at >= 0, 'applyRemoteSettings 应存在');
    const body = src.slice(at, src.indexOf('\n}', at));
    assert.ok(body.includes('mergeSettingsInto(deps.settings, stripPerWindowLayout(values))'),
        'applyRemoteSettings 是广播 + 方案 C 重读的共同必经点，合并前必须过 stripPerWindowLayout');
    assert.ok(!/mergeSettingsInto\(deps\.settings,\s*values\)/.test(body),
        '不得把未剥离的 payload 直并进内存——布局键会被远端快照覆盖');
});

// ---- 统一入口守卫（2026-11-22）：settings 持久化/跨窗同步只有三条通道，别开第四条 ----
// ① applySettings（全量重绘+落盘+广播）② persistSettingsLight（只落盘+广播）③ applyRemoteSettings
// （唯一合并入口）。历史上 editor-split-preview / structure-panel / rememberScratchExt 直写
// localStorage 不广播，别的窗口内存副本停在旧值——正是跨窗同步要修的病，靠扫描防复发。
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function walkJs(dir, out = []) {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walkJs(full, out);
        else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(full);
    }
    return out;
}

test('统一出口：settings-changed 广播全仓只有 settings-ui.js 一处（broadcastSettings 内部）', () => {
    const hits = [];
    for (const file of walkJs(SRC_ROOT)) {
        const text = readFileSync(file, 'utf8');
        const re = /EventsEmit\('settings-changed'/g;
        let m;
        while ((m = re.exec(text))) hits.push(file);
    }
    assert.equal(hits.length, 1, '广播点必须唯一，散落第二处会导致同步行为分裂：' + hits.join(', '));
    assert.ok(hits[0].endsWith(join('settings', 'settings-ui.js')), '广播点只允许在 settings-ui.js');
    const src = read('settings/settings-ui.js');
    assert.ok(src.includes('function broadcastSettings()'), '广播应收口在 broadcastSettings 内');
});

test('统一出口：settings 落盘（localStorage.setItem）只允许发生在 settings-ui.js', () => {
    const offenders = [];
    for (const file of walkJs(SRC_ROOT)) {
        const text = readFileSync(file, 'utf8');
        const isSettingsUi = file.endsWith(join('settings', 'settings-ui.js'));
        const re = /localStorage\.setItem\((?:deps\.)?settingsKey/g;
        const count = (text.match(re) || []).length;
        if (isSettingsUi) {
            assert.ok(count >= 1, 'settings-ui.js 应承载落盘');
        } else if (count > 0) {
            offenders.push(file + ' x' + count);
        }
    }
    assert.deepEqual(offenders, [], 'settings-ui.js 之外的直写点必须改走 persistSettingsLight / applySettings');
});

test('统一入口：mergeSettingsInto 调用全仓只有 applyRemoteSettings 一处', () => {
    const offenders = [];
    for (const file of walkJs(SRC_ROOT)) {
        const text = readFileSync(file, 'utf8');
        const isSync = file.endsWith(join('settings', 'settings-sync.js'));
        const isSettingsUi = file.endsWith(join('settings', 'settings-ui.js'));
        const calls = (text.match(/mergeSettingsInto\(/g) || []).length;
        if (isSync) continue; // 定义处
        if (isSettingsUi) {
            assert.equal(calls, 1, 'settings-ui.js 里只允许 applyRemoteSettings 调一次');
        } else if (calls > 0) {
            offenders.push(file + ' x' + calls);
        }
    }
    assert.deepEqual(offenders, [], '第二个合并点会绕过布局键剥离——必须走 applyRemoteSettings');
});

test('PER_WINDOW_LAYOUT_KEYS：每个键都必须真实存在于源码（防列表拼写漂移）', () => {
    const mainJs = read('main.js');
    let allSrc = '';
    for (const file of walkJs(SRC_ROOT)) allSrc += readFileSync(file, 'utf8');
    for (const key of PER_WINDOW_LAYOUT_KEYS) {
        const inDefaults = new RegExp('^\\s*' + key + '\\s*:', 'm').test(mainJs);
        const inUse = allSrc.includes('settings.' + key);
        assert.ok(inDefaults || inUse, '布局键 "' + key + '" 在源码里找不到（拼写漂移或键已改名）');
    }
});
