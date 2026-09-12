// ============================================================================
// Compelem DevTools - Panel
// 所有 UI 逻辑和消息路由的大脑
// ============================================================================
(function () {
  'use strict'

  // ---------------- 状态 ----------------
  const state = {
    currentTab: 'tree' as string,
    selectedCid: null as number | null,
    componentTree: [] as any[],
    expandedCids: new Set<number>(),
    // 用户手动展开/折叠过的节点。默认展开只作用于没被手动定过的节点，
    // 否则每次自动刷新都会把用户刚折叠的子树重新展开
    userToggledCids: new Set<number>(),
    pendingRequests: new Map<number, { resolve: Function; reject: Function; timeout: number }>(),
    lastStateValues: new Map<string, any>(),    // "cid.key" -> old value
    autoRefresh: false,
    connected: false,
    filter: '',
    uiReady: false,
    pendingLocateCid: null as number | null,
    tlFilter: { update: true, event: true, lifecycle: true },
    stats: { updates: 0, events: 0, lifecycle: 0 }
  }

  // ---------------- 消息桥接 ----------------
  let port: chrome.runtime.Port | null = null
  let connectRetries = 0
  const MAX_CONNECT_RETRIES = 15

  // 直接 eval 到页面上下文（绕过 background 链路）
  // 这是 Vue DevTools 也用的 fallback 方案
  function evalInPage<T = any>(expr: string): Promise<T> {
    return new Promise((resolve, reject) => {
      try {
        chrome.devtools.inspectedWindow.eval(expr, (result, isException) => {
          if (isException) {
            reject(new Error(typeof isException === 'string' ? isException : JSON.stringify(isException)))
          } else {
            resolve(result as T)
          }
        })
      } catch (e: any) {
        reject(e)
      }
    })
  }

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'compelem-devtools-panel' })
      // 立即清空 lastError（360/老 Edge 可能同步设置）
      void chrome.runtime.lastError
      if (!port) { port = null; state.connected = false; return }

      const tabId = chrome.devtools?.inspectedWindow?.tabId
      if (tabId) port.postMessage({ type: 'COMPELEM_DEVTOOLS_INIT', payload: { tabId } })

      port.onMessage.addListener(onBackgroundMessage)
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError
        port = null
        state.connected = false
        // eval fallback 已覆盖所有功能，port 断线不致命
        setTimeout(connect, 3000)
      })
      state.connected = true
    } catch (e) {
      void chrome.runtime.lastError
      port = null
      state.connected = false
      // eval fallback 已覆盖所有功能，静默失败即可
      setTimeout(connect, 5000)
    }
  }

  // 双通道：eval 为主（同步直接调 bridge），port 为辅（推送）
  async function sendToPage(type: string, payload?: any): Promise<any> {
    // 主通道：eval 直接调页面 bridge（0 延迟，最可靠）
    return sendViaEval(type, payload)
  }

  // 预留：port 通道用于需要 background 中转的场景
  function sendViaPort(type: string, payload?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!port) { reject(new Error('No port')); return }
      const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8)
      const timeout = setTimeout(() => {
        state.pendingRequests.delete(id as any)
        reject(new Error('Port timeout for ' + type))
      }, 3000)
      state.pendingRequests.set(id as any, { resolve, reject, timeout })
      try {
        port.postMessage({ type, payload, id })
      } catch (e) {
        clearTimeout(timeout)
        state.pendingRequests.delete(id as any)
        reject(e)
      }
    })
  }

  async function sendViaEval(type: string, payload?: any): Promise<any> {
    // 直接调 window.__COMPELEM_DEVTOOLS__ bridge 的方法
    const expr = `
      (function() {
        var b = window.__COMPELEM_DEVTOOLS__;
        if (!b) return { __noBridge: true };
        var p = ${JSON.stringify(payload || null)};
        switch(${JSON.stringify(type)}) {
          case 'COMPELEM_DEVTOOLS_PING':
            return { pong: true, version: b.version, hooked: b.hooked(),
              hasCore: !!(window.__COMPELEM_ECOSYSTEM__ && window.__COMPELEM_ECOSYSTEM__.core) };
          case 'COMPELEM_DEVTOOLS_GET_TREE':
            return b.getTree();
          case 'COMPELEM_DEVTOOLS_GET_STATE':
            return b.getState(p?.cid);
          case 'COMPELEM_DEVTOOLS_SET_STATE':
            return b.setState(p?.cid, p?.key, p?.value);
          case 'COMPELEM_DEVTOOLS_FORCE_UPDATE':
            return b.forceUpdate(p?.cid);
          case 'COMPELEM_DEVTOOLS_HIGHLIGHT':
            return b.highlight(p?.cid);
          case 'COMPELEM_DEVTOOLS_UNHIGHLIGHT':
            return b.unhighlight();
          case 'COMPELEM_DEVTOOLS_GET_DEPS':
            return b.getDeps?.(p?.cid);
          case 'COMPELEM_DEVTOOLS_GET_UPDATES':
            return b.getUpdatePoints?.(p?.cid);
          case 'COMPELEM_DEVTOOLS_GET_EVENTS':
            return b.getEvents?.();
          case 'COMPELEM_DEVTOOLS_GET_TIMELINE':
            return b.getTimeline?.();
          case 'COMPELEM_DEVTOOLS_GET_STATS':
            return { events: b.getEvents?.().length || 0, updates: b.getUpdates?.().length || 0 };
          case 'COMPELEM_DEVTOOLS_SUBSCRIBE':
            return b.subscribe?.(p?.types) || true;
          case 'COMPELEM_DEVTOOLS_UNSUBSCRIBE':
            return b.unsubscribe?.(p?.types) || true;
          case 'COMPELEM_DEVTOOLS_TRIGGER_EMIT':
            return b.triggerEmit?.(p?.cid, p?.eventName, p?.args);
          case 'COMPELEM_DEVTOOLS_DESTROY_COMPONENT':
            return b.destroyComponent?.(p?.cid);
          case 'COMPELEM_DEVTOOLS_SCROLL':
            return b.scroll?.(p?.cid) || true;
          case 'COMPELEM_DEVTOOLS_GET_ECOSYSTEM':
            return b.ecosystem?.() || { available: false };
          case 'COMPELEM_DEVTOOLS_GET_STORES':
            return b.getStores?.() || [];
          case 'COMPELEM_DEVTOOLS_GET_STORE_STATE':
            return b.getStoreState?.(p?.id);
          case 'COMPELEM_DEVTOOLS_SET_STORE_STATE':
            return b.setStoreState?.(p?.id, p?.key, p?.value);
          case 'COMPELEM_DEVTOOLS_CALL_STORE_ACTION':
            return b.callStoreAction?.(p?.id, p?.action, p?.args);
          case 'COMPELEM_DEVTOOLS_RESET_STORE':
            return b.resetStore?.(p?.id);
          case 'COMPELEM_DEVTOOLS_GET_STORE_MUTATIONS':
            return b.getStoreMutations?.() || [];
          case 'COMPELEM_DEVTOOLS_APPLY_STORE_SNAPSHOT':
            return b.applyStoreSnapshot?.(p?.id, p?.seq);
          case 'COMPELEM_DEVTOOLS_CLEAR_STORE_MUTATIONS':
            return b.clearStoreMutations?.() || true;
          case 'COMPELEM_DEVTOOLS_GET_ROUTER_INFO':
            return b.getRouterInfo?.();
          case 'COMPELEM_DEVTOOLS_MATCH_ROUTE':
            return b.matchRoute?.(p?.url);
          case 'COMPELEM_DEVTOOLS_ROUTER_NAVIGATE':
            return b.routerNavigate?.(p?.action, p?.payload);
          case 'COMPELEM_DEVTOOLS_GET_ROUTE_HISTORY':
            return b.getRouteHistory?.() || [];
          case 'COMPELEM_DEVTOOLS_GET_I18N_INSTANCES':
            return b.getI18nInstances?.() || [];
          case 'COMPELEM_DEVTOOLS_GET_I18N_MESSAGES':
            return b.getI18nMessages?.(p?.id, p?.locale);
          case 'COMPELEM_DEVTOOLS_SET_I18N_LOCALE':
            return b.setI18nLocale?.(p?.id, p?.locale);
          case 'COMPELEM_DEVTOOLS_RESOLVE_I18N_KEY':
            return b.resolveI18nKey?.(p?.id, p?.key, p?.params, p?.locale);
          case 'COMPELEM_DEVTOOLS_GET_LOCALE_TRACE':
            return b.getLocaleTrace?.() || [];
          case 'COMPELEM_DEVTOOLS_GET_STATE_CHANGES':
            return b.getStateChanges?.(p?.limit || 100);
          case 'COMPELEM_DEVTOOLS_GET_COMPUTED_STATS':
            return b.getComputedStats?.() || [];
          case 'COMPELEM_DEVTOOLS_GET_UPDATEPOINT_STATS':
            return b.getUpdatePointStats?.() || [];
          case 'COMPELEM_DEVTOOLS_TRACE_DEPENDENCY':
            return b.traceDependency?.(p?.statePath) || {};
          default:
            return { __unknownType: ${JSON.stringify(type)} };
        }
      })()
    `
    const result = await evalInPage(expr)
    if (result && result.__noBridge) {
      throw new Error('Bridge not found on page')
    }
    return result
  }

  // 来自 background 的消息（转发自 injected）
  function onBackgroundMessage(msg: any) {
    if (!msg || !msg.type) return

    // 页面右键「在组件树中定位」
    if (msg.type === 'COMPELEM_DEVTOOLS_LOCATE_COMPONENT') {
      const cid = msg.payload?.cid
      if (typeof cid === 'number' && cid >= 0) locateComponent(cid)
      return
    }

    // 处理推送消息（来自 injected 主动推送）
    if (msg.type.includes('_PUSH_')) {
      handlePushMessage(msg)
      return
    }

    // 处理响应消息
    if (msg.id !== undefined && state.pendingRequests.has(msg.id)) {
      const pending = state.pendingRequests.get(msg.id)!
      state.pendingRequests.delete(msg.id)
      clearTimeout(pending.timeout)
      if (msg.type.includes('_ERROR')) {
        pending.reject(new Error(msg.payload?.message || 'Unknown error'))
      } else {
        pending.resolve(msg.payload)
      }
    }
  }

  function handlePushMessage(msg: any) {
    const type = msg.type

    if (type === 'COMPELEM_DEVTOOLS_PUSH_UPDATE') {
      state.stats.updates++
      updateBadge('timeline', state.stats.updates)
      if (state.currentTab === 'timeline') refreshTimeline()
      if (state.currentTab === 'perf') refreshPerf()
      if (state.currentTab === 'tree' && state.selectedCid === msg.payload?.cid) refreshStateInspector()
    } else if (type === 'COMPELEM_DEVTOOLS_PUSH_EVENT') {
      state.stats.events++
      updateBadge('events', state.stats.events)
      if (state.currentTab === 'events') refreshEvents()
      if (state.currentTab === 'timeline') refreshTimeline()
    } else if (type === 'COMPELEM_DEVTOOLS_PUSH_STATE_CHANGE') {
      const key = `${msg.payload?.cid}.${msg.payload?.chain}`
      state.lastStateValues.set(key, msg.payload?.newValue)
      // 标记该 entry 高亮变化
      flashStateChange(key)
    } else if (type === 'COMPELEM_DEVTOOLS_PUSH_COMPONENT_TREE') {
      refreshComponentTree()
    } else if (type === 'COMPELEM_DEVTOOLS_PUSH_STORE_MUTATION') {
      onStoreMutationPush(msg.payload)
    } else if (type === 'COMPELEM_DEVTOOLS_PUSH_ROUTE_CHANGE') {
      onRouteChangePush(msg.payload)
    } else if (type === 'COMPELEM_DEVTOOLS_PUSH_ROUTE_ERROR') {
      onRouteErrorPush(msg.payload)
    } else if (type === 'COMPELEM_DEVTOOLS_PUSH_LOCALE_CHANGE') {
      onLocaleChangePush(msg.payload)
    }
  }

  /** store 变更推送：只追加到当前查看的那个 store，避免多 store 串扰 */
  function onStoreMutationPush(m: any) {
    if (!m) return
    if (m.storeId === ecoSelectedStore && state.currentTab === 'eco') {
      if (!ecoMutations.some((x: any) => x.seq === m.seq)) ecoMutations.push(m)
      renderStoreMutations()
    }
    if (state.currentTab === 'timeline') refreshTimeline()
  }

  /**
   * 路由变更推送：这是导航落地的权威信号（导航指令本身只回执"已下发"）。
   * 顺手把导航控制台的结果文案改成最终地址。
   */
  function onRouteChangePush(rec: any) {
    if (rec) {
      if (ecoRouter && Array.isArray(ecoRouter.history)) {
        if (!ecoRouter.history.some((x: any) => x.seq === rec.seq)) ecoRouter.history.push(rec)
      }
      if (state.currentTab === 'eco' && ecoSeg === 'router') {
        // 落地信号到达 → 作废所有在途回执，避免旧回执覆盖最终地址
        ecoNavSeq++
        setNavResult('ok', '导航完成 → ' + (rec.url || rec.to || ''))
      }
    }
    if (state.currentTab === 'eco' && ecoSeg === 'router') refreshEcoRouter()
    if (state.currentTab === 'timeline') refreshTimeline()
  }

  function onRouteErrorPush(p: any) {
    if (!p) return
    ecoNavSeq++
    setNavResult('err', (p.action || 'navigate') + ' ✗ ' + (p.error || ''))
  }

  /** 语言切换推送：刷新实例摘要与语言包预览，并追加历史 */
  function onLocaleChangePush(rec: any) {
    if (rec) {
      if (!ecoI18nTrace.some((x: any) => x.seq === rec.seq)) ecoI18nTrace.push(rec)
      const box = document.getElementById('eco-locale-history-body')
      if (box) box.innerHTML = renderLocaleHistory()
      const cnt = document.getElementById('eco-locale-history-count')
      if (cnt) cnt.textContent = String(ecoI18nTrace.length)
      if (ecoI18nInfo && rec.id === ecoI18nSelected) ecoI18nInfo.locale = rec.locale
    }
    if (state.currentTab === 'eco' && ecoSeg === 'i18n') refreshEcoI18n()
    if (state.currentTab === 'timeline') refreshTimeline()
  }

  function updateBadge(tab: string, count: number) {
    const el = document.getElementById('badge-' + tab)
    if (el) {
      if (count > 0) {
        el.textContent = count > 99 ? '99+' : count
        el.classList.add('show')
      } else {
        el.classList.remove('show')
      }
    }
  }

  function flashStateChange(key: string) {
    // 可以给 state entry 加个变化指示器
    const entries = document.querySelectorAll('.state-entry[data-key-path]')
    entries.forEach(entry => {
      if ((entry as HTMLElement).dataset.keyPath === key) {
        const indicator = document.createElement('span')
        indicator.className = 'change-indicator'
        const valueEl = entry.querySelector('.state-value')
        if (valueEl && !valueEl.querySelector('.change-indicator')) {
          valueEl.appendChild(indicator)
          setTimeout(() => indicator.remove(), 1600)
        }
      }
    })
  }

  // ---------------- Tab 切换 ----------------
  document.querySelectorAll('.nav-item[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLElement
      const seg = el.dataset.seg
      // Store / Router / I18n 三个页签共用 #tab-eco 面板，靠 data-seg 区分分段
      if (el.dataset.tab === 'eco' && seg) switchEcoTab(seg)
      else switchTab(el.dataset.tab || 'tree')
    })
  })

  // 只切 UI，不触发数据刷新（供定位等需要自行控制刷新时序的场景复用）
  // seg 仅在 tab === 'eco' 时有意义：三个生态页签共用面板，靠它决定高亮哪一个
  function setActiveTab(tab: string, seg?: string) {
    state.currentTab = tab
    const wantSeg = seg || ecoSeg
    document.querySelectorAll('.nav-item').forEach(b => {
      const el = b as HTMLElement
      const sameTab = el.dataset.tab === tab
      const sameSeg = !el.dataset.seg || el.dataset.seg === wantSeg
      el.classList.toggle('active', sameTab && sameSeg)
    })
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab))
    // 生态库的推送需要在页面侧真正挂钩子，离开生态 tab 立即全部摘掉
    if (tab !== 'eco') {
      subscribeEcoStore(false)
      subscribeEcoRouter(false)
      subscribeEcoI18n(false)
    }
  }

  function switchTab(tab: string) {
    if (tab === 'help') {
      alert('Compelem DevTools\n\n使用提示：\n• 点击左侧组件可查看状态\n• 双击状态值可编辑\n• 鼠标悬停可高亮组件\n• 页面右键可定位到组件树\n• 底部显示组件运行错误，可定位到组件\n• Store / Router / I18n 页签查看对应生态库\n• 支持实时更新推送')
      return
    }
    // 生态三页签共用 #tab-eco：统一走 switchEcoTab，保证分段状态与导航高亮一致
    if (tab === 'eco') { switchEcoTab(ecoSeg); return }
    setActiveTab(tab)
    refreshCurrentTab()
  }

  function refreshCurrentTab() {
    switch (state.currentTab) {
      case 'tree': refreshComponentTree(); if (state.selectedCid) refreshStateInspector(); break
      case 'timeline': refreshTimeline(); break
      case 'events': refreshEvents(); break
      case 'perf': refreshPerf(); break
      case 'deps': refreshDepsList(); break
      case 'eco': refreshEco(); break
    }
  }

  // ---------------- 组件树 ----------------
  function refreshComponentTree(after?: () => void) {
    sendToPage('COMPELEM_DEVTOOLS_GET_TREE').then(tree => {
      state.componentTree = tree || []
      // 默认展开所有有子节点的组件；用户手动折叠/展开过的节点保持原状
      state.componentTree.forEach((c: any) => {
        if (state.userToggledCids.has(c.cid)) return
        if (c.childCids && c.childCids.length > 0) state.expandedCids.add(c.cid)
      })
      document.getElementById('component-count')!.textContent = state.componentTree.length + ' components'
      renderTree()
      if (after) after()
    }).catch(() => {
      showNoLibraryHint()
      // 失败也要通知调用方（定位场景需要据此重试）
      if (after) after()
    })
  }

  function renderTree() {
    const container = document.getElementById('tree-view')!
    let tree = state.componentTree

    // 搜索过滤
    if (state.filter) {
      const f = state.filter.toLowerCase()
      tree = tree.filter(c =>
        c.tagName.toLowerCase().includes(f) ||
        c.className.toLowerCase().includes(f) ||
        String(c.cid).includes(f)
      )
    }

    if (tree.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">🌲</div><div>${state.filter ? '没有匹配的组件' : '没有检测到组件'}</div></div>`
      return
    }

    // 找根组件：parentCid 为 undefined/null，或 parent 在树里不存在
    const allCids = new Set(tree.map((c: any) => c.cid))
    const roots = tree.filter((c: any) =>
      c.parentCid === undefined || c.parentCid === null || !allCids.has(c.parentCid)
    )

    container.innerHTML = roots.map(c => renderTreeNode(c, tree)).join('')
    document.getElementById('tree-info')!.textContent = `${tree.length} 个组件 · ${roots.length} 棵根`

    // 绑定交互
    container.querySelectorAll('.tree-node-content').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        const cid = parseInt((el as HTMLElement).dataset.cid!)
        // 再次点击已选中的组件 = 取消选中
        if (cid === state.selectedCid) deselectComponent()
        else selectComponent(cid)
      })
      el.addEventListener('mouseenter', () => {
        const cid = parseInt((el as HTMLElement).dataset.cid!)
        sendToPage('COMPELEM_DEVTOOLS_HIGHLIGHT', { cid }).catch(() => { })
      })
      el.addEventListener('mouseleave', () => {
        if (state.selectedCid != null) {
          sendToPage('COMPELEM_DEVTOOLS_HIGHLIGHT', { cid: state.selectedCid }).catch(() => { })
        } else {
          sendToPage('COMPELEM_DEVTOOLS_UNHIGHLIGHT', {}).catch(() => { })
        }
      })
    })

    container.querySelectorAll('.tree-toggle').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        const node = (el as HTMLElement).closest('.tree-node')!
        const children = node.querySelector('.tree-children') as HTMLElement
        const cid = parseInt((node.querySelector('.tree-node-content') as HTMLElement).dataset.cid!)
        const expanded = el.classList.toggle('expanded')
        children.style.display = expanded ? '' : 'none'
        state.userToggledCids.add(cid)
        if (expanded) state.expandedCids.add(cid)
        else state.expandedCids.delete(cid)
      })
    })
  }

  function renderTreeNode(comp: any, all: any[]): string {
    const children = all.filter(c => c.parentCid === comp.cid)
    const hasChildren = children.length > 0
    const selected = comp.cid === state.selectedCid
    const expanded = state.expandedCids.has(comp.cid) || state.filter !== ''

    let html = `<div class="tree-node">`
    html += `<div class="tree-node-content ${selected ? 'selected' : ''}" data-cid="${comp.cid}">`
    html += `<span class="tree-toggle ${expanded ? 'expanded' : ''}">${hasChildren ? '▶' : ''}</span>`
    html += `<span class="tree-tag">&lt;${comp.tagName}&gt;</span>`
    html += `<span class="tree-class">${comp.className}</span>`
    html += `<span style="flex:1"></span>`
    html += `<span class="tree-cid">#${comp.cid}</span>`
    html += `</div>`
    if (hasChildren) {
      html += `<div class="tree-children" style="display:${expanded ? '' : 'none'}">`
      html += children.map(c => renderTreeNode(c, all)).join('')
      html += `</div>`
    }
    html += `</div>`
    return html
  }

  function selectComponent(cid: number) {
    state.selectedCid = cid
    renderTree()
    refreshStateInspector()
    sendToPage('COMPELEM_DEVTOOLS_HIGHLIGHT', { cid }).catch(() => { })
    sendToPage('COMPELEM_DEVTOOLS_SCROLL', { cid }).catch(() => { })
  }

  /** 取消选中：清除右栏、去掉树高亮、并让页面侧取消高亮描边 */
  function deselectComponent() {
    state.selectedCid = null
    renderTree()
    refreshStateInspector()
    sendToPage('COMPELEM_DEVTOOLS_UNHIGHLIGHT', {}).catch(() => { })
  }

  // ---------------- 页面右键定位 ----------------
  // 清掉搜索过滤 → 切到组件树 → 等树到齐后选中并滚到可见
  function locateComponent(cid: number, attempt = 0) {
    if (!state.uiReady) { state.pendingLocateCid = cid; return }

    state.filter = ''
    const searchEl = document.getElementById('search-filter') as HTMLInputElement | null
    if (searchEl) searchEl.value = ''
    state.selectedCid = cid
    setActiveTab('tree')

    refreshComponentTree(() => {
      // 组件可能刚挂载/刚销毁 → 短暂重试，避免定位到不存在的组件
      if (!state.componentTree.some((c: any) => c.cid === cid)) {
        if (attempt < 3) setTimeout(() => locateComponent(cid, attempt + 1), 400)
        else refreshStateInspector()  // 渲染「未选中组件」提示
        return
      }
      renderTree()            // 选中态依赖 selectedCid，树到齐后重渲染一次
      refreshStateInspector()
      scrollTreeItemIntoView(cid)
    })

    sendToPage('COMPELEM_DEVTOOLS_HIGHLIGHT', { cid }).catch(() => { })
    sendToPage('COMPELEM_DEVTOOLS_SCROLL', { cid }).catch(() => { })
  }

  function scrollTreeItemIntoView(cid: number) {
    requestAnimationFrame(() => {
      const el = document.querySelector(`#tree-view .tree-node-content[data-cid="${cid}"]`) as HTMLElement | null
      if (!el) return
      try { el.scrollIntoView({ block: 'nearest' }) } catch { el.scrollIntoView() }
      el.classList.add('located')
      setTimeout(() => el.classList.remove('located'), 1800)
    })
  }

  // ---------------- State Inspector ----------------
  function refreshStateInspector() {
    const container = document.getElementById('component-detail')!
    const comp = state.selectedCid == null
      ? undefined
      : state.componentTree.find(c => c.cid === state.selectedCid)
    if (!comp) {
      // 未选中（或选中的组件已销毁）→ 空态
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">👈</div><div>未选中组件</div></div>`
      return
    }

    // 渲染头部卡片
    let html = renderCompHeader(comp)

    // 渲染组件信息 section
    html += renderStateSection('component', 'Component Info', {
      tag: comp.tagName,
      class: comp.className,
      cid: comp.cid,
      parentCid: comp.parentCid ?? '-',
      mounted: comp.isMounted,
      destroyed: comp.isDestroyed,
      updatePoints: comp.updatePointCount,
      shadow: comp.hasShadow,
      reactive: comp.hasReactive
    })

    // 属性 section
    if (Object.keys(comp.attrs).length > 0) {
      html += renderStateSection('attrs', 'Attributes', comp.attrs)
    }

    // 异步获取完整 state
    sendToPage('COMPELEM_DEVTOOLS_GET_STATE', { cid: state.selectedCid }).then(snapshot => {
      if (!snapshot || !snapshot.data) return
      const data = snapshot.data

      // Props
      const props: Record<string, any> = {}
      const propDefs = getCachedPropDefs(comp)
      Object.keys(data).forEach(k => {
        if (propDefs[k]) props[k] = data[k]
      })
      if (Object.keys(props).length > 0) {
        html += renderStateSection('props', 'Props', props, true)
      }

      // State（非 prop 非 computed）
      const computedKeys = new Set(Object.keys(comp.computed || {}))
      const stateObj: Record<string, any> = {}
      Object.keys(data).forEach(k => {
        if (k === 'slots') return
        if (!propDefs[k] && !computedKeys.has(k)) stateObj[k] = data[k]
      })
      if (Object.keys(stateObj).length > 0) {
        html += renderStateSection('state', 'States', stateObj, true)
      }

      // Computed
      if (Object.keys(comp.computed || {}).length > 0) {
        html += renderStateSection('computed', 'Computed', comp.computed)
      }

      // Slots（slots + slotHooks）
      const slotsMap = comp.slots || {}
      if (Object.keys(slotsMap).length > 0) {
        Object.keys(slotsMap).forEach(sectionKey => {
          html += renderStateSection('slots', sectionKey === 'slots' ? 'Slots' : 'Slot Hooks', slotsMap[sectionKey])
        })
      }

      // Styles（cssVars + @csscope），各自独立成卡片
      const stylesMap = comp.styles || {}
      const STYLE_SECTION_TITLES: Record<string, string> = {
        cssVars: 'CSS Vars',
        cssScopes: 'Style Scopes'
      }
      if (Object.keys(stylesMap).length > 0) {
        Object.keys(stylesMap).forEach(sectionKey => {
          html += renderStateSection(sectionKey, STYLE_SECTION_TITLES[sectionKey] ?? sectionKey, stylesMap[sectionKey])
        })
      }

      // Emits
      if (comp.emitEvents && comp.emitEvents.length > 0) {
        const emits: Record<string, string> = {}
        comp.emitEvents.forEach(e => emits[e] = '(declared)')
        html += renderStateSection('events', 'Emits', emits)
      }

      container.innerHTML = html
      bindInspectorInteractions(container)
    }).catch(() => {
      container.innerHTML = html + `<div class="empty-state"><div class="empty-icon">⚠️</div><div>获取状态失败</div></div>`
    })
  }

  function renderCompHeader(comp: any): string {
    const initial = comp.tagName.replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase()
    return `
      <div class="comp-header-card">
        <div class="comp-icon">${initial || '?'}</div>
        <div class="comp-header-info">
          <div class="comp-header-tag">&lt;${comp.tagName}&gt;</div>
          <div class="comp-header-class">${comp.className}</div>
        </div>
        <div class="comp-header-stats">
          <span class="comp-stat-chip ok">${comp.isMounted ? '● mounted' : '○ unmounted'}</span>
          <span class="comp-stat-chip">${comp.updatePointCount} UPs</span>
        </div>
        <div class="comp-header-actions">
          <button class="comp-action-btn" id="action-force-update" title="强制触发组件重新渲染">↻ 刷新</button>
          <button class="comp-action-btn danger" id="action-destroy" title="销毁组件（生命周期/泄漏调试）">🗑 销毁</button>
          <button class="comp-action-btn" id="action-scroll" title="滚动到组件 DOM">◎ 定位</button>
        </div>
      </div>`
  }

  // 支持内联编辑的类型；array / object 结构化值不参与文本编辑，避免被写成字符串
  const EDITOR_TYPES = new Set(['boolean', 'number', 'string', 'null', 'undefined'])

  // 把真实值编码进 data-raw，供编辑器取种子值（避免从显示文本反推，字符串不再带引号）
  function encodeRaw(v: any): string {
    if (v === undefined) return ''
    try { return JSON.stringify(v) ?? '' } catch { return '' }
  }

  /**
   * 渲染一个属性卡片。
   * @param storeId 传了就渲染成「生态库 store」的值（data-store），否则是组件值（data-cid）；
   *                两条链路的编辑种子/提交目标不同，但共用同一套编辑器实现。
   */
  function renderStateSection(section: string, title: string, values: Record<string, any>, editable = false, storeId?: string): string {
    if (Object.keys(values).length === 0) return ''
    const ownerAttr = storeId
      ? `data-store="${escapeHtml(storeId)}"`
      : `data-cid="${state.selectedCid}"`
    const base = storeId ? `store:${storeId}` : `${state.selectedCid}`
    const rows = Object.entries(values)
      .map(([key, val]) => renderValueEntry(key, val, base + '.' + key, ownerAttr, editable, 0))
      .join('')
    let html = `<div class="state-section" data-section="${section}">`
    html += `<div class="state-section-header"><span class="state-section-label">${title}</span>`
    html += `<span class="state-section-count">${Object.keys(values).length}</span>`
    html += `<span class="state-section-arrow">▼</span></div>`
    html += `<div class="state-section-body">`
    html += rows
    html += `</div></div>`
    return html
  }

  // 对象/数组的递归展开深度上限：超过后降级为不可展开的叶子，避免深层对象拖垮渲染
  const NESTED_MAX_DEPTH = 6
  /**
   * 递归渲染一个属性条目。
   * - 叶子（基本类型 / function）→ 可编辑（若 editable）
   * - 对象 / 数组 → 生成可折叠的分支，展开后递归渲染子项；编辑时用完整路径定位
   */
  function renderValueEntry(key: string, val: any, path: string, ownerAttr: string, editable: boolean, depth: number): string {
    const displayVal = formatValue(val)
    const vType = getValueType(val)
    const isLeaf = !(vType === 'object' || vType === 'array') || depth >= NESTED_MAX_DEPTH
    const indent = depth > 0 ? ` style="padding-left:${Math.min(20, depth * 10)}px"` : ''

    if (isLeaf) {
      const canEdit = editable && EDITOR_TYPES.has(vType)
      const roTitle = editable && !canEdit ? ' title="该类型不支持内联编辑"' : ''
      return `<div class="state-entry" data-key-path="${escapeHtml(path)}"${indent}>
        <span class="state-key">${escapeHtml(String(key))}</span><span class="state-colon">:</span>
        <span class="state-value ${canEdit ? 'editable' : ''}" data-type="${vType}" ${ownerAttr} data-key="${escapeHtml(path)}" data-raw="${escapeHtml(encodeRaw(val))}"${roTitle}>${displayVal}</span>
      </div>`
    }

    // 分支：对象 / 数组，可折叠
    const isArray = vType === 'array'
    const children: [string, any][] = isArray
      ? (val as any[]).map((it, i) => [String(i), it] as [string, any])
      : Object.entries(val || {})
    const count = isArray ? val.length : children.length
    const childRows = depth + 1 <= NESTED_MAX_DEPTH
      ? children.map(([k, v]) => renderValueEntry(k, v, path + (isArray ? `[${k}]` : '.' + k), ownerAttr, editable, depth + 1)).join('')
      : ''
    return `<div class="state-entry branch" data-key-path="${escapeHtml(path)}"${indent}>
      <span class="branch-toggle">▸</span>
      <span class="state-key">${escapeHtml(String(key))}</span><span class="state-colon">:</span>
      <span class="state-value" data-type="${vType}" title="点击展开">${displayVal} <span class="branch-count">${count}</span></span>
      <div class="state-branch-children">${childRows}</div>
    </div>`
  }

  /**
   * 绑定检查器交互。
   * 必须限定在刚重建的容器内：document 级查询会给其它 tab 里已绑过的元素重复挂监听。
   */
  function bindInspectorInteractions(root?: HTMLElement) {
    const scope: ParentNode = root || document
    // section 折叠
    scope.querySelectorAll('.state-section-header').forEach(header => {
      header.addEventListener('click', () => {
        header.parentElement?.classList.toggle('collapsed')
      })
    })

    // 值编辑
    scope.querySelectorAll('.state-value.editable').forEach(el => {
      el.addEventListener('dblclick', () => startEdit(el))
    })

    // 对象/数组分支展开折叠
    scope.querySelectorAll('.state-entry.branch').forEach(el => {
      el.addEventListener('click', (e) => {
        // 点击内部可编辑值时交还 dblclick 编辑
        if ((e.target as HTMLElement).closest('.state-value.editable')) return
        el.classList.toggle('open')
      })
    })

    // 组件头部操作：强制刷新 / 销毁 / 定位
    scope.querySelector('#action-force-update')?.addEventListener('click', () => {
      if (state.selectedCid == null) return
      sendToPage('COMPELEM_DEVTOOLS_FORCE_UPDATE', { cid: state.selectedCid })
        .catch(() => { })
    })
    scope.querySelector('#action-destroy')?.addEventListener('click', () => {
      if (state.selectedCid == null) return
      const cid = state.selectedCid
      sendToPage('COMPELEM_DEVTOOLS_DESTROY_COMPONENT', { cid }).then((r: any) => {
        if (r && r.ok === false) alert('销毁失败：' + (r.reason || '未知原因'))
        else {
          // 销毁成功：标记该组件不再选中，刷新树与检查器
          state.selectedCid = null
          refreshComponentTree()
          refreshStateInspector()
        }
      }).catch(() => { })
    })
    scope.querySelector('#action-scroll')?.addEventListener('click', () => {
      if (state.selectedCid == null) return
      sendToPage('COMPELEM_DEVTOOLS_SCROLL', { cid: state.selectedCid })
        .catch(() => { })
    })
  }

  // 原始值 → 编辑器初始文本：字符串按原样（不带展示用的引号），boolean/number 用字面量
  function seedEditText(type: string, raw: string): string {
    switch (type) {
      case 'undefined': return 'undefined'
      case 'null': return 'null'
      case 'string': {
        if (raw === '') return ''
        try {
          const parsed = JSON.parse(raw)
          return typeof parsed === 'string' ? parsed : String(parsed)
        } catch { return raw }
      }
      default: return raw
    }
  }

  // 编辑结果 → 真实值，按字段自身类型解析（不再靠内容猜类型）；ok=false 表示非法输入
  function parseByType(type: string, text: string): { ok: boolean; value?: any } {
    switch (type) {
      case 'boolean':
        if (text === 'true') return { ok: true, value: true }
        if (text === 'false') return { ok: true, value: false }
        return { ok: false }
      case 'number': {
        const trimmed = text.trim()
        if (trimmed === '') return { ok: false }
        const num = Number(trimmed)
        return Number.isFinite(num) ? { ok: true, value: num } : { ok: false }
      }
      case 'string':
        return { ok: true, value: text }
      case 'null':
      case 'undefined':
        if (text === 'null') return { ok: true, value: null }
        if (text === 'undefined') return { ok: true, value: undefined }
        return { ok: false }
      default:
        return { ok: false }
    }
  }

  function startEdit(el: Element) {
    const htmlEl = el as HTMLElement
    if (htmlEl.dataset.editing === 'true') return
    const type = htmlEl.dataset.type || 'string'
    if (!EDITOR_TYPES.has(type)) return

    const cid = htmlEl.dataset.cid ? parseInt(htmlEl.dataset.cid) : -1
    const storeId = htmlEl.dataset.store || ''
    const key = htmlEl.dataset.key!
    const raw = htmlEl.dataset.raw ?? ''
    const seedText = seedEditText(type, raw)
    const originalHtml = htmlEl.innerHTML

    // boolean 给出受限选择，其余给出对应类型的输入框
    let editor: HTMLInputElement | HTMLSelectElement
    if (type === 'boolean') {
      const select = document.createElement('select')
      select.className = 'state-edit-select'
        ;['true', 'false'].forEach(v => {
          const opt = document.createElement('option')
          opt.value = v
          opt.textContent = v
          opt.selected = v === seedText
          select.appendChild(opt)
        })
      editor = select
    } else {
      const input = document.createElement('input')
      input.type = type === 'number' ? 'number' : 'text'
      if (type === 'number') input.step = 'any'
      input.className = 'state-edit-input'
      input.value = seedText
      editor = input
    }

    htmlEl.dataset.editing = 'true'
    htmlEl.textContent = ''
    htmlEl.appendChild(editor)
    editor.focus()
    if (editor instanceof HTMLInputElement) editor.select()

    let finished = false
    function finish(shouldSave: boolean) {
      if (finished) return
      finished = true
      htmlEl.dataset.editing = 'false'

      // 恢复原展示内容（保留 v-* 类型配色）
      const restore = () => { htmlEl.innerHTML = originalHtml }

      if (!shouldSave) { restore(); return }

      const parsed = parseByType(type, editor.value)
      // 非法输入、或值未变化（boolean 下拉失焦必然触发）→ 不提交
      if (!parsed.ok || editor.value === seedText) { restore(); return }

      restore() // 先占位，refreshStateInspector 会重建
      if (storeId) {
        // key 是完整路径（含 cid/store 前缀），去掉前缀得到相对路径（可能含 . / [n]）
        const relPath = (key || '').replace(/^store:.*?\./, '')
        sendToPage('COMPELEM_DEVTOOLS_SET_STORE_STATE', { id: storeId, key: relPath, value: parsed.value })
          .then(() => refreshStoreInspector())
          .catch(() => refreshStoreInspector())
        return
      }
      const relPath = (key || '').replace(/^\d+\./, '')
      sendToPage('COMPELEM_DEVTOOLS_SET_STATE', { cid, key: relPath, value: parsed.value })
        .then(() => refreshStateInspector())
        .catch(() => refreshStateInspector())
    }

    if (type === 'boolean') editor.addEventListener('change', () => finish(true))
    editor.addEventListener('blur', () => finish(true))
    editor.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent
      if (ke.key === 'Enter') { ke.preventDefault(); finish(true) }
      if (ke.key === 'Escape') { ke.preventDefault(); finish(false) }
    })
  }

  function getCachedPropDefs(comp: any): Record<string, boolean> {
    // 从 componentTree 的 props 推断
    const defs: Record<string, boolean> = {}
    Object.keys(comp.props || {}).forEach(k => defs[k] = true)
    return defs
  }

  // ---------------- Timeline ----------------
  let timelineFilters = { update: true, event: true, lifecycle: true, state: true, store: true, route: true, locale: true }

  /** 瀑布图：把全部事件按时间轴铺开，每 50px 宽度一个时间桶，桶里事件越密颜色越深 */
  function buildWaterfall(items: any[]): string {
    if (items.length === 0) return '<div class="waterfall-empty">无事件</div>'
    const W = 800, BUCKET_PX = 4
    // 取最近一段（默认 10s），但根据事件自适应
    const sorted = items.slice().sort((a, b) => a.timestamp - b.timestamp)
    const first = sorted[0].timestamp
    const last = sorted[sorted.length - 1].timestamp
    const span = Math.max(1000, last - first)
    const bucketCount = Math.max(40, Math.min(200, Math.floor(W / BUCKET_PX)))
    const bucketMs = span / bucketCount

    // 按 type 分色 + 按桶聚合密度
    const typeColors: Record<string, string> = {
      update: '#E8590C',    // 橙 —— 组件 updated
      state: '#4C6EF5',     // 蓝 —— state 变更（新增）
      event: '#F59F00',     // 黄 —— emit 事件
      lifecycle: '#12B886', // 绿 —— connected/destroyed
      store: '#9C36B5',     // 紫
      route: '#0CA678',     // 青
      locale: '#E64980'     // 粉
    }

    // 每桶有哪些 type + 密度
    const buckets: { type: string; count: number; t: number }[][] = []
    for (let i = 0; i < bucketCount; i++) buckets.push([])
    sorted.forEach(it => {
      const idx = Math.min(bucketCount - 1, Math.floor((it.timestamp - first) / bucketMs))
      const slot = buckets[idx].find(b => b.type === it.type)
      if (slot) slot.count++
      else buckets[idx].push({ type: it.type, count: 1, t: it.timestamp })
    })

    const maxCount = Math.max(1, ...buckets.flatMap(b => b.map(s => s.count)))

    const cells = buckets.map(bucket => {
      if (bucket.length === 0) return `<div class="wf-cell wf-empty"></div>`
      return bucket.map(slot => {
        const intensity = slot.count / maxCount
        const hex = typeColors[slot.type] || '#868e96'
        // 透明度编码密度
        const alpha = 0.25 + intensity * 0.75
        const title = `${slot.type} × ${slot.count}`
        return `<div class="wf-cell wf-${slot.type}" style="background:${hex};opacity:${alpha}" title="${title}"></div>`
      }).join('')
    }).join('')

    // 类型图例
    const legend = Object.entries(typeColors).map(([t, c]) =>
      `<span class="wf-legend"><span class="wf-legend-swatch" style="background:${c}"></span>${t}</span>`
    ).join('')

    return `<div class="waterfall-wrap">
      <div class="waterfall-axis">
        <span>${new Date(first).toLocaleTimeString()}</span>
        <span>${Math.round(span / 1000)}s</span>
        <span>${new Date(last).toLocaleTimeString()}</span>
      </div>
      <div class="waterfall-grid" style="width:${bucketCount * BUCKET_PX}px">${cells}</div>
      <div class="waterfall-legend">${legend}</div>
    </div>`
  }

  function refreshTimeline() {
    sendToPage('COMPELEM_DEVTOOLS_GET_TIMELINE', { limit: 500 }).then(items => {
      const filtered = (items || []).filter((i: any) => timelineFilters[i.type as keyof typeof timelineFilters])

      // 瀑布图
      const chart = document.getElementById('timeline-chart')!
      chart.innerHTML = buildWaterfall(filtered)

      // 列表（按时间倒序，保留点击跳转逻辑）
      const list = document.getElementById('timeline-list')!
      if (filtered.length === 0) {
        list.innerHTML = `<div class="empty-state"><div>暂无事件</div></div>`
      } else {
        // 分页：先展示最近 80 条，用户拉到底再加
        const SHOW_N = 80
        const show = filtered.slice().reverse().slice(0, SHOW_N)
        list.innerHTML = show.map((i: any) => {
          const time = new Date(i.timestamp).toLocaleTimeString()
          let ecoAttr = ''
          if (i.type === 'store') {
            ecoAttr = ` data-eco-seg="store" data-eco-store-id="${escapeHtml(String(i.tagName || '').replace(/^store:/, ''))}"`
          } else if (i.type === 'route') {
            ecoAttr = ` data-eco-seg="router"`
          } else if (i.type === 'locale') {
            ecoAttr = ` data-eco-seg="i18n"`
          }
          const typeLabel = i.type === 'state' ? 'state↗' : (i.type === 'update' ? 'update' : i.type)
          return `<div class="tl-item" data-cid="${i.cid}"${ecoAttr}>
            <span class="tl-time">${time}</span>
            <span class="tl-comp">${escapeHtml(i.tagName)}</span>
            <span class="tl-type ${i.type}">${typeLabel}</span>
            <span class="tl-name">${escapeHtml(i.name)}</span>
            <span class="tl-duration">${i.duration ? i.duration.toFixed(1) + 'ms' : '—'}</span>
          </div>`
        }).join('')

        list.querySelectorAll('.tl-item').forEach(el => {
          el.addEventListener('click', () => {
            const cid = parseInt((el as HTMLElement).dataset.cid!)
            if (!Number.isFinite(cid) || cid < 0) {
              const seg = (el as HTMLElement).dataset.ecoSeg
              if (isEcoSeg(seg)) switchEcoTab(seg)
              else switchTab('eco')
              const storeId = (el as HTMLElement).dataset.ecoStoreId
              if (storeId) selectStore(storeId)
              return
            }
            switchTab('tree')
            if (!state.componentTree.some((c: any) => c.cid === cid)) {
              refreshComponentTree(() => selectComponent(cid))
            } else {
              selectComponent(cid)
            }
          })
        })
      }
    }).catch(() => { })
  }

  // timeline 过滤
  document.querySelectorAll('.timeline-filters input').forEach(cb => {
    cb.addEventListener('change', () => {
      const f = (cb as HTMLInputElement).dataset.filter as keyof typeof timelineFilters
      timelineFilters[f] = (cb as HTMLInputElement).checked
      refreshTimeline()
    })
  })

  // ---------------- Events ----------------
  function refreshEvents() {
    Promise.all([
      sendToPage('COMPELEM_DEVTOOLS_GET_EVENTS', { limit: 50 }),
      sendToPage('COMPELEM_DEVTOOLS_GET_STATE_CHANGES', { limit: 50 })
    ]).then(([emitEvents, stateChanges]) => {
      const all: any[] = []
      ;(emitEvents || []).forEach((e: any) => {
        all.push({
          cid: e.cid, tagName: e.tagName, timestamp: e.timestamp,
          kind: 'emit', name: e.eventName, args: e.args
        })
      })
      ;(stateChanges || []).forEach((s: any) => {
        all.push({
          cid: s.cid, tagName: s.tagName, timestamp: s.timestamp,
          kind: 'state', name: s.key, args: { from: s.oldValue, to: s.newValue }
        })
      })
      all.sort((a, b) => b.timestamp - a.timestamp)

      const container = document.getElementById('event-log')!
      const header = document.querySelector('.events-summary')! as HTMLElement
      if (all.length === 0) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚡</div><div>暂无事件（试试页面交互）</div></div>`
        header.textContent = ''
        return
      }

      // 统计
      const emits = all.filter(e => e.kind === 'emit').length
      const states = all.length - emits
      const byComp: Record<string, number> = {}
      all.forEach(e => { byComp[e.tagName] = (byComp[e.tagName] || 0) + 1 })
      const top = Object.entries(byComp).sort((a, b) => b[1] - a[1])[0]
      header.textContent = `${all.length} 条（emit ${emits} · state ${states}）· 高频 <${top?.[0] || '—'}>`

      container.innerHTML = all.map((e: any) => {
        const time = new Date(e.timestamp).toLocaleTimeString()
        const typeClass = e.kind === 'emit' ? 'emit' : 'state'
        const typeLabel = e.kind === 'emit' ? 'emit' : 'state↗'
        let argsDisplay = ''
        let argsFull = ''
        let hasExpand = false
        if (e.kind === 'emit') {
          argsDisplay = formatValue(e.args)
          argsFull = formatJsonFull(e.args)
          hasExpand = e.args !== null && typeof e.args === 'object'
        } else {
          const a = e.args || {}
          argsDisplay = `<span class="ev-old">${formatValue(a.from)}</span> → <span class="ev-new">${formatValue(a.to)}</span>`
          argsFull = `{\n  from: ${formatJsonFull(a.from)},\n  to:   ${formatJsonFull(a.to)}\n}`
          hasExpand = (a.from !== null && typeof a.from === 'object') || (a.to !== null && typeof a.to === 'object')
        }
        const toggleBtn = hasExpand ? `<span class="ev-expand" title="查看完整参数">▸</span>` : ''
        // 组件列：tagName 空时不渲染可点击链接（避免点了白跑）
        const hasCid = Number.isFinite(e.cid) && e.cid >= 0
        const compHtml = e.tagName
          ? `<span class="ev-col-comp ${hasCid ? 'clickable' : ''}" ${hasCid ? '' : ''} data-cid="${e.cid}">&lt;${escapeHtml(e.tagName)}&gt;</span>`
          : `<span class="ev-col-comp empty">—</span>`
        return `<div class="event-row" data-cid="${e.cid}" data-kind="${e.kind}">
          <span class="ev-col-time">${time}</span>
          ${compHtml}
          <span class="ev-col-type ${typeClass}">${typeLabel}</span>
          <span class="ev-col-name">${escapeHtml(e.name)}</span>
          <span class="ev-col-args" title="${escapeHtml(argsFull)}">${argsDisplay}${toggleBtn}</span>
        </div>`
      }).join('')

      container.querySelectorAll('.event-row').forEach(rowEl => {
        const row = rowEl as HTMLElement

        // 组件列点击 → 跳组件树
        const compCol = row.querySelector('.ev-col-comp.clickable') as HTMLElement | null
        if (compCol) {
          compCol.addEventListener('click', (ev) => {
            ev.stopPropagation()
            const cid = parseInt(compCol.dataset.cid!)
            switchTab('tree')
            if (!state.componentTree.some((c: any) => c.cid === cid)) {
              refreshComponentTree(() => selectComponent(cid))
            } else {
              selectComponent(cid)
            }
          })
        }

        // ▸ 展开/折叠完整 JSON（仍然只由按钮触发，不会冒泡到整行）
        const toggle = row.querySelector('.ev-expand')
        if (toggle) {
          toggle.addEventListener('click', (ev) => {
            ev.stopPropagation()
            const expanded = row.classList.toggle('expanded')
            ;(toggle as HTMLElement).textContent = expanded ? '▾' : '▸'
            const argsCol = row.querySelector('.ev-col-args') as HTMLElement
            if (expanded) {
              const full = argsCol.title
              row.insertAdjacentHTML('afterend',
                `<div class="event-row-detail"><pre>${escapeHtml(full)}</pre></div>`)
            } else {
              const next = row.nextElementSibling
              if (next && next.classList.contains('event-row-detail')) next.remove()
            }
          })
        }

        // 整行 hover 保留视觉反馈，但不再触发跳转（避免误点）
      })
    }).catch(() => { })
  }

  // ---------------- Performance ----------------
  // 更新频率时间线：最近 60s，每 2s 一个桶，生成直方图
  function buildPerfChart(records: any[]): string {
    const now = Date.now()
    const WINDOW = 60000
    const BUCKET = 2000
    const bucketCount = WINDOW / BUCKET
    const counts = new Array<number>(bucketCount).fill(0)
    records.forEach(r => {
      const age = now - r.timestamp
      if (age < 0 || age >= WINDOW) return
      const idx = bucketCount - 1 - Math.floor(age / BUCKET)
      if (idx >= 0 && idx < bucketCount) counts[idx]++
    })
    const max = Math.max(...counts, 1)
    const bars = counts.map((c, i) => {
      const h = c > 0 ? Math.max((c / max) * 100, 8) : 2
      const sec = Math.round((bucketCount - 1 - i) * BUCKET / 1000)
      const title = `${sec}s 前: ${c} 次更新`
      return `<div class="perf-chart-bar" style="height:${h}%" title="${title}" data-count="${c}"></div>`
    }).join('')
    return `<div class="perf-chart">
      <div class="perf-chart-title">更新频率 <span class="perf-chart-sub">最近 60s · 每 2s</span></div>
      <div class="perf-chart-bars">${bars}</div>
    </div>`
  }

  function refreshPerf() {
    Promise.all([
      sendToPage('COMPELEM_DEVTOOLS_GET_METRICS').catch(() => []),
      sendToPage('COMPELEM_DEVTOOLS_GET_COMPUTED_STATS').catch(() => []),
      sendToPage('COMPELEM_DEVTOOLS_GET_UPDATEPOINT_STATS').catch(() => [])
    ]).then(([records, computedStats, upStats]) => {
      const container = document.getElementById('perf-content')!
      records = records || []
      computedStats = computedStats || []
      upStats = upStats || []
      const hasData = records.length > 0 || computedStats.length > 0 || upStats.length > 0
      const toolbarHtml = `<div class="perf-toolbar">
        <button id="perf-clear" ${hasData ? '' : 'disabled'}>清空数据</button>
        <span class="perf-toolbar-hint">${records.length || computedStats.length || upStats.length ? `已采样 ${records.length} 次更新 · ${computedStats.length} 个 computed · ${upStats.length} 个 UP key` : '无采样数据'}</span>
      </div>`

      if (!hasData) {
        container.innerHTML = toolbarHtml + `<div class="empty-state"><div class="empty-icon">📊</div><div>暂无性能数据。交互页面后查看更新统计。</div></div>`
        bindPerfClear(container)
        return
      }

      // --- 组件级更新聚合（原有） ---
      const grouped: Record<string, any> = {}
      let totalUpdates = 0, totalDuration = 0, maxDuration = 0, totalRender = 0
      records.forEach((r: any) => {
        const key = `${r.cid}:${r.tagName}`
        if (!grouped[key]) grouped[key] = { cid: r.cid, tagName: r.tagName, updates: 0, totalDuration: 0, totalRender: 0, maxDuration: 0, lastUpdate: 0 }
        const g = grouped[key]
        g.updates++
        g.totalDuration += r.duration
        g.totalRender += r.renderTime || 0
        g.maxDuration = Math.max(g.maxDuration, r.duration)
        g.lastUpdate = Math.max(g.lastUpdate, r.timestamp)
        totalUpdates++; totalDuration += r.duration; totalRender += r.renderTime || 0
        maxDuration = Math.max(maxDuration, r.duration)
      })
      const avgAll = totalDuration / Math.max(totalUpdates, 1)
      const avgRender = totalRender / Math.max(totalUpdates, 1)

      let html = toolbarHtml

      // --- 热区汇总（快速扫一眼哪里最贵） ---
      const hotHtml: string[] = []
      const sortedComputed = computedStats.slice().sort((a, b) => b.recomputes - a.recomputes).slice(0, 5)
      const sortedUPs = upStats.slice().sort((a, b) => b.count - a.count).slice(0, 5)
      const topUpdates = Object.values(grouped).sort((a: any, b: any) => b.updates - a.updates).slice(0, 5)
      hotHtml.push(`<div class="perf-hot-row">
        <div class="perf-hot-title">🔥 更新最频繁</div>
        <div class="perf-hot-list">${topUpdates.map((g: any) => `<span class="perf-hot-chip" data-cid="${g.cid}" title="点击跳转到组件树">&lt;${escapeHtml(g.tagName)}&gt; #${g.cid} ×${g.updates}</span>`).join('') || '<span class="perf-hot-empty">暂无数据</span>'}</div>
      </div>`)
      hotHtml.push(`<div class="perf-hot-row">
        <div class="perf-hot-title">🔁 @computed 重算最多</div>
        <div class="perf-hot-list">${sortedComputed.map(c => `<span class="perf-hot-chip" title="${c.ctorName}.${c.computedKey} 命中${c.hits} · 重算${c.recomputes}">${c.ctorName}.${c.computedKey} <span class="perf-hot-rate">×${c.recomputes} · hit ${(c.hitRate*100).toFixed(0)}%</span></span>`).join('') || '<span class="perf-hot-empty">无 computed 数据</span>'}</div>
      </div>`)
      hotHtml.push(`<div class="perf-hot-row">
        <div class="perf-hot-title">⚡ UpdatePoint 最常标记</div>
        <div class="perf-hot-list">${sortedUPs.map(u => `<span class="perf-hot-chip" title="${u.key} 被标记 ${u.count} 次">${escapeHtml(u.key)} ×${u.count}</span>`).join('') || '<span class="perf-hot-empty">无 UP 数据</span>'}</div>
      </div>`)
      html += `<div class="perf-hot-wrap">${hotHtml.join('')}</div>`

      // --- 原有 metric cards ---
      html += buildPerfChart(records)
      html += `<div class="perf-summary">
          <div class="perf-metric-card"><div class="perf-metric-label">Total Updates</div><div class="perf-metric-value">${totalUpdates}</div></div>
          <div class="perf-metric-card"><div class="perf-metric-label">Avg Update</div><div class="perf-metric-value">${avgAll.toFixed(2)}<span class="perf-metric-unit">ms</span></div></div>
          <div class="perf-metric-card"><div class="perf-metric-label">Avg Render</div><div class="perf-metric-value">${avgRender.toFixed(2)}<span class="perf-metric-unit">ms</span></div></div>
          <div class="perf-metric-card"><div class="perf-metric-label">Max Duration</div><div class="perf-metric-value">${maxDuration.toFixed(2)}<span class="perf-metric-unit">ms</span></div></div>
          <div class="perf-metric-card"><div class="perf-metric-label">Components</div><div class="perf-metric-value">${Object.keys(grouped).length}</div></div>
        </div>`

      // --- 每组件卡片 ---
      if (Object.keys(grouped).length > 0) {
        html += `<div class="perf-grid">`
        Object.values(grouped).forEach((g: any) => {
          const avg = g.totalDuration / g.updates
          const avgR = g.totalRender / g.updates
          const warnClass = g.maxDuration > 5 ? 'warn' : 'ok'
          html += `<div class="perf-card" data-cid="${g.cid}">
            <div class="perf-card-tag">&lt;${escapeHtml(g.tagName)}&gt; #${g.cid}</div>
            <div class="perf-card-stats">
              <div class="perf-stat"><span class="perf-stat-label">Updates</span><span class="perf-stat-value">${g.updates}</span></div>
              <div class="perf-stat"><span class="perf-stat-label">Total</span><span class="perf-stat-value">${g.totalDuration.toFixed(1)}ms</span></div>
              <div class="perf-stat"><span class="perf-stat-label">Avg Upd</span><span class="perf-stat-value ${avg > 2 ? 'warn' : 'ok'}">${avg.toFixed(2)}ms</span></div>
              <div class="perf-stat"><span class="perf-stat-label">Avg Rnd</span><span class="perf-stat-value ${avgR > 2 ? 'warn' : 'ok'}">${avgR.toFixed(2)}ms</span></div>
              <div class="perf-stat"><span class="perf-stat-label">Max</span><span class="perf-stat-value ${warnClass}">${g.maxDuration.toFixed(2)}ms</span></div>
            </div>
          </div>`
        })
        html += `</div>`
      }

      container.innerHTML = html
      bindPerfClear(container)

      // 热区 chip 点击 → 跳到组件
      container.querySelectorAll('.perf-hot-chip[data-cid]').forEach(chip => {
        chip.addEventListener('click', () => {
          const cid = parseInt((chip as HTMLElement).dataset.cid!)
          switchTab('tree')
          selectComponent(cid)
        })
      })
      container.querySelectorAll('.perf-card').forEach(card => {
        card.addEventListener('click', () => {
          const cid = parseInt((card as HTMLElement).dataset.cid!)
          switchTab('tree')
          selectComponent(cid)
        })
      })
    }).catch(() => { })
  }

  function bindPerfClear(container: HTMLElement) {
    const btn = container.querySelector('#perf-clear')
    if (btn) btn.addEventListener('click', () => {
      sendToPage('COMPELEM_DEVTOOLS_CLEAR_EVENTS')
      refreshPerf()
    })
  }

  // ---------------- Deps ----------------
  function refreshDepsList() {
    const listContainer = document.getElementById('dep-list')!
    if (state.componentTree.length === 0) {
      sendToPage('COMPELEM_DEVTOOLS_GET_TREE').then(tree => {
        state.componentTree = tree || []
        renderDepList()
      }).catch(() => {
        listContainer.innerHTML = `<div class="empty-state"><div>没有组件</div></div>`
      })
    } else {
      renderDepList()
    }
  }

  function renderDepList() {
    const listContainer = document.getElementById('dep-list')!
    if (state.componentTree.length === 0) {
      listContainer.innerHTML = `<div class="empty-state"><div>没有组件</div></div>`
      return
    }
    const all = state.componentTree
    const roots = all.filter(c => c.parentCid == null || c.parentCid === -1 || !all.some(p => p.cid === c.parentCid))
    // 复用组件树的 class 名（tree-node / tree-node-content / tree-toggle / tree-tag / tree-cid / tree-children），
    // 这样 Deps 面板的缩进、颜色、hover、选中态都和组件树 Tab 完全一致
    const build = (node: any): string => {
      const children = all.filter(c => c.parentCid === node.cid)
      const hasChildren = children.length > 0
      const selected = node.cid === state.selectedCid
      const expanded = state.expandedCids.has(node.cid)
      let html = `<div class="tree-node">`
      html += `<div class="tree-node-content ${selected ? 'selected' : ''}" data-cid="${node.cid}">`
      html += `<span class="tree-toggle ${expanded ? 'expanded' : ''}">${hasChildren ? '▶' : ''}</span>`
      html += `<span class="tree-tag">&lt;${node.tagName}&gt;</span>`
      html += `<span class="tree-class">${node.className || ''}</span>`
      html += `<span style="flex:1"></span>`
      html += `<span class="tree-cid">#${node.cid}</span>`
      html += `</div>`
      if (hasChildren) {
        html += `<div class="tree-children" style="display:${expanded ? '' : 'none'}">`
        children.forEach(c => { html += build(c) })
        html += `</div>`
      }
      html += `</div>`
      return html
    }
    listContainer.innerHTML = roots.map(r => build(r)).join('')

    listContainer.querySelectorAll('.tree-node-content').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        const cid = parseInt((el as HTMLElement).dataset.cid!)
        state.selectedCid = cid
        renderDepList()
        showDeps(cid)
      })
    })
    // ▶/▼ toggle：点击 tree-toggle 触发父节点展开/收起（和组件树一样的交互）
    listContainer.querySelectorAll('.tree-toggle').forEach(toggle => {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation()
        const row = (toggle as HTMLElement).closest('.tree-node-content') as HTMLElement
        const cid = parseInt(row.dataset.cid!)
        const isExpanded = state.expandedCids.has(cid)
        if (isExpanded) state.expandedCids.delete(cid)
        else state.expandedCids.add(cid)
        renderDepList()
      })
    })

    if (state.selectedCid != null) showDeps(state.selectedCid)
  }

  function showDeps(cid: number) {
    sendToPage('COMPELEM_DEVTOOLS_GET_DEPS', { cid }).then(deps => {
      const container = document.getElementById('dep-inspector')!
      if (!deps) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">❓</div><div>无法获取依赖</div></div>`
        return
      }

      let html = ''
      // View Deps
      if (deps.viewDeps && deps.viewDeps.length > 0) {
        html += `<div class="dep-section"><div class="dep-section-title">📊 View Dependencies (模板插值)</div>`
        deps.viewDeps.forEach((d: string) => {
          html += `<div class="dep-item"><span class="dep-dot view"></span><span class="dep-name">${escapeHtml(d)}</span></div>`
        })
        html += `</div>`
      }

      // Sub View Deps
      if (deps.subViewDeps && Object.keys(deps.subViewDeps).length > 0) {
        html += `<div class="dep-section"><div class="dep-section-title">◈ Sub-View Dependencies (指令级)</div>`
        Object.entries(deps.subViewDeps).forEach(([k, v]) => {
          html += `<div class="dep-item"><span class="dep-dot sub"></span><span class="dep-name">${escapeHtml(k)}</span><span class="dep-meta">${v} UPs</span></div>`
        })
        html += `</div>`
      }

      // CSS Deps
      if (deps.cssDeps && deps.cssDeps.length > 0) {
        html += `<div class="dep-section"><div class="dep-section-title">🎨 CSS Variables</div>`
        deps.cssDeps.forEach((d: string) => {
          html += `<div class="dep-item"><span class="dep-dot css"></span><span class="dep-name">--${escapeHtml(d)}</span></div>`
        })
        html += `</div>`
      }

      // Watch Keys
      if (deps.watchKeys && deps.watchKeys.length > 0) {
        html += `<div class="dep-section"><div class="dep-section-title">👁 Watch Keys</div>`
        deps.watchKeys.forEach((d: string) => {
          html += `<div class="dep-item"><span class="dep-dot watch"></span><span class="dep-name">${escapeHtml(d)}</span></div>`
        })
        html += `</div>`
      }

      // Stats
      html += `<div class="dep-section"><div class="dep-section-title">📦 统计</div>`
      html += `<div class="dep-item"><span class="dep-dot view"></span><span class="dep-name">Update Points</span><span class="dep-meta">${deps.updatePointCount || 0}</span></div>`
      html += `</div>`

      if (!html) html = `<div class="empty-state"><div class="empty-icon">🔗</div><div>没有可用的依赖信息</div></div>`

      // --- 变更溯源链（P1-1）：对 viewDeps 的每个路径反查影响范围 ---
      html += `<div class="dep-section dep-trace-section"><div class="dep-section-title">🔗 变更溯源（改这些 state 会影响谁？）</div><div class="dep-trace-loading">正在反查影响范围...</div></div>`

      container.innerHTML = html

      // 异步反查每个 viewDep 路径
      const paths: string[] = []
      if (deps.viewDeps) paths.push(...deps.viewDeps)
      if (deps.watchKeys) paths.push(...deps.watchKeys)
      const uniquePaths = Array.from(new Set(paths)).slice(0, 20) // 限制数量

      if (uniquePaths.length === 0) {
        container.querySelector('.dep-trace-section')!.innerHTML =
          `<div class="dep-trace-empty">没有 viewDeps / watchKeys 可以溯源</div>`
      } else {
        Promise.all(uniquePaths.map(p =>
          sendToPage('COMPELEM_DEVTOOLS_TRACE_DEPENDENCY', { statePath: p }).catch(() => null)
        )).then(results => {
          const section = container.querySelector('.dep-trace-section')!
          // 只显示真正有影响的路径（至少影响一个组件 / computed / watcher）
          const impactful = uniquePaths.map((p, i) => ({ path: p, impact: results[i] }))
            .filter(x => x.impact && (x.impact.computedGets.length + x.impact.viewDeps.length + x.impact.watchers.length + x.impact.cssDeps.length > 0))

          if (impactful.length === 0) {
            section.innerHTML = `<div class="dep-trace-empty">这 ${uniquePaths.length} 个路径目前没有检测到跨组件影响（可能只是本组件内部使用）</div>`
            return
          }

          const rows = impactful.map(({ path, impact }) => {
            const compCount = impact.viewDeps.length
            const compNames = impact.viewDeps.map((v: any) => v.ctorName).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
            const compBadges = compCount > 0
              ? compNames.slice(0, 4).map(n => `<span class="trace-badge comp">${n}</span>`).join('') + (compCount > 4 ? `<span class="trace-badge more">+${compCount-4}</span>` : '')
              : ''
            const compBadgesTitle = compCount > 4 ? `影响组件：${compNames.join(', ')}` : ''

            const compCount2 = impact.computedGets.length
            const compBadges2 = compCount2 > 0
              ? impact.computedGets.slice(0, 4).map((c: any) => `<span class="trace-badge computed">${c.ctorName}.${c.computedKey}</span>`).join('') + (compCount2 > 4 ? `<span class="trace-badge more">+${compCount2-4}</span>` : '')
              : ''

            const watchCount = impact.watchers.length
            const watchBadges = watchCount > 0
              ? impact.watchers.map((w: any) => `<span class="trace-badge watch">${w.ctorName}@${w.key}</span>`).join('')
              : ''

            return `<div class="dep-trace-row" title="${escapeHtml(path)}">
              <div class="dep-trace-path">${escapeHtml(path)}</div>
              <div class="dep-trace-impact">
                ${compCount > 0 ? `<span class="trace-tag comp">触发 ${compCount} 组件更新</span>` : ''}
                ${compCount2 > 0 ? `<span class="trace-tag computed">${compCount2} 个 computed 重算</span>` : ''}
                ${watchCount > 0 ? `<span class="trace-tag watch">${watchCount} 个 watcher</span>` : ''}
                ${compBadges || compBadges2 || watchBadges ? `<div class="dep-trace-badges">${compBadges}${compBadges2}${watchBadges}</div>` : ''}
              </div>
            </div>`
          }).join('')

          section.innerHTML = `<div class="dep-trace-summary">${uniquePaths.length} 个路径中 ${impactful.length} 个有跨组件影响</div>${rows}`
        })
      }
    }).catch(() => { })
  }

  // ---------------- 生态库（store / router / i18n） ----------------
  // 数据来源：页面侧生态库把 provider 挂到 globalThis.__COMPELEM_ECOSYSTEM__，
  // injected 读取后经既有 eval 通道回来。缺失时整段降级为引导提示。
  // 左侧导航里 Store / Router / I18n 三个页签共用 #tab-eco 面板，靠 ecoSeg 区分。
  const ECO_SEGS = ['store', 'router', 'i18n']
  let ecoSeg: string = 'store'
  let ecoAvailability: any = null
  let ecoStores: any[] = []
  let ecoSelectedStore: string | null = null
  let ecoMutations: any[] = []
  let ecoStoreHeartbeat: number | null = null
  /** 上一次 action 调用结果。refreshStoreInspector 会重建详情 DOM，结果必须存在状态里才能存活 */
  let ecoActionResult: { ok: boolean; text: string } | null = null

  const ECO_PKG: Record<string, string> = {
    store: 'compelem-store',
    router: 'compelem-router',
    i18n: 'compelem-i18n'
  }

  const ECO_ICON: Record<string, string> = {
    store: '📦',
    router: '🧭',
    i18n: '🌐'
  }

  function isEcoSeg(v: unknown): v is string {
    return typeof v === 'string' && ECO_SEGS.indexOf(v) >= 0
  }

  function refreshEco() {
    sendToPage('COMPELEM_DEVTOOLS_GET_ECOSYSTEM').then(avail => {
      ecoAvailability = avail || {}
      applyEcoSegment()
    }).catch(() => {
      ecoAvailability = {}
      applyEcoSegment()
    })
  }

  /**
   * 只刷新依赖可用性，用于点亮左侧导航的状态点。
   * 与 refreshEco 的区别：不触碰生态面板内容，因此在任何页签下都能安全调用。
   */
  function refreshEcoAvailability() {
    sendToPage('COMPELEM_DEVTOOLS_GET_ECOSYSTEM').then(avail => {
      ecoAvailability = avail || {}
      updateEcoSegStatus()
    }).catch(() => {
      ecoAvailability = {}
      updateEcoSegStatus()
    })
  }

  /** 按当前分段分发（store / router / i18n） */
  function applyEcoSegment() {
    updateEcoSegStatus()
    if (ecoSeg === 'store') {
      // store 的标题与操作区（刷新 / Reset / 清空记录）在 refreshStoreInspector 里按选中项设置
      refreshEcoStoreList()
      return
    }
    // router / i18n 没有 store 那一组操作按钮，必须显式接管标题与操作区，
    // 否则会残留上一分段的「Store 详情 + 刷新/Reset/清空记录」（那些按钮作用于 store）
    setEcoDetailHeader(ecoSeg === 'router' ? 'Route 详情' : 'I18n 详情')
    if (ecoSeg === 'router') refreshEcoRouter()
    else refreshEcoI18n()
  }

  /**
   * 依赖三态：
   * - `off`  库未加载 —— 命名空间不存在（`a[seg]` 为假）
   * - `half` 库已加载但无实例 —— 命名空间在、`list()` 为空
   * - `ok`   有实例
   *
   * 依据是 injected 的 `ecosystemAvailability()`。三个库都在**模块加载期**就把命名空间
   * 挂到 `__COMPELEM_ECOSYSTEM__` 上，因此 off / half 是可靠可分的。
   * 老版本库（没有加载期挂载）只会退化成 off —— 即旧行为，不会误报。
   */
  function ecoDepState(seg: string): 'off' | 'half' | 'ok' {
    const a = ecoAvailability || {}
    if (!a[seg]) return 'off'
    const n = a[seg + 'Count']
    return (typeof n === 'number' && n === 0) ? 'half' : 'ok'
  }

  /** 探测结果是否可用（拿不到时保持静默，避免把「未连接页面」误报成「未启用依赖」） */
  function ecoAvailabilityKnown(): boolean {
    return !!ecoAvailability && typeof ecoAvailability.available === 'boolean'
  }

  /** 左侧三项的状态点 + 右栏当前分段的依赖状态文字 */
  function updateEcoSegStatus() {
    const known = ecoAvailabilityKnown()
    for (const seg of ECO_SEGS) {
      const dot = document.getElementById('dot-eco-' + seg)
      if (!dot) continue
      if (!known) { dot.className = 'nav-dot'; dot.title = ''; continue }
      const st = ecoDepState(seg)
      dot.className = 'nav-dot ' + st
      dot.title = st === 'off' ? ECO_PKG[seg] + ' 未启用'
        : st === 'half' ? '已启用 ' + ECO_PKG[seg] + '，但尚未创建实例'
          : ECO_PKG[seg] + ' · 已接入'
    }
    const el = document.getElementById('eco-seg-status')
    if (!el) return
    if (!known) { el.textContent = ''; el.classList.remove('off'); return }
    const st = ecoDepState(ecoSeg)
    el.textContent = st === 'off' ? '未启用 ' + ECO_PKG[ecoSeg]
      : st === 'half' ? ECO_PKG[ecoSeg] + ' · 无实例'
        : ECO_PKG[ecoSeg] + ' · 已接入'
    el.classList.toggle('off', st === 'off')
  }

  /** 未接入 / 无实例时的引导提示。已接入但空时给出不同文案。 */
  function ecoHintHtml(seg: string, readyWithoutData: string): string {
    const pkg = ECO_PKG[seg]
    const attached = !!(ecoAvailability && ecoAvailability[seg])
    if (!attached) {
      return `<div class="eco-hint">未检测到 <code>${pkg}</code><br>需该库暴露<br><code>__COMPELEM_ECOSYSTEM__.${seg}</code></div>`
    }
    return `<div class="eco-hint">已接入 <code>${pkg}</code><br>${readyWithoutData}</div>`
  }

  /**
   * 右栏依赖判定卡片。依赖就绪（`ok`）时返回 ''，由正常渲染接管。
   *
   * 这是「右侧依赖包使用判断」的落点：
   * - 库未加载   → 未启用 `<pkg>` 依赖
   * - 库已加载但无实例 → 已启用 `<pkg>`，但尚未创建实例
   */
  function ecoDepHtml(seg: string, createHint: string): string {
    const st = ecoDepState(seg)
    if (st === 'ok') return ''
    const pkg = ECO_PKG[seg]
    const title = st === 'off'
      ? `未启用 <code>${pkg}</code> 依赖`
      : `已启用 <code>${pkg}</code>，但尚未创建实例`
    const desc = st === 'off'
      ? `当前页面没有加载 <code>${pkg}</code>。`
      : '依赖已加载，但页面还没有可用实例。'
    const hint = st === 'off'
      ? `检测依据：<code>globalThis.__COMPELEM_ECOSYSTEM__.${seg}</code> 不存在<br>引入该库后此处会自动生效`
      : createHint
    return `<div class="empty-state eco-dep" data-dep-state="${st}" data-dep-pkg="${pkg}">
      <div class="empty-icon">${ECO_ICON[seg]}</div>
      <div class="eco-dep-title">${title}</div>
      <div class="eco-dep-desc">${desc}</div>
      <div class="eco-dep-hint">${hint}</div>
    </div>`
  }

  function setEcoListHeader(title: string, count: string) {
    const t = document.getElementById('eco-list-title')
    if (t) t.textContent = title
    const c = document.getElementById('eco-list-count')
    if (c) c.textContent = count
  }

  function setEcoDetailHeader(title: string, actionsHtml = '') {
    const t = document.getElementById('eco-detail-title')
    if (t) t.textContent = title
    const a = document.getElementById('eco-detail-actions')
    if (a) a.innerHTML = actionsHtml
  }

  function ecoEmpty(icon: string, text: string): string {
    return `<div class="empty-state"><div class="empty-icon">${icon}</div><div>${escapeHtml(text)}</div></div>`
  }

  /** 只读键值小节：复用 .state-section 的折叠与配色，但不带 data-cid（非组件数据） */
  function renderReadonlySection(section: string, title: string, values: Record<string, any>): string {
    const entries = Object.entries(values).filter(([, v]) => v !== undefined)
    if (entries.length === 0) return ''
    let html = `<div class="state-section" data-section="${section}">`
    html += `<div class="state-section-header"><span class="state-section-label">${title}</span>`
    html += `<span class="state-section-count">${entries.length}</span>`
    html += `<span class="state-section-arrow">▼</span></div>`
    html += `<div class="state-section-body">`
    for (const [key, val] of entries) {
      html += `<div class="state-entry">`
      html += `<span class="state-key">${escapeHtml(key)}</span>`
      html += `<span class="state-colon">:</span>`
      html += `<span class="state-value" data-type="${getValueType(val)}">${formatValue(val)}</span>`
      html += `</div>`
    }
    html += `</div></div>`
    return html
  }

  // ---------------- 生态库：router ----------------
  let ecoRouter: any = null
  /** 路由表扁平化结果：{ node, depth }，列表按此顺序渲染 */
  let ecoRouteFlat: Array<{ node: any; depth: number }> = []
  let ecoRouterSelected: number | null = null
  let ecoMatchUrl = ''
  let ecoMatchResult: any = null
  let ecoNavPath = ''
  let ecoRouterHeartbeat: number | null = null
  /**
   * 导航结果必须存在状态里：路由变更推送会触发 refreshEcoRouter() 重建整个详情 DOM，
   * 存在 DOM 里的文案会被抹掉（store 的 action 结果踩过同一个坑）。
   */
  let ecoNavResult: { kind: 'info' | 'ok' | 'err'; text: string } | null = null
  /** 单调递增的导航令牌：晚到的旧回执（或推送后的回执）不得覆盖更新的文案 */
  let ecoNavSeq = 0

  function setNavResult(kind: 'info' | 'ok' | 'err', text: string) {
    ecoNavResult = { kind, text }
    paintNavResult()
  }

  function paintNavResult() {
    const el = document.getElementById('eco-nav-result')
    if (!el) return
    el.className = 'eco-action-result' + (!ecoNavResult ? '' : ecoNavResult.kind === 'err' ? ' err' : ecoNavResult.kind === 'ok' ? ' ok' : '')
    el.textContent = ecoNavResult ? ecoNavResult.text : ''
  }

  /** 路由表 → 扁平列表（带层级），列表里用 padding-left 表达嵌套 */
  function flattenRoutes(nodes: any[], depth = 0, out: Array<{ node: any; depth: number }> = []) {
    for (const n of nodes || []) {
      out.push({ node: n, depth })
      if (n.children && n.children.length) flattenRoutes(n.children, depth + 1, out)
    }
    return out
  }

  function refreshEcoRouter() {
    const list = document.getElementById('eco-list')!
    // off = compelem-router 未加载；half = 已加载但还没 createRouter —— 都不必再问一次
    if (ecoDepState('router') !== 'ok') {
      setEcoListHeader('Route', '')
      setEcoDetailHeader('Route 详情')
      list.innerHTML = ecoHintHtml('router', '尚未创建路由实例')
      document.getElementById('eco-detail')!.innerHTML =
        ecoDepHtml('router', '调用 <code>createRouter(options)</code> 后在此查看路由表')
      ecoRouter = null
      subscribeEcoRouter(false)
      return
    }
    setEcoListHeader('Route', '')
    sendToPage('COMPELEM_DEVTOOLS_GET_ROUTER_INFO').then(info => {
      if (!info) {
        // 兜底：探测与取值之间实例被销毁
        list.innerHTML = ecoHintHtml('router', '尚未创建路由实例')
        document.getElementById('eco-detail')!.innerHTML =
          ecoDepHtml('router', '调用 <code>createRouter(options)</code> 后在此查看路由表')
        ecoRouter = null
        subscribeEcoRouter(false)
        return
      }
      ecoRouter = info
      ecoRouteFlat = flattenRoutes(info.routes || [])
      setEcoListHeader('Route', ecoRouteFlat.length ? ecoRouteFlat.length + ' routes' : '')
      if (ecoRouteFlat.length === 0) {
        list.innerHTML = ecoHintHtml('router', '路由表为空')
      } else {
        list.innerHTML = ecoRouteFlat.map((r, i) => `
          <div class="list-item eco-route-row ${i === ecoRouterSelected ? 'selected' : ''}"
               data-route-idx="${i}" style="padding-left:${8 + r.depth * 14}px">
            <span class="list-item-tag" style="color:var(--tag-route)">${escapeHtml(r.node.path)}</span>
            <span class="list-item-cid">${escapeHtml(r.node.name || (r.node.redirect ? '→' : ''))}</span>
          </div>`).join('')
        list.querySelectorAll('.eco-route-row').forEach(el => {
          el.addEventListener('click', () => selectRoute(Number((el as HTMLElement).dataset.routeIdx)))
        })
      }
      renderRouterDetail()
      subscribeEcoRouter(true)
    }).catch(() => {
      list.innerHTML = `<div class="empty-state"><div>获取路由信息失败</div></div>`
    })
  }

  function selectRoute(idx: number) {
    ecoRouterSelected = idx
    document.querySelectorAll('#eco-list .eco-route-row').forEach(el => {
      el.classList.toggle('selected', Number((el as HTMLElement).dataset.routeIdx) === idx)
    })
    renderRouterDetail()
  }

  function renderRouterDetail() {
    const detail = document.getElementById('eco-detail')!
    if (!ecoRouter) {
      detail.innerHTML = ecoEmpty('🧭', '没有可查看的路由')
      return
    }
    const cur = ecoRouter.current
    let html = ''

    // 1) 当前路由
    if (cur) {
      const url = cur.url || cur.fullPath || '(未导航)'
      html += `<div class="eco-head">
        <div class="eco-head-title">${escapeHtml(url)}</div>
        <div class="eco-head-meta">
          <span class="eco-chip">name: ${escapeHtml(cur.name || '-')}</span>
          <span class="eco-chip">mode: ${escapeHtml(cur.mode || '-')}</span>
          <span class="eco-chip">v${escapeHtml(String(cur.version))}</span>
        </div>
      </div>`
      // 面板优先展示 url；path/fullPath 由库侧 Route 提供，多段路径下会被截断
      if (cur.path && url && cur.path !== url && String(url).indexOf(cur.path) === 0) {
        html += `<div class="eco-warn">Route.path 显示为 <code>${escapeHtml(cur.path)}</code>，与真实地址不一致
          —— 库侧 buildRoute 在多段路径下会截断（动态参数段 / 嵌套末段会丢）。以 <b>url</b> 为准。</div>`
      }
      html += renderReadonlySection('route', 'Route', {
        path: cur.path, fullPath: cur.fullPath, queryString: cur.queryString || undefined,
        matched: (cur.matched || []).map((m: any) => m.path || m.name).join(' › ') || undefined,
        from: cur.from ? (cur.from.fullPath || cur.from.path) : undefined
      })
      html += renderReadonlySection('params', 'Params', cur.params || {})
      html += renderReadonlySection('query', 'Query', cur.query || {})
      html += renderReadonlySection('route', 'Meta', cur.meta || {})
    } else {
      html += `<div class="eco-head"><div class="eco-head-title">尚未导航</div>
        <div class="eco-head-meta"><span class="eco-chip">hash: ${escapeHtml(location.hash || '-')}</span></div></div>`
    }

    // 2) 导航控制台
    html += `<div class="state-section" data-section="nav">
      <div class="state-section-header"><span class="state-section-label">Navigate</span>
      <span class="state-section-count">5</span><span class="state-section-arrow">▼</span></div>
      <div class="state-section-body">
        <div class="eco-action-row">
          <input class="eco-input" id="eco-nav-path" placeholder="/post/42 或 {&quot;name&quot;:&quot;post&quot;,&quot;params&quot;:{&quot;id&quot;:42}}" value="${escapeHtml(ecoNavPath)}">
          <button class="eco-btn" id="eco-nav-push">push</button>
          <button class="eco-btn" id="eco-nav-replace">replace</button>
        </div>
        <div class="eco-action-row">
          <span class="eco-action-name">history</span>
          <button class="eco-btn" id="eco-nav-back">back</button>
          <button class="eco-btn" id="eco-nav-forward">forward</button>
          <input class="eco-action-args" id="eco-nav-delta" placeholder="delta" value="-1">
          <button class="eco-btn" id="eco-nav-go">go</button>
        </div>
        <div class="eco-action-result" id="eco-nav-result"></div>
      </div></div>`

    // 3) 匹配试算
    html += `<div class="state-section" data-section="match">
      <div class="state-section-header"><span class="state-section-label">Match 试算</span>
      <span class="state-section-arrow">▼</span></div>
      <div class="state-section-body">
        <div class="eco-action-row">
          <input class="eco-input" id="eco-match-url" placeholder="输入 URL 看会命中哪条路由（无副作用）" value="${escapeHtml(ecoMatchUrl)}">
          <button class="eco-btn" id="eco-match-run">试算</button>
        </div>
        <div id="eco-match-result">${renderMatchResult()}</div>
      </div></div>`

    // 4) 选中的路由项
    if (ecoRouterSelected != null && ecoRouteFlat[ecoRouterSelected]) {
      const node = ecoRouteFlat[ecoRouterSelected].node
      html += renderReadonlySection('routeItem', 'Route Item', {
        path: node.path, name: node.name, component: node.component,
        redirect: node.redirect, isDefault: node.isDefault || undefined,
        beforeEnter: node.hasBeforeEnter || undefined
      })
      html += renderReadonlySection('routeItem', 'Segments', Object.fromEntries(
        (node.segments || []).map((s: any, i: number) => [
          '[' + i + ']', s.text + (s.isStatic ? ' (static)' : ' (dynamic)') + (s.isWildcard ? ' wildcard' : '') + (s.isOptional ? ' optional' : '')
        ])
      ))
      html += renderReadonlySection('routeItem', 'Meta', node.meta || {})
    } else {
      html += `<div class="eco-hint">点击左侧任一路由项，查看它的完整配置与路径段解析</div>`
    }

    // 5) 变更历史
    const history = (ecoRouter.history || []).slice().reverse()
    html += `<div class="state-section" data-section="history">
      <div class="state-section-header"><span class="state-section-label">History</span>
      <span class="state-section-count">${history.length}</span><span class="state-section-arrow">▼</span></div>
      <div class="state-section-body">`
    if (history.length === 0) {
      html += `<div class="eco-hint">暂无记录。切到本面板后发生的路由变更会记录在这里（最多 200 条）。</div>`
    } else {
      html += history.slice(0, 60).map((h: any) => `
        <div class="eco-mut-item" data-route-history-seq="${h.seq}">
          <span class="eco-mut-time">${formatClock(h.timestamp)}</span>
          <span class="eco-mut-key">${escapeHtml(h.url || h.to || '')}</span>
          <span class="eco-mut-diff">${escapeHtml(h.fromName || h.from || '∅')} → ${escapeHtml(h.toName || h.to || '∅')}</span>
          <button class="eco-btn" data-route-jump="${escapeHtml(h.url || h.to || '')}">跳回</button>
        </div>`).join('')
    }
    html += `</div></div>`

    detail.innerHTML = html
    bindRouterActions()
    // 详情 DOM 刚被重建，必须把存在状态里的导航回执重新贴回去
    paintNavResult()
  }

  function renderMatchResult(): string {
    if (!ecoMatchResult) return ''
    if (ecoMatchResult.error) return `<div class="eco-action-result err">${escapeHtml(ecoMatchResult.error)}</div>`
    if (!ecoMatchResult.matched) {
      return `<div class="eco-action-result err">未命中任何路由（也没有通配兜底路由）</div>`
    }
    const item = ecoMatchResult.routeItem || {}
    const params = ecoMatchResult.params || {}
    let html = `<div class="eco-action-result ok">命中 <b>${escapeHtml(item.path || '')}</b>`
    if (item.name) html += ` · name: <b>${escapeHtml(item.name)}</b>`
    if (item.component) html += ` · ${escapeHtml(item.component)}`
    html += `</div>`
    html += `<div class="eco-action-row"><span class="eco-action-name">chain</span>
      <span>${escapeHtml((ecoMatchResult.chain || []).map((c: any) => c.path).join(' › ') || '∅')}</span></div>`
    const pKeys = Object.keys(params)
    if (pKeys.length) {
      html += `<div class="eco-action-row"><span class="eco-action-name">params</span>
        <span>${pKeys.map(k => escapeHtml(k) + '=' + escapeHtml(String(params[k]))).join(', ')}</span></div>`
    }
    html += `<div class="eco-action-row"><span class="eco-action-name">matchedPath</span>
      <span>${escapeHtml(JSON.stringify(ecoMatchResult.matchedPath || []))}</span></div>`
    return html
  }

  function bindRouterActions() {
    const navInput = document.getElementById('eco-nav-path') as HTMLInputElement | null
    if (navInput) navInput.addEventListener('input', () => { ecoNavPath = navInput.value })
    const matchInput = document.getElementById('eco-match-url') as HTMLInputElement | null
    if (matchInput) {
      matchInput.addEventListener('input', () => { ecoMatchUrl = matchInput.value })
      matchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runMatch() })
    }

    // 只拿到"指令已下发"的同步回执；真正的落地由 PUSH_ROUTE_CHANGE 推回来
    const nav = (action: string, value?: any) => {
      const seq = ++ecoNavSeq
      setNavResult('info', action + ' 已下发，等待路由变更…')
      sendToPage('COMPELEM_DEVTOOLS_ROUTER_NAVIGATE', { action, payload: value }).then(rs => {
        // 期间已有更新的指令 / 落地推送 → 丢弃这条过期回执
        if (seq !== ecoNavSeq) return
        if (rs && rs.ok) {
          setNavResult('info', action + ' 已下发，等待路由变更…')
        } else {
          setNavResult('err', action + ' ✗ ' + ((rs && rs.error) || '未知错误'))
        }
      }).catch((e: any) => {
        if (seq !== ecoNavSeq) return
        setNavResult('err', String((e && e.message) || e))
      })
    }

    const on = (id: string, fn: () => void) => {
      const el = document.getElementById(id)
      if (el) el.addEventListener('click', fn)
    }
    on('eco-nav-push', () => {
      const raw = (document.getElementById('eco-nav-path') as HTMLInputElement | null)?.value ?? ''
      nav('push', parseRouteInput(raw))
    })
    on('eco-nav-replace', () => {
      const raw = (document.getElementById('eco-nav-path') as HTMLInputElement | null)?.value ?? ''
      const p = parseRouteInput(raw)
      if (typeof p !== 'string') {
        ecoNavSeq++
        setNavResult('err', 'replace 只接受字符串路径')
        return
      }
      nav('replace', p)
    })
    on('eco-nav-back', () => nav('back'))
    on('eco-nav-forward', () => nav('forward'))
    on('eco-nav-go', () => {
      const raw = (document.getElementById('eco-nav-delta') as HTMLInputElement | null)?.value ?? '0'
      // go(0) 等价于整页刷新，明确拦下以免误操作
      if (String(raw).trim() === '0') {
        ecoNavSeq++
        setNavResult('err', 'go(0) 会触发整页重载，已拦截')
        return
      }
      nav('go', raw)
    })
    on('eco-match-run', runMatch)

    document.querySelectorAll('#eco-detail [data-route-jump]').forEach(el => {
      el.addEventListener('click', () => {
        const url = (el as HTMLElement).dataset.routeJump || ''
        if (url) nav('push', url)
      })
    })
  }

  /** 路由入参：以 { 开头按 RouteOption JSON 解析，否则当字符串路径 */
  function parseRouteInput(raw: string): any {
    const text = (raw || '').trim()
    if (text.charAt(0) === '{') {
      try { return JSON.parse(text) } catch { return text }
    }
    return text
  }

  function runMatch() {
    const raw = (document.getElementById('eco-match-url') as HTMLInputElement | null)?.value ?? ''
    ecoMatchUrl = raw
    if (!raw.trim()) {
      ecoMatchResult = null
      const box = document.getElementById('eco-match-result')
      if (box) box.innerHTML = ''
      return
    }
    sendToPage('COMPELEM_DEVTOOLS_MATCH_ROUTE', { url: raw.trim() }).then(rs => {
      ecoMatchResult = rs
      const box = document.getElementById('eco-match-result')
      if (box) box.innerHTML = renderMatchResult()
    }).catch(() => {
      ecoMatchResult = { matched: false, error: '试算失败' }
      const box = document.getElementById('eco-match-result')
      if (box) box.innerHTML = renderMatchResult()
    })
  }

  function subscribeEcoRouter(on: boolean) {
    if (!on) {
      if (ecoRouterHeartbeat != null) {
        clearInterval(ecoRouterHeartbeat)
        ecoRouterHeartbeat = null
        sendToPage('COMPELEM_DEVTOOLS_UNSUBSCRIBE', { types: ['route'] }).catch(() => { })
      }
      return
    }
    if (ecoRouterHeartbeat != null) return
    sendToPage('COMPELEM_DEVTOOLS_SUBSCRIBE', { types: ['route'] }).catch(() => { })
    ecoRouterHeartbeat = window.setInterval(() => {
      if (state.currentTab !== 'eco' || ecoSeg !== 'router') { subscribeEcoRouter(false); return }
      sendToPage('COMPELEM_DEVTOOLS_SUBSCRIBE', { types: ['route'] }).catch(() => { })
    }, 5000)
  }

  function formatClock(ts: number): string {
    if (!ts) return '--:--:--'
    const d = new Date(ts)
    const p = (n: number) => String(n).padStart(2, '0')
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  }

  // ---------------- 生态库：i18n ----------------
  let ecoI18nInstances: any[] = []
  let ecoI18nSelected: string | null = null
  let ecoI18nInfo: any = null
  let ecoI18nKey = ''
  let ecoI18nParams = ''
  let ecoI18nResolve: any = null
  let ecoI18nCoverage: any[] = []
  let ecoI18nMsgLocale: string | null = null
  let ecoI18nMessages: any = null
  let ecoI18nTrace: any[] = []
  let ecoI18nHeartbeat: number | null = null

  function refreshEcoI18n() {
    const list = document.getElementById('eco-list')!
    // off = compelem-i18n 未加载；half = 已加载但还没 createI18n
    if (ecoDepState('i18n') !== 'ok') {
      setEcoListHeader('I18n', '')
      setEcoDetailHeader('I18n 详情')
      list.innerHTML = ecoHintHtml('i18n', '尚未创建 i18n 实例')
      document.getElementById('eco-detail')!.innerHTML =
        ecoDepHtml('i18n', '调用 <code>createI18n(options)</code> 后在此查看语言包')
      ecoI18nInstances = []
      subscribeEcoI18n(false)
      return
    }
    setEcoListHeader('I18n', '')
    sendToPage('COMPELEM_DEVTOOLS_GET_I18N_INSTANCES').then(insts => {
      ecoI18nInstances = Array.isArray(insts) ? insts : []
      setEcoListHeader('I18n', ecoI18nInstances.length ? ecoI18nInstances.length + ' instances' : '')
      if (ecoI18nInstances.length === 0) {
        // 兜底：探测与取值之间实例被清空
        list.innerHTML = ecoHintHtml('i18n', '尚未创建 i18n 实例')
        document.getElementById('eco-detail')!.innerHTML =
          ecoDepHtml('i18n', '调用 <code>createI18n(options)</code> 后在此查看语言包')
        ecoI18nSelected = null
        subscribeEcoI18n(false)
        return
      }
      list.innerHTML = ecoI18nInstances.map(i => `
        <div class="list-item ${i.id === ecoI18nSelected ? 'selected' : ''}" data-i18n-id="${escapeHtml(i.id)}">
          <span class="list-item-tag" style="color:var(--tag-locale)">${escapeHtml(i.id)}</span>
          <span class="list-item-cid">${escapeHtml(i.locale)}</span>
        </div>`).join('')
      list.querySelectorAll('.list-item').forEach(el => {
        el.addEventListener('click', () => selectI18nInstance((el as HTMLElement).dataset.i18nId!))
      })
      const stillThere = ecoI18nSelected && ecoI18nInstances.some(i => i.id === ecoI18nSelected)
      if (!stillThere) {
        selectI18nInstance(ecoI18nInstances[0].id)
      } else {
        // 实例还在：只补一次最新的摘要（语言可能被页面侧改掉了）
        ecoI18nInfo = ecoI18nInstances.find(i => i.id === ecoI18nSelected) || ecoI18nInfo
        if (!ecoI18nMsgLocale && ecoI18nInfo) ecoI18nMsgLocale = ecoI18nInfo.locale
        loadI18nMessages()
      }
      subscribeEcoI18n(true)
    }).catch(() => {
      list.innerHTML = `<div class="empty-state"><div>获取 i18n 实例失败</div></div>`
    })
  }

  function selectI18nInstance(id: string) {
    ecoI18nSelected = id
    const inst = ecoI18nInstances.find(i => i.id === id)
    ecoI18nInfo = inst || null
    ecoI18nMsgLocale = inst ? inst.locale : null
    ecoI18nMessages = null
    ecoI18nResolve = null
    ecoI18nCoverage = []
    document.querySelectorAll('#eco-list .list-item').forEach(el => {
      el.classList.toggle('selected', (el as HTMLElement).dataset.i18nId === id)
    })
    loadI18nMessages()
    loadLocaleTrace()
  }

  /** 拉取当前所选语言的原始语言包（消息树） */
  function loadI18nMessages() {
    if (!ecoI18nSelected) return
    const id = ecoI18nSelected
    const locale = ecoI18nMsgLocale || undefined
    sendToPage('COMPELEM_DEVTOOLS_GET_I18N_MESSAGES', { id, locale }).then(rs => {
      if (id !== ecoI18nSelected) return
      ecoI18nMessages = rs || null
      ecoI18nMsgLocale = (rs && rs.locale) || locale || null
      renderI18nDetail()
    }).catch(() => {
      ecoI18nMessages = null
      renderI18nDetail()
    })
  }

  function loadLocaleTrace() {
    sendToPage('COMPELEM_DEVTOOLS_GET_LOCALE_TRACE').then(list => {
      ecoI18nTrace = Array.isArray(list) ? list : []
      // 历史小节可能是后渲染的，单独补一次；整体重渲染会丢掉输入焦点，故不整体重绘
      const box = document.getElementById('eco-locale-history-body')
      if (box) box.innerHTML = renderLocaleHistory()
      const cnt = document.getElementById('eco-locale-history-count')
      if (cnt) cnt.textContent = String(ecoI18nTrace.length)
    }).catch(() => { /* noop */ })
  }

  function renderLocaleHistory(): string {
    if (ecoI18nTrace.length === 0) {
      return `<div class="eco-hint">暂无记录。切到本面板后发生的语言切换会记录在这里（最多 200 条）。</div>`
    }
    return ecoI18nTrace.slice().reverse().slice(0, 60).map(t => `
      <div class="eco-mut-item">
        <span class="eco-mut-time">${formatClock(t.timestamp)}</span>
        <span class="eco-mut-key">${escapeHtml(t.id)}</span>
        <span class="eco-mut-diff">${escapeHtml(t.oldLocale)} → ${escapeHtml(t.locale)}</span>
      </div>`).join('')
  }

  function renderI18nDetail() {
    const detail = document.getElementById('eco-detail')!
    if (!ecoI18nSelected || !ecoI18nInfo) {
      detail.innerHTML = ecoEmpty('🌐', '从左侧选择一个 i18n 实例')
      return
    }
    const info = ecoI18nInfo
    const locales: string[] = info.locales || []
    let html = `<div class="eco-head">
      <div class="eco-head-title">${escapeHtml(info.id)}</div>
      <div class="eco-head-meta">
        <span class="eco-chip">locale: ${escapeHtml(info.locale)}</span>
        ${info.fallbackLocale ? `<span class="eco-chip">fallback: ${escapeHtml(info.fallbackLocale)}</span>` : ''}
        <span class="eco-chip">${locales.length} locales</span>
      </div>
    </div>`

    // 1) 语言切换
    if (locales.length) {
      html += `<div class="state-section" data-section="locale">
        <div class="state-section-header"><span class="state-section-label">Locale</span>
        <span class="state-section-count">${locales.length}</span><span class="state-section-arrow">▼</span></div>
        <div class="state-section-body"><div class="eco-chips">`
      html += locales.map(l => `<button class="eco-chip eco-locale-chip ${l === info.locale ? 'active' : ''}"
        data-locale="${escapeHtml(l)}">${escapeHtml(l)}</button>`).join('')
      html += `</div></div></div>`
    }

    // 2) Key 解析器
    html += `<div class="state-section" data-section="resolve">
      <div class="state-section-header"><span class="state-section-label">Key 解析</span>
      <span class="state-section-arrow">▼</span></div>
      <div class="state-section-body">
        <div class="eco-action-row">
          <input class="eco-input" id="eco-i18n-key" placeholder="消息键，如 cart.item.title 或 apple" value="${escapeHtml(ecoI18nKey)}">
          <button class="eco-btn" id="eco-i18n-resolve">解析</button>
        </div>
        <div class="eco-action-row">
          <input class="eco-input" id="eco-i18n-params" placeholder="可选参数 JSON，如 {&quot;count&quot;:3} 或 直接填数字触发复数" value="${escapeHtml(ecoI18nParams)}">
        </div>
        <div id="eco-i18n-result">${renderI18nResolveResult()}</div>
      </div></div>`

    // 3) 覆盖率：同一 key 在各语言下的命中情况
    if (ecoI18nCoverage.length) {
      html += `<div class="state-section" data-section="coverage">
        <div class="state-section-header"><span class="state-section-label">语言覆盖</span>
        <span class="state-section-count">${ecoI18nCoverage.length}</span><span class="state-section-arrow">▼</span></div>
        <div class="state-section-body">`
      html += ecoI18nCoverage.map(c => `
        <div class="eco-action-row">
          <span class="eco-action-name">${escapeHtml(c.locale)}</span>
          ${c.found
          ? `<span class="eco-tag ok">命中于 ${escapeHtml(c.foundIn || c.locale)}</span>`
          : `<span class="eco-tag err">缺失</span>`}
          <span class="eco-mut-diff">${escapeHtml(c.value === undefined ? '' : String(c.value))}</span>
        </div>`).join('')
      html += `</div></div>`
    }

    // 4) 语言包树
    const tree = ecoI18nMessages && ecoI18nMessages.messages
    const keyCount = tree ? countLeaves(tree) : 0
    html += `<div class="state-section" data-section="messages">
      <div class="state-section-header"><span class="state-section-label">Messages</span>
      <span class="state-section-count">${keyCount}</span><span class="state-section-arrow">▼</span></div>
      <div class="state-section-body">
        <div class="eco-action-row">
          <span class="eco-action-name">locale</span>
          <select class="eco-input eco-select" id="eco-i18n-msg-locale">
            ${locales.map(l => `<option value="${escapeHtml(l)}" ${l === ecoI18nMsgLocale ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}
          </select>
          <span class="eco-action-name">${keyCount} 条消息</span>
        </div>
        <div class="eco-msg-tree">${renderMessageTree(tree)}</div>
      </div></div>`

    // 5) 语言切换历史
    html += `<div class="state-section" data-section="history">
      <div class="state-section-header"><span class="state-section-label">Locale History</span>
      <span class="state-section-count" id="eco-locale-history-count">${ecoI18nTrace.length}</span>
      <span class="state-section-arrow">▼</span></div>
      <div class="state-section-body" id="eco-locale-history-body">${renderLocaleHistory()}</div></div>`

    detail.innerHTML = html
    bindI18nActions()
  }

  function renderI18nResolveResult(): string {
    const r = ecoI18nResolve
    if (!r) return ''
    if (r.error) return `<div class="eco-action-result err">${escapeHtml(r.error)}</div>`
    if (!r.found) {
      return `<div class="eco-action-result err">未命中：<b>${escapeHtml(r.key)}</b> 在 ${escapeHtml(r.locale || '')} 及回退链中都不存在
        <div class="eco-hint">回退链：${escapeHtml((r.chain || []).join(' → '))}</div></div>`
    }
    let html = `<div class="eco-action-result ok">${escapeHtml(String(r.value))}</div>`
    html += `<div class="eco-action-row"><span class="eco-action-name">命中于</span><span>${escapeHtml(r.foundIn || '?')}</span></div>`
    html += `<div class="eco-action-row"><span class="eco-action-name">回退链</span><span>${escapeHtml((r.chain || []).join(' → '))}</span></div>`
    if (r.raw !== undefined && r.raw !== r.value) {
      html += `<div class="eco-action-row"><span class="eco-action-name">原始模板</span><span>${escapeHtml(String(r.raw))}</span></div>`
    }
    if (r.pluralCategory) {
      html += `<div class="eco-action-row"><span class="eco-action-name">复数类别</span><span>${escapeHtml(r.pluralCategory)}</span></div>`
    }
    return html
  }

  function countLeaves(node: any): number {
    if (node == null) return 0
    if (typeof node !== 'object') return 0
    let n = 0
    for (const k of Object.keys(node)) {
      const v = node[k]
      if (v && typeof v === 'object') n += countLeaves(v)
      else n += 1
    }
    return n
  }

  /** 语言包 → 可折叠的 key/value 树 */
  function renderMessageTree(node: any, path = '', depth = 0): string {
    if (node == null) return ''
    if (typeof node !== 'object') {
      return `<div class="eco-msg-leaf" style="padding-left:${depth * 12}px">
        <span class="state-key">${escapeHtml(path)}</span>
        <span class="state-colon">:</span>
        <span class="state-value" data-type="string">${formatValue(node)}</span>
      </div>`
    }
    let html = ''
    for (const k of Object.keys(node)) {
      const v = node[k]
      const p = path ? path + '.' + k : k
      if (v && typeof v === 'object') {
        html += `<div class="eco-msg-branch" data-depth="${depth}" style="padding-left:${depth * 12}px">
          <span class="eco-msg-toggle">▾</span><span class="state-key">${escapeHtml(k)}</span>
          <span class="eco-action-name">${countLeaves(v)}</span></div>`
        html += `<div class="eco-msg-children">${renderMessageTree(v, p, depth + 1)}</div>`
      } else {
        html += renderMessageTree(v, p, depth)
      }
    }
    return html
  }

  function bindI18nActions() {
    const keyInput = document.getElementById('eco-i18n-key') as HTMLInputElement | null
    if (keyInput) {
      keyInput.addEventListener('input', () => { ecoI18nKey = keyInput.value })
      keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runI18nResolve() })
    }
    const paramsInput = document.getElementById('eco-i18n-params') as HTMLInputElement | null
    if (paramsInput) {
      paramsInput.addEventListener('input', () => { ecoI18nParams = paramsInput.value })
      paramsInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runI18nResolve() })
    }
    const btn = document.getElementById('eco-i18n-resolve')
    if (btn) btn.addEventListener('click', runI18nResolve)

    // 语言切换
    document.querySelectorAll('#eco-detail .eco-locale-chip').forEach(el => {
      el.addEventListener('click', () => {
        const locale = (el as HTMLElement).dataset.locale!
        if (!ecoI18nSelected) return
        sendToPage('COMPELEM_DEVTOOLS_SET_I18N_LOCALE', { id: ecoI18nSelected, locale }).then(() => {
          if (ecoI18nInfo) ecoI18nInfo.locale = locale
          ecoI18nMsgLocale = locale
          ecoI18nResolve = null
          ecoI18nCoverage = []
          refreshEcoI18n()
        }).catch(() => { /* noop */ })
      })
    })

    // 语言包树折叠
    document.querySelectorAll('#eco-detail .eco-msg-branch').forEach(el => {
      el.addEventListener('click', () => {
        const children = (el as HTMLElement).nextElementSibling as HTMLElement | null
        if (!children) return
        const hidden = children.style.display === 'none'
        children.style.display = hidden ? '' : 'none'
        const t = el.querySelector('.eco-msg-toggle')
        if (t) t.textContent = hidden ? '▾' : '▸'
      })
    })

    // 切换语言包预览语言
    const sel = document.getElementById('eco-i18n-msg-locale') as HTMLSelectElement | null
    if (sel) {
      sel.addEventListener('change', () => { ecoI18nMsgLocale = sel.value; loadI18nMessages() })
    }
  }

  function runI18nResolve() {
    if (!ecoI18nSelected) return
    const key = ((document.getElementById('eco-i18n-key') as HTMLInputElement | null)?.value ?? '').trim()
    const rawParams = ((document.getElementById('eco-i18n-params') as HTMLInputElement | null)?.value ?? '').trim()
    ecoI18nKey = key
    ecoI18nParams = rawParams
    if (!key) {
      ecoI18nResolve = null
      ecoI18nCoverage = []
      const box = document.getElementById('eco-i18n-result')
      if (box) box.innerHTML = ''
      return
    }
    // 参数解析：纯数字 → 数字（触发 ICU 复数）；{...} → JSON；其余按普通字符串参数
    let params: any = undefined
    if (rawParams) {
      if (/^-?\d+(\.\d+)?$/.test(rawParams)) params = Number(rawParams)
      else if (rawParams.charAt(0) === '{') {
        try { params = JSON.parse(rawParams) } catch {
          const box = document.getElementById('eco-i18n-result')
          if (box) box.innerHTML = `<div class="eco-action-result err">参数不是合法 JSON</div>`
          return
        }
      }
    }
    const id = ecoI18nSelected
    // 顺带对每个可用语言都问一次 —— 这就是「这个 key 在哪个语言包里缺了」的答案。
    // 主结果所在 locale 若本来就在声明列表里，直接复用它，不做重复请求（N 次而不是 N+1）。
    const locales: string[] = (ecoI18nInfo && ecoI18nInfo.locales) || []
    const primary: string | undefined = ecoI18nMsgLocale || (ecoI18nInfo && ecoI18nInfo.locale) || undefined
    const queryLocales = locales.slice()
    if (primary && queryLocales.indexOf(primary) < 0) queryLocales.unshift(primary)
    if (queryLocales.length === 0) {
      const box = document.getElementById('eco-i18n-result')
      if (box) box.innerHTML = `<div class="eco-action-result err">该实例未声明任何 locale</div>`
      return
    }
    const tasks = queryLocales.map(l =>
      sendToPage('COMPELEM_DEVTOOLS_RESOLVE_I18N_KEY', { id, key, params, locale: l }))
    Promise.all(tasks).then(rs => {
      if (id !== ecoI18nSelected) return
      const mainIdx = primary ? queryLocales.indexOf(primary) : 0
      ecoI18nResolve = rs[mainIdx >= 0 ? mainIdx : 0]
      ecoI18nCoverage = locales.map(l => Object.assign({ locale: l }, rs[queryLocales.indexOf(l)] || {}))
      const box = document.getElementById('eco-i18n-result')
      if (box) box.innerHTML = renderI18nResolveResult()
      // 覆盖表是独立的 section，整体重渲染会丢输入焦点 → 只补这一段
      renderI18nCoverageSection()
    }).catch(() => {
      ecoI18nResolve = { found: false, error: '解析失败' }
      const box = document.getElementById('eco-i18n-result')
      if (box) box.innerHTML = renderI18nResolveResult()
    })
  }

  /** 只更新「语言覆盖」小节，避免整体重绘导致输入框失焦 */
  function renderI18nCoverageSection() {
    const detail = document.getElementById('eco-detail')
    if (!detail) return
    let box = document.getElementById('eco-coverage-section')
    if (ecoI18nCoverage.length === 0) {
      if (box) box.remove()
      return
    }
    const html = `<div class="state-section" data-section="coverage" id="eco-coverage-section">
      <div class="state-section-header"><span class="state-section-label">语言覆盖</span>
      <span class="state-section-count">${ecoI18nCoverage.length}</span><span class="state-section-arrow">▼</span></div>
      <div class="state-section-body">${ecoI18nCoverage.map(c => `
        <div class="eco-action-row">
          <span class="eco-action-name">${escapeHtml(c.locale)}</span>
          ${c.found
        ? `<span class="eco-tag ok">命中于 ${escapeHtml(c.foundIn || c.locale)}</span>`
        : `<span class="eco-tag err">缺失</span>`}
          <span class="eco-mut-diff">${escapeHtml(c.value === undefined ? '' : String(c.value))}</span>
        </div>`).join('')}</div></div>`
    if (box) {
      box.outerHTML = html
    } else {
      // 首次插入：放在 Messages 小节之前
      const anchor = detail.querySelector('#eco-detail [data-section="messages"]')
      const holder = document.createElement('div')
      holder.innerHTML = html
      if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(holder.firstElementChild!, anchor)
      else detail.appendChild(holder.firstElementChild!)
    }
  }

  function subscribeEcoI18n(on: boolean) {
    if (!on) {
      if (ecoI18nHeartbeat != null) {
        clearInterval(ecoI18nHeartbeat)
        ecoI18nHeartbeat = null
        sendToPage('COMPELEM_DEVTOOLS_UNSUBSCRIBE', { types: ['locale'] }).catch(() => { })
      }
      return
    }
    if (ecoI18nHeartbeat != null) return
    sendToPage('COMPELEM_DEVTOOLS_SUBSCRIBE', { types: ['locale'] }).catch(() => { })
    ecoI18nHeartbeat = window.setInterval(() => {
      if (state.currentTab !== 'eco' || ecoSeg !== 'i18n') { subscribeEcoI18n(false); return }
      sendToPage('COMPELEM_DEVTOOLS_SUBSCRIBE', { types: ['locale'] }).catch(() => { })
    }, 5000)
  }

  function refreshEcoStoreList() {
    const list = document.getElementById('eco-list')!
    const title = document.getElementById('eco-list-title')
    if (title) title.textContent = 'Store'
    // off = compelem-store 未加载；half = 已加载但还没建 store —— 都不必再问一次
    if (ecoDepState('store') !== 'ok') {
      setEcoListHeader('Store', '')
      setEcoDetailHeader('Store 详情')
      list.innerHTML = ecoHintHtml('store', '尚未创建 store 实例')
      document.getElementById('eco-detail')!.innerHTML =
        ecoDepHtml('store', '调用 <code>defineStore(...)</code> 后在此查看 state')
      ecoStores = []
      ecoSelectedStore = null
      subscribeEcoStore(false)
      return
    }
    sendToPage('COMPELEM_DEVTOOLS_GET_STORES').then(stores => {
      ecoStores = Array.isArray(stores) ? stores : []
      const count = document.getElementById('eco-list-count')
      if (count) count.textContent = ecoStores.length ? ecoStores.length + ' stores' : ''
      if (ecoStores.length === 0) {
        // 兜底：探测与取值之间 store 被 dispose
        list.innerHTML = ecoHintHtml('store', '尚未创建 store 实例')
        setEcoDetailHeader('Store 详情')
        document.getElementById('eco-detail')!.innerHTML =
          ecoDepHtml('store', '调用 <code>defineStore(...)</code> 后在此查看 state')
        ecoSelectedStore = null
        subscribeEcoStore(false)
        return
      }
      list.innerHTML = ecoStores.map(s => `
        <div class="list-item ${s.id === ecoSelectedStore ? 'selected' : ''}" data-store-id="${escapeHtml(s.id)}">
          <span class="list-item-tag" style="color:var(--tag-store)">${escapeHtml(s.id)}</span>
          <span class="list-item-cid">${s.stateKeys.length}</span>
        </div>`).join('')
      list.querySelectorAll('.list-item').forEach(el => {
        el.addEventListener('click', () => selectStore((el as HTMLElement).dataset.storeId!))
      })

      // 已选中的 store 被 dispose 掉时回退到第一个
      const stillThere = ecoSelectedStore && ecoStores.some(s => s.id === ecoSelectedStore)
      if (!stillThere) selectStore(ecoStores[0].id)
      else { refreshStoreInspector(); loadStoreMutations() }
      subscribeEcoStore(true)
    }).catch(() => {
      list.innerHTML = `<div class="empty-state"><div>获取 store 列表失败</div></div>`
    })
  }

  function selectStore(id: string) {
    ecoSelectedStore = id
    // 只更新选中态，不重新拉列表（避免重入）
    document.querySelectorAll('#eco-list .list-item').forEach(el => {
      el.classList.toggle('selected', (el as HTMLElement).dataset.storeId === id)
    })
    ecoMutations = []
    ecoActionResult = null
    refreshStoreInspector()
    loadStoreMutations()
  }

  function refreshStoreInspector() {
    const detail = document.getElementById('eco-detail')!
    if (!ecoSelectedStore) {
      detail.innerHTML = `<div class="empty-state"><div class="empty-icon">📦</div><div>从左侧选择一个 store</div></div>`
      return
    }
    const storeId = ecoSelectedStore
    sendToPage('COMPELEM_DEVTOOLS_GET_STORE_STATE', { id: storeId }).then(snapshot => {
      // 期间用户可能又换了目标，丢弃过期响应
      if (storeId !== ecoSelectedStore) return
      if (!snapshot || !snapshot.data) {
        detail.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div>获取 store 状态失败</div></div>`
        return
      }
      renderStoreDetail(ecoStores.find(s => s.id === storeId), snapshot)
    }).catch(() => {
      if (storeId !== ecoSelectedStore) return
      detail.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div>获取 store 状态失败</div></div>`
    })
  }

  function renderStoreDetail(meta: any, snapshot: any) {
    const detail = document.getElementById('eco-detail')!
    const id = ecoSelectedStore!
    document.getElementById('eco-detail-title')!.textContent = 'Store 详情'
    document.getElementById('eco-detail-actions')!.innerHTML = `
      <button class="eco-btn" id="eco-refresh">刷新</button>
      <button class="eco-btn" id="eco-reset">Reset</button>
      <button class="eco-btn danger" id="eco-clear-mut">清空记录</button>`

    let html = `
      <div class="eco-head">
        <div class="eco-head-title"><span>${escapeHtml(id)}</span></div>
        <div class="eco-head-meta">
          <span class="eco-chip">slotKey: ${escapeHtml((meta && meta.slotKey) || '-')}</span>
          <span class="eco-chip">state ${meta ? meta.stateKeys.length : 0}</span>
          <span class="eco-chip">getters ${meta ? meta.getters.length : 0}</span>
          <span class="eco-chip">actions ${meta ? meta.actions.length : 0}</span>
        </div>
      </div>`

    html += renderStateSection('state', 'State', snapshot.data, true, id)
    if (snapshot.getters && Object.keys(snapshot.getters).length > 0) {
      // 必须带上 storeId：否则会退化成组件归属（data-cid + cid 前缀的 keyPath），
      // 既与 State 区的 data-store 不一致，也会让 getter 的键空间与组件键撞车
      html += renderStateSection('computed', 'Getters', snapshot.getters, false, id)
    }

    if (meta && meta.actions.length > 0) {
      html += `<div class="state-section" data-section="actions">
        <div class="state-section-header"><span class="state-section-label">Actions</span>
        <span class="state-section-count">${meta.actions.length}</span>
        <span class="state-section-arrow">▼</span></div>
        <div class="state-section-body">`
      meta.actions.forEach((a: string) => {
        html += `<div class="eco-action-row">
          <span class="eco-action-name">${escapeHtml(a)}()</span>
          <input class="eco-action-args" data-action-args="${escapeHtml(a)}" placeholder="参数 JSON，如 [1,&quot;x&quot;]">
          <button class="eco-btn" data-call-action="${escapeHtml(a)}">调用</button>
        </div>`
      })
      html += `</div></div><div id="eco-action-result"></div>`
    }

    html += `<div class="state-section" data-section="mutations">
      <div class="state-section-header"><span class="state-section-label">Mutations</span>
      <span class="state-section-count" id="eco-mut-count">0</span>
      <span class="state-section-arrow">▼</span></div>
      <div class="state-section-body" id="eco-mut-body"></div>
    </div>`
    html += `<div class="eco-warn">回滚用的是变更时的<b>浅快照</b>（<code>{...state}</code>）：顶层标量可靠；嵌套对象 / 数组是共享引用，若已被原地改写则回滚不回去。</div>`

    detail.innerHTML = html
    // 详情是整块重建的，上一次的调用结果要回填，否则会被这次重建抹掉
    const resultEl = document.getElementById('eco-action-result')
    if (resultEl && ecoActionResult) {
      resultEl.innerHTML = `<div class="eco-action-result ${ecoActionResult.ok ? '' : 'err'}">${escapeHtml(ecoActionResult.text)}</div>`
    }
    bindInspectorInteractions(detail)
    bindStoreActions()
    renderStoreMutations()
  }

  function bindStoreActions() {
    document.getElementById('eco-refresh')?.addEventListener('click', () => {
      refreshStoreInspector()
      loadStoreMutations()
    })
    document.getElementById('eco-reset')?.addEventListener('click', () => {
      if (!ecoSelectedStore) return
      sendToPage('COMPELEM_DEVTOOLS_RESET_STORE', { id: ecoSelectedStore })
        .then(() => { refreshStoreInspector(); loadStoreMutations() })
        .catch(() => { })
    })
    document.getElementById('eco-clear-mut')?.addEventListener('click', () => {
      sendToPage('COMPELEM_DEVTOOLS_CLEAR_STORE_MUTATIONS').then(() => {
        ecoMutations = []
        renderStoreMutations()
      }).catch(() => { })
    })

    document.querySelectorAll('[data-call-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = (btn as HTMLElement).dataset.callAction!
        const row = btn.closest('.eco-action-row')
        const input = row ? row.querySelector('.eco-action-args') as HTMLInputElement | null : null
        const raw = (input && input.value ? input.value : '').trim()
        let args: any[] = []
        if (raw) {
          try {
            const parsed = JSON.parse(raw)
            args = Array.isArray(parsed) ? parsed : [parsed]
          } catch {
            showActionResult(false, action + '：参数不是合法 JSON → ' + raw)
            return
          }
        }
        const el = btn as HTMLButtonElement
        el.classList.add('running')
        sendToPage('COMPELEM_DEVTOOLS_CALL_STORE_ACTION', { id: ecoSelectedStore, action, args })
          .then(rs => {
            el.classList.remove('running')
            if (rs && rs.ok) showActionResult(true, action + '(' + raw + ') → ' + JSON.stringify(rs.result))
            else showActionResult(false, action + ' 调用失败：' + ((rs && rs.error) || '未知错误'))
            refreshStoreInspector()
            loadStoreMutations()
          })
          .catch(() => {
            el.classList.remove('running')
            showActionResult(false, action + ' 调用失败：通道异常')
          })
      })
    })
  }

  function showActionResult(ok: boolean, text: string) {
    ecoActionResult = { ok: ok, text: text }
    const el = document.getElementById('eco-action-result')
    if (!el) return
    el.innerHTML = `<div class="eco-action-result ${ok ? '' : 'err'}">${escapeHtml(text)}</div>`
  }

  function loadStoreMutations() {
    if (!ecoSelectedStore) return
    const storeId = ecoSelectedStore
    sendToPage('COMPELEM_DEVTOOLS_GET_STORE_MUTATIONS').then(all => {
      if (storeId !== ecoSelectedStore) return
      ecoMutations = (Array.isArray(all) ? all : []).filter((m: any) => m.storeId === storeId)
      renderStoreMutations()
    }).catch(() => { })
  }

  /** 变更值的纯文本表示（不能复用 formatValue，它返回带标签的 HTML） */
  function formatPlain(v: any): string {
    if (v === undefined) return 'undefined'
    if (v === null) return 'null'
    if (typeof v === 'string') return '"' + v + '"'
    try { return JSON.stringify(v) ?? String(v) } catch { return String(v) }
  }

  function renderStoreMutations() {
    const body = document.getElementById('eco-mut-body')
    if (!body) return
    const countEl = document.getElementById('eco-mut-count')
    if (countEl) countEl.textContent = String(ecoMutations.length)
    if (ecoMutations.length === 0) {
      body.innerHTML = `<div class="eco-hint" style="padding:12px">还没有捕获到变更。<br>订阅期间改动该 store 即会出现在这里。</div>`
      return
    }
    body.innerHTML = ecoMutations.slice().reverse().map((m: any) => `
      <div class="eco-mut-item">
        <span class="eco-mut-time">${new Date(m.timestamp).toLocaleTimeString()}</span>
        <span class="eco-mut-key" title="${escapeHtml(m.key)}">${escapeHtml(m.key)}</span>
        <span class="eco-mut-diff"><span class="old">${escapeHtml(formatPlain(m.oldValue))}</span> → <span class="new">${escapeHtml(formatPlain(m.newValue))}</span></span>
        <button class="eco-btn" data-rollback="${m.seq}">回滚</button>
      </div>`).join('')

    body.querySelectorAll('[data-rollback]').forEach(btn => {
      btn.addEventListener('click', () => {
        const seq = parseInt((btn as HTMLElement).dataset.rollback!)
        sendToPage('COMPELEM_DEVTOOLS_APPLY_STORE_SNAPSHOT', { id: ecoSelectedStore, seq }).then(rs => {
          if (rs && rs.ok) { refreshStoreInspector(); loadStoreMutations() }
          else showActionResult(false, '回滚失败：' + ((rs && rs.error) || '未知错误'))
        }).catch(() => showActionResult(false, '回滚失败：通道异常'))
      })
    })
  }

  /**
   * store 的变更推送需要页面侧真正挂钩子。injected 侧用「心跳 + 看门狗」兜底：
   * 面板订阅期间每 5s 重发一次 SUBSCRIBE（幂等），面板一关就自动摘钩。
   */
  function subscribeEcoStore(on: boolean) {
    if (!on) {
      if (ecoStoreHeartbeat != null) {
        clearInterval(ecoStoreHeartbeat)
        ecoStoreHeartbeat = null
        sendToPage('COMPELEM_DEVTOOLS_UNSUBSCRIBE', { types: ['store'] }).catch(() => { })
      }
      return
    }
    if (ecoStoreHeartbeat != null) return
    sendToPage('COMPELEM_DEVTOOLS_SUBSCRIBE', { types: ['store'] }).catch(() => { })
    ecoStoreHeartbeat = window.setInterval(() => {
      if (state.currentTab !== 'eco') { subscribeEcoStore(false); return }
      sendToPage('COMPELEM_DEVTOOLS_SUBSCRIBE', { types: ['store'] }).catch(() => { })
    }, 5000)
  }

  // ---------------- 生态页签切换（Store / Router / I18n 共用 #tab-eco） ----------------
  /**
   * 切到某个生态页签：切 tab + 切分段 + 刷新。
   * 重复点击同一项等价于刷新一次（保留「再点一下刷新」的直觉）。
   */
  function switchEcoTab(seg: string) {
    if (!isEcoSeg(seg)) return
    setActiveTab('eco', seg)
    ecoSeg = seg
    // 只挂当前分段的页面侧钩子，避免三个订阅同时挂着
    subscribeEcoStore(seg === 'store')
    subscribeEcoRouter(seg === 'router')
    subscribeEcoI18n(seg === 'i18n')
    refreshEco()
  }

  // ---------------- 工具函数 ----------------
  function escapeHtml(str: string): string {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function getValueType(v: any): string {
    if (v === undefined) return 'undefined'
    if (v === null) return 'null'
    if (typeof v === 'string') return 'string'
    if (typeof v === 'number') return 'number'
    if (typeof v === 'boolean') return 'boolean'
    if (typeof v === 'function') return 'function'
    if (Array.isArray(v)) return 'array'
    if (typeof v === 'object') return 'object'
    return 'unknown'
  }

  function formatValue(v: any): string {
    if (v === null) return `<span class="v-null">null</span>`
    if (v === undefined) return `<span class="v-null">undefined</span>`
    const t = getValueType(v)
    switch (t) {
      case 'string': return `<span class="v-string">"${escapeHtml(v)}"</span>`
      case 'number': return `<span class="v-number">${v}</span>`
      case 'boolean': return `<span class="v-boolean">${v}</span>`
      case 'function': return `<span class="v-function">[Fn:${v.name || 'anonymous'}]</span>`
      // object / array：用单行 JSON 字符串替代之前的 Array(N) / {N keys}
      case 'array':
      case 'object': {
        let s: string
        try { s = JSON.stringify(v) } catch { s = String(v) }
        if (s.length > 160) s = s.slice(0, 160) + '…'
        return `<span class="v-json">${escapeHtml(s)}</span>`
      }
      default: return escapeHtml(String(v))
    }
  }

  /** 完整格式化 JSON（缩进 2 空格），用于 hover tooltip 和展开面板 */
  function formatJsonFull(v: any): string {
    try { return JSON.stringify(v, null, 2) } catch { return String(v) }
  }

  // ---------------- 顶部工具栏 ----------------
  document.getElementById('btn-refresh')!.addEventListener('click', () => {
    refreshComponentTree()
    refreshCurrentTab()
  })

  document.getElementById('btn-clear')!.addEventListener('click', () => {
    sendToPage('COMPELEM_DEVTOOLS_CLEAR_EVENTS')
    state.stats = { updates: 0, events: 0, lifecycle: 0 }
    updateBadge('timeline', 0)
    updateBadge('events', 0)
    refreshCurrentTab()
  })

  // 搜索：只做本地重渲染。旧实现 debounce 后再调 refreshComponentTree()，
  // 等于每敲一个字就走一次 eval 全树扫描，大页面上会明显卡顿
  document.getElementById('search-filter')!.addEventListener('input', (e) => {
    state.filter = (e.target as HTMLInputElement).value
    renderTree()
  })

  // 鼠标离开组件树 → 清掉悬浮高亮（仅当选中的组件还保留高亮）。
  // 注意：必须绑在持久的 #tree-view 容器上 —— renderTree 会整体重建 innerHTML，
  // 悬浮中的节点被销毁时其 mouseleave 不会触发，高亮会残留（这是「离开后仍高亮
  // 最后悬浮组件」的根因）。容器只在 init 时绑一次，避免 renderTree 重复叠加。
  document.getElementById('tree-view')!.addEventListener('mouseleave', () => {
    if (state.selectedCid != null) {
      sendToPage('COMPELEM_DEVTOOLS_HIGHLIGHT', { cid: state.selectedCid }).catch(() => { })
    } else {
      sendToPage('COMPELEM_DEVTOOLS_UNHIGHLIGHT', {}).catch(() => { })
    }
  })

  // Inspector actions
  document.getElementById('btn-force-update')?.addEventListener('click', () => {
    if (state.selectedCid != null) {
      sendToPage('COMPELEM_DEVTOOLS_FORCE_UPDATE', { cid: state.selectedCid })
      setTimeout(refreshStateInspector, 200)
    }
  })

  // ---------------- 启动 ----------------
  // ---------------- bridge 可用性探测 ----------------
  // content script 已改为按需注入（页面打标才注入），老版本 compelem 不打标，
  // 因此面板打开时要主动兜一次：先 PING，拿不到就要求 content script 注入再重试。
  // 返回 PING 响应（含 hasCore），拿不到 bridge 时返回 null
  async function pingBridge(): Promise<any> {
    try {
      const r = await sendToPage('COMPELEM_DEVTOOLS_PING')
      return (r && !r.__noBridge && r.pong) ? r : null
    } catch { return null }
  }

  function forceInject(): Promise<void> {
    return new Promise((resolve) => {
      const tabId = chrome.devtools?.inspectedWindow?.tabId
      if (!tabId) { resolve(); return }
      try {
        chrome.tabs.sendMessage(tabId, { type: 'COMPELEM_DEVTOOLS_FORCE_INJECT' }, function () {
          void chrome.runtime.lastError
          resolve()
        })
      } catch { resolve() }
    })
  }

  /** 面板直接把 injected 脚本插到页面（绕过 content script 失效场景） */
  function directInjectInjectedScript(): Promise<boolean> {
    return new Promise((resolve) => {
      const injectedUrl = chrome.runtime.getURL('injected/index.js')
      const expr = `
        (function() {
          if (window.__COMPELEM_DEVTOOLS__) return 'already';
          return new Promise(function(resolve) {
            var s = document.createElement('script');
            s.id = 'compelem-devtools-injected';
            s.src = ${JSON.stringify(injectedUrl)};
            s.onload = function() { resolve('loaded'); };
            s.onerror = function() { resolve('error'); };
            try { (document.head || document.documentElement).appendChild(s); }
            catch(e) { resolve('error'); }
          });
        })()
      `
      try {
        chrome.devtools.inspectedWindow.eval(expr, (result) => {
          // Promise 被 eval 执行后 result 可能是 Promise 对象或字符串
          if (result && typeof result.then === 'function') {
            result.then((v: any) => resolve(v === 'loaded' || v === 'already')).catch(() => resolve(false))
          } else {
            resolve(result === 'loaded' || result === 'already')
          }
        })
      } catch { resolve(false) }
    })
  }

  async function ensureBridge(): Promise<any> {
    let r = await pingBridge()
    if (r) return r

    // 路径 1：走 content script 的 FORCE_INJECT（需要 content script 正在运行）
    if (chrome.tabs?.sendMessage) {
      await forceInject()
      for (let i = 0; i < 4; i++) {
        await new Promise(res => setTimeout(res, 150))
        r = await pingBridge()
        if (r) return r
      }
    }

    // 路径 2（兜底）：content script 可能完全没在跑 —— 面板直接 eval 注入 injected 脚本
    // 这是 Vue DevTools 也用的 fallback：devtools 上下文有权限把 web_accessible_resources 注入页面
    const injected = await directInjectInjectedScript()
    if (injected) {
      for (let i = 0; i < 3; i++) {
        await new Promise(res => setTimeout(res, 200))
        r = await pingBridge()
        if (r) return r
      }
    }

    return null
  }

  function showNoLibraryHint() {
    const host = document.getElementById('tree-view')
    if (host) {
      host.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🔌</div>
          <div>未检测到 compelem</div>
          <div style="font-size:11px;margin-top:6px;line-height:1.6;">
            本页未发现 compelem 框架，或页面在扩展启用前已加载。<br>
            请确认页面已引入 compelem，然后刷新页面重试。
          </div>
        </div>`
    }
    const cnt = document.getElementById('component-count')
    if (cnt) cnt.textContent = '0 components'
  }

  function init() {
    // 主题初始化（从 localStorage 恢复，默认 dark）
    const savedTheme = localStorage.getItem('compelem-devtools-theme') || 'dark'
    document.documentElement.setAttribute('data-theme', savedTheme)

    // 主题切换按钮
    const themeBtn = document.getElementById('theme-toggle')
    themeBtn?.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark'
      const next = current === 'dark' ? 'light' : 'dark'
      document.documentElement.setAttribute('data-theme', next)
      localStorage.setItem('compelem-devtools-theme', next)
    })

    connect()
    // 订阅推送
    sendToPage('COMPELEM_DEVTOOLS_SUBSCRIBE', { types: ['updates', 'events', 'state', 'tree'] }).catch(() => { })
    // 首次刷新
    setTimeout(async () => {
      const ping = await ensureBridge()
      // hasCore === false 才判定「页面没有 compelem」；字段缺失（老 bridge / 探针 stub）按未知处理，照常刷新
      if (ping && ping.hasCore === false) { showNoLibraryHint(); return }
      refreshComponentTree()
      refreshCurrentTab()
      // 左侧 Store / Router / I18n 的状态点：不依赖当前页签，启动就先探一次
      refreshEcoAvailability()
    }, 300)

    // 自动刷新开关（手动/自动切换）
    const autoBtn = document.getElementById('auto-refresh-toggle')!
    const autoDot = document.getElementById('auto-refresh-dot')!
    const autoLabel = document.getElementById('auto-refresh-label')!
    function updateAutoUI() {
      autoDot.classList.toggle('on', state.autoRefresh)
      autoLabel.textContent = state.autoRefresh ? '自动' : '手动'
    }
    autoBtn.addEventListener('click', () => {
      state.autoRefresh = !state.autoRefresh
      updateAutoUI()
      if (state.autoRefresh) {
        refreshComponentTree()
        refreshEcoAvailability()
      }
    })
    updateAutoUI()

    // 定时轮询（作为推送的补充）
    setInterval(() => {
      if (state.autoRefresh && document.visibilityState === 'visible') {
        refreshComponentTree()
        refreshEcoAvailability()
      }
    }, 5000)

    // UI 就绪：面板打开前发生的右键定位在这里补选中
    state.uiReady = true
    if (state.pendingLocateCid != null) {
      const cid = state.pendingLocateCid
      state.pendingLocateCid = null
      locateComponent(cid)
    }
  }

  init()
})()
