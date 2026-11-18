import {iconSvg} from '../core/icons.js';

// 容器内图片查看层：铺满宿主容器（不越出该面板），把图片放大到整个内容区。
// 关闭：Esc / 点击空白 / 右上角按钮；滚轮缩放、拖拽平移、双击在「适应区域」与 100% 间切换。
export function createImageLightbox(host, options = {}) {
    if (!host) throw new Error('createImageLightbox 需要宿主容器');
    const onContextMenu = typeof options.onContextMenu === 'function' ? options.onContextMenu : null;
    const MIN_SCALE = 0.05;
    const MAX_SCALE = 8;

    let root = null;
    let stage = null;
    let canvas = null;
    let img = null;
    let titleNode = null;
    let zoomNode = null;
    let image = null;
    let opened = false;
    let openSeq = 0;
    let naturalW = 0;
    let naturalH = 0;
    let fitScale = 1;
    let scale = 1;
    let drag = null;
    let dragMoved = false;

    function ensureBuilt() {
        if (root) return;
        root = document.createElement('div');
        root.className = 'img-lightbox hidden';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-label', '图片查看');

        const head = document.createElement('div');
        head.className = 'img-lightbox-head';
        titleNode = document.createElement('span');
        titleNode.className = 'img-lightbox-title';
        const hint = document.createElement('span');
        hint.className = 'img-lightbox-hint';
        hint.textContent = '滚轮缩放 · 拖动平移';
        hint.dataset.tip = '滚轮缩放 · 拖动平移 · 双击原始大小 · 右键复制 / 另存为';
        zoomNode = document.createElement('span');
        zoomNode.className = 'img-lightbox-zoom';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'img-lightbox-close';
        closeBtn.dataset.tip = '关闭 (Esc)';
        closeBtn.innerHTML = iconSvg('close', 14);
        head.append(titleNode, hint, zoomNode, closeBtn);

        stage = document.createElement('div');
        stage.className = 'img-lightbox-stage';
        canvas = document.createElement('div');
        canvas.className = 'img-lightbox-canvas';
        img = document.createElement('img');
        img.className = 'img-lightbox-img';
        img.alt = '';
        img.draggable = false;
        canvas.appendChild(img);
        stage.appendChild(canvas);
        root.append(head, stage);
        host.appendChild(root);

        closeBtn.addEventListener('click', close);
        root.addEventListener('click', (e) => {
            if (!opened || dragMoved) return;
            if (e.target === root || e.target === stage || e.target === canvas) close();
        });
        root.addEventListener('contextmenu', (e) => {
            if (!opened) return;
            e.preventDefault();
            e.stopPropagation();
            // 回调拿 image 对象（AI 面板传了）；宿主没传时退回当前的 <img>，
            // 否则调用方按 target.src 取图会拿到 null，菜单静默不弹。
            if (onContextMenu) onContextMenu(image || img, e.clientX, e.clientY);
        });
        stage.addEventListener('wheel', (e) => {
            if (!opened || !naturalW || !naturalH || !e.deltaY) return;
            e.preventDefault();
            e.stopPropagation();
            zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
        }, {passive: false});
        img.addEventListener('dblclick', (e) => {
            if (!opened || !naturalW || !naturalH) return;
            e.preventDefault();
            e.stopPropagation();
            const target = Math.abs(scale - fitScale) < 0.01 ? 1 : fitScale;
            zoomAt(e.clientX, e.clientY, target / scale);
        });
        stage.addEventListener('pointerdown', (e) => {
            if (!opened || e.button !== 0) return;
            if (e.target !== stage && e.target !== canvas && e.target !== img) return;
            drag = {x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop};
            dragMoved = false;
            stage.classList.add('dragging');
            if (stage.setPointerCapture) {
                try { stage.setPointerCapture(e.pointerId); } catch (err) { /* 指针已失效 */ }
            }
        });
        stage.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const dx = e.clientX - drag.x;
            const dy = e.clientY - drag.y;
            if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true;
            stage.scrollLeft = drag.left - dx;
            stage.scrollTop = drag.top - dy;
        });
        const endDrag = (e) => {
            if (!drag) return;
            drag = null;
            stage.classList.remove('dragging');
            if (e.pointerId != null && stage.hasPointerCapture && stage.hasPointerCapture(e.pointerId)) {
                stage.releasePointerCapture(e.pointerId);
            }
        };
        stage.addEventListener('pointerup', endDrag);
        stage.addEventListener('pointercancel', endDrag);
        window.addEventListener('keydown', (e) => {
            if (!opened || e.key !== 'Escape') return;
            // 右键菜单在查看层之上：这次 Esc 先归菜单（两种监听顺序都要让过）。
            if (e.defaultPrevented) return;
            if (document.querySelector('.ctx-menu:not(.hidden)')) return;
            e.preventDefault();
            e.stopPropagation();
            close();
        }, true);
        window.addEventListener('resize', () => {
            if (!opened || !naturalW) return;
            if (Math.abs(scale - fitScale) < 0.01) computeFit();
        });
    }

    function applyScale() {
        if (!naturalW || !naturalH) return;
        img.style.width = Math.max(1, Math.round(naturalW * scale)) + 'px';
        img.style.height = Math.max(1, Math.round(naturalH * scale)) + 'px';
        if (zoomNode) zoomNode.textContent = Math.round(scale * 100) + '%';
    }

    function computeFit() {
        const rect = stage.getBoundingClientRect();
        const availW = Math.max(32, rect.width - 24);
        const availH = Math.max(32, rect.height - 24);
        fitScale = Math.min(availW / naturalW, availH / naturalH, 1);
        if (!(fitScale > 0)) fitScale = 1;
        scale = fitScale;
        applyScale();
        stage.scrollLeft = 0;
        stage.scrollTop = 0;
    }

    function zoomAt(clientX, clientY, factor) {
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
        if (!(next > 0) || Math.abs(next - scale) < 1e-4) return;
        const rect = stage.getBoundingClientRect();
        const ax = Math.min(Math.max(clientX == null ? rect.left + rect.width / 2 : clientX, rect.left), rect.right);
        const ay = Math.min(Math.max(clientY == null ? rect.top + rect.height / 2 : clientY, rect.top), rect.bottom);
        const contentX = stage.scrollLeft + (ax - rect.left);
        const contentY = stage.scrollTop + (ay - rect.top);
        const prev = scale;
        scale = next;
        applyScale();
        const ratio = scale / prev;
        stage.scrollLeft = contentX * ratio - (ax - rect.left);
        stage.scrollTop = contentY * ratio - (ay - rect.top);
    }

    function open(targetImage, src, title) {
        if (!src) return;
        ensureBuilt();
        image = targetImage || null;
        opened = true;
        const seq = ++openSeq;
        naturalW = 0;
        naturalH = 0;
        fitScale = 1;
        scale = 1;
        drag = null;
        dragMoved = false;
        stage.classList.remove('dragging');
        titleNode.textContent = title || '';
        titleNode.dataset.tip = title || '';
        zoomNode.textContent = '';
        img.alt = title || '';
        // 上一张图残留的内联尺寸会带进新图（解码慢时先看到旧尺寸），开局一律清掉。
        img.style.width = '';
        img.style.height = '';
        root.classList.remove('hidden');
        stage.scrollLeft = 0;
        stage.scrollTop = 0;
        // load / error 两条都收：解码失败（坏 data URL、超限图）时不再停在
        // 「既没放大也没提示」的黑屏——缩放开局不可用，右上角明确写「无法显示」。
        // settled 保证成功后只结算一次：load 与 decode() 常常先后都到，重复结算会把用户
        // 已经滚轮放大的比例重置回「适应区域」。失败不锁定，留给迟到的 load 一次修正机会。
        let settled = false;
        const settle = () => {
            if (settled || seq !== openSeq || !opened) return;
            naturalW = img.naturalWidth || 0;
            naturalH = img.naturalHeight || 0;
            if (naturalW && naturalH) {
                settled = true;
                computeFit();
                return;
            }
            img.style.width = '';
            img.style.height = '';
            zoomNode.textContent = '无法显示';
        };
        img.addEventListener('load', settle, {once: true});
        img.addEventListener('error', settle, {once: true});
        img.src = src;
        if (img.complete && img.naturalWidth) {
            settle(); // 命中内存缓存：load 不会再排
        } else if (typeof img.decode === 'function') {
            // 坏 data URL / 解码失败时 error 事件不保证派发（WebView2 实测只把 complete 置 true、
            // naturalWidth 留 0），decode() 的 reject 是更可靠的那一路。
            img.decode().then(settle, settle);
        }
    }

    function close() {
        if (!opened) return;
        opened = false;
        openSeq++;
        image = null;
        drag = null;
        stage.classList.remove('dragging');
        root.classList.add('hidden');
        img.removeAttribute('src');
    }

    return {open, close, isOpen: () => opened};
}
