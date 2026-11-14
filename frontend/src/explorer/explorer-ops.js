// explorer-ops.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 资源管理器域操作：路径改码（重命名/移动/删除联动）、文件剪贴板、
// 新建/重命名/删除对话框、explorer 右键菜单。
//
// deps 由 main.js 显式传入（getter 延迟求值 + 需要回写的状态带 setter）；
// 原 main.js 裸标识符引用已按 deps 名重写为 deps.X。
export function createExplorerOps(deps) {

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

function openCreateEntryDialog(dirPath, isDir, suggestedName, title) {
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
            if (deps.explorer) {
                await deps.explorer.refreshDir(dirPath);
                deps.explorer.selectPath(target, isDir);
            }
            if (isDir) {
                deps.flash('已新建文件夹：' + name.trim());
            } else {
                await deps.openPath(target);
            }
        },
    });
}

function newFileMenuItems(dirPath) {
    return [
        {label: '文件…', icon: 'E7C3', action: () => openCreateEntryDialog(dirPath, false, '', '新建文件')},
        {label: '目录…', icon: 'E8B7', action: () => openCreateEntryDialog(dirPath, true, '新建文件夹', '新建文件夹')},
        {sep: true},
        ...newFileTypeMenuItems((type) => openCreateEntryDialog(dirPath, false, type.name, '新建 ' + type.label)),
    ];
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
    deps.openCloseConfirm(message, async () => {
        const deleted = [];
        const failures = [];
        for (const item of deletable) {
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
            // 操作留痕：逐项记录（回收站可撤销，故记路径而非仅计数）。
            for (const item of deleted) {
                deps.activityLog.log('file.delete', item.path, {count: deleted.length, toRecycle: true});
            }
        }
        if (failures.length) {
            deps.flash('删除失败：' + failures[0] + (failures.length > 1 ? '（另有 ' + (failures.length - 1) + ' 项失败）' : ''), true);
        } else {
            deps.flash(deleted.length > 1 ? '已删除 ' + deleted.length + ' 个项目' : '已删除：' + deleted[0].name);
        }
    }, '删除', '删除');
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
            const newPath = await deps.backend.RenameEntry(info.path, name);
            if (newPath && newPath !== info.path) {
                applyRenamedPath(info.path, newPath);
                deps.activityLog.log('file.rename', newPath, {from: deps.actRel(info.path)});
            }
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

function showExplorerMenu(info, x, y, node) {
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
    } else {
        items.push({label: '打开', icon: 'E8E5', action: () => deps.openPath(info.path)});
        items.push({label: '在新窗口中打开', icon: 'E8A7', action: () => deps.openInNewWindows([info.path])});
        if (deps.readingMode && /\.(md|markdown|mdx|txt|docx|epub)$/i.test(info.name || '')) {
            items.push({label: '阅读此文件', icon: 'E8A5', action: () => deps.readingMode.openSingleFile(info.path)});
        }
        items.push({
            label: '在 AI 中询问此文件',
            iconHtml: deps.AI_REFERENCE_ICON_HTML,
            action: () => deps.askAIAboutPath(info.path),
        });
        items.push(...aiReferenceFileMenuItems({path: info.path, name: info.name}));
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
        items.push({
            label: node && node.expanded ? '收起目录' : '展开目录',
            icon: 'E70D',
            disabled: !node,
            action: () => deps.explorer && deps.explorer.toggleNode(node),
        });
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
        relativePathFrom,
        copyPathMenuItems,
        showExplorerMenu,
    };
}
