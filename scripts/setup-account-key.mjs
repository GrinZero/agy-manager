import {randomBytes} from 'node:crypto';
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {wrangler} from './wrangler.mjs';

const local=process.argv.includes('--local');
if(!local&&!process.argv.includes('--production'))throw Error('请指定 --local 或 --production');
const file=local?'.dev.vars':'.production.vars';
let content=await readFile(file,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
let key=content.split('\n').find(line=>line.startsWith('ACCOUNT_ENCRYPTION_KEY='))?.slice('ACCOUNT_ENCRYPTION_KEY='.length).trim();
if(!key) {
  key=randomBytes(32).toString('hex');
  content+=(content&&!content.endsWith('\n')?'\n':'')+`ACCOUNT_ENCRYPTION_KEY=${key}\n`;
  await writeFile(file,content,{mode:0o600});
}
if(!/^[a-f0-9]{64}$/.test(key))throw Error('ACCOUNT_ENCRYPTION_KEY 需要 64 位十六进制密钥');
await chmod(file,0o600);
if(!local) {
  const result=wrangler(['secret','put','ACCOUNT_ENCRYPTION_KEY'],{input:key+'\n',encoding:'utf8'});
  process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
  if(result.status!==0)process.exitCode=result.status||1;
}
console.log(`账号加密密钥已保存在 ${file}；请妥善备份，丢失密钥后需要重新授权母账号。`);
