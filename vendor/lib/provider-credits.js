/**
 * 各 provider 的**积分能力实现表** —— `ProviderRuntime.credits` 域的唯一真源。
 *
 * ## 本 fork 的裁剪说明
 *
 * 原版登记了十余家渠道的余额 / 签到实现；本 fork 只保留**腾讯 Marvis** 一家。
 * 通用骨架（`collectCreditBalances` / `collectCreditsStatus`，在 `jet-hub-rpc.js`）
 * 不变，「选哪个函数」的数据表只剩 marvis 一条。
 *
 * ## ⚠️ 为什么 marvis 用 `fetchBalanceDetailed` 而不是 `fetchBalance`
 *
 * `fetchBalance` 的 `null` 由共享骨架统一翻译成「余额查询失败」。marvis 的
 * 失败原因必须区分（401/403 ⇒ 重新登录、业务码非 0 ⇒ 上游改版、缺字段 ⇒
 * 账号未开通），压成笼统一句会丢掉唯一有用的线索。
 * **绝不允许把「查不到」写成 0**（0 是「已用光」的语义）。
 */
// ⚠️ 腾讯 Marvis（2026-11-09）：钱包余额原语（`/v3/marvis_get_wallet`）。
import { fetchMarvisBalanceDetailed } from './marvis-credits.js';
import { MARVIS } from './marvis-product.js';
/** 组装一条「有余额」的带原因结果。 */
function ok(balance) {
    return { balance };
}
/** 组装一条「查不到」的带原因结果（`error` 必须是可读原因，不是 0）。 */
function fail(error) {
    return { balance: null, error };
}
/**
 * 构造「id → 积分能力」的表。
 *
 * ⚠️ `aggregate` 没有自己的账号与余额，不在表里。
 *
 * @param {Record<string, unknown>} [deps] 可选注入（原版为 minimax 代理等保留的
 *   形状；marvis 路径用不到，签名保留以免改动调用方）。
 */
export function createProviderCredits(deps = {}) {
    return {
        /**
         * 腾讯 Marvis（2026-11-09）：**本 fork 独有**。
         *
         * 真端点 `POST https://yybadaccess.3g.qq.com/v3/marvis_get_wallet`（UAL 业务
         * 签名头 + body `"{}"`），实测 200 返回
         * `{total_tokens:"10000000", used_tokens:"0", frozen_tokens:"0",
         *   avail_tokens:"10000000", total_cost:0, status:1}` ——
         * ⚠️ **数字是字符串**（解析在 `fetchMarvisBalanceDetailed` 内），且
         * ⚠️ **没有任何日期字段** ⇒ 包必须标 `expiryUnknown`（不得编造每日重置时刻）。
         *
         * ⚠️ 用 `fetchBalanceDetailed`（不是 `fetchBalance`）：401/403 / 业务码非 0 /
         * 缺字段三种失败的**用户动作**完全不同（重新登录 / 上游改版 / 账号未开通），
         * 压成笼统的「查询失败」会误导。
         */
        marvis: {
            fetchBalanceDetailed: async (credential) => fetchMarvisBalanceDetailed(credential, MARVIS),
            /**
             * ⚠️ 2026-11-09 整支评审 M5：Marvis **没有**签到端点（钱包 `/v3/marvis_get_wallet`
             * 是只读的，9 条候选端点全 404）。UI 隐藏了「一键签到」按钮，但绕过 UI 调
             * `credits.claimAll` 时若不给这句，用户拿到的是泛化的
             * `unsupported provider: marvis` —— 而 `provider-runtime.ts` 的头注释明写
             * 「能力缺失必须给可读文案、不得退化成 unsupported provider」。
             */
            claimUnavailableReason: 'Marvis 没有每日签到接口：令牌额度由服务端每日发放，无需手动领取',
        },
    };
}
/**
 * 按 provider id 从表里取实现。
 *
 * ⚠️ 用 `Object.hasOwn` 而非 `in`：`in` 会命中原型链上的键（如 `constructor`），
 * 把 `req.provider` 为怪值时误判成「有该 provider」——
 * 与 `jet-hub-rpc.ts` 的 `authOf` 同因。
 */
export function creditsOf(table, provider) {
    if (!Object.hasOwn(table, provider))
        return undefined;
    return table[provider];
}
//# sourceMappingURL=provider-credits.js.map
