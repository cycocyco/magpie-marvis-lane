# magpie-marvis-lane

腾讯 **Marvis** 的 [magpie](https://usemagpie.ai) 供应商插件 —— 从 [Betsy20/magpie-Jet-Hub](https://github.com/Betsy20/magpie-Jet-Hub) 摘出的**单车道**版本：把上游 [dsh-providers-hub](https://github.com/iJetLi/dsh-providers-hub) 引擎里 **marvis 车道 + 共享基建** 原样保留，其余 28 家供应商、控制台、页面与相关脚本全部移除。

## 它做什么

- magpie 供应商列表里出现一张「腾讯 Marvis」卡片，模型为 `main-auto`（上游无目录端点，服务端自动路由）。
- 「新建账号」：拉起隔离 Chromium 走浏览器 OAuth（QQ / 微信扫码），模拟 Marvis 客户端指纹；登录完成自动接入。
- 「连接已有账号」：把插件里已经登录过的号一键接进 magpie，不用再输任何东西。
- 用量卡显示钱包余额（`/v3/marvis_get_wallet`，字符串数字）；请求级 429 / 额度耗尽自动换号 + 冷却。
- **不往 magpie 里塞账号**：插件加载后账号列表是空的，账号只由用户亲手添加。

## 架构（继承自上游，未改语义）

```
magpie 网关
  └─ provider jet-hub-marvis
       └─ auth.loader().fetch → JetHubContainer（src/container.mjs）
            ├─ 内嵌 cordis 容器 + vendor/lib/index.js（裁剪后的本体引擎）
            ├─ 账号池 / 静默续期 / 临期折算 / 聚合与 auto 路由组（进程内）
            └─ ctx.llm.stream() 进程内直连（src/llm-bridge.mjs，无本地端口）
```

- **凭据自持**：落在插件自己家目录 `~/.config/magpie/jet-hub-marvis/.dsh/.credentials.yaml`
  （见 `src/plugin.mjs` 的 `resolveHome`）。**不依赖、也不写入宿主 DSH 的 `~/.dsh`**。
  想与已有 DSH 凭据共用，显式传插件 option `home` 指向含 `.dsh` 的目录即可。
- **无内嵌 HTTP 网关**：对话请求在进程内直达本体 `ctx.llm`，不占端口、不需要 apiKey。
- **聚合 / auto 路由组保留**：本体内部择优路由仍在，只是不再注册成 magpie provider（单渠道下行为与原版一致）。

## 与上游（Jet-Hub）的差异

| 面 | 处理 |
|---|---|
| 28 家供应商模块（`vendor/lib/<lane>-*.js`） | 全部删除 |
| 共享引擎（账号池 / 续期 / 聚合 / 网关 / store） | 保留，登记点剪成只剩 marvis |
| 本地控制台（`console/` + `src/hub-server.mjs`） | 移除（多供应商管理 UI，单车道无意义） |
| magpie 插件页（`page/`） | 移除 |
| `scripts/` | 只留测试、价格表生成、凭据播种 |
| `tests/` | 保留与 marvis / 通用基建相关的用例，控制台 / Key 型 / magicrew 专属用例移除 |

`vendor/` 仍是上游构建产物的形态（未混淆、带注释的编译输出），裁剪以「删模块 + 剪登记点」方式进行，引擎语义不动。

## 安装

```bash
magpie plugin add cycocyco/magpie-marvis-lane
```

或在 magpie 插件设置里填 GitHub 简写。前置条件：**无**。不需要 DSH，不需要预先安装任何东西——
凭据由插件自己在首次「新建账号」时通过浏览器 OAuth 取得，存在插件自己的目录里。

也可直接从本地文件夹装载（开发时推荐，改完关掉再打开插件即重载，不必重启 magpie）：

```bash
magpie plugin add /path/to/magpie-marvis-lane
```

## 开发

```bash
npm install
npm test           # 离线单测（22 项）
npm run gen:prices # 从 magpie 缓存的 models.dev 目录重生成参考价表
```

`npm run seed:auth` 是可选的：把插件家目录里已有的账号摊平进 magpie 的 `plugin-auth.json`
（正常使用**不需要**它 —— 账号请通过界面添加）。

## License

MIT（继承上游；`vendor/` 部分归 upstream 仓库所有，商标归腾讯）。
