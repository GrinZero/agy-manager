import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

/**
 * 用当前 Node 直接执行本地 wrangler，避免依赖 PATH、npx.cmd 或 shell。
 * Windows 下 spawnSync('npx') 会因缺少 .cmd 后缀直接 ENOENT，导致本地初始化失败。
 */
export function wrangler(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], {cwd: root, ...options});
}
