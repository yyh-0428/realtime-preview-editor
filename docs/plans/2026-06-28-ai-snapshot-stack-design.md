# AI 修改快照栈 — 设计文档

> 日期：2026-06-28
> 状态：已确认，待实现

## 概述

在 AI 面板添加独立的"撤销 AI 修改"功能。每轮 AI 对话开始前自动拍快照，用户可撤销到任意历史快照点。与 CodeMirror undo 完全独立。

## 设计决策

- **触发时机**: 每轮 AI 对话开始前自动快照（B 方案）
- **容量限制**: 20 步 FIFO，满了丢最早
- **存储内容**: 代码 + 语言 + 滚动位置 + 摘要（B 方案）
- **UI 交互**: 撤销按钮 + 长按/右键历史列表浮层（A 方案）
- **淘汰策略**: 20 步满了之后丢代码留摘要，进入历史时间线（C 方案）
- **持久化**: 不持久化，刷新即清空

## 数据结构

```javascript
// 完整快照，最多 20 个
aiSnapshots = [{
    id: Number,          // Date.now()
    code: String,        // 编辑器完整代码
    lang: String,        // 当前语言
    scrollPos: Object,   // editor.getScrollInfo()
    summary: String      // 自动生成摘要
}]

// 历史时间线，无上限，只存摘要
aiSnapshotTimeline = [{
    id: Number,
    summary: String,
    ts: Number
}]
```

## 触发流程

1. 用户点击发送 / Agent 开始第一步工具调用前
2. 调用 `takeAiSnapshot()` 拍快照
3. AI 回复完成后，回写 `summary` 为 AI 最后一条消息前 30 字符
4. 如果 `aiSnapshots.length > 20`，弹出最早的，摘要推入 `aiSnapshotTimeline`

## 撤销流程

1. 弹出 `aiSnapshots` 最后一个
2. `setCode(snapshot.code)`、切换语言、恢复滚动位置
3. 更新 UI 按钮状态

## UI

AI 面板输入框上方工具条：
```
[↶ 撤销 AI 修改]    [第 3/20 步]
```

- 有快照 → 高亮可点，显示栈深度
- 空栈 → 灰色不可点

长按 500ms / 右键 → 历史列表浮层：
- 可撤销区：最近 20 步，点击撤销到该步
- 已过期区：历史时间线摘要，只读灰色

## 边界约束

- 与 CodeMirror undo 完全独立，互不干扰
- 不持久化，刷新清空
- Agent 模式下一轮多步工具调用只拍一次快照
- 摘要失败兜底为 `"第 N 轮 AI 修改"`
