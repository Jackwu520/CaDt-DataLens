// ai-composer.js：AI 面板输入区与附件域（附件条 / 图片准备 / 引用与技能附加 / 输入框交互 / 排队草稿捕获）。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移。
// attachments 与 queueSeq 为本域私有 let（attachments 经 getAttachments/setAttachments 供面板与消息队列访问）；
// attachSeq 留在面板（executeTool /clear 会重置），经 nextAttachSeq() 取号。
import {aiTextOf, aiImageSrc, AI_IMAGE_LIMIT, AI_IMAGE_MAX_BASE64, AI_IMAGE_MAX_DIM, AI_IMAGE_MAX_INPUT_BYTES, AI_IMAGE_MESSAGE_BUDGET} from './ai-constants.js';

export function createAIComposer(ctx) {
    const el = ctx.el;
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
            remove.title = '移除';
            remove.textContent = '×';
            remove.addEventListener('click', () => {
                attachments = attachments.filter((current) => current.id !== item.id);
                renderAttachments();
                updateContextCount();
            });
            if (item.kind === 'image') {
                chip.className = 'ai-chip ai-chip-image';
                chip.title = item.name + (item.width && item.height ? ' · ' + item.width + '×' + item.height : '');
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
                label.textContent = prefix + item.label;
                label.title = item.kind === 'selection_reference'
                    ? (item.path || '') + ' · ' + (item.start && item.start.line ? item.start.line + ':' + item.start.column : '') +
                        '–' + (item.end && item.end.line ? item.end.line + ':' + item.end.column : '')
                    : (item.path || item.label);
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

    function loadImageElement(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                resolve(img);
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('无法读取图片'));
            };
            img.src = url;
        });
    }

    async function prepareImageAttachment(file) {
        if (!file) throw new Error('没有图片数据');
        if (file.size > AI_IMAGE_MAX_INPUT_BYTES) throw new Error('图片超过 12MB');
        let source = file;
        let width = 0;
        let height = 0;
        if (typeof createImageBitmap === 'function') {
            source = await createImageBitmap(file);
            width = source.width;
            height = source.height;
        } else {
            source = await loadImageElement(file);
            width = source.naturalWidth || source.width;
            height = source.naturalHeight || source.height;
        }
        const scale = Math.min(1, AI_IMAGE_MAX_DIM / Math.max(width || 1, height || 1));
        const outWidth = Math.max(1, Math.round(width * scale));
        const outHeight = Math.max(1, Math.round(height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = outWidth;
        canvas.height = outHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('无法创建图片画布');
        ctx.drawImage(source, 0, 0, outWidth, outHeight);
        if (source && typeof source.close === 'function') source.close();
        let mime = 'image/png';
        let dataUrl = canvas.toDataURL('image/png');
        if (dataUrl.length > AI_IMAGE_MAX_BASE64) {
            let quality = 0.86;
            mime = 'image/jpeg';
            dataUrl = canvas.toDataURL(mime, quality);
            while (dataUrl.length > AI_IMAGE_MAX_BASE64 && quality > 0.45) {
                quality -= 0.1;
                dataUrl = canvas.toDataURL(mime, quality);
            }
        }
        if (dataUrl.length > AI_IMAGE_MAX_BASE64) throw new Error('压缩后图片仍然过大');
        const comma = dataUrl.indexOf(',');
        if (comma < 0) throw new Error('图片编码失败');
        return {
            mime,
            data: dataUrl.slice(comma + 1),
            width: outWidth,
            height: outHeight,
            bytes: Math.round((dataUrl.length - comma - 1) * 3 / 4),
            name: (file.name && file.name !== 'image.png') ? file.name : '粘贴的图片',
        };
    }

    async function handleInputPaste(e) {
        const data = e.clipboardData;
        if (!data || !data.items) return;
        const files = [];
        for (const item of data.items) {
            if (item && item.kind === 'file' && String(item.type || '').startsWith('image/')) {
                const file = item.getAsFile();
                if (file) files.push(file);
            }
        }
        if (!files.length) return;
        const text = data.getData('text/plain');
        if (!text) e.preventDefault();
        const room = AI_IMAGE_LIMIT - attachments.filter((item) => item.kind === 'image').length;
        if (room <= 0) {
            flash('每条消息最多附加 ' + AI_IMAGE_LIMIT + ' 张图片', true);
            return;
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
            await attachPath(path);
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
        if (!trimmed && !attachments.some((item) => item.kind === 'image')) return;
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
        if (!text && !items.some((item) => item.kind === 'image')) return null;
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
    return {
        renderAttachments,
        addAttachment,
        prepareImageAttachment,
        attachPath,
        attachSelection,
        referencePath,
        referenceSelection,
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
        getAttachments: () => attachments,
        setAttachments: (value) => { attachments = value; },
    };
}
