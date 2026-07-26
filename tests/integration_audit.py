from pathlib import Path
from bs4 import BeautifulSoup, Comment
from collections import Counter
import re, subprocess, sys

root = Path(__file__).resolve().parents[1]
index = root / 'index.html'
s = index.read_text(encoding='utf-8')
soup = BeautifulSoup(s, 'html.parser')
checks = []

def add(name, condition, detail=''):
    checks.append((name, bool(condition), detail))

# User-visible text only (exclude scripts/styles/comments).
visible_soup = BeautifulSoup(s, 'html.parser')
for node in visible_soup(['script', 'style', 'template']):
    node.decompose()
for comment in visible_soup.find_all(string=lambda x: isinstance(x, Comment)):
    comment.extract()
visible_text = ' '.join(visible_soup.stripped_strings)

# Regression: CDN library UI must not return.
add('No visible CDN library UI', 'CDN' not in visible_text and not re.search(r'id="(?:panelCdn|cdnSearchInput|cdnLibrary|cdnPanel)"|data-panel="cdn"', s))
add('No stale CDN initializer', not re.search(r'\binitCdnPanel\s*\(', s))
add('Dependencies are internal allowlist only', 'enable_dependency' in s and 'insertBuiltinDependencies' in s and 'add_dependency' not in s)
add('Only HTTPS dependency entries', not re.search(r"url:\s*['\"]http://", s))

# Product structure and prompts.
add('Exactly two primary AI modes', all(soup.find(id=x) for x in ['aiModeAi', 'aiModeAgent']) and not soup.find(id='aiModeDeep'))
add('Deep Thinking nested inside AI', soup.find(id='deepThinkingRow') is not None and "deepThinkingRow.hidden = next === 'agent'" in s)
add('Deep Thinking keeps conversation history', 'buildDeepThinkingPrompt' in s and 'messages.splice(1, 0, ...aiChatHistory.slice' in s)
add('Agent respects selected model', 'const selected = aiModelSelect?.value;' in s and 'if (selected) return selected;' in s)
add('Project-rule priority is explicit', '用户本次明确要求 > PRODUCT.md / DESIGN.md > 当前页面既有风格 > 视觉模板 > 通用默认' in s)
add('Project rules reach normal AI', "getDesignSystemPrompt(bestDesignKeys) + '\\n\\n' + buildContextPrompt()" in s)
add('Project rules reach Agent', "buildContextPrompt() + '\\n\\n'" in s)
add('Project context generation is awaited', 'try { await runAgentLoop(instruction); }' in s)
add('Project terminology is consistent', '项目规范已加载' in s and '正在用 AI 分析代码生成项目规范' in s)

# Preview and rendering safety.
iframe = soup.find('iframe', id='previewFrame')
add('Preview always sandboxed', iframe and iframe.get('sandbox') == ['allow-scripts', 'allow-popups'] and "removeAttribute('sandbox')" not in s)
add('Preview messages validate source frame', 'event.source !== previewFrame.contentWindow' in s)
add('AI HTML uses sanitizer and fallback', 'sanitizeAssistantHtml' in s and 'DOMPurify.sanitize' in s and "const allowed = new Set" in s)
add('No document.write initialization', not re.search(r'(?<![\w.])document\.write\s*\(', re.sub(r"/document\\\.write[^\n]+", '', s)))
add('API requests omit browser credentials', "credentials: 'omit'" in s)
add('API endpoint requires HTTPS', '必须使用 HTTPS；仅 localhost 允许 HTTP' in s and 'validateServiceEndpoint' in s)
add('Sensitive URL query parameters blocked', '不能通过查询参数传递密钥' in s)

# Agent protocol and completion integrity.
for marker in ['normalizeToolDefinition', 'normalizeAssistantToolCalls', 'parseToolArguments', 'safeApiToolName']:
    add(f'Agent protocol includes {marker}', marker in s)
add('Empty tool name triggers compatibility retry', '接口返回了没有工具名的调用，已切换兼容协议重试' in s)
add('Unknown native tools return paired results', '本批工具因存在未注册工具而未执行' in s and "role: 'tool', tool_call_id: tc.id" in s)
add('Complete must be isolated', 'complete 必须单独调用，并位于所有编辑与验证之后' in s)
add('Completion requires post-edit validation', 'codeCheckAfterChange' in s and 'visualVerifiedAfterChange' in s and '代码已修改但验证尚未完成' in s)
add('Agent budgets do not claim completion', 'Agent 已停止：' in s and '任务尚未确认完成' in s and 'if (stopReason) return;' in s)
add('Repeat tool calls are blocked', '相同工具与参数已连续使用超过两次' in s and 'recordToolInvocation' in s)
add('Fallback does not duplicate assistant message', "messages.push({ role: 'assistant', content: msg.content });" not in s)
add('Fallback without tools remains unconfirmed', '当前兼容协议没有返回可执行工具调用，任务未自动应用' in s)
add('Agent code blocks are not auto-applied', 'Agent 未通过工具调用的代码块只展示，不自动写入编辑器' in s)
add('Large files use segmented analysis', '大文件已启用分段分析' in s and '单次最多 500 行' in s)
add('Normal AI blocks oversized whole-file prompts', 'currentCode.length > 160000' in s)
add('Formatting uses Prettier', '已使用 Prettier 格式化' in s and 'plugins/estree.js' in s)
add('Search/image tools need explicit intent', 'const allowSearch' in s and 'const allowImage' in s)
add('Unsupported GSAP plugins not promised', '不得假设 SplitText、MorphSVG、DrawSVG、ScrollSmoother' in s and 'gsap-trial' not in s)
add('Public API prompt matches actual shortlist', '系统当前维护 8 个经过筛选的 HTTPS 示例' in s and '编辑器内置了 80+' not in s)

# MCP safety and routing.
mcp = (root / 'lib/mcp-bridge.js').read_text(encoding='utf-8')
add('MCP same-name tools route by server', 'async callTool(name, args, serverId)' in mcp and 'route.serverId' in s)
add('MCP keys are session-only', 'SESSION_KEY_PREFIX' in mcp and 'sessionStorage.setItem' in mcp and 'apiKey:' not in re.search(r'function persistServers\(\)[\s\S]*?\n  \}', mcp).group(0))
add('MCP requests omit credentials', "credentials: 'omit'" in mcp)
add('MCP unsafe URLs blocked', 'MCP 服务器必须使用 HTTPS' in mcp and 'MCP URL 不能通过查询参数携带密钥' in mcp)
add('External MCP tools default read-only', 'isReadOnlyExternalTool' in s)

# Mobile adaptation.
add('Viewport supports notches and keyboard', 'viewport-fit=cover' in s and 'interactive-widget=resizes-content' in s)
add('Dynamic viewport and safe areas', '100dvh' in s and 'safe-area-inset-bottom' in s and 'visualViewport' in s)
add('Mobile editor/split/preview navigation', all(f'data-view="{v}"' in s for v in ['editor', 'split', 'preview']))
add('Mobile AI drawer entry', 'data-view="assistant"' in s and "openDrawer('ai')" in s)
add('Mobile view state reflects actual layout', 'setPrimaryView(view' in s and 'syncNav(view)' in s)
add('Mobile split ratio stored separately', 'werkstatt_mobile_split_ratio_v2' in s)
add('Mobile controls have touch sizing', 'min-height: 44px' in s)
add('iOS inputs avoid auto zoom', re.search(r'\.ai-chat-input,[\s\S]{0,300}font-size:\s*16px\s*!important', s) is not None)
add('Landscape phone behavior handled', 'isLandscapePhone()' in s)

# HTML/accessibility/static integrity.
ids = [tag['id'] for tag in soup.find_all(id=True)]
add('No duplicate HTML IDs', not [k for k,v in Counter(ids).items() if v > 1])
add('All static buttons declare type', all(btn.get('type') for btn in soup.find_all('button')))
label_for = {lab.get('for') for lab in soup.find_all('label') if lab.get('for')}
unnamed = []
for control in soup.find_all(['input','select','textarea']):
    if control.has_attr('hidden') or control.get('type') == 'hidden':
        continue
    cid = control.get('id')
    named = bool(control.get('aria-label') or control.get('aria-labelledby') or control.get('title') or cid in label_for or control.find_parent('label'))
    if not named: unnamed.append(cid or control.name)
add('All form controls have accessible names', not unnamed, ', '.join(unnamed))
aria_refs = []
for tag in soup.find_all(True):
    for attr in ['aria-controls','aria-labelledby','aria-describedby']:
        for ref in (tag.get(attr) or '').split():
            if ref and ref not in ids: aria_refs.append(f'{attr}:{ref}')
add('ARIA references resolve', not aria_refs, ', '.join(aria_refs))
used = set(re.findall(r'var\((--[\w-]+)', s))
defined = set(re.findall(r'(--[\w-]+)\s*:', s))
add('No undefined CSS variables', not (used - defined), ', '.join(sorted(used-defined)))
init_calls = set(re.findall(r'\b(init[A-Z]\w*)\s*\(', s))
init_defs = set(re.findall(r'function\s+(init[A-Z]\w*)\s*\(', s))
add('No missing init functions', not (init_calls - init_defs), ', '.join(sorted(init_calls-init_defs)))
local_srcs = []
for tag in soup.find_all(['script','link']):
    src = tag.get('src') or tag.get('href')
    if src and not re.match(r'^[a-z]+://', src) and not src.startswith(('data:','#')):
        local_srcs.append(src)
missing_local = [src for src in local_srcs if not (root/src).exists()]
add('All required local assets exist', not missing_local, ', '.join(missing_local))

# JavaScript syntax.
syntax_errors = []
for i, code in enumerate(re.findall(r'<script(?:\s[^>]*)?>(.*?)</script>', s, re.S|re.I)):
    if not code.strip(): continue
    tmp = Path('/tmp') / f'werkstatt_integration_{i}.js'
    tmp.write_text(code, encoding='utf-8')
    run = subprocess.run(['node','--check',str(tmp)], capture_output=True, text=True)
    if run.returncode: syntax_errors.append(f'inline-{i}: {run.stderr.splitlines()[-1] if run.stderr else "syntax error"}')
for file in [root/'lib/antipatterns.js', root/'lib/mcp-bridge.js']:
    run = subprocess.run(['node','--check',str(file)], capture_output=True, text=True)
    if run.returncode: syntax_errors.append(f'{file.name}: syntax error')
add('All JavaScript parses', not syntax_errors, '; '.join(syntax_errors))

for name, ok, detail in checks:
    print(('PASS' if ok else 'FAIL') + ': ' + name + (f' — {detail}' if detail and not ok else ''))
failed = [(n,d) for n,o,d in checks if not o]
print(f'\n{len(checks)-len(failed)}/{len(checks)} checks passed')
if failed:
    print('Failed:')
    for name, detail in failed: print('-', name, detail)
    sys.exit(1)
