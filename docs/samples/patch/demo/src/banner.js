export function bannerText(count) {
    if (!count) return '暂无新消息';
    return '你有 ' + count + ' 条新消息';
}
