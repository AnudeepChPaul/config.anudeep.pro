import { decodeBase32 } from '@config/src/auth/base32.js';
import { BreakGlass, type BreakGlassRecord, hashPassword } from '@config/src/auth/break-glass.js';
import { generateTotp, totpCounter } from '@config/src/auth/totp.js';
import { describe, expect, it, vi } from 'vitest';

/**
 * The credential that works when iam does not.
 *
 * Two things make this different from an ordinary login. It is deliberately reachable only
 * while the identity provider is down, so its availability is itself a signal. And it is the
 * one credential that cannot be revoked through the system it protects — which is why every
 * use alerts, successful or not.
 */

const SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const SECRET = decodeBase32(SECRET_BASE32);
const NOW = 1_700_000_000;

const codeAt = (offset = 0) =>
  generateTotp(SECRET, { counter: totpCounter(NOW) + offset, digits: 6 });

const record = async (): Promise<BreakGlassRecord> => ({
  passwordHash: await hashPassword('correct horse battery staple'),
  totpSecret: SECRET_BASE32,
  actorEmail: 'breakglass@anudeep.pro',
});

const build = async (options: { iamReachable: boolean }) => {
  const alert = vi.fn();
  const gate = new BreakGlass({
    record: await record(),
    isIamReachable: async () => options.iamReachable,
    alert,
    now: () => NOW,
  });
  return { gate, alert };
};

describe('BreakGlass while iam is down', () => {
  it('accepts the right password and the right code', async () => {
    const { gate } = await build({ iamReachable: false });

    const result = await gate.attempt('correct horse battery staple', codeAt());

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.email).toBe('breakglass@anudeep.pro');
  });

  it('rejects the wrong password', async () => {
    const { gate } = await build({ iamReachable: false });

    expect((await gate.attempt('wrong', codeAt())).ok).toBe(false);
  });

  it('rejects the wrong code', async () => {
    const { gate } = await build({ iamReachable: false });

    expect((await gate.attempt('correct horse battery staple', '000000')).ok).toBe(false);
  });

  it('rejects a replayed code', async () => {
    // The code stays valid for its whole step, so a shoulder-surfer or a proxy log would
    // otherwise be enough to log in again within the window.
    const { gate } = await build({ iamReachable: false });
    const code = codeAt();
    await gate.attempt('correct horse battery staple', code);

    expect((await gate.attempt('correct horse battery staple', code)).ok).toBe(false);
  });

  it('tells the caller nothing about which factor was wrong', async () => {
    // Otherwise the form becomes an oracle for whether the password is right, and the second
    // factor is all that is left.
    const { gate } = await build({ iamReachable: false });

    const wrongPassword = await gate.attempt('wrong', codeAt());
    const wrongCode = await gate.attempt('correct horse battery staple', '000000');

    expect(!wrongPassword.ok && wrongPassword.error).toEqual(!wrongCode.ok && wrongCode.error);
  });
});

describe('BreakGlass while iam is up', () => {
  it('refuses even with entirely correct credentials', async () => {
    // The decision recorded in the plan: this path exists only for an iam outage. Leaving it
    // open the rest of the time would mean a second, weaker way in to the whole platform that
    // iam could neither see nor revoke.
    const { gate } = await build({ iamReachable: true });

    expect((await gate.attempt('correct horse battery staple', codeAt())).ok).toBe(false);
  });

  it('does not spend the code it refused', async () => {
    // The operator retries once iam is genuinely unreachable; the attempt that was refused for
    // being unnecessary must not have burned their code.
    const alertless = await build({ iamReachable: true });
    const code = codeAt();
    await alertless.gate.attempt('correct horse battery staple', code);

    const { gate } = await build({ iamReachable: false });
    expect((await gate.attempt('correct horse battery staple', code)).ok).toBe(true);
  });
});

describe('BreakGlass alerting', () => {
  it('alerts on a successful use', async () => {
    // This credential cannot be revoked through the system it protects, so its use is always
    // worth waking someone for — even when it is the right person doing the right thing.
    const { gate, alert } = await build({ iamReachable: false });

    await gate.attempt('correct horse battery staple', codeAt());

    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'succeeded' }));
  });

  it('alerts on a failed attempt', async () => {
    const { gate, alert } = await build({ iamReachable: false });

    await gate.attempt('wrong', codeAt());

    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
  });

  it('alerts when it refuses because iam is up', async () => {
    // Someone trying break-glass while the identity provider is healthy is the most
    // interesting case of the three.
    const { gate, alert } = await build({ iamReachable: true });

    await gate.attempt('correct horse battery staple', codeAt());

    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'refused_iam_up' }));
  });

  it('never puts the password or the code in the alert', async () => {
    const { gate, alert } = await build({ iamReachable: false });

    await gate.attempt('correct horse battery staple', codeAt());

    expect(JSON.stringify(alert.mock.calls)).not.toContain('correct horse');
  });

  it('alerts every time, not only the first', async () => {
    // The opposite rule to the read guard's de-duplication: repeated attempts here are the
    // signal, not noise.
    const { gate, alert } = await build({ iamReachable: false });

    await gate.attempt('wrong', '111111');
    await gate.attempt('wrong', '222222');

    expect(alert).toHaveBeenCalledTimes(2);
  });
});

describe('BreakGlass when nothing is configured', () => {
  it('refuses rather than letting anyone in', async () => {
    // Failing open here would mean a repository with no break-glass record is a repository
    // anyone can edit during an iam outage.
    const gate = new BreakGlass({
      record: null,
      isIamReachable: async () => false,
      alert: vi.fn(),
      now: () => NOW,
    });

    expect((await gate.attempt('anything', '123456')).ok).toBe(false);
  });

  it('still takes about as long as a real check', async () => {
    // An instant "no" tells an attacker no credential is configured, which is exactly when to
    // keep trying other doors.
    const gate = new BreakGlass({
      record: null,
      isIamReachable: async () => false,
      alert: vi.fn(),
      now: () => NOW,
    });

    const started = process.hrtime.bigint();
    await gate.attempt('anything', '123456');
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(elapsedMs).toBeGreaterThan(5);
  });
});

describe('hashPassword', () => {
  it('does not store the password', async () => {
    expect(await hashPassword('hunter2')).not.toContain('hunter2');
  });

  it('produces a different hash each time, so equal passwords are not visibly equal', async () => {
    expect(await hashPassword('hunter2')).not.toBe(await hashPassword('hunter2'));
  });

  it('records the parameters it used, so they can be raised later', async () => {
    // A hash with no cost parameters cannot be re-tuned without invalidating every credential.
    expect(await hashPassword('hunter2')).toMatch(/^scrypt\$\d+\$\d+\$\d+\$/);
  });
});
