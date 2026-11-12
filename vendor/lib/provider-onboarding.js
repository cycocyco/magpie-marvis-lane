/**
 * 各 provider 的**一次性奖励能力实现表** —— `ProviderRuntime.onboarding` 域的唯一真源。
 *
 * ## 本 fork 的裁剪说明
 *
 * 原版登记了 loomy / raccoon / magicrew 两站的一次性奖励；本 fork 只保留
 * **腾讯 Marvis**，而 marvis **没有**新人任务端点（`PROVIDER_REGISTRY` 的
 * `credits.onboardingTasks` 未声明）⇒ 本表为空。
 *
 * ## ⚠️ 与 `credits` 域的边界（**别把两者合并**）
 *
 * | 域 | 语义 | 频率 |
 * |---|---|---|
 * | `credits` | **每日**签到（每天都有收益） | 每天 |
 * | `onboarding` | **一次性**新手任务 / 登录奖励（每号只能领一次） | 一次 |
 *
 * 两者混在一个域里会诱导实现方拿「今天领过没」的判据去判「领过没」。
 */
/**
 * 构造「id → 一次性奖励能力」的表。
 *
 * ⚠️ 只覆盖**真有**一次性奖励的渠道（与 `PROVIDER_REGISTRY` 的
 * `credits.onboardingTasks` 声明一致）；marvis 没有 ⇒ 空表。
 */
export function createProviderOnboarding(deps = {}) {
    return {};
}
/**
 * 按 provider id 从表里取实现。
 *
 * ⚠️ 用 `Object.hasOwn` 而非 `in`：`in` 会命中原型链上的键（如 `constructor`），
 * 把 `req.provider` 为怪值时误判成「有该 provider」——
 * 与 `creditsOf` / `authOf` 同因。
 */
export function onboardingOf(table, provider) {
    if (!Object.hasOwn(table, provider))
        return undefined;
    return table[provider];
}
//# sourceMappingURL=provider-onboarding.js.map
