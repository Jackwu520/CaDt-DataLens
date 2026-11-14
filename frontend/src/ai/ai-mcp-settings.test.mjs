// ai-mcp-settings.test.mjs：MCP 设置页的纯辅助函数——env 合并（不回显语义）、hint 角标、
// 表单校验、状态灯映射。DOM 逻辑不在此测（与 index.html 联动，靠人工验收）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    mcpMergeEnvRows, mcpToolFlags, mcpValidateServerForm, mcpStatusMeta,
} from './ai-mcp-settings.js';

test('mcpMergeEnvRows：留空 = 保持原值（密码框不回显语义）', () => {
    const existing = {GITHUB_TOKEN: 'secret1', HOME: '/home/x'};
    // 留空 + key 已存在 → 保持原值；显式新值覆盖；新键落盘
    const merged = mcpMergeEnvRows(existing, [
        {key: 'GITHUB_TOKEN', value: ''},          // 不回显的旧值：留空保持
        {key: 'HOME', value: '/new/home'},         // 显式覆盖
        {key: 'NEW_VAR', value: 'abc'},            // 新键
    ]);
    assert.equal(merged.GITHUB_TOKEN, 'secret1');
    assert.equal(merged.HOME, '/new/home');
    assert.equal(merged.NEW_VAR, 'abc');
    // 留空 + key 不存在 → 空值（用户自己加的空值变量）
    assert.equal(mcpMergeEnvRows({}, [{key: 'EMPTY', value: ''}]).EMPTY, '');
    // 空键行跳过；重复键取第一个
    assert.deepEqual(mcpMergeEnvRows({}, [{key: '', value: 'x'}, {key: 'A', value: '1'}, {key: 'A', value: '2'}]).A, '1');
    // 现有键不在行里 = 删除
    assert.equal(mcpMergeEnvRows({OLD: 'x'}, [{key: 'A', value: '1'}]).OLD, undefined);
});

test('mcpToolFlags：annotations 是 hint，destructive 缺省悲观为 true', () => {
    assert.deepEqual(mcpToolFlags(undefined), {readOnly: false, destructive: true, openWorld: false});
    assert.deepEqual(mcpToolFlags(null), {readOnly: false, destructive: true, openWorld: false});
    assert.deepEqual(mcpToolFlags({readOnlyHint: true}), {readOnly: true, destructive: true, openWorld: false});
    assert.deepEqual(mcpToolFlags({readOnlyHint: true, destructiveHint: false, openWorldHint: true}),
        {readOnly: true, destructive: false, openWorld: true});
    // 畸形 annotations 与「显式 false 的 readOnly」都不能宽松
    assert.deepEqual(mcpToolFlags('x'), {readOnly: false, destructive: true, openWorld: false});
    assert.equal(mcpToolFlags({readOnlyHint: false}).readOnly, false);
});

test('mcpValidateServerForm：与 Go 写入期校验同规则', () => {
    const base = {name: 'ok', command: 'npx', args: [], startupTimeoutMs: 30000, callTimeoutMs: 60000, closeTimeoutMs: 5000};
    assert.equal(mcpValidateServerForm(base), '');
    // 名称：非法字符 / 超长 / 空
    assert.match(mcpValidateServerForm({...base, name: 'bad name'}), /服务器名/);
    assert.match(mcpValidateServerForm({...base, name: 'a'.repeat(33)}), /服务器名/);
    assert.match(mcpValidateServerForm({...base, name: ''}), /服务器名/);
    // 缺命令
    assert.match(mcpValidateServerForm({...base, command: '  '}), /缺少启动命令/);
    // 参数超限
    assert.match(mcpValidateServerForm({...base, args: new Array(129).fill('x')}), /参数个数/);
    // 超时越界
    assert.match(mcpValidateServerForm({...base, startupTimeoutMs: 601000}), /超时/);
    assert.match(mcpValidateServerForm({...base, callTimeoutMs: -1000}), /超时/);
    assert.equal(mcpValidateServerForm({...base, closeTimeoutMs: 600000}), '');
});

test('mcpStatusMeta：六态映射状态灯与文案', () => {
    assert.deepEqual(mcpStatusMeta('connected'), {cls: 'ok', text: '已连接'});
    assert.deepEqual(mcpStatusMeta('connecting'), {cls: 'warn', text: '连接中'});
    assert.deepEqual(mcpStatusMeta('reconnecting'), {cls: 'warn', text: '重连中'});
    assert.deepEqual(mcpStatusMeta('failed', 'gave-up'), {cls: 'err', text: '已放弃'});
    assert.deepEqual(mcpStatusMeta('failed', 'unclosed-generation'), {cls: 'err', text: '关闭未确认（需重启应用）'});
    assert.deepEqual(mcpStatusMeta('closed'), {cls: 'idle', text: '未连接'});
    assert.deepEqual(mcpStatusMeta('waiting-credentials'), {cls: 'idle', text: '未连接'});
});
