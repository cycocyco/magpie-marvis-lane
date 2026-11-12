/**
 * 「渠道余额 → 最早失效时刻」的**唯一口径**。
 *
 * ## 为什么单独一个文件（而不是并进 `aggregate-core.ts` / `aggregate-adapter.ts`）
 *
 * | 候选位置 | 为什么不行 |
 * |---|---|
 * | `aggregate-adapter.ts` | `auto-adapter.ts` 的 `expiryOf` 要复用它 ⇒ 依赖方向变成 `auto-adapter → aggregate-adapter`（**层次颠倒**，聚合适配器是更上层的东西） |
 * | `aggregate-core.ts` | 该文件定位是**纯逻辑**（哨兵 / 排序 / 倍率解析，模块头明写、零 import），而本模块要发网络请求 ⇒ 把 IO 混进纯函数模块 |
 * | ✅ 本文件 | 单一职责；两个适配器都依赖它，方向正确 |
 *
 * ## 本 fork 的裁剪说明
 *
 * 原版在此文件登记了十余家渠道的折算原语；本 fork 只保留**腾讯 Marvis**
 *（`marvisExpiry`）与共享的探针骨架（`createExpiryProbe` /
 * `sharedPackageExpiry` / `fetchBalanceWithCache`）。
 *
 * ## ⚠️ 依赖方向（2026-10-08 起 import `provider-runtime.ts`）
 *
 * 本模块**只**依赖底座，不依赖任何聚合侧模块。`provider-runtime.ts` 只 import
 * `provider-registry.ts`（纯数据）与 `account-pool.ts`（**仅类型**），**不** import
 * 本文件 ⇒ **无环**。⚠️ 别在这里 import `aggregate-adapter.ts` / `auto-adapter.ts`。
 *
 * @module src/aggregate-expiry.ts
 */
import { NEVER, UNUSABLE } from './aggregate-core.js';
import { isExclusiveCreditPool } from './credits.js';
// 腾讯 Marvis（2026-11-09）：钱包只有「剩余 / 总量」，没有任何到期时间。
import { fetchMarvisBalanceDetailed } from './marvis-credits.js';
import { runtimeOf } from './provider-runtime.js';

/**
 * 真实临期探针：**每个渠道折算成一个「最早失效时刻」**。
 *
 * ## 逐渠道判据（口径与 `jet-hub-auto` 完全一致，故复用同一套端点）
 *
 * | provider | 判据 | 依据 |
 * |---|---|---|
 * | buddy / workbuddy / **lobsterai** / **trae** | 有效资源包 `deductionEndTime` 的最小值（**共享** `sharedPackageExpiry`）；**无 `remaining > 0` 的有效包 ⇒ `UNUSABLE`** | `credits.ts` / `lobsterai-credits.ts` / `trae-credits.ts` |
 * | loomy | `daily > 0` → 当日 24:00；否则 `permanent > 0 ? NEVER : UNUSABLE` | 命名池，无时间戳 |
 * | codearts | **`NEVER`（长期）** | ⚠️ **报文无任何时间字段**（实测三字段全空）⇒ 不臆造 |
 * | zcode | 各桶 `expiresAt`（秒）最小值；**有余额但无到期时间 → 当日**；余额为 0 → `UNUSABLE`；**企业版（`enterprise`）→ `NEVER`** | `zcode-upstream.ts` |
 * | 其余（qoder / qodercn / cline / raccoon / minimax / gemini / opencode） | **本插件未接入** → `UNUSABLE` | 见设计文档 §9.1 |
 *
 * ## ⚠️ 未接入的渠道必须返回 `UNUSABLE`，**不能**返回 `NEVER`
 *
 * `NEVER` 的语义是「可用、只是无临期额度」，它**参与排序且可当选**。若把一个
 * 尚未实现的渠道折算成 `NEVER`，它会以「永久积分」的身份参与轮换 —— 而我们对
 * 它的余额**一无所知**（可能早就用尽了），结果是请求被发到一个没额度的渠道。
 * ⇒ 未接入 = `UNUSABLE` = 剔除。**宁可少一个候选，不可把未知当可用。**
 *
 * ## 为什么只探「一个代表账号」
 *
 * 渠道**内部**的换号由各适配器每次请求现做（buddy/loomy 走余额选号器，其余走
 * `getAvailableAccount` + 429 换号）。本层只回答「这个渠道现在能不能用、它的
 * 临期额度大概什么时候作废」，不替它们选账号。
 *
 * ## ⚠️ 取代表账号时必须带**真实 modelId**
 *
 * `getAvailableAccount` 对空 `modelId` 会**跳过限流过滤**（`account-pool.ts`），
 * 于是取回的是「手动序第一个启用账号」——**哪怕它此刻正在限流**。后果是多账号
 * 池里临期额度被完全忽略。故这里先取一个真实模型 id 再取号。
 *
 * ⚠️ `AbortError` **不得**折算成 `UNUSABLE`：用户取消请求时看到「请先登录」
 * 是误导（真实缺陷，PR !69 审计实测）。
 */
/**
 * **已接入临期折算**的渠道 id。
 *
 * ## ⚠️ 为什么必须导出（审计轮次二实测证伪的缺陷）
 *
 * 聚合层的目录会**广告**出所有能推导出规范名的虚拟模型 —— 包括**候选全来自
 * 未接入渠道**的那些。但那些候选一律被折算成 `UNUSABLE`（正确，见上方注释），
 * 于是用户选中它拿到的是：
 *
 * ```
 * MISSING_CREDENTIAL | 「xxx」当前没有任何可用候选（渠道被关闭、模型被关、
 *                      或所有渠道都无可用账号）
 * ```
 *
 * ⇒ 把「**该渠道的临期折算尚未实现**」谎报成「**你没登录 / 渠道被关**」——
 * 正是本仓库反复修的那类误导性报错。实测（探针）：只接 `cline`（未接入）时
 * `listModels('aggregate')` 仍返回 `['auto','deepseek-v4-1-flash','muse-spark-1-3']`。
 *
 * ⇒ 聚合目录只播报「**至少有一个已接入候选**」的虚拟模型；`auto` 不受影响
 *（它的池跨全部渠道，任一已接入渠道有账号就能路由）。
 *
 * ## ⚠️⚠️ 为什么它必须是**编译期常量**，不能从 runtime 派生（2026-10-08 设计复审）
 *
 * 本清单回答的是「**这个渠道接入了临期折算吗**」—— 那是一个**编译期事实**
 *（本文件有没有为它写折算原语）。而 `ProviderRuntime.expiry` 回答的是另一个问题：
 * 「**运行时该调哪个原语**」。两者**不是同一件事**，故不能互为派生源。
 *
 * 具体后果（**实测**，不是推断）：本清单在源码里有 **4 个**消费点 ——
 * 3 处在 `aggregate-adapter.ts` 的过滤（探测过滤 / 候选过滤 / 虚拟模型过滤），
 * 1 处是本文件的「未接入」短路。而**既有测试**里有两个大批量的构造点：
 * **29 处**临期探针工厂调用、**86 处** `AggregateAdapter` 构造 —— 那些文件
 * **一次都不调 `apply()`**（`aggregate-expiry` / `aggregate-wiring` /
 * `zcode-expiry-exhausted` 三份的 `apply` 命中**都不是真实调用**：实测分别是
 * 3 / 0 / 0 处，有命中的那份全是注释里的字）。
 * ⚠️ **计数口径**（便于复核，2026-10-08 实测）：在 `tests/unit` 里 grep
 * 「工厂名 + 左括号」共 36 处，减去 `expiry-runtime-parity.spec.ts` 自己的 7 处
 * ⇒ **既有 29 处**；grep「`new` + `AggregateAdapter` + 左括号」共 86 处
 *（全在既有文件）。⚠️ 本仓库的注释刻意**不写出左括号**，否则注释自己会被
 * 下一次 grep 计进去（自指），数字就再也复核不出来。
 * 而 runtime 注册只发生在 `apply()` ⇒ 派生版本在这些场景下**恒为空数组**，于是：
 *
 * | 后果 | 严重度 |
 * |---|---|
 * | `refreshCatalog` 把所有虚拟模型过滤掉 ⇒ **聚合 provider 的模型列表整个变空** | 致命 |
 * | 上述 29 + 86 处构造点大面积变红 | 高 |
 *
 * ⚠️ **不要**把它说成「生产路径也会变空」—— 那是**没有证据**的推断，已实测证伪：
 * `src/index.ts` 里聚合适配器确实在 runtime 注册**之前**创建（`registerAggregateLlm`
 * 调用早于 `registerProviderRuntime` 那段循环），但 `catalog-prewarm` 的首次预热是
 * `queueMicrotask` 排的，而 `apply()` 是**同步**函数 ⇒ 微任务在 `apply()` **整体
 * 返回之后**才跑，那时注册（同步段内）早已完成。
 * 实测（`node -e` 复现同一时序）：`sync-A → registration → sync-B → microtask → prewarm`。
 * ⇒ 派生版本在**生产**启动窗口内其实是安全的；**决定性证据是上面那两组实测计数**
 * （29 处探针 + 86 处适配器构造，全都不调 `apply()`），不是「生产会挂」。
 *
 * ⇒ 保持常量。它与 runtime 的一致性由
 * `tests/unit/expiry-runtime-parity.spec.ts` 的「**清单 == runtime 里挂了
 * `expiry` 域的渠道集合**」锁死（真跑 `apply()`）—— 那条锁的是真实会发生的漂移
 *「有人加了 runtime 注册却忘了加清单」（或反之），**不是**同义反复。
 */
export const WIRED_EXPIRY_PROVIDERS = Object.freeze([
    // ⚠️ 腾讯 Marvis（2026-11-09，本 fork 独有）：折算原语见 `marvisExpiry`，
    //    属「**有余额但不下发到期时间**」那一类（钱包报文只有 total/used/frozen）
    //    ⇒ 有余额即 `NEVER`、烧光即 `UNUSABLE`。
    //    ⚠️⚠️ **决定候选表可见性的是本表、不是 `AGGREGATE_CHANNELS`** ——
    //    只加后者 ⇒ 归一化再对也没用，症状**静默**（该陷阱在原仓库已复发 7 次）。
    'marvis',
]);

/**
 * 临期折算结果的**缓存时长**（毫秒）。用户 2026-10-07 要求加缓存，TTL 由用户在
 * 60 / 90 / 120 中选定 —— **取 60**。
 *
 * ## 为什么是 60
 *
 * - 与既有的 {@link BUDDY_BALANCE_CACHE_TTL_MS}（余额选号器，`60_000`）**同值** ——
 *   两处节奏一致，不会出现「选号用 30 秒前的数据、排序用 90 秒前的」这种分叉；
 * - 临期判据的最小粒度是**天**（资源包到期以天计）⇒ 60 秒滞后在语义上无害；
 * - 最短 ⇒ 用户改完渠道侧配置后最坏等待最短。90/120 只省极少量请求
 *  （面板与排序都不是高频路径），却让「刚登录的账号不出现在排序里」的窗口更长。
 */
export const EXPIRY_CACHE_TTL_MS = 60_000;
/**
 * **单渠道折算的总预算**（毫秒）。
 *
 * ## 为什么必须封顶
 *
 * 本函数内部 `for (const item of credentials)` **串行**折算，而单账号折算自带
 * 30 s 级的上游超时（各 `*Expiry` 自己的 `*_REQUEST_TIMEOUT_MS`）⇒ 单渠道最坏
 * 耗时 = **账号数 × 单账号超时**。账号池随用户增删账号线性增长，于是「发一条
 * 消息 / 打开面板」的等待被账号数线性放大。
 *
 * ## ⚠️ 本仓库的**具体取证**（上游 86e3591 把它删了，本仓库保留）
 *
 * 上游删掉下面这段的理由，是**他们那份仓库里 `buddy` / `workbuddy` 查无实据**
 * （`PROVIDER_REGISTRY` 只有 20 个 id、`src/` 下无 `buddy-*.ts`）。
 * **该理由在本仓库不成立**：这两家就在下面的 {@link WIRED_EXPIRY_PROVIDERS} 里，
 * 也都在 `provider-expiry.ts` 的 `createProviderExpiry()` 里（`buddyFamilyExpiry`）
 * ⇒ 走 `buddyExpiry` → `fetchCreditBalance`（`credits.ts` 的
 * `REQUEST_TIMEOUT_MS = 30_000`）。故这条**真实故障**证据在本仓库成立，按
 * 「如实登记真实故障证据」保留：
 *
 * - 用户报障「重启后配置一直加载不出来」；同机实测 `session/modelCatalog`
 *   冷启动 **290 000 / 222 000 / 54 000 ms**（中位 **222 秒**），而同一时刻
 *   `settings/describe` 只要 **68 ms** ⇒ 事件循环没被堵，是本函数在逐账号串行等上游；
 * - 该机账号池 **workbuddy 7 个号 + buddy 8 个号** ⇒ 最坏 `7×30 + 8×30 = 450 s`；
 * - 账号数在 2026-10-17 23:00 到 10-18 00:30 之间从 **17 涨到 31**
 *   ⇒ 用户感受到「昨天还能忍、今天撞墙」。
 *
 * ⚠️ 顺带订正上游 commit message 里一条**在本仓库为假**的断言：它说
 * `credits.ts` 的 `REQUEST_TIMEOUT_MS`「在 `createProviderExpiry()` 里没有消费者
 * （死路径）」—— 本仓库里 `fetchCreditBalance` **正是** buddy 系的消费者。
 *
 * ## ⚠️⚠️ 它封的是哪条路径（别读错 —— 这里已误判过两次）
 *
 * 本探针的消费者只有**两处**，且都**不在**目录加载路径上：
 *
 * | 消费者 | 何时跑 |
 * |---|---|
 * | `aggregate-adapter.ts` 的 `candidatesFor` | **发消息**（`prepareCall`） |
 * | `aggregate-adapter.ts` 的 `describeExpiryOrder` | 面板「按临期排序」（用户点按钮） |
 *
 * ⚠️ `buildModelCatalog` / `resolveModel` / `listModels` / `refreshCatalog`
 * **一律不调本探针**（前者走 `coldModelInfo` + 后台刷新，后两者只读各渠道目录）
 * ⇒ **本预算不会缩短模型选择器的冷启动耗时**。想改善那条路径要动的是
 * `AGGREGATE_BACKGROUND_REFRESH_TIMEOUT_MS` 与 `catalogForListModels`，不是这里。
 * 把因果链写成「修 `modelCatalog` 冷启动」是**错的**（2026-10-22 审计实测：
 * 那四个方法体里 `expiryProbe` 出现 0 次）。
 *
 * ## 为什么是 8 秒
 *
 * - `candidatesFor` 是**发消息**路径（用户按了发送正在等），超过 10 秒已可认为卡死；
 * - 正常情况下一个渠道折算远低于 8 秒（本仓库排障日志里 codearts / trae / zcode
 *   均在 1.2 秒内）—— 8 秒只截断「上游在超时边缘」的渠道；
 * - 被截断的渠道按**保守方向**处理，与本文件铁律
 *   「宁可少一个候选，不可把未知当可用」一致。
 *
 * ## ⚠️⚠️ 预算**按账号均分**，不是「先到先得」（2026-10-22 审计打穿后改）
 *
 * 初版是「首号吃满整个预算，耗尽就 `break`」。实测后果：某渠道的**第一个**账号
 * 稳定慢于 8 秒 ⇒ 后面所有账号**每一轮都轮不到** ⇒ 每轮都 `UNUSABLE` ⇒ 还被
 * `cacheAndReturn` 缓存 60 秒 ⇒ 该渠道在聚合轮换里**永久不可见**。
 * 那正是上一版注释自称要避免的故障，被自己的实现从另一个入口做了出来
 *（`listAvailableCredentials` 的顺序 = `readAccounts()` 固定顺序，无轮转 ⇒ 每轮
 * 都是同一个「首号」）。
 *
 * ⇒ 现在每个账号只拿「**剩余预算 ÷ 剩余账号数**」（见循环处的 `perAccountMs`）：
 * 总时长仍 ≤ 本预算，但**每个账号都有一次机会**。
 *
 * ⚠️ 截断**不是**把结果写成 `NEVER`：那会让一个我们其实没查清的渠道以
 *   「永久可用」身份参与排序。已成功折算的账号仍按**真实观测值**返回
 *   （如实登记：那是**部分观测**，不是全量）；一个都没成时才 `UNUSABLE`。
 */
export const EXPIRY_PROBE_BUDGET_MS = 8_000;
/**
 * 单账号可用的**最低预算下限**（毫秒）。
 *
 * ## 为什么必须有下限（2026-10-22 审计打穿后补）
 *
 * 预算按「剩余预算 ÷ 剩余账号数」均分后，账号一多，每份就会小到不可用：
 * 8 秒 ÷ 31 个账号 = **258 ms**，而正常的折算实测在 350 ms ~ 1.2 s 之间 ⇒
 * **每个账号都会被自己的那份截断** ⇒ 整渠道 `UNUSABLE`，等于把「账号多」直接
 * 变成「渠道不可见」。那与 {@link EXPIRY_PROBE_BUDGET_MS} 要解决的问题同型。
 *
 * ⇒ 每份取 `max(下限, 均分)`：宁可让本渠道**略微超出**总预算，也不让任何一个
 * 账号因为「排得靠后」或「账号太多」而被跳过。超出量有界（≤ 账号数 × 下限），
 * 且只在「前几个账号各自吃满自己那份」的病态情形下才叠加。
 *
 * ⚠️ 取值理由：1.2 秒是实测里最慢的正常渠道（trae）的耗时量级 ⇒ 取 1.5 秒留余量。
 * 再小会让正常渠道被误截断；再大则「账号多」时总耗时增长过快。
 */
export const EXPIRY_PROBE_MIN_SLICE_MS = 1_500;
/**
 * 归一化 {@link ExpiryProbeOptions.budgetMs}（**纯函数，可直接单测**）。
 *
 * ## 为什么必须有它（2026-10-22 审计打穿）
 *
 * 初版只判 `budgetMs === 0`，其余值原样交给 `setTimeout`。而 `setTimeout` 的
 * 延迟是 **32 位有符号整数**，越界/`NaN` 会被 Node **钳成 1 ms**（并打一条
 * `TimeoutOverflowWarning` / `TimeoutNaNWarning` 到 stderr）。实测后果：
 *
 * | 传入 | 实测（3 账号全挂死） |
 * |---|---|
 * | `Infinity`（「不封顶」最自然的直觉写法） | 每个账号**瞬间** UNUSABLE（计时器 1 ms） |
 * | `NaN` / `1e10` / 字符串 `'0'` | 同上 |
 * | `-1` | `deadline` 在过去 ⇒ **0 次 fetch** |
 *
 * ⇒ 判据：**只有有限的非负数被采纳**；`0` 保留「不封顶」语义；其余一律回落
 * 默认值（`Infinity` 也回落 —— 想要不封顶请传 `0`，那是唯一登记的写法）。
 *
 * ⚠️ 上界 `2 ** 31 - 1` 是 `setTimeout` 自己的上限，超过它就会被钳成 1 ms ⇒
 *   必须在**这里**截断，而不是指望 `setTimeout` 帮忙。
 */
export function normalizeExpiryProbeBudget(raw) {
    const max = 2 ** 31 - 1;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0)
        return EXPIRY_PROBE_BUDGET_MS;
    if (raw === 0)
        return 0;
    return Math.min(raw, max);
}
/**
 * 算出「**当前这个账号**可以等多久」（**纯函数，可直接单测**）。
 *
 * ## 为什么把它抽出来（2026-10-22 变异验证的血泪）
 *
 * 这段算术原本内联在循环里，于是只能用**耗时**来判它有没有生效。实测：
 * 「去掉 `min(剩余预算, …)`」这个变异只让 31 个账号的耗时从 8.01 s 变成 9.05 s
 * —— 而**探测账号数两者完全相同**（都是 6 个）。⇒ 那条用例：
 * - 用 `toBeLessThan(预算 + 5s)` 时对变异**完全无牙**；
 * - 用 `toBeLessThan(预算 + 1.2s)` 时又会被 CI 抖动打成**时红时绿**。
 *
 * ⇒ 抽成纯函数后，判据变成**确定性的逐格算术**，与时钟无关。
 *
 * ## 口径：`min(剩余预算, max(下限, 均分))`
 *
 * | 项 | 作用 |
 * |---|---|
 * | `均分` = 剩余 ÷ 剩余账号数 | 让**每个账号都有机会**；快账号省下的预算自动滚给后面的 |
 * | `下限` = {@link EXPIRY_PROBE_MIN_SLICE_MS} | 账号多时均分会小到不可用（8 s ÷ 31 = 258 ms，而正常渠道实测 350 ms~1.2 s）⇒ 没它会把「账号多」直接变成「全被截断」 |
 * | **`min(剩余预算, …)`** | **总时长硬上界** —— 下限**不得**透支预算 |
 *
 * ⚠️ 第三项是必须的：我第一版漏了它，实测 31 个账号全挂跑了 **46.8 秒**（31 × 下限）。
 *
 * @param budgetMs - 已归一化的总预算；`0` 表示不封顶。
 * @param remainingMs - 本渠道**还剩多少预算**（可能为负 / `Infinity`）。
 * @param remainingAccounts - **含当前账号在内**还有几个没探。
 * @returns 当前账号可等待的毫秒数（`Infinity` = 不封顶）。
 */
export function expiryProbeSliceMs(budgetMs, remainingMs, remainingAccounts) {
    if (budgetMs === 0)
        return Number.POSITIVE_INFINITY;
    const share = Math.floor(remainingMs / Math.max(1, remainingAccounts));
    return Math.min(remainingMs, Math.max(EXPIRY_PROBE_MIN_SLICE_MS, share));
}
export function createExpiryProbe(pool, firstModelIdOf, options = {}) {
    /**
     * 按渠道缓存折算结果（用户要求：排序读缓存，不每次打服务器）。
     *
     * ## ⚠️ 为什么缓存必须在**这个工厂内部**（而不是各调用方自己加）
     *
     * `auto-adapter.ts` 的 `expiryOf` **每次调用都新建一个 probe**
     *（`createExpiryProbe(pool, …)`），聚合层也用同一个工厂 ⇒ 若缓存放在调用方，
     * `auto` 与聚合会**各查一遍**，且 `auto` 那条路径每次都从零开始（等于没缓存）。
     * 放在工厂内部后，**同一装配期内的所有调用共享一份** ——
     * `src/index.ts` 里两个适配器用的是**同一个** probe 实例（见那里的装配注释）。
     *
     * ⚠️ 缓存键是**渠道 id**（不是模型）：临期额度是账号级的，与模型无关
     *（`buddyExpiry` 等只读账号的资源包）。不同渠道必须各自缓存。
     *
     * ⚠️ **中止不写缓存**（见下方 `catch`）：一次取消若留下条目，后续请求会误命中
     * 一个「上次被取消」的结果。
     */
    const cache = new Map();
    const now = () => options.now?.() ?? Date.now();
    const ttl = options.ttlMs ?? EXPIRY_CACHE_TTL_MS;
    /**
     * 写缓存并返回该值。
     *
     * ⚠️ **`UNUSABLE` 也缓存**（不是只缓存成功值）：一个渠道「现在没有可用账号」
     * 在 60 秒内不会变，不缓存会让面板与排序在每次刷新时都为它白跑一遍
     *（取号 + 目录读取）。与 `buddy-balance-selector` 的失败短 TTL 取舍**不同** ——
     * 那里失败会被判「额度用尽」（有误导性后果）故用 5 秒；这里 `UNUSABLE` 只是
     * 「本轮剔除该候选」，60 秒的滞后无害。
     *
     * ⚠️ 但**中止不写缓存** —— 那由调用点保证（`AbortError` 会 throw，走不到这里）。
     */
    /**
     * 缓存**代际**：`clear()` 递增它。
     *
     * ## ⚠️ 为什么需要（真实缺陷，对抗审计实测证伪）
     *
     * `cacheAndReturn` 在探测**结束时**写缓存。若一个探测**早在 `clear()` 之前**
     * 就已开始（正卡在某个 `await` 上），它的写回发生在 `clear()` **之后**
     * ⇒ **陈旧值活过整个 TTL** —— 用户「清缓存」的努力被一个在途请求作废。
     *
     * 实测：`clear() 期间在途探测 ⇒ -1 ｜ clear 后再探 ⇒ -1 ｜ 取号次数 = 1`
     * ⇒ 登录后清缓存，但那个「登录前开始、登录后才结束」的探测把 `-1`（不可用）
     * 又写了回去，用户仍要再等 60 秒（正是本修复要消灭的那个现象）。
     *
     * ⇒ 探测在**开始时**记下代际，写回时代际不符就**丢弃**（不写缓存）。
     */
    let generation = 0;
    /**
     * 写缓存并返回。
     *
     * ⚠️ **中止不写缓存** —— 那由调用点保证（`AbortError` 会 throw，走不到这里）。
     *
     * @param startedAt - 本次探测**开始时**的代际（`clear()` 会让它过期）
     */
    const cacheAndReturn = (forProvider, value, startedAt) => {
        // ⚠️ 代际不符 ⇒ 这是一次「跨越了 clear() 的在途探测」⇒ **丢弃**，不写缓存
        //   （否则陈旧值会活过整个 TTL，让 clear() 形同虚设）。
        if (startedAt === generation)
            cache.set(forProvider, { at: now(), value });
        return value;
    };
    return Object.assign(async (provider, signal) => {
        // ⚠️ **缓存命中也要先查 signal**：中止必须立刻以 `AbortError` 结束，
        //    不能因为「反正有缓存」就把取消吞掉（与下方短路同一口径）。
        signal?.throwIfAborted();
        const cached = cache.get(provider);
        if (cached !== undefined && now() - cached.at < ttl)
            return cached.value;
        // ⚠️ **未接入的渠道直接返回 `UNUSABLE`，不取号、不读目录**（第 3 轮审计实测）。
        //
        // 为什么要在最前面短路：本函数对**未接入**渠道最终也返回 `UNUSABLE`（走下方
        // `credentialExpiry` 的「无 `expiry` 域」分支），但那时**已经**做了两件无意义的事：
        //   ① `await firstModelIdOf(provider)` —— 一次渠道目录读取；
        //   ② `await pool.getAvailableAccount(...)` —— 一次账号池查询。
        // 而 `candidatesFor` 的池包含**全部**渠道的候选 ⇒ 每次 `auto` 请求都会为**每个**
        // 未接入渠道白做这两件事（实测探针：`getAvailableAccount` 被以 `cline/m1` 调用）。
        //
        // ⚠️ 两件都**不是网络请求**（`getAvailableAccount` 是纯本地内存过滤），故这属
        // **性能浪费**而非功能缺陷；但短路是零成本的，且让语义更准确 ——
        // 「未接入」与「有账号但折算不了」是两件事，不该走同一条路径。
        //
        // ⚠️ `signal` 仍要先查：中止必须**立刻**以 `AbortError` 结束（全局约束），
        //    不能因为「这个渠道反正未接入」就把中止吞掉。
        signal?.throwIfAborted();
        if (!WIRED_EXPIRY_PROVIDERS.includes(provider))
            return UNUSABLE;
        // ⚠️ 记下**本次探测开始时**的代际：若中途有 `clear()`（用户刚登录），
        //    写回时会被丢弃（否则陈旧值活过整个 TTL —— 见 `cacheAndReturn` 的长注释）。
        const startedAt = generation;
        // ⚠️ 类型是 `unknown[]`（各渠道凭据形状不同，由 `credentialExpiry` 分派时收窄）。
        //
        // ★ 2026-10-12：改为保留**账号条目 id**（`entry.id`）—— zcode 的按模型额度
        //   标记必须写到**具体账号**上（`modelRateLimits` 是账号级字段），
        //   而 `credential` 里没有账号 id（`device_mid` 是我们每次随机生成的，不可用）。
        //   ⚠️ 旧回退路径（`legacySingleCredential`）拿不到 id，故那里显式填 `undefined`
        //   —— 后果只是「那条路径下 zcode 写不了标记」，不影响折算值。
        //
        // ★ 2026-10-13：**同时保留 `credentialRef`** —— officeace 的余额入口只有拿到
        //   它才走云侧直读（否则回落果办客户端的全局单 cookie ⇒ 多账号串号，
        //   而聚合候选排序是**每账号**粒度 ⇒ 会选错人）。同样只在回退路径缺失。
        let credentials;
        /**
         * 该渠道目录的第一个模型 id（空串 = 目录读不到）。
         *
         * ⚠️ **必须提到 `try` 外面**：`catalogIds` 的降级分支要用它（2026-10-12）。
         */
        let probeModel = '';
        try {
            // ⚠️ `?? ''` 是**有意的**降级（注释随搬移丢失，Task 7 复审 M3 指出，现补回）：
            // 目录不可读 / 无可用模型时退回空串 —— 此时「有没有账号」这个判据**仍然成立**，
            // 只是**限流维度退化为不参与**（`getAvailableAccount` 对空 modelId 跳过限流
            // 过滤）。取舍方向：宁可少筛一层，也不可把整池判成不可用。
            // ⚠️ 反之**不要**在这里因为拿不到 modelId 就 return UNUSABLE —— 那会让
            // 「目录暂时读不到」被误报成「这个渠道没账号」。
            probeModel = await firstModelIdOf(provider) ?? '';
            // ⚠️⚠️ **取全部启用账号，而不是一个代表账号**（真实缺陷，用户报障 2026-10-07）。
            //
            // 用户质疑：「workbuddy 中一个号是 1 天到期，为什么我们统计是 2000 多天，
            // **只用了第一个账号吗**？」—— 他猜对了。旧实现走 `getAvailableAccount`，
            // 那个方法只返回**手动序第一个**可用账号 ⇒ 用户把「1 天到期」的号拖到后面时，
            // 它的临期额度在**排序**里被完全忽略：这个渠道明明有一个快作废的号，
            // 却被按「2000 多天后才作废」排到最后。
            //
            // ⇒ 改为取**全部**账号，逐个折算，取**最早**的那个（见下方 `earliest`）。
            //   ⚠️ 这不改变「实际发请求用哪个账号」（那仍由适配器按手动顺序选），
            //   只改变「这个渠道整体的临期额度何时作废」这个**观测**口径。
            //
            // ⚠️ **`listAvailableCredentials` 是可选方法**（结构化类型）：它不存在时回退到
            //    `getAvailableAccount`（只探一个代表账号）。回退不是为了兼容老装配 ——
            //    真实装配（`src/index.ts`）永远传完整的 `AccountPool`；回退是为了让
            //    **既有测试桩**（只实现 `getAvailableAccount`）仍然可用，尤其是
            //    `auto-adapter.spec.ts` —— 那份 spec 是**硬约束：必须零改动且全绿**
            //   （它是两处「搬移而非复制」重构的安全网）。
            //    ⚠️ 回退路径的语义是**降级**（少看几个账号），不是错误。
            //
            // ⚠️⚠️ **取号必须传空 `modelId`（跳过「按模型」过滤）** ——
            //    真实缺陷（本机实测 2026-10-12）：原先传的是 `probeModel`，
            //    而那会让本函数陷入**死锁**、且**整个渠道**从候选里消失：
            //
            // | 步骤 | 发生了什么 |
            // |---|---|
            // | ① | `probeModel = firstModelIdOf(provider)` = 目录**第一个**模型 |
            // | ② | 某次折算把「该模型已尽」写进 `modelRateLimits[probeModel]` |
            // | ③ | 下次折算取号 `listAvailableCredentials(provider, probeModel)` **按模型过滤** ⇒ 账号被筛空 |
            // | ④ | `credentials.length === 0` ⇒ 返回 `UNUSABLE` ⇒ **折算根本没跑** |
            // | ⑤ | 于是既清不掉标记、也写不了新标记 ⇒ 标记挂到次日 0 点 |
            // | ⑥ | **整个 zcode 渠道**在这期间对 auto / aggregate 不可见 |
            //
            // ⚠️ 实测（`scripts/verify-zcode-mark-self-heal.mjs`）：
            //    zcode 兜底目录顺序为 `[GLM-5.3-Flash, GLM-5.3]` ⇒ 只要
            //    **被标记的是 `GLM-5.3-Flash`**（用户实际一直在用的那个模型，
            //    真实会话日志 1359 次）就命中死锁。不是边角情形。
            //
            // ⇒ **折算问的是「这个渠道整体最早何时作废」，与「哪个模型」无关**
            //   （判据只看各账号的资源包 / 余额到期时刻）。按模型过滤在这里
            //   既**多余**（2026-10-07 起，派发前已由 `hasUsableAccountFor` /
            //   `filterByModelAvailability` 按**真实模型**复核），又**有害**（上面的死锁）。
            //   ⇒ 空串正是本仓库「不按模型过滤」的既有语义
            //   （`getAvailableAccount` / `listAvailableCredentials` 对空 `modelId`
            //    都有专门注释：跳过限流过滤、保持候选不变）。
            //
            // ⚠️ 这条也修正了**代码与注释的矛盾**：上面那句「取**全部**账号」
            //    在原实现里并没有真的做到（被 `probeModel` 过滤掉了一部分）。
            credentials = typeof pool.listAvailableCredentials === 'function'
                ? await pool.listAvailableCredentials(provider, '')
                : // ⚠️ **回退路径刻意保留 `probeModel`**（与本函数主路径不同，理由如下）：
                    //    ① 它只对**测试桩**可达（生产装配的 `AccountPool` 永远有
                    //       `listAvailableCredentials`）；
                    //    ② `auto-adapter.spec.ts` 有一条**明确禁止空 modelId** 的用例
                    //       （「取代表账号时不得用空 modelId（会让限流过滤整体短路）」）——
                    //       它守的是**另一个真实缺陷**（空 modelId 让账号池的限流过滤整体失效，
                    //       于是 auto 会把请求发给一个正在限流的账号）。
                    //    ⚠️ 残余风险**如实登记**：这条路径同样具备上面的死锁形态
                    //       （`getAvailableAccount` 也按模型过滤）。它当前不可达，
                    //       故不改它 —— 改它会与那条既有用例冲突，而那条用例守的缺陷
                    //       在生产上是**可达**的（主路径传空串不影响它，因为主路径
                    //       取的是全部账号、不经 `getAvailableAccount`）。
                    (await legacySingleCredential(pool, provider, probeModel)).map((credential) => ({
                        entry: { id: undefined },
                        credential,
                    }));
        }
        catch (error) {
            // ⚠️⚠️ **中止不得被吞成 `UNUSABLE`**（Global Constraints 的硬要求）。
            //
            // 为什么需要这两行：本 `try` 里有两个可能抛错的调用 —— `firstModelIdOf`
            // （装配层注入，会读渠道目录）与账号池查询。任一在**探测途中被取消**时抛出的
            // `AbortError` 若被直接折算成 `UNUSABLE`，用户取消请求后看到的是
            // 「没有任何可用候选」而不是中止（误导性报错），且与「真的没登录」无法区分。
            // 与本仓库既有口径相反：`aggregate-core.ts` 的哨兵注释
            //「abort **立刻抛 `AbortError`**，绝不折算成 `UNUSABLE`」。
            //
            // ⚠️ 两行都要，覆盖两种情形（Task 7 复审 M1/M2 订正）：
            // - `throwIfAborted()` 覆盖「signal **已被标记**」——**这是当前生产装配下
            //   实际生效的那条**；
            // - `isAbortError(error)` 覆盖「signal 未必标记、但抛出的就是 AbortError」。
            //   ⚠️ 实测（Task 7 复审 M2）：当前装配的 `firstModelIdOf` 是
            //   `ctx.llm.listModels(provider)`，而 **`LlmRuntime.listModels` 只接受
            //   provider 一个参数、没有 signal 通道**（`dsh-llm/lib/index.js:1471`）
            //   ⇒ 这一条在当前装配下不可达，是**防御性**的（装配层若改成会响应 signal
            //   的取号方式，它就生效）。
            signal?.throwIfAborted();
            if (isAbortError(error))
                throw error;
            return UNUSABLE;
        }
        // ⚠️ 一个可用账号都没有 ⇒ UNUSABLE（「这个渠道现在不能用」）。
        //    注意与「账号可用但读不到到期时间」严格区分 —— 后者由各 `*Expiry` 返回
        //    `NEVER`（可用、只是不临期），绝不能在这里一并判成不可用。
        if (credentials.length === 0)
            return cacheAndReturn(provider, UNUSABLE, startedAt);
        // ⚠️ 逐个账号折算，取**最早**的到期时刻（用户选定：探全部账号、取最早）。
        //    任一个账号折算失败不影响其余（跳过它）—— 一个坏账号不该让整个渠道被剔除。
        let earliest = NEVER;
        // ⚠️⚠️ **必须记录「是否有任何一个账号折算成功」**（真实缺陷，独立审计实测证伪）。
        //
        // 旧实现只看 `earliest` 的终值：若**所有**账号都折算失败（每个都 `continue`），
        // `earliest` 仍是初值 `NEVER` ⇒ 该渠道被判「**可用**、只是不临期」⇒ **进入排序
        // 且可当选**（`rankCandidates` 只剔除 `UNUSABLE`）。
        //
        // 而「所有账号都查不到额度」= 我们对这个渠道**一无所知** ⇒ 必须 `UNUSABLE`（剔除）。
        // 这与本模块头的铁律**直接矛盾**：「未接入 = `UNUSABLE` = 剔除。**宁可少一个候选，
        // 不可把未知当可用。**」
        //
        // 实测场景：buddy 有两个已登录账号、上游余额接口 5xx（或 token 全过期）⇒
        // 旧实现让该渠道进入排序，请求被发到一个额度未知（可能已用尽）的渠道。
        // 且该错误值还会被缓存 60 秒。
        let anyConverted = false;
        /**
         * ★ 该渠道的**全部目录模型 id**（zcode 的按模型判定用，2026-10-12）。
         *
         * ⚠️ **惰性求值**：只在实现方真的声明需要它时才去读目录
         * （省下其余 6 家每轮一次多余的目录读取）。
         * ⚠️ 未注入 `catalogIdsOf` 时退回「只有 probeModel 一个」——
         * 让既有装配与几十处测试桩零改动即可工作（只是判定范围窄一个模型）。
         */
        let catalogIdsCache;
        const catalogIds = async () => {
            if (catalogIdsCache !== undefined)
                return catalogIdsCache;
            try {
                const ids = await options.catalogIdsOf?.(provider);
                catalogIdsCache = ids !== undefined && ids.length > 0
                    ? ids
                    // ⚠️ 未注入 `catalogIdsOf`（既有装配 / 几十处测试桩）时退回
                    //    「只有 probeModel 一个」—— 判定范围窄一个模型，但**零改动可用**。
                    //    ⚠️ `probeModel` 为空串时给**空数组**：空数组会让 zcode 的
                    //    `exhaustedModelsOf` 一个模型都不判（**保守方向**：不写任何标记），
                    //    而填 `['']` 会写一个键为空串的垃圾标记。
                    : (probeModel.length > 0 ? [probeModel] : []);
            }
            catch {
                // ⚠️ 目录读失败**不得**让折算失败：退回 probeModel 一个（判定范围变窄，
                //    但折算值本身照常）。与 `firstModelIdOf` 的降级同一取向。
                catalogIdsCache = probeModel.length > 0 ? [probeModel] : [];
            }
            return catalogIdsCache;
        };
        const markModelsExhausted = pool.markModelsExhaustedForExpiry?.bind(pool);
        const clearModelsExhausted = pool.clearModelsExhaustedForExpiry?.bind(pool);
        /**
         * 共享余额读数入口（装配层注入；未注入 ⇒ 全部实现方走自己的回落路径）。
         *
         * ⚠️ 签名里的 `credential` 是**本次折算的那个账号的凭据**：缓存按
         * `(provider, accountId)` 去重，而**取数原语需要凭据** ⇒ 由本层把两者配对后
         * 传给缓存（`balanceCache.readOne`）。
         * ⚠️ 不注入时**不传**该字段（而不是传一个恒 `undefined` 的函数）：
         * 后者会让实现方白走一次「查缓存 → 未命中」的分支（行为相同，但多一层间接）。
         */
        const cachedBalanceOf = options.balanceOf;
        // ⚠️ 必须走归一化：初版直接 `?? EXPIRY_PROBE_BUDGET_MS`，于是 `Infinity`
        //    （最像「不封顶」的写法）会让 `setTimeout` 溢出被钳成 1 ms ⇒ 全部渠道瞬间
        //    UNUSABLE。判据与后果见 `normalizeExpiryProbeBudget` 的表。
        const budgetMs = normalizeExpiryProbeBudget(options.budgetMs ?? EXPIRY_PROBE_BUDGET_MS);
        /**
         * 把一次「单账号折算」限制在给定预算内。
         *
         * ⚠️ **超时返回哨兵值而不是抛错**：这不是调用方中止，而是我们自己的预算用完。
         * 抛 `AbortError` 会被上层误判成「用户取消」并冒泡成 `MISSING_CREDENTIAL`；
         * 返回 `UNUSABLE` 才符合「本轮剔除该账号」的语义。
         *
         * ⚠️ **`signal` 是第三个竞争者**（2026-10-22 审计补）。`credentialExpiry` 的
         * 签名里**没有** `signal`，各 `*Expiry` 用的是自己的 `AbortSignal.timeout(30_000)`
         * ⇒ 折算层唯一的 abort 防线是循环顶部的 `throwIfAborted()` 与 catch 里的两条，
         * 而**取消发生在 await 期间时它们全都看不到**。实测（`budgetMs: 0`，即升级前
         * 语义，取消于 100 ms）：仍等满 1.5 秒才返回 `UNUSABLE`，并把它**缓存 60 秒**
         * ⇒ 用户取消一次，该渠道对路由消失 60 秒，且报错是「请先登录」式的误导。
         * 这是**既有缺陷**（非本次改动引入），但修它正好落在本函数里，故顺手补上。
         *
         * ⚠️ 超时**不取消**在途的 fetch（各 `*Expiry` 内部自带自己的超时信号，
         * 它们会在自己的超时后结束）。这里只是**不再等它** —— 让它自然结束，
         * 避免把上游连接强行掐断引发重试风暴。
         *
         * ⚠️ **`Promise.race` 会订阅全部竞争者**，故落败者的 reject 不会变成
         * `unhandledRejection`（实测确认）。但**早退分支**（`budgetMs === 0`）只
         * `await task`、不订阅别的 —— 那里必须靠 `task` 自己，别把它改成
         * 「先建 race 再早退」（那会留下一个没人订阅的 promise）。
         *
         * ⚠️ 计时器**不能 `unref()`**（实测踩到）：调用方正 `await` 这次折算，
         * 若计时器不保持进程活跃，Node 会判定「没有待办」直接退出 ——
         * 独立验证时进程以 `Warning: Detected unsettled top-level await` 静默结束。
         * 这与后台写盘的 `unref` 场景不同：这里的计时器是**前台等待**的一部分。
         *
         * @param budgetForThisAccount - 该账号可用的毫秒数（**已按剩余账号数均分**，
         *   见循环处的 `perAccountMs`）；`budgetMs === 0` 时不封顶。
         */
        const withinBudget = async (budgetForThisAccount, task, signal) => {
            if (budgetMs === 0)
                return await task;
            let timer;
            let onAbort;
            /** 与 `timeout` 同一个哨兵：谁先胜出都只是「不再等」。 */
            const timeout = new Promise((resolve) => {
                timer = setTimeout(() => resolve(UNUSABLE), budgetForThisAccount);
            });
            /**
             * 中止竞争者：**抛** `AbortError`（不是 resolve 哨兵）—— 中止必须原样逃逸，
             * 与循环顶部 `signal?.throwIfAborted()` 同一口径。
             */
            const aborted = new Promise((_resolve, reject) => {
                if (signal === undefined)
                    return;
                if (signal.aborted) {
                    reject(abortErrorOf(signal));
                    return;
                }
                onAbort = () => reject(abortErrorOf(signal));
                signal.addEventListener('abort', onAbort, { once: true });
            });
            try {
                return await Promise.race([task, timeout, aborted]);
            }
            finally {
                if (timer !== undefined)
                    clearTimeout(timer);
                if (onAbort !== undefined)
                    signal?.removeEventListener('abort', onAbort);
                // ⚠️ `aborted` 若从未胜出（正常路径），它内部登记的 listener 已被摘掉；
                //    而 `Promise.race` 已订阅它 ⇒ 不会有未处理的 rejection。
                //    但若 `signal` 已 aborted 且 `reject` 已发生、race 又先被 task 胜出，
                //    那个 rejection 仍被 race 消费（实测无 unhandledRejection）。
            }
        };
        // ⚠️ **本渠道的预算起点**（见 `EXPIRY_PROBE_BUDGET_MS` 的长注释）。
        const deadline = budgetMs === 0 ? Number.POSITIVE_INFINITY : now() + budgetMs;
        for (let index = 0; index < credentials.length; index += 1) {
            const item = credentials[index];
            signal?.throwIfAborted();
            /**
             * ⚠️⚠️ **预算按「剩余账号数」均分，且**双重封顶**（2026-10-22 审计打穿后改）。
             *
             * ## 初版为什么错
             *
             * 初版把整个剩余预算交给当前账号、耗尽就 `break`。实测后果（真实报文形状）：
             * 第 1 号 12 秒后才失败、第 2 号 100 ms 就能成功 ⇒
             *   `budgetMs: 0` → 真实到期时刻（渠道可用）
             *   默认 8 秒    → `UNUSABLE`（渠道被判死，第 2 号**一次都没被问**）
             * 而 `listAvailableCredentials` 的顺序 = `readAccounts()` 的**固定顺序**（无轮转）
             * ⇒ 只要「首号」稳定慢于 8 秒，**每一轮**都是同一个首号、每一轮都 `UNUSABLE`
             * ⇒ 再被 `cacheAndReturn` 缓存 60 秒 ⇒ 该渠道在聚合轮换里**永久不可见**。
             * 这正是本常量上一版注释自称要避免的那件事。
             *
             * ## 现在的口径：`min(剩余预算, max(下限, 均分))`
             *
             * | 项 | 作用 |
             * |---|---|
             * | `均分` = 剩余 ÷ 剩余账号数 | 让**每个账号都有机会**，且快账号省下的预算自动滚给后面的 |
             * | `下限` = {@link EXPIRY_PROBE_MIN_SLICE_MS} | 账号多时均分会小到不可用（8 s ÷ 31 = 258 ms < 正常渠道的 350 ms~1.2 s）⇒ 没它会把「账号多」直接变成「全被截断」 |
             * | **`min(剩余预算, …)`** | **总时长硬上界** —— 下限**不得**透支预算 |
             *
             * ⚠️ 第三项是**必须**的（我第一版漏了它，实测 31 个账号全挂时跑了 **46.8 秒**
             * = 31 × 下限）：没有 `min`，下限会在预算耗尽后继续续命 ⇒ 预算形同虚设。
             * 现在 31 个账号全挂 ≈ 5 × 1500 + 500 = **8 秒**（有界），且**前 6 个账号都
             * 拿到了一次机会**（不是只有首号）。
             *
             * ## 已知代价（如实登记）
             *
             * 账号数超过 `预算 ÷ 下限`（默认 8 s ÷ 1.5 s ≈ 5 个）时，**靠后的账号本轮探不到**
             * ⇒ 若它们里有更早到期的那个，本轮返回的是**偏乐观**的到期时刻。
             * 这与「未探完 ⇒ 保守 ⇒ UNUSABLE」的铁律**不冲突**：铁律管的是「一个都没成」，
             * 这里已有一个成 ⇒ 渠道可用的**结论**是真的，只是排序值可能偏乐观。
             * ⇒ 真要根治得让起点**轮转**（每轮从不同账号开始），那是独立改动，不在本处。
             */
            const remainingAccounts = credentials.length - index;
            const remaining = deadline - now();
            // ⚠️ 预算真的用完了才停（`budgetMs === 0` 时 `remaining` 恒 Infinity，不会命中）。
            if (budgetMs !== 0 && remaining <= 0)
                break;
            const perAccountMs = expiryProbeSliceMs(budgetMs, remaining, remainingAccounts);
            const credential = item.credential;
            let value;
            try {
                /**
                 * ⚠️ `context` 对**另外 6 家**是纯粹的多余参数（它们忽略第二参）——
                 * 这不是「只为 zcode 开洞」，而是本仓库既有的「可选能力由实现自己声明」
                 * 模式（同 `ExpiryAccessors.refreshableOf` 的可选语义）。
                 *
                 * ⚠️ `catalogIds` 在这里**不求值**（传的是个函数）：只有 zcode 会调它，
                 * 其余 6 家每轮因此**零额外目录读取**（那是本仓库反复强调的成本）。
                 */
                value = await withinBudget(perAccountMs, credentialExpiry(provider, credential, {
                    ...item.entry.id === undefined ? {} : { accountId: item.entry.id },
                    // ⚠️ officeace 的余额查询**必须**拿到 ref 才走云侧直读（见该字段注释）；
                    //    其余家忽略它。
                    ...item.entry.credentialRef === undefined || item.entry.credentialRef.length === 0
                        ? {}
                        : { credentialRef: item.entry.credentialRef },
                    catalogIds,
                    ...markModelsExhausted === undefined ? {} : { markModelsExhausted },
                    ...clearModelsExhausted === undefined ? {} : { clearModelsExhausted },
                    // ⚠️ 共享读数入口（2026-10-15，规格 §5.7）：只对**声明了它**的渠道生效 ——
                    //    buddy 系四家吃同一份读数，其余家忽略（与本上下文里 `catalogIds`
                    //    同一模式：可选能力由实现自己声明）。
                    //    ⚠️ 只在装配层真的注入了缓存时给（`options.balanceOf`），否则**不传**
                    //    ⇒ 实现方走自己的回落路径（那正是「未接线 = 行为不变」）。
                    ...cachedBalanceOf === undefined || item.entry.id === undefined
                        ? {}
                        : {
                            cachedBalance: () => cachedBalanceOf(provider, item.entry.id, credential),
                        },
                }), signal);
            }
            catch (error) {
                // 中止仍必须逃逸（与上面的 `try` 同一口径）。
                signal?.throwIfAborted();
                if (isAbortError(error))
                    throw error;
                continue;
            }
            if (value === UNUSABLE)
                continue;
            // ⚠️ 走到这里 = 该账号**折算成功**（拿到一个真实到期时刻或 `NEVER`）。
            //    两者都算「成功」：`NEVER` 的语义是「可用、但无临期额度」（如 codearts
            //    的长期积分），它是**已知事实**，与「查不到」严格不同。
            anyConverted = true;
            if (value < earliest)
                earliest = value;
        }
        // ⚠️ 一个都没成功 ⇒ 未知 ⇒ 剔除（不是 NEVER）。
        if (!anyConverted)
            return cacheAndReturn(provider, UNUSABLE, startedAt);
        // ⚠️ **部分观测也要如实登记**：走到这里可能是「探完全部账号」，也可能是
        //    「每个账号各吃满自己那份均分预算」。返回的是**已观测到的最小值**，
        //    不声称它是全量最小值（真实代价：某个排得靠后的账号若更早到期，本轮看不到）。
        //    这与「一个都没成 ⇒ UNUSABLE」是**两个不同结论**，不要合并。
        return cacheAndReturn(provider, earliest, startedAt);
    }, 
    /**
     * 清空折算缓存（**账号变化时调用**，见 `src/index.ts` 的装配）。
     *
     * ## ⚠️⚠️ 为什么必须提供它（真实缺陷，对抗审计实测证伪）
     *
     * 缓存**原先没有任何失效通道**（`account-pool` 不碰它、也没暴露清理入口）
     * ⇒ 「**刚登录**（或限流刚解禁）」的账号在**最长 60 秒内对路由不可见**。
     * 用户此时请求拿到的是：
     *   `MISSING_CREDENTIAL | 「xxx」当前没有任何可用候选（渠道被关闭、模型被关、
     *    或所有渠道都无可用账号）`
     * —— 正是设计文档 §9.2.1 明确要避免的误导性报错（用户明明刚登录成功）。
     *
     * ⚠️ `UNUSABLE` **也被缓存**（一个渠道「现在没账号」60 秒内不会变；不缓存会让
     * 面板与排序每次白跑一遍取号 + 目录读取），所以刚登录后的那一格**必须显式清掉**。
     */
    { clear: () => { cache.clear(); generation += 1; } });
}
/**
 * 单账号回退：`listAvailableCredentials` 不存在时只取一个代表账号。
 *
 * ⚠️ 这是**降级路径**（少看几个账号），只为让既有测试桩可用 —— 见调用点的长注释。
 * 真实装配（`AccountPool`）永远有 `listAvailableCredentials`。
 */
async function legacySingleCredential(pool, provider, probeModel) {
    const available = await pool.getAvailableAccount(provider, probeModel);
    if (available === null || available === undefined)
        return [];
    return [available.credential];
}
/**
 * 单个账号的临期折算（**按 provider 查能力注册表**）。
 *
 * ⚠️ 从 `createExpiryProbe` 里抽出来，是为了让「探全部账号」的循环保持简单，
 * 且**判据仍然只有一处**（不复制分派）。
 *
 * ## ⚠️ 2026-10-08 改：原先是一个 7-case `switch`
 *
 * 那个 `switch` 的**每个分支体都只是「调一个原语」**
 *（`buddyExpiry` / `loomyExpiry` / `codeArtsExpiry` / `zcodeExpiry` /
 * `lobsteraiExpiry` / `traeExpiry`），只有原语名与参数不同 —— 与
 * `account.refresh` 的 13 个同构 case 完全同型。现在「**选哪个**原语」由
 * 能力注册表回答（设计文档 §3.5.3）。
 *
 * ⚠️ **各家原语函数原样保留** —— 它们是**真实差异**（判据不同、量纲不同：
 * loomy 是命名池、codearts 无到期概念、zcode 分桶按秒、buddy 系按资源包）。
 * 本函数只负责「选哪个」，**不**抽象「原语内部做什么」（§3.6 的边界）。
 *
 * ⚠️ 层次方向：本模块**只**能依赖底座（见模块头）。`provider-runtime.ts` 不
 * import 本文件、也不 import 聚合适配器，故无环 —— 但**别**在这里 import
 * `aggregate-adapter.ts`。
 *
 * @returns 毫秒时间戳（越小越早作废）／`NEVER`（长期）／`UNUSABLE`（查不到）
 */
async function credentialExpiry(provider, credential, context) {
    const runtime = runtimeOf(provider);
    if (runtime?.expiry === undefined) {
        // ⚠️ 未接入 ⇒ `UNUSABLE`（**不是** NEVER）：返回 NEVER 会让一个我们对其
        //    一无所知的渠道被排在候选**最前**并当选 —— 而它可能压根没有可用账号。
        //    这与模块头的铁律同一条：「宁可少一个候选，不可把未知当可用」。
        //
        // ⚠️⚠️ 本分支**只对「清单内但 runtime 缺 `expiry` 域」的渠道可达**：
        //    清单外的渠道在更早的「未接入」短路处就返回了。生产装配下这个组合被
        //    `expiry-runtime-parity.spec.ts` 的不变式一挡住（清单 == runtime 里挂了
        //    `expiry` 域的集合）⇒ 它是**防御性**的，锁的是「有人删了某家的注册、
        //    却没同步改清单」这一类漂移。
        //    ⚠️ 但它**不是**同义反复：`expiry-runtime-parity.spec.ts` 有一条
        //    **行为**用例专门只注册 descriptor、不挂 `expiry` 域，断言这里回
        //    `UNUSABLE` —— 把本行的 `UNUSABLE` 改成 `NEVER` 会让它变红并点名
        //    （独立复审实测：此前该分支**零覆盖**，改坏了没有任何用例会红）。
        //
        // ⚠️ 这里**刻意不打日志**（2026-10-08 决定）：本函数在候选排序里**每个渠道
        //    调一次**，而模块内**没有** logger（`createExpiryProbe` 只收
        //    `pool` / `firstModelIdOf` / `options`，没有 `ctx`）—— 为一条被断言锁住的
        //    防御性分支去穿一条 logger 通道，会把日志出口变成这个纯底座模块的新依赖。
        //    真正的防线是上面那条不变式断言（真跑 `apply()`，漏注册一家即红并点名），
        //    以及 `src/index.ts` 注册失败时已有的 info 日志。
        return UNUSABLE;
    }
    return runtime.expiry.credentialExpiry(credential, context);
}
/**
 * 该错误是否是「调用方中止」类。
 *
 * ⚠️ **就地实现，不从 `aggregate-adapter.ts` 导入**：那会让本模块反向依赖上层的
 * 聚合适配器，正是本任务要避免的层次颠倒（见模块头）。判据与 `aggregate-adapter.ts`
 * 的 `isAbortLike` 一致，只取「错误自身携带 AbortError 标记」这一条 ——
 * `signal` 侧的情形由调用点的 `signal?.throwIfAborted()` 覆盖。
 */
function isAbortError(error) {
    if (error === null || typeof error !== 'object')
        return false;
    return error.name === 'AbortError';
}
/**
 * 造一个 `AbortError`（供「预算等待期间被取消」那条腿用）。
 *
 * ⚠️ 为什么需要它：`signal.throwIfAborted()` 抛的是**平台自带的** `DOMException`
 * / `AbortError`，而 `withinBudget` 的 abort 竞争者要自己造一个。两者必须**同类**
 * ——`isAbortError` 只认 `name === 'AbortError'`，造错了（例如 `new Error()` 后忘了
 * 改名）会让中止被上层 `catch` 吞成 `UNUSABLE`，正是本文件反复修的形态。
 *
 * ⚠️ 优先用 `signal.reason`：取消方可能带了自定义 reason（如上层传了 `DOMException`），
 * 原样透传比自造更贴近「中止原样逃逸」的铁律。但只在它**确实是中止类**时才用
 *（自定义 reason 可能是任意值，把它当 AbortError 抛会让 `isAbortError` 判假）。
 */
function abortErrorOf(signal) {
    const reason = signal.reason;
    if (reason !== null && typeof reason === 'object'
        && reason.name === 'AbortError') {
        return reason;
    }
    if (typeof DOMException === 'function')
        return new DOMException('This operation was aborted', 'AbortError');
    const error = new Error('This operation was aborted');
    error.name = 'AbortError';
    return error;
}
/**
 * 「优先吃共享读数、缺席则自己取」的**唯一一份**实现（buddy 系四家共用）。
 *
 * ⚠️⚠️ **必须共享**：四家各写一遍这个「先看缓存、没有就自己发请求」的分支，
 * 任何一侧漏掉回落（或回落时用错原语）都会**静默分叉** —— 正是
 * `sharedPackageExpiry` 那条注释记录的事故类型（`classifyRaccoonFailure` 与
 * `classifyLoomyFailure` 的四格判据不一致）。
 *
 * ⚠️ 缓存命中的**证明责任在缓存**（`src/balance-cache.ts`）：`undefined` 严格表示
 * 「本次没有共享读数」，与「读数是 `null`（查询失败）」是两件事 ——
 * 后者要按既有口径折算成 `UNUSABLE`（`sharedPackageExpiry` 对 `null` 的处理）。
 */
async function fetchBalanceWithCache(cached, fallback) {
    if (cached !== undefined) {
        const shared = await cached();
        // ⚠️ 只认**非 undefined**：`null` 是「共享读数说查询失败」，那是**结论**，
        //    不该转头再自己发一次请求（那会让「失败」变成双倍上游请求）。
        if (shared !== undefined)
            return shared;
    }
    return await fallback();
}
/**
 * **共享的「有效资源包最早到期」折算**（buddy / workbuddy / lobsterai / trae 同形）。
 *
 * ## ⚠️ 为什么必须共享而不是各写一份（AGENTS.md 的「同族判据必须逐格同构」）
 *
 * 这四家的 `CreditPackage` **结构相同**（都有 `active` / `remaining` /
 * `deductionEndTime`），差别只在**怎么取到那个 `CreditBalance`**（各自的端点与凭据）。
 * 各写一份的话，任何一侧收窄（如「只算 `active` 且 `remaining > 0` 的包」）都会
 * 在另一侧**静默分叉** —— 本仓库已因这类分叉发生过真实事故
 *（`classifyRaccoonFailure` 与 `classifyLoomyFailure` 四格判据不一致，
 * 危险方向恒定朝一侧：多写 24h 冷却 ⇒ 整池被封一天）。
 *
 * ⇒ 判据只写在这里一份，各渠道只提供「怎么取余额」。
 *
 * ## 判据
 *
 * 取 `active === true` 且 `remaining > 0` 的包里 `deductionEndTime` 的**最小值**；
 * 一个都没有 ⇒ `NEVER`（长期：排最后但不剔除）。
 *
 * ⚠️ **无到期时间 ⇒ `NEVER`，不是 `UNUSABLE`**：包是有效的，只是不下发到期时间
 *（实测 lobsterai 的 `expiresAt` 可为空串）⇒ 剔除它会丢掉一个可用渠道。
 * 与 `codeArtsExpiry` 的「读不到就不猜」同一条原则。
 *
 * ## ⚠️⚠️ 「余额为 0」与「无有效包」必须一并剔除（真实缺陷，已修 2026-10-07）
 *
 * `earliest` 的初值是 `NEVER`，而只有 `remaining > 0` 才可能更新它 —— 若遍历完
 * 直接 `return earliest`，下面几种形态**都**返回 `NEVER`（= 可当选）：
 *
 * | 形态 | 旧返回 | 现在 |
 * |---|---|---|
 * | 有效包 `remaining > 0`、有 `deductionEndTime` | 该时刻 | 该时刻（不变） |
 * | 有效包 `remaining > 0`、**无**到期时间（永久积分） | `NEVER` | `NEVER`（**保留**：确实有额度） |
 * | **有效包但 `remaining = 0`（余额已尽）** | `NEVER` ❌ | **`UNUSABLE`** |
 * | **只有失效包 / `Accounts: []`** | `NEVER` ❌ | **`UNUSABLE`** |
 *
 * ⇒ 旧实现下，一个**余额已耗尽**的 buddy / workbuddy / lobsterai / trae 仍会被
 * auto 选中，请求随即以 `QUOTA_EXCEEDED` 失败 —— **与 PR #81 报障完全同型**，
 * 且 buddy / workbuddy 都在 `AUTO_PROVIDERS`（`auto-adapter.ts`）里。
 *
 * ⚠️ 本仓库对「余额为 0」早有明确判据，旧实现与它**矛盾**：
 * `buddy-balance-rank.ts` 的 `buddyBalanceTier` 在余额全为 0 时返回
 * `BUDDY_BALANCE_TIER.none`，而 `buddyTierUsable` 明写
 * **`none` 档不可用**。选号器判「不可用」、折算层判「可当选」= 同一语义两套判据
 *（AGENTS.md 首条红线）⇒ 现在两侧**同构**。
 *
 * ## ⚠️ 为什么「有余额但无到期时间」仍必须是 `NEVER`（别一刀切成 UNUSABLE）
 *
 * 实测 lobsterai 的 `expiresAt` 可为**空串**、buddy 的永久积分包也可能不下发
 * `DeductionEndTime`。这类包**确实有额度**（`remaining > 0`），剔除它会丢掉一个
 * 可用渠道。故判据是「**有没有任何一个 `active && remaining > 0` 的包**」，
 * 而不是「有没有带到期时间的包」。
 *
 * ⚠️ 与 `zcodeExpiry` 的收窄是**同一手法**（「已拥有的余额 > 0」才可用；
 * 否则 `UNUSABLE`），两处口径一致 —— 别再让一家修好、另一家漏掉。
 *
 * ⚠️ 与 `buddy-balance-selector.ts` 那句「解锁时所有候选余额都是 0 仍返回
 * 第一个候选，让上游去报真正的失败原因」**不矛盾**：那句讲的是 **provider 内部**
 * 的选号（用户已指定该渠道，此时换号才有意义），本函数讲的是**跨渠道选型**
 * （余额 0 就该让给别的渠道，而不是把请求发过去必然失败）。
 *
 * @param fetchBalance - 取余额的函数；返回 `null` 表示查询失败 ⇒ `UNUSABLE`。
 */
async function sharedPackageExpiry(fetchBalance) {
    let balance;
    try {
        balance = await fetchBalance();
    }
    catch (error) {
        /**
         * ⚠️⚠️ **中止必须原样逃逸**（铁律；这是同型缺陷在本文件的**第五处**）。
         *
         * ## 为什么必须修（2026-10-19，用户报障）
         *
         * 初版是**裸 `catch`** ⇒ 把 `AbortError` 也折算成 `UNUSABLE`。
         * 而 `UNUSABLE` 会被 `cacheAndReturn` **缓存 60 秒**（`EXPIRY_CACHE_TTL_MS`）
         * ⇒ **取消一次 = 该渠道对路由消失 60 秒**。
         *
         * 用户可见症状（真实会话日志，`aggregate: 「space-bunny」当前没有任何可用候选`）：
         * - `step/start 1792418663502` → `turn/end 1792418663505` ⇒ **3 毫秒、零网络**；
         * - 报错前一步是一次 **604 秒的 subagent 调用**（长任务被取消/超时）；
         * - 该虚拟模型**只有 buddy 一家候选**（无备胎）⇒ 候选一空就直接撞
         *   `candidatesFor() === []`（`src/aggregate-adapter.ts:1315`）；
         * - 60 秒后缓存过期 ⇒ 自愈 ⇒ 表现为「发消息继续就又能工作了」。
         *
         * ## 可达性：已实测，**如实标注**（别读成「生产已复现」）
         *
         * | 探针 | 结果 |
         * |---|---|
         * | `buddyExpiry` 的 `cached()` 抛 `AbortError` | **被吞成 `UNUSABLE`** ← 本修法修的接缝 |
         * | `balanceCache.readOne` 上游抛中止 | **原样上抛**（`src/balance-cache.ts:402`）⇒ 接缝已开口 |
         * | 真实 buddy 腿 `fetchCreditBalance` | `postJson` 把中止压成 `{ok:false}` ⇒ **该腿不抛中止** |
         *
         * ⇒ buddy 当前**不可达**；但共享缓存那条腿（上一行第二条）**已经会抛中止**，
         *  且 `src/index.ts:3273` 正是把 `readOne` 接到本函数的 `cached()` 上
         *  ⇒ 这是**接缝安全**，不是「已复现的故障」。旧注释预言的三种情形
         *  （某家改用 `fetchBalanceDetailed` / `postJson` 改为抛出 / 新增走
         *  `fetchBalanceWithCache` 的渠道）任一发生，这里就会立刻吃掉中止。
         *
         * ⚠️ **判据只认 `isAbortError`，不额外查 signal**：本函数**收不到 `signal`**
         *   （签名只有 `fetchBalance`，见 `@param`）。入口 signal 已标记的那种情形
         *   由 `createExpiryProbe` 的循环逐轮 `signal?.throwIfAborted()` 负责 ——
         *   与该文件 `zcodeExpiry` 分支的登记口径一致。
         *
         * ⚠️ 其余错误**仍折算成 `UNUSABLE`**（不改既有裁决）：
         *   `tests/unit/aggregate-expiry.spec.ts:802` 的「全部账号折算失败 ⇒ UNUSABLE」
         *   是**有意取舍**（「不能把『不知道』当『可用』」），本次**刻意不动**它。
         */
        if (isAbortError(error))
            throw error;
        return UNUSABLE;
    }
    if (balance === null)
        return UNUSABLE;
    let earliest = NEVER;
    // ⚠️ 必须单独记「有没有任何可用余额」：`earliest` 的初值 `NEVER` 无法区分
    //    「一个有效包都没有」（⇒ 剔除）与「有余额但不下发到期时间」（⇒ 长期）。
    let hasAnyCredit = false;
    for (const pkg of balance.packages) {
        if (pkg.active !== true)
            continue;
        if (!(typeof pkg.remaining === 'number' && pkg.remaining > 0))
            continue;
        /**
         * ⚠️⚠️ **独立池不进折算**（2026-10-21 合并审计发现）。
         *
         * AStudio 的星火池是服务端下发的**独立池**（不参与主池合计、也不能当
         * 通用积分消耗）。若把它算进来：
         * ① `hasAnyCredit` 会因它为真 ⇒ 主池全空时也判「有余额」⇒ 账号**不被
         * 剔除** ⇒ 聚合把请求发给一个只有专属池的账号 ⇒ 上游按主池计费 ⇒ 失败；
         * ② `earliest` 会取**它**的到期时刻 ⇒ 星火池先过期时整个账号被判「马上
         * 作废」⇒ 聚合把它排到最前 ⇒ **提前烧掉主池的长期积分**。
         *
         * ⚠️ 判据与后端选号侧（`buddy-balance-rank.ts`）同源（同一份
         * `isExclusiveCreditPool`）⇒ 两侧口径一致。
         */
        if (isExclusiveCreditPool(pkg))
            continue;
        const end = pkg.deductionEndTime;
        /**
         * ⚠️⚠️ **判据必须与 `src/buddy-balance-rank.ts` 的 `splitBuddyCreditsByExpiry` 同一份**
         * （2026-11-01 四审）：那边已把 `deductionEndTime` 收窄成「**number 或数字字符串**」，
         * 而这里曾只认 `typeof === 'number'`。
         *
         * 后果（结构可达、生产零实测 —— 目前所有生产者都写 number）：外部写入
         * （`state.json` / 备份导入 / 旧缓存里的 `"1791072000000"`）会让**面板判「临期」**
         * 而**聚合轮换把它当「未知」= 长期、排到最后** ⇒ 用户看到的「马上到期」与
         * 自动选择顺序相反。这正是本仓红线「同一语义不得两套判据」。
         */
        const endIsNumeric = typeof end === 'number' || typeof end === 'string';
        const endMs = endIsNumeric ? Number(end) : Number.NaN;
        /**
         * ⚠️⚠️ **已作废的额度不参与「可用额度」与排序**（2026-11-02，对抗审计 B1）。
         *
         * TRAE / Qoder 的 `active` 是**硬编码 true**，所以「`deductionEndTime` 已过、
         * `remaining > 0`」的包一定会出现。旧行为把它的**过去时刻**当 `earliest`
         * ⇒ 聚合按「越早到期越优先」把它排**第一** ⇒ 请求必失败，而同池里真正
         * 3 天后到期的渠道被排在后面。
         *
         * ⇒ 与 `buddy-balance-rank.ts` 的 `splitBuddyCreditsByExpiry`（`endMs <= now`
         *   单列 `expired`、不计入 `expiring`）保持**同一判据**。
         *   只剩作废额度 ⇒ `hasAnyCredit` 保持 false ⇒ 本渠道判 `UNUSABLE`（钱已经没了）。
         */
        if (Number.isFinite(endMs) && endMs > 0) {
            if (endMs <= Date.now())
                continue;
            hasAnyCredit = true;
            if (endMs < earliest)
                earliest = endMs;
            continue;
        }
        // 到期时间未知（无字段 / 脏值）⇒ 算「有余额但不知道什么时候过期」= 长期。
        hasAnyCredit = true;
    }
    // 有余额但都没给到期时间 ⇒ 长期（排最后，不剔除）。
    if (hasAnyCredit)
        return earliest;
    // ⚠️ 一个 `remaining > 0` 的有效包都没有 ⇒ 余额已尽 ⇒ **剔除**。
    //    「只有失效包」「`Accounts: []`」也走这里 —— 那同样是「这个渠道现在没有
    //    可烧的额度」，不该被 auto 选中（旧实现把它们一并返回 `NEVER`）。
    return UNUSABLE;
}
/**
 * 腾讯 Marvis（2026-11-09）：**本 fork 独有**。
 *
 * ## 判据
 * 钱包只给 `total_tokens` / `used_tokens` / `frozen_tokens` / `avail_tokens`，
 * **没有任何日期字段** ⇒ 与 modelscope 同一条红线：
 * · 有 `active && remaining > 0` 的包 ⇒ `NEVER`（可路由）；
 * · 否则 `UNUSABLE`（**不得**编造「每日 0 点重置」—— 那是 Qoder / Magicrew
 *   那类**真给了** `cycleEndTime` 的家才有的结论）。
 *
 * ⚠️ 上游 README 写「每日 1000 万计费 token」，但那是**计费口径**（缓存读 ×0、
 *    输入输出 ×0.5），钱包里的 `total_tokens` 是同一个 10_000_000 的**显示口径**
 *    ⇒ 不能用「剩余 / 每日额度」反推日期（本仓红线：绝不编造日期）。
 */
export async function marvisExpiry(credential, product, 
/** 共享读数入口。 */
cached) {
    return sharedPackageExpiry(() => fetchBalanceWithCache(cached, async () => {
        const result = await fetchMarvisBalanceDetailed(credential, product);
        // ⚠️ 同 modelscope：`balance: null` ⇒ UNUSABLE。
        return result.balance;
    }));
}
//# sourceMappingURL=aggregate-expiry.js.map