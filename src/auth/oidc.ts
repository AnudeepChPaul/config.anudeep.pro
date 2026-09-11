import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { logCaught, logged } from '@config/src/logging.js';

/**
 * Signing in through iam: OpenID Connect authorization code flow with PKCE.
 *
 * **On not verifying the id_token signature.** The token is never accepted from the browser —
 * it arrives only in the response to a direct back-channel POST this process makes to the
 * issuer's token endpoint over TLS. The channel authenticates the issuer, which is what a
 * signature would otherwise establish; OIDC Core §3.1.3.7 permits skipping it in exactly this
 * case. What is *not* optional is the claim checks below, and they are all enforced.
 *
 * That reasoning stops holding the moment an id_token reaches this code any other way — a
 * front-channel response, a token passed by another service, more than one trusted issuer. If
 * any of those arrive, this needs real JWKS verification first.
 */

/** Only what the audit trail needs. A wider scope is a wider thing to leak. */
const SCOPE = 'openid email';

/** RFC 7636 floor; below it the challenge is brute-forceable. */
const VERIFIER_BYTES = 32;

export class OidcError extends Error {}

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

/** The challenge is the hash, never the verifier — sending the verifier makes PKCE decorative. */
export function createPkce(): Pkce {
  return pkceFor(randomBytes(VERIFIER_BYTES).toString('base64url'));
}

/**
 * The challenge for a verifier that already exists.
 *
 * The callback holds only the verifier it stored, and re-deriving is the only correct way to
 * get its challenge — minting a fresh pair there would send a challenge the verifier does not
 * satisfy, and iam would refuse every exchange.
 */
export function pkceFor(verifier: string): Pkce {
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export interface OidcOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export interface IdTokenClaims {
  readonly sub: string;
  readonly email: string;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
}

export class OidcClient {
  private discovery: Discovery | null = null;

  constructor(private readonly options: OidcOptions) {}

  async authorizationUrl(params: { state: string; nonce: string; pkce: Pkce }): Promise<string> {
    return logged(undefined, 'config.oidc.authorize', { logger: 'auth.oidc' }, async () => {
      const { authorization_endpoint } = await this.discover();
      const url = new URL(authorization_endpoint);

      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', this.options.clientId);
      url.searchParams.set('redirect_uri', this.options.redirectUri);
      url.searchParams.set('scope', SCOPE);
      url.searchParams.set('state', params.state);
      url.searchParams.set('nonce', params.nonce);
      url.searchParams.set('code_challenge', params.pkce.challenge);
      url.searchParams.set('code_challenge_method', 'S256');

      return url.toString();
    });
  }

  async exchange(params: {
    code: string;
    verifier: string;
    nonce: string;
  }): Promise<IdTokenClaims> {
    return logged(undefined, 'config.oidc.exchange', { logger: 'auth.oidc' }, async () => {
      const { token_endpoint } = await this.discover();

      const response = await fetch(token_endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          // The client secret goes in the header rather than the body: request bodies turn up in
          // proxy logs and error reports far more often than Authorization does.
          authorization: `Basic ${Buffer.from(
            `${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(this.options.clientSecret)}`,
          ).toString('base64')}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: params.code,
          redirect_uri: this.options.redirectUri,
          client_id: this.options.clientId,
          code_verifier: params.verifier,
        }).toString(),
      });

      if (!response.ok) {
        throw new OidcError(`iam refused the authorization code (${response.status})`);
      }

      const body = (await response.json()) as { id_token?: unknown };
      if (typeof body.id_token !== 'string') {
        throw new OidcError('iam returned no id_token');
      }

      return this.validate(body.id_token, params.nonce);
    });
  }

  private validate(idToken: string, nonce: string): IdTokenClaims {
    const payload = idToken.split('.')[1];
    if (!payload) throw new OidcError('the id_token is not a JWT');

    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
    } catch (error) {
      logCaught(error, 'config.oidc.token.failed', { logger: 'auth.oidc' });
      throw new OidcError('the id_token payload is not JSON');
    }

    // Any issuer this service can reach could otherwise mint a session here.
    if (claims.iss !== this.options.issuer)
      throw new OidcError('the id_token came from another issuer');

    // A token for a different relying party is a perfectly valid token that says nothing about us.
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(this.options.clientId)) {
      throw new OidcError('the id_token was issued for a different client');
    }

    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) {
      throw new OidcError('the id_token has expired');
    }

    // What ties the token to the browser that began this flow. Without it, a token captured
    // from another session could be replayed into this one.
    if (typeof claims.nonce !== 'string' || !equals(claims.nonce, nonce)) {
      throw new OidcError('the id_token does not match this sign-in attempt');
    }

    if (typeof claims.sub !== 'string' || !claims.sub)
      throw new OidcError('the id_token has no subject');
    // Without an email the audit trail records that somebody changed something.
    if (typeof claims.email !== 'string' || !claims.email)
      throw new OidcError('the id_token has no email');

    return { sub: claims.sub, email: claims.email };
  }

  private async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    return logged(undefined, 'config.oidc.discover', { logger: 'auth.oidc' }, async () => {
      const url = `${this.options.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
      const response = await fetch(url);
      if (!response.ok)
        throw new OidcError(`could not reach iam's discovery document (${response.status})`);

      const body = (await response.json()) as Partial<Discovery>;
      if (!body.authorization_endpoint || !body.token_endpoint) {
        throw new OidcError("iam's discovery document is missing endpoints");
      }

      this.discovery = {
        authorization_endpoint: body.authorization_endpoint,
        token_endpoint: body.token_endpoint,
      };
      return this.discovery;
    });
  }
}

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
