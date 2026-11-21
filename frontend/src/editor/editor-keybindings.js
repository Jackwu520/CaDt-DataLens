// editor-keybindings.js：编辑器内键位的运行时。
// 把 core/editor-keybindings.js 的键位表重绑到 jsoneditor 内嵌 Ace 的 CommandManager。
// factory + 依赖注入：deps.settings.keyStyle 决定当前风格，deps.docs 提供所有已开编辑器。
//
// 重绑策略（关键）：
//   1. 用 commands.bindKey(key, null) 精确解绑每个「被本表占用的键」——Ace 会把该键从
//      原命令（可能是 removeline / redo / findprevious…）上摘掉，而不动该命令的其他键位。
//   2. 用专属命令名（cadtKey_*）+ 复用 Ace 内建命令的 exec 重新绑定，避免 addCommand 覆盖
//      内建命令时顺带清掉它的其他默认键（如 duplicateSelection 的 Ctrl-Shift-D）。
//   3. 所有操作幂等：每次 apply 先清自己的专属命令再重注册；不碰 vendored 文件。

import {EDITOR_KEY_BINDINGS, editorKeyListFor, CUSTOM_EXEC} from '../core/editor-keybindings.js';
import {DEFAULT_KEY_STYLE} from '../core/keybindings.js';

const OWNED_PREFIX = 'cadtKey_';

function ownCommandName(id) {
    return OWNED_PREFIX + String(id).replace(/[^A-Za-z0-9_]/g, '_');
}

function rangeClass(editor) {
    try {
        const ace = window.ace;
        if (ace && typeof ace.require === 'function') return ace.require('ace/range').Range;
    } catch (e) {}
    try {
        const r = editor.selection.getRange();
        if (r && r.constructor) return r.constructor;
    } catch (e) {}
    return null;
}

function makeRange(Range, r, c, r2, c2) {
    if (Range) return new Range(r, c, r2, c2);
    return {start: {row: r, column: c}, end: {row: r2, column: c2}};
}

// 取当前选区文本作为 needle；无选区时取光标下的词。返回 null 表示无从下手。
function needleFromSelection(editor, Range) {
    const session = editor.session;
    const sel = editor.selection;
    if (!session || !sel) return null;
    const range = sel.getRange();
    if (range && !range.isEmpty()) {
        return {needle: session.getTextRange(range), range};
    }
    const pos = sel.getCursor();
    let word = null;
    try { word = session.getWordRange(pos.row, pos.column); } catch (e) {}
    if (word && !word.isEmpty()) return {needle: session.getTextRange(word), range: word, bareWord: true};
    return null;
}

// 自己实现查找（不依赖 Ace 的 session.find options 机制）：逐行 indexOf，返回所有匹配的 Range。
function allMatchRanges(session, needle, Range) {
    const out = [];
    if (!needle) return out;
    const total = typeof session.getLength === 'function' ? session.getLength() : 0;
    for (let row = 0; row < total; row += 1) {
        const line = String(session.getLine(row) || '');
        let idx = line.indexOf(needle);
        while (idx >= 0) {
            out.push(makeRange(Range, row, idx, row, idx + needle.length));
            idx = line.indexOf(needle, idx + 1);
        }
    }
    return out;
}

function cmpRange(a, b) {
    return (a.start.row - b.start.row) || (a.start.column - b.start.column);
}

function selectNextMatch(editor) {
    const Range = rangeClass(editor);
    const got = needleFromSelection(editor, Range);
    if (!got) return;
    const sel = editor.selection;
    // 光标停在词上、还没有选区：第一次按 Ctrl+D 先选中这个词（VSCode 语义）
    if (got.bareWord) {
        try { sel.toSingleRange(got.range); } catch (e) {}
        return;
    }
    const matches = allMatchRanges(editor.session, got.needle, Range);
    if (!matches.length) return;
    matches.sort(cmpRange);
    const from = got.range.end;
    const ahead = matches.find((r) => cmpRange(r, from) > 0);
    const target = ahead || matches[0]; // 走到文末回绕到第一个
    try {
        sel.addRange(target, true);
        if (editor.renderer && typeof editor.renderer.scrollCursorIntoView === 'function') {
            editor.renderer.scrollCursorIntoView(target.end, 0.15);
        }
    } catch (e) {}
}

function selectAllMatches(editor) {
    const Range = rangeClass(editor);
    const got = needleFromSelection(editor, Range);
    if (!got) return;
    const matches = allMatchRanges(editor.session, got.needle, Range);
    if (!matches.length) return;
    matches.sort(cmpRange);
    const sel = editor.selection;
    try {
        sel.toSingleRange(matches[0]);
        for (let i = 1; i < matches.length; i += 1) sel.addRange(matches[i], true);
    } catch (e) {}
}

function toggleCase(editor) {
    const session = editor.session;
    const sel = editor.selection;
    if (!session || !sel) return;
    const range = sel.getRange();
    if (!range || range.isEmpty()) return;
    const text = session.getTextRange(range);
    if (!text) return;
    const next = text === text.toUpperCase() ? text.toLowerCase() : text.toUpperCase();
    if (next === text) return;
    try { session.replace(range, next); } catch (e) {}
}

const CUSTOM_IMPL = {
    [CUSTOM_EXEC.SELECT_NEXT_MATCH]: selectNextMatch,
    [CUSTOM_EXEC.SELECT_ALL_MATCHES]: selectAllMatches,
    [CUSTOM_EXEC.TOGGLE_CASE]: toggleCase,
};

export function createEditorKeybindings(deps) {

    function execFor(aceCommand, commands) {
        if (Object.prototype.hasOwnProperty.call(CUSTOM_IMPL, aceCommand)) return CUSTOM_IMPL[aceCommand];
        const cmd = commands.commands && commands.commands[aceCommand];
        return cmd && typeof cmd.exec === 'function' ? cmd.exec : null;
    }

    function applyTo(aceEditor) {
        if (!aceEditor || !aceEditor.commands) return;
        const commands = aceEditor.commands;
        const style = (deps.settings && deps.settings.keyStyle) || DEFAULT_KEY_STYLE;
        const claimed = new Set();
        const register = [];
        for (const b of EDITOR_KEY_BINDINGS) {
            const keys = editorKeyListFor(b, style);
            for (const k of keys) claimed.add(k);
            if (!keys.length) continue;
            const exec = execFor(b.aceCommand, commands);
            if (!exec) continue;
            register.push({name: ownCommandName(b.id), exec, keys});
        }
        // 1) 解绑被本表占用的键（Ace 内部会把它从原命令上摘掉，不动原命令其他键位）
        for (const key of claimed) {
            try { commands.bindKey(key, null); } catch (e) {}
        }
        // 2) 清掉本模块上次注册的专属命令（幂等）
        for (const name of Object.keys(commands.commands || {})) {
            if (name.indexOf(OWNED_PREFIX) === 0) {
                try { commands.removeCommand(name); } catch (e) {}
            }
        }
        // 3) 按当前风格重新绑定
        for (const item of register) {
            try {
                commands.addCommand({name: item.name, exec: item.exec, bindKey: item.keys.join('|')});
            } catch (e) {}
        }
    }

    function applyToAll() {
        const docs = deps.docs || [];
        for (const doc of docs) {
            const ed = doc && doc.editor && doc.editor.aceEditor;
            if (ed) applyTo(ed);
        }
    }

    return {applyTo, applyToAll};
}
