// 「用默认应用打开」：标签页右键与文件树右键都要有，且无路径时禁用。
// 这条菜单项走 backend.OpenWithDefaultApp（ShellExecute），不经过命令行，
// 空格 / 中文路径不会被拆断。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createEditorExportMenus} from '../../src/editor/editor-export-menus.js';
import {createExplorerOps} from '../../src/explorer/explorer-ops.js';

const LABEL = '用默认应用打开';

function tabMenuFor(doc, calls) {
    let items = null;
    const deps = {
        ctxMenu: {open: (list) => { items = list; }},
        groupOfDoc: () => ({id: 'g1'}),
        groupDocs: () => [doc],
        docs: [doc],
        closedTabs: [],
        aiReferenceFileMenuItems: () => [],
        requestCloseDoc: () => {},
        closeDocsWithConfirm: () => {},
        copyText: () => {},
        showPathInFolder: () => {},
        openWithDefaultApp: (path) => calls.push(path),
        openDiffDialog: () => {},
        openInNewWindows: () => {},
        reopenClosedTab: () => {},
        setDocReadOnly: () => {},
    };
    const mod = createEditorExportMenus(deps);
    mod.showTabMenu(doc, 10, 10);
    return items;
}

function explorerMenuFor(info, calls) {
    let items = null;
    const deps = {
        ctxMenu: {open: (list) => { items = list; }},
        explorer: {
            getSelection: () => [],
            getRoot: () => 'D:/ws',
            toggleNode: () => {},
            refresh: () => {},
        },
        settings: {},
        fileClipboard: null,
        gitStateCache: {map: new Map()},
        workspaceFolder: 'D:/ws',
        aiReferenceFileMenuItems: () => [],
        openPath: () => {},
        openInNewWindows: () => {},
        openWithDefaultApp: (path) => calls.push(path),
        showPathInFolder: () => {},
        showFileProperties: () => {},
        showGitDiff: () => {},
        openDiffDialog: () => {},
        openFolderWorkspace: () => {},
        copyStructuredDir: () => {},
        exportStructuredDir: () => {},
        copyText: () => {},
        flash: () => {},
        readingMode: null,
        openRenameEntryDialog: () => {},
        newFileTypeMenuItems: () => [],
    };
    const mod = createExplorerOps(deps);
    mod.showExplorerMenu(info, 10, 10, null);
    return items;
}

test('标签页右键菜单：有路径时启用，点击把路径交给后端', () => {
    const calls = [];
    const doc = {id: 3, name: 'sample.json', path: 'D:/data/sample.json'};
    const item = tabMenuFor(doc, calls).find((i) => i.label === LABEL);
    assert.ok(item, '标签页菜单里应有「用默认应用打开」');
    assert.equal(!!item.disabled, false);
    item.action();
    assert.deepEqual(calls, ['D:/data/sample.json']);
});

test('标签页右键菜单：虚拟标签 / 未落盘文档没有路径，菜单项禁用', () => {
    const doc = {id: 4, name: '未命名', path: null};
    const item = tabMenuFor(doc, []).find((i) => i.label === LABEL);
    assert.ok(item);
    assert.equal(item.disabled, true);
});

test('文件树右键菜单：文件与目录都有「用默认应用打开」且动作正确', () => {
    const fileCalls = [];
    const fileItem = explorerMenuFor({path: 'D:/ws/a.json', name: 'a.json', isDir: false}, fileCalls)
        .find((i) => i.label === LABEL);
    assert.ok(fileItem, '文件菜单里应有「用默认应用打开」');
    fileItem.action();
    assert.deepEqual(fileCalls, ['D:/ws/a.json']);

    const dirCalls = [];
    const dirItem = explorerMenuFor({path: 'D:/ws/sub', name: 'sub', isDir: true}, dirCalls)
        .find((i) => i.label === LABEL);
    assert.ok(dirItem, '目录菜单里应有「用默认应用打开」');
    dirItem.action();
    assert.deepEqual(dirCalls, ['D:/ws/sub']);
});
