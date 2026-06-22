# AI 代码编辑器竞品底层逻辑分析 & 差距报告

> 针对 `yyh-0428/realtime-preview-editor` 的 AI 助手模块

---

## 一、竞品底层逻辑全景

### 1. Tree of Thoughts (思维树 / ToT)

**起源**: Princeton NLP, Yao et al. (2023)

**核心思想**: 突破 CoT（Chain of Thought）的单一路径限制，将推理过程建模为**树形搜索**。

```
CoT: 问题 → 思考1 → 思考2 → ... → 答案  (单一路径)
ToT: 问题 → [思考A] ─┬→ [思考B1] ─┬→ 答案1
                     │            └→ 答案2
                     └→ [思考B2] ──→ 答案3
                     (多路径探索 + BFS/DFS 搜索)
```

**底层机制**:
| 组件 | 说明 |
|------|------|
| **Thought Decomposition** | 将问题分解为可评估的中间步骤 |
| **Thought Generation** | 每个节点生成 k 个候选思考 |
| **State Evaluation** | LLM 自评或投票选出最优路径 |
| **Search Algorithm** | BFS（广度优先）或 DFS（深度优先） |

**性能数据**: 在 24 点游戏中，CoT 准确率 < 10%，ToT 达到 **74%**。

**技术限制**: 需要 **多次 API 调用**（每个节点一次），成本高、延迟大。

---

### 2. ReAct (Reasoning + Acting)

**起源**: Princeton & Google Research, Yao et al. (2022)

**核心思想**: LLM 交替进行 **Reasoning（推理）→ Acting（行动）→ Observation（观察）** 的循环。

```
循环结构:
┌─────────────────────────────────────────┐
│  Thought: 我需要先了解当前代码的结构      │
│  Action: search_codebase("路由配置")      │
│  Observation: 找到 3 个相关文件...       │
│     ↓                                   │
│  Thought: 文件 A 是主入口，需要修改这里   │
│  Action: read_file("src/App.tsx")        │
│  Observation: 当前使用 React Router v5   │
│     ↓                                   │
│  Thought: 需要升级到 v6，先修改导入       │
│  Action: edit_file("src/App.tsx", ...)   │
└─────────────────────────────────────────┘
```

**关键洞察**: "不要指望模型能直接从 Input 映射到复杂的 API Call。显式的 Reasoning Step 是必不可少的。"

---

### 3. MCP (Model Context Protocol)

**起源**: Anthropic (2024), 现已成为开放标准，OpenAI、GitHub 均已采纳

**核心思想**: 标准化应用程序向 LLM **公开工具和上下文**的方式。

**架构**:
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Host      │────→│   Client    │────→│   Server    │
│  (IDE/App)  │     │  (MCP Client)│     │(MCP Server) │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                                │
                                         ┌──────┴──────┐
                                         │ • Filesystem│
                                         │ • GitHub API│
                                         │ • Database  │
                                         │ • Browser   │
                                         └─────────────┘
```

**核心原语**:
| 原语 | 说明 | 对应场景 |
|------|------|---------|
| **Resources** | 只读数据上下文 | 代码文件、文档 |
| **Tools** | LLM 可调用的函数 | 文件读写、命令执行 |
| **Prompts** | 预定义提示模板 | 代码审查、重构 |

**为什么重要**: 没有 MCP，每个 AI 工具都要自己实现文件系统访问、命令执行、API 调用。**MCP 统一了接口**。

---

### 4. OpenAI Codex CLI

**定位**: 官方终端 AI Agent，可直接操作文件系统和命令行

**底层架构**:
```
用户输入
   ↓
[Agent Loop]
   ├─ 思考: 分析需求，决定下一步行动
   ├─ 行动: 调用工具（read_file / write_file / bash / ...）
   ├─ 观察: 获取工具执行结果
   └─ 循环直到任务完成
   ↓
输出结果
```

**关键特性**:
| 特性 | 实现 |
|------|------|
| **沙盒隔离** | 在受控环境中执行命令，防止破坏系统 |
| **确定性工作流** | 通过 Agents SDK 编排可审计的工作流 |
| **MCP 集成** | 通过 MCP 服务器扩展工具能力 |
| **审批模式** | 编辑文件/运行命令前需用户确认 |

**Approval 模式**:
- `suggest`: 只建议不执行
- `auto-edit`: 自动编辑，命令需确认
- `full-auto`: 完全自动（危险）

---

### 5. Claude Code (Anthropic)

**定位**: Agentic coding system，理解整个项目并自主执行

**底层能力**:
| 能力 | 说明 |
|------|------|
| **Codebase Understanding** | 自动索引整个项目，建立代码知识图谱 |
| **Computer Use** | 视觉驱动的桌面操作（截图 → 分析 → 点击/输入） |
| **File System Operations** | 读写任意文件，创建/删除目录 |
| **Terminal Execution** | 运行测试、构建、部署命令 |
| **Multi-turn Planning** | 复杂任务的自主规划与执行 |

**Computer Use 技术栈**:
```
屏幕截图 → 视觉编码器 → LLM 推理 → 动作预测
                                      ↓
                              [点击坐标、键盘输入、滚动]
```

**与 Codex 的区别**: Claude Code 更强调**长期上下文记忆**和**项目级理解**，而 Codex 更偏向**即时任务执行**。

---

### 6. Cursor (Anysphere)

**定位**: AI-first IDE，深度集成 Agent 能力

**三种核心模式**:
| 模式 | 能力 | 工作方式 |
|------|------|---------|
| **Tab (补全)** | 单行/多行代码补全 | 实时预测，类似 Copilot |
| **Chat (对话)** | 问答、解释、小修改 | 基于当前文件上下文 |
| **Composer (Agent)** | 多文件编辑、项目重构 | 自主规划，跨文件修改 |

**Composer Agent 的底层逻辑**:
```
1. 用户描述需求
2. Agent 分析项目结构，确定需要修改的文件列表
3. 逐个文件读取 → 修改 → 写入
4. 验证修改（运行测试/类型检查）
5. 如有错误，迭代修复
```

**Context 管理**: Cursor 维护一个**优先级队列**，自动决定哪些文件/符号应放入上下文窗口。

---

### 7. GitHub Copilot

**三种模式** (VS Code 中):
| 模式 | 工具权限 | 工作方式 |
|------|---------|---------|
| **Ask** | 无 | 问答，不修改代码 |
| **Edit** | 读写当前文件 | 同步修改，需确认 |
| **Agent** | 代码读写 + 终端 + MCP | 实时协作，自主调用工具 |

**Coding Agent (异步)**:
- 从 GitHub Issue 出发
- 后台独立运行
- 最终提交 Draft PR
- 人工审核后合并

**上下文传递链**:
```
Issue 描述
   ↓
Custom Instructions (.chatmode.md)
   ↓
代码库探索 (codebase, search, usages)
   ↓
MCP 外部数据 (GitHub issues, PRs)
   ↓
LLM 推理
```

---

## 二、我们的底层逻辑 vs 竞品

### 当前架构

```
用户输入指令
   ↓
systemPrompt + currentCode + instruction
   ↓
单次 API 调用 (chat.completions)
   ↓
解析响应 → 提取代码块
   ↓
显示 diff 卡片 → 用户确认应用
```

### 对比矩阵

| 维度 | 我们 | ToT | ReAct | Codex | Claude Code | Cursor | Copilot |
|------|------|-----|-------|-------|-------------|--------|---------|
| **推理深度** | 单次 (深度思考=提示工程) | 树搜索 (多路径) | 循环 (思考→行动) | 循环 (思考→工具→观察) | 循环 + 长期记忆 | 循环 + 多文件 | 循环 + 工具 |
| **API 调用次数** | 1 次/请求 | N 次 (树节点) | N 次 (循环步) | N 次 (循环步) | N 次 | N 次 | N 次 |
| **工具调用** | ❌ 无 | ❌ 无 | ✅ 有 | ✅ MCP | ✅ 文件+终端 | ✅ 文件+终端 | ✅ MCP |
| **上下文范围** | 当前文件 | 当前问题 | 环境状态 | 文件系统 | 整个项目 | 整个项目 | 整个项目 |
| **代码执行** | ❌ 无 | ❌ 无 | ✅ 有 | ✅ 沙盒 | ✅ 有 | ✅ 有 | ✅ 有 |
| **多文件编辑** | ❌ 无 | ❌ 无 | ✅ 有 | ✅ 有 | ✅ 有 | ✅ 有 | ✅ 有 |
| **可视化推理** | ✅ 深度思考卡片 | ❌ 无 | ✅ Thought 日志 | ❌ 无 | ❌ 无 | ❌ 无 | ❌ 无 |
| **人机协作** | 确认后应用 | 投票选择 | 每步确认 | 审批模式 | 自然对话 | 实时协作 | 实时协作 |

---

## 三、关键差距 & 可借鉴方案

### 差距 1: 单次调用 vs 多步循环 (ReAct 模式)

**现状**: 我们的 AI 是**单次问答**模式 —— 用户说一句话，AI 给一段代码。没有"思考→行动→观察→再思考"的循环。

**问题场景**:
```
用户: "修复这个页面的所有响应式问题"
AI (单次): 只能基于当前代码给建议，无法:
  - 检查其他 CSS 文件是否有关联样式
  - 在浏览器中预览验证
  - 发现遗漏后补充修复
```

**借鉴方案**: 实现 **ReAct 循环**

```javascript
// 伪代码
async function reactLoop(instruction) {
  const context = { code: getCode(), lang: currentLang };
  const tools = [readFile, writeFile, runPreview, searchCode];
  
  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await llm.chat({
      messages: [
        { role: 'system', content: buildSystemPrompt(tools) },
        { role: 'user', content: instruction },
        ...history  // 之前的 Thought/Action/Observation
      ]
    });
    
    const { thought, action, toolCall } = parseResponse(response);
    addThinkingStep(thought);  // 可视化
    
    if (action === 'finish') break;
    
    const observation = await executeTool(toolCall);  // 执行工具
    history.push({ thought, action, observation });
  }
}
```

**在我们的编辑器中可实现的程度**:
- ✅ 多轮对话历史（已有）
- ⚠️ 工具调用（需要新增）
- ❌ 命令执行（前端限制，可用 iframe 模拟）

---

### 差距 2: 无工具调用能力 (MCP)

**现状**: AI 只能"看"当前文件，不能"动"任何东西。

**竞品能力**:
| 工具 | Codex | Claude Code | Cursor | Copilot |
|------|-------|-------------|--------|---------|
| 读取其他文件 | ✅ | ✅ | ✅ | ✅ |
| 写入文件 | ✅ | ✅ | ✅ | ✅ |
| 运行终端命令 | ✅ | ✅ | ✅ | ✅ |
| 浏览器预览 | ❌ | ✅ | ❌ | ❌ |
| 搜索代码库 | ✅ | ✅ | ✅ | ✅ |

**借鉴方案**: 实现**轻量级 Tool Use**

由于我们是纯前端应用，无法实现真正的文件系统操作。但可以:

```javascript
// 1. 虚拟文件系统（基于 localStorage 的多文件管理）
const tools = {
  read_file: (path) => localStorage.getItem('vfs_' + path),
  write_file: (path, content) => localStorage.setItem('vfs_' + path, content),
  list_files: () => Object.keys(localStorage).filter(k => k.startsWith('vfs_')),
  search_code: (query) => {
    // 在所有存储的文件中搜索
    return allFiles.filter(f => f.content.includes(query));
  },
  run_preview: () => {
    // 触发预览刷新
    updatePreview();
    return '预览已更新';
  }
};

// 2. 让模型输出工具调用格式
// 模型输出:
// <tool>read_file</tool><params>{"path": "styles.css"}</params>
// <thinking>需要检查 CSS 文件...</thinking>
```

**实施优先级**: ⭐⭐⭐⭐⭐（高）

---

### 差距 3: 上下文范围局限于当前文件

**现状**: AI 每次只看到一个文件的内容。

**竞品能力**:
- **Cursor**: 自动维护优先级队列，选择最相关的文件放入上下文
- **Claude Code**: 索引整个项目，建立代码知识图谱
- **Copilot**: `codebase`、`search`、`usages` 工具主动检索

**借鉴方案**: **上下文管理器**

```javascript
// 1. 多文件支持（已有基础：localStorage 多语言存储）
// 扩展到支持用户主动添加文件到上下文

// 2. 相关文件推荐
function getRelatedFiles(currentLang, currentCode) {
  // 基于导入语句分析依赖
  const imports = extractImports(currentCode);
  return imports.map(path => readFile(path)).filter(Boolean);
}

// 3. 上下文窗口管理（优先级队列）
function buildContext(currentFile, relatedFiles) {
  const system = buildSystemPrompt();
  const main = currentFile.code;
  const related = relatedFiles.map(f => f.code).join('\n\n');
  
  // 如果超出 token 限制，按优先级截断
  return truncateByPriority(system + main + related, MAX_TOKENS);
}
```

**实施优先级**: ⭐⭐⭐⭐（中高）

---

### 差距 4: 无代码验证/执行能力

**现状**: AI 生成的代码直接显示给用户，没有自动验证。

**竞品能力**:
| 验证方式 | 说明 |
|---------|------|
| **语法检查** | Claude Code / Codex 运行 `eslint`/`tsc` |
| **单元测试** | Copilot Coding Agent 运行 `npm test` |
| **预览验证** | Claude Computer Use 截图对比 |
| **类型检查** | Cursor 集成 TypeScript LSP |

**借鉴方案**: **前端验证层**

```javascript
// 1. 语法验证（前端可实现）
function validateCode(code, lang) {
  if (lang === 'html') {
    const parser = new DOMParser();
    const doc = parser.parseFromString(code, 'text/html');
    const errors = doc.querySelectorAll('parsererror');
    return errors.length === 0;
  }
  if (lang === 'js' || lang === 'ts') {
    try {
      new Function(code);  // 语法检查
      return true;
    } catch (e) {
      return { valid: false, error: e.message };
    }
  }
  // CSS、JSON 等类似...
}

// 2. 预览自动刷新（已有，但可扩展）
// 在 ReAct 循环中，每步修改后自动刷新预览
// 模型观察预览结果，决定下一步

// 3. 错误捕获与自修复
window.addEventListener('error', (e) => {
  // 将错误信息反馈给 AI
  aiContext.lastError = e.message;
  // 触发重新思考
  triggerReActStep();
});
```

**实施优先级**: ⭐⭐⭐（中）

---

### 差距 5: 无长期记忆/学习

**现状**: 每次对话都是独立的，AI 不记得用户的偏好。

**竞品能力**:
- **Cursor**: 学习用户的编码风格，后续推荐更精准
- **Claude Code**: 记住项目约定和常用模式
- **Copilot**: Custom Instructions 持久化

**借鉴方案**: **用户偏好学习**

```javascript
// 1. 用户偏好存储
const PREF_STORAGE = 'ai_user_preferences';

function learnFromInteraction(instruction, code, userAction) {
  // userAction: 'applied' | 'modified' | 'rejected'
  const prefs = loadPreferences();
  
  if (userAction === 'applied') {
    // 提取风格特征
    prefs.patterns.push(extractPattern(code));
  }
  if (userAction === 'rejected') {
    prefs.negativeExamples.push({ instruction, code });
  }
  
  savePreferences(prefs);
}

// 2. 在 system prompt 中注入偏好
function buildSystemPrompt() {
  const prefs = loadPreferences();
  return `用户偏好:\n${prefs.summary}\n\n原始 system prompt...`;
}
```

**实施优先级**: ⭐⭐（低）

---

## 四、可套用的架构升级方案

### 方案 A: ReAct + Tool Use (中等投入，高回报)

```
┌─────────────────────────────────────────────────────────────┐
│                      用户输入层                              │
│                   (自然语言指令)                             │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    ReAct Agent 循环                          │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐             │
│  │  Thought │───→│  Action  │───→│Observation│             │
│  │  (推理)  │    │ (工具调用)│    │ (结果观察) │             │
│  └──────────┘    └──────────┘    └─────┬────┘             │
│       ↑─────────────────────────────────┘                   │
│  可视化: 每个 Thought 显示在思考卡片中                        │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                      工具层 (MCP-lite)                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │read_file │  │write_file│  │search_code│  │run_preview│   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│  (基于 localStorage 的虚拟文件系统)                          │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                      输出层                                  │
│              (diff 卡片 + 思考过程 + 应用按钮)                │
└─────────────────────────────────────────────────────────────┘
```

**投入**: ~2-3 天开发
**收益**: AI 能力从"单次问答"跃升到"多步自主执行"

---

### 方案 B: 多 Agent 协作 (高投入，极高回报)

受 Cursor Composer 启发:

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Orchestrator                        │
│              (协调多个专用 Agent 的分工)                     │
└─────────────────────────────────────────────────────────────┘
        ↓                  ↓                  ↓
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Planner      │  │ Coder        │  │ Reviewer     │
│ Agent        │  │ Agent        │  │ Agent        │
│ (规划任务)   │  │ (生成代码)   │  │ (审查代码)   │
└──────────────┘  └──────────────┘  └──────────────┘
        ↓                  ↓                  ↓
┌─────────────────────────────────────────────────────────────┐
│              共享状态 (Shared Context)                       │
│     (当前代码、项目结构、对话历史、错误日志)                  │
└─────────────────────────────────────────────────────────────┘
```

**各 Agent 职责**:
| Agent | 职责 | 触发条件 |
|-------|------|---------|
| **Planner** | 分解任务、制定执行计划 | 每次请求开始时 |
| **Coder** | 生成/修改代码 | Planner 输出计划后 |
| **Reviewer** | 审查代码质量、发现潜在问题 | Coder 输出代码后 |
| **Debugger** | 分析错误、提出修复方案 | 预览报错时 |

**投入**: ~1 周开发
**收益**: 接近 Cursor/Claude Code 的 Agent 能力

---

### 方案 C: 树形推理 (ToT) (中等投入，特定场景高回报)

适合**复杂架构决策**场景:

```
用户: "我应该用 React Context 还是 Redux 来管理状态？"

        ┌────────────────────────────────────────┐
        │           问题: 状态管理方案选择         │
        └────────────────────────────────────────┘
                      /           \
           ┌─────────┐             ┌─────────┐
           │方案A:   │             │方案B:   │
           │Context  │             │Redux    │
           └────┬────┘             └────┬────┘
                │                       │
      ┌─────────┴─────────┐   ┌─────────┴─────────┐
      │优点: 简单、内置   │   │优点: 可预测、调试  │
      │缺点: 性能问题     │   │缺点: 样板代码多    │
      └───────────────────┘   └───────────────────┘
                ↓                       ↓
      ┌────────────────────────────────────────┐
      │ 评估: 项目规模小 → Context 足够        │
      │ 决策: 推荐 Context + 未来可迁移到 Redux │
      └────────────────────────────────────────┘
```

**实现方式**: 单次调用但通过**分支提示**让模型生成多个方案并评估。

```javascript
const totPrompt = `
请针对以下问题生成 3 个不同的解决方案：
1. 保守方案（最小改动）
2. 平衡方案（适度优化）
3. 激进方案（全面重构）

然后评估每个方案的优缺点，给出推荐和理由。
`;
```

**投入**: ~1 天（基于已有深度思考框架扩展）
**收益**: 复杂决策场景更可信

---

## 五、实施路线图建议

### Phase 1: ReAct + Tool Use (本周)
- [ ] 定义工具 schema（read_file, write_file, search, run_preview）
- [ ] 实现工具执行器
- [ ] 修改 API 调用逻辑，支持多轮循环
- [ ] 可视化每轮 Thought/Action/Observation

### Phase 2: 上下文扩展 (下周)
- [ ] 多文件主动添加到上下文
- [ ] 导入语句自动分析依赖
- [ ] 相关文件推荐

### Phase 3: 验证与自修复 (第3周)
- [ ] 前端语法验证
- [ ] 预览错误自动捕获
- [ ] 错误反馈到 AI 触发修复循环

### Phase 4: 多 Agent (第4周+)
- [ ] Planner/Coder/Reviewer 分工
- [ ] 共享状态管理
- [ ] Agent 间通信协议

---

## 六、关键结论

| 结论 | 说明 |
|------|------|
| **最大差距** | 单次调用 vs 多步 ReAct 循环（限制了 AI 的自主能力） |
| **最易实现** | 多文件上下文扩展（已有 localStorage 多语言基础） |
| **最高回报** | ReAct + Tool Use（从"问答"升级到"助手"） |
| **长期目标** | 多 Agent 协作（接近 Cursor/Claude Code 体验） |
| **技术限制** | 纯前端无法执行真实系统命令，需用虚拟化方案模拟 |

**一句话总结**: 我们的深度思考模式已经在**可视化推理**上领先竞品，但在**自主执行能力**上差距明显。补上 **ReAct + Tool Use** 这一环，就能从"AI 问答工具"升级为"AI 编程助手"。
