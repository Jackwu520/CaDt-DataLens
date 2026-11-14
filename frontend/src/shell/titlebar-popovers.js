// titlebar-popovers.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 标题栏弹层壳：定位工具与共享图标；项目弹层与 Git 分支弹层已拆到同目录兄弟模块。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {createTitlebarGitBranch} from './titlebar-git-branch.js';
import {createTitlebarProject} from './titlebar-project.js';

export function createTitlebarPopovers(deps) {

const POP_ICONS = {
    folder: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.8 4.5c0-.8.6-1.4 1.4-1.4h3l1.5 1.7h5c.8 0 1.4.6 1.4 1.4v5.3c0 .8-.6 1.4-1.4 1.4H3.2c-.8 0-1.4-.6-1.4-1.4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    branch: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="4.6" cy="3.7" r="1.7" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="4.6" cy="12.3" r="1.7" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="11.4" cy="5.4" r="1.7" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.6 5.4v5.2M11.4 7.1c0 2.1-2.2 2.9-4.3 3.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    reveal: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 5.3V3.9c0-.7.6-1.3 1.3-1.3h3l1.4 1.5h4.9c.8 0 1.4.6 1.4 1.4v.7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.4 6.4h11.2l-1.2 5.1c-.1.6-.6 1-1.2 1H4.7c-.6 0-1.1-.4-1.2-1z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    update: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M12.8 8a4.8 4.8 0 1 1-1.4-3.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M12.8 2.6v3.2H9.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    commit: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.4 8.3l2.8 2.8 6-6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    push: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 12.4V3.6M4.4 7.2L8 3.6l3.6 3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    plus: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 3.4v9.2M3.4 8h9.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    tag: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2.6 3.2h5.1l5 5-4.5 4.5-5-5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="5.3" cy="5.9" r="1" fill="currentColor"/></svg>',
    check: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 8.2l1.7 1.7 3.3-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevron: '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M4.4 6.2 8 9.8l3.6-3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function isToolbarPopOpen(pop) {
    return !!pop && !pop.classList.contains('hidden');
}

function positionToolbarPopover(pop, anchor) {
    if (!pop || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    let left = Math.min(rect.left, window.innerWidth - width - margin);
    left = Math.max(margin, left);
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - margin) top = window.innerHeight - height - margin;
    top = Math.max(margin, top);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
}


// 两个弹层要互相关闭对方：共用一个 extras 对象，交叉引用在两侧创建后才补上（调用都在运行时）
const popDeps = Object.create(deps);
popDeps.isToolbarPopOpen = isToolbarPopOpen;
popDeps.positionToolbarPopover = positionToolbarPopover;
popDeps.POP_ICONS = POP_ICONS;
const projMod = createTitlebarProject(popDeps);
const gitMod = createTitlebarGitBranch(popDeps);
popDeps.closeProjectPopover = projMod.closeProjectPopover;
popDeps.closeGitBranchPopover = gitMod.closeGitBranchPopover;

    return {
        ...projMod, ...gitMod,
    };
}
