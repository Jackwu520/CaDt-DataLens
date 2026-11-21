// settings-pane-app-pages.js：设置 → 页面 → 应用页面（目录页）。
//
// 「一切皆标签页」的分发口：使用统计 / 外部工具 / 定时任务 / 操作记录 / 补丁库这些功能页
// 已经从设置对话框搬进内容区标签页（内容渲染仍归原域），设置页这边只留一份**目录**——
// 一行一个页面，点开就在内容区打开对应标签页并收掉设置弹层。清单单一来源 core/app-pages.js。
//
// 这样设置页仍是这些功能的「发现入口」，但不再当容器：模态框关掉就不再丢滚动位置与筛选状态。

import {appPageGroups} from '../core/app-pages.js';

export function createSettingsPaneAppPages(deps) {
    // 打开目标页并收掉设置弹层：页面已是内容区标签页，设置窗留着只会挡视线。
    function openPage(page) {
        deps.openAppPageTab(page.id);
        if (typeof deps.closeSettings === 'function') deps.closeSettings();
    }

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

                const ic = document.createElement('span');
                ic.className = 'app-pages-row-ic';
                if (deps.iconSvg) ic.innerHTML = deps.iconSvg(page.icon, 14);

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
                    openPage(page);
                });
                control.appendChild(openBtn);

                row.append(ic, main, control);
                // 整行可点：省得每次都要瞄准小按钮
                row.addEventListener('click', () => openPage(page));
                host.appendChild(row);
            }
        }
    }

    return {renderAppPagesPane};
}
