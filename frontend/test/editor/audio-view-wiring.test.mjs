// 音频视图接线护栏：wav/mp3/ogg/flac 进「音频视图」，播放源走 /__local 令牌通道（Range 由 Go 侧处理），
// 解码失败回退二进制视图。少接一处就会出现「音频标签打开是十六进制」或「关不掉、还在响」。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {formats, isSupportedFile, audioExtensions} from '../../src/core/formats.js';
import {fileIconSpec} from '../../src/core/fileicons.js';

const src = (rel) => readFileSync(fileURLToPath(new URL('../../src/' + rel, import.meta.url)), 'utf8');

test('formats：音频有独立驱动与扩展名表', () => {
    assert.equal(formats.audio.id, 'audio');
    assert.equal(formats.audio.audio, true);
    assert.equal(formats.audio.rawOnly, true);
    for (const ext of ['wav', 'mp3', 'ogg', 'flac', 'm4a']) {
        assert.ok(audioExtensions.includes(ext), ext + ' 应在 audioExtensions 里');
    }
    assert.equal(isSupportedFile('clip.wav'), true);
    assert.equal(isSupportedFile('clip.mp3'), true);
});

test('视图选项：音频文档给音频/二进制/文本三档，文案与禁用判定齐全', () => {
    const w = src('writing/writing-ui.js');
    assert.match(w, /const AUDIO_VIEWS = \[\['audio', '音频视图'\]/);
    assert.match(w, /if \(fmt && fmt\.audio\) return AUDIO_VIEWS;/);
    assert.match(w, /if \(mode === 'audio'\) return '音频视图';/);
    assert.match(w, /if \(mode === 'audio'\) return !deps\.file\.audio;/);
});

test('文档层：音频标记落到 createDoc 与首屏视图', () => {
    const g = src('editor/editor-groups.js');
    assert.match(g, /data\.audio \? formats\.audio : formats\.bytes/);
    assert.match(g, /audio: !!data\.audio/);
    assert.match(g, /mode: defaultMediaMode\(data\) \|\| 'binary'/, '首屏视图走媒体默认单一来源');
    assert.match(g, /const audioRequested = !!fmt\.audio && doc\.mode === 'audio';/);
    assert.match(g, /!!fmt\.video \|\| !!fmt\.audio \|\| fmt\.id === 'bytes'/);
    assert.match(g, /if \(fmt\.audio\) createAudioView\(doc\);/);
    assert.match(g, /if \(audioRequested\) showAudioView\(doc\);/);
    assert.match(g, /audio: 'view-audio'/, '标签条的视图按钮要有图标（注册表 view-audio 键）');
    assert.match(g, /if \(mode === 'audio'\) return !doc\.audio;/);
});

test('默认视图：持久化的 binary 不得盖掉媒体视图（恢复与保存两侧都守）', () => {
    const f = src('core/formats.js');
    assert.match(f, /export function defaultMediaMode\(source\)/);
    assert.match(f, /if \(source\.audio\) return 'audio';/);
    const r = src('shell/session-restore.js');
    assert.match(r, /import \{defaultMediaMode\} from '\.\.\/core\/formats\.js';/);
    // 恢复：媒体文档优先用自己的视图，旧会话里的 binary / text 不参与
    assert.match(r, /const mode = defaultMediaMode\(current\) \|\| \(sess\.modes && sess\.modes\[current\.path\]\);/);
    // 保存：媒体文档只记自己的媒体视图
    assert.match(r, /modes\[d\.path\] = defaultMediaMode\(d\) \|\| /);
});

test('生命周期：切标签先暂停，关标签先断源再摘节点', () => {
    const g = src('editor/editor-groups.js');
    assert.match(g, /pauseAudioInDoc\(deps\.file\);/);
    assert.match(g, /releaseAudio\(doc\);/);
    const sp = src('editor/editor-split-preview.js');
    assert.match(sp, /function releaseAudio\(doc\)[\s\S]*?removeAttribute\('src'\)/);
    assert.match(sp, /if \(!node \|\| node\.paused\) return;/);
});

test('播放源：走 /__local 令牌通道，不把音频读成 base64', () => {
    const sp = src('editor/editor-split-preview.js');
    assert.match(sp, /deps\.backend\.RegisterPreviewRoot\(root\)/);
    assert.match(sp, /doc\.audioSrc = '\/__local\/' \+ token/);
    assert.doesNotMatch(sp, /ReadAudioAsDataURL/);
});

test('失败回退：解不了就切二进制视图并说清原因', () => {
    const sp = src('editor/editor-split-preview.js');
    assert.match(sp, /function audioErrorMessage\(code\)/);
    assert.match(sp, /deps\.switchMode\('binary'\)/);
    const ms = src('shell/mode-switch.js');
    assert.match(ms, /if \(mode === 'audio'\) \{[\s\S]*?deps\.enterAudioView\(doc\)/);
    assert.match(ms, /deps\.currentMode === 'audio' && doc\) deps\.hideAudioView\(doc\)/);
});

test('横幅与右键菜单：音频视图不弹「二进制文件」提示，也不接管右键', () => {
    assert.match(src('editor/editor-doc-extras.js'), /data\.audio && data\.mode === 'audio'/);
    assert.match(src('editor/editor-menus.js'), /deps\.currentMode === 'audio'/);
});

test('样式：audio-active 能盖住 Ace，覆盖层本身默认不显示', () => {
    const css = src('style.css');
    const sp = src('editor/editor-split-preview.js');
    assert.match(sp, /doc\.pane\.classList\.add\('audio-active'\)/);
    assert.match(sp, /doc\.pane\.classList\.remove\('audio-active'\)/);
    assert.match(css, /\.jsoneditor-pane\.audio-active > \.jsoneditor \{ display: none !important; \}/);
    assert.match(css, /\.jsoneditor-pane\.audio-active \.audio-preview-view \{ display: flex;/);
});

test('文件图标：常见音频扩展名都有专用图标', () => {
    for (const ext of ['wav', 'mp3', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'weba', 'wma']) {
        assert.equal(fileIconSpec('clip.' + ext).id, 'audio', ext + ' 应有 audio 图标');
    }
    assert.match(src('style.css'), /\.fi-audio \{ color: var\(--accent\); \}/);
});
