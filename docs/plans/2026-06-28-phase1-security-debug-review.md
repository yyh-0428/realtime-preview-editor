# Implementation Plan: Werkstatt 实时预览编辑器 Phase 1 改进

## Overview

Phase 1 聚焦安全修复、错误排查和代码审查，解决 3 个核心问题：API Key 不安全存储、11 处空 catch 静默吞错误、updatePreview 异步竞态。所有修改在 index.html 单文件内完成，不涉及架构变更。

## Architecture Decisions

- **API Key 存储策略**：默认 sessionStorage（页面关闭即清除），用户可勾选"记住 Key"显式 opt-in 到 localStorage。safeStorage 底层不改，在 loadAiKey/saveAiKey 层面切换存储介质。
- **空 catch 处理原则**：能修根因的修根因，不能修的加结构化 console.warn 带上下文。不盲目删除 catch，因为有些确实是合理的防御性编程（如 releaseLock、highlightElement）。
- **竞态修复**：引入编译版本号 `previewToken`，每次触发编译递增，回调时检查是否是最新 token，过期的丢弃。

## Task List

### Phase 1A: 安全修复

- [x] Task 1: API Key 存储从 localStorage 改为 sessionStorage + 显式"记住"选项
- [x] Task 2: AI Endpoint 和 Models Cache 同样从 localStorage 迁移评估（Endpoint 已修复，Models Cache 保持 safeStorage 不变——非敏感数据）

### Checkpoint: 安全修复完成
- [ ] API Key 默认不持久化到 localStorage
- [ ] "记住 Key" 功能正常工作
- [ ] 编辑器所有功能不受影响

### Phase 1B: 错误排查与修复

- [x] Task 3: 11 处空 catch 逐个加结构化日志（6 处代码中，1 处 iframe 字符串内保持不变）
- [x] Task 4: updatePreview 异步竞态修复（编译 token 机制）
- [x] Task 5: loadAiEndpoint 函数逻辑修复（硬编码返回 DEFAULT_ENDPOINT，忽略用户保存的值）

### Checkpoint: 错误排查完成
- [ ] 控制台无静默错误
- [ ] 快速输入/切换语言不产生预览闪烁或错乱
- [ ] AI Endpoint 正确保存和恢复

### Phase 1C: 代码审查

- [x] Task 6: 五轴审查 Agent 工具实现质量（batch_edit 行号偏移、edit_code 参数验证等）
- [x] Task 7: 审查 consoleHookScript 字符串拼接的安全性和可维护性

### Checkpoint: Phase 1 完成
- [x] 所有安全修复到位
- [x] 所有空 catch 有处理
- [x] 竞态已修复
- [x] 代码审查无遗留 Critical/High 问题
- [x] 推送到 GitHub 验证线上效果 (commit e95405a, a4df532)

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| sessionStorage 改动导致已保存的 Key 丢失 | Medium | 首次加载时检测 localStorage 旧 Key，迁移到 sessionStorage |
| 竞态 token 逻辑引入新 bug | Medium | 保守实现，只在非 HTML 编译路径加 token，HTML 直出不变 |
| 空 catch 加日志后控制台太吵 | Low | 用 console.warn 而非 console.error，加 [Werkstatt] 前缀方便过滤 |

## Open Questions

- AI_ENDPOINT_STORAGE 当前 loadAiEndpoint() 硬编码返回 DEFAULT_ENDPOINT，不走 safeStorage.get — 这是 bug 还是有意为之？需要确认。
