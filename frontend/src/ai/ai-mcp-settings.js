// ai-mcp-settings.js：MCP 服务器设置页——总开关、服务器列表/状态灯、行内编辑器、
// 工具勾选面板（token 估算 / 只读批量勾选 / stale 对账标黄）、探测与重启。
// 绑定 index.html 的 ai-opt-mcp-* 元素；配置读写走 Go（MCPGetConfig / MCPWriteConfig），
// 状态来自 mcpMod.getState()（Go 事件整代快照，本模块不自行维护连接态）。
// readOnlyHint 是服务器自填的 hint，绝不作为安全判断——批量勾选只是省点击，授权动作是用户点按钮本身。
import {aiEstimateTokens} from './ai-constants.js';

const MCP_SERVER_NAME_RULE = /^[A-Za-z0-9_-]{1,32}$/;
const MCP_TIMEOUT_MAX_MS = 600000;

// ---- 可测纯辅助函数 ----

// mcpMergeEnvRows：env 编辑行 → 配置 map。value 留空 + key 已存在 = 保持原值（密码框不回显，
// 不能把留空当成「删值」）；key 空行跳过；其余覆盖。
export function mcpMergeEnvRows(existing, rows) {
    const out = {};
    const seen = new Set();
    for (const row of rows || []) {
        const key = String(row.key || '').trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const value = String(row.value || '');
        out[key] = value === '' && Object.prototype.hasOwnProperty.call(existing || {}, key)
            ? existing[key]
            : value;
    }
    return out;
}

// mcpToolFlags：annotations 只作展示角标与留痕，绝不作为审批/安全判断。
// destructive 缺省 = true（悲观默认）。
export function mcpToolFlags(annotations) {
    const a = annotations && typeof annotations === 'object' ? annotations : {};
    return {
        readOnly: a.readOnlyHint === true,
        destructive: a.destructiveHint !== false,
        openWorld: a.openWorldHint === true,
    };
}

// mcpValidateServerForm：写入前表单校验（与 Go 写入期校验同规则，用户当场看到错在哪）。
export function mcpValidateServerForm(form) {
    const name = String(form.name || '').trim();
    if (!MCP_SERVER_NAME_RULE.test(name)) {
        return '服务器名只能用字母数字下划线连字符，最长 32';
    }
    if (!String(form.command || '').trim()) {
        return '缺少启动命令';
    }
    if ((form.args || []).length > 128) {
        return '参数个数超过上限 128';
    }
    for (const [label, value] of [['启动超时', form.startupTimeoutMs], ['调用超时', form.callTimeoutMs], ['关闭超时', form.closeTimeoutMs]]) {
        if (value < 0 || value > MCP_TIMEOUT_MAX_MS) {
            return label + '必须在 0 或 1–' + (MCP_TIMEOUT_MAX_MS / 1000) + ' 秒之间';
        }
    }
    return '';
}

// mcpStatusMeta：六态 → 状态灯颜色与文案（§9.1）。
export function mcpStatusMeta(state, reason) {
    switch (state) {
        case 'connected': return {cls: 'ok', text: '已连接'};
        case 'connecting': return {cls: 'warn', text: '连接中'};
        case 'reconnecting': return {cls: 'warn', text: '重连中'};
        case 'failed': return {cls: 'err', text: reason === 'unclosed-generation' ? '关闭未确认（需重启应用）' : '已放弃'};
        default: return {cls: 'idle', text: '未连接'};
    }
}

// ---- 设置面板工厂 ----

export function createAIMcpSettings(ctx) {
    const backend = (ctx && ctx.backend) || {};
    const getMcpState = (ctx && ctx.getMcpState) || (() => ({enabled: false, servers: []}));
    const flash = (ctx && ctx.flash) || (() => {});
    const confirmAction = (ctx && ctx.confirmAction) || ((message, action) => { if (window.confirm(message)) action(); });
    const onChanged = (ctx && ctx.onChanged) || (() => {});

    let config = null;      // MCPConfig（Go 读写）
    let editingName = null; // null = 未在编辑；'' = 新建；其他 = 编辑该 server
    let toolsPanel = null;  // {name, tools, checked:Set}
    let openDiagName = null;

    const el = {
        enabled: document.getElementById('ai-opt-mcp-enabled'),
        add: document.getElementById('ai-opt-mcp-add'),
        list: document.getElementById('ai-opt-mcp-list'),
        editor: document.getElementById('ai-opt-mcp-editor'),
    };

    function bind() {
        if (el.enabled) {
            el.enabled.addEventListener('change', async () => {
                if (!config) return;
                await writeConfig(Object.assign({}, config, {enabled: el.enabled.checked}));
            });
        }
        if (el.add) {
            el.add.addEventListener('click', () => {
                editingName = '';
                renderEditor({});
            });
        }
    }

    async function loadConfig() {
        if (typeof backend.MCPGetConfig !== 'function') {
            config = {version: 1, enabled: true, mcpServers: {}};
            return;
        }
        try {
            const cfg = await backend.MCPGetConfig();
            config = cfg && typeof cfg === 'object' ? cfg : {version: 1, enabled: true, mcpServers: {}};
            if (!config.mcpServers) config.mcpServers = {};
        } catch (e) {
            config = null;
            renderList();
            if (el.editor) el.editor.innerHTML = '<div class="fmt-hint hint-indent">配置文件读取失败：' + escapeHtml(String((e && e.message) || e)) + '</div>';
            throw e; // 调用方（refreshSettings）已有 flash 渠道
        }
    }

    async function writeConfig(next) {
        if (!next.mcpServers) next.mcpServers = {};
        next.version = 1;
        try {
            await backend.MCPWriteConfig(next);
            config = next;
            editingName = null;
            toolsPanel = null;
            onChanged();
            renderAll();
        } catch (e) {
            flash('MCP 配置保存失败：' + String((e && e.message) || e), true);
        }
    }

    function statusOf(name) {
        const st = getMcpState();
        const server = (st.servers || []).find((s) => s.name === name);
        return server || {name, state: 'closed', tools: [], staleTools: [], toolCount: 0};
    }

    function renderAll() {
        renderSwitch();
        renderList();
        renderEditorVisible();
        renderToolsPanel();
    }

    function renderSwitch() {
        if (el.enabled && config) el.enabled.checked = config.enabled !== false;
    }

    function renderList() {
        if (!el.list) return;
        if (!config) {
            el.list.innerHTML = '';
            return;
        }
        const names = Object.keys(config.mcpServers);
        if (!names.length) {
            el.list.innerHTML = '<div class="fmt-hint hint-indent">尚未配置服务器。npx / uvx 型命令首次启动可能需要下载依赖，稍慢属正常。</div>';
            return;
        }
        const st = getMcpState();
        const frag = document.createElement('div');
        for (const name of names) {
            const cfg = config.mcpServers[name];
            const meta = mcpStatusMeta(statusOf(name).state, statusOf(name).reason);
            const live = st.servers.find((s) => s.name === name);
            const toolCount = live ? (live.toolCount || 0) : 0;
            const enabledOn = cfg.enabled !== false;
            const row = document.createElement('div');
            row.className = 'ai-mcp-server-row';
            row.innerHTML =
                '<span class="ai-mcp-lamp ai-mcp-lamp-' + meta.cls + '" title="' + escapeHtml(meta.text) + '"></span>' +
                '<span class="ai-mcp-server-name">' + escapeHtml(name) + '</span>' +
                '<span class="ai-mcp-server-tools">' + toolCount + '/' + (cfg.enabledTools || []).length + ' 工具</span>' +
                '<label class="ai-mcp-inline-label"><input type="checkbox" data-mcp-toggle="' + escapeHtml(name) + '"' + (enabledOn ? ' checked' : '') + '>启用</label>' +
                '<button type="button" class="dlg-btn" data-mcp-tools="' + escapeHtml(name) + '">工具</button>' +
                '<button type="button" class="dlg-btn" data-mcp-edit="' + escapeHtml(name) + '">编辑</button>' +
                '<button type="button" class="dlg-btn" data-mcp-remove="' + escapeHtml(name) + '">删除</button>';
            frag.appendChild(row);
            // 诊断行：状态灯点击展开（重连细节 / 最近 stderr 由 Go 侧日志承载，这里给状态与原因）
            if (openDiagName === name) {
                const diag = document.createElement('div');
                diag.className = 'ai-mcp-diag';
                const s = statusOf(name);
                const lastErr = s.lastError ? escapeHtml(s.lastError) : '（无）';
                const retry = s.nextRetryAt && s.state === 'reconnecting'
                    ? '，下次重试 ' + new Date(s.nextRetryAt).toLocaleTimeString()
                    : '';
                const attempt = s.state === 'reconnecting' ? '（第 ' + s.attempt + '/' + s.maxAttempt + ' 次）' : '';
                diag.innerHTML = '<div class="fmt-hint hint-indent">状态：' + escapeHtml(meta.text) + attempt + retry +
                    '；最近错误：' + lastErr + '</div>' +
                    '<button type="button" class="dlg-btn" data-mcp-probe="' + escapeHtml(name) + '">测试连接</button> ' +
                    '<button type="button" class="dlg-btn" data-mcp-restart="' + escapeHtml(name) + '">重启</button>' +
                    '<span class="ai-mcp-probe-result" data-mcp-probe-result="' + escapeHtml(name) + '"></span>';
                frag.appendChild(diag);
            }
        }
        el.list.innerHTML = '';
        el.list.appendChild(frag);
    }

    function renderEditorVisible() {
        if (!el.editor) return;
        if (editingName === null) {
            el.editor.classList.add('hidden');
            el.editor.innerHTML = '';
        }
    }

    function renderEditor(cfg) {
        if (!el.editor) return;
        el.editor.classList.remove('hidden');
        const args = (cfg.args || []).join('\n');
        const envRows = Object.keys(cfg.env || {}).map((key) => ({key, value: ''}));
        el.editor.innerHTML =
            '<div class="ai-mcp-editor">' +
            '<div class="set-row"><div class="set-main"><div class="set-title">名称</div><div class="set-desc">字母数字下划线连字符，最长 32；也用作工具前缀 mcp__名称__</div></div>' +
            '<div class="set-control"><input type="text" class="ai-settings-input" id="ai-mcp-f-name" maxlength="32" value="' + escapeHtml(editingName || '') + '"></div></div>' +
            '<div class="set-row"><div class="set-main"><div class="set-title">启动命令</div><div class="set-desc">例如 npx、可执行文件路径；将在本机执行</div></div>' +
            '<div class="set-control"><input type="text" class="ai-settings-input" id="ai-mcp-f-cmd" value="' + escapeHtml(cfg.command || '') + '"></div></div>' +
            '<div class="set-row"><div class="set-main"><div class="set-title">参数（每行一个）</div></div>' +
            '<div class="set-control"><textarea class="ai-settings-input ai-settings-textarea" id="ai-mcp-f-args" rows="3" spellcheck="false">' + escapeHtml(args) + '</textarea></div></div>' +
            '<div class="set-row"><div class="set-main"><div class="set-title">工作目录</div><div class="set-desc">留空 = 继承应用目录</div></div>' +
            '<div class="set-control"><input type="text" class="ai-settings-input" id="ai-mcp-f-cwd" value="' + escapeHtml(cfg.cwd || '') + '"></div></div>' +
            '<div class="set-row"><div class="set-main"><div class="set-title">环境变量</div><div class="set-desc">值留空 = 保持原值；已存的值不回显</div></div>' +
            '<div class="set-control"><div id="ai-mcp-f-env"></div><button type="button" class="dlg-btn" id="ai-mcp-f-env-add">加一条</button></div></div>' +
            '<div class="set-row"><div class="set-main"><div class="set-title">启动 / 调用 / 关闭超时（秒）</div></div>' +
            '<div class="set-control">' +
            '<input type="number" class="ai-settings-input ai-font-size-num" id="ai-mcp-f-t1" min="1" max="600" value="' + Math.round((cfg.startupTimeoutMs || 30000) / 1000) + '"> ' +
            '<input type="number" class="ai-settings-input ai-font-size-num" id="ai-mcp-f-t2" min="1" max="600" value="' + Math.round((cfg.callTimeoutMs || 60000) / 1000) + '"> ' +
            '<input type="number" class="ai-settings-input ai-font-size-num" id="ai-mcp-f-t3" min="1" max="600" value="' + Math.round((cfg.closeTimeoutMs || 5000) / 1000) + '">' +
            '</div></div>' +
            '<div class="ai-mcp-editor-actions"><button type="button" class="dlg-btn" id="ai-mcp-f-save">保存</button> ' +
            '<button type="button" class="dlg-btn" id="ai-mcp-f-cancel">取消</button></div>' +
            '</div>';
        renderEnvRows(envRows);
        el.editor.querySelector('#ai-mcp-f-env-add').addEventListener('click', () => {
            renderEnvRows(collectEnvRows().concat([{key: '', value: ''}]));
        });
        el.editor.querySelector('#ai-mcp-f-cancel').addEventListener('click', () => {
            editingName = null;
            el.editor.classList.add('hidden');
            el.editor.innerHTML = '';
        });
        el.editor.querySelector('#ai-mcp-f-save').addEventListener('click', () => {
            void saveEditor();
        });
    }

    function renderEnvRows(rows) {
        const box = el.editor.querySelector('#ai-mcp-f-env');
        if (!box) return;
        box.innerHTML = '';
        for (const row of rows) {
            const line = document.createElement('div');
            line.className = 'ai-mcp-env-row';
            line.innerHTML =
                '<input type="text" class="ai-settings-input ai-mcp-env-key" placeholder="变量名" value="' + escapeHtml(row.key || '') + '" spellcheck="false">' +
                '<input type="password" class="ai-settings-input ai-mcp-env-val" placeholder="值（留空 = 保持原值）" autocomplete="new-password">';
            line.querySelector('.ai-mcp-env-key').dataset.initialKey = row.key || '';
            line.querySelector('.ai-mcp-env-val').value = '';
            box.appendChild(line);
        }
    }

    function collectEnvRows() {
        const box = el.editor.querySelector('#ai-mcp-f-env');
        if (!box) return [];
        return [...box.querySelectorAll('.ai-mcp-env-row')].map((line) => ({
            key: line.querySelector('.ai-mcp-env-key').value,
            initialKey: line.dataset.initialKey || '',
            value: line.querySelector('.ai-mcp-env-val').value,
        }));
    }

    async function saveEditor() {
        const name = el.editor.querySelector('#ai-mcp-f-name').value.trim();
        const command = el.editor.querySelector('#ai-mcp-f-cmd').value.trim();
        const args = el.editor.querySelector('#ai-mcp-f-args').value.split('\n').map((s) => s.trim()).filter(Boolean);
        const cwd = el.editor.querySelector('#ai-mcp-f-cwd').value.trim();
        const t1 = Math.max(0, Math.round(Number(el.editor.querySelector('#ai-mcp-f-t1').value) || 0)) * 1000;
        const t2 = Math.max(0, Math.round(Number(el.editor.querySelector('#ai-mcp-f-t2').value) || 0)) * 1000;
        const t3 = Math.max(0, Math.round(Number(el.editor.querySelector('#ai-mcp-f-t3').value) || 0)) * 1000;
        const envRows = collectEnvRows();
        // 键改名：先删旧键再落新键
        const existing = Object.assign({}, (editingName && config.mcpServers[editingName]) || {}).env || {};
        const oldRows = collectInitialRows();
        const removed = oldRows.filter((r) => r.initialKey && !envRows.some((n) => n.initialKey === r.initialKey && n.key === r.initialKey));
        const env = mcpMergeEnvRows(existing, envRows.filter((r) => r.key));
        for (const row of removed) delete env[row.initialKey];
        // 键名变化（改了名）：旧键删除
        for (const row of envRows) {
            if (row.initialKey && row.key && row.initialKey !== row.key) delete env[row.initialKey];
        }

        const form = {name, command, args, startupTimeoutMs: t1, callTimeoutMs: t2, closeTimeoutMs: t3};
        const error = mcpValidateServerForm(form);
        if (error) {
            flash(error, true);
            return;
        }
        if (editingName !== '' && name !== editingName && config.mcpServers[name]) {
            flash('服务器名 ' + name + ' 已存在', true);
            return;
        }
        const isNew = editingName === '';
        const proceed = () => {
            const next = Object.assign({}, config);
            next.mcpServers = Object.assign({}, config.mcpServers);
            if (!isNew && editingName && editingName !== name) delete next.mcpServers[editingName];
            next.mcpServers[name] = Object.assign({
                enabledTools: (editingName && !isNew && config.mcpServers[editingName] && config.mcpServers[editingName].enabledTools) || [],
            }, form, {env});
            void writeConfig(next).then(() => {
                // §15.1 两步走：保存成功 → 异步拉工具清单 → 打开勾选面板（默认全不勾）
                openToolsPanel(name);
            });
        };
        if (isNew) {
            confirmAction('该命令会在本机执行，等同于你自己运行它：\n' + command + (args.length ? ' ' + args.join(' ') : '') + '\n确认添加？', proceed);
        } else {
            proceed();
        }
    }

    function collectInitialRows() {
        return collectEnvRows().map((row) => ({initialKey: row.initialKey}));
    }

    // ---- 工具勾选面板 ----

    async function openToolsPanel(name) {
        if (typeof backend.MCPListServerTools !== 'function') return;
        let tools;
        try {
            tools = await backend.MCPListServerTools(name);
        } catch (e) {
            flash('拉取工具清单失败：' + String((e && e.message) || e), true);
            return;
        }
        const cfg = config.mcpServers[name] || {};
        toolsPanel = {
            name,
            tools: tools || [],
            checked: new Set(cfg.enabledTools || []),
        };
        renderToolsPanel();
    }

    function renderToolsPanel() {
        const host = el.list && el.list.parentElement;
        if (!host) return;
        let panel = host.querySelector('#ai-opt-mcp-tools');
        if (!toolsPanel) {
            if (panel) panel.remove();
            return;
        }
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'ai-opt-mcp-tools';
            host.appendChild(panel);
        }
        const st = getMcpState().servers.find((s) => s.name === toolsPanel.name);
        const stale = new Set((st && st.staleTools) || []);
        const rows = toolsPanel.tools.map((tool) => {
            const flags = mcpToolFlags(tool.annotations);
            const badges = [];
            if (flags.destructive) badges.push('<span class="ai-mcp-badge ai-mcp-badge-warn" title="destructiveHint（服务器自填，不可作为安全保证）">写</span>');
            if (flags.openWorld) badges.push('<span class="ai-mcp-badge ai-mcp-badge-warn" title="openWorldHint：工具会接触外部实体">外</span>');
            const tokens = aiEstimateTokens(JSON.stringify({d: tool.description, s: tool.inputSchema}));
            const isStale = stale.has(tool.name);
            return '<label class="ai-mcp-tool-row' + (isStale ? ' ai-mcp-stale' : '') + '">' +
                '<input type="checkbox" data-mcp-tool="' + escapeHtml(tool.name) + '"' + (toolsPanel.checked.has(tool.name) ? ' checked' : '') + '> ' +
                '<span class="ai-mcp-tool-name">' + escapeHtml(tool.name) + badges.join('') + (isStale ? ' <span class="ai-mcp-badge ai-mcp-badge-stale" title="该工具已不在服务器清单中，保存时将被移除">已失效</span>' : '') + '</span>' +
                '<span class="ai-mcp-tool-desc">' + escapeHtml(String(tool.description || '').slice(0, 120)) + '</span>' +
                '<span class="ai-mcp-tool-tokens">≈' + tokens + ' tok</span></label>';
        }).join('');
        panel.innerHTML =
            '<div class="ai-mcp-tools-head"><b>' + escapeHtml(toolsPanel.name) + ' 的工具</b>' +
            '<button type="button" class="dlg-btn" id="ai-mcp-tools-ro">勾选只读声明</button> ' +
            '<button type="button" class="dlg-btn" id="ai-mcp-tools-all">全选</button> ' +
            '<button type="button" class="dlg-btn" id="ai-mcp-tools-save">保存勾选</button> ' +
            '<button type="button" class="dlg-btn" id="ai-mcp-tools-close">关闭</button></div>' +
            '<div class="fmt-hint hint-indent">「只读」等角标是服务器自行填写的声明，不可作为安全保证；勾选 = 授权 AI 调用该工具。</div>' +
            '<div class="ai-mcp-tools-list">' + rows + '</div>';
        panel.querySelector('#ai-mcp-tools-ro').addEventListener('click', () => {
            for (const tool of toolsPanel.tools) {
                if (tool.annotations && tool.annotations.readOnlyHint === true) toolsPanel.checked.add(tool.name);
            }
            syncCheckboxes();
        });
        panel.querySelector('#ai-mcp-tools-all').addEventListener('click', () => {
            toolsPanel.checked = new Set(toolsPanel.tools.map((tool) => tool.name));
            syncCheckboxes();
        });
        panel.querySelector('#ai-mcp-tools-close').addEventListener('click', () => {
            toolsPanel = null;
            renderToolsPanel();
        });
        panel.querySelector('#ai-mcp-tools-save').addEventListener('click', () => {
            // stale 的工具不再保存：server 已不存在该工具，勾了也拿不到
            const live = new Set(toolsPanel.tools.map((tool) => tool.name));
            const checked = [...toolsPanel.checked].filter((toolName) => live.has(toolName));
            const next = Object.assign({}, config);
            next.mcpServers = Object.assign({}, config.mcpServers);
            next.mcpServers[toolsPanel.name] = Object.assign({}, next.mcpServers[toolsPanel.name], {enabledTools: checked});
            void writeConfig(next);
        });
        syncCheckboxes();
        // 勾选联动
        panel.addEventListener('change', (e) => {
            const box = e.target.closest('input[data-mcp-tool]');
            if (!box) return;
            if (box.checked) toolsPanel.checked.add(box.dataset.mcpTool);
            else toolsPanel.checked.delete(box.dataset.mcpTool);
        });
    }

    function syncCheckboxes() {
        const panel = el.list && el.list.parentElement.querySelector('#ai-opt-mcp-tools');
        if (!panel) return;
        for (const box of panel.querySelectorAll('input[data-mcp-tool]')) {
            box.checked = toolsPanel.checked.has(box.dataset.mcpTool);
        }
    }

    // ---- 列表交互（事件委托） ----

    function bindList() {
        if (!el.list) return;
        el.list.addEventListener('change', async (e) => {
            const toggle = e.target.closest('input[data-mcp-toggle]');
            if (!toggle) return;
            if (typeof backend.MCPSetServerEnabled !== 'function') return;
            try {
                await backend.MCPSetServerEnabled(toggle.dataset.mcpToggle, toggle.checked);
                onChanged();
            } catch (err) {
                flash('切换失败：' + String((err && err.message) || err), true);
                toggle.checked = !toggle.checked;
            }
        });
        el.list.addEventListener('click', (e) => {
            const lamp = e.target.closest('.ai-mcp-lamp');
            if (lamp) {
                const row = lamp.closest('.ai-mcp-server-row');
                const name = row && row.querySelector('.ai-mcp-server-name');
                if (name) {
                    openDiagName = openDiagName === name.textContent ? null : name.textContent;
                    renderList();
                }
                return;
            }
            const probe = e.target.closest('button[data-mcp-probe]');
            if (probe) return void runProbe(probe.dataset.mcpProbe, probe);
            const restart = e.target.closest('button[data-mcp-restart]');
            if (restart) {
                if (typeof backend.MCPRestartServer !== 'function') return;
                backend.MCPRestartServer(restart.dataset.mcpRestart).catch((err) => flash('重启失败：' + String((err && err.message) || err), true));
                return;
            }
            const toolsBtn = e.target.closest('button[data-mcp-tools]');
            if (toolsBtn) return void openToolsPanel(toolsBtn.dataset.mcpTools);
            const editBtn = e.target.closest('button[data-mcp-edit]');
            if (editBtn) {
                editingName = editBtn.dataset.mcpEdit;
                renderEditor(config.mcpServers[editingName] || {});
                return;
            }
            const removeBtn = e.target.closest('button[data-mcp-remove]');
            if (removeBtn) {
                const name = removeBtn.dataset.mcpRemove;
                confirmAction('删除服务器 ' + name + '？（配置将立即写盘，其进程停止）', () => {
                    const next = Object.assign({}, config);
                    next.mcpServers = Object.assign({}, config.mcpServers);
                    delete next.mcpServers[name];
                    void writeConfig(next);
                });
            }
        });
    }

    async function runProbe(name, button) {
        const resultHost = el.list.querySelector('[data-mcp-probe-result="' + CSS.escape(name) + '"]');
        if (!resultHost || typeof backend.MCPProbeServer !== 'function') return;
        button.disabled = true;
        resultHost.textContent = '探测中…';
        try {
            const res = await backend.MCPProbeServer(name, config.mcpServers[name] || {command: ''});
            if (res.error) {
                resultHost.textContent = '失败（' + res.stage + '）：' + res.error + '；耗时 ' + res.durationMs + 'ms';
            } else {
                resultHost.textContent = '成功：' + res.toolCount + ' 个工具，耗时 ' + res.durationMs + 'ms' + (res.cleanupError ? '；' + res.cleanupError : '');
            }
        } catch (e) {
            resultHost.textContent = '探测失败：' + String((e && e.message) || e);
        }
        button.disabled = false;
    }

    function render() {
        void loadConfig().then(() => {
            renderAll();
        }).catch(() => {}); // loadConfig 失败已在面板内展示错误，这里不再重复 flash
    }

    function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
    }

    bind();
    bindList();

    return {
        render,          // 设置页打开 / 配置变化时刷新（ai-panel refreshSettings 调）
        renderAll,       // Go 状态事件到达时轻量刷新状态灯
    };
}
