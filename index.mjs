/**
 * magpie 插件入口 —— 每个本体 provider 一个插件工厂。
 *
 * ⚠️⚠️ **只导出插件工厂，绝不导出工具函数/常量对象**（2026-10-27 实测真缺陷）。
 *
 * magpie 宿主加载插件时会**遍历模块的全部导出**并探测性调用 —— 只要有一个
 * 导出不是「插件工厂」形状，就会被无参调用后抛错，**整个插件加载失败**
 * （`plugin list` 报 failed）。
 *
 * ## 本 fork 的裁剪说明
 *
 * 原版为 29 家供应商各导出一个工厂；本 fork 只保留**腾讯 Marvis** 一家。
 * `aggregate`（聚合路由）与 `jet-hub-auto`（自动选号）两个路由组没有自己的
 * 账号池与模型目录，从不注册成 magpie provider。
 */
import { PLUGINS, PROVIDER_IDS } from './src/plugin.mjs'

const byId = new Map(PLUGINS)

/** 少一个 id 就是导出契约漏了 —— 加载即抛，别让它静默少一个 provider。 */
for (const id of PROVIDER_IDS) {
  if (typeof byId.get(id) !== 'function') throw new Error(`magpie-marvis-lane: 缺少 provider 工厂 ${id}`)
}

/** 本体 `marvis`（magpie id `jet-hub-marvis`，腾讯 Marvis）。 */
export const JetHubMarvisPlugin = byId.get('jet-hub-marvis')
