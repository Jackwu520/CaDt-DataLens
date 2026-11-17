// explorer-history.js：文件树操作的会话内撤销栈（纯逻辑，不碰 DOM / 后端）。
//
// 每条记录是一对可逆动作：{label, undo, redo}，undo/redo 都是 () => Promise<boolean|void>，
// 返回 false 表示动作失败——此时停止继续回放，且不改栈。
// 不做持久化：重启后回收站里还在，但本会话的"刚刚操作"语义消失。
export function createExplorerHistory(limit = 50) {
    let undoStack = [];
    let redoStack = [];
    let replaying = false;

    function push(entry) {
        if (!entry || typeof entry.undo !== 'function' || typeof entry.redo !== 'function') return;
        // 回放过程中触发的操作（如内部刷新）不记栈，避免自我循环
        if (replaying) return;
        undoStack.push(entry);
        if (undoStack.length > limit) undoStack.shift();
        redoStack = [];
    }

    async function play(entry, direction) {
        if (!entry) return false;
        const op = entry[direction];
        if (typeof op !== 'function') return false;
        const result = await op();
        return result !== false;
    }

    async function undo() {
        if (replaying || !undoStack.length) return false;
        replaying = true;
        try {
            const entry = undoStack[undoStack.length - 1];
            if (!(await play(entry, 'undo'))) return false;
            undoStack.pop();
            redoStack.push(entry);
            return true;
        } finally {
            replaying = false;
        }
    }

    async function redo() {
        if (replaying || !redoStack.length) return false;
        replaying = true;
        try {
            const entry = redoStack[redoStack.length - 1];
            if (!(await play(entry, 'redo'))) return false;
            redoStack.pop();
            undoStack.push(entry);
            return true;
        } finally {
            replaying = false;
        }
    }

    return {
        push,
        undo,
        redo,
        canUndo: () => undoStack.length > 0,
        canRedo: () => redoStack.length > 0,
        clear: () => { undoStack = []; redoStack = []; },
        peekUndo: () => (undoStack.length ? undoStack[undoStack.length - 1].label : ''),
        peekRedo: () => (redoStack.length ? redoStack[redoStack.length - 1].label : ''),
    };
}
