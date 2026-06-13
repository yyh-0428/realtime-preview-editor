# Werkstatt 实时预览编辑器 — 代码质量审查报告

**审查文件**: `realtime-preview-editor-redesign.html`  
**文件规模**: 4601 行 / ~260KB 单 HTML 文件  
**技术栈**: CodeMirror 5, GSAP 3.x, 纯前端 HTML/CSS/JS  
**审查日期**: 2026-06-13  

---

## 一、安全漏洞

### SEC-001 [Critical] iframe srcdoc 直接注入未过滤的用户代码
- **严重程度**: Critical
- **问题描述**: 用户编辑的 HTML/JS/CSS 代码直接通过 `previewFrame.srcdoc = code` 注入 iframe，没有进行任何安全过滤。虽然 iframe 声明了 `sandbox="allow-scripts allow-popups"`，但仍允许执行任意 JavaScript，可能导致钓鱼页面、恶意重定向、加密货币挖矿脚本等。
- **代码位置**: 第 2011 行 `updatePreviewWith`, 第 2047 行 `updatePreview`
- **修复建议**:
  - 对注入 iframe 的代码进行 DOMPurify 过滤，或至少对 `<script>` 内容进行安全审查
  - 考虑使用 `srcdoc` + `sandbox="allow-scripts"` 的组合限制，但增加 CSP: `<meta http-equiv="Content-Security-Policy" content="default-src 'self' ...">`
  - 对于不可信来源的代码，使用 `sandbox="allow-scripts"` 但不允许 `allow-same-origin` 是正确的，但需要在文档中明确告知用户风险

### SEC-002 [Critical] API Key 明文存储在 localStorage
- **严重程度**: Critical
- **问题描述**: AI API Key (`editor_ai_key`) 以明文形式存储在 localStorage 中。一旦页面存在 XSS 漏洞（如通过代码片段导入、AI生成的恶意代码等），攻击者可以轻易窃取 API Key。
- **代码位置**: 第 2335 行 `AI_KEY_STORAGE`, 第 2344 行 `saveAiKey`, 第 2343 行 `loadAiKey`
- **修复建议**:
  - 使用 `sessionStorage` 替代 `localStorage`，页面关闭后自动清除
  - 或提供"记住 Key"的显式 opt-in 选项，默认不保存
  - 考虑使用 Memory-only 存储，要求用户每次重新输入
  - 如果必须持久化，至少在前端进行简单的对称加密（虽非绝对安全，但可提高攻击门槛）

### SEC-003 [High] 多处 innerHTML 使用，存在 XSS 注入面
- **严重程度**: High
- **问题描述**: 代码中多处使用 `innerHTML` 赋值，虽然部分经过 `escapeHTML` 处理，但存在不一致和遗漏。
- **代码位置**:
  - 第 1877 行: `container.innerHTML = ''` (低风险)
  - 第 1889 行: `tab.innerHTML = '<span class="dot"></span>' + cfg.label`
  - 第 2088 行: `snippetsList.innerHTML = html` (使用 `escapeHTML`，但 escapeHTML 本身有缺陷)
  - 第 4049 行: `card.innerHTML = '...'` (拼接 SVG + 动态内容)
  - 第 4061 行: `card.innerHTML = '...'` (同理)
  - 第 4074 行: `populateModelSelect` 中 `o.textContent` 是安全的，但其他位置不够一致
- **修复建议**:
  - 统一使用 `textContent` 替代 `innerHTML` 处理纯文本
  - 需要 HTML 结构时，使用 `document.createElement` 构建而非字符串拼接
  - 对 `escapeHTML` 函数进行全面审计和统一

### SEC-004 [High] escapeHtml 函数不完整，存在属性注入风险
- **严重程度**: High
- **问题描述**: 项目中存在三个不同的 HTML 转义函数，且实现不一致。`escapeHtml` (第 4484 行) 缺少引号转义，无法安全用于属性上下文；`escapeHTML` (第 2216 行) 使用 DOM textContent 较为安全，但只用于片段列表；`escapeHtmlAttr` (第 1906 行) 虽然转义了引号，但使用场景有限。
- **代码位置**: 第 1906 行、2216 行、4484 行
- **修复建议**:
  - 统一为一个安全完整的转义函数，覆盖 `& < > " '` 五个字符
  - 或使用 DOMPurify / Trusted Types 进行现代化处理

### SEC-005 [Medium] AI Key 在输入框 focus 时明文暴露
- **严重程度**: Medium
- **问题描述**: 当用户 focus API Key 输入框时，代码将 input type 切换为 text 并显示完整 Key（第 4135 行）。在屏幕共享、演示或旁站攻击场景下会导致 Key 泄露。
- **代码位置**: 第 4133-4135 行
- **修复建议**:
  - 始终保持 `type="password"`
  - 提供显式的"显示/隐藏"切换按钮，由用户主动控制
  - focus 时不应自动暴露敏感信息

### SEC-006 [Medium] 缺少 Content Security Policy (CSP)
- **严重程度**: Medium
- **问题描述**: 页面没有任何 CSP meta 标签或 HTTP Header，无法有效防御 XSS、数据注入等攻击。
- **代码位置**: 全局
- **修复建议**:
  - 添加 `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;">`
  - 注意 `'unsafe-inline'` 对 style 是必需的（因为使用了 CodeMirror 内联样式），但 script 应尽量避免

### SEC-007 [Medium] 文件导入无内容类型校验
- **严重程度**: Medium
- **问题描述**: `fileInput` 虽有 `accept` 属性，但 JS 端仅通过后缀名判断语言类型，没有校验实际文件内容。恶意用户可上传包含 XSS payload 的文件。
- **代码位置**: 第 1985-2009 行
- **修复建议**:
  - 导入文件时对内容进行大小限制（如最大 1MB）
  - 读取文件后先做基本的内容安全扫描
  - 对非文本文件拒绝处理

---

## 二、性能问题

### PERF-001 [Critical] 每次按键都立即触发预览更新，无防抖
- **严重程度**: Critical
- **问题描述**: `editor.on('change', () => { updatePreview(); ... })` 在每次按键（或任何编辑器变化）时立即调用 `updatePreview()`，而 `updatePreview()` 会设置 `previewFrame.srcdoc = code`。对于大型文件或快速输入，这会导致 iframe 极其频繁地重载，CPU 和内存占用飙升。
- **代码位置**: 第 4547-4555 行
- **修复建议**:
  - 为 `updatePreview()` 添加防抖（debounce），延迟 300-500ms
  - 区分用户主动刷新和自动刷新，自动刷新使用防抖，手动刷新（点击刷新按钮）立即执行
  - 当前只有状态文字有防抖，预览更新没有

### PERF-002 [High] 非 HTML 语言每次变更都重新编译
- **严重程度**: High
- **问题描述**: 对于 TS/SCSS/MD 等非 HTML 语言，`updatePreview` 的 patch 版本（第 2054-2070 行）会在每次编辑器变更时调用 `compileCode()`，触发 Babel/Sass 编译。编译是 CPU 密集型操作，频繁调用会导致严重卡顿。
- **代码位置**: 第 2054-2070 行 `patchUpdatePreview`
- **修复建议**:
  - 对 `compileCode()` 增加独立的防抖机制
  - 编译结果缓存，若源码未改变不重复编译
  - 大文件时禁用实时编译，改为手动编译模式

### PERF-003 [High] AI 流式输出逐字符 DOM 操作
- **严重程度**: High
- **问题描述**: `onStreamChunk` (第 4178-4217 行) 对每个字符进行状态机判断和 DOM 更新，虽然 `thinkingBuffer.length % 30 === 0` 有一定节流，但整体仍是 O(n) 的逐字符处理。在高频流式场景下主线程被阻塞。
- **代码位置**: 第 4178-4217 行
- **修复建议**:
  - 使用 `requestAnimationFrame` 批量处理 DOM 更新
  - 增加基于时间的节流（如每 100ms 更新一次 UI），而非基于字符数
  - 将 thinking 内容拼接缓冲，批量写入 DOM

### PERF-004 [Medium] window.resize 无节流
- **严重程度**: Medium
- **问题描述**: `window.addEventListener('resize', () => { applyRatio(); editor.refresh(); })` 在窗口 resize 期间会高频触发，没有节流或防抖。
- **代码位置**: 第 1718 行
- **修复建议**:
  - 使用 `requestAnimationFrame` 或防抖封装
  - `editor.refresh()` 是昂贵操作，不应在 resize 时高频调用

### PERF-005 [Medium] rebuildLangTabs 循环读取 localStorage
- **严重程度**: Medium
- **问题描述**: `rebuildLangTabs` 在循环中多次调用 `localStorage.getItem()`（第 1883 行）。虽然单次开销小，但结合频繁调用会影响性能。
- **代码位置**: 第 1874-1900 行
- **修复建议**:
  - 一次性读取所有需要的 localStorage 项到内存，再构建 DOM
  - 使用内存缓存减少 localStorage 访问

### PERF-006 [Medium] 高亮标记 setTimeout 可能累积
- **严重程度**: Medium
- **问题描述**: `highlightChangedLines` 使用 `setTimeout(() => { ... }, 3500)` 清除高亮，但没有取消机制。如果用户快速多次触发 AI 修改，多个定时器会同时存在，可能导致 line class 的竞争状态。
- **代码位置**: 第 3933-3943 行
- **修复建议**:
  - 使用 `clearTimeout` 在新增高亮前清理旧定时器
  - 或维护一个 Map 来追踪每行的清除定时器

### PERF-007 [Low] CodeMirror 5 大文件性能瓶颈
- **严重程度**: Low
- **问题描述**: CodeMirror 5 在处理大文件（>1000 行）时存在已知性能问题，尤其是 line wrapping 开启时。项目中 `lineWrapping: true` 且没有大文件检测和降级机制。
- **代码位置**: 第 1470-1489 行
- **修复建议**:
  - 检测文件大小，超过阈值时关闭 lineWrapping 或提示用户
  - 考虑升级到 CodeMirror 6，其虚拟滚动性能更好

### PERF-008 [Low] 260KB 单文件导致首屏加载慢
- **严重程度**: Low
- **问题描述**: 单文件 260KB（加上外部依赖），在慢网络环境下首屏加载时间长。没有代码分割或懒加载策略。
- **代码位置**: 全局
- **修复建议**:
  - 将设计系统数据、API 列表等大块数据抽离为独立 JSON 文件，按需加载
  - 使用动态 import() 加载 AI 面板相关逻辑

---

## 三、代码健壮性

### ROB-001 [High] 大量 try/catch 静默吞掉所有错误
- **严重程度**: High
- **问题描述**: 代码中存在数十个空的 `catch (e) {}` 块，完全静默处理异常。这使得调试和错误监控几乎不可能，用户也无法感知问题。
- **代码位置**（部分）:
  - 第 1590 行 `loadEditorCode`
  - 第 1603 行 `saveEditorCode`
  - 第 1627 行 `loadRatio`
  - 第 1631 行 `saveRatio`
  - 第 1734 行 `loadColorMode`
  - 第 1757 行 `toggleColorMode`
  - 第 1835 行 `DOMContentLoaded` 回调内的主题加载
  - 第 2200 行 `saveSnippetsToStorage`
- **修复建议**:
  - 至少将错误信息输出到 `console.error`
  - 对用户可见的操作（如保存失败），应显示 Toast 提示
  - 建立统一的错误处理函数

### ROB-002 [High] applySearchReplaceBlocks 替换位置计算在多次替换后可能出错
- **严重程度**: High
- **问题描述**: 函数先排序匹配项（descending），然后逐个调用 `editor.replaceRange()`。每次替换后编辑器内容改变，后续使用 `editor.posFromIndex()` 计算位置时，虽然基于 "新的" 内容索引，但 `found.idx` 是基于原始内容的。如果前面的替换改变了文本长度，后面的 `found.idx` 就不再准确。
- **代码位置**: 第 3884-3931 行
- **修复建议**:
  - 由于已经按 descending 排序，前面的替换（在文件末尾）不会影响后面的替换（在文件开头），这在大多数情况下是正确的。但需要确保 `editor.indexFromPos(m.from)` 在替换后重新计算
  - 对 `changedLines` 的计算也应重新基于替换后的位置
  - 添加单元测试覆盖重叠替换和相邻替换场景

### ROB-003 [Medium] fetchModels / callAiApiStream 缺少超时处理
- **严重程度**: Medium
- **问题描述**: 所有 `fetch` 调用都没有 `AbortController` 超时机制。在网络不佳时请求可能挂起 indefinitely，UI 状态永远停留在"加载中"。
- **代码位置**: 第 4085-4100 行 `fetchModels`, 第 4394-4456 行 `callAiApiStream`
- **修复建议**:
  - 使用 `AbortController` 设置请求超时（如 30 秒）
  - 超时后显示用户友好的重试界面
  - 流式读取时也设置整体超时

### ROB-004 [Medium] Babel/Sass 动态加载没有错误恢复
- **严重程度**: Medium
- **问题描述**: `ensureBabel()` 和 `ensureSass()` 在脚本加载失败时 `reject`，但调用方没有统一处理。网络中断后用户无法使用 TS/SCSS 编译功能，且没有重试机制。
- **代码位置**: 第 1958-1980 行
- **修复建议**:
  - 增加加载失败后的用户提示和手动重试按钮
  - 添加指数退避重试机制
  - 缓存加载状态避免重复请求

### ROB-005 [Medium] AI 响应解析缺乏健壮性
- **严重程度**: Medium
- **问题描述**: `parseThinkingResponse` 使用正则替换提取 thinking 内容，如果 AI 输出 `<thinking>` 标签嵌套或不规范，可能导致内容丢失或解析错误。
- **代码位置**: 第 3857-3863 行
- **修复建议**:
  - 使用更健壮的非贪婪匹配
  - 处理嵌套标签（虽然理论上不应嵌套）
  - 对解析失败提供 fallback 显示原始文本

### ROB-006 [Medium] getStructuralContext 正则匹配过于简单
- **严重程度**: Medium
- **问题描述**: 通过正则表达式分析代码结构，对于复杂语法（如模板字符串、注释中的关键字）会产生误判。例如注释中的 `function foo()` 会被误认为在函数内。
- **代码位置**: 第 1519-1544 行
- **修复建议**:
  - 增加对注释块的跳过逻辑
  - 对于 HTML 使用更精确的解析器而非简单正则
  - 标记此为"最佳努力"功能，不保证 100% 准确

### ROB-007 [Medium] checkCodeSafety 规则过于简单，可能误报/漏报
- **严重程度**: Medium
- **问题描述**: 代码安全检查仅通过长度比例和标签数量判断，没有语义分析。例如合法的大量重构会被误判为"删减过多"，而巧妙保留标签但篡改逻辑的恶意代码则可通过检查。
- **代码位置**: 第 3957-4016 行
- **修复建议**:
  - 增加 AST 级别的差异分析（如使用 diff 库）
  - 提供更清晰的用户确认界面，而非简单的自动回滚
  - 对安全警告分级：warning 级别不自动回滚，critical 级别才回滚

### ROB-008 [Low] localStorage 配额超限处理不完善
- **严重程度**: Low
- **问题描述**: `saveSnippetsToStorage` 在存储失败时设置了 `storageAvailable = false`，但编辑器代码的保存（`saveEditorCode`）没有类似的配额检测。
- **代码位置**: 第 2198-2201 行 vs 第 1593-1604 行
- **修复建议**:
  - 统一所有 localStorage 写入的错误处理
  - 预估存储大小，接近上限时提示用户清理

---

## 四、可维护性

### MAINT-001 [High] 260KB 单文件严重违反单一职责原则
- **严重程度**: High
- **问题描述**: 整个应用（CSS + HTML + JS）挤在单个 HTML 文件中，包含：UI 布局、CodeMirror 集成、主题系统、多语言编译、AI 对话、流式处理、增量编辑、设计系统、API 数据源、代码片段管理、全屏控制等。任何改动都可能影响不相关的模块。
- **代码位置**: 全局
- **修复建议**:
  - 按功能模块拆分为独立文件：`editor.js`, `preview.js`, `ai-panel.js`, `design-systems.js`, `api-data.js`, `snippets.js`
  - 使用 ES Modules 或构建工具（Vite/Webpack）进行打包
  - CSS 抽离为独立文件，按组件组织

### MAINT-002 [High] 魔法数字/字符串遍布，缺乏常量定义
- **严重程度**: High
- **问题描述**: 大量未命名的字面量散布在代码中，增加理解和维护成本。
- **代码位置**:
  - 第 1504 行: `selectedText.slice(0, 600)` — 600 是什么含义？
  - 第 1524 行: `i >= startLine - 50` — 50 行扫描限制
  - 第 3942 行: `setTimeout(..., 3500)` — 3.5 秒高亮持续时间
  - 第 4206 行: `thinkingBuffer.length % 30 === 0` — 30 字符节流
  - 第 2087 行: `setTimeout(..., 2200)` — Toast 显示时长
  - 第 2103 行: `setTimeout(..., 1800)` — 复制成功状态恢复时长
  - 第 3001 行及后续: DESIGN_SYSTEMS 中大量硬编码的字体、颜色、间距值
- **修复建议**:
  - 提取为命名常量，如 `const MAX_CONTEXT_SNIPPET_LENGTH = 600`
  - 设计 Token 应通过 CSS 变量或配置对象统一管理

### MAINT-003 [Medium] 命名规范不一致
- **严重程度**: Medium
- **问题描述**: 同一项目中混合了多种命名风格：
  - 驼峰: `escapeHtml`, `loadAiKey`, `applyRatio`
  - 全大写下划线: `CODE_STORAGE_KEY`, `DEBOUNCE_DELAY`
  - 匈牙利式/缩写: `btnClear`, `fsIcon`, `ep`
  - HTML 转义函数有三个不同名字: `escapeHtmlAttr`, `escapeHTML`, `escapeHtml`
- **代码位置**: 全局
- **修复建议**:
  - 制定并遵循统一的命名规范
  - 统一 HTML 转义函数名
  - 避免单字母变量（`ep`, `k`, `m`, `s` 等），除非是极短作用域的循环变量

### MAINT-004 [Medium] 重复代码和逻辑分散
- **严重程度**: Medium
- **问题描述**: 多处存在重复或高度相似的代码块。
- **代码位置**:
  - 左右两个 resizer 的逻辑高度重复（`startDrag` vs `startLeftDrag`）
  - 保存/加载 localStorage 模式重复出现数十次（应抽象为 `safeStorage` 工具）
  - Toast 和 Status 更新逻辑有重叠
  - 第 4584-4595 行 `beforeunload` 和 `pagehide` 逻辑几乎相同
- **修复建议**:
  - 抽象通用的 Storage 工具函数
  - 抽象通用的拖放逻辑
  - 抽象事件监听器的添加/清理模式

### MAINT-005 [Medium] 设计系统和 API 数据内联，导致文件膨胀
- **严重程度**: Medium
- **问题描述**: `DESIGN_SYSTEMS` (第 2882-3429 行，~550 行)、`PUBLIC_APIS` (第 2619-2707 行，~90 行)、`GSAP_KNOWLEDGE` (第 2370-2558 行，~190 行) 等大量静态数据直接内联在 JS 中。这些数据很少变更，却占用了大量代码体积。
- **代码位置**: 第 2370-3429 行
- **修复建议**:
  - 将静态数据抽离为独立的 `.json` 文件，按需 `fetch` 加载
  - 或使用构建时的代码分割（如 dynamic import）
  - 设计系统可以保留，但 API 列表和知识库文档应考虑外部化

### MAINT-006 [Low] 复杂度过高的函数
- **严重程度**: Low
- **问题描述**: 多个函数过长，职责过多：
  - `buildDeepThinkingPrompt` (第 3749-3855 行): 超过 100 行，拼接大量字符串
  - `btnAiSend.addEventListener('click', ...)` (第 4139-4312 行): 超过 170 行的匿名回调
  - `callAiApiStream` (第 4394-4456 行): 流式解析逻辑复杂
- **修复建议**:
  - 将大函数拆分为小的、单一职责的函数
  - 使用模板字符串的替代方案（如模板文件）管理大段提示词

---

## 五、用户体验缺陷

### UX-001 [High] iframe 预览缺少错误捕获和反馈
- **严重程度**: High
- **问题描述**: 用户代码中的 JavaScript 错误会在 iframe 内部抛出，父页面完全无法感知。如果代码导致 iframe 白屏或崩溃，用户没有任何错误信息可参考。
- **代码位置**: 第 1366-1374 行 iframe 定义
- **修复建议**:
  - 使用 `iframe.contentWindow.onerror` 或 `window.addEventListener('error')` 在 iframe 内部捕获错误，并通过 `postMessage` 将错误信息传递给父页面显示
  - 添加控制台输出面板，显示 iframe 内的 console.log/error

### UX-002 [Medium] 键盘可访问性不足
- **严重程度**: Medium
- **问题描述**:
  - 左右面板的分隔条（resizer）无法通过键盘操作
  - AI 聊天区域的代码 diff card 中"应用到编辑器"按钮虽然可聚焦，但整体聊天区域的键盘导航未优化
  - 没有提供跳转到主要区域的 skip link
- **代码位置**: 第 905-947 行 resizer, 第 4469-4482 行 diff card
- **修复建议**:
  - 为 resizer 添加键盘支持（如 ArrowLeft/ArrowRight 调整宽度）
  - 添加 skip navigation link
  - 确保所有交互元素都有可见的焦点样式（目前已有 `focus-visible`，但需全面检查）

### UX-003 [Medium] Toast 通知缺乏 ARIA 支持
- **严重程度**: Medium
- **问题描述**: Toast 元素没有 `role="alert"` 或 `role="status"`，屏幕阅读器用户无法感知状态变化。
- **代码位置**: 第 998-1015 行 `.toast` CSS, 第 2080-2088 行 `showToast`
- **修复建议**:
  - 给 toast 元素添加 `role="status"`（非紧急）或 `role="alert"`（紧急）
  - 使用 `aria-live="polite"` 区域确保屏幕阅读器播报

### UX-004 [Medium] 响应式断点单一，缺少中间态优化
- **严重程度**: Medium
- **问题描述**: 只有 768px 一个断点，在 768px-1200px 的平板尺寸下，侧栏 280px 固定宽度可能占据过多空间，编辑器区域被挤压。
- **代码位置**: 第 1090-1116 行
- **修复建议**:
  - 增加 1024px 断点，平板尺寸下可调整侧栏宽度或自动折叠
  - 考虑使用 CSS Container Queries 替代 Media Queries

### UX-005 [Medium] 加载状态不一致
- **严重程度**: Medium
- **问题描述**:
  - Babel/Sass 加载脚本时没有 loading 指示器
  - Prettier 格式化前没有检查插件是否已加载完成（第 2142 行只是检查 `typeof prettier`）
  - 导入文件后编译期间有状态指示，但初始加载时没有
- **代码位置**: 第 1958-1980 行, 第 2141 行
- **修复建议**:
  - 统一加载状态管理
  - 所有异步操作都应有明确的 loading / success / error 状态

### UX-006 [Low] 没有 prefers-reduced-motion 的完整覆盖
- **严重程度**: Low
- **问题描述**: 虽然有 `@media (prefers-reduced-motion: reduce)` 规则（第 1133-1139 行），但只覆盖了 CSS 动画。JS 驱动的动画（如 GSAP 模板中的动画）没有相应的 reduced-motion 检测和降级。
- **代码位置**: 第 1133-1139 行
- **修复建议**:
  - 在生成 GSAP 动画代码时，检测 `prefers-reduced-motion` 并禁用或简化动画
  - 在 JS 动画初始化前做同样的检测

### UX-007 [Low] 初始加载时 FOUC (Flash of Unstyled Content)
- **严重程度**: Low
- **问题描述**: CodeMirror 主题和页面主题在 JS 执行前可能显示默认样式，导致闪烁。
- **代码位置**: 全局
- **修复建议**:
  - 在 `<head>` 中添加内联的 critical CSS 设置默认深色模式
  - 使用 `document.documentElement.style.visibility = 'hidden'` 并在主题应用后恢复

### UX-008 [Low] 代码片段标题输入没有最大长度实时提示
- **严重程度**: Low
- **问题描述**: 保存片段时标题 `maxlength="80"`，但没有实时字符计数提示。
- **代码位置**: 第 1387 行
- **修复建议**:
  - 添加字符计数器，如 "0/80"
  - 接近上限时给出视觉提示

---

## 六、其他建议

1. **版本控制**: 当前没有版本号或构建哈希，不利于排查线上问题。建议在 console.log 中包含版本和构建时间。

2. **代码格式化配置**: 项目没有 `.editorconfig` 或 `.prettierrc`，多人协作时格式可能不一致。

3. **测试覆盖**: 完全没有单元测试或 E2E 测试。核心功能如 `applySearchReplaceBlocks`、`checkCodeSafety`、`detectComplexity` 等非常适合编写单元测试。

4. **TypeScript 迁移**: 随着功能增长，纯 JS 越来越难以维护。建议逐步迁移到 TypeScript，至少为关键模块添加 JSDoc 类型注释。

5. **依赖管理**: 外部库（CodeMirror、Prettier、Babel、Sass 等）全部通过 CDN 加载，没有版本锁定机制。如果 CDN 服务故障或版本不兼容，应用将崩溃。建议：
   - 使用 package.json + 构建工具管理依赖
   - 或至少使用 SRI (Subresource Integrity) 校验 CDN 资源

---

## 总结

| 类别 | Critical | High | Medium | Low |
|------|----------|------|--------|-----|
| 安全漏洞 | 2 | 2 | 3 | 0 |
| 性能问题 | 1 | 2 | 2 | 2 |
| 代码健壮性 | 0 | 2 | 5 | 1 |
| 可维护性 | 0 | 1 | 3 | 1 |
| 用户体验 | 0 | 1 | 3 | 3 |
| **总计** | **3** | **8** | **16** | **7** |

**最优先修复项**:
1. SEC-001: iframe srcdoc 安全过滤
2. SEC-002: API Key 明文存储 → sessionStorage
3. PERF-001: 预览更新添加防抖
4. SEC-003/SEC-004: innerHTML 和 escapeHtml 统一安全处理
5. ROB-001: 错误处理从静默失败改为可见反馈
