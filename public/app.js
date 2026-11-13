import {poolView} from './quota-view.mjs';

const $ = selector => document.querySelector(selector);
let viewerRole = 'admin', viewerEmail = '';
let adminToken = '', data = null, toastTimer, oauthMode = 'mother', memberWindow = 'fiveHour';
let policyLoaded = false, refreshTask = null, availabilitySignature = '';
const limitKeys = ['gemini_5h_limit', 'gemini_wk_limit', 'tp_5h_limit', 'tp_wk_limit'];
const number = value => Number(value).toLocaleString('zh-CN', {maximumFractionDigits: 3});
function node(tag, cls, value) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (value !== undefined) el.textContent = value;
  return el;
}
function toast(text) {
  $('#toast').textContent = text; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 3500);
}
function confirmAction({title, description, label, action}) {
  const dialog = $('#confirm-dialog'), form = $('#confirm-form');
  if (dialog.open) return Promise.resolve(false);
  const parent = document.querySelector('dialog[open]'), trigger = document.activeElement;
  const buttons = [...form.querySelectorAll('button')];
  let busy = false, confirmed = false;
  $('#confirm-title').textContent = title;
  $('#confirm-description').textContent = description;
  $('#confirm-submit').textContent = label;
  form.querySelector('.form-error').textContent = '';
  parent?.classList.add('dialog-suspended');
  return new Promise(resolve => {
    const cancel = event => { if (busy) event.preventDefault(); };
    const trapFocus = event => {
      if (event.key !== 'Tab') return;
      if (busy) { event.preventDefault(); return; }
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    dialog.addEventListener('cancel', cancel);
    dialog.addEventListener('keydown', trapFocus);
    dialog.addEventListener('close', () => {
      dialog.removeEventListener('cancel', cancel);
      dialog.removeEventListener('keydown', trapFocus);
      form.onsubmit = null;
      parent?.classList.remove('dialog-suspended');
      if (parent?.open || !parent) trigger?.focus({preventScroll: true});
      resolve(confirmed);
    }, {once: true});
    $('#confirm-cancel').onclick = () => dialog.close();
    form.onsubmit = async event => {
      event.preventDefault();
      if (busy) return;
      busy = true; buttons.forEach(button => { button.disabled = true; });
      form.setAttribute('aria-busy', 'true');
      $('#confirm-submit').textContent = '处理中…';
      form.querySelector('.form-error').textContent = '';
      try { await action(); confirmed = true; dialog.close(); }
      catch (error) { form.querySelector('.form-error').textContent = error.message; }
      finally {
        busy = false; buttons.forEach(button => { button.disabled = false; });
        form.removeAttribute('aria-busy'); $('#confirm-submit').textContent = label;
      }
    };
    dialog.showModal();
    $('#confirm-cancel').focus({preventScroll: true});
  });
}
function showLogin() {
  adminToken = ''; data = null; policyLoaded = false;
  document.body.dataset.auth = 'guest';
  $('#admin-token').value = ''; $('#generated-token').value = ''; $('#callback-url').value = '';
  $('#installation-token').value = ''; clearPromptFallbacks();
  document.querySelectorAll('dialog[open]').forEach(dialog => { if (dialog.id !== 'login-dialog') dialog.close(); });
  if (!$('#login-dialog').open) $('#login-dialog').showModal();
}
async function api(path, method = 'GET', body) {
  const res = await fetch(`/api/${viewerRole === 'member' ? 'member' : 'admin'}/${path}`, {method, headers: {
    ...(adminToken ? {Authorization: `Bearer ${adminToken}`} : {}),
    ...(body ? {'Content-Type': 'application/json'} : {})
  }, ...(body ? {body: JSON.stringify(body)} : {})});
  const result = await res.json();
  if (!res.ok) { if (res.status === 401) showLogin(); throw Object.assign(Error(result.error || `请求失败 (${res.status})`), {status: res.status}); }
  return result;
}
async function authApi(path, body) {
  const res = await fetch(`/api/auth/${path}`, {method: body ? 'POST' : 'GET', ...(body ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {})});
  const result = await res.json();
  if (!res.ok) throw Error(result.error || `登录失败 (${res.status})`);
  return result;
}
function meter(value, cap, label, unit = '%') {
  const el = node('progress'); el.max = cap > 0 ? cap : 1; el.value = Math.max(0, Math.min(value, el.max));
  el.setAttribute('aria-label', `${label}：${number(value)} / ${number(cap)}${unit === '%' ? '%' : ` ${unit}`}`); return el;
}
function windowView(used, cap, title) {
  const box = node('div', 'window'), line = node('div', 'window-label');
  line.append(node('span', '', title), node('strong', '', `${number(used)}% / ${number(cap)}%`));
  box.append(line, meter(used, cap, title, '%')); return box;
}
function formatTime(value) {
  return value ? new Date(value).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'}) : '尚未查询';
}
function resetLabel(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '未提供重置时间';
  const date = new Date(value), today = new Date();
  return `${date.toLocaleString('zh-CN', { ...(date.toDateString() === today.toDateString() ? {} : {month: '2-digit', day: '2-digit'}), hour: '2-digit', minute: '2-digit'})} 重置`;
}
function poolCard(pool) {
  const view = poolView(data, pool), gemini = pool.pool === 'gemini';
  const card = node('article', `pool-card${gemini ? '' : ' tp'}${view.fresh ? '' : ' is-stale'}`);
  const top = node('div', 'pool-card-top'), title = node('div', 'pool-title');
  title.append(node('h2', '', gemini ? 'Gemini' : 'Claude / GPT'));
  if (gemini) title.append(node('p', '', 'Carbon / Argon / Hydrogen / Flash / Orchestrator'));
  top.append(title, node('span', `availability${view.reason ? ' warning' : ''}`, view.label)); card.append(top);
  const five = view.windows.fiveHour, week = view.windows.week;
  const value = node('div', 'quota-value'), amount = node('div', 'quota-number');
  if (five.valid) { amount.textContent = number(five.fraction * 100); amount.append(node('span', '', '%')); }
  else amount.textContent = '—';
  const caption = node('div', 'quota-caption', '5 小时官方额度剩余');
  if (!five.valid) caption.append(node('small', '', five.fraction === null ? '尚未获得有效额度' : view.inGrace ? '15 分钟容错期内 · 沿用最近快照' : '最近快照已失效'));
  value.append(amount, caption); card.append(value);
  if (five.fraction !== null) card.append(meter(five.fraction * 100, 100, five.valid ? '5 小时官方剩余' : '上次快照剩余', '%'));
  const meta = node('div', 'pool-meta');
  meta.append(node('span', '', resetLabel(five.resetTime)), node('span', '', week.valid ? `本周还剩 ${number(week.fraction * 100)}%` : '每周额度未就绪'));
  card.append(meta);
  if (week.fraction !== null) { const progress = meter(week.fraction * 100, 100, week.valid ? '每周官方剩余' : '每周上次快照', '%'); progress.className = 'weekly-meter'; card.append(progress); }
  const points = node('div', `reconciled-points${view.reason ? ' warning' : ''}`);
  points.append(
    node('strong', '', `家庭池还可预留 ${number(view.remaining.fiveHour)}% / 5 小时`),
    node('small', '', `每周可用 ${number(view.remaining.week)}%${view.inGrace ? ' · 短暂离线容错中' : ''}${view.reason ? ` · ${view.reason}` : ''}`)
  );
  card.append(points); return card;
}
function calibrationView(pool) {
  const box = node('section', 'calibration'); box.append(node('h3', '', pool.pool === 'gemini' ? 'Gemini' : 'Claude / GPT'));
  box.append(windowView(pool.usage.fiveHour, pool.limits.fiveHour, '5 小时已用（含预留）'), windowView(pool.usage.week, pool.limits.week, '每周已用（含预留）'));
  const statuses = {collecting: '等待足够样本', learned: '区间已收紧', reset: '已跟随官方重置', gap: '观测中断，重新采样', replenished: '额度回升，重新采样', untracked: '已隔离未记账消耗', inflight: '含在途调用，持续累积', offline: '离线补记区间未用于校准', source_changed: '额度桶变化，重新采样', disabled: '自动校准已关闭'};
  for (const [key, label] of [['fiveHour', '5 小时'], ['week', '每周']]) {
    const b = pool.realBudget?.[key]; if (!b) continue;
    const upperPct = b.upperPercentPerUnit ?? b.percentPerPoint ?? 0;
    const lowerPct = b.lowerPercentPerUnit;
    const rangeText = lowerPct != null
      ? `[${lowerPct.toLocaleString('zh-CN', {maximumFractionDigits: 6})}%, ${upperPct.toLocaleString('zh-CN', {maximumFractionDigits: 6})}%]`
      : `≤ ${upperPct.toLocaleString('zh-CN', {maximumFractionDigits: 6})}%`;
    const line = node('div', 'calibration-window');
    line.append(node('p', '', `${label}：1 当量 ${rangeText}（安全上界 ${upperPct.toLocaleString('zh-CN', {maximumFractionDigits: 6})}%）`));
    const source = b.source === 'learned' ? `累积校准 · ${b.sampleCount} 个有效样本 · ${number(b.samplePoints)} 当量` : b.source === 'disabled' ? '自动校准已关闭 · 使用初始上界' : '初始保守上界';
    line.append(node('small', '', `${source}${b.updated_at ? ` · 更新于 ${formatTime(b.updated_at * 1000)}` : ''}`), node('small', '', `${statuses[b.status] || '等待样本'} · ${b.officialReset ? '官方' : '备用'}重置于 ${formatTime(b.reset_at * 1000)}`));
    box.append(line);
  }
  box.append(node('p', 'pool-foot', `家庭上限 ${number(pool.totalLimits.fiveHour)}% / ${number(pool.totalLimits.week)}%，安全缓冲 ${data.policy.buffer_percent}%。`)); return box;
}
function memberRow(member, home = false) {
  const row = node('article', 'member-row'), info = node('div', 'member-info'), text = node('div');
  text.append(node('div', 'member-name', member.name), node('div', `member-state${member.enabled ? '' : ' paused'}`, member.enabled ? '使用中' : '已暂停'));
  text.append(node('small', 'member-email', member.email || '未绑定邮箱 · 编辑后可登录'));
  info.append(node('div', 'avatar', [...member.name][0]), text); row.append(info);
  if (home && !member.enabled) row.append(node('div', 'member-paused-note', '已暂停新调用'));
  else for (const [key, label, prefix] of [['gemini', 'Gemini', 'gemini'], ['third_party', 'Claude / GPT', 'tp']]) {
    const window = home ? 'fiveHour' : memberWindow, limit = member[`${prefix}_${window === 'fiveHour' ? '5h' : 'wk'}_limit`];
    const usage = node('div', 'member-usage'); usage.append(node('span', '', label), node('strong', '', `${number(member.usage[key][window])}% / ${number(limit)}%`)); row.append(usage);
  }
  if (viewerRole === 'member') return row;
  const actions = node('div', 'member-actions'), edit = node('button', '', '›'); edit.type = 'button';
  edit.dataset.member = member.member_id; edit.setAttribute('aria-label', `编辑 ${member.name} 的限额`); edit.onclick = () => editMember(member); actions.append(edit); row.append(actions); return row;
}
function emptyMembers() {
  const empty = node('div', 'empty'); empty.append(node('strong', '', '把第一份额度，留给家里的人。'), node('p', '', '添加成员后，就能分配百分比额度并获取安装令牌。')); return empty;
}
function renderMembers() {
  const focused = document.activeElement?.dataset.member, inHome = !!document.activeElement?.closest('#home-members');
  $('#member-count').textContent = data.members.length || '';
  $('#home-members').replaceChildren(...(data.members.length ? data.members.slice(0, 4).map(m => memberRow(m, true)) : [emptyMembers()]));
  $('.all-members').hidden = data.members.length <= 4;
  $('#member-list').replaceChildren(...(data.members.length ? data.members.map(m => memberRow(m)) : [emptyMembers()]));
  if (focused) (inHome ? $('#home-members') : $('#member-list')).querySelector(`[data-member="${CSS.escape(focused)}"]`)?.focus({preventScroll: true});
}
const eventState = event => event.status === 'reserved' && event.expires_at <= Date.now() / 1000 ? 'expired' : event.status;
function formatTokens(value) {
  return value >= 1000 ? `${(value / 1000).toLocaleString('zh-CN', {maximumFractionDigits: 1})}k` : String(value);
}
function eventPercent(event, windowKey = 'fiveHour') {
  const explicit = windowKey === 'fiveHour' ? event.five_hour_percent : event.week_percent;
  if (explicit != null) return explicit;
  const poolObj = data?.pools?.find(p => p.pool === event.pool_group);
  const rb = poolObj?.realBudget?.[windowKey];
  const rate = rb?.upperPercentPerUnit ?? rb?.percentPerPoint ?? (windowKey === 'fiveHour' ? 0.4 : 0.05);
  return Math.round(Number(event.weight || 0) * rate * 1000) / 1000;
}
function eventDetail(event) {
  const pool = event.pool_group === 'gemini' ? 'Gemini' : 'Claude / GPT';
  const parts = [pool];
  if (event.input_tokens != null || event.output_tokens != null || event.cache_read_tokens != null) {
    parts.push(`输入 ${formatTokens(event.input_tokens || 0)}`);
    if (event.cache_read_tokens > 0) parts.push(`缓存 ${formatTokens(event.cache_read_tokens)}`);
    parts.push(`输出 ${formatTokens(event.output_tokens || 0)}`);
    if (event.tool_calls > 0) parts.push(`工具×${event.tool_calls}`);
  }
  parts.push(`${number(event.weight)} 当量`, `周 ${number(eventPercent(event, 'week'))}%`);
  return parts.join(' · ');
}
function renderEvents() {
  const search = $('#event-search').value.trim().toLocaleLowerCase(), status = $('#event-status').value;
  const events = data.events.filter(e => (!search || `${e.name} ${e.model_name}`.toLocaleLowerCase().includes(search)) && (!status || eventState(e) === status));
  const names = {committed: '已记账', reserved: '进行中', released: '已释放', expired: '预留已过期'};
  const rows = events.map(event => {
    const row = node('article', 'event-row'), who = node('div', 'event-person'), model = node('div', 'event-model'), state = eventState(event);
    who.append(node('strong', '', event.name), node('small', '', formatTime((event.committed_at || event.created_at) * 1000)));
    model.append(node('div', '', event.model_name), node('span', '', eventDetail(event)));
    row.append(who, model, node('div', 'event-points', `${number(eventPercent(event, 'fiveHour'))}%`), node('span', `state-tag ${state === 'expired' ? 'released' : state}`, names[state] || state)); return row;
  });
  if (!rows.length) {
    const empty = node('div', 'empty');
    if (data.events.length) {
      empty.append(node('strong', '', '没有匹配的记录'), node('p', '', '试试清空搜索词或切换状态筛选；筛选范围只包含最近 80 条记录。'));
    } else {
      empty.append(node('strong', '', '还没有收到使用记录'));
      empty.append(node('p', '', '流水由每台电脑上的本地守门员在调用前后上报，官方额度消耗不会自动变成记录。'));
      if (viewerRole === 'admin' && data.members?.length) empty.append(node('p', '', `已添加 ${data.members.length} 位成员，但服务端还没有收到任何门禁上报。`));
      const steps = node('ol', 'empty-steps');
      steps.append(
        node('li', '', '成员在「教程」生成安装令牌，重新运行安装 / 更新命令，并确认安装输出里有「Hook 自检通过」。'),
        node('li', '', '升级过系统、更换过 Node.js 路径后也要重新安装一次；完全重启 Antigravity 客户端，再调用一次模型。'),
        node('li', '', '回到本页点击右上角「刷新」。')
      );
      empty.append(steps);
      const link = node('a', 'subtle-link', '查看安装教程 →'); link.href = '#tutorial'; empty.append(link);
    }
    rows.push(empty);
  }
  $('#events').replaceChildren(...rows); $('#event-count').textContent = `显示 ${events.length} / ${data.events.length} 条已加载记录${search || status ? ' · 仅筛选最近 80 条' : ''}`;
}
function renderMother() {
  const area = $('#mother-account'), account = data.mother;
  $('#connect-mother').textContent = account ? '重新连接' : '登录母账号';
  if (!account) { area.replaceChildren(node('div', 'empty', '尚未登录母账号。母账号未连接时将暂停新调用，连接后即可同步官方剩余百分比。')); return; }
  const view = poolView(data, data.pools[0]), fresh = view.fresh;
  const card = node('div', 'account-card'), header = node('div', 'account-header'), identity = node('div');
  identity.append(node('strong', 'account-email', account.email), node('p', '', account.snapshot?.tier || '套餐信息待查询'));
  const state = account.status === 'auth_required' ? '授权已失效' : !view.graceValid ? '超过 15 分钟未同步' : account.status === 'error' ? '查询抖动 · 容错中' : !fresh ? '容错期内' : '已连接';
  header.append(identity, node('span', `account-state${fresh ? '' : ' warning'}`, state)); card.append(header);
  card.append(node('p', 'account-meta', `上次成功查询 ${formatTime(account.checked_at)} · 母账号实时把关（15 分钟容错）`));
  if (account.last_error) card.append(node('p', 'account-error', account.last_error));
  if (!fresh) card.append(node('p', 'account-error', view.graceValid ? '当前处于 15 分钟短暂抖动容错期，正结合安全上界沿用上次快照。' : '上次成功快照已超过 15 分钟或授权失效，新调用已暂停，请刷新或重新连接。'));
  const groups = node('div', 'official-groups');
  for (const group of account.snapshot?.groups || []) {
    const section = node('div', 'official-group'); section.append(node('h3', '', group.name));
    for (const bucket of group.buckets) {
      const box = node('div', 'official-bucket'), line = node('div', 'window-label'), percent = bucket.remaining_fraction * 100;
      const label = bucket.window === 'weekly' ? '每周' : bucket.window === '5h' ? '5 小时' : bucket.window;
      line.append(node('span', '', label), node('strong', percent <= 0 ? 'low-quota' : '', `${fresh ? '' : '上次快照 · '}剩余 ${number(percent)}%`));
      box.append(line, meter(percent, 100, '官方剩余额度', '%'), node('small', '', resetLabel(bucket.reset_time))); section.append(box);
    }
    groups.append(section);
  }
  card.append(groups);
  if (!groups.children.length) card.append(node('p', 'hint', '尚未获得有效额度，请刷新。未知额度不会显示为 0%。'));
  const actions = node('div', 'account-actions'), disconnect = node('button', 'text-button danger-text', '解除连接'); disconnect.type = 'button';
  disconnect.onclick = async () => {
    if (!await confirmAction({title: '解除母账号连接？', description: '解除后无法校验官方百分比余额，所有成员的新调用将暂停，直至重新连接母账号。', label: '解除连接', action: () => api('mother', 'DELETE')})) return;
    try { await refresh(false, true); toast('母账号已解除连接'); } catch (e) { toast(e.message); }
  };
  actions.append(disconnect); card.append(actions); area.replaceChildren(card);
}
function renderAvailability() {
  if (!data) return;
  const views = data.pools.map(p => poolView(data, p));
  $('#pools').replaceChildren(...data.pools.map(poolCard)); $('#pools').setAttribute('aria-busy', 'false');
  const notice = $('#notice'); notice.replaceChildren();
  const graceValid = views[0]?.graceValid;
  if (!data.mother || data.mother.status === 'auth_required' || !graceValid) {
    const msg = !data.mother
      ? '母账号尚未连接，无法校验真实余额，所有新调用已暂停。'
      : data.mother.status === 'auth_required'
        ? '母账号授权已失效，所有新调用已暂停，请重新连接。'
        : '官方额度已超过 15 分钟未同步，所有新调用已暂停，请检查连接或刷新。';
    notice.append(node('span', '', msg));
    if (viewerRole === 'admin') {
      const link = node('a', '', '前往连接母账号 →'); link.href = '#settings/account'; notice.append(link);
    }
    notice.hidden = false;
  } else {
    notice.hidden = true;
  }
  const fresh = views[0]?.fresh;
  $('#updated').textContent = data.mother?.checked_at ? `成功查询 ${new Date(data.mother.checked_at).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'})}` : '尚未查询官方额度';
  $('#connection-status').textContent = !data.mother ? '母账号尚未连接' : fresh ? '母账号实时在线' : graceValid ? '母账号容错运行中' : '母账号需要重连';
  $('#connection-status').className = fresh ? 'connected' : '';
  $('#guard-status').textContent = '百分比限额 + 母账号真实余额把关';
  availabilitySignature = JSON.stringify(views.map(v => [v.fresh, v.graceValid, v.reason, v.windows.fiveHour.valid, v.windows.week.valid]));
}
function loadPolicy() {
  if (!data) return;
  const form = $('#policy-form');
  for (const [key, value] of Object.entries(data.policy)) if (form.elements[key]) {
    if (form.elements[key].type === 'checkbox') form.elements[key].checked = !!value;
    else form.elements[key].value = value;
  }
  form.dataset.dirty = ''; $('#save-status').textContent = '设置已同步'; form.querySelector('.form-error').textContent = '';
  policyLoaded = true; policyExamples();
}
function render() {
  document.body.dataset.auth = 'ready';
  document.body.dataset.role = viewerRole;
  const email = viewerEmail || data.mother?.email || '家庭账号';
  $('#account-initial').textContent = email[0].toUpperCase();
  $('#account-label').textContent = email;
  $('#members-nav').textContent = viewerRole === 'member' ? '我的额度' : '成员';
  $('#members-title').textContent = viewerRole === 'member' ? '我的额度' : '一起使用的人';
  $('#members-title').nextElementSibling.textContent = viewerRole === 'member' ? '查看自己的百分比上限与本期用量。' : '手动填写称呼和 Google 邮箱，按百分比为每个人分配额度。';
  $('#home-members-title').firstChild.textContent = viewerRole === 'member' ? '我的使用情况 ' : '一起使用的人 ';
  $('#tutorial-identity').textContent = viewerRole === 'member' ? `当前登录：${viewerEmail}` : '管理员绑定邮箱后，成员即可自行登录。';
  renderAvailability(); if(viewerRole === 'admin') renderMother(); renderMembers(); renderEvents();
  $('#quota-breakdown').replaceChildren(...data.pools.map(calibrationView));
  if (!policyLoaded || !$('#policy-form').dataset.dirty) loadPolicy();
  route(false);
}
async function refresh(query = false, afterWrite = false) {
  if (refreshTask) {
    if (!afterWrite) return refreshTask;
    try { await refreshTask; } catch { /* A completed write still needs a new snapshot. */ }
  }
  $('#refresh').disabled = true; $('#refresh').setAttribute('aria-busy', 'true');
  refreshTask = (async () => {
    let queryError;
    if (query && viewerRole === 'admin') { try { await api('mother/refresh', 'POST'); } catch (error) { if (error.status === 401) throw error; queryError = error; } }
    data = await api('overview'); render();
    if (queryError) toast(queryError.message);
  })();
  try { await refreshTask; } finally { refreshTask = null; $('#refresh').disabled = false; $('#refresh').removeAttribute('aria-busy'); }
}
function settingsTab(tab, focus = false) {
  if (!['budget', 'account', 'advanced'].includes(tab)) tab = 'budget';
  document.querySelectorAll('[data-settings-tab]').forEach(button => {
    const selected = button.dataset.settingsTab === tab;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    $(`#settings-${button.dataset.settingsTab}`).hidden = !selected;
    if (selected && focus) button.focus();
  });
}
function route(focus = true) {
  const [candidate, tab] = location.hash.slice(1).split('/');
  const requested = ['overview', 'members', 'activity', 'settings', 'tutorial'].includes(candidate) ? candidate : 'overview';
  const page = requested === 'settings' && viewerRole === 'member' ? 'tutorial' : requested;
  document.querySelectorAll('main>.page').forEach(section => section.hidden = section.id !== page);
  document.querySelectorAll('.main-nav a, #settings-top').forEach(link => {
    if (link.hash === `#${page}`) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  $('.account-menu').open = false;
  if (page === 'settings') { if (!policyLoaded && data) loadPolicy(); if (tab) settingsTab(tab); }
  if (focus && data) { document.querySelector(`#${page} h1`).focus({preventScroll: true}); window.scrollTo(0, 0); }
}
function editMember(member) {
  if (viewerRole !== 'admin') return;
  if (!data) return showLogin();
  const form = $('#member-form'); form.reset(); form.querySelector('.form-error').textContent = '';
  form.elements.member_id.value = member?.member_id || ''; form.elements.name.value = member?.name || '';
  form.elements.email.value = member?.email || '';
  limitKeys.forEach(key => { if (member) form.elements[key].value = member[key]; });
  form.elements.enabled.checked = member ? !!member.enabled : true;
  $('#enabled-label').hidden = !member; $('#member-token-options').hidden = !member; $('#member-token-options').open = false;
  $('#delete-member').hidden = !member;
  if (member) syncMemberShare();
  else { $('#member-share').value = 25; applyMemberShare(); }
  $('#member-title').textContent = member ? '调整这份额度' : '添加成员'; $('#member-dialog').showModal();
  $('.member-form-body').scrollTop = 0;
}
function shareLimits(share) {
  return Object.fromEntries(data.pools.flatMap(pool => {
    const prefix = pool.pool === 'gemini' ? 'gemini' : 'tp';
    return [[`${prefix}_5h_limit`, Math.round(pool.limits.fiveHour * share) / 100],
      [`${prefix}_wk_limit`, Math.round(pool.limits.week * share) / 100]];
  }));
}
function showMemberShare(custom = false) {
  const slider = $('#member-share');
  $('#member-share-value').value = custom ? '自定义' : `${slider.value}%`;
  slider.setAttribute('aria-valuetext', custom ? `${slider.value}%，当前百分比已自定义` : `${slider.value}%`);
  $('#member-share-hint').textContent = custom ? '当前为单独微调的百分比；拖动滑条可重新按比例速算。' : '按家庭可分配比例（已扣除缓冲）同步换算，也可在下方单独微调百分比。';
}
function applyMemberShare() {
  const form = $('#member-form'), values = shareLimits(Number($('#member-share').value));
  limitKeys.forEach(key => { form.elements[key].value = values[key]; });
  showMemberShare();
}
function syncMemberShare() {
  const form = $('#member-form');
  const share = Array.from({length: 101}, (_, i) => i).find(value => {
    const values = shareLimits(value);
    return limitKeys.every(key => form.elements[key].value !== '' && Math.abs(Number(form.elements[key].value) - values[key]) < 1e-6);
  });
  if (share !== undefined) $('#member-share').value = share;
  else {
    const base = shareLimits(100), key = limitKeys.find(key => base[key] > 0 && form.elements[key].value !== '');
    $('#member-share').value = key ? Math.max(0, Math.min(100, Math.round(Number(form.elements[key].value) / base[key] * 100))) : 0;
  }
  showMemberShare(share === undefined);
}
// No single download command works in every shell: Windows PowerShell 5.1 aliases
// `curl` to Invoke-WebRequest, while macOS/Linux have no `curl.exe` and cmd/PowerShell
// do not understand POSIX single quotes or /tmp. Emit one explicit command per OS.
// Two separate lines (no &&): Windows PowerShell 5.1 does not support &&.
function currentInstallOS() {
  return /win/i.test(navigator.platform || navigator.userAgent || '') ? 'windows' : 'posix';
}
function installProxy() {
  const raw = (document.querySelector('[data-install-proxy]')?.value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return '';
    return url.origin;
  } catch {
    return '';
  }
}
function installCommand(os = currentInstallOS(), extra = '') {
  const win = os === 'windows';
  const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
  // An origin is scheme://host[:port] - no shell metacharacters. Leave it bare on
  // Windows: cmd /C strips the outer quotes from a spawned command line and can
  // leave a trailing quote attached to the URL, which curl rejects as a bad port.
  const bare = s => s;
  const q = win ? bare : quote;
  const file = win ? 'agy-quota-install.mjs' : '/tmp/agy-quota-install.mjs';
  const curl = win ? 'curl.exe' : 'curl';
  const proxy = installProxy();
  return `${curl} -fsS ${q(location.origin + '/client/install.mjs')} -o ${win ? file : quote(file)}\n` +
    `node ${win ? file : quote(file)} --url ${q(location.origin)}${extra ? ' ' + extra : ''}${proxy ? ` --proxy ${q(proxy)}` : ''}`;
}
function renderInstallCommands() {
  const os = document.querySelector('[data-install-os]')?.value || currentInstallOS();
  document.querySelectorAll('[data-install-os]').forEach(select => { select.value = os; });
  const value = installCommand(os);
  $('#install-command').textContent = value;
  $('#tutorial-command').textContent = value;
  $('#upgrade-command').textContent = installCommand(os, '--upgrade');
}
function installationPrompt(token = '【复制时会自动填入你的成员令牌】') {
  const proxy = installProxy();
  return `请直接在我当前这台电脑上安装 AGY 家庭配额门禁，并完成配置检查。请实际执行，不要只给我一份操作教程。目标是我日常运行 Antigravity 的本机；如果你只能访问云端沙箱或容器，无法操作我的电脑，请说明这个限制，不要在远程环境安装后宣称本机已经完成。

服务地址：${location.origin}
成员令牌：${token}
本机代理（可选）：${proxy || '不使用'}

这份令牌用于把本机调用记入我的个人额度。请只在本机安装过程中使用它，不要在命令行参数、终端输出、日志或最后的回复中回显令牌。

请依次完成：
1. 检查当前系统和 Node.js。安装器支持 macOS / Linux / Windows，需要 Node.js 20+。按目标系统选择 shell：macOS / Linux 用终端（sh/bash/zsh），Windows 用 cmd 或 PowerShell；命令中的引号风格要与之匹配，Windows 请用双引号，不要照搬单引号写法。缺少依赖时按本机环境处理；如果当前工具无法执行命令，或系统不支持，请明确告诉我卡在哪里，不要声称已经安装。
2. 新建独立临时目录（macOS / Linux 可用 mktemp -d 并设为 0700；Windows 可在 %TEMP% 下新建目录，chmod 相关权限在 Windows 忽略），下载 ${location.origin}/client/install.mjs 到该目录并检查脚本。将上面的成员令牌写入同一目录内的临时文件（类 Unix 设为 0600），通过 --token-file 传入，避免交互输入和把令牌放进命令行。
3. 使用真实用户的主目录执行安装器，命令结构为：node <临时目录>/install.mjs --url <服务地址> --token-file <临时令牌文件>${proxy ? ` --proxy ${proxy}` : ''}。请用本机 shell 正确引用实际路径，不要原样执行尖括号占位符，也不要安装到临时 HOME。安装器会合并已有 Hooks、备份原配置，设置 CLI useG1Credits=false，并实际试跑一次 Hook 做自检；只有看到「Hook 自检通过」才算安装成功，自检失败要停下来并把报错原样告诉我。若已有门禁，以本次提供的地址和令牌更新；保留其他 Hooks 和用户设置，遇到无效 JSON 应停止并说明问题。
4. 检查 ~/.gemini/config/hooks.json 中 family-quota-guard 已启用，PreInvocation、PostInvocation、Stop 分别连接 check、commit、release；检查 agy-quota.mjs 存在（Windows 还应有同目录的 run.cmd 启动器）、凭据权限为 0600（Windows 忽略）、CLI useG1Credits 为 false。门禁单次主请求时限必须为 10 秒，所有主请求尝试共用 16 秒网络预算，后续尝试按剩余时间缩短；临时网络错误、HTTP 408/429/5xx 最多重试 2 次（总共最多 3 次尝试），使用指数退避与随机抖动，并遵守 Retry-After；鉴权失败、参数错误和额度不足不重试。脚本总时限为 16.5 秒，三类 Hooks 的外层 timeout 均为 18 秒，避免外层提前杀死进程；如已有本机配置不同，备份后调整，并保留超时暂停新调用的行为。读取凭据时只在内存核对地址和令牌，不要打印文件内容。请求 ${location.origin}/health 确认服务连通性；这只能验证服务可达，不代表令牌或实际调用已验收。完成后删除临时令牌文件。
5. 如果你能操作 Antigravity 桌面端 / IDE 设置，将 AI Credit Overages 设为 Never；无法操作时，明确告诉我这个设置需要在哪里完成。不要自动结束我正在运行的会话。

最后用简短中文告诉我：实际安装了什么、哪些检查通过、哪些还未完成，以及是否需要我重启 Antigravity。重启后我会用自己的 Google 账号调用一次模型，再在 ${location.origin}/#activity 查看记录。不要把静态配置检查说成实际调用验证，不要为验证而改动家庭额度或制造虚假账单。`;
}
function clearPromptFallbacks() {
  for(const id of ['install-prompt-fallback','token-prompt-fallback']) {$('#'+id).value='';$('#'+id).hidden=true;}
}
async function copyInstallationPrompt(input, fallback) {
  if(!/^agy_[a-f0-9]{64}$/.test(input.value.trim())) {
    input.setCustomValidity('请先粘贴有效的成员令牌，或生成新令牌后再复制');
    input.reportValidity();input.focus();return;
  }
  input.setCustomValidity('');
  const prompt=installationPrompt(input.value.trim());
  try {await navigator.clipboard.writeText(prompt);toast('安装提示词已复制，发给自己的 AI 即可');}
  catch {fallback.value=prompt;fallback.hidden=false;fallback.focus();fallback.select();toast('无法自动复制，已选中完整提示词，请手动复制');}
}
function showToken(result) {
  clearPromptFallbacks();
  $('#generated-token').value=result.token;$('#installation-token').value=result.token;$('#installation-token').setCustomValidity('');
  renderInstallCommands();$('#token-dialog').showModal();
}
function numericForm(form,fields) {return Object.fromEntries(fields.map(k=>[k,Number(form.elements[k].value)]));}
async function saveForm(form,fn) {const buttons=form.querySelectorAll('button.primary, #delete-member'),err=form.querySelector('.form-error');buttons.forEach(btn=>btn.disabled=true);err.textContent='';try{await fn();}catch(e){err.textContent=e.message;}finally{buttons.forEach(btn=>btn.disabled=false);}}
$('#login-form').onsubmit=async e=>{e.preventDefault();viewerRole='admin';viewerEmail='';adminToken=$('#admin-token').value.trim();const btn=$('#login-form button');btn.disabled=true;try{await refresh(true);$('#login-dialog').close();$('#admin-token').value='';$('#login-error').textContent='';}catch(err){$('#login-error').textContent=err.message;}finally{btn.disabled=false;}};
$('#login-dialog').addEventListener('cancel',e=>e.preventDefault());
document.querySelectorAll('[data-add-member]').forEach(button => button.onclick = () => editMember());
$('#add-member').onclick=()=>{if(!data)return $('#login-dialog').showModal();editMember();};
$('#refresh').onclick=()=>{if(!data)return $('#login-dialog').showModal();refresh(true).catch(e=>toast(e.message));};
$('#logout').onclick=async()=>{try{await authApi('logout',{});adminToken='';data=null;location.reload();}catch(e){toast(e.message);}};
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$('#'+b.dataset.close).close());
$('#member-share').addEventListener('input', applyMemberShare);
limitKeys.forEach(key => $('#member-form').elements[key].addEventListener('input', syncMemberShare));
$('#delete-member').onclick = async () => {
  const form = $('#member-form'), id = form.elements.member_id.value;
  const member = data?.members.find(item => item.member_id === id);
  if (!member || !await confirmAction({title: `删除成员「${member.name}」？`, description: '删除后，该成员无法再发起新调用。历史记录和已用额度会保留，进行中调用仍可完成记账。', label: '删除成员', action: () => api(`members/${id}`, 'DELETE')})) return;
  $('#member-dialog').close();
  try { await refresh(false, true); toast('成员已删除'); }
  catch (error) { toast(error.message); }
};
$('#member-form').onsubmit=e=>{e.preventDefault();const f=e.currentTarget;saveForm(f,async()=>{const id=f.elements.member_id.value;const b={name:f.elements.name.value,email:f.elements.email.value.trim(),...numericForm(f,limitKeys),...(id?{enabled:f.elements.enabled.checked?1:0}:{})};const res=await api(id?`members/${id}`:'members',id?'PATCH':'POST',b);$('#member-dialog').close();if(!id)showToken(res);await refresh(false, true);toast('成员已保存');});};
function policyExamples(){
  const f=$('#policy-form');
  const fields=[...limitKeys,'buffer_percent','flash_weight','gemini_weight','tp_weight','opus_weight'];
  if(fields.some(k=>f.elements[k].value===''||!f.elements[k].validity.valid)){$('#policy-examples').textContent='填完有效数值后，这里会显示可分配百分比与估算调用轮数。';return;}
  const values=numericForm(f,fields),factor=(100-values.buffer_percent)/100;
  const lines=[['Gemini','gemini',values.flash_weight,'Flash',values.gemini_weight,'其他 Gemini'],['第三方','tp',values.tp_weight,'Claude / GPT',values.opus_weight,'Opus']].map(([name,prefix,light,lightName,heavy,heavyName])=>{
    const poolObj = data?.pools?.find(p => (p.pool === 'gemini' ? 'gemini' : 'tp') === prefix);
    const k5 = poolObj?.realBudget?.fiveHour?.upperPercentPerUnit ?? poolObj?.realBudget?.fiveHour?.percentPerPoint ?? 0.4;
    const full=values[`${prefix}_5h_limit`],cap=Math.round(full*factor*100)/100,week=Math.round(values[`${prefix}_wk_limit`]*factor*100)/100;
    const lightCalls = Math.floor(cap / Math.max(light * k5, 1e-6)), heavyCalls = Math.floor(cap / Math.max(heavy * k5, 1e-6));
    return node('p','',`${name}：5 小时 ${number(full)}% × ${100-values.buffer_percent}% = ${number(cap)}%，每周 ${number(week)}%。按安全上界（1 当量 ≈ ${number(k5)}%），5 小时常规单轮只用 ${lightName} 约 ${lightCalls} 次，只用 ${heavyName} 约 ${heavyCalls} 次。`);
  });
  $('#policy-examples').replaceChildren(...lines);
}
$('#policy-form').addEventListener('input', () => {
  $('#policy-form').dataset.dirty = 'true'; $('#save-status').textContent = '有尚未保存的修改'; policyExamples();
});
$('#policy-form').addEventListener('invalid', event => {
  const panel = event.target.closest('[role=tabpanel]');
  if (panel) settingsTab(panel.id.replace('settings-', ''));
}, true);
$('#reset-policy').onclick = loadPolicy;
$('#policy-form').onsubmit = event => {
  event.preventDefault(); const form = event.currentTarget;
  saveForm(form, async () => {
    await api('policy', 'PATCH', {...numericForm(form, [...limitKeys, 'buffer_percent', 'reservation_seconds', 'flash_weight', 'gemini_weight', 'tp_weight', 'opus_weight']), calibration_enabled: form.elements.calibration_enabled.checked ? 1 : 0});
    form.dataset.dirty = ''; await refresh(false, true); toast('家里的配额设置已保存');
  });
};
document.querySelectorAll('[data-settings-tab]').forEach(button => {
  button.onclick = () => settingsTab(button.dataset.settingsTab);
  button.onkeydown = event => {
    const tabs = [...document.querySelectorAll('[data-settings-tab]')], index = tabs.indexOf(button);
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (delta || event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + delta + tabs.length) % tabs.length;
      settingsTab(tabs[next].dataset.settingsTab, true);
    }
  };
});
document.querySelectorAll('[data-member-window]').forEach(button => button.onclick = () => {
  memberWindow = button.dataset.memberWindow;
  document.querySelectorAll('[data-member-window]').forEach(other => { const selected = other === button; other.classList.toggle('selected', selected); other.setAttribute('aria-pressed', String(selected)); });
  if (data) renderMembers();
});
$('#event-search').oninput = () => { if (data) renderEvents(); };
$('#event-status').onchange = () => { if (data) renderEvents(); };
$('#rotate-member-token').onclick = async () => {
  const id = $('#member-form').elements.member_id.value, member = data?.members.find(m => m.member_id === id);
  let result;
  if (!member || !await confirmAction({title: `重置「${member.name}」的令牌？`, description: '旧令牌将立即失效，该成员需要使用新令牌重新安装。请先等待进行中调用完成。', label: '重置令牌', action: async () => { result = await api(`members/${id}/rotate-token`, 'POST'); }})) return;
  $('#member-dialog').close(); showToken(result);
};
window.addEventListener('hashchange', () => route());
document.addEventListener('click', event => { if (!event.target.closest('.account-menu')) $('.account-menu').open = false; });
$('#copy-token').onclick=()=>navigator.clipboard.writeText($('#generated-token').value).then(()=>toast('令牌已复制')).catch(()=>toast('无法自动复制，请选中令牌手动复制'));
$('#copy-install').onclick=()=>navigator.clipboard.writeText($('#install-command').textContent).then(()=>toast('安装命令已复制')).catch(()=>toast('无法自动复制，请手动复制命令'));
$('#token-dialog').addEventListener('close',()=>{$('#generated-token').value='';$('#token-prompt-fallback').value='';$('#token-prompt-fallback').hidden=true;});
$('#copy-upgrade').onclick=()=>navigator.clipboard.writeText($('#upgrade-command').textContent).then(()=>toast('更新命令已复制')).catch(()=>toast('无法自动复制，请手动复制命令'));
function showOAuth(result,mode) {
  oauthMode=mode;
  $('#callback-url').value='';
  $('#oauth-title').textContent = mode === 'mother' ? '登录母账号' : '登录 Google 账号';
  $('#oauth-description').textContent='在 Google 页面选择母账号或管理员已绑定的成员邮箱，完成授权后回到这里。成员登录不会替换母账号。';
  $('#mother-form button.primary').textContent='完成登录';
  if(!result.manual_callback){location.assign(result.url);return;}
  $('#google-auth-link').href=result.url;
  $('#oauth-hint').textContent=result.redirect_uri.startsWith('http://localhost:')||result.redirect_uri.startsWith('http://127.0.0.1:')?'授权后浏览器会跳转到 localhost，页面无法打开是正常现象。复制地址栏里的完整地址，回到这里粘贴即可完成登录。':'授权后复制浏览器跳转后的完整地址，回到这里粘贴即可完成登录。';
  $('#mother-form .form-error').textContent='';$('#login-dialog').close();$('#mother-dialog').showModal();
}
$('#google-login').onclick=async()=>{const button=$('#google-login');button.disabled=true;$('#google-login-error').textContent='';try{showOAuth(await authApi('google/start',{}),'login');}catch(e){$('#google-login-error').textContent=e.message;}finally{button.disabled=false;}};
$('#connect-mother').onclick=async()=>{if(!data)return $('#login-dialog').showModal();const button=$('#connect-mother');button.disabled=true;try{showOAuth(await api('mother/login','POST'),'mother');}catch(e){toast(e.message);}finally{button.disabled=false;}};
$('#mother-form').onsubmit=e=>{e.preventDefault();saveForm(e.currentTarget,async()=>{
  const body={callback_url:$('#callback-url').value.trim()};
  if(oauthMode==='login')await authApi('google/finish',body);else await api('mother/callback','POST',body);
  adminToken='';$('#admin-token').value='';const status=await authApi('status');viewerRole=status.role||'admin';viewerEmail=status.email||'';
  await refresh(false,true);$('#mother-dialog').close();if(viewerRole==='member')location.hash='tutorial';
  toast(viewerRole==='member'?'已登录，可以查看自己的额度并安装门禁':'母账号已登录，可查看官方额度');
});};
$('#mother-dialog').addEventListener('close',()=>{$('#callback-url').value='';$('#google-auth-link').removeAttribute('href');if(!data)$('#login-dialog').showModal();});
$('#upgrade-client').onclick=()=>{renderInstallCommands();$('#upgrade-dialog').showModal();};
setInterval(() => { if (data && !document.hidden) refresh().catch(error => toast(error.message)); }, 30000);
setInterval(() => {
  if (!data || document.hidden) return;
  const signature = JSON.stringify(data.pools.map(pool => { const view = poolView(data, pool); return [view.fresh, view.graceValid, view.reason, view.windows.fiveHour.valid, view.windows.week.valid]; }));
  if (signature !== availabilitySignature) { renderAvailability(); if(viewerRole === 'admin') renderMother(); }
  if (!$('#activity').hidden) renderEvents();
}, 5000);
document.addEventListener('visibilitychange', () => { if (data && !document.hidden) { renderAvailability(); refresh().catch(error => toast(error.message)); } });
async function initialize() {
  const loginFailed=new URLSearchParams(location.search).has('login_error');
  if(loginFailed){history.replaceState(null,'',location.pathname);$('#google-login-error').textContent='Google 登录未完成，请重新登录并选择母账号或已绑定的成员邮箱。';}
  try {
    const status=await authApi('status');
    $('#google-login').disabled=!status.google_login_available;
    $('#google-login-hint').textContent=status.google_login_available?'母账号和已绑定邮箱的成员均可使用 Google 登录。':'尚未指定母账号。请先配置管理员邮箱，或使用备用令牌连接一次母账号。';
    $('#token-login').open=!status.google_login_available;
    viewerRole=status.role||'admin';viewerEmail=status.email||'';
    if(status.authenticated){await refresh();if(loginFailed)toast('Google 授权未完成，请重新连接母账号。');return;}
  }catch(e){$('#google-login-error').textContent=e.message;}
  document.body.dataset.auth = 'guest';
  $('#login-dialog').showModal();
}
document.querySelectorAll('[data-install-os]').forEach(select=>{select.onchange=renderInstallCommands;});
{
  const inputs=[...document.querySelectorAll('[data-install-proxy]')];
  let stored='';try{stored=localStorage.getItem('agy-install-proxy')||'';}catch{}
  for(const input of inputs){
    input.value=stored;
    input.setAttribute('aria-invalid',String(!!stored.trim()&&!installProxy()));
    input.oninput=()=>{
      const raw=input.value.trim();
      for(const other of inputs){if(other!==input)other.value=input.value;other.setAttribute('aria-invalid',String(!!raw&&!installProxy()));}
      try{raw?localStorage.setItem('agy-install-proxy',raw):localStorage.removeItem('agy-install-proxy');}catch{}
      renderInstallCommands();
    };
  }
}
renderInstallCommands();
$('#installation-prompt').textContent=installationPrompt();
$('#installation-token').addEventListener('input',()=>{$('#installation-token').setCustomValidity('');clearPromptFallbacks();});
$('#copy-install-prompt').onclick=()=>copyInstallationPrompt($('#installation-token'),$('#install-prompt-fallback'));
$('#copy-token-prompt').onclick=()=>copyInstallationPrompt($('#generated-token'),$('#token-prompt-fallback'));
$('#copy-tutorial-install').onclick=()=>navigator.clipboard.writeText(installCommand()).then(()=>toast('安装命令已复制')).catch(()=>toast('无法自动复制，请选中命令手动复制'));
$('#token-tutorial').onclick=()=>$('#token-dialog').close();
$('#self-install-token').onclick=async()=>{
  let result;
  if(viewerRole!=='member'||!await confirmAction({title:'生成新的安装令牌？',description:'旧令牌将立即失效。请先等待进行中调用完成，并在所有使用你这份额度的电脑上用新令牌重新安装。',label:'生成新令牌',action:async()=>{result=await api('rotate-token','POST',{});}}))return;
  showToken(result);
};
route(false);
initialize();
