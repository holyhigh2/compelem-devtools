import type { BridgeMessage } from './types'

let messageCallback: ((msg: BridgeMessage) => void) | null = null
let pendingRequests: Map<number, { resolve: (v: any) => void, reject: (e: any) => void }> = new Map()
let requestId = 0

export function initBridge() {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const msg = event.data as BridgeMessage
    if (!msg || !msg.type) return
    if (msg.type.startsWith('COMPELEM_DEVTOOLS_')) {
      if (msg.id && pendingRequests.has(msg.id)) {
        const pending = pendingRequests.get(msg.id)!
        pendingRequests.delete(msg.id)
        pending.resolve(msg.payload)
      }
      messageCallback?.(msg)
    }
  })
}

export function onMessage(cb: (msg: BridgeMessage) => void) {
  messageCallback = cb
}

export function sendToPage(type: string, payload?: any): Promise<any> {
  const id = ++requestId
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject })
    window.postMessage({ type, payload, id }, '*')
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id)
        reject(new Error(`Timeout waiting for response to ${type}`))
      }
    }, 5000)
  })
}

export function sendToBackground(type: string, payload?: any) {
  chrome.runtime.sendMessage({ type, payload })
}

export function onBackgroundMessage(cb: (msg: BridgeMessage) => void) {
  chrome.runtime.onMessage.addListener((msg: BridgeMessage) => {
    if (msg && msg.type) cb(msg)
  })
}
