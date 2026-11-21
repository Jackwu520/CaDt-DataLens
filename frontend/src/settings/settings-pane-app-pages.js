// settings-pane-app-pages.js：设置 → 页面 → 应用页面（目录页）。
//
// 「一切皆标签页」的分发口：使用统计 / 定时任务 / 操作记录 / 补丁库这些数据浏览面板
// 已经从设置对话框搬进内容区标签页（内容渲染仍归原域），设置页这边只留一份**目录**——
// 一行一个页面，点开就在内容区打开对应标签页。清单单一来源 core/app-pages.js。
//
// 这样设置页仍是这些功能的「发现入口」，但不再当容器：模态框关掉就不再丢滚动位置与筛选状态。

import {appPageGroups} from '../core/app-pages.js';

export function createSettingsPaneAppPages(deps) {
    // 渲染目录行：图标 + 标题 + 一句话说明 + 「打开」按钮（整行可点）。
    function renderAppPagesPane() {
        const host = document.getElementById('app-pages-list');
        if (!host) return;
        host.textContent = '';
        for (const group of appPageGroups()) {
            for (const page of group.pages) {
                const row = document.createElement('div');
                row.className = 'set-row app-pages-row';
                row.dataset.pageId = page.id;

                const main = document.createElement('div');
                main.className = 'set-main';
                const title = document.createElement('div');
                title.className = 'set-title';
                title.textContent = page.label;
                const desc = document.createElement('div');
                desc.className = 'set-desc';
                desc.textContent = page.desc;
                main.append(title, desc);

                const control = document.createElement('div');
                control.className = 'set-control';
                const openBtn = document.createElement('button');
                openBtn.type = 'button';
                openBtn.className = 'dlg-btn';
                openBtn.textContent = '打开';
                openBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    deps.openAppPageTab(page.id);
                });
                control.appendChild(openBtn);

                row.append(main, control);
                // 整行可点：省得每次都要瞄准小按钮
                row.addEventListener('click', () => deps.openAppPageTab(page.id));
                host.appendChild(row);
            }
        }
    }

    return {renderAppPagesPane};
}
