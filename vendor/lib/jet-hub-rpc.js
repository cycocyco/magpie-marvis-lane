/**
 * Jet Hub 多账号管理的 RPC 端点注册。
 *
 * 使用 DSH 的 connection.fetch.register() 模式注册 HTTP API 端点，
 * 与 dsh-im 的 registerManagementRpc 一致。
 * 通道名 jet-hub → 路径 /api/jet-hub
 * 端点方法：account.list / account.create / account.update / account.delete /
 *           account.reorder / account.refresh / account.retest / account.retestAll /
 *           account.test / account.reset / account.resetAll / login.poll /
 *           credits.status / credits.claimAll / credits.balances /
 *           model.list / model.setDisabled /
 *           captcha.demand / captcha.carrierUrl / captcha.contribute（内部载体供给位；
 *           ⚠ 本 fork 裁剪后没有载体服务，carrierUrl 恒回 null）/
 *           backup.export / backup.import / backup.status /
 *           nativeSearch.getEnabled / nativeSearch.setEnabled /
 *           sessionBalance.getEnabled / sessionBalance.setEnabled /
 *           panelEntry.get / panelEntry.set /
 * ⚠️ 本 fork 裁剪后只支持 **marvis** 一个供应商：其余 28 家的专属模块 import
 *    与按 provider 分派的特例分支已全部删除；通用路径（registry / 能力表 /
 *    product 表驱动）与 marvis 专属路径保持原语义。
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { AUTO_PROVIDER as AUTO_PROVIDER_ID } from './auto-adapter.js';
import { resolveAutoBadgeRewrite } from './auto-badge.js';
import { broadcastCatalogChanged } from './catalog-broadcast.js';
import { isGatewayEnabled, isGatewayHostFromEnv } from './openai-gateway/config.js';
import { collectGatewayEffortViews, collectGatewayModels, toGatewayModelIds } from './openai-gateway/models.js';
import { applyGatewayDesiredState, gatewayAddress, gatewayApiKey, gatewayLastError, isGatewayRunning, setGatewayDesiredAllowLan, setGatewayDesiredEnabled, } from './openai-gateway/runtime.js';
// ⚠️ **值导入**（不是类型）：一键「拒绝非临期」要把这份清单传给账号池。
//    它是一份**冻结的静态数组**（`Object.freeze([...])`），模块级求值安全 ——
//    与 `WIRED_EXPIRY_PROVIDERS` 自己那条注释里说的「不要读 runtime 注册表」不矛盾
//    （本文件只读它是为了让「谁是未接入渠道」的权威**只有一处**）。
//    ⚠️ 每一次调用都**重新读**这个导出（而不是在模块级拷成另一个常量），以后者为准会
//    在接入新渠道时静默漂移：一键按钮会开始清掉**已接入**渠道的白名单。
import { WIRED_EXPIRY_PROVIDERS } from './aggregate-expiry.js';
// ⚠️ **值导入**：`AGGREGATE_PROVIDER` 是聚合的 provider id（写入端点在下面三处要用它
//    作为 `invalidateCatalogCache` 的键）。**不**在本文件再抄一份字面量 `'aggregate'`
//    —— 那会与常量漂移（本文件另一处 `modelAdapters?.['aggregate']` 是既有写法，
//    本次只新增消费点，不改既有行）。
//    ⚠️ 依赖方向：`aggregate-adapter.ts` 不 import 本文件 ⇒ 无环。
// ⚠️ `invalidateCatalogCache`：用户主动改设置 ⇒ 该 provider 的目录读数**立即**失效
//    （规格 §6 的正确性要求，不是优化）。实现在 `model-catalog.ts`（与
//    `isCatalogFresh` 同一处，保证「多久算新鲜」只有一份判据）。
//
// ⚠️⚠️⚠️ **接线规则（2026-10-19 复审补齐，务必照此逐条自查）**
//
//   「凡是写入**目录或门控相关表**的端点，**成功之后**都要
//     `invalidateCatalogCache(req.provider)`」
//     （聚合那几处写的是 `invalidateCatalogCache(AGGREGATE_PROVIDER)` —— 只失效
//     聚合**自己**一个 provider，绝不顺手失效其余渠道，那是「改一个开关打十几个
//     上游」）。
//
//   这条规则**必须成对**满足两个条件才算接线正确：
//   ① 端点**真的写**了下面这些表之一：模型黑名单（`disabledModels`）、失效表
//      （dead models）、聚合拒绝表、聚合白名单、聚合手工顺序表、聚合排序模式；
//   ② 调用点在**写盘成功之后**（参数校验 `return`、写入抛错、目录核实不过而拒绝的
//      路径一个字都没改，失效只会白打一次上游）。
//
//   ⚠️⚠️ **`provider.setEnabled` 曾被漏掉过一次**（真实的漏网教训，2026-10-19 复审
//   发现）：它是 Jet Hub 里**最显眼**的供应商级开关（左栏每行尾的那个），写的
//   正是**同一张模型黑名单**（`clearDisabledModels` / `setModelsDisabled`），
//   症状与单条 `model.setDisabled` 逐字相同 —— 而它当时没接线。
//   ⇒ 只按「已核实的行号清单」接线必然漏；**必须按上面那条规则**逐个端点自查。
//   接线清单与理由见 `src/model-catalog.ts` 的 `invalidateCatalogCache` 注释。
import { AGGREGATE_PROVIDER } from './aggregate-adapter.js';
import { invalidateCatalogCache } from './model-catalog.js';
import { PANEL_ENTRY_VALUES } from './jet-hub-store.js';
// ⚠️ 腾讯 Marvis（2026-11-09，本 fork 独有）：OAuth（QQ / 微信）+ 从 magpie 导入。
import { importCredentialFromMagpie } from './marvis-auth.js';
import { MARVIS } from './marvis-product.js';
import { 
// ⚠️ 必须改名：本文件已从 `buddy.ts` 导入了同名的 `credentialExpiresAtMs`
//    （buddy 系的凭据是 `{expiresAt}`，Marvis 的是毫秒**字符串**）。
credentialExpiresAtMs as marvisCredentialExpiresAtMs, marvisAccountLabel, parseMarvisCredential, } from './marvis.js';
import { loginNeedsExternalAction } from './login-failure.js';
import { PROVIDER_REGISTRY, descriptorOf } from './provider-registry.js';
import { createProviderCredits, creditsOf } from './provider-credits.js';
// ⚠️ 共享余额读数缓存（2026-10-15，规格 §5.7）：经**进程级注册位**取，不给
//    `registerJetHubRpc` 加第 5 个形参（那会重开「位置错位复发 6 次」的门）。
import { balanceCacheOf } from './provider-runtime.js';
import { createProviderOnboarding, onboardingOf } from './provider-onboarding.js';
import { deleteTokenLedgerDay, isValidTokenLedgerDayKey, readTokenLedger, readTokenLedgerDayMap, readTokenLedgerHistory, TOKEN_LEDGER_HISTORY_MAX_DAYS, } from './token-ledger.js';
import { claimDailyCheckin, claimUnitOf, fetchCheckinStatus, fetchCreditBalance, } from './credits.js';
/**
 * 整轮成长任务的时间预算缺省值（毫秒）。
 *
 * 上界由**账号数 × 逐账号预算**决定（后者缺省 10 分钟），账号多时线性增长。
 * 30 分钟约覆盖 3 个账号从容跑完；超出即如实停住并报出未跑的账号，而不是撞上
 * 宿主 RPC 的超时（该上界由 dsh 侧决定，本插件不可见也不可控）。
 */
const DEFAULT_ROUND_BUDGET_MS = 30 * 60 * 1000;
import { pickTestModel, resetAccount, resetAllAccounts, retestAccount, retestAllAccounts, testAccount, } from './account-probe.js';
import { exportBackup, importBackup } from './backup.js';
import { clearDeadModels, deadModelIdsFor } from './dead-model-store.js';
import { BADGE_PREFERENCES, createBadgePreferenceStore, } from './badge-preferences.js';
import { createUsageBadge } from './usage-badge.js';
import { createAutoCheckin, createAutoCheckinStore } from './auto-checkin.js';
/** Jet Hub RPC API 路径 */
export const JET_HUB_API_PATH = '/api/jet-hub';
// ⚠️ 本 fork 裁剪：原版此处还有 `CAPTCHA_CARRIER_PATH`（zcode 专用载体页路由），
//    随 captcha 载体链一并移除。
/** Gateway RPC 端点名（connection.rpc.call 的 endpoint 参数） */
const JET_HUB_ENDPOINT = 'jet-hub';
/** 生成 8 字符随机短 ID（小写 hex） */
function shortId() {
    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
/**
 * 支持「锁定永久积分」的 provider 白名单。
 *
 * ⚠️ **必须与前端 `plugin-src/client/jet-hub.js` 的 `supportsPermanentLock` 一致**：
 * 前端拿它决定要不要渲染按钮、要不要发读取请求；后端拿它拒绝越权写入。
 * 两边不一致的后果是「按钮出现但点了报错」或「功能存在却点不出来」。
 *
 * 登记条件：**余额响应里能拿到逐包的到期时间**（归一化到 `deductionEndTime`），
 * 从而分出「快到期」与「不会马上作废」两桶。判据见
 * `buddy-balance-rank.ts` 的 `splitBuddyCreditsByExpiry` —— 它只读通用的
 * `packages[].{ active, remaining, deductionEndTime }`，**与 provider 无关**。
 *
 * | provider | 分桶依据 |
 * |---|---|
 * | Loomy | 服务端直接给 `dailyBalance`（当日到期）与 `balance`（永久）两个命名池 |
 * | CodeBuddy / WorkBuddy | 资源包列表的 `DeductionEndTime` 距今是否满窗口天数 |
 * | TRAE（字节） | 资源包列表的**条目级** `expire_time`（秒级 Unix 时间戳） |
 * | LobsterAI（有道） | 资源包列表的 `expiresAt`（ISO 8601） |
 *
 * ⚠️ TRAE / LobsterAI **不区分「每日额度」与「永久积分」两个命名池**，但同样能按
 * 到期时间分桶 —— 对锁定功能而言，判据只需「会不会马上作废」，与池的名字无关。
 * 拿不到到期时间的包归入**永久桶**（保守方向：宁可锁定时少用一个号，
 * 也不要把长期积分误当快到期烧掉，见 `splitBuddyCreditsByExpiry` 注释）。
 *
 * 仍未登记的渠道（CodeArts / Qoder / Cline / Raccoon / Minimax / ZCode / Gemini /
 * OpenCode）：余额响应里没有逐包到期时间，或根本没有资源包列表 ——
 * 分不出两桶，登记进来只会多一个无效开关。
 *
 * ## ⚠️ 2026-10-08 起从 `PROVIDER_REGISTRY` 派生
 *
 * 原先这是一份手抄 `Set`，而客户端 `supportsPermanentLock` 读的是 registry 的
 * `permanentLock` 字段 ⇒ **两处必须一致**（不一致会出现「按钮渲染出来了，
 * 点了却报 bad-request」）。现在两侧同出一个字段，不再可能漂移。
 * 上面那张「分桶依据」表已随值迁移到 registry 里各条的注释。
 *
 * ⚠️ **本常量是模块级、但这里安全**：它只读 `PROVIDER_REGISTRY`（Task 1 的
 * **静态数据**），**不读 runtime 注册表** —— 后者要到 `apply()` 才填充，
 * 模块级求值会得到空集（`WIRED_EXPIRY_PROVIDERS` 那条注释记的正是这个陷阱，
 * 但那里是**刻意**保持常量的，理由见 `aggregate-expiry.ts`）。
 * 判据是「读的是不是静态数据」，不是「是不是模块级常量」。
 */
export const PERMANENT_LOCK_PROVIDERS = new Set(PROVIDER_REGISTRY.filter((d) => d.permanentLock === true).map((d) => d.id));
/**
 * 汇总一次批量领取的结果。
 * 纯函数，便于单测；inactive（无资格/活动结束）与 failed 分开计数，
 * 因为前者是正常的业务状态、后者才是需要用户关注的问题。
 *
 * ★ **按单位分开累加**（2026-10-04，真实缺陷）：`totalCredit` 这个标量会把
 * 不同量纲加在一起（ZCode 的 1 亿 token + 100 积分 = `100000100`），单位信息
 * 一旦在这一层丢掉，下游无论怎么写文案都只能标一个「积分」。故同时产出
 * `totalByUnit`，消费方一律用它（见 `RpcCreditsClaimSummary.totalByUnit`）。
 *
 * ⚠️ `totalCredit` **保留原语义**（跨单位求和），只为不破坏既有契约；
 * **不要**在展示路径上用它 —— 那正是本缺陷的成因。
 */
export function computeClaimSummary(outcomes) {
    const summary = {
        claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0, coversToday: 0,
        totalByUnit: { token: 0, credit: 0 },
    };
    for (const outcome of outcomes) {
        switch (outcome.kind) {
            case 'claimed':
                summary.claimed += 1;
                summary.totalCredit += outcome.credit;
                // ⚠️ 单位缺省按 `credit`（与 `ClaimOutcome.unit` 的声明一致）——
                // 只有 ZCode 显式传 `'token'`，其余 11 个渠道逐字不变。
                summary.totalByUnit[claimUnitOf(outcome.unit)] += outcome.credit;
                // ⚠️ 只有**覆盖今天**的领取才算「今天已处理」。`coversToday:false` 是
                // 渠道自己标的（当前是 Qoder 刷新前那一轮），见 `credits.ts` 的字段说明。
                if (outcome.coversToday !== false)
                    summary.coversToday += 1;
                break;
            case 'already-claimed':
                summary.alreadyClaimed += 1;
                if (outcome.coversToday !== false)
                    summary.coversToday += 1;
                break;
            case 'inactive':
                summary.inactive += 1;
                break;
            case 'failed':
                summary.failed += 1;
                break;
            default: {
                // 编译期穷尽性检查：ClaimOutcome 未来新增 kind 时此处会报错，
                // 迫使作者显式决定它该计入哪一栏，而不是被静默漏计。
                const exhaustive = outcome;
                void exhaustive;
                // 运行期兜底：类型声明与运行时不符（未知 kind）时按 failed 计入，
                // 宁可多报一个失败，也不让结果凭空消失。
                summary.failed += 1;
                break;
            }
        }
    }
    return summary;
}
/**
 * `credits.status` 逐账号查询的**默认并发度**。
 *
 * 3 的依据与代价见 `collectCreditsStatus` 函数体内那段注释（**不要**用「浏览器
 * 默认 6」来论证 —— 那是不同量纲）。
 */
export const DEFAULT_CREDITS_STATUS_CONCURRENCY = 3;
/**
 * `credits.status` 逐账号查询的**并发硬上界**。
 *
 * ## ⚠️ 为什么必须有它（2026-10-22 审计打穿）
 *
 * 初版的上界是 `accounts.length`：
 *
 * ```ts
 * Math.max(1, Math.min(deps.concurrency ?? 3, accounts.length || 1))
 * ```
 *
 * 于是 `deps.concurrency = 1e10`（任何 ≥ 账号数的安全整数）⇒ 并发度 = 账号数
 * ⇒ **31 个账号 = 31 个并发请求打同一上游**（实测峰值 31）。注释说的「3 个并发
 * 压力很低」这个保护**只由 `accounts.length` 约束，没有任何硬顶**。
 *
 * ⇒ 上界改为本常量。它同时给「将来有人把默认值调大」加了一道闸。
 *
 * ⚠️ 取值 8：足够覆盖「账号很多」的正常情形（3 是默认，8 是天花板），且远低于
 * 任何一家上游会当成爬虫的量级。调它需要重新核对 `fetchStatus` 各家的限流策略。
 */
export const MAX_CREDITS_STATUS_CONCURRENCY = 8;
/**
 * 解析 `credits.status` 的并发度（**纯函数，可直接单测**）。
 *
 * 逐格行为（2026-10-22 审计逐格实测确认）：
 *
 * | 传入 | 结果 | 说明 |
 * |---|---|---|
 * | `undefined` / `0` / `-1` / `NaN` / `1.5` / `Infinity` / 字符串 | 3 | 非「正整数」一律回落默认 |
 * | `1` | 1 | 恢复旧的完全串行语义 |
 * | `4` | 4 | |
 * | `1e10` / `MAX_SAFE_INTEGER` | **8** | 被 {@link MAX_CREDITS_STATUS_CONCURRENCY} 硬顶（初版这里会变成账号数） |
 * | `accounts.length === 0` | 1 | 起 1 个 worker 立刻返回 -1（**不能**是 0 —— 那会让 `results` 全是空洞） |
 *
 * ⚠️ `concurrency: 0` 的语义是「**回落默认 3**」，**不是**「串行」——要串行请传 `1`。
 *    这条在初版注释里没写，是审计点出来的语义空隙。
 */
export function resolveCreditsStatusConcurrency(raw, accountCount) {
    const wanted = typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0
        ? raw
        : DEFAULT_CREDITS_STATUS_CONCURRENCY;
    const capped = Math.min(wanted, MAX_CREDITS_STATUS_CONCURRENCY);
    // ⚠️ `Math.max(1, …)` 不可省：账号数为 0 时 `Array.from({length: 0})` 会让
    //    `Promise.all([])` 立即 resolve，`results` 保持全空洞（返回 `[undefined,…]`）。
    return Math.max(1, Math.min(capped, accountCount || 1));
}
/**
 * 逐账号收集签到状态（**有限并发**，默认 3；见函数体内 `concurrency` 的说明）。
 *
 * ⚠️ **原实现是纯串行**，注释写「顺序执行，避免并发触发风控」。2026-10-22 改成
 * 有限并发，理由与代价见函数体内那段长注释 —— **别再照旧注释改回串行**。
 *
 * **包含已停用账号**：停用只影响账号池的自动选择与限流切换，不改变账号本身
 * 是否已签到。用户要看到的是「这个账号今天领了没」，因此这里不过滤 enabled。
 *
 * 关键约束：**凭据解析也在 try 之内**。`credentialRef()` 会对名称做正则校验
 * （非法名称抛 TypeError），`deps.resolve()` 也可能抛错。若把它们留在 try
 * 之外，任一账号的异常都会冒泡到 handleMethod 外层 catch，使整批请求以
 * `jet-hub/handler-failed` 失败——违背「单个账号失败不中断整体」的设计。
 */
export async function collectCreditsStatus(accounts, product, deps) {
    // 与 collectClaimResults 同款：显式包装默认实现把 fetcher 送进第三参，
    // 不用 `as unknown as` 掩盖签名差异（见 CreditsEndpointDeps.fetcher 的说明）。
    const fetcher = deps.fetcher ?? fetch;
    const fetchStatus = deps.fetchStatus
        ?? (async (credential, product) => fetchCheckinStatus(credential, product, fetcher));
    /**
     * **有限并发**（2026-10-22，真实故障）。
     *
     * ## 为什么不再「完全串行」
     *
     * 原实现是纯顺序循环，注释写「避免并发触发风控」。但账号池随用户增删账号
     * **线性增长**，而单账号上游超时是 30 s 级 ⇒ 单渠道耗时 = 账号数 × 单账号耗时
     * ⇒ 「打开 Jet Hub 设置页」的等待被账号数线性放大。同一时刻 `model.list` 只要
     * 毫秒级（⇒ 慢的不是读目录，是这里）。
     *
     * ## 为什么是 3（以及**推翻**了哪条既有理由）
     *
     * 原注释的理由是「顺序查询避免并发触发风控」。逐项核对后的**真实依据**是：
     *
     * - **实际能走到这里的渠道极少**：只有注册了 `ProviderCredits.fetchStatus` 的
     *   渠道才会调本函数（`credits.status` 端点先判 `statusImpl?.fetchStatus` ——
     *   实测判据在 `creditsOf(credits, req.provider)` 之后、`undefined` 即短路返回），
     *   **本仓库是 4 家**：`minimax` / `minimaxintl`（`fetchMinimaxSigninStatus`）与
     *   `buddy` / `workbuddy`（`fetchCheckinStatus` → `postJson`）；其余渠道走
     *   「如实回 null」的短路分支，**零请求**。
     *   ⚠️ 上游 86e3591 这里写的是「**两家** `minimax` / `minimaxintl`」—— 那是
     *   **他们**那份仓库的事实（其 `provider-credits.ts` 里没有 buddy / workbuddy 条目）。
     *   **本仓库不适用**：`buddy` 有签到状态端点，`workbuddy` 那条是**刻意注册**的
     *   （国际版没有签到接口、但状态端点存在，见 `provider-credits.ts` 里
     *   `workbuddy.fetchStatus` 的注释）⇒ 四家都是**只读状态查询、一次/账号**。
     * - **429 不会被放大**：`minimax` 的 `minimaxFetchWithRetry` 只重试**传输错误**，
     *   而 `buddy` 系走的 `credits.ts` `postJson` **同样不重试 HTTP 状态**
     *   （实测：该文件里 `429` / `retry` 零命中）⇒ 3 并发撞限流只是 3 条同时失败，
     *   不会变成重试风暴；
     * - 签到（**写操作**）走的是 `collectClaimResults`，那里**仍是串行**，本改动不碰它。
     *
     * ⚠️ 因此**不要**照「3 远低于浏览器默认的 6」那条类比来论证安全性（浏览器并发
     * 与服务端风控不是同一量纲，那是初版注释的推理错误）。要论证就按上面三条。
     *
     * ## 顺序与逃逸
     *
     * - 结果**按 `accounts` 原序**写回（`new Array(len)` + 下标），UI 不跳序；
     * - 单账号的凭据缺失 / JSON 损坏 / 名称非法 / 网络失败都只影响它自己；
     * - ⚠️ `deps.warn` 抛错**不得**逃逸成整批失败（初版会：它在 catch 里调用，
     *   一抛就把 worker 的 promise reject 掉）⇒ 已包 try。
     *
     * ⚠️ 并发度可通过 `deps.concurrency` 覆盖（测试与将来调参用）；
     *    `1` 即恢复旧的完全串行语义。上界是 {@link MAX_CREDITS_STATUS_CONCURRENCY}
     *    （**不是** `accounts.length` —— 那会让 31 个账号变成 31 并发）。
     */
    const concurrency = resolveCreditsStatusConcurrency(deps.concurrency, accounts.length);
    const results = new Array(accounts.length);
    let cursor = 0;
    /** 取下一个待处理下标；无剩余返回 -1（同步自增，单线程下无需加锁）。 */
    const take = () => (cursor < accounts.length ? cursor++ : -1);
    const worker = async () => {
        for (let index = take(); index !== -1; index = take()) {
            const entry = accounts[index];
            /**
             * ⚠️ `accountId` / `nickname` 必须在 try **之外**取也会抛（`entry` 是外部对象，
             * 可能是带 getter 的代理 / 冻结对象）。初版把它们的读取放在 `results[index] = …`
             * 那一行 —— 而那一行在 catch **之后**、不受保护 ⇒ 一次抛错就让 worker 的
             * promise reject ⇒ `Promise.all` 短路 ⇒ **整批失败**（违背本函数的设计约定）。
             * ⇒ 先取到局部变量并各自兜底，写结果那一行只做纯赋值。
             */
            let accountId;
            let nickname;
            let status = null;
            try {
                accountId = entry.id;
                nickname = entry.nickname;
                let resolved = await deps.resolve(credentialRef(entry.credentialRef));
                if (resolved !== undefined) {
                    const credential = JSON.parse(resolved.value);
                    status = await fetchStatus(credential, product);
                }
            }
            catch (error) {
                // 单个账号的凭据缺失 / JSON 损坏 / 名称非法 / 网络失败都不影响其余账号。
                // ⚠️ `deps.warn` 自己抛错也**不得**逃逸（初版会让整批失败）——
                //    告警是尽力而为，它坏了不该让用户看不到其余账号的签到状态。
                status = null;
                try {
                    deps.warn?.(`[jet-hub] credits.status 账号 ${String(accountId ?? entry.id)} 失败: ${String(error)}`);
                }
                catch {
                    // 告警失败只能静默：这里已经没有更外层的可观测通道了。
                }
            }
            // ⚠️ 纯赋值，不得再抛（`Promise.all` 会因 worker reject 而短路整批）。
            results[index] = { accountId, nickname, status };
        }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return results;
}
/**
 * 逐账号执行一键领取（顺序执行，单个账号失败不中断整体）。
 *
 * **包含已停用账号**：签到领取与「是否参与账号池自动选择」无关 —— 停用的
 * 账号同样有当日积分可领，用户点「一键领取」时期望所有账号都尝试一遍。
 * 停用只影响限流切换时的候选集合，不影响这里。
 *
 * 与 collectCreditsStatus 同理：凭据解析位于每个账号自己的 try 之内，
 * 异常只让该账号记为 failed。
 */
export async function collectClaimResults(accounts, product, deps) {
    // ⚠️ **默认实现必须显式适配，不能 `as unknown as` 硬转。**
    //
    // 真实签名是 `(credential, product, fetcher)`，而本接口把 `claim` 声明为
    // `(credential, product, entry)`（TRAE 需要 `entry.id` 取签到设备代次）。
    // 历史写法用 `as unknown as` 把这个不匹配「压」过去 —— TypeScript 于是不再
    // 报错，但调用点传的第三个实参是 `entry`，它落进 `fetcher` 位置，运行时抛
    // **`TypeError: fetcher is not a function`**。
    // **真实缺陷**：用户一键领取 4 个 CodeBuddy 账号全部失败，报错就是这句。
    //
    // 修法：显式包装 —— 把 `deps.fetcher`（或全局 `fetch`）送进第三参，
    // `entry` 只交给真正需要它的 provider（它们在自己的分支里注入 `claim`）。
    const fetcher = deps.fetcher ?? fetch;
    const fetchStatus = deps.fetchStatus
        ?? (async (credential, product) => fetchCheckinStatus(credential, product, fetcher));
    const claim = deps.claim
        ?? (async (credential, product) => claimDailyCheckin(credential, product, fetcher));
    // 默认保留预检（CodeBuddy 系需要）；LobsterAI 显式传 false 跳过。
    const precheck = deps.precheckStatus !== false;
    const results = [];
    const outcomes = [];
    /** 仅在 deps.afterClaim 存在时非空；见该钩子的说明。 */
    const growth = [];
    // 整轮共享截止时刻。0 / 负数 / 非有限值一律视为不限时（本地排障用）。
    const rawRound = deps.roundBudgetMs === undefined
        ? DEFAULT_ROUND_BUDGET_MS
        : Number(deps.roundBudgetMs);
    const roundBudgetMs = Number.isFinite(rawRound) ? rawRound : 0;
    const roundDeadlineAt = roundBudgetMs > 0 ? Date.now() + roundBudgetMs : undefined;
    for (const entry of accounts) {
        let outcome;
        try {
            const resolved = await deps.resolve(credentialRef(entry.credentialRef));
            if (resolved === undefined) {
                outcome = { kind: 'failed', code: -1, message: '凭据未配置' };
            }
            else {
                const credential = JSON.parse(resolved.value);
                if (!precheck) {
                    // 领取流程自带状态判断（LobsterAI 的 slot/context 检查在 claim 内部）。
                    outcome = await claim(credential, product, entry);
                }
                else {
                    // 先查状态：活动未开启或今日已领则跳过领取请求，减少无效调用
                    const status = await fetchStatus(credential, product);
                    if (status !== null && !status.active) {
                        outcome = { kind: 'inactive', message: '签到活动未开启' };
                    }
                    else if (status !== null && status.todayCheckedIn) {
                        outcome = { kind: 'already-claimed', message: '今天已签到' };
                    }
                    else {
                        // 状态查询失败（status 为 null）时仍然尝试领取：
                        // 无法确认不代表不能领，交给领取接口以响应体 code 定夺。
                        outcome = await claim(credential, product, entry);
                    }
                }
            }
        }
        catch (error) {
            deps.warn?.(`[jet-hub] credits.claimAll 账号 ${entry.id} 失败: ${String(error)}`);
            outcome = {
                kind: 'failed', code: -1,
                message: error instanceof Error ? error.message : String(error),
            };
        }
        outcomes.push(outcome);
        results.push({ accountId: entry.id, nickname: entry.nickname, outcome });
        // ★ **签到收尾的附加提示**（2026-10-20）：本条对 `claimed` 与 `already-claimed`
        //   **都会跑** —— 后者正是「今天已签到」的账号（本家 precheck 直接回它、
        //   连 `claim` 都不调），而它恰恰最该抽奖。见 `afterClaimNote` 的契约说明。
        //   ⚠️ 必须在 `results.push` **之后**改写（改的是同一对象引用）——
        //      放到之前也行，但那时 `outcome` 还没定稿，语义容易读错。
        if (deps.afterClaimNote !== undefined) {
            try {
                const resolvedForNote = await deps.resolve(credentialRef(entry.credentialRef));
                if (resolvedForNote !== undefined) {
                    const credentialForNote = JSON.parse(resolvedForNote.value);
                    const note = await deps.afterClaimNote(credentialForNote, product, entry, outcome);
                    if (typeof note === 'string' && note.length > 0) {
                        // ⚠️ 只改**这一条** outcome 的 message（客户端渲染的就是它）。
                        //    `claimed` 结局原本没有 message 字段 ⇒ 这里补上；
                        //    `already-claimed` / `inactive` / `failed` 则是追加在原文案之后。
                        const target = results[results.length - 1].outcome;
                        target.message = typeof target.message === 'string' && target.message.length > 0
                            ? `${target.message} · ${note}`
                            : note;
                    }
                }
            }
            catch (error) {
                // ⚠️ 抽奖的任何异常都不得影响签到结果（契约见 `afterClaimNote`）。
                deps.warn?.(`[jet-hub] credits.claimAll 账号 ${entry.id} 收尾提示失败: ${String(error)}`);
            }
        }
        // 成长中心等「领取之后」的下钻：与签到共用这一趟循环，避免把凭据解析做两遍。
        // 它的异常只让该项自己失败，不影响已定稿的签到 outcome。
        if (deps.afterClaim !== undefined) {
            try {
                const resolvedForGrowth = await deps.resolve(credentialRef(entry.credentialRef));
                if (resolvedForGrowth !== undefined) {
                    const credentialForGrowth = JSON.parse(resolvedForGrowth.value);
                    const extra = await deps.afterClaim(credentialForGrowth, product, entry, outcome, roundDeadlineAt);
                    if (extra !== undefined) {
                        growth.push(extra);
                    }
                }
            }
            catch (error) {
                deps.warn?.(`[jet-hub] credits.claimAll 账号 ${entry.id} 成长任务失败: ${String(error)}`);
            }
        }
    }
    return {
        results,
        summary: computeClaimSummary(outcomes),
        ...(growth.length > 0 ? { growth } : {}),
    };
}
/**
 * 逐账号收集积分余额（顺序执行，避免并发触发风控）。
 *
 * 与 {@link collectCreditsStatus} 的关键差异：**这里保留失败原因**。
 * 余额查不到时用户最需要知道"为什么"（凭据过期？网络不通？），把它降级成
 * 一个 null 会让账号卡片显示成空白或 0 分，反而误导。因此失败时带上 error 文案。
 *
 * **包含已停用账号**：停用只影响账号池的自动选择，与"这个账号还剩多少积分"
 * 无关——用户就是想在同一个列表里看全部账号的余额。
 *
 * 凭据解析同样位于每个账号自己的 try 之内：单个账号的凭据缺失/损坏/名称非法
 * 都不会冒泡中断整批。
 */
export async function collectCreditBalances(accounts, product, deps) {
    // 同 collectClaimResults：显式包装，避免 `as unknown as` 掩盖签名差异。
    const fetcher = deps.fetcher ?? fetch;
    const fetchBalance = deps.fetchBalance
        ?? (async (credential, product) => fetchCreditBalance(credential, product, fetcher));
    const fetchDetailed = deps.fetchBalanceDetailed;
    const results = [];
    /**
     * ⚠️ **这里仍是串行**（与 `collectCreditsStatus` 的有限并发**刻意不同**）。
     *
     * `collectCreditsStatus` 于 2026-10-22 改成有限并发（默认 3），本函数**没有**跟着改，
     * 理由是两者接的上游不同：那个只服务 `minimax` / `minimaxintl` 的**只读 GET**，
     * 而本函数是面板「刷新积分」的主路径，各家余额接口都有速率限制（且部分带写语义，
     * 例如 astudio 的 `importLocalSession`、minimax 的积分端点），并发收益不明而风险
     * 更高。⇒ 要改这里必须**逐家**核对限流策略，不能因为「隔壁改了」就跟着改。
     *
     * ⚠️ 也别把「顺序查询避免并发触发风控」当成通用铁律 —— 它对**写操作**
     * （`collectClaimResults`，签到）与**余额查询**（本函数）成立，对
     * `credits.status` 那种只读单发的状态查询不成立（依据见 `collectCreditsStatus`）。
     */
    for (const entry of accounts) {
        let balance = null;
        let error;
        let extra;
        /**
         * ★ 先吃共享读数（2026-10-16）：命中即**零网络请求**。
         *
         * ⚠️ **必须排在解析凭据之前**：缓存命中时我们压根不需要凭据 ——
         * 而「凭据读不到」正是最该显示旧值的那种失败（凭据可能被并发续期覆盖）。
         * ⚠️ 命中时**不设 `extra`**（缓存里那份没有该字段，见 `readCachedBalance` 注释）。
         * ⚠️ 兼顶读数（`stale: true`）**照样回传**，并带上 `error` 让 UI 标注
         *    「本次查询失败，显示的是 HH:MM 的数据」—— 这正是用户 2026-10-16 的要求：
         *    拿不到新数据就读旧数据，而不是直接返回错误。
         */
        if (deps.readCachedBalance !== undefined && entry.id !== undefined) {
            // ⚠️⚠️ **`force` 必须透传下去**（2026-10-16 审计 P1-1 实测确认的回归）：
            //   这里原写死 `{}` ⇒ `readOptions.force` 恒 `undefined` ⇒ 端点虽然读了
            //   `payload.force`，但**这一腿永远传不到** ⇒ 面板「刷新积分」按钮在
            //   120 秒 TTL 内点了等于没点，而按钮 title 写着「点此可刷新」—— 假的。
            //   ⇒ 载荷的 `force` 经 `collectCreditBalances` 的 deps 一路透到这里。
            const cached = await deps.readCachedBalance(entry.id, { force: deps.force === true });
            if (cached !== undefined) {
                balance = cached.balance;
                if (cached.stale) {
                    error = `本次查询失败，显示的是 ${new Date(cached.at).toLocaleString('zh-CN')} 的数据（${cached.error ?? '上游不可达'}）`;
                }
            }
        }
        if (balance === null) {
            try {
                let resolved = await deps.resolve(credentialRef(entry.credentialRef));
                if (resolved === undefined) {
                    error = '凭据未配置';
                }
                else {
                    const credential = JSON.parse(resolved.value);
                    if (fetchDetailed !== undefined) {
                        // 带原因的查询：实现自己决定「非积分账户」等业务状态的文案。
                        // ⚠️ `entry.id` 必须透传（Gitee issue IKLTZ2）：Gemini 要按**账号**
                        // 取出口代理，而账号 id 无法由 `credentialRef` 反查。
                        const detailed = await fetchDetailed(credential, product, entry.id);
                        balance = detailed.balance;
                        error = detailed.error;
                        extra = detailed.extra;
                        if (balance === null && error === undefined)
                            error = '余额查询失败';
                    }
                    else {
                        balance = await fetchBalance(credential, product);
                        // 查询函数以 null 表示"查不到"（网络/业务码异常），与"余额为 0"不同
                        if (balance === null)
                            error = '余额查询失败';
                    }
                }
            }
            catch (caught) {
                deps.warn?.(`[jet-hub] credits.balances 账号 ${entry.id} 失败: ${String(caught)}`);
                error = caught instanceof Error ? caught.message : String(caught);
                balance = null;
            }
        }
        results.push({
            accountId: entry.id,
            nickname: entry.nickname,
            balance,
            ...error === undefined ? {} : { error },
            ...extra === undefined ? {} : { extra },
        });
        // ⚠️ **回写共享读数**（规格 §5.7）：只写**成功**的余额 —— 于是聚合折算能命中
        //    面板刚查过的那一条（同一个 `(provider, accountId)` 键）。
        //    ⚠️ 失败**不写**：失败是瞬时的，写进去会让折算侧把「刚失败过一次」当结论
        //    （`balance-cache.ts` 的 `write` 也自带这道守卫，两处一致）。
        if (balance !== null)
            deps.writeBalance?.(entry.id, balance);
    }
    return results;
}
/**
 * 读取 `ctx.llm` 用于枚举 provider 的模型目录。
 *
 * ## ⚠️ 必须**优先属性访问** `ctx.llm`
 *
 * `src/index.ts` 里 `mountOpenAiGateway` 传的是 `ctx.llm`（属性），而本模块
 * 原先只走 `ctx.get('llm')`。在 connection 上下文里后者可能拿不到
 * `listProviders` —— 结果是**同一时刻**两个页面给出矛盾答案：
 * `/v1/models` 正常返回 36 个模型，而设置页的清单恒为 0 个。
 * 两处服务来源不一致还会让「纠错建议里给的 ID」与「网关实际接受的 ID」可能不同。
 *
 * 用 `ctx.get`（而非插件级 `inject`）作回退：Jet Hub 的账号管理是主要职责，
 * 模型开关只是附加能力；llm 服务完全缺失时账号面板仍应可用。
 *
 * `listAllModels` 是本插件适配器额外提供的**不受用户黑名单影响**的完整目录
 * （见各适配器的同名方法）。DSH 的 `llm` 服务只保证 `listModels`，故它与
 * `listProviders` 都声明为可选。
 */
function llmServiceOf(ctx) {
    const direct = ctx.llm;
    if (direct !== undefined && direct !== null)
        return direct;
    return ctx.get('llm');
}
/**
 * 采集网关目录（**含思考档位视图**）。
 *
 * ⚠️ 两个 RPC 分支（`gateway.getEnabled` / `gateway.setEnabled`）必须共用本函数：
 * 设置页看到的档位与 `/v1/reasoning-efforts` 返回的必须同源，各算一遍必然漂移，
 * 而漂移的症状是「照着设置页填的对不上网关实际接受的」—— 本功能存在的全部理由
 * 就是消灭这种对照错误，自己再造一个就毫无意义了。
 *
 * 档位要逐模型 `resolveModelInfo` 才拿得到（`listModels` 不带），成本是每个模型
 * 一次**读缓存**的调用（远端目录刚被 `listModels` 拉过），与 DSH 自己
 * `buildModelCatalog` 的形状一致。
 */
async function collectGatewayCatalog(llm, providers, onError) {
    const source = {
        listProviders: () => providers,
        listModels: (provider) => llm.listModels(provider),
    };
    const resolve = llm?.resolveModelInfo;
    if (typeof resolve === 'function') {
        source.resolveModelInfo = (provider, model) => resolve.call(llm, provider, model);
    }
    const groups = await collectGatewayModels(source, onError);
    const views = await collectGatewayEffortViews(source, groups, onError);
    return toGatewayModelIds(groups, views);
}
/**
 * 列出可用于枚举目录的 provider。
 *
 * ⚠️ `listProviders` 取不到时**用已注册适配器的 key 兜底** —— 那些 key 就是本
 * 插件注册的 provider 全集，比「什么都没有」有用得多。仍取不到才返回
 * `undefined`（调用方据此给出明确原因，而不是显示一个空清单让用户去猜）。
 */
function providerIdsOf(llm, modelAdapters) {
    if (llm?.listProviders !== undefined) {
        try {
            const listed = llm.listProviders();
            if (Array.isArray(listed) && listed.length > 0)
                return listed;
        }
        catch {
            // 落到下面的兜底。
        }
    }
    const keys = Object.keys(modelAdapters ?? {});
    return keys.length > 0 ? keys.map((id) => ({ id })) : undefined;
}
/**
 * 按 provider id 取 auth 实例。
 *
 * ⚠️ **键是 provider id**（`qodercn`），不是变量名（`qoderCn`）——
 * 这是 `JetHubAuths` 的接口约定（见其注释）。
 *
 * ⚠️ 用 `Object.hasOwn` 而非 `in`：`in` 会命中原型链上的键（如 `'constructor'`），
 * 把 `entry.provider` 为怪值时误判成「有该 provider」。
 */
export function authOf(auths, provider) {
    if (!Object.hasOwn(auths, provider))
        return undefined;
    return auths[provider];
}
/**
 * 腾讯 Marvis 的 `expiresAt` 补丁（**唯一一份判据**）。
 *
 * ⚠️ `MarvisCredential.expires_at` 是**毫秒时间戳字符串**（上游 `Set-Cookie` 的
 * `access_token_expire_time` 原样），`credentialExpiresAtMs` 负责「秒 / 毫秒」
 * 两种口径的归一（`> 1e12` 当毫秒，否则 ×1000）。
 */
function marvisExpiresAtPatch(credential) {
    const expiresAt = marvisCredentialExpiresAtMs(credential);
    return expiresAt === undefined ? {} : { expiresAt };
}
/**
 * 在账号池里找「**同一个 Marvis 账号**」的既有条目 —— 唯一一份判重实现。
 *
 * ## 判据：`openid`
 * `account.create` 每次都生成新的 `${provider}-${shortId()}` 与
 * `MARVIS_ACCOUNT_${suffix}`，而同一个 QQ / 微信账号反复登录拿到的是**同一个
 * `openid`**（它是账号的稳定身份；`access_token` 会随重登轮换、
 * `guid` 每次登录都是新造的虚拟设备）⇒ 只有 `openid` 能判重。
 *
 * ⚠️ 与 magicrew 的三条边界逐条同款：读不到凭据的账号**跳过**（无法判定 ≠ 失配）、
 *    非 JSON / 缺 `openid` 的条目**跳过**、`skipAccountId` 排除本次自己的占位条目。
 */
async function findMarvisAccountByOpenid(params) {
    const { ctx, pool, openid, skipAccountId } = params;
    if (openid.length === 0)
        return undefined;
    for (const existing of pool.listAccountsByProvider(MARVIS.id)) {
        if (existing.id === skipAccountId)
            continue;
        const resolved = await ctx.credentials.resolve(credentialRef(existing.credentialRef))
            .catch(() => undefined);
        // ⚠️ 边界 ①：读不到 ⇒ 跳过（既不判「重复」也不判「不重复」）。
        if (resolved === undefined)
            continue;
        const parsed = parseMarvisCredential(resolved.value);
        if (parsed !== undefined && parsed.openid === openid)
            return existing;
    }
    return undefined;
}
/**
 * ⚠️ 2026-10-08 改：各 provider 形参从**位置传参**改为**命名对象**（`auths`）。
 *
 * 原注释记录「历史上已因少传/插队错位复发 **6 次**」—— 位置参数天生有这个缺陷
 *（改签名顺序、插一个新 provider 都会静默错位，而症状是「某个 provider 在用
 * 另一个 provider 的凭据续期」）。命名对象让错位在**类型层面不可能**，
 * 且新增 provider 只加一个键。
 *
 * ## ⚠️ 积分能力表**不是形参**（2026-10-08 设计复审 C1）
 *
 * Task 3 初版曾在本函数末尾加**第 5 个形参** `credits?: Readonly<Record<string,
 * ProviderCredits>>`，现已删除。三条理由（复审报告 `.superpowers/sdd/
 * task-3-design-eval.md` §4/§6）：
 *
 * 1. **它在生产路径上不承载任何信息** —— `src/index.ts` 传进来的正是
 *    `createProviderCredits({ loomy, raccoon, zcode })`，而这三个实例就是本函数
 *    形参 `auths` 里的 `loomy` / `raccoon` / `zcode`；`registerJetHubEndpoints`
 *    自己现造的那份**逐字节等价**。删掉实参生产行为不变 ⇒ 它是**纯测试接缝**，
 *    而「形参一侧 === 生产分派」这件事**没有任何测试守着**。
 * 2. **它重开了 Task 9 刚关掉的门** —— 一个可选的**位置**形参：在它之前插入
 *    任何新的可选形参，调用点 `(…, modelAdapters, creditsTable)` 就会**静默**
 *    把表落进新形参（本仓库实测复发 6 次的位置错位形态）。`modelAdapters` 与
 *    `credits` 值类型不同，互换会被 `tsc` 抓到，但**插入**不会。
 * 3. ⇒ 改为**从 `auths` 派生**（见 `registerJetHubEndpoints` 里的 `credits`），
 *    签名回到 4 个形参。
 *
 * ⚠️ **全局注册表（`ProviderRuntime.credits`）仍然保留且必须保留** —— 那是
 * Task 5 的 `aggregate-expiry.ts` / Task 8 的 `account-probe.ts` 这类
 * **拿不到 `auths` 形参**的跨模块消费点的唯一入口，由 `src/index.ts` 的
 * `registerProviderRuntime` 挂上。它与本函数现造的表**同源同构**
 *（同一个工厂、同一批实例），只是消费方不同。
 *
 * ⚠️ 端点级「表真的驱动分派」的测试改由模块替身注入
 *（`tests/unit/credits-runtime-parity.spec.ts` 的 `vi.mock('provider-credits')`）——
 * 断言仍打在**端点响应**上，判别力与原形参方案逐条等价。
 */
export function registerJetHubRpc(ctx, pool, 
/** ⚠️ 命名对象，不是位置参数。键是 provider id（见 `JetHubAuths`）。 */
auths, 
/**
 * provider → 适配器实例（可选）。
 *
 * 用于「显示列表」拿到**不受用户黑名单影响**的全量目录（`listAllModels`），
 * 使被关闭的模型也能显示正确的展示名（含倍率），而不是退化成裸 id。
 * 省略时退化为只用 `ctx.llm.listModels()` 的历史行为。
 */
modelAdapters) {
    ctx.inject(['connection'], (connectionCtx) => {
        registerJetHubEndpoints(connectionCtx, pool, auths, modelAdapters);
    });
}
/**
 * 取某 provider 的**模型 id**（两个目录来源的并集），供「关闭全部」「关闭供应商」
 * 与「测试账号选模型」共用。
 *
 * ## ⚠️⚠️ 并集是必须的，不能「优先 `listAllModels()`」（真实缺陷）
 *
 * 本仓库有两个「目录」来源，**并不总是同源**：
 *
 * | 来源 | 形态 |
 * |---|---|
 * | `modelAdapters[provider].listAllModels()` | 不套黑名单；**冷缓存下是编译期兜底表（子集）** |
 * | `llm.listModels(provider)` | **真实远端目录 − 黑名单**；异步、可能失败 |
 *
 * 原实现是「**优先** `listAllModels()`，只要它存在就短路、根本不看 `listModels()`」，
 * 而冷缓存下兜底表是**子集**（`model-catalog.ts` 的 `cached ?? config.syncCatalog()`；
 * 实测 `cline` 冷缓存只有 **3** 条，远端有 **460** 条）⇒ 两个关闭方向都会写出
 * **只含兜底表条目**的黑名单，而端点返回「成功」：
 *
 * - `model.setAllDisabled`：用户以为整个供应商已关闭，而**几百个模型仍可选**；
 * - `provider.setEnabled`：更重 —— `provider.status` 的 `closed` 判据是
 *   `total > 0 && disabled === total`，而 `total` 也取自 `listAllModels()`
 *   ⇒ 界面**显示为已关闭**，对话框里那几百条却**仍能选中**。这正是该端点注释里
 *   列为**必须避免**的「账号全停用但模型仍可见」形态的镜像。
 *
 * 用户报障路径**恰恰是冷缓存**（脚本/设置页首次打开就点「关闭全部」）。
 * ⚠️ 既有注释其实早已立下约定「失败时**不落盘** —— 否则会写入一个不完整的
 * 黑名单，用户看到『关了一半』且无从判断原因」，但 `listAllModels()` 冷缓存返回
 * 子集时它**不算失败**，于是绕过了那条守卫。并集把那个缺口补上。
 *
 * ## ⚠️ 适配器那一半**不能丢**（即使远端成功）
 *
 * `listModels()` 会把**已被用户关闭**的模型过滤掉，而适配器目录带着它们。
 * 漏掉会让 `provider.setEnabled` 的 `ids.length === 0` 判据在「全部已关闭」时
 * 误判成「没有可关闭的模型」而拒绝操作。
 *
 * ## ⚠️ 与 `readableCatalogIds` 的分工：**目录来源只此一处**
 *
 * 两者共用本函数取目录，区别只在**失败时的动作**：写黑名单的调用方**拒绝操作**，
 * 提示层（`readableCatalogIds`）**放弃核对**。
 * ⚠️ **不要在这里或那里再各写一份目录来源逻辑** —— 本仓库踩过「一文件两套同义
 * 判据必然先腐坏一套」（IKJW33 修复时实测出内层判据在生产路径上不可达）。
 *
 * ⚠️ **远端读取带超时**（{@link CATALOG_READ_TIMEOUT_MS}）：这是写操作的前置读取，
 * 不能把用户点开关的等待无限拉长。
 *
 * @param ctx - 取 `llm` 服务用。
 * @param modelAdapters - 设置页目录来源（并集的一半，同步、不产生网络请求）。
 * @param provider - 目标 provider。
 * @returns 见 {@link FullCatalogResult}（**部分成功**是合法结果）。
 */
async function fullCatalogIds(ctx, modelAdapters, provider) {
    // ── 来源一：适配器目录（同步；但**冷缓存下是兜底子集**）──
    // ⚠️ 它抛错**不独自决定成败**：远端那一半仍可能成功，故单独吞掉。
    const adapterIds = [];
    try {
        // ⚠️ **必须校验形状**（2026-11-05 四审端到端 P2-2）：适配器的类型契约是
        // `LlmModelInfo[]`，但那是**编译期**保证。运行期若某个第三方/桩实现返回
        // 字符串数组，`.id` 会取到 `undefined` ⇒ 黑名单被写成 `{"undefined":true}`
        //（静默落盘、且 `total` 随之虚高）。实测：桩返回 `['a','b']` ⇒ 黑名单
        // `{"a":true,"b":true,"undefined":true}`、状态 `{total:3,disabled:3}`。
        // 过滤是**零成本**的（正常实现每条都过），故不必区分「该不该防」。
        for (const model of modelAdapters?.[provider]?.listAllModels() ?? []) {
            if (typeof model?.id === 'string' && model.id.length > 0)
                adapterIds.push(model.id);
        }
    }
    catch {
        /* 适配器异常不该让整个读取失败：远端目录仍可用 */
    }
    // ── 来源二：远端真实目录（权威；冷缓存下会真发一次拉取）──
    const llm = llmServiceOf(ctx);
    if (llm === undefined) {
        // ⚠️ 远端拿不到 ⇒ 只剩兜底子集 ⇒ **不可用于写黑名单**（`complete: false`）。
        return { ids: adapterIds, complete: false, remoteError: 'llm 服务不可用' };
    }
    let remoteIds;
    try {
        // ⚠️ 同样校验形状（理由见上面 `adapterIds` 处；远端那份更值得防 —— 它是
        // **网络来的**数据，上游一次改契约就会让 `undefined` 混进黑名单）。
        remoteIds = (await withTimeout(llm.listModels(provider), CATALOG_READ_TIMEOUT_MS))
            .map((model) => model?.id)
            .filter((id) => typeof id === 'string' && id.length > 0);
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ids: adapterIds, complete: false, remoteError: `读取模型列表失败：${reason}` };
    }
    // ⚠️⚠️ **第 3 种形态：适配器自报「我这份目录还不是全的」**（Critcal，Task 7 引入）。
    //
    // 上面那一步「远端读到」对**动态目录**的 provider（目前只有聚合）**不再等价于
    // 读全**：Task 7 之后聚合的 `listModels` 立刻返回**已知**目录（冷启动时只有
    // `auto`），逐渠道推导转后台 ⇒ 这里会看到「读成功、但只有 1 条」。
    //
    // 不拦的后果（控制方实测）：
    // ```
    // setEnabled(false) 结果 = {"written":["auto"],"changedCount":1}   ← 只关了 auto！
    // 稳态对照       = {"written":["auto","deepseek-v4-1-flash","glm-5-3"],"changedCount":3}
    // ```
    // 用户点「关闭聚合供应商」→ 提示「已关闭 1 个模型」、返回 `ok:true`，而另外两个
    // 虚拟模型**仍可选** —— 正是本文件 `provider.setEnabled` 注释里明文禁止的缺陷形态。
    //
    // ⚠️ **必须排在「远端读到但为空」那一步之前**判：冷帧下聚合的远端也会是
    // `['auto']`（非空）⇒ 不加这一步会一路落到下面「成功」分支。
    // ⚠️ 探测**抛错按「不可用」处理**（保守方向：宁可拒绝一次关闭，也不要写出残缺
    // 黑名单后仍报成功）。
    try {
        const readiness = modelAdapters?.[provider]?.catalogReadyForBulkWrite?.();
        if (readiness !== undefined && readiness.ready !== true) {
            return {
                ids: [...new Set([...adapterIds, ...remoteIds])],
                complete: false,
                notReady: readiness.reason ?? '目录尚未就绪',
            };
        }
    }
    catch {
        return {
            ids: [...new Set([...adapterIds, ...remoteIds])],
            complete: false,
            notReady: '目录就绪状态探测失败',
        };
    }
    // ⚠️⚠️ **远端读到但为空 ⇒ 同样不可用于写黑名单**（`complete: false`，且**无**
    // `remoteError` —— 它不是错误）。含义是「看不到」（无账号门控），不是
    // 「该 provider 一个模型都没有」；此时适配器兜底表仍可能有内容，照它写黑名单
    // 就是同一个缺陷的另一个入口（见 `FullCatalogResult.complete` 的长注释）。
    return {
        ids: [...new Set([...adapterIds, ...remoteIds])],
        complete: remoteIds.length > 0,
    };
}
/**
 * 核对目录时的读取预算（毫秒）。
 *
 * 开关是**写操作**，不该被远端目录拉取拖住（见 `readableCatalogIds` 的注释）。
 * 取 2 秒：缓存已热时是纯内存读、立即返回；冷缓存下的正常远端读取也在秒级内
 * 完成，超过它说明上游正卡着 —— 此时放弃核对、照常写入开关。
 * ⚠️ 不要为了「多拿到几次核对」而调大：这条预算**直接加在用户点开关的等待上**。
 */
const CATALOG_READ_TIMEOUT_MS = 2000;
/**
 * 给一个 Promise 加超时；超时即 reject（调用方按「读不到」处理）。
 *
 * ⚠️ **不取消底层请求**（`listModels` 不接受 signal）：只是不再等它。
 * 这是刻意的 —— 底层那次拉取的结果仍会填进 `ModelCatalog` 的缓存，
 * 对后续的 `model.list` 有用，取消反而浪费。
 */
function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`catalog read timed out after ${ms}ms`)), ms);
        promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); });
    });
}
/**
 * 核对一批 id 是否**真的在**当前模型目录里，为「静默空操作」生成 warnings。
 *
 * ## 解决的报障（Issue IKJW33，2026-10-08）
 *
 * 对**已从上游目录消失**的模型 id 调 `on`/`off`，旧实现返回「成功 1」却
 * **什么都没发生、且没有任何警告**。用户实测两例：
 * `cline/cline-free/deepseek-v4.1-flash` 与 `cline/stealth/space-bunny-alpha`
 * 在 10-05 记录「上游 model not found」后已从 cline 目录消失（490 → 489）。
 * 后果：① 脚本/AI 助手据「成功 1」误判开关已生效；② 黑名单里残留幽灵条目，
 * 模型在 GUI 已看不见、关闭记录却还挂着，导入号池时还会被一起搬走。
 *
 * ## ⚠️⚠️ 判据必须是**两个目录来源的并集**（两个方向都已被实测证伪）
 *
 * 本仓库有两个「目录」来源，**它们并不总是同源**：
 *
 * | 来源 | 谁在用 | 形态 |
 * |---|---|---|
 * | `llm.listModels(provider)` | 对话框模型选择器 | **真实远端目录 − 黑名单** |
 * | `modelAdapters[provider].listAllModels()` | **设置页**（`model.list`） | 不套黑名单；**冷缓存下是编译期兜底表** |
 *
 * 只取任一个都被实测证伪：
 *
 * - **只取 `listAllModels()`**（本修复第一版）⇒ 冷缓存下兜底表是**子集**：
 *   实测 `cline` 冷缓存只返回 **3** 条（`fallbackModels`），远端却有 **460** 条
 *   ⇒ 远端任意正常模型都被误报。而 issue 的复现路径**恰恰是冷缓存**
 *   （脚本直接调 `on`，从未先跑 `list`）。
 * - **只取 `listModels()`**（第二版）⇒ 在 `opencode` 上**反向**误报：它的
 *   `listAllModels()` **恒返回**编译期兜底表（永不读远端），而 `listModels()`
 *   在**只有匿名槽**时还会 `filter(isFree)` ⇒ 设置页看得见的付费模型在
 *   `listModels()` 里**一个都没有**。审计实测：无付费账号时关闭 13 个设置页
 *   可见的模型，**13/13 全部收到假警告**（「该模型可能已被上游下架」，
 *   而它并没有下架，只是当前匿名身份看不到）。
 *
 * ⇒ 取**并集**。方向刻意是「宁漏勿误」：`known` 越大 ⇒ `missing` 越小 ⇒
 * 误报越少。提示类信息的**误报比漏报糟得多**（用户会对整类提示脱敏），
 * 故宁可漏报（少一条提示）也不能误报（把正常模型说成已下架）。
 *
 * ## ⚠️⚠️ `listModels()` 失败**必须整体放弃核对**，不得退化成「只用兜底表」
 *
 * `listModels()` 是**唯一**能反映远端真实目录的来源（`listAllModels()` 在
 * 冷缓存与 opencode 上都可能是编译期快照）。它读不到（超时 / 抛错 / 空目录）时
 * 若仍拿 `listAllModels()` 去核对，就**退化回第一版的误报形态**。
 * ⇒ 直接返回 `undefined`（放弃核对），开关照常写入、不带任何警告。
 *
 * ⚠️ **这是刻意的取舍，不是漏写**：代价是「远端目录首次拉取就失败」时
 *（凭据过期 / 上游抖动）连兜底表也不用来核对 ⇒ issue 的原始场景
 *（脚本冷启动直调 `on`）恰好最可能命中这条**漏报**面。
 * 接受它，因为反向（拿快照当权威）会把**正常模型**说成已下架。
 *
 * ## ⚠️ 黑名单必须在**本函数内部**、于 `await` **之后**读
 *
 * 下面把黑名单里 `true` 的 id **并回** `known`：那是「在目录里、但被用户关着」，
 * 用户能重新打开它 ⇒ 不能判成「不在目录」。
 *
 * ⚠️⚠️ **这个读取刻意放在 `await listModels()` 之后**（真实缺陷，审计实测）：
 * 若由调用方在 `await` **之前**取快照传进来，则「快照」与「实际写入」之间隔着
 * 一次 `listModels`（冷缓存下最长 {@link CATALOG_READ_TIMEOUT_MS}）—— 期间
 * 另一路 RPC 的写入会让快照失真，实测出现「**实际产生了变更却报『本次没有产生
 * 任何变更』**」（与 issue 要消除的误导同型）。放在这里之后，从读黑名单到写入
 * 全是**同步代码、无 await** ⇒ 窗口归零。
 *
 * ## ⚠️ `dead` 表里的 id 算「不在目录」，但文案必须可操作
 *
 * 失效模型被 `withDeadModelPruning` 从**两个来源**同时剔除（`llm.listModels`
 * 与 `modelAdapters.listAllModels` 都是 pruned 代理），而 `model.list` 又把它们
 * 补回设置页（带 `dead:true`）供用户点「重新显示」⇒ 它们天然落在判据的
 * 「目录外」。issue 的两例正是这个形态。只说「不在目录」不够 ——
 * 必须告诉用户去点「重新显示」（`model.clearDead`），否则他无从下手。
 *
 * ## ⚠️ 放弃核对（返回 undefined）的三种情况
 *
 * 1. **`listModels()` 读失败**（超时 / 抛错）—— 理由见上，这是**关键**一条；
 * 2. **`listModels()` 返回空**：`createModelCatalog` 在「无已登录账号」时返回
 *    `[]`（门控隐藏整个 provider）⇒ 空目录意味着「看不到」而非「全部下架」；
 * 3. **`llm` 服务缺失**：拿不到远端目录，无从核对。
 *
 * ⚠️ **目录来源取自 `fullCatalogIds`，本函数不自己再取一遍** ——
 * 两处各写一份「哪个来源优先」的判据，就是本仓库踩过的
 * 「一文件两套同义判据必然先腐坏一套」（那次实测出内层判据在生产路径上**不可达**）。
 * 这里只负责把它的**失败**翻译成「放弃核对」（提示层错了不如不说），
 * 而两个关闭方向把同一个失败翻译成「拒绝操作」（写黑名单必须完整）。
 *
 * ⚠️ **必须带超时**：`listModels()` 在**冷缓存**下会真的发一次远端拉取
 *（`loadCatalog()`），于是「开关」这个原本纯本地的写操作多了一条网络依赖。
 * 开关**绝不能**被远端拖住 —— 用户点一下开关却转圈几十秒，比少一条提示糟得多。
 * 故核对是**尽力而为**：超时（{@link CATALOG_READ_TIMEOUT_MS}）即放弃核对。
 * ⚠️ GUI 路径上缓存通常已热（用户先看到模型列表才会去点开关），此时是纯内存读、
 * 无新增延迟；只有「脚本冷启动直接调开关」才可能等一次拉取。
 *
 * @param ctx - 取 `llm` 服务用。
 * @param pool - 读黑名单（**在 await 之后**，理由见上）。
 * @param modelAdapters - 设置页目录来源（并集的一半）。
 * @param provider - 目标 provider。
 * @returns `known` = 可核对的目录 id 集合；`undefined` = **放弃核对**（三种情况见上）。
 *          `catalog` = {@link fullCatalogIds} 的**原始并集结果**（不并黑名单）。
 *          ⚠️ 两者**不可混用**：`known` 是 `catalog.ids` **并回黑名单**后的派生值，
 *          拿它判「本次写入是否覆盖该家全量目录」**恒真**（等于「关一个模型就关掉
 *          整个供应商」）—— 那个判据只能用 `catalog.ids`，见 `model.setDisabledMany`。
 *          ⚠️ 顺带返回 `catalog` 是为了让关闭方向**不必再取一次目录**
 *          （`fullCatalogIds` 冷缓存下真的会发远端拉取，多调一次就多一条网络依赖）。
 */
async function readableCatalogIds(ctx, pool, modelAdapters, provider) {
    const catalog = await fullCatalogIds(ctx, modelAdapters, provider);
    // ⚠️⚠️ **目录不可用 ⇒ 整体放弃核对**（判 `complete`，它同时覆盖
    // 「远端读失败」「远端读到但为空」「**适配器自报未就绪**（`notReady`）」三种形态
    // —— 见该字段的长注释）。第三种是 Task 7 引入的（聚合的 `listModels` 不再同步
    // 等上游 ⇒ 冷帧只有 `auto`）：那时并集是残缺的，拿它核对会**大面积误报**
    // 「该模型可能已被上游下架」。
    // 不得退化成「只用 listAllModels 兜底表」：那会退回第一版的大面积误报。
    // 提示层错了不如不说。
    if (!catalog.complete)
        return { known: undefined, catalog };
    const known = new Set(catalog.ids);
    // ⚠️ 并回「被关着」的 id —— **必须在 await 之后读**（理由见函数头）。
    // ⚠️ `fullCatalogIds` 的并集**已含**适配器目录里那些被关闭的 id，
    // 但**不含**「既不在适配器目录、也不在远端目录」的历史死键（那些只存在于
    // 黑名单里）。它们必须并回来：打开方向正是清理它们的唯一路径。
    for (const [id, disabled] of Object.entries(pool.listDisabledModels(provider))) {
        if (disabled === true)
            known.add(id);
    }
    return { known, catalog };
}
/**
 * 为「静默空操作」生成 warnings（纯函数，判据与取舍见 {@link readableCatalogIds}）。
 *
 * @param known - 可核对的目录 id 集合（**已含**黑名单里的 id）；`undefined` = 放弃核对。
 * @param provider - 目标 provider（查 dead 表给可操作指引）。
 * @param ids - 本次操作的模型 id（已去重）。
 * @param disabled - 目标状态：true = 关闭，false = 打开。
 * @returns 警告文案（无警告时为空数组）。
 */
function catalogWarnings(known, provider, ids, disabled) {
    if (known === undefined)
        return [];
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length === 0)
        return [];
    const dead = deadModelIdsFor(provider);
    /** 失效模型的正确动作是「重新显示」，必须给出这条可操作指引。 */
    const hint = (id) => dead.has(id)
        ? '（已被判为失效，可在模型列表里点「重新显示」恢复）'
        : '（该模型可能已被上游下架）';
    return missing.map((id) => disabled
        // 关闭方向：写入生效了，但它本来也不在可选列表里，故不影响实际可选集合。
        ? `${id} 不在当前模型目录，本次关闭不影响可选列表${hint(id)}。`
        // 打开方向：黑名单里没有它（有的话已被 `readableCatalogIds` 并回 `known`）
        // ⇒ 本次既没写也没删，是纯空操作。
        : `${id} 不在当前模型目录，且黑名单里没有它 —— 本次没有产生任何变更${hint(id)}。`);
}
/** 注册 Jet Hub 管理 API 端点。使用 ctx.connection.fetch.register() 注册 HTTP POST 端点。 */
function registerJetHubEndpoints(ctx, pool, auths, modelAdapters) {
    /**
     * 在飞的目录核实（single-flight 去重，键 = provider id）。
     *
     * ⚠️⚠️ **为什么需要**（2026-11-05 四审端到端 P2-1）：`withTimeout` 只
     * reject 外层 Promise、**不取消**底层请求（`listModels` 不接受 signal，
     * 见 `withTimeout` 的注释）。而 `provider.status` 会被反复调用
     *（挂载即发 + 每次 `toggleProvider` 后 + 用户点「重试」），每次都对
     * 「派生判据说已关闭」的家发一轮核实 ⇒ 上游 5s 才返回时，连发两次就有
     * **56 个在飞请求**（28 家 × 2 轮，实测：`峰值并发 = 56`、
     * `listModels 总调用 = 56 次`）。
     *
     * 后果是正反馈：请求越多越容易 429，而 429 又会产出 `remoteError`。
     *
     * ⇒ 对同一 provider 的在飞核实去重：后来者 `await` 同一个 Promise。
     * 语义等价（同一时刻的同一份目录），只是不再重复发请求。
     *
     * ⚠️ **必须完成后立即清除**（成功与失败都清）：目录是**可变**的，
     * 缓存超过一次「在飞窗口」就会让用户看到过期目录。
     * ⚠️ 作用域在 `registerJetHubEndpoints` 内（**不是模块级**）：测试会创建
     * 多个实例，模块级 Map 会让它们互相复用对方的 Promise（假绿/假红）。
     */
    const catalogVerifyInFlight = new Map();
    /**
     * 对同一 provider 的目录核实做 single-flight（见 `catalogVerifyInFlight`）。
     *
     * ⚠️ 只在**同一时刻**去重，不跨请求复用结果 —— 这正是「在飞」而非「缓存」
     * 的含义。要缓存请另做（本仓库的目录缓存另有其事，见
     * `src/model-catalog.ts` 的 `invalidateCatalogCache`）。
     */
    const verifyCatalogOnce = (provider) => {
        const existing = catalogVerifyInFlight.get(provider);
        if (existing !== undefined)
            return existing;
        const pending = fullCatalogIds(ctx, modelAdapters, provider)
            .finally(() => { catalogVerifyInFlight.delete(provider); });
        catalogVerifyInFlight.set(provider, pending);
        return pending;
    };
    /**
     * 积分能力表。
     *
     * ⚠️ 本 fork 裁剪后表里只剩 **marvis** 一条（实现已收敛进
     * `provider-credits.js`，本调用不再传 deps —— 该表原为 loomy / raccoon /
     * zcode 等实例保留的注入形状已随裁剪消失）。
     */
    const credits = createProviderCredits();
    /**
     * **一次性奖励**能力表。
     *
     * ⚠️ 本 fork 裁剪后是**空表**：marvis 没有新人任务端点（原 loomy /
     * raccoon 登记项随裁剪删除）。
     */
    const onboarding = createProviderOnboarding();
    /**
     * 传给各家 credits 实现的调用上下文。
     *
     * ⚠️ 与 Task 5/8 的 `ProviderCallContext` **同形但不同源**：本函数在
     * `registerJetHubEndpoints` 的闭包里，持有的是**本次注册的** ctx / pool，
     * 而全局注册表那条路要等 `index.ts` 装配。两者的字段含义一致
     *（凭据解析 / 日志 / 账号池），故实现侧只需一个形状。
     */
    const callContext = {
        resolveCredential: (refName) => ctx.credentials.resolve(credentialRef(refName)),
        warn: (message) => ctx.logger?.warn?.(message),
        accountPool: pool,
        /**
         * 刷新**轮换**出的凭据写回（2026-10-27 Gitee PR #153 审计 P0）。
         *
         * ⚠️ 与 `resolveCredential` **同一个 ref 约定**（都经 `credentialRef(...)` 归一）
         * —— 实现侧传的是 `entry.credentialRef`，正是 `collectClaimResults` 里
         * `deps.resolve(credentialRef(entry.credentialRef))` 用的那一个，
         * 两条腿必须看到**同一份**凭据。
         *
         * ⚠️ 与既有续期腿 `autoclaw-auth.ts` 的 `credentials.set(ref, …)` **同源**
         * —— 那是本仓库唯一被验证过的凭据回写路径，不要再写第二套。
         */
        persistCredential: async (refName, value) => {
            await ctx.credentials.set(credentialRef(refName), value);
        },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connection = ctx.connection ?? ctx.get('connection');
    if (!connection || typeof connection.fetch?.register !== 'function') {
        ctx.logger.warn('[jet-hub] connection.fetch not available, RPC endpoints not registered');
        return;
    }
    /**
     * **真正支持按需续期**的 provider 集合（有 refresh 端点的）。
     *
     * ⚠️ 这是「跳过」与「报错」的分界线，两者的区别是**本质的**：
     * - **不在**本集合里 ＝ 该渠道**设计上**没有续期能力，
     *   自愈应当**静默跳过**（不发请求、不记日志）—— 它不是失败，是「无需处理」。
     * - 在集合里但查表失败/续期抛错 ＝ 真失败，必须记 warn。
     *
     * ⚠️ **不能用 `throw` 来表达「不支持」**（对抗审计实测到的真实缺陷）：
     * heal 的 catch 会把异常记成误导性的告警，一条**每次刷新面板都会重复**
     * 的噪音（AGENTS.md 已记「重复同一行会把有用信息埋掉」）。
     *
     * ⚠️ 本 fork 裁剪后集合里只剩 **marvis** 一家：**有**真实 refresh 端点
     *    （`POST /marvis_client_login/marvis_refresh_token`，body 的
     *    `loginType` 恒 Marvis 这个字面量、不是 QC/WX 码）。
     *    ⚠️ 本注释**不得**出现带单引号的 Marvis 字面量 —— 对应的守卫会扫
     *    Set 体里的单引号字符串，注释里的引号会被当成一个 Set 成员（实测踩过）。
     *    ⚠️ 上游的 access_token **不变**、只重置有效期 ⇒ 续期必须把新的
     *    `expires_at` 写回池（否则调度器永不武装）。
     */
    const SELF_HEAL_REFRESHABLE_PROVIDERS = new Set([
        MARVIS.id,
    ]);
    /**
     * 自愈的**在飞去重**表（key = 账号 id）—— 同一账号的并发自愈共享同一次续期。
     *
     * ⚠️ **必须有**（对抗审计实测证实的真实缺陷）：本端点是**用户可反复触发**的
     * （客户端 `plugin-src/client/jet-hub.js` 的 `loadCredits` 有四个调用点：
     * 面板挂载、签到成功后、领取成功后、「刷新积分」按钮，且**没有重入闸门** ——
     * 对比 `claimCredits` 的 `claimInFlightRef`；按钮的 `disabled: creditsLoading`
     * 是异步 state，连点两次即并发）。宿主还有第二条独立入口：用量徽标每 60 秒
     * 轮询 `usageBadge.read` → 同一个 `handleMethod('credits.balances')`。
     *
     * 而**续期会轮换 refresh_token**（`AGENTS.md` 记过 codearts 那次「三条续期入口
     * 并发消费同一份 refresh_token，1 个成功、其余 invalid_grant」的事故），
     * 并发自愈存在「后写的把先写的新 token 覆盖成已失效旧 token」的风险。
     *
     * ⚠️ 本表只防**进程内、本入口**的并发。跨入口（定时器 `refreshAll`、按需续期）
     * 与跨进程的互斥由各家自己兜（codearts / gemini 有 per-ref `SerialQueue`，
     * 其余几家是既有状态，非本次引入）。
     */
    const balanceHealInFlight = new Map();
    /**
     * 自愈的续期分派：**复用 `account.refresh` 同一处查表**（{@link authOf}）。
     *
     * ⚠️ 2026-10-10（issue IKKHL5 合并 master）：本函数原先自己持一张
     * `provider → auth 实例` 的 switch。合并时发现 master 的 provider 抽象重构
     *（Task 2）已把 `account.refresh` 的那张 switch 收成 `authOf(auths, provider)`
     * ——**正是本函数当初想要的「分派只能有一份」**。故这里改为直接调它，
     * 而不是留两份平行实现（留两份就是本函数注释开头警告的那个缺陷本身）。
     *
     * ⚠️ 仍然**不含 `enabled` 判据**（AGENTS.md 铁律）：停用只影响自动选号。
     */
    const refreshAccountByProvider = async (provider, credentialRefName, accountId) => {
        const auth = authOf(auths, provider);
        // ⚠️ 抛错还是跳过由**调用方**决定：自愈侧先用
        // {@link SELF_HEAL_REFRESHABLE_PROVIDERS} 过滤，故走到这里为空说明
        // 「本以为是可续期的，实际没注册」—— 那是真异常，必须留痕。
        if (auth === undefined)
            throw new Error(`Unknown provider: ${provider}`);
        await auth.refreshAccountCredential(credentialRefName, pool, accountId);
    };
    /**
     * 积分查询前的**按需自愈**（Gitee issue IKKHL5 建议 C）。
     *
     * ## 缺陷
     *
     * 系统睡眠/挂起数小时后恢复，**宿主进程全程没退出**，于是
     * `state.json` 里的 `expiresAt`（= 上次续期时刻 + 令牌寿命）落在过去，
     * 而客户端判据只有一次本地比较（`plugin-src/client/jet-hub.js` 的
     * `account.expiresAt <= Date.now()`）⇒ 卡片显示红色「已过期 · 自动续期」；
     * `credits.balances` 又只 resolve 凭据后直连上游、**全程不续期**
     * ⇒ 积分行报「账户信息查询失败：HTTP 401」。该窗口内**没有任何手动
     * 自救手段**（「重测」的 refresh 是刻意 no-op）。
     *
     * ## 为什么这一层是对症的（而不是 issue 建议的 A：墙钟跳变检测）
     *
     * 实测（`NtSuspendProcess` 真实挂起 8 秒 = 等比 4 小时）：libuv 定时器基于
     * **单调时钟**，睡眠时长 > interval 时**恢复瞬间就补触发**一轮；所以
     * 「睡几小时」并不需要墙钟检测来抢救。真正的缺口是**恢复后的第一轮要等
     * 最多一个 interval**，而短寿命 provider（minimax 1h / codearts 2h /
     * raccoon 3h）在这个窗口里必然显示「已过期」。
     *
     * 本函数让**积分查询这个用户主动发起的动作**自带续期：不必等定时器，
     * 一次刷新面板就同时消灭「已过期」显示与 401。
     */
    const healExpiredAccountBeforeBalance = async (entry, 
    /** 「现在」的注入点（只供测试；见 {@link healExpiredAccounts} 的说明）。 */
    now = Date.now) => {
        // ⚠️ 判据与客户端**逐字一致**（同一个表达式），否则会出现「面板说没过期、
        // 这里却发续期请求」或反之的无谓请求。
        //
        // ⚠️ **`typeof` 检查不是冗余**（对抗审计实测的测试盲区）：`expiresAt` 可从
        // **用户可编辑的备份文件**导入，而 `sanitizeAccounts` **不过滤**该字段。
        // 池里若是数字字符串 `'1791559805000'`：保留 `typeof` → 不续期
        // （与客户端判据一致）；删掉 `typeof` 则被 JS 强制转换判为过期 →
        // 宿主与 UI **行为分叉**。
        const expired = typeof entry.expiresAt === 'number'
            && entry.expiresAt > 0
            && entry.expiresAt <= now();
        // ⚠️ **不判 `entry.refreshable`**（issue IKKHL5 建议 C 的原文写的是
        // 「已过期且 refreshable」）：那个布尔是**凭据材料的镜像**、可能被误标，
        // 而本插件已有一条铁律——误标过一次就永不自愈（见 AGENTS.md「账号池的
        // refreshable 只是凭据材料的镜像」）。各家 `refreshAccountCredential`
        // 内部自己按凭据材料判断能否续期（缺 refresh_token 时抛「请重新登录」），
        // 由它给出真终态；这里不预判。
        if (!expired)
            return;
        // ⚠️ **设计上没有续期能力的渠道静默跳过**（不抛错、不记日志）：
        // 用异常表达「跳过」会让每次刷新面板都留下一条误导性告警（loomy 的池内
        // `expiresAt` 是本地按 14 天推算的固定值，14 天后必然过期 ⇒ 确定可达）。
        // 详见 {@link SELF_HEAL_REFRESHABLE_PROVIDERS}。
        if (!SELF_HEAL_REFRESHABLE_PROVIDERS.has(entry.provider))
            return;
        // ⚠️ **在飞去重**：同一账号的并发自愈共享同一次续期请求。
        // 积分端点与领取端点都会被用户反复触发（连点「刷新积分」/「一键领取」、
        // 徽标每 60 秒轮询走同一条 `handleMethod`），而续期**会轮换 refresh_token**，
        // 并发会让「后写的把先写的新 token 覆盖成已失效的旧 token」。
        // 详见 {@link balanceHealInFlight}。
        const existing = balanceHealInFlight.get(entry.id);
        if (existing !== undefined) {
            await existing;
            return;
        }
        const task = (async () => {
            try {
                await refreshAccountByProvider(entry.provider, entry.credentialRef, entry.id);
            }
            catch (error) {
                // ⚠️ **绝不上抛**：续期失败不是「余额/领取失败」——凭据本来就已过期，
                // 直连上游必然 401，让整条积分行报「续期失败：…」反而比原来的
                // 「账户信息查询失败：HTTP 401」更难懂。照常往下走、由上游给出真原因。
                // ⚠️ 文案**刻意不写「余额」**：本函数已同时服务 `credits.balances`
                // 与 `credits.claimAll` 两个端点，「照常查余额」在领取路径上是错的。
                ctx.logger?.warn?.(`[jet-hub] 积分操作前的自愈续期失败（账号 ${entry.id}，照常继续）：`
                    + `${error instanceof Error ? error.message : String(error)}`);
            }
        })();
        balanceHealInFlight.set(entry.id, task);
        try {
            // ⚠️ **必须 `await`**：本函数的存在意义就是「**先续期、再查余额**」——
            // 不 await 就等于没修（对抗审计实测：改成 `void task` 后 12 条测试全绿，
            // 说明该顺序语义原先没有任何守护；现已由
            // `credits-balance-self-heal.spec.ts` 的「顺序」用例锁住）。
            await task;
        }
        finally {
            // ⚠️ 必须在 `finally` 里删除：续期失败时也要放行下一次自愈，
            // 否则一次失败会把该账号的自愈**永久焊死**（与 `SerialQueue` 的
            // 「失败也必须放行下一个」同一条教训）。
            // ⚠️ 只删自己这一条：并发时后来者读到的是同一个 task，删掉的也应是它
            //（用值比较而不是无条件 delete，避免把「后来者刚建的新 task」误删）。
            if (balanceHealInFlight.get(entry.id) === task) {
                balanceHealInFlight.delete(entry.id);
            }
        }
    };
    /**
     * 自愈的**整轮预算**（毫秒）。
     *
     * ⚠️ **必须有**（对抗审计实测的真实缺陷）：本自愈是**逐账号顺序 await，
     * 每个账号一个真实 HTTP 续期**，而各家 `AbortSignal.timeout` 是
     * 20~60 秒（codearts / buddy / raccoon 60s，lobsterai / qoder / trae /
     * cline / minimax 30s，gemini 20s）。池里 39 个账号全过期且全部超时时，
     * 最坏 **39 × 60s ≈ 39 分钟**，而这发生在**用户点一下就等**的
     * `credits.balances` / `credits.claimAll` 入口上（徽标还会每 60 秒轮询
     * 走同一个 `handleMethod`）。
     *
     * 原有的 `DEFAULT_ROUND_BUDGET_MS`（30 分钟）**管不到这里** —— 它只在
     * `collectClaimResults` 的成长任务路径（`afterClaim`）里被消费。
     * 若不设闸门，症状会从「积分行报 HTTP 401」**恶化成「整个端点超时、
     * 余额与领取结果一起丢」** —— 比原缺陷更糟。
     *
     * ⚠️ 语义与 `collectClaimResults` 的 `roundBudgetMs` 保持一致：
     * 到点后**停止继续自愈、但不失败**（余下账号留给下一轮/定时器），
     * 因为「没来得及续期」远好于「整个端点拿不到任何结果」。
     */
    const SELF_HEAL_ROUND_BUDGET_MS = 60_000;
    /**
     * 逐账号**顺序**执行自愈（供 `credits.balances` 与 `credits.claimAll` 共用）。
     *
     * ⚠️ **必须串行、不得改 `Promise.all`**（对抗审计实测的测试盲区：改成并行后
     * 测试全绿，而「顺序执行避免并发触发风控」是本端点的既有约定，见
     * `collectCreditBalances` 的注释；并发续期还有轮换 token 的覆盖风险）。
     * 由 `credits-balance-self-heal.spec.ts` 的**双账号**顺序用例锁住
     *（单账号时串行与并行不可区分 —— 那正是它当初漏掉的原因）。
     *
     * ⚠️ **受 {@link SELF_HEAL_ROUND_BUDGET_MS} 约束**：到点即停，余下账号
     * 交给下一轮（见该常量的说明 —— 不能让自愈把端点本身拖超时）。
     * ⚠️ 预算判据在**每个账号之前**检查：已经开始的续期不打断
     *（它有自己的 20~60 秒超时兜底），故实际耗时上界是
     * `预算 + 单个续期超时`，而不是「预算 + N × 超时」。
     */
    const healExpiredAccounts = async (accounts, 
    /**
     * 「现在」的注入点。⚠️ **只供测试**注入确定时刻 ——
     * 生产不传即用 `Date.now()`。
     *
     * 存在的理由（对抗审计实测的高危点）：`<=` 边界用例原先在自己体内取
     * `const now = Date.now()`，而 heal 内部**再调一次** `Date.now()`，
     * 两者跨毫秒才检出 ⇒ 实测单文件 20 次只有 **10 次**变红（50%），
     * 全量 CI 下 **0 检出**。注入 now 后边界判定变得确定。
     */
    now = Date.now) => {
        const deadlineAt = now() + SELF_HEAL_ROUND_BUDGET_MS;
        for (const entry of accounts) {
            // ⚠️ 到点即停、**不失败**：已开始的续期不打断（见函数注释）。
            if (now() >= deadlineAt) {
                ctx.logger?.warn?.(`[jet-hub] 自愈续期已达整轮预算（${SELF_HEAL_ROUND_BUDGET_MS}ms），`
                    + `本轮停止继续续期（余下账号交给下一轮/定时器）`);
                return;
            }
            await healExpiredAccountBeforeBalance(entry, now);
        }
    };
    /**
     * 收口「网页版登录用户已放弃」留下的 magicrew 占位条目。
     *
     * ## 为什么需要（与 OfficeAce 收口同因，但判据**不同**）
     *
     * 用户在宿主起的窗口里登到一半直接关掉窗口时：`login.poll` 会收到那一轮任务的
     * 终态（`waitForCredential` 看到浏览器已退出 ⇒ `undefined` ⇒ `failLogin` 删条目），
     * 所以**正常路径不需要本收口**。
     *
     * 本函数只兜**一种**残留：**宿主进程重启/崩溃**。那时
     * `magicrewBrowserLoginInFlight` / `magicrewBrowserLoginPendingAt` 是内存表、
     * 一起消失了，而池里的占位条目还在盘上 ⇒ 它会变成一张「凭据未配置」的幽灵卡片，
     * 没有任何入口会被清理（与 OfficeAce 那个 issue 的观感逐字相同）。
     *
     * ## 判据三条**必须同时**
     *
     * | # | 判据 | 漏掉的后果 |
     * |---|---|---|
     * | 1 | provider 属于**浏览器登录五家**（`magicrew` / `magicrewintl` / `monkeycode` / `monkeycodeintl` / `baizhi`，见下方 `if`）且**没有在途任务** | 把正在等用户的登录删掉（用户正常登录反而失败） |
     * | 2 | 中间态缺失**或**已超过 {@link MAGICREW_BROWSER_PENDING_TTL_MS} | 把刚开始的登录删掉（同 1） |
     * | 3 | 凭据**确实未落库** | 把刚登好的账号连凭据一起删掉（不可逆） |
     *
     * ⚠️ 判据 3 复用 `loginCredentialLanded`（**不另写一份**）：`'unknown'` 时同样
     * **不删** —— 不可逆的删除必须建立在**确证**上（这条取向在 OfficeAce 处有红队取证）。
     *
     * @param now 「现在」的注入点（**只供测试**；生产不传即 `Date.now()`）。
     *   边界用例必须能确定地驱动时刻，不能靠跨毫秒的运气（本仓库记过同型事故）。
     * @returns 被收口的账号 id 列表（供日志与用例观测）。
     */
    async function sweepAbandonedMagicrewBrowserLogins(now = Date.now) {
        const swept = [];
        let accounts;
        try {
            accounts = await pool.listAllAccounts();
        }
        catch {
            // 读不到池 ⇒ **什么都不做**（不可逆的删除不该建立在一次失败的读上）。
            return swept;
        }
        const at = now();
        for (const entry of accounts) {
            // ⚠️ 本 fork 裁剪后本收口只服务 **marvis**：它的 `account.create
            //    { mode:'browser' }` 分支同样登记 `magicrewBrowserLoginPendingAt`。
            //    漏这家 ⇒ 宿主崩溃/重启后那张「凭据未配置」的幽灵卡片**永不收口**，
            //    用户只能自己删号（且删除会连带清掉可能已写好的凭据）。
            if (entry.provider !== MARVIS.id)
                continue;
            // 判据 1：有在途任务 ⇒ 用户可能正在窗口里登录，绝不碰。
            if (magicrewBrowserLoginInFlight.has(entry.id))
                continue;
            const pendingAt = magicrewBrowserLoginPendingAt.get(entry.id);
            /**
             * 判据 2：**从未登记过中间态**（本进程从没起过它 ⇒ 重启残留）也走这里；
             * 登记过但还年轻 ⇒ 跳过（同进程里正在登录的那一轮）。
             *
             * ⚠️ 但「从未登记过」**不能**单独当成「已中止」的充分条件：`local-browser`
             * 分支建的账号同样不在表里。⇒ 必须靠判据 3 兜底（凭据在就不删）。
             * 而 `local-browser` 建的账号**恒有凭据**（它读到才建）⇒ 判据 3 会放行它。
             */
            if (pendingAt !== undefined && at - pendingAt <= MAGICREW_BROWSER_PENDING_TTL_MS)
                continue;
            const landed = await loginCredentialLanded(entry.id);
            if (landed === 'yes' || landed === 'unknown') {
                if (landed === 'unknown') {
                    ctx.logger?.warn?.(`[jet-hub] magicrew 收口跳过 ${entry.id}：读凭据失败（无法确证「没有凭据」）`
                        + ' ⇒ 不做不可逆的删除（宁可留一张卡片）');
                }
                continue;
            }
            try {
                await pool.removeAccount(entry.id);
                magicrewBrowserLoginPendingAt.delete(entry.id);
                swept.push(entry.id);
            }
            catch (error) {
                // ⚠️ 用 `entry.provider` 而非写死「magicrew」：本函数已覆盖五家，
                //    写死会让百智云 / 国际站的失败日志指向错的助手（三审 F🟢-3）。
                ctx.logger?.warn?.(`[jet-hub] ${entry.provider} 收口 ${entry.id} 失败：${String(error)}`);
            }
        }
        if (swept.length > 0) {
            ctx.logger?.info?.(
            // ⚠️ 不再写「超级麦吉」：五家都会走这条路径（三审 F🟢-3）。
            `[jet-hub] 已收口 ${swept.length} 个浏览器登录中止留下的占位账号：`
                + `${swept.join(', ')}（用户未完成登录即关闭窗口 / 宿主重启残留；这些条目没有凭据）`);
        }
        return swept;
    }
    /**
     * 登录**终态失败**记录（账号 id → `{ message, at }`；`message` 即下发给前端的原文）。
     *
     * ## 为什么必须有这张表（Gitee issue IKLI7J，真实缺陷）
     *
     * `login.poll` 原先**只有一条**终态通道：`done:true`，而它**只在成功时下发**。
     * 失败侧走的是「删掉占位条目」的清理路径 ⇒ 下一次轮询命中
     * `if (!entry) return {done:false}`，把
     * 「账号尚未登记（用户还没授权完）」与「登录已被拒绝并清理」**混成同一个返回**。
     * 前端只会判 `done`，于是**任何 provider 的登录失败都变成静默转圈 5 分钟**
     * （5 分钟是客户端自己的轮询上限，不是服务端超时），用户分不清是网络问题、
     * 账号未开通服务、自己关掉了弹窗，还是插件 bug。
     *
     * 实测代价（issue 附件）：OfficeAce 因「账号未订阅 ModelArts MaaS」失败时，
     * 云侧早已用 `HTTP 200 + subscription:null` 讲清原因，而用户只能看到转圈 ——
     * 报告方为此改宿主代码加文件日志才定位。
     *
     * ## 生命周期
     *
     * 写入：各 provider 后台登录失败后的收尾（统一走 `failLogin`，**不要**各自
     * 手写 `removeAccount` —— 漏一处就是「那一家失败时前端仍静默转圈」且完全无痕）。
     * 读取：`login.poll` **在查账号池之前**先查这里。顺序是刻意的：
     * `failLogin` 先同步记原因、再异步删条目，故「记录已写、条目未删」的窗口里
     * 也必须能报出终态。
     *
     * ⚠️ **读后不删**（与 `pendingOfficeAceState` 的一次性中间态不同）：终态原因
     * 要**幂等**——客户端 1 秒一次轮询、`setInterval` 的异步回调可能重叠，若
     * 「读到即清」，一次丢包/慢响应就把唯一次原因吃掉，又退回静默转圈。
     * 记录按**账号 id** 索引，而 id 由 `account.create` 每次新生成（`shortId()`），
     * 不存在「旧记录被下一次登录读到」的可能，故保留无害。过期与容量由
     * `LOGIN_FAILURE_TTL_MS` / `LOGIN_FAILURE_LIMIT` 兜住。
     */
    const loginFailures = new Map();
    /**
     * **超级麦吉网页版登录**的在途表（`accountId` → 那一轮等待的后台任务）。
     *
     * ## ⚠️⚠️ 为什么网页版登录必须走**两步式**（`account.create` 只开窗，`login.poll` 收尾）
     *
     * 它是全仓**唯一**「用户在**宿主起的那个**浏览器窗口里操作」的登录（其余各家的
     * 授权页在用户自己的浏览器里，所以宿主能在拿到 URL 后立刻返回）。而用户在窗口里
     * 扫码 / 输密码要 **2–5 分钟** —— 若在 `account.create` 里同步等：
     *
     * | # | 同步等的后果 |
     * |---|---|
     * | 1 | `account.create` 是**一条 RPC**，客户端与宿主各有超时/重试语义 ⇒ 分钟级挂住会被判成「网络失败」，用户看到「新建账号失败」而窗口还开着 —— **两边状态彻底错开** |
     * | 2 | 客户端 `createAccount` 的 `finally` 无条件释放 `creating` 闸门 ⇒ 按钮变可点 ⇒ 再点一次 = **两个浏览器窗口** + 两条登录腿抢同一个派生语义 |
     * | 3 | 与其余十余家的既有契约（先返回 `accountId` → `login.poll` 三态）不同形 ⇒ 前端要为它写第二套流程（而 `login.poll` 的三态修法 IKLI7J 刚刚才全部收口） |
     *
     * ⇒ 走既有两步式：本表存「那一轮等待的后台任务」，`login.poll` **单飞**地
     * `await` 它（与 `officeAceExchangeInFlight` **同一条纪律**：客户端 `setInterval`
     * 没有 in-flight 闸门，两拍重叠若各开一轮就会抢同一个 id / 各起一个浏览器）。
     *
     * ⚠️ **只在本进程内存里**（不落盘）：宿主重启后这张表空了 ⇒ `login.poll` 退化成
     * `{done:false}`、由客户端自己的 5 分钟表收口。可接受 —— 那时浏览器窗口也已随
     * 宿主进程树一起没了（`ChromiumSession` 的 `detached: false` / 进程组语义），
     * 而占位条目由 {@link sweepAbandonedMagicrewBrowserLogins} 按时间收口。
     */
    const magicrewBrowserLoginInFlight = new Map();
    /**
     * 网页版登录**等待中**的中间态（`accountId` → 开始时刻）。
     *
     * ⚠️ 与 `magicrewBrowserLoginInFlight` 分开存是刻意的：后者是「那一轮任务」、
     * 任务一结束就要 `delete`（否则表无界增长），而「这个账号是一个正在等用户的
     * 占位条目」这个**事实**必须比任务活得久一点 —— 任务结束（成功/失败）时两者
     * 一起清；只有 `account.list` 的收口需要它来判断「够老了吗」。
     */
    const magicrewBrowserLoginPendingAt = new Map();
    /**
     * 「登录成功但被判定为重复、占位条目已合并进旧卡」的重定向表（2026-11-02 二审 C🟡-2）。
     *
     * ## 为什么需要它
     *
     * 判重命中时后台任务会 `removeAccount(占位 id)`，把凭据写进旧卡。若这一步发生在
     * 客户端**首拍 `login.poll` 之前**（用户本来就在登录态，开窗即取到 cookie ⇒ 秒过），
     * 那么之后每一拍 poll 都会命中 `!entry` ⇒ 回 `{done:false}` ⇒ 前端一路转圈到
     * 客户端 5 分钟上限，而卡其实早已建好（与 IKLJ7J 同款「静默转圈」形态，只是触发
     * 条件更窄）。
     *
     * ⇒ 合并时记下「占位 id → 旧卡 id」，poll 首拍就能立刻回 `done:true` 并清掉记录。
     *
     * ⚠️ 只在 poll 命中时 `delete`，所以正常情况下每个占位 id 最多驻留一拍；
     *    用户中途关掉面板时残留的那条由 `sweepAbandonedMagicrewBrowserLogins` 按 TTL 清理。
     */
    const loginMergedRedirect = new Map();
    /**
     * `loginMergedRedirect` 的 TTL 与容量上限（2026-11-02 三审 F🟡-6）。
     *
     * ⚠️ 为什么必须有：这张表原来是**只增不减**的 —— 正常情况下 `login.poll`
     * 命中一次就 `delete`，但用户把面板一关、前端不再 poll，那条记录就永久驻留；
     * 每次「浏览器登录判重合并」都会再添一条 ⇒ 长期使用是缓慢的泄漏，
     * 而 `at` 字段写了却**零处读取**（写了不读 = 该字段没有存在理由）。
     * 对照 `loginFailures` 有 `LOGIN_FAILURE_TTL_MS = 30 * 60_000` → 这里取同一个 30 分钟。
     */
    const LOGIN_MERGED_REDIRECT_TTL_MS = 30 * 60_000;
    /** 容量护栏：即使有人在 30 分钟内刷出成百上千个占位条，也不让这张表无限长。 */
    const LOGIN_MERGED_REDIRECT_LIMIT = 200;
    /**
     * 记下「占位 id → 旧卡 id」的合并重定向，并顺带清掉过期/超限的记录。
     *
     * ⚠️ 调用方**不要**再直接 `loginMergedRedirect.set(...)` —— 直接 set 会绕过 TTL
     * 与上限，重现 F🟡-6 那个只增不减的形态。
     */
    function rememberLoginMergedRedirect(id, targetId) {
        const now = Date.now();
        for (const [key, value] of loginMergedRedirect) {
            if (now - value.at > LOGIN_MERGED_REDIRECT_TTL_MS)
                loginMergedRedirect.delete(key);
        }
        while (loginMergedRedirect.size >= LOGIN_MERGED_REDIRECT_LIMIT) {
            const oldest = loginMergedRedirect.keys().next();
            if (oldest.done === true)
                break;
            loginMergedRedirect.delete(oldest.value);
        }
        loginMergedRedirect.set(id, { targetId, at: now });
    }
    /**
     * 读一条未过期的合并重定向（过期即删）。
     *
     * ⚠️ 过期记录**必须**当不存在处理：`login.poll` 拿到一条三天前的记录会
     * 谎报 `done:true, success:true`，而那张旧卡可能早就被删了。
     */
    function takeFreshLoginMergedRedirect(id) {
        const entry = loginMergedRedirect.get(id);
        if (entry === undefined)
            return undefined;
        if (Date.now() - entry.at > LOGIN_MERGED_REDIRECT_TTL_MS) {
            loginMergedRedirect.delete(id);
            return undefined;
        }
        return entry;
    }
    /**
     * 网页版登录占位条目的**最短保留时长**（收口阈值）。
     *
     * 客户端自己的轮询上限是 5 分钟、宿主侧等待上限 4 分钟（
     * `MAGICREW_BROWSER_LOGIN_TIMEOUT_MS`）⇒ 取 **10 分钟**（2 倍余量）：
     * 只有「明显超过任何正常等待」的占位条目才收口。
     *
     * ⚠️ 与 OfficeAce 的 20 分钟刻意不同：本家没有「交换 code」那一步（凭据不需要
     * 再换一次），失败是立刻可见的（后台任务自己 `failLogin`），故收口只需要兜
     * 「宿主崩溃/重启」这一种残留。
     */
    const MAGICREW_BROWSER_PENDING_TTL_MS = 10 * 60_000;
    /** 终态失败记录的保留时长。客户端轮询上限是 5 分钟，留 6 倍余量。 */
    const LOGIN_FAILURE_TTL_MS = 30 * 60_000;
    /**
     * 条数上限（写入时按插入序淘汰最旧的）：挡住异常路径下的无界增长。
     *
     * ⚠️ 必须**远大于任何可能的「同时在轮询的登录数」**：淘汰会把一条**仍在被轮询**
     * 的失败记录挤掉 ⇒ 那条登录退回静默（只剩客户端超时文案兜底）。客户端同一时刻
     * 只允许一轮登录（`pollRef` 闸门），但 `login.poll` 可被外部脚本调用 ——
     * 独立审计实测「连做 65 次失败登录」即可触发 64 上限的淘汰。真正的内存边界
     * 是 `LOGIN_FAILURE_TTL_MS`（30 分钟），上限只是护栏。
     */
    const LOGIN_FAILURE_LIMIT = 256;
    /**
     * 归一化异常为可读文案。
     *
     * ⚠️ **必须显式挡 `undefined` / `null`**：`String(undefined)` 不报错，会拼出
     * 字面量 `"undefined"`（`docs/agent-notes/misc.md` §2 记过同型缺陷）——
     * 那会让用户看到「登录失败：undefined」这种零线索文案。
     */
    function loginReasonText(reason) {
        if (reason === undefined || reason === null)
            return '未知错误';
        const text = reason instanceof Error ? reason.message : String(reason);
        return text.trim().length > 0 ? text : '未知错误';
    }
    /**
     * 终端失败对用户可见的文案。
     *
     * ⚠️ **只此一处构造**：首次报出（各 provider 的失败收尾 / OfficeAce 的交换失败）
     * 与后续轮询读表，必须是**逐字相同**的一句话 —— 两处各写一份必然漂移，
     * 用户会看到「第一次说 A、再点一次说 B」。
     */
    function loginFailureMessage(reason) {
        const text = loginReasonText(reason);
        // ⚠️⚠️ **「请重新点击「+ 新建账号」」只在重试可能有意义时才加**（2026-10-20 用户报障）。
        //
        // 有一类失败的**出路在外部**：OfficeAce「尚未开通 ModelArts MaaS」⇒ 去**果办客户端**
        // 点开通并同意授权；AStudio 会话失效 ⇒ 去 **AStudio 桌面端**重新微信扫码。
        // 那些情形重新点「+ 新建账号」只会重走一遍授权、然后**再失败一次** ⇒ 那半句是
        // **假出路**：它把用户锚在一个永远不会成功的动作上，还把内层那句唯一有用的指路
        // 冲淡了（与 `docs/agent-notes/client-ui.md` 的 IKLBSH 同向：文案本身就是出路）。
        //
        // ⚠️ 判据是**抛错方打的标记**（`src/login-failure.ts`），**不是**匹配文案 ——
        //    后者一改就失效，且属本仓库明令的「一文件两套同义判据」形态。
        // ⚠️ fail-closed 方向：**未标记一律照旧加后缀** —— 误留后缀只是不精确，
        //    误删后缀会让用户不知道该做什么。
        if (loginNeedsExternalAction(reason))
            return `登录失败：${text}`;
        return `登录失败：${text}。请重新点击「+ 新建账号」。`;
    }
    /**
     * 记一条登录终态失败，并**返回**落库的文案（调用方可据此立即回终态，与后续轮询一致）。
     */
    function recordLoginFailure(accountId, reason) {
        const message = loginFailureMessage(reason);
        if (accountId.length > 0) {
            const now = Date.now();
            // ⚠️ **先 delete 再 set**：Map 的迭代序是**插入序**，覆盖已存在的 key
            //    不会把它移到末尾 —— 少了这一步，淘汰序会停在「第一次失败的时刻」。
            loginFailures.delete(accountId);
            loginFailures.set(accountId, { message, at: now });
            for (const [key, value] of loginFailures) {
                if (now - value.at > LOGIN_FAILURE_TTL_MS)
                    loginFailures.delete(key);
            }
            while (loginFailures.size > LOGIN_FAILURE_LIMIT) {
                const oldest = loginFailures.keys().next();
                if (oldest.done === true)
                    break;
                loginFailures.delete(oldest.value);
            }
        }
        return message;
    }
    /** 读某账号的终态失败文案（不过期就不删，见 `loginFailures` 的说明）。 */
    function loginFailureOf(accountId) {
        const record = loginFailures.get(accountId);
        if (record === undefined)
            return undefined;
        if (Date.now() - record.at > LOGIN_FAILURE_TTL_MS) {
            loginFailures.delete(accountId);
            return undefined;
        }
        return record.message;
    }
    /**
     * 该账号此刻的池内条目；**读不到时返回 `'unknown'`**（≠「没有这个账号」）。
     *
     * ⚠️ 为什么要区分「没有」与「读不到」：`failLogin` 会**删账号 + unset 凭据**，
     * 那是不可逆的。池实现抛错（或测试替身没实现 `findAccount`）时若被当成
     * 「账号不存在 / 没有凭据」，就会把一次**可能已经成功**的登录销毁 ——
     * 正是 `failLogin` 要防的事。⇒ 读不到时**不删**（宁可留一张卡片让用户自己删；
     * 反过来则无法恢复）。
     */
    function poolEntryOf(accountId) {
        try {
            const find = pool.findAccount;
            if (typeof find !== 'function')
                return 'unknown';
            return find.call(pool, accountId);
        }
        catch {
            return 'unknown';
        }
    }
    /**
     * 这次登录**是否已经真的成了**（该账号的凭据已落库）。
     *
     * ## 为什么失败收尾必须先问这一句（2026-10-14 两轮独立审计查出的**净回归**）
     *
     * 各 provider 后台 `.then` 里，**记账**（`pool.updateAccount` → `state.json` 落盘）
     * 排在**凭据落盘之后**；而 `AccountPool` 的落盘失败会**抛错**
     *（`account-pool.ts` 的 `writeAccounts` —— 本仓库自己记过「落盘抛错时账号
     * **已经是可用状态**」）。于是「登录其实成了、只是记账失败」会走进 `.catch`
     * ⇒ `failLogin` ⇒ **删号 + 报「登录失败」**，用户被误导去重新登录
     *（同一个上游账号会变成两条）。红队实测：codearts 一支在 `credentials.set`
     * 之后让 `updateAccount` 抛错，修前回 `success:true`，改后回 `success:false`
     * 而账号与凭据其实都在。
     *
     * ⇒ 判据：**凭据在 ⇒ 这次登录就是成了**。`failLogin` 据此把「登录真的失败」与
     * 「登录成功后的记账失败」分开（后者只记日志，不删号、不报失败）。
     *
     * ⚠️ 这个判据**只此一处实现**：OfficeAce 那条一度另写了一份同义判据 ——
     * 一个文件两套同义判据必然漂移（`docs/agent-notes/misc.md` §1）。
     *
     * ## ⚠️⚠️ 返回 `'unknown'` 的那一格是**为了不误删**（2026-10-17 红队打穿的 P0）
     *
     * 本函数原先只有一个 `boolean`：**读凭据失败**（`resolve` 抛错 / 后端抖动）与
     * **确证没有凭据**都返回 `false` ⇒ 调用方把「读不到」当成「没有」。
     * 对 `failLogin` 那类"删号"收尾，这会**误删健康账号**；对
     * `sweepAbandonedOfficeAceLogins` 更糟 —— 它是**静默的定时收口**，
     * 红队探针实测：凭据**确实在**库里但 `resolve` 抛错 ⇒ 账号被删、凭据被 unset
     *（不可逆，且用户没有任何提示）。
     *
     * ⇒ 三态（与 `poolEntryOf` 的 `'unknown'` **同一取向**：读不到 ≠ 没有）：
     * - `'yes'`：**确证**凭据在；
     * - `'no'`：**确证**读完所有候选 ref 都没有凭据；
     * - `'unknown'`：**中途读失败** ⇒ 无法确证 ⇒ 调用方**不得**据此做不可逆操作。
     *
     * ⚠️ 只有「一次都没读失败」才允许回 `'no'`：候选 ref 有多个（entry + pending），
     *    其中一个成功读到「没有」、另一个读失败时，仍是 `'unknown'`
     *   （"确证"必须是全部确证）。
     */
    async function loginCredentialLanded(accountId) {
        const refs = new Set();
        const entry = poolEntryOf(accountId);
        /**
         * ⚠️⚠️ **`'unknown'`（读不到池）必须直接判「无法确证」**（2026-10-17 独立审计打穿的 **P0-3**）。
         *
         * 原先只是「不把它加进 `refs`」，于是 `refs` 可能**一个都没有** ⇒ 下面的循环
         * 一次都不跑 ⇒ `readFailed` 保持 `false` ⇒ 返回 `'no'`（=「确证没有凭据」）
         * ⇒ 收口走 `removeAccount`（连带 `unset`，不可逆）。
         *
         * ⚠️ 这与本文件 `poolEntryOf` 自己的契约**直接矛盾**（它的注释逐字写着
         * 「读不到时不删（宁可留一张卡片）」），也与 `failLogin` 里**单独**处理
         * `entry === 'unknown'` 的做法自相矛盾 —— 同一文件两套取向。
         *
         * ⇒ 判据：**一次凭据都没能读**（池读不到 ⇒ 连该查哪个 ref 都不知道）
         *    就不是「确证没有」，而是「无法确证」。这与 `'no'` 的语义必须分开。
         */
        if (entry === 'unknown')
            return 'unknown';
        if (entry !== undefined)
            refs.add(entry.credentialRef);
        let readFailed = false;
        for (const name of refs) {
            if (name.length === 0)
                continue;
            const resolved = await ctx.credentials.resolve(credentialRef(name)).catch(() => {
                // ⚠️ **不要**把失败并进 `undefined`（那样就退化成"没有凭据"）。
                readFailed = true;
                return undefined;
            });
            if (resolved !== undefined && resolved.value.length > 0)
                return 'yes';
        }
        return readFailed ? 'unknown' : 'no';
    }
    /**
     * 登录失败的**统一收尾**：先判「其实是否已经成功」→ 真失败才记终态 + 删占位条目。
     *
     * 十余处 provider 后台 `.catch()` 都走这里，**不要各自手写两行** ——
     * 漏接的那一家会继续静默转圈（计数断言锁死接线），而「失败不留幽灵账号」
     * 这条腿也**只由这里**保证（除 raccoon 外没有任何行为用例覆盖它）。
     *
     * @returns 需要报给前端的失败文案；**`undefined` = 这次登录其实已经成功**
     *（凭据已落库，只是后续记账失败）—— 调用方**不得**把它当作失败。
     */
    async function failLogin(accountId, error) {
        const landed = await loginCredentialLanded(accountId);
        if (landed === 'yes') {
            ctx.logger.warn(`[jet-hub] ${accountId} 登录已拿到凭据、后续记账失败（按成功处理：不记失败、不删账号）：`
                + `${loginReasonText(error)}`);
            return undefined;
        }
        const entry = poolEntryOf(accountId);
        if (entry === 'unknown' || landed === 'unknown') {
            // 读不到池 / 读不到凭据库（实现抛错 / 替身缺方法）：**不当成失败去删**（不可逆）。
            ctx.logger.warn(`[jet-hub] ${accountId} 登录收尾时读不到${entry === 'unknown' ? '账号池' : '凭据库'}，`
                + `已记终态但**不删账号**（宁可留卡片）：${loginReasonText(error)}`);
            return recordLoginFailure(accountId, error);
        }
        // 条目已被（用户）删除：不要把内部错误串（`Account xxx not found`）丢给用户。
        if (entry === undefined) {
            return recordLoginFailure(accountId, new Error('该账号条目已被删除（可能是你手动删掉了它）'));
        }
        const message = recordLoginFailure(accountId, error);
        void pool.removeAccount(accountId).catch(() => { });
        return message;
    }
    /**
     * 用量徽标的显示偏好（`$DSH_HOME/jet-hub/ui-preferences.json`）。
     *
     * ⚠️ 与账号池**分开**的独立文档：`state.json` 是整体替换语义，同机另一条工作区
     * 里的旧版本代码整体重写它时不会带上不认识的键 —— 理由与后果见
     * `badge-preferences.ts` 的文件头。
     */
    const badgePreferences = createBadgePreferenceStore(ctx);
    /**
     * 「每日首次启动自动签到」（独立文档 `auto-checkin.json`）。
     *
     * ⚠️ **不维护第二份「哪些渠道能签到」的名单**：判据交给下面的 `claim` ——
     * `credits.claimAll` 对不支持的渠道会**不发上游请求**就返回明确错误，本执行体
     * 把它计为「跳过」。客户端的能力表（`credits-capabilities.js`）仍是唯一权威。
     *
     * ⚠️ 「有账号的渠道」由账号池派生（`pool.listAllAccounts()` 只是同步内存副本
     * 的异步外壳），不遍历**没有账号**的那些渠道 —— 那些调下去只会拿到空结果。
     */
    const autoCheckin = createAutoCheckin({
        store: createAutoCheckinStore(ctx),
        listProviderIds: async () => {
            const accounts = await pool.listAllAccounts();
            return [...new Set(accounts.map((entry) => entry.provider))].sort();
        },
        claim: (provider) => handleMethod('credits.claimAll', { provider }).then((result) => {
            // ⚠️ 自动签到路径**绕过**了 RPC 请求入口那处清理（它直接调 `handleMethod`）
            //    ⇒ 必须在这里也清一次，否则「启动时自动签到成功 → 用户马上用 auto」
            //    仍会撞上缓存里的 `UNUSABLE`（见 `ModelCatalogSource.clearExpiryCache`）。
            modelAdapters?.['aggregate']?.clearExpiryCache?.();
            return result;
        }),
        warn: (message) => ctx.logger?.warn?.(message),
    });
    // 启动时排定一轮（延迟 30s；内部自己判开关与「今天是否已跑」）。
    autoCheckin.start();
    /**
     * ⚠️ `ctx.effect` 必须**可选调用**：本文件此前没用过它，而大量单测的 ctx 桩是
     * 最小化的（没有 `effect`）—— 直接调用会让 138 条无关用例报
     * `ctx.effect is not a function`（2026-10-02 实测到）。真实宿主里它一定存在，
     * 故这里的降级只影响桩环境，不影响生产环境的清理语义。
     */
    ctx.effect?.(() => () => autoCheckin.stop(), 'jet-hub: auto checkin');
    /**
     * 用量徽标读数服务（宿主侧 TTL 缓存 + 只保留启用账号 + 附加订阅读数）。
     *
     * ⚠️ **取数直接复用内部 `handleMethod`**，不另写 provider 分派：
     * `credits.balances` 的分派（Task 3 后是 `credits` 表查表 + opencode / qoder
     * 两个特例；此前是 12 段 `if`）是唯一口径 —— 含 codearts 的
     * 「Token 计费账户」文案、zcode 的逐桶折算等，复制一份必然漂移。
     * 第三个参数是 `AbortSignal` 且在当前实现里未被使用，故这里传 `undefined`
     *（该形参是下划线命名 = 有意未用）。
     *
     * ⚠️ 订阅窗口**只对 Cline** 存在（能力矩阵里的 `subscriptionQuota`）—— 这个
     * 「哪个渠道有窗口」的判断留在装配层，`usage-badge.ts` 因此不认识任何具体渠道。
     */
    const usageBadge = createUsageBadge({
        // ⚠️ `accountIds` 原样透传（2026-10-15，规格 §7-8）：徽标只要启用账号的读数。
        //    ⚠️ **省略时不得传 `undefined` 之外的键**：端点以「键存在与否」区分
        //    「查全部」与「查空集」—— `accountIds: undefined` 会被 JSON 丢掉，
        //    故两种写法在这里等价（但显式展开更安全，见下面那行）。
        collectBalances: (provider, accountIds) => handleMethod('credits.balances', {
            provider,
            ...accountIds === undefined ? {} : { accountIds: [...accountIds] },
        }),
        // ⚠️ 原 `collectQuota`（Cline 订阅额度窗口）随 Cline 裁剪删除 —— 本 fork
        //    没有提供订阅读数的供应商，徽标只展示余额。
        listAccounts: (provider) => pool.listAccountsByProvider(provider),
        readPreference: () => badgePreferences.load(),
        readAutoCheckin: () => autoCheckin.state(),
        warn: (message) => ctx.logger?.warn?.(message),
    });
    connection.fetch.register({
        path: JET_HUB_API_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
            if (request.method !== 'POST') {
                return new Response('method not allowed', { status: 405 });
            }
            const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
            if (contentType !== 'application/json') {
                return new Response('content type must be application/json', { status: 415 });
            }
            let message;
            try {
                message = await request.json();
            }
            catch {
                return new Response('body is not JSON', { status: 400 });
            }
            const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request';
            const call = message.payload;
            if (message.type !== 'client-request' || typeof message.rpcId !== 'string'
                || message.method !== JET_HUB_ENDPOINT
                || !call || typeof call.method !== 'string'
                || !Object.prototype.hasOwnProperty.call(call, 'payload')) {
                return reply(rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'Invalid Jet Hub management request.' } });
            }
            try {
                const result = await handleMethod(call.method, call.payload, request.signal);
                // ⚠️ 领取成功后清**临期折算缓存**（见 `ModelCatalogSource.clearExpiryCache`
                //    的长注释）：zcode 的每日额度要先领取才进 `balances` 桶，而「余额为 0」
                //    现在会被折算成 `UNUSABLE` 并被缓存 60 秒 ⇒ 不清就会让用户「签到成功了，
                //    但 60 秒内 auto 仍说没有可用候选」。
                if (call.method === 'credits.claimAll') {
                    modelAdapters?.['aggregate']?.clearExpiryCache?.();
                }
                return reply(rpcId, result);
            }
            catch (error) {
                // 必须返回规范的 RPC 错误响应（而不是裸 500 文本），
                // 否则客户端 unwrapRpcResult 无法识别错误，表现为"点击无反应"。
                const message = error instanceof Error ? error.message : String(error);
                ctx.logger.warn(`[jet-hub] ${String(call.method)} failed: ${message}`);
                return reply(rpcId, {
                    ok: false,
                    error: {
                        // ⚠️ **保留底层错误码**（2026-11-05 四审契约 P2-2）：
                        // `EACCES`（改权限）/ `ENOENT`（文件不在）/ `EISDIR` /
                        // `SyntaxError`（文档损坏）的用户动作**完全不同**，全塌成
                        // `handler-failed` 会让客户端无法分支处理，也只能给出「未知故障」。
                        // ⚠️ 客户端目前对 `handler-failed` **零分支**（`grep` 只命中本仓
                        // src 的注释）⇒ 这是纯增量，不会破坏既有契约。
                        code: error?.code ?? 'jet-hub/handler-failed',
                        message,
                    },
                });
            }
        },
    });
    /**
     * 给 `account.list` 的返回项补上**只存在于凭据里**的展示字段（账号名 / 手机号）。
     *
     * ⚠️ 本 fork 裁剪后没有需要补字段的供应商（原 zcode / modelscope / qiniu /
     * monkeycode / baizhi 的打码与身份补全分支随裁剪删除）⇒ 原样透传，
     * 返回形状保持不变。
     */
    async function enrichAccountIdentity(accounts, provider) {
        return [...accounts];
    }
    /**
     * 分发端点方法到对应的处理器。
     *
     * ⚠️ 本 fork 裁剪后**没有任何前缀改道分支**（原 opencode / gemini / qoder /
     * minimaxintl / modelscope / qiniu / monkeycode / baizhi 的前缀入口随供应商
     * 裁剪一并删除）—— 所有方法都直接落进下面的主 `switch`。
     */
    async function handleMethod(method, payload, _signal) {
        switch (method) {
            case 'account.list': {
                const req = payload;
                // ⚠️ **先收口「登录中止」的 OfficeAce 占位条目**（Gitee issue IKM741 修法 A）：
                //    用户打开授权页却没完成授权就关掉时，占位条目会永久残留成一张
                //    「凭据未配置」的幽灵卡片（用户可以看见、却没有任何入口清理它，
                //    issue 原话「还要手动删一次」）。判据与安全闸见
                //    `sweepAbandonedOfficeAceLogins`。
                //
                // ⚠️ 放在 `pool.listAccounts` **之前**是刻意的：这里要读的是「收口后」的
                //    列表 —— 否则用户刷新一次仍会看到那张刚被删掉的卡片（观感是「没生效」，
                //    必须再刷新一次）。
                // ⚠️ 本 fork 裁剪后只在**会走浏览器登录的 provider**（= marvis）上跑，
                //    判据与 sweep 内部一致（见 `sweepAbandonedMagicrewBrowserLogins`）。
                if (req.provider === MARVIS.id) {
                    await sweepAbandonedMagicrewBrowserLogins();
                }
                const accounts = await pool.listAccounts(req.provider);
                return { ok: true, value: { accounts: await enrichAccountIdentity(accounts, req.provider) } };
            }
            case 'account.create': {
                const req = payload;
                const { provider } = req;
                const id = `${provider}-${shortId()}`;
                const suffix = shortId().toUpperCase();
                const refName = `${provider.toUpperCase()}_ACCOUNT_${suffix}`;
                /**
                 * ## 腾讯 Marvis（2026-11-09）
                 *
                 * 两条登录路径，按 `req.mode` 分流：
                 *
                 * | mode | 形态 | 时长 | 失败形态 |
                 * |---|---|---|---|
                 * | `'browser'` | 开隔离浏览器 → QQ / 微信 授权 → 回调带 `code` → 兑换 | 分钟级（等用户） | 先建占位条目，`login.poll` 报终态并**删掉**它 |
                 * | `'magpie-import'` | **宿主自己读**本机 magpie 的 `plugin-auth.json`（凭据已含 access/refresh/openid/guid） | 毫秒级（无上游请求） | 立刻回可读错误、**不建账号** |
                 *
                 * ⚠️ 判重按 **`openid`**（不是 `access_token`）：Marvis 续期**不换**
                 *    access_token 只重置有效期，但重登会签发新的 ⇒ 用 token 判重会
                 *    「每登一次多一张卡」（`src/account-pool.ts` 里 AutoClaw 的同型事故）。
                 * ⚠️ `guid` 每次登录都**新造**（token 与设备绑定，用本机 svid 会让多个
                 *    账号互相顶号）⇒ 它绝不能当身份判据。
                 */
                if (provider === MARVIS.id && req.mode === 'magpie-import') {
                    /**
                     * ## 为什么默认由**宿主**去读文件
                     *
                     * 2026-11-09 用户报障：弹窗里放 textarea 让用户自己打开
                     * `~/.config/magpie/plugin-auth.json` 抄一段 JSON —— 而这个文件就在
                     * 本机、插件自己就能读。把「找文件 + 精确复制」外包给用户没有任何收益，
                     * 只会多出「漏一个括号就报凭据不完整」的失败面。
                     *
                     * `req.magpieCredential` 仍然接受（自动化脚本 / 老客户端），但**空串与
                     * 缺省都当作「没给」**⇒ 走文件读取。判据必须是 `trim() !== ''`：
                     * 客户端如果发来空串（表单没填就点了按钮），不能把它当成「用户提供了
                     * 一段空 JSON」而报解析失败 —— 那样用户看到的原因是错的。
                     */
                    const pasted = typeof req.magpieCredential === 'string' ? req.magpieCredential.trim() : '';
                    const imported = pasted === ''
                        ? auths.marvis.readMagpieCredential()
                        : (() => {
                            const credential = importCredentialFromMagpie(pasted);
                            return credential === undefined
                                ? { error: '没有从粘贴内容里读到 Marvis 凭据：需要 access / refresh / metadata.openid / metadata.guid 四个字段。' }
                                : { credential };
                        })();
                    if ('error' in imported) {
                        // ⚠️ 读不到 ⇒ **不建账号**（占位条目只会变成幽灵卡片）。
                        //
                        // ⚠️⚠️ `error` **必须是对象**（`{code,message}`），不能是字符串：
                        //     `reply()` 会用 `{...result.error, details:{}}` 归一化，而展开
                        //     一个字符串得到的是 `{"0":"没","1":"有",…}` ⇒ 客户端拿不到
                        //     `code`/`message`，直接抛
                        //     `connection: invalid server-response failure`（2026-11-09 真机
                        //     报障：弹窗里只有这一句，用户看不出是「文件没读到」）。
                        return { ok: false, error: { code: 'bad-request', message: imported.error } };
                    }
                    const credential = imported.credential;
                    // ⚠️ 顺序：先写凭据、再建/改账号（与 magicrew 的 local-browser 分支同款）。
                    const existing = await findMarvisAccountByOpenid({
                        ctx,
                        pool,
                        openid: credential.openid,
                        skipAccountId: id,
                    });
                    if (existing !== undefined) {
                        await ctx.credentials.set(credentialRef(existing.credentialRef), JSON.stringify(credential));
                        await pool.updateAccount(existing.id, {
                            nickname: marvisAccountLabel(credential.nickname, credential.login_type),
                            ...marvisExpiresAtPatch(credential),
                        });
                        return { ok: true, value: { accountId: existing.id, loginUrl: '', reused: true } };
                    }
                    await ctx.credentials.set(credentialRef(refName), JSON.stringify(credential));
                    await pool.addAccount({
                        id,
                        provider: MARVIS.id,
                        nickname: marvisAccountLabel(credential.nickname, credential.login_type),
                        enabled: true,
                        credentialRef: refName,
                        refreshable: true,
                        createdAt: Date.now(),
                        ...marvisExpiresAtPatch(credential),
                    });
                    return { ok: true, value: { accountId: id, loginUrl: '' } };
                }
                if (provider === MARVIS.id && req.mode === 'browser') {
                    /**
                     * ① 占位条目：**先登记再开窗**。顺序不可颠倒 —— `login.poll` 在这之后
                     *    任何一刻到达都必须能查到它（客户端 1 秒一拍，而开浏览器要几百毫秒）。
                     */
                    await pool.addAccount({
                        id,
                        provider: MARVIS.id,
                        nickname: id,
                        enabled: true,
                        credentialRef: refName,
                        refreshable: true,
                        createdAt: Date.now(),
                    });
                    magicrewBrowserLoginPendingAt.set(id, Date.now());
                    /** 登录渠道：缺省 QQ（`'1'`），`'2'` = 微信。 */
                    const loginType = req.marvisLoginType === '2' ? '2' : '1';
                    /**
                     * ② 后台任务（**不 await**）：开窗 → 等用户扫码/点授权 → 截获回调 →
                     *    兑换凭据 → 落库。与 magicrew / monkeycode 同一条纪律。
                     */
                    const task = (async () => {
                        let credential;
                        try {
                            credential = await auths.marvis.loginViaBrowser(loginType);
                        }
                        catch (error) {
                            // 抛错 = 真失败（浏览器起不来 / 兑换被拒）。文案原样交给 `failLogin`。
                            const message = await failLogin(id, error);
                            return message === undefined
                                ? { done: true, success: true }
                                : { done: true, success: false, error: message };
                        }
                        if (credential === undefined) {
                            // `undefined` = 用户没登完（超时 / 关窗）。仍是**终态**：
                            // 占位条目留着就是幽灵卡片（IKLI7J 的形态）⇒ 同样走 `failLogin`。
                            const message = await failLogin(id, new Error('网页登录未完成（超时或窗口已关闭）'));
                            return message === undefined
                                ? { done: true, success: true }
                                : { done: true, success: false, error: message };
                        }
                        // 这一步之后凭据已在库里 ⇒ 任何失败都**不得**再删号（`failLogin` 自己会判）。
                        const existing = await findMarvisAccountByOpenid({
                            ctx,
                            pool,
                            openid: credential.openid,
                            skipAccountId: id,
                        });
                        if (existing !== undefined) {
                            /**
                             * ⚠️⚠️ **必须**先记合并重定向（2026-11-09 评审 C1，IKLI7J 同型）。
                             *
                             * 本分支会删掉自己的占位条目 ⇒ `login.poll` 的四道出口全部落空：
                             * `loginFailureOf`(undefined) → `accounts.find`(占位已删) →
                             * `takeFreshLoginMergedRedirect`(从没记过) →
                             * `magicrewBrowserLoginInFlight.has`(任务已结束) ⇒ 永远
                             * `{done:false}`。用户看到的是「授权成功、账号也建好了，弹窗却转
                             * 5 分钟圈然后报超时」，且该路径不 `loadAccounts()` ⇒ 卡片不刷新。
                             *
                             * 这是**主路径**：`findMarvisAccountByOpenid` 按 openid 判重，
                             * 同一账号第二次登录必然命中本分支。
                             */
                            rememberLoginMergedRedirect(id, existing.id);
                            /**
                             * ⚠️ **顺序不能反：先删自己的占位，再写旧卡的凭据**（2026-11-02 二审自纠）。
                             *
                             * `account-pool.removeAccount` 内部会 `credentials.unset(自己条目的 ref)`。
                             * 正常情况两张卡的 ref 由不同的 Key 派生、不会相同；但**万一相同**
                             * （上游哪天改成复用同一把 Key），先写后删就会把刚写进旧卡的那份凭据
                             * 一起清掉 —— 表现为旧卡突然「凭据未配置」，且没有任何错误日志。
                             * 反过来先删，最坏只是旧卡没写成、占位已消失，用户重登一次即可。
                             */
                            await pool.removeAccount(id).catch(() => undefined);
                            await ctx.credentials.set(credentialRef(existing.credentialRef), JSON.stringify(credential));
                            await pool.updateAccount(existing.id, {
                                nickname: marvisAccountLabel(credential.nickname, credential.login_type),
                                ...marvisExpiresAtPatch(credential),
                            });
                            return { done: true, success: true };
                        }
                        await ctx.credentials.set(credentialRef(refName), JSON.stringify(credential));
                        await pool.updateAccount(id, {
                            nickname: marvisAccountLabel(credential.nickname, credential.login_type),
                            ...marvisExpiresAtPatch(credential),
                        });
                        return { done: true, success: true };
                    })();
                    magicrewBrowserLoginInFlight.set(id, task);
                    /**
                     * ③ 任务结束后**必须**清两张表（`finally` 而不是 `.then`）：否则一次失败
                     *    就把这个 id 永久钉在表里（表无界增长、同一 id 再也开不了新一轮）。
                     */
                    void (async () => {
                        try {
                            await task;
                        }
                        catch {
                            // 不该发生：上面两个分支都把异常收成了返回值。仍要兜住 ——
                            // 一次未捕获拒绝会跳过下面的清理。
                        }
                        magicrewBrowserLoginInFlight.delete(id);
                        magicrewBrowserLoginPendingAt.delete(id);
                    })();
                    return { ok: true, value: { accountId: id, loginUrl: '' } };
                }
                else {
                    return { ok: false, error: { code: 'bad-request', message: `unknown provider: ${provider}` } };
                }
            }
            case 'account.update': {
                const req = payload;
                /**
                 * ⚠️⚠️ **patch 必须白名单化**（2026-10-25 合并审计 P2 修法）。
                 *
                 * `RpcUpdateAccountRequest.patch` 在**类型**上只有
                 * `nickname / enabled / expiresAt / refreshable` 四个键，但它是**无 schema
                 * 校验的客户端载荷**：`{qoderProxy:'ftp://host:21'}` 会被
                 * `AccountPool.updateAccount` 的 `{...entry, ...patch}` **原样展开进池**
                 * ⇒ 绕过 `sanitizeAccounts` 的代理 scheme 闸 ⇒ 该账号此后取 fetcher 恒抛
                 * 「代理地址无效」（实测：`AFTER-UPDATE qoderProxyFor = "ftp://host:21"`）。
                 *
                 * ⇒ 只放行那四个键。多余键**丢字段而不是丢请求**（删一个字段可逆，
                 * 删一条账号不可逆），并留一条 warn 便于发现 UI 打错。
                 */
                const allowed = ['nickname', 'enabled', 'expiresAt', 'refreshable'];
                const safePatch = {};
                for (const key of allowed) {
                    const value = req.patch?.[key];
                    if (value !== undefined)
                        safePatch[key] = value;
                }
                const dropped = Object.keys((req.patch ?? {}))
                    .filter((key) => !allowed.includes(key));
                if (dropped.length > 0) {
                    ctx.logger.warn(`[jet-hub] account.update 收到不支持的字段，已忽略：${dropped.join(', ')}`
                        + '（这类字段必须走各自专用端点，否则会绕过写入闸门）');
                }
                await pool.updateAccount(req.accountId, safePatch);
                return { ok: true, value: undefined };
            }
            case 'account.delete': {
                const req = payload;
                await pool.removeAccount(req.accountId);
                return { ok: true, value: undefined };
            }
            // 拖拽排序：重写该 provider 账号在池中的顺序。
            // 该顺序是自动选号与限流换号的候选优先级，因此不是纯 UI 操作。
            case 'account.reorder': {
                const req = payload;
                if (typeof req.provider !== 'string' || req.provider.length === 0) {
                    return { ok: false, error: { code: 'bad-request', message: 'provider 必填' } };
                }
                if (!Array.isArray(req.orderedIds) || req.orderedIds.some(id => typeof id !== 'string')) {
                    return { ok: false, error: { code: 'bad-request', message: 'orderedIds 必须是字符串数组' } };
                }
                try {
                    await pool.reorderAccounts(req.provider, req.orderedIds);
                }
                catch (error) {
                    // 集合不一致（前端列表过期）是可预期的并发情况，回可读错误让用户
                    // 刷新重试，而不是抛成 jet-hub/handler-failed 那种「未知故障」。
                    return {
                        ok: false,
                        error: {
                            code: 'bad-request',
                            message: error instanceof Error ? error.message : String(error),
                        },
                    };
                }
                return { ok: true, value: undefined };
            }
            case 'account.refresh': {
                const req = payload;
                try {
                    const accounts = await pool.listAllAccounts();
                    const entry = accounts.find((a) => a.id === req.accountId);
                    if (!entry)
                        throw new Error(`Account ${req.accountId} not found`);
                    // 按 **entry.provider** 查 `auths` 命名对象分派，并调用**按凭据 ref 的**
                    // 续期入口 —— 三处都是修复既有缺陷的关键：
                    //
                    // 1. 原实现只处理 codearts / buddy，`workbuddy` 会落到 else 抛
                    //    `Unknown provider` —— 即 `account.refresh` 端点**对 WorkBuddy 完全不可用**；
                    // 2. 原实现调的是 `service.refresh()`，它读写的是该 provider 的
                    //    **默认单凭据 ref**（如 BUDDY_ACCESS_TOKEN），而要刷的是池内条目的
                    //    BUDDY_ACCOUNT_XXX —— 于是「刷这个账号」实际刷的是另一个凭据，
                    //    结果要么报错要么静默改了错的对象。
                    // 3. ⚠️ **分派必须传 `pool` + `entry.id`**（issue !IKIRTT）：
                    //    续期成功后要把新的 `expiresAt` 写回账号池，UI 才不再显示
                    //    「已过期」。早先只有 raccoon 分支传了，其余七个分支漏传，
                    //    凭据续好了、界面纹丝不动，用户没有任何自救手段。
                    //
                    // ⚠⚠ **本端点没有面板入口**（issue IKJOZA 取证）：账号卡片上并没有
                    // 「刷新」按钮（按钮是 测试/重测/重置/停用/代理/指纹/删除），
                    // 调用方是仓库外的脚本/手工 RPC。下面三处历史注释曾把它写成
                    // 「账号卡片的刷新按钮」——那是失实的，会把排障的人引到不存在的 UI。
                    //
                    // ⚠️ 2026-10-08 改（Task 2）：原先这里是一个 13 个 case 的 switch，
                    // 而**每个分支体都是同一行调用**（`auth.refreshAccountCredential(
                    // entry.credentialRef, pool, entry.id)`），只有实例名不同 —— 纯粹重复，
                    // 且历史上漏接过 `workbuddy`（它对 `account.refresh` 一直报
                    // `Unknown provider`）。分支越多，漏接概率越高。
                    //
                    // ⚠️ **查 `auths` 形参，不查全局注册表**（`provider-runtime.ts`）：
                    //    `auths` 是 Task 9 引入的命名对象，其**键就是 provider id**
                    //    （含 `qodercn`，注意不是变量名 `qoderCn`）。用形参而非全局 Map
                    //    的三个好处：① 测试仍可**直接传桩**控制分派（零全局可变状态）；
                    //    ② 不会与「真跑 apply()」的测试互相污染；③ 闭包捕获的是**本次注册
                    //    的那批实例**，语义上更紧。全局注册表留给**真正跨模块**的消费点
                    //    （Task 5 的 aggregate-expiry、Task 8 的 account-probe）。
                    const auth = authOf(auths, entry.provider);
                    if (auth === undefined) {
                        // ⚠️ 文案必须保持**可读且指明原因**，不要退化成泛化的 unsupported：
                        //    opencode 是「该产品没有续期概念」（凭据是静态 API key），
                        //    而未知 id 是「没注册」。两者都要让排查者看懂。
                        throw new Error(descriptorOf(entry.provider) === undefined
                            ? `Unknown provider: ${entry.provider}`
                            : `Provider ${entry.provider} 不支持续期（它的凭据不是可续期类型）`);
                    }
                    await auth.refreshAccountCredential(entry.credentialRef, pool, entry.id);
                    return { ok: true, value: { success: true } };
                }
                catch (error) {
                    /**
                     * ⚠⚠ **失败必须回 `ok: false`**，不得包成 `ok:true + value.success:false`
                     * （Gitee issue IKJOZA，真实缺陷）。
                     *
                     * ## 原来的行为与代价
                     * 本分支的 catch 曾把异常包进**成功**响应
                     * （`{ok:true, value:{success:false, error}}`）。而客户端的
                     * `unwrapRpcResult`（`plugin-src/management-rpc.mjs`）只判 `ok === true`
                     * 就返回 `value` —— 于是**只判 `ok` 的调用方会把续期失败读成成功**。
                     * 实测代价：报告方一个工具首版只判 `ok`，18 个「✅」里 **17 个实为失败**，
                     * 真实原因是 `codearts 400 STS5.1806 invalid refresh token:
                     * 'the refresh token has been used'` / `minimax refresh_token 已失效` /
                     * `raccoon 登录态已过期`。
                     *
                     * ## 为什么这里不能学那四处「catch 仍回 ok:true」
                     * 本文件确有四处 catch 后仍 `ok:true`，它们**都有额外的判别字段**，
                     * 调用方不判它就会误读，本端点没有 —— 逐条对照：
                     *
                     * | 位置 | 形态 | 为何安全 |
                     * |---|---|---|
                     * | `login.poll` | `{done:false}`（进行中）／`{done:true, success:false, error}`（终态失败） | 有 `done` + `success` 两个判别字段，前端两者都判（2026-10-14 按 issue IKLI7J 补齐终态腿） |
                     * | `login.submitSms` | `{done:false, error}` | 验证码输错可重试；⚠️ 随包客户端**从不调用**它（备用路径，`plugin-src/` 零命中），故它的失败文案可见性**未被真实使用验证** |
                     * | `credits.permanentLock` | 广播失败仍 `ok:true` | 广播失败不影响已落盘 |
                     * | `credits.claimAll` | 单号失败进 `results[]` | 「单个失败不中断整体」是设计语义 |
                     *
                     * 本分支只有 `success` 一个布尔：**失败是业务终态，不是可自愈的中间态**，
                     * 与上述四者不同类。
                     *
                     * ## 为什么 `ok:false` 不会打破仓库内任何调用方
                     * `account.refresh` **全仓库零调用方**：面板 `plugin-src/client/jet-hub.js`
                     * 的 42 处 `rpcCall(` 里没有它（账号卡片的按钮是 测试/重测/重置/停用/代理/
                     * 指纹/删除，**没有「刷新」**）；另两处 `rpcCall(变量)` 的实参经追溯只有
                     * `opencode.*` 四个方法。它从来就是给仓库外脚本/手工 RPC 用的端点。
                     * ⇒ 这是**对外部调用方的破坏性契约变更**：原先误判的调用方会从「静默错」
                     * 变成 `unwrapRpcResult` 抛错，属预期的「提前炸」。成功路径仍是
                     * `ok:true + value.success:true`，未变。
                     *
                     * ⚠⚠ **复现这条取证不要用 `git log -S "rpcCall('account.refresh'"`**：
                     * 本注释自身引用了该字面量，`-S` 会**自匹配修复提交本身**（返回 `68fb567`），
                     * 那正是 `AGENTS.md` 明令禁止的「注释与实测脱节」。在 `origin/master`
                     * （修复前）上该命令零命中，这本身是它曾有效的证据。稳定写法是只搜
                     * **不含注释**的客户端源码：
                     * `Select-String -Path plugin-src\client\*.js -Pattern "rpcCall\('account\."`
                     * （应零命中；`account.refreshable` 是另一个字段名，不是端点）。
                     *
                     * 回归用例在 `tests/unit/lobsterai-rpc-dispatch.spec.ts` 的
                     * 「issue IKJOZA」段（锁死「失败不得是 ok:true」+「失败必须带原因」）。
                     */
                    return {
                        ok: false,
                        error: {
                            code: 'bad-request',
                            message: error instanceof Error ? error.message : String(error),
                        },
                    };
                }
            }
            case 'login.poll': {
                const req = payload;
                /**
                 * ⚠️⚠️ **终态失败必须先于一切「进度」判据被检查**（Gitee issue IKLI7J）。
                 *
                 * 失败侧各 provider 都会删掉占位条目，而 `if (!entry)` 原先与
                 * 「账号尚未登记（用户还没授权完）」**同形** ⇒ 前端只能干等到 5 分钟上限。
                 *
                 * 放在 `listAllAccounts()` **之前**是刻意的：`failLogin` 是「先同步写记录、
                 * 再异步删条目」，落在「记录已写、条目还在」的窗口里也必须能报出终态。
                 * 正常路径不会误命中 —— 占位条目在 `account.create` 返回**之前**就已登记
                 *（十几处分支逐一核对过，含 accio 由 `startLogin` 自己登记），故「条目在」
                 * 期间不会有本账号 id 的失败记录。
                 */
                const failure = loginFailureOf(req.accountId);
                if (failure !== undefined) {
                    return {
                        ok: true,
                        value: { done: true, success: false, error: failure },
                    };
                }
                /**
                 * ⚠️ 两件事必须排在 `!entry` 早退**之前**（2026-11-02 二审 C🟡-2）：
                 * ① 判重合并会让占位条目消失（`removeAccount`），但那是**成功**；
                 * ② 后台任务在途时条目理应还在，但万一有人先删了卡，也要继续等而不是报完。
                 * 原先 `!entry` 在最前面 ⇒ 「秒过」场景下前端每拍都回 `done:false`，
                 * 一路转圈到 5 分钟上限，而账号其实已经建好。
                 */
                const accounts = await pool.listAllAccounts();
                const entry = accounts.find((a) => a.id === req.accountId);
                if (!entry) {
                    /**
                     * ⚠️ 条目**已经不在了**时才看这两条（2026-11-02 二审 C🟡-2 的修法位置很重要）：
                     * 不能把「在途」判据提到 `entry` 之前 —— 条目还在时**凭据是否落库**才是
                     * 更可靠的终态信号（既有用例正是靠它判 `done:true`：`account.create`
                     * 返回后任务往往还没跑完，此时 `inFlight.has(id)` 仍为真）。
                     */
                    const merged = takeFreshLoginMergedRedirect(req.accountId);
                    if (merged !== undefined) {
                        // 判重合并 ⇒ 成功（凭据已写进 `merged.targetId`），但 id 已经不是本次这个。
                        // ⚠️ 不再这里另记一次 `loginMergedRedirect.delete`：`takeFreshLoginMergedRedirect`
                        //    已经把过期项删掉并返回了未过期项（四审自查：原写法是多余的重复删除）。
                        return { ok: true, value: { done: true, success: true } };
                    }
                    // 还在途 ⇒ 继续等（别让前端以为「什么都没发生」而提前收工）。
                    if (magicrewBrowserLoginInFlight.has(req.accountId)) {
                        return { ok: true, value: { done: false } };
                    }
                    return { ok: true, value: { done: false } };
                }
                // 检查凭据是否已实际写入（占位条目没有凭据）。
                //
                // ⚠ **不能只判「resolve 出了非空字符串」**（审查发现）：占位条目被
                //   `credentials.set` 写入过一段**残缺 JSON** 时，`resolve` 照样返回
                //   字符串，UI 就会弹「账号已添加」而实际上该账号一发请求就 `凭据无效`。
                const ref = credentialRef(entry.credentialRef);
                const resolved = await ctx.credentials.resolve(ref);
                if (!resolved) {
                    /**
                     * ⚠️⚠️ **marvis 网页版登录：把「等用户」交给后台任务**（`mode: 'browser'`）。
                     *
                     * 占位条目在、凭据还没有是**正常形态**：账号创建里起的那轮任务在
                     * 等用户在隔离窗口里完成授权（分钟级）。⇒ 必须 `await` 那一轮任务
                     *（**单飞**：客户端 1 秒一拍、`setInterval` 没有 in-flight 闸门）。
                     *
                     * ⚠️ 任务结束后**它自己会从表里删掉**（`account.create` 那段 `finally`）；
                     * 这里 `return await task` 拿到的是已经算好的三态，不会再起第二次。
                     */
                    const shared = magicrewBrowserLoginInFlight.get(req.accountId);
                    if (shared !== undefined)
                        return { ok: true, value: await shared };
                    /**
                     * ⚠️ 表里没有这一轮（宿主重启过 / 兜底轮询到了别人的 id）⇒ 回
                     * `{done:false}` 交给客户端自己的 5 分钟表收口，**不要**在这里猜成功或失败：
                     * 猜成功会把一张没有凭据的卡片报成「已添加」，猜失败会删掉一张可能
                     * 正在登录的卡（`magicrewBrowserLoginInFlight` 只在**成功或失败落定后**
                     * 才删自己，故走到这里一定意味着没有在途任务）。
                     *
                     * ⚠️ 但**不能**无限挂着：占位条目由 `account.list` 的
                     * `sweepAbandonedMagicrewBrowserLogins` 按 TTL 收口。
                     */
                    return { ok: true, value: { done: false } };
                }
                return { ok: true, value: { done: true, success: true } };
            }
            /**
             * 查询新手任务 / 一次性奖励状态（**Loomy** 的新手任务、**raccoon** 的登录奖励，只读）。
             *
             * ⚠️ 只读：**不得**在此触发任何 `complete`/`claim`（面板挂载时会调用它）。
             *
             * ⚠️ **2026-10-08 改（Task 4）：两段 `if (req.provider === X.id)` 收敛成查表**
             *   —— 分支体里**没有一行协议逻辑**（协议早已封装在 `loomy-onboarding.ts` 与
             *   `raccoon-credits.ts` 内）。表在 `src/provider-onboarding.ts`，
             *   各家实现逐字搬迁、**一行未改**（含 raccoon 那条「映射成 Loomy 那套任务
             *   形状的一项」的语义）。
             *
             * ⚠️ 判据从「provider 属于 {loomy, raccoon}」改为「**该家是否提供
             *   `onboarding.status`**」：那张手抄的 `!== LOOMY.id && !== RACCOON.id`
             *   与能力表是**两份可漂移的东西**（新增一家要同时改两处，漏一处就静默
             *   失效）。表由 `auths` 现造，与 `credits.*` 同法。
             */
            case 'onboarding.status': {
                const req = payload;
                const impl = onboardingOf(onboarding, req.provider);
                // ⚠️ 未登记 / 无该能力的 provider 回**可读的** bad-request（兜底契约）。
                if (impl?.status === undefined) {
                    return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } };
                }
                const account = pool.findAccount(req.accountId);
                if (account === undefined) {
                    return { ok: false, error: { code: 'bad-request', message: '账号不存在' } };
                }
                const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef));
                if (!resolved) {
                    return { ok: false, error: { code: 'bad-request', message: '凭据未配置' } };
                }
                // ⚠️ 凭据解析在**守卫之后**、在 try 之外，与旧实现逐字一致：
                //    这里只有**一个**账号（不是批量循环），故失败应如实冒泡成端点错误，
                //    不该被吞成某个账号的 failed。
                const credential = JSON.parse(resolved.value);
                const value = await impl.status(credential, callContext);
                return { ok: true, value: value };
            }
            /**
             * 「锁定永久积分」开关（读 / 写，**provider 维度**）。
             *
             * **用户需求**：锁定后选号只允许消耗**会近期作废**的积分，永久积分不参与 ——
             * 只剩永久积分的账号在锁定期间等同于不可用（「锁定后没有临时积分后找
             * 可用账号就是没有可用账号」）。解锁后恢复「没临时积分就用永久积分」。
             *
             * 三个 provider 都有这件事，但「什么算永久积分」不同（Loomy 看服务端的每日
             * 池字段；两个 buddy 看资源包扣费截止距今是否满 15 天，判据见
             * `buddy-balance-rank.ts`）。**语义相同、判据不同**，故共用一个端点与一张
             * 持久化表，而不是各加一条 case —— 平行分支越多，漏接概率越高。
             *
             * ⚠️ 开关是 **provider 级**（不分账号），持久化在
             * `$DSH_HOME/jet-hub/permanent-locks.json` 的 `locks` 表里（**不放 state.json**：
              * 那份文档同机多 profile 共享，另一条工作区的旧版本整体重写它时不会带上
              * 自己不认识的键 —— 理由见 `src/permanent-lock-store.ts` 文件头）
             * （`loomyPermanentLocked` 是同一值的兼容副本，见 `jet-hub-store.ts`）。
             *
             * ⚠️ `locked` 省略时**只读**（供面板初始化），给出布尔值才写入。
             */
            case 'credits.permanentLock': {
                const req = payload;
                const provider = typeof req.provider === 'string' ? req.provider.trim() : '';
                if (!PERMANENT_LOCK_PROVIDERS.has(provider)) {
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: `该 provider 不支持锁定永久积分：${provider || '(空)'}` },
                    };
                }
                /**
                 * 组装响应。
                 *
                 * ⚠️ 原「按到期时间分桶的 provider 回传窗口天数」逻辑随 buddy /
                 * TRAE / LobsterAI 裁剪删除：本 fork 的 registry 里没有任何
                 * `usesExpiryWindow` 的供应商（marvis 不分桶）⇒ 不回传该字段。
                 */
                const lockResponse = () => ({
                    provider,
                    locked: pool.permanentLocked(provider),
                });
                if (req.locked === undefined) {
                    return { ok: true, value: lockResponse() };
                }
                if (typeof req.locked !== 'boolean') {
                    return { ok: false, error: { code: 'bad-request', message: 'locked 必须是布尔值' } };
                }
                await pool.setPermanentLocked(provider, req.locked);
                // ⚠️ 与 `model.setDisabled` 同理：本次写入会改变**选号结果**
                // （进而改变哪些账号会被使用），故广播一次让界面重新读取状态。
                // ⚠️ 走**唯一**的广播实现（`src/catalog-broadcast.ts`）：它自带
                // 「失败只记日志、不反噬已落盘的开关」与两级可选链 logger（审计指出
                // 此处曾是内联实现，`ctx.logger.warn` 在 logger 缺席时会抛、仅被 catch 吞）。
                broadcastCatalogChanged(ctx);
                return { ok: true, value: lockResponse() };
            }
            /**
             * 领取新手任务 / 一次性奖励（**Loomy** 的新手任务、**raccoon** 的登录奖励，一次性）。
             *
             * ⚠️ 这是**写**操作，且**每号只能领一次** —— 与 `credits.claimAll`
             *（每日签到）语义完全不同，故独立端点。
             *
             * ⚠️ **2026-10-08 改（Task 4）：两段 `if (req.provider === X.id)` 收敛成查表**
             *   —— 与 `onboarding.status` 同法（见那里的注释）。表在
             *   `src/provider-onboarding.ts`，含 raccoon 那条
             *   「**已领时 `earned` 报满分、不是 0**」的实测语义（真实报障：
             *   UI 显示「✅ 1 个此前已完成 / 累计已领 0 / 3000」自相矛盾）。
             */
            case 'onboarding.claim': {
                const req = payload;
                const impl = onboardingOf(onboarding, req.provider);
                if (impl?.claim === undefined) {
                    return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } };
                }
                const account = pool.findAccount(req.accountId);
                if (account === undefined) {
                    return { ok: false, error: { code: 'bad-request', message: '账号不存在' } };
                }
                const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef));
                if (!resolved) {
                    return { ok: false, error: { code: 'bad-request', message: '凭据未配置' } };
                }
                const credential = JSON.parse(resolved.value);
                let value;
                try {
                    value = await impl.claim(credential, callContext);
                }
                catch (error) {
                    // ⚠️ 实现侧用**上抛**表达「领取失败」（而不是返回一条
                    //    「成功但没领到」的响应）—— 这里翻译成既有的可读 bad-request
                    //    （`code: 'bad-request'` + 服务端原文）。
                    //
                    // ⚠️ **2026-10-08 更正（Task 4 复审 Finding 2）：本注释原先写「与旧实现
                    //    逐字一致」，那是错的** —— 逐字一致只对 **raccoon** 成立（它的旧分支
                    //    自己 catch 了 `outcome.kind === 'failed'` 并回 `bad-request`）；
                    //    **loomy 的旧分支没有 try/catch**，`claimOnboardingTasks` 一抛错就
                    //    冒到外层处理器，变成 `jet-hub/handler-failed`（「未知故障」，
                    //    用户看不出是领取失败）。
                    //
                    // ⇒ 现在两家**统一** `bad-request`，即 loomy 的**错误码变了**
                    //    （`jet-hub/handler-failed` → `bad-request`），这是一处 **G3 例外**
                    //    （见 Task 4 报告 §5 的 G3-4），**方向是改善**：失败原因不再被
                    //    降级成「未知故障」。用户可见影响为零 —— 客户端只渲染
                    //    `error.message`，而 message 逐字未变（仍是服务端原文）。
                    //    ⚠️ 故**不要**为了「零行为变更」把 loomy 改回上抛。
                    return {
                        ok: false,
                        error: {
                            code: 'bad-request',
                            message: error instanceof Error ? error.message : String(error),
                        },
                    };
                }
                return { ok: true, value: value };
            }
            // ── 限流标记：重测（发真实请求验证）──
            // 标记只反映"上一次 429 时的快照"，服务端常在重置时间前提前放行。
            // 重测发一次最小对话请求：正常返回才清除标记，仍受限则保留并回报原因。
            case 'account.retest': {
                const req = payload;
                const account = await retestAccount(pool, req.accountId);
                return {
                    ok: true,
                    value: { accounts: [account], clearedCount: account.cleared.length },
                };
            }
            // 重测该 provider 下的全部账号。**包含已停用账号**——用户明确要求
            // 停用账号也能重测（停用只影响自动选择，不影响手动排查）。
            case 'account.retestAll': {
                const req = payload;
                const value = await retestAllAccounts(pool, req.provider);
                return { ok: true, value };
            }
            // ── 限流标记：测试（**无条件**发一次真实请求）──
            //
            // ⚠️ 与 `account.retest` 的区别是**触发条件**，不是措辞：
            // `retestAccount` 只测那些已经有 `modelRateLimits` 标记的模型，没有标记时
            // 在 `modelIds.length === 0` 处提前返回、一次请求都不发。于是「这个账号
            // 到底还能不能用」在**没有历史 429** 时没有手动探活入口 —— 用户点「重测」
            // 看到瞬间返回，会以为按钮失灵（真实报障：「重测按钮你确认过会发请求吗，
            // 为什么响应这么快？」）。`account.test` 补齐的就是这个缺口。
            //
            // ⚠️ 它**不写任何存储**：不清标记、不写回新的重置时刻。测出「仍受限」只
            // 如实回报给用户看，不落盘 —— 落盘会把「一次手动探活」变成「改变选号
            // 状态」，那是重测的语义。
            case 'account.test': {
                const req = payload;
                const accountId = req.accountId;
                if (typeof accountId !== 'string' || accountId === '') {
                    return { ok: false, error: { code: 'bad-request', message: '缺少 accountId' } };
                }
                const entry = pool.findAccount(accountId);
                if (entry === undefined) {
                    return { ok: false, error: { code: 'bad-request', message: `账号 ${accountId} 不存在` } };
                }
                // 模型推断：显式指定 > 已有的限流标记（用户最可能想看的就是它）> 全量目录第一个。
                // ⚠️ 只有前两者都拿不到时才去读目录 —— 若无条件先读它，一个「明明有标记可测」
                // 的账号会因为目录服务暂时不可用而被拒，属于自造的失败。
                //
                // ⚠️⚠️ **本调用点对目录是「尽力而为」，与两个关闭方向刻意不同**：
                // 它只要**一个** id 就能测，故远端读失败时**不拒绝**，用拿到的（适配器兜底表
                // 或空）照常继续。⚠️ 这与 `model.setAllDisabled` 的「必须完整 ⇒ 拒绝」是
                // **两种不同的完整度要求**，不是同一条判据的两个写法（实测：若这里也拒绝，
                // 「适配器有目录 + llm 临时故障」会从「能测」退化成 bad-request）。
                //
                // 目录也读不出来时如实报错，**不**猜一个模型名发出去（猜错会得到与账号
                // 无关的 404，把「账号不可用」和「模型名不对」两件事混成一条报错）。
                let modelId = pickTestModel(entry, [], req.modelId);
                if (modelId === '') {
                    const catalog = await fullCatalogIds(ctx, modelAdapters, entry.provider);
                    modelId = pickTestModel(entry, catalog.ids, req.modelId);
                    // ⚠️ 一个 id 都挑不出来**且远端也读失败**时才报「无法确定」并带上原因；
                    // 远端成功但目录为空 ⇒ 落到下面那句「没有可测试的模型」（两件事不同：
                    // 前者是「读不到」，后者是「读到了但里面没有模型」）。
                    if (modelId === '' && catalog.remoteError !== undefined) {
                        return {
                            ok: false,
                            error: { code: 'bad-request', message: `无法确定要测试的模型：${catalog.remoteError}` },
                        };
                    }
                }
                if (modelId === '') {
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: `${entry.provider} 没有可测试的模型` },
                    };
                }
                const value = await testAccount(pool, accountId, modelId);
                /**
                 * ⚠️⚠️ **不要**在这里清任何标记 —— 包括账号级封禁标记（2026-11-01 对抗
                 * 审计打穿了第一版「成功即清」的写法）。
                 *
                 * 原因不是「少一个便利」，而是**判据强度不够**：
                 * - `testAccount` 只测**一个**模型（`pickTestModel` = 请求里的 modelId >
                 *   `Object.keys(modelRateLimits)[0]`（**插入序最老的那个键**）> 目录第一个）；
                 * - 客户端「测试」按钮**从不传 modelId**（`rpcCall('account.test', { accountId })`）；
                 * - 而封禁与限流是两笔账：最老的键可能是历史 429 的模型，与被 11140 拦下的
                 *   模型无关。实测（对抗审计 `zzatk3.spec.ts`）：`modelRateLimits = {glm-5.2:
                 *   旧429, deepseek-v4.1-flash: 11140}` 时 `pickTestModel ⇒ glm-5.2`，那个
                 *   模型换模型立刻 200 ⇒ `ok:true` ⇒ **整号封禁被洗白** ⇒ 池立刻选回它 ⇒
                 *   下一发再 403（mark/clear 抖动，每次烧一发真实请求 + 2 次写盘）。
                 *
                 * 清除只留给**证据强度足够**的路径：`account.retest`（要求**所有**带标记的
                 * 模型都实测通过）与 `account.reset`（用户显式「我确认它好了」，不做验证）。
                 * 这与上面「它不写任何存储」的原有纪律一致 —— 第一版把它破例了，现撤销。
                 */
                return { ok: true, value };
            }
            // ── 限流标记：重置（不发请求，直接清除）──
            case 'account.reset': {
                const req = payload;
                const value = await resetAccount(pool, req.accountId);
                return { ok: true, value };
            }
            case 'account.resetAll': {
                const req = payload;
                const value = await resetAllAccounts(pool, req.provider);
                return { ok: true, value };
            }
            // ── 每日签到（积分领取）──
            // 查询某 provider 下全部启用账号的签到状态。
            //
            // ⚠️ **2026-10-08 改（Task 3）：7 段分支收敛成「有则真查、无则如实 null」**。
            //    原先 5 段（codearts / lobsterai / trae / cline / loomy）是**逐字同构**的
            //    「手工拼 `{accountId, nickname, status: null}`」，另 2 段（minimax /
            //    buddy 系）真查。现在判据统一为「该渠道有没有注册 `fetchStatus`」：
            //    - 未注册 ⇒ 共享分支如实回 null（与它们原先的行为**逐字等价**）；
            //    - 已注册 ⇒ 走 `collectCreditsStatus` 真查。
            //
            //    ⚠️ 那 5 家**不注册** `fetchStatus` 是**诚实**的，不是偷懒：它们确实
            //    没有与 `CheckinStatus` 同构的状态端点 —— 要么根本没有签到端点
            //    （cline），要么要走两步且字段语义不同（codearts / lobsterai），
            //    要么由 claim 流程自带幂等判据（trae / loomy）。臆造一份
            //    `{streakDays: 0, dailyCredit: 0}` 会让面板显示「连续 0 天」这种
            //    **看起来像真实读数**的假数据。
            //
            //    ⚠️ 与「不支持」的区别：本端点**支持**（返回 200 + 账号列表），
            //    只是状态本身未知。故**不是**错误（与 claimAll 的守卫不同）。
            //
            //    ⚠️⚠️ **本改造对 5 家是行为变更（如实登记，别当成等价重构）**：
            //    `qoder` / `qodercn` / `raccoon` / `zcode` / `gemini` 原先落到
            //    `productById()` 的兜底、回 `bad-request: unsupported provider`，
            //    现在回 `ok: true` + `status: null`。这是**放宽**（把「端点不支持」
            //    改成「端点支持但状态未知」），与上面那条语义一致，且**无回归风险**：
            //    - 客户端**零调用**本端点（`plugin-src/client/` 里搜不到
            //      `credits.status`），自动签到走的是 `credits.claimAll`；
            //    - 它的实际消费者是外部脚本 / 直接 RPC 调用（见
            //      `docs/implementation-notes.md`）。
            //    判据由 `credits-runtime-parity.spec.ts` 的
            //    「credits.status 对 registry 里的每个渠道都被接受」锁死；
            //    **未知** provider 仍回 bad-request（兜底契约不变）。
            case 'credits.status': {
                const req = payload;
                const accounts = await pool.listAccounts(req.provider);
                const statusImpl = creditsOf(credits, req.provider);
                if (statusImpl?.fetchStatus === undefined) {
                    // ⚠️ 未知 provider 与「已登记但无状态端点」必须**分开**：
                    //    前者是 bad-request（兜底契约），后者是「如实 null」。
                    //    registry 是权威判据（不是另立一份 provider 名单 —— 两份必然漂移）。
                    if (descriptorOf(req.provider) === undefined) {
                        return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } };
                    }
                    return {
                        ok: true,
                        value: {
                            accounts: accounts.map((entry) => ({
                                accountId: entry.id,
                                nickname: entry.nickname,
                                status: null,
                            })),
                        },
                    };
                }
                // ⚠️ `collectCreditsStatus` 逐账号 try/catch —— 单账号失败**不中断整体**，
                //    这是该骨架已验证的语义，**不要重写**。
                //
                // ⚠️⚠️ **它已不是「顺序查询」了**（2026-10-22 改成有限并发，默认 3）：
                //    原注释写「这与『顺序查询避免并发风控』同属该骨架已验证的语义，不要重写」
                //    —— 而函数**就在那之后被重写了**，那条注释因此变成误导（下一个读者会照它
                //    改回串行）。并发度的依据与代价见 `collectCreditsStatus` 函数体内那段注释。
                //    签到（写操作）仍在 `collectClaimResults` 里**串行**，那一条没变。
                //
                // ⚠️ 第二参（product）统一传 `undefined`：它**只被透传给 `fetchStatus`**，
                //    而 `fetchStatus` 现在由 credits 表提供、自带各自的 product 配置，
                //    不再需要调用侧转发（原先 buddy 系传 `productById()`、minimax 传
                //    `undefined`，是历史形态）。
                const value = await collectCreditsStatus(accounts, undefined, {
                    resolve: (ref) => ctx.credentials.resolve(ref),
                    fetchStatus: (credential) => statusImpl.fetchStatus(credential, callContext),
                    warn: (msg) => ctx.logger?.warn?.(msg),
                });
                return { ok: true, value: { accounts: value } };
            }
            // 一键领取：逐账号顺序执行（并发易触发风控），单个账号失败不中断整体。
            //
            // ⚠️ **2026-10-08 改（Task 4）：14 段 `if (req.provider === X.id)` 收敛成查表**
            //   —— 那些分支体里**没有一行协议逻辑**（协议早已封装在各家
            //   `claimXxxDailyCheckin` 内），RPC 层看到的只是「选哪个函数」。
            //   表在 `src/provider-credits.ts`，各家实现逐字搬迁、**一行未改**。
            //   ⚠️ 编排仍留在共享骨架 `collectClaimResults` 里，**一行不重写**
            //   （「顺序执行避免并发风控」「单账号失败不中断」「凭据解析在 try 之内」
            //    都是实测结论）。
            //
            // ⚠️ **表从 `auths` 现造，不查全局注册表**（与 `credits.balances` 同法，
            //   理由见 `registerJetHubRpc` 的注释与设计复审 C1）：本函数持有本次注册的
            //   auth 实例，查全局表会让测试无法注入桩、并重开「位置/时序错位」那扇门。
            case 'credits.claimAll': {
                const req = payload;
                const accounts = await pool.listAccounts(req.provider);
                // ⚠⚠ **领取前也要按需自愈**（issue IKKHL5，与 `credits.balances` 同一层）。
                //
                // 用户报障的场景里，「积分行报 HTTP 401」旁边**就挂着「一键领取积分」
                // 按钮** —— 睡眠/挂起恢复后点它，撞的是**同一个** 401：凭据已过期，
                // 而领取流程同样只 resolve 凭据后直连上游、全程不续期。
                // 若只修余额查询，「用户点刷新能看到余额了、点领取却还是 401」，
                // 症状会变得自相矛盾、更难排查。
                //
                // ⚠️ 放在**端点入口**（与余额端点同因）：本 case 下有十几家 provider
                // 分支（qoder/codearts/lobsterai/trae/cline/workbuddy/raccoon/minimax/
                // zcode/gemini/buddy 系…），逐分支加必漏。
                // ⚠️ 顺序执行、失败不上抛，见 {@link healExpiredAccounts}。
                await healExpiredAccounts(accounts);
                const impl = creditsOf(credits, req.provider);
                if (impl?.claim === undefined) {
                    // ⚠️ 措辞必须**指明是"该产品无此能力"**，不能退化成「provider 没注册」
                    // —— 后者会让排查者去查注册表，而真相是产品没有这个接口。
                    //
                    // ⚠️ 文案由**表**给（`claimUnavailableReason`），不在端点里拼模板：
                    //    三条文案是实测报障修来的、各自信息量不同（raccoon 那条含可操作
                    //    指引「登录奖励请在『新手任务』中领取」），压成一句泛化模板会丢掉它。
                    //    两个真实例子（各自的历史注释都记录了这一点）：
                    //      - cline：对整个 sidecar 做字符串扫描，无任何 checkin/campaign 端点；
                    //      - workbuddy：国际版内核里只有 get-dosage-notify，没有签到接口。
                    //    ⚠️ workbuddy 这条守卫**必须有**：没有它时会落到下面的通用分支，
                    //       用**国际版**凭据去发**国内版**的签到请求 —— 必然失败，而且是一次
                    //       真实的上游请求。而「每日首次启动自动签到」正是靠「调 claimAll、
                    //       按返回的信封判跳过」来决定遍历范围的，它**不维护第二份能力名单**。
                    //
                    // ⚠️ 表里**没有专属文案**的已登记渠道（gemini / opencode / aggregate）
                    //    仍回**旧的** `unsupported provider: X` —— 那是**刻意不动**的行为
                    //    （改成「不支持每日签到」是一处需批准的 G3 例外，见 Task 4 报告）。
                    //    未登记的 id 同样落进这里（兜底契约不变）。
                    if (impl?.claimUnavailableReason !== undefined) {
                        return {
                            ok: false,
                            error: { code: 'bad-request', message: impl.claimUnavailableReason },
                        };
                    }
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` },
                    };
                }
                // ⚠️ 第二参（product）统一传 `undefined`：它只被透传给骨架的 `claim` /
                //    `fetchStatus` 入参，而这两者现在由 credits 表提供、**自带各自的
                //    product 配置**，不再需要调用侧转发（原先 buddy 系传
                //    `productById()`、其余传 `undefined`，是历史形态）。
                //
                // ⚠️ `afterClaim`（成长中心）**必须留在这趟循环里**（见
                //    `CreditsEndpointDeps.afterClaim` 的长注释）：它与签到共用同一趟
                //    逐账号循环，凭据只解析一遍。漏掉它的症状**只是**「成长中心不工作了」，
                //    日志里没有错误。
                const value = await collectClaimResults(accounts, undefined, {
                    resolve: (ref) => ctx.credentials.resolve(ref),
                    // ⚠️ 骨架的 `claim` 是 `(credential, product, entry)` —— 第三参才是
                    //    `entry`（TRAE 用它取签到设备代次）。产品配置由表里的实现闭包捕获，
                    //    故这里把 `product` 丢掉。
                    claim: (credential, _product, entry) => impl.claim(credential, entry, callContext),
                    // ⚠️ 由能力表驱动，不再散落 provider 字面量。
                    ...impl.precheckStatus === undefined ? {} : { precheckStatus: impl.precheckStatus },
                    // ★ 签到收尾的附加提示（TRAE 的 1024 打卡抽奖走这里）。
                    //   ⚠️ **必须透传**：漏了它症状是「抽奖永远不触发」且**日志零字**
                    //   —— 与 `afterClaim` 漏接线同型（那格已复发过一次）。
                    ...impl.afterClaimNote === undefined
                        ? {}
                        : {
                            afterClaimNote: (credential, _product, entry) => impl.afterClaimNote(credential, entry, undefined),
                        },
                    // ⚠️ 预检优先用 `claimStatus`，缺席时回落到 `fetchStatus`
                    //（buddy / minimax 的预检与面板读数是同一个端点，只声明一次）。
                    ...(impl.claimStatus ?? impl.fetchStatus) === undefined
                        ? {}
                        : {
                            fetchStatus: (credential) => (impl.claimStatus ?? impl.fetchStatus)(credential, callContext),
                        },
                    // 成长中心任务：与签到**共用这一趟逐账号循环**（见 CreditsEndpointDeps
                    // .afterClaim），故凭据只解析一遍。
                    //
                    // ⚠️ `runTasks` 缺省为 false：这条路径同时是「每日首次启动自动签到」的
                    // 执行体（见上方 createAutoCheckin 的 claim 回调），而成长一轮单账号实测
                    // 90～270s、全串行、任务间 1.5s 节流。默认开启等于每次启动自动打几十个
                    // 上游请求。只有用户手点「一键领取积分」时才传 true。
                    //
                    // ⚠️ 门控是「**该家是否提供 `afterClaim`**」—— 原先的
                    //    `GROWTH_CAPABLE_PROVIDERS` 手抄集合已删除（Task 1b 同因：
                    //    消除平行副本，让「哪家有成长中心」由能力注册表说了算）。
                    ...req.runTasks !== true || impl.afterClaim === undefined
                        ? {}
                        : {
                            afterClaim: (credential, _product, entry, _outcome, roundDeadlineAt) => impl.afterClaim(credential, entry, { budgetMs: req.budgetMs, roundDeadlineAt }, callContext),
                        },
                    warn: (msg) => ctx.logger?.warn?.(msg),
                });
                return { ok: true, value: value };
            }
            // 积分余额（Credits Balance）：逐账号顺序查询。
            //
            // 独立于 account.list 的原因：余额要为每个账号发一次网络请求，而
            // account.list 是打开面板就会调的轻量操作。混在一起会让账号列表被
            // 网络耗时拖慢，且一次查询失败会让整份列表都取不到。
            //
            // ⚠️ **2026-10-08 改（Task 3）：11 段 `if (req.provider === X.id)` 收敛成查表**
            //   —— 那些分支体里**没有一行协议逻辑**（协议早已封装在各家
            //   `fetch*Balance` 内），RPC 层看到的只是「选哪个函数」。表在
            //   `src/provider-credits.ts`，各家实现逐字搬迁、**一行未改**。
            //   ⚠️ 编排仍留在共享骨架 `collectCreditBalances` 里，**一行不重写**
            //   （「顺序查询避免并发触发风控」「单账号失败不中断」都是实测结论）。
            case 'credits.balances': {
                const req = payload;
                /**
                 * ★ 共享读数槽要用的**凭据**（2026-10-16）。
                 *
                 * ⚠️ 为什么不能直接用 `accounts` 里现成的：那些条目只有 `credentialRef`，
                 *    而 `fetchBalanceReading` 需要**已解析**的凭据（`JSON.parse` 之后）。
                 * ⚠️ **解析失败返回 `undefined`**：缓存命中时压根不发请求（不需要凭据），
                 *    未命中时 `fetchBalanceReading` 会抛「凭据未提供」⇒ 被记成失败读数 ⇒
                 *    面板照常显示「凭据未配置」的错误路径。**不会**把凭据问题伪装成余额。
                 */
                const resolveCredentialForCache = async (accountId) => {
                    const entry = accounts.find((a) => a.id === accountId);
                    if (entry === undefined)
                        return undefined;
                    const resolved = await ctx.credentials.resolve(credentialRef(entry.credentialRef));
                    if (resolved === undefined)
                        return undefined;
                    try {
                        return JSON.parse(resolved.value);
                    }
                    catch {
                        return undefined;
                    }
                };
                // ⚠️ 载荷里的 `accountIds` 是**可选裁剪**（用量徽标只要启用账号，见 types.ts
                //    的那段注释）。⚠️ 必须在**自愈之前**读它、但只用于**余额查询**那一段：
                //    自愈仍对**全部**账号跑（AGENTS.md：「续期不得按 enabled 过滤」）。
                const requestedIds = Array.isArray(req?.accountIds)
                    ? new Set(req.accountIds.filter((id) => typeof id === 'string'))
                    : undefined;
                const allAccounts = await pool.listAccounts(req.provider);
                const accounts = requestedIds === undefined
                    ? allAccounts
                    : allAccounts.filter((entry) => requestedIds.has(entry.id));
                // ⚠⚠ **先按需自愈、再查余额**（Gitee issue IKKHL5 建议 C）。
                //
                // 缺陷：系统睡眠/挂起数小时后恢复，**宿主进程全程没退出** ⇒
                // `state.json` 的 `expiresAt`（上次续期时刻 + 令牌寿命）落在过去，
                // 卡片显示红色「已过期 · 自动续期」，而本端点 resolve 凭据后
                // **直连上游、全程不续期** ⇒ 积分行报「HTTP 401」。该窗口内没有任何
                // 手动自救手段（「重测」的 refresh 是刻意 no-op）。
                //
                // 为什么要放在**端点入口**而不是每个 provider 分支里：本端点上有
                // 「特例短路（opencode / qoder）+ 查表分派」两段，且查表那段对
                // **所有**落在表里的渠道共用一行调用 —— 在入口加**一处**就覆盖全部，
                // 逐分支加必然漏（仓库在 `workbuddy` 上漏过一次：`account.refresh`
                // 端点对它一直报 `Unknown provider`）。
                //
                // ⚠️ **顺序执行**且失败不上抛（见该函数）：积分查询是逐账号顺序
                // 查询（避免并发触发风控），这里保持同一形状。
                //
                // ⚠️⚠️ **自愈用 `allAccounts`（全部账号），不是被 `accountIds` 裁剪过的
                //    `accounts`**（2026-10-15 加裁剪时同步加这条注释）：
                //    本仓库有成文铁律「**续期不得按 `enabled` 过滤**」—— 停用只影响自动选号，
                //    与「凭据是否需要保持新鲜」无关。用量徽标为了省几个余额请求而传
                //    `accountIds`（只含启用账号）时，**停用账号的凭据仍必须被续期** ——
                //    否则它们会在停用期间一路放到失效，用户重新启用后拿到死凭据、
                //    只能重新登录（真实缺陷，见 AGENTS.md 的那一节）。
                await healExpiredAccounts(allAccounts);
                // ⚠️ **两个形态与骨架不匹配的特例，先于查表短路**：
                //    - `opencode`：余额是**本地派生的通道可用性**（读账号池的
                //      `modelRateLimits`），**零网络请求**。套进
                //      `fetchBalance(credential, …)` 形状会逼它去发一个不存在的上游请求
                //      （实测 Zen 的 15 个候选余额路径全部 404）。
                //    - `qoder` 系：`fetchQoderCreditBalance` 只吃 `QoderCredential`，
                //      且 product 来自同族注册表，**不走** `collectCreditBalances` 的
                //      `(credential, product)` 泛型。
                // 保留特例而非强行套骨架：套上去会丢语义（设计文档 §3.5 的边界 ——
                // 抽象的是「选哪个函数」，不是「函数内部怎么做」）。
                // ── 查表分派 ──
                // ⚠️ 表由 `registerJetHubEndpoints` 从 `auths` 现造（**不是**形参，
                //    见 `registerJetHubRpc` 的注释：第 5 个位置形参已在 2026-10-08
                //    设计复审 C1 中删除）。`src/index.ts` 另有一份**同源同构**的表挂在
                //    `ProviderRuntime.credits` 上，供 Task 5/8 的跨模块消费点读 ——
                //    两条接线的消费方不同，但用的是同一个工厂、同一批 auth 实例。
                const impl = creditsOf(credits, req.provider);
                if (impl === undefined) {
                    return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } };
                }
                // ⚠️ 包一层适配：runtime 的签名是 `(credential, call)`，
                //    `collectCreditBalances` 的入参签名是 `(credential, product)`。
                // ⚠️ `accountId` 经**逐账号**包装传入（Gitee issue IKLTZ2）：Gemini 要按
                //    账号取出口代理，故 `callContext` 必须是**每账号一份**而不是端点级
                //    单例 —— 共享单例会让所有账号都查到「最后一个」账号的代理。
                const values = await collectCreditBalances(accounts, undefined, {
                    resolve: (ref) => ctx.credentials.resolve(ref),
                    ...impl.fetchBalanceDetailed === undefined
                        ? {}
                        : {
                            fetchBalanceDetailed: (credential, _product, accountId) => impl.fetchBalanceDetailed(credential, accountId === undefined ? callContext : { ...callContext, accountId }),
                        },
                    ...impl.fetchBalance === undefined
                        ? {}
                        : { fetchBalance: (credential) => impl.fetchBalance(credential, callContext) },
                    // ⚠️ 回写共享读数（规格 §5.7）：`provider` 由本端点提供 —— 
                    //    `collectCreditBalances` 自己不知道 provider（它的入参是账号数组）。
                    ...balanceCacheOf() === undefined
                        ? {}
                        : {
                            writeBalance: (accountId, balance) => balanceCacheOf().write(req.provider, accountId, { at: Date.now(), value: balance }),
                            /**
                             * ★ 载荷的 `force`（面板「刷新积分」按钮，2026-10-16 审计 P1-1）。
                             *
                             * ⚠️ 类型已补进 `RpcCreditsBalancesRequest`（`src/types.ts`），
                             *   故这里**按类型读**而不是 `(payload as {force?: unknown})` 强转 ——
                             *   强转会让「客户端根本没传」这件事在编译期完全看不出来。
                             */
                            force: req.force === true,
                            /**
                             * ★ **先吃共享读数**（2026-10-16，issue IKMCOO 缺陷 1 + 用户
                             * 「打开面板要很久，加载拿不到新数据应该读旧数据」）。
                             *
                             * ⚠️ `readStale` 内部会**真的取数**（命中则零网络），故此处是
                             *    「读一次共享读数（含兼顶）」，不是「只 peek」。
                             * ⚠️ **`force` 必须透传**：面板「刷新」按钮要绕过缓存（含兼顶）
                             *    强制回源 —— 漏传会让「刷新」退化成「读旧值」，用户点了没反应。
                             *    ⚠️ 该载荷此前**没有** `force` 字段（只有 `accountIds`），
                             *    这里按既有可选字段的同款读法解析，不改响应形状。
                             */
                            readCachedBalance: async (accountId, readOptions) => {
                                // ⚠️ 判据**只用** `readOptions.force`（2026-10-16 审计 P1-1）：
                                //   原先这里 `|| payload.force === true` 兜底，看起来两条腿都通，
                                //   但上一行 `collectCreditBalances` 传的是**硬编码 `{}`**
                                //   ⇒ `readOptions.force` 恒 undefined ⇒ 那一腿恒假。
                                //   现在 `collectCreditBalances` 会透传 `deps.force`（见其定义），
                                //   而 `deps.force` 由下方 `force:` 注入 ⇒ 只有**一条**来源，
                                //   避免「两处判 force」再次漂移。
                                const forced = readOptions.force === true;
                                const reading = await balanceCacheOf().readStale(req.provider, accountId, 
                                // ⚠️ 槽里必须带凭据：`fetchBalanceReading` 靠它发请求
                                //    （`entry.credential === undefined` ⇒ 直接抛「凭据未提供」）。
                                { credential: await resolveCredentialForCache(accountId) }, { force: forced });
                                if (reading.value === undefined)
                                    return undefined;
                                return {
                                    balance: reading.value,
                                    stale: reading.stale,
                                    at: reading.at,
                                    ...reading.error === undefined ? {} : { error: reading.error },
                                };
                            },
                        },
                    warn: (msg) => ctx.logger?.warn?.(msg),
                });
                // ⚠️ 原「按到期时间分桶的渠道回传 windowDays」逻辑随 buddy /
                //    TRAE / LobsterAI 裁剪删除：本 fork 的 registry 里没有任何
                //    `usesExpiryWindow` 的供应商（marvis 不分桶）⇒ 不回传该字段。
                const value = { accounts: values };
                return { ok: true, value };
            }
            case 'model.list': {
                const req = payload;
                const llm = llmServiceOf(ctx);
                if (llm === undefined) {
                    return { ok: false, error: { code: 'bad-request', message: 'llm 服务不可用' } };
                }
                let models;
                try {
                    models = await llm.listModels(req.provider);
                }
                catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    return { ok: false, error: { code: 'bad-request', message: `读取模型列表失败：${reason}` } };
                }
                // 黑名单直接读账号池的进程内副本：开关写入后无需重建适配器，
                // 下一次 listModels 就会应用新的过滤结果。
                const disabledMap = pool.listDisabledModels(req.provider);
                // ⚠️⚠️ 「该供应商是否被整体关闭」（Gitee issue IKP8OF）：意图为真时
                // **每一条**模型都要显示成「已关闭」—— 与 `provider.status` 的 `closed`
                // 同一判据，否则两处自相矛盾（分组说关了、逐条开关都说开着）。
                // 纯内存同步读，零 IO（本端点已有同样的性能约束）。
                const providerClosed = pool.providerClosedFor(req.provider);
                // ⚠️ `llm.listModels()` 返回的目录**已被适配器过滤掉黑名单**：所有适配器
                // 的 listModels 内部都会实时 `filter(m => !disabledModelsFor(provider).has(m.id))`。
                // 若直接对这个结果回填 disabled，就形成闭环矛盾——`disabledMap` 里的键恰好是
                // `models` 中已被移除的那些元素，`.map()` 永远匹配不到它们，被关闭的
                // 模型连同它的开关一起从设置页消失，用户**再也无法重新打开**（只能手工
                // 编辑 settings.yaml）。这正是「关掉后彻底找不到该模型」的根因。
                //
                // 因此设置页的目录必须以**未过滤**的全量为准：
                // - 优先用适配器提供的 `listAllModels()`（不套黑名单，且带**最终展示名**，
                //   含倍率与同名消歧）；
                // - 它不存在时（外部/旧适配器）退化为「listModels 结果 + 黑名单补回裸 id」，
                //   此时关闭项只能显示 id（历史行为）。
                //
                // ⚠️ 展示名必须来自**不套黑名单**的全量目录而非裸 id：用户报障
                // 「关闭的就没有显示倍率，关闭的应该也显示倍率」—— 根因正是补回时只有
                // id 可用。适配器实例由 `registerJetHubRpc` 的 `modelAdapters` 传入
                // （DSH 的 `ctx.llm` 只保证 `listModels`，不透传自定义方法）。
                // 对话框模型选择器读的仍是过滤后的 `listModels`，可见性行为完全不变。
                const catalogSource = modelAdapters?.[req.provider];
                const all = catalogSource?.listAllModels();
                /**
                 * ⚠️⚠️ **黑名单补回必须以上游目录为界**（真实缺陷，2026-10-27）。
                 *
                 * ## 缺陷形态
                 *
                 * 旧实现无条件把 `disabledMap` 里所有 `true` 的 id 补进设置页目录。
                 * 于是**上游已下架**、但用户曾经关掉过的模型会**永久留在设置页**：
                 * 灰显、能点「打开」，点开却必然 404（实测 `GLM-5` / `glm-5.3-flash`
                 * 回 `InferHub.002002009.404 The model is not registered`）。
                 *
                 * 用户视角：这模型明明还在列表里、开关也能动，为什么一发就失败？
                 * 而它既不是 `dead`（没有阳性请求失败记录）、也不在远端目录里 ——
                 * 两条现有的「可解释」路径都覆盖不到它。
                 *
                 * ## ⚠️⚠️ 判据必须用 `listAllModels()`，**不能用 `models`**
                 *
                 * 这是本修法最容易搞反的一处：`llm.listModels()` 的结果**已被适配器按
                 * 黑名单过滤**（见上方长注释）。若拿它当「在售集合」，那么**每一个被
                 * 用户关掉的在售模型都不在其中** ⇒ 它们会被判成「已下架」⇒ 全部不再
                 * 补回 ⇒ 用户关掉的模型从设置页集体消失、无法重新打开 ——
                 * 那正是本端点**当初要修的那个缺陷**，等于把坑重新挖一遍。
                 *
                 * ⇒ 权威在售集合只能取 **`listAllModels()`**（不套黑名单的全量目录）。
                 * 拿不到它（外部/旧适配器没有该方法）时，**放弃该判据**（照旧补回），
                 * 宁可留着幽灵条目，也不让用户在售模型凭空消失。
                 *
                 * ## ⚠️⚠️ 但「拿得到 `listAllModels()`」**仍然不等于**「拿到了全量目录」
                 * （2026-10-28 修，PR159 首版的缺口）
                 *
                 * 它在**冷缓存 / 远端降级**下返回的是各家**编译期兜底表**，而那是远端
                 * 目录的**子集**（`model-catalog.ts` 的 `cached ?? config.syncCatalog()`；
                 * Issue IKJW33 实测：`cline` 冷缓存只有 **3** 条、远端有 **460** 条）。
                 *
                 * 后果与本修复要治的病**同形但方向相反**：用户关掉的**在售**模型若恰好
                 * 不在兜底表里（例如 codearts 近期新增、只存在于远端的 `glm-5.3` /
                 * `kimi-k3`），会被判成「已下架」⇒ **从设置页彻底消失、再也打不开**。
                 * 命中窗口很实在：远端拉取失败、离线启动、或刚重启还没拉到目录时。
                 *
                 * ⇒ 判据的前置条件必须是**适配器自报「这份目录确认来自远端完整读取」**
                 * （{@link ModelCatalogSource.catalogConfirmedRemote}）。证明不了就放弃判据。
                 * 这条正是本文件注释里那句原则的落地：「判据只能建立在**确认拿到全量目录**
                 * 之上」—— 而「拿得到一份数组」不是「确认拿到全量」。
                 *
                 * | 形态 | 处置 |
                 * |---|---|
                 * | 自报确认远端 + `listAllModels()` 非空 | 补回时只补**仍在其中**的（本次要修的） |
                 * | 自报**未**确认远端（false / 未实现） | **放弃判据**，照旧补回（保守；其余 14 家的默认行为） |
                 * | `listAllModels()` 不可用（`undefined`） | 同样放弃判据 |
                 * | 它返回空数组 | 同样放弃判据（空目录 = 无账号门控，不是「全部下架」） |
                 *
                 * ⚠️ 判据只能建立在「确认拿到全量目录」之上。拿「读不到」反推「已下架」
                 * 正是本仓库 `dead-model-store.ts` 头注释明令禁止的「从残缺目录反推」。
                 *
                 * ⚠️ **不删用户数据**：这里只是**不显示**已下架条目，`disabledMap` 里的
                 * 记录原样保留 —— 万一上游把模型重新上架，开关状态还在（用户不必重设）。
                 */
                // ⚠️ 探测本身抛错一律按「未确认」处理（保守方向：宁可多留一个幽灵条目）。
                let confirmedRemote;
                try {
                    confirmedRemote = catalogSource?.catalogConfirmedRemote?.();
                }
                catch {
                    confirmedRemote = undefined;
                }
                const onSale = confirmedRemote === true && all !== undefined && all.length > 0
                    // ⚠️ 取**两个来源的并集**（与 `fullCatalogIds` 同口径）：`listModels` 是
                    //    被黑名单过滤过的远端目录，`listAllModels` 是不套黑名单的那份 ——
                    //    任一来源里有它，就不能说它已下架。
                    ? new Set([...models.map((model) => model.id), ...all.map((model) => model.id)])
                    : undefined;
                const stillOnSale = (id) => onSale === undefined || onSale.has(id);
                let catalog;
                if (all !== undefined) {
                    catalog = [...all];
                    // 全量目录里若仍有黑名单命中却缺失者，一并补上（保底，正常不会发生）。
                    const known = new Set(catalog.map((model) => model.id));
                    for (const id of Object.keys(disabledMap)) {
                        if (disabledMap[id] === true && !known.has(id) && stillOnSale(id)) {
                            catalog.push({ id, name: id });
                        }
                    }
                }
                else {
                    const listedIds = new Set(models.map((model) => model.id));
                    const filteredOut = Object.keys(disabledMap)
                        .filter((id) => disabledMap[id] === true && !listedIds.has(id));
                    catalog = [
                        ...models.map((model) => ({ id: model.id, name: model.name })),
                        // 这些模型已被适配器过滤掉，拿不到原始 name，回退为 id。
                        ...filteredOut.map((id) => ({ id, name: id })),
                    ];
                }
                // ⚠️⚠️ 「已失效模型」必须**显式列出且可恢复**（2026-10-06 复审 !66 实测）。
                //
                // 背景：`withDeadModelPruning` 会把已失效模型从 `listModels` / `listAllModels`
                // 两侧剔除，于是它既不在 `all` 里、也不在 `disabledMap` 里 —— 上面的两条
                // 补回路径都救不回它。结果是**模型从设置页彻底消失，连开关都摸不着**，
                // 用户永远无法自行恢复（这正是上文 `withDeadModelPruning` 处列为必须避免的根因：
                // 「用户再也无法重新打开」）。
                //
                // ⇒ 这里把 dead 表里的 id 补回目录，并带上 `dead: true` 让客户端灰显 +
                // 提供「重新显示」入口（`model.clearDead`）。**方向必须与黑名单相反**：
                // 失效模型**永远**列出（哪怕被用户关着），否则用户没有恢复路径。
                const dead = deadModelIdsFor(req.provider);
                if (dead.size > 0) {
                    const known = new Set(catalog.map((model) => model.id));
                    for (const id of dead) {
                        if (!known.has(id))
                            catalog.push({ id, name: id });
                    }
                }
                const value = {
                    models: catalog.map((model) => ({
                        id: model.id,
                        name: model.name,
                        // ⚠️⚠️ **「供应商整体关闭」意图为真 ⇒ 每条都显示为已关闭**（IKP8OF）。
                        // 否则设置页与 `provider.status` 自相矛盾：分组说「已关闭」，
                        // 而这里每条开关都显示「已打开」（意图关闭的模型**不在**黑名单里，
                        // 那正是本 issue 的成因）。用户据此会以为开关坏了。
                        // ⚠️ 打开任意一条即清除意图（见 `AccountPool` 的三个打开入口），
                        //    故这里的「全关」显示是**可操作**的，不是死状态。
                        disabled: providerClosed || disabledMap[model.id] === true,
                        // ⚠️ **照实透传**：缺失即 false，**不推导**（黑名单命中也算用户主动关的，
                        // 不是失效）。客户端据它灰显并显示「重新显示」按钮。
                        dead: dead.has(model.id),
                        // ⚠️ 免费标记**照原样透传，缺失就不写**（不编造 `false`）：Jet Hub 的
                        // 模型列表按「计费/来源」分组，把「适配器没报」当成「按量计费」是
                        // 保守归组，但字段本身仍保持「未知」语义（与全仓约定一致）。
                        ...model.isFree === undefined ? {} : { isFree: model.isFree },
                    })),
                };
                return { ok: true, value };
            }
            // 打开/关闭某个模型。写入后**不重建适配器**：适配器的 listModels 每次
            // 都直接读账号池的黑名单，因此下一次调用即返回新目录。
            //
            // ⚠️ 但「适配器立刻返回新目录」**不等于**「界面立刻更新」—— 客户端把
            // `modelCatalog` 的响应缓存在带 `status === 'ready'` 短路的 store 里，
            // 只在转发事件上失效（详见下方 emit 的注释）。不广播就等于开关只写进了
            // 磁盘、界面一直显示旧目录。
            case 'model.setDisabled': {
                const req = payload;
                if (typeof req.provider !== 'string' || typeof req.modelId !== 'string' || req.modelId.length === 0) {
                    return { ok: false, error: { code: 'bad-request', message: 'provider 与 modelId 必填' } };
                }
                // ⚠️ 目录必须在写入**之前**读：关闭一个目录内的模型后，它会被
                // `listModels()` 过滤掉，写完再读就把它误判成「不在目录」。
                // ⚠️ 黑名单**不在这里取** —— `readableCatalogIds` 会在 `await` 之后
                //    自己读（理由见其注释：提前取会与写入时刻错开、导致误报「没有变更」）。
                const { known } = await readableCatalogIds(ctx, pool, modelAdapters, req.provider);
                await pool.setModelDisabled(req.provider, req.modelId, req.disabled === true);
                ctx.logger.info(`[jet-hub] ${req.disabled === true ? '关闭' : '打开'}模型 ${req.provider}/${req.modelId}`);
                // 必须广播：否则开关只写进磁盘、界面一直显示旧目录（成因见该函数注释）。
                broadcastCatalogChanged(ctx);
                // ⚠️⚠️ 用户主动改目录相关的设置 ⇒ 该 provider 的目录读数**立即**失效，
                // 否则要等满 20 分钟才看到效果（规格 §6 的正确性要求，不是优化）。
                // ⚠️ 必须排在**写入之后**：失败路径（参数校验 `return`、或上面写入抛错）
                // 一个字都没改，此时失效只会白打一次上游。
                // ⚠️ `model.setDisabledMany`（按分组批量开关）**也已接线** —— 它是同一类
                // 写入端点（同一张黑名单），不接线的症状与单条开关逐字相同。
                invalidateCatalogCache(req.provider);
                const disabledModels = pool.listDisabledModels(req.provider);
                // ⚠️⚠️ **静默空操作必须留痕**（Issue IKJW33）：对已从上游目录消失的 id
                // 开关时，旧实现返回「成功」却什么都没发生、且零警告。写入语义不变，
                // 只在响应里补 warnings 说明真相（判据与取舍见 `catalogWarnings`）。
                const warnings = catalogWarnings(known, req.provider, [req.modelId], req.disabled === true);
                if (warnings.length > 0)
                    ctx.logger.warn(`[jet-hub] ${warnings.join(' ')}`);
                const value = {
                    provider: req.provider,
                    disabledModels,
                    ...warnings.length > 0 ? { warnings } : {},
                };
                return { ok: true, value };
            }
            /**
             * 把模型从「已失效」表里移除，让它重新出现在目录中。
             *
             * ## 为什么必须有这个端点（2026-10-06 复审 !66 确认）
             *
             * 失效记录的唯一自愈路径是 TTL 过期（默认 30 天）—— 因为模型被剔除后用户
             * **选不到**，不可能靠「再成功一次」触发清除。所以**误判一次 = 该模型被
             * 藏 30 天且用户毫无办法**，这与 Jet Hub 已有的模型开关完全不对等
             * （用户能一键关，却不能一键复活）。
             *
             * ⚠️ **不动黑名单**：`disabledModels` 是用户主动选择，失效表是系统推断，
             * 两者必须分开清除 —— 否则「重新显示」会顺带打开用户特意关着的模型。
             *
             * ⚠️ `modelId` **没有默认值**：传 `""`/非字符串一律拒绝（避免字段名写错
             * 导致「静默清空全表」）。省略该字段才是「清空该 provider 全部」。
             */
            case 'model.clearDead': {
                const req = payload;
                if (typeof req.provider !== 'string' || req.provider.length === 0) {
                    return { ok: false, error: { code: 'bad-request', message: 'provider 必填' } };
                }
                if (req.modelId !== undefined && (typeof req.modelId !== 'string' || req.modelId.length === 0)) {
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: 'modelId 必须是非空字符串，或省略以恢复全部' },
                    };
                }
                const removed = clearDeadModels(req.provider, req.modelId);
                // 必须广播：与三个开关端点同约定，否则客户端目录（`llm/adapters-updated`
                // 三个触发源之一）不复位，用户点了「重新显示」界面却不动。
                broadcastCatalogChanged(ctx);
                // ⚠️ 用户主动改了目录相关的设置 ⇒ 该 provider 的目录读数**立即**失效
                //（规格 §6 的正确性要求，见 `invalidateCatalogCache`）。排在写入之后。
                invalidateCatalogCache(req.provider);
                ctx.logger.info(`[jet-hub] 恢复 ${removed} 个失效模型：${req.provider}`
                    + `${req.modelId === undefined ? '' : `/${req.modelId}`}`);
                const value = {
                    provider: req.provider,
                    deadModels: [...deadModelIdsFor(req.provider)],
                };
                return { ok: true, value };
            }
            /**
             * 批量打开/关闭**指定的一批**模型（Jet Hub 模型列表里「按分组」的
             * 本组全开 / 本组全关）。
             *
             * ⚠️ **不能复用 `model.setAllDisabled`**：那个的范围是「该 provider 的
             * 全部模型」，且打开方向会清空整张黑名单（含用户特意关着的其它组）。
             * 分组开关只动本组的 id，故服务端需要一个「按子集清除」的路径
             * （`AccountPool.clearModelsDisabled`）。
             *
             * 与另外两个开关端点同约定：`disabled` 不做默认值猜测、只落盘一次、
             * 只广播一次（逐条调用会写 N 次文档、广播 N 次）。
             */
            case 'model.setDisabledMany': {
                const req = payload;
                if (typeof req.provider !== 'string' || req.provider.length === 0
                    || !Array.isArray(req.modelIds)
                    || typeof req.disabled !== 'boolean') {
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: 'provider、modelIds（数组）与 disabled（布尔）必填' },
                    };
                }
                // 去重 + 剔除非字符串/空串：前端按组传 id，重复项或脏值只会白写一次文档。
                const ids = [...new Set(req.modelIds.filter((id) => typeof id === 'string' && id.length > 0))];
                if (ids.length === 0) {
                    return { ok: false, error: { code: 'bad-request', message: 'modelIds 不能为空' } };
                }
                // 同单条端点：目录必须在写入**之前**读（关闭方向会让 `listModels()`
                // 过滤掉这些 id）；黑名单由 `readableCatalogIds` 在 `await` 之后自取。
                const { known, catalog } = await readableCatalogIds(ctx, pool, modelAdapters, req.provider);
                if (req.disabled) {
                    /**
                     * ⚠️⚠️ **关闭方向必须补设「供应商关闭」意图**（本仓补丁，2026-11-05）。
                     *
                     * ## 缺陷形态（与 `model.setAllDisabled` 的 IKP8OF 同一个症状的**第三个入口**）
                     *
                     * 宿主的「供应商开关」与 `provider.status` 是**两套持久语义**：
                     *
                     * - 开关写的是「黑名单 + 关闭意图」两份状态；
                     * - `provider.status` 的 `closed` 判据是 `total > 0 && disabled === total`
                     *   （`total` 取自 `listAllModels()`，**含被过滤掉的 id**）。
                     *
                     * 本端点原实现只写黑名单、**从不落意图**。于是：
                     *
                     * 1. 模型列表弹窗把该家**全部**模型按「未勾选」全传进来 ⇒ 黑名单写满全量；
                     * 2. 此刻 `provider.status` 报 `closed: true`（`disabled === total`），
                     *    但 `providerClosed[provider]` 仍是 `false`；
                     * 3. 用户看到「全部已关闭」，点「打开供应商」—— 走
                     *    `clearModelsWithProviderClosed`，它按**意图**决定清哪家 ⇒ 清不到；
                     * 4. 弹窗重新打开，34 个模型仍全显示「已在 Jet Hub 关闭」、勾选数 0；
                     * 5. 再点保存 ⇒ 又全传一次。**死循环，用户没有任何出口。**
                     *
                     * 实测（2026-11-05，本机）：黑名单 29 家 / 1005 条全 `true`，而
                     * `providerClosed` 只有 2 家（那两家恰好是账号全停用、走
                     * `provider.setEnabled(false)` 关闭的）。历史备份从 830 → 920 → 1005
                     * 一路上涨，说明每保存一次就把当时目录里的全部模型加进黑名单。
                     *
                     * ## 判据：黑名单**覆盖该家全量目录** ⇒ 语义上等价于「关闭供应商」
                     *
                     * ⚠️ **必须用 `catalog.ids`（`fullCatalogIds` 的纯净并集）**，
                     *    不能用 `known` —— 后者已经把黑名单里的 id 并回去了（为了清理历史
                     *    死键），拿它判「全量覆盖」**恒真**，等于「关一个模型就关掉整个
                     *    供应商」。两者不可混用，见 `readableCatalogIds` 的 `@returns`。
                     *
                     * ⚠️ **目录不完整（`complete === false`）时不猜** —— 宁可少设一次
                     *    意图，也不能拿残缺目录把供应商误关掉（与 `setAllDisabled` 的同名
                     *    守卫同源）。`catalog.ids.length > 0` 同理防「空目录 ⇒ every 恒真」。
                     *
                     * ⚠️ **未覆盖全量时走原路径，一个字节都不变** —— 用户只是关掉了某几个
                     *    分组，那与「关闭供应商」是两件事（`setAllDisabled` 的
                     *    `closeProvider` 注释也这么写：模型级批量关闭不得顺带关供应商）。
                     *
                     * ⚠️ **黑名单与意图必须同一次落盘** —— `writeModelsWithProviderClosed`
                     *    内部合并好两份状态后只 `queueStoreSave()` 一次；分两次写会留下
                     *    「黑名单满了、意图没写」的半套状态，重启后静默复发。
                     */
                    const disabledBefore = pool.listDisabledModels(req.provider);
                    const after = { ...disabledBefore };
                    for (const id of ids)
                        after[id] = true;
                    const coversAll = catalog.complete
                        && catalog.ids.length > 0
                        && catalog.ids.every((id) => after[id] === true);
                    if (coversAll) {
                        // ⚠️ 本仓改动（2026-11-05）：第三参是「**目标意图**」，**不要**写死 `true`。
                        //
                        // `closeProvider: false` 是模型列表屏传的，语义是「只关这家的模型、
                        // 供应商保持打开」⇒ 对应 `writeModelsWithProviderClosed` 的三态
                        // `'keep'`（**不动** `providerClosed` 那个键）。
                        //
                        // ⚠️ 不能直接传 `false`：`false` 的实现是
                        // `delete providerClosed[provider]`，会**主动删掉**用户先前用
                        // 「关闭供应商」设下的意图 —— 与「不动」是两回事（2026-11-04 真机
                        // 报障：「更新插件后停用的供应商被启用了」，见 `writeModelsWithProviderClosed`
                        // 里 `'keep'` 那一态的注释）。
                        //
                        // ⚠️ 与 `setAllDisabled` 的 `closeProvider` 同一条契约：两个入口写的是
                        // 同一张黑名单，不给这条就会出现「同一份黑名单状态经两个入口得到不同
                        // 意图」，随后打开任意模型时又被清掉，状态反向跳变。
                        const closeProvider = req.closeProvider !== false;
                        await pool.writeModelsWithProviderClosed(req.provider, ids, closeProvider ? true : 'keep');
                        ctx.logger.info(`[jet-hub] ${req.provider} 的黑名单已覆盖全量目录（${catalog.ids.length} 个），`
                            + (closeProvider
                                ? '同时落「供应商关闭」意图'
                                : '不动「供应商关闭」意图（closeProvider: false）'));
                    }
                    else {
                        await pool.setModelsDisabled(req.provider, ids);
                    }
                }
                else {
                    await pool.clearModelsDisabled(req.provider, ids);
                }
                ctx.logger.info(`[jet-hub] ${req.disabled ? '关闭' : '打开'} ${req.provider} 的 ${ids.length} 个模型（按分组）`);
                // 与其它开关端点一致：必须广播，否则界面一直显示旧目录。
                broadcastCatalogChanged(ctx);
                // ⚠️ **本处是 brief 那 6 处之外的同一类写入端点**（第 7 处）：
                //    它写的是同一张黑名单（只是按分组批量），用户点「本组全关」之后
                //    同样会撞上「最坏等满 20 分钟」—— 不接线的症状与单条开关**逐字相同**。
                //    刻意补上（brief 的 6 处是“已核实到行”的清单，不是“只许这 6 处”）。
                invalidateCatalogCache(req.provider);
                const disabledModels = pool.listDisabledModels(req.provider);
                // 与单条端点同约定：目录外的 id 必须留痕（Issue IKJW33）。
                const warnings = catalogWarnings(known, req.provider, ids, req.disabled);
                if (warnings.length > 0)
                    ctx.logger.warn(`[jet-hub] ${warnings.join(' ')}`);
                const value = {
                    provider: req.provider,
                    disabledModels,
                    ...warnings.length > 0 ? { warnings } : {},
                };
                return { ok: true, value };
            }
            /**
             * 批量打开/关闭某 provider 的全部模型（Jet Hub 模型列表的
             * 「打开全部 / 关闭全部」）。
             *
             * 两个方向的语义**刻意不对称**（需求明确规定）：
             *
             * - `disabled: true`（关闭全部）：按**当前目录**逐项加入黑名单，故需要读
             *   模型目录。目录优先取适配器的 `listAllModels()`（不套黑名单的全量目录，
             *   与 `model.list` 同源），缺失时退化为 `llm.listModels()`。
             * - `disabled: false`（打开全部）：直接清空该 provider 的黑名单条目，
             *   **不读目录** —— 这样「曾被关闭、后来从服务端目录里下线」的历史遗留键
             *   才能被清掉（按目录删的话它们永远留在配置里）。
             *
             * 为什么不做成前端循环调用 `model.setDisabled`：那会发 N 次请求、写 N 次
             * 完整文档、广播 N 次 `llm/adapters-updated`，且中途失败会留下「关了一半」
             * 的黑名单。批量端点只落盘一次、只广播一次。
             */
            case 'model.setAllDisabled': {
                const req = payload;
                // ⚠️ `disabled` **不做默认值猜测**：缺失或非布尔一律拒绝。默认成 true 会
                // 让一次字段名写错的前端改动静默关闭用户全部模型；默认成 false 则反向
                // 静默打开 —— 两个方向都是灾难性且难察觉的。
                if (typeof req.provider !== 'string' || typeof req.disabled !== 'boolean') {
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: 'provider 与 disabled（布尔）必填' },
                    };
                }
                /**
                 * 全量目录（关闭方向用它写黑名单；两个方向都用它算 `warnings`）。
                 *
                 * ⚠️ 打开方向**不读目录**（见该分支的注释：目录故障时用户仍应能全打开）⇒
                 * `catalog` 在打开方向可能是 `undefined`，`warnings` 随之为空 —— 这是
                 * **正确**的（打开方向的 warnings 只在「这个 id 已从上游消失」时才有意义，
                 * 而那恰恰需要目录才能判定）。
                 */
                const catalog = req.disabled
                    ? await fullCatalogIds(ctx, modelAdapters, req.provider)
                    : undefined;
                if (req.disabled && catalog !== undefined) {
                    // 关闭全部：先取全量目录，再一次性写入黑名单。
                    // ⚠️⚠️ **判据顺序是语义的一部分**，五条分支按「能否在目录不完整时
                    // 安全作答」从强到弱排列（下面逐条给理由，别重排）：
                    //
                    // 1. **远端读失败**（超时/抛错/无 llm 服务）⇒ 拒绝且不落盘。
                    //    瞬态故障下拿兜底子集写黑名单正是 IKJW33 修的「显示已关闭而几百个
                    //    模型仍可选」—— 这个守卫**原样保留**。
                    if (catalog.remoteError !== undefined) {
                        return {
                            ok: false,
                            error: {
                                code: 'bad-request',
                                message: `没有可关闭的模型：${catalog.remoteError}`,
                            },
                        };
                    }
                    // 2. **并集为空** ⇒ 适配器目录里都没有该 provider 的模型，真没东西可关。
                    //    文案与 `provider.setEnabled` 的同名分支**逐字同构**。
                    if (catalog.ids.length === 0) {
                        return {
                            ok: false,
                            error: {
                                code: 'bad-request',
                                message: '该供应商没有可关闭的模型，未做任何变更',
                            },
                        };
                    }
                    const disabledBefore = pool.listDisabledModels(req.provider);
                    const pending = catalog.ids.filter((id) => disabledBefore[id] !== true);
                    // 3. ⚠️⚠️ **幂等短路：并集里的 id 已全部在黑名单里 ⇒ 无事可做，直接成功**
                    //    —— 此时**不需要**完整目录也能安全作答（什么都不写，就不存在
                    //    「写出不完整黑名单」的风险）。
                    //
                    //    为什么必须有这条（真实缺陷，2026-08）：`complete` 的定义是「远端读到
                    //    且**非空**」，而「**全部模型都已关闭**」时 `listModels()` 会被黑名单
                    //    过滤成 `[]`（`createModelCatalog.listModels` 的
                    //    `listed = all.filter(entry => !disabled.has(entry.id))`）⇒
                    //    `complete === false`。于是用户在**已经全关**的状态下再点一次
                    //    「关闭全部」（或在模型列表里确认一下），会得到
                    //    「该供应商没有可关闭的模型」——而它明明有 N 个、只是都已关。
                    //    ⚠️ 该形态与「无账号门控」在 `fullCatalogIds` 里**完全同形**
                    //    （都是 `remoteIds === []` 且无 `remoteError`），**无法**靠目录侧区分，
                    //    故判据只能建在「黑名单已覆盖并集」这个**结果**上。
                    //    ⚠️ 前端联动路径会命中它：停用最后一个账号时问「是否同时关闭它的
                    //    全部模型」，若模型此前已全关，用户会看到误导告警
                    //    「账号已停用，但关闭模型失败：该供应商没有可关闭的模型」。
                    if (pending.length === 0) {
                        ctx.logger.info(`[jet-hub] ${req.provider} 的全部 ${catalog.ids.length} 个模型本就已关闭，无变更`);
                    }
                    else if (!catalog.complete && req.closeProvider === false
                        && catalog.notReady === undefined) {
                        /**
                         * ⚠️⚠️ **模型列表屏的「全关」在「供应商没有账号」时不能拒绝**（2026-11-04 真机报障）。
                         *
                         * 症状（用户原话「部分供应商全关按钮异常」）：模型列表屏上 Codeoly (Unity)
                         * 明明显示「5 个 · 已关闭 0」、五个开关全蓝，点「全关」却报
                         * 「该供应商没有可关闭的模型，未做任何变更」——**界面与报错自相矛盾**。
                         *
                         * 成因：该供应商**没有登录账号** ⇒ `llm.listModels()` 被目录门控成 `[]`
                         * ⇒ `complete = remoteIds.length > 0 = false` ⇒ 落到「目录不完整 ⇒ 拒绝」。
                         * 而界面上那 5 个模型来自适配器**兜底表**（`adapterIds`），`catalog.ids`
                         * 本来就是这 5 个 —— 用户要关的正是它们。
                         *
                         * 为什么这一格**可以**放行（与 IKJW33 不矛盾）：
                         * - IKJW33 的缺陷形态是「写完整黑名单 + 落**关闭意图**」⇒ `provider.status`
                         *   此后报「已关闭」，而上游其实还有几百个模型可选。本分支落的是
                         *   `closeProvider === false`（模型列表屏**从不**写意图，见下面 else 分支
                         *   的注释）⇒ `provider.status` 仍按同一份兜底表算「5 个 · 已关闭 5」，
                         *   **状态与事实一致**。
                         * - 用户看不到的模型不会被误报成已关闭；将来登录后新增的模型仍是打开的，
                         *   用户可以再点一次「全关」。
                         *
                         * ⚠️ **`notReady` 一格必须排除**：那是「远端读到了、但目录还没推导完」
                         * （聚合冷启动），此时「可见项」本身是残的，写黑名单会把状态搞错。
                         * ⚠️ `remoteError`（分支 1 已拦）不放行：那是真的读失败，重试可能就好，
                         * 不该写下一份可能残缺的黑名单。
                         */
                        // ⚠️ 第三参是 `'keep'` **不是** `false`（2026-11-04 修）：
                        //    `false` 的语义是「删掉该供应商已有的关闭意图」，而本屏从不设置
                        //    意图 ⇒ 传 `false` 会**删除用户在别处设好的关闭状态**
                        //    （用户报障「关闭供应商后随更新变回启用」就是这个）。
                        await pool.writeModelsWithProviderClosed(req.provider, pending, 'keep');
                        ctx.logger.info(`[jet-hub] 关闭 ${req.provider} 的 ${pending.length} 个模型`
                            + '（目录不完整：该供应商未登录或远端无可读目录，只关当前可见项、不动供应商关闭意图）');
                    }
                    else if (!catalog.complete) {
                        // 4. **有新增项但目录不完整** ⇒ 拒绝且不落盘。
                        //    ⚠️ 必须排在幂等短路**之后**：先判它会让第 3 条那个正常形态
                        //    被误拒（即上面记的那个真实缺陷）。而判据仍用 `complete`
                        //    （不是 `ids` 是否为空）—— 冷缓存下兜底表会让并集看起来非空，
                        //    而它只是**子集**，据此写黑名单正是本 issue 的原始缺陷。
                        //    ⚠️ 文案与 `provider.setEnabled` **逐字同构**：`remoteError` 有值
                        //    = 「**读不到**」（已在第 1 条拦下）；无值 = 「**没账号**」（去登录）。
                        // ⚠️⚠️ **冷帧必须与「无账号」分开说**（二审 P2-1，行为级探针 S4b 实测）：
                        //    `notReady` 有值 = 聚合目录**还在后台推导**，用户动作是「等一下再点」；
                        //    而「没账号」的动作是「去登录」。两者动作不同 ⇒ 文案不能合并，
                        //    否则冷帧下界面明明列着 5 个模型、报错却说「没有可关闭的模型」。
                        //    `provider.setEnabled` 早就分开说了（见它自己的 `notReady` 分支），
                        //    本端点此前漏了 —— 同一份数据、两个端点、两套文案。
                        if (catalog.notReady !== undefined) {
                            return {
                                ok: false,
                                error: {
                                    code: 'bad-request',
                                    message: `聚合目录尚未读取完成（${catalog.notReady}），`
                                        + '为避免只关闭一部分模型，本次未做任何变更。请稍后重试。',
                                },
                            };
                        }
                        return {
                            ok: false,
                            error: {
                                code: 'bad-request',
                                message: '该供应商没有可关闭的模型，未做任何变更',
                            },
                        };
                    }
                    else {
                        // ⚠️⚠️ **「关闭全部模型」也必须落「关闭意图」**（Gitee issue IKP8OF，
                        // 对抗审计打穿：这是同一症状的**第二个入口**）。
                        //
                        // 判据是**语义同构**：作者已把「逐条关光 ⇒ 算已关闭」列为必须保留的
                        // 既有语义（`provider.status` 的派生腿 + 反向用例）。那么
                        // 「一次性关光全部」是同一语义的**批量形态**，它同样必须抗目录增长 ——
                        // 否则用户点「关闭全部模型」后，目录一变长就翻回「已打开」且新模型可选，
                        // 而点「关闭供应商」不会。**两个按钮给出不同的持久语义**，且无任何提示。
                        //
                        // ⚠️ 与关闭方向同理，**黑名单与意图必须同一次落盘**
                        //   （见 `writeModelsWithProviderClosed` 的注释：分两次会留下半套状态）。
                        //
                        // ⚠️⚠️ **但「是否落意图」由 `closeProvider` 决定**（2026-10-21 合并审计
                        //   发现，阻断级）：默认 `true` 保持既有语义（「关闭全部模型」≡
                        //   「关闭该供应商」），而**模型级**的批量关闭（PR !120 的「模型列表」
                        //   统一管理屏）传 `false` ⇒ 只改黑名单、不落意图。
                        //
                        //   ⇒ 否则用户在模型列表屏点一次「全关」（只想关这家模型）会把**整个
                        //   供应商**也关掉（`provider.status` 报 closed、选择器里一个模型都没有）
                        //   ；再打开**任意一个**模型，供应商又被顺带打开（`setModelDisabled` 的
                        //   打开方向会清意图）⇒ 两头都与用户意图相反，且**零提示**。
                        // ⚠️⚠️ 第三参 **`'keep'` 而不是 `false`**（2026-11-04 真机报障修复）。
                        //
                        // 上一行的注释说的是「**不落**意图」，而 `false` 的实现是
                        // **`delete providerClosed[provider]`** —— 两回事：
                        // - 「不落」= 不设置；
                        // - `false` = **主动删除**用户已经设好的意图。
                        //
                        // 用户报障的完整链条（实测现场：`providerClosed` 只剩 `{accio:true}`）：
                        // ```
                        // ① 点「关闭供应商」 ⇒ providerClosed={X:true} + 全量黑名单  ← 本来稳定
                        // ② 之后在模型列表屏对 X 点一次「全关」 ⇒ 本行传 false ⇒ 意图被删
                        // ③ 插件更新 / 目录变长 ⇒ 派生判据 disabled!==total ⇒ 翻回「启用」
                        // ```
                        // ⇒ 用户看到「关闭过的供应商自己变回启用」，且无任何提示。
                        await pool.writeModelsWithProviderClosed(req.provider, pending, req.closeProvider !== false ? true : 'keep');
                        ctx.logger.info(`[jet-hub] 关闭 ${req.provider} 的 ${pending.length} 个模型`
                            + (req.closeProvider !== false ? '' : '（不动供应商关闭意图）'));
                    }
                }
                else {
                    // 打开全部：纯本地操作，不读目录 —— 目录故障时用户仍应能把开关全打开。
                    // ⚠️ `clearDisabledModels` 内部会清「关闭意图」（见 `AccountPool` 的三个
                    // 打开入口收口），故这里不需要额外调用。
                    await pool.clearDisabledModels(req.provider);
                    ctx.logger.info(`[jet-hub] 打开 ${req.provider} 的全部模型`);
                }
                // 只广播一次：批量不等于逐条广播。
                broadcastCatalogChanged(ctx);
                // ⚠️ 用户主动改了目录相关的设置 ⇒ 该 provider 的目录读数**立即**失效
                //（规格 §6 的正确性要求，见 `invalidateCatalogCache`）。
                // ⚠️ 排在**所有失败 `return` 之后**：上面四条拒绝分支一个字都没写，
                // 那时失效只会白打一次上游。
                // ⚠️ 命中「本就已全部关闭」的幂等短路时也照样失效一次 —— 那是用户点了一个
                // 开关、期望看到最新的代价（一次上游目录读取），比「界面纹丝不动」划算。
                invalidateCatalogCache(req.provider);
                /**
                 * ⚠️⚠️ **本端点的 `warnings` 恒为空，这是正确的**（2026-10-21 合并审计定论）。
                 *
                 * ⚠️ 合并审计最初建议「批量路径也调 `catalogWarnings`」—— **实测证明那是死代码**：
                 * `catalogWarnings` 的判据是「`ids` 里不在 `known` 的」，而本端点传的 `ids`
                 * 本就是 `catalog.ids`，而 `readableCatalogIds` 的 `known` 是
                 * `new Set(catalog.ids)` **并回黑名单** ⇒ `known ⊇ catalog.ids` **恒成立**
                 * ⇒ `missing` 恒为空 ⇒ warnings 恒 `[]`。
                 *
                 * ⇒ 而这正是**语义正确**的：批量关闭的对象是「目录里的全部模型」——它们
                 * **本来就在目录里**，不存在「关了但没有效果」的那个 id（那是**逐条开关**
                 * 的语义）。所以批量路径**无事可警告**。
                 *
                 * ⚠️ 不能把它拿来给「已下架的模型」报警：失效模型被 `withDeadModelPruning`
                 * 剔除、但 `model.list` 又把它们补回目录（带 `dead:true`）⇒ 它们**不在**
                 * `catalog.ids` 里 ⇒ **不会**被这个批量关闭涉及。
                 *
                 * ⚠️ 故客户端读 `result?.warnings` 在这条路径上恒空是**正确的**（无事可警）。
                 */
                const value = {
                    provider: req.provider,
                    disabledModels: pool.listDisabledModels(req.provider),
                };
                return { ok: true, value };
            }
            /**
             * 读取多个供应商的汇总状态（Jet Hub 左侧导航分组 + 一键开关据此渲染）。
             *
             * 为什么一次取全部：8 个供应商若逐个查，就是 16 次往返，且每次都要走
             * 异步凭据解析。这里**默认全程只用同步的内存副本**，不产生网络请求：
             * - 模型目录用 `modelAdapters[provider].listAllModels()`（同步；它内部
             *   在冷缓存时会**后台**补拉，但不阻塞本次返回）；
             * - 账号用 `pool.listAccountsByProvider()`（同步读内存）。
             *
             * ⚠️ **不得**改用 `pool.listAccounts()` —— 那个方法会对每个账号调
             * `credentials.describe()`（异步 IO），8 个供应商逐个解析凭据会明显
             * 拖慢设置页首屏，而我们**只需要计数**，不需要凭据状态。
             *
             * 适配器缺失（外部/旧适配器）时 `total = 0`、`closed = false`：
             * 保守判为「未关闭」，让用户可以尝试操作，而不是误报成已关闭。
             *
             * ⚠️ **唯一的例外是「关闭意图」**（Gitee issue IKP8OF）：用户**确实点过**
             * 「关闭供应商」时，意图为真 ⇒ `closed: true`，即使适配器已缺失、`total = 0`。
             * 这不是误报 —— 用户明确关过它，报「已关闭」才是如实。而且这种形态
             * **可以自救**：前端 `providerSwitchState` 对 `closed === true` 一律允许点击
             * （见该函数里「已关闭优先于没有模型可关」那条注释），点一下就清意图。
             * ⇒ 不要按「适配器缺失 ⇒ 恒 false」写用例：那条不变式**已经不再成立**。
             *
             * ## ⚠️⚠️ `closed` 必须只走「安全方向」，故它在必要时**会去核实一次**
             *
             * `listAllModels()` 在**冷缓存**下返回各家**编译期兜底表**（子集），
             * 而 `closed = total > 0 && disabled === total` 是**基于那个子集**算的
             * ⇒ 子集可能**误报已关闭**（真实缺陷，独立审计实测）：
             *
             * ```
             * 兜底表 [hy3]（冷缓存） + 黑名单 { hy3: true }（旧版本「关闭全部」写下的）
             * ⇒ total=1, disabled=1 ⇒ closed:true
             * 而远端还有 glm-5.2 / deepseek-v4-flash 可选 ⇒ 界面显示「已关闭」却仍能选
             * ```
             *
             * ⚠️ 危险方向**只有 `closed: true` 这一个**：报 false 是安全的（用户可点开关，
             * 点了会得到明确错误）。故这里**只在子集判据说「已关闭」时才去核实**
             *（用 `fullCatalogIds` 取并集）：
             *
             * - 核实成功 ⇒ 用并集重算 `total` / `disabled` / `closed`；
             * - 核实不了（远端读失败 / 为空）⇒ **保守报未关闭**（安全方向），
             *   与「适配器缺失」同一取舍。
             *
             * ⚠️ 这样**常见路径零网络**：绝大多数供应商是「未关闭」，子集判据
             * 直接给 false、不触发核实（冷缓存下也不触发）。只有**真的可能已关闭**
             * 的供应商才付一次目录读取；缓存已热时那次读是纯内存的。
             * ⚠️ 代价：**只有真的可能已关闭**的供应商才付一次目录读取；缓存已热时
             * 那次读是纯内存的。并发后总时长与家数**无关**（见阶段 2 的注释）。
             */
            case 'provider.status': {
                const req = payload;
                if (!Array.isArray(req.providers) || req.providers.some((id) => typeof id !== 'string')) {
                    return { ok: false, error: { code: 'bad-request', message: 'providers 必须是字符串数组' } };
                }
                const statuses = {};
                // ⚠️⚠️ **三阶段：先同步算出「谁需要核实」，再并发核实，最后生成状态**
                //（2026-11-05 三审端到端 P1-1）。原先是一个 `for` 里逐家
                // `await fullCatalogIds(...)`，而该调用最长 2000ms
                //（`CATALOG_READ_TIMEOUT_MS`）⇒ 28 家全关时**串行 56194ms**（实测）。
                // 症状：插件更新/重启后首次打开设置页，供应商开关整片灰显
                //（`reason: '状态尚未读取'`）最长 50 秒，期间分组不生效、之后突然重排，
                // **全程零提示**。
                //
                // ⚠️ `fullCatalogIds` 是**幂等**的读（只读目录与黑名单，不写本仓库的
                //    状态、不广播），故并发安全。⚠️ 它**不是**「纯读」——冷缓存下会写
                //    models.dev 的**磁盘缓存**（`src/models-dev-cache.ts` 的
                //    `writeFile` + `rename`）并发网络请求；那份缓存的并发由模块级在途槽
                //    + `RemoteCatalogGate` 去重保证（2026-11-05 四审并发 P1-2 更正：
                //    原注释自称「纯读」，与实现不符）。
                //    每家的 2s 预算不变，总时长从 `N × 2s` 降到 `≤ 2s`。
                // ⚠️ 判据只写一份（`computePlan`）：循环与预取共用它，避免两处漂移
                //    （本仓库「一文件两套同义判据」是红线）。
                const computePlan = (provider) => {
                    const catalog = modelAdapters?.[provider]?.listAllModels();
                    let total = catalog?.length ?? 0;
                    // ⚠️ `listAllModels()` **不带 disabled 字段**，故必须另取黑名单再按 id 计数。
                    const disabledMap = pool.listDisabledModels(provider);
                    let disabled = 0;
                    if (catalog !== undefined) {
                        for (const model of catalog) {
                            // 与 `disabledModelsFor` 的判定对齐：只有显式 true 才算已关闭。
                            if (disabledMap[model.id] === true)
                                disabled++;
                        }
                    }
                    let closed = total > 0 && disabled === total;
                    // ⚠️⚠️ **双腿取或**（Gitee issue IKP8OF）：上面那条是**派生**判据
                    //（目录里的每一条都在黑名单里），它有一个致命弱点 —— 目录**变长**时
                    // 新 id 不在黑名单里 ⇒ `closed` 翻回 `false` ⇒ 供应商静默回到「已打开」，
                    // 而新模型**仍可选**。
                    //
                    // 实测（真实 `ClineAdapter` + 真实 `AccountPool` 走完整 RPC 链路；
                    // 关闭那一刻 models.dev 未就绪 ⇒ 目录 3 条，恢复后补齐到 7 条）：
                    // ```
                    // 关闭后   {total:3,disabled:3,closed:true}
                    // 补齐后   {total:7,disabled:3,closed:false}   ← 缺陷：开关翻回「已打开」
                    // 而选择器里多出 4 条可选                        ← 真正的危害
                    // ```
                    //
                    // 「关闭**意图**」（`providerClosedFor`）与目录快照无关，故它管住
                    // 「目录增长」这一半；派生判据管住「用户逐条关光也算关闭」这一半
                    //（既有语义，有既有用例锁定，**不能**丢）。
                    //
                    // ⚠️ **不能只用意图**：用户在模型列表里逐条打开该供应商的模型后，
                    //    意图若仍为 `true` ⇒ 界面显示「已关闭」而模型**全部可选**
                    //    —— 正是 IKJW33 修过的矛盾态。故打开方向必须清除意图
                    //（见 `AccountPool` 的三个打开入口，它们在类内收口）。
                    const closedByIntent = pool.providerClosedFor(provider);
                    // ⚠️⚠️ **意图为真 ⇒ 计数也必须按「全部已关闭」报**（不只是 `closed`）。
                    //
                    // 否则设置页会出现自相矛盾的一屏：分组说「已关闭」，而模型列表里
                    // 每一条的开关都显示「已打开」（`disabled` 计数只数了黑名单，
                    // 而意图关闭的模型**不在**黑名单里 —— 那正是本 issue 的成因）。
                    // 用户据此会以为「开关坏了」。
                    //
                    // ⚠️ 但 `total` **不变**：它是目录条数（契约：不套黑名单的全量），
                    //    前端 `providerSwitchState` 的「`total === 0` ⇒ 禁用」判据依赖它。
                    if (closedByIntent) {
                        closed = true;
                        disabled = total;
                    }
                    return { total, disabled, closed, closedByIntent };
                };
                // 阶段 2：**并发**核实（只对「派生判据为已关闭且无意图」的家发请求）。
                // ⚠️ 「空 id 不进结果」：它不可能对应任何 provider，留着只会让前端多一个
                //    无意义的键（前端按 PROVIDERS 取，多出来的键会被忽略，但脏数据不该产生）。
                const planMap = new Map();
                for (const provider of req.providers) {
                    if (provider.length === 0)
                        continue;
                    planMap.set(provider, computePlan(provider));
                }
                const verifyMap = new Map();
                await Promise.all([...planMap]
                    .filter(([, plan]) => plan.closed && !plan.closedByIntent)
                    .map(async ([provider]) => {
                    // ⚠️ 走 single-flight：同一 provider 的在飞核实只发一次请求
                    //（2026-11-05 四审端到端 P2-1，见 `verifyCatalogOnce`）。
                    verifyMap.set(provider, await verifyCatalogOnce(provider));
                }));
                // 阶段 3：应用核实结果并生成状态。
                for (const provider of req.providers) {
                    const plan = planMap.get(provider);
                    if (plan === undefined)
                        continue;
                    let { total, disabled, closed } = plan;
                    /** 核实腿没能证明「已关闭」时的原因（见 `ProviderStatus.verifyFailed`）。 */
                    let verifyFailed;
                    // ⚠️⚠️ 只有「即将报已关闭」才核实（危险方向，见方法头）。
                    // ⚠️ 意图为真时**跳过核实**：核实是为了「证明目录里每一条都关着」，
                    //    而意图已经把整家关掉了 ⇒ 核实既无必要，还会因一次远端抖动
                    //    把 `closed` 翻回 false（正是本 issue 的形态）。
                    if (closed && !plan.closedByIntent) {
                        // ⚠️ 阶段 2 已按同一判据预取，但**判据写了两份**（那边的 `filter`
                        //    与这里的 `if`）⇒ 将来任何人在阶段 1 加一个 `continue` 就会
                        //    「该核实却没预取」⇒ 这里必须显式处理 `undefined`
                        //（2026-11-05 四审并发 P2-3；改用 `!` 会在下面 `full.notReady`
                        //  处抛 `TypeError`，把一次读状态变成 500）。
                        const full = verifyMap.get(provider);
                        if (full === undefined)
                            continue;
                        // ⚠️⚠️ **判据是「远端读成功」，不是 `complete`**：`complete` 额外要求
                        // 远端**非空**，而这里恰好有一个**正常**的空形态 ——
                        // 「全部模型都已关闭」时 `listModels()` 被黑名单过滤成 `[]`
                        //（实测：这正是本端点要正确回答的那个状态！）。
                        // 若这里用 `complete`，一关全就永远核实不了、`closed` 恒为 false
                        // ⇒ 「关闭供应商」后界面永远显示未关闭（本修复第一版踩过，
                        // 两条既有用例当场变红）。
                        // ⚠️ 而「无账号门控」（真的看不到）时远端也是 `[]`，两者**同形**；
                        // 此时并集只剩适配器兜底表，`disabled` 会按它算 —— 因为
                        // `closed` 的判据是「子集里全部命中」，若兜底表全命中就仍报已关闭。
                        // 这是可接受的：兜底表全关 + 远端看不到 ⇒ 用户确实没有可选模型。
                        if (full.notReady !== undefined) {
                            // ⚠️⚠️ **适配器自报「目录还没读全」⇒ 报安全方向**（Critical）。
                            //
                            // 与 `provider.setEnabled` 同一个根因（`fullCatalogIds` 的第 3 种形态），
                            // 但**用户后果不同**：那边是「只关掉一部分却报成功」，这边是
                            // 「只关掉 `auto`，整个『聚合』在设置页被标成**已关闭**」。
                            // 控制方实测（Task 7 之后）：
                            // ```
                            // provider.status = {"total":1,"disabled":1,"closed":true,"verified":"ok（远端 0 条）"}
                            // 改前形态        = {"total":1,"disabled":1,"closed":false,"verified":"remoteError：超时"}
                            // ```
                            // 改后核实「成功」但只见到 `auto` ⇒ `closed=true`（**危险方向**），
                            // 而另外两个虚拟模型仍可选 —— 界面与事实相反。
                            //
                            // ⚠️⚠️ 这一格与下面的 `remoteError` **必须分开**（2026-11-05 四审
                            // 端到端 P1-1 与三审 P1-2 的裁决）：
                            // - `notReady` 是**适配器确定性地**说「我这份目录不全」⇒ 此时
                            //   「派生判据说全关」**不构成证据**（它只见到一个子集）⇒ 必须报
                            //   `closed:false`。这个判断**不随上游抖动翻转**（它是适配器自己
                            //   的就绪状态），故没有「28 家一起翻」的问题。
                            // - `remoteError` 是**瞬态网络故障**（429 / 502 / 超时）⇒ 本地
                            //   证据（目录快照 + 黑名单）**一个字都没变**，变的只是「远端
                            //   读不到」⇒ 保留派生判据（见下面 else 分支的长注释）。
                            verifyFailed = full.notReady;
                            closed = false;
                        }
                        else if (full.remoteError === undefined) {
                            total = full.ids.length;
                            // ⚠️⚠️ 黑名单必须在**这一刻**重读（2026-11-05 四审并发 P1-1）。
                            //
                            // 原实现用阶段 1 的快照（`plan.disabledMap`），理由是「黑名单与
                            // 目录必须来自同一时刻」。方向对，但**取错了那一时刻**：
                            // 阶段 1 在**所有**核实之前跑完，而 `total` 来自**全部**核实
                            // 之后 ⇒ 窗口从「该家一次读取（≤2s）」**放大**成「阶段 1 剩余
                            // + 全部核实」。可复现（两供应商，p1 核实期间把 m3 移出黑名单）：
                            // ```
                            // 改前 p2 = {"total":3,"disabled":2,"closed":false}  ✅ 安全
                            // 改后 p2 = {"total":3,"disabled":3,"closed":true}   ❌ 报已关闭而
                            //                                                      m3 已可选
                            // ```
                            // 现在两者紧挨着取 ⇒ 窗口 = 两次同步调用之间的**零 await**。
                            const disabledMap = pool.listDisabledModels(provider);
                            disabled = full.ids.filter((id) => disabledMap[id] === true).length;
                            closed = total > 0 && disabled === total;
                        }
                        else {
                            // ⚠️⚠️⚠️ **瞬态远端故障时绝不改写 `closed`**（2026-11-05 四审端到端 P1-1）。
                            //
                            // 三审（`9b2f93a`）这里原本是 `closed = false`，理由是「保守报
                            // 未关闭是安全方向」。**该结论已被真实链路实测推翻**：
                            //
                            // 真实 UI 载荷是 `model.setAllDisabled({closeProvider:false})`
                            //（`plugin-src/client/jet-hub.js:7757-7761`）⇒ **永不写关闭意图**
                            // ⇒ 每次读状态都走核实腿。于是**任何一次上游瞬态故障**
                            //（429 / 502 / 超时 > 2s）都会把「派生判据说已关闭」的**全部**
                            // 供应商一起翻成 `closed:false`。实测 28 家同时关闭：
                            // ```
                            // 健康目录：        closed===true  = 28/28
                            // 目录 429（2ms）： closed===false = 28/28   ← 界面「全部开启」
                            // 502 / 超时 2100ms：同上
                            // ```
                            // 而 `groupProviders`（`plugin-src/client/provider-toggle.js:42-55`）
                            // 只读 `closed === true` ⇒ 28 家整片从「已关闭」组跳到「已打开」组
                            // = 用户报障的「有时候全部开启 / 全部关闭」。
                            //
                            // ⇒ 正确语义：**「核实不了」只意味着「我无法证明它已关闭」，
                            //    不意味着「它没关闭」**。此时保留派生判据的结论（`closed` 与
                            //    `disabled`/`total` 都来自**同一个**本地快照，三者自洽），
                            //    只用 `verifyFailed` 附注「本次未能核实」。
                            //
                            // ⚠️ 保留 `closed:true` 会不会「危险」（界面说已关闭而模型可选）？
                            //    本格的触发条件是**远端读失败**，而目录快照与黑名单一个字都没变
                            //    ⇒ 若目录真的变长了，那一次**成功**的核实会给出 `closed:false`
                            //（见上面 `total = full.ids.length` 那一支）。即：只有「读到了
                            //    新目录」才允许改判 —— 与 `notReady` 那一格刻意不同。
                            //
                            // ⚠️⚠️ **前端在这一格**拿不到**原因**（2026-11-05 对抗审计 P2-3）：
                            //    `providerSwitchState` 的第一条 `if (status.closed === true)`
                            //    **先短路** ⇒ 本格 `closed:true` + `verifyFailed` ⇒ 前端渲染成
                            //    「已关闭、可点开」，**`reason` 为 null** ⇒ 悬停看不到「本次没核实成」。
                            //    （`notReady` 那一格不同：它报 `closed:false` ⇒ 走下面那条
                            //    「核实失败 ⇒ 禁用 + 原因」分支 ⇒ 原因可见。）
                            //    ⇒ 这里**刻意**保留 `closed:true`（界面与分组自洽，见上方注释），
                            //      `verifyFailed` 只作**排障线索**（服务端日志 / 客户端 console），
                            //      **不得**在注释里承诺「前端会渲染成禁用 + 原因」——
                            //      那会是一个不存在的渲染。
                            verifyFailed = full.remoteError;
                        }
                    }
                    const entries = pool.listAccountsByProvider(provider);
                    // ⚠️ 目录健康快照是**可选诊断**（issue IKKZUG 第 5 点）：
                    // 只有目录来自多个外部来源的适配器实现它（目前只有 cline）。
                    // 三条纪律：① 钩子不存在 ⇒ 字段**缺席**（不是空对象，前端按
                    // 「无信息」渲染，不得当成「一切正常」）；② 钩子抛错 ⇒ 吞掉并
                    // 缺席（诊断不得反噬主流程）；③ **不发起任何 IO**（本端点全程只用
                    // 同步内存副本，见本方法的注释）。
                    let catalogHealth;
                    try {
                        catalogHealth = modelAdapters?.[provider]?.describeCatalogHealth?.();
                    }
                    catch {
                        catalogHealth = undefined;
                    }
                    statuses[provider] = {
                        models: { total, disabled },
                        accounts: {
                            total: entries.length,
                            // 与适配器一致的判据：`enabled !== false` 视为启用
                            //（老文档可能缺该字段，缺省语义等同启用）。
                            enabled: entries.filter((entry) => entry.enabled !== false).length,
                        },
                        closed,
                        ...catalogHealth === undefined ? {} : { catalog: catalogHealth },
                        // ⚠️ 字段**缺席**表示「核实成功或未需要核实」；只有「派生判据说已关闭、
                        //    但核实腿没能证明」时才出现（见 `ProviderStatus.verifyFailed`）。
                        ...verifyFailed === undefined ? {} : { verifyFailed },
                    };
                }
                const value = { statuses };
                return { ok: true, value };
            }
            /**
             * 供应商级一键开关（Jet Hub 左侧每个供应商行尾的开关）。
             *
             * ## 语义（用户已确认）
             *
             * - `enabled: false`（关闭）= **关闭它的全部模型** + **停用它的全部账号**；
             * - `enabled: true`（打开）= 清空它的模型黑名单 + 启用它的全部账号。
             *
             * ## ⚠️ 关闭方向的顺序不可颠倒：先关模型，再停账号
             *
             * 「是否已关闭」的判据是**模型是否全关**（见 `provider.status` 的 `closed`）。
             * 先关模型可保证：即使随后停账号失败，状态判定依然自洽（该供应商确实已关闭），
             * 用户重试一次即可补齐账号。反过来先停账号、再关模型，中途失败会留下
             * 「账号全停用但模型仍可见」的中间态 —— 用户在对话框里还能选到它的模型，
             * 却没有任何可用账号，这正是本次要消除的落差。
             *
             * ## ⚠️ 「不关闭模型就不关闭供应商」
             *
             * 关闭方向必须拿到模型目录：**远端读失败**（`remoteError` 有值）时整个
             * 操作失败，既不落盘也不广播。绝不能「关不掉模型就只停账号」—— 那会让供应商
             * 显示成已关闭而模型其实还在，用户按关闭的预期却仍能选到它。
             * 「远端读到但为空」（无账号门控，`remoteError === undefined`）**不算
             * 读失败**：此时用并集目录照常关闭（见关闭分支内的注释 —— 否则无账号
             * 供应商永远关不掉，且与 `provider.status` 的核实判据不一致）。
             *
             * ## 打开方向不读目录
             *
             * 与 `model.setAllDisabled` 的「打开全部」同理：直接清空黑名单，这样
             * 「曾被关闭、后来从服务端目录下线」的历史遗留键才能被清掉；且目录故障时
             * 用户仍应能把开关全打开。
             */
            case 'provider.setEnabled': {
                const req = payload;
                // ⚠️ `enabled` 不做默认值猜测：缺失或非布尔一律拒绝。默认成 true 会静默
                // 打开用户特意关闭的供应商；默认成 false 则反向静默关闭 —— 两个方向都是
                // 灾难性且难察觉的（与 model.setAllDisabled 同约定）。
                if (typeof req.provider !== 'string' || req.provider.length === 0 || typeof req.enabled !== 'boolean') {
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: 'provider 与非空布尔 enabled 必填' },
                    };
                }
                let modelCount = 0;
                if (req.enabled) {
                    // 打开：清空黑名单（返回被清掉的条目数，供提示）。null 表示本就无关闭项。
                    const cleared = pool.listDisabledModels(req.provider);
                    // ⚠️⚠️ **清黑名单 + 清「关闭意图」必须同一次落盘**（Gitee issue IKP8OF，
                    // 对抗审计打穿的真实窗口）。原先走两步（`clearDisabledModels` → save #1，
                    // `setProviderClosed(false)` → save #2），两次之间磁盘上是
                    // 「黑名单空 + 意图真」；若第二次失败/进程被杀 ⇒ **重启后该供应商的
                    // 模型选择器恒空**（意图真 + 黑名单空），而设置页一条关闭项都没有
                    // ⇒ 用户无从归因。实测 `saves=2`。
                    //
                    // ⚠️ 而这条**危险路径恰好最常见**：只有「黑名单本来就空」时
                    // `clearDisabledModels` 才一次写完；黑名单非空（用户真关过东西、现在要
                    // 打开）时必然两次 —— 正是用户点「打开供应商」的典型情形。
                    await pool.clearModelsWithProviderClosed(req.provider);
                    modelCount = Object.keys(cleared).length;
                }
                else {
                    const catalog = await fullCatalogIds(ctx, modelAdapters, req.provider);
                    // ⚠️⚠️ 判据是「远端读失败」（`remoteError`），**不是** `complete`。
                    //
                    // `complete === false` 覆盖两种形态，只有一种该拒绝：
                    // 1. **远端读失败**（超时/抛错/无 llm 服务，`remoteError` 有值）⇒ 拒绝且
                    //    不落盘。瞬态故障下拿兜底子集写黑名单，正是 IKJW33 修的
                    //    「显示已关闭而几百个模型仍可选」缺陷 —— 这个守卫**原样保留**。
                    // 2. **远端读到但为空**（`remoteError === undefined`；`createModelCatalog`
                    //    对「无已登录账号」的 provider 门控返回 `[]`）⇒ 用并集照常落盘。
                    //    这与 `provider.status` 核实路径的判据一致（它判的也是
                    //    `full.remoteError === undefined` 即「读成功」；其注释已明确：
                    //    「无账号门控」时远端同形为 `[]`，兜底表全关 + 远端看不到
                    //    ⇒ 用户确实没有可选模型，可接受）。
                    //    若这里仍按 `complete` 拒绝，无账号供应商将**永远无法关闭**
                    //    （远端目录按已登录账号门控，不登录永远读到 `[]`），且与
                    //    `provider.status` 在同一文件里形成两套同义判据 —— 本仓库的
                    //    既有处置就是收敛成一套。
                    if (catalog.remoteError !== undefined) {
                        return {
                            ok: false,
                            error: {
                                code: 'bad-request',
                                message: `没有可关闭的模型：${catalog.remoteError}`,
                            },
                        };
                    }
                    // ⚠️⚠️ **第 3 种形态：适配器自报「目录还没读全」⇒ 必须拒绝**（Critical）。
                    //
                    // 判据是 `notReady`（**不是** `complete`、**不是** `remoteError`），理由与
                    // 三段判据的对应关系见 `FullCatalogResult.notReady` 的长注释。
                    //
                    // 这里修的缺陷（Task 7 重新打开，控制方实测）：
                    // ```
                    // setEnabled(false) 结果 = {"written":["auto"],"changedCount":1}   ← 只关了 auto！
                    // 稳态对照       = {"written":["auto","deepseek-v4-1-flash","glm-5-3"],"changedCount":3}
                    // ```
                    // 用户点「关闭聚合供应商」后界面提示「已关闭 1 个模型」并返回 `ok:true`，
                    // 而另外两个虚拟模型**仍可选** —— 该文件 `:6298` 的注释明文禁止这一形态。
                    //
                    // ⚠️ 与「无账号门控照常关闭」**不冲突**：那条针对的是**目录已读全、只是
                    // 里面没有模型**（`remoteIds` 为空但推导跑过了）；这里是「推导压根还没跑
                    // 完」⇒ 拒绝是唯一不撒谎的选择。用户等目录落地后再点一次即可，
                    // 文案如实说明这一点。
                    if (catalog.notReady !== undefined) {
                        return {
                            ok: false,
                            error: {
                                code: 'bad-request',
                                message: `聚合目录尚未读取完成（${catalog.notReady}），`
                                    + '为避免只关闭一部分模型，本次未做任何变更。请稍后重试。',
                            },
                        };
                    }
                    // 远端读到（含为空）但并集为空 ⇒ 适配器目录里都没有该 provider 的
                    // 模型，真没东西可关，拒绝且不落盘。文案与 `model.setAllDisabled`
                    // 的「目录为空」形态逐字同构。
                    if (catalog.ids.length === 0) {
                        return {
                            ok: false,
                            error: {
                                code: 'bad-request',
                                message: '该供应商没有可关闭的模型，未做任何变更',
                            },
                        };
                    }
                    // ⚠️⚠️ 计数必须报「**本次真正改变的**条数」，不是「本次写入的条数」
                    //（真实缺陷，2026-08 审计实测）：
                    // `setModelsDisabled` 是**合并**语义（`perProvider[id] = true`），传入的
                    // 并集里可能有相当一部分**早就关着**了（历史遗留的完整黑名单、
                    // 或用户此前逐条关过）。此时「写入条数」会**少报**用户看到的实际结果 ——
                    // 实测：远端 4 条 / 适配器兜底表 2 条 / 黑名单已有另 2 条 ⇒ 并集 4 条、
                    // 其中 2 条已是 `true`，写完后 4 条全关，而返回 `models: 2`，
                    // 前端 `summarizeProviderToggle` 便播报「已关闭 2 个模型」。
                    // 与 `accounts` 的口径（只算实际变更数，见 `setAccountsEnabled` 的返回）
                    // 对齐后，提示才与用户观察到的结果一致。
                    const disabledBefore = pool.listDisabledModels(req.provider);
                    const pending = catalog.ids.filter((id) => disabledBefore[id] !== true);
                    // ⚠️⚠️ **黑名单与「关闭意图」必须同一次落盘**（Gitee issue IKP8OF）。
                    //
                    // 分两次写（先 `setModelsDisabled`、再 `setProviderClosed`）时，第二次失败
                    // 会留下「磁盘上黑名单已写、意图未写」的半套状态，而内存里意图已是 true
                    // ⇒ 本次会话看起来正常、**重启后静默复发**（目录一变长就翻回「已打开」）。
                    // 实测（把第二次 `replace` 改成抛 `disk full`）：
                    // ```
                    // setEnabled => {ok:false, error:{message:'disk full'}}   ← 用户看到了失败
                    // 磁盘: disabledModels={a:true,b:true} / providerClosed={} ← 半套
                    // ```
                    // ⇒ 用合并写入：要么都落盘、要么都不落盘（与 `queueStoreSave` 的
                    // 「同一份快照」约定同源）。
                    await pool.writeModelsWithProviderClosed(req.provider, catalog.ids, true);
                    modelCount = pending.length;
                    // ⚠️⚠️ **落「关闭意图」**（Gitee issue IKP8OF）：黑名单只是**当时的目录
                    // 快照**，而目录会继续变长（cline 三源异步 + models.dev 可恢复、其余家
                    // 后台刷新器补进上游新模型）⇒ 新 id 不在黑名单里 ⇒ 它们**仍可选**、
                    // 且 `provider.status` 的派生判据翻回「已打开」。
                    //
                    // 本意图与目录快照无关，故它是唯一能覆盖「关闭之后才出现的模型」的判据：
                    // - 选择器：各适配器的 `listModels` 见它即返回 `[]`；
                    // - `provider.status`：见它即报 `closed: true`。
                    //
                }
                // 账号状态**在模型之后**处理（顺序理由见上）。返回实际变更数，
                // 已是目标状态的账号不计入，避免提示夸大成「已停用 N 个」。
                const accountCount = await pool.setAccountsEnabled(req.provider, req.enabled);
                // ⚠️⚠️ **第 8 处**（2026-10-19 复审补齐）：本端点写的是**同一张模型黑名单**
                //   （关闭方向 `setModelsDisabled`、打开方向 `clearDisabledModels`），
                //   症状与单条 `model.setDisabled` 逐字相同 —— 而它此前**漏接线**。
                //   它是 Jet Hub 最显眼的供应商级开关，漏它的代价最大。
                // ⚠️ **必须排在真正写盘成功之后**：上面关闭方向的四条拒绝分支
                //   （`remoteError` / `notReady` / `ids.length === 0` / 参数校验）都**一个
                //   字都没改**，此时失效只会白打一次上游；而那段 `fullCatalogIds` 远端核实
                //   （Task 7 为「只关 auto 却返回成功」的 IKJW33 形态加的守卫）也**不**因
                //   本行而改变行为 —— 失效只发生在成功路径、且只置陈旧不删内容。
                // ⚠️ 放在 `setAccountsEnabled` 之后 ⇒ 连账号侧也一并生效。
                invalidateCatalogCache(req.provider);
                // 两个方向都改变 listModels 的结果（关/开黑名单），**必须广播**，
                // 否则对话框的模型选择器要重启才更新（成因见 broadcastCatalogChanged）。
                broadcastCatalogChanged(ctx);
                ctx.logger.info(`[jet-hub] ${req.enabled ? '打开' : '关闭'}供应商 ${req.provider}：`
                    + `${req.enabled ? '清空' : '变更'} ${modelCount} 个模型、`
                    + `${req.enabled ? '启用' : '停用'} ${accountCount} 个账号`);
                const value = {
                    provider: req.provider,
                    enabled: req.enabled,
                    models: modelCount,
                    accounts: accountCount,
                };
                return { ok: true, value };
            }
            // ── 供应商自定义显示顺序（「供应商开关」弹窗的拖拽排序）──
            case 'provider.getOrder': {
                // 与 provider.status 同级的轻量读取：池内进程内存副本，无任何 IO。
                const value = { order: pool.providerOrder() };
                return { ok: true, value };
            }
            case 'provider.setOrder': {
                const req = payload;
                if (!Array.isArray(req?.order) || req.order.some(id => typeof id !== 'string')) {
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: 'order 必须是字符串数组' },
                    };
                }
                // ⚠️ 与 account.reorder 不同：这里**不校验**「必须恰好等于当前供应商
                // 清单」——展示侧（provider-toggle.js 的 sortOpenProvidersByOrder）对
                // 数组中不认识 / 缺失的 id 都有稳定兜底，并发下列表过期也不需要让用户
                // 重试，接受最后一次拖拽的结果即可。
                await pool.setProviderOrder(req.order);
                ctx.logger.info(`[jet-hub] 已更新供应商自定义显示顺序（${req.order.length} 项）`);
                return { ok: true, value: undefined };
            }
            // ── 聚合 provider 的设置面板（`src/aggregate-adapter.ts`）──
            //
            // ⚠️ 接线复用 `modelAdapters` 形参，**不新增形参**：`registerJetHubRpc` 是
            //    位置传参，其形参列表有成文警告「历史上已因少传/插队错位复发 6 次」，
            //    而 `aggregate` **没有 auth 服务**（无账号/无凭据/无续期）⇒ 它不该占一个
            //    `XxxAuth` 形参位（那会逼 15 个调用点补 `undefined` 占位）。
            //    聚合适配器实例本来就在 `modelAdapters[AGGREGATE_PROVIDER]` 里。
            case 'aggregate.catalog': {
                const source = modelAdapters?.['aggregate'];
                if (source?.describeCatalog === undefined) {
                    return {
                        ok: false,
                        error: { code: 'unavailable', message: '聚合 provider 未注册或未提供目录' },
                    };
                }
                // ⚠️ 只读 + 零余额查询（规格 §8.3）：describeCatalog 内部不碰 expiryProbe。
                // ⚠️ `force`（可选，默认 false）：面板的「刷新」按钮传 true 以**绕过目录 TTL
                //    缓存**（真实缺陷，对抗审计实测证伪：不传 force 时「刷新」实际是「读 60 秒
                //    缓存」，用户在渠道侧改了模型后点刷新看不到变化）。
                //    只有显式刷新才绕缓存；其余调用方（含 `listModels`）继续走缓存。
                const force = payload?.force === true;
                const catalog = await source.describeCatalog(force, _signal);
                // ⚠️ `orderMode` 与每个模型的 `order` **由 `describeCatalog` 从池里读**（不是这里读）：
                //    两处都读会让「面板显示的排序方式」与「实际用的」在某个时刻分叉。
                //    客户端**不得**重算这两项（红线：同一语义两套判据）。
                const value = catalog;
                return { ok: true, value };
            }
            case 'aggregate.setRejected': {
                const req = payload;
                if (typeof req?.canonicalId !== 'string' || req.canonicalId.length === 0
                    || typeof req.provider !== 'string' || req.provider.length === 0
                    || typeof req.realId !== 'string' || req.realId.length === 0) {
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: 'canonicalId / provider / realId 必填' },
                    };
                }
                await pool.setAggregateRejected(req.canonicalId, req.provider, req.realId, req.rejected === true);
                ctx.logger.info(`[jet-hub] 聚合：${req.rejected === true ? '拒绝' : '恢复'} `
                    + `${req.canonicalId} 的候选 ${req.provider}/${req.realId}`);
                // ⚠️ 清选型缓存：让改动**立刻**生效（虽然缓存键含拒绝表指纹、正确性不依赖
                //    它，但清掉可立即释放内存，并让语义更直白）。
                modelAdapters?.['aggregate']?.clearChoiceCache?.();
                // ⚠️ **额外失效 `aggregate` 自己的目录缓存**（`catalogAt`）——
                //
                // ⚠️⚠️⚠️ **准确的因果（2026-10-19 复审订正 —— 原文那段是错的）**：
                // 复审核实 `refreshCatalog` 的推导链是
                //   `catalogs[provider] = await ctx.llm.listModels(provider)` ⇒
                //   `buildVirtualModels(catalogs)`，
                // 而 `buildVirtualModels`（`aggregate-catalog.ts`）**只读各渠道目录的
                // `id` / `name` 与归一映射** ⇒ **完全不读拒绝表、白名单、顺序表、排序模式**。
                //
                // ⇒ 所以**这一处失效并不是为了让聚合目录重算**（改这三张表，当前实现下
                //   推导结果逐字节相同）。它是为了**语义对齐 / 兜底**：保持
                //   「凡是写入目录或门控相关表的端点都失效」这条规则不破例，万一将来
                //   `buildVirtualModels` 真的开始依赖它们，这里**已经**是对的。
                //
                // ⇒ 那三张表**真实**影响的是：`gateOf` / `rejectedFor`（每次现算、无缓存）、
                //   `pickerNameOf` / `isAllDefaultsUnopened`（每次 `listModels` 现算、无缓存），
                //   以及 `routingFingerprint()` 的键。
                // ⚠️ **而「改这三张表 ⇒ 候选序缓存失效」的**真实**机制是上一行那句
                //   `clearChoiceCache()`**（候选序缓存 = `choiceCache`，60 秒 TTL）——
                //   正确性其实由 `routingFingerprint()` 兜底（缓存键含这三张表的指纹），
                //   `clearChoiceCache` 只是立即释放内存 + 语义更直白。
                //
                // ⚠️ **只失效 `aggregate` 一个**：失效全部渠道会让「改一个开关」连带作废
                // 其余 11 家的目录缓存 ⇒ 用户改一个开关却付出十几个上游请求。
                invalidateCatalogCache(AGGREGATE_PROVIDER);
                const value = {
                    aggregateRejections: pool.listAggregateRejections(),
                    // ⚠️ 必须同时回白名单：面板的逐条开关要按三态显示，只回拒绝表会让白名单条目
                    //    在下一次点击前一直是陈旧值（与 `rejectionsFromCatalog()` 的回填机制同款）。
                    aggregateAllowed: pool.listAggregateAllowed(),
                };
                return { ok: true, value };
            }
            // ⚠️ **本端点当前没有客户端调用者**（对抗审计指出）—— 但**不要删**：
            //    规格 §8.4 明确要求它（「清空（支持按模型或按渠道清）」），是**先定的契约**。
            //    面板目前只提供「逐条开关」（`aggregate.setRejected`），批量清空留作后续
            //    UI（如「全部恢复」按钮）与排障用途。判据：**规格要求 ≠ 死代码**
            //   （与 `vendorOf` 那类零调用者的自造辅助函数不同）。
            case 'aggregate.clearRejected': {
                const req = payload;
                // ⚠️ 省略字段才是「清空该维度」；传了非字符串一律拒绝（避免字段名写错导致
                //    「静默清空全表」—— 与 `model.clearDead` 的 modelId 判据同款）。
                if ((req?.canonicalId !== undefined && typeof req.canonicalId !== 'string')
                    || (req?.provider !== undefined && typeof req.provider !== 'string')) {
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: 'canonicalId / provider 必须是字符串或省略' },
                    };
                }
                await pool.clearAggregateRejected(req?.canonicalId, req?.provider);
                ctx.logger.info('[jet-hub] 聚合：已清空拒绝表（按传入的维度）');
                modelAdapters?.['aggregate']?.clearChoiceCache?.();
                // ⚠️ **第 9 处**（2026-10-19 复审补齐）：兄弟端点 `aggregate.setRejected`
                //   **已**接线，本端点写的是**同一张拒绝表**（只是按维度批量清空）⇒ 按接线
                //   规则属必接线。上一行那句「漏掉任一处的 `clearChoiceCache`」说的正是它。
                // ⚠️ 只失效 `aggregate` 自己（理由见 `setRejected` 那边）。
                // ⚠️ 排在写入之后：上面的 `return` 是 bad-request，一个字都没改。
                invalidateCatalogCache(AGGREGATE_PROVIDER);
                const value = {
                    aggregateRejections: pool.listAggregateRejections(),
                    aggregateAllowed: pool.listAggregateAllowed(),
                };
                return { ok: true, value };
            }
            /**
             * 手工「打开 / 关闭」某条候选是否参与轮换（用户 2026-10-15）。
             *
             * ⚠️ 与 `aggregate.setRejected` 是**同一枚开关的两个方向**，但落在**两张不同的表**上
             *（未接入临期折算的候选归白名单、已接入的归拒绝表 —— 见 `AggregateAllowedMap` 的说明）：
             * 故两个 case 的体例、日志、`clearChoiceCache` 必须**逐条对齐** ——
             * 漏掉任一处的 `clearChoiceCache`/指纹会让改动最多 60 秒后才生效（静默）。
             *
             * ⚠️ **本端点不做两表归一**（用户 2026-10-15 的修正）：写白名单**不得**顺手清拒绝表。
             */
            case 'aggregate.setAllowed': {
                const req = payload;
                if (typeof req?.canonicalId !== 'string' || req.canonicalId.length === 0
                    || typeof req.provider !== 'string' || req.provider.length === 0
                    || typeof req.realId !== 'string' || req.realId.length === 0) {
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: 'canonicalId / provider / realId 必填' },
                    };
                }
                await pool.setAggregateAllowed(req.canonicalId, req.provider, req.realId, req.allowed === true);
                ctx.logger.info(`[jet-hub] 聚合：${req.allowed === true ? '手工打开' : '取消手工打开'} `
                    + `${req.canonicalId} 的候选 ${req.provider}/${req.realId}`);
                modelAdapters?.['aggregate']?.clearChoiceCache?.();
                // ⚠️ 与 `aggregate.setRejected` **逐条对齐**（漏一处两个方向就会不同步）：
                //    额外失效 `aggregate` 自己的目录缓存，且**只**失效它一个（理由见那边）。
                invalidateCatalogCache(AGGREGATE_PROVIDER);
                const value = {
                    aggregateRejections: pool.listAggregateRejections(),
                    aggregateAllowed: pool.listAggregateAllowed(),
                };
                return { ok: true, value };
            }
            /**
             * 写入某虚拟模型的**手工排序**（面板拖动结束时调用，整体提交）。
             *
             * ⚠️ `order` 必须是**字符串数组**：传字符串会被逐字符处理（`String(undefined)` 的同类形态，
             *    本仓库有专门判据）。**不得**接受畸形后静默清空顺序 —— 那等于用户拖完一次顺序就没了
             *   （比报错更糟）。
             * ⚠️ 返回的是**服务端过滤去重后**的权威数组（不是入参回声）⇒ 客户端据此校正本地状态。
             */
            case 'aggregate.setOrder': {
                const req = payload;
                if (typeof req?.canonicalId !== 'string' || req.canonicalId.length === 0
                    || !Array.isArray(req.order)
                    || req.order.some((entry) => typeof entry !== 'string')) {
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: 'canonicalId 必填且 order 必须是字符串数组' },
                    };
                }
                const order = await pool.setAggregateOrder(req.canonicalId, req.order);
                ctx.logger.info(`[jet-hub] 聚合：写入 ${req.canonicalId} 的手工顺序（${order.length} 条）`);
                // ⚠️ 顺序**参与**候选排序 ⇒ 顺序变了缓存里的候选序就失效了（指纹也含它，双保险）。
                modelAdapters?.['aggregate']?.clearChoiceCache?.();
                // ⚠️ 同上：额外失效 `aggregate` 自己的目录缓存，且**只**失效它一个。
                invalidateCatalogCache(AGGREGATE_PROVIDER);
                const value = { canonicalId: req.canonicalId, order };
                return { ok: true, value };
            }
            /**
             * 切换排序模式（顶部 toggle：按临期 / 按手工）。
             *
             * ⚠️ 只接受两个字面量：畸形值若被静默接受，面板会显示「按手工」而宿主按临期路由
             *（显示与行为分叉）。
             */
            case 'aggregate.setOrderMode': {
                const req = payload;
                if (req?.mode !== 'expiry' && req?.mode !== 'manual') {
                    return {
                        ok: false,
                        error: { code: 'bad-request', message: "mode 必须是 'expiry' 或 'manual'" },
                    };
                }
                await pool.setAggregateOrderMode(req.mode);
                ctx.logger.info(`[jet-hub] 聚合：排序模式切换为「${req.mode === 'manual' ? '按手工' : '按临期'}」`);
                modelAdapters?.['aggregate']?.clearChoiceCache?.();
                // ⚠️ **第 10 处**（2026-10-19 复审补齐）：`orderMode` 是
                //   `routingFingerprint()` 的**四项输入之一**（`aggregate-adapter.ts`），
                //   即「改这三张表 ⇒ 候选序缓存失效」的真实机制的一环 ⇒ 按接线规则属必接线。
                // ⚠️ 只失效 `aggregate` 自己（理由见 `setRejected` 那边）。
                invalidateCatalogCache(AGGREGATE_PROVIDER);
                const value = { orderMode: pool.listAggregateOrderMode() };
                return { ok: true, value };
            }
            /**
             * 一键「拒绝非临期」：把所有**未接入临期折算**渠道上的候选恢复成
             * 「默认不参与轮换」的初始态（用户后续仍可逐条手工打开）。
             *
             * ⚠️⚠️ `keepProviders` 必须从 `WIRED_EXPIRY_PROVIDERS` **取引用**，不得在这里写死一份副本：
             *    写死会随「新接入一个渠道」静默漂移 —— 那一键按钮会开始清掉**已接入**渠道的白名单，
             *    而它们的白名单是**有意义**的（用户可能手工打开了某条已接入候选）。
             *
             * ⚠️ 账号池**不该知道**「接入折算」是什么语义：它只收到「保留哪些 provider」的清单
             *   ⇒ 依赖方向仍是「上层知道下层」。这样「谁是未接入渠道」的权威只有那一个常量。
             *
             * ⚠️ `cleared === 0` 也回 `ok: true`：幂等点击**不是错误**（面板据计数决定文案）。
             */
            case 'aggregate.rejectNonExpiring': {
                const { cleared, aggregateAllowed } = await pool.clearAggregateAllowedExcept(WIRED_EXPIRY_PROVIDERS);
                ctx.logger.info(`[jet-hub] 聚合：一键拒绝非临期，恢复 ${cleared} 条候选为默认不参与`);
                modelAdapters?.['aggregate']?.clearChoiceCache?.();
                // ⚠️ **第 11 处**（2026-10-19 复审补齐）：本端点写的是**聚合白名单**
                //   （`clearAggregateAllowedExcept`）⇒ 与 `setAllowed` 同一张表，按接线
                //   规则属必接线（`cleared === 0` 也算一次写入：幂等点击同样是「用户刚
                //   要求过那个状态」，目录该重读一次）。
                // ⚠️ 只失效 `aggregate` 自己（理由见 `setRejected` 那边）。
                invalidateCatalogCache(AGGREGATE_PROVIDER);
                const value = { cleared, aggregateAllowed };
                return { ok: true, value };
            }
            /**
             * 聚合 provider **上次实际转发成功的渠道**（P3，供用量徽标）。
             *
             * ⚠️⚠️ **必须是纯内存读、零网络零余额查询**（规格 §6.3 的 P2）：
             * 徽标在**门控阶段**就要拿到它 —— 重定向必须发生在
             * `supportsCreditBalance` 门控**之前**（那行是既有断言逐字钉住的，不得修改），
             * 而门控阶段是**同步渲染路径**，查网络会让外层渲染抖动（渠道变一次、
             * 徽标闪一次）。
             *
             * ⚠️ 语义是**真实历史**（已发生的转发），**不是预测** —— 不用
             * `pickCurrentAutoProvider`（预测语义 + 有网络成本）。
             *
             * ⚠️ 无历史 ⇒ `{ provider: null }` ⇒ 客户端**不渲染**徽标（规格 §6.3 的 P4）。
             */
            case 'aggregate.activeProvider': {
                const source = modelAdapters?.['aggregate'];
                // ⚠️ 未注册时回 `{ provider: null }` 而**不是**报错：徽标是**可选装饰**，
                //    为它报错会让会话输入区出现无意义的错误（本仓库对「非关键路径失败」
                //    的既有取向是安静降级，见 `usage-badge.js` 的目录解析注释）。
                const canonicalId = payload?.canonicalId;
                const provider = typeof canonicalId === 'string' && canonicalId.length > 0
                    ? (source?.activeProvider?.(canonicalId) ?? null)
                    : (source?.activeProvider?.() ?? null);
                const value = { provider };
                return { ok: true, value };
            }
            /**
             * 「按临期排序」用的候选到期时刻（面板的可选按钮，用户 2026-10-07 选定）。
             *
             * ⚠️⚠️ **这是唯一会做余额探测的面板端点** —— `describeCatalog` 的契约是
             * **零余额查询**（规格 §8.3，有专门用例断言），而「按临期排序」必须探测
             * 才知道顺序。⇒ 分开：面板默认零探测，用户点按钮才走这里。
             *
             * ⚠️ 未注册时回**空表**而不是报错：面板据此保持字母序并提示，
             * 不影响其余功能（与 `aggregate.activeProvider` 的安静降级同取向）。
             *
             * ⚠️ `force`（可选，默认 false，2026-10-15 加）：`true` 时绕过**探针自己的**
             * 折算缓存（{@link EXPIRY_CACHE_TTL_MS} 60 秒）。面板的按临期模式每 5 分钟
             * 自动重探一次、用户手动点也算重探 ⇒ 那两种情形都该拿**新鲜**值，
             * 否则「每 5 分钟刷新」实际是「每 5 分钟读一次 60 秒缓存」（近似无差别，
             * 但用户点「刷新」时期待的是真重查）。
             * 只有显式重探才传 `true`；进入模式时那次传 `false`（省钱）。
             */
            case 'aggregate.expiryOrder': {
                const source = modelAdapters?.['aggregate'];
                const force = payload?.force === true;
                const order = source?.describeExpiryOrder === undefined
                    ? {}
                    : await source.describeExpiryOrder(_signal, force);
                const value = { order };
                return { ok: true, value };
            }
            // ── 本机 OpenAI 网关（`src/openai-gateway/`）──
            case 'gateway.getEnabled': {
                // ⚠️ **每个字段独立降级**：这里是设置页唯一的网关状态来源，任何一个附属
                // 字段采集失败都不该让**整个面板变空白**（开关、地址、密钥全看不到），
                // 更不该把用户挡在「关掉网关」这条自救路径之外。
                // 失败一律降级为 null / []，并在 logger 里带上是哪一步失败的。
                const degrade = async (step, run, fallback) => {
                    try {
                        return await run();
                    }
                    catch (error) {
                        ctx.logger.warn(`[jet-hub] gateway.getEnabled 的「${step}」读取失败，该字段降级为默认值：${String(error)}`);
                        return fallback;
                    }
                };
                const blockedByEnv = await degrade('env 开关', () => !isGatewayEnabled(process.env), true);
                const apiKey = await degrade('API Key', () => gatewayApiKey(), null);
                const address = await degrade('监听地址', () => (blockedByEnv ? null : gatewayAddress() ?? null), null);
                const llm = llmServiceOf(ctx);
                const listed = llm?.listProviders !== undefined
                    ? (() => {
                        try {
                            const value = llm.listProviders();
                            return Array.isArray(value) && value.length > 0 ? value : undefined;
                        }
                        catch {
                            return undefined;
                        }
                    })()
                    : undefined;
                const adapters = Object.keys(modelAdapters ?? {}).map((id) => ({ id }));
                const providers = listed ?? (adapters.length > 0 ? adapters : undefined);
                // 目录来源要让**空状态能自解释**：用户看到空清单时必须能分辨「我没登录」
                // 与「宿主没给出任何可枚举的 provider」。
                const modelsSource = listed !== undefined ? 'catalog' : (adapters.length > 0 ? 'adapters' : 'none');
                const value = {
                    enabled: await degrade('开关状态', () => pool.gatewayEnabled(), true),
                    running: await degrade('运行态', () => isGatewayRunning(), false),
                    blockedByEnv,
                    // 局域网开关与其是否被 env host 覆盖（UI 据此禁用开关并说明原因）。
                    allowLan: await degrade('局域网开关', () => pool.gatewayAllowLan(), false),
                    hostFromEnv: await degrade('env host', () => isGatewayHostFromEnv(process.env), false),
                    // 被 env 停用时即使 `enabled` 为真也不会监听，此时**不**回显地址，
                    // 否则设置页会显示一个根本连不上的 URL。
                    address,
                    // 「期望运行但没监听」的结构化原因（Issue #11 建议 ②）：
                    // `running: false` 本身分不清「用户关的」与「起不来的」。
                    lastError: await degrade('失败原因', () => gatewayLastError(), null),
                    // ⚠️ 明文凭据：只用于设置页展示与复制，**不进日志**。
                    apiKey: apiKey === null
                        ? null
                        : { value: apiKey.value, fromEnv: apiKey.fromEnv, path: apiKey.path },
                    // 有些 agent（如 ZCode）不会主动扫目录，要靠用户手工填 ID，
                    // 故这里把目录一并回传，让设置页内嵌展示。
                    models: await degrade('模型目录', async () => {
                        if (providers === undefined) {
                            // ⚠️ 不能静默返回空：那会让用户以为是自己没登录，而真实原因是
                            // 宿主根本没给出任何可枚举的 provider。modelsSource 会把这件事
                            // 如实带到 UI 上。
                            ctx.logger.warn('[jet-hub] gateway.getEnabled：既取不到 llm.listProviders，也没有任何已注册适配器可作兜底，模型清单为空');
                            return [];
                        }
                        return collectGatewayCatalog(llm, providers, (provider, error) => {
                            ctx.logger.warn(`[jet-hub] ${provider} 模型目录读取失败，已从网关列表跳过：${String(error)}`);
                        });
                    }, []),
                    modelsSource,
                };
                return { ok: true, value };
            }
            case 'gateway.setEnabled': {
                const req = payload;
                // ⚠️ 不做默认值猜测，与 `provider.setEnabled` 同约定：
                // 默认成 true 会静默打开用户特意关闭的网关。
                if (typeof req.enabled !== 'boolean') {
                    return { ok: false, error: { code: 'bad-request', message: '非空布尔 enabled 必填' } };
                }
                // 先落盘再启停：启停失败（端口冲突）不该让已写入的开关回滚成
                // 「看起来没生效」——状态与运行态分开，由 status 的 running 字段区分。
                await pool.setGatewayEnabled(req.enabled);
                setGatewayDesiredEnabled(req.enabled);
                await applyGatewayDesiredState();
                const blockedByEnv = !isGatewayEnabled(process.env);
                ctx.logger.info(`[jet-hub] ${req.enabled ? '打开' : '关闭'}本机 OpenAI 网关`
                    + `${blockedByEnv ? '（已被 DSH_OPENAI_GATEWAY_ENABLED 阻止）' : isGatewayRunning() ? '' : '（未在监听）'}`);
                // 开关切换会创建/销毁实例，密钥随之可能从「尚无」变成「已生成」。
                const key = gatewayApiKey();
                const llm = llmServiceOf(ctx);
                // 刚打开网关 ⇒ 目录可能刚从空变成有值，必须重新采集。
                // ⚠️ 同样不让目录采集拖垮整个响应：它只是回传的附加值。
                const providers = req.enabled ? providerIdsOf(llm, modelAdapters) : undefined;
                const modelsSource = !req.enabled
                    ? 'none'
                    : (llm?.listProviders !== undefined ? 'catalog' : (Object.keys(modelAdapters ?? {}).length > 0 ? 'adapters' : 'none'));
                const models = providers === undefined
                    ? []
                    : await collectGatewayCatalog(llm, providers, (provider, error) => {
                        ctx.logger.warn(`[jet-hub] ${provider} 模型目录读取失败，已从网关列表跳过：${String(error)}`);
                    }).catch((error) => {
                        ctx.logger.warn(`[jet-hub] gateway.setEnabled 的模型目录刷新失败：${String(error)}`);
                        return [];
                    });
                const value = {
                    enabled: req.enabled,
                    running: isGatewayRunning(),
                    blockedByEnv,
                    allowLan: pool.gatewayAllowLan(),
                    hostFromEnv: isGatewayHostFromEnv(process.env),
                    address: blockedByEnv ? null : gatewayAddress() ?? null,
                    // 「期望运行但没监听」的结构化原因（Issue #11 建议 ②）。
                    lastError: gatewayLastError(),
                    apiKey: key === null ? null : { value: key.value, fromEnv: key.fromEnv, path: key.path },
                    models,
                    modelsSource,
                };
                return { ok: true, value };
            }
            /**
             * ── 「允许局域网访问」开关（2026-10-20）──
             *
             * 语义：**开** = 网关绑 `0.0.0.0`（全部网卡，局域网可达）；**关** = 只绑
             * 回环/env 配置的本机地址。⚠️ env 显式给了 `DSH_OPENAI_GATEWAY_HOST` 时
             * 本开关**不生效**（env 是运维口径，优先级更高）——此时仍照常落盘用户的
             * 选择，但日志与 status 的 `hostFromEnv` 会把这件事带回 UI。
             */
            case 'gateway.setAllowLan': {
                const req = payload;
                // ⚠️ 与 `gateway.setEnabled` 同约定：不做默认值猜测 —— 默认成 true 会
                // 静默把网关暴露给整个网络。
                if (typeof req.allowLan !== 'boolean') {
                    return { ok: false, error: { code: 'bad-request', message: '非空布尔 allowLan 必填' } };
                }
                // 先落盘再换绑（与 `gateway.setEnabled` 同序）：换绑失败（端口被旧连接
                // 占用等）不该让已写入的选择回滚成「看起来没生效」。
                await pool.setGatewayAllowLan(req.allowLan);
                setGatewayDesiredAllowLan(req.allowLan);
                await applyGatewayDesiredState();
                const blockedByEnv = !isGatewayEnabled(process.env);
                const hostFromEnv = isGatewayHostFromEnv(process.env);
                ctx.logger.info(`[jet-hub] ${req.allowLan ? '打开' : '关闭'}网关「允许局域网访问」`
                    + `${hostFromEnv ? '（已被 DSH_OPENAI_GATEWAY_HOST 覆盖，本开关不生效）' : ''}`
                    + `${blockedByEnv ? '（网关整体已被 DSH_OPENAI_GATEWAY_ENABLED 停用）' : isGatewayRunning() ? '' : '（网关未在监听）'}`);
                const key = gatewayApiKey();
                const llm = llmServiceOf(ctx);
                // 网关在跑 ⇒ 实例可能刚被重建，目录照 setEnabled 的口径重新采集；
                // 网关没跑（被关/env 停用）时开关只落盘，不采目录。
                const gatewayOn = !blockedByEnv && pool.gatewayEnabled();
                const providers = gatewayOn ? providerIdsOf(llm, modelAdapters) : undefined;
                const modelsSource = !gatewayOn
                    ? 'none'
                    : (llm?.listProviders !== undefined ? 'catalog' : (Object.keys(modelAdapters ?? {}).length > 0 ? 'adapters' : 'none'));
                const models = providers === undefined
                    ? []
                    : await collectGatewayCatalog(llm, providers, (provider, error) => {
                        ctx.logger.warn(`[jet-hub] ${provider} 模型目录读取失败，已从网关列表跳过：${String(error)}`);
                    }).catch((error) => {
                        ctx.logger.warn(`[jet-hub] gateway.setAllowLan 的模型目录刷新失败：${String(error)}`);
                        return [];
                    });
                const value = {
                    enabled: pool.gatewayEnabled(),
                    running: isGatewayRunning(),
                    blockedByEnv,
                    allowLan: pool.gatewayAllowLan(),
                    hostFromEnv,
                    address: blockedByEnv ? null : gatewayAddress() ?? null,
                    // 「期望运行但没监听」的结构化原因（Issue #11 建议 ②）。
                    lastError: gatewayLastError(),
                    apiKey: key === null ? null : { value: key.value, fromEnv: key.fromEnv, path: key.path },
                    models,
                    modelsSource,
                };
                return { ok: true, value };
            }
            // ── 渠道原生搜索总开关（Jet Hub 页头的开关）──
            //
            // 语义：**开** = 支持原生搜索的渠道（CodeBuddy / WorkBuddy）走自己后端的
            // 搜索接口；**关** = 所有渠道一律回官方 DeepSeek 搜索。
            // 消费方是 `src/web-native.ts` 的 `tools/execute` 监听器（经 `index.ts`
            // 传入 `() => pool.nativeWebSearchEnabled()`）。
            case 'nativeSearch.getEnabled': {
                const value = { enabled: pool.nativeWebSearchEnabled() };
                return { ok: true, value };
            }
            case 'nativeSearch.setEnabled': {
                const req = payload;
                // ⚠️ 与 `gateway.setEnabled` 同约定：**不做默认值猜测** ——
                // 默认成 true 会静默打开用户特意关闭的开关。
                if (typeof req.enabled !== 'boolean') {
                    return { ok: false, error: { code: 'bad-request', message: '非空布尔 enabled 必填' } };
                }
                await pool.setNativeWebSearchEnabled(req.enabled);
                // 不刷新任何缓存：监听器是**每次现读** `pool.nativeWebSearchEnabled()`，
                // 写完即生效（没有需要失效的派生状态）。
                ctx.logger.info(`[jet-hub] ${req.enabled ? '打开' : '关闭'}渠道原生搜索`
                    + `${req.enabled ? '' : '（所有渠道改用 DeepSeek 官方搜索）'}`);
                const value = { enabled: pool.nativeWebSearchEnabled() };
                return { ok: true, value };
            }
            // ── 「ZCode 会话负载均衡」总开关（Jet Hub 页头的开关）──
            //
            // 语义：**开** = ZCode 多账号按 DSH sessionId 做会话亲和（同一会话**优先**
            // 落同一账号；账号今日负载达阈值后会被沉底、正在跑的会话会迁移一次），
            // 没有 sessionId 的请求随机分摊；**关** = 回到「手动顺序首个可用账号」的
            // 既有语义。消费方是 `credential-resolver.ts` 与
            // `zcode-adapter.ts` 的选号路径（每次现读 `pool.sessionBalanceEnabled()`）。
            case 'sessionBalance.getEnabled': {
                const value = { enabled: pool.sessionBalanceEnabled() };
                return { ok: true, value };
            }
            case 'sessionBalance.setEnabled': {
                const req = payload;
                // ⚠️ 与 `nativeSearch.setEnabled` 同约定：**不做默认值猜测** ——
                // 默认成 true 会静默打开用户特意关闭的开关。
                if (typeof req.enabled !== 'boolean') {
                    return { ok: false, error: { code: 'bad-request', message: '非空布尔 enabled 必填' } };
                }
                await pool.setSessionBalanceEnabled(req.enabled);
                // 不刷新任何缓存：选号路径**每次现读** `pool.sessionBalanceEnabled()`，
                // 写完即生效（没有需要失效的派生状态）。
                ctx.logger.info(`[jet-hub] ${req.enabled ? '打开' : '关闭'}ZCode 会话负载均衡`
                    + `${req.enabled ? '' : '（ZCode 回到手动顺序优先选号）'}`);
                const value = { enabled: pool.sessionBalanceEnabled() };
                return { ok: true, value };
            }
            // ── 「严格手动顺序」（账号面板上每张渠道卡片一个开关）──
            //
            // 语义：**开** = 拖拽顺序是**唯一**的选号优先级（余额档位退化为「可用 /
            // 不可用」判据，「锁定永久积分」照旧生效）；**关**（缺键默认）= 升级前行为
            // （余额分档优先、档内才看手动顺序）。
            //
            // 消费方是 `credential-resolver.ts` 的分档编排（每次现读
            // `pool.strictManualOrder(providerId)`）。没有它时面板文案
            //「拖动卡片调整排序，按顺序选号」对**走余额分档的渠道**是一句假话 ——
            // 那正是「拖拽时灵时不灵」这条报障的根。
            case 'strictManualOrder.getEnabled': {
                const req = payload;
                if (typeof req?.provider !== 'string' || req.provider.length === 0) {
                    return { ok: false, error: { code: 'bad-request', message: 'provider 必填' } };
                }
                const value = {
                    enabled: pool.strictManualOrder(req.provider),
                };
                return { ok: true, value };
            }
            case 'strictManualOrder.setEnabled': {
                const req = payload;
                if (typeof req?.provider !== 'string' || req.provider.length === 0) {
                    return { ok: false, error: { code: 'bad-request', message: 'provider 必填' } };
                }
                // ⚠️ 与 `sessionBalance.setEnabled` 同约定：**不做默认值猜测** ——
                // 默认成 true 会静默打开用户特意关闭的开关（而本开关会改变选号策略，
                // 静默打开等于用户不知情地开始按拖拽序发请求）。
                if (typeof req.enabled !== 'boolean') {
                    return { ok: false, error: { code: 'bad-request', message: '非空布尔 enabled 必填' } };
                }
                await pool.setStrictManualOrder(req.provider, req.enabled);
                // 不刷新任何缓存：选号路径**每次现读** `pool.strictManualOrder(provider)`。
                ctx.logger.info(`[jet-hub] ${req.enabled ? '打开' : '关闭'} ${req.provider} 的严格手动顺序`
                    + `${req.enabled ? '（选号完全按拖拽序，余额档位只判可用性）' : '（回到余额分档优先）'}`);
                const value = { enabled: pool.strictManualOrder(req.provider) };
                return { ok: true, value };
            }
            // ── 「面板入口」（插件详情页设置卡片里的下拉）──
            //
            // 语义：Jet Hub 的**唯一**入口位置，两个取值严格互斥 ——
            // `'sidebar'` = 主导航（`sidebar.panellist`）里显示「Jet Hub」一行，点它把
            // 页面渲染进中央主面板（`main` 槽的 `jet-hub` key），同时 `settings.section`
            // 那一节注销；`'settings'` = 该行注销，进入路径只剩「设置 → 插件 → Jet Hub」。
            //
            // 消费方是客户端：`plugin-src/client/panel-entry.js` 在 `apply` 里先读一次
            // 本端点，再决定注不注入那两处入口；卡片写回后由同一份进程内副本通知两处
            // 注册逻辑重新求值。
            case 'panelEntry.get': {
                const value = { entry: pool.panelEntry() };
                return { ok: true, value };
            }
            case 'panelEntry.set': {
                const req = payload;
                // ⚠️ 与 `nativeSearch.setEnabled` 同约定：**不做默认值猜测** ——
                // 把非法值当成某个合法值会静默改掉用户的入口。校验表用
                // `PANEL_ENTRY_VALUES`（与 store 的 sanitize 同一份真源），不在这里
                // 另写一套字面量比较。
                if (!PANEL_ENTRY_VALUES.includes(req.entry)) {
                    return { ok: false, error: { code: 'bad-request', message: 'entry 必须是 sidebar 或 settings' } };
                }
                await pool.setPanelEntry(req.entry);
                // 不刷新任何缓存：客户端的注册逻辑读的是**同一个**进程内副本，
                // 写完由客户端自己按返回值（落盘后重读）同步两处 UI。
                ctx.logger.info(req.entry === 'sidebar'
                    ? '[jet-hub] 面板入口：仅侧栏（主导航一行；设置页那一节已注销）'
                    : '[jet-hub] 面板入口：仅设置页（主导航那一行已注销）');
                const value = { entry: pool.panelEntry() };
                return { ok: true, value };
            }
            // ⚠️ 本 fork 裁剪：原版此处有一组「内部 captcha 载体」端点
            //（captcha.demand / captcha.carrierUrl / captcha.contribute，zcode 专用）。
            // marvis 登录不需要 captcha，DSH 客户端（唯一消费方）也已随控制台移除
            // ⇒ 载体链整体摘除（captcha-supply.js / zcode-captcha.js 一并删除）。
            // ── 账号备份（导出 / 导入）──
            //
            // 目的：更换 DSH 版本时迁移账号凭据，以及**单独**把某个账号搬到另一台
            // 机器。备份文件是**自包含**的 JSON（账号索引 + 凭据原文 + 模型黑名单，
            // 见 src/backup.ts），与 DSH 版本无关 —— 导入时按**当前版本**的存储契约
            // 重建，天然跨版本。
            //
            // 安全约定：加密在浏览器侧完成（PBKDF2 + AES-GCM），RPC 只接收/返回
            // 明文载荷；明文 JSON 不经过本层持久化与日志。
            case 'backup.export': {
                const req = (payload ?? {});
                // accountIds 只作用于 accounts / credentials 两个字段；黑名单与锁定表
                // 仍是全量，故产物始终是一份可整体还原的自包含快照。
                const accountIds = Array.isArray(req.accountIds)
                    ? req.accountIds.filter((id) => typeof id === 'string' && id.length > 0)
                    : undefined;
                const result = await exportBackup(pool, ctx.credentials, { accountIds });
                const value = {
                    payload: result.payload,
                    warnings: result.warnings,
                };
                return { ok: true, value };
            }
            // 导入有两种模式：
            // - `replace`（缺省）= 整体替换（还原快照，不是合并）；
            // - `merge` = 只追加，按 id 跳过已存在的账号，不碰黑名单与锁定表。
            // 写入顺序刻意「先凭据、后账号池」：账号池写入成功后，门控
            // （hasLoggedInAccount）与黑名单立即反映新状态；若凭据写入中途失败
            // （非法 ref 等），只跳过该条、不中断整体。
            //
            // ⚠️ 模式必须显式取白名单，不能把请求里的任意字符串透传下去：未知值
            // 会被 importBackup 的 `?? 'replace'` 静默当成整体替换 —— 那时用户以为
            // 只是「加一个账号」，实际账号池被清空，属于不可逆的数据损失。
            case 'backup.import': {
                const req = payload;
                const mode = req?.mode === 'merge' ? 'merge' : 'replace';
                const result = await importBackup(ctx.credentials, pool, req.payload, { mode });
                // 导入会改变账号集合（门控依赖 hasLoggedInAccount）与模型黑名单，
                // 必须广播目录变更，否则界面仍显示旧目录。
                broadcastCatalogChanged(ctx);
                if (mode === 'merge') {
                    ctx.logger.info(`[jet-hub] 合并导入：新增 ${result.accountsImported} 个账号，跳过 ${result.accountsSkipped.length} 个已存在`);
                }
                const value = {
                    credentialsImported: result.credentialsImported,
                    accountsImported: result.accountsImported,
                    accountsSkipped: result.accountsSkipped,
                    skipped: result.skipped,
                    expiredAccounts: result.expiredAccounts,
                    missingCredentials: result.missingCredentials,
                };
                return { ok: true, value };
            }
            // 账号池统计（导入前的覆盖提示用，也供导出弹窗勾选账号）：缺 expiresAt
            // 的条目疑似 DSH 版本切换后自动恢复的产物（反推不读凭据值，故无有效期）。
            // 前端据此在确认导入前提示用户「有 N 个自动恢复的账号将被整体覆盖」，
            // 并在导出时列出可勾选的账号。
            case 'backup.status': {
                const state = pool.getStateSnapshot();
                const value = {
                    accounts: state.accounts.length,
                    withoutExpiry: state.accounts.filter((entry) => entry.expiresAt === undefined).length,
                    // 只给展示字段：凭据内容绝不进这条响应。
                    accountList: state.accounts.map((entry) => ({
                        id: entry.id,
                        provider: entry.provider,
                        nickname: entry.nickname,
                        enabled: entry.enabled,
                    })),
                };
                return { ok: true, value };
            }
            /**
             * 用量徽标读数（会话输入区、模型选择器旁那枚）。
             *
             * ## 与 `credits.balances` 的关系
             *
             * 读数是**同一份**（本分支内部直接复用 `credits.balances` 的实现，见
             * `usageBadge` 的装配注释），差别只有三处：
             * 1. 只返回**启用**账号，并给出 `disabledCount`（停用账号不进合计）；
             * 2. 多带一份订阅读数（窗口 / 套餐），判定表在 `src/badge-subscription.ts`；
             * 3. 带**宿主侧 TTL 缓存**（`cached` 标出来）—— 徽标按分钟轮询，而余额是
             *    逐账号顺序打上游的（`collectCreditBalances` 的「顺序查询，避免并发
             *    触发风控」），不缓存会让上游请求数随轮询线性放大。
             *
             * ⚠️ 未知 provider 的 `bad-request` 由内层 `credits.balances` 给出（那里
             * 已有查表分派与 `unsupported provider` 的统一文案），本分支**原样透传**，
             * 不另立一份 provider 名单 —— 两份名单必然漂移。
             *
             * ⚠️ `force: true` = 绕过缓存（手动刷新、签到之后）。
             */
            case 'usage.badge': {
                const req = payload;
                const provider = typeof req.provider === 'string' ? req.provider.trim() : '';
                if (provider.length === 0) {
                    return { ok: false, error: { code: 'bad-request', message: 'provider 不能为空' } };
                }
                // auto 的「余额」= **临期胜者**的余额（真实缺陷，用户报障 2026-10-06）：
                // auto 自己没有账号也没有余额，徽标若按字面查会显示「用量不可用」。
                // ⇒ 把请求改写给「auto 现在真正会用的那个 provider」。
                //
                // ⚠️ 判定逻辑在 `src/auto-badge.ts` 的 `resolveAutoBadgeRewrite`（**纯函数**）——
                //    本文件 4500+ 行且大量 import，单测无法 import 它的内部逻辑，只能做
                //    源码字符串断言，而**字符串断言是恒真的假用例**（把实现改成
                //    `if (false && …)` 后正则照样命中、用例依然全绿 —— 我实测撞过）。
                //    ⇒ 搬出去后测试可以行为断言（喂不同的 autoState，断言改写结果）。
                const rewrite = await resolveAutoBadgeRewrite(provider, AUTO_PROVIDER_ID, modelAdapters?.[AUTO_PROVIDER_ID]?.autoState?.());
                if (rewrite.kind === 'error') {
                    return { ok: false, error: { code: 'bad-request', message: rewrite.message } };
                }
                const effectiveProvider = rewrite.kind === 'rewrite' ? rewrite.effectiveProvider : provider;
                const value = await usageBadge.read(effectiveProvider, req.force === true ? { force: true } : {});
                // ⚠️ 响应里的 `provider` 必须**改回请求的 provider**（即 auto）：客户端
                // 用它做「这份读数属不属于我」的对号（usage-badge.js 的
                // `value.provider !== provider` 守卫）。原样透传被改写后的 provider 会被
                // 客户端当成「别的渠道的读数」丢弃 —— 表现就是徽标一直停在初始态。
                if (value?.ok === true && value.value !== undefined && rewrite.kind === 'rewrite') {
                    return {
                        ...value,
                        value: {
                            ...value.value,
                            provider,
                            ...(rewrite.autoActual === undefined ? {} : { autoActual: rewrite.autoActual }),
                            ...(rewrite.autoExpiryAt === undefined ? {} : { autoExpiryAt: rewrite.autoExpiryAt }),
                            ...(rewrite.autoPrice === undefined ? {} : { autoPrice: rewrite.autoPrice }),
                        },
                    };
                }
                return value;
            }
            /**
             * **Token 账本**快照（「Token 用量」面板）。
             *
             * 纯内存读（`readTokenLedger`），不打上游、不做任何 I/O —— 面板可以
             * 随意刷新。数据在重启后为空是**既定行为**（第 1 期不持久化），UI 负责
             * 把「进程内存账本」这一事实讲清楚。
             *
             * ⚠️ 这里**不**做渠道/provider 过滤：账本条数上限 500，全量下发即可，
             * 过滤维度（渠道、provider、模型）都由 UI 在聚合树上展开，避免为每个
             * 维度各造一个 RPC 端点。
             */
            case 'usage.tokenLedger': {
                const req = payload;
                const snapshot = readTokenLedger(typeof req?.limit === 'number' && Number.isFinite(req.limit) && req.limit > 0
                    ? { limit: Math.trunc(req.limit) }
                    : {});
                const value = { snapshot };
                return { ok: true, value };
            }
            /**
             * **历史日聚合**（第 4 期 · 「Token 用量」弹窗的历史视图）。
             *
             * 数据源是落盘的日聚合表（`token-ledger.json`，重启保留）—— 纯内存
             * 计算（Map 树 → 数组），不打上游、不做额外 I/O。
             *
             * `sinceDays` 钳制在 `[1, TOKEN_LEDGER_HISTORY_MAX_DAYS]`；也支持 fromDay / toDay
             * 按 UTC+8 日键做闭区间查询。落盘本身只保留 90 天。
             */
            case 'usage.tokenLedgerHistory': {
                const req = payload;
                const raw = req?.sinceDays;
                const sinceDays = typeof raw === 'number' && Number.isFinite(raw)
                    ? Math.min(Math.max(Math.trunc(raw), 1), TOKEN_LEDGER_HISTORY_MAX_DAYS)
                    : undefined;
                const fromDay = isValidTokenLedgerDayKey(req?.fromDay) ? req.fromDay : undefined;
                const toDay = isValidTokenLedgerDayKey(req?.toDay) ? req.toDay : undefined;
                const result = readTokenLedgerHistory(readTokenLedgerDayMap(), { sinceDays, fromDay, toDay });
                const value = { history: result.days, totals: result.totals };
                return { ok: true, value };
            }
            /** 只删除一个 UTC+8 日期的持久化历史累计，不触碰实时明细与其他设置。 */
            case 'usage.tokenLedgerDeleteDay': {
                const req = payload;
                if (!isValidTokenLedgerDayKey(req?.day)) {
                    return { ok: false, error: { code: 'bad-request', message: 'day 必须是有效的 YYYY-MM-DD 日期' } };
                }
                if (!deleteTokenLedgerDay(req.day)) {
                    return { ok: false, error: { code: 'not-found', message: `没有可删除的 ${req.day} 历史用量` } };
                }
                const value = { day: req.day, deleted: true };
                return { ok: true, value };
            }
            /**
             * 用量徽标的显示偏好（读 / 写，**全局一个**，不分渠道）。
             *
             * ⚠️ `preference` 省略时**只读**（徽标首次渲染与设置面板初始化都用它）；
             * 给出时必须是 `auto` / `subscription` / `credits` 之一。
             *
             * ⚠️ 非法值**拒绝**而不是静默回落：回落会让「设置没生效」看起来像
             * 「保存成功」（用户改完刷新，界面仍按旧口径显示，且没有任何提示）。
             * 磁盘脏数据的容错在 `sanitizeBadgePreference`（那条路径面对的不是用户输入）。
             */
            case 'usage.badgePreference': {
                const req = payload;
                if (req.preference === undefined) {
                    const value = { preference: badgePreferences.load() };
                    return { ok: true, value };
                }
                if (!BADGE_PREFERENCES.includes(req.preference)) {
                    return {
                        ok: false,
                        error: {
                            code: 'bad-request',
                            message: `preference 必须是 ${BADGE_PREFERENCES.join(' / ')} 之一（收到：${JSON.stringify(req.preference)}）`,
                        },
                    };
                }
                await badgePreferences.save(req.preference);
                const value = { preference: badgePreferences.load() };
                return { ok: true, value };
            }
            /**
             * 「每日首次启动自动签到」开关（读 / 写，**全局一个**，不分渠道）。
             *
             * ⚠️ `enabled` 省略时**只读**；给出时必须是布尔值。非法值拒绝而不是静默
             * 回落 —— 理由与 `usage.badgePreference` 完全一致（回落会让「设置没生效」
             * 看起来像「保存成功」）。
             *
             * ⚠️ 写入 `true` 时宿主会**立刻尝试跑一轮**（今天已跑过则由执行体内部拦住）：
             * 否则用户今天打开开关要等到明天才有动作，看起来像没生效。返回值里的
             * `running` 会立刻为 `true`，界面据此显示「进行中」。
             */
            case 'usage.autoCheckin': {
                const req = payload;
                /**
                 * 关闭那行**常驻**的自动签到状态文字。
                 *
                 * ⚠️ 与 `enabled` 分开判而不是「先 dismiss 再 enabled」：两者语义独立，
                 * 一次请求只该做一件事 —— 否则 `{ dismiss: true, enabled: true }` 会
                 * 既关文字又改开关，客户端将来误传就难查。
                 */
                if (req.dismiss !== undefined) {
                    if (typeof req.dismiss !== 'boolean') {
                        return {
                            ok: false,
                            error: {
                                code: 'bad-request',
                                message: `dismiss 必须是布尔值（收到：${JSON.stringify(req.dismiss)}）`,
                            },
                        };
                    }
                    if (req.dismiss) {
                        const value = { autoCheckin: await autoCheckin.dismiss() };
                        return { ok: true, value };
                    }
                }
                /**
                 * 写两个执行时刻（`HH:MM`，UTC+8）。
                 *
                 * ⚠️ 与 `enabled` / `dismiss` 一样**一次请求只做一件事**：三类字段同时给出
                 * 时无法分辨「用户到底改了什么」，故**直接拒绝**（`bad-request`）而不是
                 * 静默丢弃后面的字段 —— 静默丢弃会让客户端以为两项都保存成功
                 * （2026-11-01 审计 P3：旧实现只处理 `times` 就 return，`enabled` 与
                 * `dismiss` 被无声吞掉，调用方无从发现）。
                 */
                if (req.times !== undefined || req.jitterMinutes !== undefined) {
                    if (req.enabled !== undefined || req.dismiss !== undefined) {
                        return {
                            ok: false,
                            error: {
                                code: 'bad-request',
                                message: '一次请求只能改一件事：times / jitterMinutes 不能与 enabled / dismiss 同时下发',
                            },
                        };
                    }
                    try {
                        // `times` 与 `jitterMinutes` 是同一次「保存设置」的两个字段：
                        // 客户端关闭面板时一次把它们写全。`times` 省略 = 保留现有时刻。
                        const value = {
                            autoCheckin: await autoCheckin.setTimes(req.times !== undefined ? req.times : autoCheckin.state().times, req.jitterMinutes),
                        };
                        return { ok: true, value };
                    }
                    catch (error) {
                        // 校验失败（数量不对 / 格式非法 / 重复）按 bad-request 回给客户端，
                        // **不静默回落** —— 回落会让用户以为保存成功却永远等不到那轮签到。
                        return {
                            ok: false,
                            error: {
                                code: 'bad-request',
                                message: error instanceof Error ? error.message : String(error),
                            },
                        };
                    }
                }
                if (req.enabled === undefined) {
                    const value = { autoCheckin: autoCheckin.state() };
                    return { ok: true, value };
                }
                if (typeof req.enabled !== 'boolean') {
                    return {
                        ok: false,
                        error: {
                            code: 'bad-request',
                            message: `enabled 必须是布尔值（收到：${JSON.stringify(req.enabled)}）`,
                        },
                    };
                }
                const value = { autoCheckin: await autoCheckin.setEnabled(req.enabled) };
                return { ok: true, value };
            }
            default:
                return { ok: false, error: { code: 'bad-request', message: `unknown method: ${method}` } };
        }
    }
}
/**
 * 构造带 rpcId 的响应 JSON。
 *
 * ⚠️ 失败结果的 `error` 有**两种**形状：`{ code, message }`（正常）与裸字符串
 * （早期几个分支的写法）。后者若直接透传，客户端会看到
 * `{"0":"没","1":"有",…}` ⇒ 拿不到 `code`/`message` ⇒ 抛
 * `connection: invalid server-response failure`（2026-11-09 marvis 真机报障）。
 * ⇒ 这里**统一兜底**成对象：字符串包成 `bad-request`，缺 `details` 的补空对象。
 * 各分支自己的形状保持不变（只是不再能漏到 wire 上）。
 */
function reply(rpcId, result) {
    let value = result;
    if (typeof result === 'object' && result !== null && result.ok === false) {
        const record = result;
        const error = record.error;
        value = {
            ...record,
            error: typeof error === 'string'
                ? { code: 'bad-request', message: error, details: {} }
                : { ...error, details: {} },
        };
    }
    return Response.json({ type: 'server-response', rpcId, result: value });
}
//# sourceMappingURL=jet-hub-rpc.js.map