// titlebar-popovers.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 标题栏弹层壳：定位工具与共享图标；项目弹层与 Git 分支弹层已拆到同目录兄弟模块。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {createTitlebarGitBranch} from './titlebar-git-branch.js';
import {createTitlebarProject} from './titlebar-project.js';
import {createTitlebarRunConfig} from './titlebar-run-config.js';
import {iconSvg} from '../core/icons.js';
import {placePopover} from '../core/popover-position.js';

export function createTitlebarPopovers(deps) {

// 局部键 → 注册表键（原散落 SVG 已收编 core/icons.js；尺寸保持原值）
const POP_ICONS = {
    folder: iconSvg('folder', 16),
    branch: iconSvg('git', 16),
    reveal: iconSvg('open-folder', 14),
    update: iconSvg('refresh', 16),
    commit: iconSvg('check', 16),
    push: iconSvg('upload', 16),
    plus: iconSvg('plus', 16),
    tag: iconSvg('tag', 16),
    check: iconSvg('circle-check', 16),
    chevron: iconSvg('chevron-down', 10),
};

function isToolbarPopOpen(pop) {
    return !!pop && !pop.classList.contains('hidden');
}

// 定位统一走 core/popover-position：底部优先、放不下钳到视口底部（与旧行为一致，不翻上方）。
function positionToolbarPopover(pop, anchor) {
    placePopover(pop, anchor, {placement: 'bottom', gap: 6});
}


// 三个弹层要互相关闭对方：共用一个 extras 对象，交叉引用在各侧创建后才补上（调用都在运行时）
const popDeps = Object.create(deps);
popDeps.isToolbarPopOpen = isToolbarPopOpen;
popDeps.positionToolbarPopover = positionToolbarPopover;
popDeps.POP_ICONS = POP_ICONS;
const projMod = createTitlebarProject(popDeps);
const gitMod = createTitlebarGitBranch(popDeps);
const runMod = createTitlebarRunConfig(popDeps);
popDeps.closeProjectPopover = projMod.closeProjectPopover;
popDeps.closeGitBranchPopover = gitMod.closeGitBranchPopover;
popDeps.closeRunConfigPopover = runMod.closeRunConfigPopover;

    return {
        ...projMod, ...gitMod, ...runMod,
    };
}
