from pathlib import Path
from bs4 import BeautifulSoup
from collections import Counter
import re, subprocess, sys
root=Path('/mnt/data/integrated_fix')
s=(root/'index.html').read_text(encoding='utf-8')
soup=BeautifulSoup(s,'html.parser')
checks={}
def check(name,cond):
    checks[name]=bool(cond)
check('CDN user panel removed', not re.search(r'data-panel="cdn"|id="panelCdn"|id="cdnSearchInput"|CDN_PRESETS|initCdnPanel\s*\(',s))
check('AI and Agent are the only primary modes', all(x in s for x in ['id="aiModeAi"','id="aiModeAgent"','id="deepThinkingRow"']))
check('Project rules applied to normal AI', 'getDesignSystemPrompt(bestDesignKeys) + \'\\n\\n\' + buildContextPrompt()' in s)
check('Preview sandbox never removed', 'sandbox="allow-scripts allow-popups"' in s and "removeAttribute('sandbox')" not in s)
check('AI HTML sanitized', 'sanitizeAssistantHtml' in s and 'dompurify/3.2.6' in s)
check('Agent tools normalized', all(x in s for x in ['normalizeToolDefinition','normalizeAssistantToolCalls','parseToolArguments']))
check('MCP same-name routing', 'route.serverId' in s and 'async callTool(name, args, serverId)' in (root/'lib/mcp-bridge.js').read_text())
check('Agent respects selected model', 'const selected = aiModelSelect?.value;' in s)
check('Agent budgets enforced', 'totalTurns > 20' in s and 'totalToolCalls >= 40' in s and 'if (stopReason) return;' in s)
check('Agent large-file segmented analysis', '大文件已启用分段分析' in s and "startLine: { type: 'number'" in s)
check('Agent uses Prettier', '已使用 Prettier 格式化' in s and 'plugins/estree.js' in s)
check('Search and image tools require explicit intent', 'const allowSearch' in s and 'const allowImage' in s)
check('Secrets not persisted long-term', 'const secureStorage' in s and 'sessionStorage.getItem' in s and '记住 Key' not in s)
check('Trusted dependency allowlist only', 'enable_dependency' in s and 'add_dependency' not in s)
check('Unsupported GSAP trial scripts absent', 'gsap-trial' not in s and not re.search(r'(SplitText|MorphSVG|ScrollSmoother).*\.js',s))
check('Mobile AI drawer and 3 primary views', 'data-view="assistant"' in s and all(f"data-view=\"{v}\"" in s for v in ['editor','split','preview']))
check('Modal focus trap', 'Modal keyboard and focus management' in s and 'modalClassObserver' in s)
ids=[x['id'] for x in soup.find_all(id=True)]
check('No duplicate HTML ids', not [k for k,v in Counter(ids).items() if v>1])
check('All static buttons have type', all(b.get('type') for b in soup.find_all('button')))
used=set(re.findall(r'var\((--[\w-]+)',s)); defined=set(re.findall(r'(--[\w-]+)\s*:',s))
check('No undefined CSS variables', not (used-defined))
init_calls=set(re.findall(r'\b(init[A-Z]\w*)\s*\(',s)); init_defs=set(re.findall(r'function\s+(init[A-Z]\w*)\s*\(',s))
check('No missing init functions', not (init_calls-init_defs))
# JS syntax
scripts=re.findall(r'<script(?:\s[^>]*)?>(.*?)</script>',s,re.S|re.I)
syntax_ok=True
for i,code in enumerate(scripts):
    if not code.strip(): continue
    tmp=Path('/tmp')/f'werk_static_{i}.js';tmp.write_text(code)
    if subprocess.run(['node','--check',str(tmp)],capture_output=True).returncode: syntax_ok=False
for f in [root/'lib/antipatterns.js',root/'lib/mcp-bridge.js']:
    if subprocess.run(['node','--check',str(f)],capture_output=True).returncode: syntax_ok=False
check('All JavaScript parses',syntax_ok)
for name,ok in checks.items(): print(('PASS' if ok else 'FAIL')+': '+name)
failed=[k for k,v in checks.items() if not v]
print(f'\n{len(checks)-len(failed)}/{len(checks)} checks passed')
if failed: print('Failed:',failed);sys.exit(1)
