const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(`Function not found: ${name}`);
  const braceStart = html.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = braceStart; i < html.length; i++) {
    const ch = html[i];
    const next = html[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`Unclosed function: ${name}`);
}

const sandbox = { Date, JSON, String, Object, Array, Error };
vm.createContext(sandbox);
vm.runInContext(extractFunction('parseToolArguments'), sandbox);
vm.runInContext(extractFunction('normalizeAssistantToolCalls'), sandbox);
const { parseToolArguments, normalizeAssistantToolCalls } = sandbox;

assert.deepStrictEqual(JSON.parse(JSON.stringify(parseToolArguments(null))), {});
assert.deepStrictEqual(JSON.parse(JSON.stringify(parseToolArguments({ a: 1 }))), { a: 1 });
assert.deepStrictEqual(JSON.parse(JSON.stringify(parseToolArguments('{"startLine":"12"}'))), { startLine: '12' });
assert.deepStrictEqual(JSON.parse(JSON.stringify(parseToolArguments('"{\\"query\\":\\"button\\"}"'))), { query: 'button' });
assert.deepStrictEqual(JSON.parse(JSON.stringify(parseToolArguments('```json\n{"x":1}\n```'))), { x: 1 });
assert.throws(() => parseToolArguments('{bad json}'), /有效 JSON/);

let calls = normalizeAssistantToolCalls({
  tool_calls: [{ id: 'a', function: { name: 'analyze_code', arguments: '{"query":"nav"}' } }]
});
assert.strictEqual(calls.length, 1);
assert.strictEqual(calls[0].function.name, 'analyze_code');
assert.strictEqual(calls[0].id, 'a');

calls = normalizeAssistantToolCalls({ function_call: { name: 'run_code_check', arguments: '{}' } });
assert.strictEqual(calls[0].function.name, 'run_code_check');
assert.ok(calls[0].id);

calls = normalizeAssistantToolCalls({ toolCalls: [{ tool_call_id: 'b', name: 'preview_code', arguments: {} }] });
assert.strictEqual(calls[0].id, 'b');
assert.strictEqual(calls[0].function.name, 'preview_code');

calls = normalizeAssistantToolCalls({ content: [{ type: 'tool_use', id: 'c', name: 'get_selection', input: { compact: true } }] });
assert.strictEqual(calls[0].id, 'c');
assert.strictEqual(calls[0].function.name, 'get_selection');
assert.deepStrictEqual(JSON.parse(JSON.stringify(calls[0].function.arguments)), { compact: true });

calls = normalizeAssistantToolCalls({ tool_calls: [{ function: { name: '', arguments: '{}' } }] });
assert.strictEqual(calls[0].function.name, '');
assert.ok(calls[0].id);

const requiredProtocolMarkers = [
  "complete 必须单独调用",
  "本批工具因存在未注册工具而未执行",
  "工具参数解析失败",
  "相同工具与参数已连续使用超过两次",
  "代码已修改但验证尚未完成",
  "当前兼容协议没有返回可执行工具调用，任务未自动应用"
];
for (const marker of requiredProtocolMarkers) assert.ok(html.includes(marker), `Missing protocol marker: ${marker}`);

const duplicateFallbackAssistant = "messages.push({ role: 'assistant', content: msg.content });";
assert.ok(!html.includes(duplicateFallbackAssistant), 'Fallback mode should not duplicate assistant messages');

console.log('Agent protocol tests: PASS');
