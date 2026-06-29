# Phase 2 代码审查报告

> 审查日期：2026-06-29
> 审查范围：全量 index.html (8519 行 / 496KB) + lib/ 目录
> 审查人：Alex

## 一、已实现功能确认

### ✅ AI 快照栈
- 设计文档完整（docs/plans/2026-06-28-ai-snapshot-stack-design.md）
- 实现与设计一致：20 步 FIFO、历史时间线、撤销到任意步、长按/右键浮层
- `takeAiSnapshot()` 在 AI 对话开始前调用（5755 行）
- `updateAiSnapshotSummary()` 在 AI 回复完成后回写摘要（6162/8293 行）
- 与 CodeMirror undo 独立，不持久化，符合设计

### ✅ TS/SCSS 实验性标注
- 语言 tab 上有"实验"标签（2437 行 `isExperimental` 判断）
- Babel/Sass CDN 加载失败 toast 标注"实验性功能"（2515/2527 行）

### ✅ 数据外置
- `data/design-systems.json` 已创建（96KB）
- `loadExternalDesignSystems()` 按需 fetch，失败回退内联数据（2693 行）
- file:// 协议下跳过 fetch

### ✅ 预览防抖
- `PREVIEW_DEBOUNCE_DELAY = 400ms`，保存防抖 `SAVE_DELAY = 1000ms`
- resize 已有 rAF 节流

### ✅ 竞态修复
- `previewToken` 版本号机制正确（2742 行）
- 过期编译结果被丢弃

### ✅ 安全修复
- API Key 默认 sessionStorage，"记住 Key" opt-in 到 localStorage
- 旧 localStorage key 自动迁移到 sessionStorage
- 非敏感配置（endpoint/model/design system/models cache）正确使用 safeStorage（localStorage）
- innerHTML 使用全部经过 escapeHtml 或为硬编码内容
- CSP meta 注入预览 iframe（3295 行），object-src 'none'

## 二、新发现的问题

### Medium

#### M1: ~~streaming chat fetch 无超时~~ ✅ 已确认有 300s 超时
**位置**: 6643 行
**结论**: streaming 路径已有 `setTimeout(() => controller.abort(), 300000)`，5 分钟超时合理。误报，已排除。

#### M2: `applyEditBlocks` 缺少越界校验
**位置**: 5308 行
**问题**: `startLine` / `endLine` / `afterLine` 未校验是否在 `editor.lineCount()` 范围内。如果 AI 返回了错误的行号（比如 99999），CodeMirror 的 `replaceRange` 会抛错。
**当前保护**: 外层 `callToolUnified` 调用方有 try/catch，不会崩溃，但返回的是通用错误信息，AI 无法区分是行号错误还是其他异常。
**修复建议**: 在 `applyEditBlocks` 开头加校验：
```javascript
const maxLine = editor.lineCount();
for (const block of sorted) {
    const refLine = block.type === 'insert' ? block.afterLine : block.startLine;
    if (refLine < 1 || refLine > maxLine + 1) {
        return { success: false, reason: '行号越界: ' + refLine + '（有效范围 1-' + maxLine + '）' };
    }
}
```

#### M3: non-streaming fallback fetch 无超时
**位置**: 6605 行 `callAiApi` 函数
**问题**: 无 `AbortController` 也无超时。如果 API 服务端接受请求但不响应，fetch 会一直挂起，用户无法通过"停止"按钮中断（因为没有 controller 可以 abort）。
**对比**: streaming 路径有 300s 超时 + AbortController，models fetch 有 30s 超时，Agent 模式有 300s 超时。唯独 non-streaming fallback 没有。
**修复建议**: 添加 AbortController + 60s 超时。

### Low

#### L1: `edit_code` case 缺少 try/catch（一致性）
**位置**: 7512 行
**问题**: `batch_edit` 有 try/catch（7867 行），但 `edit_code` 没有。虽然外层调用方有保护，但一致性不好。
**影响**: 错误信息不够精确。
**修复建议**: 加 try/catch 返回 `[ERR]` 格式错误。

#### L2: `typeof streamTextBuf !== 'undefined'` 冗余检查
**位置**: 6162 行
**问题**: `streamTextBuf` 在同一函数作用域内声明（5804 行），typeof 检查永远为 true。
**影响**: 无功能影响，代码噪音。

#### L3: CDN 离线检测未实现
**问题**: MEMORY.md 记录"已实现 CDN 离线检测警告条"，但 GitHub 仓库代码中未找到相关实现（`checkCdnAvailability` / `updateCdnWarning` 等函数不存在）。可能是 workspace 旧版本功能未同步到仓库。
**影响**: 用户在离线环境下不知道哪些 CDN 不可用。
**修复建议**: 确认是否需要此功能。如果不需要，更新 MEMORY.md。如果需要，参考 MEMORY.md 描述实现。

#### L4: 496KB 单文件体积
**现状**: index.html 8519 行 / 496KB。路线图目标 <120KB。
**分析**: 设计系统数据已外置（96KB → data/），但 AI system prompt（~30KB）、CDN_PRESETS（~15KB）、GSAP_TEMPLATES（~10KB）等仍内联。
**建议**: 暂不拆分。单文件形态对用户使用便利性（一个文件就能跑）大于体积优化的收益。如果未来要拆，优先提取 CDN_PRESETS 和 GSAP_TEMPLATES 到 data/。

## 三、已确认无问题

- **innerHTML 安全性**: 所有用户内容写入均经过 escapeHtml 或 DOMPurify
- **consoleHookScript**: postMessage 回传逻辑合理，无注入风险
- **Agent 工具实现**: batch_edit 从后往前排序正确，edit_code lineDelta 计算准确，search-replace 三级匹配策略合理
- **API Key 存储**: secureStorage 机制正确，只有 AI_KEY_STORAGE 走 sessionStorage，其他配置走 localStorage
- **空 catch**: 剩余的带注释 catch（如"静默失败，使用内联数据"）都有合理理由
- **resize 节流**: rAF 节流已实现
- **预览防抖**: 400ms 防抖合理

## 四、建议执行顺序

1. **M1 + M3**: 给 streaming 和 non-streaming chat fetch 加超时（30 分钟）
2. **M2**: applyEditBlocks 加越界校验（15 分钟）
3. **L1**: edit_code 加 try/catch 保持一致性（5 分钟）
4. **L3**: 确认 CDN 离线检测需求，更新 MEMORY.md

总计约 1 小时工作量。
