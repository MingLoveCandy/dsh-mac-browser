# dsh-mac-browser

让 DSH 的 agent 直接操作这台 Mac 上**真实的** Safari 与 Google Chrome：鼠标、键盘、滚轮
走的是和用户操作同一条路径（CoreGraphics 真实事件），页面内的读取、定位与填写走
AppleScript 注入。15 个工具，可在真实站点上完成「打开 → 登录 → 填表 → 提交」这类完整流程。

## 环境要求

- **macOS**（页面级能力依赖 AppleScript / CoreGraphics）
- 浏览器：**Safari** 或 **Google Chrome**
- DSH Desktop，且插件装进它实际启动的 profile（见「安装」）
- 若干系统授权，缺哪个会在报错里点名（见「权限」）

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `mac_browser_status` | 自检：osascript 是否可用、各后端是否安装/运行、需要哪些权限 |
| `mac_browser_open` | 打开 URL 到新标签并前置；**无 url 时只唤起前台**（「打开 Safari」） |
| `mac_browser_tabs` | 列出全部窗口的标签页（W/T 序号、是否当前、标题、URL） |
| `mac_browser_read` | 读指定标签页的标题、URL、可见正文 |
| `mac_browser_eval` | 在指定标签页执行 JS 表达式并返回结果 |
| `mac_browser_activate` | 把浏览器唤起前台 |
| `mac_browser_close` | 关页签：按 `window`/`tab` 关一个，或给 `url` 关掉全部匹配的（内部从大到小关，不会串位） |
| `mac_browser_click` | **点击元素**：按 `selector` / `text` / **`label`**（表单标签文字）定位，`index` 选第几个 |
| `mac_browser_type` | **在输入框打字**：按 `selector`/`text`/**`label`** 定位；`submit:true` 提交 —— 找得到提交/搜索按钮就点它，否则派发合成回车 |
| `mac_browser_screenshot` | 截图（整个浏览器窗口，或指定元素）返回 PNG 路径，供模型 `read_image` 查看。用于 DOM 定位失败时的**视觉兜底**。需要「屏幕录制」权限 |
| `mac_browser_snapshot` | **紧凑页面结构**：可见文字摘要 + 带编号的元素表。编号可直接用于 click/type 的 `ref`。探索陌生页面优先用它 |
| `mac_browser_scroll` | **真实滚轮滚动**（CGEvent）：按方向 + 像素滚，或给 `ref`/`selector`/`text` 滚到目标可见 |
| `mac_browser_formcheck` | **提交表单前的前置检查**：扫出「必填但为空」的字段。查到就**停下问用户**，不要自己挑值填 |
| `mac_browser_host_focus` | 把**宿主应用**（跑着 agent 的那个 app，如 DSH Desktop）切到前台、还原最小化、未运行则启动 |
| `mac_browser_recipe` | 执行预配置的**站点配方**（`config.recipes`）；省略 `name` 则列出全部可用配方 |

## 使用约定

### 表单字段：定位用 `label`，提交前先 `formcheck`

**优先用 `label`（标签文字）定位表单字段，不要用 `nth-child` 路径或缓存的 `ref`。**
表单常会在选中某个字段后重渲染、自动增删字段，位置型定位会整体错位；标签是语义，
字段增删、分辨率与页面缩放都不影响它。

```
mac_browser_type  { label: '数量', value: '0' }
mac_browser_click { label: '客户编码' }          # 下拉点 wrapper，会自动展开
```

**提交前先跑 `mac_browser_formcheck`。** 指令里没提到的字段也可能是必填的，直接提交只会被
服务端挡回一句笼统的「提示异常」，既不知道是哪个字段也不知道为什么。该工具在提交**之前**
列出「必填但为空」的清单（框架必填标记 / 原生 `required` / 控件是否为空，三路识别）。
查到清单时**不要自己挑值填上** —— 替用户选业务值属于猜测，可能悄悄改掉单据性质；把清单
**一次性**列给用户问清楚再继续。

### `selector` 命中多个：工具拒绝执行

`selector` 的匹配顺序就是 DOM 顺序，跟「你想点哪个」无关。所以当选择器命中**多个**、而
调用方又没给 `index` 时，`click` / `type` / `screenshot` / `scroll` **一律拒绝**并列出候选 ——
默默取第一个的后果是「报了成功、实际点错」，没有任何信号。

| 做法 | 说明 |
|---|---|
| 用 `label` | 表单字段的首选 |
| 收窄选择器 | 例如 `.el-table__row:first-child .btn`，让它只命中一个 |
| 显式传 `index` | 确实要候选里的某一个时才这么写；`index: 0` 也算显式（与「没给」区分得开） |

`text` 定位**不受影响**：它有一套刻意设计的消歧规则（优先可交互元素、再取面积最小的）。
配方里的 `waitFor` / `expect` 同理 —— 它们本就是**数个数**的，命中多个正是它们要的。

### 提问与任务结束时：把宿主应用切回前台

需要向用户提问时、以及任务结束时，先调 `mac_browser_host_focus`。用户在 agent 干活期间
往往已经切到别处，不把宿主拉回前台，提问和结论不会被看见。被最小化时它会还原窗口；
进程不在则 `open -a` 启动。目标 app 默认从本进程的 `execPath` 推出（打包态即
`…/DSH Desktop.app/…`），也可用 `config.hostApp` 指定或调用时传 `app`。

### 探索页面：`snapshot` + `ref`，不要 dump DOM

先快照拿编号，再用编号操作 —— 不用猜选择器，也不受「同名元素有多个」影响。快照输出是
紧凑的元素表 + 视口内的可见文字；手写 `eval` 去 dump 整页元素会一次吐出几十 KB，把上下文
撑大，之后每一步都变慢。

```
mac_browser_snapshot                     → 25  button  <图标 1/7>  36x24
mac_browser_click {ref: 25}              → 直接点它
mac_browser_type {ref: 9, value: '100'}  → 直接往里输
```

两点注意：

- **每次快照会重新编号**，页面变化后旧 `ref` 失效。有交互就重新快照。
- 表格里的图标按钮没有文字、也没有 `title`/`aria`，标签会补上**所在行的标识 + 同父同类序号**
  （如 `A001 › <图标 1/7>`）。这样一行里几个长得一样的按钮才能区分开。

## 滚动

`mac_browser_scroll` 发的是**真实滚轮事件**（`CGEventCreateScrollWheelEvent2`），和用户滚
鼠标走同一条路径 —— 页面看得见地滚。

```
mac_browser_scroll { direction: down, amount: 600 }    # 按方向 + 像素
mac_browser_scroll { ref: 25, offset: 120 }            # 滚到 ref 可见，距顶留 120px
mac_browser_scroll { text: 目标区块 }                   # 按可见文字找
```

要点：

- 用 `CGEventCreateScrollWheelEvent2`（**非变参**版）—— 变参的
  `CGEventCreateScrollWheelEvent` 在 JXA 的 C 桥里传不了可变参数。
- `units=0` 就是像素，`wheel1` **负值向下、正值向上**。
- 滚轮作用于**光标所在的窗口**，所以工具先激活浏览器、再把光标放进页面；并且**回读实际
  滚动位置** —— 否则「命令成功但页面没动」会被当成成功报出去。回读对比的是**全部可滚动
  容器**的前后差异：页面把滚动放在内层容器里时，只读 `window.scrollY` 会误报「没动」。
- 宽表里目标列可能在视口右侧之外：`scrollIntoView` 带 `inline: 'center'`，会连内层容器
  一起滚到位。

## 视觉兜底（DOM 找不到元素时）

现有定位是**结构化**的：DOM + 无障碍树。跨域 iframe、canvas、纯图片按钮都进不去。兜底流程：

1. `mac_browser_screenshot` 截图（返回路径 + 屏幕区域 + **缩放比**）
2. 模型用 `read_image` 看图
3. `mac_browser_click {x, y}` 传屏幕坐标真实点击

返回里写清了坐标换算：`屏幕坐标 = 区域左上角 + 图像像素 / 缩放`。Retina 上缩放是 2x，
不换算会点偏一倍。

> 刻意**不**做「DOM 失败就自动改用视觉」的静默融合。有研究
> （[arXiv:2607.04334](https://arxiv.org/abs/2607.04334)）测出：同时拿到像素与结构两路信息的
> GUI agent，在二者冲突时**会相信结构而不是眼睛**，在过期快照上最多 0.88 的比例跟着过时
> 结构走；唯一被验证有效的缓解是**一致性门**（不一致就停下报告），而非盲目融合。
> 所以这里让模型显式决定。

## 安装

包名 `dsh-mac-browser`。profile 名以该机器实际启动的为准 —— **DSH Desktop 启动的是
`web` profile**（证据：`~/Library/Application Support/DSH Desktop/health-snapshots/`
里每份快照都写着 `"profileName":"web"` / `"provider":"desktop-profile"`），
`profiles/desktop/` 是个没被使用的空壳。

```sh
dsh plugin --profile web add /path/to/dsh-mac-browser
```

然后把 `"dsh-mac-browser"` 加进 profile 的 `dsh.profile.bundles`：

`~/.dsh/profiles/web/package.json`

```json
"dsh": { "profile": { "bundles": [ ..., "dsh-mac-browser" ] } }
```

重启 DSH Desktop 生效。`link:` 安装时改文件即生效（但仍需重启进程才会重新加载）。

> 更简的替代做法：不动 `bundles`，直接往 `~/.dsh/profiles/web/cordis.patch.yml`
> （你自己的 patch 层，最后应用、能覆盖 bundle 层）插一行
> `- insert: [- id: mac-browser, name: 'dsh-mac-browser']`。

> 预设里**不要**再放 `./mac-browser.mjs` 那一行。全局注册的工具对所有预设的会话都可见，
> 预设层不需要（也不该）再来一份，否则两份拷贝会分叉。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖 `mac-browser` 行。注意这是**浅覆盖**：
同 id 的整个 `config` 会被替换，漏写 `defaultBackend` 会让缺省浏览器退回「第一个注册的
后端」，而不是包默认的 safari。

| 字段 | 缺省 | 说明 |
| --- | --- | --- |
| `backends` | 全部 | 启用哪些后端 |
| `defaultBackend` | `safari` | 省略 `browser` 参数时的落点；不属于本平台时自动退回第一个可用后端 |
| `timeoutMs` | `20000` | 单次 osascript 超时 |
| `maxOutputBytes` | `512000` | 单流输出上限 |
| `cwd` | `$HOME` | 子进程工作目录 |
| `hostApp` | 自动识别 | `mac_browser_host_focus` 的目标 app；缺省从本进程 `execPath` 推 |
| `pointer.steps` | `48` | 鼠标移动插值步数（夹在 2–400） |
| `pointer.stepMs` | `20` | 每步间隔毫秒（夹在 1–200）；48×20 ≈ 0.96s |
| `pointer.easing` | `easeInOut` | `easeInOut` 或 `linear`。匀速直线看起来像「被拖过去」 |
| `recipes` | `[]` | 站点配方数组，见下 |
| `instructionProtocol` | `true` | 是否注入「多指令 / 模糊指令」处理约定（系统提示词段），见下 |
| `instructionProtocolText` | 内置文案 | 整段替换掉那段约定 |
| `instructionProtocolOrder` | `15` | 该提示词段的位置；有限数即可（`0` 也是合法值） |

调鼠标速度只动前两项。嫌「一闪而过」就调大步数或间隔；超过约 2s 会让连续操作很烦。

## 随插件走的「多指令 / 模糊指令」约定

插件会往**系统提示词**里注册一段行为约定（`ctx.systemPrompt.section`），所以装到哪个 agent
都生效 —— 这是刻意的：这条纪律不是浏览器能力的一部分，而是「别拿猜测冒充执行」这个更基本
的约定，跟着插件走就不用每次都重新交代。

注册的段名是 `mac-browser/instruction-protocol`，`order` 默认 15（persona 之上、工具类 100+
之下）。插件是全局安装的，所以这段注册在宿主作用域 —— **进程内每个 agent 都会看到**。
要关掉设 `instructionProtocol: false`。

约定共 8 条：

1. **先拆解** —— 把用户一段话拆成独立的指令列表。
2. **逐条判定** —— 模糊 / 缺关键信息 / 有多种合理解读 → 不做、不猜；不依赖被阻塞项且确信
   理解正确 → 照做；依赖被阻塞项 → 也停下。
3. **只问一次** —— 所有被阻塞项合并成一次提问，不逐条追问，也不先做一半再问一半。
4. 已完成的照常汇报，并说明哪些项因为什么被阻塞。
5. **提交表单前先跑 `mac_browser_formcheck`**，查到未填项不要自己挑值。
6. **表单字段优先用 `label`**，不要用 `nth-child` 路径或缓存 `ref`。
7. **提问前与任务结束时先切宿主前台**（`mac_browser_host_focus`）。
8. **`selector` 命中多个就改用 `label`**，不要靠 `index` 蒙。

> 为什么写进提示词而不是只写在文档里：**文档不会被 agent 在每次决策时读到，提示词会。**

## 站点配方（config.recipes）

把「某个网站上的固定操作」固化成声明式步骤 —— 模型不必每次现编选择器，页面小改也只改配置：

```yaml
recipes:
  - name: example-search
    match: example.com             # 当前标签页 URL 必须含它，否则拒绝执行
    description: 在示例站点搜索关键词
    steps:
      - click: input.search-input
      - type: { selector: input.search-input, value: '{{query}}', submit: true }
      - waitFor: .result-list a
```

用 `mac_browser_recipe {name: example-search, vars: {query: 关键词}}` 执行；省略 `name`
则列出全部配方。

**步骤词汇表**（每项只写一个键）：

| 步骤 | 说明 |
| --- | --- |
| `goto: <url>` | 打开网址（可配 `real: true` 走地址栏） |
| `wait: <毫秒>` | 固定等待 |
| `waitFor: <selector>` 或 `{selector, timeoutMs}` | 轮询到元素出现 |
| `expect: <selector>` 或 `{selector, timeoutMs, min, what}` | **断言这里必须有结果**，否则立刻停下（见下） |
| `click: <selector>` 或 `{selector｜text, index, real}` | 点击 |
| `type: {selector｜text, value, submit, real}` | 输入 |
| `eval: <js 表达式>` | 逃生口；结果可从 `{{__last}}` 串到下一步 |
| `screenshot: true` 或 `{selector}` | 截图，路径写进 trace |

字符串里的 `{{name}}` 由调用时的 `vars` 替换。**任一步失败即中止**，并回报「第几步 +
已完成哪些」—— 不猜、不继续。

配方里的 `click` / `type` 步骤会显式传 `index: 0`：配方是刻意编写的，「命中多个时取第一个」
就是它写下来的语义。

### `expect`：空结果必须硬失败

查询类流程**必须**用它。理由是：空结果集是**静默的成功** —— 页面没报错、步骤也「成功」了，
agent 很容易以为一切正常，然后自己编一个相近的词继续走。

```yaml
- type: { selector: 'input[placeholder="编码"]', value: '{{code}}' }
- click: { text: 搜索, exact: true }
- expect: { selector: '.result-row', timeoutMs: 5000, what: 查询结果 }   # ← 没有结果就在这里停
- click: { selector: '.result-row:first-child .btn-view' }
```

失败时的文案是**刻意写给 agent 看的**：不要自行替换搜索词、不要猜一个相近的值继续 ——
那是猜测不是执行；请把「用这个条件查不到」回报给用户并问清楚要用哪个条件。

变关键词时**直接再跑一次这条配方**即可：`type` 本身是整体替换语义，不需要先清空，也不必
重新登录或重新导航。

配方可整体选 `real: true` 让所有步骤走真实鼠标键盘（看得见但慢），也可只给个别步骤加 `real`。

## 权限（macOS，各一次）

1. **自动化**：系统设置 → 隐私与安全性 → 自动化 → 允许 DSH Desktop 控制
   Safari / Google Chrome。缺这个会报 `-1743`。
2. **Apple 事件 JavaScript**（只有 `read` / `eval` / 页内定位需要）：
   - Safari：设置 → 高级 → 显示网页开发者功能，再点 开发 → 允许 Apple 事件中的 JavaScript
   - Chrome：显示 → 开发者 → 允许 Apple 事件中的 JavaScript
3. **辅助功能**（只有 `real: true` 的真实鼠标/键盘需要）：系统设置 → 隐私与安全性
   → 辅助功能，打开「DSH Desktop」。

   注意 `-1719` 报错里点名的是 **`osascript`** 而不是宿主 App。如果列表里没有
   DSH Desktop 可勾，就点「+」，`Cmd+Shift+G` 输入 `/usr/bin`，把 `osascript`
   加进去。页内合成模式（省略 `real`）**不需要**这项权限。
4. **屏幕录制**（只有 `mac_browser_screenshot` 需要）：系统设置 → 隐私与安全性
   → 屏幕录制，打开「DSH Desktop」。

   缺这项时 `screencapture` 报 `could not create image from display` /
   `from rect` —— **全屏和指定矩形都失败**，不是矩形算错。列表里没有就按上面的
   「+」办法加 `/usr/sbin/screencapture`。

这四项互相独立，失败都会被翻译成可执行的中文提示，而不是把底层报错丢给模型。

## Windows

AppleScript 在 Windows 上不存在，所以那边是 PowerShell 后端，**只覆盖 OS 层**：

| 能做 | 不能做 |
| --- | --- |
| 打开 URL、唤起浏览器 | 列标签页 / 读正文 / 执行 JS / 关标签页 |
| 真实鼠标点击（**必须显式给 `x` / `y`**） | 按 selector / text / label 定位元素 |
| 真实键盘输入（**只能送进当前焦点**） | 指定往哪个输入框输 |

原因：页面级能力要靠 Chrome DevTools Protocol，目前没接。插件里有一张能力矩阵，
调不到的能力会当场说明「此平台不支持 + 为什么」。

接 CDP 前必须知道：**Chrome 136 起，默认配置目录不再接受 `--remote-debugging-port`**
（官方安全变更），要么用 auto-connect，要么用独立配置目录 / Chrome for Testing。

Windows **不需要** macOS 那套辅助功能授权；门槛是 UIPI —— 目标窗口若以管理员权限
运行，非管理员进程发不进事件。真实键盘走「写剪贴板 + Ctrl+V」（中文必须这样送）。

> ⚠️ Windows 后端**尚未在真实 Windows 环境中验证**：开发机是 macOS 且没有 `pwsh`，那些 PowerShell
> 从未被解释器解析过一次。已验的只有脚本生成与注入面。

## 传输层

**macOS**：`/usr/bin/osascript` + AppleScript，但**全程不经过 shell** —— 源码走
`stdio.stdin`，参数走 `on run argv` 由 argv 数组直接进 `execve`。所以 URL / JS
表达式不会被拼接进任何字符串字面量：没有转义问题，也没有注入面。

**Windows**：PowerShell，值以单引号字面量内嵌（PS 里单引号写两遍转义），同样没有注入面。

## 可插拔后端

`registerBackend(id, factory)` 是唯一扩展点，`config.backends` 决定启用哪些。
两个内置后端（`chrome` / `safari`）共用一份 AppleScript 实现，差异只在 spec。
以后加 CDP 或 Agent Window 后端，只需另写一个模块：

```js
import { registerBackend } from 'dsh-mac-browser'
registerBackend('cdp', () => ({ id: 'cdp', /* ... */ }))
```

## 已知限制

- **页面缩放 ≠ 100%** 时的屏幕坐标换算：采用比例映射（视口 CSS 像素 × 窗口点尺寸 ÷
  `outerWidth`），在 100% 缩放下与既有基准等价；**非 100% 场景未验证**。
- **Windows 后端**未在真实 Windows 环境中验证（见上）。
- 真实鼠标 / 键盘 / 滚轮事件按**屏幕坐标**发出，只会落到当前可见的那一页：目标标签页不在
  前台时 `real: true` 会被直接拒绝，而不是打到别的页面上却报成功。

## 安全边界

`mac_browser_eval` 是在用户**已登录**的标签页里执行任意 JS，`mac_browser_read`
读的是登录态正文。这两个工具的权限等同于用户本人。
