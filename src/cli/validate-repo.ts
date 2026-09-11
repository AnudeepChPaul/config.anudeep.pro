import { parse as parseYaml } from 'yaml';
import { GitRepository } from '../git/repository.js';
import { ServiceRegistry } from '../identity/registry.js';
import { logCaught } from '../logging.js';
import { SchemaSet } from '../schema/validator.js';

/**
 * The check that runs on every push to the config repository.
 *
 * Its defining constraint: it works **without the age key**. CI is the least trusted place this
 * repository is ever cloned, and giving it the key to prove secrets are encrypted would hand
 * over the very thing being protected. Everything below is decided from ciphertext.
 *
 * It shares SchemaSet and ServiceRegistry with the running service, so CI cannot drift into
 * enforcing different rules from the ones the write path enforces.
 */

/** A SOPS-encrypted value, recognisable without being readable. */
const ENCRYPTED = /^ENC\[AES256_GCM,/;

/** SOPS's own metadata block. Not a config key, and not the consuming service's business. */
const SOPS_KEY = 'sops';

export interface Finding {
  readonly file: string;
  readonly message: string;
}

export async function validateRepository(repoDir: string): Promise<Finding[]> {
  const repository = new GitRepository(repoDir);
  const findings: Finding[] = [];

  let schemas: SchemaSet;
  try {
    schemas = SchemaSet.fromFiles(await repository.readSchemas());
  } catch (error) {
    logCaught(error, 'config.validate.schemas.failed', { logger: 'cli.validate-repo' });
    return [{ file: 'schema/', message: (error as Error).message }];
  }

  const sources = await repository.readSources();

  for (const [namespace, source] of sources.sources) {
    const file = `config/${namespace}.yaml`;
    const service = namespace.split('/')[0] ?? '';

    let parsed: Record<string, unknown>;
    try {
      const document = parseYaml(source) as Record<string, unknown> | null;
      parsed = document ?? {};
    } catch (error) {
      logCaught(error, 'config.validate.yaml.failed', { logger: 'cli.validate-repo', file });
      findings.push({ file, message: `is not valid YAML: ${(error as Error).message}` });
      continue;
    }

    // Encrypted documents carry a `sops` block. It is metadata, not configuration, and the
    // schema knows nothing about it.
    const { [SOPS_KEY]: _sops, ...config } = parsed;

    const validation = schemas.validate(service, config);
    if (!validation.ok) {
      for (const error of validation.error) findings.push({ file, message: error.message });
    }

    for (const [key, value] of Object.entries(config)) {
      if (!schemas.isSecret(service, key)) continue;
      if (typeof value === 'string' && ENCRYPTED.test(value)) continue;

      // Deliberately without the offending value: CI logs are retained and often widely
      // readable, so printing the secret it caught would leak it a second time, further.
      findings.push({
        file,
        message: `'${key}' is declared secret but was committed unencrypted — check .sops.yaml`,
      });
    }
  }

  findings.push(...validateGrants(repoDir, sources.sources, await readServices(repository)));

  return findings;
}

async function readServices(repository: GitRepository): Promise<string | null> {
  try {
    return await repository.readFile('services.yaml');
  } catch (error) {
    logCaught(error, 'config.validate.services.read.failed', { logger: 'cli.validate-repo' });
    return null;
  }
}

function validateGrants(
  _repoDir: string,
  sources: ReadonlyMap<string, string>,
  servicesYaml: string | null,
): Finding[] {
  if (servicesYaml === null) {
    return [{ file: 'services.yaml', message: 'is missing — no service could read anything' }];
  }

  let registry: ServiceRegistry;
  try {
    registry = ServiceRegistry.fromYaml(servicesYaml);
  } catch (error) {
    logCaught(error, 'config.validate.services.parse.failed', { logger: 'cli.validate-repo' });
    return [{ file: 'services.yaml', message: (error as Error).message }];
  }

  const findings: Finding[] = [];
  for (const service of registry.services()) {
    for (const namespace of service.namespaces) {
      if (sources.has(namespace)) continue;
      // Either a typo or a file deleted without its grant. Both leave the table asserting
      // something untrue about who may read what.
      findings.push({
        file: 'services.yaml',
        message: `'${service.name}' is granted '${namespace}', which has no config file`,
      });
    }
  }
  return findings;
}

async function main(): Promise<void> {
  const repoDir = process.argv[2] ?? process.cwd();
  const findings = await validateRepository(repoDir);

  if (findings.length === 0) {
    process.stdout.write('configuration is valid\n');
    return;
  }

  for (const finding of findings) {
    process.stderr.write(`${finding.file}: ${finding.message}\n`);
  }
  process.stderr.write(`\n${findings.length} problem(s) found\n`);
  process.exit(1);
}

if (
  process.argv[1]?.endsWith('validate-repo.ts') ||
  process.argv[1]?.endsWith('validate-repo.js')
) {
  void main();
}
