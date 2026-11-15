// editor-export-menus.js：从 editor-groups.js 拆出的域模块（factory + 显式依赖注入）。
// Markdown 块级渲染与选区复制（预览反向取源）、SVG→PNG 导出、
// svg/image/md 预览右键菜单与标签页右键菜单。
//
// deps 经 Object.create 委托继承 editor-groups 的 getter 集，另接
// renderMarkdownPreview（分屏预览域）与核心函数 updateStatus / closeDocsWithConfirm /
// requestCloseDoc / showPathInFolder / reopenClosedTab / groupDocs / groupOfDoc 的转发箭头。
import DOMPurify from 'dompurify';
import {copyImageBlobToClipboard} from '../core/image-clipboard.js';
import {iconSvg} from '../core/icons.js';
import {isTabReadOnlyFixed, isTabReadOnlyLocked} from '../core/readonly.js';

export function createEditorExportMenus(deps) {


// copyImageBlobToClipboard 把图片 Blob 写入剪贴板（image/png）。
// svgToPngBlob 把 SVG 文本转成 2x 尺寸的 PNG Blob。
function svgToPngBlob(svgText) {
    return new Promise((resolve, reject) => {
        const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
        const img = new Image();
        img.onload = () => {
            try {
                const scale = 2;
                const w = Math.max(1, img.naturalWidth || 800);
                const h = Math.max(1, img.naturalHeight || 600);
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(w * scale);
                canvas.height = Math.round(h * scale);
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                canvas.toBlob((blob) => {
                    if (blob) resolve(blob);
                    else reject(new Error('canvas 转换失败'));
                }, 'image/png');
            } catch (e) {
                reject(e);
            }
        };
        img.onerror = () => reject(new Error('SVG 加载失败'));
        img.src = url;
    });
}

function fileStem(name) {
    const base = deps.baseNameOf(name || '图表');
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(0, dot) : base;
}

// showSvgMenu SVG 渲染视图的右键菜单（完整渲染 + 分屏右栏）。
function showSvgMenu(doc, x, y) {
    if (!deps.ctxMenu || !doc) return;
    const items = [
        {label: '导出为 PNG…（2x）', icon: 'E74E', action: async () => {
            try {
                const svgText = doc.editor.getText();
                const blob = await svgToPngBlob(svgText);
                const dataUrl = await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => resolve('');
                    reader.readAsDataURL(blob);
                });
                if (!dataUrl) throw new Error('PNG 数据生成失败');
                let dest = '';
                try {
                    dest = await deps.backend.SaveFileDialog(fileStem(doc.path || doc.name) + '.png');
                } catch (e) {
                    return;
                }
                if (!dest) return;
                await deps.backend.SaveDataURL(dest, dataUrl);
                deps.flash('已导出 PNG：' + deps.baseNameOf(dest));
            } catch (e) {
                deps.flash('导出失败：' + (e && e.message || e), true);
            }
        }},
        {label: '复制图片', icon: 'E8C8', action: async () => {
            try {
                const blob = await svgToPngBlob(doc.editor.getText());
                const ok = await copyImageBlobToClipboard(blob);
                deps.flash(ok ? '已复制图片' : '剪贴板不支持图片', !ok);
            } catch (e) {
                deps.flash('复制失败：' + (e && e.message || e), true);
            }
        }},
        {sep: true},
        ...deps.aiReferenceFileMenuItems(doc),
        {label: '复制文件路径', icon: 'E8C8', disabled: !doc.path, action: () => deps.copyText(doc.path, '路径')},
        {label: '打开文件位置', icon: 'E8B7', disabled: !doc.path, action: () => deps.showPathInFolder(doc.path)},
    ];
    deps.ctxMenu.open(items, x, y);
}

// showImageMenu 图片视图的右键菜单。
function showImageMenu(doc, x, y) {
    if (!deps.ctxMenu || !doc) return;
    const items = [
        {label: '另存为…', icon: 'E74E', disabled: !doc.path, action: async () => {
            let dest = '';
            try {
                dest = await deps.backend.SaveFileDialog(deps.baseNameOf(doc.path));
            } catch (e) {
                return;
            }
            if (!dest) return;
            try {
                await deps.backend.CopyFileTo(doc.path, dest);
                deps.flash('已另存为：' + deps.baseNameOf(dest));
            } catch (e) {
                deps.flash('另存为失败：' + (e && e.message || e), true);
            }
        }},
        {label: '复制图片', icon: 'E8C8', action: async () => {
            try {
                const url = doc.imageUrl || await deps.backend.ReadImageAsDataURL(doc.path);
                const blob = await (await fetch(url)).blob();
                const ok = await copyImageBlobToClipboard(blob);
                deps.flash(ok ? '已复制图片' : '剪贴板不支持图片', !ok);
            } catch (e) {
                deps.flash('复制失败：' + (e && e.message || e), true);
            }
        }},
        {sep: true},
        ...deps.aiReferenceFileMenuItems(doc),
        {label: '复制文件路径', icon: 'E8C8', disabled: !doc.path, action: () => deps.copyText(doc.path, '路径')},
        {label: '打开文件位置', icon: 'E8B7', disabled: !doc.path, action: () => deps.showPathInFolder(doc.path)},
    ];
    deps.ctxMenu.open(items, x, y);
}

// showMdPreviewMenu Markdown 预览区的右键菜单：常用操作 + 预览宽度调整。
function showMdPreviewMenu(doc, x, y) {
    if (!deps.ctxMenu || !doc) return;
    const selText = String(window.getSelection ? window.getSelection().toString() : '');
    const widthOptions = [['720', '720px'], ['860', '860px'], ['920', '920px'], ['1100', '1100px'], ['1300', '1300px'], ['0', '跟随窗口宽度']];
    const items = [
        {label: '复制', shortcut: 'Ctrl+C', icon: 'E8C8', disabled: !selText, submenu: [
            {label: '纯文本', action: () => deps.copyText(selText, '所选文本')},
            {label: '富文本', action: async () => {
                const ok = await copySelectionRich();
                if (!ok) deps.flash('复制失败', true);
            }},
            {label: 'markdown文本', action: async () => {
                const ok = await copySelectedMarkdown(doc);
                if (!ok) deps.flash('无法定位所选内容对应的源码', true);
            }},
        ]},
        {label: '全选', shortcut: 'Ctrl+A', action: () => {
            const sel = window.getSelection();
            if (sel && doc.previewBody) sel.selectAllChildren(doc.previewBody);
        }},
        {sep: true},
        {label: '切换到代码视图', action: () => deps.switchMode('code')},
        {label: '分屏预览（左源码右预览）', disabled: doc.splitActive || !deps.canSplitDoc(doc), action: () => deps.switchMode('split')},
    ];
    if (!doc.splitActive) {
        items.push({sep: true});
        items.push({
            label: '预览宽度',
            submenu: widthOptions.map(([value, label]) => ({
                label,
                checked: String(deps.settings.mdPreviewWidth) === value,
                action: () => {
                    deps.settings.mdPreviewWidth = value;
                    deps.applySettings();
                    deps.updateStatus();
                },
            })),
        });
        items.push({label: '刷新预览', icon: 'E72C', action: () => deps.renderMarkdownPreview(doc)});
    }
    items.push({sep: true});
    items.push(...deps.aiReferenceFileMenuItems(doc));
    items.push({label: '复制文件路径', icon: 'E8C8', disabled: !doc.path, action: () => deps.copyText(doc.path, '路径')});
    items.push({label: '打开文件位置', icon: 'E8B7', disabled: !doc.path, action: () => deps.showPathInFolder(doc.path)});
    deps.ctxMenu.open(items, x, y);
}

function showTabMenu(doc, x, y) {
    if (!deps.ctxMenu || !doc) return;
    const g0 = deps.groupOfDoc(doc.id);
    const gdocs = g0 ? deps.groupDocs(g0) : deps.docs.slice();
    const idx = gdocs.indexOf(doc);
    const others = gdocs.filter((d) => d !== doc);
    const left = gdocs.slice(0, Math.max(0, idx));
    const clean = gdocs.filter((d) => !d.dirty);
    const hasPath = !!doc.path;
    deps.ctxMenu.open([
        {label: '关闭', shortcut: 'Ctrl+W / Shift+点击', icon: 'E8BB', action: () => deps.requestCloseDoc(doc)},
        {label: '关闭其他标签页', disabled: !others.length, action: () => deps.closeDocsWithConfirm(others)},
        {label: '关闭所有标签页', action: () => deps.closeDocsWithConfirm(gdocs.slice(), '关闭所有标签页将丢弃未保存的修改。')},
        {label: '关闭左侧标签页', disabled: !left.length, action: () => deps.closeDocsWithConfirm(left)},
        {label: '关闭未修改标签页', disabled: !clean.length, action: () => deps.closeDocsWithConfirm(clean)},
        {sep: true},
        {label: '复制文件路径', icon: 'E8C8', disabled: !hasPath, action: () => deps.copyText(doc.path, '路径')},
        {label: '复制文件名', icon: 'E8C8', action: () => deps.copyText(doc.name, '文件名')},
        {label: '打开文件位置', icon: 'E8B7', disabled: !hasPath, action: () => deps.showPathInFolder(doc.path)},
        // 固定只读（审阅快照）：不提供解锁入口，只留一条禁用说明。
        ...(isTabReadOnlyFixed(doc) ? [{
            label: '只读快照 · 不可解锁',
            iconHtml: iconSvg('lock', 14),
            title: '这是只读快照，不能改成可编辑',
            disabled: true,
        }] : [{
            label: isTabReadOnlyLocked(doc) ? '解除本标签只读' : '只读锁定本标签',
            iconHtml: iconSvg('lock', 14),
            title: '只影响当前标签，与编辑器全局只读锁互不干扰',
            action: () => deps.setDocReadOnly(doc, !isTabReadOnlyLocked(doc)),
        }]),
        {label: '与另一个标签页比较…', icon: 'E8A5', disabled: gdocs.filter((d) => d.path && !d.binary).length < 2, action: () => deps.openDiffDialog(doc.path)},
        ...deps.aiReferenceFileMenuItems(doc),
        {sep: true},
        {label: '在新窗口中打开', shortcut: 'Shift+F4', icon: 'E8A7', disabled: !hasPath, action: () => deps.openInNewWindows([doc.path])},
        {label: '重新打开关闭的标签页', shortcut: 'Ctrl+Shift+T', icon: 'E7A7', disabled: !deps.closedTabs.length, action: deps.reopenClosedTab},
    ], x, y);
}

// renderMarkdownBlocks 按顶层块渲染 Markdown，并用 data-md-start/end
// 标注每块对应的源码行区间（0 基，含头不含尾），供预览选区反向取 md 源码。
function renderMarkdownBlocks(text) {
    const env = {};
    const tokens = deps.markdownRenderer.parse(text || '', env);
    const blocks = [];
    let i = 0;
    while (i < tokens.length) {
        const start = i;
        let level = 0;
        do {
            const t = tokens[i];
            if (t.nesting === 1) level++;
            else if (t.nesting === -1) level--;
            i++;
        } while (i < tokens.length && level > 0);
        const group = tokens.slice(start, i);
        const html = deps.markdownRenderer.renderer.render(group, deps.markdownRenderer.options, env);
        const map = group[0] && group[0].map;
        blocks.push({
            start: map && map.length === 2 ? map[0] : null,
            end: map && map.length === 2 ? map[1] : null,
            html,
        });
    }
    return blocks;
}

function markdownBlockHash(html) {
    let hash = 2166136261 >>> 0;
    for (let i = 0; i < html.length; i++) {
        hash ^= html.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(36) + ':' + html.length.toString(36);
}

function sanitizeMarkdownSegment(html) {
    return DOMPurify.sanitize(html, {
        USE_PROFILES: {html: true, mathMl: true, svg: true},
        ADD_ATTR: ['target', 'rel'],
    });
}

function renderMarkdownBlocksHtml(text) {
    let blocks;
    try {
        blocks = renderMarkdownBlocks(text);
    } catch (e) {
        return deps.renderMarkdownHtml(text);
    }
    let html = '';
    for (const block of blocks) {
        if (block.start != null && block.end != null) {
            html += '<div class="md-block" style="display:contents" data-md-start="' + block.start +
                '" data-md-end="' + block.end + '" data-md-hash="' + markdownBlockHash(block.html) + '">' +
                block.html + '</div>';
        } else {
            html += block.html;
        }
    }
    // 整页只净化一次：逐块 sanitize 会为每个顶层块各建一个 document 并全量遍历
    return DOMPurify.sanitize(html, {
        USE_PROFILES: {html: true, mathMl: true, svg: true},
        ADD_ATTR: ['target', 'rel', 'data-md-start', 'data-md-end', 'data-md-hash'],
    });
}

// patchMarkdownPreview 复用未变化块的 DOM，只更新行区间或替换变化块；
// 任一块缺少源码行区间（无法安全对齐）时返回 false，调用方回退整页渲染。
function patchMarkdownPreview(doc) {
    const body = doc && doc.previewBody;
    if (!body) return false;
    let blocks;
    try {
        blocks = renderMarkdownBlocks(doc.editor.getText());
    } catch (e) {
        return false;
    }
    if (blocks.some((block) => block.start == null || block.end == null)) return false;
    const oldEls = Array.from(body.children);
    if (oldEls.some((el) => !el.classList || !el.classList.contains('md-block'))) return false;
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        let el = oldEls[i];
        if (!el) {
            el = document.createElement('div');
            el.className = 'md-block';
            el.style.display = 'contents';
            body.appendChild(el);
        }
        el.dataset.mdStart = String(block.start);
        el.dataset.mdEnd = String(block.end);
        const hash = markdownBlockHash(block.html);
        if (el.dataset.mdHash !== hash) {
            el.innerHTML = sanitizeMarkdownSegment(block.html);
            el.dataset.mdHash = hash;
        }
    }
    for (let i = blocks.length; i < oldEls.length; i++) oldEls[i].remove();
    return true;
}

// rangeIntersectsNode 判断选区 range 是否与节点内容相交。
function rangeIntersectsNode(range, node) {
    try {
        const nr = document.createRange();
        nr.selectNodeContents(node);
        return range.compareBoundaryPoints(Range.END_TO_START, nr) < 0 &&
            range.compareBoundaryPoints(Range.START_TO_END, nr) > 0;
    } catch (e) {
        return false;
    }
}

// copySelectedMarkdown 把预览选区还原成对应的 markdown 源码行并复制。
// 精度是块级：选中段落的任何部分都会取回该块（及跨到的最后一个块）的完整源码行。
function copySelectedMarkdown(doc) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    const blocks = doc.previewBody ? Array.from(doc.previewBody.querySelectorAll('.md-block[data-md-start]')) : [];
    const hit = blocks.filter((b) => rangeIntersectsNode(range, b));
    if (!hit.length) return false;
    const start = Number(hit[0].dataset.mdStart);
    const end = Number(hit[hit.length - 1].dataset.mdEnd);
    if (!(start >= 0) || !(end > start)) return false;
    const lines = doc.editor.getText().split('\n');
    const text = lines.slice(start, end).join('\n');
    return deps.copyText(text, 'markdown 源码');
}

// getSelectionHtml 取当前选区的 HTML 片段（支持多选区）。
function getSelectionHtml(sel) {
    if (!sel || !sel.rangeCount) return '';
    const container = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) {
        container.appendChild(sel.getRangeAt(i).cloneContents());
    }
    return container.innerHTML;
}

// copySelectionRich 富文本复制：同时写入 text/html 与 text/plain，
// 粘到 Word/微信等会保留渲染样式。Clipboard API 不可用时回退临时选区 + execCommand。
async function copySelectionRich() {
    const sel = window.getSelection();
    const plain = sel ? sel.toString() : '';
    if (!plain) return false;
    const html = getSelectionHtml(sel);
    try {
        if (navigator.clipboard && window.ClipboardItem) {
            await navigator.clipboard.write([new ClipboardItem({
                'text/html': new Blob([html], {type: 'text/html'}),
                'text/plain': new Blob([plain], {type: 'text/plain'}),
            })]);
            return true;
        }
    } catch (e) {}
    try {
        const holder = document.createElement('div');
        holder.contentEditable = 'true';
        holder.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        holder.innerHTML = html || '';
        document.body.appendChild(holder);
        const range = document.createRange();
        range.selectNodeContents(holder);
        const tmpSel = window.getSelection();
        tmpSel.removeAllRanges();
        tmpSel.addRange(range);
        const ok = document.execCommand('copy');
        tmpSel.removeAllRanges();
        holder.remove();
        if (ok) return true;
    } catch (e) {}
    return await deps.copyText(plain, '所选文本');
}

    return {
        renderMarkdownBlocks, markdownBlockHash, sanitizeMarkdownSegment, renderMarkdownBlocksHtml, patchMarkdownPreview,
        rangeIntersectsNode, copySelectedMarkdown, getSelectionHtml, copySelectionRich,
        svgToPngBlob, fileStem, showSvgMenu, showImageMenu, showMdPreviewMenu, showTabMenu,
    };
}
