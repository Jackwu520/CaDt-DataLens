// code-shot.js：把当前代码视图的展示效果画成 PNG（Canvas 2D，零新增依赖）。
// 不走 DOM → foreignObject → SVG：那种产物是独立文档，页面 @font-face 的 JetBrains Mono
// 不会加载，字形字宽全变；也不走窗口截图 API，Ace 虚拟滚动只能截到可见区。
// token 颜色不另建映射表，用隐藏探针 DOM 读 getComputedStyle，自动跟随
// data-theme / data-code-style（含 style.css 里 Python / YAML / XML 的 mode 特例）。
export const CODE_SHOT_LIMITS = Object.freeze({
    maxLines: 600,
    maxWidth: 12000,
    maxHeight: 24000,
    fontScale: 1.5,
    minWidth: 420,
    maxCardWidth: 1200,
});

// 样式档位单一来源：设置页下拉与归一化共用（title 默认关、lineNumbers 默认开）。
export const CODE_SHOT_RADII = Object.freeze([0, 6, 10, 16]);
export const CODE_SHOT_SCALES = Object.freeze([1, 2, 3]);

export function shotStyleOptions(options = {}) {
    const radius = Number(options.radius);
    const scale = Number(options.scale);
    return {
        title: options.title === true,
        lineNumbers: options.lineNumbers !== false,
        radius: CODE_SHOT_RADII.includes(radius) ? radius : 10,
        scale: CODE_SHOT_SCALES.includes(scale) ? scale : 2,
    };
}

// 有选区取涉及的全部整行；末行列号为 0 说明选区止于行首，去掉那一行。
export function planCodeShot({range, hasSelection, lineCount, limits = CODE_SHOT_LIMITS} = {}) {
    const total = Math.max(1, Number(lineCount) || 1);
    let startRow = 0;
    let endRow = total - 1;
    if (hasSelection && range && range.start && range.end) {
        startRow = Math.max(0, Math.min(total - 1, Number(range.start.row) || 0));
        endRow = Math.max(startRow, Math.min(total - 1, Number(range.end.row) || 0));
        if (endRow > startRow && Number(range.end.column) === 0) endRow -= 1;
    }
    const lines = endRow - startRow + 1;
    if (lines > limits.maxLines) {
        return {error: '共 ' + lines + ' 行，超过单次导出上限 ' + limits.maxLines + ' 行；请缩小选区范围'};
    }
    return {startRow, endRow, lines};
}

// Ace 的 token.type 是点分路径（keyword.operator / entity.name.function），
// 与 DOM 上的 ace_* class 一一对应，顺序保持原样以命中属性前缀选择器。
export function tokenClasses(type) {
    const value = String(type == null ? '' : type).trim();
    if (!value) return '';
    return value.split('.').filter(Boolean)
        .map((part) => 'ace_' + part.replace(/[^\w-]/g, ''))
        .join(' ');
}

export function flattenLine(tokens, tabSize = 4) {
    const size = Math.min(16, Math.max(1, Number(tabSize) || 4));
    const pad = ' '.repeat(size);
    return (tokens || []).map((token) => ({
        classes: tokenClasses(token && token.type),
        text: String(token && token.value != null ? token.value : '').replace(/\t/g, pad),
    }));
}

export function modeClassOf(session) {
    const id = session && session.getMode ? String((session.getMode() || {}).$id || '') : '';
    const name = id.split('/').pop().replace(/[^A-Za-z0-9_-]/g, '');
    return name ? 'ace-mode-' + name : '';
}

function cssVar(styles, name, fallback) {
    return ((styles && styles.getPropertyValue ? styles.getPropertyValue(name) : '') || '').trim() || fallback;
}

function browserEnv() {
    return {
        document: globalThis.document,
        getComputedStyle: (el) => globalThis.getComputedStyle(el),
        createCanvas: () => globalThis.document.createElement('canvas'),
    };
}

// 探针复刻真实 Ace 的祖先 class：.jsoneditor + .ace_editor + ace-mode-xxx。
// 读出来的 color / fontStyle / fontWeight 就是当前主题 + 代码风格下的实际值。
function makeProbe(doc, getStyle, modeClass) {
    const host = doc.createElement('div');
    host.className = 'jsoneditor ' + modeClass;
    const editor = doc.createElement('div');
    editor.className = 'ace_editor ' + modeClass;
    host.appendChild(editor);
    host.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none;';
    (doc.body || doc.documentElement).appendChild(host);
    const cache = new Map();
    return {
        style(classes) {
            const key = classes || '';
            if (cache.has(key)) return cache.get(key);
            const line = doc.createElement('span');
            line.className = 'ace_line';
            const span = doc.createElement('span');
            if (key) span.className = key;
            span.textContent = 'x';
            line.appendChild(span);
            editor.appendChild(line);
            const computed = getStyle(span) || {};
            const out = {
                color: computed.color || '',
                weight: Math.round(Number(computed.fontWeight) || 400),
                italic: computed.fontStyle === 'italic',
            };
            editor.removeChild(line);
            cache.set(key, out);
            return out;
        },
        destroy() {
            if (host.parentNode) host.parentNode.removeChild(host);
        },
    };
}

function roundRectPath(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
        if (!canvas.toBlob) {
            reject(new Error('当前环境不支持 PNG 导出'));
            return;
        }
        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('PNG 编码失败'));
        }, 'image/png');
    });
}

// options: {ace, name, rangeLabel, env, limits, fontSize, lineHeight, title, lineNumbers, radius, scale}；
// 样式位经 shotStyleOptions 归一化（默认无标题、带行号）。返回 PNG Blob。
// 超出行数 / 画布上限一律抛错（由调用方 flash 提示），不静默截断、不自动分段。
export async function renderCodeShot(options = {}) {
    const limits = {...CODE_SHOT_LIMITS, ...(options.limits || {})};
    const env = {...browserEnv(), ...(options.env || {})};
    const ace = options.ace;
    const session = ace && (ace.session || (ace.getSession && ace.getSession()));
    if (!ace || !session) throw new Error('当前没有可用的代码编辑器');
    const doc = env.document;
    if (!doc) throw new Error('当前环境不支持图片绘制');

    const selected = ace.getSelectedText ? String(ace.getSelectedText() || '') : '';
    const plan = planCodeShot({
        range: ace.getSelectionRange ? ace.getSelectionRange() : null,
        hasSelection: !!selected,
        lineCount: session.getLength(),
        limits,
    });
    if (plan.error) throw new Error(plan.error);

    const rootStyle = env.getComputedStyle(doc.documentElement);
    const fontSize = Number(options.fontSize) || parseFloat(cssVar(rootStyle, '--editor-font', '13px')) || 13;
    const fontFamily = cssVar(rootStyle, '--editor-font-family', 'monospace');
    const lineHeight = Number(options.lineHeight) || Math.round(fontSize * limits.fontScale);
    const palette = {
        // 代码截图是「编辑器观感」的产物：底色与正文跟随代码主题的 --editor-bg/--editor-text
        //（auto 时回退界面变量），与编辑器本体一致。
        card: cssVar(rootStyle, '--editor-bg', '') || cssVar(rootStyle, '--bg', '#ffffff'),
        header: cssVar(rootStyle, '--panel', '#f4f6f8'),
        border: cssVar(rootStyle, '--border', '#d0d7de'),
        text: cssVar(rootStyle, '--editor-text', '') || cssVar(rootStyle, '--text', '#1f2328'),
        muted: cssVar(rootStyle, '--muted', '#6b7280'),
        gutter: cssVar(rootStyle, '--ace-gutter', '#8b949e'),
        gutterBg: cssVar(rootStyle, '--editor-bg', '') || cssVar(rootStyle, '--panel', '#f4f6f8'),
    };
    // 页面内绘制能用上 @font-face 字体；显式 load 一次避免首张图回退到系统等宽字体。
    if (doc.fonts && doc.fonts.load) {
        try {
            await doc.fonts.load(fontSize + 'px ' + fontFamily, 'Aa测');
        } catch (e) { /* 字体加载失败时仍按可用字体绘制 */ }
    }

    const canvas = env.createCanvas();
    const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) throw new Error('无法创建绘图上下文');
    const fontOf = (weight, italic) => (italic ? 'italic ' : '') + weight + ' ' + fontSize + 'px ' + fontFamily;
    const probe = makeProbe(doc, env.getComputedStyle, modeClassOf(session));
    try {
        ctx.font = fontOf(400, false);
        const charW = ctx.measureText('M').width || fontSize * 0.6;
        const rows = [];
        let maxTextWidth = 0;
        for (let i = 0; i < plan.lines; i += 1) {
            const row = plan.startRow + i;
            let tokens;
            try {
                tokens = session.getTokens ? session.getTokens(row) : null;
            } catch (e) {
                tokens = null;
            }
            const parts = tokens && tokens.length
                ? flattenLine(tokens, session.getTabSize ? session.getTabSize() : 4)
                : [{classes: '', text: String(session.getLine(row) || '')}];
            let width = 0;
            for (const part of parts) {
                const style = probe.style(part.classes);
                ctx.font = fontOf(style.weight, style.italic);
                width += ctx.measureText(part.text).width;
            }
            maxTextWidth = Math.max(maxTextWidth, width);
            rows.push(parts);
        }

        const shotStyle = shotStyleOptions(options);
        const showGutter = shotStyle.lineNumbers;
        const digits = String(plan.endRow + 1).length;
        const gutterW = showGutter ? Math.max(28, Math.ceil(digits * charW + 20)) : 0;
        const padX = 14;
        const padY = 12;
        const titleH = shotStyle.title ? 32 : 0;
        const cardW = Math.min(limits.maxCardWidth,
            Math.max(limits.minWidth, Math.ceil(gutterW + padX * 2 + maxTextWidth + 24)));
        const cardH = titleH + padY * 2 + plan.lines * lineHeight;
        // 卡片即整图：没有外圈页面背景，圆角外四角留透明（PNG alpha）
        const imgW = cardW;
        const imgH = cardH;
        const pxW = Math.ceil(imgW * shotStyle.scale);
        const pxH = Math.ceil(imgH * shotStyle.scale);
        if (pxW > limits.maxWidth || pxH > limits.maxHeight) {
            throw new Error('图片尺寸 ' + pxW + '×' + pxH + ' 超过上限 ' +
                limits.maxWidth + '×' + limits.maxHeight + '；请缩小选区范围');
        }
        canvas.width = pxW;
        canvas.height = pxH;
        ctx.scale(shotStyle.scale, shotStyle.scale);

        // 白卡片浮起（浅色主题靠实色边线区分，不叠半透明灰）
        ctx.save();
        ctx.fillStyle = palette.card;
        roundRectPath(ctx, 0, 0, cardW, cardH, shotStyle.radius);
        ctx.fill();
        ctx.restore();

        ctx.save();
        roundRectPath(ctx, 0, 0, cardW, cardH, shotStyle.radius);
        ctx.clip();
        if (titleH) {
            ctx.fillStyle = palette.header;
            ctx.fillRect(0, 0, cardW, titleH);
            ctx.fillStyle = palette.border;
            ctx.fillRect(0, titleH - 1, cardW, 1);
            ctx.font = fontOf(400, false);
            ctx.fillStyle = palette.muted;
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            const title = (String(options.name || '').trim() || '代码') +
                (options.rangeLabel ? ' · ' + options.rangeLabel : '');
            ctx.fillText(title.slice(0, 90), padX, titleH / 2, cardW - padX * 2);
        }
        if (showGutter) {
            ctx.fillStyle = palette.gutterBg;
            ctx.fillRect(0, titleH, gutterW, cardH - titleH);
        }

        const contentX = showGutter ? gutterW + 10 : padX;
        const clipW = Math.max(1, cardW - contentX - padX);
        ctx.textBaseline = 'middle';
        for (let i = 0; i < rows.length; i += 1) {
            const y = titleH + padY + i * lineHeight + lineHeight / 2;
            if (showGutter) {
                ctx.font = fontOf(400, false);
                ctx.fillStyle = palette.gutter;
                ctx.textAlign = 'right';
                ctx.fillText(String(plan.startRow + i + 1), gutterW - 10, y);
            }
            ctx.textAlign = 'left';
            ctx.save();
            ctx.beginPath();
            ctx.rect(contentX, titleH, clipW, cardH - titleH);
            ctx.clip();
            let x = contentX;
            for (const part of rows[i]) {
                if (!part.text) continue;
                const tokenStyle = probe.style(part.classes);
                ctx.font = fontOf(tokenStyle.weight, tokenStyle.italic);
                ctx.fillStyle = tokenStyle.color || palette.text;
                ctx.fillText(part.text, x, y);
                x += ctx.measureText(part.text).width;
            }
            ctx.restore();
        }
        ctx.restore();

        ctx.strokeStyle = palette.border;
        ctx.lineWidth = 1;
        roundRectPath(ctx, 0.5, 0.5, cardW - 1, cardH - 1, shotStyle.radius);
        ctx.stroke();
        return await canvasToPngBlob(canvas);
    } finally {
        probe.destroy();
    }
}
