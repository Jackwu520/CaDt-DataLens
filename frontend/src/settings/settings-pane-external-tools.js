// settings-pane-external-tools.js：设置 → AI → 外部工具。
// 上半部分是能力来源矩阵（搜索/抓取/OCR/TTS/ASR 各选 关闭 / 本地 MCP / 服务提供商，
// 搜索与抓取另有内置），下半部分是服务提供商配置；MCP 服务器组由 index.html 原样迁入，
// 绑定仍归 ai-mcp-settings.js。配置读写走 Go（WebToolsConfigGet / Save / ClearKey）。
import {createInput, createSelect, createSwitch} from '../core/form-controls.js';
import {
    DEFAULT_PROVIDER_BASE_URL,
    EXTERNAL_CAPABILITIES,
    EXTERNAL_MODE_LABELS,
    defaultExternalToolsConfig,
    effectiveExternalMode,
    externalProviderReady,
    normalizeExternalToolsConfig,
} from '../ai/ai-external-tools.js';

export function createSettingsPaneExternalTools(deps) {
    const backend = (deps && deps.backend) || {};
    const flash = (deps && deps.flash) || (() => {});
    const getMcpToolDefs = (deps && deps.getMcpToolDefs) || (() => []);
    const getAiPanel = (deps && deps.getAiPanel) || (() => null);
    const openExternalUrl = (deps && deps.openExternalUrl) || (() => {});
    const enhanceSetSelects = (deps && deps.enhanceSetSelects) || null;

    const els = {
        list: document.getElementById('extcap-list'),
        provider: document.getElementById('extcap-provider'),
    };
    let config = defaultExternalToolsConfig();
    let loading = false;
    let errorText = '';

    function fieldRow(title, desc, ...controls) {
        const row = document.createElement('div');
        row.className = 'set-row';
        const main = document.createElement('div');
        main.className = 'set-main';
        const t = document.createElement('div');
        t.className = 'set-title';
        t.textContent = title;
        main.appendChild(t);
        if (desc) {
            const d = document.createElement('div');
            d.className = 'set-desc';
            d.textContent = desc;
            main.appendChild(d);
        }
        const box = document.createElement('div');
        box.className = 'set-control';
        for (const control of controls) if (control) box.appendChild(control);
        row.append(main, box);
        return row;
    }

    function button(label, className, onClick) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = className || 'dlg-btn';
        el.textContent = label;
        if (onClick) el.addEventListener('click', onClick);
        return el;
    }

    async function load() {
        if (loading) return;
        loading = true;
        try {
            if (typeof backend.WebToolsConfigGet !== 'function') {
                errorText = '当前后端版本不支持外部工具配置（请重新构建或更新应用）';
                return;
            }
            config = normalizeExternalToolsConfig(await backend.WebToolsConfigGet());
            errorText = '';
        } catch (e) {
            errorText = '配置读取失败：' + ((e && e.message) || e);
        } finally {
            loading = false;
        }
    }

    function payload(patch) {
        const next = Object.assign({}, config, patch || {});
        return {
            enabled: next.enabled,
            baseUrl: next.baseUrl,
            apiKey: (patch && patch.apiKey) || '',
            searchCount: next.searchCount,
            capabilities: next.capabilities,
            mcpBindings: next.mcpBindings,
        };
    }

    async function save(patch) {
        if (typeof backend.WebToolsConfigSave !== 'function') {
            flash('当前后端版本不支持外部工具配置', true);
            return;
        }
        try {
            await backend.WebToolsConfigSave(payload(patch));
            config = normalizeExternalToolsConfig(await backend.WebToolsConfigGet());
            const panel = getAiPanel();
            if (panel && typeof panel.refreshExternalTools === 'function') {
                Promise.resolve(panel.refreshExternalTools()).catch(() => {});
            }
            paint();
        } catch (e) {
            flash('外部工具配置保存失败：' + ((e && e.message) || e), true);
        }
    }

    function mcpToolOptions() {
        return (getMcpToolDefs() || []).map((def) => ({value: def.name, label: def.name}));
    }

    function capabilityHint(cap, mode, liveNames) {
        if (mode === 'off') return '不向 AI 注册该工具。';
        if (mode === 'builtin') return '使用应用内置实现，失败后可自动回退。';
        if (mode === 'provider') {
            return externalProviderReady(config)
                ? '上传到服务提供商，按量计费；审批卡会显示文件与预估费用。'
                : '服务提供商未启用或缺少 API Key，当前不可用（见下方配置）。';
        }
        if (mode === 'mcp') {
            const binding = config.mcpBindings[cap.key] || '';
            if (!binding) return '尚未选择 MCP 工具，当前不可用。';
            if (!liveNames.includes(binding)) return '绑定的工具当前不可用（服务器被禁用/删除或工具未勾选），请重选。';
            return '交本机 MCP 服务器处理；仅写权限档（非计划模式）向 AI 开放，调用按写工具审批。';
        }
        return '';
    }

    function paintCapabilities() {
        if (!els.list) return;
        els.list.textContent = '';
        const liveNames = mcpToolOptions().map((item) => item.value);
        for (const cap of EXTERNAL_CAPABILITIES) {
            const mode = config.capabilities[cap.key].mode;
            const options = [];
            if (cap.builtin) options.push({value: 'builtin', label: EXTERNAL_MODE_LABELS.builtin});
            options.push({value: 'provider', label: EXTERNAL_MODE_LABELS.provider});
            options.push({value: 'mcp', label: EXTERNAL_MODE_LABELS.mcp});
            options.push({value: 'off', label: EXTERNAL_MODE_LABELS.off});
            const modeSelect = createSelect({
                className: 'opt-select',
                options: options.map((item) => Object.assign({selected: item.value === mode}, item)),
                onChange: (event) => {
                    const caps = Object.assign({}, config.capabilities, {[cap.key]: {mode: event.target.value}});
                    void save({capabilities: caps});
                },
            });
            const controls = [modeSelect.element];
            if (mode === 'mcp') {
                const live = mcpToolOptions();
                if (!live.length) live.push({value: '', label: '（未检测到已启用的 MCP 工具）'});
                const binding = config.mcpBindings[cap.key] || '';
                const bindingSelect = createSelect({
                    className: 'opt-select',
                    options: live.map((item) => Object.assign({selected: item.value === binding}, item)),
                    onChange: (event) => {
                        const bindings = Object.assign({}, config.mcpBindings, {[cap.key]: event.target.value});
                        void save({mcpBindings: bindings});
                    },
                });
                controls.push(bindingSelect.element);
            }
            const card = document.createElement('div');
            card.className = 'set-card';
            card.appendChild(fieldRow(cap.label, capabilityHint(cap, mode, liveNames), ...controls));
            els.list.appendChild(card);
        }
    }

    function paintProvider() {
        if (!els.provider) return;
        els.provider.textContent = '';
        const switchCtl = createSwitch({
            checked: config.enabled,
            onChange: (event) => { void save({enabled: event.target.checked}); },
        });
        const keyInput = createInput({
            type: 'password',
            className: 'dlg-input',
            placeholder: config.apiKeySet ? '已保存；留空保持不变' : 'sk-...（只保存在本机）',
            autocomplete: 'new-password',
            onChange: (event) => {
                const value = event.target.value.trim();
                if (!value) return; // 留空 = 保持原值；清空走右侧按钮
                void save({apiKey: value}).then(() => { event.target.value = ''; });
            },
        });
        const keyControls = [keyInput.element];
        if (config.apiKeySet) {
            keyControls.push(button('清除 Key', 'dlg-btn', async () => {
                try {
                    await backend.WebToolsConfigClearKey();
                    await load();
                    paint();
                    const panel = getAiPanel();
                    if (panel && typeof panel.refreshExternalTools === 'function') {
                        Promise.resolve(panel.refreshExternalTools()).catch(() => {});
                    }
                } catch (e) {
                    flash('清除 API Key 失败：' + ((e && e.message) || e), true);
                }
            }));
        }
        const baseInput = createInput({
            className: 'dlg-input',
            value: config.baseUrl,
            placeholder: DEFAULT_PROVIDER_BASE_URL,
            spellcheck: false,
            onChange: (event) => { void save({baseUrl: event.target.value.trim()}); },
        });
        const countInput = createInput({
            type: 'number',
            className: 'ai-settings-input ai-font-size-num',
            value: config.searchCount,
            min: 1,
            max: 50,
            step: 1,
            onChange: (event) => {
                const n = Math.max(1, Math.min(50, Math.round(Number(event.target.value) || 10)));
                event.target.value = String(n);
                void save({searchCount: n});
            },
        });
        const links = document.createElement('div');
        links.className = 'set-control';
        links.append(
            button('API 文档', 'dlg-btn', () => openExternalUrl('https://api-docs.deepseek.com/zh-cn/api/search')),
            button('价格', 'dlg-btn', () => openExternalUrl('https://api-docs.deepseek.com/zh-cn/quick_start/pricing')),
            button('获取 Key', 'dlg-btn', () => openExternalUrl('https://platform.deepseek.com')),
        );
        els.provider.append(
            fieldRow('启用服务提供商', '各能力选择「服务提供商」时必须启用并配置 API Key；搜索/抓取选「内置」时不受影响。', switchCtl.element),
            fieldRow('API Key', '只保存在本机应用数据目录（0600）；不会回显明文，也不会写入日志。', ...keyControls),
            fieldRow('基础地址', '留空 = ' + DEFAULT_PROVIDER_BASE_URL + '（程序自动追加 /search、/fetch、/ocr、/tts、/asr）。', baseInput.element),
            fieldRow('每次搜索结果数', '1–50；实际返回还受工具单次上限 10 约束。', countInput.element),
            fieldRow('外部链接', '接口、计费与申请 Key 的官方页面。', links),
        );
    }

    function paint() {
        if (els.list) els.list.textContent = '';
        if (els.provider) els.provider.textContent = '';
        if (errorText) {
            if (els.list) {
                const hint = document.createElement('div');
                hint.className = 'fmt-hint hint-indent';
                hint.textContent = errorText;
                els.list.appendChild(hint);
            }
            return;
        }
        paintCapabilities();
        paintProvider();
        // 动态创建的行式下拉需要设置页增强器接管（与其它动态 pane 一致）
        if (typeof enhanceSetSelects === 'function') enhanceSetSelects();
    }

    async function renderExternalToolsPane() {
        await load();
        paint();
    }

    return {renderExternalToolsPane};
}
