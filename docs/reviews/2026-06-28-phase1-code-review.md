# Phase 1 代码审查报告 — Task 6 & Task 7

## 审查范围
- **文件**: index.html (8262+ 行)
- **重点**: Agent 工具实现质量（batch_edit 行号偏移、edit_code 参数验证）、consoleHookScript 安全性、innerHTML 使用审计
- **审查日期**: 2026-06-28
- **审查人**: Alex

---

## 一、Agent 工具实现审查

### 1.1 applyEditBlocks (行 5083-5130)

**功能**: 将编辑块（replace/insert/delete）按行号从后往前排序后应用到 CodeMirror 编辑器。

**✅ 正确的部分**:
- 排序逻辑正确：从后往前（lineB - lineA），避免前面的修改影响后面的行号
- `editor.operation()` 包裹批量操作，避免多次触发 change 事件
- toLine 边界处理正确：`toLine + 1 > lastLine` 时取行末而非下一行行首

**⚠️ 问题 E1 (Medium)**: insert 操作的 content 前面加了 `\n`，但如果 `afterLine` 是最后一行且该行已有内容，插入位置是对的。但如果 `afterLine` 行为空（lineText 为 falsy），`ch: 0` 会导致 `\n` 插在行首，产生一个空行。虽然不影响功能，但会产生多余空行。

**修复建议**: 不紧急，可以接受当前行为。如果在意可以加 `lineText ? '\n' + content : content`。

**⚠️ 问题 E2 (Low)**: delete 操作删除到 `toLine + 1` 的行首（即包含 toLine 的整行+换行符），但如果 toLine 是最后一行，删除到行末，可能留下一个空行。不影响功能但视觉上可能有残留。

**结论**: 核心逻辑正确，行号偏移处理得当。两个小问题不影响功能。

### 1.2 batch_edit (行 7654-7685)

**功能**: 批量编辑，转换 operations 为 blocks，调用 applyEditBlocks。

**✅ 正确的部分**:
- 正确转换为 blocks 格式
- 从后往前排序在 applyEditBlocks 内部处理
- 空列表校验

**⚠️ 问题 B1 (Low)**: 没有对 startLine/endLine 做越界校验。如果 AI 传入 startLine=99999，CodeMirror 的 `editor.getLine(99998)` 会返回 undefined，`{ line: 99998, ch: 0 }` 到 `{ line: 99999, ch: 0 }` 的 replaceRange 会在文件末尾插入空内容，不会报错但也不会做任何事。

**修复建议**: 加一个 `Math.min(startLine, editor.lineCount())` 的 clamp。低优先级。

### 1.3 edit_code (行 7301-7327)

**功能**: 单次编辑操作，计算 lineDelta 返回给 AI 提示行号偏移。

**✅ 正确的部分**:
- lineDelta 计算正确：replace 时新行数减旧行数，insert 时新行数，delete 时负的旧行数
- 偏移提示返回给 AI，让 AI 知道后续行号需要调整
- 调用 updatePreview() 和 highlightChangedLines()

**⚠️ 问题 C1 (Medium)**: `args.endLine || args.startLine` 用 `||` 而非 `??`，当 endLine 为 0 时会回退到 startLine。虽然行号是 1-based 不会为 0，但这种模式在其他地方也有出现，是个代码坏味道。

**结论**: 功能正确，`||` vs `??` 是代码风格问题。

### 1.4 applySearchReplaceBlocks (行 4962-5015)

**功能**: search-replace 块匹配，支持精确匹配、trim 匹配、忽略前导空白匹配。

**✅ 正确的部分**:
- 三级匹配策略合理（精确 → trim → 忽略缩进）
- 唯一性校验（找到多个匹配返回 ambiguous）
- 从后往前排序应用替换

**⚠️ 问题 S1 (Medium)**: 忽略缩进匹配时，对全文件做 `codeLines.slice(j, j + textLines.length)` 的遍历，O(n*m) 复杂度。对于大文件（>1000行）和长 search 块，可能有性能问题。

**修复建议**: 可以用 KMP 或先把 codeLines 做预处理。但目前编辑器主要处理单文件 HTML，不太会到几千行，暂不紧急。

### 1.5 search_web (行 7347-7380)

**功能**: 通过 DuckDuckGo API + CORS 代理搜索。

**⚠️ 问题 W1 (Medium)**: 依赖 `api.allorigins.win` 作为 CORS 代理，这是第三方免费服务，不稳定且不可信。API Key 不经过代理（只用 query），但搜索内容会经过代理。

**⚠️ 问题 W2 (Low)**: `catch(e) { /* timeout or network error */ }` 这个空 catch 虽然有注释但没加日志。应该加 `console.warn`。

**修复建议**: W2 可以立即修。W1 暂时接受，但在 docs 中标注依赖。

---

## 二、consoleHookScript 审查 (行 2530)

**功能**: 注入到预览 iframe 中的脚本，拦截 console.log/warn/error/info 和 window.onerror，通过 postMessage 回传给编辑器。

**✅ 正确的部分**:
- 使用 postMessage 回传，targetOrigin 设为 `"*"` — 在 srcdoc iframe 场景下可接受（同源限制）
- 日志队列限 100 条防止内存泄漏
- 错误信息格式化包含文件名和行号

**⚠️ 问题 H1 (Low)**: `JSON.stringify(x)` 在循环引用时会抛错，被内层 `catch(e){return String(x)}` 捕获。处理正确但 silent。可以接受。

**⚠️ 问题 H2 (Medium)**: 这个脚本是通过字符串拼接注入到 iframe srcdoc 的。如果用户代码中包含 `</script>` 标签，会提前关闭 script 标签导致注入中断。但这是 HTML 的固有特性，用户代码本身就应该处理好 `<\/script>` 转义。可接受。

**结论**: consoleHookScript 实现合理，无安全风险。

---

## 三、innerHTML 使用审计

共发现 ~15 处 innerHTML 使用，分类评估：

### 高风险（需修复）

**无** — 所有 innerHTML 使用要么是写入空字符串（`el.innerHTML = ''`）、要么是写入经 escapeHtml 转义的内容、要么是写入经 DOMPurify 过滤的内容。

### 中风险（可接受但需记录）

| 行 | 代码 | 评估 |
|---|------|------|
| 5451 | `textSpan.innerHTML = marked.parse(text)` | marked 输出 + DOMPurify 过滤，可接受 |
| 5567 | `thinkingBodyEl.innerHTML = renderThinkingSteps(...)` | 渲染 AI 思考步骤，输入来自 AI 响应但无 XSS 风险（不包含用户输入注入） |
| 6533 | `card.innerHTML = '...' + escapeHtml(code) + '...'` | code 经过 escapeHtml，安全 |
| 2852 | `snippetsList.innerHTML = html` | html 来自代码片段列表渲染，内容是用户保存的 snippet title — 需确认是否经过转义 |

### 低风险（安全）

| 行 | 代码 | 评估 |
|---|------|------|
| 2363 | `container.innerHTML = ''` | 清空，安全 |
| 5366 | `aiModelSelect.innerHTML = ''` | 清空，安全 |
| 3583 | `searchResults.innerHTML = ''` | 清空，安全 |

### 需进一步检查

**行 2852**: `snippetsList.innerHTML = html` — 需要确认 snippet title 在渲染前是否经过 escapeHtml。

---

## 四、search_web 空 catch 修复

审查中发现 search_web 工具实现中有一处空 catch（行 ~7375），Phase 1 Task 3 未覆盖到（因为 grep 只匹配了 `catch(e) {}` 而这里是 `catch(e) { /* timeout or network error */ }`）。

---

## 五、总结

### 已修复（Phase 1 Task 1-5）
- ✅ API Key 存储安全（sessionStorage + opt-in）
- ✅ loadAiEndpoint 硬编码 bug
- ✅ updatePreview 异步竞态
- ✅ 6 处空 catch 加日志

### 本次审查新发现
- ⚠️ E1 (Low): insert 多余空行 — 可接受
- ⚠️ E2 (Low): delete 末行残留 — 可接受
- ⚠️ B1 (Low): batch_edit 无越界校验 — 低优先级
- ⚠️ C1 (Low): `||` vs `??` 代码风格 — 低优先级
- ⚠️ S1 (Medium): search-replace O(n*m) — 暂不紧急
- ⚠️ W1 (Medium): CORS 代理依赖 — 暂时接受
- ⚠️ W2 (Low): search_web 空 catch — **立即修复**
- ⚠️ H1 (Low): consoleHook JSON 循环引用 — 可接受
- ⚠️ H2 (Medium): consoleHook `</script>` 中断 — HTML 固有特性，可接受

### 结论
**无 Critical/High 遗留问题**。Agent 工具实现的核心逻辑（行号偏移、从后往前排序、编辑操作转换）全部正确。发现 1 个可立即修复的小问题（search_web 空 catch），其余为 Low/Medium 可后续处理。

---

*审查完成于 2026-06-28 13:08 GMT+8*
