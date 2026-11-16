// 补丁示例用的配置（docs/samples/patch）
export const config = {
    theme: 'dark',
    pageSize: 50,
    locale: 'zh-CN',
    features: {
        patchView: true,
        aiPanel: true,
    },
};

export function describe() {
    return config.theme + ' / ' + config.pageSize;
}
