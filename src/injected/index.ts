// ============================================================================
// Compelem DevTools - Injected Script
// 运行在页面上下文，hook compelem 组件原型来采集调试数据
// ============================================================================
; (function () {
  'use strict'

  const VERSION = '0.2.0'
  const MAX_LOG_SIZE = 500
  const MAX_TIMELINE_SIZE = 1000

  // ---------------- 立即打标（compelem 框架检测扩展是否安装）----------------
  // content script 本来应该在 document_start 打 pending，但如果 content script
  // 没有跑（浏览器/CSP/时机问题），框架在 setTimeout(0) 里就会检测不到扩展并输出提示。
  // 这里在 injected 脚本最顶部同步写 ready 标记，确保比框架检查更早生效。
  // 即使 content script 后来也打了 pending，这里的 ready 也会覆盖它（值更精确）。
  try {
    document.documentElement?.setAttribute('data-compelem-devtools', 'ready:' + VERSION)
  } catch { /* noop */ }

  // ---------------- 数据存储 ----------------
  const EVENT_LOG: any[] = []     // emit 事件
  const STATE_CHANGE_LOG: any[] = []  // state 变更（比 emit 多很多）
  const UPDATE_LOG: any[] = []    // 组件 updated 生命周期
  const TIMELINE: any[] = []      // 统一瀑布图数据源
  const componentCache = new Map<number, any>()
  const hookedCtors = new Set<any>()
  const updatePointStats = new Map<string, { count: number; lastTime: number }>()
  // UpdatePoint 级计数。用 WeakMap 而不是往 UP 上写属性：UP 可能是响应式对象，
  // 直接赋值有触发额外更新的风险，WeakMap 零副作用。
  const updatePointCounter = new WeakMap<any, { count: number; lastTime: number }>()
  // UP 的依赖键。UP 对象上根本没有 deps 字段，唯一可信来源是组件上的
  // __updateSubViewDeps（Map<key, Set<UP>>），倒排一次给面板展示用。
  let updatePointDeps = new WeakMap<any, string[]>()
  // UP 上次观测到的值，用于值级差分（顶层 view 更新时框架不会逐个标记 UP）
  let upValueSnapshot = new WeakMap<any, any>()
  const subscribedTypes = new Set<string>()
  let subscribedCid: number | undefined = undefined
  let isHooked = false
  let nextTimelineId = 0
  let nextUpdateId = 0
  let nextEventId = 0
  let lastTreeTimestamp = 0
  // computed getter 缓存统计：Map<`ctorName.computedKey`, {key, ctorName, hits, recomputes, lastDuration, cidCounters}>
  const COMPUTED_STATS = new Map<string, { key: string; ctorName: string; hits: number; recomputes: number; lastDuration: number; cidCounters: Map<number, { hits: number; recomputes: number }> }>()

  // ---------------- 序列化工具 ----------------
  function serializeValue(v: any, depth: number = 0): any {
    if (depth > 4) return '[max-depth]'
    if (v === null || v === undefined) return v
    try {
      if (v instanceof HTMLElement) return `<${v.tagName.toLowerCase()}>`
      if (v instanceof Node) return `[Node:${v.nodeType}]`
      if (v instanceof Promise) return '[Promise]'
      if (v instanceof RegExp) return v.toString()
      if (v instanceof Date) return v.toISOString()
    } catch (e) { /* noop */ }
    if (Array.isArray(v)) {
      if (depth > 2) return `[Array(${v.length})]`
      return v.slice(0, 20).map(item => serializeValue(item, depth + 1))
    }
    if (typeof v === 'object') {
      if (depth > 2) return '[Object]'
      try {
        const keys = Object.keys(v).slice(0, 50)
        const result: Record<string, any> = {}
        for (const k of keys) {
          if (k.startsWith('_') || k === '__isData') continue
          try { result[k] = serializeValue(v[k], depth + 1) } catch { /* noop */ }
        }
        return result
      } catch { return '[Object]' }
    }
    if (typeof v === 'function') return `[Fn:${v.name || 'anonymous'}]`
    if (typeof v === 'symbol') return v.toString()
    return v
  }

  /**
   * 语言包专用深度序列化。
   * 不复用 serializeValue 的原因有二：它的对象深度上限只有 3 层（语言包常见 4+ 层嵌套），
   * 且会跳过 `_` 开头的键（消息键没有这个名字约定，跳过会静默丢内容）。
   */
  function serializeMessages(v: any, depth: number = 0): any {
    if (depth > 8) return '[max-depth]'
    if (v === null || v === undefined) return v
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    if (Array.isArray(v)) return v.slice(0, 200).map(item => serializeMessages(item, depth + 1))
    if (typeof v === 'object') {
      const out: Record<string, any> = {}
      for (const k of Object.keys(v)) {
        try { out[k] = serializeMessages(v[k], depth + 1) } catch { out[k] = '[error]' }
      }
      return out
    }
    return serializeValue(v, depth)
  }

  // ---------------- 组件检测 ----------------
  function isCompElem(node: any): boolean {
    if (!node || !(node instanceof HTMLElement)) return false
    if ((node as any).__data_ !== undefined) return true
    try {
      const ctor = node.constructor
      if (ctor && ctor.prototype) {
        const desc = Object.getOwnPropertyDescriptor(ctor.prototype, 'cid')
        if (desc && desc.get) return true
      }
    } catch { /* noop */ }
    return false
  }

  function findAllCompElem(): any[] {
    const found: any[] = []
    const visited = new WeakSet<Node>()

    function walk(node: Node | DocumentFragment) {
      if (!node) return
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        walkChildren(node)
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      if (visited.has(node)) return
      visited.add(node)
      if (isCompElem(node)) found.push(node as any)
      const el = node as HTMLElement
      if (el.shadowRoot) walkChildren(el.shadowRoot)
      walkChildren(node)
    }
    function walkChildren(parent: any) {
      const children = parent.children || parent.childNodes
      if (!children) return
      for (let i = 0; i < children.length; i++) walk(children[i])
    }
    walk(document.documentElement)
    return found
  }

  function camelCaseKey(str: string): string {
    return str.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
  }

  // ---------------- 组件信息构建 ----------------
  function getPropDefs(comp: any): Record<string, boolean> {
    const ctor = comp.constructor
    if (!ctor) return {}
    const cacheKey = '__cdt_propDefs__'
    if (ctor[cacheKey]) return ctor[cacheKey]
    const defs: Record<string, boolean> = {}
    try {
      // prop（attribute=true）会在 constructor.observedAttributes 注册 kebab-case 属性名
      // 这是 compelem 官方对 prop 的可靠登记，state 不会出现在这里
      const observed = ctor.observedAttributes
      if (Array.isArray(observed)) {
        for (const attr of observed) {
          defs[camelCaseKey(String(attr))] = true
        }
      }
      // 补偿：attribute=false 的 prop 不会出现在 observedAttributes，
      // 但它的 prototype setter 是"只读 prop setter"（特征：源码含 emitModelEvent）
      let p = ctor.prototype
      while (p && p !== HTMLElement.prototype) {
        const names = Object.getOwnPropertyNames(p)
        for (const key of names) {
          if (defs[key] || key === 'constructor' || key.startsWith('_')) continue
          try {
            const desc = Object.getOwnPropertyDescriptor(p, key)
            if (desc && desc.set && String(desc.set).includes('emitModelEvent')) {
              defs[key] = true
            }
          } catch { /* noop */ }
        }
        p = Object.getPrototypeOf(p)
      }
    } catch { /* noop */ }
    ctor[cacheKey] = defs
    return defs
  }

  // 核心库元数据接入点（compelem 提供 __COMPELEM_ECOSYSTEM__.core）
  function coreMeta(): any {
    try {
      const eco = (globalThis as any).__COMPELEM_ECOSYSTEM__
      return (eco && eco.core) || null
    } catch { return null }
  }

  // 回退路径：老版本库没有接入点时，靠 getter 源码特征猜（只收键，值必须现取）
  // 特征为 getter 源码含 Collector.isCollection() / getVarPathList()
  // （state/prop 的 getter 是 getterValue()，slots/cssVars/slotHooks 是普通实例 getter）
  function detectComputedKeysBySource(comp: any): string[] {
    const ctor = comp.constructor
    const keys: string[] = []
    if (!ctor) return keys
    try {
      const propDefs = getPropDefs(comp)
      let p = ctor.prototype
      while (p && p !== HTMLElement.prototype) {
        for (const key of Object.getOwnPropertyNames(p)) {
          if (key === 'constructor' || key.startsWith('_') || key === 'slots' || key === 'slotHooks' || key === 'cssVars') continue
          try {
            const desc = Object.getOwnPropertyDescriptor(p, key)
            if (desc && desc.get && !desc.set && !propDefs[key]) {
              const src = String(desc.get)
              if (!src.includes('Collector.isCollection') && !src.includes('getVarPathList')) continue
              if (!keys.includes(key)) keys.push(key)
            }
          } catch { /* noop */ }
        }
        p = Object.getPrototypeOf(p)
      }
    } catch { /* noop */ }
    return keys
  }

  // 键集合可以缓存（类级不变），但**值绝不能缓存** ——
  // 曾经把 serializeValue 的结果一起按类缓存，导致同类第 2+ 个实例
  // 永远显示第一个实例的 computed 值。值一律现取。
  function getComputedKeys(comp: any): string[] {
    const ctor = comp.constructor
    if (!ctor) return []
    const cacheKey = '__cdt_computedKeys__'
    if (Array.isArray(ctor[cacheKey])) return ctor[cacheKey]
    let keys: string[] = []
    const meta = coreMeta()
    if (meta && typeof meta.computedKeys === 'function') {
      try { keys = (meta.computedKeys(ctor) || []).filter((k: any) => typeof k === 'string') } catch { keys = [] }
    }
    if (!keys.length) keys = detectComputedKeysBySource(comp)
    ctor[cacheKey] = keys
    return keys
  }

  function getComputedInfo(comp: any): Record<string, any> {
    const result: Record<string, any> = {}
    getComputedKeys(comp).forEach(key => {
      try { result[key] = serializeValue(comp[key]) } catch { /* noop */ }
    })
    return result
  }

  // 收集 slots / slotHooks 信息
  function getSlotsInfo(comp: any): Record<string, any> {
    const result: Record<string, any> = {}
    try {
      const slots = comp.slots
      if (slots && typeof slots === 'object') {
        const entries: Record<string, any> = {}
        Object.keys(slots).forEach(k => {
          const nodes = slots[k]
          entries[k] = Array.isArray(nodes) ? `Slot (${nodes.length} nodes)` : '—'
        })
        if (Object.keys(entries).length > 0) result.slots = entries
      }
    } catch { /* noop */ }
    try {
      const hooks = comp.slotHooks
      if (hooks && typeof hooks === 'object') {
        const entries: Record<string, any> = {}
        Object.keys(hooks).forEach(k => { entries[k] = 'ƒ slot hook' })
        if (Object.keys(entries).length > 0) result.slotHooks = entries
      }
    } catch { /* noop */ }
    return result
  }

  // 收集样式信息：cssVars + @csscope 静态 getter
  function getStylesInfo(comp: any): Record<string, any> {
    const result: Record<string, any> = {}
    try {
      const vars = comp.cssVars
      if (vars && typeof vars === 'object') {
        const entries: Record<string, any> = {}
        Object.keys(vars).forEach(k => {
          let v: any = vars[k]
          if (typeof v === 'object' && v !== null) v = JSON.stringify(v)
          entries[k] = String(v ?? '')
        })
        if (Object.keys(entries).length > 0) result.cssVars = entries
      }
    } catch { /* noop */ }
    // @csscope 静态 getter：返回 CssTemplate（有 strings + getCssText）或 CSSStyleSheet
    try {
      const ctor = comp.constructor
      if (ctor) {
        const names = Object.getOwnPropertyNames(ctor)
        const scopes: Record<string, any> = {}
        for (const name of names) {
          if (['length', 'name', 'prototype', 'observedAttributes'].includes(name)) continue
          let desc: PropertyDescriptor | undefined
          try { desc = Object.getOwnPropertyDescriptor(ctor, name) } catch { /* noop */ }
          if (!desc || typeof desc.get !== 'function') continue
          try {
            const rs = desc.get.call(ctor)
            const arr = Array.isArray(rs) ? rs : [rs]
            const isCss = arr.some(it =>
              it instanceof CSSStyleSheet ||
              (it && typeof it.getCssText === 'function' && Array.isArray(it.strings))
            )
            if (isCss) scopes[name] = `@csscope (${arr.length})`
          } catch { /* noop */ }
        }
        if (Object.keys(scopes).length > 0) result.cssScopes = scopes
      }
    } catch { /* noop */ }
    return result
  }

  function buildComponentInfo(comp: any): any {
    let data: any = {}
    try { data = comp.__data_ || {} } catch { /* noop */ }

    const propDefs = getPropDefs(comp)
    const computedInfo = getComputedInfo(comp)
    const slotsInfo = getSlotsInfo(comp)
    const stylesInfo = getStylesInfo(comp)
    const dataKeys = Object.keys(data).filter(k => k !== '__isData' && !k.startsWith('_'))

    const props: Record<string, any> = {}
    const state: Record<string, any> = {}
    const computed: Record<string, any> = {}

    dataKeys.forEach(key => {
      if (key === 'slots') return
      const val = serializeValue(data[key])
      if (propDefs[key]) props[key] = val
      else if (computedInfo[key] !== undefined) computed[key] = computedInfo[key]
      else if (key === 'slotHooks' || key === 'cssVars') return // 归入 slots/styles
      else state[key] = val
    })

    // 补充 prototype 上的 computed
    Object.keys(computedInfo).forEach(k => {
      if (!(k in props) && !(k in state)) computed[k] = computedInfo[k]
    })

    let parent: any = null, wrapper: any = null
    try { parent = comp.parentComponent } catch { /* noop */ }
    try { wrapper = comp.wrapperComponent } catch { /* noop */ }

    return {
      cid: comp.cid,
      tagName: comp.tagName.toLowerCase(),
      className: (comp.constructor && comp.constructor.name) || 'Unknown',
      props,
      state,
      computed,
      slots: slotsInfo,
      styles: stylesInfo,
      attrs: comp.attrs || {},
      isMounted: !!comp.isMounted,
      isDestroyed: !!comp.isDestroyed,
      parentCid: parent ? parent.cid : undefined,
      wrapperCid: wrapper ? wrapper.cid : undefined,
      childCids: [],
      updatePointCount: (comp.__updateTree || []).length,
      emitEvents: comp.constructor?.prototype?.__cdt_emits__ || [],
      hasShadow: !!(comp as any).shadowRoot,
      hasReactive: !!(comp.__updateTree && comp.__updateTree.length > 0)
    }
  }

  // ---------------- 日志记录 ----------------
  function addEventRecord(record: any) {
    if (EVENT_LOG.length >= MAX_LOG_SIZE) EVENT_LOG.shift()
    EVENT_LOG.push(record)
    // 订阅推送
    if (subscribedTypes.has('events')) {
      sendToPanel('COMPELEM_DEVTOOLS_PUSH_EVENT', record)
    }
  }

  function addUpdateRecord(record: any) {
    if (UPDATE_LOG.length >= MAX_LOG_SIZE) UPDATE_LOG.shift()
    UPDATE_LOG.push(record)
    // 添加到 timeline
    addTimelineRecord({
      cid: record.cid,
      tagName: record.tagName,
      type: 'update',
      name: Object.keys(record.changed).join(', ') || 'force',
      duration: record.duration,
      timestamp: record.timestamp,
      details: record.changed
    })
    // 订阅推送
    if (subscribedTypes.has('updates')) {
      sendToPanel('COMPELEM_DEVTOOLS_PUSH_UPDATE', record)
    }
  }

  function addTimelineRecord(record: any) {
    if (TIMELINE.length >= MAX_TIMELINE_SIZE) TIMELINE.shift()
    record.id = nextTimelineId++
    TIMELINE.push(record)
  }

  // ---------------- 原型 Hook ----------------
  function hookPrototype(ctor: any) {
    if (!ctor || !ctor.prototype || hookedCtors.has(ctor)) return
    hookedCtors.add(ctor)
    const proto = ctor.prototype

    // ---------------- Hook computed getters（缓存命中/重算统计）----------------
    try {
      const eco = (globalThis as any).__COMPELEM_ECOSYSTEM__
      const computedKeys = eco?.core?.computedKeys?.(ctor) || []
      computedKeys.forEach((key: string) => {
        if (!proto.hasOwnProperty(key)) return
        const desc = Object.getOwnPropertyDescriptor(proto, key)
        if (!desc || !desc.get || (desc.get as any).__cdt_hooked__) return
        const origGet = desc.get
        const comp = COMPUTED_STATS
        const cidKey = `${ctor.name}.${key}`
        if (!comp.has(cidKey)) comp.set(cidKey, { key, ctorName: ctor.name, hits: 0, recomputes: 0, lastDuration: 0, cidCounters: new Map<number, {hits:number,recomputes:number}>() })

        // 读取原始 descriptor 的其他属性（enumerable/configurable）
        Object.defineProperty(proto, key, {
          ...desc,
          get: function () {
            const start = performance.now()
            // 框架 computed 实现：每次重算前会先做依赖检查。我们没法廉价地 100% 准确
            // 判断本次是命中缓存还是真的重算，但可以用「耗时阈值」区分——
            // 命中缓存通常 < 0.05ms，真重算涉及依赖收集 + 表达式执行会明显更慢。
            const result = origGet.call(this)
            const dur = performance.now() - start
            const stat = comp.get(cidKey)!
            if (dur < 0.05) { stat.hits++ } else { stat.recomputes++ }
            stat.lastDuration = dur
            // 按 cid 再细一层（同一个 ctor 可能有多个实例）
            if (this && typeof (this as any).cid === 'number') {
              const cid = (this as any).cid
              const counter = stat.cidCounters.get(cid) || { hits: 0, recomputes: 0 }
              if (dur < 0.05) counter.hits++; else counter.recomputes++
              stat.cidCounters.set(cid, counter)
            }
            return result
          }
        })
      })
    } catch { /* noop — computed hook 失败不影响主流程 */ }

    // Hook emit
    if (typeof proto.emit === 'function' && !proto.emit.__cdt_hooked__) {
      const origEmit = proto.emit
      const emitInfo: string[] = []
      proto.emit.__cdt_hooked__ = true
      ctor.prototype.__cdt_emits__ = emitInfo
      proto.emit = function (evName: string, arg: any, event: any) {
        // 记录 emit 事件名
        if (!emitInfo.includes(evName)) emitInfo.push(evName)
        if (emitInfo.length > 20) emitInfo.shift()

        const record = {
          id: nextEventId++,
          cid: this.cid,
          tagName: this.tagName.toLowerCase(),
          eventName: evName,
          args: serializeValue(arg),
          timestamp: Date.now()
        }
        addEventRecord(record)
        addTimelineRecord({
          cid: this.cid,
          tagName: this.tagName.toLowerCase(),
          type: 'event',
          name: evName,
          duration: 0,
          timestamp: record.timestamp,
          details: arg
        })
        return origEmit.call(this, evName, arg, event)
      }
    }

    // Hook updated
    if (typeof proto.updated === 'function' && !proto.updated.__cdt_hooked__) {
      const origUpdated = proto.updated
      proto.updated.__cdt_hooked__ = true
      proto.updated = function (changed: any) {
        const start = performance.now()
        // 先调用原始
        const result = origUpdated.call(this, changed)
        const duration = performance.now() - start

        // 追踪 UpdatePoint 更新
        trackUpdatePoints(this, changed)

        // 读取本次更新关联的 render 耗时（渲染后清零，避免重复计入）
        const renderTime = this.__cdtLastRenderTime || 0
        this.__cdtLastRenderTime = 0

        const record = {
          id: nextUpdateId++,
          cid: this.cid,
          tagName: this.tagName.toLowerCase(),
          changed: changed ? Object.keys(changed).reduce((acc: any, k: string) => {
            acc[k] = serializeValue(changed[k]?.value ?? changed[k])
            return acc
          }, {}) : {},
          duration,
          renderTime,
          updatePointCount: (this.__updateTree || []).length,
          timestamp: Date.now()
        }
        addUpdateRecord(record)
        return result
      }
    }

    // Hook render 测量 DOM 渲染耗时（模板构建，发生在 updated 之前）
    if (typeof proto.render === 'function' && !proto.render.__cdt_hooked__) {
      const origRender = proto.render
      proto.render.__cdt_hooked__ = true
      proto.render = function () {
        const start = performance.now()
        const result = origRender.call(this)
        this.__cdtLastRenderTime = performance.now() - start
        return result
      }
    }

    // Hook requestUpdate 来更早捕获更新 + state 变更入日志
    if (typeof proto.requestUpdate === 'function' && !proto.requestUpdate.__cdt_hooked__) {
      const origRequestUpdate = proto.requestUpdate
      proto.requestUpdate.__cdt_hooked__ = true
      proto.requestUpdate = function (nv: any, ov: any, chain: string[]) {
        const result = origRequestUpdate.call(this, nv, ov, chain)

        // state 变更入日志（Events 面板 + Timeline 瀑布图都要用）
        const changeKey = chain && chain.length > 0 ? chain.join('.') : '(unknown)'
        const now = Date.now()
        if (STATE_CHANGE_LOG.length >= MAX_LOG_SIZE) STATE_CHANGE_LOG.shift()
        STATE_CHANGE_LOG.push({
          cid: this.cid,
          tagName: this.tagName.toLowerCase(),
          key: changeKey,
          oldValue: sameScalar(nv, ov) ? null : serializeValue(ov),
          newValue: sameScalar(nv, ov) ? null : serializeValue(nv),
          timestamp: now
        })
        addTimelineRecord({
          cid: this.cid,
          tagName: this.tagName.toLowerCase(),
          type: 'state',
          name: changeKey,
          duration: 0,
          timestamp: now,
          details: { from: serializeValue(ov), to: serializeValue(nv) }
        })

        if (subscribedTypes.has('state')) {
          sendToPanel('COMPELEM_DEVTOOLS_PUSH_STATE_CHANGE', {
            cid: this.cid,
            chain: changeKey,
            newValue: serializeValue(nv),
            oldValue: serializeValue(ov),
            timestamp: now
          })
        }
        return result
      }
    }

    // Hook connectedCallback 来追踪生命周期
    if (typeof proto.connectedCallback === 'function' && !proto.connectedCallback.__cdt_hooked__) {
      const origConnected = proto.connectedCallback
      proto.connectedCallback.__cdt_hooked__ = true
      proto.connectedCallback = function () {
        addTimelineRecord({
          cid: this.cid,
          tagName: this.tagName.toLowerCase(),
          type: 'lifecycle',
          name: 'connected',
          duration: 0,
          timestamp: Date.now()
        })
        return origConnected.call(this)
      }
    }

    // Hook destroyed/destroy
    const destroyMethod = typeof proto.destroy === 'function' ? 'destroy' :
      typeof proto.disconnectedCallback === 'function' ? 'disconnectedCallback' : null
    if (destroyMethod && !proto[destroyMethod].__cdt_hooked__) {
      const origDestroy = proto[destroyMethod]
      proto[destroyMethod].__cdt_hooked__ = true
      proto[destroyMethod] = function () {
        addTimelineRecord({
          cid: this.cid,
          tagName: this.tagName.toLowerCase(),
          type: 'lifecycle',
          name: 'destroyed',
          duration: 0,
          timestamp: Date.now()
        })
        // 推送树变化
        if (subscribedTypes.has('tree')) {
          sendToPanel('COMPELEM_DEVTOOLS_PUSH_COMPONENT_TREE', null)
        }
        return origDestroy.call(this)
      }
    }
  }

  function trackUpdatePoints(comp: any, changed: any) {
    try {
      const tree = comp.__updateTree || []
      if (!tree.length) return
      const changedKeys = changed ? Object.keys(changed) : []
      if (changedKeys.length > 0) {
        const key = `${comp.cid}:${changedKeys.join(',')}`
        const stat = updatePointStats.get(key) || { count: 0, lastTime: 0 }
        stat.count++
        stat.lastTime = Date.now()
        updatePointStats.set(key, stat)
      }

      const now = Date.now()

      // (1) 倒排依赖：框架持有 Map<key, Set<UP>>，UP 自身不带 deps，这里反查出来给面板看
      const subDeps = comp.__updateSubViewDeps
      if (subDeps && typeof subDeps.forEach === 'function') {
        subDeps.forEach((ups: any, key: string) => {
          if (!ups || typeof ups.forEach !== 'function') return
          ups.forEach((up: any) => {
            if (!up) return
            const d = updatePointDeps.get(up) || []
            if (d.indexOf(key) < 0) d.push(key)
            updatePointDeps.set(up, d)
          })
        })
      }

      // (2) 精确命中：changed 键直接映射到 UP —— 与框架 updateSubScopeView 的取法一致
      const hit = new Set<any>()
      changedKeys.forEach(k => {
        const ups = subDeps && typeof subDeps.get === 'function' ? subDeps.get(k) : null
        if (!ups || typeof ups.forEach !== 'function') return
        ups.forEach((up: any) => { if (up) hit.add(up) })
      })

      // (3) 值级兜底：顶层 viewDeps 触发整视图重渲染时框架不逐个标记 UP，
      //     但 up.value 会被刷新 —— 用「上次快照 → 本次值」判断该 UP 是否真的产出了新值。
      //     对象/函数无法廉价比较，一律视为「无变化」，宁可漏记也不误记。
      const walk = (ups: any[]) => {
        ups.forEach(up => {
          if (!up) return
          try {
            if (!upValueSnapshot.has(up)) {
              // 首次观测只建基线，不计数
              upValueSnapshot.set(up, up.value)
              if (!updatePointCounter.has(up)) updatePointCounter.set(up, { count: 0, lastTime: 0 })
            } else if (hit.has(up) || !sameScalar(upValueSnapshot.get(up), up.value)) {
              const c = updatePointCounter.get(up) || { count: 0, lastTime: 0 }
              c.count++
              c.lastTime = now
              updatePointCounter.set(up, c)
              upValueSnapshot.set(up, up.value)
            }
          } catch { /* noop */ }
          if (up.children && up.children.length) walk(up.children)
        })
      }
      walk(tree)
    } catch { /* noop */ }
  }

  /** 只判定「标量是否真的变了」；对象/函数无法廉价比较，返回 true 表示当作没变 */
  function sameScalar(a: any, b: any): boolean {
    if (a === b) return true
    const obj = (v: any) => v !== null && (typeof v === 'object' || typeof v === 'function')
    return obj(a) || obj(b)
  }

  function autoHook() {
    const all = findAllCompElem()
    if (!all.length) return
    all.forEach(comp => {
      componentCache.set(comp.cid, comp)
      hookPrototype(comp.constructor)
    })
    if (!isHooked) {
      isHooked = true
      // 推送树变化
      if (subscribedTypes.has('tree')) {
        sendToPanel('COMPELEM_DEVTOOLS_PUSH_COMPONENT_TREE', null)
      }
    }
  }

  // ---------------- 树查询 ----------------
  function getComponentTree() {
    autoHook()
    const all = findAllCompElem()
    const infoMap = new Map<number, any>()
    const hookedSet = new Set<any>()

    for (const comp of all) {
      try {
        hookPrototype(comp.constructor)
        const info = buildComponentInfo(comp)
        infoMap.set(info.cid, info)
        componentCache.set(info.cid, comp)
        hookedSet.add(comp.constructor)
      } catch { /* noop */ }
    }

    // 构建父子关系（注意 parentCid 可能是 0，不能用 falsy 判断）
    infoMap.forEach(info => {
      if (info.parentCid !== undefined && info.parentCid !== null && infoMap.has(info.parentCid)) {
        infoMap.get(info.parentCid).childCids.push(info.cid)
      }
    })

    return Array.from(infoMap.values())
  }

  function findComponent(cid: number): any | null {
    if (componentCache.has(cid)) {
      const cached = componentCache.get(cid)
      if (cached && cached.isConnected) return cached
      componentCache.delete(cid)
    }
    autoHook()
    const all = findAllCompElem()
    for (const c of all) {
      componentCache.set(c.cid, c)
      if (c.cid === cid) return c
    }
    return null
  }

  // ---------------- 状态快照 ----------------
  function getStateSnapshot(cid: number): any {
    const comp = findComponent(cid)
    if (!comp) return null
    const data: Record<string, any> = {}
    try {
      const raw = comp.__data_ || {}
      const propDefs = getPropDefs(comp)
      const computedInfo = getComputedInfo(comp)
      const keys = Object.keys(raw)
      for (const k of keys) {
        if (k.startsWith('_') || k === '__isData') continue
        data[k] = serializeValue(raw[k])
      }
      // 添加 computed（从 prototype 上 getter 获取）
      Object.keys(computedInfo).forEach(k => {
        if (!(k in data)) data[k] = computedInfo[k]
      })
    } catch { /* noop */ }

    // 获取 computed 依赖
    const computedDeps: Record<string, string[]> = {}
    try {
      // 尝试通过 comp.__updateTree 获取子视图依赖
      const subDeps = comp.__updateSubViewDeps
      if (subDeps && typeof subDeps.forEach === 'function') {
        // 收集每个 state 对应的更新点
        const stateToUps: Record<string, number> = {}
        subDeps.forEach((val: any, key: string) => {
          if (val && val.size !== undefined) stateToUps[key] = val.size
        })
        // 简单推断 computed 依赖（所有 deps 的反向）
        // 这里简化处理，只展示 viewDeps
      }
    } catch { /* noop */ }

    return { cid, data, computedDeps, timestamp: Date.now() }
  }

  function kebabCaseKey(str: string): string {
    return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
  }

  /** 把 `a.b[0].c` 拆成 [‘a','b','0','c'] */
  function parsePath(p: string): string[] {
    return p.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
  }

  function setStateValue(cid: number, key: string, value: any): boolean {
    const comp = findComponent(cid)
    if (!comp) return false
    try {
      // 深度路径：`root.nested[0].leaf`
      const segments = parsePath(key)
      const rootKey = segments[0]
      const rest = segments.slice(1)

      // 判断顶级是否为 prop：constructor.observedAttributes 包含 kebab-case 的 key
      const attrName = kebabCaseKey(rootKey)
      const observed = (comp.constructor as any).observedAttributes
      const isProp = Array.isArray(observed) && observed.includes(attrName)

      // 非叶子路径：沿路径定位父容器修改，不重建整棵
      if (isProp) {
        if (rest.length === 0) {
          // prop 的正确更新方式：调用官方公共 API updateProps（触发 requestUpdate + 视图更新）
          comp.updateProps?.({ [rootKey]: value }, true)
          return true
        }
        // prop 深度：读取根对象，沿路径修改后整体写回
        const root = comp[rootKey]
        if (!root || typeof root !== 'object') return false
        const parent = getByPath(root, rest.slice(0, -1))
        if (!parent || typeof parent !== 'object') return false
        parent[rest[rest.length - 1]] = value
        comp.updateProps?.({ [rootKey]: root }, true)
        return true
      }

      // state 深度
      if (rest.length > 0) {
        const root = readStateRoot(comp, rootKey)
        if (root && typeof root === 'object') {
          const parent = getByPath(root, rest.slice(0, -1))
          if (parent && typeof parent === 'object') {
            const before = parent[rest[rest.length - 1]]
            parent[rest[rest.length - 1]] = value
            comp.requestUpdate?.(root, before, [rootKey])
            return true
          }
        }
        return false
      }

      // state 顶级：优先级 proto setter > instance __data_ > instance 直接赋值
      const protoDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(comp), rootKey)
      if (protoDesc?.set) {
        protoDesc.set.call(comp, value)
        comp.requestUpdate?.(value, comp[rootKey], [rootKey])
        return true
      }
      if (comp.__data_) {
        const setter = Object.getOwnPropertyDescriptor(comp.__data_, rootKey)?.set
        if (setter) {
          setter.call(comp.__data_, value)
        } else {
          const old = comp.__data_[rootKey]
          comp.__data_[rootKey] = value
          comp.requestUpdate?.(value, old, [rootKey])
        }
        return true
      }
      // 兜底：直接在实例上设
      comp[rootKey] = value
      return true
    } catch { return false }
  }

  /** 读取一个 state 根值：优先 .__data_，其次实例属性 */
  function readStateRoot(comp: any, rootKey: string): any {
    if (comp.__data_ && rootKey in comp.__data_) return comp.__data_[rootKey]
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(comp), rootKey)
    if (desc && 'get' in desc) return comp[rootKey]
    return comp[rootKey]
  }

  function getByPath(obj: any, segments: string[]): any {
    let cur = obj
    for (const seg of segments) {
      if (cur === null || cur === undefined) return undefined
      cur = cur[seg]
    }
    return cur
  }

  function forceUpdate(cid: number): boolean {
    const comp = findComponent(cid)
    if (!comp) return false
    try {
      if (typeof comp.forceUpdate === 'function') comp.forceUpdate()
      return true
    } catch { return false }
  }

  /** 销毁组件（生命周期调试 / 泄漏排查）：返回是否成功销毁，以及销毁前的状态 */
  function destroyComponent(cid: number): any {
    const comp = findComponent(cid)
    if (!comp) return { ok: false, reason: 'not found' }
    try {
      const info = {
        cid: comp.cid,
        tagName: (comp.tagName || '').toString().toLowerCase(),
        hasDestroy: typeof comp.destroy === 'function',
        hasDisconnected: typeof comp.disconnectedCallback === 'function'
      }
      if (typeof comp.destroy === 'function') comp.destroy()
      else if (typeof comp.disconnectedCallback === 'function') comp.disconnectedCallback()
      else return { ok: false, reason: 'no destroy api', ...info }
      // 触发一次树刷新推送，让面板移除已销毁节点
      if (subscribedTypes.has('tree')) sendToPanel('COMPELEM_DEVTOOLS_PUSH_COMPONENT_TREE', null)
      return { ok: true, ...info }
    } catch (e: any) {
      return { ok: false, reason: (e && e.message) || String(e) }
    }
  }

  // ---------------- 生态库接入（store / router / i18n） ----------------
  // 生态库各自把 provider 挂到 globalThis.__COMPELEM_ECOSYSTEM__ 的命名空间键下：
  //   __COMPELEM_ECOSYSTEM__.store  → { list(), entry(id), subscribe(id, cb) }
  //   __COMPELEM_ECOSYSTEM__.router / .i18n（后续接入）
  // 未安装对应库时整段静默降级，不产生任何副作用。
  const ECOSYSTEM_KEY = '__COMPELEM_ECOSYSTEM__'
  const MAX_STORE_MUTATIONS = 200
  const STORE_MUTATIONS: any[] = []
  let nextStoreMutationSeq = 0
  /** storeId → 退订函数（面板订阅期间才存在） */
  const storeUnsubs = new Map<string, () => void>()

  function ecosystem(): any {
    try { return (window as any)[ECOSYSTEM_KEY] || null } catch { return null }
  }

  function storeProvider(): any {
    const eco = ecosystem()
    const p = eco && eco.store
    return p && typeof p.list === 'function' ? p : null
  }

  /**
   * 生态接入探测。`store/router/i18n` 三个布尔值保持与首版一致的语义（provider 是否存在），
   * 另加 `*Count` 让面板能区分「库装了但没建实例」和「库根本没接入」。
   */
  function ecosystemAvailability(): any {
    const eco = ecosystem()
    const count = (p: any) => {
      try { return p && typeof p.list === 'function' ? (p.list() || []).length : 0 } catch { return 0 }
    }
    return {
      available: !!eco,
      store: !!(eco && eco.store),
      router: !!(eco && eco.router),
      i18n: !!(eco && eco.i18n),
      storeCount: count(eco && eco.store),
      routerCount: count(eco && eco.router),
      i18nCount: count(eco && eco.i18n),
      namespaces: eco ? Object.keys(eco) : []
    }
  }

  /** 单个 store 的元信息：state / getters / actions 三段键名 */
  function getStoreInfo(id: string): any {
    const p = storeProvider()
    if (!p) return null
    let e: any = null
    try { e = p.entry(id) } catch { e = null }
    if (!e || !e.facade) return null
    let stateKeys: string[] = []
    try { stateKeys = Object.keys(e.facade) } catch { /* noop */ }
    return {
      id,
      slotKey: e.slotKey,
      stateKeys,
      getters: Array.isArray(e.getters) ? e.getters : [],
      actions: Array.isArray(e.actions) ? e.actions : []
    }
  }

  function getStores(): any[] {
    const p = storeProvider()
    if (!p) return []
    let ids: string[] = []
    try { ids = p.list() || [] } catch { ids = [] }
    const out: any[] = []
    for (const id of ids) {
      const info = getStoreInfo(id)
      if (info) out.push(info)
    }
    return out
  }

  function getStoreState(id: string): any {
    const p = storeProvider()
    if (!p) return null
    let e: any = null
    try { e = p.entry(id) } catch { e = null }
    if (!e || !e.facade) return null
    const data: Record<string, any> = {}
    const getters: Record<string, any> = {}
    try {
      for (const k of Object.keys(e.facade)) data[k] = serializeValue(e.facade[k])
    } catch { /* noop */ }
    try {
      for (const g of (e.getters || [])) {
        try { getters[g] = serializeValue(e.facade[g]) } catch { getters[g] = '[error]' }
      }
    } catch { /* noop */ }
    return { id, data, getters, timestamp: Date.now() }
  }

  function setStoreState(id: string, key: string, value: any): boolean {
    const p = storeProvider()
    if (!p) return false
    let e: any = null
    try { e = p.entry(id) } catch { e = null }
    if (!e || !e.facade || typeof e.facade.patch !== 'function') return false
    try {
      // 支持深度路径：`root.nested[0].leaf` → 读取根值，沿路径修改后整体 patch 回
      const segments = parsePath(key)
      const rootKey = segments[0]
      const rest = segments.slice(1)
      if (rest.length === 0) {
        e.facade.patch({ [key]: value })
        return true
      }
      const root = (e.facade && e.facade[rootKey] != null) ? e.facade[rootKey] : null
      if (root === null || typeof root !== 'object') return false
      const parent = getByPath(root, rest.slice(0, -1))
      if (!parent || typeof parent !== 'object') return false
      parent[rest[rest.length - 1]] = value
      e.facade.patch({ [rootKey]: root })
      return true
    } catch { return false }
  }

  function callStoreAction(id: string, action: string, args: any): any {
    const p = storeProvider()
    if (!p) return { ok: false, error: '生态库未接入：未找到 store provider' }
    let e: any = null
    try { e = p.entry(id) } catch { e = null }
    if (!e || !e.facade) return { ok: false, error: 'store 不存在: ' + id }
    const fn = e.facade[action]
    if (typeof fn !== 'function') return { ok: false, error: 'action 不存在: ' + action }
    try {
      const list = Array.isArray(args) ? args : []
      const rs = fn.apply(e.facade, list)
      return { ok: true, result: serializeValue(rs) }
    } catch (err: any) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  }

  function resetStore(id: string): boolean {
    const p = storeProvider()
    if (!p) return false
    let e: any = null
    try { e = p.entry(id) } catch { e = null }
    if (!e || !e.facade || typeof e.facade.reset !== 'function') return false
    try { e.facade.reset(); return true } catch { return false }
  }

  /** mutation 的线上形状：原始值序列化后回传，snapshot 只做浅层预览 */
  function serializeStoreMutation(rec: any): any {
    return {
      seq: rec.seq,
      storeId: rec.storeId,
      key: rec.key,
      oldValue: serializeValue(rec.oldValue),
      newValue: serializeValue(rec.newValue),
      snapshotPreview: serializeValue(rec.snapshot),
      timestamp: rec.timestamp
    }
  }

  function addStoreMutationRecord(id: string, mutation: any, snapshot: any) {
    const rec = {
      seq: nextStoreMutationSeq++,
      storeId: id,
      key: (mutation && mutation.key) || '',
      oldValue: mutation ? mutation.oldValue : undefined,
      newValue: mutation ? mutation.newValue : undefined,
      // 保留原始浅快照用于回滚；发给面板时才序列化（序列化有损，不可用于回滚）
      snapshot: snapshot,
      timestamp: Date.now()
    }
    if (STORE_MUTATIONS.length >= MAX_STORE_MUTATIONS) STORE_MUTATIONS.shift()
    STORE_MUTATIONS.push(rec)

    addTimelineRecord({
      cid: -1,
      tagName: 'store:' + id,
      type: 'store',
      name: id + '.' + rec.key,
      duration: 0,
      timestamp: rec.timestamp,
      details: { oldValue: serializeValue(rec.oldValue), newValue: serializeValue(rec.newValue) }
    })

    if (subscribedTypes.has('store')) {
      sendToPanel('COMPELEM_DEVTOOLS_PUSH_STORE_MUTATION', serializeStoreMutation(rec))
    }
  }

  function subscribeStore(): any {
    const p = storeProvider()
    // 心跳：面板每次重发 SUBSCRIBE 都会刷新，看门狗据此判断面板是否还活着
    lastEcoHeartbeat = Date.now()
    startEcoWatchdog()
    if (!p) return { subscribed: false, reason: 'no-store-provider' }
    let ids: string[] = []
    try { ids = p.list() || [] } catch { ids = [] }
    for (const id of ids) {
      if (storeUnsubs.has(id)) continue
      try {
        storeUnsubs.set(id, p.subscribe(id, (mutation: any, snapshot: any) => {
          addStoreMutationRecord(id, mutation, snapshot)
        }))
      } catch { /* noop */ }
    }
    return { subscribed: true, ids: Array.from(storeUnsubs.keys()) }
  }

  function unsubscribeStore(): boolean {
    storeUnsubs.forEach(off => { try { off() } catch { /* noop */ } })
    storeUnsubs.clear()
    return true
  }

  /**
   * 面板关闭时不会有机会发退订消息，因此用「心跳 + 看门狗」兜底：
   * 面板在订阅期间每 5s 重发一次 SUBSCRIBE（幂等），超过 12s 没收到就自行摘钩，
   * 避免 listeners 里永久挂着一个回调、白白构造 snapshot。
   *
   * store / router / i18n 三者共用一个心跳与看门狗：任一路径被订阅时启动，
   * 全部退订后自动停表。
   */
  let lastEcoHeartbeat = 0
  let ecoWatchdog: any = null

  /** 是否还有任何生态订阅挂着钩子 */
  function hasEcoSubscriptions(): boolean {
    return storeUnsubs.size > 0 || !!routerUnsub || i18nUnsubs.size > 0
  }

  function startEcoWatchdog() {
    if (ecoWatchdog) return
    ecoWatchdog = setInterval(() => {
      if (!hasEcoSubscriptions()) {
        clearInterval(ecoWatchdog)
        ecoWatchdog = null
        return
      }
      if (Date.now() - lastEcoHeartbeat > 12000) {
        unsubscribeStore()
        unsubscribeRouter()
        unsubscribeI18n()
        clearInterval(ecoWatchdog)
        ecoWatchdog = null
      }
    }, 5000)
  }

  /**
   * 用历史浅快照回滚。注意：浅快照的顶层标量可靠，嵌套对象/数组是共享引用，
   * 若已被原地改写则回不去——面板需向用户明示这一限制。
   */
  function applyStoreSnapshot(id: string, seq: number): any {
    const p = storeProvider()
    if (!p) return { ok: false, error: '生态库未接入：未找到 store provider' }
    let e: any = null
    try { e = p.entry(id) } catch { e = null }
    if (!e || !e.facade) return { ok: false, error: 'store 不存在: ' + id }
    const rec = STORE_MUTATIONS.find(r => r.seq === seq && r.storeId === id)
    if (!rec) return { ok: false, error: '找不到该快照记录 seq=' + seq }
    if (!rec.snapshot) return { ok: false, error: '该记录没有可用快照' }
    try {
      e.facade.patch(rec.snapshot)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  }

  // ---------------- 生态库：router ----------------
  // 契约：__COMPELEM_ECOSYSTEM__.router → { list(), entry(id), active() }
  // entry: { routes(), current(), match(url), navigate(action, payload), subscribe(cb) }
  const MAX_ROUTE_HISTORY = 200
  const ROUTE_HISTORY: any[] = []
  let nextRouteHistorySeq = 0
  let routerUnsub: (() => void) | null = null

  function routerProvider(): any {
    const eco = ecosystem()
    const p = eco && eco.router
    return p && typeof p.active === 'function' ? p : null
  }

  function routerEntry(): any {
    const p = routerProvider()
    if (!p) return null
    try {
      // 优先 active()（单例路由）；退化到 list() 的第一个
      let e = null
      if (typeof p.active === 'function') e = p.active()
      if (!e && typeof p.list === 'function') {
        const ids = p.list() || []
        if (ids.length) e = p.entry(ids[0])
      }
      return e && typeof e.current === 'function' ? e : null
    } catch { return null }
  }

  /**
   * 路由总览：路由表 + 当前路由 + 历史。
   * 注意 current 里的 `url` 才是可信全路径；`path`/`fullPath` 来自库侧 Route，
   * 在「多段路径」场景会被截断（库侧既有问题，见 panel 的提示）。
   */
  function getRouterInfo(): any {
    const p = routerProvider()
    if (!p) return null
    const e = routerEntry()
    if (!e) return null
    let routes: any[] = []
    let current: any = null
    try { routes = e.routes() || [] } catch { routes = [] }
    try { current = e.current() } catch { current = null }
    return { routes, current, history: ROUTE_HISTORY.map(serializeRouteHistory) }
  }

  function matchRoute(url: string): any {
    const e = routerEntry()
    if (!e || typeof e.match !== 'function') return { matched: false, error: 'router 未接入' }
    try { return e.match(url) } catch (err: any) {
      return { matched: false, error: (err && err.message) || String(err) }
    }
  }

  /**
   * 导航控制。
   *
   * 只返回**同步回执**（指令是否下发），不等导航落地 —— 因为这条链路要走
   * `inspectedWindow.eval`，而它是否替调用方 await Promise 并不确定，
   * 与其赌它，不如用「回执 + 推送」两段式：
   * 导航真正落地时 `subscribeRouter` 的回调会推 `COMPELEM_DEVTOOLS_PUSH_ROUTE_CHANGE`，
   * 面板据此刷新当前路由；失败则推 `_PUSH_ROUTE_ERROR`。
   */
  function routerNavigate(action: string, payload: any): any {
    const e = routerEntry()
    if (!e || typeof e.navigate !== 'function') return { ok: false, error: 'router 未接入' }
    try {
      const rs = e.navigate(action, payload)
      if (rs && typeof rs.then === 'function') {
        rs.then((r: any) => {
          if (r && r.ok === false) pushRouteError(action, r.error)
        }, (err: any) => pushRouteError(action, (err && err.message) || String(err)))
      }
      return { ok: true, started: true, action }
    } catch (err: any) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  }

  function pushRouteError(action: string, error: string) {
    if (!subscribedTypes.has('route')) return
    sendToPanel('COMPELEM_DEVTOOLS_PUSH_ROUTE_ERROR', { action, error: error || '未知错误' })
  }

  function serializeRouteHistory(rec: any): any {
    return {
      seq: rec.seq,
      to: rec.to,
      from: rec.from,
      toName: rec.toName,
      fromName: rec.fromName,
      url: rec.url,
      timestamp: rec.timestamp
    }
  }

  function addRouteHistoryRecord(to: any, from: any) {
    const rec = {
      seq: nextRouteHistorySeq++,
      to: (to && to.path) || '',
      from: (from && from.path) || '',
      toName: to && to.name,
      fromName: from && from.name,
      // 回调触发时 location 已经切好，url 取可信的当前地址
      url: routerCurrentUrl(),
      timestamp: Date.now()
    }
    if (ROUTE_HISTORY.length >= MAX_ROUTE_HISTORY) ROUTE_HISTORY.shift()
    ROUTE_HISTORY.push(rec)

    addTimelineRecord({
      cid: -1,
      tagName: 'route',
      type: 'route',
      name: rec.toName || rec.to || rec.url,
      duration: 0,
      timestamp: rec.timestamp,
      details: { from: rec.from, to: rec.to, url: rec.url }
    })

    if (subscribedTypes.has('route')) {
      sendToPanel('COMPELEM_DEVTOOLS_PUSH_ROUTE_CHANGE', serializeRouteHistory(rec))
    }
  }

  function routerCurrentUrl(): string {
    const e = routerEntry()
    if (!e) return ''
    try {
      const cur = e.current()
      return (cur && cur.url) || (cur && cur.fullPath) || ''
    } catch { return '' }
  }

  function subscribeRouter(): any {
    lastEcoHeartbeat = Date.now()
    startEcoWatchdog()
    const e = routerEntry()
    if (!e) return { subscribed: false, reason: 'no-router-provider' }
    if (routerUnsub) return { subscribed: true, already: true }
    try {
      routerUnsub = e.subscribe((to: any, from: any) => addRouteHistoryRecord(to, from))
    } catch { /* noop */ }
    return { subscribed: !!routerUnsub }
  }

  function unsubscribeRouter(): boolean {
    if (routerUnsub) { try { routerUnsub() } catch { /* noop */ } }
    routerUnsub = null
    return true
  }

  // ---------------- 生态库：i18n ----------------
  // 契约：__COMPELEM_ECOSYSTEM__.i18n → { list(), entry(id), active() }
  // entry: { locale(), locales(), messages(locale), setLocale(l), resolve(key, params, locale), subscribe(cb) }
  const MAX_LOCALE_TRACE = 200
  const LOCALE_TRACE: any[] = []
  let nextLocaleTraceSeq = 0
  const i18nUnsubs = new Map<string, () => void>()

  function i18nProvider(): any {
    const eco = ecosystem()
    const p = eco && eco.i18n
    return p && typeof p.list === 'function' ? p : null
  }

  function getI18nInstances(): any[] {
    const p = i18nProvider()
    if (!p) return []
    let ids: string[] = []
    try { ids = p.list() || [] } catch { ids = [] }
    const out: any[] = []
    for (const id of ids) {
      let e: any = null
      try { e = p.entry(id) } catch { e = null }
      if (!e) continue
      let locale = '', locales: string[] = [], fallback: any
      try { locale = e.locale() } catch { /* noop */ }
      try { locales = e.locales() || [] } catch { locales = [] }
      try { fallback = e.fallbackLocale() } catch { /* noop */ }
      out.push({ id, locale, locales, fallbackLocale: fallback })
    }
    return out
  }

  function i18nEntry(id: string): any {
    const p = i18nProvider()
    if (!p) return null
    try { return p.entry(id) || null } catch { return null }
  }

  /** 取某语言（缺省当前语言）的原始消息树 */
  function getI18nMessages(id: string, locale?: string): any {
    const e = i18nEntry(id)
    if (!e) return null
    let loc = locale
    try { if (!loc) loc = e.locale() } catch { /* noop */ }
    let messages: any = {}
    try { messages = e.messages(loc as string) || {} } catch { messages = {} }
    return { id, locale: loc, messages: serializeMessages(messages) }
  }

  function setI18nLocale(id: string, locale: string): any {
    const e = i18nEntry(id)
    if (!e) return { ok: false, error: 'i18n 未接入' }
    try {
      e.setLocale(locale)
      return { ok: true, locale: e.locale() }
    } catch (err: any) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  }

  /**
   * 解析 key 并回报回退链定位（foundIn / chain）。
   * 这是面板「这个 key 在哪个语言包里缺了」的唯一依据；本身是只读操作。
   */
  function resolveI18nKey(id: string, key: string, params: any, locale?: string): any {
    const e = i18nEntry(id)
    if (!e) return { found: false, error: 'i18n 未接入' }
    if (typeof e.resolve !== 'function') return { found: false, error: '接入点缺少 resolve()' }
    try {
      const rs = e.resolve(key, params, locale)
      if (!rs) return { found: false }
      return {
        key: rs.key, locale: rs.locale, chain: rs.chain, found: !!rs.found,
        foundIn: rs.foundIn, value: serializeValue(rs.value), raw: serializeValue(rs.raw),
        pluralCategory: rs.pluralCategory
      }
    } catch (err: any) {
      return { found: false, error: (err && err.message) || String(err) }
    }
  }

  function serializeLocaleTrace(rec: any): any {
    return { seq: rec.seq, id: rec.id, locale: rec.locale, oldLocale: rec.oldLocale, timestamp: rec.timestamp }
  }

  function addLocaleTraceRecord(id: string, locale: string, oldLocale: string) {
    const rec = { seq: nextLocaleTraceSeq++, id, locale, oldLocale, timestamp: Date.now() }
    if (LOCALE_TRACE.length >= MAX_LOCALE_TRACE) LOCALE_TRACE.shift()
    LOCALE_TRACE.push(rec)

    addTimelineRecord({
      cid: -1,
      tagName: 'i18n:' + id,
      type: 'locale',
      name: oldLocale + ' → ' + locale,
      duration: 0,
      timestamp: rec.timestamp,
      details: { locale, oldLocale }
    })

    if (subscribedTypes.has('locale')) {
      sendToPanel('COMPELEM_DEVTOOLS_PUSH_LOCALE_CHANGE', serializeLocaleTrace(rec))
    }
  }

  function subscribeI18n(): any {
    lastEcoHeartbeat = Date.now()
    startEcoWatchdog()
    const p = i18nProvider()
    if (!p) return { subscribed: false, reason: 'no-i18n-provider' }
    let ids: string[] = []
    try { ids = p.list() || [] } catch { ids = [] }
    for (const id of ids) {
      if (i18nUnsubs.has(id)) continue
      const e = i18nEntry(id)
      if (!e || typeof e.subscribe !== 'function') continue
      try {
        i18nUnsubs.set(id, e.subscribe((locale: string, oldLocale: string) => addLocaleTraceRecord(id, locale, oldLocale)))
      } catch { /* noop */ }
    }
    return { subscribed: true, ids: Array.from(i18nUnsubs.keys()) }
  }

  function unsubscribeI18n(): boolean {
    i18nUnsubs.forEach(off => { try { off() } catch { /* noop */ } })
    i18nUnsubs.clear()
    return true
  }

  // ---------------- 依赖信息 ----------------
  function getDependencies(cid: number): any {
    const comp = findComponent(cid)
    if (!comp) return null

    const subViewDeps: Record<string, number> = {}
    try {
      const deps = comp.__updateSubViewDeps
      if (deps && typeof deps.forEach === 'function') {
        deps.forEach((val: any, key: string) => {
          subViewDeps[key] = val && val.size !== undefined ? val.size : 0
        })
      }
    } catch { /* noop */ }

    // 优先取核心库接入点：viewDeps 是 render() 真实收集的完整依赖；
    // computedDeps / watchKeys 只有库侧才有（此前一个是硬编码 {}，一个是永不写入的字段）
    const meta = coreMeta()
    const ctor = comp.constructor
    let computedDeps: Record<string, string[]> = {}
    let watchKeys: string[] = []
    let viewDepsFromLib: string[] = []
    if (meta && ctor) {
      try { computedDeps = meta.computedDeps(ctor) || {} } catch { /* noop */ }
      try { watchKeys = meta.watchKeys(ctor) || [] } catch { /* noop */ }
      try { viewDepsFromLib = meta.viewDeps(ctor) || [] } catch { /* noop */ }
    }
    if (!watchKeys.length) {
      // 老版本库回退：原型上可能被其它工具写入过
      watchKeys = ctor?.prototype?.__cdt_watchKeys__ || []
    }

    const viewDeps: string[] = []
    if (viewDepsFromLib.length) {
      viewDepsFromLib.forEach((d: string) => { if (!viewDeps.includes(d)) viewDeps.push(d) })
    } else {
      // 回退：根层 UpdatePoint 代表模板插值
      try {
        const tree = comp.__updateTree || []
        tree.forEach((up: any) => {
          const deps = up?.deps || up?.varPathList || []
          deps.forEach((d: string) => {
            if (!viewDeps.includes(d)) viewDeps.push(d)
          })
        })
      } catch { /* noop */ }
    }

    return {
      viewDeps,
      computedDeps,
      cssDeps: Object.keys(comp.cssVars || {}),
      watchKeys,
      updatePointCount: (comp.__updateTree || []).length,
      subViewDeps
    }
  }

  // ---------------- UpdatePoint 检查 ----------------
  function getUpdatePoints(cid: number): any[] {
    const comp = findComponent(cid)
    if (!comp) return []
    const result: any[] = []
    try {
      const tree = comp.__updateTree || []
      function walk(ups: any[], depth: number) {
        ups.forEach(up => {
          if (!up) return
          const counter = updatePointCounter.get(up)
          result.push({
            id: up.id || up.__cdt_id__ || `up_${result.length}`,
            deps: updatePointDeps.get(up) || up.deps || up.varPathList || up.vars || [],
            updateCount: counter ? counter.count : 0,
            lastUpdateTime: counter ? counter.lastTime : 0,
            depth,
            type: up.type || 'unknown'
          })
          if (up.children && up.children.length) walk(up.children, depth + 1)
        })
      }
      walk(tree, 0)
    } catch { /* noop */ }
    return result
  }

  // ---------------- 事件触发（测试用）----------------
  function triggerEmit(cid: number, eventName: string, args: any): boolean {
    const comp = findComponent(cid)
    if (!comp) return false
    try {
      if (typeof comp.emit === 'function') comp.emit(eventName, args)
      return true
    } catch { return false }
  }

  // ---------------- 高亮（独立 overlay）----------------
  let highlightCid: number | null = null
  let overlayEl: HTMLDivElement | null = null
  /** 高亮期间挂在各滚动容器 / window 上的监听清理函数（removeHighlight 时统一摘除） */
  let highlightScrollCleanups: (() => void)[] = []

  let overlayStyleInjected = false
  function ensureOverlayStyle() {
    if (overlayStyleInjected) return
    const style = document.createElement('style')
    style.textContent = `
      #cdt-overlay-root {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        pointer-events: none;
        z-index: 2147483646;
        overflow: hidden;
      }
      #cdt-overlay-box {
        position: fixed;
        border: 2px solid #4fc3f7;
        background: rgba(79, 195, 247, 0.08);
        box-shadow: 0 0 0 2px rgba(79, 195, 247, 0.25), inset 0 0 30px rgba(79, 195, 247, 0.12);
        border-radius: 2px;
        transition: all 0.12s ease-out;
        pointer-events: none;
      }
      #cdt-overlay-label {
        position: fixed;
        background: linear-gradient(135deg, #4fc3f7, #29b6f6);
        color: #0a0a1a;
        font-size: 11px;
        font-family: -apple-system, 'Segoe UI', monospace;
        font-weight: 600;
        padding: 3px 8px;
        border-radius: 4px 4px 0 0;
        white-space: nowrap;
        pointer-events: none;
        box-shadow: 0 2px 8px rgba(79, 195, 247, 0.4);
      }
    `
      ; (document.head || document.documentElement).appendChild(style)
    overlayStyleInjected = true
  }

  function updateOverlayPosition() {
    if (!overlayEl || highlightCid == null) return
    const comp = findComponent(highlightCid)
    if (!comp) { removeHighlight(); return }
    const rect = comp.getBoundingClientRect()
    const box = overlayEl.querySelector('#cdt-overlay-box') as HTMLElement
    const label = overlayEl.querySelector('#cdt-overlay-label') as HTMLElement
    if (!box) return

    box.style.top = rect.top + 'px'
    box.style.left = rect.left + 'px'
    box.style.width = rect.width + 'px'
    box.style.height = rect.height + 'px'

    label.style.top = Math.max(0, rect.top - 22) + 'px'
    label.style.left = Math.max(0, rect.left) + 'px'
  }

  function highlightComponent(cid: number): boolean {
    const comp = findComponent(cid)
    if (!comp) return false
    removeHighlight()
    highlightCid = cid
    ensureOverlayStyle()

    if (!overlayEl) {
      overlayEl = document.createElement('div')
      overlayEl.id = 'cdt-overlay-root'
      overlayEl.innerHTML = `
        <div id="cdt-overlay-box"></div>
        <div id="cdt-overlay-label"></div>
      `
      document.documentElement.appendChild(overlayEl)
    }

    const label = overlayEl.querySelector('#cdt-overlay-label') as HTMLElement
    label.textContent = `<${comp.tagName.toLowerCase()}> #${cid}`

    // 跟随滚动：scroll 事件**不冒泡**，且发生在 Shadow DOM 内的 scroll 不会越过
    // shadow 边界传到 window —— 只靠 window capture 监听会漏掉内部滚动容器
    // （如 <site-sidebar> 的列表区滚动时高亮不跟随）。
    // → 把监听直挂到组件的每一个可滚动祖先上（同树直挂必然触发），
    //   页面级滚动仍由 window capture 兜底。卸载高亮时统一摘除。
    detachHighlightScrollListeners()
    for (const scroller of collectScrollableAncestors(comp)) {
      const fn = () => updateOverlayPosition()
      scroller.addEventListener('scroll', fn, { passive: true })
      highlightScrollCleanups.push(() => scroller.removeEventListener('scroll', fn))
    }
    window.addEventListener('scroll', updateOverlayPosition, { capture: true, passive: true })
    window.addEventListener('resize', updateOverlayPosition)
    highlightScrollCleanups.push(() => {
      window.removeEventListener('scroll', updateOverlayPosition, { capture: true })
      window.removeEventListener('resize', updateOverlayPosition)
    })

    updateOverlayPosition()
    return true
  }

  function removeHighlight() {
    detachHighlightScrollListeners()
    if (overlayEl) {
      overlayEl.remove()
      overlayEl = null
    }
    highlightCid = null
  }

  function detachHighlightScrollListeners() {
    for (const fn of highlightScrollCleanups) {
      try { fn() } catch { /* 容器可能已随 DOM 销毁 */ }
    }
    highlightScrollCleanups = []
  }

  /** 收集组件的**全部**可滚动祖先（穿 shadow 边界，含组件自身）。供高亮 overlay 跟随滚动用。 */
  function collectScrollableAncestors(el: HTMLElement): HTMLElement[] {
    const out: HTMLElement[] = []
    let cur: any = el
    const visited = new Set<any>()
    while (cur && !visited.has(cur)) {
      visited.add(cur)
      if (cur === document.documentElement || cur === document.body) break
      if (cur instanceof HTMLElement) {
        const cs = getComputedStyle(cur)
        const oy = cs.overflowY
        const ox = cs.overflowX
        const scrollableY = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && cur.scrollHeight > cur.clientHeight + 4
        const scrollableX = (ox === 'auto' || ox === 'scroll' || ox === 'overlay') && cur.scrollWidth > cur.clientWidth + 4
        if (scrollableY || scrollableX) out.push(cur)
      }
      if (cur.parentElement) {
        cur = cur.parentElement
      } else {
        const root = cur.getRootNode()
        if (root && root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && (root as ShadowRoot).host) {
          cur = (root as ShadowRoot).host
        } else {
          break
        }
      }
    }
    return out
  }

  // 向上找最近的可滚动祖先容器
  function findScrollableAncestor(el: HTMLElement): HTMLElement | null {
    let cur: any = el
    const visited = new Set<any>()
    while (cur && !visited.has(cur)) {
      visited.add(cur)

      // 跳过 document 根
      if (cur === document.documentElement || cur === document.body) break

      // 检查当前元素是否可滚动（host 元素可能就是容器）
      if (cur instanceof HTMLElement) {
        const cs = getComputedStyle(cur)
        const oy = cs.overflowY
        if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && cur.scrollHeight > cur.clientHeight + 4) {
          return cur
        }
      }

      // 向上走
      if (cur.parentElement) {
        cur = cur.parentElement
      } else {
        // 到 parentElement 边界了 — 可能是 shadow root 内部顶层元素
        const root = cur.getRootNode()
        if (root && root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && (root as ShadowRoot).host) {
          // 跳到 shadow host 继续往上
          cur = (root as ShadowRoot).host
        } else {
          break
        }
      }
    }
    return null
  }

  function scrollToComponent(cid: number): boolean {
    const comp = findComponent(cid)
    if (!comp) return false

    // 优先滚最近的可滚动祖先容器
    const scrollable = findScrollableAncestor(comp)
    if (scrollable) {
      // 用视口坐标差值计算（offsetTop 链在中间有 relative/absolute 定位元素时会算错，
      // getBoundingClientRect 不受 offsetParent 链影响，也能正确处理 shadow root）
      const elRect = comp.getBoundingClientRect()
      const cr = scrollable.getBoundingClientRect()
      const target = scrollable.scrollTop + (elRect.top - cr.top) - cr.height / 2 + elRect.height / 2
      scrollable.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
      return true
    }

    // fallback: window 滚动
    const rect = comp.getBoundingClientRect()
    const offset = rect.top + window.scrollY - window.innerHeight / 2 + rect.height / 2
    window.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' })
    return true
  }

  // ---------------- 元素 → 组件（右键定位）----------------
  // 右键目标在点击菜单时已经过期无从得知，所以在 contextmenu 时先记下来
  let contextTarget: any = null
  let contextPath: any[] = []

  window.addEventListener('contextmenu', (e) => {
    try {
      // composedPath 才能穿透 Shadow DOM 拿到真实目标（target 会被 retarget 成宿主）
      const path = e.composedPath ? e.composedPath() : []
      contextPath = path
      contextTarget = path[0] || e.target
    } catch { /* noop */ }
  }, true)

  // 沿 parentElement 上爬找最近的 compelem 组件，穿过 shadow root 边界
  function findCompElemAncestor(node: any): any {
    let cur = node
    let guard = 0
    while (cur && cur.nodeType === 1 && guard++ < 500) {
      if (isCompElem(cur)) return cur
      if (cur.parentElement) {
        cur = cur.parentElement
        continue
      }
      const root = cur.getRootNode ? cur.getRootNode() : null
      if (root && root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && (root as ShadowRoot).host) {
        cur = (root as ShadowRoot).host
        continue
      }
      break
    }
    return null
  }

  // 从该元素向上收集所有 compelem 组件（近 → 远），跳过已脱离文档的
  function describeComponentChain(node: any): any[] {
    const chain: any[] = []
    let cur = node
    let guard = 0
    while (cur && cur.nodeType === 1 && guard++ < 500) {
      if (cur.isConnected && isCompElem(cur)) {
        let cid: number = NaN
        try { cid = parseInt(cur.cid) } catch { cid = NaN }
        chain.push({
          cid: Number.isFinite(cid) ? cid : -1,
          tagName: String(cur.tagName || '').toLowerCase(),
          className: (cur.constructor && cur.constructor.name) || 'Unknown'
        })
      }
      if (cur.parentElement) {
        cur = cur.parentElement
        continue
      }
      const root = cur.getRootNode ? cur.getRootNode() : null
      if (root && root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && (root as ShadowRoot).host) {
        cur = (root as ShadowRoot).host
        continue
      }
      break
    }
    return chain
  }

  // 右键时记录的元素可能被重渲染掉 → 优先用还连着的目标
  function currentContextNode(): any {
    if (contextTarget && contextTarget.isConnected && contextTarget.nodeType === 1) return contextTarget
    for (let i = 0; i < contextPath.length; i++) {
      const n = contextPath[i]
      if (n && n.nodeType === 1 && n.isConnected) return n
    }
    return null
  }

  // DOM 节点 → 最近的 compelem 组件实例
  function findComponentByElement(node: any): any | null {
    let el = node
    if (el && el.nodeType !== 1) el = el.parentElement
    if (!el) return null
    const compEl = findCompElemAncestor(el)
    if (!compEl) return null
    let cid: number = NaN
    try { cid = parseInt(compEl.cid) } catch { cid = NaN }
    if (!Number.isFinite(cid)) return compEl
    return findComponent(cid) || compEl
  }

  // ---------------- 页面内提示（Shadow DOM 隔离，避免被页面样式污染）----------------
  let toastRoot: HTMLElement | null = null
  let toastTimer: number | null = null

  function showToast(text: string, kind?: string) {
    if (!text) return
    try {
      if (!toastRoot || !toastRoot.isConnected) {
        toastRoot = document.createElement('div')
        toastRoot.id = 'compelem-devtools-toast-root'
        toastRoot.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;'
        const sr = toastRoot.attachShadow ? toastRoot.attachShadow({ mode: 'open' }) : null
        const host: any = sr || toastRoot
        host.innerHTML = '<style>' +
          '.cdt-toast{font:12px/1.6 -apple-system,"Segoe UI",sans-serif;background:#141726;color:#e6e9f5;' +
          'border:1px solid rgba(108,140,255,.45);border-radius:6px;padding:7px 12px;white-space:nowrap;' +
          'box-shadow:0 6px 24px rgba(0,0,0,.35);opacity:0;transform:translateY(6px);' +
          'transition:opacity .18s ease,transform .18s ease}' +
          '.cdt-toast.warn{border-color:rgba(251,146,60,.55);color:#ffd7b0}' +
          '.cdt-toast.show{opacity:1;transform:translateY(0)}' +
          '</style><div class="cdt-toast"></div>'
          ; (document.body || document.documentElement).appendChild(toastRoot)
      }
      const host: any = toastRoot.shadowRoot || toastRoot
      const el = host.querySelector('.cdt-toast')
      if (!el) return
      el.className = 'cdt-toast' + (kind === 'warn' ? ' warn' : '')
      el.textContent = text
      // 强制回流，保证重复提示也能触发过渡
      void el.offsetWidth
      el.classList.add('show')
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = window.setTimeout(() => { el.classList.remove('show') }, 2600)
    } catch { /* noop */ }
  }

  // ---------------- 消息处理 ----------------
  let panelPort: MessagePort | null = null

  function sendToPanel(type: string, payload?: any) {
    const msg = { type, payload, _ts: Date.now() }
    try {
      if (panelPort) panelPort.postMessage(msg)
      // content script 监听的是 window.postMessage 触发的 message 事件
      window.postMessage(msg, '*')
    } catch { /* noop */ }
  }

  function handleMessage(msg: any) {
    if (!msg || !msg.type) return
    const type = msg.type as string
    const payload = msg.payload
    const id = msg.id
    let result: any = undefined

    try {
      switch (type) {
        case 'COMPELEM_DEVTOOLS_PING':
          result = { pong: true, version: VERSION, hooked: isHooked }
          break
        case 'COMPELEM_DEVTOOLS_GET_TREE':
          result = getComponentTree()
          break
        case 'COMPELEM_DEVTOOLS_GET_STATE':
          result = getStateSnapshot(payload?.cid)
          break
        case 'COMPELEM_DEVTOOLS_SET_STATE':
          result = setStateValue(payload?.cid, payload?.key, payload?.value)
          break
        case 'COMPELEM_DEVTOOLS_FORCE_UPDATE':
          result = forceUpdate(payload?.cid)
          break
        case 'COMPELEM_DEVTOOLS_HIGHLIGHT':
          result = highlightComponent(payload?.cid)
          break
        case 'COMPELEM_DEVTOOLS_UNHIGHLIGHT':
          removeHighlight()
          result = true
          break
        case 'COMPELEM_DEVTOOLS_SCROLL':
          result = scrollToComponent(payload?.cid)
          break
        case 'COMPELEM_DEVTOOLS_GET_DEPS':
          result = getDependencies(payload?.cid)
          break
        case 'COMPELEM_DEVTOOLS_GET_UPDATE_POINTS':
          result = getUpdatePoints(payload?.cid)
          break
        case 'COMPELEM_DEVTOOLS_GET_METRICS':
          result = UPDATE_LOG.slice(-100)
          break
        case 'COMPELEM_DEVTOOLS_GET_EVENTS':
          result = EVENT_LOG.slice(-(payload?.limit || 100))
          break
        case 'COMPELEM_DEVTOOLS_GET_TIMELINE':
          result = TIMELINE.slice(-(payload?.limit || 500))
          break
        case 'COMPELEM_DEVTOOLS_CLEAR_EVENTS':
          EVENT_LOG.length = 0
          UPDATE_LOG.length = 0
          TIMELINE.length = 0
          result = true
          break
        case 'COMPELEM_DEVTOOLS_CLEAR_TIMELINE':
          TIMELINE.length = 0
          result = true
          break
        case 'COMPELEM_DEVTOOLS_HOOK':
          autoHook()
          result = { success: true, hookedCtors: hookedCtors.size }
          break
        case 'COMPELEM_DEVTOOLS_SUBSCRIBE':
          if (payload?.types?.length) {
            payload.types.forEach((t: string) => subscribedTypes.add(t))
            if (payload?.cid !== undefined) subscribedCid = payload.cid
            // 生态库的订阅是唯一需要真正挂钩子到页面侧的推送：按需挂、退订即摘
            if (payload.types.includes('store')) subscribeStore()
            if (payload.types.includes('route')) subscribeRouter()
            if (payload.types.includes('locale')) subscribeI18n()
          }
          result = { subscribed: Array.from(subscribedTypes) }
          break
        case 'COMPELEM_DEVTOOLS_UNSUBSCRIBE':
          if (payload?.types?.length) {
            payload.types.forEach((t: string) => subscribedTypes.delete(t))
            if (payload.types.includes('store')) unsubscribeStore()
            if (payload.types.includes('route')) unsubscribeRouter()
            if (payload.types.includes('locale')) unsubscribeI18n()
          } else {
            subscribedTypes.clear()
            unsubscribeStore()
            unsubscribeRouter()
            unsubscribeI18n()
          }
          subscribedCid = undefined
          result = { subscribed: Array.from(subscribedTypes) }
          break
        case 'COMPELEM_DEVTOOLS_TRIGGER_EMIT':
          result = triggerEmit(payload?.cid, payload?.eventName, payload?.args)
          break
        case 'COMPELEM_DEVTOOLS_DESTROY_COMPONENT':
          result = destroyComponent(payload?.cid)
          break
        // ---- 生态库：store ----
        case 'COMPELEM_DEVTOOLS_GET_ECOSYSTEM':
          result = ecosystemAvailability()
          break
        case 'COMPELEM_DEVTOOLS_GET_STORES':
          result = getStores()
          break
        case 'COMPELEM_DEVTOOLS_GET_STORE_STATE':
          result = getStoreState(payload?.id)
          break
        case 'COMPELEM_DEVTOOLS_SET_STORE_STATE':
          result = setStoreState(payload?.id, payload?.key, payload?.value)
          break
        case 'COMPELEM_DEVTOOLS_CALL_STORE_ACTION':
          result = callStoreAction(payload?.id, payload?.action, payload?.args)
          break
        case 'COMPELEM_DEVTOOLS_RESET_STORE':
          result = resetStore(payload?.id)
          break
        case 'COMPELEM_DEVTOOLS_GET_STORE_MUTATIONS':
          result = STORE_MUTATIONS.map(serializeStoreMutation)
          break
        case 'COMPELEM_DEVTOOLS_APPLY_STORE_SNAPSHOT':
          result = applyStoreSnapshot(payload?.id, payload?.seq)
          break
        case 'COMPELEM_DEVTOOLS_CLEAR_STORE_MUTATIONS':
          STORE_MUTATIONS.length = 0
          result = true
          break
        // ---- 生态库：router ----
        case 'COMPELEM_DEVTOOLS_GET_ROUTER_INFO':
          result = getRouterInfo()
          break
        case 'COMPELEM_DEVTOOLS_MATCH_ROUTE':
          result = matchRoute(payload?.url)
          break
        case 'COMPELEM_DEVTOOLS_ROUTER_NAVIGATE':
          // 不 await：本轮响应通道会识别 thenable 并等它 resolve 后再回，
          // 这样 handleMessage 本身保持同步（其它分支不受影响）。
          result = routerNavigate(payload?.action, payload?.payload)
          break
        case 'COMPELEM_DEVTOOLS_GET_ROUTE_HISTORY':
          result = ROUTE_HISTORY.map(serializeRouteHistory)
          break
        // ---- 生态库：i18n ----
        case 'COMPELEM_DEVTOOLS_GET_I18N_INSTANCES':
          result = getI18nInstances()
          break
        case 'COMPELEM_DEVTOOLS_GET_I18N_MESSAGES':
          result = getI18nMessages(payload?.id, payload?.locale)
          break
        case 'COMPELEM_DEVTOOLS_SET_I18N_LOCALE':
          result = setI18nLocale(payload?.id, payload?.locale)
          break
        case 'COMPELEM_DEVTOOLS_RESOLVE_I18N_KEY':
          result = resolveI18nKey(payload?.id, payload?.key, payload?.params, payload?.locale)
          break
        case 'COMPELEM_DEVTOOLS_GET_LOCALE_TRACE':
          result = LOCALE_TRACE.map(serializeLocaleTrace)
          break
        // 右键菜单：解析右键目标 → 交回面板定位 / 页面内高亮
        case 'COMPELEM_DEVTOOLS_LOCATE_CONTEXT_TARGET': {
          const chain = describeComponentChain(currentContextNode())
          const target = chain[0]
          if (!target || target.cid < 0) {
            showToast('此处没有 compelem 组件', 'warn')
            result = { found: false }
          } else {
            sendToPanel('COMPELEM_DEVTOOLS_LOCATE_COMPONENT', {
              cid: target.cid,
              tagName: target.tagName,
              className: target.className,
              chain: chain
            })
            showToast('已定位 <' + target.tagName + '> #' + target.cid, 'info')
            result = { found: true, cid: target.cid }
          }
          break
        }
        case 'COMPELEM_DEVTOOLS_HIGHLIGHT_CONTEXT_TARGET': {
          const target = describeComponentChain(currentContextNode())[0]
          if (!target || target.cid < 0) {
            showToast('此处没有 compelem 组件', 'warn')
            result = { found: false }
          } else {
            highlightComponent(target.cid)
            showToast('已高亮 <' + target.tagName + '> #' + target.cid, 'info')
            result = { found: true, cid: target.cid }
          }
          break
        }
        case 'COMPELEM_DEVTOOLS_SHOW_TOAST':
          showToast(payload?.text || '', payload?.kind)
          result = true
          break
        default:
          return
      }

      // 返回响应
      const responseType = type.includes('_RESPONSE') || type.includes('_ERROR')
        ? type
        : type + '_RESPONSE'
      if (id !== undefined) {
        // 通过 BroadcastChannel 或 window.postMessage 回复
        try {
          window.postMessage({ type: responseType, payload: result, id }, '*')
        } catch { /* noop */ }
      }
    } catch (e: any) {
      console.error('[Compelem DevTools] Error handling', type, ':', e)
      try {
        window.postMessage({ type: type + '_ERROR', payload: { message: e?.message || String(e) }, id }, '*')
      } catch { /* noop */ }
    }
  }

  // ---------------- 通信设置 ----------------
  // 通过 window.postMessage 接收 content script 的请求
  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const msg = event.data
    if (!msg || !msg.type) return
    if (typeof msg.type !== 'string') return
    if (!msg.type.startsWith('COMPELEM_DEVTOOLS_')) return
    // 忽略来自自己的推送消息
    if (msg.type.includes('_PUSH_')) return
    handleMessage(msg)
  })

  // ---------------- MutationObserver ----------------
  function observeDOM() {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of Array.from(m.addedNodes)) {
          if (!(node instanceof Element)) continue
          if (isCompElem(node)) {
            autoHook()
            if (subscribedTypes.has('tree')) {
              const now = Date.now()
              if (now - lastTreeTimestamp > 1000) { // 节流
                lastTreeTimestamp = now
                sendToPanel('COMPELEM_DEVTOOLS_PUSH_COMPONENT_TREE', null)
              }
            }
            return
          }
          if (node.querySelectorAll) {
            const matches = node.querySelectorAll('[cid]')
            if (matches.length > 0) { autoHook(); return }
          }
        }
      }
    })
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true })
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, { childList: true, subtree: true })
        autoHook()
      })
    }
  }

  // ---------------- 暴露公共 API ----------------
  const bridge = {
    version: VERSION,
    hooked: () => isHooked,
    hook: autoHook,
    getTree: getComponentTree,
    getState: getStateSnapshot,
    setState: setStateValue,
    forceUpdate,
    getDeps: getDependencies,
    getUpdatePoints,
    triggerEmit,
    getEvents: (limit: number) => EVENT_LOG.slice(-limit),
    getStateChanges: (limit: number) => STATE_CHANGE_LOG.slice(-limit),
    getUpdates: (limit: number) => UPDATE_LOG.slice(-limit),
    getTimeline: (limit: number) => TIMELINE.slice(-limit),
    // Computed 缓存统计：面板 Performance 页签和变更溯源要用
    getComputedStats: () => {
      const out: any[] = []
      COMPUTED_STATS.forEach((v, key) => {
        out.push({
          key,
          computedKey: v.key,
          ctorName: v.ctorName,
          hits: v.hits,
          recomputes: v.recomputes,
          lastDuration: v.lastDuration,
          hitRate: v.hits + v.recomputes > 0 ? v.hits / (v.hits + v.recomputes) : 0
        })
      })
      return out
    },
    // UpdatePoint 热区统计：面板 Performance 页签
    getUpdatePointStats: () => {
      const out: any[] = []
      updatePointStats.forEach((v, key) => {
        out.push({ key, count: v.count, lastTime: v.lastTime })
      })
      return out.sort((a, b) => b.count - a.count)
    },
    // 变更溯源：给定一个 state key 路径，反查哪些 computed / 组件依赖它
    traceDependency: (statePath: string) => {
      const eco = (globalThis as any).__COMPELEM_ECOSYSTEM__
      const result: any = { computedGets: [], viewDeps: [], cssDeps: [], watchers: [] }
      if (!eco || !eco.core) return result
      // 反查所有已 hook ctor 的 computed → 框架 ComputedUpdateDepsMap 里是正向（依赖路径 → getter 集合）
      // 我们需要遍历所有 ctor，逐个 computedDeps 看是否包含 statePath
      hookedCtors.forEach(ctor => {
        try {
          const compKeys = eco.core.computedKeys(ctor) || []
          const compDeps = eco.core.computedDeps(ctor) || {}
          compKeys.forEach((k: string) => {
            const deps = compDeps[k] || []
            if (deps.some((d: string) => d === statePath || d.startsWith(statePath + '.') || statePath.startsWith(d + '.'))) {
              result.computedGets.push({ ctorName: ctor.name, computedKey: k, deps })
            }
          })
          const viewDeps = eco.core.viewDeps(ctor) || []
          if (viewDeps.some((d: string) => d === statePath || d.startsWith(statePath + '.') || statePath.startsWith(d + '.'))) {
            result.viewDeps.push({ ctorName: ctor.name })
          }
          const cssDeps = eco.core.cssDeps(ctor) || []
          if (cssDeps.some((d: string) => d === statePath || d.startsWith(statePath + '.') || statePath.startsWith(d + '.'))) {
            result.cssDeps.push({ ctorName: ctor.name })
          }
          const watchKeys = eco.core.watchKeys(ctor) || []
          if (watchKeys.some((d: string) => d === statePath || d.startsWith(statePath + '.') || statePath.startsWith(d + '.'))) {
            result.watchers.push({ ctorName: ctor.name, key: watchKeys.find((d: string) => d === statePath || d.startsWith(statePath + '.') || statePath.startsWith(d + '.')) })
          }
        } catch { /* skip */ }
      })
      return result
    },
    clear: () => {
      EVENT_LOG.length = STATE_CHANGE_LOG.length = UPDATE_LOG.length = TIMELINE.length = 0
      STORE_MUTATIONS.length = ROUTE_HISTORY.length = LOCALE_TRACE.length = 0
      COMPUTED_STATS.clear()
      updatePointStats.clear()
      updatePointDeps = new WeakMap()
      upValueSnapshot = new WeakMap()
    },
    highlight: highlightComponent,
    unhighlight: removeHighlight,
    scroll: scrollToComponent,
    subscribe: (types: string[]) => {
      types.forEach(t => subscribedTypes.add(t))
      if (types.includes('store')) subscribeStore()
    },
    unsubscribe: (types?: string[]) => {
      if (types) {
        types.forEach(t => subscribedTypes.delete(t))
        if (types.includes('store')) unsubscribeStore()
        if (types.includes('route')) unsubscribeRouter()
        if (types.includes('locale')) unsubscribeI18n()
      } else {
        subscribedTypes.clear()
        unsubscribeStore()
        unsubscribeRouter()
        unsubscribeI18n()
      }
    },
    findComponent,
    // 元素 → 组件：右键定位用的反向查找，控制台也可直接用
    findComponentByElement,
    describeComponentChain,
    toast: showToast,
    // 生态库：store / router / i18n
    ecosystem: ecosystemAvailability,
    getStores,
    getStoreState,
    setStoreState,
    callStoreAction,
    resetStore,
    getStoreMutations: () => STORE_MUTATIONS.map(serializeStoreMutation),
    clearStoreMutations: () => { STORE_MUTATIONS.length = 0; return true },
    applyStoreSnapshot,
    subscribeStore,
    unsubscribeStore,
    // router
    getRouterInfo,
    matchRoute,
    routerNavigate,
    getRouteHistory: () => ROUTE_HISTORY.map(serializeRouteHistory),
    subscribeRouter,
    unsubscribeRouter,
    // i18n
    getI18nInstances,
    getI18nMessages,
    setI18nLocale,
    resolveI18nKey,
    getLocaleTrace: () => LOCALE_TRACE.map(serializeLocaleTrace),
    subscribeI18n,
    unsubscribeI18n,
    destroyComponent,
    _EVENT_LOG: EVENT_LOG,
    _UPDATE_LOG: UPDATE_LOG,
    _TIMELINE: TIMELINE,
    _STORE_MUTATIONS: STORE_MUTATIONS,
    _ROUTE_HISTORY: ROUTE_HISTORY,
    _LOCALE_TRACE: LOCALE_TRACE,
    _componentCache: componentCache
  }

  try {
    Object.defineProperty(window, '__COMPELEM_DEVTOOLS__', {
      value: bridge,
      writable: false,
      configurable: false
    })
  } catch { /* noop */ }

  // bridge 可用 → 把页面标记从 pending 转为 ready（content script 也会据此点亮图标）
  try {
    document.documentElement?.setAttribute('data-compelem-devtools', 'ready:' + VERSION)
    window.postMessage({ type: 'COMPELEM_DEVTOOLS_BRIDGE_READY', payload: { version: VERSION } }, '*')
  } catch { /* noop */ }

  // ---------------- 启动 ----------------
  console.log('[Compelem DevTools] Injected v' + VERSION + ' ready')

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      observeDOM()
      setTimeout(autoHook, 100)
    })
  } else {
    observeDOM()
    setTimeout(autoHook, 100)
  }
})()
