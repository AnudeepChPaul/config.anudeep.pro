import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

describe('local HTTPS origin for iam.anudeep.pro and config.anudeep.pro', () => {
  it('points the app container at the host for those hostnames', () => {
    const compose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');

    expect(compose).toMatch(/extra_hosts:[\s\S]*iam\.anudeep\.pro:host-gateway/);
    expect(compose).toMatch(/extra_hosts:[\s\S]*config\.anudeep\.pro:host-gateway/);
    expect(compose).toMatch(
      /NODE_EXTRA_CA_CERTS:\s*\$\{CONFIG_IAM_TLS_CA:\+\/run\/certs\/iam-rootCA\.pem\}/,
    );
  });

  it('terminates TLS on loopback for both names from one certificate', () => {
    const caddy = readFileSync(resolve(root, 'deploy/local-iam-caddy/Caddyfile'), 'utf8');

    expect(caddy).toMatch(/iam\.anudeep\.pro\s*\{/);
    expect(caddy).toMatch(/config\.anudeep\.pro\s*\{/);
    expect(caddy).toMatch(/bind 127\.0\.0\.1/);
    expect(caddy).toMatch(/reverse_proxy 127\.0\.0\.1:8000/);
    expect(caddy).toMatch(/reverse_proxy 127\.0\.0\.1:8200/);
    expect(caddy).toMatch(/\{\$IAM_CADDY_DIR\}\/local-anudeep\.pem/);
  });
});
