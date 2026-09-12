// Background Service Worker — listeners must be registered synchronously at top level

console.log('[Compelem DevTools] Background script started')

var panelByTab = {}
var contentByTab = {}

// ---------------- 右键菜单 ----------------
// 页面右键 → 直接定位到面板组件树 / 页面内高亮
var MENU_LOCATE = 'compelem-devtools-locate'
var MENU_HIGHLIGHT = 'compelem-devtools-highlight'

function registerMenus() {
  try {
    chrome.contextMenus.removeAll(function () {
      void chrome.runtime.lastError
      try {
        chrome.contextMenus.create({ id: MENU_LOCATE, title: '在 Compelem 组件树中定位', contexts: ['all'] })
      } catch (e) { /* noop */ }
    })
  } catch (e) { /* noop */ }
}

// SW 每次启动都重建（removeAll + create 幂等，避免 duplicate id 报错）
registerMenus()
chrome.runtime.onInstalled.addListener(registerMenus)

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (!tab || tab.id == null) return
  var type = null
  if (info.menuItemId === MENU_LOCATE) type = 'COMPELEM_DEVTOOLS_LOCATE_CONTEXT_TARGET'
  else if (info.menuItemId === MENU_HIGHLIGHT) type = 'COMPELEM_DEVTOOLS_HIGHLIGHT_CONTEXT_TARGET'
  if (!type) return

  var frameId = info.frameId == null ? 0 : info.frameId
  try {
    chrome.tabs.sendMessage(tab.id, { type: type, payload: { frameId: frameId } }, { frameId: frameId }, function () {
      void chrome.runtime.lastError
    })
  } catch (e) { /* noop */ }
})

// ---------------- 页面检测到 compelem → 点亮扩展图标 ----------------
// 与 Vue DevTools 一致：图标状态反映「本页能不能用」，减少用户的无效点击
var detectedTabs = {}

function markTab(tabId, detected) {
  if (tabId == null) return
  try {
    chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#4f46e5' })
  } catch (e) { /* noop */ }
  try {
    chrome.action.setBadgeText({ tabId: tabId, text: detected ? 'CE' : '' })
  } catch (e) { /* noop */ }
  try {
    chrome.action.setTitle({
      tabId: tabId,
      title: detected ? 'Compelem DevTools — 本页检测到 compelem' : 'Compelem DevTools — 本页未检测到 compelem'
    })
  } catch (e) { /* noop */ }
}

chrome.runtime.onMessage.addListener(function (msg, sender) {
  if (!msg || msg.type !== 'COMPELEM_DEVTOOLS_PAGE_DETECTED') return
  var tabId = sender && sender.tab && sender.tab.id
  if (tabId != null) detectedTabs[tabId] = true
  markTab(tabId, true)
})

// 导航到新页面时复位，避免上一次的 badge 残留
try {
  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
    if (!changeInfo || changeInfo.status !== 'loading') return
    delete detectedTabs[tabId]
    markTab(tabId, false)
  })
} catch (e) { /* noop */ }

// ---------------- 待定位记录 ----------------
// 面板未连接时先记下来，面板一连上就自动选中
// SW 会被回收，所以同时写一份 chrome.storage.session（内存态，不落盘）
var pendingLocate = {}

function persistPending(tabId, payload) {
  try {
    chrome.storage.session.set({ ['pending_' + tabId]: payload }, function () { void chrome.runtime.lastError })
  } catch (e) { /* noop */ }
}

function clearPersistedPending(tabId) {
  try {
    chrome.storage.session.remove('pending_' + tabId, function () { void chrome.runtime.lastError })
  } catch (e) { /* noop */ }
}

function deliverPending(tabId) {
  var port = panelByTab[tabId]
  if (!port) return

  if (pendingLocate[tabId]) {
    var p = pendingLocate[tabId]
    delete pendingLocate[tabId]
    try { port.postMessage({ type: 'COMPELEM_DEVTOOLS_LOCATE_COMPONENT', payload: p }) } catch (e) { /* noop */ }
    clearPersistedPending(tabId)
    return
  }

  // 内存里没有（SW 被回收过）→ 从 session 恢复
  try {
    chrome.storage.session.get('pending_' + tabId, function (res) {
      void chrome.runtime.lastError
      if (!res) return
      var q = res['pending_' + tabId]
      var live = panelByTab[tabId]
      if (!q || !live) return
      try { live.postMessage({ type: 'COMPELEM_DEVTOOLS_LOCATE_COMPONENT', payload: q }) } catch (e) { /* noop */ }
      clearPersistedPending(tabId)
    })
  } catch (e) { /* noop */ }
}

// ---------------- 页面 → background（右键定位的回传）----------------
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return
  if (msg.type !== 'COMPELEM_DEVTOOLS_LOCATE_COMPONENT') return

  var tabId = sender && sender.tab && sender.tab.id
  if (tabId == null) { sendResponse({ delivered: false }); return }

  var port = panelByTab[tabId]
  var delivered = false
  if (port) {
    try {
      port.postMessage({ type: msg.type, payload: msg.payload })
      delivered = true
    } catch (e) {
      delete panelByTab[tabId]
      port = null
    }
  }

  if (delivered) {
    delete pendingLocate[tabId]
    clearPersistedPending(tabId)
  } else {
    pendingLocate[tabId] = msg.payload
    persistPending(tabId, msg.payload)
  }

  sendResponse({ delivered: delivered })
})

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name === 'compelem-devtools-panel') {
    port.onMessage.addListener(function (msg) {
      if (msg.type === 'COMPELEM_DEVTOOLS_INIT' && msg.payload && msg.payload.tabId) {
        panelByTab[msg.payload.tabId] = port
        // 面板刚连上 → 回放未投递的定位请求
        deliverPending(msg.payload.tabId)
      } else {
        var foundTabId = null
        for (var tid in panelByTab) {
          if (panelByTab[tid] === port) { foundTabId = tid; break }
        }
        if (foundTabId && contentByTab[foundTabId]) {
          try { contentByTab[foundTabId].postMessage(msg) } catch (e) { }
        }
      }
    })
    port.onDisconnect.addListener(function () {
      for (var tid in panelByTab) {
        if (panelByTab[tid] === port) { delete panelByTab[tid]; break }
      }
    })
  }

  if (port.name === 'compelem-content') {
    var cTabId = port.sender && port.sender.tab && port.sender.tab.id
    if (cTabId) {
      contentByTab[cTabId] = port
      port._tabId = cTabId
    }
    port.onMessage.addListener(function (msg) {
      var tid = port._tabId
      if (tid && panelByTab[tid]) {
        try { panelByTab[tid].postMessage(msg) } catch (e) { }
      }
    })
    port.onDisconnect.addListener(function () {
      if (port._tabId) delete contentByTab[port._tabId]
    })
  }
})
