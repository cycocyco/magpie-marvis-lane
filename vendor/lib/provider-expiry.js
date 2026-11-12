/**
 * 各 provider 的**临期折算能力实现表** —— `ProviderRuntime.expiry` 域的唯一真源。
 *
 * ## 本 fork 的裁剪说明
 *
 * 原版为十余家渠道登记折算原语；本 fork 只保留**腾讯 Marvis** 一家。
 * 表只做「选哪个原语」，原语本身留在 `aggregate-expiry.js`。
 *
 * ## ⚠️ 边界：本表只做「选哪个原语」，**不**抽象原语本身
 *
 * ## ⚠️ 只覆盖**已接入临期折算**的渠道（权威是
 * `aggregate-expiry.js` 的 `WIRED_EXPIRY_PROVIDERS`，抄一份必然漂移）
 *
 * ## ⚠️⚠️ **「哪些虚拟模型可以播报」不由本表派生**
 *
 * 那由 `aggregate-expiry.js` 的**编译期常量** `WIRED_EXPIRY_PROVIDERS` 决定。
 * 两者回答的是**两个不同的问题**：本表答「**运行时**该调哪个原语」（要到
 * `apply()` 注册时才填充），那个常量答「这个渠道**接入了**折算吗」（编译期事实）
 * —— 不是同一件事，故不能互为派生源。**别把那个常量改成本表的派生值**：
 * 派生版本在「不调 `apply()`」的场景下恒为空数组，`refreshCatalog` 会把
 * **所有虚拟模型过滤掉**、聚合 provider 的模型列表**整个变空**。
 */
// ⚠️ 腾讯 Marvis（2026-11-09）：钱包无日期字段 ⇒ 折算只看「有没有余额」。
import { marvisExpiry } from './aggregate-expiry.js';
import { MARVIS } from './marvis-product.js';
/**
 * 构造「id → 临期折算」的表。
 *
 * ⚠️ 返回**新对象**（不是模块级单例）：调用方各自持有一份，互不影响；
 * 表本身是**无状态**的（每个值只是一层转发闭包），故无共享状态风险。
 */
export function createProviderExpiry(deps = {}) {
    return {
        // ⚠️ 腾讯 Marvis（2026-11-09）：与原版 modelscope **同格**（钱包只有剩余/总量，
        //    没有任何日期字段 ⇒ 有余额即 `NEVER`、烧光即 `UNUSABLE`）。
        //    ⚠️ 三处必须同改（本表 + `WIRED_EXPIRY_PROVIDERS` + 折算原语
        //    `marvisExpiry`）—— 漏任何一处都是**静默**的（聚合轮换列表里看不到它）。
        //    ⚠️ **必须走 `cachedBalance`**：聚合每轮折算会对同一账号反复提问，
        //    没有共享读数就会白发大量重复请求。
        marvis: {
            credentialExpiry: (c, context) => marvisExpiry(c, MARVIS, context?.cachedBalance === undefined
                ? undefined
                : () => context.cachedBalance(context.accountId)),
        },
    };
}
//# sourceMappingURL=provider-expiry.js.map
