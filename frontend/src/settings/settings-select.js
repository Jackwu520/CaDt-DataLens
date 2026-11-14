// 设置页的行式下拉：把原生 select 增强为触发器 + 圆角面板，原生 select 仍是值真源。
// 从 settings-ui.js 拆出；options 动态增删由 MutationObserver 自动重建。
export function createSettingsSelect(deps) {

// ---- 自定义下拉：把设置页的原生 select 增强为行式下拉（参考图形态：触发器 + 圆角面板 + 选中✓）。
// 原生 select 隐藏但保留为真源（value / disabled 可读写），点击项更新 value 并派发 change——
// 既有接线全部零改动；options 动态增删由 MutationObserver 自动重建（模型/字体/模板下拉）。
// 这同时绕开了 WebView2 原生 select 弹层的不可控外观与偶发定位问题。

function setSelectCloseAll(except) {
    document.querySelectorAll('.set-select.open').forEach((wrap) => {
        if (wrap !== except) {
            wrap.classList.remove('open');
            const sel = wrap.querySelector('.set-select-native');
            if (sel) sel.dataset.ssOpen = '';
        }
    });
}

function setSelectRender(sel, wrap) {
    const btn = wrap.querySelector('.set-select-btn');
    const pop = wrap.querySelector('.set-select-pop');
    const label = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '';
    btn.querySelector('.ss-label').textContent = label;
    pop.innerHTML = '';
    [...sel.options].forEach((option) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'ss-opt' + (option.selected ? ' selected' : '');
        item.dataset.value = option.value;
        const text = document.createElement('span');
        text.className = 'ss-label';
        text.textContent = option.text;
        item.append(text);
        if (option.selected && deps.iconSvg) {
            const check = document.createElement('span');
            check.className = 'ss-check';
            check.innerHTML = deps.iconSvg('check', 12);
            item.append(check);
        }
        item.addEventListener('click', () => {
            if (sel.value !== option.value) {
                sel.value = option.value;
                sel.dispatchEvent(new Event('change', {bubbles: true}));
            }
            wrap.classList.remove('open');
            sel.dataset.ssOpen = '';
        });
        pop.append(item);
    });
}

function enhanceSetSelects() {
    document.querySelectorAll('.settings-pane select.opt-select').forEach((sel) => {
        if (sel.dataset.setSelect === '1') return;
        sel.dataset.setSelect = '1';
        sel.classList.add('set-select-native');
        const wrap = document.createElement('div');
        wrap.className = 'set-select';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'set-select-btn';
        btn.innerHTML = '<span class="ss-label"></span><span class="ss-chev"></span>';
        const pop = document.createElement('div');
        pop.className = 'set-select-pop';
        sel.after(wrap);
        wrap.append(btn, pop);
        if (deps.iconSvg) btn.querySelector('.ss-chev').innerHTML = deps.iconSvg('chevron-down', 12);

        const render = () => setSelectRender(sel, wrap);
        const toggle = () => {
            const opening = !wrap.classList.contains('open');
            setSelectCloseAll();
            if (opening) {
                render();
                // 下方空间不足时向上弹
                const rect = wrap.getBoundingClientRect();
                pop.classList.toggle('up', rect.bottom + 240 > window.innerHeight && rect.top > 240);
                wrap.classList.add('open');
                sel.dataset.ssOpen = '1';
            }
        };
        btn.addEventListener('click', toggle);
        btn.addEventListener('keydown', (e) => {
            // 键盘：↑↓ 直接改选中项（同步派发 change），Enter/Esc 开合与关闭
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const delta = e.key === 'ArrowDown' ? 1 : -1;
                const next = Math.min(sel.options.length - 1, Math.max(0, sel.selectedIndex + delta));
                if (next !== sel.selectedIndex) {
                    sel.selectedIndex = next;
                    render();
                    sel.dispatchEvent(new Event('change', {bubbles: true}));
                }
            } else if (e.key === 'Escape') {
                wrap.classList.remove('open');
                sel.dataset.ssOpen = '';
            }
        });
        // options 动态增删（模型 / 字体 / 模板下拉）自动重建
        new MutationObserver(render).observe(sel, {childList: true});
        sel.addEventListener('change', () => {
            if (!wrap.classList.contains('open')) render();
        });
        render();
    });
    // 外点关闭（与 info-tip 委托并列）
    if (!window.__setSelectDelegated) {
        window.__setSelectDelegated = true;
        document.addEventListener('click', (e) => {
            if (e.target && e.target.closest && e.target.closest('.set-select')) return;
            setSelectCloseAll();
        });
    }
}


return {enhanceSetSelects, setSelectCloseAll};
}
