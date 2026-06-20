/**
 * MCPBridge —— Werkstatt AI 编辑器的 MCP（Model Context Protocol）桥接模块
 * ============================================================================
 *
 * 模块用途：
 *   1. 将 Werkstatt 现有 14 个内置 Agent 工具包装为 MCP 标准工具定义；
 *   2. 支持通过 SSE / HTTP 传输连接外部 MCP 服务器，发现并调用其工具；
 *   3. 提供统一的工具发现（getAllTools）与调用（callTool）接口，自动路由到
 *      内置 handler 或外部服务器；
 *   4. 保持与现有 Agent 引擎（executeAgentTool）的完全兼容——内置工具的实际
 *      执行逻辑仍由 Agent 引擎注入，本模块仅负责 schema 包装与路由分发；
 *   5. 服务器配置持久化到 localStorage，启动时自动重连。
 *
 * MCP 协议参考：
 *   - 规范：https://modelcontextprotocol.io/specification
 *   - 工具定义：{ name, description, inputSchema(JSON Schema) }
 *   - JSON-RPC 2.0 消息：{ jsonrpc:"2.0", id, method, params } / { jsonrpc:"2.0", id, result|error }
 *   - 传输层：stdio（本地进程，浏览器不可用）、SSE（HTTP 流）、WebSocket
 *
 * 运行环境：浏览器端（非 Node.js），仅使用原生 API（EventSource / fetch / localStorage）。
 *
 * 挂载点：window.MCPBridge
 * ============================================================================
 */
(function (global) {
    'use strict';

    // localStorage 存储键
    var STORAGE_KEY = 'mcp_servers';

    // 默认请求超时（毫秒）
    var DEFAULT_TIMEOUT = 30000;

    // 心跳间隔（毫秒）
    var HEARTBEAT_INTERVAL = 25000;

    // JSON-RPC 2.0 方法名
    var METHOD_INITIALIZE = 'initialize';
    var METHOD_TOOLS_LIST = 'tools/list';
    var METHOD_TOOLS_CALL = 'tools/call';
    var METHOD_PING = 'ping';

    // 标准错误码（JSON-RPC 2.0 + MCP 约定）
    var ERR_PARSE_ERROR = -32700;
    var ERR_INVALID_REQUEST = -32600;
    var ERR_METHOD_NOT_FOUND = -32601;
    var ERR_INVALID_PARAMS = -32602;
    var ERR_INTERNAL = -32603;
    var ERR_TIMEOUT = -32001;
    var ERR_CONNECTION = -32002;

    /**
     * 生成唯一请求 ID（单调递增）
     */
    var _requestId = 1;
    function nextId() { return _requestId++; }

    /**
     * 生成唯一服务器 ID
     */
    function genServerId() {
        return 'srv_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    /**
     * 简单深拷贝（用于 schema / 配置等纯数据对象）
     */
    function clone(obj) {
        if (obj === null || typeof obj !== 'object') return obj;
        try {
            return JSON.parse(JSON.stringify(obj));
        } catch (e) {
            return obj;
        }
    }

    /**
     * 带超时的 Promise 包装
     * @param {Promise} promise 原始 Promise
     * @param {number} ms 超时毫秒
     * @param {string} label 超时描述（用于错误信息）
     */
    function withTimeout(promise, ms, label) {
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () {
                reject(makeError(ERR_TIMEOUT, '请求超时: ' + (label || '操作') + ' (' + ms + 'ms)'));
            }, ms);
            promise.then(
                function (v) { clearTimeout(timer); resolve(v); },
                function (e) { clearTimeout(timer); reject(e); }
            );
        });
    }

    /**
     * 构造 JSON-RPC 错误对象
     */
    function makeError(code, message, data) {
        var err = new Error(message);
        err.code = code;
        if (data !== undefined) err.data = data;
        return err;
    }

    /**
     * 判断字符串是否以内置结果前缀开头（[OK]/[ERR]/[WARN]）
     */
    function isBuiltinResultString(s) {
        return typeof s === 'string' && /^\[(OK|ERR|WARN)\]/.test(s);
    }

    /**
     * 将任意工具执行结果标准化为 MCP content 数组格式
     * MCP 工具调用结果约定：{ content: [{ type:"text", text:"..." }], isError?: boolean }
     */
    function normalizeResult(raw) {
        // 已经是 MCP 标准结构
        if (raw && typeof raw === 'object' && Array.isArray(raw.content)) {
            return raw;
        }
        var text;
        var isError = false;
        if (typeof raw === 'string') {
            text = raw;
            if (raw.indexOf('[ERR]') === 0) isError = true;
        } else if (raw instanceof Error) {
            text = raw.message;
            isError = true;
        } else if (raw === undefined || raw === null) {
            text = '';
        } else {
            try { text = JSON.stringify(raw); } catch (e) { text = String(raw); }
        }
        return { content: [{ type: 'text', text: text }], isError: isError };
    }

    // ========================================================================
    // 内置工具 schema 定义（由现有 AGENT_TOOLS 转换而来）
    // 实际执行 handler 由 Agent 引擎在 init 时注入（registerBuiltinHandler）。
    // ========================================================================
    var BUILTIN_TOOL_DEFS = [
        {
            name: 'analyze_code',
            description: '读取并分析当前编辑器中的完整代码，了解结构和内容',
            inputSchema: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'edit_code',
            description: '使用行号编辑格式修改代码。每行代码左侧有行号。',
            inputSchema: {
                type: 'object',
                properties: {
                    operation: { type: 'string', enum: ['replace', 'insert', 'delete'], description: '操作类型' },
                    startLine: { type: 'number', description: '起始行号（1-based）' },
                    endLine: { type: 'number', description: '结束行号（1-based，replace/delete 时使用）' },
                    afterLine: { type: 'number', description: '在此行后插入（insert 时使用）' },
                    code: { type: 'string', description: '新代码内容（replace/insert 时使用）' }
                },
                required: ['operation']
            }
        },
        {
            name: 'preview_code',
            description: '刷新实时预览，查看当前代码的运行效果',
            inputSchema: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'search_web',
            description: '搜索网页获取最新信息、文档、API 参考',
            inputSchema: {
                type: 'object',
                properties: { query: { type: 'string', description: '搜索关键词' } },
                required: ['query']
            }
        },
        {
            name: 'generate_image',
            description: '使用 AI 图片生成模型创建图片，返回 URL 可直接嵌入代码',
            inputSchema: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: '图片描述（英文效果更好）' },
                    size: { type: 'string', enum: ['1024x1024', '1792x1024', '1024x1792'], description: '图片尺寸' }
                },
                required: ['prompt']
            }
        },
        {
            name: 'add_dependency',
            description: '在预览 HTML 中添加 CDN 依赖（如 GSAP、Chart.js 等）',
            inputSchema: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'CDN 资源的完整 URL' },
                    type: { type: 'string', enum: ['script', 'style'], description: '资源类型' }
                },
                required: ['url', 'type']
            }
        },
        {
            name: 'get_skill',
            description: '获取内置技能知识（GSAP 动画、设计系统、代码片段）',
            inputSchema: {
                type: 'object',
                properties: {
                    domain: { type: 'string', enum: ['gsap', 'design', 'snippet', 'api'], description: '技能领域' },
                    query: { type: 'string', description: '具体查询内容' }
                },
                required: ['domain']
            }
        },
        {
            name: 'undo_edit',
            description: '撤销上一步代码编辑操作（CodeMirror undo）',
            inputSchema: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'batch_edit',
            description: '批量执行多个编辑操作（replace/insert/delete），按从后往前的顺序自动处理行号偏移',
            inputSchema: {
                type: 'object',
                properties: {
                    operations: {
                        type: 'array',
                        description: '编辑操作列表',
                        items: {
                            type: 'object',
                            properties: {
                                operation: { type: 'string', enum: ['replace', 'insert', 'delete'] },
                                startLine: { type: 'number', description: '起始行号（1-based）' },
                                endLine: { type: 'number', description: '结束行号' },
                                afterLine: { type: 'number', description: '在此行后插入' },
                                code: { type: 'string', description: '新代码内容' }
                            },
                            required: ['operation']
                        }
                    }
                },
                required: ['operations']
            }
        },
        {
            name: 'format_code',
            description: '格式化当前代码（统一缩进、清理多余空行、对齐属性）',
            inputSchema: {
                type: 'object',
                properties: {
                    mode: { type: 'string', enum: ['indent', 'full'], description: 'indent=仅统一缩进，full=完整格式化' }
                },
                required: []
            }
        },
        {
            name: 'get_selection',
            description: '获取编辑器中当前选中的代码文本及行号范围',
            inputSchema: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'run_code_check',
            description: '对当前代码运行安全检查（函数完整性、标签闭合、潜在问题）',
            inputSchema: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'get_console',
            description: '获取预览 iframe 的最近控制台日志（console.log/warn/error）',
            inputSchema: {
                type: 'object',
                properties: { lines: { type: 'number', description: '获取最近几条日志（默认 20）' } },
                required: []
            }
        },
        {
            name: 'complete',
            description: '标记任务完成，总结所做修改',
            inputSchema: {
                type: 'object',
                properties: { summary: { type: 'string', description: '完成总结' } },
                required: ['summary']
            }
        }
    ];

    // ========================================================================
    // MCPBridge 主对象
    // ========================================================================
    var MCPBridge = {
        // 内置工具注册表：Map<name, { name, description, inputSchema, _source, _handler }>
        builtinTools: null,
        // 外部 MCP 服务器连接：Map<serverId, ServerConn>
        servers: null,
        // 回调钩子列表
        _hooks: null,
        // 是否已初始化
        _initialized: false
    };

    /**
     * 服务器连接对象结构：
     * {
     *   id, name, url, transport, apiKey,
     *   status: 'connecting'|'connected'|'disconnected'|'error',
     *   tools: [MCP tool def],
     *   es: EventSource|null,           // SSE 传输
     *   postEndpoint: string|null,      // SSE 模式下 POST 目标地址
     *   pending: Map<id, {resolve, reject, timer}>,  // 待响应请求
     *   heartbeatTimer, reconnectTimer,
     *   lastError, connectedAt
     * }
     */

    // ------------------------------------------------------------------------
    // 初始化
    // ------------------------------------------------------------------------

    /**
     * 初始化 MCPBridge：构建内置工具表，加载持久化配置并重连服务器。
     */
    MCPBridge.init = function () {
        if (this._initialized) return;
        this.builtinTools = new Map();
        this.servers = new Map();
        this._hooks = {
            serverConnect: [],
            serverDisconnect: [],
            toolCall: [],
            error: []
        };

        // 注册 14 个内置工具（handler 暂为 null，由 Agent 引擎注入）
        BUILTIN_TOOL_DEFS.forEach(function (def) {
            this.builtinTools.set(def.name, {
                name: def.name,
                description: def.description,
                inputSchema: clone(def.inputSchema),
                _source: 'builtin',
                _handler: null
            });
        }, this);

        this._initialized = true;

        // 异步重连已保存的服务器（不阻塞初始化）
        var self = this;
        setTimeout(function () { self._reconnectSavedServers(); }, 0);
    };

    /**
     * 从 localStorage 读取并重连已保存的服务器配置
     */
    MCPBridge._reconnectSavedServers = function () {
        var saved = this._loadSavedServers();
        if (!saved || saved.length === 0) return;
        var self = this;
        saved.forEach(function (cfg) {
            // 静默重连，失败不弹错误
            self.connectServer(cfg).catch(function (err) {
                self._emit('error', { source: 'reconnect', serverId: cfg.id, error: err });
            });
        });
    };

    // ------------------------------------------------------------------------
    // 内置工具注册
    // ------------------------------------------------------------------------

    /**
     * 注册一个内置工具（或覆盖 schema）。通常用于初始化时注册自定义工具。
     * @param {string} name 工具名
     * @param {object} schema MCP 工具定义 { description, inputSchema }
     * @param {function|null} handler 异步处理函数 (args) => result
     */
    MCPBridge.registerBuiltin = function (name, schema, handler) {
        if (!name || typeof name !== 'string') {
            throw new Error('registerBuiltin: name 必须是非空字符串');
        }
        var def = {
            name: name,
            description: (schema && schema.description) || '',
            inputSchema: (schema && schema.inputSchema) || { type: 'object', properties: {}, required: [] },
            _source: 'builtin',
            _handler: typeof handler === 'function' ? handler : null
        };
        this.builtinTools.set(name, def);
        return def;
    };

    /**
     * 为已注册的内置工具注入实际执行 handler（由 Agent 引擎调用）。
     * 这保证现有 executeAgentTool 逻辑不变，仅通过本桥接暴露统一接口。
     * @param {string} name 工具名
     * @param {function} handler (args) => result
     */
    MCPBridge.registerBuiltinHandler = function (name, handler) {
        var def = this.builtinTools.get(name);
        if (!def) {
            throw new Error('registerBuiltinHandler: 未知内置工具 ' + name);
        }
        if (typeof handler !== 'function') {
            throw new Error('registerBuiltinHandler: handler 必须是函数');
        }
        def._handler = handler;
    };

    /**
     * 批量注入内置 handler（便捷方法）
     * @param {object} handlers { toolName: handlerFn }
     */
    MCPBridge.registerBuiltinHandlers = function (handlers) {
        var self = this;
        Object.keys(handlers || {}).forEach(function (name) {
            if (self.builtinTools.has(name)) {
                self.builtinTools.get(name)._handler = handlers[name];
            }
        });
    };

    // ------------------------------------------------------------------------
    // 外部 MCP 服务器连接
    // ------------------------------------------------------------------------

    /**
     * 连接外部 MCP 服务器
     * @param {object} config { id?, name, url, transport:'sse'|'http', apiKey?, timeout? }
     * @returns {Promise<{id, name, status, tools}>}
     */
    MCPBridge.connectServer = function (config) {
        var self = this;
        if (!this._initialized) this.init();

        // 参数校验
        if (!config || !config.url) {
            return Promise.reject(makeError(ERR_INVALID_PARAMS, 'connectServer: 缺少 url'));
        }
        var transport = config.transport || 'sse';
        if (transport !== 'sse' && transport !== 'http') {
            return Promise.reject(makeError(ERR_INVALID_PARAMS, 'connectServer: 不支持的传输类型 ' + transport));
        }

        var id = config.id || genServerId();
        // 若已存在同 id 连接，先断开
        if (this.servers.has(id)) {
            this._disconnectServerInternal(id, 'reconnect');
        }

        var conn = {
            id: id,
            name: config.name || id,
            url: config.url,
            transport: transport,
            apiKey: config.apiKey || null,
            status: 'connecting',
            tools: [],
            es: null,
            postEndpoint: null,
            pending: new Map(),
            heartbeatTimer: null,
            reconnectTimer: null,
            lastError: null,
            connectedAt: null,
            timeout: config.timeout || DEFAULT_TIMEOUT
        };
        this.servers.set(id, conn);

        // 持久化配置（不含运行时字段）
        this._persistServerConfig(conn);

        // 根据传输类型建立连接
        var connectPromise;
        if (transport === 'sse') {
            connectPromise = this._connectSSE(conn);
        } else {
            connectPromise = this._connectHTTP(conn);
        }

        return connectPromise.then(function (tools) {
            conn.status = 'connected';
            conn.connectedAt = Date.now();
            conn.tools = tools;
            self._startHeartbeat(conn);
            self._emit('serverConnect', { serverId: id, name: conn.name, tools: tools });
            return { id: id, name: conn.name, status: 'connected', tools: tools };
        }).catch(function (err) {
            conn.status = 'error';
            conn.lastError = err.message || String(err);
            self._emit('error', { source: 'connectServer', serverId: id, error: err });
            // 清理半连接资源
            self._cleanupConnection(conn);
            throw err;
        });
    };

    /**
     * SSE 传输连接流程：
     *   1. EventSource 连接 {url}/sse，监听 endpoint 事件获取 POST 地址；
     *   2. 通过 POST {postEndpoint} 发送 initialize 请求；
     *   3. 调用 tools/list 获取工具清单。
     */
    MCPBridge._connectSSE = function (conn) {
        var self = this;
        return new Promise(function (resolve, reject) {
            var sseUrl = conn.url.replace(/\/$/, '') + '/sse';
            var settled = false;

            function fail(err) {
                if (settled) return;
                settled = true;
                reject(err);
            }

            var es;
            try {
                es = new EventSource(sseUrl, { withCredentials: !!conn.apiKey });
            } catch (e) {
                return fail(makeError(ERR_CONNECTION, 'EventSource 创建失败: ' + e.message));
            }
            conn.es = es;

            // 超时保护
            var timeoutTimer = setTimeout(function () {
                fail(makeError(ERR_TIMEOUT, 'SSE 连接超时 (' + conn.timeout + 'ms)'));
            }, conn.timeout);

            // 收到 endpoint 事件 → 拿到 POST 地址后发 initialize
            es.addEventListener('endpoint', function (evt) {
                if (settled) return;
                var endpoint = evt.data;
                if (!endpoint) {
                    return fail(makeError(ERR_CONNECTION, 'SSE 未返回 endpoint'));
                }
                // endpoint 可能是相对路径，拼接 base url
                conn.postEndpoint = self._resolveUrl(conn.url, endpoint);
                clearTimeout(timeoutTimer);

                // initialize
                self._sseRequest(conn, METHOD_INITIALIZE, {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: { name: 'werkstatt-mcp-bridge', version: '1.0.0' }
                }).then(function () {
                    // tools/list
                    return self._sseRequest(conn, METHOD_TOOLS_LIST, {});
                }).then(function (result) {
                    settled = true;
                    resolve((result && result.tools) || []);
                }).catch(function (err) {
                    fail(err);
                });
            });

            // 通用 message 事件（部分实现用 message 而非 endpoint）
            es.addEventListener('message', function (evt) {
                // 仅当尚未拿到 endpoint 时尝试解析
                if (conn.postEndpoint) return;
                try {
                    var data = JSON.parse(evt.data);
                    if (data && data.endpoint) {
                        conn.postEndpoint = self._resolveUrl(conn.url, data.endpoint);
                    }
                } catch (e) { /* ignore */ }
            });

            es.onerror = function () {
                if (settled) {
                    // 连接建立后断开 → 标记断开并尝试重连
                    if (conn.status === 'connected') {
                        self._handleDisconnect(conn, 'SSE 连接中断');
                    }
                    return;
                }
                fail(makeError(ERR_CONNECTION, 'SSE 连接失败（' + sseUrl + '）'));
            };
        });
    };

    /**
     * HTTP 传输连接流程：直接 POST initialize → tools/list
     */
    MCPBridge._connectHTTP = function (conn) {
        var self = this;
        var endpoint = conn.url.replace(/\/$/, '');
        conn.postEndpoint = endpoint;

        return self._httpRequest(conn, METHOD_INITIALIZE, {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'werkstatt-mcp-bridge', version: '1.0.0' }
        }).then(function () {
            return self._httpRequest(conn, METHOD_TOOLS_LIST, {});
        }).then(function (result) {
            return (result && result.tools) || [];
        });
    };

    /**
     * 通过 SSE 传输发送 JSON-RPC 请求：POST 到 postEndpoint，响应经 EventSource 流返回。
     */
    MCPBridge._sseRequest = function (conn, method, params) {
        var self = this;
        return new Promise(function (resolve, reject) {
            if (!conn.postEndpoint) {
                return reject(makeError(ERR_CONNECTION, 'SSE postEndpoint 未就绪'));
            }
            var id = nextId();
            var payload = { jsonrpc: '2.0', id: id, method: method, params: params || {} };

            var timer = setTimeout(function () {
                conn.pending.delete(id);
                reject(makeError(ERR_TIMEOUT, 'SSE 请求超时: ' + method));
            }, conn.timeout);

            conn.pending.set(id, { resolve: resolve, reject: reject, timer: timer });

            fetch(conn.postEndpoint, {
                method: 'POST',
                headers: self._buildHeaders(conn),
                body: JSON.stringify(payload),
                credentials: conn.apiKey ? 'include' : 'same-origin'
            }).catch(function (e) {
                clearTimeout(timer);
                conn.pending.delete(id);
                reject(makeError(ERR_CONNECTION, 'SSE POST 失败: ' + e.message));
            });
        });
    };

    /**
     * 处理 SSE 流上收到的 JSON-RPC 响应消息
     */
    MCPBridge._handleSSEMessage = function (conn, raw) {
        var msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }
        if (!msg || msg.jsonrpc !== '2.0' || msg.id === undefined) return;

        var entry = conn.pending.get(msg.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        conn.pending.delete(msg.id);

        if (msg.error) {
            entry.reject(makeError(msg.error.code || ERR_INTERNAL, msg.error.message || 'JSON-RPC 错误', msg.error.data));
        } else {
            entry.resolve(msg.result);
        }
    };

    /**
     * 通过 HTTP 传输发送 JSON-RPC 请求（单次 POST，同步响应）
     */
    MCPBridge._httpRequest = function (conn, method, params) {
        var self = this;
        var id = nextId();
        var payload = { jsonrpc: '2.0', id: id, method: method, params: params || {} };

        var fetchPromise = fetch(conn.postEndpoint, {
            method: 'POST',
            headers: self._buildHeaders(conn),
            body: JSON.stringify(payload),
            credentials: conn.apiKey ? 'include' : 'same-origin'
        }).then(function (res) {
            if (!res.ok) {
                return res.text().then(function (t) {
                    throw makeError(ERR_CONNECTION, 'HTTP ' + res.status + ': ' + t.slice(0, 200));
                });
            }
            return res.json();
        }).then(function (msg) {
            if (!msg || msg.jsonrpc !== '2.0') {
                throw makeError(ERR_INVALID_REQUEST, '非法 JSON-RPC 响应');
            }
            if (msg.error) {
                throw makeError(msg.error.code || ERR_INTERNAL, msg.error.message || 'JSON-RPC 错误', msg.error.data);
            }
            return msg.result;
        });

        return withTimeout(fetchPromise, conn.timeout, method);
    };

    /**
     * 构造请求头（含 apiKey 鉴权）
     */
    MCPBridge._buildHeaders = function (conn) {
        var headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
        if (conn.apiKey) {
            headers['Authorization'] = 'Bearer ' + conn.apiKey;
        }
        return headers;
    };

    /**
     * 解析相对 URL（基于服务器 base url）
     */
    MCPBridge._resolveUrl = function (base, path) {
        try {
            return new URL(path, base).toString();
        } catch (e) {
            // URL 构造失败时简单拼接
            if (/^https?:\/\//i.test(path)) return path;
            return base.replace(/\/$/, '') + (path.charAt(0) === '/' ? '' : '/') + path;
        }
    };

    /**
     * 启动心跳保活（ping）
     */
    MCPBridge._startHeartbeat = function (conn) {
        var self = this;
        this._stopHeartbeat(conn);
        conn.heartbeatTimer = setInterval(function () {
            if (conn.status !== 'connected') return;
            var pingPromise;
            if (conn.transport === 'sse') {
                pingPromise = self._sseRequest(conn, METHOD_PING, {}).catch(function () { return null; });
            } else {
                pingPromise = self._httpRequest(conn, METHOD_PING, {}).catch(function () { return null; });
            }
            pingPromise.then(function (ok) {
                if (ok === null && conn.status === 'connected') {
                    self._handleDisconnect(conn, '心跳无响应');
                }
            });
        }, HEARTBEAT_INTERVAL);
    };

    MCPBridge._stopHeartbeat = function (conn) {
        if (conn.heartbeatTimer) {
            clearInterval(conn.heartbeatTimer);
            conn.heartbeatTimer = null;
        }
    };

    /**
     * 处理连接断开：标记状态、通知回调、尝试重连
     */
    MCPBridge._handleDisconnect = function (conn, reason) {
        if (conn.status === 'disconnected') return;
        conn.status = 'disconnected';
        conn.lastError = reason;
        this._emit('serverDisconnect', { serverId: conn.id, name: conn.name, reason: reason });
        // 指数退避重连（最多一次，避免无限循环；用户可手动 refreshTools）
        this._scheduleReconnect(conn);
    };

    /**
     * 调度一次重连尝试
     */
    MCPBridge._scheduleReconnect = function (conn) {
        var self = this;
        if (conn.reconnectTimer) return;
        conn.reconnectTimer = setTimeout(function () {
            conn.reconnectTimer = null;
            if (conn.status === 'connected' || conn.status === 'disconnected' && !self.servers.has(conn.id)) return;
            // 复用配置重连
            var cfg = { id: conn.id, name: conn.name, url: conn.url, transport: conn.transport, apiKey: conn.apiKey, timeout: conn.timeout };
            self.connectServer(cfg).catch(function () { /* 静默失败，等待下次手动刷新 */ });
        }, 5000);
    };

    /**
     * 断开指定服务器（对外接口）
     */
    MCPBridge.disconnectServer = function (id) {
        this._disconnectServerInternal(id, 'user');
    };

    /**
     * 断开服务器内部实现
     * @param {string} id 服务器 ID
     * @param {string} reason 断开原因
     */
    MCPBridge._disconnectServerInternal = function (id, reason) {
        var conn = this.servers.get(id);
        if (!conn) return;
        this._cleanupConnection(conn);
        conn.status = 'disconnected';
        conn.lastError = reason;
        this._emit('serverDisconnect', { serverId: id, name: conn.name, reason: reason });
    };

    /**
     * 清理连接相关资源（EventSource、定时器、pending 请求）
     */
    MCPBridge._cleanupConnection = function (conn) {
        this._stopHeartbeat(conn);
        if (conn.reconnectTimer) { clearTimeout(conn.reconnectTimer); conn.reconnectTimer = null; }
        if (conn.es) {
            try { conn.es.close(); } catch (e) { /* ignore */ }
            conn.es = null;
        }
        // 拒绝所有 pending 请求
        conn.pending.forEach(function (entry) {
            clearTimeout(entry.timer);
            entry.reject(makeError(ERR_CONNECTION, '连接已关闭'));
        });
        conn.pending.clear();
    };

    // ------------------------------------------------------------------------
    // 工具发现
    // ------------------------------------------------------------------------

    /**
     * 获取所有可用工具（内置 + 外部），返回 MCP 标准格式数组。
     * 工具名冲突处理：内置优先，外部工具名加前缀 `server_id:tool_name`。
     * @returns {Array<{name, description, inputSchema, _source, _server?}>}
     */
    MCPBridge.getAllTools = function () {
        if (!this._initialized) this.init();
        var result = [];
        var self = this;

        // 1. 内置工具
        this.builtinTools.forEach(function (def) {
            result.push({
                name: def.name,
                description: def.description,
                inputSchema: clone(def.inputSchema),
                _source: 'builtin'
            });
        });

        // 2. 外部服务器工具（带前缀避免冲突）
        this.servers.forEach(function (conn) {
            if (conn.status !== 'connected') return;
            (conn.tools || []).forEach(function (tool) {
                var rawName = tool.name;
                var finalName = self.builtinTools.has(rawName)
                    ? conn.id + ':' + rawName   // 与内置冲突 → 加前缀
                    : rawName;
                result.push({
                    name: finalName,
                    description: tool.description || '',
                    inputSchema: tool.inputSchema || { type: 'object', properties: {}, required: [] },
                    _source: 'external',
                    _server: conn.id,
                    _serverName: conn.name,
                    _originalName: rawName
                });
            });
        });

        return result;
    };

    /**
     * 获取已连接服务器列表
     * @returns {Array<{id, name, url, transport, status, toolCount, lastError, connectedAt}>}
     */
    MCPBridge.listServers = function () {
        if (!this._initialized) this.init();
        var list = [];
        this.servers.forEach(function (conn) {
            list.push({
                id: conn.id,
                name: conn.name,
                url: conn.url,
                transport: conn.transport,
                status: conn.status,
                toolCount: (conn.tools || []).length,
                lastError: conn.lastError,
                connectedAt: conn.connectedAt
            });
        });
        return list;
    };

    /**
     * 重新加载所有服务器的工具列表（重新调用 tools/list）
     */
    MCPBridge.refreshTools = function () {
        if (!this._initialized) this.init();
        var self = this;
        var tasks = [];
        this.servers.forEach(function (conn) {
            if (conn.status !== 'connected') return;
            var p;
            if (conn.transport === 'sse') {
                p = self._sseRequest(conn, METHOD_TOOLS_LIST, {});
            } else {
                p = self._httpRequest(conn, METHOD_TOOLS_LIST, {});
            }
            tasks.push(p.then(function (result) {
                conn.tools = (result && result.tools) || [];
                return { serverId: conn.id, tools: conn.tools };
            }).catch(function (err) {
                return { serverId: conn.id, error: err.message };
            }));
        });
        return Promise.all(tasks);
    };

    // ------------------------------------------------------------------------
    // 工具调用与路由
    // ------------------------------------------------------------------------

    /**
     * 调用工具（自动路由到内置 handler 或外部服务器）
     * @param {string} name 工具名（外部冲突工具用 `server_id:tool_name` 形式）
     * @param {object} args 参数
     * @returns {Promise<{content: Array, isError: boolean}>} MCP 标准结果
     */
    MCPBridge.callTool = function (name, args) {
        if (!this._initialized) this.init();
        var self = this;
        args = args || {};

        // 1. 内置工具优先
        if (this.builtinTools.has(name)) {
            return this._callBuiltin(name, args);
        }

        // 2. 外部工具（可能带 server_id: 前缀）
        // 2a. 显式前缀形式
        if (name.indexOf(':') !== -1) {
            var sepIdx = name.indexOf(':');
            var serverId = name.substring(0, sepIdx);
            var toolName = name.substring(sepIdx + 1);
            var conn = this.servers.get(serverId);
            if (conn && conn.status === 'connected') {
                return this._callExternal(conn, toolName, args);
            }
        }

        // 2b. 无前缀 → 在所有已连接服务器中查找
        var found = null;
        this.servers.forEach(function (conn) {
            if (found || conn.status !== 'connected') return;
            var exists = (conn.tools || []).some(function (t) { return t.name === name; });
            if (exists) found = conn;
        });
        if (found) {
            return this._callExternal(found, name, args);
        }

        // 3. 未找到
        return Promise.reject(makeError(ERR_METHOD_NOT_FOUND, '未找到工具: ' + name));
    };

    /**
     * 调用内置工具
     */
    MCPBridge._callBuiltin = function (name, args) {
        var self = this;
        var def = this.builtinTools.get(name);
        return new Promise(function (resolve) {
            self._emit('toolCall', { name: name, args: args, source: 'builtin' });
            if (!def._handler) {
                resolve(normalizeResult('[ERR] 内置工具 ' + name + ' 未注册 handler'));
                return;
            }
            Promise.resolve()
                .then(function () { return def._handler(args); })
                .then(function (raw) { resolve(normalizeResult(raw)); })
                .catch(function (err) {
                    resolve(normalizeResult(makeError(ERR_INTERNAL, '内置工具异常: ' + err.message)));
                });
        });
    };

    /**
     * 调用外部服务器工具
     */
    MCPBridge._callExternal = function (conn, toolName, args) {
        var self = this;
        self._emit('toolCall', { name: toolName, args: args, source: 'external', serverId: conn.id });

        var p;
        if (conn.transport === 'sse') {
            p = self._sseRequest(conn, METHOD_TOOLS_CALL, { name: toolName, arguments: args });
        } else {
            p = self._httpRequest(conn, METHOD_TOOLS_CALL, { name: toolName, arguments: args });
        }
        return p.then(function (result) {
            // MCP tools/call 返回 { content: [...], isError?: boolean }
            if (result && Array.isArray(result.content)) {
                return { content: result.content, isError: !!result.isError };
            }
            return normalizeResult(result);
        }).catch(function (err) {
            return normalizeResult(makeError(ERR_INTERNAL, '外部工具调用失败: ' + err.message));
        });
    };

    // ------------------------------------------------------------------------
    // 参数校验
    // ------------------------------------------------------------------------

    /**
     * 调用前校验参数是否符合工具 inputSchema（轻量校验：required 字段 + 类型）
     * @param {string} name 工具名
     * @param {object} args 参数
     * @returns {{valid: boolean, errors: string[]}}
     */
    MCPBridge.validateToolCall = function (name, args) {
        if (!this._initialized) this.init();
        args = args || {};
        var errors = [];

        // 查找工具定义
        var def = null;
        if (this.builtinTools.has(name)) {
            def = this.builtinTools.get(name);
        } else {
            // 外部工具（含前缀）
            var lookupName = name;
            var serverId = null;
            if (name.indexOf(':') !== -1) {
                var sepIdx = name.indexOf(':');
                serverId = name.substring(0, sepIdx);
                lookupName = name.substring(sepIdx + 1);
            }
            if (serverId) {
                var conn = this.servers.get(serverId);
                if (conn) {
                    def = (conn.tools || []).find(function (t) { return t.name === lookupName; });
                }
            } else {
                this.servers.forEach(function (conn) {
                    if (def) return;
                    def = (conn.tools || []).find(function (t) { return t.name === lookupName; });
                });
            }
        }

        if (!def) {
            return { valid: false, errors: ['未知工具: ' + name] };
        }

        var schema = def.inputSchema || { type: 'object', properties: {}, required: [] };

        // required 字段检查
        if (Array.isArray(schema.required)) {
            schema.required.forEach(function (field) {
                if (args[field] === undefined || args[field] === null) {
                    errors.push('缺少必填参数: ' + field);
                }
            });
        }

        // 类型检查（仅对已提供字段）
        var props = schema.properties || {};
        Object.keys(args).forEach(function (key) {
            var spec = props[key];
            if (!spec) return; // schema 未声明 → 放行
            var val = args[key];
            if (val === undefined || val === null) return;
            var actualType = Array.isArray(val) ? 'array' : typeof val;
            // MCP/JSON Schema 类型映射：integer→number 兼容
            var expected = spec.type;
            if (expected === 'integer' && actualType === 'number') return;
            if (expected === 'array' && actualType !== 'array') {
                errors.push('参数 ' + key + ' 应为 array，实际 ' + actualType);
            } else if (expected === 'object' && actualType !== 'object') {
                errors.push('参数 ' + key + ' 应为 object，实际 ' + actualType);
            } else if (expected === 'string' && actualType !== 'string') {
                errors.push('参数 ' + key + ' 应为 string，实际 ' + actualType);
            } else if (expected === 'number' && actualType !== 'number') {
                errors.push('参数 ' + key + ' 应为 number，实际 ' + actualType);
            } else if (expected === 'boolean' && actualType !== 'boolean') {
                errors.push('参数 ' + key + ' 应为 boolean，实际 ' + actualType);
            }
            // enum 校验
            if (Array.isArray(spec.enum) && spec.enum.indexOf(val) === -1) {
                errors.push('参数 ' + key + ' 取值非法，允许: ' + spec.enum.join(', '));
            }
        });

        return { valid: errors.length === 0, errors: errors };
    };

    // ------------------------------------------------------------------------
    // 统计
    // ------------------------------------------------------------------------

    /**
     * 返回工具统计信息
     * @returns {{builtin: number, external: number, total: number, servers: Array}}
     */
    MCPBridge.getToolStats = function () {
        if (!this._initialized) this.init();
        var builtinCount = this.builtinTools.size;
        var externalCount = 0;
        var servers = [];
        this.servers.forEach(function (conn) {
            var cnt = conn.status === 'connected' ? (conn.tools || []).length : 0;
            externalCount += cnt;
            servers.push({
                id: conn.id,
                name: conn.name,
                status: conn.status,
                toolCount: cnt
            });
        });
        return {
            builtin: builtinCount,
            external: externalCount,
            total: builtinCount + externalCount,
            servers: servers
        };
    };

    // ------------------------------------------------------------------------
    // 配置持久化
    // ------------------------------------------------------------------------

    /**
     * 持久化单个服务器配置到 localStorage
     */
    MCPBridge._persistServerConfig = function (conn) {
        var saved = this._loadSavedServers();
        var cfg = {
            id: conn.id, name: conn.name, url: conn.url,
            transport: conn.transport, apiKey: conn.apiKey, timeout: conn.timeout
        };
        var idx = saved.findIndex(function (s) { return s.id === cfg.id; });
        if (idx >= 0) saved[idx] = cfg; else saved.push(cfg);
        this._saveSavedServers(saved);
    };

    /**
     * 从 localStorage 移除服务器配置
     */
    MCPBridge._removeSavedServer = function (id) {
        var saved = this._loadSavedServers();
        var filtered = saved.filter(function (s) { return s.id !== id; });
        this._saveSavedServers(filtered);
    };

    MCPBridge._loadSavedServers = function () {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return [];
            var arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            return [];
        }
    };

    MCPBridge._saveSavedServers = function (arr) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
        } catch (e) {
            // localStorage 不可用时静默失败
        }
    };

    // ------------------------------------------------------------------------
    // 事件回调钩子（用于 UI 集成）
    // ------------------------------------------------------------------------

    /**
     * 注册服务器连接成功回调
     */
    MCPBridge.onServerConnect = function (callback) {
        if (typeof callback === 'function') this._hooks.serverConnect.push(callback);
    };

    /**
     * 注册服务器断开回调
     */
    MCPBridge.onServerDisconnect = function (callback) {
        if (typeof callback === 'function') this._hooks.serverDisconnect.push(callback);
    };

    /**
     * 注册工具调用回调（用于日志/监控）
     */
    MCPBridge.onToolCall = function (callback) {
        if (typeof callback === 'function') this._hooks.toolCall.push(callback);
    };

    /**
     * 注册错误回调
     */
    MCPBridge.onError = function (callback) {
        if (typeof callback === 'function') this._hooks.error.push(callback);
    };

    /**
     * 触发钩子
     */
    MCPBridge._emit = function (event, payload) {
        var hooks = this._hooks && this._hooks[event];
        if (!hooks) return;
        hooks.forEach(function (cb) {
            try { cb(payload); } catch (e) { /* 单个回调异常不影响其他 */ }
        });
    };

    // ------------------------------------------------------------------------
    // 重写 disconnectServer 以同步移除持久化配置
    // 用包装方式避免覆盖上面 _disconnectServerInternal 的内部调用链
    // ------------------------------------------------------------------------
    var _origDisconnect = MCPBridge.disconnectServer;
    MCPBridge.disconnectServer = function (id) {
        _origDisconnect.call(this, id);
        this._removeSavedServer(id);
    };

    // ------------------------------------------------------------------------
    // 自动初始化（DOM 就绪后）
    // ------------------------------------------------------------------------
    function autoInit() {
        try { MCPBridge.init(); } catch (e) { /* 初始化失败不阻塞页面 */ }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInit);
    } else {
        autoInit();
    }

    // 暴露到全局
    global.MCPBridge = MCPBridge;
})(typeof window !== 'undefined' ? window : this);
