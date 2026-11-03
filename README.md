# dsh-usage-summary

[English](README.en.md) | 简体中文

DeepSeek Harness Web 的**用量汇总**小组件：输入框下方状态栏（`conversation.composer.dock`，
`order: -10`）里一颗紧凑胶囊，排在「N 轮 M 步 · tok/s」统计胶囊**左侧**；点击**向上**弹出明细面板。

面板内容**跟随当前会话正在使用的渠道**自动切换：

## 两种模式

| 当前会话渠道 | 胶囊 | 面板标题 | 面板内容 |
| --- | --- | --- | --- |
| DeepSeek 官方（`deepseek-official` / `deepseek-account`） | `● DS ¥128.40` | **DeepSeek 官方余额** | 只显示官方数据：本会话官方 token（未命中输入 / 缓存命中 / 输出）、按时段计费的估算金额、账户余额。不显示 Go 套餐 |
| OpenCode Go（其他情况） | `● Go 5h 12% · 周 8% · 月 46%` | **OpenCode Go 用量汇总** | 顶部新增「本会话」行（**只统计 Go 渠道**的 token 总量与调用次数），下面仍是套餐三窗口（5 小时 / 周 / 月）进度条与重置时间 |

```text
# DeepSeek 官方渠道
● DeepSeek 官方余额  [账号]  deepseek-flash · 5 次        ↻  ×
输入(未命中)                                          12.3K
缓存命中                                              48.0K
输出                                                   1.2K
花费(估算)                                          ¥0.0181
余额                                               ¥128.40

# OpenCode Go 渠道
● OpenCode Go 用量汇总                                   ↻  ×
本会话                                  21.4K tok · 9 次
5 小时  ████░░░░░░░░░░░░  12%      重置 16:30
本周    ███░░░░░░░░░░░░░   8%      重置 11-08
本月    █████████░░░░░░░  46%      重置 11-07
```

既有行为：颜色 <60% 绿 / 60–85% 黄 / ≥85% 红；点胶囊切换面板、点外面或 `Esc` 收起；
60 秒自动刷新；`↻` 强制刷新；取数失败显示错误与重试。

## 颜色阈值（可在面板里改）

进度条/百分比/胶囊圆点用三档颜色：**绿 < 橙起点 ≤ 橙 < 红起点 ≤ 红**。默认阈值
**60 / 85**（打开面板后点标题栏的 **⚙** 可改）：

```text
● OpenCode Go 用量汇总        ↻ ⚙ ×
  ⬛ 0–60%   ⬛ 60–85%   ⬛ 85–100%
  橙色起点 (%)              [ 60 ]
  红色起点 (%)               [ 85 ]
  [恢复默认] [取消] [保存]
  只影响本浏览器的显示，保存在 localStorage。
```

- 两个切分点定义三个区间，输入需满足 `1 ≤ 橙色起点 < 红色起点 ≤ 100`，否则拒绝保存并提示。
- 保存后**立即生效**（胶囊百分比文字、进度条填充色、圆点颜色同时更新），写入
  `localStorage`（键 `dsh-usage-summary:thresholds`），刷新页面保留、无需重启。
- 胶囊圆点取三个窗口里**最高**的百分比来判定，所以"本月到 60%"会让圆点整体变色。
- DeepSeek 官方模式的颜色按**金额**判定（余额 < ¥10 橙、< ¥1 红），不受此设置影响。

## 历史会话与后台索引

宿主内存里只保留"当前进程打开过"的会话，所以历史会话要另找来源。插件通过
`ctx.sessionPersistence` 读取持久化日志，并在后台做一次静默全量索引：

- **启动即扫描**：`sessionPersistence.list()` 枚举全部已存会话，按**最近活动时间倒序**
  （日志文件 mtime，回退到 header 的 createdAt），用一个后台队列逐个折叠；
  一次只处理一个，会话之间默认停 120ms，不抢宿主资源。
- **按需优先**：面板打开时若该会话还没排到，`本会话` 显示 **统计中…**，客户端在面板
  打开期间每 2 秒快速轮询，索引完成后自动变成数字。
- **刷新 = 高优**：点面板里的 `↻` 会把当前会话**插到队列最前面**并等待结果
  （`indexTimeoutMs`，默认 8s），通常几十毫秒就返回，不用等整队跑完。
- **只建一次**：索引存在内存里，重启后重建；每 5 分钟按 `revision` 复查一次已存日志，
  有变化才重折叠。已打开的会话永远走同步路径（内存日志最新，不必等索引）。
- 索引静默运行：不写日志、不发通知、不占用会话。

## 数据来源

| 端点 | 用途 |
| --- | --- |
| `GET /usage-summary/v1/plan` | OpenCode Go 套餐用量（host 轮询上游 `https://opencode.ai/inference/go/v1/usage`，60s 缓存） |
| `GET /usage-summary/v1/session?session=<id>` | 当前会话汇总：路由判定 + 官方/Go 两套本地统计 + 余额；未索引的历史会话返回 `pending:true`，`&refresh=1` 触发高优先折叠 |

- **用量统计纯本地**：host 折叠会话持久日志（`request/header` 判定路由，`assistant/message`
  的 `source.provider` + `usage` 记账），零额外推理调用。token 数是提供方上报的精确值。
- **余额**：优先取与认证方式匹配的来源 —— API-key 路由走官方 `/user/balance`，
  账号路由走 DSH 账号服务的平台钱包（`deepseekAccount.getBalance`），失败自动回退另一来源
  （60s 缓存，余额 <¥1 标红）。
- **金额是估算**：按官方 CNY 价目表（2026-10-17）逐次按时段计费。

### DeepSeek 官方计价（CNY / 1M tokens）

| 模型 | 缓存命中（峰/闲） | 缓存未命中（峰/闲） | 输出（峰/闲） |
| --- | --- | --- | --- |
| `deepseek-flash` | ¥0.04 / ¥0.02 | ¥2 / ¥1 | ¥8 / ¥4 |
| `deepseek-v4-pro` | ¥0.30 / ¥0.15 | ¥9 / ¥4.5 | ¥27 / ¥13.5 |

高峰 = **北京时间** 周一至周五 09:00–12:00、14:00–18:00；法定节假日未建模 → 金额为估算。

## 以后新增渠道？

**可以，但不是自动的。** 设置页里的"渠道"只是 DSH 的 provider 路由；插件要接入一个渠道，
还需要知道它的两样东西：

1. **怎么统计用量** —— 任意渠道都能用当前机制：按 provider id 从会话日志累计 token（配置里列 id 即可）；
2. **有没有余额/套餐来源** —— 有官方接口就加一个取数适配（像 DeepSeek 的 `/user/balance`、
   OpenCode Go 的 `/usage`）；没有就只能显示本地 token 与花费估算。

所以扩展路径是：把 `goProviders` / `deepseekProviders` 这类 provider 集合改成你要统计的渠道 id，
余额部分加一个 fetch 适配与缓存。目前插件内置 Go 与 DeepSeek 官方两个渠道组。

## 安装

```sh
dsh plugin --profile web add link:/绝对/无空格/路径/dsh-usage-summary
```

从压缩包安装同样可行（`dsh-usage-summary-0.5.0.tgz` 已按 npm 打包规范生成）：

```sh
dsh plugin --profile web add /绝对路径/dsh-usage-summary-0.5.0.tgz
```

首次安装 / **升级 host 半边需要重启 `dsh web`**；只改 `lib/client.js` 时刷新页面即可。

> 插件不内置任何密钥：OpenCode Go 的 key 与 DeepSeek 的 key 都由宿主 credentials 服务解析
> （默认引用 `OPENCODE_GO_API_KEY` / `DEEPSEEK_API_KEY`，可在配置里改）。

## 配置（可选，写在 profile 的 `cordis.patch.yml`，按 id 覆盖）

```yaml
- id: usage-summary
  config:
    # OpenCode Go（套餐）
    apiBase: https://opencode.ai/inference/go/v1
    apiKeyEnv: OPENCODE_GO_API_KEY
    apiPath: /usage-summary/v1
    refreshMs: 60000
    timeoutMs: 15000
    goProviders: [opencode-go]            # 计入"本会话"用量的 provider
    # DeepSeek 官方
    deepseekApiBase: https://api.deepseek.com
    deepseekKeyEnv: DEEPSEEK_API_KEY
    deepseekProviders: [deepseek-official, deepseek-account]
    deepseekAccountVersion: 1.0.0         # 平台钱包请求的 x-client-version（默认取宿主版本）
    balanceRefreshMs: 60000
    # 历史会话后台索引
    indexDelayMs: 120            # 会话之间的让出间隔
    indexRescanMs: 300000        # 复查已存日志 revision 的周期（5 分钟）
    indexTimeoutMs: 8000         # 刷新时高优先折叠的最长等待
    # 颜色阈值在浮窗 ⚙ 里设置（localStorage），不在服务端配置里
    deepseekPrices:
      deepseek-flash:
        peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 }
        offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 }
      deepseek-v4-pro:
        peak: { cacheHit: 0.30, cacheMiss: 9, output: 27 }
        offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }
```

## 工作原理

- **Host 半边**：`inject: [webServer, credentials, sessions]`。
  - `/plan`：按 `refreshMs` 缓存并去重上游请求；
  - `/session`：`ctx.sessions.get(id)` 取会话 → 折叠持久事件日志（单遍同时算官方与 Go 两套账）
    → 按最新 `request/header` 判定 `mode`：官方渠道返回 `{ mode:'deepseek', auth, deepseek:{...}, go }`，
    否则返回 `{ mode:'go', go:{calls,tokens} }`。结果按会话日志游标做 2s 微缓存。
  - 密钥一律经 `ctx.credentials.resolve(ref)` 解析，不落盘、不进日志。
- **Client 半边**：注册进 `conversation.composer.dock`（`order: -10`），从 slot 的 session 标准 props
  取 `sessionId`；`/plan` 与 `/session` 各按 60s 轮询，胶囊与面板都按 `mode` 渲染。
  面板用 `createPortal` + `position: fixed` 锚定胶囊上方。

## 已知限制

- 会话日志读取用 `Session.snapshotEvents()`（deprecated 但仍可用）；未来移除时官方区块会
  显示取数失败，Go 套餐部分不受影响。
- 金额为估算（节假日未建模、Search/Fetch 按次费用不计）。
- 只统计成功上报 usage 的 `assistant/message`；失败尝试不计。
- `deepseek-account` 余额需要账号插件已挂载且登录；否则回退 API-key 余额，两者都失败显示"取数失败"。
- 历史会话依赖 `sessionPersistence` 服务；缺失时这些会话只能显示"取数失败"。
- 首次启动会在后台把历史日志读一遍（静默、限速），会话很多时需要几秒才能全部索引完。

## 卸载

```sh
dsh plugin --profile web remove dsh-usage-summary
```
