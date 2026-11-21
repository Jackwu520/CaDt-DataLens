// bridge-app-page-view.js：应用页面在内容区的标签页（「一切皆标签页」的第二族）。
//
// 与第一族（子代理详情 / 支线对话 / 便签…）的区别：那族装载「一个具体业务对象」，
// 这族装载「一个功能页面」（使用统计 / 定时任务 / 操作记录 / 补丁库）。
// 页面清单与元数据在 core/app-pages.js，内容渲染仍归原域——本模块只负责：
//   建标签页 → 建容器 → 调该页的 mount(root) → 关标签时调它返回的卸载函数。
//
// 各页的 mount 由 main.js 经 deps.appPageMounters 注入（键 = appPage id），
// 这样 bridge 域不需要 import settings/ 或 ai/（同级域互相不 import）。
import {appPageOf} from '../core/app-pages.js';
import {createVirtualTabDoc} from '../core/virtual-tab-doc.js';

export function createBridgeAppPageView(deps) {

// 同一页面只允许一个标签页（单例）：再点入口就切过去，不堆重复标签。
function openAppPageTab(pageId) {
    const page = appPageOf(pageId);
    if (!page) return null;
    const existing = deps.docs.find((d) => d.appPage === page.id);
    if (existing) {
        deps.activateDoc(existing);
        return existing;
    }
    const doc = createVirtualTabDoc({
        id: 'apppage-' + page.id,
        name: page.label,
        format: {id: 'apppage', name: page.label, extensions: [], aceMode: 'text', rawOnly: true},
        mode: 'apppage',
        marker: 'appPage',
        key: page.id,
    });
    deps.docs.push(doc);
    deps.addDocToFocusedGroup(doc);
    deps.activateDoc(doc);
    return doc;
}

function createAppPageView(doc) {
    const page = appPageOf(doc.appPage);
    const pane = document.createElement('div');
    pane.className = 'jsoneditor-pane active apppage-pane';
    deps.els.editor.appendChild(pane);
    const root = document.createElement('div');
    root.className = 'apppage-root';
    pane.appendChild(root);
    doc.pane = pane;
    doc.appPageRoot = root;

    const mount = deps.appPageMounters ? deps.appPageMounters[doc.appPage] : null;
    if (typeof mount !== 'function') {
        root.textContent = '应用页面「' + (page ? page.label : doc.appPage) + '」不可用：界面尚未就绪。';
        root.classList.add('empty');
        return;
    }
    const unmount = mount(root);
    // 统一卸载契约（closeDocNow 只调这一条）：页面自己退订 / 释放图表实例
    doc.tabUnmount = () => {
        if (typeof unmount === 'function') unmount();
        doc.tabUnmount = null;
        doc.appPageRoot = null;
    };
}

return {openAppPageTab, createAppPageView};
}
