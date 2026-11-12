// 本体 RPC 方法总数的口径锁定测试（本 fork 裁剪版）。
//
// 背景：原版还要对账「控制台覆盖率」，但控制台（console/）已随 28 家供应商
// 一并裁剪删除，那几个段落（rpc() 调用点解析、DELEGATED/DROPPED 表、
// REKEY_CHANNELS 对账、探活）随之失去被测对象，整段移除。
//
// 现在只锁两件事：
//   ① 「本体实际可调度的方法」全集与总数锚点 —— 三条解析链都从源码提取：
//      A) 主 `switch (method)` 块里的 `case '<x>.<y>'` 标签；
//      B) `handleMethod()` 里的前缀改道 / 单方法改道（裁剪后为 0，解析器保留：
//         上游同步带回前缀改道时这里自动重新计数，不用改测试）。
//   ② 裁剪事实的反向锚点：captcha.*、sendSms/submitSms、loomy.permanentLock
//      等 28 家专属方法**必须不在**方法面里 —— 多留一个就说明裁剪不干净。
//
// 另外「未知方法回错」这条契约也钉住：主 switch 的 `default:` 必须回
// `unknown method: <method>`（原探活断言的静态等价物）。
//
// vendor 本地补丁的锚点（原第 8 节）保留：docs/vendor.md 的同步流程是整片覆盖
// vendor/，补丁被覆盖时会**静默**失效，必须钉成断言。
//
// 退出码即结论。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const RPC_JS = path.join(ROOT, 'vendor', 'lib', 'jet-hub-rpc.js')

let failed = 0
const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failed += 1
}
const read = (p) => fs.readFileSync(p, 'utf8')
const linesOf = (p) => read(p).split(/\r?\n/)

// ---- 0) 解析器自检：正则拼装的转义必须是对的 --------------------------------
// 模板串里写 `\s`，JS 字符串字面量先把未知转义当字面字符消费掉（`\s` → `s`），
// 拼出的正则永远匹配不到 `const cfg = …`。钉成断言，坏掉时第一时间在这里响。
{
  const B = '\\' // 一个反斜杠
  const sample = 'const cfg = PROXY_CHANNELS[provider]'
  const eaten = new RegExp(`(?:const|let|var)\s+cfg\s*=\s*(.+)$`).source
  const proper = new RegExp(`(?:const|let|var)${B}s+cfg${B}s*=${B}s*(.+)$`).source
  ok(eaten === '(?:const|let|var)s+cfgs*=s*(.+)$',
    `自检：模板串里的单个反斜杠+s 被吃成 s（正则 = ${eaten}）`)
  ok(new RegExp(proper).test(sample),
    `自检：双反斜杠拼出的正则能命中 \`const cfg = …\`（正则 = ${proper}）`)
  ok(!new RegExp(eaten).test(sample),
    '自检：被吃掉反斜杠的正则命中不了 —— 这就是「解析不出实参」的根因')
}

// ---- 1) A：主 switch (method) 块里的 case 标签 ---------------------------------
const rpcLines = linesOf(RPC_JS)
const switchLine = rpcLines.findIndex((l) => /switch\s*\(\s*method\s*\)/.test(l))
ok(switchLine >= 0, `找到主 switch (method)（第 ${switchLine + 1} 行）`)

const mainCases = []
let sawDefault = false
for (let i = switchLine + 1; i < rpcLines.length; i++) {
  const m = rpcLines[i].match(/^(\s*)case '([A-Za-z][A-Za-z0-9_-]*\.[A-Za-z][A-Za-z0-9_-]*)'\s*:/)
  if (m) mainCases.push({ line: i + 1, method: m[2], hasBody: rpcLines[i].slice(m[0].length).trim() !== '' })
  if (/^\s{8,}default\s*:/.test(rpcLines[i])) { sawDefault = true; break }
}
ok(mainCases.length === new Set(mainCases.map((c) => c.method)).size,
  `主 switch 里 case 标签无重复（${mainCases.length} 个标签 / ${new Set(mainCases.map((c) => c.method)).size} 个唯一）`)

// 别名/老端点：标签后不跟 { 的是 fall-through，与下一个 case 共享实现体。
const fallThrough = mainCases.filter((c) => !c.hasBody).map((c) => c.method)
console.log(`  A) 主 switch 方法数: ${new Set(mainCases.map((c) => c.method)).size}`)
console.log(`  其中共享实现体的标签: ${fallThrough.length ? fallThrough.join(', ') : '无'}`)

// 「未知方法回错」契约（原探活断言的静态等价物）：`default:` 必须存在且回
// `unknown method: <method>` —— case 标签存在但调度没接进去时，探活就是靠这条兜住的。
ok(sawDefault, '主 switch 有 default 分支')
ok(/default:\s*\n\s*return \{ ok: false, error: \{ code: 'bad-request', message: `unknown method: \$\{method\}` \} \};/.test(
  rpcLines.slice(switchLine, switchLine + 4000).join('\n'),
), 'default 分支回 `unknown method: <method>`（未知方法必须报错，不能静默）')

// ---- 2) B：handleMethod() 里的前缀改道 ----------------------------------------
// 解析器保留（原版从源码读「哪些前缀被改道」）。裁剪后前缀改道已整体删除，
// 这里解析出 0 个是**新事实**；上游同步带回改道分支时这里自动重新计数。
const handleStart = rpcLines.findIndex((l) => /function\s+handleMethod\s*\(/.test(l))
ok(handleStart >= 0, `找到 handleMethod()（第 ${handleStart + 1} 行）`)

const prefixes = []
const singleMethods = []
// 边界：只在 handleMethod 函数体里扫，即 [handleStart, switchLine)。
for (let i = handleStart; i < switchLine; i++) {
  const line = rpcLines[i] ?? ''
  const one = line.match(/method\s*===\s*'([A-Za-z][A-Za-z0-9_-]*)\.([A-Za-z][A-Za-z0-9_-]*)'/)
  if (one) {
    singleMethods.push({ method: `${one[1]}.${one[2]}`, line: i + 1 })
    continue
  }
  const m = line.match(/method\.startsWith\('([A-Za-z][A-Za-z0-9_-]*)\.'\)/)
  if (!m) continue
  let handler = null
  for (let k = i; k < Math.min(i + 6, rpcLines.length); k++) {
    const h = rpcLines[k].match(/await\s+(handle\w*Rpc)\s*\(/)
    if (h) { handler = h[1]; break }
  }
  prefixes.push({ prefix: m[1], handler, line: i + 1 })
}

// 处理器名 → 源文件：从 jet-hub-rpc.js 的 import 语句里解析，别猜文件名。
const importMap = {}
for (const l of rpcLines) {
  const m = l.match(/^import\s*\{([^}]*)\}\s*from\s*'\.\/(.+?\.js)'/)
  if (!m) continue
  for (const raw of m[1].split(',')) {
    const name = raw.trim().split(/\s+as\s+/)[0].trim()
    if (/^handle\w*Rpc$/.test(name)) importMap[name] = m[2]
  }
}

const prefixCases = []
for (const p of prefixes) {
  if (p.handler === null) { ok(false, `前缀 ${p.prefix}.* 的改道分支后面没找到 await handleXxxRpc(...)`); continue }
  const file = importMap[p.handler]
  if (!file) { ok(false, `前缀 ${p.prefix}.* 的处理器 ${p.handler} 找不到源文件（import 里没有）`); continue }
  const src = linesOf(path.join(ROOT, 'vendor', 'lib', file))
  const found = []
  for (const l of src) {
    const full = l.match(/^\s*case '([A-Za-z][A-Za-z0-9_-]*\.[A-Za-z][A-Za-z0-9_-]*)'\s*:/)
    if (full && full[1].startsWith(`${p.prefix}.`)) { found.push(full[1]); continue }
    const plain = l.match(/^\s*case '([A-Za-z][A-Za-z0-9_-]*)'\s*:/)
    if (plain) found.push(`${p.prefix}.${plain[1]}`)
  }
  const unique = [...new Set(found)]
  ok(unique.length > 0, `${file} 里认出 ${unique.length} 个 ${p.prefix}.* 方法`)
  for (const f of unique) prefixCases.push(f)
}
console.log(`  B) 前缀改道方法数: ${prefixCases.length}${prefixes.length ? '' : '（裁剪后为 0，符合预期）'}`)

const singleCaseMethods = singleMethods.map((s) => s.method)

// 前缀改道的方法不该同时出现在主 switch 里（否则重复计数/语义冲突）
const overlap = [...prefixCases, ...singleCaseMethods].filter((m) => mainCases.some((c) => c.method === m))
ok(overlap.length === 0, `前缀改道与主 switch 无重叠${overlap.length ? '：' + overlap.join(', ') : ''}`)

// ---- 3) 全量方法集合 ----------------------------------------------------------
const methods = [...new Set([...mainCases.map((c) => c.method), ...prefixCases, ...singleCaseMethods])].sort()
const mainMethodSet = new Set(mainCases.map((c) => c.method))
console.log(`\n  本体实际可调度方法总数: ${methods.length}（主 switch ${mainMethodSet.size} + 前缀改道 ${prefixCases.length} + 单方法改道 ${singleCaseMethods.length}）`)
if (singleCaseMethods.length > 0) console.log(`  单方法改道: ${singleCaseMethods.join(', ')}`)
// 总数锚点：解析链「少认几个」时，相对判据可能依然全绿。钉死总数；
// 上游加减方法时必须同步这个常量（它同时是「解析没退化成空」的兜底）。
// 56 = 裁剪版主 switch 的全部 case（前缀改道 / 单方法改道均为 0）。
const EXPECTED_RPC_METHOD_COUNT = 56
ok(methods.length === EXPECTED_RPC_METHOD_COUNT,
  `本体可调度方法总数应为 ${EXPECTED_RPC_METHOD_COUNT}，实际 ${methods.length}（上游加减方法时必须同步这个常量）`)
// marvis 链路必经的几个方法点名（少一个 = 新建/签到/用量链路断了）。
for (const must of ['account.list', 'account.create', 'account.delete', 'login.poll', 'credits.balances', 'credits.claimAll', 'credits.status', 'model.list']) {
  ok(methods.includes(must), `方法面里有 ${must}（marvis 链路必经）`)
}
// 裁剪反向锚点：28 家专属的方法**必须不在**方法面里 —— 多留一个说明裁剪不干净。
for (const gone of ['captcha.demand', 'captcha.carrierUrl', 'captcha.contribute', 'loomy.permanentLock']) {
  ok(!methods.includes(gone), `${gone} 已随裁剪删除（不该再出现在方法面里）`)
}
ok(!methods.some((m) => /^(qiniu|modelscope|baizhi|minimax|minimaxintl|opencode|gemini|qoder|monkeycode|monkeycodeintl|loomy|magicrew|workbuddy|cline|zcode)\./.test(m)),
  `方法面里没有 28 家专属前缀的方法（实际前缀分布：${[...new Set(methods.map((m) => m.split('.')[0]))].join(', ')}）`)
// fall-through 裁剪后应为空：loomy.permanentLock 别名已删，credits.permanentLock 独立成 case。
ok(fallThrough.length === 0, `主 switch 没有共享实现体的 fall-through 标签（实际：${fallThrough.join(', ') || '无'}`)

// ---- 4) vendor 本地补丁必须还在（docs/vendor.md 的同步会整片覆盖 vendor/）----
//
// 这些补丁打在**上游编译产物**上（`vendor/lib/jet-hub-rpc.js`），下次按文档
// 重跑同步会被整片覆盖且**静默**：
//   - `jet-hub-rpc` 少了「全关即意图」⇒ magpie 弹窗保存一次写满黑名单，**死循环**
{
  const rpc = read(RPC_JS)
  ok(/本仓改动（2026-11-05）：第三参是「\*\*目标意图\*\*」/.test(rpc),
    'vendor/lib/jet-hub-rpc.js 的「全关即意图」补丁还在（model.setDisabledMany）')
  // ⚠️ 第三个实参必须由 `closeProvider` **决定**，**不能**写死 `true`：
  // 直接传布尔 `false` 会 `delete providerClosed[provider]`，把用户先前设好的
  // 「关闭供应商」意图主动删掉（2026-11-04 真机报障）。
  ok(/writeModelsWithProviderClosed\(req\.provider, ids, closeProvider \? true : 'keep'\)/.test(rpc),
    '… 且真的调了 writeModelsWithProviderClosed(provider, ids, closeProvider ? true : \'keep\')')
  ok(/const coversAll = catalog\.complete\s*&& catalog\.ids\.length > 0\s*&& catalog\.ids\.every\(\(id\) => after\[id\] === true\)/.test(rpc),
    '… 判据用的是「写入后黑名单覆盖全量目录」（fullCatalogIds 的纯净并集，且空目录不算覆盖）')
  // 契约本身也要钉住：`closeProvider` 必须从 `req` 读、默认 `true`。
  ok(/const closeProvider = req\.closeProvider !== false;/.test(rpc),
    '… `closeProvider` 从 `req` 取、不传默认 `true`（与 setAllDisabled 同一条契约）')
}

console.log(failed === 0 ? `\n✓ RPC 口径一致：本体 ${methods.length} 个方法` : `\n✗ ${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
