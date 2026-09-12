// ============ Compelem DevTools 类型定义 ============

export interface ComponentInfo {
  cid: number
  tagName: string
  className: string
  props: Record<string, any>
  state: Record<string, any>
  computed: Record<string, any>
  attrs: Record<string, string>
  isMounted: boolean
  isDestroyed: boolean
  parentCid?: number
  wrapperCid?: number
  childCids: number[]
  updatePointCount: number
  cssVarKeys: string[]
  emitEvents: string[]
  hasShadow: boolean
  hasReactive: boolean
}

export interface StateSnapshot {
  cid: number
  data: Record<string, any>
  computedDeps?: Record<string, string[]>
  timestamp: number
}

export interface EventRecord {
  id: number
  cid: number
  tagName: string
  eventName: string
  args: any
  timestamp: number
  duration?: number
  stackTrace?: string
}

export interface UpdateRecord {
  id: number
  cid: number
  tagName: string
  changed: Record<string, any>
  duration: number
  updatePointCount: number
  timestamp: number
  reason?: string
}

export interface DepInfo {
  viewDeps: string[]
  computedDeps: Record<string, string[]>
  cssDeps: string[]
  watchKeys: string[]
  updatePointCount: number
  subViewDeps: Record<string, number>
}

export interface UpdatePointInfo {
  id: string
  deps: string[]
  updateCount: number
  lastUpdateTime: number
  location?: string
}

export interface TimelineRecord {
  id: number
  cid: number
  tagName: string
  type: 'update' | 'event' | 'lifecycle'
  name: string
  duration: number
  timestamp: number
  details?: any
}

export interface PerformanceMetric {
  cid: number
  tagName: string
  updateCount: number
  totalDuration: number
  avgDuration: number
  maxDuration: number
  lastUpdate: number
  fps?: number
}

// ============ 消息协议 ============

export type MessageType =
  | 'COMPELEM_DEVTOOLS_PING'
  | 'COMPELEM_DEVTOOLS_GET_TREE'
  | 'COMPELEM_DEVTOOLS_GET_STATE'
  | 'COMPELEM_DEVTOOLS_SET_STATE'
  | 'COMPELEM_DEVTOOLS_FORCE_UPDATE'
  | 'COMPELEM_DEVTOOLS_HIGHLIGHT'
  | 'COMPELEM_DEVTOOLS_UNHIGHLIGHT'
  | 'COMPELEM_DEVTOOLS_SCROLL'
  | 'COMPELEM_DEVTOOLS_GET_DEPS'
  | 'COMPELEM_DEVTOOLS_GET_UPDATE_POINTS'
  | 'COMPELEM_DEVTOOLS_GET_METRICS'
  | 'COMPELEM_DEVTOOLS_GET_EVENTS'
  | 'COMPELEM_DEVTOOLS_CLEAR_EVENTS'
  | 'COMPELEM_DEVTOOLS_HOOK'
  | 'COMPELEM_DEVTOOLS_SUBSCRIBE'
  | 'COMPELEM_DEVTOOLS_UNSUBSCRIBE'
  | 'COMPELEM_DEVTOOLS_GET_TIMELINE'
  | 'COMPELEM_DEVTOOLS_CLEAR_TIMELINE'
  | 'COMPELEM_DEVTOOLS_GET_COMPUTED_DEPS'
  | 'COMPELEM_DEVTOOLS_TRIGGER_EMIT'
  | 'COMPELEM_DEVTOOLS_DESTROY_COMPONENT'
  | 'COMPELEM_DEVTOOLS_PUSH_UPDATE'
  | 'COMPELEM_DEVTOOLS_PUSH_EVENT'
  | 'COMPELEM_DEVTOOLS_PUSH_STATE_CHANGE'
  | 'COMPELEM_DEVTOOLS_PUSH_COMPONENT_TREE'
  | 'COMPELEM_DEVTOOLS_EXPORT_STATE'
  | 'COMPELEM_DEVTOOLS_IMPORT_STATE'

export interface BridgeMessage {
  type: MessageType | string
  payload?: any
  id?: number
}

export interface SubscribePayload {
  types: ('updates' | 'events' | 'state' | 'tree')[]
  cid?: number // 可选，订阅特定组件
}

export type PanelTab = 'tree' | 'state' | 'timeline' | 'events' | 'perf' | 'deps' | 'updatepoints'

// ============ 序列化辅助 ============

export function serializeValue(v: any, depth: number = 0): any {
  if (depth > 4) return '...'
  if (v === null || v === undefined) return v

  // 处理常见类型
  try {
    if (v instanceof HTMLElement) return `<${v.tagName.toLowerCase()}>`
    if (v instanceof Node) return `[Node:${v.nodeType}]`
    if (v instanceof Promise) return '[Promise]'
    if (v instanceof RegExp) return v.toString()
    if (v instanceof Date) return v.toISOString()
  } catch (e) { /* noop */ }

  if (Array.isArray(v)) {
    if (depth > 2) return `[Array(${v.length})]`
    return v.slice(0, 20).map((item: any) => serializeValue(item, depth + 1))
  }

  if (typeof v === 'object') {
    if (depth > 2) return `[Object]`
    try {
      const keys = Object.keys(v).slice(0, 50)
      const result: Record<string, any> = {}
      for (const k of keys) {
        if (k.startsWith('_') || k === '__isData') continue
        try { result[k] = serializeValue(v[k], depth + 1) } catch { /* noop */ }
      }
      return result
    } catch {
      return '[Object]'
    }
  }

  if (typeof v === 'function') return `[Fn:${v.name || 'anonymous'}]`
  if (typeof v === 'symbol') return v.toString()

  return v
}
