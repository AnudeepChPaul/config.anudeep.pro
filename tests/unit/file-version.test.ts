import { ServiceRegistry, ServiceRegistryError } from '@config/src/identity/registry.js';
import { SchemaError, SchemaSet } from '@config/src/schema/validator.js';
import { describe, expect, it } from 'vitest';

/**
 * A version on the registry's own files.
 *
 * Both files are read by a service that must keep running while they change. Declaring a version
 * is what makes it possible to change their SHAPE later without guessing: a reader that meets a
 * version it does not know can say so instead of quietly misreading the file, which for
 * services.yaml means misreading a grant table.
 *
 * It lands in three steps, and this is the first: absent means 1, so the four files already in
 * the registry keep working while they are migrated. Requiring it before writing it would leave
 * a deploy where the console cannot read its own registry.
 */
const SERVICES = `services:
  - name: iam
    uid: 1002
    namespaces: [iam/dev]
`;

const SCHEMA = `keys:
  MFA_ENFORCEMENT:
    type: enum
    values: [optional, all]
`;

const withVersion = (source: string, version: unknown) => `version: ${version}\n${source}`;

describe('services.yaml', () => {
  // Step three: the registry has been migrated, so a file without a version is a file this
  // service has never written and cannot vouch for. Silence is no longer read as 1.
  it('refuses a file that declares no version at all', () => {
    expect(() => ServiceRegistry.fromYaml(SERVICES)).toThrow(ServiceRegistryError);
    expect(() => ServiceRegistry.fromYaml(SERVICES)).toThrow(/version/);
  });

  it('reads the version it declares', () => {
    expect(ServiceRegistry.fromYaml(withVersion(SERVICES, 1)).version).toBe(1);
  });

  // The point of the field: a reader that meets a shape it does not know must stop, not guess.
  // Guessing here means misreading which uid may read which namespace.
  it('refuses a version it does not know, naming the file', () => {
    expect(() => ServiceRegistry.fromYaml(withVersion(SERVICES, 2))).toThrow(ServiceRegistryError);
    expect(() => ServiceRegistry.fromYaml(withVersion(SERVICES, 2))).toThrow(/services\.yaml/);
  });

  it('refuses a version that is not a number at all', () => {
    expect(() => ServiceRegistry.fromYaml(withVersion(SERVICES, '"one"'))).toThrow(
      ServiceRegistryError,
    );
  });

  it('still reads the services beside the version', () => {
    const registry = ServiceRegistry.fromYaml(withVersion(SERVICES, 1));
    expect(registry.services().map((service) => service.name)).toEqual(['iam']);
  });
});

describe('a schema file', () => {
  it('refuses a file that declares no version at all', () => {
    expect(() => SchemaSet.fromFiles({ iam: SCHEMA })).toThrow(SchemaError);
    expect(() => SchemaSet.fromFiles({ iam: SCHEMA })).toThrow(/schema\/iam\.yaml/);
  });

  it('reads the version it declares, and the keys beside it', () => {
    const schemas = SchemaSet.fromFiles({ iam: withVersion(SCHEMA, 1) });
    expect(schemas.versionOf('iam')).toBe(1);
    expect(schemas.definitionsFor('iam').has('MFA_ENFORCEMENT')).toBe(true);
  });

  it('refuses a version it does not know, naming the file', () => {
    expect(() => SchemaSet.fromFiles({ iam: withVersion(SCHEMA, 9) })).toThrow(SchemaError);
    expect(() => SchemaSet.fromFiles({ iam: withVersion(SCHEMA, 9) })).toThrow(/schema\/iam\.yaml/);
  });

  // `version` is a reserved word in these files, not a key anyone can declare.
  it('does not mistake the version for a key', () => {
    expect(
      SchemaSet.fromFiles({ iam: withVersion(SCHEMA, 1) })
        .definitionsFor('iam')
        .has('version'),
    ).toBe(false);
  });
});
