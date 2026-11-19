// 状态栏底部弹出层：编码/BOM/换行符/视图切换/图片与表格缩放/md 与 AI 宽度。
// 从 writing-ui.js 拆出（放 editor/）。视图模型（deps.viewOptionsFor/deps.viewLabel/deps.viewDisabled/deps.EOLS 等）由宿主经 deps 注入。
import {iconSvg} from '../core/icons.js';
import {overlayStack} from '../core/overlay-stack.js';

export function createFootMenus(deps) {

function makeSelect(options, value, onChange) {
    const sel = document.createElement('select');
    for (const [v, label] of options) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = label;
        if (v === value) opt.selected = true;
        sel.appendChild(opt);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
}

const footPopover = document.getElementById('enc-popover');
const FOOT_WIDGETS = {encoding: deps.els.stEnc, view: deps.els.stMode, eol: deps.els.stEol, zoom: deps.els.stZoom, mdWidth: deps.els.stMdWidth, aiWidth: deps.els.stAiWidth};
let footPopoverKind = null;
// 浮层的弹层栈条目（openFootPopover/closeFootPopover 收口；Esc 由栈按层序退）
let footStackHandle = null;
// 编码/换行/缩进弹出面板的行图标用 icons.js 渲染（不再使用 MDL2 字符）
function closeFootPopover() {
    if (footStackHandle) {
        footStackHandle.dispose();
        footStackHandle = null;
    }
    footPopover.classList.add('hidden');
    Object.values(FOOT_WIDGETS).forEach((el) => el && el.classList.remove('active'));
    footPopoverKind = null;
}

function popTitle(text) {
    const t = document.createElement('div');
    t.className = 'enc-title';
    t.textContent = text;
    return t;
}

function popSep() {
    const s = document.createElement('div');
    s.className = 'enc-sep';
    return s;
}

function popFoot(prefix, value) {
    const foot = document.createElement('div');
    foot.className = 'enc-foot';
    foot.textContent = prefix + ': ';
    const b = document.createElement('b');
    b.textContent = value;
    foot.appendChild(b);
    return foot;
}

function popItem(label, opts = {}) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'enc-item' + (opts.current ? ' current' : '');
    const ic = document.createElement('span');
    ic.className = 'enc-ic' + (opts.current ? ' cur' : (opts.iconClass ? ' ' + opts.iconClass : ''));
    if (opts.current) ic.innerHTML = iconSvg('check', 12);
    const text = document.createElement('span');
    text.textContent = label;
    row.append(ic, text);
    if (opts.disabled) {
        row.disabled = true;
        row.style.opacity = '0.4';
        row.dataset.tip = opts.disabledTitle || '';
    } else if (opts.onClick) {
        row.addEventListener('click', opts.onClick);
    }
    return row;
}

function toggleBom() {
    if (!deps.file) return;
    deps.file.hasBom = !deps.file.hasBom;
    deps.setDirty(true);
    deps.updateStatus();
    if (footPopoverKind === 'encoding') {
        footPopover.textContent = '';
        renderEncodingMenu();
    }
}

function convertEncoding(enc) {
    if (!deps.file) return;
    if ((deps.file.enc || 'utf-8') === enc) {
        closeFootPopover();
        return;
    }
    deps.file.enc = enc;
    if (enc !== 'utf-8') deps.file.hasBom = false;
    deps.setDirty(true);
    deps.updateStatus();
    deps.flash('编码已转换为 ' + enc.toUpperCase());
    closeFootPopover();
}

async function renderEncodingMenu() {
    const current = deps.file.enc || 'utf-8';
    footPopover.appendChild(popTitle('文件编码'));
    footPopover.appendChild(popItem(
        current === 'utf-8' ? (deps.file.hasBom ? '移除 BOM' : '添加 BOM') : '添加 BOM（仅 UTF-8）',
        {disabled: current !== 'utf-8', disabledTitle: '仅 UTF-8 支持 BOM', onClick: toggleBom}
    ));
    footPopover.appendChild(popSep());
    const rows = [];
    for (const [enc, label] of deps.CONVERT_ENCODINGS) {
        const row = popItem(label, {current: enc === current, onClick: () => convertEncoding(enc)});
        footPopover.appendChild(row);
        if (enc !== current) rows.push({enc, ic: row.querySelector('.enc-ic')});
    }
    footPopover.appendChild(popFoot('文件编码', current.toUpperCase() + (deps.file.hasBom && current === 'utf-8' ? ' BOM' : '')));
    for (const {enc, ic} of rows) {
        try {
            const ok = await deps.backend.CheckEncoding(deps.file.content || '', enc);
            ic.innerHTML = iconSvg(ok ? 'check' : 'warn', 12);
            ic.className = 'enc-ic ' + (ok ? 'ok' : 'warn');
        } catch (e) {}
    }
}

function renderViewMenu() {
    footPopover.appendChild(popTitle('视图'));
    const splitActive = !!(deps.file && deps.file.splitActive);
    for (const [mode, label] of deps.viewOptionsFor(deps.file && deps.file.format, deps.file)) {
        const disabled = deps.viewDisabled(mode);
        footPopover.appendChild(popItem(label, {
            current: mode === 'split' ? splitActive
                : (mode === 'sql' ? !!(deps.file && deps.file.sqlActive) : (!splitActive && deps.currentMode === mode)),
            disabled,
            disabledTitle: deps.viewDisabledTitle(mode),
            onClick: () => { deps.switchMode(mode); closeFootPopover(); },
        }));
    }
    footPopover.appendChild(popFoot('当前', splitActive ? deps.viewLabel('split') : deps.viewLabel(deps.currentMode)));
}

function renderImageZoomMenu() {
    if (!deps.file || !deps.file.image) return;
    const doc = deps.file;
    footPopover.appendChild(popTitle('图片缩放'));
    footPopover.appendChild(popItem('自动（适配显示区）', {
        current: doc.imageZoom == null,
        onClick: () => {
            doc.imageZoom = null;
            deps.applyImageZoom(doc);
            closeFootPopover();
        },
    }));
    footPopover.appendChild(popSep());
    for (const percent of [25, 50, 75, 100, 150, 200, 400, 800]) {
        footPopover.appendChild(popItem(percent + '%', {
            current: doc.imageZoom != null && Math.round(doc.imageZoom * 100) === percent,
            onClick: () => {
                doc.imageZoom = percent / 100;
                deps.applyImageZoom(doc);
                closeFootPopover();
            },
        }));
    }
    const current = doc.imageScale ? Math.round(doc.imageScale * 100) + '%' : '—';
    footPopover.appendChild(popFoot('当前', current));
}

function renderTableZoomMenu() {
    if (!deps.file || !deps.file.format || !deps.file.format.table) return;
    const doc = deps.file;
    footPopover.appendChild(popTitle('表格缩放'));
    for (const percent of [25, 50, 75, 100, 150, 200, 400, 800]) {
        footPopover.appendChild(popItem(percent + '%', {
            current: Math.round((doc.tableZoom || 1) * 100) === percent,
            onClick: () => {
                doc.tableZoom = percent / 100;
                deps.applyCsvTableZoom(doc);
                deps.updateStatus();
                closeFootPopover();
            },
        }));
    }
    footPopover.appendChild(popFoot('当前', Math.round((doc.tableZoom || 1) * 100) + '%'));
}

function mdPreviewWidthLabel(value) {
    return String(value) === '0' ? '自适应' : value + 'px';
}

function aiFullscreenWidthLabel(value) {
    const current = String(value || 'auto');
    if (current === 'auto') return '自动';
    return current === '0' ? '跟随' : current + 'px';
}

function updateAiWidthWidget() {
    if (!deps.els.stAiWidth) return;
    const show = !!deps.settings.aiPanelOpen;
    deps.els.stAiWidth.style.display = show ? '' : 'none';
    if (!show) {
        deps.els.stAiWidth.textContent = '';
        return;
    }
    const value = String(deps.settings.aiFullscreenWidth || 'auto');
    deps.els.stAiWidth.textContent = 'AI 宽度 · ' + aiFullscreenWidthLabel(value);
}

function renderAiWidthMenu() {
    footPopover.appendChild(popTitle('AI 内容宽度（停靠 / 全屏）'));
    const options = [['auto', '自动（默认）'], ['720', '720px'], ['860', '860px'], ['920', '920px'], ['1100', '1100px'], ['1300', '1300px'], ['0', '跟随']];
    for (const [value, label] of options) {
        footPopover.appendChild(popItem(label, {
            current: String(deps.settings.aiFullscreenWidth) === value,
            onClick: () => {
                deps.settings.aiFullscreenWidth = value;
                deps.applySettings();
                closeFootPopover();
            },
        }));
    }
    footPopover.appendChild(popSep());
    footPopover.appendChild(popFoot('当前', aiFullscreenWidthLabel(deps.settings.aiFullscreenWidth)));
    footPopover.appendChild(popFoot('自动规则', '<920px 跟随 / ≥920px 最大 920px'));
}

function renderMdWidthMenu() {
    footPopover.appendChild(popTitle('Markdown 预览宽度'));
    const options = [['720', '720px'], ['860', '860px'], ['920', '920px'], ['1100', '1100px'], ['1300', '1300px'], ['0', '跟随窗口宽度']];
    for (const [value, label] of options) {
        footPopover.appendChild(popItem(label, {
            current: String(deps.settings.mdPreviewWidth) === value,
            onClick: () => {
                deps.settings.mdPreviewWidth = value;
                deps.applySettings();
                deps.updateStatus();
                closeFootPopover();
            },
        }));
    }
    footPopover.appendChild(popSep());
    footPopover.appendChild(popItem('更多设置…', {
        onClick: () => {
            closeFootPopover();
            deps.openSettings('general');
        },
    }));
    footPopover.appendChild(popFoot('当前', mdPreviewWidthLabel(deps.settings.mdPreviewWidth)));
}

function chooseEol(value) {
    if (!deps.file) return;
    const fs = deps.getFormatSettings(deps.file.format.id);
    if (fs.eol === value) {
        closeFootPopover();
        return;
    }
    const before = fs.eol === 'follow' ? deps.file.eol : fs.eol;
    fs.eol = value;
    deps.applySettings();
    const after = value === 'follow' ? deps.file.eol : value;
    if (after !== before) deps.setDirty(true);
    deps.updateStatus();
    deps.flash('保存换行: ' + (value === 'follow' ? '跟随原文件' : value.toUpperCase()));
    closeFootPopover();
}

function renderEolMenu() {
    const fs = deps.getFormatSettings(deps.file.format.id);
    const eff = fs.eol === 'follow' ? deps.file.eol : fs.eol;
    footPopover.appendChild(popTitle('换行符'));
    for (const [value, label] of deps.EOLS) {
        footPopover.appendChild(popItem(label, {
            current: fs.eol === value,
            onClick: () => chooseEol(value),
        }));
    }
    footPopover.appendChild(popFoot('当前', eff.toUpperCase()));
}

function openFootPopover(kind) {
    if (!deps.file && kind !== 'aiWidth') return;
    const anchor = FOOT_WIDGETS[kind];
    if (!anchor) return;
    footPopover.textContent = '';
    footPopover.classList.remove('hidden');
    if (kind === 'encoding') renderEncodingMenu();
    else if (kind === 'view') renderViewMenu();
    else if (kind === 'zoom') {
        if (deps.currentMode === 'table' && deps.file.format && deps.file.format.table) renderTableZoomMenu();
        else renderImageZoomMenu();
    }
    else if (kind === 'mdWidth') renderMdWidthMenu();
    else if (kind === 'aiWidth') renderAiWidthMenu();
    else renderEolMenu();
    const r = anchor.getBoundingClientRect();
    const pr = footPopover.getBoundingClientRect();
    // 向上弹出，空间不足时限制高度内部滚动，避免被窗口顶部截断
    const available = r.top - 14;
    if (pr.height > available && available > 120) {
        footPopover.style.maxHeight = available + 'px';
        footPopover.style.overflowY = 'auto';
        const pr2 = footPopover.getBoundingClientRect();
        footPopover.style.left = Math.max(8, Math.round(r.right - pr2.width)) + 'px';
        footPopover.style.top = Math.round(r.top - pr2.height - 6) + 'px';
    } else {
        footPopover.style.maxHeight = '';
        footPopover.style.overflowY = '';
        footPopover.style.left = Math.max(8, Math.round(r.right - pr.width)) + 'px';
        footPopover.style.top = Math.round(r.top - pr.height - 6) + 'px';
    }
    Object.values(FOOT_WIDGETS).forEach((el) => el && el.classList.remove('active'));
    anchor.classList.add('active');
    footPopoverKind = kind;
    if (footStackHandle) footStackHandle.dispose();
    footStackHandle = overlayStack.open({
        id: 'foot-popover', kind: 'popover', el: footPopover,
        onClose: () => { closeFootPopover(); return true; },
    });
}

function toggleFootPopover(kind) {
    if (footPopoverKind === kind && !footPopover.classList.contains('hidden')) closeFootPopover();
    else openFootPopover(kind);
}

Object.entries(FOOT_WIDGETS).forEach(([kind, el]) => {
    if (!el) return;
    el.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFootPopover(kind);
    });
});
footPopover.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.closest && (t.closest('#enc-popover') || t.closest('#statusbar'))) return;
    closeFootPopover();
}, true);
window.addEventListener('blur', () => closeFootPopover());


return {closeFootPopover, makeSelect, mdPreviewWidthLabel, openFootPopover, toggleFootPopover, updateAiWidthWidget};
}
