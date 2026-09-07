/**
 * Defaults for the suite.
 *
 * The identity tests bind real Unix sockets rather than stubbing `SO_PEERCRED`, because the
 * whole point of the mechanism is that the credential comes from the kernel and not from
 * application code. A mock would assert that the mock returns what it was told to return.
 */

process.env.CONFIG_ENVIRONMENT ??= 'dev';
process.env.CONFIG_LOG_LEVEL ??= 'silent';
