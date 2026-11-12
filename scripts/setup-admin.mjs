import {randomBytes} from 'node:crypto';
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
let token;
try {token=(await readFile('.production.vars','utf8')).split('\n').find(x=>x.startsWith('ADMIN_TOKEN='))?.slice(12).trim();}
catch(e) {if(e.code!=='ENOENT')throw e;}
if(!token){token=randomBytes(32).toString('hex');await writeFile('.production.vars',`ADMIN_TOKEN=${token}\n`,{mode:0o600});}
if(token.length<32)throw Error('管理员令牌至少需要 32 个字符');
await chmod('.production.vars',0o600);
const result=spawnSync('npx',['wrangler','secret','put','ADMIN_TOKEN'],{input:token+'\n',encoding:'utf8'});
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
if(result.status!==0)process.exitCode=result.status||1;
else console.log('生产管理员令牌已配置；本机副本位于 .production.vars（0600，请保存到密码管理器）。');
