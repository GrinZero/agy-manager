import {randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
try {await readFile('.dev.vars');}
catch(e) {
  if(e.code!=='ENOENT')throw e;
  await writeFile('.dev.vars',`ADMIN_TOKEN=${randomBytes(32).toString('hex')}\n`,{mode:0o600});
  console.log('已生成本地管理员令牌：.dev.vars（仅本机使用，请勿提交）。');
}
const keySetup=spawnSync(process.execPath,['scripts/setup-account-key.mjs','--local'],{stdio:'inherit'});
if(keySetup.status!==0)process.exit(keySetup.status||1);
const p=spawnSync('npx',['wrangler','d1','migrations','apply','agy-family-quota','--local'],{stdio:'inherit'});
process.exitCode=p.status??1;
