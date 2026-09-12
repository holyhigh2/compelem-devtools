# Compelem DevTools

A full-featured browser DevTools extension for the [compelem](https://github.com/holyhigh2/compelem) WebComponent framework.

Manifest V3 + `chrome.devtools.*`，实测可用：**Chrome / Edge**。
Firefox 与 Safari 未适配（MV3 service worker 与 devtools 面板 API 差异），暂不支持。

## Features

- **Component Tree** — 可视化完整组件层级（仅显示 id，父-子关系明确），支持手动 / 自动刷新切换、搜索过滤
- **State Inspector** — 分 Props / States / Computed / Slots / Styles 独立面板，支持类型化深度编辑和强制更新
- **Timeline（瀑布图）** — 统一记录 emit / state↗ / update / lifecycle / store / route / locale 事件，按时间桶密集度着色，不同类型不同颜色
- **Event Log** — emit + state 变更双列统计；参数 JSON 格式行内显示（160 字符截断），hover 看完整 JSON，点击 ▸ 展开格式化面板；组件列独立可点击跳组件树
- **Performance（热区）** — 顶部三连芯片：更新最频繁 / @computed 重算最多 / UpdatePoint 最常标记，每组件卡片展示耗时 / 更新次数 / computed hitRate
- **Dependency Graph** — 左侧组件树形目录，右侧 viewDeps / computedDeps / cssDeps / watchKeys 列表，底部「🔗 变更溯源链」反查指定 state 路径影响哪些 computed / 组件 / watcher
- **右键菜单定位** — 视图上右键 → 「在 Compelem 组件树中定位」→ 页面 toast 提示 + DevTools 面板自动选中并滚动到该组件
- **Installation Detection** — 页面用了 compelem 但没装扩展时控制台给出安装提示；装了扩展则图标点亮（Vue DevTools 同款体验）

### 安装检测与按需注入

浏览器没有「查询扩展是否安装」的 API，只能靠扩展自己打标。三处约定：

| 标记 | 写入方 | 时机 | 用途 |
|---|---|---|---|
| `<html data-compelem-devtools="pending:<ver>">` | content script | `document_start` | 库侧据此判断「扩展已安装」（同步，早于任何页面脚本） |
| `<html data-compelem-devtools="ready:<ver>">` | injected bridge | bridge 挂载后 | 表示扩展可用；停在 `pending` 说明被页面 CSP 拦住了 |
| `<html data-compelem="<协议版本>">` | compelem 库 | 模块加载期 | 扩展据此判断「本页用了 compelem」→ 按需注入 + 图标点亮 |

- **按需注入**：content script 不再无条件注入 bridge。检测到 `data-compelem` 立即注入；否则观察 `<html>` 属性，并在 DOM 就绪后扫描一次自定义元素（覆盖不打标的老版本库）。非 compelem 页面完全不注入。
- **面板兜底**（两条路径，content script 完全失效时仍可用）：
  1. 要求 content script 注入一次（`COMPELEM_DEVTOOLS_FORCE_INJECT`）
  2. 兜底：面板直接用 `chrome.devtools.inspectedWindow.eval` 把 `web_accessible_resources` 里的 `injected/index.js` 插进页面（绕过 content script 失效场景）
- **提示开关**：只想让扩展闭嘴时设 `window.__COMPELEM_DEVTOOLS_NO_HINT__ = true`。提示**只在 compelem 的 dev 构建**（`process.env.DEV`）出现，生产构建整段被消除。

### 依赖库侧的元数据接入点（compelem ≥ 带 `src/devtools.ts` 的版本）

`computedDeps` / `watchKeys` / `viewDeps` / `propKeys` / `stateKeys` 这些字段只有核心库
暴露了 `__COMPELEM_ECOSYSTEM__.core` 才有真实值。老版本库会自动回退：

| 字段 | 库侧接入点可用 | 回退行为 |
|---|---|---|
| `computedKeys` | 装饰器元数据 | 按 getter 源码特征猜测 |
| `computedDeps` | ✅ | `{}` |
| `watchKeys` | ✅ | `[]` |
| `viewDeps` | ✅ | 根层 UpdatePoint 推断 |

## Installation

### From Source

```bash
git clone https://github.com/your-org/compelem-devtools.git
cd compelem-devtools
npm install
npm run build
```

### Load in Chrome/Edge

1. Open `chrome://extensions/` (or `edge://extensions/`)
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `dist` directory from this project

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  DevTools Panel (UI)                                 │
│  └─ panel.html + panel.ts                           │
├─────────────────────────────────────────────────────┤
│  Background Script (Service Worker)                  │
│  └─ background/index.js — message routing            │
├─────────────────────────────────────────────────────┤
│  Content Script                                      │
│  └─ content/index.js — postMessage bridge            │
├─────────────────────────────────────────────────────┤
│  Page World (injected)                               │
│  └─ injected/index.js — __COMPELEM_DEVTOOLS__ bridge │
└─────────────────────────────────────────────────────┘
```

### Communication Flow

1. The **injected script** sets up `window.__COMPELEM_DEVTOOLS__` in the page world
2. The **content script** relays messages between the page and extension via `postMessage`
3. The **background script** routes messages between the content script and DevTools panel
4. The **panel UI** sends commands and receives responses through the bridge

## Bridge API

When the extension is active, it exposes `window.__COMPELEM_DEVTOOLS__`:

```js
const B = window.__COMPELEM_DEVTOOLS__

B.getTree()                 // 完整组件树
B.getState(cid)             // { cid, data, computedDeps, timestamp }
B.getDeps(cid)              // { viewDeps, computedDeps, cssDeps, watchKeys, updatePointCount }
B.getUpdatePoints(cid)      // [{ id, deps, updateCount, lastUpdateTime, depth, type }]
B.setState(cid, 'count', 42)// 支持 'a.b[0].c' 深路径
B.forceUpdate(cid)
B.getEvents(100)            // emit 事件日志（最近 N 条）
B.getStateChanges(100)      // state 变更日志（最近 N 条，含 from/to 值）
B.getUpdates(100)           // 更新记录：duration / renderTime / changed
B.getTimeline(100)          // 统一时间线（emit + state↗ + update + lifecycle + store/router/i18n）
B.getComputedStats()        // [{ key, computedKey, ctorName, hits, recomputes, lastDuration, hitRate }]
B.getUpdatePointStats()     // [{ key, count, lastTime }] 按 count 降序
B.traceDependency('state.count') // { computedGets, viewDeps, cssDeps, watchers } 反查依赖该路径的所有位置
B.findComponent(cid)        // cid → 组件实例（控制台里直接 inspect 用它）
B.findComponentByElement(el)// 元素 → 组件（含 Shadow DOM 穿透）
```

> 注意：`getComponentTree` / `getStateSnapshot` / `setStateValue` / `getDependencies` /
> `getPerformanceMetrics` / `getEventLog` **都不是** bridge 上的方法，别照着旧文档敲。

## Development

```bash
npm run dev      # Watch mode
npm run build    # Production build（vite build + postbuild，必须走 build，不能只跑 vite build）
```

## Verification

探针套件在 `.workbuddy/verify/`，用真实 `dist/` 产物 + headless Chrome / vm 沙箱跑：

```bash
node .workbuddy/verify/injected-correctness-probe.mjs   # P0 正确性回归
node .workbuddy/verify/compelem-core-meta-probe.mjs     # 库侧元数据接入点
node .workbuddy/verify/panel-eco-probe.mjs              # 生态三页签端到端
node .workbuddy/verify/panel-edit-probe.mjs             # 类型化编辑
node .workbuddy/verify/context-locate-probe.mjs         # 右键定位（页面侧）
node .workbuddy/verify/devtools-detect-probe.mjs        # 安装检测 / 按需注入 / 未安装提示
```

| 探针 | 基线 |
|---|---|
| `injected-correctness` | 14/14 |
| `compelem-core-meta` | 11/11 |
| `injected-eco` | 40/40 |
| `panel-eco` | 114/114 |
| `panel-edit` | 23/23 |
| `panel-locate` | 22/22 |
| `context-locate` | 25/25 |
| `content-locate` | 10/10 |
| `background-locate` | 15/15 |
| `devtools-detect` | 28/28 |

探针路径全部由 `import.meta.url` 推导，不硬编码盘符。
`devtools-detect` 的 B 组（库侧提示）需要 compelem 的 **dev 构建**产物，
位于 `../compelem/dist-dev/index.js`（prod 构建会把提示整段消除，只够验证「不提示」）。
`router-lib` / store、i18n 的 vitest 套件依赖那几个仓库里的 `src/devtools.ts`，
本机（F 盘）checkout 没有该文件，因此这几套跑不了。

## Requirements

- The target page must use the `compelem` library
- Components must be registered via `@tag()` or `defineComponents()`

## License

MIT
