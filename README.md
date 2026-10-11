# dsh-model-select

兼容层插件：对外伪装成 OpenAI 兼容的 `/v1/chat/completions`，用 `select()` 在候选通道上做可用性过滤与失败回退。

**主干是路由，不是聊天**。一次请求进来先判断意图：

```
请求 → 路由
  ├─ 大部分（有 decision 字段）
  │     JEV 挑出合适的操作（route/score/classify，原生 /v1/decide，不出自由文本）
  │     → 找到声称该操作的执行单元（dispatch 通道）→ send session 执行
  └─ 少数无法处理 → 降级到生成型 LLM
        兜底 LLM 必带【预设 · 行为纪律】+【近况说明 · 当前状态】，防遗忘
```

「无法处理」包括：路由器拨不通、裁决没点出任何操作对应的执行单元、执行单元拒收、执行单元回空。这几种一律走同一个 fallback 循环降级到 chat 通道——降级不是特殊路径。

**定位（2026-10-08 JEV 调查结论）**：JEV（TypeSafe AI "System One Model"）的语义是**选择/结构化决定**——route/score/classify，原生端点 `/v1/decide`，不出自由文本。本地 `jev-1.13-free` 是死档（404）。所以 JEV 在这套里的角色是**路由器**，不是答题人。

动机见 KB 节点 `notes/proj-model-select-compat-layer-2026-10-08.md`（/mnt/e/knowledge-base）：接了真正模型之后 agent 会不爱继续、不遵从指令、遗忘——**结论是不能依赖模型自觉**，可靠行为由固化骨架保证。

## 目录结构

```
dsh-model-select/
├── index.js               # 插件入口：createModelSelect() / apply(ctx,config) / 独立 CLI
├── cordis.patch.yml       # 一行 insert，DSH profile 接入位（本步刻意留空）
├── package.json           # 零依赖，node:test 跑测试
├── config/
│   └── channels.json      # 通道表：channels / pools / defaults（含 defaults.preset）
├── src/
│   ├── errors.js          # 失败码表 + SelectError，retryable 在构造时定死
│   ├── channels.js        # 通道表加载/校验 + ${VAR} 展开 + /v1/models 行源
│   ├── availability.js    # 内存可用性缓存，60s TTL，过期即回
│   ├── intent.js          # decision 字段 → decide / chat 两种意图
│   ├── spec.js            # model 字段 → 有序候选列表（解析/池/扇出/按意图排序）
│   ├── context.js         # 预设 + 近况说明 → system 消息（防遗忘那层）
│   ├── operations.js      # 裁决 → 操作 → 执行单元注册表 + send session 体
│   ├── stream.js          # inspectContent + SSE peek/replay（空答案判定）
│   ├── select.js          # 核心 fallback 循环（语义两次重构都未动）
│   ├── upstream.js        # 真实 dispatch：chat 透传 / decide 投射回 chat 信封 / session 体
│   ├── routing.js         # 一次完整回合：组稿 → 解析 → 选号 → fallback → 裁决派发 → 降级
│   ├── selection.js       # 数字键 choice/selection：1-based 锁定候选，越界报错带菜单
│   ├── loop.js            # 巡逻：巡检 → 去重 → 派发执行单元，重叠防护 + 审计记录
│   ├── adapter.js         # dsh-llm LlmAdapter 七方法，provider 注册位
│   └── forward.js         # OpenAI 兼容 HTTP 端点 + 路由主路径
└── test/                  # node --test，258 例，全离线（loopback + 假 dispatch + 假时钟）
```

## 三种通道类型

| type | 端点 | 回答什么 | 能不能进 fallback 顺序 |
|---|---|---|---|
| `chat` | `chat/completions` | 自由文本（生成型） | 能，垫底 |
| `decide` | `v1/decide` | 结构化裁决：route/score/classify，无自由文本（JEV 一类） | 能，decide 意图下排最前 |
| `dispatch` | `chat/completions` | 执行一个操作（send session） | **不能** |

`dispatch` 是**目的地**，不是候选：

- 只有两种到达方式——调用方**显式指名**它，或**路由裁决点中**它。
- 池里永远不收 dispatch（写进池会加载即报配置错），裸模型名扇出也不命中。
- 一个执行单元声称它执行的 `operations`；一个操作只归属**第一个**声称它的通道，所以配置无法把一件事悄悄派给两个会话。
- 缺省 `path` 复用 `chat/completions`（执行单元也是模型，走标准端点），但请求体是 session 形态，不是对话续写。

## 选择语义（`decision` 字段）

主接口仍是 `/v1/chat/completions`。调用方在请求体里多带一个 `decision` 字段，就完成了全部协商：

```jsonc
{
  "model": "__pool__:fast-free",
  "messages": [ ... ],
  "task":     "合并 PR 12",            // 可选：执行单元实际跑的东西
  "decision": {
    "options":  ["merge", "audit", "idle"],     // 要选的东西（必填，非空数组）
    "criteria": "cheapest safe thing",          // 自然语言的判据（可选）
    "task":     "pick the next action",         // 可选
    "top_k":    1                               // 可选
  }
}
```

- 裁决**被投射回 chat 信封**：选中的东西以 JSON 编码作为 assistant 的 `content`，同时挂在响应的 `decision` 字段上。只说 OpenAI 协议的调用方也能读。
- decide 通道收到的是 `{model, options, criteria, task, top_k, context}`——`messages` 折进 `context`，因为路由器不续写对话，它只选东西。
- decide 只取一个裁决、不流式：调用方开了 `stream: true` 也按 JSON 拿裁决，然后**合成 SSE 帧**下发。
- `decision.options` 缺失或空 → **400**，不静默改成生成请求：请求说了「选」，答案就必须是「选」。
- 裁决里除信封字段（`id/object/created/model/usage/...`）之外的键都算裁决内容；一个裁决都没有等于空答案，按 EMPTY 走 fallback。
- decide 通道可用 `decideBody` 追加/改写字段，适配不认这套拼法的上游。

### 裁决 → 操作 → send session

裁决里能读出操作名，就不「回答」了，改成「交接」。操作名从这些键里按序找：`choice` / `selection` / `action` / `operation` / `op` / `route` / `selected` / `top` / `choices` / `scores`；嵌套对象再看 `action` / `operation` / `op` / `route` / `name` / `id`。也认一栏置信度图 `{ "merge": 0.91 }`（值必须是数字，避免把 `reason` / `usage` 这种信封字段误读成操作）。

三种结局：

| 裁决 | 结果 |
|---|---|
| 点出操作，且有执行单元声称它 | **交接**：send session 给那个执行单元，返回它的回答 + `decision` + `dispatch` 字段 |
| 点出操作，但没人声称 | **降级**：chat 尾巴接管这一轮，裁决作为 `decision` 留在 body 里当理由 |
| 没点出任何操作 | **裁决就是答案**：原样返回，不降级（调用方问的是「选哪个」，不是「做点什么」） |

执行单元收到的请求体（`src/operations.js` 的 `sessionRequest`）：

```jsonc
{
  "model":   "deepseek-v4.1-flash",          // 执行单元的 defaultModel
  "session": "merge-runner",                 // 执行单元的会话 id，缺省等于通道名
  "messages": [ {"role":"user","content":"合并 PR 12"} ],   // taskFrom(request) 的结果
  "context":  [ ...调用方的 messages... ],  // 含预设/近况那层 system 消息
  // ...执行单元表里的 dispatchBody 覆盖项...
  "temperature": 0.2                          // temperature / label 跟着工作走
}
```

`task` 的来源顺序：请求体 `task` → `decision.task` → **最后一条 user 消息** → 都没有就 400（`CODE.config`，「there is no task to dispatch」）。执行单元回空也算没做事，同样降级。

交接响应额外带三个 header：`x-select-routed: true`、`x-select-operation`、`x-select-channel-type: dispatch`。降级带 `x-select-operation` + `x-select-degraded`（`no_executor` / 失败码）。

### 预设 + 近况说明

兜底 LLM 每次都要带上这两样，在**候选解析之前**折进 `messages` 首条 system 消息（已有 system 消息就追加进去，不叠两条）。decide 和 chat 看到的是同一份上下文，路由器不会因为话少而乱选。

```
【预设 · 行为纪律】
1. 有 merge 就 merge（合并能合并的，别为形式拆两次）
2. 有问题就处理（发现了问题先处理，别只记录）
3. 没事做就审计（空档用于盘点，不用于等待）
4. 知识要录入（新结论落到知识节点，不留在会话里）
5. 不确定就说「不确定」并说明缺什么（不要猜，别用形容词代替证据）

【近况说明 · 当前状态】
- 通道 kilo：down（30s，RATE_LIMIT）
- 通道 bunny：up
```

- 预设的解析顺序：请求体 `preset` → 通道表 `defaults.preset` → 内置 `DEFAULT_PRESET`。**永远非空**——没有纪律的生成请求不存在。`preset` 可以是一个字符串或字符串数组。
- 近况的解析顺序：请求体 `status` → **可用性缓存快照**。缓存是这层自己唯一掌握的状态，没有请求方状态就把它如实写成「通道 X：down（Ns，原因）/ up」；缓存空了就什么都不写，不编状态。
- `preset` / `status` 两个字段在发上游前删掉——它们已经投递了。
- 请求没有 messages 就仍然是无效请求，不会因为折了预设而变有效。

## model 字段的三种写法

```jsonc
{ "model": "kilo/deepseek-v4.1-flash,space-bunny-free", "messages": [...] }  // 候选列表，逗号分隔
{ "model": "__pool__:fast-free",             "messages": [...] }              // 池名，展开自通道表
{ "model": "sensenova-6.8-flash-lite",       "messages": [...] }              // 单模型：池内扇出
```

解析规则（`src/spec.js`）：

- `channel/model` 固定该通道的模型；`channel` 用其 `defaultModel`。
- 裸 token 先按通道名查，查不到再按模型名在所有通道里扇出（表内顺序）。
- 池可嵌套，最多 4 层；自引用（含间接）直接报错。
- `models` 列表只是发现提示，不是白名单——显式 pin 未列出的模型也会发出去，由上游自己的 4xx 结案。
- 同一 `channel/model` 去重，保序；被可用性缓存挡掉的候选直接跳过，全被挡才报错。
- **按意图排序**：decide 意图下，调用方没点到路由器会从 `defaults.decidePool` 补齐、没点到 chat 通道会从 `defaults.fallbackPool` 补齐——`{"model":"kilo","decision":{...}}` 也有地方可降级。各半内保持调用方给的顺序。
- **执行单元排在最前**：decide 意图下候选顺序是 `dispatch… → decide… → chat…`，生成意图下是 `dispatch… → chat…`。前者只对显式指名有效，池永远补不进来。
- **`disabled: true` 的通道是文档不是路由器**：池静默跳过、裸模型名扇出也不命中；显式指名报配置错。这是 JEV 这类「表里有、端点未知」的通道先落地当文档的方式。

## select() 核心

```
candidates → dispatch 第一个 → 429/超时/空 content/5xx/网络失败 → 下一个
                                → 400/401/403、调用方取消 → 立即停
                                → 成功 → 返回；全失败 → 返回最后一个错误
```

- **retryable 是构造时就定死的属性**（`errors.js` 里一张 `RETRYABLE` 集合），fallback 循环只做一次属性读取，不加新分支。
- 429/超时/空/网络/5xx 可重试；4xx、凭证拒绝、配置错误、调用方取消**不重试**——换个通道再发同样的坏请求只是把整个池的配额烧掉。
- 每个候选失败都记进 `attempts`，全失败时 `error` 是**最后**一个失败，完整轨迹同时在 `attempts` 里。
- 可重试失败写可用性缓存（60s），成功立即清掉该通道的 down 记录；60s 后死通道自己回来，不需要重启。
- 流式请求先 `peekSse` 确认有内容再回 200——只 thinking 就结束的流会被判空并重试下一个通道，调用方永远看不到空 200。peek 缓冲的字节原样回放。
- **降级不是特殊路径**：decide 挂了就轮到 chat，执行单元拒收也轮到 chat，用的还是同一个循环、同一个 retryable 判据、同一个超时和尝试上限。

## 数字键（`choice` / `selection`）

请求体里的 `choice` 或 `selection` 是一个 **1-based** 数字，直接锁定候选列表第 N 个，跳过 JEV/decide 和 fallback 走查。人工指定优先于路由器——调用方读过菜单了，这一层不再替它决定。

```jsonc
{ "model": "__pool__:fast-free", "messages": [...], "choice": 2 }
```

- 1-based：`choice: 1` 是第一个候选。`0`、负数、小数、`true`、`{}` 一律报 400，**不做隐式转换**——想选第一个却写 `1.0` 的人应该被告知，而不是被静默路由到另一个通道。
- 数字或纯数字字符串都行（表单来的 JSON 常不带类型）。
- 越界报 400，**错误信息里带完整菜单**：`"choice 4 is out of range: 3 candidates in order (kilo/kilo-flash,bunny/bunny-free,sense/sense-lite)"`。这是电话菜单的服务端形态——报菜名，不只报错号。
- `choice` 和 `selection` 同时给且值不同 → 400；值相同 → 忽略冗余。
- 锁定即**真的只走一个**：`maxAttempts` 被截到 1，该通道拒收就返回拒收，不会偷偷试下一个。这是「跳过 fallback」的含义，不是「fallback 顺序改了」。
- 落在路由器上仍然走裁决：`choice: 1` 点到 JEV，裁决照样派发给执行单元。
- 两个门一样：HTTP 端点和 provider adapter 都透传这两个字段（`src/adapter.js` 的 tail 字段清单）。
- 响应头回显：`x-select-choice: 2/3`（选的第几个 / 菜单共几个）、`x-select-menu: <完整菜单>`；`x-select-candidates` 仍是**实际走过的**列表，选了就只剩一个。

位置：`src/selection.js`。解析在解析候选**之后**、`select` 之前——`resolveCandidates` 保持纯函数，只看表和缓存，不知道调用方在菜单里填了什么。`routeTurn` 的返回值同时给 `menu`（解析出的完整列表）和 `candidates`（实际走过的），两者一致说明没人挑，不一致就是人工指定过。

## 巡逻（无人值守定时分发）

`defaults.loopMs` 是巡逻间隔。到点巡检待办（merge 就绪的 PR / 会话卡死 / 账本结算 / 知识落库），按 `operation` 派给声称它的 `dispatch` 执行单元。

```jsonc
{ "defaults": { "loopMs": 60000 } }     // 每 60s 巡逻一次
```

`0`（默认）就是关。这一层不该因为配置文件里写了个数字就开始自己拨号执行器。

- **巡检逻辑不在这层**。插件暴露 `api.loop(inspect)` 和 `apply()` 的 `config.inspect` 参数，谁来报待办谁实现——这一层没有 git remote、没有会话索引、没有账本，编不出真待办。出厂的 `idleInspector()` 返回空数组。
- 待办形状：`{ operation, task, key?, label?, status? }`。字段名宽松，`task`/`message`/`content`/`brief` 都行，`operation`/`op`/`route`/`session`/`target` 都行。缺 operation 或缺 task 是跳过并记录原因，不是抛错。
- **派发用的是裁决那条路的同一个 `sessionRequest`**，所以执行单元分不清这两条路；也走同一次 `applyContext`，纪律预设和近况说明一个都不少。
- **按 `key` 去重**：成功静默 `suppressMs`（默认 10 个周期），失败静默 `retryAfterMs`（默认 1 个周期）。同一个 PR 不会因为定时器每秒响一次就被合并十次。
- **同时只跑一趟**：上一趟还没拨完，下一趟直接丢弃并记日志，不进队列——慢执行器拖长周期，而不是堆一堆同样的活。
- **一趟里串行派发**：执行单元是会话，一次塞两个任务是哪个都做不好。
- 一趟永不上抛：巡检抛错、执行单元拒收、空答复，都记进审计记录返回，定时器链不断。`tick()` 返回 `{ok, dispatched, deduped, skipped, failed, elapsedMs}`。
- **与 DSH schedule 的关系**：插件自跑自己的钟，同时暴露 `tick()` 给外部调度器（DSH schedule / cron / 按钮）驱动一次。两者同时存在也不重复派发，靠的是同一个去重表。`stop()` 幂等，`dispose()` 会调它。

位置：`src/loop.js`。

## 通道表

`config/channels.json`，`channels` / `defaults` / `pools` 三个字段支持 `${VAR}` 和 `${VAR:-default}` 环境变量展开（展开只作用在这三个字段，文档散文里的 `${VAR}` 示例不会被误展开）。

- 变量**已设置**时优先用它的值（包括空串）；**未设置**才回落默认值并记 warning。
- 通道名/池名只允许 `[A-Za-z0-9._-]`，避免解析歧义。
- 一个通道没有模型是**配置错误**，加载即失败——宁可在启动时报，也不在第一个请求上炸。
- `type` 缺省 `chat`；`decide` 的 `path` 缺省 `v1/decide`；`dispatch` 的 `path` 缺省 `chat/completions`。
- **dispatch 通道必须至少声称一个操作**，否则加载即报配置错。声称一个没人读的操作没意义。
- **池列出执行单元是配置错误**，加载即报（`an execution unit is a destination, not a fallback candidate`）。
- `defaults.decidePool` / `defaults.fallbackPool` 必须指向存在的池；指到不存在就是静默死路。
- `defaults.preset` 接受字符串或字符串数组，其他类型报配置错——一份静默不生效的纪律不是纪律。
- `defaults.loopMs` 是巡逻间隔，非负整数，`0` 表示关闭（见「巡逻」一节）。
- 执行单元共用 `MODEL_SELECT_EXECUTOR_BASE`（缺省 `http://127.0.0.1:8788/v1`）和 `MODEL_SELECT_EXECUTOR_TOKEN`；未部署执行器网关前，任何一次派发都会 TRANSPORT 失败并降级到 chat 尾巴。

## 端点

| 路径 | 说明 |
|---|---|
| `POST /v1/chat/completions` | 兼容端点；`model` 支持上面三种写法，`decision` 切到路由 |
| `GET  /v1/models` | 通道表展开出的 `channel/model` 列表（含执行单元，不含 disabled） |
| `GET  /health` | 通道、**类型**、**操作 → 执行单元映射**、disabled 名单、池、模型数、当前可用性判定 |

响应回显实际选中通道：body 里 `model` 改写为 `channel/model`，加上

- 基础：`x-selected-channel` / `x-selected-model` / `x-select-retries` / `x-select-candidates` / `x-select-elapsed-ms` / `x-select-intent` / `x-select-channel-type`
- 交接：`x-select-routed: true` / `x-select-operation`
- 降级：`x-select-operation` / `x-select-degraded`

`x-select-candidates` 里 decide 候选带 `!` 前缀、dispatch 候选带 `@` 前缀。
全部候选失败回 503 + `code: all_channels_failed`，带完整 `attempts`。
可选 `--key` 加 Bearer / `x-api-key` 鉴权，`/health` 不鉴权。

## 本地跑

```sh
node index.js --serve --port 8787          # 独立跑，不接 DSH
node index.js --serve --key sk-xxx          # 加鉴权
node index.js --help                        # 字段与语义速查
curl -s localhost:8787/v1/chat/completions -d '{"model":"__pool__:fast-free","messages":[{"role":"user","content":"hi"}]}'
```

```sh
npm test               # 或 node --test test/*.test.js
npm run test:select    # select 单测
npm run test:handler   # handler 冒烟（loopback 真起 http 服务器）
npm run test:decide    # decide / 降级路径
npm run test:operations# 路由交接 + 预设/近况
npm run test:config    # 通道表
```

测试全部离线：`dispatch` 注入脚本化 stub，端到端组用 `node:http` 起 loopback 假上游 + 一个不走近程代理的 `fetch` 实现，不依赖外网、不依赖任何 token。

## 边界（本步刻意没做）

数字键的**服务端形态**和巡逻的**调度机制**都在这步落地了，剩的是接真实状态源：

- **巡逻没有真实巡检器**：`idleInspector()` 报空。git merge 就绪判断、会话卡死检测、账本结算、知识落库这四件事各自的判断逻辑属于状态拥有者，得由 `config.inspect` 注入。
- **数字键没有 UI**：1/2/3 现在是请求体字段。DSH 核心没有数字键监听（红线，不改），插件内做不出浏览器输入框，所以这里只保证服务端形态。


- **不接 DSH profile**：`cordis.patch.yml` 只留一行 insert。DSH 侧的端口、鉴权、池与工作选项 UI 是下一步部署的事。
- **执行单元是骨架，不是真的会话系统**：`dispatch` 通道只是「一个带 session id 的模型端点」。真正的 send session（会话状态持久化、任务队列、结果回写）要接执行器网关，本步只在 `dispatchBody` 里留了覆盖位。
- **JEV 本地 `jev-1.13-free` 是死档（404）**：`config/channels.json` 里 `jev` 是 `disabled: true`，挂在表里当文档，不被池收录也不被扇出命中。指向真实 `/v1/decide` 端点并去掉 `disabled` 即可启用——路由一旦可用，`__pool__:decide` 会把它排在 chat 前面。
- **四个执行单元（merge/triage/audit/ingest-runner）等网关**：表里已声明并声称操作，但 `MODEL_SELECT_EXECUTOR_BASE` 指向的地址未部署。当前它们会被正常解析、正常派发、然后 TRANSPORT 降级到 chat 尾巴。
- **space-bunny / sensenova 的 base URL 未经核实**：先用 `MODEL_SELECT_SPACE_BUNNY_BASE` 之类的环境变量指向真实地址，别猜。
- `config/channels.json` 目前硬编码在仓库里；DSH 部署步要把它挪到用户可编辑的位置，并让 `/v1/models` 跟着变。
