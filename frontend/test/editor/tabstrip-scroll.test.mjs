// tabstrip-scroll.test.mjs —— 标签条横向滚动位置的接线守卫。
//
// 背景（2026-11-21 用户实测）：renderEditorLayout 整段重建标签条会把横向滚动位置清零，
// 随后 revealActiveTabs 无条件把激活标签滚回可视区。任何后台重绘（外部修改标记 /
// AI 写已打开文件 / 保存脏标 / 后台标签关闭）都会把用户手动滚到一半的标签条弹回
// 激活标签的定位点，标签多时表现为「怎么都滚不到末尾，末尾被工具区盖住」。
//
// 修复契约：
//   · renderEditorLayout 重建前按组记录 .etabs 的 scrollLeft，重建后原样恢复；
//   · 只有首次构建（此前不存在该组的标签条）才做激活标签定位（reveal）；
//   · 切换标签（activateDoc 换 doc 分支）显式补发定位；
//   · scheduleRevealActiveTabs / revealActiveTabs 支持按组过滤，同帧调度合并时
//     「无条件定位」（null）吞掉组过滤，绝不能让组过滤把无条件定位挤掉。
//
// 历史教训：这类回归全部静默——不会报错、dev 单标签场景复现不了，必须有源码守卫。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const src = readFileSync(join(srcRoot, 'editor/editor-groups.js'), 'utf8');

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
