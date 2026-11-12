/**
 * 供应商图标 —— magpie provider 的 `auth.icon`。
 *
 * 契约（宿主 `iconOf`）：接受 `https://` 或 `data:image/`，不超过 1 MB，宿主
 * 不抓取、原样收下。这里全部内联成 data URI，不依赖外部图床（离线也要显示）。
 *
 * ## 本 fork 的裁剪说明
 *
 * 原版为 29 家各配图标（品牌 SVG / 厂商位图 / 官网 favicon / 自绘兜底）；
 * 本 fork 只剩 marvis 一家 + 插件自己的兜底图。
 */

/**
 * 自绘图形：64×64 视口，透明底（图形自己就是标识）。
 *
 * @param {string} bg 底色
 * @param {string} inner viewBox 0 0 64 64 内的图形
 */
function mark(bg, inner) {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">' +
    `<rect width="64" height="64" rx="14" fill="${bg}"/>` +
    inner +
    '</svg>'
  )
}

/** SVG 文本 → data URI（宿主不抓取，必须自包含）。 */
const toDataUri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`

// 腾讯 Marvis（2026-11-09 上游新增）：品牌蓝底 + 对话气泡 + 星形。
const MARVIS = mark(
  '#0052d9',
  '<path d="M20 15h24a4 4 0 0 1 4 4v14a4 4 0 0 1-4 4H31l-9 8v-8h-2a4 4 0 0 1-4-4V19a4 4 0 0 1 4-4z" fill="none" stroke="#fff" stroke-width="3.2" stroke-linejoin="round"/>' +
    '<path d="M32 23l2.2 5.6 5.6 2.2-5.6 2.2L32 38.6l-2.2-5.6-5.6-2.2 5.6-2.2z" fill="#fff"/>',
)

// 插件自己的兜底图（未知 provider 用；本 fork 只剩一家，基本不会被走到）。
const BRAND = mark(
  '#5b5bd6',
  '<circle cx="32" cy="32" r="7" fill="#fff"/>' +
    '<g stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".85">' +
    '<path d="M32 10v9"/><path d="M32 45v9"/><path d="M10 32h9"/><path d="M45 32h9"/>' +
    '<path d="M17 17l6 6"/><path d="M41 41l6 6"/><path d="M47 17l-6 6"/><path d="M23 41l-6 6"/>' +
    '</g>',
)

const PROVIDER_SVG = {
  marvis: MARVIS,
}

const ICON_URIS = new Map(
  Object.entries(PROVIDER_SVG).map(([provider, svg]) => [provider, toDataUri(svg)]),
)
const BRAND_URI = toDataUri(BRAND)

/**
 * 取某个 provider 的图标（`data:image/svg+xml;base64,…`）。
 * 没登记的 provider 退回插件自己的图标。
 *
 * @param {string} dshProvider 本体 provider 名
 */
export function iconFor(dshProvider) {
  return ICON_URIS.get(dshProvider) ?? BRAND_URI
}

/** 供测试用：确认每个 provider 都有独立图标。 */
export function iconProviders() {
  return [...ICON_URIS.keys()]
}
