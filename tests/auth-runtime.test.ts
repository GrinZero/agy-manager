import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

let mf:Miniflare,db:any,redirectToken=false;
const outbound:string[]=[],origin='https://quota.example';
before(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({
    modules:true,scriptPath:'dist/index.js',compatibilityDate:'2026-07-01',d1Databases:['DB'],
    bindings:{ACCOUNT_ENCRYPTION_KEY:'a'.repeat(64),ADMIN_GOOGLE_EMAIL:'mother@example.com'},
    // Exercise fetch/crypto/D1 inside workerd, not the host Node.js implementation.
    outboundService:async(request:any)=>{
      const url=new URL(request.url);outbound.push(url.href);
      if(url.hostname==='oauth2.googleapis.com') {
        if(redirectToken)return new Response(null,{status:302,headers:{Location:'https://untrusted.example/collect'}});
        const form=new URLSearchParams(await request.text());
        assert.equal(form.get('grant_type'),'authorization_code');
        assert.ok(form.get('code_verifier'));
        return Response.json({access_token:'test-access',refresh_token:'test-refresh',expires_in:3600});
      }
      assert.equal(request.headers.get('Authorization'),'Bearer test-access');
      if(url.pathname.endsWith('/userinfo'))return Response.json({email:'mother@example.com',id:'google-mother-id',verified_email:true});
      if(url.pathname.endsWith(':loadCodeAssist'))return Response.json({paidTier:{id:'test-tier'}});
      if(url.pathname.endsWith(':retrieveUserQuotaSummary'))return Response.json({groups:[
        {displayName:'Gemini',buckets:[{bucketId:'gemini-5h',window:'5h',remainingFraction:.8}]}
      ]});
      throw Error('Unexpected outbound destination');
    }
  }));
  db=await mf.getD1Database('DB');
  for(const name of ['0001_initial.sql','0002_mother_account.sql','0003_admin_google_login.sql','0004_zero_quota_floor.sql','0005_adaptive_quota.sql','0006_member_deletion.sql','0007_initial_quota_usage.sql','0008_member_login.sql','0009_family_connection.sql','0010_remove_family_connection.sql','0011_precision_billing.sql','0012_percentage_quota.sql']) {
    const schema=await readFile(`migrations/${name}`,'utf8');
    for(const statement of schema.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
  }
});
after(async()=>{await mf?.dispose();});
beforeEach(async()=>{
  outbound.length=0;redirectToken=false;
  for(const table of ['mother_account','oauth_sessions','real_quota_budgets','admin_identity','admin_sessions','quota_calibration','quota_samples'])await db.prepare(`DELETE FROM ${table}`).run();
});
async function finish() {
  const start=await mf.dispatchFetch(origin+'/api/auth/google/start',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});
  assert.equal(start.status,200);
  const nonce=start.headers.get('Set-Cookie')!.split(';')[0];
  const data=await start.json() as any,url=new URL(data.url);
  return mf.dispatchFetch(origin+'/api/auth/google/finish',{method:'POST',headers:{Origin:origin,Cookie:nonce,'Content-Type':'application/json'},
    body:JSON.stringify({callback_url:`${data.redirect_uri}?code=test-code&state=${url.searchParams.get('state')}`})});
}
test('workerd completes pasted Google callbacks, fetches real quota, and creates a usable admin cookie',async()=>{
  const response=await finish();
  assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
  const data=await response.json() as any;
  assert.equal(data.account.status,'connected');assert.equal(data.account.email,'mother@example.com');
  assert.equal(data.account.snapshot.groups[0].buckets[0].remaining_fraction,.8);
  assert.equal(outbound.length,4);
  const cookie=response.headers.getSetCookie().find(value=>value.startsWith('__Host-agy_admin='))!.split(';')[0];
  const overview=await mf.dispatchFetch(origin+'/api/admin/overview',{headers:{Cookie:cookie}});
  assert.equal(overview.status,200);
});
test('workerd rejects upstream redirects without forwarding Google credentials to another host',async()=>{
  redirectToken=true;
  const response=await finish();
  assert.equal(response.status,502);
  assert.deepEqual(outbound,['https://oauth2.googleapis.com/token']);
  assert.equal(await db.prepare('SELECT * FROM mother_account').first(),null);
  assert.equal(await db.prepare('SELECT * FROM admin_sessions').first(),null);
});
