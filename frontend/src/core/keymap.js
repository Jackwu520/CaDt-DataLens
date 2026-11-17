// keymap.js：快捷键风格的运行时（事件归一化 + 按当前风格查表分发）。
//
// 组合键归一化成 'Ctrl+Shift+P' 这样的串：字母 / 数字走 e.code（物理键位），
// 中文输入法下 e.key 会变成组字字符（'中'）而 e.code 仍是 'KeyZ' —— 取 e.code 更稳，
// 也顺带解决输入法态下「按了字母却被当成中文」的老问题。
//
// 风格（settings.keyStyle）只换一张索引：行为立即跟着变，且与设置页文案同源
// （两者都来自 core/keybindings.js 同一张表），不会出现「表里写一套、实际按另一套」。
//
// 一个动作可以登记多个组合（keys[style] 是数组）：数组每一项都能独立触发它，
// 见 is(combo, id) —— 命中任一项即为真。
//
// 非组合键的特殊触发（双击 Shift）不进索引，用 hasSpecial(id, token) 判断：
// 当前风格不含该特殊触发时，双击 Shift 不生效。

import {
    KEY_BINDINGS, KEY_STYLES, DEFAULT_KEY_STYLE, DOUBLE_SHIFT,
    keyListFor, isValidKeyStyleId,
} from './keybindings.js';

// 物理键位 → 组合串里的主键名（只列有专门写法的；其余走 e.key）
const CODE_TOKENS = {
    Backquote: '`', Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
    BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Semicolon: ';', Quote: "'",
};

// 事件 → 组合串（'Ctrl+Shift+P' / 'F5' / 'Alt+1' / 'Ctrl+`'）。
export function comboFromEvent(e) {
    if (!e) return '';
    const code = e.code || '';
    let key = '';
    if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
    else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
    else if (code === 'NumpadAdd') key = '+';
    else if (code === 'NumpadSubtract') key = '-';
    else if (code === 'NumpadMultiply') key = '*';
    else if (code === 'NumpadDivide') key = '/';
    else if (Object.prototype.hasOwnProperty.call(CODE_TOKENS, code)) key = CODE_TOKENS[code];
    else if (typeof e.key === 'string' && e.key) key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (!key) return '';
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');
    parts.push(key);
    return parts.join('+');
}

export function createKeymap(options = {}) {
    const bindings = options.bindings || KEY_BINDINGS;
    const styles = options.styles || KEY_STYLES;
    let style = options.style || DEFAULT_KEY_STYLE;

    let index = new Map();     // 组合串 → 动作 id
    let combos = new Map();    // 动作 id → Set(组合串)
    let specials = new Map();  // 动作 id → Set(特殊触发)
    const listeners = new Set();

    function build() {
        index = new Map();
        combos = new Map();
        specials = new Map();
        for (const b of bindings) {
            const comboSet = new Set();
            const specialSet = new Set();
            for (const item of keyListFor(b, style)) {
                if (item === DOUBLE_SHIFT) {
                    specialSet.add(item);
                    continue;
                }
                comboSet.add(item);
                if (!index.has(item)) index.set(item, b.id);
            }
            combos.set(b.id, comboSet);
            specials.set(b.id, specialSet);
        }
    }
    build();

    return {
        get style() { return style; },
        get styles() { return styles.map((s) => s.id); },
        // 切风格：重建索引 + 通知调用方（文案表要跟着重绘）。
        setStyle(next) {
            const id = String(next || '');
            if (!isValidKeyStyleId(id)) return false;
            if (id === style) return false;
            style = id;
            build();
            if (typeof options.onChange === 'function') options.onChange(id);
            for (const fn of listeners) {
                try { fn(id); } catch (e) {}
            }
            return true;
        },
        // 订阅风格变化（设置页据此重绘快捷键文案表；main.js 启动时按存档切换也会触发）。
        subscribe(fn) {
            if (typeof fn !== 'function') return () => {};
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        combo(e) { return comboFromEvent(e); },
        // 该组合是否触发这个动作（多组合：命中任一项即为真）。
        is(combo, id) {
            const set = combos.get(id);
            return !!set && set.has(combo);
        },
        // 该组合对应哪个动作（先到先得；风格内已保证不冲突）。
        match(combo) { return index.get(combo) || null; },
        combosFor(id) {
            const set = combos.get(id);
            return set ? [...set] : [];
        },
        // 特殊触发（如双击 Shift）在当前风格是否生效。
        hasSpecial(id, token) {
            const set = specials.get(id);
            return !!set && set.has(token);
        },
    };
}

// 全局单例：main.js 的按键链与设置页共用同一份运行时状态。
export const keymap = createKeymap();
