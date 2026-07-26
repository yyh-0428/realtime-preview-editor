const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
class Storage { constructor(){this.m=new Map()} getItem(k){return this.m.has(k)?this.m.get(k):null} setItem(k,v){this.m.set(k,String(v))} removeItem(k){this.m.delete(k)} }
const localStorage = new Storage();
const sessionStorage = new Storage();
const calls=[];
const fetch = async (url, options={}) => {
  const body=JSON.parse(options.body||'{}'); calls.push({url,body,headers:options.headers,credentials:options.credentials});
  let result={};
  if(body.method==='initialize') result={protocolVersion:'2025-03-26'};
  else if(body.method==='tools/list') result={tools:[{name:'read',description:'read data',inputSchema:{type:'object',properties:{id:{type:'string'}}}}]};
  else if(body.method==='tools/call') result={content:[{type:'text',text:url.includes('server-two')?'two':'one'}]};
  return {ok:true,status:200,headers:{get:()=> 'application/json'},text:async()=>JSON.stringify({jsonrpc:'2.0',id:body.id,result})};
};
const context={window:{},localStorage,sessionStorage,fetch,URL,AbortController,setTimeout,clearTimeout,console,Math,JSON};
context.window=context;
vm.createContext(context);
vm.runInContext(fs.readFileSync('/mnt/data/integrated_fix/lib/mcp-bridge.js','utf8'),context);
(async()=>{
  const b=context.MCPBridge;
  b.init();
  b.registerBuiltinHandlers({analyze_code:()=> 'builtin-ok'});
  assert.equal(await b.callTool('analyze_code',{}),'builtin-ok');
  await b.connectServer({id:'srv:one',name:'one',url:'https://server-one.example/mcp',apiKey:'secret-one'});
  await b.connectServer({id:'srv:two',name:'two',url:'https://server-two.example/mcp',apiKey:'secret-two'});
  const tools=b.getAllTools();
  assert(tools.some(t=>t._serverId==='srv:one'&&t.name==='read'));
  assert(tools.some(t=>t._serverId==='srv:two'&&t.name==='read'));
  const result=await b.callTool('read',{id:'x'},'srv:two');
  assert.equal(result.content[0].text,'two');
  assert(!localStorage.getItem('werkstatt_mcp_servers_v2').includes('secret'));
  assert.equal(sessionStorage.getItem('werkstatt_mcp_key_srv:two'),'secret-two');
  assert(calls.every(c=>c.credentials==='omit'));
  let rejected=false;try{await b.connectServer({url:'http://evil.example/mcp'})}catch(e){rejected=true}assert(rejected);
  rejected=false;try{await b.connectServer({url:'https://ok.example/mcp?token=oops'})}catch(e){rejected=true}assert(rejected);
  console.log('MCP bridge tests: PASS ('+calls.length+' RPC calls)');
})().catch(e=>{console.error(e);process.exit(1)});
