# Werkstatt 集成修复版

此版本把手机版适配重新合并到最新的 AI / Agent、安全与项目规范实现中。

## 建议使用

直接打开根目录的 `index.html`，或通过静态 HTTP 服务器运行。

如果替换到原项目，请同时替换：

- `index.html`
- `src/index.html`
- `lib/antipatterns.js`
- `lib/mcp-bridge.js`
- `src/lib/antipatterns.js`
- `src/lib/mcp-bridge.js`

## 关键变化

- 普通用户界面不再显示 CDN 库管理入口。
- 外部依赖由 Agent 的可信内置清单自动启用。
- 只保留 AI / Agent 两个主模式；深度思考属于 AI 模式内部能力。
- 保留项目规范优先级、预览沙箱、AI 输出净化、工具调用兼容与手机版抽屉。
- API Key 与 MCP Key 仅保存在当前标签页会话中。

## 测试

```bash
node tests/agent_protocol_test.js
node tests/mcp_bridge_test.js
python tests/integration_audit.py
```

浏览器端真实 API / MCP 调用仍需要在你的服务环境中验证。
