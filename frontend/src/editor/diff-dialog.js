// diff-dialog.js：两个文件 Diff 的选择对话框（factory + 显式依赖注入）。
// 比较内核与结果渲染已迁到独立对比窗（diff-window-view.js，辅助窗第一批）；
// 本模块退化为选择器——选两个文件后开对比窗，结果与语义差异都在窗口里看。
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构。
import {overlayStack} from '../core/overlay-stack.js';

export function createDiffDialog(deps) {

const diffState = {open: false, previousFocus: null};

// 对话框的弹层栈条目（modal 档，遮罩即容器）；Esc 由栈按层序退
let diffStackHandle = null;

function diffEls() {
    return {
        mask: document.getElementById('diff-mask'),
        a: document.getElementById('diff-a'),
        b: document.getElementById('diff-b'),
        run: document.getElementById('diff-run'),
        close: document.getElementById('diff-close'),
        semantic: document.getElementById('diff-semantic'),
        summary: document.getElementById('diff-summary'),
        semanticList: document.getElementById('diff-semantic-list'),
        output: document.getElementById('diff-output'),
    };
}

function fillDiffSelect(select, entries) {
    select.textContent = '';
    for (const [path, name] of entries) {
        const option = document.createElement('option');
        option.value = path;
        option.textContent = name + ' — ' + path;
        select.appendChild(option);
    }
}

// openDiffWindow 打开独立对比窗（辅助窗第一批）。
function openDiffWindow(pathA, pathB) {
    if (!deps.backend.OpenDiffWindow) {
        deps.flash('当前构建不支持对比窗口', true);
        return;
    }
    deps.backend.OpenDiffWindow(pathA, pathB).catch((e) => {
        deps.flash('打开对比窗口失败：' + ((e && e.message) || e), true);
    });
}

function openDiffDialog(pathA, pathB) {
    // 两个路径都被点名（编辑器右键「与文件对比」等）：跳过选择对话框直接开窗
    if (pathA && pathB) {
        openDiffWindow(pathA, pathB);
        return;
    }
    const elsD = diffEls();
    if (!elsD.mask) return;
    const candidates = deps.docs.filter((d) => d.path && !d.binary);
    const map = new Map(candidates.map((d) => [d.path, d.name]));
    if (pathA && !map.has(pathA)) map.set(pathA, deps.baseNameOf(pathA) || pathA);
    if (pathB && !map.has(pathB)) map.set(pathB, deps.baseNameOf(pathB) || pathB);
    if (map.size < 2) {
        deps.flash('至少打开两个文本文件才能比较', true);
        return;
    }
    const entries = [...map.entries()].sort((x, y) => x[1].localeCompare(y[1], 'zh-CN'));
    fillDiffSelect(elsD.a, entries);
    fillDiffSelect(elsD.b, entries);
    if (pathA && map.has(pathA)) elsD.a.value = pathA;
    if (pathB && map.has(pathB)) elsD.b.value = pathB;
    if (elsD.b.value === elsD.a.value) {
        const other = entries.find(([path]) => path !== elsD.a.value);
        if (other) elsD.b.value = other[0];
    }
    diffState.open = true;
    diffState.previousFocus = document.activeElement;
    elsD.mask.classList.remove('hidden');
    if (diffStackHandle) diffStackHandle.dispose();
    diffStackHandle = overlayStack.open({
        id: 'diff-mask', kind: 'modal', el: elsD.mask,
        onClose: () => { closeDiffDialog(); return true; },
    });
    // 对话框只做选择：旧的结果区（语义差异 / diff 输出）随比较内核一并退场
    elsD.semanticList.classList.add('hidden');
    elsD.semanticList.textContent = '';
    elsD.output.textContent = '';
    elsD.summary.textContent = '选择两个文件，结果在独立对比窗口中展示';
}

function closeDiffDialog() {
    if (!diffState.open) return;
    diffState.open = false;
    if (diffStackHandle) {
        diffStackHandle.dispose();
        diffStackHandle = null;
    }
    const {mask} = diffEls();
    if (mask) mask.classList.add('hidden');
    const prev = diffState.previousFocus;
    diffState.previousFocus = null;
    if (prev && prev.isConnected && typeof prev.focus === 'function') {
        try { prev.focus(); } catch (e) {}
    }
}

function runDiffCompare() {
    const elsD = diffEls();
    if (!elsD.a || !elsD.b) return;
    const pathA = elsD.a.value;
    const pathB = elsD.b.value;
    if (!pathA || !pathB) {
        elsD.summary.textContent = '请选择两个文件';
        return;
    }
    if (deps.samePathValue(pathA, pathB)) {
        elsD.summary.textContent = '两个文件相同，请选择不同的文件';
        return;
    }
    closeDiffDialog();
    openDiffWindow(pathA, pathB);
}

function bindDiffDialog() {
    const elsD = diffEls();
    if (!elsD.mask) return;
    if (elsD.run) elsD.run.addEventListener('click', runDiffCompare);
    if (elsD.close) elsD.close.addEventListener('click', closeDiffDialog);
    elsD.mask.addEventListener('mousedown', (e) => {
        if (e.target === elsD.mask) closeDiffDialog();
    });
    // Esc 已归全局弹层栈（openDiffDialog 注册），不再需要 document capture 监听
}
bindDiffDialog();


    return {openDiffDialog};
}
