// dsh-peak-guard · 客户端半边（浏览器里那一半）
//
// 形态照 DSH 官方 skill 的 `templates/decoration/client.js`：
//   window.__ModuleLoader__.load({ id: <包名>, factory(require) { … return { inject, apply } } })
// 三条硬规矩（官方 skill 明写，踩了会被判不合规）：
//   1. **不 import 任何 DSH 自带的客户端包**（包括 @deepseek-ai/dsh-client-ui-primitives），
//      UI 全部手写；样式**只用主题令牌** `--dsw-alias-*`，浅色/深色自动跟随。
//   2. **factory 里不许有副作用**：装样式、起定时器、挂监听器全部在 apply 里，用
//      ctx.effect 登记并在卸载时清理。
//   3. 文案走人不走硬编码？—— 这里**故意**不做 locale 注入：多声明一个可能缺席的服务
//      会让 fiber 停在 PENDING，代价（整块控件不出现）远大于收益。文案按 navigator.language
//      在中英两套里挑一套，见 STRINGS。
//
// 它只做一件事：在输入框工具行左边放一个高峰保护开关，状态从宿主半边的
// `GET /peak-guard/state` 读、点击 `POST /peak-guard/set` 写（同源 fetch + 自定义头防 CSRF）。

window.__ModuleLoader__.load({
  id: 'dsh-peak-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 插槽：输入框工具行左侧的紧凑控件区（list 插槽，必须有 id）。 */
    const SLOT = 'conversation.input.left'
    const ENTRY_ID = 'peak-guard-toggle'
    const ORDER = 20

    /**
     * 插槽：**输入框卡片上方**的整宽条目（`conversation.input.dock`）。
     *
     * 为什么不是「聊天记录顶部」：DSH 的插槽体系里没有那个座位 —— 会话区可加的整宽 list 座位
     * 只有 input.dock（输入框上方）和 composer.dock（输入框下方），而 `conversation.session` /
     * `conversation.header` 这些顶部座位是 single 且已被自带 UI 占满（replaceRisk: shadows-shipped-ui）。
     * 那张「任务」卡其实是 `todo_write` 的**行内 tool-call 视图**（tool.call.toolview 里 key=todo_write），
     * 不是顶部插槽，所以无法照搬位置、只能照搬外观。
     */
    const STRIP_SLOT = 'conversation.input.dock'
    const STRIP_ID = 'peak-guard-pending'
    const STRIP_ORDER = 15

    /** 设置页一次拿多少条记录（宿主上限 200）。 */
    const SETTINGS_LIST_LIMIT = 200
    /** 设置页在左侧导航里的位置（照 dsh-archived-chats 用 30，我们在它后面）。 */
    const SETTINGS_SLOT = 'settings.section'
    const SETTINGS_ID = 'peak-guard-records'
    const SETTINGS_ORDER = 40

    const STATE_URL = '/peak-guard/state'
    const SET_URL = '/peak-guard/set'
    /** 轮询间隔：这个开关不需要秒级精度，20 秒足够，且只在页面可见时轮询。 */
    const POLL_MS = 20000
    const TAG = '[peak-guard]'

    const ZH = {
      label: '高峰保护',
      on: '高峰保护已开启',
      off: '高峰保护已关闭',
      blocking: '现在是高峰，模型调用会被拦下',
      offpeak: '现在是谷时，模型调用放行',
      blocked: (n) => `本次运行已拦下 ${n} 次模型调用`,
      nextOffpeak: (clock, rest) => `谷时 ${clock} 开始（还有 ${rest}）`,
      nextPeak: (clock, rest) => `下一段高峰 ${clock} 开始（${rest} 后）`,
      hintOff: '点击打开：高峰时段不调用模型，直接回你一句',
      hintOn: '点击关闭：谷时以外也一律放行',
      unavailable: '宿主半边未就绪（改过插件代码需要重启 DSH）',
      killed: '被环境变量 DSH_PEAK_GUARD 关掉了',
      // 被拦截列表（只读）
      pendingTitle: (n) => `高峰期间有 ${n} 条请求被拦下`,
      pendingNote: '这些请求没有发给模型，也没有产生费用',
      expand: '展开列表',
      collapse: '收起列表',
      dismiss: '关闭这个列表',
      markDone: '标为已办',
      markUndone: '标回待办',
      emptyList: '列表是空的',
      moreNote: '只显示最新的几条',
      // 设置页「拦截记录」
      settingsLabel: '拦截记录',
      setTitle: '拦截记录',
      setEmpty: '暂无拦截记录',
      setNoMatch: '没有匹配的记录',
      tabAll: '全部',
      tabTodo: '待办',
      tabDone: '已办',
      tabSkipped: '跳过',
      searchPlaceholder: '搜索请求内容或会话 id',
      markAll: '全部标为已办',
      markAllHint: '把当前所有记录标成已办（只是勾选状态，不影响拦截）',
      markedAll: '已全部标为已办',
      clear: '清空记录',
      clearConfirm: '确认清空？',
      clearConfirmHint: '再点一次「确认清空」就会删掉全部记录，不能撤销。',
      cleared: '记录已清空',
      removeOne: '删除这条记录',
      restoreOne: '点一下恢复为待办',
      skippedHint: '关掉展示框时它还没被处理',
      setFailed: '操作失败',
      truncatedNote: '只显示了最新的 200 条；更早的记录已按上限丢弃。',
      hostDown: '读不到宿主状态（改过插件代码需要重启 DSH）',
    }
    const EN = {
      label: 'Peak guard',
      on: 'Peak guard is on',
      off: 'Peak guard is off',
      blocking: 'Peak pricing now — model calls are blocked',
      offpeak: 'Off-peak now — model calls pass through',
      blocked: (n) => `${n} model call${n === 1 ? '' : 's'} blocked this run`,
      nextOffpeak: (clock, rest) => `Off-peak starts ${clock} (in ${rest})`,
      nextPeak: (clock, rest) => `Next peak starts ${clock} (in ${rest})`,
      hintOff: 'Click to enable: during peak hours the model is not called at all',
      hintOn: 'Click to disable: calls pass through outside peak hours too',
      unavailable: 'Host half not ready (restart DSH after changing plugin code)',
      killed: 'Disabled by the DSH_PEAK_GUARD environment variable',
      pendingTitle: (n) => `${n} request${n === 1 ? '' : 's'} blocked during peak`,
      pendingNote: 'They were never sent to the model and cost nothing',
      expand: 'Expand the list',
      collapse: 'Collapse the list',
      dismiss: 'Dismiss this list',
      markDone: 'Mark as done',
      markUndone: 'Mark as to-do',
      emptyList: 'The list is empty',
      moreNote: 'showing the newest only',
      settingsLabel: 'Blocked requests',
      setTitle: 'Blocked requests',
      setEmpty: 'Nothing blocked yet',
      setNoMatch: 'No matching records',
      tabAll: 'All',
      tabTodo: 'To-do',
      tabDone: 'Done',
      tabSkipped: 'Skipped',
      searchPlaceholder: 'Search request text or session id',
      markAll: 'Mark all as done',
      markAllHint: 'Marks every record as done (a local checkbox; blocking is unaffected)',
      markedAll: 'All marked as done',
      clear: 'Clear records',
      clearConfirm: 'Confirm clear?',
      clearConfirmHint: 'Click again to delete every record. This cannot be undone.',
      cleared: 'Records cleared',
      removeOne: 'Delete this record',
      restoreOne: 'Click to restore as a to-do',
      skippedHint: 'This was still unhandled when you closed the card',
      setFailed: 'Action failed',
      truncatedNote: 'Only the newest 200 records are shown; older ones were dropped by the cap.',
      hostDown: 'Cannot read host state (restart DSH after changing plugin code)',
    }
    const STRINGS = (() => {
      try {
        const language = typeof navigator === 'object' && typeof navigator.language === 'string' ? navigator.language : 'zh'
        return language.toLowerCase().startsWith('zh') ? ZH : EN
      } catch {
        return ZH
      }
    })()

    // ── 样式：只用主题令牌，浅色/深色自动跟随 ─────────────────────────────
    const CSS = `
.pk-guard{position:relative;display:inline-flex;align-items:center}
.pk-guard__btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background 120ms ease,color 120ms ease}
.pk-guard__btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pk-guard__btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.pk-guard__btn[data-on="true"]{color:var(--dsw-alias-brand-primary)}
.pk-guard__btn[data-blocking="true"]{color:var(--dsw-alias-state-warn-primary)}
.pk-guard__btn[data-unavailable="true"]{color:var(--dsw-alias-state-idle-primary);cursor:default}
.pk-guard__btn[data-busy="true"]{opacity:.6;cursor:progress}
.pk-guard__dot{position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-state-warn-primary)}
.pk-guard__tip{position:fixed;z-index:60;min-width:190px;max-width:280px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-overlay);box-shadow:0 6px 20px rgb(0 0 0 / 18%);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.55;white-space:normal;pointer-events:none}
.pk-guard__tip b{font-weight:600}
.pk-guard__tip span{display:block;color:var(--dsw-alias-label-secondary)}
.pk-badge{position:absolute;top:-2px;left:-2px;min-width:14px;height:14px;padding:0 3px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary-foreground);font-size:9px;line-height:14px;text-align:center;font-weight:600}

/* 被拦截列表卡片：几何/宽度/圆角/行高照抄 DSH 官方那张 composer 卡片的规则
   （原型的 root/body/head/lead/title/progress/chevron/list/item/glyph/content 一字不差搬过来，
   只换前缀），所以它跟官方卡片同宽、同行高、同节奏，不会自己长出另一种观感。 */
.pk-card{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-panel);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border:0;flex:none;margin:0 auto;overflow:hidden}
.pk-card__body{flex-direction:column;gap:8px;padding:6px 12px;display:flex}
.pk-card__head{text-align:left;background:0 0;border:none;align-items:center;gap:10px;width:100%;padding:0;display:flex}
.pk-card__lead{color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid}
.pk-card__title{color:var(--dsw-alias-label-primary);flex:none;font-size:13px;font-weight:500;line-height:24px}
.pk-card__progress{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:13px;font-weight:400;line-height:20px;overflow:hidden}
.pk-card__progress--bad{color:var(--dsw-alias-state-error-primary)}
.pk-card__progress--ok{color:var(--dsw-alias-state-success-primary)}
.pk-card__actions{display:flex;align-items:center;gap:0;flex:none}
/* 折叠键与关闭键共用同一套外观（20×20、圆角、悬停底色）。
   SVG 必须 display:block —— 作为 inline 元素时它按**文字基线**对齐，会在按钮里被顶高约 1.4px。
   （踩过一次：折叠箭头外面曾包一层丢掉样式的 <span>，量用户截图才发现它比 × 高 1.44px。） */
.pk-card__iconbtn{display:grid;place-items:center;width:20px;height:20px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background 120ms ease,color 120ms ease}
.pk-card__iconbtn > svg{display:block}
.pk-card__iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.pk-card__iconbtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.pk-card__list{flex-direction:column;gap:8px;max-height:180px;margin:0;padding:0;list-style:none;display:flex;overflow-y:auto}
.pk-card__item{min-width:0;color:var(--dsw-alias-label-secondary);align-items:center;gap:10px;font-size:13px;line-height:20px;display:flex}
.pk-card__item--done{color:var(--dsw-alias-label-tertiary)}
.pk-card__item--done .pk-card__content{text-decoration:line-through}
/* 行首那颗图标同时是勾选键：**三种状态共用同一个 SVG**（实心点 / 对勾 / 空心环+斜杠）。
   圆环是同一个 <circle> 从实心撑开的（r 3→3.7 + fill-opacity 1→0 + stroke-opacity 0→1），
   对勾与斜杠各自靠 stroke-dashoffset 画出来 / 收回去，所以 点↔勾↔环 来回切都连贯。 */
.pk-card__glyph{display:grid;place-items:center;width:16px;height:16px;padding:0;border:0;border-radius:50%;corner-shape:round;background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer;flex:none;transition:background 120ms ease,color 160ms ease}
.pk-card__glyph:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pk-card__glyph:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.pk-card__glyph:disabled{cursor:default;opacity:.6}
.pk-card__glyph[data-state="done"]{color:var(--dsw-alias-state-success-primary)}
.pk-card__glyph[data-state="skipped"]{color:var(--dsw-alias-state-warn-primary)}
.pk-glyph__dot{transform-origin:8px 8px;transition:fill-opacity 150ms ease,stroke-opacity 150ms ease,r 190ms cubic-bezier(.2,.8,.2,1)}
.pk-card__glyph[data-state="todo"] .pk-glyph__dot{fill-opacity:1;stroke-opacity:0;r:3}
.pk-card__glyph[data-state="done"] .pk-glyph__dot{fill-opacity:0;stroke-opacity:0;r:3}
.pk-card__glyph[data-state="skipped"] .pk-glyph__dot{fill-opacity:0;stroke-opacity:1;r:3.7}
.pk-glyph__check{opacity:0;stroke-dasharray:11;stroke-dashoffset:11;transition:opacity 120ms ease,stroke-dashoffset 240ms cubic-bezier(.2,.8,.2,1)}
.pk-card__glyph[data-state="done"] .pk-glyph__check{opacity:1;stroke-dashoffset:0}
.pk-glyph__slash{opacity:0;stroke-dasharray:9;stroke-dashoffset:9;transition:opacity 120ms ease,stroke-dashoffset 220ms cubic-bezier(.2,.8,.2,1)}
.pk-card__glyph[data-state="skipped"] .pk-glyph__slash{opacity:1;stroke-dashoffset:0}
@media(prefers-reduced-motion:reduce){.pk-glyph__dot,.pk-glyph__check,.pk-glyph__slash{transition:none}}
.pk-card__content{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden;flex:1 1 auto}
.pk-card__when{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}

/* 设置页「拦截记录」（settings.section）：结构照 DSH 自己的设置页 —— 标题行 + 标签页 + 搜索 + 列表 */
.pk-set{display:flex;flex-direction:column;gap:14px;min-height:0;height:100%;color:var(--dsw-alias-label-primary)}
.pk-set__head{display:flex;align-items:center;gap:10px;flex:none}
.pk-set__title{font-size:20px;font-weight:600;line-height:28px}
.pk-set__version{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;font-variant-numeric:tabular-nums}
.pk-set__spacer{flex:1 1 auto}
.pk-set__btn{display:inline-flex;align-items:center;height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;cursor:pointer;flex:none;transition:background 120ms ease,border-color 120ms ease}
.pk-set__btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.pk-set__btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.pk-set__btn:disabled{opacity:.45;cursor:default}
.pk-set__btn--danger{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}
.pk-set__tabs{display:flex;align-items:center;gap:2px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l3)}
.pk-set__tab{position:relative;height:36px;padding:0 12px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:20px;cursor:pointer}
.pk-set__tab:hover{color:var(--dsw-alias-label-primary)}
.pk-set__tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);font-weight:500}
.pk-set__tab[aria-selected="true"]:after{content:"";position:absolute;left:10px;right:10px;bottom:-1px;height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary)}
.pk-set__tab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.pk-set__search{display:flex;align-items:center;gap:8px;height:40px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);flex:none}
.pk-set__search:focus-within{border-color:var(--dsw-alias-state-business-primary)}
.pk-set__searchicon{display:grid;place-items:center;color:var(--dsw-alias-label-tertiary);flex:none}
.pk-set__search input{flex:1 1 auto;min-width:0;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px}
.pk-set__search input::placeholder{color:var(--dsw-alias-label-dimmed)}
.pk-set__list{display:flex;flex-direction:column;gap:6px;overflow-y:auto;min-height:0;padding-right:2px}
.pk-set__row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.pk-set__row:hover{background:var(--dsw-alias-bg-layer-2)}
.pk-set__preview{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px}
.pk-set__row--done .pk-set__preview{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}
.pk-set__row--skipped{border-color:var(--dsw-alias-border-l2)}
.pk-set__row--skipped .pk-set__preview{color:var(--dsw-alias-label-secondary)}
.pk-set__meta{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;font-variant-numeric:tabular-nums}
.pk-set__meta--dim{color:var(--dsw-alias-label-tertiary)}
.pk-set__empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;flex:1 1 auto;min-height:220px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.pk-set__note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;flex:none}
.pk-set__note--bad{color:var(--dsw-alias-state-error-primary)}
`
    function installStyles() {
      if (typeof document === 'undefined' || document.head === null) return () => {}
      const element = document.createElement('style')
      // data-plugin 是**所有权键**：自带包按它整批回收；不写的话，无主 <style>
      // 会被「下一个物化的插件」认领（把别人的样式一起删掉）。data-plugin-css 只做去重键。
      element.setAttribute('data-plugin', 'dsh-peak-guard')
      element.setAttribute('data-plugin-css', 'peak-guard')
      element.textContent = CSS
      document.head.appendChild(element)
      return () => {
        try {
          element.remove()
        } catch {
          /* 页面已经换过了 */
        }
      }
    }

    // ── 纯函数小工具（独立出来便于离线测试） ────────────────────────────────

    /** 剩余时长的短文案。 */
    function shortDuration(ms) {
      const total = Math.max(0, Math.ceil(Number(ms) / 60000))
      const days = Math.floor(total / 1440)
      const hours = Math.floor((total % 1440) / 60)
      const minutes = total % 60
      if (days > 0) return STRINGS === ZH ? `${days} 天 ${hours} 小时` : `${days}d ${hours}h`
      if (hours > 0) return STRINGS === ZH ? `${hours} 小时 ${minutes} 分` : `${hours}h ${minutes}m`
      return STRINGS === ZH ? `${minutes} 分` : `${minutes}m`
    }

    /** 宿主给的 epoch ms → 本地 HH:MM。 */
    function localClock(atMs) {
      const date = new Date(Number(atMs))
      if (!Number.isFinite(date.getTime())) return '--:--'
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }

    /**
     * 把宿主状态翻译成「按钮长什么样 + tooltip 说什么」。
     * @param {object|null} state - /peak-guard/state 的响应，或 null（还没拿到）。
     * @param {boolean} failed - 上一次请求是否失败（宿主半边没就绪）。
     * @returns {{on: boolean, blocking: boolean, unavailable: boolean, title: string, lines: string[]}}
     */
    function describe(state, failed) {
      if (failed || state === null) {
        return { on: false, blocking: false, unavailable: true, title: STRINGS.label, lines: [STRINGS.unavailable] }
      }
      const on = state.enabled === true
      const blocking = on && state.peak === true
      const lines = []
      if (state.hardOff === true) lines.push(STRINGS.killed)
      else if (!on) lines.push(STRINGS.hintOff)
      else lines.push(state.peak === true ? STRINGS.blocking : STRINGS.offpeak)
      if (on && state.peak !== true && Number.isFinite(state.nextTransitionAt) && state.nextIntoPeak === true) {
        lines.push(STRINGS.nextPeak(localClock(state.nextTransitionAt), shortDuration(state.remainingMs)))
      }
      if (on && state.peak === true && Number.isFinite(state.nextTransitionAt) && state.nextIntoPeak === false) {
        lines.push(STRINGS.nextOffpeak(localClock(state.nextTransitionAt), shortDuration(state.remainingMs)))
      }
      if (on && Number.isFinite(state.blockedCount) && state.blockedCount > 0) lines.push(STRINGS.blocked(state.blockedCount))
      if (on && state.snoozeUntilMs !== null) lines.push(ZH === STRINGS ? `临时放行到 ${localClock(state.snoozeUntilMs)}` : `Snoozed until ${localClock(state.snoozeUntilMs)}`)
      return { on, blocking, unavailable: false, title: on ? STRINGS.on : STRINGS.off, lines }
    }

    // ── 状态：读宿主 + 写宿主 ───────────────────────────────────────────────

    /** 拉一次宿主状态。传 limit 可以一次要更多条（设置页要 200，卡片只要默认的 20）。 */
    async function fetchState(limit) {
      const url = Number.isFinite(limit) ? `${STATE_URL}?limit=${Math.max(1, Math.min(200, Math.trunc(limit)))}` : STATE_URL
      const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      if (body === null || typeof body !== 'object' || body.ok !== true) throw new Error('bad payload')
      return body
    }

    /** 写一次（带防 CSRF 的自定义头）。 */
    async function postJson(url, payload) {
      // 写接口的失败要把宿主给的错误码带出来（只报 HTTP 409 没法排查）。
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-peak-guard': '1' },
        body: JSON.stringify(payload ?? {}),
      })
      let body
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok) {
        const code = body !== null && typeof body === 'object' && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`
        throw new Error(code)
      }
      if (body === null || typeof body !== 'object' || body.ok !== true) throw new Error(body?.error ?? 'bad payload')
      return body
    }

    /** 写一次开关；返回新状态。 */
    const putEnabled = (enabled) => postJson(SET_URL, { enabled })
    /** 勾选 / 取消勾选列表里的一条（宿主落盘；纯本地勾选状态，不影响拦截）。 */
    const putCheck = (id, done) => postJson(SET_URL, { check: { id, done } })
    /** 把「跳过」的记录恢复成正常待办（单向：没有改回跳过的接口）。 */
    const putRestore = (ids) => postJson(SET_URL, { restore: ids })
    /** 关掉展示框：宿主把当时未处理的记录标记为「跳过」，并从此默认不展示已办。 */
    const postDismiss = () => postJson(SET_URL, { dismiss: true })

    // ── 共享状态：两个控件共用一个轮询，别各自打请求 ─────────────────────────

    const store = {
      state: null,
      failed: false,
      listeners: new Set(),
      timer: null,
      /** 最近一次手动动作的回执（补发结果），给面板显示一行结果。 */
      notice: null,
      notify() {
        for (const listener of [...store.listeners]) {
          try {
            listener()
          } catch {
            /* 单个订阅者出错不能连累别人 */
          }
        }
      },
      set(next, failed = false) {
        store.state = next
        store.failed = failed
        store.notify()
      },
      async load() {
        try {
          const next = await fetchState()
          store.set(next, false)
          return next
        } catch {
          store.set(store.state, true)
          return null
        }
      },
      start() {
        if (store.timer !== null) return
        void store.load()
        store.timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void store.load()
        }, POLL_MS)
        try {
          window.addEventListener('focus', store.onFocus)
        } catch { /* 离线测试没有 window */ }
      },
      onFocus() {
        void store.load()
      },
      stop() {
        if (store.timer !== null) {
          clearInterval(store.timer)
          store.timer = null
        }
        try {
          window.removeEventListener('focus', store.onFocus)
        } catch { /* 同上 */ }
      },
      subscribe(listener) {
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      },
    }

    /** 订阅宿主状态（两个控件都用它，轮询只有一份）。 */
    function usePeakGuardState() {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        const rerender = () => {
          if (alive) force((value) => value + 1)
        }
        const unsubscribe = store.subscribe(rerender)
        return () => {
          alive = false
          unsubscribe()
        }
      }, [])
      return { state: store.state, failed: store.failed }
    }

    /** 开关组件。 */
    function PeakGuardToggle() {
      const { state, failed } = usePeakGuardState()
      const [busy, setBusy] = React.useState(false)
      const [tipOpen, setTipOpen] = React.useState(false)
      /** 气泡坐标（fixed 定位，跟着按钮走；不用 portal 也不会被输入区裁剪）。 */
      const [tip, setTip] = React.useState(null)

      const view = describe(state, failed)
      /** 被拦截条数：开关上挂个小角标，让它在谷时也提醒得到。 */
      const pending = Number.isFinite(state?.listCount) ? state.listCount : 0

      /** 悬停/聚焦时把气泡钉在按钮上方；量不到就退回不显示。 */
      const showTip = (event) => {
        try {
          const rect = event.currentTarget.getBoundingClientRect()
          setTip({ left: Math.max(8, rect.left), bottom: Math.max(8, window.innerHeight - rect.top + 8) })
        } catch {
          setTip(null)
        }
        setTipOpen(true)
      }
      const hideTip = () => {
        setTipOpen(false)
        setTip(null)
      }

      const onClick = React.useCallback(async () => {
        if (view.unavailable || busy) return
        const next = view.on !== true
        setBusy(true)
        hideTip()
        // 乐观更新：先把按钮切过去，失败再回滚（轮询兜底）。
        if (store.state !== null) store.set({ ...store.state, enabled: next })
        try {
          const applied = await putEnabled(next)
          store.set(applied, false)
        } catch (error) {
          store.set(store.state, true)
          try {
            console.error(`${TAG} 切换高峰保护失败：`, error)
          } catch { /* ignore */ }
        } finally {
          setBusy(false)
        }
      }, [view.unavailable, view.on, busy])

      const button = h(
        'button',
        {
          type: 'button',
          className: 'pk-guard__btn',
          role: 'switch',
          'aria-checked': view.on,
          'aria-label': view.title,
          'data-on': String(view.on),
          'data-blocking': String(view.blocking),
          'data-unavailable': String(view.unavailable),
          'data-busy': String(busy),
          onClick,
          onMouseEnter: showTip,
          onMouseLeave: hideTip,
          onFocus: showTip,
          onBlur: hideTip,
        },
        h(
          'svg',
          {
            viewBox: '0 0 16 16',
            width: 16,
            height: 16,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
          },
          h('path', { d: 'M8 1.9 13 3.7v4.1c0 3.1-2.1 5.5-5 6.3-2.9-.8-5-3.2-5-6.3V3.7L8 1.9Z' }),
          view.on ? h('path', { d: 'M5.9 8.1 7.4 9.6l2.8-3' }) : h('path', { d: 'M6.2 6.2l3.6 3.6' }),
        ),
        view.blocking ? h('span', { className: 'pk-guard__dot' }) : null,
        pending > 0 ? h('span', { className: 'pk-badge' }, pending > 99 ? '99+' : String(pending)) : null,
      )

      const tooltip = tipOpen && tip !== null
        ? h(
            'div',
            {
              className: 'pk-guard__tip',
              role: 'tooltip',
              style: { left: `${Math.round(tip.left)}px`, bottom: `${Math.round(tip.bottom)}px` },
            },
            h('b', null, view.title),
            ...view.lines.map((line, index) => h('span', { key: `line-${index}` }, line)),
          )
        : null

      return h('div', { className: 'pk-guard' }, button, tooltip)
    }

    // ── 被拦截列表（conversation.input.dock，只读） ─────────────────────────

    /**
     * 描边权重：对齐 DSH 自带的 `ICON_MEDIUM_STROKE = 1.3`
     * （@deepseek-ai/dsh-client-ui-primitives：regular=1、medium=1.3；官方 16px 的关闭键就用 1.3）。
     * 卡头那三枚图标（lead / chevron / close）统一用它，所以整行的笔画一样重。
     */
    const ICON_STROKE = 1.3
    /** 列表里那枚对勾略重一点（它是「状态标记」而不是控件图标，1.6 才在 13px 行里读得出来）。 */
    const CHECK_STROKE = 1.6

    /**
     * 箭头的纵向微调档位（单位 = viewBox 单位 = 渲染出来的 CSS px）。
     *
     * 基准区间 `5.9 → 10.3` 的墨迹盒中心正好落在几何中心下方 0.10；这个常量按 0.5px 一档微调，
     * 负值 = 整组上移。**这是照着眼睛定的**（模型算不出来的那部分），所以单独拎出来一个数字，
     * 下次要挪就是改它，别的都不用碰。
     */
    const CHEVRON_Y_SHIFT = -0.5
    const CHEVRON_TOP = Number((5.9 + CHEVRON_Y_SHIFT).toFixed(2))
    const CHEVRON_BOTTOM = Number((10.3 + CHEVRON_Y_SHIFT).toFixed(2))

    /**
     * 路径与描边按 DSH 自带图标的手感标定（不是拍脑袋的坐标）：
     *   · 依据是**真实墨迹质心**（含圆头端帽 πr²/2 与拐点接点 (π/2−1)r² 的质量），不是包围盒中心；
     *   · **两个方向用同一段 y 区间**：墨迹盒完全重合，展开/收起切换时图标不会上下跳；
     *     端帽在上的那个（↓）质心略高、在下的（↑）略低，这是形状自身的不对称。
     *   · 整组纵向位置由 `CHEVRON_Y_SHIFT` 微调（见上）。
     *   · 叉号上下左右对称，重心天然落在 (8,8)，不需要偏移。
     * 尺寸按参考示意图的比例定：**× 的墨迹宽度 ≈ 箭头宽度、× 高度 ≈ 箭头的 1.64 倍**
     * （实测 0.99 / 1.67）—— 于是 × 看着比箭头「大一号」，但两者同宽、摆在一起是一条线。
     */
    const CHEVRON_DOWN = `M3.85 ${CHEVRON_TOP} 8 ${CHEVRON_BOTTOM}l4.15-4.4`
    const CHEVRON_UP = `M3.85 ${CHEVRON_BOTTOM} 8 ${CHEVRON_TOP}l4.15 4.4`
    const CLOSE_PATH = 'M3.9 3.9l8.2 8.2M12.1 3.9l-8.2 8.2'

    /** 少于等于这么多条时默认展开列表；更多就折叠起来，只留标题和一个箭头。 */
    const EXPAND_MAX = 3

    /**
     * 折叠/展开箭头 —— 照 DSH 官方 UI 的那枚：16px 画布、1.6px 描边、圆头圆角、
     * `currentColor`（继承按钮的 `--dsw-alias-label-secondary`）。刻意不用 `^`/`ˇ` 字符：
     * 字符的字形、基线、粗细都随字体走，跟官方那枚对不上。
     */
    function Chevron({ direction }) {
      const down = direction === 'down'
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: ICON_STROKE,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: down ? CHEVRON_DOWN : CHEVRON_UP }),
      )
    }

    /** 卡片左侧那枚图标（官方那张是两条短横的 lead 图形）。 */
    function CardGlyph() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: ICON_STROKE, strokeLinecap: 'round', 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M3 5.5h10M3 10.5h10' }),
      )
    }

    /** 关闭键的叉号（跟 Chevron 同一套描边参数，风格统一）。 */
    function CloseIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: ICON_STROKE, strokeLinecap: 'round', 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: CLOSE_PATH }),
      )
    }

    /**
     * 列表项前面那颗图标：**三种状态共用同一个 SVG**，靠 `data-state` 与 CSS 过渡切换。
     *
     *   · `todo`    实心圆点（品牌色）—— 正常待办
     *   · `done`    对勾（绿色，按描边长度画出来）—— 已办
     *   · `skipped` 空心圆环 + 一道斜杠（琥珀色）—— 关展示框时还没处理的那批
     *
     * 圆环就是同一个 `<circle>` 从实心「撑开」的（`r` 3 → 3.7、`fill-opacity` 1 → 0、
     * `stroke-opacity` 0 → 1），斜杠靠 `stroke-dashoffset` 画出来 / 收回去 ——
     * 点 ↔ 勾 ↔ 环之间来回切都是连贯的。`skipped → todo` 是单向的（点一下恢复成正常待办）。
     */
    function TodoGlyph({ state }) {
      const value = state === 'done' || state === 'skipped' ? state : 'todo'
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, 'data-glyph': value, 'aria-hidden': 'true', focusable: 'false' },
        h('circle', {
          className: 'pk-glyph__dot',
          cx: 8,
          cy: 8,
          r: 3,
          fill: 'currentColor',
          stroke: 'currentColor',
          strokeWidth: ICON_STROKE,
        }),
        h('path', {
          className: 'pk-glyph__check',
          d: 'M4.6 8.05l2.1 2.1 4.7-4.9',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: CHECK_STROKE,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          className: 'pk-glyph__slash',
          d: 'M5.2 10.8 10.8 5.2',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: ICON_STROKE,
          strokeLinecap: 'round',
        }),
      )
    }

    /** 一条记录当前该显示成哪种图标状态。 */
    function glyphState(item) {
      if (item?.done === true) return 'done'
      if (item?.skippedAt !== null && item?.skippedAt !== undefined) return 'skipped'
      return 'todo'
    }

    /**
     * 输入框上方那张卡要列出哪些记录（纯函数）：
     *   · **跳过的不展示** —— 关展示框时它们已经被收进「拦截记录」页了；
     *   · **关掉那一刻之前就已办的，不再展示**；关闭**之后**才标已办的照旧留在卡上 ——
     *     所以你勾「已办」不会让某一行当场消失，得再关一次卡片才会收起；
     *   · 其余（正常待办、以及刚勾的已办）都列出来。
     * @param {object[]} list - 快照里的列表。
     * @param {number|null} dismissedAtMs - 最近一次关掉展示框的时刻。
     */
    function cardItems(list, dismissedAtMs) {
      const sweptAt = typeof dismissedAtMs === 'number' && Number.isFinite(dismissedAtMs) ? dismissedAtMs : null
      return (Array.isArray(list) ? list : []).filter((item) => {
        if (item?.skippedAt !== null && item?.skippedAt !== undefined) return false
        if (item?.done !== true) return true
        if (sweptAt === null) return true
        const doneAt = typeof item?.doneAt === 'number' && Number.isFinite(item.doneAt) ? item.doneAt : item?.atMs
        return !(typeof doneAt === 'number' && doneAt <= sweptAt)
      })
    }

    /** 还等着处理的条数（既没勾已办、也没被收起）—— 开关上那个角标用它。 */
    function countUnhandled(list) {
      return (Array.isArray(list) ? list : []).filter((item) => item?.done !== true
        && (item?.skippedAt === null || item?.skippedAt === undefined)).length
    }

    /**
     * 被拦截列表卡片：**只读记录 + 两个无害的小动作**。
     *
     * 表头一行（图标 + 标题 + 灰色说明 + 折叠键 + 关闭键），下面列出**还没处理的**记录。
     *
     * 「关闭（✕）」是这套设计的核心：它会**在宿主侧**把当时还没处理的记录盖一个「跳过」戳
     * （于是它们和已办一样不再出现在卡片上，但在「拦截记录」页里与正常待办区分开、点一下能恢复），
     * 并让卡片从此默认不展示已办。之后**新拦下的请求**照旧会出现在卡片上。
     * 这里**没有任何会替用户发请求的东西** —— 早先的「一键补发 / 谷时自动补发」已整体砍掉。
     */
    function PendingCard() {
      const { state, failed } = usePeakGuardState()
      /** null = 跟随条数自动决定；true/false = 用户手动展开/收起过。 */
      const [expandOverride, setExpandOverride] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const items = cardItems(state?.list, state?.dismissedAtMs ?? null)
      const count = items.length
      const expanded = expandOverride ?? count <= EXPAND_MAX

      // 没有「还没处理」的记录就完全不占位（关掉之后卡片就是空的，直到新请求被拦下）
      if (failed || state === null || count === 0) return null

      const truncated = state.listTruncated === true

      /** 勾选 / 取消勾选；对「跳过」的记录则是**恢复成正常待办**（单向）。 */
      const toggle = async (item) => {
        if (busy) return
        const state0 = glyphState(item)
        setBusy(true)
        // 乐观更新：先动本地观感，失败再退回，点了不会有延迟感。
        const previous = store.state
        const optimistic = (list) => list.map((entry) => {
          if (entry.id !== item.id) return entry
          if (state0 === 'skipped') return { ...entry, skippedAt: null }
          if (state0 === 'done') return { ...entry, done: false }
          return { ...entry, done: true }
        })
        if (previous !== null && Array.isArray(previous.list)) {
          store.set({ ...previous, list: optimistic(previous.list) }, false)
        }
        try {
          const applied = state0 === 'skipped'
            ? await putRestore([item.id])
            : await putCheck(item.id, state0 !== 'done')
          store.set(applied, false)
        } catch {
          store.set(previous, false)
        } finally {
          setBusy(false)
        }
      }

      /** 关闭：宿主标记「跳过」+ 从此默认不展示已办，卡片随即变空（新拦截出现时会再回来）。 */
      const dismiss = async () => {
        if (busy) return
        setBusy(true)
        try {
          const applied = await postDismiss()
          store.set(applied, false)
        } catch {
          /* 关不掉就保持原样，别把卡片弄没 */
        } finally {
          setBusy(false)
        }
      }

      const iconButton = (kind, label, onClick, children, extra = {}) => h('button', {
        type: 'button',
        className: `pk-card__iconbtn pk-card__iconbtn--${kind}`,
        'aria-label': label,
        title: label,
        onClick,
        ...extra,
      }, children)

      const head = h(
        'div',
        { className: 'pk-card__head' },
        h('span', { className: 'pk-card__lead' }, h(CardGlyph)),
        h('span', { className: 'pk-card__title' }, STRINGS.pendingTitle(count)),
        // 说明位永远渲染（flex:auto）：它既是说明，也是把右侧按钮顶到最右的弹簧。
        h('span', { className: 'pk-card__progress' }, truncated ? `${STRINGS.pendingNote} · ${STRINGS.moreNote}` : STRINGS.pendingNote),
        h(
          'span',
          { className: 'pk-card__actions' },
          iconButton(
            'chevron',
            expanded ? STRINGS.collapse : STRINGS.expand,
            () => setExpandOverride(!expanded),
            // 直接放 SVG，不再套一层 <span>：两个图标键的 DOM 结构完全对称，
            // 就不会出现「一个被内联基线顶高、另一个没有」这种事。
            h(Chevron, { direction: expanded ? 'down' : 'up' }),
            { 'aria-expanded': expanded, 'data-dir': expanded ? 'down' : 'up' },
          ),
          iconButton('close', STRINGS.dismiss, () => { void dismiss() }, h(CloseIcon), { disabled: busy }),
        ),
      )

      const list = expanded
        ? h(
          'ul',
          { className: 'pk-card__list' },
          ...items.map((item) => {
            const state0 = glyphState(item)
            return h(
              'li',
              { key: item.id, className: `pk-card__item${state0 === 'done' ? ' pk-card__item--done' : ''}` },
              h('button', {
                type: 'button',
                className: 'pk-card__glyph',
                'aria-pressed': state0 === 'done',
                'data-state': state0,
                'aria-label': state0 === 'done' ? STRINGS.markUndone : state0 === 'skipped' ? STRINGS.restoreOne : STRINGS.markDone,
                title: state0 === 'done' ? STRINGS.markUndone : state0 === 'skipped' ? STRINGS.restoreOne : STRINGS.markDone,
                disabled: busy,
                onClick: () => { void toggle(item) },
              }, h(TodoGlyph, { state: state0 })),
              h('span', { className: 'pk-card__content' }, item.preview || STRINGS.emptyList),
              h('span', { className: 'pk-card__when' }, localClock(item.atMs)),
            )
          }),
        )
        : null

      // 结构照官方卡片：root 里套 body（6px 12px 内边距）→ head + list。
      return h(
        'div',
        { className: 'pk-card' },
        h('div', { className: 'pk-card__body' }, head, list),
      )
    }

    // ── 设置页：拦截记录管理（插槽 settings.section，照 dsh-archived-chats 的注册方式）──

    /**
     * 过滤 + 计数（纯函数，方便离线测试）：标签页（all/todo/done）× 搜索词。
     * 搜索命中预览文本与会话 id，大小写不敏感。
     * @param {object[]} list - 快照里的列表（最新在前）。
     * @param {{tab?: string, query?: string}} [view] - 当前视图。
     * @returns {{items: object[], counts: {all: number, todo: number, done: number, skipped: number}}}
     */
    function filterBlocked(list, view = {}) {
      const items = Array.isArray(list) ? list : []
      const tab = view.tab ?? 'all'
      const query = typeof view.query === 'string' ? view.query.trim().toLowerCase() : ''
      const isSkipped = (item) => item.skippedAt !== null && item.skippedAt !== undefined
      const counts = {
        all: items.length,
        done: items.filter((item) => item.done === true).length,
        // 「跳过」单独一档：关展示框时还没处理的那批；「待办」只算正常待办
        skipped: items.filter((item) => item.done !== true && isSkipped(item)).length,
        todo: items.filter((item) => item.done !== true && !isSkipped(item)).length,
      }
      const filtered = items.filter((item) => {
        if (tab === 'done' && item.done !== true) return false
        if (tab === 'todo' && (item.done === true || isSkipped(item))) return false
        if (tab === 'skipped' && (item.done === true || !isSkipped(item))) return false
        if (query === '') return true
        const preview = typeof item.preview === 'string' ? item.preview.toLowerCase() : ''
        const session = typeof item.sessionId === 'string' ? item.sessionId.toLowerCase() : ''
        return preview.includes(query) || session.includes(query)
      })
      return { items: filtered, counts }
    }

    /** 搜索图标。 */
    function SearchIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: ICON_STROKE, strokeLinecap: 'round', 'aria-hidden': 'true', focusable: 'false' },
        h('circle', { cx: 7, cy: 7, r: 4.2 }),
        h('path', { d: 'M10.2 10.2 13.5 13.5' }),
      )
    }

    /** 空态图标（收件箱，跟 DSH 的空态风格一致）。 */
    function InboxIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 32, height: 32, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M3 13.5 5.5 5h13L21 13.5v4H3z' }),
        h('path', { d: 'M3 13.5h5l1 2h6l1-2h5' }),
      )
    }

    /** 删除图标（垃圾桶）。 */
    function TrashIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: ICON_STROKE, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M3.2 5h9.6M6.4 5V3.6h3.2V5M4.4 5l.6 8h6l.6-8M6.8 7.4v3.4M9.2 7.4v3.4' }),
      )
    }

    /**
     * 设置页「拦截记录」：看、搜、勾、删。
     * 只跟本插件自己的两个路由打交道，不碰任何会话数据。
     */
    function BlockedSection() {
      const [snapshot, setSnapshot] = React.useState(null)
      const [failed, setFailed] = React.useState(false)
      const [tab, setTab] = React.useState('all')
      const [query, setQuery] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [confirmClear, setConfirmClear] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      const load = async () => {
        try {
          const next = await fetchState(SETTINGS_LIST_LIMIT)
          setSnapshot(next)
          setFailed(false)
        } catch {
          setFailed(true)
        }
      }
      React.useEffect(() => { void load() }, [])

      const apply = async (patch, message) => {
        if (busy) return
        setBusy(true)
        setNotice(null)
        try {
          const next = await postJson(SET_URL, patch)
          setSnapshot(next)
          // 顺手推给共享 store：对话界面那张卡片订阅的是它，所以切回去立刻就是新状态；
          // 否则得等下一轮 20 秒轮询（或窗口重新获得焦点）才会刷新。
          store.set(next, false)
          if (message !== undefined) setNotice(message)
        } catch (error) {
          setNotice(`${STRINGS.setFailed}：${String(error?.message ?? error)}`)
        } finally {
          setBusy(false)
        }
      }

      const list = Array.isArray(snapshot?.list) ? snapshot.list : []
      const { items, counts } = filterBlocked(list, { tab, query })
      const truncated = snapshot?.listTruncated === true

      const tabs = [
        ['all', STRINGS.tabAll, counts.all],
        ['todo', STRINGS.tabTodo, counts.todo],
        ['done', STRINGS.tabDone, counts.done],
        ['skipped', STRINGS.tabSkipped, counts.skipped],
      ]

      const head = h(
        'div',
        { className: 'pk-set__head' },
        h('span', { className: 'pk-set__title' }, STRINGS.setTitle),
        snapshot?.version ? h('span', { className: 'pk-set__version' }, `v${snapshot.version}`) : null,
        h('span', { className: 'pk-set__spacer' }),
        h('button', {
          type: 'button',
          className: 'pk-set__btn',
          disabled: busy || counts.todo + counts.skipped === 0,
          title: STRINGS.markAllHint,
          onClick: () => { void apply({ checkAll: true }, STRINGS.markedAll) },
        }, STRINGS.markAll),
        h('button', {
          type: 'button',
          className: `pk-set__btn${confirmClear ? ' pk-set__btn--danger' : ''}`,
          disabled: busy || counts.all === 0,
          onClick: () => {
            if (!confirmClear) {
              setConfirmClear(true)
              setNotice(STRINGS.clearConfirmHint)
              return
            }
            setConfirmClear(false)
            void apply({ clear: true }, STRINGS.cleared)
          },
        }, confirmClear ? STRINGS.clearConfirm : STRINGS.clear),
      )

      const tabBar = h(
        'div',
        { className: 'pk-set__tabs', role: 'tablist' },
        ...tabs.map(([key, label, count]) => h('button', {
          key,
          type: 'button',
          role: 'tab',
          'aria-selected': tab === key,
          'data-tab': key,
          className: 'pk-set__tab',
          onClick: () => setTab(key),
        }, `${label} ${count}`)),
      )

      const search = h(
        'div',
        { className: 'pk-set__search' },
        h('span', { className: 'pk-set__searchicon' }, h(SearchIcon)),
        h('input', {
          type: 'search',
          value: query,
          placeholder: STRINGS.searchPlaceholder,
          'aria-label': STRINGS.searchPlaceholder,
          onChange: (event) => setQuery(String(event?.target?.value ?? '')),
        }),
      )

      const body = items.length === 0
        ? h(
          'div',
          { className: 'pk-set__empty' },
          h(InboxIcon),
          h('span', null, query.trim() === '' && counts.all === 0 ? STRINGS.setEmpty : STRINGS.setNoMatch),
        )
        : h(
          'div',
          { className: 'pk-set__list' },
          ...items.map((item) => {
            const state0 = glyphState(item)
            const done = state0 === 'done'
            return h(
              'div',
              { key: item.id, className: `pk-set__row${done ? ' pk-set__row--done' : ''}${state0 === 'skipped' ? ' pk-set__row--skipped' : ''}` },
              h('button', {
                type: 'button',
                className: 'pk-card__glyph',
                'aria-pressed': done,
                'data-state': state0,
                'aria-label': done ? STRINGS.markUndone : state0 === 'skipped' ? STRINGS.restoreOne : STRINGS.markDone,
                title: done
                  ? STRINGS.markUndone
                  : state0 === 'skipped' ? `${STRINGS.restoreOne}（${STRINGS.skippedHint}）` : STRINGS.markDone,
                disabled: busy,
                // 「跳过」→ 恢复成正常待办（单向）；其余两态照旧是勾选 / 取消勾选
                onClick: () => {
                  void (state0 === 'skipped'
                    ? apply({ restore: [item.id] })
                    : apply({ check: { id: item.id, done: !done } }))
                },
              }, h(TodoGlyph, { state: state0 })),
              h('span', { className: 'pk-set__preview' }, item.preview || STRINGS.emptyList),
              h('span', { className: 'pk-set__meta' }, localClock(item.atMs)),
              h('span', { className: 'pk-set__meta pk-set__meta--dim' }, String(item.sessionId ?? '').slice(-8)),
              h('button', {
                type: 'button',
                className: 'pk-card__iconbtn',
                'aria-label': STRINGS.removeOne,
                title: STRINGS.removeOne,
                disabled: busy,
                onClick: () => { void apply({ remove: [item.id] }) },
              }, h(TrashIcon)),
            )
          }),
        )

      return h(
        'section',
        { className: 'pk-set' },
        head,
        tabBar,
        search,
        notice === null ? null : h('div', { className: 'pk-set__note' }, notice),
        truncated ? h('div', { className: 'pk-set__note' }, STRINGS.truncatedNote) : null,
        failed ? h('div', { className: 'pk-set__note pk-set__note--bad' }, STRINGS.hostDown) : null,
        body,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 样式跟着插件生命周期走（factory 里不许有副作用）。
        try {
          ctx.effect(() => installStyles(), 'peak-guard: styles')
        } catch (error) {
          try { console.error(`${TAG} 样式注入失败：`, error) } catch { /* ignore */ }
        }
        // 轮询只有一份，两个控件共用。
        try {
          ctx.effect(() => {
            store.start()
            return () => store.stop()
          }, 'peak-guard: state polling')
        } catch (error) {
          try { console.error(`${TAG} 状态轮询启动失败：`, error) } catch { /* ignore */ }
        }
        const register = (slot, id, order, component, label) => {
          try {
            ctx.slots.inject(slot, () =>
              ctx.slots.register({ name: slot, id, order, label: () => label ?? STRINGS.label }, component),
            )
          } catch (error) {
            // 注册失败只意味着这块控件不出现，绝不能连累输入区。
            try { console.error(`${TAG} 插槽 ${slot} 注册失败：`, error) } catch { /* ignore */ }
          }
        }
        register(SLOT, ENTRY_ID, ORDER, PeakGuardToggle)
        register(STRIP_SLOT, STRIP_ID, STRIP_ORDER, PendingCard)
        // 设置页：左侧导航会出现一项「拦截记录」（label 决定导航文案）
        register(SETTINGS_SLOT, SETTINGS_ID, SETTINGS_ORDER, BlockedSection, STRINGS.settingsLabel)
      },
      // 离线测试接缝：纯函数 + 常量，运行时无副作用（照 dsh-codex-effort-slider 的做法）。
      __internals: {
        CSS, SLOT, STRIP_SLOT, ENTRY_ID, STRIP_ID, ORDER, STRIP_ORDER, EXPAND_MAX,
        SETTINGS_SLOT, SETTINGS_ID, SETTINGS_ORDER, SETTINGS_LIST_LIMIT,
        STATE_URL, SET_URL, STRINGS, store,
        describe, shortDuration, localClock, PeakGuardToggle, PendingCard, Chevron, CardGlyph, TodoGlyph, CloseIcon, glyphState, cardItems, countUnhandled,
        ICON_STROKE, CHECK_STROKE, CHEVRON_DOWN, CHEVRON_UP, CLOSE_PATH, CHEVRON_Y_SHIFT,
        installStyles, fetchState, postJson, putEnabled, putCheck, putRestore, postDismiss,
        BlockedSection, filterBlocked, SearchIcon, InboxIcon, TrashIcon,
      },
    }
  },
})
