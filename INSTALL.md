# 安装

## 前置要求

| 项 | 要求 |
|---|---|
| DSH | 桌面端，实测 **0.2.1-rc.5** |
| 会话格式 | v4（`session.v4.jsonl.zstd`）|
| Node | 仅独立 CLI 需要（DSH 自带运行时）|

## 方式一：命令行

```bash
dsh plugin --profile desktop add dsh-session-merge
```

profile 按你在用的界面填：`dsh web` → `web`，桌面应用（Electron）→ `desktop`。

## 方式二：图形化

打开 DSH 的「插件管理」页，在安装框里填 `dsh-session-merge`，回车。

## 方式三：源码（开发用）

```bash
git clone https://github.com/HCQM/dsh-session-merge.git
# 放到 <DSH_HOME>/plugins/ 下，然后在 profile 的 bundles 里登记
```

登记（bundle 型插件不登记就不会加载）：

```yaml
# profiles/desktop/cordis.patch.yml 或 profile 配置
bundles:
  - dsh-session-merge
```

## 重启

装完或改完**重启 DSH**。

> ⚠️ **插件没有可靠热载**：改 `index.js`、改 `cordis.patch.yml` 都不会触发重载，那些 `apply` 日志全是重启时发生的。

## 验证安装

重启后，让 Agent 调一次只读操作：

```js
session_merge_build({ inspect: true, targetId: "<任意会话id>" })
```

能返回事件数/turn/surface 就说明装好了。想同时验证官方校验：

```js
session_merge_build({ inspect: true, verify: true, targetId: "<任意会话id>" })
```

返回里 `verify.ok: true` 表示 DSH 自己也能打开这个会话。

## 独立 CLI（可选）

```bash
node bin/validate.mjs <会话id前缀|目录|文件> [--json] [--no-replay] [--strict-replay]
node bin/validate.mjs --all
```

> 深度校验依赖 `@deepseek-ai/dsh-*`。在 DSH 进程外跑，若解析不到会自动降级（只查帧/路径/seq），输出里会标 `degraded`。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-session-merge
```

或从 `bundles` 里删掉登记再重启。
