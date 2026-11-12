"""Deterministic local browser acceptance; API fixtures never mutate the local or production database."""
import copy
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
out = root / 'output' / 'playwright' / 'member-dialogs'
out.mkdir(parents=True, exist_ok=True)
now = datetime.now(timezone.utc)
policy = dict(gemini_5h_limit=100, gemini_wk_limit=100, tp_5h_limit=100, tp_wk_limit=100,
              buffer_percent=0, flash_weight=1, gemini_weight=3, tp_weight=3, opus_weight=8,
              calibration_enabled=1, real_quota_guard=1, real_quota_floor=0, reservation_seconds=900)

def bucket(window, fraction):
    return dict(id=window, window=window, remaining_fraction=fraction,
                reset_time=(now + timedelta(hours=2 if window == '5h' else 72)).isoformat())

def member(id, name, enabled, limits, usage):
    return dict(member_id=id, name=name, email=id+'@gmail.com', enabled=enabled, created_at=1,
                **dict(zip(['gemini_5h_limit', 'gemini_wk_limit', 'tp_5h_limit', 'tp_wk_limit'], limits)),
                usage=dict(gemini=dict(fiveHour=usage[0], week=usage[1]), third_party=dict(fiveHour=usage[2], week=usage[3])))

def budget(official_pct, remaining_pct, lower_pct, upper_pct):
    return dict(officialPercent=official_pct, remainingPercent=remaining_pct, remaining=remaining_pct,
                fresh=True, graceValid=True, stale=False,
                lowerPercentPerUnit=lower_pct, percentPerPoint=(lower_pct + upper_pct) / 2, upperPercentPerUnit=upper_pct,
                source='learned', sampleCount=6, samplePoints=120, updated_at=int(now.timestamp()),
                status='learned', officialReset=True, reset_at=int((now + timedelta(hours=2)).timestamp()))

state = dict(policy=policy, now=int(now.timestamp()),
    mother=dict(email='family@example.com', status='connected', checked_at=int(now.timestamp()*1000), stale=False, grace_expired=False,
                last_error=None, snapshot=dict(tier='Google AI Pro', groups=[
                    dict(name='Gemini', buckets=[bucket('5h', .68), bucket('weekly', .72)]),
                    dict(name='Claude / GPT', buckets=[bucket('5h', .44), bucket('weekly', .78)])])),
    pools=[dict(pool='gemini', usage=dict(fiveHour=12, week=16), limits=dict(fiveHour=100, week=100),
                totalLimits=dict(fiveHour=100, week=100), realBudget=dict(fiveHour=budget(68, 67.2, .35, .4), week=budget(72, 71.9, .04, .05))),
           dict(pool='third_party', usage=dict(fiveHour=32, week=26), limits=dict(fiveHour=100, week=100),
                totalLimits=dict(fiveHour=100, week=100), realBudget=dict(fiveHour=budget(44, 42.4, .35, .4), week=budget(78, 77.8, .04, .05)))],
    members=[member('lin', '小林', 1, [50,50,50,50], [7.2,9,12,11]),
             member('yuan', '阿远', 1, [25,25,25,25], [4.8,7,20,15]),
             member('he', '小禾', 0, [15,15,15,15], [0,0,0,0])],
    events=[dict(id=i, member_id='lin', name='小林', model_name=model, pool_group=pool, weight=weight,
                 five_hour_percent=round(weight * 0.4, 3), week_percent=round(weight * 0.05, 3),
                 status=status, created_at=int(now.timestamp())-i*60, committed_at=None,
                 expires_at=int(now.timestamp())+(900 if status != 'expired' else -1))
            for i,(model,pool,weight,status) in enumerate([
                ('Gemini Flash','gemini',1,'committed'),('Claude Opus','third_party',8,'reserved'),
                ('Claude','third_party',3,'released'),('Gemini Pro','gemini',3,'expired')],1)])
state['events'][-1]['status'] = 'reserved'
original = copy.deepcopy(state)
requests = []
hold_deletion = False
pending_deletions = []

def backend(route):
    path = route.request.url.split('/api/admin/',1)[1]
    assert not (path == 'family' or path.startswith('family/')), 'Manual member management must not request Google family lookup or consent'
    method = route.request.method
    body = route.request.post_data_json if method in ['POST','PATCH'] and route.request.post_data else None
    requests.append((method,path,body))
    if path == 'overview':
        route.fulfill(json=state)
    elif path == 'mother/refresh':
        route.fulfill(json=dict(account=state['mother']))
    elif path == 'mother/login':
        route.fulfill(json=dict(url='https://accounts.google.com/o/oauth2/v2/auth?code_challenge_method=S256',
                                manual_callback=True, redirect_uri='http://localhost:50987/oauth-callback'))
    elif path == 'mother' and method == 'DELETE':
        state['mother'] = None
        route.fulfill(json=dict(ok=True))
    elif path == 'policy':
        assert all(isinstance(value, (int, float)) for value in body.values())
        state['policy'].update(body)
        for pool in state['pools']:
            prefix = 'gemini' if pool['pool']=='gemini' else 'tp'
            pool['totalLimits'] = dict(fiveHour=body[prefix+'_5h_limit'],week=body[prefix+'_wk_limit'])
            pool['limits'] = {key: round(value*(100-body['buffer_percent'])/100, 3) for key,value in pool['totalLimits'].items()}
        route.fulfill(json=dict(ok=True))
    elif path == 'members':
        new = member('new-person', body['name'], 1,
                     [body[k] for k in ['gemini_5h_limit','gemini_wk_limit','tp_5h_limit','tp_wk_limit']], [0,0,0,0])
        state['members'].append(new)
        route.fulfill(status=201,json=dict(member_id=new['member_id'],name=new['name'],token='agy_'+'a'*64))
    elif path.endswith('/rotate-token'):
        route.fulfill(json=dict(token='agy_'+'b'*64))
    elif path.startswith('members/'):
        if method == 'DELETE':
            if hold_deletion:
                pending_deletions.append(route)
                return
            state['members'] = [m for m in state['members'] if m['member_id'] != path.split('/')[1]]
        else:
            next(m for m in state['members'] if m['member_id']==path.split('/')[1]).update(body)
        route.fulfill(json=dict(ok=True))
    else:
        route.fulfill(status=404,json=dict(error='Unexpected fixture request: '+path))

with sync_playwright() as p:
    executable = os.environ.get('PLAYWRIGHT_EXECUTABLE_PATH')
    browser = p.chromium.launch(headless=True, **({'executable_path':executable} if executable else {}))
    # Test-only styles suppress animation/toasts for deterministic screenshots.
    context = browser.new_context(viewport=dict(width=1440,height=900), bypass_csp=True)
    page = context.new_page()
    errors=[]
    page.on('pageerror',lambda error: errors.append(str(error)))
    def native_dialog(dialog):
        errors.append('Unexpected browser dialog: '+dialog.message)
        dialog.dismiss()
    page.on('dialog', native_dialog)
    page.route('**/api/auth/status', lambda route: route.fulfill(json=dict(authenticated=False,google_login_available=True)))
    page.route('**/api/admin/**', backend)
    page.goto('http://127.0.0.1:8787',wait_until='networkidle')
    page.add_style_tag(content='#toast{display:none!important}.page{animation:none!important}')
    expect(page.locator('#google-login')).to_be_enabled()
    page.screenshot(path=str(out/'login-desktop.png'),full_page=True,animations='disabled',style='#toast { visibility: hidden !important; }')
    page.locator('#token-login summary').click()
    page.locator('#admin-token').fill('local-browser-fixture-token-'+'x'*32)
    page.locator('#login-form button').click()
    expect(page.locator('#login-dialog')).not_to_be_visible()
    expect(page.locator('.quota-number').first).to_have_text('68%')
    expect(page.locator('.reconciled-points').first).to_contain_text('67.2%')
    expect(page.locator('#quota-breakdown')).not_to_be_visible()
    page.screenshot(path=str(out/'home-desktop.png'),full_page=True,animations='disabled',style='#toast { visibility: hidden !important; }')
    page.locator('#quota-details summary').click()
    expect(page.locator('.calibration').first).to_contain_text('安全上界 0.4%')
    expect(page.locator('.calibration').first).to_contain_text('6 个有效样本')
    page.locator('#quota-details summary').click()

    page.locator('#add-member').click()
    page.locator('#member-form input[name=name]').fill('新成员')
    page.locator('#member-form input[name=email]').fill('new-member@gmail.com')
    expect(page.locator('#delete-member')).not_to_be_visible()
    slider = page.get_by_role('slider',name='按比例速算')
    expect(slider).to_have_value('25')
    slider.focus()
    page.keyboard.press('ArrowRight')
    expect(page.locator('#member-share-value')).to_have_text('26%')
    expect(page.locator('#member-form input[name=gemini_5h_limit]')).to_have_value('26')
    page.keyboard.press('Home')
    for key in ['gemini_5h_limit','gemini_wk_limit','tp_5h_limit','tp_wk_limit']:
        expect(page.locator('#member-form input[name='+key+']')).to_have_value('0')
    page.keyboard.press('End')
    expect(page.locator('#member-share-value')).to_have_text('100%')
    expect(page.locator('#member-form input[name=tp_wk_limit]')).to_have_value('100')
    slider.fill('50')
    expect(page.locator('#member-form input[name=gemini_5h_limit]')).to_have_value('50')
    expect(page.locator('#member-form input[name=gemini_wk_limit]')).to_have_value('50')
    expect(page.locator('#member-form input[name=tp_5h_limit]')).to_have_value('50')
    expect(page.locator('#member-form input[name=tp_wk_limit]')).to_have_value('50')
    page.get_by_role('button',name='保存成员',exact=True).click()
    expect(page.locator('#token-dialog')).to_be_visible()
    assert page.locator('#generated-token').input_value() == 'agy_'+'a'*64
    assert '--token ' not in page.locator('#install-command').inner_text()
    page.screenshot(path=str(out/'member-install-desktop.png'),full_page=True,animations='disabled',style='#toast { visibility: hidden !important; }')
    page.locator('#token-dialog [data-close]').click()
    expect(page.locator('#generated-token')).to_have_value('')

    page.locator('.main-nav a[href="#members"]').click()
    expect(page.locator('#members')).to_be_visible()
    page.locator('[data-member-window=week]').click()
    expect(page.locator('#member-list .member-row').first).to_contain_text('9% / 50%')
    page.locator('[data-member-window=fiveHour]').click()
    page.locator('#member-list button[data-member="lin"]').click()
    expect(page.locator('#member-dialog')).to_be_visible()
    assert page.locator('#member-dialog').evaluate('(el)=>el.scrollHeight<=el.clientHeight'), 'Desktop member dialog should fit without scrolling'
    pools=page.locator('.member-pools fieldset').all()
    assert pools[0].bounding_box()['y']==pools[1].bounding_box()['y'], 'Desktop pools should be side by side'
    page.screenshot(path=str(out/'member-edit-desktop.png'),full_page=True,animations='disabled',style='#toast { visibility: hidden !important; }')
    page.locator('#member-form input[name=gemini_5h_limit]').fill('48')
    page.locator('#member-form input[name=enabled]').uncheck()
    page.get_by_role('button',name='保存成员',exact=True).click()
    expect(page.locator('#member-list .member-row').first).to_contain_text('已暂停')
    assert state['members'][0]['enabled']==0 and state['members'][0]['gemini_5h_limit']==48
    page.locator('#member-list button[data-member="lin"]').click()
    expect(page.locator('#member-form input[name=gemini_5h_limit]')).to_have_value('48')
    expect(page.locator('#member-share-value')).to_have_text('自定义')
    page.locator('#member-token-options summary').click()
    page.locator('#rotate-member-token').click()
    expect(page.locator('#confirm-title')).to_contain_text('令牌')
    expect(page.locator('#confirm-cancel')).to_be_focused()
    page.locator('#confirm-submit').click()
    expect(page.locator('#token-dialog')).to_be_visible()
    assert page.locator('#generated-token').input_value() == 'agy_'+'b'*64
    page.locator('#token-dialog [data-close]').click()
    page.locator('#member-list button[data-member="new-person"]').click()
    delete_requests=lambda: len([r for r in requests if r[0]=='DELETE'])
    before_delete=delete_requests()
    page.locator('#delete-member').click()
    expect(page.locator('#confirm-dialog')).to_be_visible()
    expect(page.locator('#member-dialog')).not_to_be_visible()
    page.screenshot(path=str(out/'delete-confirm-desktop.png'),animations='disabled')
    expect(page.locator('#confirm-cancel')).to_be_focused()
    page.keyboard.press('Tab')
    expect(page.locator('#confirm-submit')).to_be_focused()
    page.keyboard.press('Tab')
    expect(page.locator('#confirm-dialog .close')).to_be_focused()
    page.keyboard.press('Escape')
    expect(page.locator('#member-dialog')).to_be_visible()
    expect(page.locator('#delete-member')).to_be_focused()
    expect(page.locator('#member-form input[name=name]')).to_have_value('新成员')
    assert delete_requests()==before_delete
    page.locator('#delete-member').click()
    page.locator('#confirm-cancel').click()
    expect(page.locator('#member-dialog')).to_be_visible()
    assert delete_requests()==before_delete
    hold_deletion=True
    page.locator('#delete-member').click()
    page.locator('#confirm-submit').click()
    expect(page.locator('#confirm-submit')).to_be_disabled()
    expect(page.locator('#confirm-cancel')).to_be_disabled()
    expect(page.locator('#confirm-form')).to_have_attribute('aria-busy','true')
    page.keyboard.press('Escape')
    expect(page.locator('#confirm-dialog')).to_be_visible()
    page.locator('#confirm-form').dispatch_event('submit')
    assert delete_requests()==before_delete+1, 'Repeated submit sent another deletion'
    pending_deletions.pop().fulfill(status=503,json=dict(error='删除失败，请重试'))
    expect(page.locator('#confirm-form .form-error')).to_have_text('删除失败，请重试')
    expect(page.locator('#confirm-submit')).to_be_enabled()
    hold_deletion=False
    page.locator('#confirm-submit').click()
    expect(page.locator('#confirm-dialog')).not_to_be_visible()
    expect(page.locator('#member-dialog')).not_to_be_visible()
    expect(page.locator('#member-list button[data-member="new-person"]')).to_have_count(0)
    assert len(state['members'])==3
    page.locator('#upgrade-client').click()
    expect(page.locator('#upgrade-command')).to_contain_text('--upgrade')
    page.locator('#upgrade-dialog [data-close]').click()

    page.locator('.main-nav a[href="#activity"]').click()
    expect(page.locator('#events')).to_contain_text('已记账')
    expect(page.locator('#events')).to_contain_text('预留已过期')
    expect(page.locator('.event-points').first).to_have_text('0.4%')
    page.locator('#event-search').fill('Opus')
    expect(page.locator('.event-row')).to_have_count(1)
    page.locator('#event-search').fill('')
    page.locator('#event-status').select_option('released')
    expect(page.locator('.event-row')).to_have_count(1)
    page.locator('#event-status').select_option('')
    page.screenshot(path=str(out/'records-desktop.png'),full_page=True,animations='disabled',style='#toast { visibility: hidden !important; }')

    page.locator('#settings-top').click()
    expect(page.locator('#settings')).to_be_visible()
    page.locator('#policy-form input[name=gemini_5h_limit]').fill('80')
    page.locator('#policy-form input[name=buffer_percent]').fill('10')
    page.locator('#settings-budget .plain-details summary').click()
    expect(page.locator('#policy-examples')).to_contain_text('80% × 90% = 72%')
    page.locator('#policy-form input[name=gemini_5h_limit]').fill('0')
    expect(page.locator('#policy-examples')).to_contain_text('0% × 90% = 0%')
    page.locator('#policy-form input[name=gemini_5h_limit]').fill('')
    expect(page.locator('#policy-examples')).to_contain_text('填完有效数值')
    page.locator('#policy-form input[name=gemini_5h_limit]').fill('90')
    page.locator('.main-nav a[href="#overview"]').click()
    page.locator('#refresh').click()
    page.locator('#settings-top').click()
    expect(page.locator('#policy-form input[name=gemini_5h_limit]')).to_have_value('90')
    page.get_by_role('button',name='保存配额设置').click()
    expect(page.locator('#save-status')).to_have_text('设置已同步')
    assert state['policy']['gemini_5h_limit']==90
    page.locator('#policy-form input[name=gemini_5h_limit]').fill('95')
    page.locator('#reset-policy').click()
    expect(page.locator('#policy-form input[name=gemini_5h_limit]')).to_have_value('90')
    page.locator('#tab-account').click()
    expect(page.locator('#mother-account')).to_contain_text('family@example.com')
    expect(page.locator('#mother-account')).to_contain_text('15 分钟容错')
    page.locator('#connect-mother').click()
    expect(page.locator('#mother-dialog')).to_be_visible()
    assert 'code_challenge_method=S256' in page.locator('#google-auth-link').get_attribute('href')
    page.screenshot(path=str(out/'oauth-desktop.png'),full_page=True,animations='disabled',style='#toast { visibility: hidden !important; }')
    page.locator('#mother-dialog [data-close]').click()
    page.locator('#tab-budget').focus()
    page.keyboard.press('ArrowRight')
    expect(page.locator('#tab-account')).to_be_focused()
    page.keyboard.press('End')
    expect(page.locator('#tab-advanced')).to_be_focused()
    page.locator('#tab-account').click()
    page.get_by_role('button', name='解除连接', exact=True).click()
    expect(page.locator('#confirm-dialog')).to_be_visible()
    page.locator('#confirm-cancel').click()
    assert state['mother'] is not None
    page.get_by_role('button', name='解除连接', exact=True).click()
    page.locator('#confirm-submit').click()
    expect(page.locator('#mother-account')).to_contain_text('尚未登录母账号')
    assert state['mother'] is None

    # Restore the deterministic example, not a server-side account.
    state.clear(); state.update(copy.deepcopy(original))
    page.locator('.main-nav a[href="#overview"]').click()
    page.locator('#refresh').click()
    page.locator('#settings-top').click()
    page.locator('#tab-budget').click()
    page.locator('#settings-budget .plain-details').evaluate('(el)=>el.open=false')
    page.screenshot(path=str(out/'settings-desktop.png'),full_page=True,animations='disabled',style='#toast { visibility: hidden !important; }')
    page.locator('#tab-account').click()
    page.screenshot(path=str(out/'account-desktop.png'),full_page=True,animations='disabled',style='#toast { visibility: hidden !important; }')

    for width in [390,320,768]:
        page.set_viewport_size(dict(width=width,height=844))
        for name,selector in [('home','.main-nav a[href="#overview"]'),('members','.main-nav a[href="#members"]'),('records','.main-nav a[href="#activity"]'),('settings','.main-nav a[href="#settings"]' if width<701 else '#settings-top')]:
            page.locator(selector).click()
            if name=='settings': page.locator('#tab-budget').click()
            target={'home':'overview','members':'members','records':'activity','settings':'settings'}[name]
            expect(page.locator('.main-nav a[aria-current=page]')).to_have_attribute('href','#'+target)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'{name} overflows at {width}'
            if width==390: page.screenshot(path=str(out/(name+'-mobile.png')),full_page=False,animations='disabled',style='#toast { visibility: hidden !important; }')
        page.locator('.main-nav a[href="#members"]').click()
        page.locator('#member-list button[data-member="lin"]').click()
        assert page.locator('#member-dialog').evaluate('(el)=>el.scrollWidth<=el.clientWidth'), f'Member dialog overflows at {width}'
        if width==390:
            page.screenshot(path=str(out/'member-edit-mobile.png'),full_page=False,animations='disabled',style='#toast { visibility: hidden !important; }')
        page.locator('#member-dialog [data-close]').click()
    for width,height in [(1280,720),(1024,600),(390,667),(320,568)]:
        page.set_viewport_size(dict(width=width,height=height))
        page.locator('#member-list button[data-member="lin"]').click()
        page.locator('#member-token-options summary').click()
        header=page.locator('.member-form-header').bounding_box()
        footer=page.locator('.member-form-footer').bounding_box()
        assert header['y']>=0 and footer['y']+footer['height']<=height, f'Actions clipped at {width}x{height}'
        assert page.locator('#member-dialog').evaluate('(el)=>el.scrollWidth<=el.clientWidth')
        page.locator('.member-form-body').evaluate('(el)=>el.scrollTop=el.scrollHeight')
        assert page.locator('.member-form-footer').bounding_box()==footer, 'Footer moved while scrolling'
        page.screenshot(path=str(out/f'member-edit-{width}x{height}.png'),animations='disabled')
        page.locator('#delete-member').click()
        expect(page.locator('#confirm-dialog')).to_be_visible()
        assert page.locator('#confirm-dialog').evaluate('(el)=>el.scrollWidth<=el.clientWidth')
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.screenshot(path=str(out/f'delete-confirm-{width}x{height}.png'),animations='disabled')
        page.locator('#confirm-dialog .close').click()
        expect(page.locator('#member-dialog')).to_be_visible()
        page.locator('#member-dialog [data-close]').click()
    page.set_viewport_size(dict(width=1440,height=1100))
    page.locator('.main-nav a[href="#overview"]').click()
    # Inside 15-minute grace window (e.g. 100s > 90s fresh): snapshot dims, no alarm notice, calls remain available!
    state['mother']['checked_at']=int((now-timedelta(seconds=100)).timestamp()*1000)
    page.locator('#refresh').click()
    expect(page.locator('.quota-number').first).to_have_text('—')
    expect(page.locator('#notice')).not_to_be_visible()
    expect(page.locator('.availability').first).to_have_text('可使用')
    expect(page.locator('.reconciled-points').first).to_contain_text('67.2%')
    page.set_viewport_size(dict(width=390,height=844))
    page.screenshot(path=str(out/'stale-mobile.png'),full_page=False,animations='disabled',style='#toast { visibility: hidden !important; }')
    state['mother']['checked_at']=int(now.timestamp()*1000)
    state['mother']['status']='error'
    page.locator('#refresh').click()
    expect(page.locator('#notice')).not_to_be_visible()
    expect(page.locator('.availability').first).to_have_text('可使用')
    state['mother']['status']='connected'
    state['mother']['snapshot']['groups'][0]['buckets'].pop()
    page.locator('#refresh').click()
    expect(page.locator('.pool-card').first).to_contain_text('每周额度未就绪')
    expect(page.locator('.availability').first).to_have_text('可使用')
    # Past 15-minute grace (>900s) or disconnected mother account: shows notice and pauses new calls!
    state['mother']['checked_at']=int((now-timedelta(seconds=960)).timestamp()*1000)
    page.locator('#refresh').click()
    expect(page.locator('#notice')).to_be_visible()
    expect(page.locator('.availability').first).to_have_text('已暂停新调用')
    state['mother']=None
    state['members']=[]; state['events']=[]
    page.locator('#refresh').click()
    expect(page.locator('#notice')).to_be_visible()
    expect(page.locator('#home-members')).to_contain_text('第一份额度')
    expect(page.locator('.quota-number').first).to_have_text('—')
    expect(page.locator('.availability').first).to_have_text('已暂停新调用')
    page.screenshot(path=str(out/'empty-mobile.png'),full_page=False,animations='disabled',style='#toast { visibility: hidden !important; }')
    assert not errors, errors
    browser.close()
print('UI acceptance passed: percentage ledger, 15m mother grace vs >15m pause, member slider/keyboard/custom values/create/edit/pause/rotate/install/delete/cancel/retry, compact desktop dialog, settings save/dirty/reset, record filters, keyboard tabs, 320/390/768px layouts; no database mutations.')
