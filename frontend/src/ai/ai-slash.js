// ai-slash.js：斜杠命令（/context /compact /clear /help /model /export /memory /schedule /skill /plan /init /patch /diff /worktree）
// 与技能补全：指令固定在前、技能在后分区显示；/技能名 直接附加，/技能名 参数 立即发送（生成中由 sendComposerMessage 排队）。
// slashState 由面板与输入区共享（引用稳定、仅属性级读写），经 ctx 注入。
import {AI_COMMANDS, aiClamp} from './ai-constants.js';

// ---------- 纯函数（测试见 frontend/test/ai/ai-slash.test.mjs） ----------

// 指令按前缀过滤（历史口径）；技能名用 includes（/err 也能命中 app-error-log）；均大小写不敏感
export function filterSlashCommands(commands, query) {
    const q = String(query || '').toLowerCase();
    return commands.filter((cmd) => cmd.name.slice(1).toLowerCase().startsWith(q));
}

export function filterSlashSkills(skills, query) {
    const q = String(query || '').toLowerCase();
    return skills.filter((skill) => String(skill.name || '').toLowerCase().includes(q));
}

// 提取「/技能名」之后的参数文本；首 token 与技能名大小写不敏感比对，不匹配返回空串
export function extractSlashArgs(text, skillName) {
    const trimmed = String(text || '').trim();
    const firstToken = trimmed.split(/\s+/)[0] || '';
    if (firstToken.toLowerCase() !== '/' + String(skillName || '').toLowerCase()) return '';
    return trimmed.slice(firstToken.length).trim();
}

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
    const listSkills = ctx.listSkills;
    const skillSourceLabel = ctx.skillSourceLabel;
    const addAttachment = ctx.addAttachment;
    const sendComposerMessage = ctx.sendComposerMessage;

    // 技能列表缓存：面板构造即预热（listSkills 自带 5s 缓存），输入 / 时基本已就位，
    // 补全可以全同步渲染、不闪烁；首载在途时 updateSlash 才走异步补渲染兜底。
    let skillsCache = null;
    let skillsPromise = null;
    let renderSeq = 0;

    function ensureSkills() {
        if (skillsCache) return Promise.resolve(skillsCache);
        if (!skillsPromise) {
            // 尽力而为：技能列表读不到就不显示技能区，指令补全不受影响
            skillsPromise = Promise.resolve(listSkills())
                .then((skills) => { skillsCache = skills; return skills; })
                .catch(() => { skillsCache = []; return []; });
        }
        return skillsPromise;
    }

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

    function commandEntry(cmd) {
        return {type: 'command', name: cmd.name, desc: cmd.desc};
    }

    function skillEntry(skill) {
        return {
            type: 'skill',
            name: '/' + skill.name,
            desc: (skillSourceLabel(skill.source) || '') + (skill.description ? ' · ' + skill.description : ''),
            skill,
        };
    }

    function renderSlash(items) {
        if (!items.length) {
            hideSlash();
            return;
        }
        slashState.items = items;
        slashState.index = aiClamp(slashState.index, 0, items.length - 1);
        slashState.open = true;
        el.slash.innerHTML = '';
        let headerPlaced = false;
        items.forEach((entry, index) => {
            // 分区标题放在第一个技能条目前：指令固定在前、技能在后
            if (entry.type === 'skill' && !headerPlaced) {
                headerPlaced = true;
                const header = document.createElement('div');
                header.className = 'ai-slash-header';
                header.textContent = '技能';
                el.slash.appendChild(header);
            }
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'ai-slash-item' + (index === slashState.index ? ' selected' : '');
            item.dataset.aiSlashIndex = String(index);
            const name = document.createElement('span');
            name.textContent = entry.name;
            const desc = document.createElement('span');
            desc.className = 'ai-slash-desc';
            desc.textContent = entry.desc;
            item.append(name, desc);
            item.addEventListener('click', () => {
                slashState.index = index;
                runSlashCommand(items[index]);
            });
            item.addEventListener('mousemove', () => {
                if (slashState.index === index) return;
                slashState.index = index;
                el.slash.querySelectorAll('.ai-slash-item').forEach((row) => {
                    row.classList.toggle('selected', Number(row.dataset.aiSlashIndex) === index);
                });
            });
            el.slash.appendChild(item);
        });
        el.slash.classList.remove('hidden');
        positionOverlays();
    }

    function updateSlash() {
        if (!el.slash || !el.input) return;
        const value = el.input.value;
        if (!value.startsWith('/') || value.includes(' ') || value.includes('\n')) {
            hideSlash();
            return;
        }
        const query = value.slice(1).toLowerCase();
        const commands = filterSlashCommands(AI_COMMANDS, query).map(commandEntry);
        const matched = skillsCache ? filterSlashSkills(skillsCache, query).map(skillEntry) : [];
        const entries = commands.concat(matched);
        const rendered = entries.length > 0;
        if (rendered) renderSlash(entries);
        else hideSlash();
        if (skillsCache) return;
        // 首载在途兜底：到达后本次输入仍有效就补渲染（含「指令无匹配但技能有」的面板重开；
        // Esc 与空态在此时序下无法区分，重开窗口仅首载几十 ms，可接受）
        const seq = ++renderSeq;
        ensureSkills().then((skills) => {
            if (seq !== renderSeq || !el.input || el.input.value !== value) return;
            const all = commands.concat(filterSlashSkills(skills, query).map(skillEntry));
            if (all.length) renderSlash(all);
            else if (!rendered) hideSlash();
        });
    }

    // 技能调用核心：附加技能附件 → 有参数则立即发送原文（生成中由 sendComposerMessage 排队）；
    // 无参数则清空输入框让用户继续写需求（与 /skill <名字> 的附加手感一致）。
    async function invokeSkillItem(skill, typedText) {
        if (!skill) return;
        hideSlash();
        const args = extractSlashArgs(typedText, skill.name);
        addAttachment({kind: 'skill', label: skill.name, path: skill.path, content: skill.content});
        if (args) {
            sendComposerMessage(String(typedText || '').trim());
            showNote('已附加技能：' + skill.name);
            return;
        }
        if (el.input) {
            el.input.value = '';
            resizeInput();
            el.input.focus();
        }
        updateSendState();
        showNote('已加载技能：' + skill.name + '（随下一轮发送），继续输入需求。');
    }

    async function runSlashCommand(entry) {
        if (!entry) return;
        if (entry.type === 'skill') {
            await invokeSkillItem(entry.skill, el.input ? String(el.input.value || '') : '');
            return;
        }
        const command = entry;
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
                startCompact(argText ? {instruction: argText} : undefined);
                break;
            case '/clear':
                clearCurrentSession();
                break;
            case '/help':
                showNote('可用命令：\n' + AI_COMMANDS.map((cmd) => cmd.name + '  —  ' + cmd.desc).join('\n')
                    + '\n\n技能可直接 /技能名 调用（可带参数，如 /技能名 参数），输入 / 从补全列表选择。');
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
            case '/persona':
                openSettings('persona');
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
                showNote('已填入提示词。');
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
                showNote('已填入提示词。');
                break;
            }
            case '/worktree': {
                // 隔离 worktree：面板直接创建（不经过模型回合，确定性入口）。
                // 确认卡在 createWorktree 内部按当前档位出（full 免）；成功后会出胶囊。
                const added = await ctx.createWorktree(argText.trim());
                showNote(added
                    ? '隔离区已创建：' + added.name + '（分支 ' + added.branch + '）。之后让 AI 在 .cadt/worktree/' + added.name + '/ 下改代码，完成后 export 审阅回灌。'
                    : '未创建隔离区（已有隔离区、用户取消或失败，详见提示）。');
                break;
            }
            default:
                showNote('未知命令，输入 /help 查看可用命令。', true);
                break;
        }
    }

    async function handleSlashText(text) {
        const name = String(text || '').trim().split(/\s+/)[0];
        const command = AI_COMMANDS.find((cmd) => cmd.name === name);
        if (command) {
            runSlashCommand(command);
            return;
        }
        // 非固定指令：尝试按技能名调用（/技能名 参数）
        const skills = await ensureSkills();
        const skill = skills.find((item) => String(item.name || '').toLowerCase() === name.slice(1).toLowerCase());
        if (skill) {
            await invokeSkillItem(skill, text);
            return;
        }
        showNote('未知命令：' + name + '\n输入 / 查看命令与技能补全，/help 查看命令列表。', true);
    }

    ensureSkills();
    return {hideSlash, updateSlash, runSlashCommand, handleSlashText};
}
