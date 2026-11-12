"""Browser auth acceptance with a simulated Google response; real auth is covered by auth.test.ts."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
token = next(line.split('=', 1)[1].strip() for line in (root / '.dev.vars').read_text().splitlines() if line.startswith('ADMIN_TOKEN='))
origin = 'http://127.0.0.1:8787'
out = root / 'test-results'
out.mkdir(exist_ok=True)
with sync_playwright() as p:
    executable = os.environ.get('PLAYWRIGHT_EXECUTABLE_PATH')
    browser = p.chromium.launch(headless=True, **({'executable_path': executable} if executable else {}))
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))

    def signed_in():
        return any(c['name'] == 'agy_admin' and c['value'] == 'ui-test-session' for c in context.cookies())

    page.route('**/api/auth/status', lambda route: route.fulfill(json={
        'authenticated': signed_in(), 'google_login_available': True}))
    page.route('**/api/auth/google/start', lambda route: route.fulfill(json={
        'url': 'https://accounts.google.com/o/oauth2/v2/auth?state=test-state',
        'manual_callback': True, 'redirect_uri': 'http://localhost:50987/oauth-callback'}))

    def finish(route):
        if 'code=test-code' not in route.request.post_data_json['callback_url']:
            route.fulfill(status=400, json={'error': '回调地址缺少授权码'})
            return
        route.fulfill(status=200, headers={'Set-Cookie': 'agy_admin=ui-test-session; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800'}, json={'account': None})
    page.route('**/api/auth/google/finish', finish)

    def overview(route):
        assert 'authorization' not in route.request.headers, 'Google UI must use cookies without a handwritten token'
        assert signed_in()
        # Real local dashboard data; inject the fallback credential only in the test harness.
        response = route.fetch(headers={**route.request.headers, 'Authorization': 'Bearer ' + token})
        route.fulfill(response=response)
    page.route('**/api/admin/overview', overview)

    page.goto(origin, wait_until='networkidle')
    expect(page.locator('#google-login')).to_be_enabled()
    assert not page.locator('#token-login').evaluate('(el) => el.open')
    page.screenshot(path=str(out / 'google-login-desktop.png'), full_page=True)
    page.set_viewport_size({'width': 390, 'height': 844})
    page.screenshot(path=str(out / 'google-login-mobile.png'), full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.locator('#google-login').click()
    expect(page.locator('#mother-dialog')).to_be_visible()
    expect(page.locator('#login-dialog')).not_to_be_visible()
    assert page.locator('#google-auth-link').get_attribute('href').startswith('https://accounts.google.com/')
    page.locator('#callback-url').fill('http://localhost:50987/oauth-callback?state=test-state')
    page.locator('#mother-form button.primary').click()
    expect(page.locator('#mother-form .form-error')).to_contain_text('缺少授权码')
    page.locator('#callback-url').fill('http://localhost:50987/oauth-callback?state=test-state&code=test-code')
    page.locator('#mother-form button.primary').click()
    expect(page.locator('#mother-dialog')).not_to_be_visible()
    expect(page.locator('.pool-card')).to_have_count(2)
    assert page.locator('#admin-token').input_value() == ''
    assert next(c for c in context.cookies() if c['name'] == 'agy_admin')['httpOnly']
    page.reload(wait_until='networkidle')
    expect(page.locator('#login-dialog')).not_to_be_visible()
    expect(page.locator('.pool-card')).to_have_count(2)
    page.locator('#add-member').click()
    expect(page.locator('#member-dialog')).to_be_visible()
    page.locator('#member-dialog [data-close]').click()
    page.locator('.account-menu summary').click()
    page.locator('#logout').click()
    expect(page.locator('#login-dialog')).to_be_visible()
    assert not signed_in()
    assert not errors, errors
    browser.close()
print('Google UI acceptance passed: primary entry, callback errors, cookie-only requests, reload persistence, logout, desktop/mobile layout.')
