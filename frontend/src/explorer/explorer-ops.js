// explorer-ops.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 资源管理器域操作：路径改码（重命名/移动/删除联动）、文件剪贴板、
// 新建/重命名/删除对话框、explorer 右键菜单。
//
// deps 由 main.js 显式传入（getter 延迟求值 + 需要回写的状态带 setter）；
// 原 main.js 裸标识符引用已按 deps 名重写为 deps.X。
import {createExplorerHistory} from './explorer-history.js';
import {fileTypeMenuItem, resolveNewFileMenu} from './new-file-menu.js';

export function createExplorerOps(deps) {

// 文件树操作历史（会话内）：删除 / 重命名 / 移动 / 新建各自记录可逆动作。
const history = createExplorerHistory();

// 撤销动作写盘后走差量刷新，保留树的展开态与滚动位置（refresh() 是用户主动点刷新专用）。
function afterHistoryChange(paths) {
    if (!deps.explorer || !deps.explorer.notifyFileChange) return;
    for (const path of paths) {
        if (path) deps.explorer.notifyFileChange(path);
    }
}

function remapPathValue(path, oldPath, newPath) {
    if (!path) return path;
    const target = String(path).replace(/\\/g, '/');
    const oldNorm = String(oldPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!oldNorm) return path;
    const lowerTarget = target.toLowerCase();
    const lowerOld = oldNorm.toLowerCase();
    if (lowerTarget === lowerOld) return newPath;
    if (!lowerTarget.startsWith(lowerOld + '/')) return path;
    return String(newPath).replace(/\\/g, '/').replace(/\/+$/, '') + target.slice(oldNorm.length);
}

function parentFolderOf(path) {
    const text = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const index = text.lastIndexOf('/');
    if (index < 0) return '';
    let dir = text.slice(0, index);
    if (/^[a-z]:$/i.test(dir)) dir += '/';
    return dir;
}

function samePathValue(a, b) {
    const left = String(a || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const right = String(b || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return !!left && left === right;
}

function pathWithinValue(root, target) {
    const base = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const child = String(target || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return !!base && (child === base || child.startsWith(base + '/'));
}

function clipboardItems(targets) {
    const list = Array.isArray(targets) ? targets : (targets ? [targets] : []);
    const out = [];
    for (const item of list) {
        if (!item || !item.path) continue;
        if (out.some((entry) => samePathValue(entry.path, item.path))) continue;
        out.push({path: item.path, name: item.name || deps.baseNameOf(item.path), isDir: !!item.isDir});
    }
    return out;
}

function setFileClipboard(targets, cut) {
    const all = clipboardItems(targets);
    const items = all.filter((item) =>
        !all.some((other) =>
            other.isDir && !samePathValue(other.path, item.path) && pathWithinValue(other.path, item.path)));
    if (!items.length) return;
    const same = deps.fileClipboard && deps.fileClipboard.cut === !!cut &&
        deps.fileClipboard.items.length === items.length &&
        items.every((item) => deps.fileClipboard.items.some((old) => samePathValue(old.path, item.path)));
    if (same) {
        if (deps.explorer) deps.explorer.setCutPaths(cut ? items.map((item) => item.path) : []);
        return;
    }
    deps.fileClipboard = {items, cut: !!cut};
    if (deps.explorer) deps.explorer.setCutPaths(cut ? items.map((item) => item.path) : []);
    deps.flash(items.length === 1
        ? (cut ? '已剪切：' : '已复制：') + items[0].name
        : (cut ? '已剪切 ' : '已复制 ') + items.length + ' 项');
}

function applyMovedPath(oldPath, newPath) {
    let activeChanged = false;
    let rootChanged = false;
    for (const doc of deps.docs) {
        if (!doc.path) continue;
        const next = remapPathValue(doc.path, oldPath, newPath);
        if (next === doc.path) continue;
        doc.path = next;
        doc.name = deps.baseNameOf(next);
        if (doc === deps.file) activeChanged = true;
    }
    if (deps.workspaceFolder) {
        const next = remapPathValue(deps.workspaceFolder, oldPath, newPath);
        if (next !== deps.workspaceFolder) {
            deps.workspaceFolder = next;
            rootChanged = true;
        }
    }
    for (const entry of deps.closedTabs) {
        if (entry.path) entry.path = remapPathValue(entry.path, oldPath, newPath);
    }
    if (activeChanged && deps.file) {
        deps.setFilename(deps.file.name, deps.file.path);
        deps.renderBreadcrumb(deps.file.path);
        deps.updateWindowTitle();
    }
    deps.renderTabs();
    return {activeChanged, rootChanged};
}

// 移动可撤销：记录每项的原路径与新路径，正反两个方向都调 MoveEntry + applyMovedPath。
function recordMove(results, destDir) {
    if (!results.length) return;
    const moves = results.map((result) => ({
        from: result.path,
        to: result.newPath,
        name: result.name || deps.baseNameOf(result.path),
        isDir: !!result.isDir,
    }));
    const replay = (forward) => async () => {
        const failures = [];
        for (const move of moves) {
            const src = forward ? move.from : move.to;
            const dir = forward ? destDir : parentFolderOf(move.from);
            try {
                const landed = await deps.backend.MoveEntry(src, dir, move.name);
                applyMovedPath(src, landed);
                afterHistoryChange([src, landed]);
            } catch (e) {
                failures.push(move.name + '：' + ((e && e.message) || e));
            }
        }
        if (failures.length) {
            deps.flash((forward ? '移动' : '移回') + '失败：' + failures[0], true);
            return false;
        }
        deps.flash(forward ? '已移动 ' + moves.length + ' 项' : '已移回 ' + moves.length + ' 项');
        return true;
    };
    history.push({
        label: moves.length > 1 ? '移动 ' + moves.length + ' 项' : '移动“' + moves[0].name + '”',
        undo: replay(false),
        redo: replay(true),
    });
}

async function runPasteItems(clip, destDir, names) {
    if (!clip || !clip.items.length) throw new Error('剪贴板中没有文件');
    if (!deps.backend.CopyEntry || !deps.backend.MoveEntry) throw new Error('当前版本不支持粘贴');
    const cut = !!clip.cut;
    const results = [];
    const errors = [];
    for (const item of clip.items) {
        const name = (names && names[item.path]) || item.name;
        try {
            const newPath = cut
                ? await deps.backend.MoveEntry(item.path, destDir, name)
                : await deps.backend.CopyEntry(item.path, destDir, name);
            results.push({...item, newPath});
        } catch (e) {
            errors.push({item, error: (e && e.message) || String(e)});
        }
    }
    let activeChanged = false;
    let rootChanged = false;
    if (cut && results.length) {
        for (const result of results) {
            const flags = applyMovedPath(result.path, result.newPath);
            activeChanged = activeChanged || flags.activeChanged;
            rootChanged = rootChanged || flags.rootChanged;
            if (deps.explorer) deps.explorer.removePath(result.path);
            deps.activityLog.log('file.move', destDir, {from: deps.actRel(result.path), count: results.length});
        }
        const moved = new Set(results.map((result) => result.path));
        const remaining = clip.items.filter((item) => !moved.has(item.path));
        if (remaining.length) {
            deps.fileClipboard = {items: remaining, cut: true};
            if (deps.explorer) deps.explorer.setCutPaths(remaining.map((item) => item.path));
        } else {
            deps.fileClipboard = null;
            if (deps.explorer) deps.explorer.setCutPaths([]);
        }
        recordMove(results, destDir);
    }
    if (rootChanged && deps.explorer) deps.explorer.setRoot(deps.workspaceFolder);
    if (rootChanged) deps.renderWorkspaceCrumbs();
    if (deps.explorer && results.length) {
        await deps.explorer.refreshDir(destDir);
        deps.explorer.selectPaths(results.map((result) => ({
            path: result.newPath,
            name: deps.baseNameOf(result.newPath),
            isDir: result.isDir,
        })));
        if (activeChanged && deps.file) deps.explorer.setActive(deps.file.path);
    }
    return {
        okCount: results.length,
        failCount: errors.length,
        firstError: errors.length ? errors[0].error : '',
        results,
    };
}

async function moveEntriesByDrag(items, destDir) {
    if (deps.settings.readOnlyMode) {
        deps.flash('只读模式下不能移动文件', true);
        return;
    }
    if (!deps.backend.MoveEntry) {
        deps.flash('当前版本不支持移动文件', true);
        return;
    }
    const all = clipboardItems(items);
    // 选中的父目录和子项同时拖动时只移动父目录
    const unique = all.filter((item) =>
        !all.some((other) => other.isDir && !samePathValue(other.path, item.path) && pathWithinValue(other.path, item.path)));
    const movable = unique.filter((item) =>
        !samePathValue(item.path, destDir) &&
        !(item.isDir && pathWithinValue(item.path, destDir)) &&
        !samePathValue(parentFolderOf(item.path), destDir));
    if (!movable.length) {
        deps.flash('文件已在该目录中', true);
        return;
    }
    const results = [];
    const errors = [];
    for (const item of movable) {
        try {
            const newPath = await deps.backend.MoveEntry(item.path, destDir, item.name);
            results.push({...item, newPath});
            deps.activityLog.log('file.move', destDir, {from: deps.actRel(item.path), count: movable.length});
        } catch (e) {
            errors.push({item, error: (e && e.message) || String(e)});
        }
    }
    let activeChanged = false;
    let rootChanged = false;
    for (const result of results) {
        const flags = applyMovedPath(result.path, result.newPath);
        activeChanged = activeChanged || flags.activeChanged;
        rootChanged = rootChanged || flags.rootChanged;
        if (deps.explorer) deps.explorer.removePath(result.path);
    }
    if (rootChanged && deps.explorer) deps.explorer.setRoot(deps.workspaceFolder);
    recordMove(results, destDir);
    if (deps.explorer && results.length) {
        await deps.explorer.refreshDir(destDir);
        deps.explorer.selectPaths(results.map((result) => ({
            path: result.newPath,
            name: deps.baseNameOf(result.newPath),
            isDir: result.isDir,
        })));
        if (activeChanged && deps.file) deps.explorer.setActive(deps.file.path);
    }
    if (errors.length) {
        const ok = results.length ? '已移动 ' + results.length + ' 项，' : '';
        deps.flash(ok + errors.length + ' 项失败：' + errors[0].error, true);
    } else {
        deps.flash(results.length === 1 ? '已移动：' + deps.baseNameOf(results[0].newPath) : '已移动 ' + results.length + ' 项');
    }
}

async function pasteFileClipboard(targetInfo) {
    if (!deps.fileClipboard || !deps.fileClipboard.items.length) {
        deps.flash('剪贴板中没有文件', true);
        return;
    }
    if (deps.settings.readOnlyMode) {
        deps.flash('只读模式下不能粘贴', true);
        return;
    }
    const clip = deps.fileClipboard;
    const destDir = targetInfo && targetInfo.isDir ? targetInfo.path : parentFolderOf(targetInfo && targetInfo.path);
    if (!destDir) {
        deps.flash('无法确定粘贴目录', true);
        return;
    }
    const items = clip.items.filter((item) => {
        if (item.isDir && pathWithinValue(item.path, destDir)) return false;
        if (clip.cut && samePathValue(parentFolderOf(item.path), destDir)) return false;
        return true;
    });
    if (!items.length) {
        deps.flash(clip.cut ? '源文件已经在该目录中' : '不能粘贴到文件夹自身或其子目录', true);
        return;
    }
    const skipped = clip.items.length - items.length;
    if (items.length === 1 && clip.items.length === 1) {
        const item = items[0];
        let suggested;
        try {
            suggested = await deps.backend.SuggestCopyName(destDir, item.name, item.isDir);
        } catch (e) {
            deps.flash('粘贴失败：' + e, true);
            return;
        }
        if (suggested === item.name) {
            try {
                const result = await runPasteItems({items, cut: clip.cut}, destDir);
                if (result.failCount) deps.flash('粘贴失败：' + result.firstError, true);
                else deps.flash((clip.cut ? '已移动：' : '已粘贴：') + item.name);
            } catch (e) {
                deps.flash('粘贴失败：' + e, true);
            }
            return;
        }
        deps.openNameDialog({
            title: clip.cut ? '移动' : '粘贴',
            label: '新名称',
            value: suggested,
            selectStem: !item.isDir,
            okLabel: clip.cut ? '移动' : '粘贴',
            onSubmit: async (name) => {
                const result = await runPasteItems({items, cut: clip.cut}, destDir, {[item.path]: name});
                if (result.failCount) throw new Error(result.firstError);
            },
        });
        return;
    }
    const names = {};
    let renamed = 0;
    for (const item of items) {
        try {
            const suggested = await deps.backend.SuggestCopyName(destDir, item.name, item.isDir);
            if (suggested !== item.name) {
                names[item.path] = suggested;
                renamed++;
            }
        } catch (e) {
            deps.flash('粘贴失败：' + e, true);
            return;
        }
    }
    try {
        const result = await runPasteItems({items, cut: clip.cut}, destDir, names);
        if (result.failCount) {
            deps.flash('已粘贴 ' + result.okCount + ' 项，' + result.failCount + ' 项失败：' + result.firstError, true);
        } else {
            deps.flash((clip.cut ? '已移动 ' : '已粘贴 ') + result.okCount + ' 项' +
                (renamed ? '（' + renamed + ' 项自动重命名）' : '') +
                (skipped ? '，跳过 ' + skipped + ' 项' : ''));
        }
    } catch (e) {
        deps.flash('粘贴失败：' + e, true);
    }
}

function openCreateEntryDialog(dirPath, isDir, suggestedName, title, initialContent) {
    deps.openNameDialog({
        title: title || (isDir ? '新建文件夹' : '新建文件'),
        label: isDir ? '文件夹名称' : '文件名',
        value: suggestedName || '',
        placeholder: isDir ? '例如：config' : '例如：data.json',
        selectStem: !isDir,
        okLabel: '创建',
        onSubmit: async (name) => {
            if (!deps.backend.CreateEntry) throw new Error('当前版本不支持新建');
            const target = await deps.backend.CreateEntry(dirPath, name, isDir);
            // 自定义模板：CreateEntry 建的是空文件（O_EXCL），模板正文随后由 SaveFile 写入。
            const body = !isDir && initialContent ? String(initialContent) : '';
            if (body && deps.backend.SaveFile) await deps.backend.SaveFile(target, body, 'lf', false, 'utf-8');
            if (deps.explorer) {
                await deps.explorer.refreshDir(dirPath);
                deps.explorer.selectPath(target, isDir);
            }
            if (isDir) {
                deps.flash('已新建文件夹：' + name.trim());
            } else {
                await deps.openPath(target);
            }
            // 新建可撤销：撤销删除（进回收站），重做则重新创建同名条目并回填模板正文
            history.push({
                label: '新建“' + deps.baseNameOf(target) + '”',
                undo: async () => {
                    if (!deps.backend.DeleteEntry) return false;
                    await deps.backend.DeleteEntry(target);
                    afterHistoryChange([target]);
                    return true;
                },
                redo: async () => {
                    const created = await deps.backend.CreateEntry(dirPath, deps.baseNameOf(target), isDir);
                    if (body && deps.backend.SaveFile) await deps.backend.SaveFile(created, body, 'lf', false, 'utf-8');
                    afterHistoryChange([created]);
                    if (deps.explorer) await deps.explorer.refreshDir(dirPath);
                    return true;
                },
            });
        },
    });
}

// 打开「通用设置」并滚到「新建菜单」小节（右键子菜单底部的「配置菜单…」入口）。
function openNewFileMenuSettings() {
    if (!deps.openSettings) return;
    deps.openSettings('general');
    requestAnimationFrame(() => {
        const section = document.getElementById('new-file-menu-settings');
        if (section && typeof section.scrollIntoView === 'function') section.scrollIntoView({block: 'start'});
    });
}

// newFileMenuItems：按 settings.newFileMenu 合成「新建」子菜单。
// 只决定「出现与顺序」，不绕过 readOnlyMode（入口在 showExplorerMenu 里整体禁用，这里再兜一层）。
function newFileMenuItems(dirPath) {
    const {top, more} = resolveNewFileMenu(deps.settings && deps.settings.newFileMenu);
    const readOnly = !!(deps.settings && deps.settings.readOnlyMode);
    const createType = (type) => openCreateEntryDialog(
        dirPath, false, type.name, '新建 ' + type.label, type.content);
    const items = [];
    let specials = 0;
    let types = 0;
    for (const entry of top) {
        if (entry.kind === 'special') {
            specials += 1;
            if (entry.id === 'file.dialog') {
                items.push({label: entry.label, icon: 'E7C3', disabled: readOnly,
                    action: () => openCreateEntryDialog(dirPath, false, '', '新建文件')});
            } else if (entry.id === 'dir.dialog') {
                items.push({label: entry.label, icon: 'E8B7', disabled: readOnly,
                    action: () => openCreateEntryDialog(dirPath, true, '新建文件夹', '新建文件夹')});
            } else if (entry.id === 'scratch') {
                // 临时文件落盘草稿的编排可能落在本模块或经 deps 注入（另一项功能负责），
                // 两种位置都认；尚未接入时保留灰占位，不给点了没反应的条目。
                const scratchFn = typeof createScratchFile === 'function' ? createScratchFile
                    : (typeof deps.createScratchFile === 'function' ? deps.createScratchFile : null);
                items.push({label: entry.label, icon: 'doc', disabled: readOnly || !scratchFn,
                    action: !readOnly && scratchFn ? () => scratchFn(dirPath) : undefined});
            }
            continue;
        }
        if (specials && !types) items.push({sep: true});
        types += 1;
        items.push({...fileTypeMenuItem(entry, createType), disabled: readOnly});
    }
    if (more.length) {
        items.push({sep: true});
        items.push({
            label: '更多', icon: 'more', disabled: readOnly,
            submenu: more.map((type) => fileTypeMenuItem(type, createType)),
        });
    }
    items.push({sep: true});
    items.push({label: '配置菜单…', icon: 'gear', action: openNewFileMenuSettings});
    return items;
}

function applyRenamedPath(oldPath, newPath) {
    let activeChanged = false;
    for (const doc of deps.docs) {
        if (!doc.path) continue;
        const next = remapPathValue(doc.path, oldPath, newPath);
        if (next === doc.path) continue;
        doc.path = next;
        doc.name = deps.baseNameOf(next);
        if (doc === deps.file) activeChanged = true;
    }
    if (deps.workspaceFolder) {
        const next = remapPathValue(deps.workspaceFolder, oldPath, newPath);
        if (next !== deps.workspaceFolder) {
            deps.workspaceFolder = next;
            deps.renderWorkspaceCrumbs();
        }
    }
    for (const entry of deps.closedTabs) {
        if (entry.path) entry.path = remapPathValue(entry.path, oldPath, newPath);
    }
    if (deps.fileClipboard) {
        for (const item of deps.fileClipboard.items) {
            const next = remapPathValue(item.path, oldPath, newPath);
            if (next === item.path) continue;
            item.path = next;
            item.name = deps.baseNameOf(next);
        }
    }
    if (deps.explorer) {
        deps.explorer.pathRenamed(oldPath, newPath);
        if (deps.fileClipboard && deps.fileClipboard.cut) deps.explorer.setCutPaths(deps.fileClipboard.items.map((item) => item.path));
        if (activeChanged && deps.file) deps.explorer.setActive(deps.file.path);
    }
    if (activeChanged && deps.file) {
        deps.setFilename(deps.file.name, deps.file.path);
        deps.renderBreadcrumb(deps.file.path);
        deps.updateWindowTitle();
    }
    deps.renderTabs();
    deps.flash('已重命名为：' + deps.baseNameOf(newPath));
}

// 真正执行删除并做联动（关闭文档 / 清剪贴板 / 差量刷新 / 留痕）。
// deleteExplorerEntries 与历史回放共用，避免两套逻辑分叉。
async function performDelete(items, opts) {
    const skipLog = !!(opts && opts.skipLog);
    const deleted = [];
    const failures = [];
    for (const item of items) {
        try {
            await deps.backend.DeleteEntry(item.path);
            deleted.push(item);
        } catch (e) {
            failures.push(item.name + '：' + ((e && e.message) || e));
        }
    }
    if (deleted.length) {
        for (const doc of deps.docs.slice()) {
            if (!doc.path) continue;
            if (deleted.some((item) =>
                item.isDir ? pathWithinValue(item.path, doc.path) : samePathValue(item.path, doc.path))) {
                deps.closeDocNow(doc, false);
            }
        }
        deps.closedTabs = deps.closedTabs.filter((entry) => !deleted.some((item) =>
            item.isDir ? pathWithinValue(item.path, entry.path) : samePathValue(item.path, entry.path)));
        if (deps.fileClipboard && deps.fileClipboard.cut) {
            deps.fileClipboard.items = deps.fileClipboard.items.filter((item) => !deleted.some((target) =>
                target.isDir ? pathWithinValue(target.path, item.path) : samePathValue(target.path, item.path)));
            if (!deps.fileClipboard.items.length) deps.fileClipboard = null;
        }
        if (deps.explorer) {
            for (const item of deleted) deps.explorer.removePath(item.path);
            deps.explorer.setCutPaths(deps.fileClipboard && deps.fileClipboard.cut ? deps.fileClipboard.items.map((item) => item.path) : []);
            deps.explorer.refresh();
        }
        // 操作留痕：逐项记录（回收站可撤销，故记路径而非仅计数）。回放不重复记。
        if (!skipLog) {
            for (const item of deleted) {
                deps.activityLog.log('file.delete', item.path, {count: deleted.length, toRecycle: true});
            }
        }
    }
    if (failures.length) {
        deps.flash('删除失败：' + failures[0] + (failures.length > 1 ? '（另有 ' + (failures.length - 1) + ' 项失败）' : ''), true);
        return false;
    }
    deps.flash(deleted.length > 1 ? '已删除 ' + deleted.length + ' 个项目' : '已删除：' + deleted[0].name);
    return true;
}

// 从系统回收站还原（撤销删除）；整批全部成功才算成功，避免栈状态与实际文件不一致。
async function performRestore(items) {
    if (!deps.backend.RestoreEntry) {
        deps.flash('当前版本不支持从回收站还原', true);
        return false;
    }
    const failures = [];
    for (const item of items) {
        try {
            await deps.backend.RestoreEntry(item.path);
            afterHistoryChange([item.path]);
        } catch (e) {
            failures.push(item.name + '：' + ((e && e.message) || e));
        }
    }
    if (failures.length) {
        deps.flash('还原失败：' + failures[0] + (failures.length > 1 ? '（另有 ' + (failures.length - 1) + ' 项失败）' : ''), true);
        return false;
    }
    deps.flash(items.length > 1 ? '已还原 ' + items.length + ' 个项目' : '已还原：' + items[0].name);
    return true;
}

function deleteExplorerEntries(targets) {
    const list = clipboardItems(targets);
    if (!list.length) return;
    if (!deps.backend.DeleteEntry) {
        deps.flash('当前版本不支持删除', true);
        return;
    }
    if (deps.settings.readOnlyMode) {
        deps.flash('只读模式下不能删除', true);
        return;
    }
    const rootPath = deps.explorer && deps.explorer.getRoot ? deps.explorer.getRoot() : '';
    const deletable = list.filter((item) => !(rootPath && samePathValue(rootPath, item.path)));
    if (!deletable.length) {
        deps.flash('不能删除文件树的根目录', true);
        return;
    }
    const openDocs = deps.docs.filter((doc) => doc.path && deletable.some((item) =>
        item.isDir ? pathWithinValue(item.path, doc.path) : samePathValue(item.path, doc.path)));
    const dirty = openDocs.some((doc) => doc.dirty);
    const what = deletable.length === 1 ? '“' + deletable[0].name + '”' : '选中的 ' + deletable.length + ' 个项目';
    const message = dirty
        ? what + '已打开且有未保存的修改，删除后这些修改会一并丢失。\n确定移到回收站吗？'
        : what + '将被移到回收站，确定继续吗？';
    deps.openConfirmDialog(message, async () => {
        const items = deletable.map((item) => ({...item}));
        const ok = await performDelete(items);
        if (ok) {
            const label = items.length > 1 ? '删除 ' + items.length + ' 项' : '删除“' + items[0].name + '”';
            history.push({
                label,
                undo: () => performRestore(items),
                redo: () => performDelete(items, {skipLog: true}),
            });
        }
    }, '删除', '删除', 'danger');
}

// 重命名到指定路径并做全链联动；正向与撤销共用。
async function performRename(path, newName, opts) {
    const newPath = await deps.backend.RenameEntry(path, newName);
    if (!newPath || newPath === path) return false;
    applyRenamedPath(path, newPath);
    afterHistoryChange([path, newPath]);
    if (!(opts && opts.quiet)) deps.activityLog.log('file.rename', newPath, {from: deps.actRel(path)});
    return {newPath};
}

function openRenameEntryDialog(info) {
    deps.openNameDialog({
        title: info.isDir ? '重命名文件夹' : '重命名文件',
        label: '新名称',
        value: info.name,
        selectStem: !info.isDir,
        okLabel: '重命名',
        onSubmit: async (name) => {
            if (!deps.backend.RenameEntry) throw new Error('当前版本不支持重命名');
            const oldPath = info.path;
            const oldName = deps.baseNameOf(oldPath);
            const result = await performRename(oldPath, name);
            if (!result) return;
            const newPath = result.newPath;
            const label = '重命名“' + oldName + '”';
            history.push({
                label,
                undo: () => performRename(newPath, oldName, {quiet: true}),
                redo: () => performRename(oldPath, name, {quiet: true}),
            });
        },
    });
}

function relativePathFrom(path, root) {
    if (!path || !root) return '';
    const target = String(path).replace(/\\/g, '/');
    const base = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
    if (!base) return '';
    const lowerTarget = target.toLowerCase();
    const lowerBase = base.toLowerCase();
    if (lowerTarget === lowerBase) return '.';
    if (!lowerTarget.startsWith(lowerBase + '/')) return '';
    return target.slice(base.length + 1);
}

function copyPathMenuItems(targets) {
    const list = clipboardItems(targets);
    const root = deps.workspaceFolder || (deps.explorer && deps.explorer.getRoot ? deps.explorer.getRoot() : '');
    const absolute = list.map((item) => item.path).join('\r\n');
    const relativeParts = list.map((item) => relativePathFrom(item.path, root));
    const relative = relativeParts.every(Boolean) ? relativeParts.join('\r\n') : '';
    const names = list.map((item) => item.name).join('\r\n');
    return [
        {label: '绝对路径', disabled: !absolute, action: () => deps.copyText(absolute, '绝对路径')},
        {label: '相对路径', disabled: !relative, action: () => deps.copyText(relative, '相对路径')},
        {sep: true},
        {label: '文件名', disabled: !names, action: () => deps.copyText(names, '文件名')},
    ];
}

async function undoExplorer() {
    if (!history.canUndo()) return false;
    const label = history.peekUndo();
    const ok = await history.undo();
    if (ok) deps.flash('已撤销：' + label);
    return ok;
}

async function redoExplorer() {
    if (!history.canRedo()) return false;
    const label = history.peekRedo();
    const ok = await history.redo();
    if (ok) deps.flash('已重做：' + label);
    return ok;
}

function showExplorerMenu(info, x, y) {
    if (!deps.ctxMenu || !info) return;
    const isDir = !!info.isDir;
    const selected = deps.explorer ? deps.explorer.getSelection() : [];
    const targets = selected.length ? selected : [{path: info.path, name: info.name, isDir}];
    const rootPath = deps.explorer && deps.explorer.getRoot ? deps.explorer.getRoot() : '';
    const deletable = targets.filter((item) => !(rootPath && samePathValue(rootPath, item.path)));
    const items = [];
    if (isDir) {
        items.push({
            label: '新建',
            icon: 'E710',
            disabled: !!deps.settings.readOnlyMode,
            submenu: newFileMenuItems(info.path),
        });
        items.push({label: '作为书籍阅读', icon: 'E8A5', action: () => deps.readingMode && deps.readingMode.openBook(info.path)});
        items.push({label: '用默认应用打开', icon: 'E8E5', action: () => deps.openWithDefaultApp(info.path)});
    } else {
        items.push({label: '打开', icon: 'E8E5', action: () => deps.openPath(info.path)});
        items.push({label: '以只读打开', icon: 'E8E5', action: () => deps.openPath(info.path, {readOnly: true})});
        items.push({label: '用默认应用打开', icon: 'E8E5', action: () => deps.openWithDefaultApp(info.path)});
        items.push({label: '在新窗口中打开', icon: 'E8A7', action: () => deps.openInNewWindows([info.path])});
        if (deps.readingMode && /\.(md|markdown|mdx|txt|docx|epub)$/i.test(info.name || '')) {
            items.push({label: '阅读此文件', icon: 'E8A5', action: () => deps.readingMode.openSingleFile(info.path)});
        }
        items.push(...deps.aiReferenceFileMenuItems({path: info.path, name: info.name}));
        if (deps.gitStateCache.map.get(info.path.replace(/\\/g, '/'))) {
            items.push({label: 'Git：查看差异', icon: 'E8D3', action: () => deps.showGitDiff(info.path)});
        }
        const compareTargets = selected.filter((item) => item && item.path && !item.isDir);
        if (compareTargets.length === 2) {
            items.push({
                label: '比较这两个文件…',
                icon: 'E8A5',
                action: () => deps.openDiffDialog(compareTargets[0].path, compareTargets[1].path),
            });
        }
    }
    items.push({sep: true});
    items.push({label: '复制', shortcut: 'Ctrl+C', icon: 'E8C8', action: () => setFileClipboard(targets, false)});
    items.push({
        label: '剪切',
        shortcut: 'Ctrl+X',
        icon: 'E8C6',
        disabled: !!deps.settings.readOnlyMode,
        action: () => setFileClipboard(targets, true),
    });
    items.push({
        label: '粘贴',
        shortcut: 'Ctrl+V',
        icon: 'E77F',
        disabled: !!deps.settings.readOnlyMode || !deps.fileClipboard || !deps.fileClipboard.items.length,
        action: () => pasteFileClipboard(info),
    });
    items.push({sep: true});
    if (isDir) {
        items.push({label: '设为文件树根目录', icon: 'E8B7', action: () => deps.openFolderWorkspace(info.path)});
        items.push({
            label: '结构化目录',
            iconHtml: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4.5h14M5.5 8.5h11.5M8 12.5h9M10.5 16.5h6.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
            submenu: [
                {label: '复制', icon: 'E8C8', action: () => deps.copyStructuredDir(info.path)},
                {label: '导出…', icon: 'E74E', action: () => deps.exportStructuredDir(info.path)},
            ],
        });
        items.push({sep: true});
    }
    items.push({
        label: '重命名…',
        icon: 'E8AC',
        disabled: !!deps.settings.readOnlyMode || targets.length !== 1,
        action: () => openRenameEntryDialog(info),
    });
    items.push({
        label: '删除',
        shortcut: 'Delete',
        icon: 'E74D',
        danger: true,
        disabled: !!deps.settings.readOnlyMode || !deletable.length,
        action: () => deleteExplorerEntries(targets),
    });
    items.push({label: '复制路径', icon: 'E8C8', submenu: copyPathMenuItems(targets)});
    items.push({label: '在文件管理器中显示', icon: 'E8B7', action: () => deps.showPathInFolder(info.path)});
    items.push({sep: true});
    items.push({label: '刷新', icon: 'E72C', action: () => deps.explorer && deps.explorer.refresh()});
    items.push({sep: true});
    items.push({label: '属性…', icon: 'E946', action: () => deps.showFileProperties(info.path)});
    deps.ctxMenu.open(items, x, y);
}

    return {
        remapPathValue,
        parentFolderOf,
        samePathValue,
        pathWithinValue,
        clipboardItems,
        setFileClipboard,
        applyMovedPath,
        runPasteItems,
        moveEntriesByDrag,
        pasteFileClipboard,
        openCreateEntryDialog,
        newFileMenuItems,
        applyRenamedPath,
        deleteExplorerEntries,
        openRenameEntryDialog,
        undoExplorer,
        redoExplorer,
        canUndoExplorer: () => history.canUndo(),
        canRedoExplorer: () => history.canRedo(),
        relativePathFrom,
        copyPathMenuItems,
        showExplorerMenu,
    };
}
