// 格式识别纯函数测试：仓库元信息约定名的支持、代码视图判定与 Ace 高亮模式映射。
// 用法：npm test（package.json 的 test 脚本里显式列出本文件）
import test from 'node:test';
import assert from 'node:assert/strict';

import {aceModeFor, isKnownCodeFileName, isSupportedFile} from './formats.js';

test('仓库元信息约定名受支持且按代码文件名处理', () => {
    for (const name of ['LICENSE', 'licence', 'NOTICE', 'COPYING', 'AUTHORS', 'CONTRIBUTORS',
        'CONTRIBUTING', 'CHANGELOG', 'CODEOWNERS', 'SECURITY', 'MAINTAINERS']) {
        assert.ok(isSupportedFile(name), name + ' 应受支持（可从文件树打开）');
        assert.ok(isKnownCodeFileName(name), name + ' 应按代码文件名处理');
    }
});

test('npm / git 配置 dotfile 映射到正确的高亮模式', () => {
    assert.equal(aceModeFor('.npmrc'), 'ace/mode/ini');
    assert.equal(aceModeFor('.gitconfig'), 'ace/mode/ini');
    assert.equal(aceModeFor('.npmignore'), 'ace/mode/gitignore');
    assert.ok(isKnownCodeFileName('.npmrc'));
    assert.ok(isKnownCodeFileName('.gitconfig'));
});

test('既有映射不受影响，普通未知名仍回退 text', () => {
    assert.equal(aceModeFor('Dockerfile'), 'ace/mode/dockerfile');
    assert.equal(aceModeFor('.gitignore'), 'ace/mode/gitignore');
    assert.equal(aceModeFor('Makefile'), 'ace/mode/makefile');
    assert.equal(aceModeFor('randomfile'), 'ace/mode/text');
    assert.ok(!isKnownCodeFileName('randomfile'));
    assert.ok(!isSupportedFile('randomfile'));
});
