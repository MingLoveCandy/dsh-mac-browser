/**
 * mac-browser — 让 agent 直接操作 macOS 上真实的 Safari / Google Chrome。
 *
 * 这个文件是**独立插件**：不依赖 liangshen 预设的任何东西，任何预设把它
 * 加一行 `name: ./mac-browser.mjs` 就能用（见 agent.cordis.yml 的 mac-browser 行）。
 *
 * ── 传输层 ────────────────────────────────────────────────────────────────
 * 走 /usr/bin/osascript + AppleScript，但**全程不经过 shell**：
 *   · AppleScript 源码走 stdin（`stdio.stdin = { data: script }`）
 *   · 参数走 `on run argv`，由 spawn 的 argv 数组直接交给 execve
 * 所以 URL / JS 表达式永远不会被拼接进任何字符串字面量，既没有引号转义
 * 地狱，也没有命令注入面。（对比：拼 `osascript -e "..."` 一定会在第一段
 * 含引号的 JS 上炸掉。）
 *
 * ── 可插拔后端 ────────────────────────────────────────────────────────────
 * `registerBackend(id, factory)` 是唯一扩展点。现有两个后端共用一份
 * AppleScript 实现，差异全部来自 spec；以后加 CDP / Agent Window 后端，
 * 只要在另一模块里 registerBackend 即可，工具层不用改：
 *
 *   import { registerBackend } from './mac-browser.mjs'
 *   registerBackend('cdp', () => ({ id: 'cdp', ... }))
 *
 * config.backends 决定启用哪些（缺省全部）；config.defaultBackend 决定
 * 省略 `browser` 参数时的落点（缺省 safari）。
 *
 * ── 权限（macOS，只需一次） ───────────────────────────────────────────────
 *   1. 系统设置 → 隐私与安全性 → 自动化 → 允许 DSH Desktop 控制目标浏览器
 *   2. 读/执行 JS 还需要浏览器放行 Apple 事件 JavaScript：
 *      Safari：设置 → 高级 → 显示网页开发者功能，再点 开发 → 允许 Apple 事件中的 JavaScript
 *      Chrome：显示 → 开发者 → 允许 Apple 事件中的 JavaScript
 * 两类失败都会被映射成上面这两句中文提示，而不是丢一个 -1743 给模型。
 */

import { access, readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'mac-browser'

/**
 * 配置 schema。
 *
 * 为什么要声明它：DSH 的 `settings` 服务只给**有原生 Config 的插件**投影命名空间
 * （`isNativeConfigSchema` 认的是 schemastery，不是 zod）。没有它，界面上连
 * 「配置」入口都不会出现 —— 客户端页面拿不到 `form`，写不进去。
 *
 * 几个刻意的选择：
 *   · 所有键都写进来。schemastery 的 object 会**保留未知键**，但漏写已知键会让它
 *     从投影里消失，配方和 toolTimeouts 就白配了。
 *   · `pointer.mode` 用宽松的 string 而不是 union(const…)：写错时应当像以前一样
 *     静默退回 synthetic，而不是让整行插件激活失败 —— 这里挡下来，代价是整个浏览器
 *     能力全没，不值得。
 *   · 数值一律用宽松的 number()，真正的夹紧仍在代码里做 —— 写个 -1 应当被夹回
 *     合理区间，而不是让整行插件校验失败、把浏览器能力一起带走。
 */
export const Config = z.object({
  backends: z.array(z.string()).description('启用哪些后端；空数组 = 全部'),
  defaultBackend: z.string().description('省略 browser 参数时的落点'),
  timeoutMs: z.number().description('单次 osascript / PowerShell 往返超时（毫秒）'),
  maxOutputBytes: z.number().description('单流输出上限（字节）'),
  cwd: z.string().description('子进程工作目录'),
  hostApp: z.string().description('mac_browser_host_focus 的目标 app；缺省按宿主进程推断'),
  pointer: z
    .object({
      mode: z
        .string()
        .default('synthetic')
        .description('synthetic = 页内合成点击（快、看不见光标）；real = 真实鼠标键盘（光标会真的走过去）'),
      steps: z.number().default(48).description('鼠标移动插值步数（2–400）'),
      stepMs: z.number().default(20).description('每步间隔毫秒（1–200）'),
      easing: z.string().default('easeInOut').description('easeInOut 或 linear'),
    })
    .default({})
    .description('鼠标移动与输入模式'),
  toolTimeouts: z.dict(z.number()).default({}).description('按工具名覆盖整体时限（毫秒）'),
  recipes: z.array(z.any()).default([]).description('站点配方'),
  instructionProtocol: z.boolean().default(true).description('是否注入「多指令 / 模糊指令」处理约定'),
  instructionProtocolText: z.string().description('整段替换掉那段约定文案'),
  instructionProtocolOrder: z.number().default(15).description('该提示词段的位置'),
})

/** tools 注册表与 subprocess seam 必须先存在。 */
export const inject = ['subprocess', 'tools']

const FIELD_SEP = '\u001f'
const RECORD_SEP = '\u001e'
const DEFAULT_TIMEOUT_MS = 20000
const DEFAULT_MAX_OUTPUT_BYTES = 512000
const GRACE_MS = 2000

/**
 * 每个工具的**整体**时限（毫秒）。
 *
 * 这是 `ToolDefinition.timeoutMs`，由 DSH 内置的 `dsh-tool-call-timeout-policy`
 * 读出来强制执行：到点它就 abort `exec.signal`，我们内部照常把取消转成终止子进程，
 * 模型收到的是一条干净的 `TOOL_TIMEOUT` 错误，而不是一轮永远不结束的等待。
 *
 * 和 `config.timeoutMs` 是两层，别搞混：
 *   · config.timeoutMs —— **一次 osascript / PowerShell 往返**的上限（默认 20s）
 *   · 这里的值         —— **一次工具调用**的上限，可能包含好几次子进程 + 页内轮询
 *                          + 真实鼠标动画（48 步 × 20ms ≈ 1s）
 *
 * 为什么不统一成一个值：这些工具耗时差着量级。读一次正文几百毫秒，真实鼠标点一下
 * 1.5 秒，一条配方能连着走十几步。统一值要么误杀配方，要么对单步操作形同虚设。
 *
 * 想按站点调（比如某条配方就是慢），用 config.toolTimeouts 覆盖。
 */
const TOOL_TIMEOUT_MS = {
  mac_browser_status: 30_000,
  mac_browser_open: 45_000,
  mac_browser_tabs: 20_000,
  mac_browser_read: 20_000,
  mac_browser_eval: 20_000,
  mac_browser_activate: 20_000,
  mac_browser_close: 20_000,
  mac_browser_click: 45_000,
  mac_browser_type: 45_000,
  mac_browser_screenshot: 30_000,
  mac_browser_snapshot: 30_000,
  mac_browser_scroll: 45_000,
  mac_browser_formcheck: 30_000,
  mac_browser_host_focus: 30_000,
  mac_browser_recipe: 180_000,
}

/**
 * 可以和别的工具**同时**跑的工具（`ToolDefinition.isConcurrencySafe` 返回 true）。
 *
 * 不声明这个字段时，DSH 按 **exclusive** 处理：这一次 batch 里它独占，同批的其他
 * 调用排队。浏览器是一份共享的可变状态，所以点名、打字、滚动、开关标签页都不能并行 ——
 * 两个真实鼠标事件同时发出，落点会互相踩，而且会「都报成功」。
 *
 * 名单里只放**纯读且不改页面**的：自检、列标签页、读正文、截图、表单体检。
 * `snapshot` 故意不在里面：它会给元素打 `data-mb-ref` 编号，两次并发会互相重编号，
 * 于是前一次拿到的 ref 直接失效。
 */
const PARALLEL_SAFE_TOOLS = new Set([
  'mac_browser_status',
  'mac_browser_tabs',
  'mac_browser_read',
  'mac_browser_screenshot',
  'mac_browser_formcheck',
])

/**
 * 随插件一起走的「多指令 / 模糊指令」处理约定。
 *
 * 它注册成一条**系统提示词段**（ctx.systemPrompt.section），插件装到哪个 agent
 * 都生效 —— 这是刻意的：这条纪律不是浏览器能力的一部分，而是「别拿猜测冒充
 * 执行」这个更基本的约定；跟着插件走，装到别的 harness 也不用重新交代一遍。
 *
 * 之所以要写进提示词而不是只写在文档里：文档不会被 agent 在每次决策时读到，
 * 提示词会。
 *
 * 可用 config 覆盖：instructionProtocol: false 关掉，
 * instructionProtocolText 换文案，instructionProtocolOrder 调位置。
 */
const DEFAULT_INSTRUCTION_PROTOCOL = [
  '【多指令与模糊指令的处理约定】',
  '',
  '用户一次给出多条指令、或某条指令含义模糊时，按下面处理 —— 不要合成一次猜测：',
  '',
  '1. 先拆解。把用户这段话拆成**独立的指令列表**（一句话里可能含好几件要做的事）。',
  '2. 逐条判定：',
  '   · 模糊 / 缺关键信息 / 有多种合理解读 → **不做、不猜**。',
  '   · 不依赖被阻塞项、且你确信自己理解正确 → **照做**。',
  '   · 依赖被阻塞项（例如"把它改成 X"里那个指代不清的"它"）→ **也停下**。',
  '3. 只问一次。把所有被阻塞的项**合并成一次提问**，不要逐条追问，也不要先做一半再问一半。',
  '4. 已经做完的照常汇报，并说明哪些项因为什么被阻塞。',
  '',
  '判定"我确信理解正确"要从严：宁可多问一句，也不要把一个猜测的结果当作执行结果报出去。',
  '',
  '【填表的两条硬规矩】',
  '',
  '5. **提交表单前先跑 mac_browser_formcheck。** 指令里没提到的字段也可能是必填的，',
  '   直接点提交只会被服务端挡回一句笼统的"提示异常"，既不知道是哪个字段也不知道为什么。',
  '   该工具在提交**之前**把"必填但为空"的清单列出来。查到清单时：**不要自己挑值填上** ——',
  '   替用户选一个业务值属于猜测，可能悄悄改掉单据性质。把清单**一次性**列给用户问清楚再继续。',
  '',
  '6. **定位表单字段优先用 label（标签文字），不要用 nth-child 路径或缓存的 ref。**',
  '   表单会在选择某个字段后重渲染、自动增删字段，位置型定位会整体错位（错过）。',
  '   标签是语义，字段增删、分辨率与页面缩放都不影响它。',
  '',
  '7. **需要向用户提问、以及任务结束时，先把宿主应用切回前台**（mac_browser_host_focus）。',
  '   你在浏览器里干活的这段时间，用户很可能已经切到别处去了 —— 不把宿主拉回前台，',
  '   你的提问和结论根本不会被看见，表面上是"卡住了"，实际是在等人回答。',
  '   要提问时先切前台再提问；任务结束时先切前台再给结论。',
  '',
  '8. **用 selector 定位时，命中多个就改用 label，不要靠 index 蒙。**',
  '   选择器的匹配顺序就是 DOM 顺序，跟"你想点哪个"无关。工具已经会拒绝执行并列出候选；',
  '   看到这个报错时**不要**随手补一个 index 了事 —— 先想清楚是不是选择器本身不够具体。',
  '   例如：input[placeholder="请选择"] 同时命中多个不同的字段，',
  '   默认取第一个就点到了另一个字段，而输出显示的是"已点击"，看起来完全成功。',
  '   表单字段一律优先用 label；table 里的按钮加 :first-child 之类的限定。',
].join('\n')


/* ══════════════════════════════════════════════════════════════════════════
 * 页面内引擎：定位元素 + 点击 / 输入
 *
 * 这段代码是**注入到网页里执行**的，不是插件自己跑的。它被拼进一个 IIFE，
 * 连同 JSON 化的 opts 一起交给 `do JavaScript`。
 *
 * 用 String.raw 是必须的：普通模板字面量会把 `\s` 吃成 `s`，正则当场失效。
 *
 * 定位策略（真实站点上最容易出错的一环）：
 *   1. 候选里**优先可交互元素**（button/a/[role=button]/input/…）；
 *   2. 同一优先级里取**面积最小**的 —— 否则会点到包住整页的容器上。
 *      「关闭」按钮的祖先 div 面积 23596，按钮本身 2101，选小者才对。
 * ══════════════════════════════════════════════════════════════════════════ */

const IN_PAGE_ENGINE = String.raw`
function __mbVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  var r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  var s = window.getComputedStyle(el);
  if (s.visibility === 'hidden' || s.display === 'none') return false;
  if (Number(s.opacity) === 0) return false;
  return true;
}
function __mbLabel(el) {
  var t = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder'));
  if (!t) {
    // 注意：只有表单控件才认 value。
    //
    // 原来的判断是 el.value !== undefined && el.value !== '' —— 可 li 天生带一个
    // 数字型 value（有序列表的序号，默认 0）。于是每个菜单项的标签都变成 "0"：
    // 快照里整列是 0、点击回显是「0」、连「命中多个」的候选清单也全是 0，等于没标签。
    // 更糟的是按 text 定位时 li 永远匹配不上，只能落到包住整页的祖先 div 上
    // （实测点到过 div#app，页面毫无反应却报「已点击」）。
    // li / option / progress 都有 value，所以按标签判，别按「有没有值」判。
    var isFormField = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' || el.tagName === 'BUTTON';
    var v = isFormField ? el.value : undefined;
    t = (typeof v === 'string' && v !== '') ? v : (el.innerText || el.textContent || '');
  }
  return String(t).replace(/\s+/g, ' ').trim();
}
function __mbArea(el) {
  var r = el.getBoundingClientRect();
  return r.width * r.height;
}
var __MB_POOL = 'button,a,[role="button"],[role="link"],input,textarea,summary,label,span,div,p,li,td,h1,h2,h3';
var __MB_INTERACTIVE = 'button,a,[role="button"],[role="link"],input,textarea,select,summary,[onclick],[tabindex]';
var __MB_CTL = 'input,textarea,select,[role="combobox"],.el-select__wrapper,.el-checkbox,.el-radio,.el-switch';
var __MB_FORMLABEL = 'label,.el-form-item__label,.form-label,[class*="form-label"],[class*="form__label"],[class*="control-label"]';

/**
 * 按**标签文字**定位表单控件 —— 索引无关，表单增删字段也自动跟随。
 *
 * 为什么需要它：位置型定位（nth-child 路径、缓存的 ref/标记）在表单重渲染后
 * 会整体错位。表单在选中某个字段后自动多出 3 个字段，所有索引后移，
 * 按索引点会点到别的字段上（点中过"另一个字段"）。标签是**语义**，不受影响。
 *
 * 也顺带解决分辨率/缩放无关：全程只看 DOM 结构，不依赖任何像素位置。
 *
 * 解析分两轮：先只认真正的表单标签，避免把表格表头之类的同名文字误当标签；
 * 找不到再放宽到任意叶子元素。向上找最近的、**正好含一个控件**的祖先。
 */
function __mbByLabel(want) {
  var target = String(want).trim().replace(/[：:]\s*$/, '');
  if (!target) return [];
  var rounds = [__MB_FORMLABEL, 'th,td,span,div,p,dt,dd'];
  for (var r = 0; r < rounds.length; r++) {
    var pool = document.querySelectorAll(rounds[r]);
    for (var i = 0; i < pool.length; i++) {
      var e = pool[i];
      if (e.children.length > 0) continue;
      if (!__mbVisible(e)) continue;
      var t = String(e.innerText || e.textContent || '').trim().replace(/[：:]\s*$/, '');
      if (t !== target) continue;
      var node = e;
      var depth = 0;
      while (node && depth < 6) {
        var ctls = Array.prototype.slice.call(node.querySelectorAll(__MB_CTL)).filter(__mbVisible);
        // 只保留**最外层**候选：Element Plus 的 el-select 里，wrapper 内部还套着一个
        // role=combobox 的 input，不去重会数成 2 个控件，于是误判"这一层已经越出了单个
        // 字段的范围"而放弃 —— 真实站点上就是这样让 label 定位彻底失效的。
        ctls = ctls.filter(function (c) {
          for (var k = 0; k < ctls.length; k++) {
            if (ctls[k] !== c && ctls[k].contains(c)) return false;
          }
          return true;
        });
        if (ctls.length === 1) return ctls;
        // 一层里出现多个控件说明已经越出"这个字段"的范围 —— 换下一个同名标签
        if (ctls.length > 1) break;
        node = node.parentElement;
        depth++;
      }
    }
  }
  return [];
}
function __mbFind(opts) {
  // ref：直接用上一次 __mbSnapshot 打上的编号定位。这条路径最稳 ——
  // 不用猜选择器、也不受「同名元素有多个」影响。
  if (opts.ref !== undefined && opts.ref !== null && opts.ref !== '') {
    var tagged = document.querySelector('[data-mb-ref="' + String(opts.ref) + '"]');
    return tagged && __mbVisible(tagged) ? [tagged] : [];
  }
  if (opts.selector) {
    return Array.prototype.slice.call(document.querySelectorAll(opts.selector)).filter(__mbVisible);
  }
  // label：按表单标签文字定位。表单会重渲染、字段会增删，位置型定位会错位，
  // 语义不会 —— 这是「不确定分辨率/缩放/字段增删」场景下的首选定位方式。
  if (opts.label) return __mbByLabel(opts.label).filter(__mbVisible);
  var needle = String(opts.text || '');
  var pool = Array.prototype.slice.call(document.querySelectorAll(__MB_POOL));
  var hits = [];
  for (var i = 0; i < pool.length; i++) {
    var el = pool[i];
    var L = __mbLabel(el);
    if (!L) continue;
    if (opts.exact ? L !== needle : L.indexOf(needle) === -1) continue;
    if (!__mbVisible(el)) continue;
    hits.push(el);
  }
  var inter = hits.filter(function (el) { return el.matches(__MB_INTERACTIVE); });
  var use = inter.length > 0 ? inter : hits;
  use.sort(function (a, b) { return __mbArea(a) - __mbArea(b); });
  return use;
}
/**
 * selector 命中多个、而调用方又没给 index —— **宁可不做，也不要默默点第一个**。
 *
 * 为什么：selector 的匹配顺序就是 DOM 顺序，跟"我想点哪个"毫无关系。在真实站点上
 * input[placeholder="请选择"] 这种选择器同时命中多个不同的字段，默认取 index 0
 * 就点到了另一个字段 —— 而且**报了"已点击"，看起来完全成功**。这类错误没有任何信号。
 *
 * 注意只对 selector 生效：text 定位有一套刻意的消歧规则（优先可交互、再取面积最小），
 * 那是设计出来的行为，不该被拦。真要第一个，显式传 index: 0 即可。
 */
function __mbAmbiguity(o, f) {
  // many:true = 调用方只要**计数**（waitFor / expect 数的是"出现了几个"），
  // 命中多个是正常且期望的，绝不能拦 —— 拦了它们会永远等不到、必然超时。
  if (o.many === true) return null;
  if (!o.selector || f.length <= 1 || o.index !== undefined) return null;
  var cands = [];
  for (var i = 0; i < f.length && i < 8; i++) {
    var L = __mbLabel(f[i]).slice(0, 40);
    cands.push(L || (f[i].tagName ? f[i].tagName.toLowerCase() : '?'));
  }
  return {
    ok: false, error: 'ambiguous-selector', count: f.length,
    candidates: cands, tried: o.selector, url: location.href
  };
}
function __mbClick(o) {
  var f = __mbFind(o);
  if (f.length === 0) return { ok: false, error: 'no-match', tried: o.selector || o.text, url: location.href };
  var amb = __mbAmbiguity(o, f);
  if (amb) return amb;
  var el = f[o.index || 0];
  if (!el) return { ok: false, error: 'index-out-of-range', count: f.length, url: location.href };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  if (el.focus) el.focus();
  el.click();
  var r = el.getBoundingClientRect();
  return {
    ok: true, count: f.length, tag: el.tagName.toLowerCase(), id: el.id || '',
    text: __mbLabel(el).slice(0, 60),
    x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
    url: location.href
  };
}
function __mbType(o) {
  var f = __mbFind(o);
  if (f.length === 0) return { ok: false, error: 'no-match', tried: o.selector || o.text, url: location.href };
  var ambT = __mbAmbiguity(o, f);
  if (ambT) return ambT;
  var el = f[o.index || 0];
  if (!el) return { ok: false, error: 'index-out-of-range', count: f.length, url: location.href };
  if (!el.isContentEditable && !/^(input|textarea)$/i.test(el.tagName)) {
    return { ok: false, error: 'not-editable', tag: el.tagName.toLowerCase(), url: location.href };
  }
  // 必须带 inline：宽表（Element Plus 的表格是横向可滚容器）里目标列可能在
  // 视口右侧之外，只做纵向滚动的话控件看不见、屏幕坐标也会落在窗口外。
  // 这里用浏览器自身的滚动，不依赖横向滚轮事件 —— 效果与用户拖横向滚动条一致。
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus();
  if (el.isContentEditable) {
    el.textContent = o.value;
  } else {
    // 走原型上的原生 setter：直接 el.value = v 会被受控组件（React/Vue）
    // 的实例 setter 忽略掉。
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, o.value); else el.value = o.value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  var how = null;
  if (o.submit) {
    // 分流规则全部来自，别改回去：
    //  · 找得到「提交/搜索按钮」→ 点它。合成 click 会触发浏览器的默认提交动作，
    //    站点绑在按钮上的 handler 也会跑 —— 该站点只有这条稳定生效。
    //  · 找不到 → 派发合成回车（纯 JS 搜索框的常见做法）。
    //
    // 为什么不能只看 form：该站点的 form 是装饰性的（无 action、无 onsubmit，
    // 「搜索」是个 div.nav-search-btn），对它 requestSubmit() 什么都不发生。
    // 而合成回车在同一页上**时灵时不灵** —— 第一次成功了，后面几次同样的事件
    // 却毫无反应。所以判据是「有没有可点的提交/搜索按钮」，不是「有没有 form」，
    // 也不能把回车当主力。
    var scopes = [];
    if (el.form) scopes.push(el.form);
    var p = el.parentElement, depth = 0;
    while (p && depth < 3) { scopes.push(p); p = p.parentElement; depth++; }
    var SUBMIT_SEL = 'button[type="submit"],input[type="submit"],button:not([type]),' +
      '[class*="search"][class*="btn"],[class*="search"][class*="button"]';
    var btn = null;
    for (var si = 0; si < scopes.length && btn === null; si++) {
      var cands = Array.prototype.slice.call(scopes[si].querySelectorAll(SUBMIT_SEL)).filter(__mbVisible);
      if (cands.length > 0) btn = cands[0];
    }
    if (btn) {
      btn.click();
      how = 'submit-button';
    } else {
      ['keydown', 'keypress', 'keyup'].forEach(function (t) {
        el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      });
      how = 'enter-keys';
    }
  }
  return {
    ok: true, tag: el.tagName.toLowerCase(), id: el.id || '',
    value: el.value === undefined ? String(el.textContent || '').slice(0, 120) : String(el.value).slice(0, 120),
    submitted: how, url: location.href
  };
}
/**
 * 紧凑页面快照：把「页面上有什么、能点哪里」压成一小段文本 + 编号元素表。
 *
 * 存在理由是**省往返**：没有它，agent 只能一次次写 eval 去 dump DOM，每次都要
 * 自己拼选择器，还可能一次吐出几十 KB。一次 dump 了 214 个元素的
 * 矩形，把上下文撑大、之后每一步都变慢。
 *
 * 元素会被打上 data-mb-ref="N" 属性，之后 mac_browser_click {ref: N} 直接可用 ——
 * 不用猜选择器，也不受「同名元素有多个」影响。
 *
 * 只收**可见**元素，按位置（先上下、再左右）排序，默认最多 60 个。
 */
/**
 * 扫出**必填但为空**的字段 —— 提交前的前置检查。
 *
 * 要解决的问题：指令里没提到某个字段，但它必填。直接点提交会被服务端挡回来，
 * 而错误信息往往是笼统的一句"提示异常"，既不知道是哪个字段，也不知道为什么。
 * 这里在**提交之前**把清单拿出来，交给调用方去问人，而不是自己挑一个值填上
 * （自动挑业务值属于猜测，可能悄悄改掉单据性质）。
 *
 * 三路识别，合并去重：
 *   1. Element Plus 的必填标记 .el-form-item.is-required（Element Plus 在用）
 *   2. 原生 required / aria-required
 *   3. 上述容器里的控件为空
 */
function __mbFormCheck() {
  function labelOf(box) {
    if (!box) return '';
    var l = box.querySelector(__MB_FORMLABEL);
    if (!l) return '';
    return String(l.innerText || l.textContent || '').replace(/[：:]\s*$/, '').replace(/\s+/g, ' ').trim();
  }
  function kindOf(box) {
    if (box.querySelector('.el-select__wrapper')) return 'select';
    if (box.querySelector('.el-checkbox,.el-radio,.el-switch')) return 'choice';
    var e = box.querySelector('input,textarea,select');
    if (!e) return 'other';
    if (e.tagName === 'SELECT') return 'select';
    if (/date|time/i.test(e.getAttribute('placeholder') || '')) return 'date';
    return 'text';
  }
  function isEmpty(box) {
    var wrap = box.querySelector('.el-select__wrapper');
    if (wrap) {
      var t = String(wrap.innerText || '').trim();
      // 没选时 Element Plus 显示的是 placeholder
      return t === '' || /^(请选择|请输入|请先)/.test(t);
    }
    var choices = box.querySelectorAll('.el-checkbox,.el-radio,.el-switch');
    if (choices.length > 0) {
      for (var c = 0; c < choices.length; c++) {
        if (/(^|\s)(is-checked|is-active)(\s|$)/.test(choices[c].className)) return false;
      }
      return true;
    }
    var cs = Array.prototype.slice.call(box.querySelectorAll('input,textarea,select')).filter(function (e) {
      return e.type !== 'hidden' && __mbVisible(e);
    });
    if (cs.length === 0) return false;
    for (var i = 0; i < cs.length; i++) {
      var v = String(cs[i].value === undefined || cs[i].value === null ? '' : cs[i].value).trim();
      if (cs[i].tagName === 'SELECT') {
        if (v !== '' && cs[i].selectedIndex > 0) return false;
      } else if (v !== '') {
        return false;
      }
    }
    return true;
  }

  var found = [];
  var seen = {};
  function add(label, kind) {
    var k = (label || '(无标签)') + '|' + kind;
    if (seen[k]) return;
    seen[k] = 1;
    found.push({ label: label || '(无标签)', kind: kind });
  }
  function kindOfEl(e) {
    if (!e) return 'other';
    if (e.tagName === 'SELECT') return 'select';
    if (/date|time|日期|时间/.test(e.getAttribute('placeholder') || '')) return 'date';
    return 'text';
  }

  // 1) 框架必填标记：整条 form-item 判空（能覆盖 el-select 的 placeholder 态）
  var marked = document.querySelectorAll('.el-form-item.is-required,[class*="form-item"].is-required');
  for (var i = 0; i < marked.length; i++) {
    if (!__mbVisible(marked[i])) continue;
    if (isEmpty(marked[i])) add(labelOf(marked[i]), kindOf(marked[i]));
  }

  // 2) 原生 required / aria-required：按**元素自身**判空（不是整个容器 ——
  //    容器里别的字段有值会掩盖这个空字段），标签仍从容器取。
  var nat = document.querySelectorAll('input[required],select[required],textarea[required],[aria-required="true"]');
  for (var j = 0; j < nat.length; j++) {
    var e = nat[j];
    if (e.type === 'hidden' || !__mbVisible(e)) continue;
    var empty = e.tagName === 'SELECT'
      ? (!e.value || e.selectedIndex <= 0)
      : String(e.value === undefined || e.value === null ? '' : e.value).trim() === '';
    if (!empty) continue;
    var box = e.closest('.el-form-item,.form-group,.form-item,.field') || e.parentElement;
    add(labelOf(box) || e.getAttribute('placeholder') || e.name, kindOfEl(e));
  }

  return { ok: true, count: found.length, items: found, url: location.href };
}
/**
 * 往一个滚动容器里滚一段，并回报「目标文字出现了没」。
 *
 * 为什么需要它：番剧选集、商品列表这类**虚拟列表**一次只渲染 ~20 项，
 * 没渲染出来的元素在 DOM 里根本不存在 —— filter/snapshot 都看不见，
 * 于是只能绕去搜索。真正该做的是「滚一段、找一次、再滚」，循环到出现为止。
 *
 * 这一步只滚一次，循环放在宿主侧：页内没法 await 下一帧，回吐一次反而干净。
 */
function __mbScrollFind(o) {
  var sel = String(o.container || '');
  var needle = String(o.text || '');
  var step = Math.max(50, Math.min(3000, Number(o.step) || 400));
  var box = sel === '' ? null : document.querySelector(sel);

  // 先查一次再滚：目标可能本来就在视野里。不先查的话，第一轮就会白滚 400px，
  // 对着已经到位的列表反复跑会一路越滚越过。
  function find() {
    var pool = Array.prototype.slice.call(document.querySelectorAll(__MB_POOL));
    for (var i = 0; i < pool.length; i++) {
      var el = pool[i];
      var L = __mbLabel(el);
      if (!L || L.indexOf(needle) === -1) continue;
      if (!__mbVisible(el)) continue;
      return el;
    }
    return null;
  }

  var hit = find();
  if (hit !== null) {
    var nowAt = box ? box.scrollTop : window.scrollY;
    return { ok: true, found: true, atEnd: false, scrollTop: Math.round(nowAt), max: 0 };
  }

  var max = 0;
  if (box) {
    box.scrollTop = Math.min(box.scrollHeight, box.scrollTop + step);
    max = Math.max(0, box.scrollHeight - box.clientHeight);
  } else {
    window.scrollBy(0, step);
    max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  }

  hit = find();
  var after = box ? box.scrollTop : window.scrollY;
  return {
    ok: true,
    found: hit !== null,
    atEnd: after >= max - 1,
    scrollTop: Math.round(after),
    max: Math.round(max),
  };
}

function __mbSnapshot(o) {
  var max = o.max && o.max > 0 ? Math.min(200, o.max) : 60;
  // 可见文字块默认只留 400 字（原来是 1200）。它和元素标签高度重叠，却常年占掉
  // 快照一半的体积。要看全页文字就显式传 textMax（最大 8000），传 0 是彻底不要。
  var textMax = (o.textMax === undefined || o.textMax === null)
    ? 400
    : Math.min(8000, Math.max(0, Number(o.textMax) || 0));
  var onlyInteractive = o.only === 'interactive';
  var filter = String(o.filter === undefined || o.filter === null ? '' : o.filter).trim().toLowerCase();

  // 先清掉上一次的编号：否则页面变化后旧 ref 会指向错的东西
  var stale = document.querySelectorAll('[data-mb-ref]');
  for (var k = 0; k < stale.length; k++) stale[k].removeAttribute('data-mb-ref');

  // 候选集不能只认语义标签。真实后台的一级侧边栏是**没有**
  // role / onclick / tabindex 的 div，靠框架的 @click 绑事件 —— 只按语义标签找
  // 会完全看不见它，快照里直接少了整个导航。
  // 所以补一个通用信号：**计算样式里 cursor 是 pointer**。这正是「这东西能点」
  // 的视觉约定，手写的 Vue/React 组件几乎都靠它。only:'interactive' 是显式放弃
  // 这一层兜底、只认语义标签，用来换更小的输出 —— 默认不开，因为漏导航的代价更大。
  var pool = Array.prototype.slice.call(document.querySelectorAll(__MB_POOL));
  var keep = [];
  for (var i = 0; i < pool.length; i++) {
    var el = pool[i];
    if (!__mbVisible(el)) continue;
    var r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;   // 布局残留，不是给人点的
    if (!el.matches(__MB_INTERACTIVE)) {
      if (onlyInteractive) continue;
      // 只有非语义元素才去问计算样式 —— 那一步比 matches() 贵得多
      var cur = '';
      try { cur = window.getComputedStyle(el).cursor; } catch (cursorErr) { cur = '' }
      if (cur !== 'pointer') continue;
    }
    keep.push(el);
  }
  // 去掉「容器」：如果一个候选元素**包含**另一个候选元素，它多半是包装层
  // （Element UI 的 li>a、表格的 tbody、input 外面那圈 div），留着只会让列表
  // 里出现成对的重复项，把真正可点的东西淹掉。
  keep = keep.filter(function (el) {
    for (var n = 0; n < keep.length; n++) {
      if (keep[n] !== el && el.contains(keep[n])) return false;
    }
    return true;
  });

  keep.sort(function (a, b) {
    var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return Math.abs(ra.top - rb.top) > 4 ? ra.top - rb.top : ra.left - rb.left;
  });

  var total = keep.length;

  // filter 要拿 label 比对，所以先算 label、再决定编号：**过滤后重新从 1 编**。
  // 先编号再过滤的话，「第 2 个」还是过滤前的第 2 个，点下去就错位了。
  var scan = filter === '' ? keep.slice(0, max) : keep;
  var prepared = [];
  for (var j = 0; j < scan.length; j++) {
    var e = scan[j];
    var rect = e.getBoundingClientRect();
    var kind = e.tagName.toLowerCase();
    if (kind === 'input') kind = 'input[' + (e.type || 'text') + ']';

    var label = __mbLabel(e).slice(0, 40);
    if (!label) {
      // 图标按钮没有文字、也没有 title/aria。光写「(无标签)」的话，一行里三个
      // 长得一样的按钮就没法区分 —— 而它们往往是查看/编辑/删除，猜错代价很大。
      // 所以补两样东西：**所在行的标识**（表格里通常是编码列）和**同父同类的序号**。
      var rowCtx = '';
      var tr = e.closest ? e.closest('tr') : null;
      if (tr) {
        var tds = tr.querySelectorAll('td');
        for (var q = 0; q < tds.length; q++) {
          var cellText = (tds[q].innerText || '').replace(/\s+/g, ' ').trim();
          if (cellText) { rowCtx = cellText.slice(0, 14); break; }
        }
      }
      var groups = {};
      var sibs = e.parentElement ? e.parentElement.children : [];
      for (var s = 0; s < sibs.length; s++) {
        var key = sibs[s].tagName;
        groups[key] = (groups[key] || 0) + 1;
      }
      var myIndex = 1;
      for (var t = 0; t < sibs.length; t++) {
        if (sibs[t] === e) break;
        if (sibs[t].tagName === e.tagName) myIndex++;
      }
      var sameCount = groups[e.tagName] || 1;
      label = (rowCtx ? rowCtx + ' › ' : '') + '<图标 ' + String(myIndex) + '/' + String(sameCount) + '>';
    }

    prepared.push({
      el: e,
      kind: kind,
      label: label,
      w: Math.round(rect.width),
      h: Math.round(rect.height)
    });
  }

  var matched = filter === '' ? prepared : prepared.filter(function (item) {
    return item.label.toLowerCase().indexOf(filter) >= 0;
  });

  var list = matched.slice(0, max);
  var items = [];
  for (var m = 0; m < list.length; m++) {
    var it = list[m];
    it.el.setAttribute('data-mb-ref', String(m + 1));
    items.push({
      ref: m + 1,
      kind: it.kind,
      label: it.label,
      w: it.w,
      h: it.h,
      disabled: it.el.disabled === true || it.el.getAttribute('aria-disabled') === 'true'
    });
  }

  // 可见文字：**只取视口内的**。
  //
  // 之前用的是 document.body.innerText —— 它不受滚动影响，返回整份文档的
  // 文字。对一个 3000px 的长页，那叫「全页文字」不叫「可见文字」，而且会把
  // 输出撑大（这正是快照显得不够紧凑的原因之一）。
  //
  // 做法：遍历所有元素，只收**直接文本节点**（不取 textContent，避免父子重复
  // 计入），再按矩形与视口求交过滤。
  //
  // 定向快照（给了 filter）**不返回文字块**：目标已经在元素表里了，再附一整段
  // 页面文字纯属浪费。
  var viewportText = '';
  if (textMax > 0 && filter === '') {
    var vw = window.innerWidth, vh = window.innerHeight;
    var pieces = [];
    var chars = 0;
    var nodes = document.body ? document.body.querySelectorAll('*') : [];
    for (var n2 = 0; n2 < nodes.length; n2++) {
      var node = nodes[n2];
      var own = '';
      for (var c = 0; c < node.childNodes.length; c++) {
        if (node.childNodes[c].nodeType === 3) own += node.childNodes[c].nodeValue;
      }
      own = own.replace(/\s+/g, ' ').trim();
      if (!own) continue;
      var nr = node.getBoundingClientRect();
      if (nr.width <= 0 || nr.height <= 0) continue;
      if (nr.bottom <= 0 || nr.top >= vh || nr.right <= 0 || nr.left >= vw) continue;  // 视口外
      var nst = window.getComputedStyle(node);
      if (nst.visibility === 'hidden' || nst.display === 'none') continue;
      pieces.push({ top: nr.top, left: nr.left, text: own });
      chars += own.length;
      if (chars > textMax * 2) break;
    }
    pieces.sort(function (a, b) {
      return Math.abs(a.top - b.top) > 4 ? a.top - b.top : a.left - b.left;
    });
    viewportText = pieces.map(function (p) { return p.text; }).join(' ');
  }

  return {
    ok: true,
    url: location.href,
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight, scrollY: Math.round(window.scrollY) },
    total: total,
    matched: matched.length,
    shown: items.length,
    truncated: matched.length > items.length,
    text: viewportText.slice(0, textMax) + (viewportText.length > textMax ? ' …' : ''),
    elements: items
  };
}

/** 容器的短名字：div#app.el-scrollbar 这种，用来在报告里指认是哪个盒子动了。 */
function __mbBoxName(e) {
  var id = e.id ? '#' + e.id : '';
  var cls = String(e.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
  return (e.tagName.toLowerCase() + id + (cls ? '.' + cls : '')).slice(0, 40);
}

/**
 * 找元素**最近的可滚动祖先** —— 找不到就返回 null，表示由窗口滚动。
 *
 * 为什么需要它：SPA 常把滚动放在内层容器里（Element UI 的 el-scrollbar、
 * 各种 overflow:auto 的 main）。那种页面上 document.scrollHeight 等于
 * 视口高、window.scrollY 恒为 0 —— 按窗口算的话「滚到某元素」会算成 0，
 * 于是明明目标在下面很远，却报「已经在视口里」。
 */
function __mbScrollBox(el) {
  var node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    if (node.scrollHeight - node.clientHeight > 4) {
      var st = window.getComputedStyle(node);
      if (st.overflowY === 'auto' || st.overflowY === 'scroll' || st.overflowY === 'overlay') return node;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * 挑一个**在视口内**、且滚轮事件能落到指定盒子上的点。
 *
 * 两个坑都在这里挡掉：
 *   1. 光标不能停在视口外。目标元素常远在视口下方，直接用它的屏幕坐标
 *      （ y=2519，窗口只到 775）等于把滚轮发到空处 —— 什么都不会滚。
 *   2. 光标底下如果是**别的**可滚动盒子，滚轮就滚那个盒子，不是我们算好的那个。
 *      所以逐点验证 elementFromPoint 的最近可滚动祖先确实是我们想要的盒子。
 *
 * box 为 null 表示要滚的是窗口本身 —— 那就得找一个底下没有内层可滚动盒子的点。
 */
function __mbPointFor(box) {
  var vw = window.innerWidth;
  var vh = window.innerHeight;
  var r = box
    ? box.getBoundingClientRect()
    : { left: 0, top: 0, width: vw, height: vh };
  var frac = [[0.5, 0.5], [0.5, 0.3], [0.5, 0.7], [0.3, 0.5], [0.7, 0.5], [0.5, 0.15], [0.5, 0.85]];
  for (var i = 0; i < frac.length; i++) {
    var px = r.left + r.width * frac[i][0];
    var py = r.top + r.height * frac[i][1];
    if (px < 4 || py < 4 || px > vw - 4 || py > vh - 4) continue;
    var el = document.elementFromPoint(px, py);
    if (!el) continue;
    if (__mbScrollBox(el) === box) return { x: Math.round(px), y: Math.round(py) };
  }
  // 兜底：夹进视口 —— 宁可试着滚，也不要发到窗口外面去
  return {
    x: Math.round(Math.min(Math.max(r.left + r.width / 2, 4), vw - 4)),
    y: Math.round(Math.min(Math.max(r.top + r.height / 2, 4), vh - 4))
  };
}

/**
 * 算出「把某个元素滚进视口」需要滚多少像素 —— **只算，不动**。
 * 真正的滚动交给调用方发真实滚轮事件，这样目标精确、动作又是真的。
 * 返回的 delta 为正表示需要**向下**滚。
 */
function __mbScrollDelta(o) {
  var f = __mbFind(o);
  if (f.length === 0) {
    return { ok: false, error: 'no-match', tried: o.selector || o.text || ('ref=' + String(o.ref)), url: location.href };
  }
  var ambS = __mbAmbiguity(o, f);
  if (ambS) return ambS;
  var el = f[o.index || 0];
  if (!el) return { ok: false, error: 'index-out-of-range', count: f.length, url: location.href };
  var offset = typeof o.offset === 'number' ? o.offset : 120;
  var box = __mbScrollBox(el);
  var chromeH = window.outerHeight - window.innerHeight;
  var r = el.getBoundingClientRect();
  // 光标停在**要滚的那个盒子**上，而不是目标元素上：元素多半在视口外，
  // 用它的坐标会把滚轮发到窗口外面去；盒子则一定有一块在视口里。
  var vp = __mbPointFor(box);
  var base = {
    ok: true,
    text: __mbLabel(el).slice(0, 40),
    // 同样只给视口 CSS 像素，屏幕点由宿主按窗口几何换算（理由见 __mbLocate）
    vp: { x: vp.x, y: vp.y },
    vpGeo: {
      innerW: window.innerWidth, innerH: window.innerHeight,
      outerW: window.outerWidth, outerH: window.outerHeight,
      chromeH: chromeH
    },
    url: location.href
  };
  if (box) {
    var cur = box.scrollTop;
    var maxY = Math.max(0, box.scrollHeight - box.clientHeight);
    var target = Math.max(0, Math.min(cur + (r.top - box.getBoundingClientRect().top) - offset, maxY));
    base.delta = Math.round(target - cur);
    base.from = Math.round(cur);
    base.to = Math.round(target);
    base.maxY = Math.round(maxY);
    base.box = __mbBoxName(box);
    base.scope = 'container';
    return base;
  }
  var abs = r.top + window.scrollY;
  var wMax = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  var wTarget = Math.max(0, Math.min(abs - offset, wMax));
  base.delta = Math.round(wTarget - window.scrollY);
  base.from = Math.round(window.scrollY);
  base.to = Math.round(wTarget);
  base.maxY = Math.round(wMax);
  base.scope = 'window';
  return base;
}

/**
 * 读出**所有可能被滚轮滚到的盒子**的当前位置 —— 用来做滚动前后的对比。
 *
 * 只看 window.scrollY 是不够的：SPA 把滚动放在内层容器里时它永远是 0，
 * 即使滚轮真的滚动了页面也会报「没动」。所以这里连同每个可滚动容器一起读，
 * 由调用方做前后 diff，谁动了就说谁。
 *
 * visibility 是关键信号：真实滚轮事件按屏幕坐标发出，只会落到**当前可见的
 * 那一页**上。后台标签页拿到的是同一个屏幕坐标，却什么也滚不到。
 */
function __mbScrollState() {
  var list = [];
  var all = document.querySelectorAll('div,main,section,article,ul,ol,table,form');
  for (var i = 0; i < all.length; i++) {
    var e = all[i];
    var room = e.scrollHeight - e.clientHeight;
    if (room < 24) continue;
    var st = window.getComputedStyle(e);
    if (st.overflowY !== 'auto' && st.overflowY !== 'scroll' && st.overflowY !== 'overlay') continue;
    list.push({ name: __mbBoxName(e), top: Math.round(e.scrollTop), max: Math.round(room) });
    if (list.length >= 40) break;
  }
  return {
    ok: true,
    visibility: document.visibilityState,
    windowY: Math.round(window.scrollY),
    windowMax: Math.round(Math.max(0, document.documentElement.scrollHeight - window.innerHeight)),
    geo: {
      x: window.screenX, y: window.screenY,
      chromeH: window.outerHeight - window.innerHeight,
      w: window.outerWidth, h: window.outerHeight,
      vw: window.innerWidth, vh: window.innerHeight
    },
    list: list
  };
}

/**
 * 只定位、不发合成事件：返回元素中心的**屏幕坐标**，交给 System Events 发
 * 真实鼠标事件。
 *
 * 坐标系换算 —— System Events 用的是「屏幕左上角为原点、单位为点」的全局坐标：
 *   x = window.screenX + 视口内 x
 *   y = window.screenY + 浏览器 chrome 高度 + 视口内 y
 * chrome 高度用 outerHeight - innerHeight 近似。
 * 已知局限：多显示器时 screenX/screenY 的原点未必是主屏左上角，坐标会偏；
 * 所以返回值里同时带上 viewport 与 screen 原始值，便于对不上时排查。
 */
function __mbLocate(o) {
  var f = __mbFind(o);
  if (f.length === 0) return { ok: false, error: 'no-match', tried: o.selector || o.text || o.label || ('ref=' + String(o.ref)), url: location.href };
  var ambL = __mbAmbiguity(o, f);
  if (ambL) return ambL;
  var el = f[o.index || 0];
  if (!el) return { ok: false, error: 'index-out-of-range', count: f.length, url: location.href };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  if (o.focus && el.focus) el.focus();
  var r = el.getBoundingClientRect();
  var chromeH = window.outerHeight - window.innerHeight;
  // 这里**只给视口内的 CSS 像素**，不给屏幕坐标。
  // 原因：getBoundingClientRect 是 CSS 像素，鼠标事件要的是屏幕点，浏览器缩放
  // 不等于 100% 时两者不能相加（缩得越小偏得越多），而实际分辨率与缩放事先不可知。
  // 换算交给宿主：用比例映射到窗口内容区的点尺寸，比例对缩放免疫。
  return {
    ok: true, count: f.length, tag: el.tagName.toLowerCase(), id: el.id || '',
    text: __mbLabel(el).slice(0, 60),
    vp: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
    vpRect: {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.max(1, Math.round(r.width)),
      h: Math.max(1, Math.round(r.height))
    },
    vpGeo: {
      innerW: window.innerWidth, innerH: window.innerHeight,
      outerW: window.outerWidth, outerH: window.outerHeight,
      chromeH: chromeH
    },
    visibility: document.visibilityState,
    url: location.href
  };
}
`

/** 把引擎与参数拼成一个可交给 do JavaScript 的表达式。 */
function buildInPageSource(action, options) {
  return (
    '(function(){ var opts = ' +
    JSON.stringify(options) +
    ';' +
    IN_PAGE_ENGINE +
    'return JSON.stringify(' +
    action +
    '(opts)); })()'
  )
}

/* ══════════════════════════════════════════════════════════════════════════
 * 后端注册表 —— 唯一的扩展点
 * ══════════════════════════════════════════════════════════════════════════ */

const backendFactories = new Map()

/**
 * 注册一个可插拔后端。返回反注册函数。
 * factory() 必须返回至少 { id, label, transport }；AppleScript 后端还需要
 * app / titleProp / currentTab / bundlePaths / processName。
 */
export function registerBackend(id, factory) {
  if (typeof id !== 'string' || id.length === 0) throw new Error('registerBackend: id 必须是非空字符串')
  if (typeof factory !== 'function') throw new Error('registerBackend: factory 必须是函数')
  backendFactories.set(id, factory)
  return () => backendFactories.delete(id)
}

/** 已注册的后端 id（不实例化）。 */
export function backendIds() {
  return [...backendFactories.keys()]
}

/**
 * 能力矩阵 —— 工具层据此在**动手前**就给出明确错误，而不是让不支持的平台
 * 静默失败、或抛一个调用方看不懂的底层报错。
 *
 * 为什么必须显式：Windows 上不存在 AppleScript，页面级能力（列标签页 / 读正文 /
 * 执行 JS / 页内点击输入）要靠 Chrome DevTools Protocol 才有，目前没接。
 * 把这些标成 false，调用方拿到的就是「此路不通 + 为什么」，而不是一句
 * "osascript 找不到"。
 */
const MAC_CAPS = { activate: true, open: true, tabs: true, read: true, eval: true, close: true, realInput: true, screenshot: true }

// Windows 当前只做 OS 层。页面级一律 false —— 是「本平台没接」，不是「还没写」。
// screenshot 也 false：PowerShell 侧还没接截图，别让调用方以为有。
const WIN_CAPS = { activate: true, open: true, tabs: false, read: false, eval: false, close: false, realInput: true, screenshot: false }

/** AppleScript 后端（macOS）。差异全部落在 spec 上。 */
function applescriptBackend(spec) {
  return {
    id: spec.id,
    label: spec.label,
    platform: 'darwin',
    transport: 'applescript',
    caps: { ...MAC_CAPS },
    app: spec.app,
    titleProp: spec.titleProp,
    currentTab: spec.currentTab,
    currentTabIndex: spec.currentTabIndex,
    activeIndex: spec.activeIndex,
    bundlePaths: spec.bundlePaths,
    processName: spec.processName,
  }
}

/**
 * Windows 后端 —— **只覆盖 OS 层**：打开 / 唤起 / 真实鼠标键盘。
 *
 * 用 PowerShell + Win32，全部挑最经典、最稳妥的调用：
 *   · 打开        Start-Process
 *   · 唤起        SetForegroundWindow（必要时先 ShowWindow 还原最小化）
 *   · 真实鼠标    SetCursorPos + mouse_event（不用 SendInput 的 INPUT 结构体 ——
 *                 那个结构在 x64 与 x86 上 union 偏移不同，盲写必踩）
 *   · 真实键盘    **剪贴板 + Ctrl+V**。选它是因为 Unicode 走 SendInput 需要
 *                 逐字符填 INPUT 结构，风险高；粘贴一条真实按键事件就够，
 *                 且中文、emoji 都稳。代价见 README（会占用剪贴板；少数
 *                 禁用粘贴的输入框不适用）。
 *
 * Windows 上**没有** macOS 那套「辅助功能」授权，不需要任何开关。
 * 唯一的门槛是 UIPI：目标窗口若以管理员权限运行，非管理员进程发不进事件。
 *
 * ⚠️ 本后端**尚未在真实 Windows 环境中验证**（开发机是 macOS，且没有 pwsh 可做语法检查）。
 * 拿到 Windows 机器后跑 selftest 即可回归。
 */
function powershellBackend(spec) {
  return {
    id: spec.id,
    label: spec.label,
    platform: 'win32',
    transport: 'powershell',
    caps: { ...WIN_CAPS },
    processNames: spec.processNames,
    bundlePaths: spec.bundlePaths,
    urlPrefix: spec.urlPrefix,
  }
}

const IS_WIN = typeof process !== 'undefined' && process.platform === 'win32'

if (IS_WIN) {
  // Windows：Chrome / Edge 都走同一套 PowerShell 实现，只有进程名与可执行路径不同。
  registerBackend('chrome', () =>
    powershellBackend({
      id: 'chrome',
      label: 'Google Chrome',
      processNames: ['chrome'],
      bundlePaths: [
        `${process.env['ProgramFiles'] || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env['LOCALAPPDATA'] || ''}\\Google\\Chrome\\Application\\chrome.exe`,
      ],
    }),
  )
  registerBackend('edge', () =>
    powershellBackend({
      id: 'edge',
      label: 'Microsoft Edge',
      processNames: ['msedge'],
      bundlePaths: [
        `${process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${process.env['ProgramFiles'] || 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ],
    }),
  )
} else {
  registerBackend('chrome', () =>
    applescriptBackend({
      id: 'chrome',
      label: 'Google Chrome',
      app: 'Google Chrome',
      titleProp: 'title',
      currentTab: 'active tab',
      //  Chrome 152：`index of <tab>` 读不了（转 text/integer 都 -1700，
      // 赋值 -1728），只有 `active tab index` 可读。Safari 上两者都行。
      currentTabIndex: 'active tab index of w',
      // 不依赖循环变量 t 的「当前页序号」表达式，给列标签页那种场合用。
      activeIndex: 'active tab index of w',
      bundlePaths: ['/Applications/Google Chrome.app'],
      processName: 'Google Chrome',
    }),
  )

  registerBackend('safari', () =>
    applescriptBackend({
      id: 'safari',
      label: 'Safari',
      app: 'Safari',
      titleProp: 'name',
      currentTab: 'current tab',
      currentTabIndex: 'index of t',
      activeIndex: 'index of current tab of w',
      // Safari 在较新 macOS 上可能只以 Cryptex 形式存在，两个路径都探。
      bundlePaths: [
        '/Applications/Safari.app',
        '/System/Cryptexes/App/System/Applications/Safari.app',
        '/System/Applications/Safari.app',
      ],
      processName: 'Safari',
    }),
  )
}

/* ══════════════════════════════════════════════════════════════════════════
 * AppleScript 源码
 * 统一约定：字段用 US(\u001f)、记录用 RS(\u001e) 分隔，参数从 argv 来。
 * ══════════════════════════════════════════════════════════════════════════ */

function asListTabs(be) {
  return [
    'on run argv',
    '  set fs to character id 31',
    '  set rs to character id 30',
    '  set out to {}',
    `  tell application "${be.app}"`,
    '    if (count of windows) is 0 then return ""',
    '    set wi to 0',
    '    repeat with w in windows',
    '      set wi to wi + 1',
    '      set ti to 0',
    // 当前页的判据：拿**循环计数器**和别人比，不要 `index of t` ——
    // Chrome 152 上 `index of <tab>` 读不出来（-1700，见上面几处同样的坑），
    // 而这里的 try 会把异常吞掉，结果就是「Chrome 上永远没有 ▶」，
    // 谁也看不出当前停在哪个标签页。ti 本来就是 1-based 序号，比它更可靠。
    `      set curIdx to (${be.activeIndex}) as integer`,
    '      repeat with t in tabs of w',
    '        set ti to ti + 1',
    '        set act to "false"',
    '        if ti is curIdx then set act to "true"',
    '        set tname to ""',
    '        try',
    `          set tname to ${be.titleProp} of t`,
    '        end try',
    '        set turl to ""',
    '        try',
    '          set turl to URL of t',
    '        end try',
    '        set end of out to (wi as text) & fs & (ti as text) & fs & act & fs & tname & fs & turl',
    '      end repeat',
    '    end repeat',
    '  end tell',
    "  set AppleScript's text item delimiters to rs",
    '  return out as text',
    'end run',
  ].join('\n')
}

function asOpenTab(be) {
  if (be.id === 'safari') {
    return [
      'on run argv',
      '  set theURL to item 1 of argv',
      '  tell application "Safari"',
      '    activate',
      '    if (count of windows) is 0 then',
      '      make new document with properties {URL:theURL}',
      '    else',
      '      tell front window',
      '        set current tab to (make new tab with properties {URL:theURL})',
      '      end tell',
      '    end if',
      '    delay 0.4',
      '    return (name of current tab of front window) & (character id 31) & (URL of current tab of front window)',
      '  end tell',
      'end run',
    ].join('\n')
  }
  return [
    'on run argv',
    '  set theURL to item 1 of argv',
    '  tell application "Google Chrome"',
    '    activate',
    '    if (count of windows) is 0 then make new window',
    '    tell front window',
    '      make new tab at end of tabs with properties {URL:theURL}',
    // 不能用 `set active tab index to (index of newTab)`：Chrome 152 上
    // `index of` 一个刚创建的 tab 返回的是 tab id 引用（不是整数），赋值报
    // -10006「不能将 index of tab id … 设置为 …」—— 标签建出来了，脚本却抛错，
    // 于是 open 报失败而实际成功。新建后在末尾，index 就等于 count of tabs。
    '      set active tab index to (count of tabs)',
    '    end tell',
    '    delay 0.4',
    '    return (title of active tab of front window) & (character id 31) & (URL of active tab of front window)',
    '  end tell',
    'end run',
  ].join('\n')
}

function asActivate(be) {
  return `tell application "${be.app}" to activate`
}

/**
 * 真实鼠标：把光标**平滑移动**过去，再按下/抬起左键。
 *
 * 为什么不用 `System Events` 的 `click at {x,y}`：它只在该坐标发一个点击事件，
 * **不移动可见光标** —— 用户完全看不到动静（这就是"没看到鼠标移动"的原因；
 * Windows 那边用的是 SetCursorPos，所以那边反而会动）。
 *
 * 改用 JXA + CoreGraphics：`CGEventCreateMouseEvent` + `CGEventPost` 是真的
 * 鼠标事件 —— 光标会走过去、沿途产生 mouseMoved（悬停菜单能响应），
 * 而且 isTrusted=true。
 *
 * /usr/bin/osascript 支持 `-l JavaScript`，CoreGraphics 桥可用，
 * **不需要 cliclick / pyobjc / 编译任何东西**。
 *
 * 坐标由我们自己 Math.round 成整数再内嵌，没有注入面。
 *
 * 速度由 `config.pointer` 控制。默认 48 步 × 20ms ≈ 0.96s **并带缓动** ——
 * 匀速直线看起来像"被拖过去"，ease-in-out（起步慢、中间快、收尾停住）才像人。
 * 之前的 18×12ms≈0.22s 用户反馈"一闪而过"，所以默认值调慢且可配。
 */
function jxaPointer(appName, x, y, click, pointer) {
  const cfg = pointer || {}
  const steps = Math.min(400, Math.max(2, Number.isInteger(cfg.steps) ? cfg.steps : 48))
  const stepMs = Math.min(200, Math.max(1, Number.isInteger(cfg.stepMs) ? cfg.stepMs : 20))
  const easeExpr =
    cfg.easing === 'linear'
      ? 'function ease(t) { return t }'
      : 'function ease(t) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2 }'
  const tx = Number.isFinite(Number(x)) ? Math.round(Number(x)) : 0
  const ty = Number.isFinite(Number(y)) ? Math.round(Number(y)) : 0
  return [
    "ObjC.import('CoreGraphics')",
    `Application(${JSON.stringify(appName)}).activate()`,
    'delay(0.35)',
    `var tx = ${tx}, ty = ${ty}`,
    'function post(t, x, y) { $.CGEventPost(0, $.CGEventCreateMouseEvent($(), t, $.CGPointMake(x, y), 0)) }',
    easeExpr,
    'var p = $.CGEventGetLocation($.CGEventCreate($()))',
    'var sx = p.x, sy = p.y',
    `var steps = ${steps}`,
    `for (var i = 1; i <= steps; i++) { var e = ease(i / steps); post(5, sx + (tx - sx) * e, sy + (ty - sy) * e); delay(${stepMs} / 1000) }`,
    'post(5, tx, ty)',
    'delay(0.06)',
    click ? 'post(1, tx, ty); delay(0.07); post(2, tx, ty)' : '/* 只移动，不点击 */',
    `JSON.stringify({ from: { x: Math.round(sx), y: Math.round(sy) }, to: { x: tx, y: ty }, clicked: ${click ? 'true' : 'false'} })`,
  ].join('\n')
}

/**
 * 真实滚轮滚动（CGEvent）。
 *
 * 用 `CGEventCreateScrollWheelEvent2` 而**不是**变参的 `CGEventCreateScrollWheelEvent`
 * —— 后者在 JXA 的 C 桥里没法传可变参数，只有非变参这个版本能调通。
 *
 * （macOS 26 / Safari）：`units=0` 就是像素，`wheel1` **负值向下、正值向上**，
 * 而且**精确** —— 8 次 × -80 正好滚 640px（67 → 707，分毫不差）。
 *
 * ⚠️ 滚轮事件作用于**光标所在的窗口**，所以必须先激活浏览器、再把光标放进页面，
 * 否则滚的是别的窗口。这一步不做，会得到"命令成功但页面没动"的假成功。
 */
function jxaScroll(appName, x, y, deltaY, steps, stepMs) {
  const cx = Math.round(Number(x))
  const cy = Math.round(Number(y))
  const total = Math.round(Number(deltaY))
  const n = Math.min(80, Math.max(1, Number.isInteger(steps) ? steps : 12))
  const per = total === 0 ? 0 : (total < 0 ? -1 : 1) * Math.max(1, Math.round(Math.abs(total) / n))
  return [
    "ObjC.import('CoreGraphics')",
    `Application(${JSON.stringify(appName)}).activate()`,
    'delay(0.35)',
    `var cx = ${cx}, cy = ${cy}`,
    'function move(t, x, y) { $.CGEventPost(0, $.CGEventCreateMouseEvent($(), t, $.CGPointMake(x, y), 0)) }',
    'function wheel(dy) { $.CGEventPost(0, $.CGEventCreateScrollWheelEvent2($(), 0, 1, dy, 0, 0)) }',
    'move(5, cx, cy)',
    'delay(0.2)',
    `var steps = ${n}, per = ${per}`,
    `for (var i = 0; i < steps; i++) { wheel(per); delay(${stepMs} / 1000) }`,
    `JSON.stringify({ at: { x: cx, y: cy }, deltaY: ${total}, steps: steps, per: per })`,
  ].join('\n')
}

/**
 * 真实键盘输入。
 *
 * ⚠️ 中文**不能**用 keystroke 直接送 —— 这是出来的：
 * 在挂着拼音输入法（com.apple.inputmethod.SCIM.ITABC）的系统上，
 * `keystroke` 直接送中文会被输入法截走，落进输入框的是 "a a" 这种乱码。
 * keystroke 送的是 Unicode 字符，而输入法只认「键」。
 *
 * 所以文本一律走「写剪贴板 + Cmd+V」：v 是 ASCII，不受输入法影响，
 * 任何 Unicode（中文 / emoji）都稳。Windows 侧是同一套做法，两边语义一致。
 *
 * 代价：会占用系统剪贴板。脚本开始前尽力存下原有的**文本**剪贴板，
 * 粘贴完再还原；原本若是图片等非文本内容则只能被替换（尽力而为，不假装能保全）。
 *
 * 先 Cmd+A 全选再粘贴，保证「整体替换」语义与页内模式一致。
 *
 * 注意它**只负责键盘**：激活窗口、把光标移过去、点中目标，都由调用方先用
 * `jxaPointer()` 做完（这样鼠标是可见地走过去的，而不是偷偷点一下）。
 * argv = [要输入的文本]。
 */
function asRealType(submit) {
  const lines = [
    'on run argv',
    '  set theText to item 1 of argv',
    '  set savedClip to ""',
    '  set hadText to false',
    '  try',
    '    set savedClip to (the clipboard as text)',
    '    if savedClip is not "" then set hadText to true',
    '  end try',
    '  set the clipboard to theText',
    '  delay 0.12',
    '  tell application "System Events"',
    '    keystroke "a" using command down',
    '    delay 0.08',
    '    keystroke "v" using command down',
  ]
  if (submit) {
    lines.push('    delay 0.2')
    lines.push('    key code 36')
  }
  lines.push('  end tell')
  lines.push('  delay 0.25')
  lines.push('  if hadText then')
  lines.push('    try')
  lines.push('      set the clipboard to savedClip')
  lines.push('    end try')
  lines.push('  end if')
  lines.push('  return "typed"')
  lines.push('end run')
  return lines.join('\n')
}

/** 辅助功能权限探针：读最前面进程的窗口数，未授权必然抛错。 */
function asAccessibilityProbe() {
  return [
    'tell application "System Events"',
    '  set p to first application process whose frontmost is true',
    '  return (count of windows of p) as text',
    'end tell',
  ].join('\n')
}

/**
 * 取**地址栏**的矩形 —— 它属于浏览器 chrome，页面 JS 拿不到，只能走无障碍树。
 *
 * 不写死索引：Safari 的地址栏在 toolbar 的第三个 group 里，但这个结构会随
 * 版本/窗口状态变化。这里做一次深度有界的递归搜索，取**第一个** AXTextField。
 *  Safari 命中 `@404,47 463x31  desc=智能搜索栏`，中心 (636,63)。
 *
 * 返回 `x␟y␟w␟h`；失败返回 `ERR␟原因`。
 */
function asAddressFieldRect(be) {
  return [
    'on run',
    '  tell application "System Events"',
    `    tell process "${be.app}"`,
    '      if (count of windows) is 0 then return "ERR" & (character id 31) & "no window"',
    '      set r to missing value',
    '      try',
    '        set r to my findField(window 1, 0)',
    '      on error errMsg',
    '        return "ERR" & (character id 31) & errMsg',
    '      end try',
    '      if r is missing value then return "ERR" & (character id 31) & "在无障碍树里找不到地址栏输入框（AXTextField）"',
    '      set fs to character id 31',
    '      return ((item 1 of r) as text) & fs & ((item 2 of r) as text) & fs & ((item 3 of r) as text) & fs & ((item 4 of r) as text)',
    '    end tell',
    '  end tell',
    'end run',
    '',
    // handler 定义在 tell 块**外面**，编译器不认识 System Events 的专有术语
    // （UI elements / role）—— 必须用 using terms from 把它的词典引进来，
    // 否则 osacompile 报 "Expected , but found identifier"，而且是编译期就失败。
    'using terms from application "System Events"',
    '',
    'on findField(container, depth)',
    '  if depth > 4 then return missing value',
    '  try',
    '    repeat with c in (UI elements of container)',
    '      try',
    '        if (role of c) is "AXTextField" then',
    '          set p to position of c',
    '          set s to size of c',
    '          return {item 1 of p, item 2 of p, item 1 of s, item 2 of s}',
    '        end if',
    '      end try',
    '    end repeat',
    '  end try',
    '  try',
    '    repeat with c in (UI elements of container)',
    '      try',
    '        set r to my findField(c, depth + 1)',
    '        if r is not missing value then return r',
    '      end try',
    '    end repeat',
    '  end try',
    '  return missing value',
    'end findField',
    '',
    'end using terms from',
  ].join('\n')
}

/**
 * 浏览器窗口的屏幕矩形。返回 `x␟y␟w␟h` 或 `ERR␟原因`。
 *
 * 优先问浏览器**自己**（`bounds of front window`），不去问 System Events。
 *
 * 为什么：System Events 看到的是**辅助功能树里的窗口列表**，Chrome 会把弹层、
 * 工具窗、扩展气泡也塞进去，而且顺序跟「用户眼里的主窗口」不一定一致。
 * 实测踩到：Chrome 有 2 个 AX 窗口，`window 1` 取到的是个 362x180 的小窗 ——
 * 于是真实鼠标点击的屏幕坐标、截图裁剪区域**全部按这个小窗算**，点哪儿都偏，
 * 却依然报「已点击」。而 `bounds of front window` 给的是 (0,29,1280,775)，
 * 一眼就对。Safari 同样支持 bounds，且两条都不依赖辅助功能。
 */
function asWindowRectNative(be) {
  return [
    'on run',
    '  set fs to character id 31',
    `  tell application "${be.app}"`,
    '    if (count of windows) is 0 then return "ERR" & fs & "no window"',
    '    set b to bounds of window 1',
    '    return ((item 1 of b) as text) & fs & ((item 2 of b) as text) & fs & ' +
      '(((item 3 of b) - (item 1 of b)) as text) & fs & (((item 4 of b) - (item 2 of b)) as text)',
    '  end tell',
    'end run',
  ].join('\n')
}

/** 退路：浏览器不认 `bounds` 时，退回 System Events 的 AX 窗口。 */
function asWindowRect(be) {
  return [
    'on run',
    '  tell application "System Events"',
    `    tell process "${be.app}"`,
    '      if (count of windows) is 0 then return "ERR" & (character id 31) & "no window"',
    '      set p to position of window 1',
    '      set s to size of window 1',
    '      set fs to character id 31',
    '      return ((item 1 of p) as text) & fs & ((item 2 of p) as text) & fs & ((item 1 of s) as text) & fs & ((item 2 of s) as text)',
    '    end tell',
    '  end tell',
    'end run',
  ].join('\n')
}

/**
 * 截图失败的中文指引。
 *
 * 缺「屏幕录制」权限时 `screencapture` 报
 * `could not create image from display` / `could not create image from rect`
 * —— 全屏与指定矩形**都**失败。这和辅助功能、自动化是三个独立授权项。
 */
function screenRecordingHint(raw) {
  const s = String(raw || '')
  if (/could not create image|not authorized|ScreenCaptureKit|declined|TCC/i.test(s)) {
    return (
      '截图需要「屏幕录制」权限（与辅助功能、自动化是三项独立授权）：\n' +
      '  系统设置 → 隐私与安全性 → 屏幕录制 → 打开「DSH Desktop」。\n' +
      '  列表里若没有它，点「+」，Cmd+Shift+G 前往 /usr/sbin 选 screencapture（或 /usr/bin 选 osascript），添加后重启。'
    )
  }
  return ''
}

/** 读 PNG 头的 IHDR 拿像素尺寸 —— 纯 JS，不用再 spawn 一个 sips。 */
async function pngSize(path) {
  try {
    const buf = await readFile(path)
    if (buf.length < 24) return undefined
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  } catch {
    return undefined
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * Windows（PowerShell）—— 只覆盖 OS 层
 *
 * 全部挑最经典、最稳妥的 Win32 调用：
 *   · 打开      Start-Process
 *   · 唤起      SetForegroundWindow（最小化时先 ShowWindow 还原）
 *   · 真实鼠标  SetCursorPos + mouse_event
 *   · 真实键盘  剪贴板 + Ctrl+V
 *
 * 刻意**不用** SendInput 的 INPUT 结构体：那个 union 在 x64 与 x86 上的字段
 * 偏移不同（x64 是 8 字节对齐），盲写必踩，而本机没有 pwsh 可做校验。
 * mouse_event / SendKeys 虽然老，但行为稳定、语义清楚。
 *
 * 参数不拼进命令行，而是以 PowerShell 单引号字面量内嵌；单引号在 PS 里靠
 * 写两遍转义（''），没有任何注入面。
 * ══════════════════════════════════════════════════════════════════════════ */

/** PowerShell 单引号字面量：内部单引号写两遍即可，其余字符原样。 */
export function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/** 供各脚本复用的 Win32 声明（PowerShell here-string，标记必须在行首）。 */
const PS_WIN32 = [
  "Add-Type @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class MBWin {',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
  '  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);',
  '}',
  "'@",
].join('\n')

/** 打开 URL；url 为空则只启动浏览器。 */
export function psOpen(exe, url) {
  return [
    `$exe = ${psQuote(exe)}`,
    `$url = ${psQuote(url)}`,
    'if ($url -ne "") { Start-Process -FilePath $exe -ArgumentList $url } else { Start-Process -FilePath $exe }',
    'Write-Output "ok"',
  ].join('\n')
}

/** 唤起窗口：优先取有主窗口句柄的那个进程。 */
export function psActivate(be) {
  return [
    PS_WIN32,
    `$names = @(${be.processNames.map(psQuote).join(', ')})`,
    '$p = Get-Process -Name $names -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
    'if (-not $p) { Write-Output "not-running"; exit 0 }',
    'if ([MBWin]::IsIconic($p.MainWindowHandle)) { [void][MBWin]::ShowWindow($p.MainWindowHandle, 9) }',
    '[void][MBWin]::SetForegroundWindow($p.MainWindowHandle)',
    'Write-Output "ok"',
  ].join('\n')
}

/** 真实鼠标点击：先挪光标，再按下 / 抬起左键。 */
export function psRealClick(x, y) {
  return [
    PS_WIN32,
    `[void][MBWin]::SetCursorPos(${String(x)}, ${String(y)})`,
    'Start-Sleep -Milliseconds 80',
    '[MBWin]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)',
    'Start-Sleep -Milliseconds 50',
    '[MBWin]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)',
    'Write-Output "clicked"',
  ].join('\n')
}

/**
 * 真实键盘输入：剪贴板 + Ctrl+V。
 * Windows 上送 Unicode 走 SendInput 要逐字符填 INPUT 结构（见文件头说明），
 * 粘贴一条真实按键事件就够，且中文 / emoji 都稳。
 * 代价：会占用系统剪贴板；少数禁用粘贴的输入框不适用。
 */
export function psRealType(text, submit) {
  const lines = [
    'Add-Type -AssemblyName System.Windows.Forms',
    `Set-Clipboard -Value ${psQuote(text)}`,
    'Start-Sleep -Milliseconds 80',
    "[System.Windows.Forms.SendKeys]::SendWait('^a')",
    'Start-Sleep -Milliseconds 60',
    "[System.Windows.Forms.SendKeys]::SendWait('^v')",
  ]
  if (submit) {
    lines.push('Start-Sleep -Milliseconds 150')
    lines.push("[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')")
  }
  lines.push('Write-Output "typed"')
  return lines.join('\n')
}

/**
 * 读正文 / 执行 JS 共用一份脚本。
 * argv = [窗口, 标签, (仅 eval) JS 源码]；窗口或标签为 0 表示“前台窗口的当前标签”。
 */
function asTabScript(be, mode) {
  const evalJs = be.id === 'safari' ? 'do JavaScript jsSource in t' : 'execute t javascript jsSource'
  const readJs =
    be.id === 'safari'
      ? 'do JavaScript "document.body.innerText" in t'
      : 'execute t javascript "document.body.innerText"'
  const lines = [
    'on run argv',
    '  set wi to (item 1 of argv) as integer',
    '  set ti to (item 2 of argv) as integer',
    `  tell application "${be.app}"`,
    '    if (count of windows) is 0 then return "ERR" & (character id 31) & "no window"',
    '    if wi is 0 then',
    '      set w to front window',
    '    else',
    '      set w to window wi',
    '    end if',
    '    if ti is 0 then',
    `      set t to ${be.currentTab} of w`,
    '    else',
    '      set t to tab ti of w',
    '    end if',
    '    set tname to ""',
    '    try',
    `      set tname to ${be.titleProp} of t`,
    '    end try',
    '    set turl to ""',
    '    try',
    '      set turl to URL of t',
    '    end try',
  ]
  if (mode === 'eval') {
    lines.push('    set jsSource to item 3 of argv')
    lines.push(`    set payload to ((${evalJs}) as text)`)
  } else {
    lines.push('    set payload to ""')
    lines.push('    try')
    lines.push(`      set payload to ((${readJs}) as text)`)
    lines.push('    on error errMsg')
    lines.push('      set payload to "JSERR: " & errMsg')
    lines.push('    end try')
  }
  lines.push(
    // 标签号必须**按后端**取：Chrome 152 上 `index of <tab>` 返回的是 tab 引用，
    // 转 text/integer 都报 -1700，赋值更是 -1728 —— 直接写 `(index of t as text)`
    // 会让每一条页内操作在 Chrome 上全部失败（而 Safari 上一直是对的）。
    // ti 非 0 时目标就是 tab ti，序号已知；ti 为 0 时才去问浏览器当前标签是谁。
    '    set wIdx to 1',
    '    try',
    '      set wIdx to (index of w)',
    '    end try',
    '    set tIdx to ti',
    `    if ti is 0 then set tIdx to (${be.currentTabIndex})`,
    '    return (wIdx as text) & (character id 31) & (tIdx as text) & (character id 31) & tname & (character id 31) & turl & (character id 31) & payload',
  )
  lines.push('  end tell')
  lines.push('end run')
  return lines.join('\n')
}

/**
 * 关闭单个标签页。索引/标题/URL 必须在 close **之前**取好 —— 关掉一个窗口
 * 的最后一个标签页时 Safari 会把窗口一起关掉，之后再引用 w 就报错。
 */
function asCloseTab(be) {
  return [
    'on run argv',
    '  set fs to character id 31',
    '  set wi to (item 1 of argv) as integer',
    '  set ti to (item 2 of argv) as integer',
    `  tell application "${be.app}"`,
    '    if (count of windows) is 0 then return "ERR" & fs & "no window"',
    '    if wi is 0 then',
    '      set w to front window',
    '    else',
    '      set w to window wi',
    '    end if',
    '    if ti is 0 then',
    `      set t to ${be.currentTab} of w`,
    // Chrome 152 上 `index of <tab>` 读不出来（转 text / integer 都报 -1700）—— 和
    // open 里 `index of newTab` 是同一个坑：拿得到 tab 引用，读不出它的 index。
    // 关「当前页」时用后端自己的 currentTabIndex（Chrome 是 active tab index）；
    // 关「指定页」时序号本来就是调用方给的 ti，不需要回读。
    `      set tiOut to (${be.currentTabIndex}) as text`,
    '    else',
    '      set t to tab ti of w',
    '      set tiOut to (ti as text)',
    '    end if',
    '    set wiOut to (index of w) as text',
    '    set n to ""',
    '    try',
    `      set n to ${be.titleProp} of t`,
    '    end try',
    '    set u to ""',
    '    try',
    '      set u to URL of t',
    '    end try',
    '    close t',
    '    return wiOut & fs & tiOut & fs & n & fs & u',
    '  end tell',
    'end run',
  ].join('\n')
}

/**
 * 关闭一个窗口内所有 URL 含 needle 的标签页。
 *
 * 必须先收集、再**从大到小**关：正序关会让后面的标签页序号前移，下一步就
 * 关错对象 —— 「关掉第 2 个和第 4 个」这种请求最容易踩这个坑。
 *
 * 索引和展示串分成两个平行数组：FS 是控制字符不是空格，AppleScript 的
 * `word 1 of row` 拆不出来，只能另外记一份整数索引。
 */
function asCloseByUrl(be) {
  return [
    'on run argv',
    '  set fs to character id 31',
    '  set rs to character id 30',
    '  set needle to item 1 of argv',
    '  set wi to (item 2 of argv) as integer',
    '  set out to {}',
    `  tell application "${be.app}"`,
    '    if (count of windows) is 0 then return ""',
    '    if wi is 0 then',
    '      set w to front window',
    '    else',
    '      set w to window wi',
    '    end if',
    '    set hits to {}',
    '    set rows to {}',
    '    repeat with i from 1 to (count of tabs of w)',
    '      set u to ""',
    '      try',
    '        set u to URL of tab i of w',
    '      end try',
    '      if u contains needle then',
    '        set n to ""',
    '        try',
    `          set n to ${be.titleProp} of tab i of w`,
    '        end try',
    '        set end of hits to i',
    '        set end of rows to (i as text) & fs & n & fs & u',
    '      end if',
    '    end repeat',
    '    repeat with k from (count of hits) to 1 by -1',
    '      try',
    '        close tab (item k of hits) of w',
    '      end try',
    '      set end of out to item k of rows',
    '    end repeat',
    '  end tell',
    "  set AppleScript's text item delimiters to rs",
    '  return out as text',
    'end run',
  ].join('\n')
}

/* ══════════════════════════════════════════════════════════════════════════
 * 诊断与错误翻译
 * ══════════════════════════════════════════════════════════════════════════ */

function hintFor(raw) {
  const s = String(raw ?? '')
  // 辅助功能必须排在最前，但**不能只看 -1719**：这个码一码两用 ——
  //   · System Events 拒绝辅助功能时用它（文案含「辅助访问」）
  //   · Chrome 报「无效的索引」也用它（实测：关标签页拿到 `tab 4 … 无效的索引 (-1719)`）
  // 以前只要看到 -1719 就指去辅助功能面板，于是「序号过期」被解释成「没权限」，
  // 用户照着点了一圈设置也没用。所以这一支必须同时出现「辅助访问」字样。
  if (/-25211|不允许辅助访问|not allowed assistive access/i.test(s)) {
    return '这是「辅助功能」权限，只有真实鼠标/键盘（real:true）需要：打开「系统设置 → 隐私与安全性 → 辅助功能」，把「DSH Desktop」打开；若列表里没有它、或报错点名 osascript，就点左下角「+」，按 Cmd+Shift+G 输入 /usr/bin，选中 osascript 添加。页内合成模式（real 省略）不需要这个权限。'
  }
  if (/Apple Events|not allowed to execute JavaScript|not authorized to send Apple events to/i.test(s) && /JavaScript/i.test(s)) {
    return '需要在浏览器里放行 JavaScript：Safari 先在「设置 → 高级 → 显示网页开发者功能」打开“开发”菜单，再选「开发 → 允许 Apple 事件中的 JavaScript」；Chrome 选「显示 → 开发者 → 允许 Apple 事件中的 JavaScript」。'
  }
  if (/-1743|Not authorized to send Apple events|not allowed to send Apple events/i.test(s)) {
    return '系统未授权自动化：打开「系统设置 → 隐私与安全性 → 自动化」，允许 DSH Desktop 控制 Safari / Google Chrome，然后重试。'
  }
  if (/-600|not running|isn't running/i.test(s)) {
    return '浏览器没有运行：先调用 mac_browser_open（不带 url）或 mac_browser_activate 把它启动起来。'
  }
  if (/-1719|-1728|Invalid index|无效的索引|Can't get tab|Can’t get tab/i.test(s)) {
    return '窗口 / 标签页序号无效：先调用 mac_browser_tabs 取最新列表再操作。'
  }
  return ''
}

/* ══════════════════════════════════════════════════════════════════════════
 * 插件主体
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 从进程可执行文件路径推出**宿主应用** —— 跑着本插件的那个 app（例如 DSH Desktop）。
 *
 * 为什么需要它：agent 干活时用户常常已经切到别处去了。等到 agent 需要提问、或者
 * 任务结束时，用户根本注意不到 —— 表面上像是"卡住了"，实际是在等人回答。
 * 把宿主切回前台，提问和结论才真的被看见。
 *
 * 打包后的 Electron 应用，主进程的 execPath 形如
 *   /Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop
 * 取到 `.app` 那一段就够了。
 */
export function hostAppFromExecPath(execPath) {
  const s = String(execPath || '')
  const mark = '.app/Contents/MacOS/'
  const i = s.indexOf(mark)
  if (i < 0) return undefined
  const appPath = s.slice(0, i + 4)
  const name = appPath.slice(appPath.lastIndexOf('/') + 1).replace(/\.app$/, '')
  if (name === '') return undefined
  return { appPath, name }
}

/**
 * 把宿主应用切到前台，并还原被最小化的窗口。
 * 进程不存在时返回 NOT_RUNNING，由调用方决定要不要启动它。
 */
export function asHostFocus(appName) {
  const a = JSON.stringify(String(appName))
  return [
    'tell application "System Events"',
    `  if not (exists process ${a}) then return "NOT_RUNNING"`,
    `  tell process ${a}`,
    '    set frontmost to true',
    '    set restored to 0',
    '    repeat with w in windows',
    '      try',
    '        if (value of attribute "AXMinimized" of w) is true then',
    '          set value of attribute "AXMinimized" of w to false',
    '          set restored to restored + 1',
    '        end if',
    '      end try',
    '    end repeat',
    '    return "OK" & (character id 31) & (restored as text)',
    '  end tell',
    'end tell',
  ].join('\n')
}

/**
 * 单次调用该走页内合成还是真实鼠标键盘。
 *
 * 顺序刻意是「参数 > 全局开关」：全局开关只是省掉每次手写 `real: true`，
 * 但显式参数永远能反驳它 —— 开了 mode:'real' 还要能单次 real:false 跑快的，
 * 关着开关也要能单次 real:true 让光标走一趟。
 *
 * 只把**布尔**当真：schema 约束了类型，这里再守一道，别让字符串 "false" 反而变真。
 * mode 只认 'real'，其余（含写错的拼写）一律当 synthetic —— 配错的代价是「没变慢」，
 * 而不是「所有操作突然要求前台标签页」。
 */
export function wantsRealInput(args, mode) {
  if (args?.real === true) return true
  if (args?.real === false) return false
  return mode === 'real'
}

/**
 * 随插件走的一篇 skill：把「固定站点怎么操作」的静态知识单独放，不塞进工具描述。
 *
 * 为什么分开：工具描述每轮都进上下文，而 skill 只在模型真要用时才加载。
 * 对「同一个后台反复操作」这种场景，它省掉的是**探索**（快照 → 找元素），
 * 不是定位（点之前仍要知道元素在）。
 */
const PLAYBOOK = `# 浏览器操作手册（mac-browser）

这份手册给「已经知道要去哪、点什么」的场景用：能照着直接做，就不要先快照再摸索。

## 一、先选模式

| 场景 | 用哪个 |
| --- | --- |
| 普通后台、表单、要快 | 默认 \`synthetic\`（页内合成，约 50ms） |
| 站点只认真实事件（B 站等风控站）、或要给人看光标 | \`real: true\`（约 0.4–1.7s） |
| 一次合成点击后页面没反应 | **先换 \`real: true\` 再试**，别反复合成点 |
| 目标标签页在后台 | 只能合成；真实模式会被拒绝 |

判断信号：合成点击后 URL 没变、DOM 没变、也没报错 → 大概率被站点忽略，切真实。

## 二、定位优先级（从快到慢）

1. **已知选择器**（下面站点卡里写的）→ \`click({selector})\`
2. **表单字段用 label** → \`type({label:"客户编码", value:"..."})\`
3. **定向快照** → \`snapshot({filter:"关键字"})\`，一次约 100 字符
4. **整页快照** → 最后手段，约 2–3k 字符
5. **截图** → 只有 DOM 全找不到时才用

## 三、纪律

- 提交前先 \`formcheck\`；查到必填为空就**列给用户问**，不要自己挑值
- \`selector\` 命中多个 → 工具会拒绝并列出候选；改用 label 或收窄选择器，别随手填 index
- 找不到元素就停，不要猜一个相近的继续
- 关键动作后回读一次（URL / 关键文本），确认真的生效

## 四、站点卡

### E6 Meta Engine（http://124.223.203.144:9006）

- 左侧菜单 \`.el-menu-item\`，顺序：0 配置中心 / 1 元数据模板 / 2 业务数据 / 3 字典管理 / 4 查询台 / 5 AI 助手 / 6 变更与事件 / 7 接口开放 / 8 运维 / 9 数据权限
- 登录：账号 \`input[type=text]\`，密码 \`input[type=password]\`，按钮文字「登 录」（中间有空格）
- 表单字段优先用 label；但**字典管理的新建弹窗没有 label 关联**，要按 placeholder 定位：
  字典编码 \`input[placeholder="例如 unit"]\`，名称 \`input[placeholder="例如 计量单位"]\`，
  说明/备注是 textarea（选填）
- 点「新建字典」要 \`{ text: '新建字典', exact: true }\` —— 不加 exact 会同时命中禁用的「新建字典项」按钮
- Element Plus 下拉的容器是 \`.el-select__wrapper\`
- 表格行按钮：\`.el-table__body .el-table__row:first-child .el-button\`，index 0 归档 / 1 列表 / 2 主子表
- 表格里的名称列是**纯文本**，不在元素表里，\`filter\` 找不到它

### 哔哩哔哩

- 搜索框 \`.nav-search-input\`，搜索按钮 \`.nav-search-btn\`
- ⚠️ 只认真实事件：搜索按钮、搜索结果卡片用合成点击会被静默忽略 → 必须 \`real:true\`
- 番剧页右侧选集是**虚拟列表**（一次只渲染约 20 个），\`filter\` 找不到未渲染的集数。
  用配方 \`bilibili-episode\`（内部是 \`scrollUntil\` + 真实点击）：一条调用直接滚到指定集并打开
- 搜索结果里同一个视频有两个链接（缩略图 + 标题），selector 会命中 2 个 → 用 index 1 点标题

## 六、怎么维护这份手册（重要）

手册不是一次写完的，是**每次探索的沉淀**：

1. **第一次**遇到某个固定页面：照常探索（\`snapshot({filter})\`），把确认过的选择器记下来
2. **写回来**：把「选择器 + 注意事项 + 失败形态」追加到上面站点卡，重载插件即生效
3. **之后**：同一页面再来，直接照卡操作，**零快照**
4. **要跑很多次的流程**：升级成配方（\`recipes\`），一次调用跑完，连回合都省了

判断标准很简单：**同一个页面第二次来，就不该再探索。** 如果发现自己在重复快照，
说明有东西该写进这里了。

## 五、失败长什么样

- 合成点击「成功」但页面没变 → 站点拦了，换 \`real:true\`
- \`filter\` 返回 0 → 先 \`read\` 确认这段文字在不在当前页；可能在别的标签页、折叠区，或还没渲染
- \`-1719 无效的索引\` → 标签页序号过期，重新 \`tabs\` 取序号
- \`工具超时\` → 多半是真实鼠标动画 + 页面慢，调小 \`pointer.steps/stepMs\` 或换合成
`

export function apply(ctx, config) {
  const cfg = config ?? {}

  // 鼠标移动手感。数值项都做了夹紧，配错值不会把光标卡死或拖到几秒。
  const rawPointer = cfg.pointer && typeof cfg.pointer === 'object' ? cfg.pointer : {}
  // 输入总开关：synthetic（缺省，页内合成点击 —— 快、不依赖前台、不要权限）/
  // real（真实鼠标键盘 —— 光标会真的走过去，但每次约 1.5s，且目标标签页必须在前台）。
  // 只认这两个值，写错了一律当 synthetic：配错的代价是"没变慢"，不是"突然点不动"。
  const pointerMode = rawPointer.mode === 'real' ? 'real' : 'synthetic'
  const pointer = {
    steps: Math.min(400, Math.max(2, Number.isInteger(rawPointer.steps) ? rawPointer.steps : 48)),
    stepMs: Math.min(200, Math.max(1, Number.isInteger(rawPointer.stepMs) ? rawPointer.stepMs : 20)),
    easing: rawPointer.easing === 'linear' ? 'linear' : 'easeInOut',
    mode: pointerMode,
  }

  // 单次调用到底走哪条路：**调用参数优先，其次全局开关**。
  // 显式 real:false 必须能压过 mode:'real' —— 开了总开关，也还得能单独跑一次快的。
  // 反过来 real:true 永远有效，不受开关关着的影响。
  const useReal = (args) => wantsRealInput(args, pointerMode)

  // ── 随插件走的「多指令 / 模糊指令」约定（系统提示词段）────────────────────
  // 插件是全局装的，所以这段注册在宿主作用域 → 进程内每个 agent 都会看到。
  // 名字带 mac-browser/ 前缀：别的层想按名覆盖（或预设想整段替换）都方便。
  if (cfg.instructionProtocol !== false) {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt === undefined) {
      ctx.logger?.warn?.('mac-browser: systemPrompt 服务不可用，跳过指令处理约定')
    } else {
      const protocolText =
        typeof cfg.instructionProtocolText === 'string' && cfg.instructionProtocolText.trim() !== ''
          ? cfg.instructionProtocolText
          : DEFAULT_INSTRUCTION_PROTOCOL
      const protocolOrder = Number.isFinite(cfg.instructionProtocolOrder)
        ? cfg.instructionProtocolOrder
        : 15
      ctx.effect(function () {
        return systemPrompt.section({
          name: 'mac-browser/instruction-protocol',
          order: protocolOrder,
          text: protocolText,
        })
      })
    }
  }

  // ── 随插件走的「操作手册」skill ─────────────────────────────────────────
  // 静态知识（选择器、模式选择、失败形态）放这里，而不是全塞进工具描述：
  // 工具描述每一轮都进上下文，skill 只在模型真要动手时才加载。
  // skills 是**可选**依赖：没装 dsh-skill 的 profile 里插件照常跑，只是没有这篇。
  const skillsService = ctx.get('skills')
  if (skillsService !== undefined) {
    ctx.effect(
      () =>
        skillsService.register({
          name: 'mac-browser-playbook',
          description: '浏览器操作手册：合成/真实模式怎么选、已知站点的选择器、失败怎么读',
          whenToUse: '在固定站点反复操作（尤其表单）、或点击后页面没反应时先读这篇，能省掉整页快照',
          content: PLAYBOOK,
          // source 必须显式给：注册表只补 invocation 与 provider 的默认值，
          // 漏掉它加载时会报 `source must be a string`（实测）。
          source: 'runtime',
          invocation: { modelInvocable: true, userInvocable: true },
        }),
      'mac-browser: playbook skill',
    )
  } else {
    ctx.logger?.warn?.('mac-browser: skills 服务不可用，跳过操作手册 skill')
  }

  const timeoutMs =
    Number.isSafeInteger(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxOutputBytes =
    Number.isSafeInteger(cfg.maxOutputBytes) && cfg.maxOutputBytes > 0
      ? cfg.maxOutputBytes
      : DEFAULT_MAX_OUTPUT_BYTES

  const workdir = typeof cfg.cwd === 'string' && cfg.cwd.length > 0 ? cfg.cwd : homedir()

  // 启用哪些后端：缺省全部；显式 config.backends 之外的注册后端只是不启用，不报错。
  // 注意 backends 里只会有「本平台注册过的」那些 —— 例如 Windows 上不会有 safari。
  const enabled = Array.isArray(cfg.backends) && cfg.backends.length > 0
    ? cfg.backends.filter((id) => typeof id === 'string')
    : backendIds()

  const backends = new Map()
  for (const id of enabled) {
    const factory = backendFactories.get(id)
    if (factory === undefined) continue
    const be = factory()
    backends.set(id, be)
  }

  // 配置里的 defaultBackend 可能属于另一个平台（compositions 是跨平台共用的，
  // Windows 上配的仍是 safari）。不在已启用集合里就退回第一个可用后端，
  // 而不是让每一次不带 browser 参数的调用都报「未知后端」。
  const configuredDefault =
    typeof cfg.defaultBackend === 'string' && cfg.defaultBackend.length > 0 ? cfg.defaultBackend : undefined
  const defaultBackendId =
    configuredDefault !== undefined && backends.has(configuredDefault)
      ? configuredDefault
      : [...backends.keys()][0]

  if (backends.size === 0) {
    ctx.logger?.warn?.(`mac-browser: no usable backend among ${JSON.stringify(enabled)}`)
    return
  }

  /** 归一浏览器参数：支持 "chrome" / "google chrome" / "谷歌" / "safer" 等 ASR 变体。 */
  const pickBackend = (value) => {
    const v = String(value ?? '').trim().toLowerCase()
    let id
    if (v === 'chrome' || v === 'google' || v === 'google chrome' || v === '谷歌' || v === '谷歌浏览器') {
      id = 'chrome'
    } else if (v === 'safari' || v === 'safer' || v === 'safri' || v === '浏览器' || v === '') {
      id = defaultBackendId
    } else {
      id = v
    }
    const be = backends.get(id)
    if (be === undefined) {
      throw new Error(
        `未知或未启用的浏览器后端 "${id}"；当前可用：${[...backends.keys()].join(', ')}`,
      )
    }
    return be
  }

  /* ── 进程与信号 ─────────────────────────────────────────────────────── */

  let osascriptPath

  const resolveOsa = async (signal) => {
    if (osascriptPath !== undefined) return osascriptPath
    try {
      osascriptPath = await ctx.subprocess.resolveExecutable('/usr/bin/osascript', undefined, signal)
    } catch (error) {
      throw new Error(
        `mac-browser 需要 macOS 的 /usr/bin/osascript，但解析失败：${String((error && error.message) || error)}`,
      )
    }
    return osascriptPath
  }

  const combineSignals = (signals) => {
    const list = signals.filter((s) => s !== undefined)
    if (list.length === 0) return undefined
    if (list.length === 1) return list[0]
    if (typeof AbortSignal.any === 'function') return AbortSignal.any(list)
    const controller = new AbortController()
    for (const s of list) {
      if (s.aborted) {
        controller.abort(s.reason)
        break
      }
      s.addEventListener('abort', () => controller.abort(s.reason), { once: true })
    }
    return controller.signal
  }

  const readCollected = (handle, which) => {
    const reader = handle.collected?.[which]
    if (reader === undefined) return ''
    try {
      return reader.readFrom(0).text
    } catch {
      return ''
    }
  }

  /** 唯一的执行入口：脚本走 stdin，参数走 argv，不经 shell。 */
  const runOsa = async (script, argv, exec, language) => {
    const exe = await resolveOsa(exec?.signal)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('mac-browser timeout')), timeoutMs)
    timer.unref?.()

    let handle
    try {
      handle = ctx.subprocess.spawn({
        argv: [exe, ...(language === undefined ? [] : ['-l', language]), '-', ...argv],
        cwd: workdir,
        stdio: {
          stdin: { data: script },
          stdout: { maxBytes: maxOutputBytes },
          stderr: { maxBytes: maxOutputBytes },
        },
        graceMs: GRACE_MS,
        signal: combineSignals([controller.signal, exec?.signal]),
      })

      let outcome
      try {
        outcome = await handle.done
      } catch (error) {
        throw new Error(`osascript 启动失败：${String((error && error.message) || error)}`)
      }

      const stdout = readCollected(handle, 'stdout').replace(/\s+$/, '')
      const stderr = readCollected(handle, 'stderr').trim()

      if (controller.signal.aborted) {
        throw new Error(`mac-browser 超时（${timeoutMs}ms）：osascript 没有返回。`)
      }
      if (outcome.exitCode !== 0) {
        const hint = hintFor(stderr)
        throw new Error(
          `osascript 退出码 ${String(outcome.exitCode)}：${stderr || '无 stderr'}${hint ? `\n提示：${hint}` : ''}`,
        )
      }
      return stdout
    } finally {
      clearTimeout(timer)
      // 超时/取消路径下确保子进程被回收；正常结束时是幂等无操作。
      if (controller.signal.aborted) {
        try {
          handle?.terminate()
        } catch {
          /* 已经退出 */
        }
      }
    }
  }

  /* ── Windows：PowerShell 执行层 ─────────────────────────────────────── */

  let pwshPath

  const resolvePwsh = async (signal) => {
    if (pwshPath !== undefined) return pwshPath
    const tried = []
    // Windows PowerShell 与 PowerShell 7 都试；-Command - 两者都支持从 stdin 读脚本。
    for (const candidate of ['powershell.exe', 'powershell', 'pwsh.exe', 'pwsh']) {
      try {
        pwshPath = await ctx.subprocess.resolveExecutable(candidate, undefined, signal)
        return pwshPath
      } catch {
        tried.push(candidate)
      }
    }
    throw new Error(
      `mac-browser：找不到 PowerShell（试过 ${tried.join(' / ')}）。Windows 后端靠它执行 OS 层操作。`,
    )
  }

  const runPowerShell = async (script, exec) => {
    const exe = await resolvePwsh(exec?.signal)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('mac-browser timeout')), timeoutMs)
    timer.unref?.()

    let handle
    try {
      handle = ctx.subprocess.spawn({
        argv: [exe, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
        cwd: workdir,
        stdio: {
          stdin: { data: script },
          stdout: { maxBytes: maxOutputBytes },
          stderr: { maxBytes: maxOutputBytes },
        },
        graceMs: GRACE_MS,
        signal: combineSignals([controller.signal, exec?.signal]),
      })

      let outcome
      try {
        outcome = await handle.done
      } catch (error) {
        throw new Error(`PowerShell 启动失败：${String((error && error.message) || error)}`)
      }

      const stdout = readCollected(handle, 'stdout').replace(/\s+$/, '')
      const stderr = readCollected(handle, 'stderr').trim()

      if (controller.signal.aborted) {
        throw new Error(`mac-browser 超时（${timeoutMs}ms）：PowerShell 没有返回。`)
      }
      if (outcome.exitCode !== 0) {
        // UIPI：目标以管理员运行时会在这里出现「拒绝访问」类错误。
        const uipi = /拒绝访问|Access is denied|0x80070005/i.test(stderr)
          ? '\n提示：Windows 的 UIPI 限制 —— 目标窗口若以管理员权限运行，非管理员进程发不进鼠标/键盘事件。把两边都提权，或让目标以普通权限运行。'
          : ''
        throw new Error(`PowerShell 退出码 ${String(outcome.exitCode)}：${stderr || '无 stderr'}${uipi}`)
      }
      return stdout
    } finally {
      clearTimeout(timer)
      if (controller.signal.aborted) {
        try {
          handle?.terminate()
        } catch {
          /* 已经退出 */
        }
      }
    }
  }

  /**
   * 能力闸门：在**动手前**给出明确错误，而不是让不支持的平台抛底层报错。
   * 这是「Windows 只做 OS 层」这个决定落地的地方。
   */
  const requireCap = (be, cap, what) => {
    if (be.caps[cap] === true) return
    const extra =
      be.platform === 'win32'
        ? '\nWindows 目前只做 OS 层：打开 / 唤起 / 真实鼠标键盘。页面级能力（列标签页、读正文、执行 JS、页内定位与点击输入）要接 Chrome DevTools Protocol，尚未实现 —— 也因此 Windows 上点元素必须显式给 x/y 屏幕坐标，输入只能送进当前焦点。'
        : ''
    throw new Error(`mac-browser：${be.label} 这个后端不支持「${what}」。${extra}`)
  }

  /** 取后端在 Windows 上第一个真实存在的可执行文件。 */
  const resolveWinExe = async (be) => {
    for (const p of be.bundlePaths || []) {
      if (p && (await exists(p))) return p
    }
    throw new Error(
      `mac-browser：找不到 ${be.label} 的可执行文件，找过：\n  ${(be.bundlePaths || []).join('\n  ')}`,
    )
  }

  const parseTabs = (stdout) => {
    if (stdout === '') return []
    return stdout.split(RECORD_SEP).map((row) => {
      const p = row.split(FIELD_SEP)
      return {
        window: Number(p[0]),
        index: Number(p[1]),
        active: p[2] === 'true',
        title: p[3] || '',
        url: p[4] || '',
      }
    })
  }

  const exists = (path) => access(path).then(() => true, () => false)

  /** 用 pgrep 判断进程是否在跑（不触发任何自动化权限）。 */
  const isRunning = async (processName, exec) => {
    let pgrep
    try {
      pgrep = await ctx.subprocess.resolveExecutable('pgrep', undefined, exec?.signal)
    } catch {
      return undefined
    }
    const handle = ctx.subprocess.spawn({
      argv: [pgrep, '-x', processName],
      cwd: workdir,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      graceMs: GRACE_MS,
      ...(exec?.signal !== undefined ? { signal: exec.signal } : {}),
    })
    try {
      const outcome = await handle.done
      return outcome.exitCode === 0
    } catch {
      return undefined
    }
  }

  /* ── 工具注册 ───────────────────────────────────────────────────────── */

  /* ══ 站点配方（config.recipes）═══════════════════════════════════════════
   *
   * 把「某个网站上的固定操作」写成声明式步骤，模型不必每次现编选择器，
   * 页面小改时也只改配置、不动代码。
   *
   * 步骤词汇表（每项只写一个键）：
   *   - goto: <url>                        打开网址（可配 real: true 走地址栏）
   *   - wait: <毫秒>                       固定等待
   *   - waitFor: <selector>                轮询到元素出现（可配 timeoutMs）
   *   - click: <selector> | { selector|text, index, real }
   *   - type: { selector|text, value, submit, real }
   *   - eval: <js 表达式>                  逃生口，结果记进 trace
   *   - screenshot: true | { selector }    截图，路径记进 trace
   *
   * 字符串里的 {{name}} 会被 vars 替换；内置 {{url}} 是当前标签页地址。
   * 任一步失败即中止，并回报已完成的步骤 —— 不猜、不继续。
   */

  const rawRecipes = Array.isArray(cfg.recipes) ? cfg.recipes : []
  const recipes = []
  for (const r of rawRecipes) {
    if (!r || typeof r !== 'object' || typeof r.name !== 'string' || !Array.isArray(r.steps)) {
      ctx.logger?.warn?.('mac-browser: 跳过一条格式不对的 recipe（需要 { name, steps[] }）')
      continue
    }
    recipes.push(r)
  }
  const recipeByName = new Map(recipes.map((r) => [r.name, r]))

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /** 递归替换字符串里的 {{var}}。 */
  const substitute = (value, vars) => {
    if (typeof value === 'string') {
      return value.replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m))
    }
    if (Array.isArray(value)) return value.map((v) => substitute(v, vars))
    if (value && typeof value === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(value)) out[k] = substitute(v, vars)
      return out
    }
    return value
  }

  const invokeTool = async (name, args, exec) => {
    const def = ctx.tools.get(name)
    if (def === undefined) throw new Error(`mac-browser：内部错误，工具 ${name} 未注册。`)
    return def.execute(args, exec)
  }

  /** 执行一步。返回要写进 trace 的一句话。 */
  const runRecipeStep = async (rawStep, vars, base, exec) => {
    const step = substitute(rawStep, vars)
    const common = { browser: base.browser, window: base.window, tab: base.tab }

    if (typeof step !== 'object' || step === null) {
      throw new Error(`步骤必须是对象，收到 ${JSON.stringify(rawStep)}`)
    }

    if (step.goto !== undefined) {
      const r = await invokeTool('mac_browser_open', { ...common, url: String(step.goto), real: step.real ?? base.real }, exec)
      return r.text.split('\n')[0]
    }

    if (step.wait !== undefined) {
      const ms = Math.min(60000, Math.max(1, Number(step.wait) || 0))
      await sleep(ms)
      return `等待 ${String(ms)}ms`
    }

    if (step.waitFor !== undefined) {
      const selector = typeof step.waitFor === 'string' ? step.waitFor : String(step.waitFor.selector)
      const timeoutMs = Math.min(120000, Math.max(100, Number(step.waitFor.timeoutMs) || 15000))
      const started = Date.now()
      const be = pickBackend(base.browser)
      while (Date.now() - started < timeoutMs) {
        const r = await runInPage(be, '__mbLocate', { selector, many: true }, base.window, base.tab, exec).catch(() => undefined)
        if (r !== undefined && r.result.ok === true) {
          return `等到了 ${selector}（${String(Date.now() - started)}ms）`
        }
        await sleep(250)
      }
      throw new Error(`等 ${selector} 超时（${String(timeoutMs)}ms）`)
    }

    // expect：要求「至少 N 个可见匹配」，否则立刻停下。
    //
    // 和 waitFor 的区别是**语义与报错**：waitFor 是「等某个东西出现」，
    // expect 是「断言这里必须有结果」。查询类流程必须用它 —— 否则一个空的
    // 结果集是**静默的成功**，agent 会以为一切正常，然后自己编一个替代词继续。
    // 这个错误文案是刻意写给 agent 看的：明确不许猜。
    if (step.expect !== undefined) {
      const spec = typeof step.expect === 'string' ? { selector: step.expect } : step.expect
      const selector = String(spec.selector)
      const want = Math.max(1, Number(spec.min) || 1)
      const timeoutMs = Math.min(60000, Math.max(300, Number(spec.timeoutMs) || 5000))
      const what = typeof spec.what === 'string' && spec.what !== '' ? spec.what : '结果'
      const started = Date.now()
      const be = pickBackend(base.browser)
      let seen = 0
      while (Date.now() - started < timeoutMs) {
        const r = await runInPage(be, '__mbLocate', { selector, many: true }, base.window, base.tab, exec).catch(() => undefined)
        seen = r !== undefined && r.result.ok === true ? Number(r.result.count) || 0 : 0
        if (seen >= want) {
          return `${what}就绪：${String(seen)} 条（${String(Date.now() - started)}ms）`
        }
        await sleep(250)
      }
      throw new Error(
        `没有${what}：等待 ${String(timeoutMs)}ms 内「${selector}」始终少于 ${String(want)} 个（最后看到 ${String(seen)} 个）。\n` +
          '已停止，后续步骤不再执行。\n' +
          '⚠️ 不要自行替换搜索词、也不要猜一个相近的值继续 —— 那是猜测，不是执行。\n' +
          '请把「用这个条件查不到内容」回报给用户，并问清楚要用哪个条件。',
      )
    }

    // scrollUntil：在指定容器里「滚一段 → 找一次」，直到目标文字出现。
    // 虚拟列表（番剧选集、长商品列表）只能这么处理：没渲染的元素不在 DOM 里，
    // filter / snapshot 都看不见，必须靠滚动把它造出来。
    if (step.scrollUntil !== undefined) {
      const spec = typeof step.scrollUntil === 'string' ? { text: step.scrollUntil } : step.scrollUntil
      const needle = String(spec.text ?? '').trim()
      if (needle === '') throw new Error('scrollUntil 需要 text（要滚到哪个文字）')
      const container = typeof spec.container === 'string' ? spec.container : ''
      const maxSteps = Math.max(1, Math.min(80, Number(spec.max) || 40))
      const px = Math.max(50, Math.min(3000, Number(spec.step) || 400))
      const be = pickBackend(base.browser)
      for (let i = 0; i < maxSteps; i++) {
        const { result } = await runInPage(be, '__mbScrollFind', { container, text: needle, step: px }, base.window, base.tab, exec)
        if (result.ok !== true) throw new Error(`滚动查找失败（${JSON.stringify(result)}）`)
        if (result.found) {
          // 虚拟列表在滚动后还会重渲染一轮：立刻返回的话，下一句 click 可能刚好
          // 撞在「旧行已卸载、新行还没挂上」的空档里（实测过一次）。留一点稳定时间。
          await sleep(250)
          return `滚到「${needle}」（第 ${String(i + 1)} 次，容器 ${String(result.scrollTop)}px / ${String(result.max)}px）`
        }
        if (result.atEnd) {
          throw new Error(
            `滚到底也没找到「${needle}」（滚了 ${String(i + 1)} 次，共 ${String(result.max)}px）。` +
              '可能是文字对不上、或者它不在这个容器里 —— 先 mac_browser_read 确认，不要猜一个相近的继续。',
          )
        }
        await sleep(120)
      }
      throw new Error(`滚了 ${String(maxSteps)} 次还没找到「${needle}」，已停下。`)
    }

    if (step.click !== undefined) {
      const spec = typeof step.click === 'string' ? { selector: step.click } : step.click
      const r = await invokeTool('mac_browser_click', {
        ...common,
        selector: spec.selector,
        text: spec.text,
        // 配方是刻意编写的，"选择器命中多个时取第一个"就是它写下来的语义。
        // 显式传 index 让这个选择**留痕**：歧义守卫只拦"没意识到有多个"的调用。
        index: spec.index ?? 0,
        real: spec.real ?? base.real,
      }, exec)
      return r.text.split('\n')[0]
    }

    if (step.type !== undefined) {
      if (typeof step.type !== 'object') throw new Error('type 步骤要写成 { value, selector|text, ... }')
      const r = await invokeTool('mac_browser_type', {
        ...common,
        selector: step.type.selector,
        text: step.type.text,
        index: step.type.index ?? 0,
        value: String(step.type.value ?? ''),
        submit: step.type.submit === true,
        real: step.type.real ?? base.real,
      }, exec)
      return r.text.split('\n')[0]
    }

    if (step.eval !== undefined) {
      const r = await invokeTool('mac_browser_eval', { ...common, expression: String(step.eval) }, exec)
      const payload = r.text.includes('→ ') ? r.text.slice(r.text.indexOf('→ ') + 2) : r.text
      vars.__last = payload
      return `eval → ${payload.slice(0, 120)}`
    }

    if (step.screenshot !== undefined) {
      const spec = step.screenshot === true ? {} : step.screenshot
      const r = await invokeTool('mac_browser_screenshot', { ...common, selector: spec.selector }, exec)
      return r.text.split('\n')[0]
    }

    throw new Error(`无法识别的步骤：${JSON.stringify(rawStep)}`)
  }

  const browserParam = {
    type: 'string',
    enum: [...backends.keys()],
    description: `目标浏览器：${[...backends.keys()].join(' / ')}（缺省 ${defaultBackendId}）。`,
  }

  // 工具级时限：config.toolTimeouts 按工具名覆盖（慢站点 / 长配方用得到）。
  // 非正数、非数字一律忽略 —— 宁可退回内置值，也不要让拼错的配置把工具变成
  // 「注册即触发超时」。
  const toolTimeoutOverrides =
    cfg.toolTimeouts && typeof cfg.toolTimeouts === 'object' ? cfg.toolTimeouts : {}
  const toolTimeout = (name) => {
    const override = toolTimeoutOverrides[name]
    if (Number.isFinite(override) && override > 0) return override
    return TOOL_TIMEOUT_MS[name] ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * 统一补上当前 ToolDefinition 契约里两个可选字段：
   *   · timeoutMs        —— 整个调用的协作式上限，交给 dsh-tool-call-timeout-policy
   *   · isConcurrencySafe —— 缺省按 exclusive 处理；这里只给纯读工具放行并行
   *
   * 放在这里而不是逐个工具写：十五个工具里十个是同一套语义（独占 + 各自时限），
   * 散着写既容易漏，也看不出「谁允许并行」这个整体判断。单个工具想特事特办，
   * 在它自己的定义里写同名键即可（后面的展开会覆盖）。
   */
  const register = (definition) =>
    ctx.tools.register({
      timeoutMs: toolTimeout(definition.name),
      isConcurrencySafe: () => PARALLEL_SAFE_TOOLS.has(definition.name),
      ...definition,
    })

  /* ── 截图（macOS：screencapture）─────────────────────────────────────── */

  let screencapturePath

  const resolveScreencapture = async (signal) => {
    if (screencapturePath !== undefined) return screencapturePath
    for (const candidate of ['/usr/sbin/screencapture', '/usr/bin/screencapture']) {
      try {
        screencapturePath = await ctx.subprocess.resolveExecutable(candidate, undefined, signal)
        return screencapturePath
      } catch {
        /* 试下一个 */
      }
    }
    throw new Error('mac-browser：找不到 screencapture（试过 /usr/sbin 与 /usr/bin）。')
  }

  /** 截取屏幕上的一个矩形到 outPath。失败时把 TCC 报错翻译成中文指引。 */
  const runScreencapture = async (rect, outPath, exec) => {
    const exe = await resolveScreencapture(exec?.signal)
    const handle = ctx.subprocess.spawn({
      argv: [exe, '-x', '-R', `${rect.x},${rect.y},${rect.w},${rect.h}`, outPath],
      cwd: workdir,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
      graceMs: GRACE_MS,
      ...(exec?.signal !== undefined ? { signal: exec.signal } : {}),
    })
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      throw new Error(`screencapture 启动失败：${String((error && error.message) || error)}`)
    }
    const err = readCollected(handle, 'stderr').trim()
    if (outcome.exitCode !== 0) {
      const hint = screenRecordingHint(err)
      throw new Error(`screencapture 退出码 ${String(outcome.exitCode)}：${err || '无 stderr'}${hint ? `\n提示：${hint}` : ''}`)
    }
    return err
  }

  /**
   * 跑一段页面内动作（__mbClick / __mbType），返回解析后的结果。
   * 复用 asTabScript(be,'eval') 那条现成传输路径 —— 它本来就是「把 argv[3]
   * 当 JS 源码丢进标签页执行、把返回值带回来」。
   */
  const runInPage = async (be, action, options, wi, ti, exec) => {
    const source = buildInPageSource(action, options)
    const stdout = await runOsa(asTabScript(be, 'eval'), [String(wi), String(ti), source], exec)
    const p = stdout.split(FIELD_SEP)
    if (p[0] === 'ERR') throw new Error(`mac-browser：${p[1] || '没有窗口'}`)
    const raw = (p[4] || '').trim()
    // 与 read 同源的问题：JS 被禁用时 AppleScript 把报错当成正常 payload 返回，
    // 不在这里翻译就会掉进下面 JSON.parse 的兜底、丢掉可执行的中文提示。
    if (raw.startsWith('JSERR:')) {
      const hint = hintFor(raw)
      throw new Error(`mac-browser：页面里执行 JS 失败：${raw}${hint ? `\n提示：${hint}` : ''}`)
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`mac-browser：页面返回了无法解析的结果：${raw.slice(0, 200)}`)
    }
    return { url: p[3] || '', result: parsed }
  }

  const inPageError = (result, options) => {
    const what = options.selector
      ? `selector=${options.selector}`
      : options.label
        ? `label=「${String(options.label)}」`
        : `text=「${String(options.text)}」`
    if (result.error === 'no-match') {
      return (
        `mac-browser：没找到匹配的元素（${what}）。\n` +
        '先用 mac_browser_read 看页面上的实际文字，确认措辞（空格/全半角/是否在 iframe 里）后再试。'
      )
    }
    if (result.error === 'index-out-of-range') {
      return `mac-browser：${what} 匹配到 ${String(result.count)} 个，但没有 index=${String(options.index || 0)} 那个。`
    }
    // 选择器歧义：**拒绝执行**，而不是默默操作第一个。默默取第一个的后果是"报了成功、
    // 实际点到了另一个字段"—— 没有任何信号，只能靠人发现。
    if (result.error === 'ambiguous-selector') {
      const cands = Array.isArray(result.candidates) ? result.candidates : []
      const lines = cands.map((c, i) => `  index ${String(i)}: ${String(c)}`)
      return (
        `mac-browser：选择器 ${what} 匹配到 **${String(result.count)} 个**元素，已拒绝执行 —— ` +
        '不给 index 时默认取第一个，而 DOM 顺序跟"你想点哪个"无关，很容易点错。\n' +
        '候选：\n' +
        lines.join('\n') +
        (result.count > cands.length ? `\n  …还有 ${String(result.count - cands.length)} 个` : '') +
        '\n请改用以下任一种：\n' +
        '  · **label**：按表单标签定位（最稳，表单重渲染也不受影响）\n' +
        '  · 收窄选择器，让它只命中一个（例如 .el-table__row:first-child .btn）\n' +
        '  · 确实要候选中的某一个，就显式传 index'
      )
    }
    if (result.error === 'not-editable') {
      return `mac-browser：${what} 匹配到的是 <${String(result.tag)}>，不是输入框。输入请指向真正的 input/textarea。`
    }
    return `mac-browser：页面内操作失败：${JSON.stringify(result)}`
  }

  /**
   * 真实指针/键盘事件是按**屏幕坐标**发出的，所以只会落到当前可见的那一页上。
   *
   * 目标标签页在后台时（被同窗口的其他页盖住、或在别的窗口后面），坐标依然有效，
   * 但事件会打到**错误的那一页**上 —— 而且命令会报成功。这是最危险的一类错：
   * 看起来做成了，其实动的是别的东西。`document.visibilityState` 是页面自己给的
   * 权威信号，用它拦住，而不是猜。
   */
  const assertFrontTab = (result, what) => {
    if (result?.visibility === 'hidden') {
      throw new Error(
        `mac-browser：目标标签页不在前台，不能用${what}操作它。\n` +
          '真实鼠标/键盘/滚轮事件按屏幕坐标发出，只会落到当前可见的那一页 —— ' +
          '硬做的话事件会打到别的页面上，却报告成功。\n' +
          '先用 mac_browser_activate 把这一页切到前台，再重试；' +
          '或者传 real:false 改走页内合成模式（不需要前台，但没有可见光标）。',
      )
    }
  }

  /**
   * 把页面的**视口 CSS 像素**坐标换算成屏幕点。
   *
   * 为什么不能直接相加：`getBoundingClientRect()` 给的是 CSS 像素，而 CoreGraphics
   * 要的是屏幕点。浏览器缩放 ≠ 100% 时 1 CSS px ≠ 1 点，`screenX + rect.left` 这种
   * 加法就会偏 —— 缩得越小偏得越多。而实际场景的分辨率与页面缩放比例事先不可知，
   * 不能靠"假设是 100%"。
   *
   * 用**比例**就免疫缩放：元素在视口中的相对位置 × 窗口内容区的点尺寸。
   * 窗口几何（点）来自 System Events；浏览器 chrome 的高由
   * outerHeight - innerHeight 得到（CSS px），同样按比例换算成点。
   *
   * 缩放 100% 时 kx=ky=1，退化成原来的加法 —— 与既有基准一致。
   */
  /**
   * 取浏览器窗口矩形：**先问浏览器自己**（bounds），失败再退回 System Events。
   * 退路存在是因为极少数版本/配置下 `bounds` 不可用；但默认路径必须是前者 ——
   * System Events 的 AX `window 1` 可能是个弹层小窗，会把这套坐标换算整体带偏。
   */
  const readWindowRect = async (be, exec) => {
    try {
      const out = await runOsa(asWindowRectNative(be), [], exec)
      const p = out.split(FIELD_SEP)
      if (p[0] !== 'ERR') {
        const r = { x: Number(p[0]), y: Number(p[1]), w: Number(p[2]), h: Number(p[3]) }
        if (Number.isFinite(r.x) && Number.isFinite(r.y) && r.w > 0 && r.h > 0) return r
      }
    } catch (nativeErr) {
      /* 退回 System Events */
    }
    const out = await runOsa(asWindowRect(be), [], exec)
    const q = out.split(FIELD_SEP)
    if (q[0] === 'ERR') throw new Error(`mac-browser：取窗口矩形失败 —— ${q[1] || '未知原因'}`)
    return { x: Number(q[0]), y: Number(q[1]), w: Number(q[2]), h: Number(q[3]) }
  }

  const toScreen = async (be, vpGeo, vp, exec) => {
    const win = await readWindowRect(be, exec)
    const kx = vpGeo && vpGeo.outerW > 0 && win.w > 0 ? win.w / vpGeo.outerW : 1
    const ky = vpGeo && vpGeo.outerH > 0 && win.h > 0 ? win.h / vpGeo.outerH : 1
    const chromeH = vpGeo ? Number(vpGeo.chromeH) || 0 : 0
    return {
      x: Math.round(win.x + vp.x * kx),
      y: Math.round(win.y + (chromeH + vp.y) * ky),
      kx,
      ky,
      win,
    }
  }

  const textOutput = (schema) => ({
    schema,
    render: (_args, value) => [{ type: 'text', text: value.text }],
  })

  /* 1) 自检 ──────────────────────────────────────────────────────────── */
  register({
    name: 'mac_browser_status',
    description:
      '自检 macOS 浏览器控制能力：osascript 是否可用、每个后端是否已安装、是否正在运行、需要哪些权限。排障第一步，也用来确认插件有没有装好。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput({
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    }),
    async execute(_args, exec) {
      const lines = []
      let osaOk = true
      let osaPath = ''
      try {
        osaPath = await resolveOsa(exec?.signal)
      } catch (error) {
        osaOk = false
        osaPath = String((error && error.message) || error)
      }
      lines.push(`osascript：${osaOk ? osaPath : `不可用（${osaPath}）`}`)

      for (const [id, be] of backends) {
        const installed = (
          await Promise.all(be.bundlePaths.map((p) => exists(p)))
        ).some(Boolean)
        const running = installed ? await isRunning(be.processName, exec) : false
        lines.push(
          `${be.label}（${id}，transport=${be.transport}）：安装=${installed ? '是' : '否'} ` +
            `运行=${running === undefined ? '未知' : running ? '是' : '否'}`,
        )
      }

      // 辅助功能权限：只有 macOS 的真实鼠标/键盘需要。Windows 没有这套授权，
      // 它的门槛是 UIPI（目标提权时非管理员进程发不进事件）。
      let ax
      if (IS_WIN) {
        ax = '不适用（Windows 无需辅助功能授权；门槛是 UIPI 提权）'
      } else {
        ax = '已授权'
        try {
          await runOsa(asAccessibilityProbe(), [], exec)
        } catch (error) {
          const msg = String((error && error.message) || error)
          ax = /-1719|-25211|辅助访问|assistive/i.test(msg)
            ? '未授权 → real:true 不可用（页内合成模式 real 省略，不受影响）'
            : `检测失败：${msg.slice(0, 100)}`
        }
      }
      lines.push(`辅助功能权限：${ax}`)
      lines.push(
        `输入模式（config.pointer.mode）：${
          pointerMode === 'real'
            ? 'real —— 默认真实鼠标键盘：光标会真的走过去（约 1.5s/次），且目标标签页必须在前台'
            : 'synthetic —— 默认页内合成：快、不依赖前台、不要辅助功能；单次传 real:true 即改走真实鼠标'
        }`,
      )
      lines.push(`已启用后端：${[...backends.keys()].join(', ')}；缺省：${defaultBackendId}`)
      const hp = hostApp()
      lines.push(`宿主应用（mac_browser_host_focus 的目标）：${hp.name}  ←  ${hp.appPath}`)
      lines.push(
        '首次使用若报 -1743：系统设置 → 隐私与安全性 → 自动化 → 允许 DSH Desktop 控制浏览器；' +
          '读/执行 JS 还需在浏览器里放行「允许 Apple 事件中的 JavaScript」。',
      )
      return { text: lines.join('\n') }
    },
  })

  /* 2) 打开 / 唤起 ───────────────────────────────────────────────────── */
  register({
    name: 'mac_browser_open',
    description:
      '在用户真实的 Safari 或 Google Chrome 里打开一个 URL（新标签页）并把窗口切到前台。省略 url 时只把浏览器唤到前台——用于「打开 Safari」这类指令。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的 URL，如 https://example.com；省略则只唤起前台。' },
        real: { type: 'boolean', description: '像人一样操作：把鼠标移到地址栏、点一下、输入 URL、回车。需要「辅助功能」权限，且光标会可见地移动。默认否（用 AppleScript 直接建标签页，更快但不产生任何可见动作）；配了 config.pointer.mode: real 时默认为是，可显式传 false 单次关掉。' },
        browser: browserParam,
      },
      required: [],
      additionalProperties: false,
    },
    output: textOutput({
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    }),
    async execute(args, exec) {
      const be = pickBackend(args?.browser)
      requireCap(be, 'open', '打开页面')
      const url = typeof args?.url === 'string' ? args.url.trim() : ''

      // Windows：没有 AppleScript，走 PowerShell。页面级能力缺失的直接后果是
      // 拿不到新标签页的标题与最终 URL，所以只能回报「已发出打开请求」。
      if (be.transport === 'powershell') {
        const exe = await resolveWinExe(be)
        await runPowerShell(psOpen(exe, url), exec)
        return {
          text:
            url === ''
              ? `已启动 ${be.label}。`
              : `已在 ${be.label} 发出打开请求：${url}\n（Windows 后端无页面级能力，无法回报新标签页的标题与最终 URL。）`,
        }
      }

      // real:true —— 像人一样：移动鼠标点地址栏 → 输入 URL → 回车。
      // 地址栏属于浏览器 chrome，页面 JS 拿不到，只能走无障碍树的 AXTextField。
      if (useReal(args) && url !== '') {
        requireCap(be, 'realInput', '真实鼠标键盘')
        const rect = await runOsa(asAddressFieldRect(be), [], exec)
        const p = rect.split(FIELD_SEP)
        if (p[0] === 'ERR') throw new Error(`mac-browser：取地址栏失败 —— ${p[1] || '未知原因'}`)
        const cx = Math.round(Number(p[0]) + Number(p[2]) / 2)
        const cy = Math.round(Number(p[1]) + Number(p[3]) / 2)
        const move = await runOsa(jxaPointer(be.app, cx, cy, true, pointer), [], exec, 'JavaScript')
        await runOsa(asRealType(true), [url], exec)
        return {
          text:
            `已在 ${be.label} 用真实鼠标键盘导航：\n` +
            `  地址栏矩形来自无障碍树 @${p[0]},${p[1]} ${p[2]}x${p[3]} → 中心 (${String(cx)}, ${String(cy)})\n` +
            `  光标：${move}\n` +
            `  已输入 ${url} 并按下回车`,
        }
      }

      if (url === '') {
        await runOsa(asActivate(be), [], exec)
        return { text: `已把 ${be.label} 切到前台。` }
      }
      const stdout = await runOsa(asOpenTab(be), [url], exec)
      const p = stdout.split(FIELD_SEP)
      return { text: `已在 ${be.label} 打开：\n  ${p[0] || '(无标题)'}\n  ${p[1] || url}` }
    },
  })

  /* 3) 列标签页 ──────────────────────────────────────────────────────── */
  register({
    name: 'mac_browser_tabs',
    description:
      '列出 Safari 或 Google Chrome 全部窗口的标签页（窗口号、标签号、是否当前、标题、URL）。任何「第几个窗口/第几个标签」的操作都要先用它拿最新序号。',
    parameters: {
      type: 'object',
      properties: { browser: browserParam },
      required: [],
      additionalProperties: false,
    },
    output: textOutput({
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    }),
    async execute(args, exec) {
      const be = pickBackend(args?.browser)
      requireCap(be, 'tabs', '列标签页')
      const tabs = parseTabs(await runOsa(asListTabs(be), [], exec))
      if (tabs.length === 0) return { text: `${be.label} 当前没有打开的标签页（或没有窗口）。` }
      const body = tabs
        .map(
          (t) =>
            `${t.active ? '▶' : ' '} W${t.window}/T${t.index}  ${t.title || '(无标题)'}\n     ${t.url}`,
        )
        .join('\n')
      return { text: `${be.label} 共 ${tabs.length} 个标签页：\n${body}` }
    },
  })

  /* 4) 读正文 ────────────────────────────────────────────────────────── */
  register({
    name: 'mac_browser_read',
    description:
      '读取指定标签页的标题、URL 与可见正文（document.body.innerText）。不传 window/tab 时读前台窗口的当前标签页。注意：这会读到用户已登录页面的真实内容。',
    parameters: {
      type: 'object',
      properties: {
        browser: browserParam,
        window: { type: 'integer', description: '窗口序号；省略或 0 = 前台窗口。' },
        tab: { type: 'integer', description: '标签页序号；省略或 0 = 当前标签页。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: textOutput({
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    }),
    async execute(args, exec) {
      const be = pickBackend(args?.browser)
      const wi = Number.isInteger(args?.window) && args.window > 0 ? args.window : 0
      const ti = Number.isInteger(args?.tab) && args.tab > 0 ? args.tab : 0
      requireCap(be, 'read', '读正文')
      const stdout = await runOsa(asTabScript(be, 'read'), [String(wi), String(ti)], exec)
      const p = stdout.split(FIELD_SEP)
      if (p[0] === 'ERR') throw new Error(`mac-browser：${p[1] || '没有窗口'}`)
      const body = p[4] || ''
      // 读正文时 JS 错误是被 AppleScript 的 `on error` 接住、当成正常 payload
      // 返回的，走不到 runOsa 里 exitCode!==0 的 hintFor 分支 —— 这里必须自己
      // 翻译一次，否则用户拿到的是 Safari 那句英文原文，而不是可执行的提示。
      const jsHint = body.startsWith('JSERR:') ? hintFor(body) : ''
      const shown = jsHint === '' ? body : `${body}\n提示：${jsHint}`
      return {
        text: `【${p[2] || '(无标题)'}】 ${p[3] || ''}\n(W${p[0]}/T${p[1]})\n\n${shown || '(正文为空)'}`,
      }
    },
  })

  /* 5) 执行 JS ───────────────────────────────────────────────────────── */
  register({
    name: 'mac_browser_eval',
    description:
      '在用户真实浏览器的指定标签页里执行一段 JavaScript 表达式并返回结果。表达式由参数传入（不拼字符串），所以引号不用自己转义；让它返回字符串最稳。需要浏览器开启「允许 Apple 事件中的 JavaScript」。这是最强的操作手段：点击、填表、取数据都能做。',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: '要执行的 JavaScript 表达式，例如 document.querySelectorAll("a").length。',
        },
        browser: browserParam,
        window: { type: 'integer', description: '窗口序号；省略或 0 = 前台窗口。' },
        tab: { type: 'integer', description: '标签页序号；省略或 0 = 当前标签页。' },
      },
      required: ['expression'],
      additionalProperties: false,
    },
    output: textOutput({
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    }),
    async execute(args, exec) {
      const be = pickBackend(args?.browser)
      const expression = String(args?.expression ?? '')
      if (expression.trim() === '') throw new Error('mac-browser：expression 不能为空')
      const wi = Number.isInteger(args?.window) && args.window > 0 ? args.window : 0
      const ti = Number.isInteger(args?.tab) && args.tab > 0 ? args.tab : 0
      requireCap(be, 'eval', '执行 JS')
      // 包一层 try/catch。页面里的表达式抛错时，AppleScript 那边只会把结果变成
      // 字符串 "missing value" —— 模型看到的就是这么一句毫无信息的话，既不知道
      // 是语法错、变量不存在，还是页面根本没加载。包起来至少能把 message 带回来。
      // 顺带修掉一个老毛病：`{a:1}` 这种以 `{` 开头的表达式原来是语句块（返回 undefined），
      // 现在在括号里就按对象字面量求值。
      const wrapped = `(function () { try { return (${expression}) } catch (e) { return '⛔️ JS 报错：' + String((e && e.message) || e) } })()`
      const stdout = await runOsa(asTabScript(be, 'eval'), [String(wi), String(ti), wrapped], exec)
      const p = stdout.split(FIELD_SEP)
      if (p[0] === 'ERR') throw new Error(`mac-browser：${p[1] || '没有窗口'}`)
      return { text: `${p[3] || ''}\n→ ${p[4] || '(空结果)'}` }
    },
  })

  /* 6) 唤起前台 ──────────────────────────────────────────────────────── */
  register({
    name: 'mac_browser_activate',
    description: '把 Safari 或 Google Chrome 切到前台（必要时启动它）。',
    parameters: {
      type: 'object',
      properties: { browser: browserParam },
      required: [],
      additionalProperties: false,
    },
    output: textOutput({
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    }),
    async execute(args, exec) {
      const be = pickBackend(args?.browser)
      requireCap(be, 'activate', '唤起浏览器')
      if (be.transport === 'powershell') {
        const out = (await runPowerShell(psActivate(be), exec)).trim()
        if (out === 'not-running') {
          // 进程在但没有主窗口句柄，等价于没开；顺手启动一次。
          const exe = await resolveWinExe(be)
          await runPowerShell(psOpen(exe, ''), exec)
          return { text: `${be.label} 之前没有可用的窗口，已启动。` }
        }
        return { text: `已唤起 ${be.label}。` }
      }
      await runOsa(asActivate(be), [], exec)
      return { text: `已唤起 ${be.label}。` }
    },
  })

  /* 7) 关闭标签页 ────────────────────────────────────────────────────── */
  register({
    name: 'mac_browser_close',
    description:
      '关闭标签页。给了 url 就关闭指定窗口内所有 URL 包含该子串的标签页（内部总是从大到小关，不会因序号前移而关错，适合「关掉所有该站点」这类请求）；否则只关 window/tab 指定的那一个，两个都不传则关前台窗口的当前标签页。调用前先用 mac_browser_tabs 确认序号。',
    parameters: {
      type: 'object',
      properties: {
        browser: browserParam,
        url: { type: 'string', description: 'URL 子串；给了就关闭该窗口内所有匹配的标签页。' },
        window: { type: 'integer', description: '窗口序号；省略或 0 = 前台窗口。' },
        tab: { type: 'integer', description: '标签页序号；省略或 0 = 当前标签页。仅在未给 url 时生效。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: textOutput({
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    }),
    async execute(args, exec) {
      const be = pickBackend(args?.browser)
      requireCap(be, 'close', '关闭标签页')
      const wi = Number.isInteger(args?.window) && args.window > 0 ? args.window : 0
      const needle = typeof args?.url === 'string' ? args.url.trim() : ''

      if (needle !== '') {
        const stdout = await runOsa(asCloseByUrl(be), [needle, String(wi)], exec)
        const rows =
          stdout === ''
            ? []
            : stdout.split(RECORD_SEP).map((row) => {
                const p = row.split(FIELD_SEP)
                return { index: Number(p[0]), title: p[1] || '', url: p[2] || '' }
              })
        if (rows.length === 0) {
          return { text: `${be.label} 里没有 URL 含「${needle}」的标签页，未做任何改动。` }
        }
        const body = rows
          .map((r) => `  T${String(r.index)}  ${r.title || '(无标题)'}\n     ${r.url}`)
          .join('\n')
        return {
          text: `已关闭 ${be.label} 里 ${String(rows.length)} 个 URL 含「${needle}」的标签页：\n${body}`,
        }
      }

      const ti = Number.isInteger(args?.tab) && args.tab > 0 ? args.tab : 0
      const stdout = await runOsa(asCloseTab(be), [String(wi), String(ti)], exec)
      const p = stdout.split(FIELD_SEP)
      if (p[0] === 'ERR') throw new Error(`mac-browser：${p[1] || '没有窗口'}`)
      return {
        text: `已关闭 ${be.label} 的标签页：\n  W${p[0]}/T${p[1]}  ${p[2] || '(无标题)'}\n     ${p[3] || ''}`,
      }
    },
  })

  /* 8) 点击元素 ──────────────────────────────────────────────────────── */
  register({
    name: 'mac_browser_click',
    description:
      '在真实浏览器里点击页面元素 —— 模拟鼠标点击的主力。定位二选一：selector（CSS 选择器）或 text（可见文字，如「关闭」「搜索」「登录」）。按 text 定位时优先可交互元素、并在其中取面积最小的，避免点到包住整页的容器。匹配到多个用 index 选第几个（从 0 起）。默认走页内合成点击（不需额外权限）；配置了 pointer.mode: real 或单次传 real:true 时改走 CoreGraphics 真实鼠标 —— 光标会可见地走过去（需要「辅助功能」权限，且目标标签页必须在前台）。点击后页面可能跳转，需要重新观察时用 mac_browser_read / mac_browser_tabs。',
    parameters: {
      type: 'object',
      properties: {
        browser: browserParam,
        selector: { type: 'string', description: 'CSS 选择器，如 button.close、#submit。与 text 二选一。' },
        text: { type: 'string', description: '元素可见文字，如「关闭」。与 selector 二选一。' },
        exact: { type: 'boolean', description: 'text 是否要求完全相等；默认否（包含即可）。' },
        index: { type: 'integer', description: '匹配到多个时点第几个，从 0 起；默认 0。' },
        ref: { type: 'integer', description: '元素编号，来自 mac_browser_snapshot 的输出。**优先用它** —— 不用猜选择器，也不受「同名元素有多个」影响。与 selector / text 三选一。' },
        label: { type: 'string', description: '**按表单标签文字定位控件**，如「客户编码」「数量」。表单会重渲染、字段会增删，selector 的 nth-child 路径和缓存的 ref 都会整体错位；标签是语义，不受影响。与 selector / text / ref 四选一。' },
        real: { type: 'boolean', description: '用真实鼠标事件（CoreGraphics，光标会可见地移过去）代替页内合成点击；需要「辅助功能」权限，且会先把浏览器窗口切到前台。**目标标签页必须在最前面** —— 真实点击按屏幕坐标发出，会点到别的页面上，所以后台标签页会被直接拒绝。默认否；配了 config.pointer.mode: real 时默认为是，可显式传 false 单次关掉。' },
        x: { type: 'integer', description: '屏幕横坐标。给了 x/y 就直接在坐标上真实点击（**视觉兜底**用：DOM 找不到元素时先 mac_browser_screenshot 看图再给坐标）。Windows 上则是唯一可用的点击方式。' },
        y: { type: 'integer', description: '屏幕纵坐标。与 x 配对使用。' },
        window: { type: 'integer', description: '窗口序号；省略或 0 = 前台窗口。' },
        tab: { type: 'integer', description: '标签页序号；省略或 0 = 当前标签页。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: textOutput({
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    }),
    async execute(args, exec) {
      const be = pickBackend(args?.browser)
      const wi = Number.isInteger(args?.window) && args.window > 0 ? args.window : 0
      const ti = Number.isInteger(args?.tab) && args.tab > 0 ? args.tab : 0
      const selector = typeof args?.selector === 'string' ? args.selector.trim() : ''
      const text = typeof args?.text === 'string' ? args.text.trim() : ''
      const label = typeof args?.label === 'string' ? args.label.trim() : ''
      // Windows：没有页面级能力 → 定位不了元素，只能在显式坐标上发真实点击
      if (be.transport === 'powershell') {
        requireCap(be, 'realInput', '真实鼠标点击')
        const x = Number.isInteger(args?.x) ? args.x : undefined
        const y = Number.isInteger(args?.y) ? args.y : undefined
        if (x === undefined || y === undefined) {
          throw new Error(
            'mac-browser：Windows 后端无法按 selector/text 定位元素（没有页面级能力），必须显式给屏幕坐标 x / y。\n' +
              '坐标以屏幕左上角为原点。要拿到坐标可以用系统截图工具量，或等 CDP 后端接上。',
          )
        }
        await runPowerShell(psRealClick(x, y), exec)
        return { text: `已在 ${be.label} 的屏幕坐标 (${String(x)}, ${String(y)}) 发出真实鼠标点击。` }
      }

      // 显式坐标点击 —— 这是**视觉兜底**的动作那一半：DOM 定位失败时先用
      // mac_browser_screenshot 看图，由模型从图里给出屏幕坐标，再走这里。
      // 故意放在 selector/text 之前：坐标是更高的显式意图，不该被选择器逻辑抢走。
      if (Number.isInteger(args?.x) && Number.isInteger(args?.y)) {
        requireCap(be, 'realInput', '真实鼠标点击')
        const move = await runOsa(
          jxaPointer(be.app, args.x, args.y, true, pointer),
          [],
          exec,
          'JavaScript',
        )
        return {
          text: `已在 ${be.label} 的屏幕坐标 (${String(args.x)}, ${String(args.y)}) 发出真实鼠标点击。\n光标：${move}`,
        }
      }

      if (selector === '' && text === '' && label === '' && !Number.isInteger(args?.ref) && !(Number.isInteger(args?.x) && Number.isInteger(args?.y))) {
        throw new Error('mac-browser：selector / text / label / ref 至少要给一个（或给 x,y 直接点坐标）—— 不知道点什么就没法点。')
      }
      const options = {}
      if (selector !== '') options.selector = selector
      if (text !== '') options.text = text
      if (Number.isInteger(args?.ref)) options.ref = args.ref
      if (label !== '') options.label = label
      if (args?.exact === true) options.exact = true
      // index 必须**原样透传，包括 0**：selector 命中多个时，显式 index:0 是"我就要第一个"
      // 的意思，而"没给 index"是"我不知道有多个"——两者必须区分得开，否则歧义守卫
      // 会把明确的选择也拦下来。（原来写成 > 0 才透传，index:0 会被当成没给。）
      if (Number.isInteger(args?.index) && args.index >= 0) options.index = args.index

      // real:true（或全局 mode:'real'）—— 页内只负责定位，真实指针事件交给 JXA + CoreGraphics
      if (useReal(args)) {
        const located = await runInPage(be, '__mbLocate', options, wi, ti, exec)
        if (located.result.ok !== true) throw new Error(inPageError(located.result, options))
        assertFrontTab(located.result, '真实鼠标点击')
        const pt = await toScreen(be, located.result.vpGeo, located.result.vp, exec)
        const move = await runOsa(
          jxaPointer(be.app, pt.x, pt.y, true, pointer),
          [],
          exec,
          'JavaScript',
        )
        const idReal = located.result.id ? `#${located.result.id}` : ''
        return {
          text: `已用真实鼠标点击 ${be.label} 的 <${located.result.tag}${idReal}>「${located.result.text}」\n光标：${move}\n共匹配 ${String(located.result.count)} 个\n页面：${located.result.url}`,
        }
      }

      const { result } = await runInPage(be, '__mbClick', options, wi, ti, exec)
      if (result.ok !== true) throw new Error(inPageError(result, options))
      const idPart = result.id ? `#${result.id}` : ''
      return {
        text: `已点击 ${be.label} 的 <${result.tag}${idPart}>「${result.text}」（共匹配 ${String(result.count)} 个）\n页面：${result.url}`,
      }
    },
  })

  /* 9) 输入文字 ──────────────────────────────────────────────────────── */
  register({
    name: 'mac_browser_type',
    description:
      '在真实浏览器的输入框里打字。定位二选一：selector（CSS 选择器）或 text（占位符/标签/可见文字，如「搜索关键词」）。会整体替换输入框原内容；值通过原生 setter 写入并派发 input/change 事件，所以 React/Vue 这类受控组件也能收到。submit:true 会提交 —— 表单里有真正的提交按钮就点它，否则派发合成回车（该站点这类站点的「搜索」是个 div，只能靠回车）。',
    parameters: {
      type: 'object',
      properties: {
        browser: browserParam,
        value: { type: 'string', description: '要输入的文字。' },
        selector: { type: 'string', description: 'CSS 选择器，如 input#q。与 text 二选一。' },
        text: { type: 'string', description: '输入框的占位符/标签/可见文字，如「搜索关键词」。与 selector 二选一。' },
        ref: { type: 'integer', description: '元素编号，来自 mac_browser_snapshot 的输出。优先用它。与 selector / text 三选一。' },
        label: { type: 'string', description: '**按表单标签文字定位输入框**，如「数量」「客户编码」「商品名称」。表单重渲染会移位索引与缓存 ref，标签不会。与 selector / text / ref 四选一。' },
        index: { type: 'integer', description: 'selector 命中多个时取第几个，从 0 起。**不给就拒绝执行**（避免默默输错框）；确实要第一个就写 0。' },
        submit: { type: 'boolean', description: '输入后是否提交（默认否）。' },
        real: { type: 'boolean', description: '用真实键盘（System Events）代替页内赋值；需要「辅助功能」权限。会先真实点一下输入框确保焦点，再 Cmd+A 全选、用「写剪贴板 + Cmd+V」粘贴 —— 中文必须这么送，keystroke 直送中文会被拼音输入法吃成乱码。会短暂占用系统剪贴板（原本是文本则尽力还原）。**目标标签页必须在最前面**（真实点击按屏幕坐标发出），后台标签页会被直接拒绝。默认否；配了 config.pointer.mode: real 时默认为是，可显式传 false 单次关掉。' },
        window: { type: 'integer', description: '窗口序号；省略或 0 = 前台窗口。' },
        tab: { type: 'integer', description: '标签页序号；省略或 0 = 当前标签页。' },
      },
      required: ['value'],
      additionalProperties: false,
    },
    output: textOutput({
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    }),
    async execute(args, exec) {
      const be = pickBackend(args?.browser)
      const wi = Number.isInteger(args?.window) && args.window > 0 ? args.window : 0
      const ti = Number.isInteger(args?.tab) && args.tab > 0 ? args.tab : 0
      const selector = typeof args?.selector === 'string' ? args.selector.trim() : ''
      const text = typeof args?.text === 'string' ? args.text.trim() : ''
      const label = typeof args?.label === 'string' ? args.label.trim() : ''
      // Windows：定位不了输入框，只能把真实键盘输入送进当前焦点
      if (be.transport === 'powershell') {
        requireCap(be, 'realInput', '真实键盘输入')
        if (typeof args?.value !== 'string') throw new Error('mac-browser：value 必须是字符串。')
        await runPowerShell(psRealType(args.value, args?.submit === true), exec)
        return {
          text: `已在 ${be.label} 向**当前焦点**用真实键盘输入「${args.value}」${args?.submit === true ? '，并按下回车' : ''}。\n（Windows 后端无法按 selector/text 定位输入框；请先确保目标已获得焦点，例如用 mac_browser_click 给坐标点一下。实现是「写剪贴板 + Ctrl+V」，会占用你的剪贴板。）`,
        }
      }

      if (selector === '' && text === '' && label === '' && !Number.isInteger(args?.ref)) {
        throw new Error('mac-browser：selector / text / label / ref 至少要给一个 —— 不知道往哪个框里输。')
      }
      if (typeof args?.value !== 'string') throw new Error('mac-browser：value 必须是字符串。')
      const options = { value: args.value }
      if (selector !== '') options.selector = selector
      if (text !== '') options.text = text
      if (Number.isInteger(args?.ref)) options.ref = args.ref
      if (label !== '') options.label = label
      if (Number.isInteger(args?.index) && args.index >= 0) options.index = args.index
      if (args?.submit === true) options.submit = true

      // real:true（或全局 mode:'real'）—— 两步：先用真实鼠标「走」过去点中目标（可见），再走键盘
      if (useReal(args)) {
        options.focus = true
        const located = await runInPage(be, '__mbLocate', options, wi, ti, exec)
        if (located.result.ok !== true) throw new Error(inPageError(located.result, options))
        assertFrontTab(located.result, '真实键盘输入')
        const pt = await toScreen(be, located.result.vpGeo, located.result.vp, exec)
        const move = await runOsa(
          jxaPointer(be.app, pt.x, pt.y, true, pointer),
          [],
          exec,
          'JavaScript',
        )
        await runOsa(asRealType(args?.submit === true), [args.value], exec)
        const idReal = located.result.id ? `#${located.result.id}` : ''
        return {
          text: `已在 ${be.label} 的 <${located.result.tag}${idReal}> 用真实键盘输入「${args.value}」${args?.submit === true ? '，并按下回车' : ''}。\n光标：${move}\n页面：${located.result.url}`,
        }
      }

      const { result } = await runInPage(be, '__mbType', options, wi, ti, exec)
      if (result.ok !== true) throw new Error(inPageError(result, options))
      const how =
        result.submitted === 'submit-button'
          ? '已点击提交按钮'
          : result.submitted === 'enter-keys'
            ? '已派发合成回车'
            : '未提交'
      return {
        text: `已在 ${be.label} 的 <${result.tag}${result.id ? '#' + result.id : ''}> 输入「${result.value}」，${how}。\n页面：${result.url}`,
      }
    },
  })

  /* 10) 截图（视觉兜底的第一步）──────────────────────────────────────── */
  register({
    name: 'mac_browser_screenshot',
    description:
      '截取浏览器窗口（或指定元素）的屏幕图像，返回 PNG 路径，供模型用 read_image 查看。用途是 DOM 定位失败时的**视觉兜底**：先看截图确认元素在哪，再用 mac_browser_click 的 x/y 直接点。需要「屏幕录制」权限（与辅助功能、自动化相互独立）。默认截整个浏览器窗口；给了 selector 就只截那个元素。',
    parameters: {
      type: 'object',
      properties: {
        browser: browserParam,
        selector: {
          type: 'string',
          description: 'CSS 选择器；给了就只截这个元素（DOM 找得到才能截，所以主要用于「确认长得对不对」）。',
        },
        window: { type: 'integer', description: '窗口序号；省略或 0 = 前台窗口。' },
        tab: { type: 'integer', description: '标签页序号；省略或 0 = 当前标签页。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: textOutput({
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    }),
    async execute(args, exec) {
      const be = pickBackend(args?.browser)
      requireCap(be, 'screenshot', '截图')
      if (be.transport !== 'applescript') {
        throw new Error(`mac-browser：${be.label} 这个后端还没接截图。`)
      }
      const wi = Number.isInteger(args?.window) && args.window > 0 ? args.window : 0
      const ti = Number.isInteger(args?.tab) && args.tab > 0 ? args.tab : 0
      const selector = typeof args?.selector === 'string' ? args.selector.trim() : ''

      // 截图截的是**屏幕那一块区域**，不是「那个窗口」。浏览器不在前台时，压在它上面的
      // app 会被原样拍进来 —— 实测拍到了 DSH 自己的插件页，却报告「已截图（浏览器窗口）」，
      // 属于最坏的那种错：看着成功，内容全是错的。所以先把它切到前台再取矩形。
      await runOsa(asActivate(be), [], exec)
      await sleep(150)

      let rect
      let what
      if (selector !== '') {
        const located = await runInPage(be, '__mbLocate', { selector }, wi, ti, exec)
        if (located.result.ok !== true) throw new Error(inPageError(located.result, { selector }))
        // 截图要的是屏幕区域（点），同样不能把 CSS 像素直接当点 —— 走比例换算
        const origin = await toScreen(be, located.result.vpGeo, { x: 0, y: 0 }, exec)
        const vr = located.result.vpRect
        rect = {
          x: origin.x + Math.round(vr.x * origin.kx),
          y: origin.y + Math.round(vr.y * origin.ky),
          w: Math.max(1, Math.round(vr.w * origin.kx)),
          h: Math.max(1, Math.round(vr.h * origin.ky)),
        }
        what = `元素 ${selector}`
      } else {
        rect = await readWindowRect(be, exec)
        what = '浏览器窗口'
      }

      const outPath = join(tmpdir(), `mb-shot-${String(Date.now())}.png`)
      await runScreencapture(rect, outPath, exec)
      const size = await pngSize(outPath)
      const scale = size !== undefined && rect.w > 0 ? size.w / rect.w : 1

      return {
        text:
          `已截图（${what}）：${outPath}\n` +
          `  屏幕区域: x=${String(rect.x)} y=${String(rect.y)} w=${String(rect.w)} h=${String(rect.h)}\n` +
          `  图像尺寸: ${size ? `${String(size.w)}x${String(size.h)}` : '未知'}  缩放 ${scale.toFixed(2)}x\n` +
          `  坐标换算: 屏幕坐标 = (${String(rect.x)} + 图像x / ${scale.toFixed(2)}, ${String(rect.y)} + 图像y / ${scale.toFixed(2)})\n` +
          '用 read_image 看这张图；要点击时用 mac_browser_click 的 x / y 传屏幕坐标。',
      }
    },
  })

  /* 11) 页面快照（省往返的主力）──────────────────────────────────────── */
  register({
    name: 'mac_browser_snapshot',
    description:
      '返回当前标签页的**紧凑结构**：可见文字摘要 + 一个带编号的元素表（类型/标签/尺寸/是否禁用）。编号可直接用于 mac_browser_click / mac_browser_type 的 ref 参数。**探索陌生页面时优先用它** —— 一次调用就够，比反复写 mac_browser_eval 去 dump DOM 省得多，输出也小得多。注意：每次快照会**重新编号**，页面变化后旧 ref 失效。',
    parameters: {
      type: 'object',
      properties: {
        browser: browserParam,
        max: { type: 'integer', description: '最多返回多少个元素；默认 60，上限 200。' },
        textMax: {
          type: 'integer',
          description: '可见文字最多多少字符；默认 400（够看个大概），上限 8000，传 0 = 完全不要文字块。',
        },
        filter: {
          type: 'string',
          description:
            '只返回**标签里含这个词**的元素（不分大小写），并从 1 重新编号。给了它就**不返回可见文字块** —— 「我只想点某个东西」时用这个，token 最小。例：filter: "登录" 通常只剩 1–2 条。',
        },
        only: {
          type: 'string',
          enum: ['all', 'interactive'],
          description:
            'all（默认）连 cursor:pointer 的 div/li 一起收 —— 真实后台的导航常常没有 role/tabindex，只认语义标签会整个漏掉。interactive 只收语义可交互元素，输出更小，但可能漏掉靠样式绑事件的容器。',
        },
        window: { type: 'integer', description: '窗口序号；省略或 0 = 前台窗口。' },
        tab: { type: 'integer', description: '标签页序号；省略或 0 = 当前标签页。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: textOutput({
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    }),
    async execute(args, exec) {
      const be = pickBackend(args?.browser)
      requireCap(be, 'read', '读取页面结构')
      const wi = Number.isInteger(args?.window) && args.window > 0 ? args.window : 0
      const ti = Number.isInteger(args?.tab) && args.tab > 0 ? args.tab : 0
      const options = {}
      if (Number.isInteger(args?.max) && args.max > 0) options.max = args.max
      // textMax 允许 0（= 不要文字块），所以这里不能用 > 0 过滤掉它
      if (Number.isInteger(args?.textMax) && args.textMax >= 0) options.textMax = args.textMax
      if (args?.only === 'interactive') options.only = 'interactive'
      const filterText = typeof args?.filter === 'string' ? args.filter.trim() : ''
      if (filterText !== '') options.filter = filterText

      const { result } = await runInPage(be, '__mbSnapshot', options, wi, ti, exec)
      if (result.ok !== true) throw new Error('mac-browser：页面快照失败。')

      const head =
        `【${result.title}】 ${result.url}\n` +
        `视口 ${String(result.viewport.w)}x${String(result.viewport.h)}  已滚动 ${String(result.viewport.scrollY)}px`
      const rows = result.elements.map((e) => {
        const ref = String(e.ref).padStart(2, ' ')
        const kind = String(e.kind).padEnd(14, ' ')
        return `  ${ref}  ${kind} ${e.label || '(无标签)'}  ${String(e.w)}x${String(e.h)}${e.disabled ? '  [禁用]' : ''}`
      })
      const foot =
        filterText !== ''
          ? result.matched === 0
            ? ''
            : `\n（标签含「${filterText}」的共 ${String(result.matched)} 个，显示 ${String(result.shown)} 个）`
          : result.truncated
            ? `\n（共 ${String(result.total)} 个，只显示前 ${String(result.shown)} 个 —— 要更多就调大 max）`
            : ''
      const denominator = filterText !== '' ? result.matched : result.total
      const empty = result.elements.length === 0
        ? filterText !== ''
          ? `\n（元素表里没有标签含「${filterText}」的项 —— filter 只匹配**能点/能输的元素**，` +
            `页面上的纯文本不在表里。常见原因：还没渲染 / 要滚动 / 目标在别的标签页或折叠区里。` +
            `先 mac_browser_read 确认这段文字在不在当前这一页，再决定是滚动、切标签页，还是换 selector）`
          : ''
        : ''
      const textBlock = result.text ? `\n\n可见文字：\n${result.text}` : ''

      return {
        text:
          `${head}\n\n可见元素 ${String(result.shown)}/${String(denominator)}：\n` +
          `${rows.join('\n')}${empty}${foot}${textBlock}`,
      }
    },
  })

  /* 12) 真实滚轮滚动 ─────────────────────────────────────────────────── */
  register({
    name: 'mac_browser_scroll',
    description:
      '用**真实滚轮事件**（CoreGraphics）滚动页面 —— 和用户滚鼠标滚轮走同一条路径，页面看得见地滚动。两种用法：给 `direction` + `amount` 按像素滚；给 `ref`/`selector`/`text` 则先算出「把这个元素滚进视口」需要多少像素再滚（目标精确，不用估）。需要「辅助功能」权限，且**目标标签页必须在最前面**（真实滚轮按屏幕坐标发出），否则直接拒绝。滚动前后会对比所有可滚动容器，如实报告到底哪个盒子动了 —— SPA 常把滚动放在内层容器里，不这样读会谎报「没动」。',
    parameters: {
      type: 'object',
      properties: {
        browser: browserParam,
        direction: { type: 'string', description: 'down 或 up；给了 ref/selector/text 时忽略（按目标自动判断方向）。' },
        amount: { type: 'integer', description: '滚多少像素；默认 600。' },
        selector: { type: 'string', description: '滚到该元素可见。与 text / ref 三选一。' },
        text: { type: 'string', description: '滚到含该可见文字的元素。与 selector / ref 三选一。' },
        ref: { type: 'integer', description: '元素编号，来自 mac_browser_snapshot。优先用它。' },
        offset: { type: 'integer', description: '滚到目标时，让元素距视口顶部留多少像素；默认 120。' },
        steps: { type: 'integer', description: '拆成几次滚轮事件发，默认 12；步数越多越平滑。' },
        window: { type: 'integer', description: '窗口序号；省略或 0 = 前台窗口。' },
        tab: { type: 'integer', description: '标签页序号；省略或 0 = 当前标签页。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: textOutput({
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    }),
    async execute(args, exec) {
      const be = pickBackend(args?.browser)
      requireCap(be, 'realInput', '真实滚轮滚动')
      const wi = Number.isInteger(args?.window) && args.window > 0 ? args.window : 0
      const ti = Number.isInteger(args?.tab) && args.tab > 0 ? args.tab : 0
      const selector = typeof args?.selector === 'string' ? args.selector.trim() : ''
      const text = typeof args?.text === 'string' ? args.text.trim() : ''
      const hasTarget = selector !== '' || text !== '' || Number.isInteger(args?.ref)
      const offset = Number.isInteger(args?.offset) ? args.offset : 120

      let deltaY
      let what
      // 光标停在哪：目标模式停在元素上（滚轮只滚**光标底下**那个盒子，
      // 停在窗口中心会滚到别的盒子里去）；按方向滚则停在视口中心。
      let point
      if (hasTarget) {
        // 先算出「滚到目标可见」需要多少像素，再发真实滚轮
        const options = {}
        if (selector !== '') options.selector = selector
        if (text !== '') options.text = text
        if (Number.isInteger(args?.ref)) options.ref = args.ref
        if (Number.isInteger(args?.offset)) options.offset = args.offset
        const { result } = await runInPage(be, '__mbScrollDelta', options, wi, ti, exec)
        if (result.ok !== true) throw new Error(inPageError(result, options))
        const where = result.scope === 'container' ? `容器 ${String(result.box)}` : '窗口'
        if (result.delta === 0) {
          return {
            text:
              `「${result.text}」已经到位，未滚动。\n` +
              `${where}当前滚动 ${String(result.from)}px（上限 ${String(result.maxY)}px，距目标约 ${String(offset)}px）。`,
          }
        }
        deltaY = -result.delta   // 轮子：负值向下；delta 为正表示需要向下
        point = result
        what =
          `滚到「${result.text}」：${where} ${String(result.from)}px → ${String(result.to)}px` +
          `（目标距容器顶 ${String(offset)}px，可滚动上限 ${String(result.maxY)}px）`
      } else {
        const dir = args?.direction === 'up' ? 'up' : 'down'
        const amount = Number.isInteger(args?.amount) && args.amount > 0 ? args.amount : 600
        deltaY = dir === 'up' ? amount : -amount
        what = `${dir === 'up' ? '向上' : '向下'}滚 ${String(amount)}px`
      }

      // 真实滚轮作用于**光标下的那个窗口**，所以先确认目标页就在前台
      const before = (await runInPage(be, '__mbScrollState', {}, wi, ti, exec)).result
      if (before.ok !== true) throw new Error(`mac-browser：读不到页面滚动状态（${JSON.stringify(before)}）。`)
      assertFrontTab(before, '真实滚轮滚动')
      if (before.windowMax === 0 && before.list.length === 0) {
        return {
          text:
            `${what}\n` +
            '这个页面**没有可滚动的内容**（文档高 = 视口高，也没有内层可滚动容器），所以没发滚轮 —— 整页都在视口里了。',
        }
      }

      // 光标落点：目标模式用页内算好的那个点（在要滚的盒子上）；
      // 方向模式用视口中心。两者都只拿 CSS 像素，屏幕点交给 toScreen 按比例换算。
      const g = before.geo
      const vpGeo = { outerW: g.w, outerH: g.h, innerW: g.vw, innerH: g.vh, chromeH: g.chromeH }
      const vp = point ? point.vp : { x: Math.round(g.vw / 2), y: Math.round(g.vh / 2) }
      const at = await toScreen(be, point ? point.vpGeo : vpGeo, vp, exec)

      const move = await runOsa(
        jxaScroll(be.app, at.x, at.y, deltaY, args?.steps, Math.max(8, pointer.stepMs)),
        [],
        exec,
        'JavaScript',
      )

      // 回读：否则「命令成功但页面没动」会被当成成功报出去。
      // 只读 window.scrollY 不够 —— SPA 把滚动放在内层容器里时它恒为 0，
      // 明明滚了也会报「没动」。所以读全部盒子，做前后 diff，谁动了说谁。
      await sleep(450)
      const after = (await runInPage(be, '__mbScrollState', {}, wi, ti, exec)).result
      const moved = []
      if (after?.ok === true) {
        if (after.windowY !== before.windowY) {
          moved.push(`窗口 ${String(before.windowY)} → ${String(after.windowY)}px`)
        }
        const n = Math.min(before.list.length, after.list.length)
        for (let i = 0; i < n; i += 1) {
          if (before.list[i].top !== after.list[i].top) {
            moved.push(`${before.list[i].name} ${String(before.list[i].top)} → ${String(after.list[i].top)}px`)
          }
        }
      }
      const verdict =
        after?.ok !== true
          ? '实际滚动：读不回状态，无法确认页面是否真的动了。'
          : moved.length > 0
            ? `实际滚动：${moved.join('；')}`
            : '实际滚动：**没有任何盒子移动** —— 滚轮没落在可滚动区域，或已经到顶/底了。'
      return { text: `${what}\n滚轮：${move}\n${verdict}` }
    },
  })

  /* 13) 必填项前置检查 ───────────────────────────────────────────────── */
  register({
    name: 'mac_browser_formcheck',
    description:
      '扫出**必填但为空**的表单字段 —— 点「提交」之前的前置检查，提交表单前应当先跑它。' +
      '要解决的问题：指令里没提到的字段却是必填的，直接提交会被服务端挡回来，' +
      '而错误往往只给一句笼统的「提示异常」，既不知道是哪个字段、也不知道为什么。' +
      '这里把清单在提交**之前**拿出来。**查到未填项时不要自己挑值填上** —— ' +
      '替用户选一个业务值属于猜测，可能悄悄改掉单据性质；应当把清单一次性列给用户问清楚。' +
      '识别三路：框架必填标记（如 Element Plus 的 .el-form-item.is-required）、原生 required / aria-required、以及控件自身是否为空。',
    parameters: {
      type: 'object',
      properties: {
        browser: browserParam,
        window: { type: 'integer', description: '窗口序号；省略或 0 = 前台窗口。' },
        tab: { type: 'integer', description: '标签页序号；省略或 0 = 当前标签页。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: textOutput({
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    }),
    async execute(args, exec) {
      const be = pickBackend(args?.browser)
      requireCap(be, 'eval', '表单必填项检查')
      const wi = Number.isInteger(args?.window) && args.window > 0 ? args.window : 0
      const ti = Number.isInteger(args?.tab) && args.tab > 0 ? args.tab : 0
      const { result } = await runInPage(be, '__mbFormCheck', {}, wi, ti, exec)
      if (result?.ok !== true) throw new Error(`mac-browser：表单必填项检查失败（${JSON.stringify(result)}）。`)
      if (result.count === 0) {
        return { text: `表单必填项检查：**未发现空的必填字段**，可以提交。\n页面：${result.url}` }
      }
      const kindName = { select: '下拉', date: '日期', choice: '单选/多选', text: '文本', other: '其他' }
      const rows = result.items.map((it, i) => `  ${String(i + 1)}. ${it.label}（${kindName[it.kind] || it.kind}）`)
      return {
        text:
          `表单必填项检查：**发现 ${String(result.count)} 个必填但为空的字段** —— 先不要提交。\n` +
          rows.join('\n') +
          '\n这些字段指令里没有提到。**不要自己挑一个值填上** —— 替用户选业务值属于猜测，' +
          '可能悄悄改掉单据性质（把某个下拉随便选成默认项就属于这种情况）。请把这份清单**一次性**列给用户，' +
          '问清各自填什么再继续。\n' +
          `页面：${result.url}`,
      }
    },
  })

  /* 15) 把宿主应用切回前台 ─────────────────────────────────────────────── */
  // 用 argv 传 app 路径，不经过 shell —— 没有引号/注入面。
  const runOpen = async (appPath, exec) => {
    const handle = ctx.subprocess.spawn({
      argv: ['/usr/bin/open', '-a', appPath],
      cwd: workdir,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
      graceMs: GRACE_MS,
      ...(exec?.signal !== undefined ? { signal: exec.signal } : {}),
    })
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      throw new Error(`open 启动失败：${String((error && error.message) || error)}`)
    }
    const err = readCollected(handle, 'stderr').trim()
    if (outcome.exitCode !== 0) throw new Error(`open 退出码 ${String(outcome.exitCode)}：${err || '无 stderr'}`)
  }

  // 宿主应用：配置优先，其次从本进程的 execPath 推，最后退回 DSH Desktop。
  const hostApp = () => {
    const configured = typeof cfg.hostApp === 'string' ? cfg.hostApp.trim() : ''
    if (configured !== '') {
      const asPath = hostAppFromExecPath(configured)
      if (asPath !== undefined) return asPath
      const name = configured.replace(/^.*\//, '').replace(/\.app$/, '')
      return { name, appPath: configured.endsWith('.app') ? configured : `/Applications/${name}.app` }
    }
    return hostAppFromExecPath(process.execPath) || { name: 'DSH Desktop', appPath: '/Applications/DSH Desktop.app' }
  }

  register({
    name: 'mac_browser_host_focus',
    description:
      '把**宿主应用**（跑着本 agent 的那个 app，例如 DSH Desktop）切到前台；被最小化则还原，未运行则启动。' +
      '**需要向用户提问时、以及任务结束时，应当先调用它。** ' +
      '用户在 agent 干活期间往往已经切到别处去了 —— 不把宿主拉回前台，你的提问和结论根本不会被看见，' +
      '表面上是"卡住了"，实际是在等人回答。',
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', description: '要切到前台的 app 名；省略则用自动识别的宿主应用（通常就是 DSH Desktop）。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: textOutput({
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    }),
    async execute(args, exec) {
      if (process.platform !== 'darwin') throw new Error('mac-browser：宿主激活目前只实现了 macOS。')
      const host = hostApp()
      const wanted = typeof args?.app === 'string' && args.app.trim() !== '' ? args.app.trim() : host.name
      const out = await runOsa(asHostFocus(wanted), [], exec)
      const parts = out.split(FIELD_SEP)
      if (parts[0] === 'NOT_RUNNING') {
        await runOpen(host.appPath, exec)
        return { text: `宿主应用「${wanted}」当时不在运行，已启动：${host.appPath}` }
      }
      const restored = Number(parts[1] || 0)
      return {
        text:
          `已把宿主应用「${wanted}」切到前台` +
          (restored > 0 ? `，并还原了 ${String(restored)} 个被最小化的窗口` : '') +
          '。\n' +
          '（提问与任务结束时都应当先做这一步，否则用户可能根本看不到。）',
      }
    },
  })

  /* 14) 站点配方 ─────────────────────────────────────────────────────── */
  register({
    name: 'mac_browser_recipe',
    description:
      '执行一条预配置的**站点操作配方**（写在插件 config.recipes 里）。配方把「某个网站上的固定操作」固化成声明式步骤，省得每次现编选择器，页面小改也只改配置。省略 name 就列出当前所有可用配方。配方若声明了 match，则当前标签页 URL 必须包含它，否则拒绝执行。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '配方名。省略则只列出可用配方，不执行。' },
        vars: { type: 'object', description: '变量表，用来替换步骤里的 {{name}}。例如 { query: "关键词" }。' },
        real: { type: 'boolean', description: '这条配方的默认输入方式：true = 真实鼠标键盘（慢但更稳，光标可见）。步骤里可单独覆盖。默认否；配了 config.pointer.mode: real 时缺省为 true。' },
        browser: browserParam,
        window: { type: 'integer', description: '窗口序号；省略或 0 = 前台窗口。' },
        tab: { type: 'integer', description: '标签页序号；省略或 0 = 当前标签页。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: textOutput({
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    }),
    async execute(args, exec) {
      const be = pickBackend(args?.browser)
      const wi = Number.isInteger(args?.window) && args.window > 0 ? args.window : 0
      const ti = Number.isInteger(args?.tab) && args.tab > 0 ? args.tab : 0
      const name = typeof args?.name === 'string' ? args.name.trim() : ''

      if (name === '') {
        if (recipes.length === 0) {
          return {
            text:
              '当前没有配置任何配方。\n在 profile 的 cordis.patch.yml 里给 mac-browser 加 config.recipes，例如：\n' +
              '  recipes:\n' +
              '    - name: example-search\n' +
              '      match: example.com\n' +
              '      steps:\n' +
              '        - click: input.nav-search-input\n' +
              '        - type: { selector: input.nav-search-input, value: "{{query}}", submit: true }',
          }
        }
        const lines = recipes.map((r) => {
          const head = `  ${r.name}${r.match ? `  （限 URL 含 ${r.match}）` : ''}`
          const desc = r.description ? `\n      ${r.description}` : ''
          return `${head}\n      ${String(r.steps.length)} 步${desc}`
        })
        return { text: `可用配方（${String(recipes.length)} 条）：\n${lines.join('\n')}` }
      }

      const recipe = recipeByName.get(name)
      if (recipe === undefined) {
        return {
          text: `没有名为「${name}」的配方。当前可用：${recipes.map((r) => r.name).join(', ') || '（无）'}`,
        }
      }

      // match 是一道闸：配方通常绑定在特定站点，跑错页面会点出莫名其妙的结果。
      if (typeof recipe.match === 'string' && recipe.match !== '') {
        const cur = await invokeTool(
          'mac_browser_eval',
          { browser: be.id, window: wi, tab: ti, expression: 'location.href' },
          exec,
        )
        const href = cur.text.includes('→ ') ? cur.text.slice(cur.text.indexOf('→ ') + 2).trim() : ''
        if (!href.includes(recipe.match)) {
          throw new Error(
            `mac-browser：配方「${name}」限定在 URL 含「${recipe.match}」的页面执行，当前是 ${href}。\n` +
              '先用 mac_browser_open 打开对应站点；或去掉该配方的 match。',
          )
        }
      }

      const vars = args?.vars && typeof args.vars === 'object' ? { ...args.vars } : {}
      const base = { browser: args?.browser, real: useReal(args), window: wi, tab: ti }
      const trace = []

      for (let i = 0; i < recipe.steps.length; i++) {
        try {
          trace.push(`${String(i + 1)}. ${await runRecipeStep(recipe.steps[i], vars, base, exec)}`)
        } catch (error) {
          const msg = String((error && error.message) || error)
          throw new Error(
            `mac-browser：配方「${name}」在第 ${String(i + 1)} 步失败：${msg}\n` +
              `已完成：\n${trace.map((t) => `  ${t}`).join('\n') || '  （无）'}`,
          )
        }
      }

      return {
        text: `配方「${name}」执行完成（${String(recipe.steps.length)} 步）：\n${trace.map((t) => `  ${t}`).join('\n')}`,
      }
    },
  })
}
