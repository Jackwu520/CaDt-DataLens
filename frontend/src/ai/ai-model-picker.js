// ai-model-picker.js：双层级模型选择器（搜索 + 按账号分组 + 行内思考等级 + 会话上下文上限）。
// 方案 M1 从 ai-panel.js 逐字搬入（docs/unfinished-plans/side-chat-tab.md §7.4）。
// 状态自持（弹层节点与文档监听器）；配置 / 会话 / 动作经 ctx 注入，档位与窗口计算
// 直接复用 ai-config-model.js 的纯函数（单一来源）。
import {iconSvg} from '../core/icons.js';
import {createInput} from '../core/form-controls.js';
import {ctxLimitTiersFor, effectiveContextWindow, formatTokenAmount, reasoningLevelInfo} from './ai-config-model.js';
import {providerIconTileHtml} from './ai-provider-icons.js';
import {formatUsageHeadline} from './ai-usage-quota.js';

export function createAIModelPicker(ctx) {
    const el = ctx.el;
    const getConfig = ctx.getConfig;
    const currentSession = ctx.currentSession;
    const entryOf = ctx.entryOf;
    const sessionModelRef = ctx.sessionModelRef;
    const switchModel = ctx.switchModel;
    const openSettings = ctx.openSettings;
    const providerLabelFor = ctx.providerLabelFor;
    const setReasoningLevelFor = ctx.setReasoningLevelFor;
    const applyCtxLimit = ctx.applyCtxLimit;
    const flash = ctx.flash;
    // 额度外显（可选依赖）：分组头右侧显示余额主句；管线未注入时保持原样
    const usageQuota = typeof ctx.usageQuota === 'function' ? ctx.usageQuota : null;

    let modelPickerEl = null;
    let modelPickerDismiss = null;

    function closeModelPicker() {
        if (modelPickerDismiss) {
            const dispose = modelPickerDismiss;
            modelPickerDismiss = null;
            dispose();
        }
        if (modelPickerEl) {
            modelPickerEl.remove();
            modelPickerEl = null;
        }
    }

    function showModelPicker() {
        if (!el.modelChip) return;
        if (modelPickerEl) {
            closeModelPicker();
            return;
        }
        const config = getConfig();
        if (!config.profiles.length) {
            openSettings('models');
            return;
        }
        const rect = el.modelChip.getBoundingClientRect();
        // 选择器展示 / 勾选的都是「当前会话」的模型（各会话独立）
        const sessionRef = sessionModelRef(currentSession());
        const activeAccountId = (sessionRef.profile && sessionRef.profile.id) || '';
        const activeEntryId = (sessionRef.entry && sessionRef.entry.id) || '';
        const picker = document.createElement('div');
        picker.className = 'ai-model-picker';
        modelPickerEl = picker;

        const searchWrap = document.createElement('div');
        searchWrap.className = 'ai-model-picker-searchwrap';
        const searchIco = document.createElement('span');
        searchIco.className = 'ai-model-picker-searchico';
        searchIco.innerHTML = iconSvg('search', 13);
        const search = createInput({
            className: 'ai-model-picker-search',
            placeholder: '搜索模型…',
            spellcheck: false,
        }).control;
        searchWrap.append(searchIco, search);
        const listBox = document.createElement('div');
        listBox.className = 'ai-model-picker-list';
        const limitRow = document.createElement('div');
        limitRow.className = 'ai-model-picker-limits';
        const foot = document.createElement('div');
        foot.className = 'ai-model-picker-foot';
        const settingsBtn = document.createElement('button');
        settingsBtn.type = 'button';
        settingsBtn.className = 'ai-model-picker-settings';
        settingsBtn.textContent = '模型设置…';
        settingsBtn.addEventListener('click', () => {
            closeModelPicker();
            openSettings('models');
        });
        foot.appendChild(settingsBtn);
        picker.append(searchWrap, listBox, limitRow, foot);

        let flatItems = [];
        let navIndex = -1;
        // 行内展开的思考等级档位条（accountId|entryId）；搜索重建列表时收起
        let expandedKey = '';

        function renderList() {
            const query = search.value.trim().toLowerCase();
            const tokens = query.split(/\s+/).filter(Boolean);
            listBox.innerHTML = '';
            flatItems = [];
            for (const account of getConfig().profiles) {
                const entries = (account.models || []).filter((entry) => {
                    if (!tokens.length) return true;
                    const haystack = ((entry.model || '') + ' ' + (account.name || '')).toLowerCase();
                    return tokens.every((token) => haystack.includes(token));
                });
                if (!entries.length) continue;
                const group = document.createElement('div');
                group.className = 'ai-model-picker-group';
                const head = document.createElement('div');
                head.className = 'ai-model-picker-group-head';
                const headIcon = document.createElement('span');
                headIcon.className = 'ai-model-picker-headicon';
                headIcon.innerHTML = providerIconTileHtml(account, 16);
                head.appendChild(headIcon);
                const headName = document.createElement('span');
                headName.textContent = account.name || '未命名账号';
                const headTag = document.createElement('span');
                headTag.className = 'ai-model-picker-tag';
                headTag.textContent = providerLabelFor(account);
                head.append(headName, headTag);
                // 开启了额度查询的账号在分组头右侧显示余额主句（失败态红字；无缓存不占位）
                if (usageQuota) {
                    const snapshot = usageQuota().peek(account.id);
                    if (snapshot && (snapshot.state === 'error' || (snapshot.items || []).length)) {
                        const headUsage = document.createElement('span');
                        headUsage.className = 'ai-model-picker-usage' + (snapshot.state === 'error' ? ' error' : '');
                        headUsage.textContent = snapshot.state === 'error'
                            ? (snapshot.error || '查询失败')
                            : formatUsageHeadline(snapshot);
                        head.appendChild(headUsage);
                    }
                }
                group.appendChild(head);
                for (const entry of entries) {
                    const isActive = account.id === activeAccountId && entry.id === activeEntryId;
                    const item = document.createElement('button');
                    item.type = 'button';
                    item.className = 'ai-model-picker-item' + (isActive ? ' active' : '');
                    const name = document.createElement('span');
                    name.className = 'ai-model-picker-name';
                    name.textContent = entry.model || '（未填写模型 ID）';
                    // 思考等级徽标：每个模型条目自己的等级（分色见 --ai-lv-*），
                    // 点击在行下展开档位条直接改该模型 —— 弹层不关，可连续配置多个
                    const info = reasoningLevelInfo(account, entry);
                    const effort = document.createElement('button');
                    effort.type = 'button';
                    effort.className = 'ai-model-picker-effort';
                    effort.dataset.tone = info.tone;
                    effort.textContent = info.label;
                    effort.addEventListener('click', (e) => {
                        e.stopPropagation();
                        toggleQuickBar(account, entry);
                    });
                    const win = document.createElement('span');
                    win.className = 'ai-model-picker-win';
                    win.textContent = formatTokenAmount(entry.contextWindow || 128000);
                    const check = document.createElement('span');
                    check.className = 'ai-model-picker-check';
                    check.innerHTML = isActive ? iconSvg('check', 13) : '';
                    item.append(name, effort, win, check);
                    item.addEventListener('click', () => {
                        closeModelPicker();
                        switchModel(account.id, entry.id);
                    });
                    flatItems.push(item);
                    group.appendChild(item);
                    // 档位条是 item 的兄弟节点（按钮不能嵌套），展开态单开
                    if (account.id + '|' + entry.id === expandedKey) group.appendChild(buildQuickBar(account, entry));
                }
                listBox.appendChild(group);
            }
            if (!flatItems.length) {
                const empty = document.createElement('div');
                empty.className = 'ai-model-picker-empty';
                empty.textContent = query
                    ? '没有匹配「' + search.value.trim() + '」的模型'
                    : '还没有模型';
                listBox.appendChild(empty);
            }
            navIndex = -1;
        }

        // 展开 / 收起某模型行下的思考等级档位条（同弹层内只开一个）
        function toggleQuickBar(account, entry) {
            const key = account.id + '|' + entry.id;
            expandedKey = expandedKey === key ? '' : key;
            renderList();
            const bar = expandedKey ? listBox.querySelector('.ai-model-picker-quick') : null;
            if (bar && bar.scrollIntoView) bar.scrollIntoView({block: 'nearest'});
        }

        // 思考等级档位条：连体分段控件，点档写该模型条目（不关弹层、徽标即时刷新）
        function buildQuickBar(account, entry) {
            const info = reasoningLevelInfo(account, entry);
            const bar = document.createElement('div');
            bar.className = 'ai-model-picker-quick ai-model-picker-seggroup';
            for (const [value, label] of info.options) {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'ai-model-picker-seg' + (info.value === value ? ' active' : '');
                chip.textContent = label;
                chip.addEventListener('click', () => {
                    setReasoningLevelFor(account, entry, value);
                    flash('已更新 ' + (entry.model || '未命名模型') + ' 思考等级：' + reasoningLevelInfo(account, entry).label);
                    expandedKey = account.id + '|' + entry.id;
                    renderList();
                });
                bar.appendChild(chip);
            }
            return bar;
        }

        function setNav(next) {
            if (!flatItems.length) return;
            navIndex = (next + flatItems.length) % flatItems.length;
            flatItems.forEach((item, index) => item.classList.toggle('nav', index === navIndex));
            const target = flatItems[navIndex];
            if (target && target.scrollIntoView) target.scrollIntoView({block: 'nearest'});
        }

        // 本次会话上下文上限（会话级，不动模型条目）：档位只列 < 模型窗口的固定档
        //（CTX_LIMIT_TIERS），模型窗口不大于最小档（如上限就 256K 的模型）时整行隐藏。
        // 思考等级已收进模型行的行内徽标 + 档位条，这里不再有全局推理等级行。
        function renderLimits() {
            const session = currentSession();
            const entry = entryOf(session);
            const base = (entry && entry.contextWindow) || 128000;
            const tiers = ctxLimitTiersFor(base);
            limitRow.innerHTML = '';
            if (!session || !entry || !tiers.length) {
                limitRow.style.display = 'none';
                return;
            }
            limitRow.style.display = '';
            const lab = document.createElement('span');
            lab.className = 'ai-model-picker-limits-label';
            lab.textContent = '上下文上限';
            limitRow.appendChild(lab);
            const seg = document.createElement('div');
            seg.className = 'ai-model-picker-seggroup';
            const currentEffective = effectiveContextWindow(base, session.ctxLimit);
            const options = [[0, '默认']].concat(tiers.map((tier) => [tier, formatTokenAmount(tier)]));
            for (const [value, label] of options) {
                const effective = effectiveContextWindow(base, value);
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'ai-model-picker-seg' + (effective === currentEffective ? ' active' : '');
                chip.textContent = label;
                chip.addEventListener('click', () => {
                    closeModelPicker();
                    applyCtxLimit(value);
                });
                seg.appendChild(chip);
            }
            limitRow.appendChild(seg);
        }

        search.addEventListener('input', () => {
            expandedKey = '';
            renderList();
        });
        search.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setNav(navIndex < 0 ? 0 : navIndex + 1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setNav(navIndex < 0 ? flatItems.length - 1 : navIndex - 1);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const target = flatItems[navIndex >= 0 ? navIndex : 0];
                if (target) target.click();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeModelPicker();
            }
        });

        const onDocMouseDown = (e) => {
            if (modelPickerEl && picker.contains(e.target)) return;
            if (el.modelChip && el.modelChip.contains(e.target)) return;
            closeModelPicker();
        };
        modelPickerDismiss = () => {
            document.removeEventListener('mousedown', onDocMouseDown, true);
        };
        document.addEventListener('mousedown', onDocMouseDown, true);

        renderList();
        renderLimits();
        document.body.appendChild(picker);
        picker.style.visibility = 'hidden';
        const width = Math.min(360, window.innerWidth - 16);
        const height = picker.offsetHeight;
        const top = rect.top - height - 8 >= 8 ? rect.top - height - 8 : Math.max(8, rect.bottom + 8);
        picker.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + 'px';
        picker.style.top = top + 'px';
        picker.style.width = width + 'px';
        picker.style.visibility = '';
        search.focus();
    }

    return {showModelPicker, closeModelPicker};
}
