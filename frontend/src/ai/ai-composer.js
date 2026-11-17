// ai-composer.js：AI 面板输入区与附件域（附件条 / 图片准备 / 引用与技能附加 / 输入框交互 / 排队草稿捕获）。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移。
// attachments 与 queueSeq 为本域私有 let（attachments 经 getAttachments/setAttachments 供面板与消息队列访问）；
// attachSeq 留在面板（executeTool /clear 会重置），经 nextAttachSeq() 取号。
import {aiTextOf, aiImageSrc, AI_IMAGE_LIMIT, AI_IMAGE_MAX_BASE64, AI_IMAGE_MAX_DIM, AI_IMAGE_MAX_INPUT_BYTES, AI_IMAGE_MESSAGE_BUDGET,
    AI_VIDEO_LIMIT, AI_VIDEO_MAX_INPUT_BYTES, AI_VIDEO_MAX_BASE64, AI_VIDEO_MIMES, aiVideoFromSrc, bufferToBase64, isReadableVideoPath} from './ai-constants.js';
import {prepareImagePayload} from './ai-image-encode.js';
import {AI_QUOTE_KIND, quoteChipLabel, quoteExcerpt} from './ai-quote.js';

export function createAIComposer(ctx) {
    const el = ctx.el;
    const backend = ctx.backend || {};
    const compactOf = ctx.compactOf;
    const currentSession = ctx.currentSession;
    const flash = ctx.flash;
    const getSelection = ctx.getSelection;
    const getWorkspaceContext = ctx.getWorkspaceContext;
    const listSkills = ctx.listSkills;
    const pickFiles = ctx.pickFiles;
    const readTextFile = ctx.readTextFile;
    const settings = ctx.settings;
    const showContextMenu = ctx.showContextMenu;
    const showImagePreview = ctx.showImagePreview;
    const showNote = ctx.showNote;
    const syncStreamView = ctx.syncStreamView;
    const updateContextCount = ctx.updateContextCount;
    const updateSendState = ctx.updateSendState;
    const updateSlash = ctx.updateSlash;
    const hideSlash = ctx.hideSlash;
    const runSlashCommand = ctx.runSlashCommand;
    const handleSlashText = ctx.handleSlashText;
    const enqueueComposerMessage = ctx.enqueueComposerMessage;
    const interjectComposerMessage = ctx.interjectComposerMessage;
    const renderMessageQueue = ctx.renderMessageQueue;
    const entryOf = ctx.entryOf;
    const sessionImageBytes = ctx.sessionImageBytes;
    const readVideoFile = ctx.readVideoFile;
    // 排队消息的读写经队列模块 API（所有权在 ai-message-queue.js，阶段 A 迁移）
    const queue = ctx.queue;
    const slashState = ctx.slashState;
    const submitText = ctx.submitText;
    const nextAttachSeq = ctx.nextAttachSeq;

    // —— 随域迁入的输入区状态（原 ai-panel.js 闭包级）——
    let attachments = [];
    let queueSeq = 0;

    function renderAttachments() {
        if (!el.attach) return;
        el.attach.innerHTML = '';
        el.attach.classList.toggle('hidden', !attachments.length);
        for (const item of attachments) {
            const chip = document.createElement('span');
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'ai-chip-remove';
            remove.textContent = '×';
            remove.addEventListener('click', () => {
                attachments = attachments.filter((current) => current.id !== item.id);
                renderAttachments();
                updateContextCount();
            });
            if (item.kind === 'image') {
                chip.className = 'ai-chip ai-chip-image';
                const img = document.createElement('img');
                img.className = 'ai-chip-img';
                img.src = aiImageSrc(item);
                img.alt = item.name || '图片';
                img.draggable = false;
                img.addEventListener('click', () => showImagePreview(item));
                chip.append(img, remove);
            } else {
                chip.className = 'ai-chip';
                const label = document.createElement('span');
                label.className = 'ai-chip-label';
                let prefix = '文件 · ';
                if (item.kind === 'skill') prefix = '技能 · ';
                else if (item.kind === 'selection') prefix = '选中 · ';
                else if (item.kind === 'reference') prefix = '引用 · ';
                else if (item.kind === 'selection_reference') prefix = '引用选区 · ';
                else if (item.kind === AI_QUOTE_KIND) prefix = '回复引用 · ';
                else if (item.kind === 'video') prefix = '视频 · ';
                label.textContent = prefix + item.label;
                chip.append(label, remove);
            }
            el.attach.appendChild(chip);
        }
        updateContextCount();
        updateSendState();
    }

    function addAttachment(item) {
        if (!item) return false;
        if (item.kind === 'image') {
            // 模型条目未勾选图像输入时拒绝附加（粘贴 / 拖拽 / 文件对话框统一走这里）
            const entry = entryOf(currentSession());
            if (entry && entry.modalities && entry.modalities.image === false) {
                flash('当前模型（' + (entry.model || '未命名') + '）未勾选图像输入，可在模型设置中开启', true);
                return false;
            }
            if (!item.data) return false;
            if (attachments.filter((current) => current.kind === 'image').length >= AI_IMAGE_LIMIT) {
                flash('每条消息最多附加 ' + AI_IMAGE_LIMIT + ' 张图片', true);
                return false;
            }
            const currentBytes = attachments
                .filter((current) => current.kind === 'image')
                .reduce((sum, current) => sum + sessionImageBytes([current]), 0);
            if (currentBytes + item.data.length > AI_IMAGE_MESSAGE_BUDGET) {
                flash('图片总量超过上限，请减少图片或先发送当前消息', true);
                return false;
            }
            item.id = 'att-' + (nextAttachSeq());
            attachments.push(item);
            renderAttachments();
            el.input && el.input.focus();
            return true;
        }
        if (item.kind === 'video') {
            // 模型条目未勾选视频输入时拒绝附加（粘贴 / 文件对话框统一走这里）
            const entry = entryOf(currentSession());
            if (entry && entry.modalities && entry.modalities.video === false) {
                flash('当前模型（' + (entry.model || '未命名') + '）未勾选视频输入，可在模型设置中开启', true);
                return false;
            }
            if (!item.data) return false;
            if (attachments.some((current) => current.kind === 'video')) {
                flash('每条消息最多附加 ' + AI_VIDEO_LIMIT + ' 个视频', true);
                return false;
            }
            item.id = 'att-' + (nextAttachSeq());
            attachments.push(item);
            renderAttachments();
            el.input && el.input.focus();
            return true;
        }
        const isReference = item.kind === 'reference' || item.kind === 'selection_reference';
        if (isReference) {
            if (!item.path) return false;
            const duplicate = attachments.some((current) => {
                if (current.kind !== item.kind || current.path !== item.path) return false;
                if (item.kind !== 'selection_reference') return true;
                const a = item.start || {};
                const b = item.end || {};
                const x = current.start || {};
                const y = current.end || {};
                return a.line === x.line && a.column === x.column && b.line === y.line && b.column === y.column;
            });
            if (duplicate) {
                flash('该引用已在输入区');
                return false;
            }
            item.id = 'att-' + (nextAttachSeq());
            attachments.push(item);
            renderAttachments();
            el.input && el.input.focus();
            return true;
        }
        if (!item.content) return false;
        if (item.content.length > 64 << 10) {
            item.content = item.content.slice(0, 64 << 10) + '\n…（已截断到 64KB）';
        }
        const total = attachments.reduce((sum, current) => sum + aiTextOf(current.content).length, 0);
        if (total + item.content.length > 256 << 10) {
            flash('附加内容总量超过 256KB，请减少文件或选区', true);
            return false;
        }
        const duplicate = attachments.some((current) => {
            if (item.kind === 'skill' && current.kind === 'skill') {
                return current.label === item.label;
            }
            if (item.kind === 'selection' && current.kind === 'selection') {
                return current.content === item.content;
            }
            if (item.kind === 'file' && current.kind === 'file') {
                return !!item.path && current.path === item.path;
            }
            if (item.kind === AI_QUOTE_KIND && current.kind === AI_QUOTE_KIND) {
                return current.source === item.source && current.index === item.index &&
                    current.scope === item.scope && current.content === item.content;
            }
            return false;
        });
        if (duplicate) {
            flash('该内容已经附加');
            return false;
        }
        item.id = 'att-' + (nextAttachSeq());
        attachments.push(item);
        renderAttachments();
        el.input && el.input.focus();
        return true;
    }

    // 降采样 / 压缩链在 ai-image-encode.js（与 read_image 工具共用单一实现），这里只补
    // 「输入框口径」：体积上限、尺寸上限与默认名。
    function prepareImageAttachment(file) {
        return prepareImagePayload(file, {
            maxInputBytes: AI_IMAGE_MAX_INPUT_BYTES,
            maxDim: AI_IMAGE_MAX_DIM,
            maxBase64: AI_IMAGE_MAX_BASE64,
            name: (file && file.name && file.name !== 'image.png') ? file.name : '粘贴的图片',
        });
    }

    // 视频：不降质不截帧（浏览器无法解任意容器），原样 base64；体积门禁在这里与传输层双保险。
    async function prepareVideoAttachment(file) {
        if (!file) throw new Error('没有视频数据');
        if (file.size > AI_VIDEO_MAX_INPUT_BYTES) throw new Error('视频超过 16 MB（请先压缩）');
        let mime = String(file.type || '').toLowerCase();
        if (!AI_VIDEO_MIMES.includes(mime)) {
            if (!isReadableVideoPath(file.name)) throw new Error('不支持的视频格式（当前仅支持 mp4）');
            mime = 'video/mp4';
        }
        const data = bufferToBase64(await file.arrayBuffer());
        if (data.length > AI_VIDEO_MAX_BASE64) throw new Error('视频超过 base64 上限');
        return {mime, data, bytes: file.size, name: String(file.name || '').trim() || '视频'};
    }

    async function attachVideoPath(path) {
        if (!readVideoFile) {
            flash('当前版本不支持读取视频', true);
            return false;
        }
        try {
            const dataURL = await readVideoFile(path);
            const payload = aiVideoFromSrc(dataURL, String(path).split(/[\\/]/).pop());
            if (!payload) throw new Error('不是支持的 mp4 视频');
            return addAttachment({kind: 'video', label: payload.name, ...payload});
        } catch (e) {
            flash('附加视频失败：' + ((e && e.message) || e), true);
            return false;
        }
    }

    async function handleInputPaste(e) {
        const data = e.clipboardData;
        if (!data || !data.items) return;
        const files = [];
        const videoFiles = [];
        for (const item of data.items) {
            if (item && item.kind === 'file') {
                const file = item.getAsFile();
                if (!file) continue;
                const type = String(item.type || '');
                if (type.startsWith('image/')) files.push(file);
                else if (type.startsWith('video/')) videoFiles.push(file);
            }
        }
        if (!files.length && !videoFiles.length) return;
        const text = data.getData('text/plain');
        if (!text) e.preventDefault();
        const room = AI_IMAGE_LIMIT - attachments.filter((item) => item.kind === 'image').length;
        if (files.length && room <= 0) {
            flash('每条消息最多附加 ' + AI_IMAGE_LIMIT + ' 张图片', true);
        }
        for (const file of files.slice(0, room)) {
            try {
                const prepared = await prepareImageAttachment(file);
                prepared.kind = 'image';
                prepared.label = prepared.name;
                addAttachment(prepared);
            } catch (err) {
                flash('图片处理失败：' + ((err && err.message) || err), true);
            }
        }
        if (files.length > room) flash('超出图片数量上限，已附加 ' + room + ' 张', true);
        for (const file of videoFiles) {
            try {
                const prepared = await prepareVideoAttachment(file);
                prepared.kind = 'video';
                prepared.label = prepared.name;
                addAttachment(prepared);
            } catch (err) {
                flash('视频处理失败：' + ((err && err.message) || err), true);
            }
        }
    }

    async function attachPath(path, opts) {
        if (!path) return false;
        try {
            const read = await readTextFile(path, 64 << 10);
            const name = (read.data && read.data.name) || String(path).split(/[\\/]/).pop();
            return addAttachment({kind: 'file', label: name, path, content: read.text});
        } catch (e) {
            flash('附加文件失败：' + ((e && e.message) || e), true);
            return false;
        }
    }

    async function attachCurrentFile() {
        const context = getWorkspaceContext() || {};
        const path = context.activeFile && context.activeFile.path;
        if (!path) {
            flash('当前没有打开的文件', true);
            return false;
        }
        return attachPath(path, {focus: true});
    }

    function attachSelection() {
        const selection = getSelection ? getSelection() : null;
        if (!selection || !aiTextOf(selection.text).trim()) {
            flash('当前没有选中的内容', true);
            return false;
        }
        return addAttachment({
            kind: 'selection',
            label: selection.name || '选中内容',
            path: selection.path || '',
            content: selection.text,
        });
    }

    function referencePath(path, name) {
        const target = aiTextOf(path).trim();
        if (!target) {
            flash('当前文件没有可引用的绝对路径', true);
            return false;
        }
        const label = aiTextOf(name).trim() || target.split(/[\\/]/).pop() || target;
        return addAttachment({kind: 'reference', label, path: target});
    }

    function referenceSelection() {
        const selection = getSelection ? getSelection() : null;
        if (!selection || !aiTextOf(selection.path).trim()) {
            flash('当前没有可引用的选区或文件路径', true);
            return false;
        }
        const range = selection.selection;
        if (!range || !range.start || !range.end) {
            flash('当前选区缺少行列信息', true);
            return false;
        }
        return addAttachment({
            kind: 'selection_reference',
            label: selection.name || '选中内容',
            path: selection.path,
            start: range.start,
            end: range.end,
        });
    }

    // 对话引用：把 AI 回复（或用户消息）的整条 / 所选片段放进输入区附件条，
    // 发送时由 submitText 拼成 user content 前缀的 <quote> 标记，不进 <attachments>。
    function addMessageQuote(quote) {
        const source = quote && quote.source === 'user' ? 'user' : 'assistant';
        const index = Number(quote && quote.index) || 0;
        const scope = quote && quote.scope === 'selection' ? 'selection' : 'message';
        const content = aiTextOf(quote && quote.content);
        if (!content.trim()) {
            flash('这条消息没有可引用的正文', true);
            return false;
        }
        return addAttachment({
            kind: AI_QUOTE_KIND,
            label: quoteChipLabel({source, index, scope}),
            source,
            index,
            scope,
            content,
        });
    }

    async function attachFilesDialog() {
        if (!pickFiles) {
            flash('当前版本不支持选择附加文件', true);
            return;
        }
        let paths;
        try {
            paths = await pickFiles();
        } catch (e) {
            flash('选择文件失败：' + ((e && e.message) || e), true);
            return;
        }
        if (!paths || !paths.length) return;
        for (const path of paths) {
            // mp4 走视频通道（二进制 base64），其余照旧读文本
            if (isReadableVideoPath(path)) await attachVideoPath(path);
            else await attachPath(path);
        }
    }

    async function showSkillPicker() {
        let skills;
        try {
            skills = await listSkills(true);
        } catch (e) {
            showNote('读取技能失败：' + ((e && e.message) || e), true);
            return;
        }
        if (!skills.length) {
            showNote('未找到技能。技能目录：工作区 .cadt/skills、.agents/skills，应用数据 ai-skills，用户 ~/.agents/skills，内置 builtin-skills。', true);
            return;
        }
        if (!showContextMenu) {
            return;
        }
        const rect = el.attachSkill ? el.attachSkill.getBoundingClientRect() : {right: 200, bottom: 200};
        showContextMenu(skills.map((skill) => ({
            label: skill.name + ' — ' + skill.description,
            action: () => {
                addAttachment({
                    kind: 'skill',
                    label: skill.name,
                    path: skill.path,
                    content: skill.content,
                });
            },
        })), rect.right + 4, rect.bottom + 4);
    }

    async function attachSkillByName(name) {
        let skills;
        try {
            skills = await listSkills(true);
        } catch (e) {
            showNote('读取技能失败：' + ((e && e.message) || e), true);
            return;
        }
        const target = skills.find((skill) => skill.name.toLowerCase() === String(name || '').toLowerCase());
        if (!target) {
            showNote('未找到技能：' + name, true);
            return;
        }
        addAttachment({kind: 'skill', label: target.name, path: target.path, content: target.content});
        showNote('已加载技能：' + target.name + '（随下一轮发送）');
    }

    // 输入框随内容长高，上限 8 行：按当前字号行高与上下内边距动态算上限（字号可自定义），
    // 到顶后 textarea 内部滚动；与 CSS 的 max-height: calc(8 * 1.5em + 12px) 保持同一口径
    function resizeInput() {
        if (!el.input) return;
        el.input.style.height = 'auto';
        const cs = getComputedStyle(el.input);
        const line = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 13) * 1.5;
        const max = Math.round(line * 8 + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0));
        el.input.style.height = Math.min(max, Math.max(44, el.input.scrollHeight)) + 'px';
    }

    // ev：点击事件可带 Ctrl/Meta——生成中点发送按钮 = 排队，按住 Ctrl 点 = 插话（与 Ctrl+Enter 同路）。
    function submitFromComposer(ev) {
        if (!el.input) return;
        const text = el.input.value;
        const trimmed = text.trim();
        if (!trimmed && !attachments.length) return;
        if (trimmed.startsWith('/')) {
            handleSlashText(trimmed);
            return;
        }
        // 只有本会话在生成 / 压缩时才并入排队；别的会话在跑不影响本会话直接发送。
        if (syncStreamView() || compactOf((currentSession() || {}).id)) {
            const interject = !!(ev && (ev.ctrlKey || ev.metaKey));
            if (interject) {
                interjectComposerMessage();
            } else {
                enqueueComposerMessage();
            }
            return;
        }
        submitText(text);
    }

    function handleComposerKey(e) {
        if (e.isComposing || e.keyCode === 229) return;
        if (slashState.open) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                slashState.index = Math.min(slashState.items.length - 1, slashState.index + 1);
                updateSlash();
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                slashState.index = Math.max(0, slashState.index - 1);
                updateSlash();
                return;
            }
            if (e.key === 'Tab') {
                e.preventDefault();
                const command = slashState.items[slashState.index];
                if (command && el.input) {
                    el.input.value = command.name;
                    updateSlash();
                    const end = el.input.value.length;
                    el.input.setSelectionRange(end, end);
                }
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                runSlashCommand(slashState.items[slashState.index]);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                hideSlash();
                return;
            }
        }
        // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z 走 textarea 自己的撤销栈（原生行为，不 preventDefault）。
        // 只挡冒泡：main.js 的全局快捷键会把这三个键抢去做编辑器 undo/redo。
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key &&
            (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
            e.stopPropagation();
            return;
        }
        if (e.key !== 'Enter') return;
        if (syncStreamView() || compactOf((currentSession() || {}).id)) {
            if (e.shiftKey || e.altKey) return;
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) {
                interjectComposerMessage();
            } else {
                enqueueComposerMessage();
            }
            return;
        }
        const ctrlEnter = settings.aiSendKey === 'ctrl-enter';
        const shouldSend = ctrlEnter ? (e.ctrlKey || e.metaKey) : (!e.shiftKey && !e.altKey);
        if (!shouldSend) return;
        e.preventDefault();
        submitFromComposer();
    }

    function currentQueueItems() {
        const session = currentSession();
        return session ? queue.itemsForSession(session.id) : [];
    }

    function captureComposerMessage() {
        if (!el.input) return null;
        const text = String(el.input.value || '').trim();
        const items = attachments.slice();
        if (!text && !items.length) return null;
        const session = currentSession();
        if (!session) return null;
        const item = {
            id: ++queueSeq,
            sessionId: session.id,
            text,
            attachments: items,
            ts: Date.now(),
        };
        el.input.value = '';
        resizeInput();
        attachments = [];
        renderAttachments();
        hideSlash();
        updateSendState();
        return item;
    }

    function editQueuedMessage(item) {
        if (!item || !el.input) return;
        const index = queue.indexOfItem(item);
        if (index < 0) return;
        const session = currentSession();
        if (!session) return;
        const draftText = String(el.input.value || '').trim();
        const draftAttachments = attachments.slice();
        let queuedDraft = false;
        if (draftText || draftAttachments.length) {
            queue.pushItem({
                id: ++queueSeq,
                sessionId: session.id,
                text: draftText,
                attachments: draftAttachments,
                ts: Date.now(),
            });
            el.input.value = '';
            attachments = [];
            renderAttachments();
            queuedDraft = true;
        }
        queue.removeItem(item);
        el.input.value = item.text || '';
        attachments = (item.attachments || []).map((att) => ({...att}));
        renderAttachments();
        resizeInput();
        updateSendState();
        renderMessageQueue();
        el.input.focus();
        flash(queuedDraft ? '已取回待编辑消息；输入区原有内容已放回排队' : '已取回待编辑消息');
    }
    // ---------- 输入框右键编辑菜单（撤销/重做/剪切/复制/粘贴/全选；方案 M2 搬入） ----------

    function editableHasSelection(target) {
        if (typeof target.selectionStart === 'number') return target.selectionEnd > target.selectionStart;
        const selection = window.getSelection ? window.getSelection() : null;
        return !!(selection && selection.rangeCount && !selection.isCollapsed);
    }

    function execEditable(target, command) {
        target.focus();
        try {
            return !!document.execCommand(command);
        } catch (e) {
            return false;
        }
    }

    // data URL → File：右键菜单粘贴到的图片由后端以 data URL 返回，复用粘贴/拖拽的压缩管线。
    function dataUrlToFile(dataUrl, name) {
        const raw = String(dataUrl || '');
        const comma = raw.indexOf(',');
        if (comma < 0) return null;
        const header = raw.slice(0, comma);
        const mime = (header.slice(header.indexOf(':') + 1).split(';')[0] || 'image/png').trim() || 'image/png';
        let binary = '';
        try {
            binary = atob(raw.slice(comma + 1));
        } catch (e) {
            return null;
        }
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        if (!bytes.length) return null;
        try {
            return new File([bytes], name || '粘贴的图片', {type: mime});
        } catch (e) {
            return null;
        }
    }

    // 右键菜单的「粘贴」拿不到 paste 事件（菜单点击不会触发剪贴板事件），
    // 图片只能请后端回读系统剪贴板，再走和 Ctrl+V 一样的附件流程。
    async function pasteImageFromClipboard() {
        if (!backend.GetClipboardImage) return false;
        let dataUrl = '';
        try {
            dataUrl = String((await backend.GetClipboardImage()) || '');
        } catch (e) {
            return false;
        }
        if (!dataUrl) return false;
        const file = dataUrlToFile(dataUrl, '粘贴的图片.png');
        if (!file) return false;
        try {
            const prepared = await prepareImageAttachment(file);
            prepared.kind = 'image';
            prepared.label = prepared.name;
            return addAttachment(prepared);
        } catch (err) {
            flash('图片处理失败：' + ((err && err.message) || err), true);
            return false;
        }
    }

    async function pasteIntoEditable(target) {
        let text = '';
        try {
            if (backend.GetClipboardText) text = String((await backend.GetClipboardText()) || '');
        } catch (e) {}
        if (!text && navigator.clipboard && navigator.clipboard.readText) {
            try {
                text = await navigator.clipboard.readText();
            } catch (e) {}
        }
        if (!text) {
            // 剪贴板里没有文字：按图片粘贴（Ctrl+V 走 paste 事件，菜单粘贴只能这样回读）。
            await pasteImageFromClipboard();
            return;
        }
        target.focus();
        // execCommand('insertText') 会进 undo 栈（菜单粘贴也能 Ctrl+Z 撤销）；不可用时回退 setRangeText
        let ok = false;
        try {
            ok = document.execCommand('insertText', false, text);
        } catch (e) {}
        if (!ok) {
            if (typeof target.selectionStart === 'number') {
                target.setRangeText(text, target.selectionStart, target.selectionEnd, 'end');
            } else {
                target.value += text;
            }
            target.dispatchEvent(new Event('input', {bubbles: true}));
        }
    }

    function showAIEditMenu(event, target) {
        if (!showContextMenu) return;
        const hasSel = editableHasSelection(target);
        showContextMenu([
            {label: '撤销', shortcut: 'Ctrl+Z', icon: 'E7A7', action: () => execEditable(target, 'undo')},
            {label: '重做', shortcut: 'Ctrl+Y', icon: 'E7A6', action: () => execEditable(target, 'redo')},
            {sep: true},
            {label: '剪切', shortcut: 'Ctrl+X', icon: 'E8C6', disabled: !hasSel, action: () => execEditable(target, 'cut')},
            {label: '复制', shortcut: 'Ctrl+C', icon: 'E8C8', disabled: !hasSel, action: () => execEditable(target, 'copy')},
            {label: '粘贴', shortcut: 'Ctrl+V', icon: 'E77F', action: () => pasteIntoEditable(target)},
            {sep: true},
            {label: '全选', shortcut: 'Ctrl+A', icon: 'E8B3', action: () => execEditable(target, 'selectAll')},
        ], event.clientX, event.clientY);
    }

    return {
        renderAttachments,
        addAttachment,
        prepareImageAttachment,
        prepareVideoAttachment,
        attachPath,
        attachVideoPath,
        attachSelection,
        referencePath,
        referenceSelection,
        addMessageQuote,
        attachFilesDialog,
        showSkillPicker,
        attachSkillByName,
        resizeInput,
        submitFromComposer,
        handleComposerKey,
        currentQueueItems,
        captureComposerMessage,
        editQueuedMessage,
        handleInputPaste,
        attachCurrentFile,
        showAIEditMenu,
        getAttachments: () => attachments,
        setAttachments: (value) => { attachments = value; },
    };
}
