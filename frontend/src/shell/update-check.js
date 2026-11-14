// update-check.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。


export function createUpdateCheck(deps) {


let updateChecking = false;

function openUpdateDialog() {
    deps.elsDialogs.updateStatus.className = 'update-status';
    deps.elsDialogs.updateStatus.textContent = '正在检查更新…';
    deps.elsDialogs.updateNotes.classList.add('hidden');
    deps.elsDialogs.updateNotes.textContent = '';
    deps.elsDialogs.updateDownload.classList.add('hidden');
    deps.elsDialogs.updateDownload.onclick = null;
    deps.elsDialogs.updatePage.classList.add('hidden');
    deps.elsDialogs.updatePage.onclick = null;
    deps.openDialogEl(deps.elsDialogs.update);
}

function renderUpdateResult(info) {
    const status = deps.elsDialogs.updateStatus;
    const pageUrl = info.pageUrl || deps.appReleasesUrl;
    status.className = 'update-status';
    if (info.status === 'no-release') {
        status.textContent = 'Gitee 仓库尚未发布正式版本。当前版本 ' + info.currentVersion + '。';
        status.classList.add('muted');
        deps.elsDialogs.updatePage.classList.remove('hidden');
        deps.elsDialogs.updatePage.onclick = () => deps.openExternalUrl(pageUrl);
        return;
    }
    if (!info.hasUpdate) {
        status.textContent = '当前已是最新版本 ' + info.currentVersion + '。';
        status.classList.add('muted');
        return;
    }
    const date = info.publishedAt ? '，发布于 ' + String(info.publishedAt).slice(0, 10) : '';
    status.textContent = '发现新版本 ' + info.latestVersion + '（当前 ' + info.currentVersion + '）' + date + '。';
    if (info.notes) {
        deps.elsDialogs.updateNotes.innerHTML = deps.renderMarkdownHtml(info.notes);
        deps.elsDialogs.updateNotes.classList.remove('hidden');
        deps.elsDialogs.updateNotes.querySelectorAll('a').forEach((a) => {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                deps.openExternalUrl(a.getAttribute('href'));
            });
        });
    }
    if (info.downloadUrl) {
        deps.elsDialogs.updateDownload.classList.remove('hidden');
        deps.elsDialogs.updateDownload.onclick = () => deps.openExternalUrl(info.downloadUrl);
    }
    if (pageUrl) {
        deps.elsDialogs.updatePage.classList.remove('hidden');
        deps.elsDialogs.updatePage.onclick = () => deps.openExternalUrl(pageUrl);
    }
}

// ---- 启动时自动检查更新（可在设置关闭）——结果只走消息中心（toast + 常驻列表），
// 不再占用底部状态栏：状态栏是工作区信息位，消息类内容一律进消息中心。
async function autoCheckUpdateOnStart() {
    if (!deps.backend.CheckForUpdates || deps.settings.autoCheckUpdate === false) return;
    if (updateChecking) return;
    updateChecking = true;
    try {
        const info = await deps.backend.CheckForUpdates();
        if (!info) throw new Error('未返回更新信息');
        if (info.hasUpdate && info.status !== 'no-release') {
            // 版本更新进消息中心（弹一条 toast，消息常驻列表，点击本条打开更新对话框）
            if (typeof deps.addMessage === 'function') {
                deps.addMessage({
                    kind: 'update',
                    title: '发现新版本 ' + info.latestVersion,
                    body: '当前 ' + info.currentVersion + (info.publishedAt ? '，发布于 ' + String(info.publishedAt).slice(0, 10) : '') + '。点击本条通知查看详情与下载。',
                    actionId: 'open-update-dialog',
                }, {toast: true});
            }
        }
        // 已是最新 / 未发布版本 / 检查失败：静默（失败记调试日志）
    } catch (e) {
        deps.logFrontend('error', '自动检查更新失败：' + e);
    } finally {
        updateChecking = false;
    }
}

async function checkForUpdates() {
    if (updateChecking) return;
    updateChecking = true;
    openUpdateDialog();
    try {
        if (!deps.backend.CheckForUpdates) throw new Error('当前版本不支持检查更新');
        const info = await deps.backend.CheckForUpdates();
        if (!info) throw new Error('未返回更新信息');
        renderUpdateResult(info);
    } catch (e) {
        deps.elsDialogs.updateStatus.className = 'update-status error';
        deps.elsDialogs.updateStatus.textContent = '检查更新失败：' + e;
        deps.elsDialogs.updatePage.classList.remove('hidden');
        deps.elsDialogs.updatePage.onclick = () => deps.openExternalUrl(deps.appReleasesUrl);
        deps.logFrontend('error', '检查更新失败：' + e);
    } finally {
        updateChecking = false;
    }
}

async function checkForUpdatesInline() {
    const btn = document.getElementById('about-check-update');
    const status = document.getElementById('about-update-status');
    if (!btn || !status) return;
    btn.disabled = true;
    status.className = 'about-update-status';
    status.textContent = '正在检查…';
    try {
        if (!deps.backend.CheckForUpdates) throw new Error('当前版本不支持检查更新');
        const info = await deps.backend.CheckForUpdates();
        if (!info) throw new Error('未返回更新信息');
        status.className = 'about-update-status';
        status.textContent = '';
        if (info.status === 'no-release') {
            status.textContent = '仓库尚未发布版本，当前 ' + info.currentVersion;
            status.classList.add('muted');
        } else if (!info.hasUpdate) {
            status.textContent = '已是最新版本 ' + info.currentVersion;
            status.classList.add('muted');
        } else {
            status.textContent = '发现新版本 ' + info.latestVersion;
            const link = document.createElement('a');
            link.className = 'about-update-link';
            link.textContent = info.downloadUrl ? '下载安装包' : '打开发布页';
            link.addEventListener('click', (e) => {
                e.preventDefault();
                deps.openExternalUrl(info.downloadUrl || info.pageUrl || deps.appReleasesUrl);
            });
            status.appendChild(link);
        }
    } catch (e) {
        status.className = 'about-update-status error';
        status.textContent = '检查失败：' + e;
        deps.logFrontend('error', '检查更新失败：' + e);
    } finally {
        btn.disabled = false;
    }
}

document.getElementById('btn-update-close').addEventListener('click', deps.closeDialogs);
document.getElementById('about-check-update').addEventListener('click', checkForUpdatesInline);


    return {autoCheckUpdateOnStart, checkForUpdates};
}
