// The usage manual lives in the admin UI, so its command strings and wiring are
// easy to break without any runtime error. Keep a cheap static guard on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('manual page is reachable from the navigation and routed', () => {
  assert.match(html, /<a href="#manual">手册<\/a>/, 'nav should link to the manual');
  assert.match(html, /<section id="manual" class="page manual-page"/, 'manual page must be a routed page section');
  assert.match(app, /\['overview', 'members', 'activity', 'settings', 'tutorial', 'manual'\]/, 'route must accept #manual');
  assert.match(html, /id="manual-title"/, 'routed pages need an h1 for focus handling');
});

test('manual exposes install, upgrade, proxy, uninstall and health commands', () => {
  for (const id of ['manual-install', 'manual-upgrade', 'manual-proxy', 'manual-no-proxy', 'manual-health']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} is missing`);
    assert.match(app, new RegExp(`'#${id}'`), `${id} is never rendered by app.js`);
  }
  for (const flag of ['--upgrade', '--proxy', '--no-proxy', '--uninstall', '--token-file', '--home']) {
    assert.match(html, new RegExp(flag), `manual should document ${flag}`);
  }
});

test('every copy button targets a real command block', () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const targets = [...html.matchAll(/data-copy-command="([^"]+)"/g)].map(m => m[1]);
  assert.ok(targets.length >= 5, 'manual should offer copy buttons');
  for (const target of targets) assert.ok(ids.has(target), `copy target #${target} does not exist`);
});

test('app.js only references ids that exist in the document', () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const referenced = [...new Set([...app.matchAll(/\$\('#([a-z0-9-]+)'\)/gi)].map(m => m[1]))];
  const missing = referenced.filter(id => !ids.has(id));
  assert.deepEqual(missing, [], `missing ids: ${missing.join(', ')}`);
});

test('the health probe avoids quotes and curl aliases that break on Windows', () => {
  assert.match(app, /curl\.exe -sS -o NUL -w HTTP:%\{http_code\}:%\{time_total\}s/);
  assert.doesNotMatch(app, /-w "HTTP/, 'cmd /c misparses a quoted -w value');
});

test('--no-proxy never emits a contradicting --proxy argument', () => {
  assert.match(app, /extra\.includes\('--no-proxy'\) \? '' : installProxy\(\)/,
    'the proxy must be dropped from the command when --no-proxy is present');
});

test('an invalid proxy never produces a copyable command', () => {
  assert.match(app, /if \(rawProxy && !proxy\)/, 'invalid proxy input must be reported');
  assert.match(app, /proxyButton\.disabled = true/, 'the copy button must be disabled while the proxy is invalid');
});
