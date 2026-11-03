// A local stand-in for the LambdaDB API origin and its OAuth issuer: RFC 9728
// resource metadata, provider metadata, device and code grants, refresh
// rotation, revocation and the current-member route. Domain routes go to the
// test's handler. Every call is recorded; tokens are synthetic.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

export const consoleUrl = 'https://console.example.com';

export async function oauthServer(t, handler = () => false, options = {}) {
  const calls = [];
  const state = {
    memberId: options.memberId ?? randomUUID(),
    email: options.email ?? 'test@example.com',
    expiresIn: options.expiresIn ?? 900,
    devices: new Map(),
    codes: new Map(),
    refresh: new Map(),
    revoked: [],
    deviceError: options.deviceError,
    grantedScope: options.grantedScope,
  };
  let n = 0;
  const token = (prefix) => `${prefix}-${++n}-${randomUUID()}`;
  const issue = (scope) => {
    const granted = state.grantedScope ?? scope;
    const value = { access_token: token('access'), token_type: 'bearer', expires_in: state.expiresIn, scope: granted };
    if (granted.split(' ').includes('offline_access')) {
      value.refresh_token = token('refresh');
      state.refresh.set(value.refresh_token, granted);
    }
    return value;
  };
  const instance = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const form = (req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded');
    const call = {
      path: req.url,
      method: req.method,
      auth: req.headers.authorization,
      orgId: req.headers['x-organization-id'],
      body: raw ? (form ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw)) : undefined,
    };
    calls.push(call);
    res.setHeader('Content-Type', 'application/json');
    const json = (status, value) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    const url = `http://127.0.0.1:${instance.address().port}`;
    const path = req.url.split('?')[0];
    if (await handler(call, res, state)) return;
    if (res.writableEnded) return;
    if (path === '/.well-known/oauth-protected-resource')
      return json(200, { resource: url, authorization_servers: [`${url}/`], lambdadb_console_url: consoleUrl, scopes_supported: [] });
    if (path === '/.well-known/openid-configuration')
      return json(200, {
        issuer: `${url}/`,
        authorization_endpoint: `${url}/oauth2/auth`,
        token_endpoint: `${url}/oauth2/token`,
        device_authorization_endpoint: `${url}/oauth2/device/auth`,
        revocation_endpoint: `${url}/oauth2/revoke`,
      });
    if (path === '/oauth2/auth') {
      // Simulates the browser approving at once and following the redirect.
      const q = new URL(req.url, url).searchParams;
      const code = token('code');
      state.codes.set(code, { scope: q.get('scope'), verifier: q.get('code_challenge'), redirect: q.get('redirect_uri'), connection: q.get('connection_id') });
      const target = new URL(q.get('redirect_uri'));
      target.searchParams.set('code', code);
      target.searchParams.set('state', q.get('state'));
      res.statusCode = 302;
      res.setHeader('Location', target.href);
      return res.end();
    }
    if (path === '/oauth2/device/auth') {
      if (state.deviceError) return json(400, { error: state.deviceError });
      const device = token('device');
      state.devices.set(device, { scope: call.body.scope, connection: call.body.connection_id });
      return json(200, {
        device_code: device,
        user_code: 'AbCd1234',
        verification_uri: `${url}/oauth2/device/verify`,
        verification_uri_complete: `${url}/oauth2/device/verify?user_code=AbCd1234`,
        expires_in: 15,
        interval: 1,
      });
    }
    if (path === '/oauth2/token') {
      const b = call.body;
      if (b.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        const device = state.devices.get(b.device_code);
        if (!device) return json(400, { error: 'invalid_grant' });
        if (options.devicePoll) {
          const outcome = options.devicePoll(device, state);
          if (outcome) return json(400, { error: outcome });
        }
        state.devices.delete(b.device_code);
        return json(200, issue(device.scope));
      }
      if (b.grant_type === 'authorization_code') {
        const code = state.codes.get(b.code);
        state.codes.delete(b.code);
        if (!code || code.redirect !== b.redirect_uri || !b.code_verifier) return json(400, { error: 'invalid_grant' });
        return json(200, issue(code.scope));
      }
      if (b.grant_type === 'refresh_token') {
        const scope = state.refresh.get(b.refresh_token);
        if (!scope) return json(400, { error: 'invalid_grant' });
        state.refresh.delete(b.refresh_token);
        return json(200, issue(scope));
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (path === '/oauth2/revoke') {
      state.revoked.push(call.body);
      state.refresh.delete(call.body.token);
      res.statusCode = 200;
      return res.end();
    }
    if (path === '/members/me') return json(200, { id: state.memberId, email: state.email, name: 'Test' });
    json(404, { error: 'not_found' });
  });
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    instance.closeAllConnections();
    instance.close();
  });
  const url = `http://127.0.0.1:${instance.address().port}`;
  return { url, issuer: `${url}/`, calls, state };
}

/** A saved OAuth login for in-process tests: metadata plus its OS-store session. */
export function session(overrides = {}) {
  return JSON.stringify({
    refresh_token: overrides.refresh_token ?? `refresh-saved-${randomUUID()}`,
    access_token: overrides.access_token ?? `access-saved-${randomUUID()}`,
    access_expires_at: overrides.access_expires_at ?? Date.now() + 600_000,
  });
}
