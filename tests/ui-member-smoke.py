"""Member onboarding acceptance with isolated API fixtures; no database mutations."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
out = root / 'output' / 'playwright' / 'member-onboarding'
out.mkdir(parents=True, exist_ok=True)
origin = 'http://127.0.0.1:8787'
limits = dict(gemini_5h_limit=25, gemini_wk_limit=25, tp_5h_limit=25, tp_wk_limit=25)
policy = dict(gemini_5h_limit=100, gemini_wk_limit=100, tp_5h_limit=100, tp_wk_limit=100,
              buffer_percent=0, reservation_seconds=900, flash_weight=1,
              gemini_weight=3, tp_weight=3, opus_weight=8, calibration_enabled=1)
me = dict(member_id='my-id', name='小林', email='xiaolin@gmail.com', enabled=1, **limits,
          usage=dict(gemini=dict(fiveHour=1.2, week=0.3), third_party=dict(fiveHour=0, week=0)))
view = dict(policy=policy, mother=None, members=[me], events=[], pools=[
    dict(pool=pool, usage=dict(fiveHour=1.2, week=0.3), limits=dict(fiveHour=100, week=100),
         totalLimits=dict(fiveHour=100, week=100)) for pool in ['gemini', 'third_party']])

with sync_playwright() as p:
    executable = os.environ.get('PLAYWRIGHT_EXECUTABLE_PATH')
    browser = p.chromium.launch(headless=True, **({'executable_path': executable} if executable else {}))
    context = browser.new_context(viewport=dict(width=1440, height=1000), permissions=['clipboard-read', 'clipboard-write'])
    page = context.new_page()
    errors, requests = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    def signed_in():
        return any(c['name'] == 'agy_admin' and c['value'] == 'member-fixture' for c in context.cookies())
    def backend(route):
        path = route.request.url.removeprefix(origin)
        requests.append((route.request.method, path))
        assert '/api/admin/' not in path, 'Member UI requested an administrator endpoint'
        if path == '/api/auth/status':
            route.fulfill(json=dict(authenticated=signed_in(), google_login_available=True,
                                    **(dict(role='member', email=me['email']) if signed_in() else {})))
        elif path == '/api/auth/google/start':
            route.fulfill(json=dict(url='https://accounts.google.com/o/oauth2/v2/auth?state=fixture',
                                   manual_callback=True, redirect_uri='http://localhost:50987/oauth-callback'))
        elif path == '/api/auth/google/finish':
            route.fulfill(headers={'Set-Cookie': 'agy_admin=member-fixture; Path=/; HttpOnly; SameSite=Lax'}, json=dict(role='member'))
        elif path == '/api/member/overview':
            assert signed_in()
            route.fulfill(json=view)
        elif path == '/api/member/rotate-token':
            assert signed_in()
            route.fulfill(json=dict(member_id='my-id', token='agy_'+'c'*64))
        elif path == '/api/auth/logout':
            route.fulfill(headers={'Set-Cookie': 'agy_admin=; Path=/; Max-Age=0'}, json=dict(ok=True))
        else:
            route.fulfill(status=404, json=dict(error='Unexpected fixture request: '+path))
    page.route('**/api/**', backend)
    page.goto(origin, wait_until='networkidle')
    expect(page.locator('#google-login')).to_have_text('使用 Google 账号登录')
    page.locator('#google-login').click()
    expect(page.locator('#oauth-title')).to_have_text('登录 Google 账号')
    page.locator('#callback-url').fill('http://localhost:50987/oauth-callback?state=fixture&code=fixture')
    page.locator('#mother-form button.primary').click()
    expect(page.locator('#tutorial')).to_be_visible()
    expect(page.locator('#tutorial-identity')).to_contain_text(me['email'])
    expect(page.locator('#settings-top')).not_to_be_visible()
    expect(page.locator('#members-nav')).to_have_text('我的额度')
    expect(page.locator('.tutorial-steps > li')).to_have_count(3)
    assert not page.locator('#tutorial-preparation').evaluate('(el) => el.open')
    expect(page.locator('.tutorial-steps > li').first).not_to_be_visible()
    expect(page.locator('#install-focus-title')).to_be_visible()
    assert '127.0.0.1:8787/client/install.mjs' in page.locator('#installation-prompt').text_content()
    page.locator('#copy-install-prompt').click()
    expect(page.locator('#installation-token')).to_be_focused()
    assert not page.locator('#installation-token').evaluate('(el) => el.validity.valid')
    page.locator('#tutorial-preparation summary').click()
    expect(page.locator('.tutorial-steps > li').first).to_be_visible()
    page.locator('#tutorial-preparation summary').click()
    page.locator('#toast').wait_for(state='hidden')
    page.screenshot(path=str(out / 'tutorial-desktop.png'), full_page=True, animations='disabled')
    page.locator('#self-install-token').click()
    expect(page.locator('#confirm-dialog')).to_be_visible()
    page.locator('#confirm-cancel').click()
    assert not any(path.endswith('rotate-token') for _, path in requests)
    page.locator('#self-install-token').click()
    page.locator('#confirm-submit').click()
    expect(page.locator('#generated-token')).to_have_value('agy_'+'c'*64)
    page.locator('#copy-token-prompt').click()
    prompt = page.evaluate('navigator.clipboard.readText()')
    assert '成员令牌：agy_'+'c'*64 in prompt
    assert '服务地址：'+origin in prompt and '--token-file' in prompt
    assert '不要只给我一份操作教程' in prompt
    assert '最多重试 2 次' in prompt
    assert '单次主请求时限必须为 5 秒' in prompt
    assert '脚本总时限为 16.5 秒' in prompt and 'timeout 均为 18 秒' in prompt
    page.locator('#token-tutorial').click()
    expect(page.locator('#token-dialog')).not_to_be_visible()
    expect(page.locator('#generated-token')).to_have_value('')
    expect(page.locator('#installation-token')).to_have_value('agy_'+'c'*64)
    page.locator('#copy-install-prompt').click()
    assert page.evaluate('navigator.clipboard.readText()') == prompt
    assert 'agy_'+'c'*64 not in page.locator('#installation-prompt').text_content()
    # Clipboard restrictions must still leave a complete, manually copyable prompt.
    page.evaluate("() => { window.originalClipboardWrite = navigator.clipboard.writeText; navigator.clipboard.writeText = async () => { throw Error('denied'); }; }")
    page.locator('#copy-install-prompt').click()
    expect(page.locator('#install-prompt-fallback')).to_be_visible()
    expect(page.locator('#install-prompt-fallback')).to_have_value(prompt)
    page.evaluate('() => { navigator.clipboard.writeText = window.originalClipboardWrite; }')
    page.locator('#installation-token').fill('agy_'+'c'*64)
    expect(page.locator('#install-prompt-fallback')).not_to_be_visible()
    page.locator('#toast').wait_for(state='hidden')
    page.evaluate('() => { document.activeElement?.blur(); window.scrollTo(0, 0); }')
    for width in [390, 320]:
        page.set_viewport_size(dict(width=width, height=844))
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
        page.screenshot(path=str(out / f'tutorial-mobile-{width}.png'), full_page=True, animations='disabled')
        page.locator('#members-nav').click()
        expect(page.locator('#member-list .member-row')).to_have_count(1)
        expect(page.locator('#member-list .member-actions')).to_have_count(0)
        expect(page.locator('[data-add-member]')).not_to_be_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
        page.locator('.main-nav a[href="#tutorial"]').click()
    page.goto(origin+'/#settings/account', wait_until='networkidle')
    expect(page.locator('#tutorial')).to_be_visible()
    expect(page.locator('#settings')).not_to_be_visible()
    page.reload(wait_until='networkidle')
    expect(page.locator('#tutorial')).to_be_visible()
    expect(page.locator('#installation-token')).to_have_value('')
    page.locator('.account-menu summary').click()
    expect(page.locator('#account-label')).to_have_text(me['email'])
    page.locator('#logout').click()
    expect(page.locator('#login-dialog')).to_be_visible()
    assert not errors, errors
    browser.close()
print('Member acceptance passed: Google login, own quota, collapsed preparation, AI prompt clipboard/fallback, token confirmation, no admin requests, reload, logout, desktop and 320/390px mobile.')
