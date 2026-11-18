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

/**
 * 把任意图片 Blob 转成 PNG Blob（剪贴板只接受 image/png）。
 * 已经是 PNG 的原样返回；否则经 Image 解码 + Canvas 重绘后编码为 PNG。
 * @param {Blob|null} blob 源图片 Blob
 * @returns {Promise<Blob|null>} PNG Blob；入参为空时返回 null
 */
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

/**
 * 把图片 Blob 写入系统剪贴板（自动转 PNG）。
 * 浏览器剪贴板 API 不可用或用户未聚焦页面时返回 false，由调用方决定是否提示。
 * @param {Blob} blob 源图片 Blob
 * @returns {Promise<boolean>} true = 写入成功
 */
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

/**
 * 从 URL 拉取图片并写入系统剪贴板。
 * @param {string} url 图片地址（公网 http(s) 或 data URL）
 * @returns {Promise<boolean>} true = 写入成功
 */
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
/**
 * 把 data URL 转成 File 对象，供右键「粘贴」走与 Ctrl+V 相同的压缩管线。
 * 解码失败或空数据时返回 null。
 * @param {string} dataUrl 图片 data URL
 * @param {string} [name] 目标文件名，缺省用「粘贴的图片」
 * @returns {File|null} File 对象；无法解析时返回 null
 */
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
