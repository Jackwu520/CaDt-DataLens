// 接线护栏：关于页版本号必须来自 Go 的 appVersion（GetAppVersion 绑定），
// index.html 只留占位符——硬编码会在下次升版时再次漂移。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('关于页版本：index.html 只留占位符，不再硬编码', () => {
    const html = read('../../index.html');
    const m = html.match(/<span id="about-version"[^>]*>([^<]*)<\/span>/);
    assert.ok(m, '关于页版本 span 必须带 id="about-version"');
    assert.ok(!/^v?\d+\.\d+\.\d+/.test(m[1].trim()), '版本号不许硬编码，应由 GetAppVersion 填充');
});

test('关于页版本：设置页从后端 GetAppVersion 读取', () => {
    const ui = read('./settings-ui.js');
    assert.match(ui, /about-version/, '必须写入 about-version 元素');
    assert.match(ui, /GetAppVersion/, '必须调用 GetAppVersion 绑定');
    const go = read('../../../app_window.go');
    assert.match(go, /func \(a \*App\) GetAppVersion\(\) string/, 'Go 侧 GetAppVersion 绑定必须存在');
});
