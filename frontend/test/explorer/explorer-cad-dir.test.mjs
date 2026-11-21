// explorer-cad-dir.test.mjs —— 文件树/列表显示应用状态目录 .cadt 的开关护栏。
//
// 背景：2026-11-21 a72570a 为配合「临时草稿」节点，把 .cadt 在工作区根层硬编码隐藏，
// 用户无从得知也没有开关。本轮改为「默认显示 + 设置项可关」：
//   - 纯函数 isCadDirEntry / visibleTreeEntries 决定根层过滤；
//   - showCadDir 开关同步树的过滤与列表的跳过表（LIST_SKIP_DIRS）；
//   - 设置项 showCadDir 走完 HTML → elsSettings → main.js 事件 → settings-ui 同步的全链路。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isCadDirEntry, visibleTreeEntries} from '../../src/explorer/explorer.js';

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => readFileSync(join(here, '..', '..', rel), 'utf8');

const dir = (name) => ({name, isDir: true});
const file = (name) => ({name, isDir: false});

test('isCadDirEntry：只认目录、大小写不敏感，文件与近似名不误判', () => {
    assert.equal(isCadDirEntry(dir('.cadt')), true);
    assert.equal(isCadDirEntry(dir('.CADT')), true);
    assert.equal(isCadDirEntry(file('.cadt')), false); // 同名文件不算
    assert.equal(isCadDirEntry(dir('.cadt-worktree')), false);
    assert.equal(isCadDirEntry(dir('cadt')), false);
    assert.equal(isCadDirEntry(null), false);
});

test('visibleTreeEntries：showCadDir=true 原样返回（默认显示）', () => {
    const entries = [dir('.cadt'), dir('src'), file('README.md')];
    assert.equal(visibleTreeEntries(entries, true, true), entries, '同引用返回，不做无谓拷贝');
});

test('visibleTreeEntries：showCadDir=false 且根节点才在根层隐藏 .cadt', () => {
    const entries = [dir('.cadt'), dir('src'), file('README.md')];
    assert.deepEqual(visibleTreeEntries(entries, true, false).map((e) => e.name), ['src', 'README.md']);
    // 非根节点（用户把子目录设为根）不过滤，避免误伤同名子目录
    assert.equal(visibleTreeEntries(entries, false, false), entries);
});

test('explorer.js：列表跳过表不含 .cadt，setShowCadDir 同步增删并对外导出', () => {
    const src = readSrc('src/explorer/explorer.js');
    assert.match(src, /const LIST_SKIP_DIRS = new Set\(\[[^\]]*\]\)/);
    const listLine = src.match(/const LIST_SKIP_DIRS = new Set\((.*?)\);/)[1];
    assert.ok(!listLine.includes("'.cadt'"), '列表跳过表不应写死 .cadt（默认显示）');
    assert.match(src, /function setShowCadDir\(next\)[\s\S]*?LIST_SKIP_DIRS\.(delete|add)\('\.cadt'\)/);
    assert.match(src, /setShowCadDir,\s*\n\s*};/, 'setShowCadDir 必须在返回对象里导出');
});

test('全链路：设置项 showCadDir 从 HTML 到事件再到 explorer 同步', () => {
    const html = readSrc('index.html');
    const main = readSrc('src/main.js');
    const ui = readSrc('src/settings/settings-ui.js');

    assert.match(html, /id="opt-show-cad-dir"/, '设置页要有开关控件');
    assert.match(ui, /showCadDir: document\.getElementById\('opt-show-cad-dir'\)/, 'elsSettings 要登记控件');
    assert.match(main, /showCadDir: \{type: 'bool'\}/, 'APP_SETTING_RULES 要登记白名单');
    assert.match(main, /showCadDir: true,/, '默认值必须是显示');
    assert.match(main, /settings\.showCadDir = settings\.showCadDir !== false;/, '非法值回落显示');
    assert.match(main, /elsSettings\.showCadDir\.addEventListener\('change'/, '要有 change 事件');
    assert.match(main, /explorer\.setShowCadDir\(settings\.showCadDir\)/, '事件里要同步 explorer');
    assert.match(ui, /elsSettings\.showCadDir\.checked = deps\.settings\.showCadDir !== false/, 'applySettings 要回填勾选态');
    assert.match(ui, /deps\.explorer\.setShowCadDir\(deps\.settings\.showCadDir !== false\)/, 'applySettings 要把状态推给 explorer（覆盖 AI set_setting 路径）');
});
