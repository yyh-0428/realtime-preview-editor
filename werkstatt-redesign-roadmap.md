# Werkstatt 实时预览编辑器 — 改进路线图 v1.0

> 生成日期：2026-06-13
> 来源：竞品差距分析（discovery-analyst）+ 五维设计质量评审（critique-reviewer）+ 代码质量审查（code-auditor）

---

## 一、当前状态诊断

### 核心矛盾

Werkstatt 是一个**"交互精致、架构贪婪"**的产品——视觉和微交互层面达到工匠水准，但功能野心超出了单文件形态的合理承载力。

**量化问题**：
- 4601 行 / ~260KB 单文件，违反单一职责原则
- 34 个代码质量问题（3 Critical + 8 High + 16 Medium + 7 Low）
- 五维设计评分：哲学 3/5、层次 3/5、执行 3/5、特异性 3/5、克制 **2/5**
- AI 能力仍停留在"单次调用问答"，与 Cursor/Bolt/Codex 存在代差

---

## 二、三大 P0 修正（立即执行）

### P0-1: 数据与逻辑分离（1-2 天）

**问题**：设计系统/知识库硬编码在单文件中，占 60-80KB
**目标**：主文件从 260KB → <120KB，首屏加载减少 50%+

| 数据块 | 当前位置 | 提取目标 | 体积估计 |
|--------|----------|----------|----------|
| DESIGN_SYSTEMS | JS 内联 | design-systems.json，按需 fetch | ~40KB |
| COMPONENT_MOTION_SPEC | JS 内联 | motion-specs.json，按需 fetch | ~15KB |
| GSAP_KNOWLEDGE | JS 内联 | gsap-knowledge.json，按需 fetch | ~20KB |
| PUBLIC_APIS_KNOWLEDGE | JS 内联 | apis-knowledge.json，按需 fetch | ~10KB |

**实施步骤**：
1. 将上述数据提取为独立 JSON 文件
2. 使用 `fetch()` + localStorage 缓存实现离线可用
3. AI 面板首次展开时异步加载，不阻塞首屏
4. 添加加载态（skeleton / spinner）

**与竞品对标**：v0/Bolt 均按需加载设计系统，不内联全部数据

---

### P0-2: 补齐 Undo + 前端验证（1-2 天）

**问题**：
- AI 修改一旦应用，用户无法撤销（无历史栈）
- AI 生成的代码直接注入，无 HTML/JS/CSS 前置校验
- 预览 iframe 白屏时无错误反馈

**实施步骤**：

1. **AI 修改快照**
   - 每次 AI 修改前将编辑器内容存入 `aiHistory[]`（内存数组，限制 20 步）
   - UI 添加"撤销上一步 AI 修改"按钮（Ctrl+Z 仅撤销 AI 修改，不与编辑器原生 undo 冲突）
   - 快照包含：修改前内容、修改后内容、时间戳、AI 请求摘要

2. **前端语法验证层**
   - HTML: `new DOMParser().parseFromString(code, 'text/html')`，检查 parse error
   - JS: `new Function(code)` 在 try/catch 中预执行（不执行，仅解析）
   - CSS: 临时创建 `<style>` 标签试错
   - 验证失败时在 Toast 中显示具体错误，阻止应用

3. **iframe 错误捕获与回传**
   - 在 iframe srcdoc 中注入 `window.onerror` 和 `console.error` 拦截器
   - 通过 `postMessage` 将错误回传至编辑器
   - 在预览区底部显示"控制台"面板，展示 iframe 内错误

---

### P0-3: 安全漏洞紧急修复（1 天）

来自代码质量审查的 2 个 Critical + 2 个 High 安全项：

| 编号 | 问题 | 修复方案 | 优先级 |
|------|------|----------|--------|
| SEC-001 | iframe srcdoc 直接注入未过滤代码 | 添加 DOMPurify 过滤或 CSP meta；在文档中明确告知用户风险 | Critical |
| SEC-002 | API Key 明文存储 localStorage | 改用 `sessionStorage`（页面关闭自动清除）；提供"记住 Key"显式 opt-in，默认不保存 | Critical |
| SEC-003 | 多处 innerHTML 使用 | 统一使用 `textContent`；需 HTML 结构时用 `createElement` | High |
| SEC-004 | escapeHtml 不完整（3 个不统一函数） | 统一为一个完整转义函数，覆盖 `& < > " '` | High |
| SEC-005 | API Key focus 时明文暴露 | 移除 focus 自动暴露逻辑；添加显式"显示/隐藏"切换按钮 | Medium |

---

## 三、P1 修正（1-2 周内）

### P1-1: 预览更新防抖 + 性能优化

| 问题 | 修复 | 代码位置 |
|------|------|----------|
| 每次按键立即触发预览更新 | `updatePreview()` 添加 300ms debounce | 第 4547 行 |
| TS/SCSS 每次变更都重新编译 | `compileCode()` 独立防抖 + 编译结果缓存 | 第 2054 行 |
| AI 流式逐字符 DOM 操作 | 改用 `requestAnimationFrame` 批量更新，100ms 节流 | 第 4178 行 |
| window.resize 无节流 | 添加 rAF 节流 | 第 1718 行 |

### P1-2: 补齐 ReAct 基础框架（2-3 天）

**目标**：将产品从"AI 问答工具"升级为"AI 助手"，补上与 Cursor/Bolt 的最大能力差距。

**最小可行实现**：
1. **虚拟文件系统工具**（3 个工具）
   - `read_file(path)` — 读取当前编辑器中指定语言的内容
   - `write_file(path, content)` — 修改指定语言的内容
   - `run_preview()` — 触发预览刷新并返回 iframe 错误状态

2. **多步循环可视化**
   - AI 每执行一步，在思考卡片中新增一个"步骤节点"
   - 显示：步骤编号、工具名、参数摘要、执行结果摘要
   - 用户可在每一步后点击"继续"或"停止"

3. **提示词工程瘦身**
   - 将 3 档复杂度（low/medium/high）合并为 1 档通用框架
   - `outputFormatRule` 从 1500 字压缩至 300 字核心约束
   - 通过 `max_tokens` 和 `temperature` 控制输出长度

### P1-3: Toolbar 与 AI 面板信息分级

**Toolbar 分级**：
- 保留：品牌、格式化、刷新、AI 触发
- 移入"更多"二级菜单：清空、复制、下载、导入
- 主题色点从 6 个缩减为 2 个（Terracotta 默认 + Slate 备选）

**AI 面板渐进披露**：
- 首次使用只显示：输入框 + 发送按钮
- 配置项（API Key、端点、模型、设计系统）折叠在"设置"抽屉中
- 参考 ChatGPT "先对话，后配置"策略

### P1-4: 诚实面对虚假功能

| 功能 | 当前状态 | 修正方案 |
|------|----------|----------|
| GSAP 全插件内置 | 只在提示词中声称，iframe 未真正加载 | 方案 A：在 iframe srcdoc 中注入 GSAP CDN；方案 B：从品牌宣传中移除该卖点 |
| 80+ Public API | 只在提示词中作为知识库，无 CORS 代理 | 添加简单的 CORS 代理说明或推荐用户自备代理 |
| TS/SCSS 编译 | 运行时动态加载 Babel/Sass.js，不稳定 | 明确标为"实验性功能"，或降级为纯编辑器模式 |

---

## 四、P2 修正（后续迭代）

| 修正项 | 说明 | 优先级 |
|--------|------|--------|
| fetch 超时处理 | 所有 `fetch` 调用添加 `AbortController`（30s 超时） | Medium |
| 错误处理从静默失败改为可见反馈 | 数十个空 `catch (e) {}` 添加 `console.error` + Toast | Medium |
| 增量编辑位置计算修复 | `applySearchReplaceBlocks` 多次替换后位置准确性 | Medium |
| 响应式断点优化 | 增加 1024px 平板断点 | Medium |
| ARIA 与可访问性 | Toast 添加 `role="status"`、resizer 键盘支持 | Medium |
| 魔法数字常量化 | `MAX_CONTEXT_SNIPPET_LENGTH = 600`、`HIGHLIGHT_DURATION = 3500` 等 | Low |
| 代码格式配置 | 添加 `.editorconfig` + `.prettierrc` | Low |
| 版本控制 | 在 console.log 中包含版本号和构建时间 | Low |

---

## 五、需要叫停的过度工程

1. **暂停新增设计系统**：16 套已足够，未来新增走"用户自定义上传 JSON"
2. **暂停新增语言支持**：TS/SCSS 稳定性未达标前，不扩展至 Vue/Svelte/Less
3. **简化深度思考框架**：3 档合并为 1 档，减少提示词技术债
4. **不急于模块拆分**：虽然 260KB 单文件违反单一职责，但在数据外置后（降至 <120KB），单文件形态仍可接受。若未来超过 200KB 再考虑构建工具

---

## 六、时间线与优先级

```
Week 1（P0 紧急修复）
├── Day 1-2: P0-1 数据外置（JSON 提取 + 按需加载）
├── Day 2-3: P0-2 Undo + 前端验证 + iframe 错误捕获
├── Day 3-4: P0-3 安全漏洞修复（XSS、API Key、escapeHtml）
└── Day 4-5: 集成测试 + 性能验证

Week 2（P1 能力升级）
├── Day 1-2: P1-1 防抖 + 性能优化
├── Day 2-4: P1-2 ReAct 基础框架（3 工具 + 多步可视化）
├── Day 4-5: P1-3 Toolbar/AI 面板信息分级
└── Day 5: P1-4 虚假功能修正

Week 3（打磨与迭代）
├── P2 修正项按优先级逐个处理
└── 回归测试 + 性能基准对比
```

---

## 七、成功指标

| 指标 | 当前值 | 目标值 | 验证方式 |
|------|--------|--------|----------|
| 单文件体积 | ~260KB | <120KB | 文件大小 |
| 首屏加载时间（3G） | ~4s | <2s | Lighthouse |
| 安全问题 | 3 Critical + 8 High | 0 Critical + 0 High | 代码审查 |
| AI 修改可撤销 | 无 | 支持 20 步历史 | 功能测试 |
| 代码语法预检 | 无 | HTML/JS/CSS 预检 | 功能测试 |
| 预览错误反馈 | 无 | iframe 错误回传显示 | 功能测试 |
| AI 多步执行 | 无单次调用 | 支持 read/write/preview 工具链 | 功能测试 |

---

*本路线图基于三份独立审查报告的综合结论制定，所有修正项均有具体代码位置关联。*
