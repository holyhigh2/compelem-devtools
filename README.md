# Compelem DevTools

为 [compelem](https://github.com/holyhigh2/compelem) WebComponent 框架开发的 Chrome / Edge DevTools 扩展。

Manifest V3 + `chrome.devtools.*`，实测 Chrome / Edge 可用；Firefox / Safari 暂未适配。

## 功能概览

- **组件树** — 可视化完整父子层级，支持手动 / 自动刷新、搜索过滤
- **属性检查器** — Props / States / Computed / Slots / Styles 独立面板，支持类型化深度编辑和强制更新
- **时间线瀑布图** — 统一记录 emit / state↗ / update / lifecycle / store / route / locale 事件，按时间桶密集度着色
- **事件日志** — emit + state 变更合并展示；参数 JSON 格式化（行内截断 / hover 完整 / 点击展开）；组件列可点击跳组件树
- **性能热区** — 三连芯片：更新最频繁 / @computed 重算最多 / UpdatePoint 最常标记
- **依赖图 + 变更溯源** — 选中 state 路径可反查哪些 computed / 组件 / watcher 受影响
- **右键菜单定位** — 视图右键 → 「在 Compelem 组件树中定位」→ 页面 toast + 面板自动选中
- **安装检测** — compelem dev 构建页面未装扩展时控制台提示安装；装了后图标点亮

## 安装

### 构建

```bash
git clone https://github.com/holyhigh2/compelem-devtools.git
cd compelem-devtools
npm install
npm run build
```

### 加载到 Chrome / Edge

1. 打开 `chrome://extensions/`（Edge 为 `edge://extensions/`）
2. 启用「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目的 `dist/` 目录

### 提示开关

如果想让 compelem dev 构建的页面闭嘴（不再提示安装扩展），在页面控制台执行：

```js
window.__COMPELEM_DEVTOOLS_NO_HINT__ = true
```

## 项目结构

```
├── src/
│   ├── background/    Service Worker — 消息路由 + 右键菜单注册
│   ├── content/       Content Script — 按需注入桥接脚本
│   ├── injected/      Injected Script — 页面内 `__COMPELEM_DEVTOOLS__` 桥接
│   └── panel/         DevTools Panel — UI + 面板层消息处理
├── public/            静态资源（图标等）
└── manifest.json
```

通信流：injected（页面世界）→ content（postMessage 中转）→ background（Service Worker）→ panel（DevTools UI）。

## Bridge API

扩展生效后，页面上暴露 `window.__COMPELEM_DEVTOOLS__`：

```js
const B = window.__COMPELEM_DEVTOOLS__

B.getTree()                  // 完整组件树
B.getState(cid)              // { cid, data, computedDeps, timestamp }
B.getDeps(cid)               // { viewDeps, computedDeps, cssDeps, watchKeys, updatePointCount }
B.getUpdatePoints(cid)       // [{ id, deps, updateCount, lastUpdateTime, depth, type }]
B.setState(cid, 'count', 42) // 支持 'a.b[0].c' 深路径
B.forceUpdate(cid)
B.getEvents(100)             // emit 事件（最近 N 条）
B.getStateChanges(100)       // state 变更日志（含 from/to）
B.getUpdates(100)            // 更新记录：duration / renderTime / changed
B.getTimeline(100)           // 统一时间线（emit + state↗ + update + lifecycle + store/router/i18n）
B.getComputedStats()         // [{ key, computedKey, ctorName, hits, recomputes, lastDuration, hitRate }]
B.getUpdatePointStats()      // [{ key, count, lastTime }] 按 count 降序
B.traceDependency('state.count') // { computedGets, viewDeps, cssDeps, watchers }
B.findComponent(cid)         // cid → 组件实例
B.findComponentByElement(el) // 元素 → 组件（含 Shadow DOM 穿透）
```

## 开发

```bash
npm run dev     # Watch 模式
npm run build   # 生产构建（必须走这个，不能只跑 vite build）
```

## License

MIT
