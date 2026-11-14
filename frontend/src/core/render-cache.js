// render-cache.js：SSR 渲染结果的小型 LRU 缓存。
// 背景：AI 消息 DOM 每次更新都整段重建，卡片随之销毁重建；异步引擎（echarts / ELK / 词云）
// 不缓存就会在每次重渲染时重跑布局引擎。key 由调用方拼（内容 + 主题）。

export function createLruCache(maxEntries) {
    const map = new Map();
    return {
        get(key) {
            if (!map.has(key)) return undefined;
            const value = map.get(key);
            map.delete(key);
            map.set(key, value); // 命中即移到队尾（最新）
            return value;
        },
        set(key, value) {
            if (map.has(key)) map.delete(key);
            map.set(key, value);
            while (map.size > maxEntries) {
                const oldest = map.keys().next().value;
                map.delete(oldest);
            }
        },
    };
}
