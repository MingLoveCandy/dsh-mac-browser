/**
 * 浏览器半侧：把「鼠标输入模式」做成插件页里的一个控件。
 *
 * 为什么需要这个文件：DSH 不会按 Config schema 自动生成页面 —— `settings` 服务虽然
 * 带了 `autoGenerate` 字段，但没有任何已发布的客户端真的去生成。插件页里那个
 * 「配置」入口，只在插件自己往 `plugins.row.config` 槽注册页面时才出现。
 *
 * 槽位约定（DSH 0.2.2-rc.1）：
 *   · 名字：`plugins.row.config`
 *   · key ：`<包名>#<patch 行 id>`，我们的是 `dsh-mac-browser#mac-browser`
 *   · props：`{ view: 'summary' | 'page', form?: { state, mutate } }`
 *
 * 保存走 `form.mutate([{ op: 'set', path: ['pointer', 'mode'], value }], revision)`，
 * 直接落回 profile 的那一行配置 —— 和手改 cordis.patch.yml 是同一件事，只是不用开文件。
 * 因为改的是普通字段，保存后这一行会重启一次，pointer.mode 正好需要重启才生效。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mac-browser',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /** 与 bundle patch 里 `- id: mac-browser` 对应；改行 id 的话这里要一起改。 */
    const ROW_KEY = 'dsh-mac-browser#mac-browser'

    const MODES = [
      { value: 'synthetic', label: '页内合成', hint: '快，不依赖前台；系统光标不动' },
      { value: 'real', label: '真实鼠标', hint: '光标会真的走过去；每次约 1.5 秒' },
    ]

    /** 从表单快照里读出当前模式；读不到就按缺省值显示。 */
    function readMode(form) {
      const value = form && form.state && form.state.value
      const pointer = value && typeof value === 'object' ? value.pointer : undefined
      return pointer && pointer.mode === 'real' ? 'real' : 'synthetic'
    }

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '10px', margin: '16px 0' },
      title: { margin: 0, fontSize: '14px', fontWeight: 500 },
      hint: { margin: 0, fontSize: '12.5px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary, #666)' },
      row: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
      option: (active, disabled) => ({
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
        padding: '6px 12px',
        borderRadius: '8px',
        cursor: disabled ? 'default' : 'pointer',
        border: `1px solid ${active ? 'var(--dsw-alias-state-business-primary, #247bbf)' : 'var(--dsw-alias-border-l2, #d0d0d0)'}`,
        background: active ? 'var(--dsw-alias-bg-layer-3, #eef4fb)' : 'transparent',
        color: 'var(--dsw-alias-label-primary, #222)',
        opacity: disabled ? 0.6 : 1,
      }),
      error: { margin: 0, fontSize: '12.5px', color: 'var(--dsw-alias-state-error-primary, #c0392b)' },
    }

    /**
     * 一行模式说明 + 两个可点选项。点一下即保存，不设「保存」按钮 ——
     * 只有两个值，多一步确认反而烦。
     */
    function PointerModeConfig(props) {
      const view = props && props.view
      const form = props && props.form
      const state = form && form.state
      const mode = readMode(form)
      const writable = !state || state.writable !== false
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      // summary 视图拿不到 form（上层只在 page 视图传），所以这里没有值可读。
      // 与其猜一个模式去显示，不如什么都不渲染 —— 那一行会退回它的普通描述。
      if (view === 'summary') return null

      const choose = (next) => {
        if (busy || !form || next === mode) return
        setBusy(true)
        setError('')
        Promise.resolve(
          form.mutate([{ op: 'set', path: ['pointer', 'mode'], value: next }], state && state.revision),
        )
          .then((ok) => {
            if (ok === false) setError('保存被拒绝：配置可能刚被别处改过，刷新后再试。')
          })
          .catch((failure) => {
            setError(String((failure && failure.message) || failure))
          })
          .then(() => setBusy(false))
      }

      return h(
        'section',
        { style: styles.wrap },
        h('h3', { style: styles.title }, '鼠标输入模式'),
        h(
          'div',
          { style: styles.row },
          MODES.map((item) =>
            h(
              'button',
              {
                key: item.value,
                type: 'button',
                disabled: busy || !writable,
                style: styles.option(item.value === mode, busy || !writable),
                onClick: () => choose(item.value),
              },
              item.label,
            ),
          ),
        ),
        h('p', { style: styles.hint }, MODES.find((item) => item.value === mode).hint),
        h(
          'p',
          { style: styles.hint },
          '页内合成：在页面里派发一个合成 click，页面照样响应，但系统鼠标没参与，所以指针一动不动。' +
            '真实鼠标：走 CoreGraphics，光标会从当前位置走过去 —— 代价是每次约 1.5 秒，且目标标签页必须在前台。',
        ),
        error === '' ? null : h('p', { style: styles.error }, error),
        writable ? null : h('p', { style: styles.hint }, '当前 profile 不接受写入，只能改配置文件。'),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('plugins.row.config', () =>
        ctx.slots.register({ name: 'plugins.row.config', key: ROW_KEY }, PointerModeConfig),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
