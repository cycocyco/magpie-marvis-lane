import { credentialRef } from '@deepseek-ai/dsh-credentials';
import Schema from '@deepseek-ai/schemastery';
import { startCatalogPrewarm } from './catalog-prewarm.js';
import { AccountPool } from './account-pool.js';
import { MultiAccountRefreshScheduler } from './refresh-scheduler.js';
import { hasLegacyNamespaceRegistration, settingsOf, suppressAutoSettingsPage } from './settings-compat.js';
import { registerJetHubRpc } from './jet-hub-rpc.js';
import { mountOpenAiGateway } from './openai-gateway/index.js';
import { installLoopResume } from './loop-recovery.js';
import { attachTokenLedgerStore, } from './token-ledger.js';
import { createTokenLedgerStore } from './token-ledger-store.js';
import { configureDeadModelStore, withDeadModelPruning } from './dead-model-store.js';
// 腾讯 Marvis（2026-11-09）。OpenAI 兼容 + OAuth 授权码（QQ / 微信），
// 目录**只有** `main-auto` 一条（上游无目录端点），余额与推理同一个 host。
// 见 `src/marvis-product.ts` / `src/marvis-adapter.ts` 模块头。
import { MarvisAuth } from './marvis-auth.js';
import { MarvisAdapter, registerMarvisLlm } from './marvis-adapter.js';
import { MARVIS } from './marvis-product.js';
import { parseMarvisCredential } from './marvis.js';
import { createProviderCredits, creditsOf } from './provider-credits.js';
import { createProviderOnboarding, onboardingOf } from './provider-onboarding.js';
// ⚠️ `PROVIDER_REGISTRY` 供 namespace 清单派生（`registerProviderSettings` 的实参）；
//    `descriptorOf` 供**能力注册表**逐项取元数据（见下面的注册段）。
import { PROVIDER_REGISTRY, descriptorOf } from './provider-registry.js';
import { registerProviderRuntime, registerBalanceCache, expiryOf, runtimeOf, wiredRefreshTargets } from './provider-runtime.js';
// ⚠️ `createExpiryProbe` 从**底座**导入，不是从 `aggregate-adapter.js`
//（它定义在 `aggregate-expiry.ts`）。
import { createExpiryProbe } from './aggregate-expiry.js';
// ⚠️ 共享余额读数缓存（2026-10-15，规格 §5.7）：装配层建**一个**实例，
//    `credits.balances` 端点与聚合折算共用它。
import { createBalanceCache, createBalanceRefresher, REFRESH_PERIOD_FALLBACK_MS } from './balance-cache.js';
// ⚠️ 模型目录的后台刷新器（用户 2026-10-18 要求：20 分钟定时更新）。
import { createCatalogRefresher } from './model-catalog.js';
// ⚠️ 中止判据复用适配器的**共享实现**（`aggregate-adapter.ts` 的 `isAbortLike`）。
import { isAbortLike as isAbortLikeError } from './aggregate-adapter.js';
import { createProviderExpiry } from './provider-expiry.js';
import { AGGREGATE_PROVIDER, registerAggregateLlm } from './aggregate-adapter.js';
import { AUTO_PROVIDER, registerAutoLlm } from './auto-adapter.js';
export const name = 'codearts-auth';
// `connection` 刻意不列入静态 inject：它只由 Web bundle（dsh-client-connection）
// 提供，headless/CLI profile 里并不存在。静态 inject 会让本插件在那些 profile
// 里永久 pending，进而让整个 profile 以
// "plugin tree failed to load: 1 entry did not activate" 启动失败
// —— chicheng-cron 的 skill/agent 任务正是通过 `dsh --profile headless` 运行的，
// 会因此全部 exit 1。Jet Hub 的 RPC 端点在 Web 下通过 apply 内的可选注入挂载，
// 其余 profile 只是不注册该端点。
export const inject = ['credentials', 'commands', 'llm'];
/**
 * 插件 Config schema。
 *
 * ⚠️ **DSH 0.1.7-rc.1 起，settings 表单的命名空间就是 profile 条目 id**
 * （本插件的条目 id 是 `codearts-auth`），且只投影本条目 Config 中标记了
 * `.volatile()` 的字段。因此这里保留一个 `providers` 映射：
 * - **历史**：它曾是各 provider 用 `registerConfigurableProviders({ settingsNs })`
 *   声明时的落地位置，模型设置页据此把它们判定为「已配置」（判据见
 *   `dsh-client-ui-settings-models` 的 `configured`）。**2026-10-01 起本插件不再
 *   声明可配置 provider**（见 `llm-register-compat.ts` 模块头），该映射因此没有
 *   消费者，保留它只为不改变 `settings.describe()` 的既有形状；
 * - 本插件的凭据与账号管理**不**走这里（那是 Jet Hub 的账号池 +
 *   `ctx.credentials`），故该字段只承接一个宽松映射，不参与业务读取。
 *
 * 必须是 schemastery schema：`SettingsForms.describe()` 会对每个注册项调用
 * `schema.toJSON()`，传入裸函数（`(value) => ...`）会让它抛
 * `TypeError: ... .toJSON is not a function`，进而使所有依赖 settings 的界面
 * （模型设置页、sidebar 的 settings.get/shell.get）全部失败。
 */
export const Config = Schema.object({
    providers: Schema.dict(Schema.any()).default({}).volatile(),
});
/**
 * 注册 provider 配置 namespace（**仅老契约需要**）。
 *
 * - **≤0.1.6**：`ctx.settings` 允许插件注册任意 namespace，六个 provider 各占
 *   一个（`llm-buddy` / `llm-workbuddy` / ...）。注册缺失会让模型设置页在
 *   `refFor → deriveKeyRef(provider)` 处以
 *   `provider.toUpperCase is not a function` 崩溃，故注册后回读 `describe()` 自检。
 * - **0.1.7-rc.1**：settings 换成 `SettingsForms`，**没有 `register`**，命名
 *   空间只能是 profile 条目 id —— 此时不再（也无法）注册。这里刻意**静默跳过**：
 *   旧实现在这条分支上会打一条误导性的
 *   「settings 服务不可用」告警（启动日志实证）。
 *
 * ⚠️ **2026-10-01 起各 provider 不再声明为可配置 provider**（`settingsNamespaceFor`
 * 因此没有调用方），模型设置页不再有这些 namespace 的消费者 —— 这份注册此后只影响
 * ≤0.1.6 的老契约 profile，属遗留行为，本次未一并删除。
 */
function registerProviderSettings(ctx, ...namespaces) {
    const settings = settingsOf(ctx);
    if (!hasLegacyNamespaceRegistration(settings) || settings?.register === undefined)
        return;
    for (const ns of namespaces) {
        try {
            settings.register(ns, Config);
        }
        catch (error) {
            ctx.logger.warn(`[codearts-auth] settings namespace "${ns}" 注册失败: ${String(error)}`);
        }
    }
    // 回读确认：模型设置页要求 settingsNs 真实存在于 describe() 中。
    // 注意：describe() 会遍历所有已注册 namespace 并调用各自 schema 的
    // toJSON()/redactSecrets()，任一注册项的 schema 不合规都会让整条调用抛错。
    // 因此这里必须把异常打出来，而不是静默吞掉。
    try {
        const descriptors = settings.describe?.({ redactSecrets: true }) ?? [];
        const registered = descriptors.map(v => v.ns);
        const missing = namespaces.filter(ns => !registered.includes(ns));
        if (missing.length > 0) {
            ctx.logger.warn(`[codearts-auth] provider namespace 未生效: ${missing.join(', ')}`);
        }
        ctx.logger.info(`[codearts-auth] settings.describe ok, namespaces: ${registered.join(', ')}`);
    }
    catch (error) {
        ctx.logger.error(`[codearts-auth] settings.describe 失败（将导致模型设置页/sidebar settings API 不可用）: `
            + `${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
}
/**
 * 图片附件桥接：把持久化图片读成原始字节供适配器内联。
 *
 * 用 `ctx.get` 而非 `inject` —— 附件服务缺失时 provider 仍可正常加载，

 * 只是收到图片时报 UNSUPPORTED_CONTENT。三个 provider 共用本实现：
 * 两个 CodeBuddy 系产品（CodeBuddy / WorkBuddy）共用同一后端与协议；
 * LobsterAI 的图片形态同为 OpenAI 兼容的 `image_url` data URL
 * （2026-09-17 实测服务端接受并正确识别内容）。

 */
export function makeReadImage(ctx) {
    return async (attachment) => {
        const attachments = ctx.get('attachments');
        if (attachments?.readImage === undefined) {
            throw new Error('codearts-auth: 附件服务（attachments）不可用，无法把图片内联进请求；'
                + '请确认当前 profile 已装载 @deepseek-ai/dsh-attachment-local。');
        }
        const stored = await attachments.readImage(attachment);
        return { data: stored.data, mediaType: stored.ref.mediaType };
    };
}
/**
 * 图片「请求版本」桥接（issue !IKITT9）。
 *
 * 走 `ctx.attachments.readImageRequest(ref, target)`：由附件服务按目标尺寸与
 * 字节目标产出**确定性、可缓存**的缩放版本（alpha 走 WebP、不透明走 JPEG、
 * 85/75/60 质量阶梯），适配器只负责选目标。
 *
 * ⚠️ **任何不可用都返回 `undefined`，绝不抛错**，调用方据此回退原图。三种
 * 真实成因都必须容忍，否则「加上缩放」本身会变成新的故障源：
 *
 * 1. 宿主 profile 没装附件服务，或该版本没有 `readImageRequest`（老契约）；
 * 2. 附件后端明确拒绝投影（`ATTACHMENT_PROJECTION_UNSUPPORTED`）；
 * 3. 派生过程中的其它错误（缓存不可写、字节校验失败…）。
 *
 * 回退方向是刻意选 conservative 的一侧：宁可发一张大图（顶多触发网关的
 * 图片 token 上限），也不能因为「想缩图」而把一次本来能成功的请求打死。
 */
export function makeReadImageRequest(ctx) {
    return async (attachment, target) => {
        const attachments = ctx.get('attachments');
        if (attachments?.readImageRequest === undefined)
            return undefined;
        try {
            const projected = await attachments.readImageRequest(attachment, target);
            const mediaType = projected.mediaType ?? projected.attachment?.mediaType;
            if (mediaType === undefined)
                return undefined;
            return { data: projected.data, mediaType };
        }
        catch (error) {
            // 只记日志、随后回退原图：缩放是优化，不是请求的前置条件。
            ctx.logger?.warn?.('[jet-hub] 图片请求版本派生失败，回退原图：'
                + `${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    };
}
/**
 * 「重测」用的**探测适配器工厂**（Task 8）。
 *
 * ⚠️ 各家代码**逐字**从 `src/account-probe.ts` 的 `else if` 链搬来（含各自的
 * 注释）；那条链已删除，改为查本表（**未登记 ⇒ 抛可读错误**）。
 *
 * ## 谁必须在这里
 *
 * 判据是「该 provider 的适配器会不会写 `modelRateLimits`」（写了才有重测语义）。
 * 核对方式机械、不要靠记忆：
 *
 *     grep -n 'updateModelRateLimit(' src/*.ts        # 写点（池侧定义 + 各适配器直调）
 *     grep -n 'markLimited' src/*.ts                  # 适配器侧经回调注入的写点
 *
 * ⚠️ **两条都要跑**：实测多数适配器是**直调** `pool.updateModelRateLimit(...)`
 * （只有 `cline` / `opencode` 用 `markLimited` 这个名字），只看第二条会把
 * 大部分家漏掉。
 *
 * ⚠️ **不要在这里抄名单、也不要写「几家」**：本段曾写「会写标记的 provider 共
 * **13 家**」并紧跟 13 个名字，2026-10-11 加入 `minimax`（issue IKJW32）后当场过期
 * —— 这正是本文件自己记的「同一条事实的多份抄写必然漂移」的又一次实证。
 * 权威判据是上面那两条 grep；权威清单是 `tests/helpers/provider-sets.ts` 的
 * `WRITES_RATE_LIMIT_PROVIDERS`（守卫把它与源码写点**双向**比对，
 * 漏一家 / 多一家都点名变红）。本表必须**恰好**登记那份清单里的家。
 *
 * 登记史（只记形态、不记数字）：
 *
 * - **第 5 次** `loomy` / `raccoon`：旧 `else if` 链里**没有它们的分支** ⇒ 落入
 *   `else` 被交给「华为云 HMAC 签名」的 `CodeArtsAdapter`，而它们的限流标记
 *   （UTC+8 当日 24:00）**永远清不掉**。
 * - **第 6 次** `opencode`：不是漏项，而是「登记表刻意豁免了它」且**理由被证伪**。
 * - **第 7 次** `minimax`：它先前**确实**不写标记（14 家里唯一），故曾被判
 *   「不需要 probe」；2026-10-11 接上请求级换号 + 冷却后该前提作废。
 *   ⇒ 判据永远是「**现在**写不写标记」，不是「曾经写不写」。
 *
 * ⚠️⚠️ **不要再写「`opencode` 不写标记」**（2026-10-08 原注释如此，独立复审
 * 实测证伪）：它与「余额是本地派生的通道可用性、零网络」说的是**两件事** ——
 * 后者是它不进积分表的理由（见 `provider-credits.ts`），前者是它进不进出本表的
 * 判据。把前者当成后者的推论，恰好把一个**真实的漏挂**说成了「不需要」。
 *
 * ⚠️ **UI 入口**：`jet-hub.js` 里「重测所有」/「重置所有」/卡片级「重测」「重置」
 * 都由 `supportsRateLimit(provider)` 门控（缺省 **true**），**不是**
 * `accountTest`（那是另一个「测试」按钮的位）。原注释称「`accountTest` 只有
 * `gemini` 为 true ⇒ 其余渠道没有入口」—— **该推论是错的**：`opencode` 没有
 * `rateLimit: false` 豁免 ⇒ 这些按钮**会渲染**。
 * ⇒ 本表的完整性**已经是用户可见功能**，不是「将来才复发」的内部契约
 * （只有「测试」那一个按钮仍限 `gemini`）。
 *
 * ⚠️ 一致性与「漏一家」由 `tests/unit/provider-runtime-wiring.spec.ts` 的 probe
 * 域守卫从硬编码清单 + {@link PROBE_EXEMPT} 派生锁死（漏挂会让它**点名**变红）。
 */
export const probeById = {
    // 腾讯 Marvis（2026-11-09）—— OAuth 凭据（QQ / 微信），探测只喂**这一份**。
    //
    // ⚠️ 必须**单独一条**：`probeById` 按 provider id 取工厂，漏了这一条 ⇒
    //    「重测」按钮点了没反应（查不到就直接回「不支持探测」，全程静默），
    //    而 Marvis 没有 `rateLimit: false` 豁免 ⇒ 按钮**一定**会渲染。
    // ⚠️ 不传 `warn` / `accountPool`：`probeById` 是**模块级**常量（在 `apply()`
    //    之前求值），此处没有 `ctx`、也没有池 ⇒ 不会写任何限流标记。
    marvis: {
        createProbeAdapter: (ref, credential) => new MarvisAdapter({
            credentialRef: credentialRef(ref),
            slots: async () => [{ id: MARVIS.id, credential: credential }],
            product: MARVIS,
        }),
    },
};
/** 注册 codeartsAuth 服务与 codearts LLM 路由（不注册斜杠命令）。 */
export function apply(ctx) {
    // 本插件自带 Jet Hub 设置页，关闭 0.1.7 起由 Config schema 反渲染的自动表单
    // （老契约没有 configure()，静默跳过）。
    suppressAutoSettingsPage(ctx);
    // provider 配置命名空间的注册**只在老契约（≤0.1.6）下执行**：
    // 那时 `settings.register` 可用，十二个 namespace 分别对应 codearts 路由、
    // CodeBuddy（buddy）、WorkBuddy（workbuddy）、LobsterAI（lobsterai）、
    // Qoder（qoder / qodercn）、TRAE（trae）、Cline（cline）、Loomy（loomy）、
    // Raccoon（raccoon）、MiniMax（minimax）与 Zcode（zcode）。
    //
    // 0.1.7-rc.1 起 settings 换成 SettingsForms（无 register），命名空间只能是
    // profile 条目 id，故这里不做任何注册。
    //
    // ⚠️ 2026-10-01 起各 provider 已**不再**声明为可配置 provider，故这批 namespace
    // 在模型设置页上已无消费者（详见该函数头的说明）。
    // ⚠️ 2026-10-08 改：namespace 清单从 `PROVIDER_REGISTRY` 派生，不再手抄 13 个。
    //    原先改 registry 的 `settingsNamespace` **行为完全不变**（宿主侧另有一份
    //    13 个字面量的副本），是「唯一真相源」名不副实的一处。
    //
    // ⚠️ **顺序变了**：原清单是 `buddy, workbuddy, codearts, lobsterai, …`（人工排列），
    //    派生后是 registry 的声明顺序（`codearts, buddy, workbuddy, …`）。
    //    ⚠️ **这个顺序无关紧要**：`registerProviderSettings` 内部是 `for (const ns of …)`
    //    逐个 `settings.register(ns, Config)`，注册顺序不影响 `describe()` 的语义
    //    （它按 ns 查、不按序）。**但必须确认既有断言不断言顺序** ——
    //    执行时 `rg -n "llm-buddy|llm-zcode|llm-codearts" tests/unit/` 核对；
    //    若有断言依赖顺序，改为**集合相等**（`.sort()`）而不是保持原顺序。
    registerProviderSettings(ctx, ...PROVIDER_REGISTRY
        .map((d) => d.settingsNamespace)
        .filter((ns) => ns !== undefined));
    const pool = new AccountPool(ctx);
    /**
     * ★★ **共享余额读数缓存**（2026-10-15 规格 §5.7；2026-10-16 起 loomy 也接入）——
     * 本进程**唯一**的一份。
     *
     * ## ⚠️⚠️ 为什么必须建在**这里**（位置不变式）
     *
     * 消费者有三处，定义顺序不能变：
     * ① loomy 选号器（`loomyBalanceSelector`，约在本段之后）—— 2026-10-16 新增；
     * ② `credits.balances` 端点（经 `registerBalanceCache` 的进程级注册位）；
     * ③ 聚合折算（`sharedExpiryProbe` 的 `balanceOf`）。
     *
     * ⚠️ 我第一版把它留在文件后段（`sharedExpiryProbe` 旁边）⇒ ① 会读到
     *   **尚未初始化的 `const`**（TDZ）—— `tsc` 不报错（`const` 在模块作用域
     *   有块级作用域，闭包里引用合法），只在 loomy 首次选号时抛
     *   `ReferenceError`。⇒ 位置本身就是一条不变式，登记在此。
     *
     * ## 谁在用它（各有各的取舍）
     *
     * | 消费者 | 传哪些账号 | 为什么 |
     * |---|---|---|
     * | `credits.balances` 端点（积分面板 / 徽标） | **全部**账号（含停用 —— 既有语义） | 用户要在同一个列表里看到每个账号还剩多少 |
     * | loomy 选号（余额分档） | **候选**账号（已过滤 enabled/限流） | 不该用没资格的号去推断整体 |
     * | 聚合折算（buddy 系四家） | **可用**账号 | 不可用的账号本来就不该参与候选 |
     *
     * ⇒ 「谁该被读」是**调用方的取舍**，「同一账号的读数在 TTL 内复用」才是本缓存
     * 提供的**基础设施**（用户 2026-10-15 的更正原话见 `balance-cache.ts` 模块头）。
     *
     * ⚠️⚠️ **必须是同一个实例**：两次 `createBalanceCache` 会让同一个账号被查两次
     *（那正是本模块要消除的），且 `clear` 也得分两次 —— 与 `sharedExpiryProbe` 那条
     * 「初版内联导致两份缓存」的真实缺陷**同型**。
     *
     * ⚠️ TTL 120 秒（规格 §5.7.4-3 的诚实登记）：聚合是**多候选回落**结构，
     *   陈旧 60 秒的代价是「多一次失败尝试后回落」（用户看不到失败），换来上游
     *   请求不翻倍；面板侧有 5 分钟重探与手动 `force` 兜底。
     *
     * ⚠️ 陈旧兼顶上界 15 分钟（`staleTtlMs`）：用户 2026-10-16 要求
     *   「拿不到新数据就读旧数据」，但必须有上界 —— 见 `balance-cache.ts` 的注释。
     */
    const balanceCache = createBalanceCache({
        ttlMs: 120_000,
        failureTtlMs: 15_000,
        // ⚠️ 中止判据**复用**适配器导出的共享实现（它含 `code: 'ABORTED'` 与 499 报文
        //    两条腿）—— 不要在装配层再写一份（本仓库已有 4 份同义实现，别再添第五份）。
        isAbort: (error) => isAbortLikeError(error),
        fetch: (provider, entry) => fetchBalanceReading(pool, provider, entry),
    });
    // ⚠️ 注册到**进程级**注册位：`credits.balances` 端点拿不到本函数的局部变量
    //   （`registerJetHubRpc` 的 4 形参不变式不许加第 5 个），故走与
    //   `ProviderRuntime.credits` 同一张表（见 `provider-runtime.ts` 的说明）。
    //   ⚠️ 未注册 ⇒ 端点回退到自己的原路径（行为与升级前一致）—— 那是刻意的降级。
    registerBalanceCache(balanceCache);
    /**
     * ★★ **余额缓存的后台刷新器**（2026-10-18，Task 2）。
     *
     * ## 为什么必须有它（用户原话）
     *
     * 「这个 2 分钟是 interval 不是 timeout」—— 原实现是 cache-aside（读驱动），
     * 而读路径在提交 `a725101` 之后陈旧命中**一个请求都不发** ⇒ 没有任何东西会再取
     * 新数据 ⇒ 缓存会永远陈旧。本刷新器补上「后台保鲜」那一半。
     *
     * ## ⚠️ 位置不变式
     *
     * 必须建在 `balanceCache` **之后**：它要拿缓存实例（与上面那条位置不变式同源）。
     *
     * ## ⚠️ 凭据必须**在装配层解析**
     *
     * `fetchBalanceReading`（本文件下方）在 `entry.credential === undefined` 时
     * 直接抛「凭据未提供」⇒ 刷新器若传空 entry，**每一轮都被记成失败读数**
     * （外面看「刷新器在跑」，实则永远拿不到新值 —— 零报错的恒绿形态）。
     * ⇒ 这里按 `credentialRef` 解析（与 `jet-hub-rpc.ts` 的
     *   `resolveCredentialForCache` **同款**口径）；解析失败返回 undefined，
     *   刷新器据此**跳过**该账号（那一枪必然失败，纯浪费）。
     */
    const balanceRefresher = createBalanceRefresher(balanceCache, {
        // ⚠️ `listAllAccounts()` 实测是 **async**（`src/account-pool.ts:1308`）；
        //    刷新器内部一律 `await`，直接传引用即可。
        // ⚠️ 传**全部**账号（含停用）：停用只影响自动选号（仓库铁律「续期不得按
        //    `enabled` 过滤」），凭据仍需保鲜 —— 由刷新器自己判低频节奏。
        listAccounts: () => pool.listAllAccounts(),
        resolveCredential: async (refName) => {
            const resolved = await ctx.credentials.resolve(credentialRef(refName));
            if (resolved === undefined)
                return undefined;
            try {
                return JSON.parse(resolved.value);
            }
            catch {
                return undefined;
            }
        },
        // ⚠️ **引用常量、不要重打 `60_000`**（2026-10-18 复审 Minor 修正）：
        //    装配层与 `createBalanceRefresher` 各写一份同一个字面量，等于把
        //    `DEFAULT_STALE_TTL_MS` 刚消灭掉的那类重复又引入了一次。
        //    ⚠️ **理由（别丢）**：周期 = 共享缓存 `ttlMs`(120s) 的**一半** ——
        //    周期恰等于 `ttlMs` 时条目在刚过期那一刻才被刷，读路径仍会频繁撞上
        //    「陈旧且后台刚开始刷」，常新目标落空；取一半 ⇒ 任何时刻至少有半个周期余量。
        intervalMs: REFRESH_PERIOD_FALLBACK_MS,
        // ⚠️⚠️ **日志必须接上**：刷新器把失败吞掉并记日志（后台没有调用方可通知）
        //    ⇒ 不接 logger 就是**完全静默**：面板只显示「查询失败」，用户与维护者
        //    都看不到「后台刷新器压根没在刷」。这两行同时是接线守卫的判据落点。
        info: (message) => ctx.logger?.info?.(message),
        warn: (message) => ctx.logger?.warn?.(message),
    });
    // 生命周期挂 `ctx.effect`，与插件一致（释放后停手）—— 与既有 `modelsDevTimer`、
    // `startCatalogPrewarm` 同款约定。
    ctx.effect(() => {
        balanceRefresher.start();
        return () => { balanceRefresher.stop(); };
    });
    // 「已失效模型」剔除：注入 ctx 只为把日志接进 DSH logger 并复用同一份 home
    // 解析。必须在任何 `registerXxxLlm` 之前调用 —— 各适配器经
    // `registerAdapterIdempotent` 注册时就会包装上剔除逻辑（见该函数注释）。
    configureDeadModelStore(ctx);
    // ===== Token 账本持久化（第 2 期 · 日聚合落盘）=====
    //
    // ⚠️ 账本本体是模块级单例（`token-ledger.ts`），没有 ctx 可拿 —— 故在启动时
    // 把后端挂进去（`attachTokenLedgerStore`）。挂载发生在**任何适配器注册之前**：
    // 启动早期就有模型请求（标题生成等）时，落盘已在位。
    //
    // ⚠️ 后端契约是**绝不抛错**（`recordTokenUsage` 的调用点在推理关键路径上，
    // 见其函数注释），`FileLedgerStore` 内部已按此实现。
    //
    // ⚠️ dispose **必须用返回的 disposer**（不能无条件 `attach(undefined)`）：
    // 插件 fiber 重启时新 apply 与旧 fiber 的异步 dispose **交错执行**
    //（本仓库已确证的事故，见 `llm-register-compat.ts` 模块头），无条件摘会把
    // **新实例刚挂上**的后端摘空 ⇒ 落盘停摆且历史视图恒为空。disposer 自带所有权
    // 校验（只摘自己的），并顺带 `flush` 当前这份数据。
    const tokenLedgerStore = createTokenLedgerStore(ctx);
    const detachTokenLedger = attachTokenLedgerStore(tokenLedgerStore);
    ctx.effect(() => () => {
        try {
            tokenLedgerStore.flush();
        }
        finally {
            detachTokenLedger();
        }
    }, 'token-ledger-persistence');
    // ===== 腾讯 Marvis（2026-11-09）=====
    //
    // 形态：OpenAI 兼容（`/v1/chat/completions`）+ OAuth 授权码（QQ / 微信）。
    // 目录**只有一条** `main-auto`（上游无目录端点，见 `src/marvis-product.ts`）。
    //
    // ⚠️ 与 modelscope / qiniu 的槽制同形：`slots()` 由**接线层**解析，适配器
    //    不直接读凭据库。区别只在槽里装的是 `MarvisCredential`（要放进请求头
    //    与 `Marvis-Ext` 指纹串），而不是裸 API Key。
    //
    // ⚠️ **不要**给模型网关加 UAL 签名头（`Ual-Access-Signature` 等）：
    //    实测加了会 403 → 被归一成 401「登录态过期」。签名只属于 `/v3/*` 业务
    //    接口，见 `src/marvis.ts` 的 `businessHeaders` 注释。
    const marvisAuth = new MarvisAuth(ctx);
    const marvisAdapter = registerMarvisLlm(ctx, {
        // 单凭据回退 ref：池里没有 marvis 账号时用它（与其余 provider 同约定）。
        credentialRef: credentialRef(MARVIS.defaultCredentialRef),
        slots: async (modelId) => {
            const entries = await pool.listAccounts(MARVIS.id);
            const usable = await Promise.all(entries.map(async (entry) => {
                // 与其余 provider 同款：停用账号不参与自动选号。
                if (!entry.enabled)
                    return undefined;
                // ⚠️ 模型级限流标记：`modelId` 缺省时**不查**（目录路径刻意不传，
                //    传了会让被限流的账号把整个目录拖空）。
                if (modelId !== undefined && modelId.length > 0) {
                    const resetAt = entry.modelRateLimits?.[modelId];
                    if (typeof resetAt === 'number' && resetAt > Date.now())
                        return undefined;
                }
                const resolved = await ctx.credentials.resolve(credentialRef(entry.credentialRef));
                if (!resolved)
                    return undefined;
                const credential = parseMarvisCredential(resolved.value);
                if (credential === undefined)
                    return undefined;
                return { id: entry.id, credential };
            }));
            return usable.filter((slot) => slot !== undefined);
        },
        accountPool: pool,
        product: MARVIS,
        // 限流标记的**写入端**（缺了它 `slots()` 里的读端是死代码，适配器里的
        // `markLimited?.()` 也恒为 no-op ⇒ 429 之后永远重打同一个号）。
        markLimited: async (slotId, modelId, resetAtMs) => {
            await pool.updateModelRateLimit(slotId, modelId, resetAtMs);
        },
        // ⚠️ 换号/风控/上游故障时适配器会 `warn?.(...)`（2026-11-09 评审 I5）：
        //    不传这一格时，生产里每次「换下一个账号」都**零日志** —— 用户报障
        //    「偶发失败」时无法判断是哪个号被换掉了、为什么。本仓其余 13 处同款。
        warn: (message) => ctx.logger?.warn?.(message),
        readImage: makeReadImage(ctx),
    });
    // ===== 多账号静默续期调度 =====
    // 替代原有的单账号 scheduleRefresh()，使用 refreshAll() 遍历所有账号续期
    const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 每 30 分钟检查一次
    /**
     * 十三个 provider 实例的续期入口（`buddy` 与 `workbuddy` 是两个实例、同一个类；
     * `qoder` 与 `qodercn` 同理）。
     *
     * ⚠️ 条数会随 provider 增长（早期写「十个」已过时）——注释里的数字**不是**契约，
     * 派生的键集合才是（见 `wiredRefreshTargets`）。
     *
     * 收成一张表是为了让「失败必须留日志」这条规则**只写一遍** —— 原先这里是
     * 十个空 catch（注释写着「静默」），把 provider 内部的告警与异常一起吞掉，
     * 「凭据一直刷不动」在日志里完全无痕（issue !IKIRTT 的可观测性条目）。
     *
     * ## ⚠️⚠️ 2026-10-08（Task 10）：改为**从能力注册表派生**，且**惰性求值**
     *
     * 原先这里**手抄 13 行**。失效形态极隐蔽：**漏一家 ⇒ 该家凭据永不自动续期**，
     * 而症状只是「每隔一段时间就要重新登录」，**日志里一个字都没有**。
     *
     * ⚠️ **必须是函数调用而不是在这里立即求值**：本行（`apply()` 中段）在
     * **注册循环之前**执行，而注册循环在 `apply()` 的**末尾**。立即求值会得到
     * **空表** ⇒ 所有 provider 都不再自动续期，而日志里只有 `isPoolEmpty`
     * 的常规输出。
     *
     * ⇒ 改为在 `refreshAllCredentials` **内部**每次调用时现取（见下）。
     * 代价是一次极廉价的 Map 遍历；收益是**与注册时机彻底解耦**。
     *
     * ⚠️ **与被删清单里的注释的关系**（2026-10-08 独立复审修正）：原先手抄的 13 行
     * 各自带注释，删除时它们被**压缩成本函数上方这段 5 项摘要**（不是「逐条上移到
     * `probeById` / `wiredRefreshTargets` 侧」—— 实测那两个符号处对这些家零命中）。
     * 摘要保留的 5 个失效模式（**不得静默丢弃**，Task 6 的主导失效类）：
     * Loomy 不可续期（只探测已过期）、raccoon 的 lead 窗口、minimax 的
     * refresh_token 轮换、zcode 静态凭据仍回写、gemini 漏挂的后果。
     * ⚠️ 其中 gemini 那条的**后果措辞已过时**：定时器自 issue IKJOZB 起已改为
     * **无条件武装**（只看池里有没有账号，不看续期表的成员资格）⇒ 漏挂 gemini 的
     * 真实后果是「**gemini 凭据永不自动续期**」，**不是**「定时器不武装」。
     */
    async function refreshAllCredentials() {
        // ⚠️ **每次现取**（wiredRefreshTargets() 是函数、读注册表）：注册发生在
        //    apply() 末尾，而本函数最早在调度器 start() 的首轮就被调用 ⇒
        //    若在这里读一个**在注册前求值的常量**，会得到**空表** ⇒
        //    所有 provider 都不再自动续期，而日志里只有 isPoolEmpty 的常规输出
        //    （⚠️ 注意 WIRED_EXPIRY_PROVIDERS **不属**这一类：它是刻意保留的纯数据清单，理由见 `aggregate-expiry.ts` 自己的注释。）
        for (const [tag, refreshAll] of wiredRefreshTargets()) {
            try {
                await refreshAll(pool);
            }
            catch (error) {
                // 单个 provider 抛错不得中断其余九个（各 refreshAll 内部本就逐账号
                // try，能冒到这里的已是「整批失败」级别的异常）。
                ctx.logger?.warn?.(`[jet-hub] ${tag} 批量续期失败：${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    // 启动时**无条件**武装续期调度器，并在账号入库时补一次武装。
    //
    // ⚠️ 空池判据（`isPoolEmpty`）**只用于日志措辞**，不再参与「是否武装」的决策。
    // 它的历史形态是「按 `accounts.some(a => a.refreshable)` 决定武装」——
    // 那让这个定时器**是否武装**取决于一批可能已被误标成 false 的布尔，而它存在
    // 的意义恰恰是去修正误标。本次事故实测：36 条账号只剩 3 条 `true`
    // （raccoon / minimax / cline 各一），只要那三条被删或被同样误标，
    // **codearts 的自愈与启动首轮会一起消失**，且日志里一个字都不会有。
    // 各家 `refreshAll` 内部本来就按凭据材料 / 是否过期过滤（`loomy` 只探已过期的、
    // 其余看 `refreshableOf(credential)`），故放宽判据最多多一次本地遍历。
    //
    // ⚠️ 仍然**不看 `enabled`**（AGENTS.md 既有铁律）：停用只影响自动选号，
    // 不该让凭据停止续期。早期写成 `a.refreshable && a.enabled`，于是
    // 「所有账号都被停用」时续期定时器根本不启动，凭据一路烂到 refresh_token 失效。
    //
    // ⚠️⚠️ **更不能因为「启动瞬间池为空」就不武装**（issue IKJOZB 的真实缺陷）：
    // 冷启动空池是正常态（新用户、刚清过存储），而原先的 `if (accounts.length === 0)
    // return` 让整个调度器**不被创建**、之后又没有重新武装的路径 ⇒ 该会话内登录的
    // 账号**永远不会被主动续期**（只剩请求内按需续期），凭据悄悄过期而面板仍显示
    // 「可自动续期」，且日志里一个字都没有。
    // 现在武装与池内容彻底解耦（见 `src/refresh-scheduler.ts`）：
    // ① 无条件武装；② 定时器内空池只记日志、下轮继续；③ `pool.onAccountAdded`
    // 提供「入库即补武装」这条 issue 点名缺失的路径。
    //
    // ⚠️ **必须立刻先跑一轮**（issue !IKIRTT 的主缺陷，已内建在 `start()` 里）：
    // 早先这里只有 `setInterval`，第一次处理要等满一个周期。短寿命 provider
    // （cline 1 小时、codearts 约 2 小时、raccoon 3 小时）的凭据在宿主关闭期间
    // 早就到期了，于是重启后**最长 30 分钟**一直显示「已过期」、积分行一直 401。
    // 这一轮与 lead-time 过滤配合（`src/expiry-sync.ts` 的 `shouldRefreshNow`），
    // 只对「距过期不足 1 小时」的账号发续期请求，其余只做一次本地对账 ——
    // 既补上了首轮，又不会在启动时打出几十个无谓请求。
    const refreshScheduler = new MultiAccountRefreshScheduler({
        refresh: refreshAllCredentials,
        intervalMs: REFRESH_INTERVAL_MS,
        /**
         * 首轮延后 15s（issue #20）：宿主启动时插件并发初始化，立即对全量账号
         * 发续期会和启动路径抢网络/凭据存储，日志里常见一串冷启动 `fetch failed`。
         * 周期定时器仍然立刻武装；只有首轮让路。
         */
        initialDelayMs: 15_000,
        isPoolEmpty: async () => (await pool.listAllAccounts()).length === 0,
        // ⚠️ 可选链：`logger` 在极简 profile 下可能缺席，而日志不该成为续期的
        // 单点故障（与仓库既有的 `ctx.logger?.warn?.()` 一致）。
        info: (message) => ctx.logger?.info?.(message),
        warn: (message) => ctx.logger?.warn?.(message),
    });
    // ⚠️ 不 await：`apply()` 是同步函数，而 `start()` 内含首轮续期（会发网络请求，
    // 可达数十秒）。阻塞在这里会让插件启动卡住（与 opencode 能力预热同款约定）。
    void refreshScheduler.start().catch((error) => {
        // 走到这里说明 `refresh()` 或订阅通知本身出了意料之外的异常；`onTick`
        // 内部已消化常规失败，故这条只是最后一道可观测性兜底。
        ctx.logger?.warn?.(`[jet-hub] 多账号续期调度器启动失败（本次会话不会自动续期）：`
            + `${error instanceof Error ? error.message : String(error)}`);
    });
    // issue IKJOZB 点名缺失的那条「重新武装的路径」：账号入库（登录成功、导入、
    // 恢复备份）时若调度器未武装则补上。⚠️ 订阅点必须挂在 `AccountPool` 上，
    // 不能逐个登录流程接线 —— 全仓库十几处 `pool.addAccount` 调用点，漏一处
    // 就意味着那个 provider 静默地永不续期。
    //
    // ⚠️ **同时清空临期折算缓存**（真实缺陷，对抗审计实测证伪）：缓存原先**没有
    // 任何失效通道** ⇒ 刚登录（或限流刚解禁）的账号在**最长 60 秒内对路由不可见**，
    // 用户拿到误导性的 `MISSING_CREDENTIAL | …没有任何可用候选`（明明刚登录成功）。
    // ⚠️ 用**可变引用**（`let sharedExpiryProbeRef`）而不是直接捕获 `const` ——
    // 探针定义在**本订阅之后**（那里才够 `ctx.llm` 注册完 provider），
    // 闭包直接引用会命中 TDZ。
    let sharedExpiryProbeRef;
    // ⚠️⚠️ **候选序缓存也必须清**（真实缺陷，独立审计实测证伪：我原先只清了一半）。
    //
    // 两个缓存**不是**同一个东西：
    //   - 折算缓存：`provider → 最早失效时刻`（决定**排序**）；
    //   - 候选序缓存（`AggregateAdapter.choiceCache`）：`${model}\0${拒绝表指纹} →
    //     DispatchTarget[]`（决定**用哪几个候选**），TTL 同样 60 秒。
    //
    // 后果（审计实测）：buddy **未登录**时被剔除（只剩 codearts）⇒ 那个**非空**结果
    // 被缓存 ⇒ 用户随后**登录 buddy** ⇒ 折算缓存被清（排序值对了），但
    // **候选序仍是「只有 codearts」的旧数组** ⇒ 60 秒内 buddy 仍不被使用。
    // ⇒ 「刚登录的账号对路由不可见」只解决了一半。
    //
    // ⚠️ 候选序缓存的键含**拒绝表**指纹但**不含账号状态**，故账号变化必须**显式**清它。
    // ⚠️ 同样用可变引用（`aggregateAdapter` 定义在本订阅之后）。
    let sharedChoiceCacheRef;
    const unsubscribeAccountAdded = pool.onAccountAdded(() => {
        refreshScheduler.notifyAccountAdded();
        // ⚠️ 未定义时什么都不做（订阅可能在它们建好前就触发 —— 那是正常时序）。
        sharedExpiryProbeRef?.clear();
        sharedChoiceCacheRef?.clearChoiceCache();
    });
    ctx.effect(() => () => {
        unsubscribeAccountAdded();
        refreshScheduler.stop();
    }, 'jet-hub: multi-account refresh scheduler');
    // 冷启动也广播一次：首次目录在注册后异步就绪，不补这一发就只能等用户重启。
    ctx.emit('llm/adapters-updated');
    // 聚合 provider：一个规范模型名挂多渠道候选表，按临期积分自动选渠道、失败自动切换
    //（见 `aggregate-adapter.ts` 模块头）。注册放在全部 provider 适配器之后：
    // 它经 ctx.llm 公开路径委托目标适配器，且目录推导要读各渠道的 listModels。
    // ⚠️ 必须传 expiryProbe：不传则所有渠道都折算成 UNUSABLE ⇒ 聚合目录虽在，
    //    但任何请求都会报「没有任何可用候选」。
    //
    // ⚠️ 聚合 provider 必须**早于** `modelAdapters` 定义注册：那张表要引用本调用返回的
    //    适配器实例（`pruned(AGGREGATE_PROVIDER, aggregateAdapter)`）。而 `modelAdapters`
    //     又必须早于 `registerJetHubRpc`（后者要拿它做设置页目录）。故聚合的注册位置
    //     比 auto 更靠前 —— 这不是笔误。
    /**
     * **共享**的临期探针（aggregate 与 auto 用同一个实例）。
     *
     * ## ⚠️ 为什么必须共享（真实缺陷，对抗审计实测证伪）
     *
     * 初版这里**直接内联** `createExpiryProbe(...)`，而 `AutoAdapter` 内部**又建一个**
     * （它自己的 `expiryProbeInstance`）⇒ **两份独立的缓存实例**，后果：
     * ① 同一渠道被折算两次（白打两次上游余额接口）；
     * ② **缓存失效必须清两次** —— 而 `clear()` 若只清到一份，另一份仍会让
     *    「刚登录的账号最长 60 秒对路由不可见」（用户拿到误导性的
     *    「没有任何可用候选」，而它其实刚登录成功）。
     *
     * ⇒ 在装配层建**一个**，两个适配器都用它；`clear()` 一次即全部生效。
     *
     * ⚠️ **共享带来的一个语义松弛 —— 它**曾经**被判定为「无害」，那个判定是错的**
     *（真实缺陷，2026-10-07 探针实测证伪）：
     *    `AutoAdapter` 自己那份 `firstModelOf` 是「跳过被禁用 + 按倍率**挑最便宜**」，
     *    而这里共享的这个是「取目录**第一个**」。共享后**两个消费者都用后者**。
     *
     *    ⚠️ 旧注释的理由是「`firstModelIdOf` 的返回值只被当作 `probeModel` 传给取号器，
     *    **不参与折算结果的任何计算**」—— 前半句对，**结论错**：`probeModel` 确实不参与
     *    「最早失效时刻」这个数值，但它**参与账号池的限流过滤**
     *   （`getAvailableAccount` 按 `entry.modelRateLimits[modelId]` 过滤），
     *    而那正是「这个模型现在还能不能用」的判据。
     *
     *    ⇒ 实测（探针）：目录为 `[glm-5.3-flash, Deepseek-V4.1-Flash · x0.1]`、
     *    账号在 `deepseek-v4.1-flash` 上额度已尽时，auto **仍选中**
     *    `codearts/deepseek-v4.1-flash` —— 因为折算问的是 `glm-5.3-flash`
     *   （未被标记），按 modelId 的过滤整体失效，请求发出去必然
     *    `InferHub.4291.200 insufficient quota`。
     *
     *    ⚠️ **已修**：两个消费者现在都**显式按将要派发的真实模型**复核账号可用性
     *   （`auto-adapter.ts` 的 `hasUsableAccountFor`、`aggregate-adapter.ts` 的
     *    `filterByModelAvailability`）—— 判据仍只有一份（账号池的 `modelRateLimits`），
     *    这两个方法只是「问对模型」。
     *
     *    ⚠️ 若将来有人让折算逻辑**依赖** `probeModel` 的**具体取值**
     *   （如「按最便宜的模型查额度」），仍需让两个消费者各自传自己的实现。
     */
    /**
     * **静态回退积分表**（无 deps 版工厂）—— 供 {@link fetchBalanceReading} 在
     * runtime 缺席时兜底。模块级常量：工厂是纯函数，表在进程内不变。
     *
     * ⚠️ 与端点侧（`jet-hub-rpc.ts`）/runtime 侧（下方 `creditsTable`）**同源同构**
     *（同一个 `createProviderCredits`），差异只在 deps：本表无 deps，loomy /
     * raccoon / zcode 的条目会退到「自由函数 + 全局 fetch」—— 但这三家**有**
     * runtime，永远先命中 runtime，实际走不到这里；本表实际服务的只有
     * 「balance:true 且无 runtime」的渠道（现役仅 codely）。一致性由
     * `credits-runtime-parity.spec.ts` 的「表键集合 === registry 派生」守卫兜住。
     */
    const FALLBACK_CREDITS_TABLE = createProviderCredits();
    /**
     * 共享缓存的**取数原语**（从 `credits.balances` 的查表分派里抽出的那一半）。
     *
     * ## ⚠️ 为什么必须与 `credits.balances` 用同一个函数（规格 §11-1 的核实结论）
     *
     * 两条路径（面板端点 / 聚合折算）取的是**同一个数**：只有共用同一份取数实现，
     * 「面板显示的余额」与「折算据此排序的余额」才不可能分叉。若各写一份，两边
     * 对同一份报文可能得出不同的 `error` / `extra` 口径（本仓库首条红线）。
     *
     * ⚠️ 取数**不含 self-heal**：续期留在 `credits.balances` / `credits.claimAll` 的
     * **端点入口**（规格 §5.7.1 末行）—— 折算路径触发填充时不该把续期开销带进发消息路径。
     * ⚠️ opencode / qoder 族 / officeace 的**特例短路仍在端点里**（它们不走本原语）：
     * 本函数只处理「查表分派」那一段（`creditsOf` + `fetchBalance(Detailed)`）。
     *
     * @returns 解析出的 `CreditBalance`（失败时抛错 ⇒ 缓存记成 `error` 读数）。
     */
    async function fetchBalanceReading(pool, provider, entry) {
        const runtime = runtimeOf(provider);
        // ⚠️⚠️ **runtime 缺席时回退到静态积分表**（真实缺陷，2026-10-19 实测打穿）：
        //    codely 是全仓首例「balance:true + 无 runtime」的渠道（channel:false、
        //    无 auth 服务 ⇒ `src/index.ts` 的注册循环里没有它 ⇒ 没有 ProviderRuntime）。
        //    本原语原先只认 runtime ⇒ 对 codely 恒抛 `unsupported provider: codely` ⇒
        //    缓存记成失败读数并**兼顶旧值 15 分钟**，面板积分行显示
        //    「本次查询失败，显示的是 … 的数据（unsupported provider: codely）」——
        //    而端点侧的表里明明有它（首次成功的那次读数正是端点表查出来的）。
        //
        //    回退表用**无 deps** 的工厂：codely 的原语是纯自由函数，不依赖任何
        //    auth 实例。⚠️ 有 runtime 的渠道**永远先命中 runtime**（含 loomy /
        //    raccoon / zcode 的实例 fetchImpl 路径），本回退只在「该声明了余额能力
        //    却没注册 runtime」的渠道上生效 —— 那正是本函数原本完全无法服务的形态。
        const impl = runtime?.credits ?? creditsOf(FALLBACK_CREDITS_TABLE, provider);
        if (impl === undefined)
            throw new Error(`unsupported provider: ${provider}`);
        if (entry.credential === undefined)
            throw new Error('凭据未提供');
        // ⚠️ `ProviderCallContext` 的三个字段与 `jet-hub-rpc.ts` 里那份**同形**
        //（那里是端点闭包内的注册实例，这里是装配层的实例；实现侧只需一个形状）。
        // ⚠️ 必须与端点那份**指向同一个池**，否则折算拿到的账号集合与面板看到的不一致。
        // ⚠️ `accountId` **必须带上**（Gitee issue IKLTZ2）：Gemini 折算路径要按账号
        // 取出口代理；漏了它 ⇒ 这条路径恒直连，症状是「面板能刷新、聚合折算却失败」。
        const callContext = {
            resolveCredential: (refName) => ctx.credentials.resolve(credentialRef(refName)),
            warn: (message) => ctx.logger?.warn?.(message),
            accountPool: pool,
            accountId: entry.id,
        };
        // ⚠️ `fetchBalanceDetailed` 优先（它带 `error` / `extra`，是既有端点的口径）。
        if (impl.fetchBalanceDetailed !== undefined) {
            const detailed = await impl.fetchBalanceDetailed(entry.credential, callContext);
            if (detailed.balance === null)
                throw new Error(detailed.error ?? '余额查询失败');
            return detailed.balance;
        }
        if (impl.fetchBalance === undefined)
            throw new Error(`unsupported provider: ${provider}`);
        const balance = await impl.fetchBalance(entry.credential, callContext);
        if (balance === null)
            throw new Error('余额查询失败');
        return balance;
    }
    const sharedExpiryProbe = createExpiryProbe(pool, async (provider) => {
        const models = await ctx.llm.listModels(provider);
        return models[0]?.id;
    }, {
        /**
         * ★★ **共享余额读数**（2026-10-15，规格 §5.7）。
         *
         * ## 用户原话（本模块存在的理由）
         *
         * 「为什么不能更新账号积分用共享缓存，取号逻辑只是在调用缓存的时候取舍的问题，
         * 不影响刷新账号积分缓存呢，账号积分缓存是更底层基础设置，计算怎么取号是
         * 基础设施上的使用逻辑」
         *
         * ⇒ 这里注入的是**同一个** `balanceCache` 实例（`credits.balances` 端点用的是
         * 它）—— 于是 buddy 系四家的折算**吃同一份读数**，而不是各自再打一次上游。
         * 「只给可用账号」这一取舍由 `createExpiryProbe` 自己的取号逻辑决定
         *（它本来就只遍历可用账号），与缓存无关。
         *
         * ⚠️ 返回 `undefined` ⇒ **本次没有共享读数** ⇒ 实现方回落到自己发请求
         * （`fetchBalanceWithCache`，见 `aggregate-expiry.ts:275` 的契约）：
         * 折算的**可用性**不得依赖本缓存（否则缓存不可用会静默变成「该渠道折算恒 UNUSABLE」）。
         * ⇒ 而返回 **`null`** 是「结论：这个账号现在不可用」（`sharedPackageExpiry`
         * 对 `null` 判 `UNUSABLE`，且**不**回落重查）—— 下面那条正是这一格。
         */
        balanceOf: async (provider, accountId, credential) => {
            const reading = await balanceCache.readOne(provider, accountId, { credential });
            // ★★ **陈旧读数不得参与折算**（2026-10-18）。
            //
            // 读路径改成 stale-while-revalidate 后，缓存陈旧时折算会拿到**旧值**，
            // 而 `stale` 字段原先只在 `readStale` 里判（`balance-cache.ts` 的注释记着
            // 那个限制）⇒ 折算会**静默地长期用 10 分钟前的数字排序**。
            //
            // ⚠️⚠️ **必须返回 `null` 而不是 `undefined`**（实测确证，2026-10-18）：
            //   契约（`aggregate-expiry.ts:275`）与实现（`fetchBalanceWithCache`）都规定
            //   `undefined` = 「**本次没有共享读数**⇒ 回落到自己发请求」，`null` 才是
            //   「结论：不可用」。实测（mock `fetchCreditBalance` 成功）：
            //     - 返回 `undefined` ⇒ fallback **被调用 1 次**，折算返回**上游的值**（≠ UNUSABLE）
            //     - 返回 `null`      ⇒ fallback **0 次**，折算返回 `-1`（UNUSABLE）
            //   ⇒ 写 `undefined` 会得到「陈旧账号每次折算**多打一次上游请求**」，
            //     恰恰是本条要消灭的行为（且与「读路径一个请求都不发」相悖）。
            //
            // ⚠️ 与 officeace 分支的既有约定同构（`aggregate-expiry.ts:1141`：
            // 「`summary.stale === true` ⇒ 判 `UNUSABLE`」）。同一次改动在别处新增了
            // 这条、而面板出口把两天前的快照当实时余额显示，被审计记为
            // 「**同一份数据两层结论相反**」（`jet-hub-rpc.ts:5462`）——
            // 本行就是避免复发的那一腿。
            //
            // ⚠️ **有意的行为代价（如实登记）**：折算可能因陈旧读数而少一个候选渠道，
            // 用户表现为**聚合轮换里某个渠道暂时不出现**。这比「用 10 分钟前的数字
            // 排序」安全，且与 officeace 既有行为一致（用户 2026-10-18 明确接受）。
            if (reading.stale === true)
                return null;
            return reading.error === undefined ? reading.value : undefined;
        },
    });
    // ⚠️ 赋给上面的可变引用 ⇒ 账号入库时清空折算缓存（见那里的注释）。
    sharedExpiryProbeRef = sharedExpiryProbe;
    const aggregateAdapter = registerAggregateLlm(ctx, {
        accountPool: pool,
        expiryProbe: sharedExpiryProbe,
        // ⚠️ **函数**而非快照（P2）：设置面板改了拒绝表后，**下一次请求**就要生效。
        //    传快照会让用户以为开关坏了（要重启插件才生效）。
        //    `pool.listAggregateRejections()` 返回进程内权威副本（与 state.json 同步）。
        rejections: () => pool.listAggregateRejections(),
        // ⚠️ 同样是**函数**（不是快照），理由与 `rejections` 完全相同：面板改完开关，
        //    下一次请求就要生效。三张表都是「同一枚开关的不同域」，故接线必须一起给
        //   （漏一个 ⇒ 该功能整个不生效，且**完全静默**：例如漏 `allowed` 时，
        //   用户手工打开的未接入候选仍会被判成「默认不参与」）。
        allowed: () => pool.listAggregateAllowed(),
        order: () => pool.listAggregateOrder(),
        orderMode: () => pool.listAggregateOrderMode(),
    });
    // ⚠️ 赋给上面的可变引用 ⇒ 账号入库时**也**清候选序缓存（见那里的长注释：
    //    两个缓存不同，只清折算缓存会让「刚登录的账号」在 60 秒内仍不进候选序）。
    sharedChoiceCacheRef = aggregateAdapter;
    // ===== Jet Hub RPC 注册 =====
    // Jet Hub「自动」：一个 `auto` 模型名用整池，按「积分最快作废」跨 provider 选型
    // （见 `auto-adapter.ts` 模块头）。注册放在全部 provider 适配器之后：它经
    // ctx.llm 公开路径委托目标适配器，目录/凭据此时均已就绪。
    //
    // ⚠️ 位置在 `modelAdapters` 表**之前**：那张表要收它的实例（见下面的
    //    `'jet-hub-auto'` 键），而 `usage.badge` 对 `jet-hub-auto` 的改写依赖它。
    // ⚠️ 上游 `ba10f4f` 重写 aggregate 时把这条接线一并删掉了 ⇒ 旧 auto 的徽标
    //    彻底消失（用户报障 2026-10-08「也没胶囊了？」）。这里补回来。
    const autoAdapter = registerAutoLlm(ctx, {
        accountPool: pool,
        // ⚠️ **与 aggregate 共用同一个探针**（真实缺陷，对抗审计实测证伪）：
        //    不传时 `AutoAdapter` 会**自建一份**，于是有两份独立缓存 ⇒
        //    ① 同一渠道被折算两次（白打两次上游余额接口）；
        //    ② 缓存失效要清两次，漏一次就让「刚登录的账号最长 60 秒对路由不可见」。
        expiryProbe: sharedExpiryProbe,
    });
    // provider → 适配器实例：Jet Hub「显示列表」需要 `listAllModels()`（不受用户
    // 黑名单影响的全量目录，带最终展示名/倍率）。DSH 的 `ctx.llm` 只保证
    // `listModels`，不透传自定义方法，故这里显式把实例传下去。
    //
    // ⚠️⚠️ **必须走 `withDeadModelPruning`，不能直接用 `registerXxxLlm` 的返回值**
    // （致命缺陷，2026-10-06 复审 !66 实测）：那些函数返回的是 `new XxxAdapter(...)`
    // —— **原始实例**，而 `registerAdapterIdempotent` 只把**代理**注册进了 `ctx.llm`。
    // 于是 `jet-hub-rpc` 的 `model.list` 先 `await llm.listModels()`（走代理，已剔除），
    // 紧接着又用本表的 `listAllModels()` **覆盖**成全量目录（走原始，**未剔除**）⇒
    // 已失效模型被加回设置页，PR 想修的「用户仍看到下架模型」原问题**完全没修到**。
    //
    // 这里复用与注册**同一个**包装函数，确保两条路径的可见性一致。
    // ⚠️ `codearts` 不在 `modelAdapters` 的常规形态里，但它同样需要该包装。
    //
    // ⚠️ 包装失败**不阻断启动**：回退到原始实例即可（它只是显示层的收敛）。
    const pruned = (provider, adapter, options) => {
        try {
            return withDeadModelPruning([provider], adapter, options);
        }
        catch (error) {
            ctx.logger.warn(`[jet-hub] ${provider} 的失效模型剔除包装失败，使用原适配器: ${String(error)}`);
            return adapter;
        }
    };
    // ⚠️⚠️ 类型必须是 **`ModelCatalogSource`**，不能写成 `{ listAllModels() }`（二审 P3-1）。
    //
    //    写成「只带 `listAllModels` 的结构类型」是**合法赋值**（`catalogReadyForBulkWrite`
    //    是可选成员），所以 TypeScript **不会**报错。
    //
    // ⚠️ **但类型收敛只保护「必需」成员**（2026-11-05 三审回归面 P2-2 订正）：
    //    `catalogReadyForBulkWrite` 至今仍是**可选**成员（`src/jet-hub-rpc.ts` 的
    //    `ModelCatalogSource` 里带 `?`）⇒ 把它**改名或删除仍然是合法赋值、仍然零
    //    编译错误**。类型收敛的真实收益只有「必需成员 `listAllModels` 的签名不兼容
    //    会报错」这一条，**不要**据此以为「有类型保护了，不用加运行时守卫」。
    //    真正锁住接线的是行为级用例（`tests/unit/jet-hub-rpc.spec.ts` 里对
    //    `aggregate` 冷帧 `notReady` 的那组），**不是**这个类型别名。
    //
    //    本仓库「缺一处就静默失效」的形态已经复发过多次（`SELF_HEAL_REFRESHABLE_PROVIDERS`、
    //    `WIRED_EXPIRY_PROVIDERS` 等）⇒ 凡是「靠可选成员挂钩」的表，**判据必须打在
    //    行为上**，源码/类型级断言只能当辅助。
    const modelAdapters = {
        // ⚠️ 腾讯 Marvis（2026-11-09）：必须进这张表，理由与 modelscope / qiniu
        //    逐条相同（`provider.status` 的「已关闭」判据读的是不套黑名单的全量目录）。
        marvis: pruned(MARVIS.id, marvisAdapter),
        // ⚠️ 聚合 provider 也必须进这张表（设计文档 §5.2 的必改点）：`jet-hub-rpc.ts` 的
        // `fullCatalogIds` **优先**用本表的 `listAllModels()`（不套黑名单的全量目录），
        // 缺失时才退化到 `llm.listModels(provider)` —— 后者已被适配器按黑名单过滤。
        // 于是「关闭整个聚合 provider」时只拿到**未被关闭的** id ⇒ 已关闭的模型漏写黑名单，
        // 而 `provider.status` 的判据是 `closed = total > 0 && disabled === total`
        // ⇒ 出现「provider 显示已关闭、模型却仍可选用」的矛盾态。
        // `pruned(...)` 会包上失效模型剔除；聚合已提供**同步** `listAllModels()`，满足契约。
        // ⚠️ 但聚合必须传 `enabled: false`（**完全不参与**该机制：不记录、**也不过滤**）
        //    —— 真实缺陷（全分支终审 C2 + 审计轮次二补修的残留面）。本机制是为
        //    「**编译期兜底快照**跟不上上游下架」设计的，而聚合层的目录是**动态推导**的
        //    （上游下架后下次推导自然消失）⇒ 既不需要记录，也不该被过滤。
        //    ① **记录**的危害：外层包装观察到的是 `aggregate` + **虚拟键**（实测），于是
        //       「某一个渠道没有该 realId」被记成「**整个规范模型**失效」，而它在其余渠道
        //       上完全可用；且恢复入口 `model.clearDead` 的 UI 在设置页 provider 面板里，
        //       而客户端 `PROVIDERS` **没有 `aggregate`** ⇒ **没有任何 UI 能恢复**。
        //    ② **过滤**的危害（补修的那半）：初版只跳过记录、仍保留过滤 ⇒ 若表里**已有**
        //       旧版本写下的 `aggregate` 记录（C2 修复前跑过一次就会有），虚拟模型**仍被
        //       隐藏**，且同样无 UI 可恢复 —— 实测探针确认（预置 `aggregate/m1` 后
        //       `listModels` 只返回 `['auto','m2']`）。
        //    ⇒ 传 `enabled: false` 让本函数**直接返回原适配器**，历史遗留记录被忽略。
        aggregate: pruned(AGGREGATE_PROVIDER, aggregateAdapter, { enabled: false }),
        // ⚠️ 旧 auto 也必须进这张表：`jet-hub-rpc.ts` 的 `usage.badge` 经它取
        //    「实际转发历史 / 预测 / 倍率」（见 `ModelCatalogSource.autoState`）。
        //    ⚠️ **不能**给 `registerJetHubRpc` 加第 17 个位置参数 —— 那条派生式不变量
        //    「客户端 PROVIDERS 条数 + 1 == 形参个数」会立刻变红（实测 10 条接线断言
        //    同时失败），而它正是为了防「位置错位 = 拿 A 的实例当 B 用」。
        //    ⚠️ 同样传 `enabled: false`：auto 是**动态**的单模型（真实目标由选型决定），
        //    「编译期兜底快照跟不上上游下架」那套记录/过滤机制对它没有意义。
        'jet-hub-auto': pruned(AUTO_PROVIDER, autoAdapter, { enabled: false }),
    };
    /**
     * ★ **模型目录的后台刷新器**（用户 2026-10-18 的要求）。
     *
     * 「各个模型的模型列表缓存也要带定时更新，20 分钟更新一次，如果不更新随高峰低谷
     * 变化的积分消耗倍率是更新不到实际的倍率」
     *
     * ## ⚠️ 为什么必须建在 `modelAdapters` **之后**（位置不变式）
     *
     * 它要读那张表拿实例。早于建表 ⇒ 空表 ⇒ **目录永不刷新、且零日志**
     * （与 `wiredRefreshTargets()` 前身在 2026-10-15 踩的坑同型）。
     *
     * ## ⚠️ 为什么走 `modelAdapters` 而不是 `ctx.llm`
     *
     * `ctx.llm` 是 DSH 的公开面，**不认识** `refresh()`（那是本插件给目录契约加的可选成员）。
     * 而 `modelAdapters` 的每一项都是 `pruned()` 的 Proxy —— 它对**其余成员原样透传并绑定
     * `this`**（`src/dead-model-store.ts:748-749`），故新加的 `refresh()` 能自动透出来。
     *
     * ## ⚠️ 未实现 `refresh` 的 provider 必须跳过
     *
     * `opencode` 这类本地派生渠道（零网络）本就没有远端可拉。对它们空转会让
     * 「刷新器说跑了 9 家、实际只刷了 3 家」**完全静默**。
     */
    const catalogRefresher = createCatalogRefresher({
        listProviders: () => Object.keys(modelAdapters),
        refreshOf: (provider) => {
            const adapter = modelAdapters[provider];
            const refresh = adapter?.refresh;
            // ⚠️⚠️ **`undefined` 只能表示「这家没有该成员」**（2026-10-20 修正）：
            //    刷新器据此统计「本轮几家真的参与」，**零参与即 warn**
            //    （见 `createCatalogRefresher` 的注释）。故**不要**写成
            //    `return adapter?.refresh?.()` —— 那会让「成员存在但同步返回 void」
            //    与「成员根本不存在」不可区分，统计随之失真。
            //    ⚠️ 而本仓库实测的失效形态恰恰是「成员根本不存在」：`be42b25` 给
            //    `createModelCatalog` 的 config 加了 `refresh` 回调，却**没有**把它
            //    转发成适配器实例的成员，而该提交的注释误以为 `pruned()` 的 Proxy
            //    会把它透出来（Proxy 只透传适配器**自己的**成员）。
            if (typeof refresh !== 'function')
                return undefined;
            return Promise.resolve(refresh.call(adapter)).then(() => undefined);
        },
        info: (message) => ctx.logger?.info?.(message),
        warn: (message) => ctx.logger?.warn?.(message),
    });
    // ⚠️ 生命周期挂 `ctx.effect`，与插件一致（释放后停手）——
    //    与既有 `modelsDevTimer`、余额刷新器同款约定。
    ctx.effect(() => {
        catalogRefresher.start();
        return () => { catalogRefresher.stop(); };
    });
    // 冷启动的**有界目录预热**（issue IKJVTF 的冷启动自愈半条）。
    //
    // 为什么必须有：首拉失败后适配器回落到**静态兜底表**，客户端把这份兜底目录
    // 缓存成 `status: 'ready'`（它只认宿主事件），而**没有任何东西会在冷却到期后
    // 再问一次** —— 只有用户主动打开设置页/切模型才可能触发下一次 `listModels`。
    // 于是「远端目录其实早已可达，只是没人再问」会一直持续到用户碰巧触发重读。
    //
    // ⚠️ **间隔必须大于 `RemoteCatalogGate` 的 30 秒失败冷却**，否则重试被闸门
    // 原样挡回、什么也不做（等于没预热）。该约束由 `catalog-prewarm.ts` 的
    // `CATALOG_PREWARM_DELAYS_MS` 与 `tests/unit/catalog-prewarm.spec.ts` 共同守着。
    //
    // ⚠️ 走 `ctx.llm.listModels` 而不是适配器私有方法：它会走完整路径
    // （账号门控 → `ensureRemoteModels` → 闸门），目录已就绪时是**零网络**的，
    // 且对 `withDeadModelPruning` 包装透明（直接拿原始实例会绕过那层收敛）。
    //
    // ⚠️ **不 await**：`apply()` 是同步函数，预热会发网络请求（与既有的
    // opencode 能力预热同款约定）。停止函数挂 `ctx.effect`，插件释放后停手。
    ctx.effect(() => startCatalogPrewarm({
        providers: Object.keys(modelAdapters),
        warm: (provider) => ctx.llm.listModels(provider),
        logger: { warn: (message) => ctx.logger?.warn?.(message) },
    }));
    // ⚠️ **命名对象**（2026-10-08 改，原为 13 个位置参数）：位置参数下改顺序/插队
    // 都会**静默错位**（症状是「某个 provider 用另一个 provider 的凭据续期」），
    // 本仓库历史上因此复发 6 次。命名对象让错位在类型层面不可能，且新增 provider
    // 只加一个键。
    //
    // ⚠️ **键是 provider id `qodercn`，值是变量 `qoderCn`** —— 两者不同名是刻意的：
    // 键必须与 `entry.provider` 同形，否则按 id 取实例会落空（`authOf(auths, id)`，
    // 见 `jet-hub-rpc.ts` 的 `JetHubAuths` 注释）。本地变量名沿用既有惯例。
    // 写成 `qoderCn:` 会编译失败（接口没有该键），这正是我们要的。
    //
    // ⚠️ **分派现状**：`account.refresh` **已**改成 `authOf(auths, entry.provider)`
    // 查表分派（Task 2 完成，见 `jet-hub-rpc.ts` 的 `account.refresh` 分支）——
    // Task 9 引入命名对象时还在的那 13 个同构 `switch (entry.provider)` case
    // （含 `requireQoderFamily` 取 Qoder 同族实例那一处）**已整体删除**。
    // 上面「键必须是 provider id」那条约定正是该查表能命中 `qodercn` 的前提。
    // ===== 积分能力表（设计文档 §3.3 / Task 3）=====
    // ⚠️ 裁剪后仅保留 marvis：各家实例依赖（loomy / raccoon / zcode / lobsterai /
    //    minimax / gemini 等）已随对应供应商接线一并移除，能力条目由
    //    `provider-credits.js` 依据 provider-registry 自行派生。
    const creditsTable = createProviderCredits({});
    /**
     * **一次性奖励**能力表（原为 Loomy 新手任务 / raccoon 登录奖励）。
     * ⚠️ 裁剪后仅保留 marvis：无实例依赖，deps 为空。
     */
    const onboardingTable = createProviderOnboarding({});
    /**
     * **临期折算**能力表（供聚合 / auto 的候选排序）。
     * ⚠️ 裁剪后仅保留 marvis：minimax 的 XFF / 按账号出口与 qoder 的按账号出口
     *    deps 已随对应供应商接线一并移除。
     */
    const expiryTable = createProviderExpiry({});
    // ===== 能力注册表（设计文档 §3.3）=====
    //
    // ⚠️ **本段是前瞻接线**（2026-10-08 调序后修正）：`account.refresh` 的分派
    //    **不走**这张表 —— 它查 Task 9 引入的 `auths` 形参（见 `jet-hub-rpc.ts` 的
    //    `authOf`）。本表是给**真正跨模块**的消费点用的：Task 5 的
    //    `aggregate-expiry.ts` 与 Task 8 的 `account-probe.ts` ——
    //    那两个模块拿不到 `auths` 形参。
    //
    // ⚠️ 仍必须在**所有 provider 实例都已创建之后**注册：实例要先存在。
    //
    // ⚠️ 注册的是**引用**，不是快照：`registerProviderRuntime` 只记 Map 条目，
    //    各 auth 实例的后续状态变化（凭据缓存、队列）对它透明。
    //
    // ⚠️ 这里**不注册 opencode**（它没有续期概念）与 aggregate / auto
    //    （虚拟 provider，无账号无凭据）。它们的 runtime 只有 descriptor。
    //    ⚠️ opencode 的积分也**不在** `creditsTable` 里（它的余额是本地派生的
    //    通道可用性、零网络，作为特例留在 `credits.balances` 里短路）。
    {
        const registry = [
            // ⚠️ 腾讯 Marvis（2026-11-09）：必须**单独一行**。漏加 = 它不进注册表
            //    ⇒ 续期 / 积分 / 探测三条链路全部**静默失效**。
            ['marvis', marvisAuth],
        ];
        for (const [id, auth] of registry) {
            const descriptor = descriptorOf(id);
            if (descriptor === undefined) {
                // ⚠️ 不静默跳过：registry 与这里的清单漂移会表现为「某个 provider 的功能没了」。
                ctx.logger?.warn?.(`[jet-hub] provider registry 缺少声明：${id}`);
                continue;
            }
            // ⚠️ 返回值必须判：`false` 表示「已存在、跳过了本次」——
            //    那发生在 **fiber 重启竞态**（新 apply 与旧 dispose 交错），是正常现象，
            //    记一条 info 即可（不是错误）。静默忽略会让「某个 provider 的注册被跳过」
            //    在日志里无痕。
            const registered = registerProviderRuntime({
                descriptor,
                auth: {
                    // ⚠️ 只传三个参数、顺序固定 —— 各家的 `refreshAccountCredential` 签名一致
                    //（本插件的统一 auth 契约）。包一层而不是直接挂方法引用：直接挂会让
                    // `this` 丢失（各家方法内部用 `this.product` / `this.ctx`）。
                    refreshAccount: (refName, pool, accountId) => auth.refreshAccountCredential(refName, pool, accountId),
                    // ⚠️ **每个会写限流标记的家都要挂**：漏一家 ⇒ 该家凭据**永不自动续期**，
                    //    而症状是「每隔一段时间就要重新登录」，且日志里一个字都没有。
                    // ⚠️ **真正锁住这件事的只有 `provider-runtime-wiring.spec.ts`**
                    //    （它真跑 `apply()`，再逐个驱动 `auth.refreshAll` 并断言打到
                    //    **自己那个**实例）。2026-10-08 独立复审修正原注释：它原先点名
                    //    `refresh-targets-derived.spec.ts` 与 `refresh-bootstrap-wiring.spec.ts`
                    //    各有一条 —— 实测**两者都不 import `index.ts`**，
                    //    它们注册的是**自己的桩**再断言桩，改坏本段循环它们照样全绿
                    //    （`refresh-targets-derived.spec.ts` 的用例⑦ 现锁的是
                    //    `modelAdapters` 的键，与本段无关）。
                    // ⚠️ 包一层而不是直接挂方法引用：直接挂会让 `this` 丢失
                    //   （各家 `refreshAll` 内部用 `this.product` / `this.ctx`）。
                    refreshAll: (pool) => auth.refreshAll(pool),
                },
                // ⚠️ `creditsOf` 而非 `creditsTable[id]`：`in`/下标会命中原型链上的键
                //（如 `constructor`），与 `jet-hub-rpc.ts` 的 `authOf` 同因。
                // ⚠️ qoder 系**没有** credits 条目（形态不匹配，是特例），故这里
                //    对它们是 `undefined` —— 如实表达「该渠道不在表里」。
                credits: creditsOf(creditsTable, id),
                // ⚠️ 与 credits 同法：`onboardingOf` 而非下标（原型链键误判）。
                // ⚠️ 只有 loomy / raccoon 有条目 —— 其余如实为 `undefined`。
                onboarding: onboardingOf(onboardingTable, id),
                // ⚠️ 与 credits / onboarding 同法：`expiryOf` 而非下标（原型链键误判）。
                // ⚠️ 只有**已接入临期折算**的渠道有条目 —— 其余如实为 `undefined`
                //    （那是「未接入」的诚实表达：`credentialExpiry` 据此返回 `UNUSABLE`）。
                //    ⚠️ `WIRED_EXPIRY_PROVIDERS` **不**从这里派生（它是编译期常量），
                //    两者的一致性由 `expiry-runtime-parity.spec.ts` 真跑 `apply()` 锁死。
                expiry: expiryOf(expiryTable, id),
                // ⚠️ 与其余域同法：`probeById[id]` 用 `Object.hasOwn` 语义（下标会命中原型链）。
                // ⚠️ **`probeById` 已登记全部会写限流标记的家**（判据 = `probeById` 头注释
                //    里那两条 grep；权威清单 = `tests/helpers/provider-sets.ts` 的
                //    `WRITES_RATE_LIMIT_PROVIDERS`），
                //    其余如实为 `undefined`（`adapterForProbe` 据此抛「不支持重测」，
                //    不落回 CodeArtsAdapter）。
                //    ⚠️ **刻意不写「几家」、也不抄名单**：本句曾写「现登记 **12 家**」，
                //    实测顶层键是 13；2026-10-11 加入 `minimax`（issue IKJW32）后是 14 ——
                //    同一事实的多份抄写必然漂移（`probeById` 头注释、本段、
                //    `account-probe.ts` 的判据都各抄过一份）。数字与名单一律看
                //    `probeById` 的键与 `WRITES_RATE_LIMIT_PROVIDERS`，两边由守卫双向比对。
                //    ⚠️ 原注释写「只有 zcode / gemini / trae 注册」，那是 Task 8 计划里的
                //    **样例**被留在了原地（2026-10-08 独立复审发现）；完整名单与缺项
                //    见 `probeById` 自己的头注释（别在这里再抄一份易腐的清单）。
                ...Object.hasOwn(probeById, id) ? { probe: probeById[id] } : {},
            });
            if (!registered) {
                ctx.logger?.info?.(`[jet-hub] provider runtime "${id}" 已注册（插件 fiber 重启竞态），跳过本次`);
            }
        }
    }
    registerJetHubRpc(ctx, pool, {
        // ⚠️ 腾讯 Marvis（2026-11-09）：值必须是上面 registry 数组里
        //    `['marvis', marvisAuth]` 的**同一个实例**，否则 spec 布在该实例上的
        //    spy 收不到调用（本仓库复发过 6 次）。
        marvis: marvisAuth,
    }, modelAdapters);
    // 网关是旁路功能：这里传 `pool` 只为读设置页里的开关，其内部任何失败都已
    // 自行降级为日志，绝不会让插件 apply() 失败。
    mountOpenAiGateway(ctx, pool);
    // 思考死循环被中止后的**自动续跑**：把此前必须由用户手打「继续」的那一步
    // 自动化（真实报障 2026-10-04，见 `loop-recovery.ts` 模块头）。
    // ⚠️ 它依赖 `agents` 服务，故内部用 `ctx.inject(['agents'], …)` 挂载：
    // 该服务缺席的 profile 里本功能整体不生效，不会让插件永久 pending。
    installLoopResume(ctx);
    ctx.provide('accountPool', pool);
}
//# sourceMappingURL=index.js.map