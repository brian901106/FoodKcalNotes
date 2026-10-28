import { randomBytes, createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const random = () => randomBytes(32).toString('base64url');

export function createTransaction(clientId, sessionId, redirectUri) {
  const verifier = randomBytes(64).toString('base64url');
  return { clientId, sessionId, redirectUri, verifier, state: random(), nonce: random(),
    challenge: createHash('sha256').update(verifier).digest('base64url'), expiresAt: Date.now() + 600_000 };
}

export async function verifyIdentity(token, clientId, nonce, jwks) {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: ISSUER, audience: clientId, requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5,
  });
  if (!payload.sub || payload.nonce !== nonce) throw new Error('登入身分驗證失敗，請重新登入。');
  return payload;
}

export function createOAuth(fetcher = fetch) {
  let discoveryPromise;
  let jwks;
  async function discovery() {
    if (!discoveryPromise) discoveryPromise = (async () => {
      const response = await fetcher(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('無法讀取 OpenAI 登入設定。');
      const config = await response.json();
      if (config.issuer !== ISSUER) throw new Error('OpenAI 登入設定的 issuer 不符。');
      for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
        if (new URL(config[key]).origin !== ISSUER) throw new Error('OpenAI 登入端點不符。');
      }
      return config;
    })().catch(error => { discoveryPromise = null; throw error; });
    return discoveryPromise;
  }
  async function token(fields) {
    const config = await discovery();
    const response = await fetcher(config.token_endpoint, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(fields), signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = new Error(`OpenAI 登入失敗（HTTP ${response.status}）；請重新授權。`);
      error.code = body.error;
      throw error;
    }
    return response.json();
  }
  return {
    async authorization(transaction, hostId, account) {
      const config = await discovery();
      const url = new URL(config.authorization_endpoint);
      url.search = new URLSearchParams({ client_id: transaction.clientId || 'dynamic_agent_client',
        redirect_uri: transaction.redirectUri, response_type: 'code', scope: SCOPES, resource: RESOURCE,
        ext_agent_host_id: hostId, state: transaction.state, nonce: transaction.nonce,
        code_challenge_method: 'S256', code_challenge: transaction.challenge,
        ...(account ? { ...(account.id_token ? { id_token_hint: account.id_token } : {}),
          ...(account.email ? { login_hint: account.email } : {}) } : { agent_name_hint: 'Meal Journal Local' }) }).toString();
      return url.toString();
    },
    exchange: (code, clientId, transaction) => token({ grant_type: 'authorization_code', code,
      client_id: clientId, redirect_uri: transaction.redirectUri, code_verifier: transaction.verifier, resource: RESOURCE }),
    refresh: account => token({ grant_type: 'refresh_token', client_id: account.client_id,
      refresh_token: account.refresh_token, resource: RESOURCE }),
    async verify(token, clientId, nonce) {
      const config = await discovery();
      jwks ||= createRemoteJWKSet(new URL(config.jwks_uri));
      return verifyIdentity(token, clientId, nonce, jwks);
    },
    async revoke(account) {
      if (!account.refresh_token) return true;
      const config = await discovery();
      if (!config.revocation_endpoint || new URL(config.revocation_endpoint).origin !== ISSUER) return false;
      const response = await fetcher(config.revocation_endpoint, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: account.refresh_token, token_type_hint: 'refresh_token', client_id: account.client_id }),
        signal: AbortSignal.timeout(15000) });
      return response.status === 200;
    },
  };
}
