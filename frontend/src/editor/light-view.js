// light-view.js：轻量查看窗的视图（辅助独立窗第二批）。
// 只读、磁盘真源：文本走 highlight.js 高亮 <pre>，图片走 ReadImageAsDataURL，
// 二进制给引导提示；大文件按 OpenFile 的 large 标记截断展示。纯函数拆出可单测。

import hljs from 'highlight.js/lib/common';

// 大文件截断阈值（OpenFile 对 >10MB 只读、>100MB 拒绝；这里限制渲染长度防 DOM 卡死）。
const LIGHT_RENDER_CHAR_LIMIT = 200000;

// pickLightLanguage 扩展名 → highlight.js 语言名（空串 = 纯文本不高亮）。
export function pickLightLanguage(path) {
    const ext = String(path || '').replace(/^.*[\\/]/, '').replace(/^.*\./, '').toLowerCase();
    const map = {
        js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
        ts: 'typescript', tsx: 'typescript',
        json: 'json', jsonl: 'json', jsonc: 'json',
        py: 'python', pyw: 'python',
        md: 'markdown', markdown: 'markdown', mdx: 'markdown',
        yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini',
        xml: 'xml', svg: 'xml', html: 'xml', htm: 'xml', xhtml: 'xml', csproj: 'xml', plist: 'xml',
        css: 'css', less: 'less', scss: 'scss',
        csv: 'plain', tsv: 'plain',
        sh: 'bash', bash: 'bash', zsh: 'bash', bat: 'dos', cmd: 'dos', ps1: 'powershell',
        sql: 'sql',
        go: 'go', rs: 'rust', rb: 'ruby', php: 'php', java: 'java', cs: 'csharp',
        c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', kt: 'kotlin', swift: 'swift',
        lua: 'lua', r: 'r', pl: 'perl', vim: 'vim', dockerfile: 'dockerfile', makefile: 'makefile',
        log: 'plain', txt: 'plain', diff: 'diff', patch: 'diff',
    };
    return map[ext] !== undefined ? map[ext] : '';
}

// formatLightMeta 文件元信息行（纯函数）。
export function formatLightMeta(data) {
    if (!data) return '';
    const parts = [];
    if (data.enc) parts.push(data.enc.toUpperCase());
    if (data.eol) parts.push(data.eol === 'crlf' ? 'CRLF' : 'LF');
    if (data.size != null) {
        const n = Number(data.size);
        parts.push(n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B');
    }
    return parts.join(' · ');
}

// createLightView 轻量查看窗视图工厂：mount() 读文件并渲染。
export function createLightView(deps) {
    let bodyEl = null;
    let metaEl = null;

    function renderText(data) {
        const text = String(data.content == null ? '' : data.content);
        const truncated = text.length > LIGHT_RENDER_CHAR_LIMIT;
        const shown = truncated ? text.slice(0, LIGHT_RENDER_CHAR_LIMIT) : text;
        const pre = document.createElement('pre');
        pre.className = 'light-view-code';
        const code = document.createElement('code');
        const lang = pickLightLanguage(deps.path);
        if (lang && lang !== 'plain') {
            try { code.innerHTML = hljs.highlight(shown, {language: lang}).value; } catch (e) { code.textContent = shown; }
        } else {
            code.textContent = shown;
        }
        pre.appendChild(code);
        bodyEl.appendChild(pre);
        if (truncated) {
            const more = document.createElement('div');
            more.className = 'light-view-hint';
            more.textContent = '文件过大，仅显示前 ' + LIGHT_RENDER_CHAR_LIMIT.toLocaleString('zh-CN') + ' 字符——完整内容请在主窗口打开。';
            bodyEl.appendChild(more);
        }
    }

    async function renderImage() {
        const img = document.createElement('img');
        img.className = 'light-view-img';
        img.alt = deps.baseNameOf ? (deps.baseNameOf(deps.path) || deps.path) : deps.path;
        img.addEventListener('load', () => {
            const info = document.createElement('div');
            info.className = 'light-view-hint';
            info.textContent = img.naturalWidth + ' × ' + img.naturalHeight;
            bodyEl.appendChild(info);
        });
        img.addEventListener('error', () => {
            bodyEl.textContent = '';
            const hint = document.createElement('div');
            hint.className = 'light-view-hint';
            hint.textContent = '图片加载失败。';
            bodyEl.appendChild(hint);
        });
        try {
            img.src = await deps.backend.ReadImageAsDataURL(deps.path);
        } catch (e) {
            const hint = document.createElement('div');
            hint.className = 'light-view-hint';
            hint.textContent = '图片读取失败：' + ((e && e.message) || e);
            bodyEl.appendChild(hint);
            return;
        }
        bodyEl.appendChild(img);
    }

    function renderHint(text) {
        const hint = document.createElement('div');
        hint.className = 'light-view-hint light-view-center';
        hint.textContent = text;
        bodyEl.appendChild(hint);
    }

    async function mount() {
        const root = document.createElement('div');
        root.className = 'light-view-root';
        metaEl = document.createElement('div');
        metaEl.className = 'light-view-meta';
        metaEl.textContent = '正在读取…';
        bodyEl = document.createElement('div');
        bodyEl.className = 'light-view-body aux-window-body';
        root.append(metaEl, bodyEl);
        deps.container.textContent = '';
        deps.container.appendChild(root);
        let data = null;
        try {
            data = await deps.backend.OpenFile(deps.path, 'auto');
        } catch (e) {
            metaEl.textContent = '';
            renderHint('读取失败：' + ((e && e.message) || e));
            return;
        }
        if (!data) {
            metaEl.textContent = '';
            renderHint('文件不存在或无法读取。');
            return;
        }
        metaEl.textContent = formatLightMeta(data) || '只读';
        if (data.binary && data.image) { await renderImage(); return; }
        if (data.binary) { renderHint('二进制文件不支持轻量查看——请在主窗口打开（十六进制视图）。'); return; }
        renderText(data);
    }

    return {mount};
}
