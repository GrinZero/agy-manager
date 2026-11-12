// Optional native agy acceptance. Requires local Worker on 127.0.0.1:8787.
// Uses an isolated workspace hook and a zero-limit test member; never changes global hooks.
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const admin=(await readFile('.dev.vars','utf8')).split('\n').find(x=>x.startsWith('ADMIN_TOKEN=')).slice(12).trim();
const res=await fetch('http://127.0.0.1:8787/api/admin/members',{method:'POST',headers:{Authorization:`Bearer ${admin}`,'Content-Type':'application/json'},body:JSON.stringify({name:'验收-原生拦截',email:`native-${crypto.randomUUID()}@example.com`,gemini_5h_limit:0,gemini_wk_limit:0,tp_5h_limit:0,tp_wk_limit:0})});
assert.equal(res.status,201);const member=await res.json();
const workspace=await mkdtemp(join(tmpdir(),'agy-native-')),config=join(workspace,'credentials');
await mkdir(config);await mkdir(join(workspace,'.agents'));
await writeFile(join(config,'credentials.json'),JSON.stringify({url:'http://127.0.0.1:8787',token:member.token}),{mode:0o600});
const runtime=resolve('public/client/agy-quota.mjs');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const cmd=`${quote(process.execPath)} ${quote(runtime)}`;
await writeFile(join(workspace,'.agents','hooks.json'),JSON.stringify({'family-quota-guard':{enabled:true,PreInvocation:[{type:'command',command:cmd+' check',timeout:18}],PostInvocation:[{type:'command',command:cmd+' commit',timeout:18}],Stop:[{type:'command',command:cmd+' release',timeout:18}]}}));
const result=await new Promise((resolve,reject)=>{
  const p=spawn('agy',['--print','请只回复 OK。','--model','gemini-3.8-flash-medium','--settings','{"useG1Credits":false}','--print-timeout','25s'],{cwd:workspace,env:{...process.env,AGY_QUOTA_CONFIG_DIR:config}});
  let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);p.on('error',reject);p.on('exit',code=>resolve({code,output}));
  const timer=setTimeout(()=>p.kill('SIGTERM'),35000);p.on('exit',()=>clearTimeout(timer));
});
assert.match(result.output,/家庭配额上限|母账号未连接/,'Native CLI did not display the quota guard message: '+result.output);
assert.notEqual(result.code,0,'Blocking must report an error exit status in print mode');
await fetch(`http://127.0.0.1:8787/api/admin/members/${member.member_id}`,{method:'PATCH',headers:{Authorization:`Bearer ${admin}`,'Content-Type':'application/json'},body:JSON.stringify({enabled:0})});
console.log(`Native agy acceptance passed: quota block shown, exit code ${result.code}; global configuration untouched.`);
