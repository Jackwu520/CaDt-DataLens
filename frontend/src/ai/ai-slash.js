// ai-slash.js：斜杠命令（/context /compact /clear /help /model /export /memory /schedule /skill /plan /init /patch /diff）。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移。
// slashState 由面板与输入区共享（引用稳定、仅属性级读写），经 ctx 注入。
import {AI_COMMANDS, aiClamp} from './ai-constants.js';

export function createAISlash(ctx) {
    const el = ctx.el;
    const slashState = ctx.slashState;
    const positionOverlays = ctx.positionOverlays;
    const resizeInput = ctx.resizeInput;
    const updateSendState = ctx.updateSendState;
    const contextSummaryText = ctx.contextSummaryText;
    const startCompact = ctx.startCompact;
    const clearCurrentSession = ctx.clearCurrentSession;
    const showNote = ctx.showNote;
    const showModelPicker = ctx.showModelPicker;
    const exportSession = ctx.exportSession;
    const showMemoryDialog = ctx.showMemoryDialog;
    const openSettings = ctx.openSettings;
    const attachSkillByName = ctx.attachSkillByName;
    const showSkillsDialog = ctx.showSkillsDialog;
    const handlePlanCommand = ctx.handlePlanCommand;
    const runInitAgentsMd = ctx.runInitAgentsMd;

    // ---------- 斜杠命令 ----------

    function hideSlash() {
        slashState.open = false;
        slashState.index = 0;
        slashState.items = [];
        if (el.slash) {
            el.slash.classList.add('hidden');
            el.slash.innerHTML = '';
        }
    }

    function updateSlash() {
        if (!el.slash || !el.input) return;
        const value = el.input.value;
        if (!value.startsWith('/') || value.includes(' ') || value.includes('\n')) {
            hideSlash();
            return;
        }
        const query = value.slice(1).toLowerCase();
        const items = AI_COMMANDS.filter((cmd) => cmd.name.slice(1).toLowerCase().startsWith(query));
        if (!items.length) {
            hideSlash();
            return;
        }
        slashState.items = items;
        slashState.index = aiClamp(slashState.index, 0, items.length - 1);
        slashState.open = true;
        el.slash.innerHTML = '';
        items.forEach((command, index) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'ai-slash-item' + (index === slashState.index ? ' selected' : '');
            item.dataset.aiSlashIndex = String(index);
            const name = document.createElement('span');
            name.textContent = command.name;
            const desc = document.createElement('span');
            desc.className = 'ai-slash-desc';
            desc.textContent = command.desc;
            item.append(name, desc);
            item.addEventListener('click', () => {
                slashState.index = index;
                runSlashCommand(items[index]);
            });
            item.addEventListener('mousemove', () => {
                if (slashState.index === index) return;
                slashState.index = index;
                el.slash.querySelectorAll('.ai-slash-item').forEach((row, rowIndex) => {
                    row.classList.toggle('selected', rowIndex === index);
                });
            });
            el.slash.appendChild(item);
        });
        el.slash.classList.remove('hidden');
        positionOverlays();
    }

    async function runSlashCommand(command) {
        if (!command) return;
        const typed = el.input ? String(el.input.value || '').trim() : '';
        const argText = typed.startsWith(command.name) ? typed.slice(command.name.length).trim() : '';
        hideSlash();
        if (el.input) {
            el.input.value = '';
            resizeInput();
        }
        updateSendState();
        switch (command.name) {
            case '/context':
                try {
                    showNote(await contextSummaryText());
                } catch (e) {
                    showNote('上下文统计失败：' + ((e && e.message) || e), true);
                }
                break;
            case '/compact':
                startCompact();
                break;
            case '/clear':
                clearCurrentSession();
                break;
            case '/help':
                showNote('可用命令：\n' + AI_COMMANDS.map((cmd) => cmd.name + '  —  ' + cmd.desc).join('\n'));
                break;
            case '/model':
                showModelPicker();
                break;
            case '/export':
                exportSession();
                break;
            case '/memory':
                await showMemoryDialog();
                break;
            case '/schedule':
                openSettings('schedules');
                break;
            case '/skill':
                if (argText) await attachSkillByName(argText);
                else await showSkillsDialog();
                break;
            case '/plan':
                handlePlanCommand(argText);
                break;
            case '/init':
                await runInitAgentsMd();
                break;
            case '/patch': {
                // 直接注入提示词到输入框，用户可改再发；不在命令里替用户做决定
                const ask = argText.trim();
                const prompt = ask
                    ? '把「' + ask + '」的改动做成 patch 补丁给我审批（不要直接改文件）。'
                    : '把这次改动做成 patch 补丁给我审批（不要直接改文件）。';
                if (el.input) {
                    el.input.value = prompt;
                    el.input.focus();
                    try { el.input.setSelectionRange(prompt.length, prompt.length); } catch (e) {}
                    updateSendState();
                }
                showNote('已填入提示词，可修改后发送。');
                break;
            }
            case '/diff': {
                const ask = argText.trim();
                const prompt = ask
                    ? '先给我看「' + ask + '」改动的 diff，不要写入文件。'
                    : '先给我看这次改动的 diff，不要写入文件。';
                if (el.input) {
                    el.input.value = prompt;
                    el.input.focus();
                    try { el.input.setSelectionRange(prompt.length, prompt.length); } catch (e) {}
                    updateSendState();
                }
                showNote('已填入提示词，可修改后发送。');
                break;
            }
            default:
                showNote('未知命令，输入 /help 查看可用命令。', true);
                break;
        }
    }

    function handleSlashText(text) {
        const name = String(text || '').trim().split(/\s+/)[0];
        const command = AI_COMMANDS.find((cmd) => cmd.name === name);
        if (command) runSlashCommand(command);
        else showNote('未知命令：' + name + '\n输入 /help 查看可用命令。', true);
    }
    return {hideSlash, updateSlash, runSlashCommand, handleSlashText};
}
