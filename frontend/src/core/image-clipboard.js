// 图片写入系统剪贴板：Chromium 的异步剪贴板只接受 image/png，
// 其他格式先转 PNG；能力缺失或用户未聚焦时返回 false，由调用方决定提示。

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = url;
    });
}

export async function blobToPngBlob(blob) {
    if (!blob) return null;
    if (blob.type === 'image/png') return blob;
    const url = URL.createObjectURL(blob);
    try {
        const img = await loadImage(url);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, img.naturalWidth || img.width || 1);
        canvas.height = Math.max(1, img.naturalHeight || img.height || 1);
        canvas.getContext('2d').drawImage(img, 0, 0);
        return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    } finally {
        URL.revokeObjectURL(url);
    }
}

export async function copyImageBlobToClipboard(blob) {
    if (!navigator.clipboard || !window.ClipboardItem) return false;
    try {
        const png = await blobToPngBlob(blob);
        if (!png) return false;
        await navigator.clipboard.write([new ClipboardItem({'image/png': png})]);
        return true;
    } catch (e) {
        return false;
    }
}

export async function copyImageUrlToClipboard(url) {
    if (!url) return false;
    try {
        const resp = await fetch(url);
        return await copyImageBlobToClipboard(await resp.blob());
    } catch (e) {
        return false;
    }
}

// dataUrlToFile data URL → File：右键菜单的「粘贴」拿不到 paste 事件，后端回读的
// 剪贴板图片先转成 File，再走与 Ctrl+V 相同的压缩管线（AI 输入框与快捷便签共用）。
export function dataUrlToFile(dataUrl, name) {
    const raw = String(dataUrl || '');
    const comma = raw.indexOf(',');
    if (comma < 0) return null;
    const header = raw.slice(0, comma);
    const mime = (header.slice(header.indexOf(':') + 1).split(';')[0] || 'image/png').trim() || 'image/png';
    let binary = '';
    try {
        binary = atob(raw.slice(comma + 1));
    } catch (e) {
        return null;
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (!bytes.length) return null;
    try {
        return new File([bytes], name || '粘贴的图片', {type: mime});
    } catch (e) {
        return null;
    }
}
