import {spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
const config=JSON.parse(await readFile('wrangler.json','utf8'));
if(config.d1_databases[0].database_id !== '00000000-0000-0000-0000-000000000000') {
  console.log('D1 已配置，保留现有数据库。');
} else {
  const result=spawnSync('npx',['wrangler','d1','create','agy-family-quota','--location','apac','--update-config','false'],{encoding:'utf8'});
  if(result.status!==0) {process.stderr.write(result.stderr||result.stdout);process.exit(result.status||1);}
  const id=result.stdout.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/i)?.[0];
  if(!id)throw Error('创建结果没有数据库 ID，请检查 wrangler d1 list；不要重复创建数据库');
  config.d1_databases[0].database_id=id;
  await writeFile('wrangler.json',JSON.stringify(config,null,2)+'\n');
  console.log('已创建 D1 并写入 wrangler.json。');
}
console.log('下一步：npm exec wrangler secret put ADMIN_TOKEN，然后 npm run deploy');
