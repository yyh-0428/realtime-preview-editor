(function (global) {
  'use strict';

  const STORAGE_KEY = 'werkstatt_mcp_servers_v2';
  const SESSION_KEY_PREFIX = 'werkstatt_mcp_key_';
  const state = {
    initialized: false,
    builtinHandlers: {},
    builtinTools: [],
    servers: new Map(),
    listeners: { connect: [], disconnect: [], error: [] },
    requestId: 1
  };

  function emit(type, payload) {
    for (const fn of state.listeners[type] || []) {
      try { fn(payload); } catch (_) {}
    }
  }

  function validateUrl(raw) {
    const url = new URL(String(raw || '').trim());
    if (url.username || url.password) throw new Error('MCP URL 不能包含账号或密码');
    const host = url.hostname.toLowerCase();
    const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
      throw new Error('MCP 服务器必须使用 HTTPS；仅 localhost 允许 HTTP');
    }
    for (const key of url.searchParams.keys()) {
      if (/(api[_-]?key|token|secret|password|authorization)/i.test(key)) {
        throw new Error('MCP URL 不能通过查询参数携带密钥');
      }
    }
    return url;
  }

  function safeJsonParse(text) {
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  function parseResponseText(text, contentType) {
    if ((contentType || '').includes('text/event-stream')) {
      const events = String(text || '').split(/\r?\n\r?\n/);
      for (const event of events) {
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
        if (!data || data === '[DONE]') continue;
        const parsed = safeJsonParse(data);
        if (parsed) return parsed;
      }
      throw new Error('MCP SSE 响应无法解析');
    }
    const parsed = safeJsonParse(text);
    if (!parsed) throw new Error('MCP 返回了无效 JSON');
    return parsed;
  }

  async function rpc(server, method, params) {
    const url = validateUrl(server.url);
    const key = sessionStorage.getItem(SESSION_KEY_PREFIX + server.id) || '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          ...(key ? { 'Authorization': 'Bearer ' + key } : {})
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: state.requestId++, method, params: params || {} }),
        signal: controller.signal,
        credentials: 'omit'
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 180)}`);
      const data = parseResponseText(text, response.headers.get('content-type'));
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  function persistServers() {
    const list = [...state.servers.values()].map(server => ({
      id: server.id,
      name: server.name,
      url: server.url,
      transport: server.transport
    }));
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch (_) {}
  }

  function loadServers() {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch (_) {}
    for (const item of Array.isArray(list) ? list : []) {
      try {
        validateUrl(item.url);
        state.servers.set(item.id, {
          ...item,
          status: 'disconnected',
          tools: [],
          lastError: ''
        });
      } catch (_) {}
    }
  }

  async function refreshServer(server) {
    server.status = 'connecting';
    server.lastError = '';
    try {
      try {
        await rpc(server, 'initialize', {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'Werkstatt', version: '2.0' }
        });
      } catch (_) {
        // Some lightweight MCP-compatible endpoints allow tools/list directly.
      }
      const result = await rpc(server, 'tools/list', {});
      const tools = Array.isArray(result?.tools) ? result.tools : [];
      server.tools = tools.map(tool => ({
        name: tool.name,
        description: tool.description || tool.name,
        inputSchema: tool.inputSchema || { type: 'object', properties: {} },
        _source: 'external',
        _serverId: server.id
      })).filter(tool => tool.name);
      server.status = 'connected';
      emit('connect', server);
      return server;
    } catch (error) {
      server.status = 'error';
      server.lastError = error.message || String(error);
      emit('error', { server, error });
      throw error;
    }
  }

  const MCPBridge = {
    init() {
      if (state.initialized) return;
      state.initialized = true;
      loadServers();
    },

    registerBuiltinHandlers(handlers) {
      state.builtinHandlers = { ...(handlers || {}) };
      state.builtinTools = Object.keys(state.builtinHandlers).map(name => ({
        type: 'function',
        function: { name, description: name, parameters: { type: 'object', properties: {} } },
        _source: 'builtin'
      }));
    },

    async refreshTools() {
      const tasks = [...state.servers.values()].map(server => refreshServer(server).catch(() => null));
      await Promise.all(tasks);
      return this.getAllTools();
    },

    getAllTools() {
      const external = [...state.servers.values()].flatMap(server => server.status === 'connected' ? server.tools : []);
      return [...state.builtinTools, ...external];
    },

    async connectServer(config) {
      this.init();
      const url = validateUrl(config.url);
      const id = config.id || ('mcp_' + Math.random().toString(36).slice(2, 10));
      const server = {
        id,
        name: String(config.name || url.hostname),
        url: url.toString(),
        transport: config.transport || 'http',
        status: 'disconnected',
        tools: [],
        lastError: ''
      };
      state.servers.set(id, server);
      if (config.apiKey) sessionStorage.setItem(SESSION_KEY_PREFIX + id, String(config.apiKey));
      persistServers();
      await refreshServer(server);
      return { ...server, toolCount: server.tools.length };
    },

    disconnectServer(id) {
      const server = state.servers.get(id);
      if (!server) return;
      state.servers.delete(id);
      sessionStorage.removeItem(SESSION_KEY_PREFIX + id);
      persistServers();
      emit('disconnect', server);
    },

    async callTool(name, args, serverId) {
      if (!serverId && state.builtinHandlers[name]) return state.builtinHandlers[name](args || {});
      const candidates = serverId ? [state.servers.get(serverId)].filter(Boolean) : [...state.servers.values()];
      for (const server of candidates) {
        if (server.status !== 'connected') continue;
        if (server.tools.some(tool => tool.name === name)) {
          return rpc(server, 'tools/call', { name, arguments: args || {} });
        }
      }
      throw new Error('未找到 MCP 工具: ' + name + (serverId ? '（服务器 ' + serverId + '）' : ''));
    },

    listServers() {
      return [...state.servers.values()].map(server => ({
        id: server.id,
        name: server.name,
        url: server.url,
        transport: server.transport,
        status: server.status,
        toolCount: server.tools.length,
        lastError: server.lastError
      }));
    },

    getToolStats() {
      const builtin = state.builtinTools.length;
      const external = [...state.servers.values()].reduce((sum, server) => sum + (server.status === 'connected' ? server.tools.length : 0), 0);
      return { builtin, external, total: builtin + external };
    },

    onServerConnect(fn) { state.listeners.connect.push(fn); },
    onServerDisconnect(fn) { state.listeners.disconnect.push(fn); },
    onError(fn) { state.listeners.error.push(fn); }
  };

  global.MCPBridge = MCPBridge;
})(window);
