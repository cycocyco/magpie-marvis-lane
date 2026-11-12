/**
 * 「在 magpie 里新建账号」这条路的回归测试（本 fork 裁剪版：只剩 marvis）。
 *
 * 必须守住的点：
 *
 * 1. `startNewAccount()` 固定带 `mode: 'browser'`：marvis 的 `account.create`
 *    必须带 mode（`MarvisAuth` 只有 `loginViaBrowser`，不带 mode 会落到通用分支
 *    而失败）。
 * 2. `authorize()` 只等 `account.create`，**绝不能等用户**：magpie 侧
 *    `pluginBegin()` 用 `context.WithTimeout(..., time.Minute)` 包住整个
 *    `plugin.Authorize`，等用户必然撞 1 分钟硬超时。
 * 3. `waitForLogin()` 三种终态都要认（还在等 / 成功 / 失败），且单次轮询
 *    抛错**不算终态**（容器刚起来时 `rpc` 会短暂失败）。
 * 4. `abandonAccount()` 删之前必须再摸一次 `login.poll`：用户可能恰在超时那刻
 *    登录成功，`account.delete` 会连带 `credentials.unset`，**不可逆**。
 * 5. 单次 `login.poll` 必须有上限（`LOGIN_POLL_TIMEOUT_MS`）：`container.rpc()`
 *    自己没有超时，`login.poll` 内部又会走 `credentials.resolve()` ——
 *    一次挂住就会让 9 分钟的等待永不返回。
 * 6. `account.create` 同样要有上限（`CREATE_TIMEOUT_MS`）：本体是「先登记占位、
 *    再 await 起登录流程」，那一步卡住就是「占位已进池、rpc 不返回」。
 * 7. 空 `loginUrl` 是**正常形态**：marvis 走 `browser` 腿时本体自己开隔离浏览器，
 *    返回恒为 `{ accountId, loginUrl: '', reused: false, incognitoOpened: true }`，
 *    进度由 `login.poll` 报终态。
 * 8. `abandonAccount()` 返回三态（`kept` / `unknown` / `deleted`）：`kept` 表示
 *    「收尾时发现其实已经登录成功了」，调用方必须改走成功路径。
 * 9. `kept` 的判据必须是 `done === true && success !== false`：本体 `login.poll`
 *    里 `loginFailureOf()` 优先于一切进度判据，用户关掉授权页 / 点拒绝都会回
 *    `{ done: true, success: false }` —— 只判 `done` 会把**每一次主动放弃**
 *    都当成「其实登录成功了」。
 * 10. `authorize()` 的超时预算要连 `container.start()` 一起算：12s + 45s = 57s，
 *     撞不穿 magpie 的 1 分钟。
 *
 * 裁剪说明：原版的「三家不声明 oauth」/ `startNewAccountSmart`（超级麦吉的
 * mode 分派）/ `NO_NEW_ACCOUNT` / `MAGICREW_CREATE_MODES` 等段落随 28 家供应商
 * 一并删除，源码里这些声明已不存在。
 *
 * 跑法：`node tests/t-new-account.mjs`（不联网、不碰真实 ~/.dsh）
 *
 * 判据直接取自 `src/plugin.mjs` 源码文本（`new Function` 求值），不是复制粘贴
 * —— 源码改了这里就跟着改，不会出现「测试绿但代码早变了」。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 测试绝不写真实 magpie 配置（2026-11-01 事故：单跑这个文件曾把用户 60 行账号写塌）
process.env.JET_HUB_NO_AUTH_SYNC = '1'

// 本文件会真的把容器拉起来（第 7 节 import index.mjs 建工厂），而
// `src/container.mjs` 起控制台后，只要端口恰好落在 18500 且没设这个变量，就会写
// `~/.config/magpie/jet-hub-console.json`。单跑本文件时 test-all 的那层保护不在，
// 所以自己设一遍。
process.env.JET_HUB_NO_ADDR_FILE = '1'

// 第 7 节会 `import('index.mjs')` 并调工厂 —— 工厂里 `containerFor()`
// 拿不到 `options.home` 时**回退 `homedir()`**（`src/plugin.mjs` 的 `resolveHome`），
// 然后 `warmUp()` 在后台真把容器起起来，`_start()` 会写
// `~/.dsh/cache/models-dev.json` 之类。实测落盘时刻在第 2548ms，而本文件 985ms
// 就跑完了 —— **纯靠侥幸没写到真实 home**（机器慢一点、或干净环境就会污染）。
// 所以第 7 节显式传 `{ home: <临时目录> }`，同时把 `DSH_HOME` 也指过去兜底。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-newacct-home-'))
process.env.DSH_HOME = path.join(TMP_HOME, '.dsh')

/** 收尾清理：临时目录不留在 %TEMP% 里。 */
function cleanupTmp() {
  try {
    fs.rmSync(TMP_HOME, { recursive: true, force: true })
  } catch { /* 容器后台可能还握着句柄，删不掉就算了 */ }
}

// 挂到 exit 上而不是只在文件末尾调一次：中途的替换守卫（`console.error` +
// `process.exit(1)`）和未捕获异常都会跳过末尾那行，留下一个空目录。
process.on('exit', cleanupTmp)

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC = path.join(ROOT, 'src', 'plugin.mjs')

let bad = 0
// 断言条数由测试自己数，不写死在末尾的文案里 —— 写死会随每次加断言漂
// （2026-10-30 三审实测：t-new-account 写 161 实际 170、t-login-reclaim 写 26 实际 28）。
let total = 0
const ok = (cond, msg) => {
  total++
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) bad++
}

/**
 * 测试侧看门狗。
 *
 * 被测代码要是**没有**自己的超时上限，await 就会挂死，node 直接以 exit 13 退出
 * （`Detected unsettled top-level await`）—— 那是「红」，但红得看不出来是哪条断言。
 * 包一层，把「挂住」变成一条可读的失败。
 */
/**
 * 跑一个「本该成功」的调用。
 * @returns `{ got, err }` —— 抛错时 `err` 是消息、`got` 是 undefined。
 */
const attempt = async (p, ms, what) => {
  try {
    return { got: await watchdog(p, ms, what), err: '' }
  } catch (e) {
    return { got: undefined, err: String(e?.message ?? e) }
  }
}

const watchdog = (p, ms, what) =>
  Promise.race([
    p,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${what} 挂住了（测试看门狗 ${ms}ms）`)), ms),
    ),
  ])

// 仓库里是 CRLF，截取前统一成 LF，否则 indexOf 全都不中
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n')

/* ── 1. 从源码里截出新建账号那一整段原样求值 ── */

// 截段范围：`LOGIN_POLL_MS` 常量起，到 `credentialAliveOf` 的函数头注释为止
// —— 这一段正好覆盖全部超时常量 + withDeadline / withRpcDeadline /
// startNewAccount / pollLoginOnce / waitForLogin / abandonAccount。
const FROM = 'const LOGIN_POLL_MS = 2_000'
const TO = '\n/**\n * 这个账号的凭据还在不在'
const i = src.indexOf(FROM)
const j = src.indexOf(TO)
if (i < 0 || j < 0 || j <= i) {
  console.error('✗ 截不出源码段：', { i, j })
  process.exit(1)
}
let body = src.slice(i, j)

// 9 分钟太久了，测试里换成 150ms（只改超时这一个数，逻辑不动）
body = body.replace('const NEW_ACCOUNT_WAIT_MS = 9 * 60 * 1000', 'const NEW_ACCOUNT_WAIT_MS = 150')
// 2 秒轮询同样换短
body = body.replace('const LOGIN_POLL_MS = 2_000', 'const LOGIN_POLL_MS = 20')
// 15 秒的单次轮询上限同样换短（不换的话「挂住的 poll」那条用例要跑 15 秒）
body = body.replace('const LOGIN_POLL_TIMEOUT_MS = 15_000', 'const LOGIN_POLL_TIMEOUT_MS = 60')
// 45 秒的建流程上限同样换短
body = body.replace('const CREATE_TIMEOUT_MS = 45_000', 'const CREATE_TIMEOUT_MS = 120')

// ⚠️ 上面四处是**精确字符串**替换：源码里改一个空格（`9*60*1000`）就会静默不生效，
// 测试于是拿着 9 分钟的真值跑，表现为「挂死」而不是「报红」。所以每条都补一条
// 守卫断言，让失效变成红。
//
// 走 `ok()` 而不是只 `console.error`：四审实测 `CREATE_TIMEOUT_MS` 改名时红的是
// stderr 那行、0 条断言计数，看不出是哪一条（2026-10-29 四审指出）。仍然要
// `process.exit(1)`，因为替换没生效时后面的用例会拿真实超时跑（9 分钟）。
let replaced = true
for (const [want, why] of [
  ['const NEW_ACCOUNT_WAIT_MS = 150', '等待上限'],
  ['const LOGIN_POLL_MS = 20', '轮询间隔'],
  ['const LOGIN_POLL_TIMEOUT_MS = 60', '单次轮询上限'],
  ['const CREATE_TIMEOUT_MS = 120', '建流程上限'],
]) {
  if (!body.includes(want)) {
    ok(false, `测试用的${why}替换生效了（源码里那一行变了？找：${want}）`)
    replaced = false
  }
}
if (!replaced) {
  console.error('✗ 常量替换没生效，后面的用例会拿真实超时跑（9 分钟），直接退出')
  process.exit(1)
}

const accountsCache = new Map()
const make = (container, log = () => {}) =>
  new Function(
    'container',
    'log',
    'accountsCache',
    // ⚠️ 常量用 `typeof` 兜一层：源码里把它们改名/删掉时，裸引用会让这个
    // `new Function` 在**调用时**抛 `ReferenceError`，表现为 exit=1 却 0 条 ✗ ——
    // 看不出是哪条断言红了（2026-10-29 三审指出）。兜成 NaN 之后，第 6.2 节
    // 的 `ok(gotStart, '源码里能读到 START_TIMEOUT_MS（读不到，常量改名了？）')`
    // 就会正常报一条可读的失败。
    `${body}\nreturn {`
      + ' CREATE_TIMEOUT_MS: typeof CREATE_TIMEOUT_MS === "undefined" ? NaN : CREATE_TIMEOUT_MS,'
      + ' START_TIMEOUT_MS: typeof START_TIMEOUT_MS === "undefined" ? NaN : START_TIMEOUT_MS,'
      + ' withDeadline, withRpcDeadline, startNewAccount,'
      + ' pollLoginOnce, waitForLogin, abandonAccount }',
  )(container, log, accountsCache)

/** 假容器：按队列依次吐出 `login.poll` 的返回值，并记录删了谁、create 收到的 payload */
function fakeContainer({ create, polls = [] }) {
  const deleted = []
  const createPayloads = []
  let n = 0
  return {
    deleted,
    createPayloads,
    async rpc(method, payload) {
      if (method === 'account.create') {
        createPayloads.push(payload)
        // 'hang' 模拟「account.create 永远不返回」：本体是「先登记占位、
        // 再 await 起登录流程」，那一步卡住就是占位已进池、rpc 不返回。
        if (create === 'hang') return new Promise(() => {})
        if (create instanceof Error) throw create
        return create
      }
      if (method === 'login.poll') {
        const step = polls[Math.min(n, polls.length - 1)]
        n++
        // 'hang' 模拟「这次 rpc 永远不返回」：本体 login.poll 内部会走
        // credentials.resolve()，真能挂住
        if (step === 'hang') return new Promise(() => {})
        if (step instanceof Error) throw step
        return step
      }
      if (method === 'account.delete') {
        deleted.push(payload.accountId)
        return undefined
      }
      throw new Error(`没预期的 rpc: ${method}`)
    },
  }
}

/* ── 2. 裁剪负断言：这些声明已不存在 ── */

console.log('裁剪负断言（28 家专属的声明已随裁剪删除）：')
{
  for (const gone of ['NO_NEW_ACCOUNT', 'KEY_ACCOUNT_RPC', 'MAGICREW_CREATE_MODES', 'SPECIAL_CLAIM_PROVIDERS', 'startNewAccountSmart']) {
    ok(!src.includes(gone), `src/plugin.mjs 里已没有 ${gone}`)
  }
}

/* ── 3. startNewAccount ── */

console.log('\nstartNewAccount（固定 mode:browser + 占位账号 id + loginUrl 恒空）：')
{
  accountsCache.set('marvis', [1, 2, 3])
  const c = fakeContainer({ create: { accountId: 'marvis-abc123', loginUrl: '' } })
  const { startNewAccount } = make(c)
  const { got, err } = await attempt(startNewAccount(c, 'marvis', () => {}), 2_000, 'startNewAccount')
  ok(err === '', `正常返回不抛错（实际错误：${err || '（没有）'}）`)
  ok(got?.accountId === 'marvis-abc123', 'accountId 原样传出')
  ok(got?.loginUrl === '', 'loginUrl 恒为空串（本体自己开隔离浏览器，没有授权页可给 magpie）')
  ok(got?.reused === false, 'reused 恒为 false（browser 腿是「等用户登录」，不是 reused）')
  ok(got?.incognitoOpened === true, 'incognitoOpened 恒为 true（本体自己在后台开窗）')
  ok(accountsCache.get('marvis') === undefined, '拿完就清掉该家账号缓存（新占位要能被看见）')
  ok(c.createPayloads.length === 1 && c.createPayloads[0]?.mode === 'browser',
    `account.create 的 payload 固定带 mode:'browser'（实际 ${JSON.stringify(c.createPayloads[0])}）`)
}
{
  // 本体给的 payload 原样转发（除 mode 以外的字段由本体决定，插件不增不减）
  const c = fakeContainer({ create: { accountId: 'marvis-zzz', loginUrl: '' } })
  const { startNewAccount } = make(c)
  const { got, err } = await attempt(startNewAccount(c, 'marvis', () => {}), 2_000, 'startNewAccount')
  ok(err === '', `第二次正常返回也不抛错（实际错误：${err || '（没有）'}）`)
  ok(got?.accountId === 'marvis-zzz', '第二个 accountId 原样传出')
}
{
  // （原「缺 loginUrl → 抛错」用例已删：新契约下空 loginUrl 是 browser 腿的正常
  //   形态，不再抛错；「缺 accountId → 抛错」由第 5.2 节覆盖。）
  const c = fakeContainer({ create: new Error('unknown provider: nope') })
  const { startNewAccount } = make(c)
  let err = ''
  try {
    await startNewAccount(c, 'nope', () => {})
  } catch (e) {
    err = String(e.message ?? e)
  }
  ok(/unknown provider: nope/.test(err), '本体拒绝时错误原样上抛（不被吞掉）')
}

/* ── 4. waitForLogin 三种终态 ── */

console.log('\nwaitForLogin（三种终态都要认）：')
{
  const c = fakeContainer({ create: {}, polls: [{ done: true, success: true }] })
  const { waitForLogin } = make(c)
  const { got: r, err } = await attempt(waitForLogin(c, 'marvis', 'marvis-abc', () => {}), 3_000, 'waitForLogin')
  ok(err === '', `不抛错（实际错误：${err || '（没有）'}）`)
  ok(r?.ok === true, 'done + success:true → ok')
}
{
  const c = fakeContainer({
    create: {},
    polls: [{ done: true, success: false, error: '授权页被关掉了' }],
  })
  const { waitForLogin } = make(c)
  const r = await waitForLogin(c, 'marvis', 'marvis-abc', () => {})
  ok(r.ok === false, 'done + success:false → 失败')
  ok(r.error === '授权页被关掉了', '失败原因用本体给的人话，不自造文案')
}
{
  const c = fakeContainer({ create: {}, polls: [{ done: true, success: false }] })
  const { waitForLogin } = make(c)
  const r = await waitForLogin(c, 'marvis', 'marvis-abc', () => {})
  ok(r.ok === false && r.error.includes('没有完成授权'), '本体没给原因时补一句可读的兜底')
}
{
  // 前两次还在等，第三次成功
  const c = fakeContainer({
    create: {},
    polls: [{ done: false }, { done: false }, { done: true, success: true }],
  })
  const { waitForLogin } = make(c)
  const { got: r, err } = await attempt(waitForLogin(c, 'marvis', 'marvis-abc', () => {}), 3_000, 'waitForLogin')
  ok(err === '', `不抛错（实际错误：${err || '（没有）'}）`)
  ok(r?.ok === true, 'done:false 不算终态，继续等到成功')
}
{
  // 中间抛一次错，不算终态
  const c = fakeContainer({
    create: {},
    polls: [new Error('路由暂时不可用'), { done: true, success: true }],
  })
  const { waitForLogin } = make(c)
  const { got: r, err } = await attempt(waitForLogin(c, 'marvis', 'marvis-abc', () => {}), 3_000, 'waitForLogin')
  ok(err === '', `不抛错（实际错误：${err || '（没有）'}）`)
  ok(r?.ok === true, '单次轮询抛错不算终态（容器刚起来会短暂失败）')
}
{
  // 一直还在等 → 超时
  const c = fakeContainer({ create: {}, polls: [{ done: false }] })
  const { waitForLogin } = make(c)
  const t0 = Date.now()
  const r = await waitForLogin(c, 'marvis', 'marvis-abc', () => {})
  const dt = Date.now() - t0
  ok(r.ok === false, '一直 done:false → 超时失败')
  ok(/还没在浏览器里完成授权/.test(r.error), '超时文案说清是「没在浏览器里完成」，不是含糊的「超时」')
  ok(dt >= 100, `确实等到了上限才返回（耗时 ${dt}ms）`)
}

/* ── 5. abandonAccount：删之前必须再摸一次 poll ── */

console.log('\nabandonAccount（不可逆删除前的三道闸门）：')
{
  const c = fakeContainer({ create: {}, polls: [{ done: true, success: true }] })
  const { abandonAccount } = make(c)
  const fate = await abandonAccount(c, 'marvis', 'marvis-abc', () => {})
  ok(c.deleted.length === 0, 'poll 说已完成 → 绝不删（用户可能恰在超时那刻登录成功）')
  ok(fate === 'kept', `poll 说已完成 → 返回 kept（实际 ${fate}）`)
}
{
  const c = fakeContainer({ create: {}, polls: [new Error('问不出来')] })
  const { abandonAccount } = make(c)
  const fate = await abandonAccount(c, 'marvis', 'marvis-abc', () => {})
  ok(c.deleted.length === 0, 'poll 抛错 → 保守不删（宁可留占位让用户手动删）')
  ok(fate === 'unknown', `poll 抛错 → 返回 unknown（实际 ${fate}）`)
}
{
  // 二审抓到的真实缺陷（2026-10-29）：`done === true` 不等于成功。
  // 用户关掉授权页 / 点拒绝 / 设备码输错超时，本体 `login.poll` 都会回
  // `{ done: true, success: false, error: '授权页被关掉了' }`（`loginFailureOf()`
  // 优先于一切进度判据）。早前这里只判 `done === true` ⇒ 用户**任何**主动放弃都被
  // 当成「其实登录成功了」→ magpie 里留一条绿色的「已新建」记录，账号却不存在。
  const c = fakeContainer({
    create: {},
    polls: [{ done: true, success: false, error: '授权页被关掉了' }],
  })
  const { abandonAccount } = make(c)
  const fate = await abandonAccount(c, 'marvis', 'marvis-abc', () => {})
  ok(fate !== 'kept', `done:true 但 success:false → 不能当 kept（实际 ${fate}）`)
  ok(fate === 'deleted', `done:true 但 success:false → 确认失败，收掉占位（实际 ${fate}）`)
  ok(c.deleted.length === 1 && c.deleted[0] === 'marvis-abc', 'success:false → 占位真的删了')
}
// 注：`callback()` 本身没在这里真跑 —— 它挂在工厂返回的 `auth.methods[]` 里，
// 要起真容器才拿得到。它对 `kept` 的处理由第 6 节的源码守卫（`fate !== 'kept'`）
// 守着，`abandonAccount` 这一侧则由上面三条覆盖。早前这里曾放过一条「再调一次
// abandonAccount 断言 fate !== 'kept'」的用例，与上一块完全重复、只换文案，
// 2026-10-29 三审指出后已删（它会让变异红项数虚高一条）。
{
  const c = fakeContainer({ create: {}, polls: [{ done: false }] })
  const { abandonAccount } = make(c)
  const fate = await abandonAccount(c, 'marvis', 'marvis-abc', () => {})
  ok(c.deleted.length === 1 && c.deleted[0] === 'marvis-abc', '确证未完成 → 收掉占位')
  ok(fate === 'deleted', `确证未完成 → 返回 deleted（实际 ${fate}）`)
}
{
  // 全程挂住 → pollLoginOnce 超时 → catch 分支 → unknown（不是 kept，也不是 deleted）
  const c = fakeContainer({ create: {}, polls: ['hang'] })
  const { abandonAccount } = make(c)
  const fate = await abandonAccount(c, 'marvis', 'marvis-abc', () => {})
  ok(c.deleted.length === 0, 'poll 挂住 → 不删')
  ok(fate === 'unknown', `poll 挂住 → 返回 unknown（实际 ${fate}）`)
}

/* ── 5.2 空 loginUrl 的新契约 ──
 *
 * 裁剪后 startNewAccount 对「缺 accountId」抛错、对「loginUrl 为空」不再有任何
 * 特殊分支（browser 腿的空 loginUrl 是正常形态，统一收口成 reused:false +
 * incognitoOpened:true）。原版「astudio reused / 别家报错」的三态分辨随裁剪删除。
 */

console.log('')
console.log('startNewAccount 对空 loginUrl 的分辨（新契约）：')
{
  // 空 loginUrl 本身不抛错（browser 腿正常形态）—— 已在第 3 节验证；
  // 这里补「连 accountId 都没有 → 抛错」这条，锚住唯一剩下的失败分支。
  const c = fakeContainer({ create: { loginUrl: '', reused: true } })
  const { startNewAccount } = make(c)
  let err = ''
  try {
    await startNewAccount(c, 'nope', () => {})
  } catch (e) {
    err = String(e.message ?? e)
  }
  ok(/没能为 nope 起一个登录流程/.test(err), '连 accountId 都没有 → 抛错（reused 也救不了）')
}

/* ── 5.5 单次轮询必须有上限（否则一次挂住的 rpc 会让等待永不返回） ── */

console.log('')
console.log('pollLoginOnce 的单次上限：')
{
  const c = fakeContainer({ create: {}, polls: ['hang'] })
  const { pollLoginOnce } = make(c)
  const t0 = Date.now()
  let err = ''
  try {
    await pollLoginOnce(c, 'marvis-abc')
  } catch (e) {
    err = String(e?.message ?? e)
  }
  const cost = Date.now() - t0
  ok(err.includes('没有返回'), `挂住的 poll 会被超时打断（错误：${err || '（没有报错！）'}）`)
  ok(cost < 500, `超时按 LOGIN_POLL_TIMEOUT_MS 生效（实际 ${cost}ms）`)
}
{
  // 挂住之后 waitForLogin 不能永远不返回：第一轮挂住（被超时打断、记为 lastError），
  // 第二轮正常返回 done → 应当正常成功
  const c = fakeContainer({ create: {}, polls: ['hang', { done: true, success: true }] })
  const { waitForLogin } = make(c)
  const t0 = Date.now()
  const { got, err } = await attempt(waitForLogin(c, 'marvis', 'marvis-abc', () => {}), 3_000, 'waitForLogin')
  const cost = Date.now() - t0
  ok(err === '', `不抛错（实际错误：${err || '（没有）'}）`)
  ok(got?.ok === true, '一次挂住不算终态，下一轮成功就成功')
  ok(cost < 800, `没有卡死在挂住那一轮（实际 ${cost}ms）`)
}
{
  // 全程挂住 → 到点必须给出「等了 N 分钟」的失败，而不是永不返回
  const c = fakeContainer({ create: {}, polls: ['hang'] })
  const { waitForLogin } = make(c)
  const t0 = Date.now()
  const got = await waitForLogin(c, 'marvis', 'marvis-abc', () => {})
  const cost = Date.now() - t0
  ok(got.ok === false, '全程挂住 → 到点失败（不是永不返回）')
  ok(/等了 \d+ (分钟|秒)/.test(String(got.error)), `失败原因是超时的人话：${got.error}`)
  ok(cost < 1_500, `整体在测试时限内收口（实际 ${cost}ms）`)
}

/* ── 5.6 account.create 也要有上限（占位已进池、rpc 不返回） ── */

console.log('')
console.log('account.create 的单次上限：')
{
  const c = fakeContainer({ create: 'hang' })
  const { startNewAccount } = make(c)
  const t0 = Date.now()
  let err = ''
  try {
    // 看门狗给 1.5 秒：被测代码的 CREATE_TIMEOUT_MS 在测试里被换成 120ms，
    // 所以正常路径必然先抛；只有「守卫被删掉」才会撞到看门狗。
    await watchdog(startNewAccount(c, 'marvis', () => {}), 1_500, 'startNewAccount')
  } catch (e) {
    err = String(e?.message ?? e)
  }
  const cost = Date.now() - t0
  ok(/account\.create \d+ms 没有返回/.test(err), `挂住的 create 会被超时打断（错误：${err || '（没有报错！）'}）`)
  ok(cost < 800, `超时按 CREATE_TIMEOUT_MS 生效（实际 ${cost}ms）`)
}
{
  // 守卫本身：到点抛、正常返回不抛、且不会让进程多活
  const c = fakeContainer({ create: { accountId: 'x', loginUrl: 'https://y' } })
  const { withRpcDeadline } = make(c)
  const v = await withRpcDeadline(c, 'account.create', { provider: 'marvis' }, 120, 'account.create')
  ok(v.accountId === 'x', 'withRpcDeadline 正常路径原样透传返回值')
}

/* ── 6. 源码守卫：不许在 authorize 里等用户 ── */

console.log('\n源码守卫：')
{
  // ⚠️ 必须先剥注释再匹配：裸正则会拿注释里的函数名当「调用」（实测把真实调用
  // 删掉、旁边写一句 `// startNewAccount 被删了` 就能骗过旧版本，全绿通过）。
  const stripComments = (t) =>
    t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  const authStart = src.indexOf('async authorize() {', src.indexOf("type: 'oauth'"))
  const authEnd = src.indexOf('async callback() {', authStart)
  ok(authStart > 0 && authEnd > authStart, '能从源码里切出 oauth 的 authorize 段')
  const authBody = stripComments(src.slice(authStart, authEnd))
  ok(!/waitForLogin/.test(authBody), 'authorize() 里不调 waitForLogin（那会撞 magpie 的 1 分钟硬超时）')
  ok(
    /startNewAccount\s*\(/.test(authBody),
    'authorize() 真的调了 startNewAccount（不是只写在注释里）',
  )
  ok(/opened:/.test(authBody), 'authorize() 返回 opened（marvis 的 browser 腿本体自己开窗，magpie 不应再开窗）')
  // 预算守卫：start() 允许 40 秒 + create 45 秒 = 85 秒，会撞穿 magpie 给
  // authorize() 的 1 分钟硬超时。必须给 start() 也套上限（2026-10-29 二审指出）。
  ok(
    /withDeadline\(\s*container\.start\(\)/.test(authBody),
    'authorize() 给 container.start() 套了上限（否则 40s+45s=85s 撞穿 1 分钟）',
  )

  // ⚠️ 定时器绝不能 `unref()`：被等的 promise 真挂住时事件循环里只剩这个定时器，
  // `unref()` 会让 Node 判定「无事可做」直接退出（`Warning: Detected unsettled
  // top-level await`，退出码 13），超时错误永远抛不出来。2026-10-29 三审实测：
  // 给 `withDeadline` 加 `unref()` 后本文件仍 exit=0 全绿 —— 说明当时没有任何断言
  // 守这条。这里补源码守卫，把「有人手滑加回去」挡在门外。
  //
  // 切段用「函数头 → 它自己的闭合 `}`」而不是「函数头 → 下一个函数的 indexOf」：
  // 后者两个 indexOf 任一返回 -1 时 `slice(start, -1)` 会吞到文件末尾（表现是崩栈，
  // 方向安全但红得不可读），而且只覆盖了 `withDeadline` 一个函数 —— 实测给
  // `withRpcDeadline` 或 `pollLoginOnce` 加 `unref()` 全绿放行（2026-10-29 四审指出）。
  // `pollLoginOnce` 尤其要紧：它另写了一遍同样的 `setTimeout` + `Promise.race`，
  // 源码注释里明写「这里不能 unref」，是真实风险点。
  const sliceFn = (name) => {
    const a = src.indexOf(`async function ${name}(`)
    if (a < 0) return ''
    const b = src.indexOf('\n}\n', a)
    return b > a ? src.slice(a, b + 3) : ''
  }
  for (const fnName of ['withDeadline', 'withRpcDeadline', 'pollLoginOnce']) {
    const fnBody = stripComments(sliceFn(fnName))
    ok(fnBody.length > 0, `能从源码里切出 ${fnName} 的函数体`)
    // 用 `\bunref\b` 而不是 `\.unref\s*\(`：后者挡不住
    // `const u = timer.unref.bind(timer); u()` 这种别名写法（四审实测全绿放行）。
    ok(
      !/\bunref\b/.test(fnBody),
      `${fnName} 里没有出现 unref（有的话超时错误永远抛不出来，进程直接 exit 13）`,
    )
  }

  const cbStart = src.indexOf('async callback() {', authStart)
  const cbBody = stripComments(src.slice(cbStart, src.indexOf("type: 'success'", cbStart)))
  ok(/await waitForLogin\s*\(/.test(cbBody), 'callback() 里真的 await 了 waitForLogin')
  ok(/abandonAccount\s*\(/.test(cbBody), 'callback() 失败时真的调了 abandonAccount')
  ok(/fate !== 'kept'/.test(cbBody), "callback() 认 abandonAccount 的 'kept'（否则把已登录的号标成失败）")
}

/* ── 6.2 超时预算：start + create 必须 < magpie 的 1 分钟 ── */

console.log('')
console.log('authorize() 的超时预算：')
{
  const c = fakeContainer({ create: {} })
  const { withDeadline } = make(c)
  // ⚠️ 这里必须读**源码里的真值**，不能用 make() 拿到的：测试为了跑得快，把
  // `CREATE_TIMEOUT_MS` 替换成了 120ms —— 拿它做算术永远是绿的，等于没测。
  // 正则要能吃小数与科学计数法：`12_000.5` 用 `([\d_]+)` 会截成 12000（漏检），
  // `12e3` 则一个都读不到。读不到时必须报一条**可读**的失败 —— 早前是让
  // `make()` 里的 `new Function` 崩 `ReferenceError`，exit=1 却 0 条 ✗，
  // 看不出是哪条断言红了（2026-10-29 三审指出）。
  // 尾部 `(?![\w.])` 收口：`\b` 挡不住 `1_0e1_0`（真实 1e11，会被截成 100，
  // 读小 1e9 倍反而能过「total < 60000」的闸门变成假绿）也挡不住 `1.2.3`（截成 1.2）。
  // 加了之后这类写法一律读成 NaN ⇒ 断言红，方向安全（2026-10-29 四审指出）。
  const readConst = (name) => {
    const m = new RegExp(`const ${name} = ([0-9][0-9_]*(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)(?![\\w.])`, 'i').exec(src)
    return m ? Number(m[1].replace(/_/g, '')) : Number.NaN
  }
  const realStart = readConst('START_TIMEOUT_MS')
  const realCreate = readConst('CREATE_TIMEOUT_MS')
  const gotStart = Number.isFinite(realStart) && realStart > 0
  const gotCreate = Number.isFinite(realCreate) && realCreate > 0
  ok(gotStart, `源码里能读到 START_TIMEOUT_MS（读到：${gotStart ? realStart : '读不到，常量改名了？'}）`)
  ok(gotCreate, `源码里能读到 CREATE_TIMEOUT_MS（读到：${gotCreate ? realCreate : '读不到，常量改名了？'}）`)
  if (gotStart && gotCreate) {
    const total = realStart + realCreate
    ok(total < 60_000, `start ${realStart}ms + create ${realCreate}ms = ${total}ms < 60000ms（magpie 给 authorize() 的硬超时）`)
    ok(realStart >= 5_000, `start 上限不能太紧（实测冷启动 1.4s，取 ${realStart}ms 留足余量）`)
    ok(realCreate <= 50_000, `create 上限不能贴着 1 分钟（取 ${realCreate}ms）`)
  }

  // 挂住的 promise 必须被超时打断，且抛的是可读错误
  let err = ''
  const t0 = Date.now()
  try {
    await withDeadline(new Promise(() => {}), 80, '本体容器启动')
  } catch (e) {
    err = String(e?.message ?? e)
  }
  const dt = Date.now() - t0
  ok(/本体容器启动 80ms 没有返回/.test(err), `挂住的 start() 被超时打断（实际：${err || '（没抛错）'}）`)
  ok(dt >= 60 && dt < 1_000, `超时按传入的毫秒生效（耗时 ${dt}ms）`)

  // 正常路径原样透传，且不因为 finally 的 clearTimeout 而改变返回值
  const got = await withDeadline(Promise.resolve('ok-value'), 500, 'x')
  ok(got === 'ok-value', '正常路径原样透传返回值')
}

/* ── 7. oauth 方法本身的形状（本 fork 只剩 marvis 一家）── */

console.log('\noauth 方法形状：')
{
  const mod = await import('file:///' + path.join(ROOT, 'index.mjs').replace(/\\/g, '/'))
  const fns = Object.entries(mod).filter(([, v]) => typeof v === 'function')
  ok(fns.length === 1, `入口只导出 1 个插件工厂（实际 ${fns.length}）`)
  for (const [name, fn] of fns) {
    // ⚠️ 必须传 home：不传就走 `resolveHome()` 的 `homedir()` 回退，`warmUp()`
    // 会在后台把容器起起来并往真实 `~/.dsh` 写缓存（见文件头 TMP_HOME 那段）。
    const p = await fn({ client: { app: { log: () => {} } } }, { home: TMP_HOME })
    ok(p.auth.provider === 'jet-hub-marvis', `provider id 是 jet-hub-marvis（实际 ${p.auth.provider}）`)
    const oauth = (p.auth.methods ?? []).filter((m) => m.type === 'oauth')
    ok(oauth.length === 1, `${p.auth.provider} 恰有一个 oauth 型新建方法`)
    for (const m of oauth) {
      ok(typeof m.authorize === 'function', `${p.auth.provider} 的 oauth 方法有 authorize`)
      ok(m.ask === undefined, `${p.auth.provider} 的 oauth 方法没有 ask（新建没得选）`)
      ok(typeof m.label === 'string' && m.label.includes('新建'), `${p.auth.provider} 的 oauth 标签说清是「新建」`)
    }
    // 裁剪后的方法面：第 1 条是「接已有账号」的 api 型，第 2 条是 oauth 型新建 ——
    // 不再有任何「贴 Key 新建」的 api+ask 方法（那三家 Key 型渠道已随裁剪删除）。
    const methods = p.auth.methods ?? []
    ok(methods.length === 2, `${p.auth.provider} 恰有 2 个签入方法（实际 ${methods.length}）`)
    ok(methods[0]?.type === 'api' && methods[0]?.keyless === true, '第 1 个方法是 api 型 + keyless（接已有账号）')
    ok(methods[1]?.type === 'oauth', '第 2 个方法是 oauth 型（新建账号）')
  }
  const { DSH_PROVIDERS } = await import(pathToFileURL(path.join(ROOT, 'src/plugin.mjs')).href)
  ok(DSH_PROVIDERS.join(',') === 'marvis', `DSH_PROVIDERS 只剩 marvis（实际 ${DSH_PROVIDERS.join(', ')}）`)
  ok(fns.map(([n]) => n).join(',') === 'JetHubMarvisPlugin', `工厂名是 JetHubMarvisPlugin（实际 ${fns.map(([n]) => n).join(', ')}）`)
}
/* ── 10. vendor 的 provider 表 vs 插件 DSH_PROVIDERS 对账 ── */
//
// 为什么要有这一节：上游每次加一家 provider，插件侧必须同步三处
// （`DSH_PROVIDERS` / `NAMES` / `index.mjs` 工厂导出），漏一处要么静默少一家、
// 要么整个插件加载失败。此前**没有任何测试对账**，全靠人肉 grep。
//
// 判据取 `vendor/lib/index.js` 的 `const modelAdapters = { ... }` 块：那张表是
// 本体「哪些 provider 有模型适配器」的唯一登记处（`pruned(PROVIDER, adapter)`
// 每行一个）。里面含 `aggregate` 与 `jet-hub-auto` 两个路由组，而插件从
// 2026-10-31 起**故意不注册**它们 —— 所以两个方向都要断言，
// 且「vendor 有、插件没有」这一侧要放行这两个路由组，其余仍必须补齐。
{
  const vendorIdx = fs.readFileSync(path.join(ROOT, 'vendor', 'lib', 'index.js'), 'utf8')
    .replace(/\r\n/g, '\n')
  const start = vendorIdx.indexOf('const modelAdapters = {')
  const end = start > 0 ? vendorIdx.indexOf(String.fromCharCode(10) + '    };', start) : -1
  ok(start > 0 && end > start, '能从 vendor/lib/index.js 里切出 modelAdapters 表')
  if (start > 0 && end > start) {
    // ⚠️ 键可能带单引号（`'jet-hub-auto': pruned(AUTO_PROVIDER, autoAdapter, { enabled: false })`），
    // 不加 `'?` 会把它漏掉 —— 二审实测：插一行 `'fake-newprov-x': pruned(...)` 时
    // 旧正则抽不出这个键，于是「vendor 里这些 provider 插件没接」永远看不到它，测试假绿。
    const keys = [...vendorIdx.slice(start, end).matchAll(/^\s{8}'?([a-zA-Z0-9_-]+)'?:\s*pruned\(/gm)].map((m) => m[1])
    // 裁剪锚点：表里只剩 marvis + 两个路由组（aggregate / jet-hub-auto），共 3 键。
    ok(
      [...keys].sort().join(',') === 'aggregate,jet-hub-auto,marvis',
      `modelAdapters 恰为 marvis + 两个路由组（实际 ${keys.join(', ')}）`,
    )
    const { DSH_PROVIDERS: DP } = await import(pathToFileURL(path.join(ROOT, 'src', 'plugin.mjs')).href)
    const vendorSet = new Set(keys)
    const pluginSet = new Set(DP)
    // ① vendor 有的，插件必须也有 —— 这是「上游加了、插件忘了加」的缺口。
    //    两个路由组是**有意不接**的，放行它们，但放行名单必须写死在这里，
    //    否则将来真漏一家也会被当成路由组悄悄放过。
    const SKIP_ROUTE_GROUPS = new Set(['aggregate', 'jet-hub-auto'])
    const missing = keys.filter((k) => !pluginSet.has(k) && !SKIP_ROUTE_GROUPS.has(k))
    ok(missing.length === 0, `vendor 里这些 provider 插件没接：${missing.join(', ') || '无'}`)
    ok(
      keys.filter((k) => SKIP_ROUTE_GROUPS.has(k)).length === 2,
      '两个路由组仍在 vendor 里（说明「不接入」是插件侧的决定，不是上游没了）',
    )
    // ② 插件有的，vendor 必须也有 —— 这是「插件写了家上游不存在的 provider」的缺口，
    //    那种只会在运行时 404。
    const extra = DP.filter((k) => !vendorSet.has(k))
    ok(extra.length === 0, `插件里这些 provider 在 vendor 里不存在：${extra.join(', ') || '无'}`)
    // ③ `NAMES` 必须覆盖全部 provider —— 漏一家会在 magpie 的方法选择器里显示成
    //    内部 id。这里对账的是「键齐全且有非空文案」，不校验文案内容。
    //    `NAMES` 没从 `src/plugin.mjs` 导出（`index.mjs` 的导出契约只允许插件工厂），
    //    所以同样从源码文本里解析。
    const pluginSrc = fs.readFileSync(path.join(ROOT, 'src', 'plugin.mjs'), 'utf8')
      .split(String.fromCharCode(13, 10)).join(String.fromCharCode(10))
    const namesStart = pluginSrc.indexOf('const NAMES = {')
    const namesEnd = namesStart > 0 ? pluginSrc.indexOf(String.fromCharCode(10) + '}', namesStart) : -1
    ok(namesStart > 0 && namesEnd > namesStart, '能从 src/plugin.mjs 里切出 NAMES 表')
    if (namesStart > 0 && namesEnd > namesStart) {
      const body = pluginSrc.slice(namesStart, namesEnd)
      const named = new Set(
        [...body.matchAll(/^\s+'?([a-zA-Z0-9_-]+)'?:\s*'([^']*)'/gm)]
          .filter((m) => m[2].trim() !== '')
          .map((m) => m[1]),
      )
      const noName = DP.filter((p) => !named.has(p))
      ok(noName.length === 0, `NAMES 缺这些 provider 的显示名：${noName.join(', ') || '无'}`)
    }
    // ④ `FALLBACK_MODELS` 必须每家至少一条 —— 它是「内存缓存与磁盘缓存都没有时」
    //    的唯一兜底（`currentModels()` 的第 3 档）。漏一家 = 那家第一次启动在 magpie
    //    里一个模型都看不到，且没有任何报错。
    //    （原「快照对账」⑤⑥ 两节已删：page/models.js 快照与 scripts/snapshot-models.mjs
    //     都随裁剪移除，没有对账对象了。）
    const fbStart = pluginSrc.indexOf('const FALLBACK_MODELS = {')
    const fbEnd = fbStart > 0 ? pluginSrc.indexOf(String.fromCharCode(10) + '}', fbStart) : -1
    ok(fbStart > 0 && fbEnd > fbStart, '能从 src/plugin.mjs 里切出 FALLBACK_MODELS 表')
    if (fbStart > 0 && fbEnd > fbStart) {
      const fbBody = pluginSrc.slice(fbStart, fbEnd)
      const fbProviders = new Set(
        [...fbBody.matchAll(/^\s+'?([a-zA-Z0-9_-]+)\//gm)].map((m) => m[1]),
      )
      const noFallback = DP.filter((p) => !fbProviders.has(p))
      ok(noFallback.length === 0, `FALLBACK_MODELS 缺这些 provider 的兜底模型：${noFallback.join(', ') || '无'}`)
      // 点名：marvis 的唯一槽位必须是 `main-auto`（服务端自动路由，真实模型 id
      // 不能直传 —— 上游回 400「无效模型id」）。
      const fbIds = [...fbBody.matchAll(/^\s+'([^']+)':/gm)].map((m) => m[1])
      ok(fbIds.includes('marvis/main-auto'), `FALLBACK_MODELS 里有 marvis/main-auto（实际 ${fbIds.join(', ')}）`)
      ok(fbIds.every((id) => id === 'marvis/main-auto'), `FALLBACK_MODELS 只剩 marvis 一家的条目（实际 ${fbIds.join(', ')}）`)
    }
  }
}

cleanupTmp()

console.log('')
if (bad === 0) {
  console.log(`✓ 全部通过（${total} 项：新建账号链路 —— 固定 mode:browser、只拿到占位就返回、三种终态、删除前三道闸门）`)
  process.exit(0)
}
console.log(`✗ ${bad} 项失败`)
process.exit(1)
