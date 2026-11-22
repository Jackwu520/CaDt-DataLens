// tabstrip-scroll.test.mjs —— 标签条横向滚动位置的接线守卫。
//
// 背景（2026-11-21 用户实测）：renderEditorLayout 整段重建标签条会把横向滚动位置清零，
// 随后 revealActiveTabs 无条件把激活标签滚回可视区。任何后台重绘（外部修改标记 /
// AI 写已打开文件 / 保存脏标 / 后台标签关闭）都会把用户手动滚到一半的标签条弹回
// 激活标签的定位点，标签多时表现为「怎么都滚不到末尾，末尾被工具区盖住」。
//
// 背景（2026-11-22 用户实测）：编辑区收起时 #main-pane 是 display:none，此时打开文件
// （AI 面板点文件链接）会在隐藏态重建标签条，右侧工具区（.tb-tools 绝对定位覆盖层）
// 的 offsetWidth 量出来恒为 0，末尾 spacer 被记成 0px；展开后 spacer 无人重量，
// 标签条滚到头末尾标签仍被工具区盖住——表现为「横滚条滚不到最后，像被盖住」。
//
// 修复契约：
//   · renderEditorLayout 重建前按组记录 .etabs 的 scrollLeft，重建后原样恢复；
//   · 只有首次构建（此前不存在该组的标签条）才做激活标签定位（reveal）；
//   · 切换标签（activateDoc 换 doc 分支）显式补发定位；
//   · scheduleRevealActiveTabs / revealActiveTabs 支持按组过滤，同帧调度合并时
//     「无条件定位」（null）吞掉组过滤，绝不能让组过滤把无条件定位挤掉；
//   · spacer 宽度测量收敛到 syncTabSpacer（buildGroup 现场量一次）；编辑区展开瞬间
//     main.js 的 setEditorCollapsed 只在「收起→展开」真实过渡时调 refreshTabStripSpacers
//     重量全部组，且只对 spacer 确实被修正的情形补发定位（不拽用户手动滚出的位置）。
//
// 历史教训：这类回归全部静默——不会报错、dev 单标签场景复现不了，必须有源码守卫。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const src = readFileSync(join(srcRoot, 'editor/editor-groups.js'), 'utf8');
const mainSrc = readFileSync(join(srcRoot, 'main.js'), 'utf8');

// 切出顶层函数体（editor-groups.js 的域函数都在 0 缩进的 `function` 层）。
function sliceTopFunction(text, signature) {
    const start = text.indexOf(signature);
    assert.ok(start >= 0, '找不到函数：' + signature);
    const rest = text.slice(start + signature.length);
    const next = /\nfunction [A-Za-z_]/.exec(rest);
    return signature + (next ? rest.slice(0, next.index) : rest);
}

test('renderEditorLayout 重建前按组记录标签条横滚位置', () => {
    const body = sliceTopFunction(src, 'function renderEditorLayout()');
    assert.ok(body.includes("querySelectorAll('.egroup[data-gid] > .etabs')"),
        'renderEditorLayout 必须在清空 #editor 前，按组收集 .etabs 的横滚位置');
    assert.ok(body.includes('prevStripScroll'),
        '收集结果必须存入 prevStripScroll（重建后恢复用）');
    // 收集必须发生在 textContent = ''（整段清空）之前
    const captureAt = body.indexOf("querySelectorAll('.egroup[data-gid] > .etabs')");
    const clearAt = body.indexOf("deps.els.editor.textContent = ''");
    assert.ok(captureAt >= 0 && clearAt >= 0 && captureAt < clearAt,
        '横滚位置的收集必须先于 #editor 清空，否则读到的永远是 0');
});

test('renderEditorLayout 重建后恢复已存在的标签条位置，仅首次构建才 reveal', () => {
    const body = sliceTopFunction(src, 'function renderEditorLayout()');
    assert.ok(body.includes('freshGids'),
        '必须有 freshGids 集合区分「首次构建的组」与「恢复位置的组」');
    assert.ok(/for\s*\(\s*const wrap of deps\.els\.editor\.querySelectorAll\('\.egroup\[data-gid\]'\)\)/.test(body),
        '重建后必须遍历 .egroup 恢复横滚位置');
    assert.ok(body.includes('stripEl.scrollLeft = prev'),
        '已有位置的组必须恢复 scrollLeft');
    assert.ok(body.includes('if (freshGids.size) scheduleRevealActiveTabs(freshGids)'),
        '只有存在首次构建的组才调度 reveal；恢复过位置的组绝不能再定位');
    // 旧的「重建完无条件定位」不能再出现（否则后台重绘又会抢走滚动位置）
    assert.ok(!/\}\n\s*scheduleRevealActiveTabs\(\);\n\}/.test(body),
        'renderEditorLayout 结尾不得保留无条件的 scheduleRevealActiveTabs()');
});

test('scheduleRevealActiveTabs 支持组过滤，同帧合并时 null 吞掉组过滤', () => {
    const body = sliceTopFunction(src, 'function scheduleRevealActiveTabs(gids = null)');
    assert.ok(body.includes('revealTabsFilter'),
        '必须用 revealTabsFilter 保存本次调度的过滤范围');
    assert.ok(body.includes('if (revealTabsRaf)'),
        '必须保留 rAF 去重守卫');
    // 合并分支：pending 为 null 时保持 null；pending 为 Set 时收到 null 要升级为 null
    assert.ok(/if \(revealTabsFilter\) \{[\s\S]*?if \(!gids\) revealTabsFilter = null;[\s\S]*?for \(const gid of gids\) revealTabsFilter\.add\(gid\);/.test(body),
        '同帧合并：null（全部组）吞掉 Set 过滤；Set 与 Set 取并集');
});

test('revealActiveTabs 只处理过滤范围内的组', () => {
    const body = sliceTopFunction(src, 'function revealActiveTabs(gids = null)');
    assert.ok(body.includes('if (gids && !gids.has(wrap.dataset.gid)) continue;'),
        '组不在过滤范围内时必须跳过（恢复过位置的组不再被拽回激活标签）');
    // 定位判定本身保持原契约：超出可视区才滚动
    assert.ok(body.includes('tr.left < sr.left + pad') && body.includes('tr.right > sr.right - rightInset - pad'),
        '左右越界判定必须保留');
});

test('activateDoc 切换分支显式补发激活标签定位', () => {
    const body = sliceTopFunction(src, 'async function activateDoc(doc)');
    assert.ok(/updateDocChrome\(\);[\s\S]{0,240}scheduleRevealActiveTabs\(\);/.test(body),
        '切换 doc 后（updateDocChrome → renderTabs）必须显式调度 reveal，' +
        '否则标签条恢复用户滚动位置后，新激活标签可能停在可视区外');
    // 同文档重新激活的定位兜底保持不变
    assert.ok(body.includes('scheduleRevealActiveTabs();'),
        '同文档重新激活（点已激活标签 / 活动栏入口）的定位兜底必须保留');
});

test('renderEditorLayout 重建前记录焦点、重建后恢复焦点', () => {
    const body = sliceTopFunction(src, 'function renderEditorLayout()');
    // 重建前必须记录焦点（document.activeElement 与所属 pane），且早于清空
    assert.ok(body.includes('const prevActive = document.activeElement'),
        '重建前必须记录 document.activeElement（否则清空后焦点信息丢失）');
    assert.ok(body.includes('prevActivePane'),
        '必须记录焦点所属的 .jsoneditor-pane（用于重建后判断是否仍激活）');
    assert.ok(body.includes('hadFocusInEditor'),
        '必须记录焦点是否在编辑器内');
    const focusAt = body.indexOf('const prevActive = document.activeElement');
    const clearAt = body.indexOf("deps.els.editor.textContent = ''");
    assert.ok(focusAt >= 0 && clearAt >= 0 && focusAt < clearAt,
        '焦点记录必须先于 #editor 清空，否则读到的 activeElement 已丢失');
    // 重建后必须恢复焦点：焦点 pane 仍激活时走 aceEditor.focus()
    assert.ok(body.includes("querySelector('.jsoneditor-pane.active')"),
        '重建后必须找到激活的 pane 做判断');
    assert.ok(body.includes('aceEditor.focus()'),
        '焦点 pane 仍激活时必须调用 aceEditor.focus() 恢复焦点');
    // 恢复逻辑必须位于重建完成之后（在 reveal 定位之后）
    const revealAt = body.indexOf('if (freshGids.size) scheduleRevealActiveTabs(freshGids)');
    const restoreAt = body.indexOf('hadFocusInEditor && prevActivePane');
    assert.ok(revealAt >= 0 && restoreAt >= 0 && restoreAt > revealAt,
        '焦点恢复必须位于标签条定位恢复之后，避免定位逻辑覆盖焦点');
});

test('buildGroup 的 spacer 宽度测量收敛到 syncTabSpacer（不许内联量 offsetWidth）', () => {
    const body = sliceTopFunction(src, 'function buildGroup(parent, gid)');
    assert.ok(body.includes('syncTabSpacer(wrap)'),
        'buildGroup 必须经 syncTabSpacer 建 spacer（测量要能在展开时重量）');
    assert.ok(!body.includes('.offsetWidth'),
        'buildGroup 里不得内联访问 .offsetWidth——收起态下量出来恒为 0（2026-11-22 事故根因）');
});

test('syncTabSpacer 从工具区实测宽度更新 spacer，宽度不变时返回 false', () => {
    const body = sliceTopFunction(src, 'function syncTabSpacer(wrap)');
    assert.ok(body.includes("wrap.querySelector('.tb-tools')"),
        '必须从 .tb-tools 实测宽度（绝对定位覆盖层占的滚动余量）');
    assert.ok(body.includes("strip.querySelector(':scope > .tb-spacer')"),
        'spacer 必须挂在 .etabs 直下（flex 尾项）');
    assert.ok(body.includes("const width = tools.offsetWidth + 'px'") && body.includes('spacer.style.width = width'),
        'spacer 宽度必须等于工具区 offsetWidth（实测来源唯一）');
    assert.ok(body.includes('return false') && body.includes('return true'),
        '必须返回宽度是否变化（refreshTabStripSpacers 据此决定是否补发定位）');
});

test('refreshTabStripSpacers 重量全部组，仅 spacer 被修正时补发定位', () => {
    const body = sliceTopFunction(src, 'function refreshTabStripSpacers()');
    assert.ok(body.includes("querySelectorAll('.egroup[data-gid]')"),
        '必须遍历全部编辑器分组（收起期间任何组都可能被重建过）');
    assert.ok(body.includes('if (syncTabSpacer(wrap)) changed = true;'),
        '逐组重量并统计 spacer 是否被修正');
    assert.ok(/if \(changed\) scheduleRevealActiveTabs\(\);/.test(body),
        '只有 spacer 确实被修正（收起态重建过）才补发激活标签定位；' +
        '纯开合循环不定位，别把用户手动滚出的位置拽回激活标签');
});

test('工厂 API 导出 refreshTabStripSpacers（main.js 展开分支要调）', () => {
    assert.match(src, /\brefreshTabStripSpacers,\s*reopenClosedTab,/,
        'createEditorGroups 返回对象必须导出 refreshTabStripSpacers');
});

test('main.js setEditorCollapsed 只在收起→展开的真实过渡时重量 spacer', () => {
    const body = sliceTopFunction(mainSrc, 'function setEditorCollapsed(next, reason)');
    assert.ok(body.includes('const was = !!editorCollapseReason'),
        '必须先记录过渡前的收起态');
    assert.ok(body.includes('if (!target && was) editorGroupsMod.refreshTabStripSpacers();'),
        '只在「收起→展开」真实过渡时调 refreshTabStripSpacers：' +
        '收起方向（hidden 态）量了也是 0；未变的重复调用不该拽滚动位置');
});
