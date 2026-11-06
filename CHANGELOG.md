# 变更记录

## 0.7.1

`scrollUntil` 实机跑通（番剧页滚到第 166 集并打开），途中修了两个时序问题：

- **先查后滚**：目标可能本来就在视野里。原来是无条件先滚 400px 再查，对着已经到位的
  列表反复跑会一路越滚越过。改成「先查 → 没找到才滚 → 再查」。
- **找到后等 250ms**：虚拟列表在滚动后会重渲染一轮。原来找到就立刻返回，紧接着的
  `click` 正好撞上「旧行已卸载、新行还没挂上」的空档，报「没找到匹配的元素」。

## 0.7.0

### 配方新增 `scrollUntil` 步骤（治虚拟列表）

`scrollUntil: { text, container?, step?, max? }` —— 在容器里「滚一段 → 找一次」，
直到目标文字出现。虚拟列表（番剧选集、长商品列表）只能这么处理：**没渲染的元素
根本不在 DOM 里**，`filter` / `snapshot` 都看不见，于是只能绕去站内搜索。

- 页内只滚一次（`__mbScrollFind`），循环放宿主侧：页内没法 await 下一帧，回吐一次更干净。
- 到底还没找到就**硬失败**并说明滚了多远，不允许猜一个相近的继续。

### 方法固化：探索一次 → 写回手册 → 之后零快照

`mac-browser-playbook` 新增「怎么维护这份手册」一节，把这次 A/B 验证的做法写成流程：

1. 第一次遇到固定页面：照常探索，把确认过的选择器记下来
2. 写回站点卡，重载插件即生效
3. 之后再来的同一个页面：照卡直接操作，**零快照**
4. 要重复很多次的流程：升级成配方

判断标准：**同一个页面第二次来，就不该再探索。**

## 0.6.1

- 往 `mac-browser-playbook` 的 E6 站点卡里补了实测发现的两条：字典管理弹窗的字段**没有 label
  关联**（要用 placeholder 定位），以及点「新建字典」必须 `exact: true`（否则会命中禁用的
  「新建字典项」按钮）。skill 正文因此从 3k 涨到约 3.4k 字符。

## 0.6.0

### 随插件附带一篇 skill：`mac-browser-playbook`

插件加载时用 `ctx.skills.register(...)` 注册一篇内存 skill（`source: runtime`）。内容是一份
**操作手册**：合成/真实怎么选、定位优先级（已知选择器 → label → 定向快照 → 整页快照 → 截图）、
操作纪律、两个已验证站点的选择器卡片（E6 后台 / 哔哩哔哩），以及常见失败长什么样。

- 为什么放 skill 而不是塞进工具描述：工具描述**每一轮**都进上下文，skill 只在模型真要用时
  才加载（3k 字符左右）。
- `skills` 是可选依赖：用 `ctx.get('skills')` 取，取不到就跳过，插件照常工作。
- 它省的是**探索**（快照找元素），不是定位：点之前仍然要确认元素在。
- 用户可以在项目里写同名 skill 覆盖（同层优先级：项目 > runtime > 用户）。

## 0.5.1

### 修：真实鼠标点击和截图用的是「错误的窗口矩形」

`asWindowRect` 一直走 System Events 的 `window 1`。但 Chrome 的**辅助功能窗口列表**里
会混进弹层/工具窗，`window 1` 未必是用户眼里的主窗口 —— 实测这台机器上 Chrome 有 2 个
AX 窗口，`window 1` 是个 362x180 的小窗。

后果很坏，而且静默：

- 真实鼠标点击按这个小窗的几何换算屏幕坐标，**点哪儿都偏**（实测 h1 中心在
  视口 245,100，工具却把光标送到 991,158；同一浏览器里另一标签页因此被误点、跳到了下一集）
- 截图裁剪区域跟着错，拍出来是 362x180 的一小块
- 命令依然报「已点击 / 已截图」，看不出问题

改成**先问浏览器自己**：`bounds of front window`（Chrome/Safari 都支持，且不依赖
辅助功能）。只有它不可用时才退回 System Events。修复后同一页面：截图区域
1280x746、真实点击落点 (245,216)，和元素实际位置对上了。

## 0.5.0

### 快照瘦身：`filter` / `only` / 文字块默认 400 字

「每步都快照一次」是 token 的主要开销，一次整页快照大约 1.2–2k tokens。这次三处改动：

- **`snapshot({ filter: '登录' })`** —— 只返回标签含这个词的元素，并从 1 重新编号；
  同时**不再返回可见文字块**。定向操作时输出从两三千字符降到一百多字符。
  实测：E6 后台定向找「元数据模板」，完整快照约 3k 字符 → 现在 120 字符，
  且拿到的 ref 可以直接 `click({ref:1})`（过滤后会重新编号，不会错位）。
- **`snapshot({ only: 'interactive' })`** —— 只收语义可交互元素（button/a/input/
  [role]/[onclick]/[tabindex]），不再跑 `cursor:pointer` 那层兜底。实测同一页面
  候选从 57 个降到 36 个。默认仍是 `all`：真实后台的一级导航常常是没有
  role/tabindex 的 div，靠 cursor 才认得出来，默认收窄会把整个导航漏掉。
- **可见文字块默认 1200 → 400 字**（`textMax` 传 0 可彻底关闭）。它和元素标签
  高度重叠，却常占掉快照一半体积。

合计：常见“先看一眼、点一下”的流程，上下文占用大约降到原来的 **1/10**。

## 0.4.0

### 文档对齐 DSH Desktop

- README 的「安装」段原来写的是 `web` profile —— 依据是 `health-snapshots` 里的
  `"profileName":"web"`。实测错了：Desktop 的启动参数是
  `--profile /Users/ming/.dsh/profiles/desktop`，`Config.listConfigs` 报的 `packageDir`
  也落在 `profiles/desktop/`。已改正，并说明那个字段对应的是 `dsh web` 的浏览器外壳。
- 同时补一句：0.4.0 起可以用「插件」页把这一行关掉再打开来热重载，不必重启整个 app。

### 实测修掉的问题（0.2.0 里就有）

拿 E6 Meta Engine 的后台（Element Plus + Vue）实跑了一遍，抓到五个：

- **`<li>` 的 `value` 被当成标签文字**。`__mbLabel` 原来只判断 `el.value !== undefined`，
  而 `<li>` 天生带一个数字型 `value`（有序列表序号，默认 **0**）。结果：快照里每个菜单项
  的标签都是 `0`、点击回显是「0」、连「selector 命中多个」的候选清单也全是 `0`（等于没有
  标签）。更糟的是按 `text` 定位时 `li` 永远匹配不上，只能落到包住整页的祖先上 ——
  实测点到 `<div id="app">`，页面毫无反应却报「已点击」。现在只对
  `INPUT`/`TEXTAREA`/`SELECT`/`BUTTON` 认 `value`。
- **Chrome 上 `mac_browser_close` 直接报错**。`index of <tab>` 在 Chrome 152 上转
  text 就是 -1700（和 0.2.0 修的 `index of newTab` 同一个坑）。按 url 关是好用的，
  按 window/tab 关必炸。改用 `active tab index` / 调用方给的序号。
- **Chrome 上列标签页永远没有 `▶`**。同一个 `index of t` 被包在 `try` 里，异常被吞掉，
  于是「当前页」判定恒为假。改成拿循环计数器跟 `active tab index` 比。
- **截图可能拍错 app**。截图截的是**屏幕那块区域**，不是那个窗口；浏览器不在前台时，
  压在它上面的 app 会被拍进来，却报「已截图（浏览器窗口）」。实测拍到了 DSH 自己的
  插件页。现在先激活浏览器再取矩形。
- **-1719 被一律解释成「辅助功能没开」**。这个码一码两用：System Events 拒绝辅助功能
  时用它，Chrome 报「无效的索引」也用它。于是「标签页序号过期」被指去隐私设置里
  翻权限。现在只有同时出现「辅助访问」字样才判权限，光有 -1719 的归到「序号无效」。
- **`mac_browser_eval` 抛错时只剩 "missing value"**。页面里的表达式报错，AppleScript
  只会把结果变成字符串 "missing value"，模型既看不出是语法错还是变量不存在。现在
  包一层 try/catch 把 message 带回来；顺带让 `{a:1}` 这种以 `{` 开头的表达式按对象
  字面量求值，而不是被当成语句块。

### 界面上的配置页

- 新增浏览器半侧 `client.js`，注册到 `plugins.row.config` 槽（key
  `dsh-mac-browser#mac-browser`）。装好后侧栏「插件 → 已安装 → dsh-mac-browser」那一行
  会多一个「配置」入口，点开就能在「页内合成 / 真实鼠标」之间切，不用再去改配置文件。
- 保存走 `form.mutate([{ op:'set', path:['pointer','mode'], value }], revision)` —— 和手改
  `cordis.patch.yml` 是同一条通道。改的是普通字段，所以保存后这一行会重启一次，
  `pointer.mode` 本来就需要重启才生效。
- 新增 `export const Config`（schemastery）。这不是可有可无的：DSH 的 `settings` 服务
  只给**有原生 Config 的插件**投影命名空间，没有它，客户端拿不到 `form`，界面也写不进去。
- `package.json`：新增依赖 `@deepseek-ai/schemastery`、`dsh.client` 段与 `./client` 导出。
- **升级注意**：`link:` 安装时依赖不会被一起装，得在插件目录跑一次 `pnpm install`。
  不装会 `import` 失败、整个插件加载不起来（浏览器工具全部消失），不是降级而是消失。

## 0.3.0

### 输入总开关

- 新增 `pointer.mode`：`synthetic`（缺省，页内合成点击）／`real`（真实鼠标键盘）。
  这是针对「页面点得到，但看不见鼠标动」这个反馈加的 —— 原来只能靠每次调用手写
  `real: true`，现在一行配置就能全局切成真实模式。
- 判定顺序是**参数优先**：`real: true` 永远有效；`real: false` 能压过 `mode: real`
  （开了总开关，也还得能单独跑一次快的）。作用于 `click` / `type` / `open` / 配方。
- 值写错（不是 `real`）一律当 `synthetic`：配错的代价是「没变慢」，不是「突然点不动」。
- `mac_browser_status` 现在会报当前输入模式 —— 排障「鼠标为什么不动」时第一眼看这里。
- 前台校验的报错补了一句「或传 real:false 改走页内合成」，不必非得先把标签页切前台。
- 顺带修正 `click` 工具描述里把真实鼠标写成「System Events」的旧说法（实现是 CoreGraphics）。

### 工具契约升级（对齐 DSH 0.2.2-rc.1）

- 每个工具都声明了 `ToolDefinition.timeoutMs`。DSH 内置的 `dsh-tool-call-timeout-policy`
  会读这个字段，到点 abort `exec.signal`；我们的子进程会因此被终止，模型收到一条
  `TOOL_TIMEOUT` 而不是无限等待。此前只有「单次 osascript 往返」的超时，整条流程
  （多次子进程 + 页内轮询 + 鼠标动画）没有上限。
- 时限按工具分开给：`recipe` 180s、`click`/`type`/`scroll`/`open` 45s、其余 20–30s。
  统一一个值要么误杀配方，要么对单步操作形同虚设。
- 新增 `config.toolTimeouts`，按工具名覆盖时限（非数字 / 非正数一律忽略，退回内置值）。
- 声明了 `isConcurrencySafe`：只有 `status` / `tabs` / `read` / `screenshot` / `formcheck`
  五个纯读工具允许并行；其余独占。不声明时 DSH 本就按 exclusive 处理，这里把判断写明白，
  并让五个读工具真的能并行。`snapshot` 故意不放行 —— 它会给元素打 `data-mb-ref` 编号，
  并发会互相重编号，让前一次的 ref 失效。

## 0.2.0

### 新增工具（13 → 15 个）

- `mac_browser_formcheck` —— 提交表单前扫出「必填但为空」。指令里没提到的必填项直接提交，
  只会被服务端挡回一句笼统的「提示异常」。三路识别：框架必填标记
  （`.el-form-item.is-required`）、原生 `required` / `aria-required`、控件是否为空。
  只列清单，**不替用户挑值**。
- `mac_browser_host_focus` —— 把宿主应用切回前台、还原被最小化的窗口、未运行则启动。
  提问前与任务结束时应当先调用它。目标 app 默认从本进程 `execPath` 推出，可用
  `config.hostApp` 或调用参数覆盖。

### 定位

- `click` / `type` 新增 **`label`** 参数：按表单标签文字定位控件。表单会在选中某个字段后
  重渲染、自动增删字段，`nth-child` 路径与缓存的 `ref` 会整体错位；标签是语义，不受影响。
  解析时逐层向上找最近的、**正好含一个控件**的祖先，并对嵌套控件做最外层去重
  （如 `select` 的 wrapper 内部还套着一个 `role="combobox"` 的 input）。
- **`selector` 命中多个且未给 `index` 时拒绝执行**，改为列出候选并报错。DOM 顺序与「想
  点哪个」无关，静默取第一个会导致「报成功、实际点错」。计数场景（配方的
  `waitFor` / `expect`）显式带 `many: true` 放行。此前 `index` 只在 `> 0` 时透传，
  导致显式 `index: 0` 与「没给」无法区分，已一并修正。
- 宽表横向滚动：`scrollIntoView` 补上 `inline: 'center'`（原来只滚纵向，离屏列够不着）。

### 真实输入

- 屏幕坐标改为**比例映射**：视口 CSS 像素 × 窗口点尺寸 ÷ `outerWidth`。此前
  `screenX + rect.left` 把 CSS 像素与屏幕点直接相加，页面缩放 ≠ 100% 时会偏。
- 真实指针 / 键盘执行前校验目标页是否**在前台**：事件按屏幕坐标发出，后台标签页上硬做会
  打到别的页面上，而命令仍报成功。
- Chrome 两处修复：
  - `(index of newTab)` → `(count of tabs)`：Chrome 152 上取新建 tab 的 `index` 得到的是
    tab 引用而非整数，赋值报 `-10006` —— 标签已建出，脚本却报失败。
  - `asTabScript` 的标签号**按后端分流**：Chrome 上 `index of <tab>` 转 text/integer 都报
    `-1700`，只能用 `active tab index`。此前 Chrome 的页内操作会全部失败。

### 滚动回读

- 改为对比**全部可滚动容器**的前后差异。只读 `window.scrollY` 时，页面把滚动放在内层容器
  里会恒为 0 —— 明明滚了也报「没动」。

### 指令协议

- 随插件注册进系统提示词（`instructionProtocol`，默认开启，全局生效）：多指令 / 模糊指令
  处理约定、填表硬规矩、宿主置前、`selector` 歧义处理。

## 0.1.0

首个版本。Safari / Chrome 可插拔后端；`open` / `tabs` / `read` / `eval` / `activate` /
`close` / `click` / `type` / `screenshot` / `snapshot` / `scroll` / `recipe` 十二个工具；
站点配方（声明式步骤 + `waitFor` / `expect`）；AppleScript 传输（脚本走 stdin、参数走
argv，不经 shell）。
