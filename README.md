# magpie-marvis

腾讯 **Marvis** 的 [magpie](https://usemagpie.ai) 供应商插件 —— 从 [Betsy20/magpie-Jet-Hub](https://github.com/Betsy20/magpie-Jet-Hub) 摘出的单车道版本：把上游 [dsh-providers-hub](https://github.com/iJetLi/dsh-providers-hub) 引擎里 **marvis 车道 + 共享基建** 原样保留，其余 28 家供应商、控制台、页面与相关脚本全部移除。

## 它做什么

- magpie 供应商列表里出现一张「腾讯 Marvis」卡片，模型为 `main-auto`（上游无目录端点，服务端自动路由）。
- 「接已有账号」：直接复用 DSH 侧登录过的 Marvis 账号（凭据与 DSH 的 `.credentials.yaml` 互通，双向可用）。
- 「在浏览器里新建账号」：起一次浏览器授权登录，登录完成自动接入。
- 用量卡显示钱包余额（`/v3/marvis_get_wallet`，字符串数字）；请求级 429 / 额度耗尽自动换号 + 冷却。

## 架构（继承自上游，未改语义）

```
magpie 网关
  └─ provider jet-hub-marvis
       └─ auth.loader().fetch → JetHubContainer（src/container.mjs）
            ├─ 内嵌 cordis 容器 + vendor/lib/index.js（裁剪后的本体引擎）
            ├─ 账号池 / 静默续期 / 临期折算 / 聚合与 auto 路由组（进程内）
            └─ ctx.llm.stream() 进程内直连（src/llm-bridge.mjs，无本地端口）
```

- **凭据**：`FileCredentialProvider` 桥接 `~/.dsh/.credentials.yaml` 的 `refs:` 段；DSH 里登录过的账号在 magpie 里立即可用，反之亦然。
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
magpie plugin add cycocyco/magpie-Jet-Hub
```

或在 magpie 插件设置里填 GitHub 简写。前置条件：机器上有 DSH（或曾在 magpie 里登录过 Marvis）。

## 开发

```bash
npm install
npm test          # 离线单测
npm run seed:auth # 把 DSH 凭据摊平进 magpie 的 plugin-auth.json
npm run gen:prices # 从 magpie 缓存的 models.dev 目录重生成参考价表
```

## License

MIT（继承上游；`vendor/` 部分归 upstream 仓库所有，商标归腾讯）。
