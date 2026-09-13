# 变更记录

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
