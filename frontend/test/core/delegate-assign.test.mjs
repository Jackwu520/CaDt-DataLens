// delegate-assign.test.mjs：委托赋值冲突护栏。
//
// main.js 组合根给各工厂的 deps 全部用 getter-only 注入（`get K() { return K; }`）；
// 兄弟模块内 `const xDeps = Object.create(deps)` 委托后再 `xDeps.K = ...` 普通赋值，
// 只要 K 撞上原型链的 getter-only 访问器，ESM 严格模式直接 TypeError——而且炸的是
// main.js 启动链（2026-11-19 实录：writing-ui plugDeps.openSettings / plugDeps.rt 两次
// 打断启动）。修复姿势是 Object.defineProperty 建自有属性；本护栏从静态扫两遍堵住：
//   ① 映射表覆盖：凡有 Object.create(deps|opts|ctx) 委托的文件必须登记 DELEGATE_FILES
//     （漏登记 = 扫描不到 = 悄悄炸启动）；
//   ② 冲突对账：委托赋值的键不得落在对应工厂 deps 的 getter-only 键集里。
// 新增委托文件 / 新加 getter 或赋值时，跑一次就知道炸不炸。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

// 委托文件 → main.js 里对应工厂的 deps 变量名。新增含 Object.create(deps) 的文件时登记。
const DELEGATE_FILES = [
    {file: 'writing/writing-ui.js', factoryVar: 'writingUI'},
    {file: 'editor/editor-groups.js', factoryVar: 'editorGroupsMod'},
    {file: 'bridge/bridge-ui.js', factoryVar: 'bridgeUI'},
    {file: 'settings/settings-ui.js', factoryVar: 'settingsUI'},
    {file: 'terminal/terminal-ui.js', factoryVar: 'terminalMod'},
    {file: 'shell/titlebar-popovers.js', factoryVar: 'titlebarPopovers'},
];

function parseFactoryDeps(mainSrc) {
    const lines = mainSrc.split('\n');
    const factories = new Map();
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/(?:const|let)?\s*(\w+)\s*=\s*(create\w+)\(\{\s*$/);
        if (!m) continue;
        let depth = 1;
        let j = i;
        while (depth > 0 && j < lines.length - 1) {
            j++;
            for (const ch of lines[j]) {
                if (ch === '{') depth++;
                else if (ch === '}') depth--;
            }
        }
        const keys = new Map();
        for (let k = i + 1; k < j; k++) {
            const g = lines[k].match(/get (\w+)\(\)/);
            const s = lines[k].match(/set (\w+)\(/);
            const p = lines[k].match(/^\s*(\w+):/);
            if (g) { const e = keys.get(g[1]) || {}; e.get = true; keys.set(g[1], e); }
            if (s) { const e = keys.get(s[1]) || {}; e.set = true; keys.set(s[1], e); }
            if (p && !g && !s) { const e = keys.get(p[1]) || {}; e.plain = true; keys.set(p[1], e); }
        }
        factories.set(m[1], {keys, start: i + 1, end: j + 1});
        i = j;
    }
    return factories;
}

test('① 凡有 Object.create(deps) 委托的文件必须登记进 DELEGATE_FILES（防漏扫）', () => {
    const files = [];
    const walk = (dir) => {
        for (const name of readdirSync(dir, {withFileTypes: true})) {
            const full = join(dir, name.name);
            if (name.isDirectory()) walk(full);
            else if (name.name.endsWith('.js') && !name.name.endsWith('.test.mjs')) files.push(full);
        }
    };
    walk(SRC);
    const registered = new Set(DELEGATE_FILES.map((e) => e.file));
    const missing = [];
    for (const full of files) {
        const src = readFileSync(full, 'utf8');
        if (/Object\.create\((deps|opts|ctx)\)/.test(src)) {
            const rel = full.slice(SRC.length + 1).replace(/\\/g, '/');
            if (!registered.has(rel)) missing.push(rel);
        }
    }
    assert.deepEqual(missing, [], '以下文件存在 Object.create 委托但未登记 DELEGATE_FILES：' + missing.join(', '));
});

test('② 委托赋值的键不得撞对应工厂 deps 的 getter-only 键（撞了 = 启动链 TypeError）', () => {
    const mainSrc = readFileSync(join(SRC, 'main.js'), 'utf8');
    const factories = parseFactoryDeps(mainSrc);
    const conflicts = [];
    for (const {file, factoryVar} of DELEGATE_FILES) {
        const fac = factories.get(factoryVar);
        assert.ok(fac, `main.js 里找不到工厂 deps 变量 ${factoryVar}（重命名了就同步本护栏的映射表）`);
        const srcLines = readFileSync(join(SRC, file), 'utf8').split('\n');
        const delegateVars = new Set();
        srcLines.forEach((l) => {
            const m = l.match(/const (\w+) = Object\.create\((deps|opts|ctx)\)/);
            if (m) delegateVars.add(m[1]);
        });
        srcLines.forEach((l, idx) => {
            const a = l.match(/^\s*(\w+)\.(\w+)\s*=\s*(.+);?\s*$/);
            if (!a || !delegateVars.has(a[1])) return;
            const key = a[2];
            const entry = fac.keys.get(key);
            if (entry && entry.get && !entry.set) {
                conflicts.push(`${file}:${idx + 1}  ${a[1]}.${key} = ${a[3].trim().slice(0, 40)}（${factoryVar} deps 有 getter-only 的 ${key}）`);
            }
        });
    }
    assert.deepEqual(conflicts, [], '存在会 TypeError 的委托赋值（用 Object.defineProperty 建自有属性）：\n' + conflicts.join('\n'));
});
