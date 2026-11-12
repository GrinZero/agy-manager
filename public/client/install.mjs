#!/usr/bin/env node
import {readFile,writeFile,mkdir,copyFile,chmod,rename} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const args = process.argv.slice(2);
function option(key) { const i=args.indexOf(key); if(i<0)return undefined;if(!args[i+1]||args[i+1].startsWith('--'))throw Error(`${key} 缺少值`);return args[i+1]; }
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
async function existingJson(path) {
  let text;
  try {text=await readFile(path,'utf8');} catch(e) {if(e.code==='ENOENT')return {};throw e;}
  let value;
  try {value=JSON.parse(text);}catch {throw Error(`${path} 不是有效 JSON；没有修改任何配置，请先修复`);}
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error(`${path} 必须是 JSON 对象`);
  return value;
}
const suffix = `.backup-${Date.now()}`;
async function save(path,data,mode=0o600) {
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  await copyFile(path,path+suffix).catch(e=>{if(e.code!=='ENOENT')throw e;});
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp,data,{mode});await chmod(temp,mode);await rename(temp,path);
}
async function tokenPrompt() {
  if(!process.stdin.isTTY)throw Error('非交互安装请使用 --token-file /path/to/token（不要把令牌写进命令行）');
  process.stdout.write('粘贴成员令牌（输入隐藏）：');
  process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');
  return new Promise((resolve,reject)=>{
    let value='';
    const onData = data => {
      for(const c of data) {
        if(c==='\u0003'){cleanup();reject(Error('已取消'));return;}
        if(c==='\r'||c==='\n'){cleanup();resolve(value.trim());return;}
        if(c==='\u007f'){value=value.slice(0,-1);continue;}
        if(c>=' ')value+=c;
      }
    };
    const cleanup=()=>{process.stdin.removeListener('data',onData);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');};
    process.stdin.on('data',onData);
  });
}
try {
  const home = resolve(option('--home') || homedir());
  const configDir = join(home,'.gemini','config'), root=join(configDir,'agy-family-quota');
  const hooksPath=join(configDir,'hooks.json'), settingsPath=join(home,'.gemini','antigravity-cli','settings.json');
  const hooks=await existingJson(hooksPath),settings=await existingJson(settingsPath);
  if(args.includes('--uninstall')) {
    delete hooks['family-quota-guard'];
    await save(hooksPath,JSON.stringify(hooks,null,2)+'\n');
    console.log('已移除 family-quota-guard；备份、待补记流水和超额点数关闭设置均保留。');
  } else {
    const previous=args.includes('--upgrade')?await existingJson(join(root,'credentials.json')):{};
    const url=new URL(option('--url') || previous.url || '');
    if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||
      !(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw Error('请通过 --url 指定 HTTPS 服务地址（本地允许 http://127.0.0.1:8787）');
    const tokenFile=option('--token-file');
    const token=(tokenFile?await readFile(tokenFile,'utf8'):args.includes('--upgrade')&&previous.token?previous.token:await tokenPrompt()).trim();
    if(!/^agy_[a-f0-9]{64}$/.test(token))throw Error('成员令牌格式错误');
    let runtime;
    try {runtime=await readFile(join(dirname(fileURLToPath(import.meta.url)),'agy-quota.mjs'),'utf8');}
    catch(e) {if(e.code!=='ENOENT')throw e;const res=await fetch(`${url.origin}/client/agy-quota.mjs`,{signal:AbortSignal.timeout(10000)});if(!res.ok)throw Error('无法下载 Hook 脚本');runtime=await res.text();if(!runtime.startsWith('#!/usr/bin/env node'))throw Error('Hook 脚本响应无效');}
    await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);
    await save(join(root,'agy-quota.mjs'),runtime,0o700);
    await save(join(root,'credentials.json'),JSON.stringify({url:url.origin,token},null,2)+'\n');
    const command=`${quote(process.execPath)} ${quote(join(root,'agy-quota.mjs'))}`;
    hooks['family-quota-guard']={enabled:true,
      PreInvocation:[{type:'command',command:`${command} check`,timeout:18}],
      PostInvocation:[{type:'command',command:`${command} commit`,timeout:18}],
      Stop:[{type:'command',command:`${command} release`,timeout:18}]};
    settings.useG1Credits=false;
    await save(settingsPath,JSON.stringify(settings,null,2)+'\n');
    await save(hooksPath,JSON.stringify(hooks,null,2)+'\n');
    console.log(`已安装至 ${root}\n已合并全局 Hooks，并设置 CLI useG1Credits=false。额度检查失败时暂停新调用。\n原配置备份后缀：${suffix}\n重启 agy；桌面端和 IDE 请手动将 AI Credit Overages 设为 Never。`);
  }
} catch(e) { console.error(e.message);process.exitCode=1; }
