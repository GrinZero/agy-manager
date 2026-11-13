#!/usr/bin/env node
import {readFile,writeFile,mkdir,copyFile,chmod,rename,unlink,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";

// Antigravity runs hooks with `sh -c` on Unix and `cmd /c` on Windows, with the
// working directory set to the directory containing hooks.json.
// On Windows `cmd /c "C:\Program Files\nodejs\node.exe" "C:\...\agy-quota.mjs" check`
// is misparsed: cmd strips the first quote off a quoted executable, so all three
// hooks silently fail to start and no usage is ever reported to the ledger.
// The Windows launcher resolves the script from its own directory (%~dp0), so no
// user path (which may contain spaces, & or %) ever appears in a cmd command line.
// It also falls back to `node` from PATH if the recorded executable was moved.
export function hookPlan(platform, nodeExe, scriptPath, guardDir) {
  if (platform !== 'win32') return {command: `${quote(nodeExe)} ${quote(scriptPath)}`, launchers: []};
  return {
    command: `${basename(guardDir)}\\run.cmd`,
    launchers: [{path: join(guardDir, 'run.cmd'), mode: 0o700,
      content: `@echo off\r\nset "AGY_NODE=${nodeExe}"\r\nif not exist "%AGY_NODE%" set "AGY_NODE=node"\r\n"%AGY_NODE%" "%~dp0${basename(scriptPath)}" %*\r\n`}]
  };
}

// A hook that fails to start produces no stdout, which Antigravity treats as a
// no-op. That is exactly how an install can look healthy while never reporting
// any usage. Probe the real command once at install time so this fails loudly.
function probeHook(command, cwd) {
  const win = process.platform === 'win32';
  const shell = win ? (process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe') : '/bin/sh';
  const args = win ? ['/c', command] : ['-c', command];
  return new Promise(resolve => {
    const child = spawn(shell, args, {cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    let out = '', err = '';
    child.stdout.on('data', c => out += c);
    child.stderr.on('data', c => err += c);
    child.on('error', e => resolve({ok: false, reason: e.message}));
    child.on('close', code => {
      try {
        const value = JSON.parse(out.trim());
        resolve({ok: code === 0 && !!value && typeof value === 'object' && !Array.isArray(value), reason: `exit ${code}: ${err.trim()}`});
      } catch { resolve({ok: false, reason: `exit ${code}, stdout=${JSON.stringify(out.trim().slice(0, 120))} stderr=${JSON.stringify(err.trim().slice(0, 120))}`}); }
    });
    // An empty payload makes the guard fail before any network request or ledger write.
    child.stdin.end('{}');
  });
}

const suffix = `.backup-${Date.now()}`;
async function existingJson(path) {
  let text;
  try {text=await readFile(path,'utf8');} catch(e) {if(e.code==='ENOENT')return {};throw e;}
  let value;
  try {value=JSON.parse(text);}catch {throw Error(`${path} 不是有效 JSON；没有修改任何配置，请先修复`);}
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error(`${path} 必须是 JSON 对象`);
  return value;
}
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
async function install() {
  const args = process.argv.slice(2);
  function option(key) { const i=args.indexOf(key); if(i<0)return undefined;if(!args[i+1]||args[i+1].startsWith('--'))throw Error(`${key} 缺少值`);return args[i+1]; }
  const home = resolve(option('--home') || homedir());
  const configDir = join(home,'.gemini','config'), root=join(configDir,'agy-family-quota');
  const hooksPath=join(configDir,'hooks.json'), settingsPath=join(home,'.gemini','antigravity-cli','settings.json');
  const hooks=await existingJson(hooksPath),settings=await existingJson(settingsPath);
  if(args.includes('--uninstall')) {
    delete hooks['family-quota-guard'];
    await save(hooksPath,JSON.stringify(hooks,null,2)+'\n');
    await unlink(join(root,'run.cmd')).catch(()=>{});
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
    const runtimePath=join(root,'agy-quota.mjs');
    await save(runtimePath,runtime,0o700);
    await save(join(root,'credentials.json'),JSON.stringify({url:url.origin,token},null,2)+'\n');
    const plan=hookPlan(process.platform,process.execPath,runtimePath,root);
    for(const launcher of plan.launchers){
      await mkdir(dirname(launcher.path),{recursive:true,mode:0o700});
      // Windows refuses to overwrite an existing executable with copyFile (EPERM);
      // write a fresh temp file and rename it over the old launcher instead.
      const temp = `${launcher.path}.tmp-${process.pid}`;
      await writeFile(temp,launcher.content,{mode:launcher.mode});
      await chmod(temp,launcher.mode);
      await rename(temp,launcher.path);
    }
    const probe=await probeHook(`${plan.command} check`,configDir);
    if(!probe.ok) throw Error(`Hook 自检失败，已写入脚本但未更新 hooks.json：${probe.reason}\n请确认 Node.js 可用，且 ${configDir} 可作为 Hook 工作目录。`);
    hooks['family-quota-guard']={enabled:true,
      PreInvocation:[{type:'command',command:`${plan.command} check`,timeout:18}],
      PostInvocation:[{type:'command',command:`${plan.command} commit`,timeout:18}],
      Stop:[{type:'command',command:`${plan.command} release`,timeout:18}]};
    settings.useG1Credits=false;
    await save(settingsPath,JSON.stringify(settings,null,2)+'\n');
    await save(hooksPath,JSON.stringify(hooks,null,2)+'\n');
    console.log(`Hook 自检通过（${process.platform==='win32'?'cmd /c':'sh -c'}）。已安装至 ${root}\n已合并全局 Hooks，并设置 CLI useG1Credits=false。额度检查失败时暂停新调用。\n原配置备份后缀：${suffix}\n重启 agy；桌面端和 IDE 请手动将 AI Credit Overages 设为 Never。`);
  }
}
const isMain = process.argv[1] && await realpath(process.argv[1]).catch(()=>process.argv[1]) === await realpath(fileURLToPath(import.meta.url)).catch(()=>fileURLToPath(import.meta.url));
if (isMain) {
  try { await install(); } catch(e) { console.error(e.message);process.exitCode=1; }
}
