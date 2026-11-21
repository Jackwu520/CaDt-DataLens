// 视频视图接线护栏：mp4/webm 进「视频视图」，播放源走 /__local 令牌通道（Range 由 Go 侧处理），
// 解码失败回退二进制视图。少接一处就会出现「视频标签打开是十六进制」或「关不掉、还在响」。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {formats, isSupportedFile, videoExtensions} from '../../src/core/formats.js';
import {fileIconSpec} from '../../src/core/fileicons.js';

const src = (rel) => readFileSync(fileURLToPath(new URL('../../src/' + rel, import.meta.url)), 'utf8');

test('formats：视频有独立驱动与扩展名表', () => {
    assert.equal(formats.video.id, 'video');
    assert.equal(formats.video.video, true);
    assert.equal(formats.video.rawOnly, true);
    for (const ext of ['mp4', 'm4v', 'webm', 'mov']) {
        assert.ok(videoExtensions.includes(ext), ext + ' 应在 videoExtensions 里');
    }
    assert.equal(isSupportedFile('clip.mp4'), true);
    assert.equal(isSupportedFile('clip.webm'), true);
});

test('视图选项：视频文档给视频/二进制/文本三档，文案与禁用判定齐全', () => {
    const w = src('writing/writing-ui.js');
    assert.match(w, /const VIDEO_VIEWS = \[\['video', '视频视图'\]/);
    assert.match(w, /if \(fmt && fmt\.video\) return VIDEO_VIEWS;/);
    assert.match(w, /if \(mode === 'video'\) return '视频视图';/);
    assert.match(w, /if \(mode === 'video'\) return !deps\.file\.video;/);
});

test('文档层：视频标记落到 createDoc 与首屏视图', () => {
    const g = src('editor/editor-groups.js');
    assert.match(g, /format: data\.image \? formats\.image : \(data\.video \? formats\.video : \(data\.audio \? formats\.audio : formats\.bytes\)\)/);
    assert.match(g, /video: !!data\.video/);
    assert.match(g, /mode: defaultMediaMode\(data\) \|\| 'binary'/, '首屏视图走媒体默认单一来源');
    assert.match(g, /const videoRequested = !!fmt\.video && doc\.mode === 'video';/);
    assert.match(g, /const binaryMode = !!fmt\.image \|\| !!fmt\.video \|\| !!fmt\.audio \|\| fmt\.id === 'bytes';/);
    assert.match(g, /if \(fmt\.video\) createVideoView\(doc\);/);
    assert.match(g, /if \(videoRequested\) showVideoView\(doc\);/);
    assert.match(g, /video: 'view-video'/, '标签条的视图按钮要有图标（注册表 view-video 键）');
    assert.match(g, /if \(mode === 'video'\) return !doc\.video;/);
});

test('生命周期：切标签先暂停，关标签先断源再摘节点', () => {
    const g = src('editor/editor-groups.js');
    assert.match(g, /pauseVideoInDoc\(deps\.file\);/);
    assert.match(g, /releaseVideo\(doc\);/);
    const sp = src('editor/editor-split-preview.js');
    assert.match(sp, /function releaseVideo\(doc\)[\s\S]*?removeAttribute\('src'\)/);
    assert.match(sp, /if \(!node \|\| node\.paused\) return;/);
});

test('播放源：走 /__local 令牌通道，不把视频读成 base64', () => {
    const sp = src('editor/editor-split-preview.js');
    assert.match(sp, /deps\.backend\.RegisterPreviewRoot\(root\)/);
    assert.match(sp, /doc\.videoSrc = '\/__local\/' \+ token/);
    assert.doesNotMatch(sp, /ReadVideoAsDataURL/);
});

test('失败回退：解不了就切二进制视图并说清原因', () => {
    const sp = src('editor/editor-split-preview.js');
    assert.match(sp, /function videoErrorMessage\(code\)/);
    assert.match(sp, /HEVC/);
    assert.match(sp, /deps\.switchMode\('binary'\)/);
    const ms = src('shell/mode-switch.js');
    assert.match(ms, /if \(mode === 'video'\) \{[\s\S]*?deps\.enterVideoView\(doc\)/);
    assert.match(ms, /deps\.currentMode === 'video' && doc\) deps\.hideVideoView\(doc\)/);
});

test('横幅与右键菜单：视频视图不弹「二进制文件」提示，也不接管右键', () => {
    assert.match(src('editor/editor-doc-extras.js'), /data\.video && data\.mode === 'video'/);
    assert.match(src('editor/editor-menus.js'), /deps\.currentMode === 'video'/);
});

test('样式：video-active 能盖住 Ace，覆盖层本身默认不显示', () => {
    const css = src('style.css');
    const sp = src('editor/editor-split-preview.js');
    assert.match(sp, /doc\.pane\.classList\.add\('video-active'\)/);
    assert.match(sp, /doc\.pane\.classList\.remove\('video-active'\)/);
    assert.match(css, /\.jsoneditor-pane\.video-active > \.jsoneditor \{ display: none !important; \}/);
    assert.match(css, /\.jsoneditor-pane\.video-active \.video-preview-view \{ display: flex;/);
});

test('文件图标：常见视频扩展名都有专用图标，且不抢 TypeScript 的 .ts', () => {
    for (const ext of ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'flv', 'wmv', 'mpg', 'mpeg', '3gp']) {
        assert.equal(fileIconSpec('clip.' + ext).id, 'video', ext + ' 应有 video 图标');
    }
    assert.equal(fileIconSpec('types.ts').id, 'ts');
    assert.match(src('style.css'), /\.fi-video \{ color: var\(--val-number\); \}/);
});
