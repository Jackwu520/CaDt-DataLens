// command-classifier-onnx：端侧命令语义分类器插件（方案 B，docs/finished-plans/local-command-classifier.md §8）。
// 一期交付：registerCommandClassifier 接线演示（词表打分模拟语义模型接口形态）+ readAsset 模型元数据加载演示。
// 二期计划：readAsset 加载 ONNX 模型 → blob URL 动态加载 onnxruntime-web → Worker 化推理（避免卡 UI）。
(function () {
    'use strict';

    // 旧版本应用没有分类器 API：提示后静默退出，不注册任何东西
    if (typeof cadt.registerCommandClassifier !== 'function') {
        try { cadt.flash('[命令语义分类器] 应用版本过低：请更新到含命令分类器 API 的新版本'); } catch (e) {}
        return;
    }

    // readAsset 演示：读取插件目录内的模型元数据（返回 data URL）。
    // 二期在同一路径加载 ONNX 权重：data URL → Blob → URL.createObjectURL → onnxruntime-web。
    const model = {ready: false, info: '', error: ''};
    try {
        Promise.resolve(cadt.readAsset('model/manifest.json'))
            .then((dataUrl) => {
                const payload = String(dataUrl || '').split(',')[1] || '';
                const json = JSON.parse(decodeURIComponent(atob(payload).split('').map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')));
                model.ready = true;
                model.info = json && json.name ? json.name + ' · ' + (json.quant || '') : '未知模型';
            })
            .catch((e) => { model.error = String((e && e.message) || e); });
    } catch (e) { model.error = String((e && e.message) || e); }

    // 一期词表打分（模拟语义模型）：命中危险模式累加权重，封顶 1。
    // 与内置线性模型刻意不同构——演示「多分类器保守合并取 max(score)」的实际效果。
    const DANGER_PATTERNS = [
        {re: /\brm\s+(-[a-z]*r[a-z]*f|-rf|--recursive\s+--force)/i, w: 0.9, name: '递归强删'},
        {re: /\b(del|erase)\b[^|]*\/(f|s)\b/i, w: 0.85, name: '强删文件'},
        {re: /\b(rmdir|rd)\s+\/s/i, w: 0.85, name: '递归删目录'},
        {re: /remove-item[^|]*-recurse/i, w: 0.85, name: '递归删目录'},
        {re: /\bdd\b[^|]*of=\/dev\//i, w: 0.95, name: '裸设备写入'},
        {re: /\bmkfs\S*\b|\bformat\s+[a-z]:/i, w: 0.95, name: '格式化'},
        {re: /\breg\s+(add|delete)\b/i, w: 0.7, name: '注册表修改'},
        {re: /\|\s*(sh|bash|zsh|pwsh|powershell)\b/i, w: 0.75, name: '管道落地 shell'},
        {re: /\biex\b|invoke-expression|powershell\s+(-enc|-encodedcommand)/i, w: 0.8, name: '代码执行'},
        {re: /\b(taskkill|kill|pkill)\b[^|]*\/?(f|-9)/i, w: 0.6, name: '强杀进程'},
        {re: /\bshutdown\b|\brestart-computer\b/i, w: 0.8, name: '关机重启'},
        {re: /git\s+push\s+(-f|--force)/i, w: 0.55, name: '强推'},
        {re: /git\s+(reset\s+--hard|clean\s+-[a-z]*f)/i, w: 0.6, name: '丢弃工作区'},
    ];

    function scoreCommand(command) {
        const text = String(command || '');
        let score = 0;
        const names = [];
        for (const pattern of DANGER_PATTERNS) {
            if (pattern.re.test(text)) {
                score += pattern.w;
                names.push(pattern.name);
            }
        }
        return {score: Math.min(1, score), names};
    }

    cadt.registerCommandClassifier({
        id: 'onnx-semantics',
        label: '语义分类器（ONNX）',
        // ctx: {cwd, toolName, strictness, threshold, sessionId}——语义模型二期在此可加显式上下文前缀
        classify(command, ctx) {
            const {score, names} = scoreCommand(command);
            const reason = names.length
                ? '词表演示命中：' + names.join('、')
                : '词表演示未命中（ONNX 二期接入）';
            return {score, reason};
        },
    });

    // 演示命令：输出插件接线状态（模型元数据是否经 readAsset 读到）
    cadt.addCommand({
        id: 'classifier-status',
        label: '端侧分类器（ONNX）状态',
        run() {
            const lines = [
                '插件：command-classifier-onnx 0.1.0（一期 · 接线演示）',
                '模型元数据：' + (model.ready ? '已加载（' + model.info + '）' : '未加载' + (model.error ? '（' + model.error + '）' : '')),
                '分类器：已注册 id=onnx-semantics（词表打分，ONNX 推理为二期）',
                '',
                '验证方法：设置 → AI 助手 → 权限 → 高级配置，端侧分类器启用后',
                '在「测试命令」输入 rm -rf /tmp/x，来源应显示「语义分类器（ONNX）」。',
            ];
            cadt.openVirtualDoc('端侧分类器（ONNX）状态.txt', lines.join('\n'));
        },
    });
})();
