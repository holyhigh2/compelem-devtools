(function () {
  'use strict'

  var DEVTOOLS_ID = 'compelem-devtools-injected'
  // 扩展在页面上的「举手」标记：库侧靠它判断用户有没有装扩展
  var DEVTOOLS_MARK = 'data-compelem-devtools'
  // 库侧反向标记：compel 加载期会在 <html> 上写 data-compelem="<协议版本>"
  var LIB_MARK = 'data-compelem'

  var EXT_VERSION = '0'
  try { EXT_VERSION = chrome.runtime.getManifest().version } catch (e) { /* noop */ }

  var injected = false

  function docEl() {
    try { return document.documentElement } catch (e) { return null }
  }

  function stamp(state) {
    var de = docEl()
    if (!de) return false
    try { de.setAttribute(DEVTOOLS_MARK, state + ':' + EXT_VERSION); return true } catch (e) { return false }
  }

  // document_start 同步打标，早于任何页面脚本 —— 这是「未安装提示」能正确工作的前提
  if (!stamp('pending') && document.readyState === 'loading') {
    document.addEventListener('readystatechange', function () { stamp('pending') }, { once: true })
  }

  function injectScript() {
    if (injected) return
    injected = true
    try {
      if (document.getElementById(DEVTOOLS_ID)) return
      var script = document.createElement('script')
      script.id = DEVTOOLS_ID
      script.src = chrome.runtime.getURL('injected/index.js')
      script.onload = function () { this.remove() }
      script.onerror = function () { console.error('[Compelem DevTools] Injected script load failed') }
        ; (document.head || document.documentElement).appendChild(script)
    } catch (e) { /* noop */ }
  }

  function libPresent() {
    var de = docEl()
    try { return !!(de && de.hasAttribute(LIB_MARK)) } catch (e) { return false }
  }

  // 老版本 compelem 不打标，用「页面里存在自定义元素」做二次探测
  function hasCustomElement() {
    try {
      var all = document.getElementsByTagName('*')
      for (var i = 0; i < all.length; i++) {
        var t = all[i].tagName
        if (t && t.indexOf('-') > 0) return true
      }
    } catch (e) { /* noop */ }
    return false
  }

  function reportDetected(reason) {
    try {
      chrome.runtime.sendMessage({ type: 'COMPELEM_DEVTOOLS_PAGE_DETECTED', payload: { reason: reason } }, function () {
        void chrome.runtime.lastError
      })
    } catch (e) { void chrome.runtime.lastError }
  }

  // ---- 按需注入：非 compelem 页面完全不注入，避免污染与无谓开销 ----
  if (libPresent()) {
    injectScript()
    reportDetected('mark')
  } else {
    try {
      var obs = new MutationObserver(function () {
        if (!libPresent()) return
        obs.disconnect()
        injectScript()
        reportDetected('mark')
      })
      obs.observe(docEl() || document, { attributes: true, attributeFilter: [LIB_MARK] })
    } catch (e) {
      injectScript() // 观察不了就退回无条件注入
    }
    // 兜底探测：DOM 就绪 + 一段延迟后，若页面已有自定义元素则注入（覆盖不打标的老库）
    var tryScan = function () {
      if (injected) return
      if (hasCustomElement()) { injectScript(); reportDetected('element') }
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { setTimeout(tryScan, 300) })
    } else {
      setTimeout(tryScan, 300)
    }
  }

  // background 连接（可选）：只用于推送消息
  // 360 等浏览器 MV3 Service Worker 可能不工作，静默失败即可
  var bgPort = null

  function tryConnect() {
    try {
      // lastError 可能在此被同步设置但不抛异常
      bgPort = chrome.runtime.connect({ name: 'compelem-content' })
      // 立即清空 lastError，防止 "Unchecked runtime.lastError"
      void chrome.runtime.lastError
      if (!bgPort) { bgPort = null; return }

      bgPort.onMessage.addListener(function (msg) {
        if (msg && msg.type && msg.type.indexOf('COMPELEM_DEVTOOLS_') === 0) {
          window.postMessage(msg, '*')
        }
      })

      bgPort.onDisconnect.addListener(function () {
        void chrome.runtime.lastError
        bgPort = null
      })
    } catch (e) {
      void chrome.runtime.lastError
      bgPort = null
    }
  }

  // 尝试连接（静默，失败不重试、不报错）
  tryConnect()

  // 延迟再试一次（有些浏览器 SW 启动慢）
  setTimeout(tryConnect, 1500)

  // ---------------- background → 页面（右键菜单等主动指令）----------------
  // 走 runtime.onMessage 而不是 port：port 在 SW 休眠后会断开，onMessage 可以直接唤醒 SW
  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || typeof msg.type !== 'string') return
      if (msg.type.indexOf('COMPELEM_DEVTOOLS_') !== 0) return
      // 面板在页面上没找到 bridge 时主动要求注入（覆盖不打标的老库）
      if (msg.type === 'COMPELEM_DEVTOOLS_FORCE_INJECT') {
        injectScript()
        try { sendResponse({ injected: true, libPresent: libPresent() }) } catch (e) { /* noop */ }
        return
      }
      try { window.postMessage(msg, '*') } catch (e) { /* noop */ }
    })
  } catch (e) { /* noop */ }

  // ---------------- 页面 → 投递结果提示 ----------------
  // 只发给页面、不需要再转给 background 的消息类型（防止回声）
  var PAGE_ONLY = { COMPELEM_DEVTOOLS_SHOW_TOAST: 1 }

  function componentLabel(payload) {
    if (!payload) return '组件'
    var tag = payload.tagName ? '<' + payload.tagName + '>' : '组件'
    return payload.cid != null && payload.cid >= 0 ? tag + ' #' + payload.cid : tag
  }

  function showToast(payload) {
    try { window.postMessage({ type: 'COMPELEM_DEVTOOLS_SHOW_TOAST', payload: payload }, '*') } catch (e) { /* noop */ }
  }

  // 页面解析出 cid 后，交给 background 投递给面板；投递不到就记录 + 引导
  function reportLocate(payload) {
    var label = componentLabel(payload)
    // 子 frame 的 cid 空间独立，面板树只展示主框架组件 → 明确拒绝，避免选中错组件
    if (window !== window.top) {
      showToast({ text: '暂不支持在 iframe 内定位（组件树仅展示主框架）', kind: 'warn' })
      return
    }
    try {
      chrome.runtime.sendMessage({ type: 'COMPELEM_DEVTOOLS_LOCATE_COMPONENT', payload: payload }, function (resp) {
        void chrome.runtime.lastError
        var delivered = !!(resp && resp.delivered)
        showToast({
          text: delivered ? ('已定位 ' + label) : ('已记录 ' + label + '，请打开 DevTools 的 Compelem 面板'),
          kind: delivered ? 'info' : 'warn'
        })
      })
    } catch (e) {
      void chrome.runtime.lastError
      showToast({ text: '已记录 ' + label + '，请打开 DevTools 的 Compelem 面板', kind: 'warn' })
    }
  }

  // 页面 → background 转发（用于推送）
  // 请求-响应完全由 panel 用 eval 直接调 injected，不走这里
  window.addEventListener('message', function (event) {
    if (event.source !== window) return
    var msg = event.data
    if (!msg || !msg.type || typeof msg.type !== 'string') return
    if (msg.type.indexOf('COMPELEM_DEVTOOLS_') !== 0) return

    // bridge 挂载成功：标记从 pending 转为 ready，库侧据此判定「已安装且可用」
    if (msg.type === 'COMPELEM_DEVTOOLS_BRIDGE_READY') {
      stamp('ready')
      reportDetected('bridge')
      return
    }
    // 右键定位：走 runtime.sendMessage 拿投递结果（能唤醒休眠 SW，比 port 稳）
    if (msg.type === 'COMPELEM_DEVTOOLS_LOCATE_COMPONENT') {
      reportLocate(msg.payload)
      return
    }
    if (PAGE_ONLY[msg.type]) return

    // 只转发给 background（panel 的请求走 eval 直接到 injected）
    // injected 的推送消息如果 bgPort 不在，直接丢弃即可
    if (!bgPort) return
    try { bgPort.postMessage(msg) } catch (e) { }
  })

})()
