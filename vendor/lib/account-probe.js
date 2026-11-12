/**
 * 限流标记重测（retest）与重置（reset）。
 *
 * 背景：账号卡片上的「限额重置」只是**一次 429 事件的快照**——它记录的是
 * 服务端当时给出的"预计恢复时间"，而不是该账号此刻的真实可用性。服务端
 * 常在重置时间到达前提前放行，于是出现「显示超额使用但发消息正常回复」。
 * 本模块让用户能主动验证并清理这些过期标记。
 *
 * 两个动作，语义严格区分：
 *
 * - **重测（retest）**：对每个带限流标记的模型**真实发一次最小对话请求**。
 *   只有请求正常完成才清除该模型的标记；仍被拒绝（限流）则保留标记，并把
 *   原因回传给 UI。这样标记始终反映"最近一次实测结果"。
 * - **重置（reset）**：不做任何网络请求，直接清除标记。用于用户已知额度
 *   已恢复、只想清掉显示的情况。
 *
 * 与 e2e 探针（tests/e2e/buddy-ratelimit-probe.e2e.spec.ts）的关系：两者都
 * 发真实请求判定限流，但 e2e 用于人工排查、本模块供设置页按钮调用。为避免
 * 逻辑漂移，这里直接复用**真实适配器**（BuddyAdapter / CodeArtsAdapter）走
 * 完整请求链路，而不是各自手写 HTTP。
 *
 * 两点关键设计：
 *
 * 1. **不传 accountPool 给适配器**。适配器只在拿到 accountPool 时才会切换
 *    账号、写限流标记；探测必须只针对**指定账号**、且不能产生副作用，否则
 *    "重测 A 账号"会顺带污染其他账号的标记。
 * 2. **停用账号也要能重测**。用户明确要求这一点，因此凭据解析走
 *    `resolveCredentialForAccount`（按 id，不检查 enabled），而非
 *    `getAvailableAccount`（自动选择，只认启用账号）。
 */
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm';
import { nextUtc8DayStartMs } from './model-queue.js';
import { runtimeOf } from './provider-runtime.js';
/** 探测请求的提示语（与 e2e 探针保持一致，最大化可比性）。 */
const PROBE_PROMPT = '只回答两个字：收到';
/**
 * 探测请求的 system 提示。
 *
 * ⚠️ **不可省略，也刻意不随产品切换**（真实缺陷，用户报障）。
 *
 * WorkBuddy 国际版网关（`www.workbuddy.ai`）**强制要求 `messages[0]` 是
 * `role:'system'`**，否则返回 HTTP 400 + `code 11128`
 * `"first message is not system prompt"`，且 `displayMsg` 把它**伪装成安全
 * 策略拦截**（「请求被安全策略拦截，请稍后重试或联系支持」）—— 与真实的限流/
 * 可用性毫无关系。
 *
 * 早期 `probeWithAdapter` 只传 `messages`、不传 `options.system`，而适配器仅在
 * `options.system` 非空时才 `unshift` system（见 `buddy-adapter.ts`），于是
 * wire 上首条就是 user。后果：WorkBuddy 面板的「重测 / 重测所有」**恒不可用**
 * ——既拿不到「已恢复」也拿不到「仍受限」，只有一句误导性的安全策略报错。
 *
 * 实测（2026-09-25，同一凭据各发一次最小请求）：
 *
 * | 端点 | 无 system | 有 system |
 * |---|---|---|
 * | `www.workbuddy.ai`（WorkBuddy） | **400 + 11128** | 200 正常 |
 * | `copilot.tencent.com`（CodeBuddy） | 200 正常 | 200 正常 |
 *
 * 即**只有 WorkBuddy 网关**有此硬性要求，但这里**无条件**给所有 provider 都带
 * 上：① 判据不该依赖「另一个产品碰巧不校验」这种易变的外部事实；② 探测本身
 * 与 system 内容无关，带上它对结论无影响；③ 分支特判会让将来新增的 provider
 * 再次踩同一个坑。
 *
 * 内容取最小可用值（对齐 `tests/e2e/buddy-pool-probe.e2e.spec.ts` 与
 * `scripts/verify-max-tokens.mjs` 里已被验证可用的同一句）。
 */
const PROBE_SYSTEM = 'You are a helpful assistant.';
/**
 * 单次探测的超时（毫秒）。
 *
 * CodeArts 适配器在排队时会以 10 秒间隔重试 chat 请求、最长 30 分钟
 * （QUEUE_MAX_ATTEMPTS）。设置页按钮显然不能等那么久，因此这里用
 * AbortSignal 给每次探测设硬上限：超时即判定"未能确认恢复"，保留标记。
 * 宁可保守留标记，也不要因为等太久让 UI 卡死。
 */
const PROBE_TIMEOUT_MS = 120_000;
/**
 * 判断一次探测失败是否**属于限流**。
 *
 * 区分限流与其他失败（鉴权过期、网络中断）很重要：只有限流才算
 * "标记仍然有效"，其他失败说明"无法确认"，两种都应该保留标记，
 * 但回传给用户的文案不同。
 */
function isRateLimitFailure(error) {
    if (error instanceof LlmError) {
        // buddy/codearts 用字面量 'QUOTA_EXCEEDED'，harness 常量 QUOTA_EXCEEDED_CODE
        // 是 'QUOTA'——两者都认，避免因词汇差异把限流误判成"未知错误"。
        if (error.code === 'RATE_LIMIT' || error.code === 'QUOTA_EXCEEDED' || error.code === 'QUOTA')
            return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    return isRateLimited(message);
}
/**
 * 按 provider 找到它的**探测适配器工厂**并造一个实例（Task 8）。
 *
 * ## ⚠️ 为什么未登记时**必须抛**，而不是落回某个默认适配器
 *
 * 旧实现是一条 `else if` 链，末尾的 `else` 兜底把**未登记的 provider** 交给
 * 「**华为云 HMAC 签名**的 `CodeArtsAdapter`」去发别家凭据 ⇒
 * 探测**必然失败**，而该 provider 的限流标记（UTC+8 当日 24:00）**永远清不掉**。
 * 症状只是「重测按钮点了没用」—— 极难定位（`account-probe.ts` 的注释记录该缺陷
 * **同型复发 4 次**：workbuddy → trae → qoder/qodercn/cline → zcode）。
 *
 * ⇒ 改为查能力注册表：**未登记 ⇒ 抛可读错误**（带 provider 名）。
 * 这是**行为收紧**：未登记的渠道从「发一次必然失败的请求」变成「明确报不支持重测」。
 * ⚠️ **该收紧是用户可见的**（2026-10-08 独立复审修正原注释的错误推论）：
 * 原注释称「客户端能力表 `accountTest` 目前**只有 `gemini`**，故其余渠道本就没有入口」——
 * 实测 `jet-hub.js` 里「重测所有」/「重置所有」/卡片级「重测」「重置」由
 * **`supportsRateLimit`**（缺省 `true`）门控，与 `accountTest`（另一个「测试」按钮）
 * **不是一个位** ⇒ 这些按钮对**所有未豁免 `rateLimit: false` 的渠道都会渲染**。
 * 故本函数抛出的错误是**用户点得到**的路径（经 RPC 外层 catch 变成
 * `jet-hub/handler-failed`），不是纯内部契约。
 *
 * ⚠️ 判据是 `runtime?.probe === undefined` —— **不能**只看 `runtimeOf(provider)`
 * 是否有值：只注册了 `expiry` 等其它域的 provider **同样不支持重测**。
 */
export function adapterForProbe(provider, refName, credential, entry) {
    const runtime = runtimeOf(provider);
    if (runtime?.probe === undefined) {
        // ⚠️ 必须抛，不得落回 CodeArtsAdapter：那会用华为云 HMAC 签名去打别家端点，
        //    探测必然失败而限流标记永远清不掉（zcode / gemini 各踩过一次）。
        throw new Error(`${provider} 没有探测适配器（该 provider 不支持重测）`);
    }
    return runtime.probe.createProbeAdapter(refName, credential, entry);
}
/** 用真实适配器对指定账号的指定模型发一次最小请求。 */
async function probeWithAdapter(entry, credential, modelId, timeoutMs) {
    const signal = AbortSignal.timeout(timeoutMs);
    // 刻意不传 accountPool / fetchRemoteModels：
    // - 不传 accountPool → 只测这一个账号，且探测本身不写限流标记；
    // - 不传 fetchRemoteModels → 避免为一次探测额外拉取远端模型目录。
    //
    // refresh 设为 no-op：探测不应触发全局续期流程（那会影响其他账号与
    // 其他并发会话），凭据真的过期就让它以 AUTH 失败并如实上报。
    //
    // **七条产品线各自选适配器**，顺序不能颠倒也不能漏判：
    // - CodeBuddy 系（buddy / workbuddy）→ BuddyAdapter，按各自 product 发请求；
    // - LobsterAI → LobsteraiAdapter（自己的端点与头族）；
    // - Qoder 系（qoder / qodercn）→ QoderAdapter（WASM 加密体 + 签名头族）；
    // - Cline → ClineAdapter（WorkOS 凭据 + 自己的端点）；
    // - ZCode（智谱）→ ZcodeAdapter（Anthropic Messages 体 + 阿里云 captcha 参数）；
    // - TRAE → TraeAdapter（SOLO 格式请求体 + Cloud-IDE-JWT 头族）；
    // - 其余（codearts）→ CodeArtsAdapter（华为云 HMAC 签名）。
    //
    // ⚠️ **这个分派表已四次因「新增 provider 没同步」而出缺陷**，改它前先读完：
    //
    // 1. 初版只判断 `provider === 'buddy'` → workbuddy 落入 else，用华为云
    //    HMAC 签名去发 WorkBuddy 凭据而必然失败；
    // 2. 加了 lobsterai 分支后**仍漏掉 trae** → TRAE 账号同样落入 else，
    //    用 CodeArts 签名发 TRAE 请求而必然失败（2026-09-25 排查 workbuddy
    //    缺陷时发现，实测 `productById('trae')` 与 `lobsteraiProductById('trae')`
    //    均为 undefined）；
    // 3. 加了 trae 分支后**仍漏掉 qoder / qodercn / cline** → 三者同样落入
    //    else，被交给 CodeArtsAdapter 用华为云 HMAC 签名去发 Qoder / Cline
    //    凭据。它们的「重测 / 重置」按钮**确实会渲染**（`RATE_LIMIT_CAPABILITIES`
    //    对未登记的 provider 默认视为有限流，当时只有 loomy 显式登记为 false），
    //    且 Qoder 的额度受限**每次都会**写 `modelRateLimits`（按 UTC+8 当日
    //    24:00 标记），于是「点重测 → 拿到签名错误 → 标记也清不掉」成为稳定
    //    可复现的死循环；
    // 4. 补上 qoder / qodercn / cline 之后**仍漏掉 zcode**（本次）→ 同型第 4 次。
    //    它的写入点 `zcode-adapter.ts` 的 `switchAccountOnQuota()` 与 Qoder
    //    **完全同款**（同样按 UTC+8 当日 24:00 标记该模型），而那个写入点是
    //    在本分支建立**之后**才进 master 的 —— 正是「清单靠记忆维护」必漏的情形。
    //
    // ⚠️ **判据是「该 provider 会不会写 `modelRateLimits`」**（写了才有重测按钮、
    // 才需要在这里分派）。但**不要靠记忆维护清单**，直接机械核对写入方：
    //
    //     grep -n 'updateModelRateLimit(' src/*.ts    # 写点（池侧定义 + 各适配器直调）
    //     grep -n 'markLimited' src/*.ts              # 适配器侧经回调注入的写点
    //
    // ⚠️ **两条都要跑**：多数适配器是**直调** `pool.updateModelRateLimit(...)`，
    // 只有 `cline` / `opencode` 用 `markLimited` 这个名字 —— 只看第二条会把
    // 大部分家漏掉。
    //
    // ⚠️ **2026-10-08 独立复审修正：上面这段旧注释里有两处已过时的判断，
    // 原文保留在下方供对照，但**不得**再按它们维护清单**：
    //
    // - 旧文说「反例：loomy 的积分耗尽时静默降级、**不写**标记，故它落 else 无害」
    //   —— **实测证伪**：`loomy-adapter.ts` 有 `markLimited` 调用点，且 Task 8 已把
    //   loomy **加入注册**（同段旧文的末尾也这么写了，两半自相矛盾）。
    //   真相是：loomy 的**积分耗尽**确实静默降级不写标记，但它的**其它**限流类失败
    //   会写 —— 判据要看「有没有写点」，不是「某一种失败写不写」。
    // - 旧文说「反例：minimax 与 opencode **不写**标记」—— 对 **`opencode` 证伪**
    //   （`opencode-adapter.ts` 3 处 `markLimited`）。opencode 曾因此不在
    //   `index.ts` 的 probe 表里，理由是「探测材料拿不到」——
    //   ⚠️ **那个理由 2026-10-08 第二轮已实测证伪并补齐**（见 `index.ts` 的
    //   `probeById.opencode` 条目）：真正缺的只是「把 `entry` 交给工厂」。
    //   ⚠️ **对 `minimax` 的那半也已在 2026-10-11 证伪**（issue IKJW32）：它原先
    //   确实零写点，接上请求级换号 + 冷却后会写 `modelRateLimits`（额度 24h /
    //   限流 1h）⇒ 必须进 `probeById`。**这条旧文两次都被证明是「当时的快照」**，
    //   正是「清单靠记忆维护」必漏的又一个实例：判据只能是「现在有没有写点」。
    //   现在本链**14 家全在**，`PROBE_EXEMPT` 仍为空表。
    // ⚠️ **2026-10-08 Task 8：本链已改为查能力注册表**（原为 `else if` 链 + `else` 兜底）。
    //
    // 原实现的 `else` 会把**未登记的 provider** 交给「**华为云 HMAC 签名**的
    // `CodeArtsAdapter`」去发别家凭据 ⇒ 探测必然失败，而该 provider 的限流标记
    //（UTC+8 当日 24:00）**永远清不掉**（症状只是「重测按钮点了没用」，极难定位）。
    // ⚠️ 该缺陷**同型复发 4 次**：workbuddy → trae → qoder/qodercn/cline → zcode，
    // 根因是「清单靠记忆维护」。
    //
    // ⇒ 现在各家在 `src/index.ts` 注册 `probe.createProbeAdapter`，
    // **未登记 ⇒ 抛可读错误**（见 `adapterForProbe`），不再有 `else` 兜底。
    //
    // 新增 provider 时**先跑上面那两条 grep**，再补 `index.ts` 的注册与
    // `tests/unit/account-probe-adapter.spec.ts` 的对应用例；
    // 「登记了哪些家、哪些家刻意不登记」由 `index.ts` 的 `probeById` 头注释
    // 与 `PROBE_EXEMPT` 说明，本处不再重复一份易腐的清单。
    const adapter = adapterForProbe(entry.provider, entry.credentialRef, credential, entry);
    try {
        for await (const _chunk of adapter.stream({
            provider: entry.provider,
            model: modelId,
            messages: [createUserMessage({
                    content: [{ type: 'text', text: PROBE_PROMPT }],
                    source: { kind: 'user' },
                })],
            // ⚠️ **必须传 system**，否则 WorkBuddy 网关返回 400 + code 11128
            // 「first message is not system prompt」（伪装成安全策略拦截），
            // 使重测恒不可用。详见 PROBE_SYSTEM 的注释。
            system: PROBE_SYSTEM,
            signal,
        })) {
            // 消费整个流即可：能正常结束就说明服务端接受并完成了这次请求
            //（未被限流）。即使正文为空（少数模型只回 finish）也不算限流。
        }
        return { modelId, ok: true };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isRateLimitFailure(error)) {
            // [patch-codearts-probe-ratelimit] 上游的重置时刻是**滚动**的：每次撞限流都会
            // 把它往后推。这里必须把它解析出来一并回传，否则调用方只能保留存储里的旧值，
            // 旧值过期后 UI 就不再渲染「限额重置」（表现为"重测说仍受限、卡片却没有"）。
            // 解析失败（文案无时间）时不带该字段，调用方按「无法确认」处理、保留原标记。
            //
            // ⚠️⚠️ **额度耗尽（14018）不能用 `parseRateLimitError` 的 1 小时兜底**
            // （Gitee IKQ6HJ，2026-10-25 修）：它的报文里没有时间字段，而那 1 小时会让
            // 账号每小时被重新选中一次、必然再失败一次。
            //
            // ⚠️⚠️ **两条腿必须逐字同形**（对抗审计实测的真缺陷，本行第一版就是错的）：
            // 推理腿（`buddy-adapter.ts`）算的是
            // `explicitRateResetAtMs(errorText) ?? creditExhaustedResetAtMs()`，
            // 而本行第一版**只有后一半** ⇒ 同一条报文（14018 码 + 显式 `reset at` 时刻）
            // 在两条腿上算出**两个不同的解禁时刻**：
            // | 路径 | 报文含显式时刻时写下的标记 |
            // |---|---|
            // | 推理腿 | `2099-12-31T15:59:59Z`（按服务端声明） |
            // | 探测腿（第一版） | `2026-10-25T16:00:00Z`（按自然日） |
            // ⇒ 用户点一次「重测」就看到解禁时间跳变。**这不是理论风险**：实测两值不同。
            // 故这里补上 `explicitRateResetAtMs`，与推理腿逐字同形。
            //
            // ⚠️ 为什么不把两处抽成「一个函数」：探测层**不得**反向 import
            // `buddy-adapter.ts`（`account-probe-adapter.spec.ts` 会 `vi.mock` 它，
            // 让导出一起变成 `undefined`）。共享的只能放在 `llm-adapter.ts`，而
            // 「显式优先 + 自然日兜底」这两个原语已经都在那里 ⇒ 两处写出**同一个表达式**
            // 是本仓库在此约束下的最优解；该表达式由本文件与 buddy 两侧的用例共同锁住
            // （任一侧少了 explicit 腿，那条「服务端给了时刻以它为准」的用例就会红）。
            const parsed = parseRateLimitError(message, modelId);
            //
            // ⚠️⚠️ **入参是「适配器压平后的 message」，不是原始报文** —— 这带来一条
            // 已实测的窄风险（对抗审计 2026-10-25 登记，未修）：
            // `isCreditExhausted` 有一条**文案腿**（`积分|额度|余额` + `不足|耗尽|用尽`），
            // 它扫的是这段被包装过的文本。实测一条**普通限流**报文
            // `{"code":429,"msg":"所有账号的「15 天内到期」积分都已用尽…"}` 命中
            // `积分.{0,4}用尽` ⇒ 被判「额度耗尽」⇒ 写下**自然日**冷却，
            // 而它本该走 `+1h` / 服务端时刻。
            //
            // 触发面窄（要求 429 正文含那几句确定性格式），故**仅登记不改判据**：
            // 收窄文案腿会让「上游改措辞」时漏判（更常见的失败形态），
            // 而收窄的收益只是这一格。若将来实测到该形态，正确修法是
            // **让探测腿能拿到原始报文**（在 `ProbeModelResult` 上加一个原始 body 字段），
            // 而不是继续在压平文本上加正则。
            const creditExhausted = isCreditExhausted(message);
            const resetTimeMs = creditExhausted
                ? explicitRateResetAtMs(message) ?? creditExhaustedResetAtMs()
                : parsed?.resetTimeMs;
            return {
                modelId,
                ok: false,
                // ⚠️ **额度耗尽不能只说「仍受限」**（Gitee IKQ6HJ 的另发现 1）：
                // 那个词把用户引向「等一会儿再试」，而真实出路是「等次日配额或充值」。
                // 两者在上游是**完全不同的恢复机制**，文案必须分出档次。
                //
                // ⚠️⚠️ **文案不得断言「已按 …… 设置」**（对抗审计实测为假话，本仓库红线）：
                // `AccountPool.updateModelRateLimit` 的语义是「只接受更长的时刻」
                //（`markerUnchanged = currentValid && current >= resetAtMs` ⇒ 静默忽略），
                // 而探测层**无从知道**这次写入是否真的生效 —— 池里若已有一个更晚的标记
                // （历史遗留，或 P0-2 那种两腿不一致的现场），存储里仍是旧值，而文案却说
                // 「已按当日 24:00 设置」。实测：写入被忽略时存储留 `2099-12-31`，文案照旧。
                //
                // ⇒ 处置：**只说事实**（额度耗尽、出路是等次日/充值），把「实际生效时刻」
                // 交给 UI 已有的 `resetTimeMs` / 徽章渲染 —— 那是从存储读出来的真值。
                //
                // ⚠️ 判据只用共享层的 `isCreditExhausted`，**不得**在这里 import
                // `buddy-adapter.ts` 的 `isContentRejection` /
                // `isChannelVerificationRejection`：探测层反向依赖某个渠道的适配器会
                // 被 `account-probe-adapter.spec.ts` 的 `vi.mock` 一起变成 `undefined`
                // （该陷阱已在本 issue 里被真实踩到一次）。其余两档（账号被封 /
                // 请求形态被拒）由上游原文自带指引（「账号存在异常行为，已被限制使用」
                // / 「请求被拦截」），故只做本档的措辞分辨。
                message: creditExhausted
                    ? `额度已耗尽（不是频率限流）：该账号在该模型上的配额用光 —— 请等次日配额重置或充值；${message}`
                    : `仍受限：${message}`,
                ...resetTimeMs !== undefined ? { resetTimeMs } : {},
            };
        }
        return { modelId, ok: false, message: `无法确认：${message}` };
    }
}
/** 默认探测实现：解析该账号凭据后用真实适配器发请求。 */
function makeDefaultProbe(pool, timeoutMs) {
    return async (entry, modelId) => {
        const credential = await pool.resolveCredentialForAccount(entry.id);
        if (credential === undefined) {
            return { modelId, ok: false, message: '无法确认：凭据不可用' };
        }
        return probeWithAdapter(entry, credential, modelId, timeoutMs);
    };
}
/**
 * 重测单个账号：对该账号每个带限流标记的模型发一次真实请求，
 * 正常返回的模型清除标记。
 */
export async function retestAccount(pool, accountId, deps = {}) {
    const entry = pool.findAccount(accountId);
    if (entry === undefined) {
        return { accountId, tested: 0, cleared: [], stillLimited: [], error: `账号 ${accountId} 不存在` };
    }
    const modelIds = Object.keys(entry.modelRateLimits ?? {});
    const result = {
        accountId,
        nickname: entry.nickname,
        tested: modelIds.length,
        cleared: [],
        stillLimited: [],
    };
    if (modelIds.length === 0)
        return result;
    const probe = deps.probe ?? makeDefaultProbe(pool, deps.timeoutMs ?? PROBE_TIMEOUT_MS);
    for (const modelId of modelIds) {
        const outcome = await probe(entry, modelId);
        if (outcome.ok)
            result.cleared.push(modelId);
        else
            result.stillLimited.push(outcome);
    }
    // 只有实测通过的模型才清除标记；仍受限/无法确认的一律保留。
    if (result.cleared.length > 0) {
        await pool.clearModelRateLimits(accountId, result.cleared);
    }
    // [patch-codearts-probe-ratelimit] 对「仍受限且上游给出了新重置时刻」的模型，
    // 把**新时刻**写回存储。不写回的话，存储会一直停在第一次撞限流的旧时刻；
    // 旧时刻过期后 UI 不再渲染「限额重置」（卡片空白），而账号实际仍在受限，
    // 选号逻辑也会误判为可用。上游时刻是滚动的，每次重测都可能往后推。
    for (const outcome of result.stillLimited) {
        if (outcome.resetTimeMs === undefined)
            continue;
        await pool.updateModelRateLimit(accountId, outcome.modelId, outcome.resetTimeMs);
    }
    /**
     * ★ 全部被测模型**都通过** ⇒ 这个账号显然没被封（Gitee issue IKS2MV）：
     * 清掉账号级封禁标记，否则它会被选号侧永久排除、只能靠用户手动「重置」捞回来。
     *
     * ⚠️ 判据是 `tested > 0 && stillLimited.length === 0`：一次都没测（`tested === 0`）
     * 不能证明任何事；有一个模型仍受限也说明账号还没恢复（封禁是账号级，但
     * 「仍受限」也可能是限流，两者都该保守处理）。
     */
    if (result.tested > 0 && result.stillLimited.length === 0 && typeof pool.clearAccountPolicyBlocked === 'function') {
        await pool.clearAccountPolicyBlocked(accountId);
    }
    return result;
}
/**
 * 重测某 provider 下的**全部**账号（含已停用账号）。
 *
 * 顺序执行而非并发：探测会真实消耗模型额度，并发发起容易触发真正想验证的
 * 限流，反而得到假阳性。
 */
export async function retestAllAccounts(pool, provider, deps = {}) {
    const entries = pool.listAccountsByProvider(provider);
    const accounts = [];
    for (const entry of entries) {
        accounts.push(await retestAccount(pool, entry.id, deps));
    }
    return {
        accounts,
        clearedCount: accounts.reduce((sum, a) => sum + a.cleared.length, 0),
    };
}
/**
 * 挑一个「测试」要用的模型 id（纯函数，无 IO —— 便于单测覆盖优先级）。
 *
 * 优先级：调用方显式指定 > 已有的限流标记 > 全量目录第一个。
 *
 * ## 为什么标记优先于目录
 *
 * 用户点「测试」最常见的动机是「这个账号显示着限流标记，它到底恢复了没有」，
 * 而那个标记指向的模型正是他关心的。取目录第一个（如 CodeBuddy 的
 * `glm-5.2`）会测一个与标记无关的模型 —— 结果既不能清标记、也不能解释标记。
 *
 * ## 为什么没有目录时返回空串而不是猜一个
 *
 * 猜错的模型名会得到 404，把「账号不可用」与「模型名不对」两件事混成同一条
 * 报错，用户据此会去做完全错误的动作（重新登录）。故调用方拿到空串时应
 * **如实报错**，而不是发出去。
 *
 * @param catalogIds 该 provider 的全量模型目录（调用方按需读取，可为空数组）。
 */
export function pickTestModel(entry, catalogIds, requested) {
    if (typeof requested === 'string' && requested !== '')
        return requested;
    const marked = Object.keys(entry.modelRateLimits ?? {})[0];
    if (marked !== undefined)
        return marked;
    return catalogIds[0] ?? '';
}
/**
 * 「测试」单个账号：**无条件**真发一次请求，且不做任何存储写入。
 *
 * ## 与 {@link retestAccount} 的区别（这是本函数存在的全部理由）
 *
 * `retestAccount` 的触发条件是 `Object.keys(entry.modelRateLimits ?? {})`：
 * 账号没有限流标记时它在 `modelIds.length === 0` 处**提前返回，一次请求都不发**。
 * 于是「这个账号到底还能不能用」在**没有历史 429** 时没有任何手动探活入口 ——
 * 用户点「重测」看到瞬间返回，会以为按钮失灵（真实报障：
 * 「重测按钮你确认过会发请求吗，为什么响应这么快？」）。
 *
 * `testAccount` 不看标记、不下发清除指令、不写回重置时刻：它只回答
 * 「这一发请求成功了吗」。故它**不需要** `modelRateLimits` 存在，
 * 也不改变任何存储状态 —— 这一点与重测是硬性区别，不可为了复用而合并。
 *
 * @param modelId 要测的模型 id，由 {@link pickTestModel} 决定。
 */
export async function testAccount(pool, accountId, modelId, deps = {}) {
    const entry = pool.findAccount(accountId);
    if (entry === undefined) {
        return { accountId, modelId, ok: false, message: `账号 ${accountId} 不存在` };
    }
    const probe = deps.probe ?? makeDefaultProbe(pool, deps.timeoutMs ?? PROBE_TIMEOUT_MS);
    let outcome;
    try {
        outcome = await probe(entry, modelId);
    }
    catch (error) {
        // 探测函数本身抛错（凭据解析异常等）：如实回报，不冒泡成 handler-failed。
        const reason = error instanceof Error ? error.message : String(error);
        return { accountId, modelId, ok: false, message: `无法确认：${reason}` };
    }
    return {
        accountId,
        ...entry.nickname === undefined ? {} : { nickname: entry.nickname },
        modelId: outcome.modelId,
        ok: outcome.ok,
        ...outcome.message === undefined ? {} : { message: outcome.message },
        ...outcome.resetTimeMs === undefined ? {} : { resetTimeMs: outcome.resetTimeMs },
    };
}
/**
 * 重置单个账号：不测试，直接清除该账号的全部限流标记。
 * @returns 清除的标记条数与涉及的账号数（此处恒为 0 或 1）。
 */
/**
 * 重置单个账号的限流标记。
 *
 * ⚠️ 同时清掉**账号级封禁标记**（Gitee issue IKS2MV）：这是「重置」按钮的语义
 * ——「我确认这个账号现在是好的，把它的坏状态全清掉」。只清限流而留下封禁，
 * 会让用户点了重置、面板仍红、选号仍排除它（按钮看起来失灵）。
 */
export async function resetAccount(pool, accountId) {
    const cleared = await pool.clearModelRateLimits(accountId);
    const policyCleared = typeof pool.clearAccountPolicyBlocked === 'function'
        ? await pool.clearAccountPolicyBlocked(accountId)
        : false;
    return { clearedCount: cleared, accountCount: cleared > 0 || policyCleared ? 1 : 0 };
}
/** 重置某 provider 下全部账号（含已停用账号）的限流标记与封禁标记。 */
export async function resetAllAccounts(pool, provider) {
    const entries = pool.listAccountsByProvider(provider);
    let clearedCount = 0;
    let accountCount = 0;
    for (const entry of entries) {
        const cleared = await pool.clearModelRateLimits(entry.id);
        const policyCleared = typeof pool.clearAccountPolicyBlocked === 'function'
            ? await pool.clearAccountPolicyBlocked(entry.id)
            : false;
        if (cleared > 0 || policyCleared) {
            clearedCount += cleared;
            accountCount++;
        }
    }
    return { clearedCount, accountCount };
}
/**
 * ## 本 fork 的裁剪说明
 *
 * 限流 / 额度耗尽判据原在 `llm-adapter.js`（codearts 主适配器，已随裁剪删除）；
 * 本 fork 唯一消费者是本文件的探测路径，故整块**搬移**至此 —— 判据逐字未动，
 * 「同一语义两套判据」红线照旧。
 */
/**
 * CodeBuddy 系（buddy / workbuddy）表示「用量超出频率限制」的业务码。
 *
 * 判据优先用结构化业务码而非文案：**它与语言无关**，且不受服务端改文案影响。
 * 国际版与国内版用的是同一个码（实测均为 6004），只有 msg 文案分中英文。
 */
const RATE_LIMIT_BUSINESS_CODE = 6004;
/**
 * 限流文案的**自然语言兜底**判据。
 *
 * 为什么需要兜底：并非所有限流错误都带得上结构化 code —— SSE 流内错误、
 * 网关返回的裸文本、以及 CodeArts（华为云）的中文错误都只有文案可判。
 *
 * ⚠️ **中英文都必须列全**。历史缺陷（用户报障，仅国际版暴露）：此处早期只有
 * 中文词（频率限制 / 使用量已超出 / 频率超出 / 重置），而国际版 WorkBuddy
 * （www.workbuddy.ai）返回的是英文
 * `usage exceeds frequency limit ... your usage will reset at <时间> UTC+8`。
 * 结果 `isRateLimited` 恒为 false → 适配器**跳过整个账号切换分支**，直接抛出
 * 原始 6004 JSON；错误码也因 HTTP 400 退化成 INVALID_REQUEST 而非
 * QUOTA_EXCEEDED。国内版返回中文文案，所以该缺陷只在国际版复现。
 *
 * `too many requests` 是标准 OpenAI 429 措辞，一并纳入。
 */
const RATE_LIMIT_PATTERN = /频率限制|频率超出|使用量已超出|重置|rate.?limit|frequency limit|usage exceeds|too many requests/i;
/**
 * 腾讯网关「**模型饱和**」业务码（HTTP 429）。
 *
 * ## 它必须与额度限流（6004）分开（真实报障，2026-10-05）
 *
 * 用户第一次用 `buddy/space-bunny` 就报「模型 space-bunny 所有账号均受限」。
 * 直连实测（`scripts/probe-buddy-error-catalog.mjs`）逼出了服务端原话：
 * ```json
 * {"code":14003,"msg":"too many requests",
 *  "displayMsg":{"zh":"模型繁忙，请换模型或稍后重试"},
 *  "displayTips":{"zh":"这个模型当前请求量饱和，与你的网络无关。请换个模型，或稍等一会儿再重试。"},
 *  "actions":["SWITCH_MODEL","SUBMIT_FEEDBACK","RETRY"]}
 * ```
 *
 * ⚠️ **它自己就说明了「这不是账号问题」**（注意 `actions` 里根本没有换号的选项，
 * 只有 `SWITCH_MODEL`）。但 `isRateLimited` 对 **429 无条件返回 true** ⇒
 * 适配器把每个账号都写上「1 小时限流」标记（报文无「将在…重置」，
 * 故取 `RATE_LIMIT_FALLBACK_MS` 兜底）⇒ 4 个独立账号在 20 秒内**全部**被锁
 * ⇒ 用户等到 1 小时也不能用，且**期间连别的模型都受影响**（同一个账号池）。
 *
 * 实测证据（同型缺陷的判据来源）：
 * | 观测 | 结果 |
 * |---|---|
 * | 4 个不同腾讯 uid 的账号 | 20 秒内**全部**被标记 `space-bunny` |
 * | 标记解禁时刻 | 全部等于「写入 + 整 1 小时」= 兜底值，**非**服务端给的时刻 |
 * | 4 MB 输入 | 稳定逼出 `429 / 14003`（46~111 秒才返回） |
 * | 小请求 30 发 | 全 200，但耗时 841ms ~ 216s —— 上游是**时变**背压 |
 *
 * ⇒ 「4 个互不相干的账号同时中招」在账号级限流下无法解释，**只能**是模型级。
 * 与 zcode `3009 model concurrency limit exceeded` 同型（那边结论同样是
 * 「退避重试，**不换号、不标记**」）。
 *
 * ⚠️ **不许把 14003 并进 `RATE_LIMIT_BUSINESS_CODE`**：两者的正确动作相反 ——
 * 6004 是「这个账号在这模型上的额度用完了」（换号有效、必须标记）；
 * 14003 是「这个模型此刻整体饱和」（换号**无益**、**不许**标记）。
 */
export const MODEL_SATURATION_BUSINESS_CODE = 14003;
/**
 * 「模型饱和」的**自然语言兜底**判据。
 *
 * 与额度限流同理：码值由服务端下发，本地产物里没有硬编码
 * （实测搜 `14003` 在本仓库源码中零命中才敢新增），上游可能改用别的码值表达
 * 同一语义，故需要文案兜底。
 *
 * ⚠️ **关键词必须窄**：`busy` / `saturated` 这种泛词若不加限定，
 * 模型正文里恰好讨论「服务器繁忙」就会被误判。这里只认腾讯原话里的组合，
 * 且判据本身**要求 HTTP 状态码 ≥ 400**（见 {@link isModelSaturationError}）。
 */
const MODEL_SATURATION_PATTERN = /模型繁忙|请求量饱和|model\s+busy|currently\s+saturated/i;
/**
 * 判断一次失败是否为**模型饱和**（上游背压），而非账号级额度限流。
 *
 * ## 为什么这个区分是**行为分叉**而不是措辞问题
 *
 * | | 额度限流 `6004` | 模型饱和 `14003` |
 * |---|---|---|
 * | 语义 | 该**账号**在该模型上额度用完 | 该**模型**此刻整体饱和 |
 * | 换号 | **有效**（别的账号有独立额度） | **无益**（所有账号撞同一堵墙） |
 * | 写限流标记 | **必须**（否则每轮重撞） | **绝对不许**（会把整池锁 1 小时） |
 * | 建议 | 等解禁 / 换账号 | **换模型** / 稍后重试 |
 *
 * 实测 `actions` 字段本身就写着 `SWITCH_MODEL` 而**没有**换号选项 ——
 * 服务端与我们的结论一致。
 *
 * ⚠️ **必须先于 `status === 429` 的无条件判定**：14003 恰恰是 429，
 * 若先判状态码就永远走不到这里（这正是缺陷的成因，见常量注释）。
 *
 * @param status - HTTP 状态码。为 `undefined`（只有文案可判）时仍检查业务码；
 *   但**文案分支要求状态码 ≥ 400** —— 否则一段正常正文里出现「模型繁忙」
 *   就会被判成错误。
 * @param body - 响应体（可能为空串）。
 */
export function isModelSaturationError(status, body) {
    // 状态码已知且 < 400 ⇒ 这是正常响应，正文里的字样不算错误。
    if (typeof status === 'number' && status < 400)
        return false;
    if (body.length === 0)
        return false;
    try {
        const code = JSON.parse(body).code;
        if (code === MODEL_SATURATION_BUSINESS_CODE
            || code === String(MODEL_SATURATION_BUSINESS_CODE))
            return true;
        // ⚠️⚠️ **结构化降级：报文自带「额度限流」业务码时，一律不判模型饱和**
        // （2026-10-17 对抗审计实测的真缺陷）。
        //
        // 本函数的**码值腿是权威的**，文案腿只是「上游可能改用别的码值」的兜底；
        // 因此当报文**明确给出了另一个已知业务码**时，那才是权威信号。
        //
        // 实测（buddy 额度限流）：`{"code":6004,"msg":"请求量饱和，请稍后再试"}`
        // → `MODEL_SATURATION_PATTERN` 的「请求量饱和」命中 ⇒ 判成**模型级**饱和。
        // 后果不是措辞问题，而是**行为分叉**（见上表）：
        // | | 额度限流 6004 | 误判成模型饱和 |
        // |---|---|---|
        // | 换号 | 有效 | 退化成「原账号退避重试」 |
        // | 写限流标记 | 必须 | **绝对不许** |
        // ⇒ 一个**额度已耗尽**的账号会被判成「换账号无效、换模型吧」，
        // 而池里其它账号的额度是独立的、可用。
        //
        // ⚠️ 为什么要**降级而不是直接 return false**：6004 之外的码还可能是别的语义
        // （上游新码 / 未知码），此时文案兜底仍有价值。故只在**已知对立法**（额度限流）
        // 成立时降级，未知码仍走文案腿。
        if (code === RATE_LIMIT_BUSINESS_CODE || code === String(RATE_LIMIT_BUSINESS_CODE)) {
            return false;
        }
    }
    catch {
        // 非 JSON：交给文案兜底。
    }
    return MODEL_SATURATION_PATTERN.test(body);
}
/**
 * 结构化判定：响应体是可解析 JSON 且 `code` 为该业务码。
 *
 * 不采用「全文包含 6004」的写法：`requestId` 是 UUID，任意数字子串都可能
 * 偶然出现，文本匹配会产生假阳性；这里只认 JSON 顶层的 `code` 字段。
 * 兼容 `"6004"`（字符串）与 `6004`（数字）两种编码。
 */
function hasRateLimitBusinessCode(body) {
    try {
        const data = JSON.parse(body);
        const code = data.code;
        return code === RATE_LIMIT_BUSINESS_CODE || code === String(RATE_LIMIT_BUSINESS_CODE);
    }
    catch {
        // 非 JSON：交给文案兜底
        return false;
    }
}
/**
 * 判断错误文本是否为频率限制错误。
 *
 * @param body - 响应体（可能为空串）
 * @param status - HTTP 状态码（可选，但**手里有 Response 就必须传**）。为 `429`
 *   时无条件判为限流，即使响应体为空、不含任何可识别文案。
 *
 * ⚠️ **`status` 判据是真实缺陷的修复，不是可选便利**：本函数原先只接收响应体，
 * 而服务端（网关 / CDN / 限流中间件）完全可能返回**空体**的 429 —— 此时
 * `hasRateLimitBusinessCode` 与 `RATE_LIMIT_PATTERN` **双双不命中**，函数返回
 * `false`，于是适配器里整段「记录重置时间 + 切换账号」逻辑被**整体跳过**，
 * 把一个本可自愈的限流直接抛给用户（表现为「账号池里明明还有可用账号，插件却
 * 报错且不换号」）。
 *
 * 判据顺序刻意是「状态码优先」：429 是 HTTP 语义上**唯一**的限流信号，无需也不应
 * 再去猜文案；下面的文案 / 业务码兜底只服务于「状态码不是 429、但正文表达了限流」
 * 的场景（业务码 6004、SSE 流内错误、网关包装过的 200/400）。
 *
 * ⚠️ 反向的约束同样重要：**非 429 绝不能因为「有状态码」就判为限流** ——
 * 404「模型不存在」这类换号无益的错误若被识别成限流，会被吞成「所有账号均受限」，
 * 用户既看不到真实原因、插件还会白试一遍全池账号。
 */
export function isRateLimited(body, status) {
    if (status === 429)
        return true;
    return hasRateLimitBusinessCode(body) || RATE_LIMIT_PATTERN.test(body);
}
/**
 * 重置时间的两种句式（中文 / 英文），并**捕获实际时区**而非硬编码 UTC+8。
 *
 * 中文（buddy 国内版）："您的使用量已超出频率限制，将在 2026-09-11 18:08:17 UTC+8 重置"
 * 英文（workbuddy 国际版）："... your usage will reset at 2026-09-17 09:09:36 UTC+8, alternatively, ..."
 *
 * 早期只列了中文句式，导致国际版即使判定为限流也只能走「1 小时后重试」的
 * 兜底，丢掉服务端给出的真实重置时刻（UI 限流徽章因此显示错误时间）。
 */
const RESET_TIME_PATTERN = /(?:将在|reset at)\s+([\d-]+\s+[\d:]+)\s+(UTC[+-]\d+(?::\d+)?)/i;
/**
 * 限流文案里解析不出重置时刻时的**兜底时长**（1 小时）。
 *
 * 为什么需要兜底而不是「解析不到就不记标记」：网关 / CDN 返回的 429 常常既没有
 * 重置时间、甚至**没有响应体**，而标记是 UI「限额重置」徽章与「重测 / 重置」
 * 两条人工解禁路径的**唯一**依据 —— 静默跳过记录会让用户既看不到限流、也无从操作。
 *
 * ⚠️ 1 小时是**快照式**兜底（标记可被重测刷新），与 `BUDDY_POLICY_BLOCK_COOLDOWN_MS`
 * 的 30 分钟**语义不同**（那是「安全策略拦截」的本地冷却，报文里根本没有时间字段），
 * 也与 Qoder「按自然日 24:00」不同（那是按日的额度结算）。三者不要合并成一个常量。
 *
 * 导出是给 `buddy-adapter` 用的：它需要在**没拿到可解析体**时也能写出标记，
 * 且必须与这里 `parseRateLimitError` 的兜底**同值**，否则两处口径会漂。
 */
export const RATE_LIMIT_FALLBACK_MS = 3_600_000;
/**
 * 额度耗尽的业务码（CodeBuddy 系实测值）。
 *
 * ⚠️ 与 {@link RATE_LIMIT_BUSINESS_CODE}（6004 = 频率限流）**不可合并**：
 * 两者动作相同但**冷却终点相反**（见 {@link isCreditExhausted} 的表）。
 */
export const CREDIT_EXHAUSTED_BUSINESS_CODE = 14018;
/**
 * 额度耗尽的文案兜底判据（`14018` 的码值腿之外的唯一通道）。
 *
 * 上游原话（`www.workbuddy.ai`，HTTP 429）：
 * `Credits exhausted. Please visit the link below to purchase add-on packs…`
 *
 * ⚠️ **关键词必须窄**：`insufficient` 单独出现**过宽**（见
 * {@link isCreditExhausted} 的说明）。
 */
const CREDIT_EXHAUSTED_PATTERN = /credits?\s+exhausted|quota\s+exhausted|积分.{0,4}(?:不足|耗尽|用尽)|额度.{0,4}(?:不足|耗尽|用尽)|余额.{0,4}(?:不足|耗尽|用尽)/i;
/**
 * 额度**耗尽**（不是频率限流）的判据 —— 「钱用光了」，不是「发太快」。
 *
 * ## ⚠️⚠️ 为什么必须与 {@link isRateLimited} 分开（真实缺陷，Gitee IKQ6HJ）
 *
 * 两者的**动作完全相同**（换号 + 写冷却标记），但**冷却终点的语义相反**：
 *
 * | | 频率限流（6004 / 429） | 额度耗尽（14018 / Credits exhausted） |
 * |---|---|---|
 * | 恢复方式 | 时间到了就恢复（分钟级滚动窗口） | **等次日配额 / 充值** |
 * | 冷却终点 | 服务端声明时刻，否则 +1h 兜底 | **UTC+8 当日 24:00** |
 * | 写成 +1h 的后果 | 无（本来就该 1 小时） | **每小时被重新选中一次、必然再失败** |
 *
 * 用户侧症状（原始报障）：「面板说可以用了，一试又不行」——面板的『限额重置』
 * 显示的是失败时刻 + 1 小时，到点后账号被重新选中，必然再失败一次，再写一条
 * 1 小时标记，**循环往复**。而真实出路是等次日配额或充值。
 *
 * ## 为什么是「UTC+8 当日 24:00」而不是「+24h」
 *
 * 与 `loomyCooldownResetAtMs`（Gitee IKL80H 那起事故）**同一条纪律**：
 * 额度按 UTC+8 自然日结算，用滑动 24h 会让 23:50 烧光的账号被封到**次日 23:50**
 * ——用户 0 点后上游明明已放行、插件仍说「没到重置时间」，白等近一整天。
 * 四家同口径的既有实现：`loomyCooldownResetAtMs` / `qoder-adapter` /
 * `zcode-adapter` / `llm-adapter` 的 codearts 分支。
 *
 * ## 判据刻意**窄**
 *
 * 只认 `14018` 码值与 `credits exhausted` 完整短语。**不收** `insufficient` 这类
 * 泛词 —— 上下文超长报文里的 `the context window is insufficient for this model`
 * 会被误伤，而那是「换号无益」的另一类失败（同类误伤在
 * `classifyLoomyFailure` / `classifyRaccoonFailure` 各踩过一次）；
 * 中文侧同样只收「额度/积分/余额 + 不足/耗尽」的**确定性组合**。
 *
 * ⚠️ **本函数只看响应体，不看状态码**：14018 实测回 **HTTP 429**，但它与
 * 频率限流共用 429 ⇒ 状态码对这一格**没有判别力**，只能靠码值/文案。
 *
 * @param body - 响应体（可能为空串）。
 */
export function isCreditExhausted(body) {
    if (body.length === 0)
        return false;
    // ① 结构化业务码：只认 JSON 的 `code` 字段（与 `hasRateLimitBusinessCode` 同一
    //    取舍 —— 全文搜 `14018` 会被 UUID 里的数字子串误命中）。
    //
    //    ⚠️ **必须同时认嵌套形态**：buddy 系的真实报文是
    //    `{"error":{"data":{"code":14018,"msg":"…"}}}`（码在**第二层**），
    //    只看顶层 `code` 会让码值腿在这家**恒不命中**、只剩英文文案腿 ——
    //    而上游一改文案就静默失效（同族教训：`channelVerificationUpstreamId`
    //    的注释记录了「判据认了某字段、出口却提不出该字段」的漂移）。
    try {
        const data = JSON.parse(body);
        const inner = typeof data.error === 'object' && data.error !== null
            ? data.error
            : undefined;
        const nested = typeof inner?.data === 'object' && inner.data !== null
            ? inner.data
            : undefined;
        const codes = [data.code, inner?.code, nested?.code];
        if (codes.some(code => code === CREDIT_EXHAUSTED_BUSINESS_CODE
            || code === String(CREDIT_EXHAUSTED_BUSINESS_CODE))) {
            return true;
        }
    }
    catch {
        // 非 JSON：交给文案腿。
    }
    // ② 文案腿（网关包装过的 200/400、纯文本错误页、以及 `errorDetail` 产物）。
    return CREDIT_EXHAUSTED_PATTERN.test(body);
}
/**
 * 额度耗尽的冷却终点：**UTC+8 当日 24:00**。
 *
 * 与 {@link isCreditExhausted} 配套，供 `buddy-adapter` 的换号记账分支与
 * `account-probe` 的重测回写共用 —— **只留一份实现**，两处各算一次必然漂移
 * （本仓库首条红线「同一语义两套判据」）。
 *
 * ⚠️ **必须放在本文件（共享层）而不是某个渠道的适配器里**：`account-probe.ts`
 * 也要用它（重测时把同一时刻回传给存储），而探测层不得反向依赖某个渠道的
 * 适配器 —— `tests/unit/account-probe-adapter.spec.ts` 普遍
 * `vi.mock('../../src/buddy-adapter.js')`，形成依赖后那个 mock 会把该函数
 * 一起变成 `undefined`（Gitee IKQ6HJ 报告里记录的同一处陷阱）。
 *
 * @param nowMs - 当前时刻（注入以便单测）。
 */
export function creditExhaustedResetAtMs(nowMs = Date.now()) {
    return nextUtc8DayStartMs(nowMs);
}
/**
 * 只取**服务端显式声明**的重置时刻；解析不到就返回 `undefined`（**不兜底**）。
 *
 * ## 为什么必须与 {@link parseRateLimitError} 并存
 *
 * `parseRateLimitError` 的语义是「调用方需要一个可写的标记」，故它**必然**
 * 给出一个时刻（解析不到就 `+1h`）。而额度耗尽那一格需要区分
 * 「服务端真给了时刻」与「它压根没给」：
 *
 * - 服务端给了 ⇒ **以它为准**（上游比我们更清楚何时恢复）；
 * - 服务端没给 ⇒ 走 {@link creditExhaustedResetAtMs} 的 UTC+8 自然日，
 *   **不是** `+1h`。
 *
 * 两者混用会让 14018 继续落进 1 小时兜底（正是 Gitee IKQ6HJ 的缺陷形态）。
 *
 * @param body - 响应体（可能为空串）。
 * @returns 服务端声明的重置时刻（epoch ms），无则 `undefined`。
 */
export function explicitRateResetAtMs(body) {
    try {
        const data = JSON.parse(body);
        // ⚠️ 只读 `msg`（与 `parseRateLimitError` **同源**：两句真实文案都写在该字段里）。
        // 若哪天上游把时刻挪到别的字段，两处必须**同批**改，不能只改一处。
        //
        // ⚠️ 嵌套形态也要认（`{"error":{"data":{"msg":"… reset at …"}}}`）：
        // 只读顶层会让本函数在 buddy 系的真实报文形态上恒为 `undefined` —— 那不会
        // 报错，只会静默退回自然日终点（「服务端给了时刻却不采用」）。
        const inner = typeof data.error === 'object' && data.error !== null
            ? data.error
            : undefined;
        const nested = typeof inner?.data === 'object' && inner.data !== null
            ? inner.data
            : undefined;
        const candidates = [data.msg, inner?.msg, nested?.msg];
        for (const candidate of candidates) {
            if (typeof candidate !== 'string')
                continue;
            const resetMatch = RESET_TIME_PATTERN.exec(candidate);
            if (!resetMatch)
                continue;
            const resetMs = Date.parse(`${resetMatch[1]} ${resetMatch[2]}`);
            if (!Number.isNaN(resetMs))
                return resetMs;
        }
        return undefined;
    }
    catch {
        // ⚠️⚠️ **非 JSON（纯文本）也必须扫一遍** —— 这不是兜底洁癖，是**真实主路径**
        // （对抗审计实测打穿的缺陷）：
        //
        // `account-probe.ts` 拿到的 `message` 是**适配器抛出的 `LlmError.message`**，
        // 而适配器早已把上游报文压平成纯文本：
        // `workbuddy: Credits exhausted. Your quota will reset at 2099-12-31 23:59:59 UTC+8`
        // ⇒ `JSON.parse` 必然失败 ⇒ 本函数恒 `undefined` ⇒ 探测腿永远退回自然日，
        // 而推理腿（拿**原始报文**）能取到显式时刻 ⇒ 两条腿对同一条报文算出两个值。
        //
        // 实测三格（同一份 `14018 + reset at 2099` 报文）：
        // | 输入形态 | 修前 | 修后 |
        // |---|---|---|
        // | 原始 JSON（推理腿） | 2099 | 2099 |
        // | 压平后的 message（探测腿） | **undefined** ⇒ 自然日 | **2099** |
        //
        // ⚠️⚠️ **「正常正文凑不出这个形状」这句断言已被实测证伪，别再引用它**
        // （对抗审计 2026-10-25 实测）：`'…配额将在 2099-12-31 23:59:59 UTC+8 重置…'`
        // 与 `'…will reset at 2099-12-31 23:59:59 UTC+8…'` **都能凑出**且 `Date.parse`
        // 正常解析 ⇒ 纯文本回退本身有误命中面。
        //
        // 当前**不可达**：两个调用点（推理腿 `buddy-adapter.ts` / 探测腿
        // `account-probe.ts`）都在 `isCreditExhausted(body)` 门禁**之内**，
        // 而上面那句纯限流正文实测 `isCreditExhausted = false` ⇒ 到不了扫描。
        //
        // ⚠️ 但这是**结构性**风险：门禁（本函数上方）与扫描（这里）分处两个函数，
        // 将来任何人放宽/重排门禁、或给第三条腿接 `explicitRateResetAtMs`，误命中会
        // **静默**打开。**新接调用点前先读这段**，并确认新路径同样有额度门禁。
        const bareMatch = RESET_TIME_PATTERN.exec(body);
        if (bareMatch !== null) {
            const bareMs = Date.parse(`${bareMatch[1]} ${bareMatch[2]}`);
            if (!Number.isNaN(bareMs))
                return bareMs;
        }
        return undefined;
    }
}
/**
 * 从限流错误中提取重置时间；体里没有时间时返回 {@link RATE_LIMIT_FALLBACK_MS} 兜底。
 *
 * @param status - HTTP 状态码（可选）。为 `429` 时即使**体为空、或无任何可识别文案**
 *   也按兜底时长返回一条，避免调用方「识别出限流却没有标记可写」（见
 *   {@link RATE_LIMIT_FALLBACK_MS} 的说明）。
 */
export function parseRateLimitError(body, currentModel, status) {
    const fallback = () => ({
        modelId: currentModel,
        resetTimeMs: Date.now() + RATE_LIMIT_FALLBACK_MS,
    });
    try {
        const data = JSON.parse(body);
        const msg = typeof data.msg === 'string' ? data.msg : '';
        const resetMatch = RESET_TIME_PATTERN.exec(msg);
        if (resetMatch) {
            // 用捕获到的真实时区拼接（不再写死 UTC+8），Date.parse 能正确解析该写法。
            const resetMs = Date.parse(`${resetMatch[1]} ${resetMatch[2]}`);
            if (!Number.isNaN(resetMs)) {
                return { modelId: currentModel, resetTimeMs: resetMs };
            }
        }
        // 标准 OpenAI 429 格式，或带业务码但文案无法解析出时间
        if (isRateLimited(body, status)) {
            return fallback();
        }
        return null;
    }
    catch {
        // 非 JSON（空体、纯文本、CDN 的 HTML 错误页）：只剩状态码可判。
        return status === 429 ? fallback() : null;
    }
}
//# sourceMappingURL=account-probe.js.map