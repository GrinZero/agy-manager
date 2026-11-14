import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {envelope,validateUrl,validateProxy,proxyFetch,requestFetch,readTelemetry,readContextTelemetry,send,selfUpdate} from '../public/client/agy-quota.mjs';
import {hookPlan,normalizeProxy} from '../public/client/install.mjs';

const token='agy_'+'a'.repeat(64), runtime=resolve('public/client/agy-quota.mjs'),installer=resolve('public/client/install.mjs');
function run(file,args,stdin='',env={}) {return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[file,...args],{env:{...process.env,...env}});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.on('error',reject);p.on('exit',code=>resolve({code,stdout,stderr}));p.stdin.end(stdin);});}
const payload={conversationId:'c-1',invocationNum:0,modelName:'gemini-flash',lastUserInput:'private prompt',transcriptPath:'/private/path',workspacePaths:['/private/work']};
async function config(url) {const root=await mkdtemp(join(tmpdir(),'agy-client-'));await writeFile(join(root,'credentials.json'),JSON.stringify({url,token}));return root;}
async function server(handler) {const s=createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));return {url:`http://127.0.0.1:${s.address().port}`,server:s,close:()=>new Promise(r=>s.close(r))};}
test('client strips private data and requires secure remote URL',()=>{
  assert.deepEqual(envelope(payload,'check'),{conversationId:'c-1',invocationNum:0,modelName:'gemini-flash'});
  assert.deepEqual(envelope({...payload,initialNumSteps:18,invocationNum:2},'check'),{conversationId:'c-1',invocationNum:180002,modelName:'gemini-flash'});
  assert.throws(()=>validateUrl('http://example.com'));assert.throws(()=>validateUrl('https://evil:password@example.com'));
  assert.equal(validateUrl('https://example.com'),'https://example.com');
});
test('explicit proxy accepts only HTTP origins and keeps credentials out of the target URL',()=>{
  assert.equal(validateProxy('http://user:pass@127.0.0.1:7897/').port,'7897');
  assert.throws(()=>validateProxy('https://127.0.0.1:7897'),/HTTP proxy/);
  assert.throws(()=>validateProxy('http://127.0.0.1:7897/proxy'),/origin/);
  assert.equal(normalizeProxy('http://127.0.0.1:7897/'),'http://127.0.0.1:7897');
  assert.throws(()=>normalizeProxy('socks5://127.0.0.1:7897'),/HTTP 代理/);
});
test('proxy sends HTTP requests in absolute form with proxy auth and bypasses localhost targets',async()=>{
  let seen;
  const proxy=await server(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;
    seen={url:req.url,host:req.headers.host,auth:req.headers['proxy-authorization'],body:raw};
    res.setHeader('Content-Type','application/json');res.end('{"ok":true}');
  });
  const local=await server((_req,res)=>res.end('{"direct":true}'));
  try {
    const response=await proxyFetch('http://service.invalid/check?x=1',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},proxy.url.replace('http://','http://user:pass@'));
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});
    assert.equal(seen.url,'http://service.invalid/check?x=1');assert.equal(seen.host,'service.invalid');
    assert.equal(seen.auth,'Basic '+Buffer.from('user:pass').toString('base64'));assert.equal(seen.body,'{}');
    const direct=await requestFetch({url:local.url,token,proxy:'http://127.0.0.1:1'},local.url+'/health');
    assert.deepEqual(await direct.json(),{direct:true});
  } finally {await proxy.close();await local.close();}
});
test('proxy establishes an HTTPS CONNECT tunnel and surfaces proxy rejection',async()=>{
  let tunnel;
  const proxy=await server(()=>{});
  proxy.server.on('connect',(req,socket)=>{tunnel=req.url;socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');});
  try {
    await assert.rejects(proxyFetch('https://example.invalid/v1internal:streamGenerateContent?alt=sse',{method:'POST',body:'{}'},proxy.url),/Proxy CONNECT 502/);
    assert.equal(tunnel,'example.invalid:443');
  } finally {await proxy.close();}
});
test('Windows hook command is cmd /c safe and never embeds the user path',()=>{
  const guardDir='C:\\Users\\Some One\\.gemini\\config\\agy-family-quota';
  const plan=hookPlan('win32','C:\\Program Files\\nodejs\\node.exe',guardDir+'\\agy-quota.mjs',guardDir);
  assert.equal(plan.command,'agy-family-quota\\run.cmd');
  assert.ok(!plan.command.includes('"'),'cmd /c strips the first quote of a quoted executable');
  assert.ok(!plan.command.includes(' '),'no spaces may appear in the hook command line');
  assert.equal(plan.launchers.length,1);
  const content=plan.launchers[0].content;
  assert.match(content,/^@echo off\r\n/);
  assert.ok(content.includes('set "AGY_NODE=C:\\Program Files\\nodejs\\node.exe"'));
  assert.ok(content.includes('set "AGY_NODE=node"'),'must fall back to PATH if node.exe was moved');
  assert.ok(content.includes('"%~dp0agy-quota.mjs"'),'resolve the script relative to the launcher');
  assert.ok(!content.includes('Some One'),'user paths with spaces must not appear in a cmd file');
  assert.ok(content.endsWith(' %*\r\n'));
});
test('Windows launcher stays safe when the home path contains cmd metacharacters',()=>{
  const guardDir='C:\\Users\\A&B%USERNAME%\\.gemini\\config\\agy-family-quota';
  const plan=hookPlan('win32','C:\\Program Files\\nodejs\\node.exe',guardDir+'\\agy-quota.mjs',guardDir);
  assert.ok(!plan.launchers[0].content.includes('A&B'));
  assert.ok(!plan.launchers[0].content.includes('%USERNAME%'));
  assert.ok(!plan.command.includes(' '));
});
test('Unix hook command keeps the original quoted absolute-path form',()=>{
  const guardDir='/home/me/.gemini/config/agy-family-quota';
  const plan=hookPlan('linux','/usr/bin/node',guardDir+'/agy-quota.mjs',guardDir);
  assert.equal(plan.command,"'/usr/bin/node' '/home/me/.gemini/config/agy-family-quota/agy-quota.mjs'");
  assert.deepEqual(plan.launchers,[]);
});
test('generated Windows launcher actually runs the guard under cmd /c',async(t)=>{
  if(process.platform!=='win32')return t.skip('cmd /c is Windows-only');
  const home=await mkdtemp(join(tmpdir(),'agy winhook '));
  const configDir=join(home,'.gemini','config'),guardDir=join(configDir,'agy-family-quota');
  await mkdir(guardDir,{recursive:true});
  const scriptPath=join(guardDir,'agy-quota.mjs');
  await writeFile(scriptPath,await readFile(runtime,'utf8'));
  const plan=hookPlan('win32',process.execPath,scriptPath,guardDir);
  await writeFile(plan.launchers[0].path,plan.launchers[0].content);
  const command=plan.command+' check';
  const result=await new Promise(resolve=>{
    const child=spawn(process.env.ComSpec||'C:\\Windows\\System32\\cmd.exe',['/c',command],{cwd:configDir,windowsHide:true});
    let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);
    child.on('close',code=>resolve({code,out,err}));child.stdin.end('{}');
  });
  assert.equal(result.code,0,result.err);
  const emitted=JSON.parse(result.out);
  assert.equal(emitted.terminationBehavior,'terminate','the guard must actually start and emit JSON');
});
test('hook outputs one valid object, forwards terminate and omits private data',async()=>{
  let received;
  const s=await server(async(req,res)=>{let raw='';for await(const c of req)raw+=c;received=JSON.parse(raw);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({terminationBehavior:'terminate',injectSteps:[{errorMessage:{userMessage:'limit'}}]}));});
  try{const root=await config(s.url);const r=await run(runtime,['check'],JSON.stringify(payload),{AGY_QUOTA_CONFIG_DIR:root});assert.equal(r.code,0);assert.equal(JSON.parse(r.stdout).terminationBehavior,'terminate');assert.ok(!JSON.stringify(received).includes('private'));assert.equal(r.stdout.trim().split('\n').length,1);}finally{await s.close();}
});
test('hook retries transient server failures with an identical payload and emits one result',async()=>{
  for(const action of ['check','commit','release']) {
    const received=[];
    const s=await server(async(req,res)=>{let raw='';for await(const c of req)raw+=c;received.push(raw);res.statusCode=received.length<3?503:200;res.end('{}');});
    try{
      const root=await config(s.url),r=await run(runtime,[action],JSON.stringify({...payload,fullyIdle:true}),{AGY_QUOTA_CONFIG_DIR:root});
      assert.equal(r.code,0);assert.deepEqual(JSON.parse(r.stdout),{});
      assert.equal(r.stdout.trim().split('\n').length,1);assert.equal(r.stderr,'');
      assert.equal(received.length,3);assert.equal(new Set(received).size,1);
      assert.ok(!received.join('').includes('private'));
      if(action==='commit')assert.equal((await readdir(join(root,'pending'))).length,0);
    }finally{await s.close();}
  }
});
test('commit and release retry with the same identity after losing a response',async()=>{
  for(const action of ['commit','release']) {
    const received=[];
    const s=await server(async(req,res)=>{
      let raw='';for await(const c of req)raw+=c;received.push({path:req.url,raw});
      if(received.length===1){req.socket.destroy();return;}
      res.end('{}');
    });
    try {
      const body=envelope({...payload,fullyIdle:true},action);
      assert.deepEqual(await send({url:s.url,token},action,body),{});
      assert.equal(received.length,2);assert.deepEqual(received[0],received[1]);
    } finally {await s.close();}
  }
});
test('an attempt timeout can recover on the next attempt',async()=>{
  let attempts=0;
  const s=await server((_req,res)=>{
    if(++attempts===1){const t=setTimeout(()=>res.end('{}'),300);res.on('close',()=>clearTimeout(t));}
    else res.end('{}');
  });
  try {assert.deepEqual(await send({url:s.url,token},'check',envelope(payload,'check'),100),{});assert.equal(attempts,2);}
  finally {await s.close();}
});
test('rate limiting respects Retry-After and stops if the wait cannot fit',async()=>{
  let attempts=0,hint='1';const times=[];
  const s=await server((_req,res)=>{
    times.push(Date.now());res.statusCode=++attempts===1?429:200;
    res.setHeader('Retry-After',hint);res.end('{}');
  });
  try {
    assert.deepEqual(await send({url:s.url,token},'check',envelope(payload,'check')),{});
    assert.equal(attempts,2);assert.ok(times[1]-times[0]>=950);
    attempts=0;hint='60';const start=Date.now();
    await assert.rejects(send({url:s.url,token},'check',envelope(payload,'check')),/Service HTTP 429/);
    assert.equal(attempts,1);assert.ok(Date.now()-start<1000);
  } finally {await s.close();}
});
test('authentication, validation, quota denials and invalid success bodies are never retried',async()=>{
  let attempts=0,status=400,body='{}';
  const s=await server((_req,res)=>{attempts++;res.statusCode=status;res.end(body);});
  try {
    for(status of [400,401,403,404,409,413,422]) {
      attempts=0;await assert.rejects(send({url:s.url,token},'check',envelope(payload,'check')),new RegExp(`Service HTTP ${status}`));
      assert.equal(attempts,1);
    }
    status=200;body='{"terminationBehavior":"terminate"}';attempts=0;
    assert.deepEqual(await send({url:s.url,token},'check',envelope(payload,'check')),{terminationBehavior:'terminate'});
    assert.equal(attempts,1);
    for(body of ['not JSON','[]']) {
      attempts=0;await assert.rejects(send({url:s.url,token},'check',envelope(payload,'check')));
      assert.equal(attempts,1);
    }
  } finally {await s.close();}
});
test('exhausted server retries still fail closed and never print credentials',async()=>{
  let attempts=0;
  const s=await server((_req,res)=>{attempts++;res.statusCode=503;res.end('{}');});
  try {
    const root=await config(s.url),r=await run(runtime,['check'],JSON.stringify(payload),{AGY_QUOTA_CONFIG_DIR:root});
    assert.equal(attempts,3);assert.equal(r.code,0);
    assert.equal(r.stdout.trim().split('\n').length,1);
    assert.equal(JSON.parse(r.stdout).terminationBehavior,'terminate');
    assert.match(r.stderr,/Service HTTP 503/);assert.ok(!(r.stdout+r.stderr).includes(token));
  } finally {await s.close();}
});
test('offline completions are durable and retried without forwarding private fields',async()=>{
  let available=false;const received=[];
  const s=await server(async(req,res)=>{let raw='';for await(const c of req)raw+=c;if(!available){res.statusCode=503;res.end('{}');return;}received.push({url:req.url,body:JSON.parse(raw)});res.end('{}');});
  try{const root=await config(s.url);const first=await run(runtime,['commit'],JSON.stringify(payload),{AGY_QUOTA_CONFIG_DIR:root});assert.deepEqual(JSON.parse(first.stdout),{});const files=await readdir(join(root,'pending'));assert.equal(files.length,1);assert.ok(!(await readFile(join(root,'pending',files[0]),'utf8')).includes('private'));available=true;await run(runtime,['check'],JSON.stringify({...payload,invocationNum:1}),{AGY_QUOTA_CONFIG_DIR:root});assert.equal((await readdir(join(root,'pending'))).length,0);assert.ok(received.some(r=>r.url==='/commit'&&r.body.invocationNum===0));}finally{await s.close();}
});
test('outbox replay tolerates a response slower than 700ms',async()=>{
  let online=false;
  const received=[];
  const s=await server(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;
    if(!online){res.statusCode=503;res.end('{}');return;}
    received.push({path:req.url,body:JSON.parse(raw)});
    if(req.url==='/commit'){const t=setTimeout(()=>res.end('{}'),1100);res.on('close',()=>clearTimeout(t));}
    else res.end('{}');
  });
  try {
    const root=await config(s.url);
    await run(runtime,['commit'],JSON.stringify(payload),{AGY_QUOTA_CONFIG_DIR:root});
    assert.equal((await readdir(join(root,'pending'))).length,1);
    online=true;
    const r=await run(runtime,['check'],JSON.stringify({...payload,invocationNum:1}),{AGY_QUOTA_CONFIG_DIR:root});
    assert.deepEqual(JSON.parse(r.stdout),{});
    assert.equal((await readdir(join(root,'pending'))).length,0);
    assert.equal(received.filter(r=>r.path==='/commit').length,1);
  } finally {await s.close();}
});
test('installed Hook forwards current calibration estimates without a client update',async()=>{
  const message='【动态额度估算】5 小时：1 分≈0.2%；周：1 分≈0.05%（历史校准）';
  const s=await server(async(req,res)=>{for await(const _ of req){}res.end(JSON.stringify({quota:{fiveHour:{percentPerPoint:.2}},injectSteps:[{ephemeralMessage:message}]}));});
  try {
    const root=await config(s.url),r=await run(runtime,['check'],JSON.stringify(payload),{AGY_QUOTA_CONFIG_DIR:root});
    assert.equal(r.code,0);assert.deepEqual(JSON.parse(r.stdout),{injectSteps:[{ephemeralMessage:message}]});
  } finally {await s.close();}
});
test('a cold connection slower than five seconds is accepted without restarting the request',async()=>{
  let attempts=0;
  const s=await server((_req,res)=>{attempts++;const t=setTimeout(()=>res.end('{}'),6500);res.on('close',()=>clearTimeout(t));});
  try{const root=await config(s.url);const r=await run(runtime,['check'],JSON.stringify(payload),{AGY_QUOTA_CONFIG_DIR:root});assert.equal(r.code,0);assert.deepEqual(JSON.parse(r.stdout),{});assert.equal(attempts,1);}finally{await s.close();}
});
test('stalled requests share a sixteen-second budget and fail closed once',async()=>{
  let attempts=0;
  const s=await server((_req,res)=>{attempts++;const t=setTimeout(()=>res.end('{}'),20000);res.on('close',()=>clearTimeout(t));});
  try{const root=await config(s.url),start=Date.now();const r=await run(runtime,['check'],JSON.stringify(payload),{AGY_QUOTA_CONFIG_DIR:root});const elapsed=Date.now()-start;assert.equal(attempts,2);assert.ok(elapsed>=15500&&elapsed<17500,`elapsed ${elapsed}ms`);assert.equal(r.stdout.trim().split('\n').length,1);assert.equal(JSON.parse(r.stdout).terminationBehavior,'terminate');assert.equal(r.code,0);}finally{await s.close();}
});
test('slow outbox replay preserves a terminate response and stays inside the hook deadline',async()=>{
  let online=false,replayed=0;
  const s=await server(async(req,res)=>{for await(const _ of req){}if(!online){res.statusCode=503;res.end('{}');return;}
    if(req.url==='/check'){res.end('{"terminationBehavior":"terminate"}');return;}
    replayed++;
    const t=setTimeout(()=>res.end('{}'),650);res.on('close',()=>clearTimeout(t));
  });
  try{const root=await config(s.url);for(let n=0;n<12;n++)await run(runtime,['commit'],JSON.stringify({...payload,invocationNum:n}),{AGY_QUOTA_CONFIG_DIR:root});
    assert.equal((await readdir(join(root,'pending'))).length,12,'offline completions must be durable');
    online=true;replayed=0;
    const start=Date.now();const r=await run(runtime,['check'],JSON.stringify({...payload,invocationNum:9}),{AGY_QUOTA_CONFIG_DIR:root});
    const elapsed=Date.now()-start;assert.ok(elapsed<16500,`elapsed ${elapsed}ms`);
    assert.equal(r.stdout.trim().split('\n').length,1);assert.equal(JSON.parse(r.stdout).terminationBehavior,'terminate');
    assert.equal(replayed,10,'replay is bounded to 10 records per hook');
    assert.equal((await readdir(join(root,'pending'))).length,2,'unreplayed records stay on disk');
  }finally{await s.close();}
});
test('installer preserves other hooks/settings, protects credentials, and uninstalls cleanly',async()=>{
  const home=await mkdtemp(join(tmpdir(),'agy install '));const root=join(home,'.gemini','config'),cli=join(home,'.gemini','antigravity-cli');await mkdir(root,{recursive:true});await mkdir(cli,{recursive:true});await writeFile(join(root,'hooks.json'),JSON.stringify({existing:{enabled:true}}));await writeFile(join(cli,'settings.json'),JSON.stringify({theme:'dark',useG1Credits:true}));const tokenFile=join(home,'token');await writeFile(tokenFile,token);
  const proxy='http://127.0.0.1:7897/';
  const r=await run(installer,['--home',home,'--url','https://example.com','--token-file',tokenFile,'--proxy',proxy]);assert.equal(r.code,0,r.stderr);
  const hooks=JSON.parse(await readFile(join(root,'hooks.json'),'utf8')),settings=JSON.parse(await readFile(join(cli,'settings.json'),'utf8'));
  assert.deepEqual(hooks.existing,{enabled:true});assert.equal(settings.theme,'dark');assert.equal(settings.useG1Credits,false);assert.equal(hooks['family-quota-guard'].Stop.length,1);
  if(process.platform==='win32')assert.equal(hooks['family-quota-guard'].PreInvocation[0].command,'agy-family-quota\\run.cmd check');
  else assert.ok(hooks['family-quota-guard'].PreInvocation[0].command.includes("'"));
  for(const event of ['PreInvocation','PostInvocation','Stop'])assert.equal(hooks['family-quota-guard'][event][0].timeout,18);
  if(process.platform!=='win32')assert.equal((await stat(join(root,'agy-family-quota','credentials.json'))).mode&0o777,0o600);
  assert.ok((await readdir(root)).some(x=>x.startsWith('hooks.json.backup-')));
  const credentialsPath=join(root,'agy-family-quota','credentials.json');
  assert.equal(JSON.parse(await readFile(credentialsPath,'utf8')).proxy,'http://127.0.0.1:7897');
  const upgrade=await run(installer,['--home',home,'--upgrade']);assert.equal(upgrade.code,0,upgrade.stderr);
  const upgraded=JSON.parse(await readFile(credentialsPath,'utf8'));
  assert.equal(upgraded.token,token);assert.equal(upgraded.proxy,'http://127.0.0.1:7897');
  const noProxy=await run(installer,['--home',home,'--upgrade','--no-proxy']);assert.equal(noProxy.code,0,noProxy.stderr);
  assert.equal('proxy' in JSON.parse(await readFile(credentialsPath,'utf8')),false);
  const undo=await run(installer,['--home',home,'--uninstall']);assert.equal(undo.code,0);const after=JSON.parse(await readFile(join(root,'hooks.json'),'utf8'));assert.deepEqual(after,{existing:{enabled:true}});
});
test('installer refuses malformed existing JSON before writing any configuration',async()=>{
  const home=await mkdtemp(join(tmpdir(),'agy-bad-')),root=join(home,'.gemini','config');await mkdir(root,{recursive:true});await writeFile(join(root,'hooks.json'),'{broken');const r=await run(installer,['--home',home,'--url','https://example.com']);assert.equal(r.code,1);assert.equal(await readFile(join(root,'hooks.json'),'utf8'),'{broken');
});
test('commit hook extracts token telemetry from local transcript without leaking conversation content',async()=>{
  let received;
  const s=await server(async(req,res)=>{let raw='';for await(const c of req)raw+=c;received=JSON.parse(raw);res.end('{}');});
  try{
    const root=await config(s.url);
    const transcript=join(root,'transcript.jsonl');
    await writeFile(transcript,[
      JSON.stringify({step_index:0,type:'USER_INPUT',content:'secret user prompt'}),
      JSON.stringify({step_index:1,type:'PLANNER_RESPONSE',input_tokens:820,cache_read_tokens:14200,output_tokens:95,thinking:'secret chain of thought',tool_calls:[{name:'read_file'},{name:'edit_file'}]})
    ].join('\n')+'\n');
    const r=await run(runtime,['commit'],JSON.stringify({...payload,transcriptPath:transcript}),{AGY_QUOTA_CONFIG_DIR:root});
    assert.equal(r.code,0);
    assert.deepEqual(received,{conversationId:'c-1',invocationNum:0,modelName:'gemini-flash',inputTokens:820,cacheReadTokens:14200,outputTokens:95,toolCalls:2});
    assert.ok(!JSON.stringify(received).includes('secret'));
    // Large tool outputs (>64KB) after PLANNER_RESPONSE still resolve current step telemetry, while USER_INPUT boundaries prevent matching stale turns:
    await writeFile(transcript,[
      JSON.stringify({step_index:0,type:'PLANNER_RESPONSE',input_tokens:99999,output_tokens:999}),
      JSON.stringify({step_index:1,type:'USER_INPUT',content:'new turn without planner response yet'})
    ].join('\n')+'\n');
    assert.deepEqual(await readTelemetry(transcript,1),{});
    await writeFile(transcript,[
      JSON.stringify({step_index:1,type:'USER_INPUT',content:'turn with large tool outputs'}),
      JSON.stringify({step_index:2,type:'PLANNER_RESPONSE',input_tokens:1500,cache_read_tokens:28000,output_tokens:210,tool_calls:[{name:'read_file'},{name:'read_file'},{name:'read_file'}]}),
      JSON.stringify({step_index:3,type:'GENERIC',content:'x'.repeat(50000)}),
      JSON.stringify({step_index:4,type:'GENERIC',content:'y'.repeat(50000)})
    ].join('\n')+'\n');
    assert.deepEqual(await readTelemetry(transcript,1),{inputTokens:1500,cacheReadTokens:28000,outputTokens:210,toolCalls:3});
    // Check action extracts known contextTokens across USER_INPUT boundaries without leaking conversation content:
    await writeFile(transcript,[
      JSON.stringify({step_index:1,type:'PLANNER_RESPONSE',input_tokens:1500,cache_read_tokens:28000,output_tokens:210}),
      JSON.stringify({step_index:2,type:'USER_INPUT',content:'next turn private prompt'})
    ].join('\n')+'\n');
    assert.deepEqual(await readContextTelemetry(transcript),{contextTokens:29710});
    const checkWithCtx=await run(runtime,['check'],JSON.stringify({...payload,invocationNum:10000,transcriptPath:transcript}),{AGY_QUOTA_CONFIG_DIR:root});
    assert.equal(checkWithCtx.code,0);
    assert.deepEqual(received,{conversationId:'c-1',invocationNum:10000,modelName:'gemini-flash',contextTokens:29710});
    assert.ok(!JSON.stringify(received).includes('private'));
  }finally{await s.close();}
});
test('outbox flush removes corrupted or permanent 4xx entries without blocking subsequent valid commits',async()=>{
  let available=true;
  const committed=[];
  const s=await server(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;
    if(!available){res.statusCode=503;res.end('{}');return;}
    const body=JSON.parse(raw);
    if(req.url==='/commit'&&body.invocationNum===0){res.statusCode=409;res.end('{"error":"conflict"}');return;}
    if(req.url==='/commit')committed.push(body.invocationNum);
    res.end('{}');
  });
  try{
    const root=await config(s.url);
    available=false;
    await run(runtime,['commit'],JSON.stringify({...payload,invocationNum:0}),{AGY_QUOTA_CONFIG_DIR:root});
    await run(runtime,['commit'],JSON.stringify({...payload,invocationNum:2}),{AGY_QUOTA_CONFIG_DIR:root});
    await writeFile(join(root,'pending','0'.repeat(64)+'.json'),'{corrupted-json');
    available=true;
    const bad=await run(runtime,['commit'],JSON.stringify({...payload,invocationNum:0}),{AGY_QUOTA_CONFIG_DIR:root});
    assert.equal(bad.code,0);
    const checkRun=await run(runtime,['check'],JSON.stringify({...payload,invocationNum:1}),{AGY_QUOTA_CONFIG_DIR:root});
    assert.equal(checkRun.code,0);
    assert.equal((await readdir(join(root,'pending'))).length,0);
    assert.deepEqual(committed,[2]);
  }finally{await s.close();}
});
test('hook silently self-updates after emitting response when server advertises a newer valid sha256',async()=>{
  const baseScript=await readFile(runtime,'utf8');
  const updatedScript=`${baseScript}\n// auto-updated-marker-v2\n`;
  const updatedSha256=createHash('sha256').update(updatedScript).digest('hex');
  const brokenSyntaxScript='#!/usr/bin/env node\nconst x = {;\n';
  const brokenSyntaxSha256=createHash('sha256').update(brokenSyntaxScript).digest('hex');
  let advertisedSha256=updatedSha256,servedScript=updatedScript,downloads=0;
  const s=await server(async(req,res)=>{
    for await(const _ of req){}
    if(req.url==='/client/agy-quota.mjs'){
      downloads++;
      res.setHeader('Content-Type','text/javascript; charset=utf-8');
      res.end(servedScript);
      return;
    }
    res.setHeader('Content-Type','application/json');
    if(advertisedSha256)res.setHeader('X-Agy-Client-Sha256',advertisedSha256);
    res.end('{}');
  });
  try{
    const root=await config(s.url);
    const localScriptPath=join(root,'agy-quota.mjs');
    await writeFile(localScriptPath,baseScript,{mode:0o700});
    // 1. Triggers self-update when hash differs and script is valid
    const r1=await run(localScriptPath,['check'],JSON.stringify(payload),{AGY_QUOTA_CONFIG_DIR:root});
    assert.equal(r1.code,0);
    assert.deepEqual(JSON.parse(r1.stdout),{});
    assert.equal(downloads,1);
    assert.equal(await readFile(localScriptPath,'utf8'),updatedScript);
    if(process.platform!=='win32')assert.equal((await stat(localScriptPath)).mode&0o777,0o700);
    // 2. Does not re-download when local script already matches advertised hash
    const r2=await run(localScriptPath,['check'],JSON.stringify(payload),{AGY_QUOTA_CONFIG_DIR:root});
    assert.equal(r2.code,0);
    assert.equal(downloads,1);
    // 3. Rejects mismatched hash or broken syntax without corrupting local script or failing the hook
    advertisedSha256='f'.repeat(64);
    servedScript=updatedScript;
    assert.equal(await selfUpdate(root,{url:s.url,token},advertisedSha256),false);
    assert.equal(await readFile(localScriptPath,'utf8'),updatedScript);
    advertisedSha256=brokenSyntaxSha256;
    servedScript=brokenSyntaxScript;
    const r3=await run(localScriptPath,['check'],JSON.stringify(payload),{AGY_QUOTA_CONFIG_DIR:root});
    assert.equal(r3.code,0);
    assert.deepEqual(JSON.parse(r3.stdout),{});
    assert.equal(await readFile(localScriptPath,'utf8'),updatedScript);
    assert.ok(!(await readdir(root)).some(name=>name.startsWith('.agy-quota.')));
  }finally{await s.close();}
});
