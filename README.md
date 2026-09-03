# dsh-jdpatterns · 设计模式参考库（v3 重建）

静态自研 DSH 插件：把本地设计模式参考仓库（java-design-patterns 等）接入 DSH——
目录检索、模块阅读（README+全源码含测试）、git ff-only 更新，并在执行层以硬闸门
强制「写 .java 前先查模式库」。

## 组件

- `lib/index.js`（host 半）：inject `["systemPrompt","tools","webServer","fs"]`
  - 工具 `jdpatterns_catalog` / `jdpatterns_read` / `jdpatterns_update`（均带 `language` 参数，默认 java）
  - 系统提示节（order 118）：动态列出全部已配置语言 + 硬闸门规则
  - HTTP 路由 `/api/jdpatterns/{config,status,pull,gate}`
  - v3 硬闸门：`tools/pre-execute` 拦截参考仓库外的 `.java` write/edit（deny + 行动指令）；
    `tools/post-execute` 记录 catalog/read 成功后按 `exec.agent.id` 放行。
    旁路：参考仓库内写入、闸门关闭、无 agent 上下文；闸门自身异常一律 fail-open。
- `lib/client.js`（client 半）：`__ModuleLoader__.load` 自注册；设置 →「设计模式参考库」页：
  硬闸门开关（顶部）、语言二级标签 + `+` 新建自定义语言（`^[a-z][a-z0-9-]*$`，java 内置不可删）、
  每语言三可配项（开源地址/本地地址/索引文件）、仓库状态卡 + 拉取更新。
- `config.json`：自管 JSON `{gateEnabled, languages:{<lang>:{remoteUrl,localPath,indexFile}}}`，
  不依赖 settings 服务（避免热重载竞态）。

## 安装

用 `install-jdpatterns.ps1`（脱离宿主执行）：给 web profile 的 package.json 加
`link:` 依赖与 bundles 行，再 `pnpm install --prefer-offline`，最后走静默闸门重启宿主。

## 历史

2026-08-31 首建（v1 动态版崩溃 → v2 静态多语言 → v3 硬闸门）；2026-09-02 源码丢失后按
mnemon 文档 dsh-jdpatterns-v2-f764c2bc.md + 开发范式记忆完整重建。
