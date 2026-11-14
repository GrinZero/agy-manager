import {readFile,readdir} from 'node:fs/promises';

export async function applyMigration(db:D1Database,name:string) {
  const sql=await readFile(`migrations/${name}`,'utf8');
  // D1 exec treats each line as a query. Keep trigger bodies in one query.
  await db.exec(sql.replace(/^[ \t]*--.*$/gm,'').replace(/\r?\n/g,' '));
}
export async function applyMigrations(db:D1Database) {
  for(const name of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await applyMigration(db,name);
}
