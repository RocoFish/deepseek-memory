# deepseek-memory

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**长期记忆**
插件，以可安装的社区 bundle 形式交付。

这里的"记忆"是**少而精的沉淀**，不是对话记录索引：库里只存有限条关于用户和项目的
短事实，并且**整库注入每一次请求**。正是这个"有界"消掉了检索问题——不需要 embedding
服务、不需要排序、也不会在会话历史里留下陈旧快照。

## 功能

| 部件 | 行为 |
| --- | --- |
| **两层记忆** | `user`（`$DSH_HOME/memory/`）记"这个人是谁"；`project`（`<cwd>/.dsh-memory/`）记这个仓库的约定与决策。 |
| **工具** | `memory_add`、`memory_update`、`memory_delete`、`memory_list`、`memory_search`、`memory_status`。 |
| **注入** | 一个 `systemPrompt` 区段，其 `text` 是**每次装配时求值的 provider**。不往会话历史里写任何东西。 |
| **轮末整理** | 由一个**受限 child agent** 只通过记忆工具审阅刚结束的那一轮。 |
| **明文存储** | 库是可读 JSON，可手改、可 git diff；每次改动保留上一版。 |

## 安装

```sh
dsh plugin --profile <name> add deepseek-memory
```

从 git 源安装，同样是这一条命令：

```sh
dsh plugin --profile <name> add github:<you>/deepseek-memory
```

**没有构建步骤，也不需要你放行任何脚本**——因为本仓库**把编译产物 `lib/` 提交进了
版本控制**，所以从 git 装和从 npm 装拿到的东西完全一样。这是一个有意的取舍：把构建产物
放进版本控制并不常见，代价是维护者每次推送前要重新构建一次；换来的是每个使用者都不必先读
一遍 pnpm 的构建脚本报错、再手工编辑 `pnpm-workspace.yaml`。一个要给别人装的插件，安装
就得是一条命令。

`package.json` 里仍然声明了 `prepare` 脚本，但它是有条件的：只在 `lib/` 缺失时才编译，
否则立即退出——所以正常安装永远不会触发它，也永远不会要求放行。

装完重启该 profile。

### 社区收录

DSH 的社区插件索引就是 GitHub 主题
[`dsh-plugin`](https://github.com/topics/dsh-plugin)——"the `dsh-plugin` topic gathers
third-party plugins that extend it"。在仓库上设置这个主题即可出现在索引里；npm 的
`keywords` 里也列了 `dsh-plugin`，两条路都指向这里。

## 配置

每个键都能在 profile 的 `cordis.patch.yml` 里针对 `memory` 这一行覆盖：

```yaml
- id: memory
  config:
    maxEntries: 80
    consolidation: always
```

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `user` | `true` | 启用用户级记忆层。 |
| `project` | `true` | 启用项目级记忆层。 |
| `maxEntries` | `50` | 每层最大条数。 |
| `maxEntryChars` | `500` | 每条最大字符数。 |
| `injectChars` | `4000` | 单次请求注入的最大字符数。 |
| `tools` | `true` | 注册记忆工具。 |
| `consolidation` | `gated` | `off`、`gated` 或 `always`。 |
| `minTurnsBetweenRuns` | `1` | 同一会话两次整理之间的最小已结束轮数。 |
| `keepHistory` | `true` | 在 `history/` 里保留上一版。 |
| `consolidationSubagentProvider` | `in-process` | 整理 **child** 运行的 subagent provider 名。注意这是 provider **名**，不是模型路由。 |
| `consolidationRouteProvider` | — | **退化路径**的 provider 路由，仅在没挂 subagent provider 时使用；省略则复用会话自己记录的路由。 |
| `consolidationRouteModel` | — | 与上面配对使用的模型 id。 |
| `consolidationTimeoutMs` | `120000` | 单次整理运行的墙钟上限。 |

## 整理是怎么工作的

每一轮都花一次模型调用太浪费——绝大多数轮次里没有任何值得长期保留的东西。闸门是一段
**本地、确定性**的扫描，只认真正会改变长期记忆的情形：明确要求记住、纠正、长期偏好、
决策、约束。它**故意偏向漏触发**：漏掉的一次整理会被之后相关的一轮补上；而一个过度
积极的整理器最终会开始**编造记忆**。想要"每轮必整理"的字面行为，设
`consolidation: always`。

闸门放行后，整理以一个**受限 child agent** 运行：

- `toolFilter: { allow: [memory_*] }` 把其余所有工具从 child 的提示里**移除**，并在
  执行层**拒绝**——所以无论对话内容怎么诱导，它都读不到也写不了你的仓库；
- `persona` 给它一份"只管整理记忆"的职责说明，仅对这个 child 遮蔽部署 persona；
- `outputSchema` 让它返回一份结构化回执；
- 它**不继承父会话历史**，所以整理永远不会撑大主对话的上下文。

child 通过**本插件自己的工具**写记忆，所以每一条上限和每一条纠错文案照旧生效。这也正是
插件**不相信 child 自我报告**的原因：它比对运行前后的**库 revision**，把"声称改了但库
没动"当作失败。

当部署没有挂载 subagent provider 时，插件退化为一次直连模型请求 + JSON 改动集，由插件
逐条校验、限制单次条数、按层原子应用。child 路径严格更好；退化路径的存在是为了让没有
subagent 的部署也能整理。

## 存储格式

```json
{
  "format": 1,
  "tier": "project",
  "revision": 3,
  "updatedAt": 1790000000000,
  "entries": [
    {
      "id": "m1a2b3c4",
      "text": "构建用 tsc，不用打包器。",
      "tags": ["build"],
      "createdAt": 1789990000000,
      "updatedAt": 1790000000000,
      "origin": "consolidator"
    }
  ]
}
```

`id` 由文本派生，所以同一个事实重复添加是幂等的，改写也保留身份。`format` 比当前
构建新的文件会被**拒绝**而不是猜着读。

项目层是给**用户在自己的仓库里**提交用的；不想共享就往项目的 `.gitignore` 里加
`.dsh-memory/`。

## 设计说明

有三条约束塑造了这个实现，改动前值得先知道。

**1. 没有万能的 `plugin` 消息来源。** `MessageSourceMap` 是可合并扩展的联合类型，
每个生产者**在自己的模块里声明自己的 `kind`**。写 `{ kind: 'plugin', plugin: 'x' }`
——旧版本接受的形状，而且在 harness 自己的测试夹具里到处都是——在 0.2 下**通不过类型
检查**，且在执行运行时强制的版本上会在日志边界抛
`format v4 message requires a producer-owned source kind`。本插件在
[`src/source.ts`](src/source.ts) 里声明自己的 kind。而注入**刻意完全不用消息注入**：
`systemPrompt` 的 provider 不可能在历史里留下陈旧副本。

**2. 轮次边界是 `agent/status` → `idle`，不是 `agent/turn-stopping`。** 后者是
serial 且被 await 的监听器，在那里整理会给**每一轮**都加上模型延迟。`agent/status`
是 `emit`，所以记忆工作发生在轮次已经关闭之后，没有任何东西在等它。

### 两层记忆的位置从哪里来

**项目层**取自会话自己记录的目录：`session/event` 的载荷里带着 `header`，其中 `cwd` 是经过
校验的绝对路径，也是唯一永远正确的来源。它通过 getter 按需解析，所以宿主切换项目时不用重启
插件也会跟随，并丢弃过期缓存；`apply` 时不缓存任何东西。

两个实测事实让这是唯一站得住的选择。第一，`ctx.get('cwd')` 在任何试过的宿主上都不是服务
——即使服务已注入也返回 `undefined`，所以那行查找从一开始就是死代码。第二，`process.cwd()`
描述的是宿主**怎么被启动的**，不是**哪个项目打开着**：同一个打包应用，一次启动得到
`D:\WSL\DSH Workspace`，另一次得到它自己的 profile 目录。信任它会把项目记忆静默写进应用
自己的配置目录——在项目里看不见，在别处又具有误导性。

**用户层**按下面的顺序解析，实际用到的来源由 `memory_status` 报告：

| 顺序 | 来源 | 为什么 |
| --- | --- | --- |
| 1 | `DSH_HOME` | 直接命名 harness home |
| 2 | `DSH_PROFILE_DIR` 上溯两级 | 应用公布的是 `<home>/profiles/<name>`，home 在上两级 |
| 3 | `USERPROFILE` + `.dsh` | Windows 标准 home 加 harness 自己的目录名 |
| 4 | `HOMEDRIVE` + `HOMEPATH` + `.dsh` | 路径被拆开的 shell |
| 5 | `dshHome` 服务 | 以服务形式而不是环境变量公布的宿主 |
| — | 否则**禁用** | 绝不回退到工作目录 |

第 2–5 条存在的原因是桌面应用的宿主主进程不携带 `DSH_HOME`：从同一个应用里派生的沙箱
shell 有这个变量，而宿主自己的启动环境没有，于是工具在 GUI 里报告该层缺失。回退到工作目录
依然被拒绝——那会把长期个人事实散落到宿主恰好启动的目录里，包括插件自己的检出，从而可能
被提交进仓库。

两层遵循同一条原则：**定位不成立的层保持关闭，并明说**。`memory_status` 会显式报告被关闭
的层，而不是省略它——否则"这一层缺失"和"这一层是空的"在输出里完全一样。

**3. 插件在运行时是自包含的，所以 SDK 只是类型依赖。**
`defineTool`、参数 schema 编译、参数校验、`createUserMessage`、输出 schema 检查，全部在本包
内实现，而不是 import 进来。SDK 包仍然声明着——作为 `peerDependencies` 表达版本一致性、作为
`devDependencies` 供类型检查和等价比对测试使用——但 `lib/` 里没有任何一处 import 它们，这正是
profile 安装能工作的前提。详见下文"产物自包含"。

**4. `ctx.get` 只在 `apply` 时读一次。** 与其说是要绕开的约束，不如说是要记住的事实：解析器
只读一次服务，所以插件需要的每个服务都必须列进 `inject`，不可能之后再发现。

### 结构接口 + 编译期一致性校验

插件对自己通过 `ctx` 触及的服务（`SubagentConsolidator`、工具注册表形状）声明的是**窄结构
接口**，而不是 import SDK 的服务类。运行时依赖面因此是零：产物 `lib/*.js` 不含任何裸说明符，
由 `tests/packaging.test.ts` 静态与动态双重把关。

结构接口有可能和真实接口悄悄漂移，所以
[`src/typecheck.ts`](src/typecheck.ts) 断言已发布的 `SubagentRuntime` 满足插件的接口。
**这个校验已经抓出两个真实错误**：一处 `readonly ContentBlock[]`（SDK 要求可变数组），
一处 `outputSchema` 类型过宽导致不可赋值。

## 发布

本包就是一个普通 npm 包，只是多了个 `dsh.bundle.patch` 字段，所以发布流程是常规的：

```sh
npm run check          # typecheck + build + 测试
npm pack --dry-run     # 确认真实发布内容（58 个文件，无测试、无 node_modules）
npm publish            # publishConfig.access 已经是 "public"
```

首次发布前，把 `package.json` 里的占位仓库地址换成你自己的——GitHub 的"发布到 npm"
指引会读它，而已发布 manifest 里留着一串 `REPLACE-WITH-YOUR-USERNAME` 比不写仓库字段更糟。

然后把仓库的 GitHub 主题设为包含 **`dsh-plugin`**，即上文[社区收录](#社区收录)里描述的索引。
主题名和同名的 npm keyword 共同保证从两侧都能被发现。

有两个打包性质是承重的，而且很容易丢：

- **`lib/` 必须在 `files` 里。** 忘了它的 manifest 会发布一个"声明的入口文件不存在"的包。
- **`lib/` 必须被提交，而且是最新的。** 它已被纳入版本控制（见"安装"一节），所以一次忘了
  重新构建的推送，会把旧版插件发给所有从 git 安装的人。npm 那侧由 `prepublishOnly` 兜住；
  git 那侧得靠你自己：`npm run build && git add lib && git commit`。

第二点就是把构建产物纳入版本控制的真实代价，值得明说，而不是等发完版才发现。

## 开发

```sh
npm install
npm run typecheck    # 对着真 SDK 类型跑 tsc --noEmit
npm run build        # tsc -p tsconfig.build.json -> lib/
npm test             # node --test，每文件一个进程
npm run check        # 上面三个一起
```

`npm run test:sandbox` 在单进程里跑同一批用例。它存在有两个原因：受限沙箱会拒绝
`node --test` 需要的 `spawn`；以及已发布 SDK 的依赖闭包不完整——
`@deepseek-ai/dsh-tools` 会走到 `@deepseek-ai/cordis`，后者又走到隔离链接器**没有
物化出来**的包。那个入口为 `@deepseek-ai/*` 作用域加了一层很窄的解析兜底；在完整的
安装里它完全用不上。

## 已知边界

- **child 路径需要 subagent provider，退化路径需要模型路由。** 有 subagent provider 时
  child 继承会话模型，整理完全自动；没有的话退化路径需要 `consolidationRouteProvider` +
  `consolidationRouteModel`，或会话已记录的 `request/header` 路由；两者都没有时整理会
  **被跳过而不是猜一个模型**。
- **整理在进程内跑且不排队。** 一个会话同时只跑一次；运行中崩溃只丢那一次改动，
  不会丢已经提交的库。
- **闸门是文本启发式。** 它只看用户与助手的文本，判断不了一轮是否**重要**，只能判断
  它是否**听起来**留下了可沉淀的东西。
- **不做近似去重。** 同一个事实的两种不同措辞算两条，靠整理器去合并。
- **`maxEntries` 是每层上限，不是全局上限**，所以两层都开时最多可存两倍的条目数。
- **child 只能写记忆，所以它得出的其他结论会被丢弃。** 这是有意为之，但也意味着"需要
  先读某个文件才能判断"的整理不在范围内。

## 许可证

MIT
