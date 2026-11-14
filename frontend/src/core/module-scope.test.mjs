// 跨模块符号泄漏扫描（拆分后的第一道静态防线）。
//
// 背景：把函数体从宿主搬到兄弟模块时，「函数体搬走了、它依赖的符号没跟着走」只会在运行时炸
// ——import/link/vite/单元测试全都看不见。2026-11-14 拆设置页时连续踩了三次：
//   elsSettings 未注入 → 整个设置页打不开；RECIPES/SELF_TEST 没 import → 启动即 ReferenceError；
//   initPluginRuntime({ flash }) 对象简写裸引用 → 同上。
//
// 规则：对每个被拆出来的模块，收集两处符号
//   R1 宿主文件的顶层定义（function/const/let/var）
//   R2 宿主文件 import 进来的名字（子模块往往也需要，但没人 import）
// 若模块里裸用（前面不是 . 或标识符字符）其中某个名字，本文件又没定义/import，则报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
    return readFileSync(join(SRC, rel), 'utf8');
}

// 去掉注释与字符串字面量，避免把说明文字当成代码
function code(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/(^|[^:\\])\/\/.*$/, '$1'))
        .join('\n')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

function decls(text) {
    const src = code(text);
    const out = new Set();
    for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
    for (const m of src.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
    for (const m of src.matchAll(/^(?:export\s+)?(?:const|let|var)\s*\{([^}]*)\}\s*=/gm)) {
        for (const id of m[1].match(/[A-Za-z_$][\w$]*/g) || []) out.add(id);
    }
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
        for (const part of m[1].split(',')) {
            const id = part.trim().split(/\s+as\s+/).pop().trim();
            if (id) out.add(id);
        }
    }
    for (const m of text.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) out.add(m[1]);
    return out;
}

// 宿主 → 它拆出来的兄弟模块
const HOSTS = [
    {
        host: 'settings/settings-ui.js',
        modules: ['settings/settings-dialogs.js', 'settings/settings-select.js', 'settings/settings-search.js'],
    },
    {
        host: 'writing/writing-ui.js',
        modules: [
            'writing/writing-mode.js',
            'editor/foot-menus.js',
            'editor/markdown-mermaid.js',
            'settings/settings-pane-run.js',
            'settings/settings-pane-plugins.js',
            'settings/settings-pane-envvars.js',
            'settings/settings-pane-lang.js',
        ],
    },
    {
        host: 'terminal/terminal-ui.js',
        modules: ['terminal/run-ui.js', 'terminal/terminal-sessions.js'],
    },
    {
        host: 'bridge/bridge-ui.js',
        modules: ['bridge/bridge-git.js', 'bridge/bridge-terminal-view.js', 'bridge/bridge-cli-convert.js'],
    },
    {
        host: 'shell/titlebar-popovers.js',
        modules: ['shell/titlebar-project.js', 'shell/titlebar-git-branch.js'],
    },
    {
        host: 'ai/ai-session-store.js',
        modules: ['ai/ai-session-disk.js'],
    },
];

test('拆出的模块不得裸用宿主定义/宿主 import 的符号', () => {
    const problems = [];
    for (const {host, modules} of HOSTS) {
        const hostNames = decls(read(host));
        for (const mod of modules) {
            const text = read(mod);
            const own = decls(text);
            const body = code(text);
            for (const name of hostNames) {
                if (own.has(name)) continue;
                // 裸用：前面不是 . 与标识符字符；且不是对象键（后面紧跟 :）
                const re = new RegExp('(?<![\\w$.])' + name + '\\b', 'g');
                for (const m of body.matchAll(re)) {
                    const after = body.slice(m.index + name.length).trimStart();
                    if (after.startsWith(':')) continue; // 对象字面量的键
                    problems.push(`${mod} 裸用了 ${name}（定义/导入在 ${host}）→ 应 import，或改 deps.${name} 并在宿主注入`);
                    break;
                }
            }
        }
    }
    assert.deepEqual(problems, [], '跨模块符号泄漏：\n' + problems.join('\n'));
});
