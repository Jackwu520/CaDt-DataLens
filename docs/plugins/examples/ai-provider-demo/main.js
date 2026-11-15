// 示例：注册一个可插拔 AI provider。
// 端点指向本地 OpenAI 兼容服务（你自己的网关或 mock），示例本身不发外部请求。
// 完整 API 见 ../../README.md「注册 AI provider」。

cadt.registerAIProvider({
    id: 'local-demo',
    name: '示例 · 本地 OpenAI 兼容服务',
    account: {
        provider: 'openai',
        baseURL: 'http://127.0.0.1:8000/v1',
        apiKey: '',
        temperature: 0.7,
    },
    models: [
        {model: 'demo-chat', contextWindow: 128000, outputWindow: 4096},
    ],
    prepare(ctx) {
        // 会话级稳定关联号 + 每轮随机请求号；真实场景可用它派生网关要求的会话 ID。
        return {
            extraHeaders: {
                'x-demo-session': fnv1a(ctx.sessionId || 'no-session'),
                'x-demo-request': Math.random().toString(36).slice(2, 12),
            },
            // 请求体补丁：覆盖同名字段，但 stream 恒为 true（应用侧强制）
            extraBody: {tool_choice: 'none'},
        };
    },
});

// 不引入依赖的 32 位 FNV-1a，仅用于演示「按会话派生稳定标识」。
function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

cadt.addCommand({
    id: 'ai-provider-demo-info',
    label: 'AI provider 示例 · 查看说明',
    run() {
        cadt.flash('已注册虚拟账号「示例 · 本地 OpenAI 兼容服务」；在设置 → AI 助手 → 模型账号里选中即可使用');
    },
});
