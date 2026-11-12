/**
 * 各 provider 的**元数据与能力声明** —— 本插件里「有哪些 provider、各自有什么能力」
 * 的**唯一真相源**。
 *
 * ## 本 fork 的裁剪说明
 *
 * 原版（dsh-providers-hub / magpie-Jet-Hub）登记了 29 家供应商；本 fork 只保留
 * **腾讯 Marvis** 一家（外加 `aggregate` 聚合路由组的登记）。其余 28 家的模块与
 * 接线已全部移除，这张表是裁剪后的真相源——派生表（`CREDITS_CAPABILITIES` 等）
 * 都从它算出来，所以这里少一家，处处就少一家。
 *
 * ## ⚠️ 本文件必须零 import
 *
 * 它同时被 Node 宿主与（原版的）浏览器客户端消费，不得 import 任何 `node:*`。
 *
 * ## 与各 product 的 `displayName` 的关系
 *
 * `displayName` 与 `marvis-product.js` 的取值相同，但**没有任何断言守着这条一致性**，
 * 不要把本字段当作契约来依赖。
 */
export const PROVIDER_REGISTRY = Object.freeze([
    {
        // 腾讯 Marvis（2026-11-09 接入）。
        //
        // ## 为什么只有一条模型
        // 上游**没有模型目录端点**（累计试过 9 条候选路径，全 404 / 400），模型列表
        // 只能静态兜底。槽位里只有 `main-auto` 是用户要的（服务端自动路由），实测
        // 落到 `deepseek-v4-1-flash-261017`；`deepseek-v4-pro-external` / `hy3-*` /
        // `claude-*` / `gpt-5.4` / `hunyuan-*` 本账号无授权（400 无效模型 id）或
        // 不在用户选择范围内 ⇒ **目录只列一条**。
        // ⚠️ 真实模型 id（`deepseek-v4-1-flash-261017`）**不能直传**：上游回
        //    `400 {"code":4130001,"msg":"客户端AI业务错误: 无效模型id"}`，
        //    只有槽位名可作 `model` 上行 —— 归一逻辑见 `normalizeMarvisModelId`。
        //
        // ## 能力登记的依据
        // · `balance: true`：`POST /v3/marvis_get_wallet` 实测 200，
        //   `{total_tokens:"10000000", used_tokens:"0", frozen_tokens:"0", …}`
        //   （**字符串数字**，且**没有任何日期字段** ⇒ 包里只能标 `expiryUnknown`）。
        // · 省略 `dailyCheckin`：**没有**签到端点。省略的语义就是「后端无可调用
        //   端点」，与「忘了写」不同 —— 一键签到会把它记成 inactive 而不是 failed。
        // · 省略 `creditPackages`：余额是单一口袋 + 可选「冻结中」子量，没有任何
        //   到期批次 ⇒ 名单型展示只会凭空造日期。
        // · 省略 `rateLimit`（= true）：请求级换号**真的**会写 `modelRateLimits`
        //   （429 / 额度耗尽 / 风控三条都调 `markLimited`）⇒ 限流按钮必须有。
        // · 省略 `accountTest`：探活要真发一次推理（消耗真实 token 配额）。
        // · 省略 `permanentLock` / `usesExpiryWindow`：上游不给任何到期时间，
        //   两者都以「包带到期时间」为前提。
        id: 'marvis',
        label: '腾讯 Marvis',
        displayName: '腾讯 Marvis',
        logoClass: 'marvis',
        credits: { balance: true },
        // ⚠️ 必须 `llm-<id>`（老契约 DSH ≤0.1.6 的 namespace）。
        settingsNamespace: 'llm-marvis',
        // ⚠️ `channel: true`：它持有账号与凭据，是普通渠道；`false` 只留给 `aggregate`。
        channel: true,
    },
    {
        id: 'aggregate',
        label: '聚合 (跨渠道)',
        displayName: '聚合 (跨渠道)',
        logoClass: 'aggregate',
        // ⚠️ 如实登记为 false：它**没有自己的账号与余额** —— 复用各渠道的账号，
        //    积分与限流由各渠道自己管理。
        // ⚠️ 这不影响用量徽标：徽标对聚合的处理是「重定向到实际选中的渠道」，
        //    重定向发生在 `supportsCreditBalance` 门控**之前**。
        credits: { balance: false, dailyCheckin: false },
        channel: false,
    },
]);
/** 按 id 取声明；未知返回 `undefined`（调用方决定报错措辞）。 */
export function descriptorOf(id) {
    return PROVIDER_REGISTRY.find((d) => d.id === id);
}
/**
 * 派生出客户端 `CREDITS_CAPABILITIES` 的同形结构。
 *
 * ⚠️ 只拷贝**已声明**的可选字段（不用 `undefined` 占位），保持"缺失即缺失"最安全。
 */
export function creditCapabilitiesOf() {
    const out = {};
    for (const d of PROVIDER_REGISTRY) {
        // ⚠️ **每一条都要 `Object.freeze`**：本仓库的约定是「保险失效比变红更糟」，
        //    只冻结外层容器时内层条目仍可被改写。
        out[d.id] = Object.freeze({
            balance: d.credits.balance,
            // ⚠️ `dailyCheckin` 是**可省略**字段（marvis 就没有），按「缺失即缺失」
            //    的规则条件拷贝，判据侧一律 `=== true`。
            ...d.credits.dailyCheckin === undefined ? {} : { dailyCheckin: d.credits.dailyCheckin },
            ...d.credits.onboardingTasks === undefined ? {} : { onboardingTasks: d.credits.onboardingTasks },
            ...d.credits.subscriptionQuota === undefined ? {} : { subscriptionQuota: d.credits.subscriptionQuota },
        });
    }
    return out;
}
/**
 * **会做「余额到期分档」的渠道**（`id` 全集的唯一真源）。
 *
 * 本 fork 只剩 marvis：它的余额是单一口袋、上游不给任何到期时间，
 * **不在**分档渠道之列 ⇒ 本表为空。保留表结构与判据函数本身，
 * 不动调用方形状。
 */
export const BALANCE_TIERED_PROVIDERS = Object.freeze([]);
/** 该渠道的选号是否会先按余额到期档位排序（见 {@link BALANCE_TIERED_PROVIDERS}）。 */
export function isBalanceTieredProvider(provider) {
    return BALANCE_TIERED_PROVIDERS.includes(provider);
}
//# sourceMappingURL=provider-registry.js.map
