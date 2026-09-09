import { stringify as stringifyYaml } from 'yaml';
import { err, ok, type Result } from '../identity/types.js';
import { isMetadataKey } from '../store/metadata.js';
import type { KeyType } from './validator.js';

/**
 * Turning a form into a schema.
 *
 * A schema decides what every future value of a key is allowed to be, so a wrong schema is worse
 * than no schema: it accepts something the consuming service cannot use, and it does so at the
 * moment somebody is changing configuration to end an outage. Everything here is checked on the
 * server whatever the form sent — a form is a convenience, and a POST body is user input.
 *
 * Pure by design: drafts in, YAML or problems out. No repository, no session, no clock. That is
 * what lets every rule below be tested on its own, and it is why the output is fed back through
 * `SchemaSet.fromFiles` in the tests — the two have to agree, or the console writes a schema that
 * makes a product uneditable.
 */

/** A key as the form describes it, before anything has been checked. */
export interface KeyDraft {
  readonly name: string;
  readonly type: KeyType;
  /** A secret is a string that is marked secret; it is not a type of its own. */
  readonly secret: boolean;
  /** Declared values. A non-empty list makes the key an enum. */
  readonly values: readonly string[];
  readonly description: string;
  readonly min?: number;
  readonly max?: number;
  /** Null is how a key is declared without a value, which is the ordinary case. */
  readonly default: unknown;
}

export interface SchemaProblem {
  readonly key: string;
  readonly message: string;
}

const TYPES: readonly KeyType[] = ['string', 'int', 'bool', 'enum', 'url', 'string[]'];

/**
 * What a key may be called.
 *
 * Upper snake case, because that is what every existing schema uses and what a consuming service
 * reads from its environment. Enforced here rather than left to the operator: a lower-case key
 * would be accepted by the validator and then never match what the service looks for.
 */
const NAME = /^[A-Z][A-Z0-9_]*$/;

const problem = (key: string, message: string): SchemaProblem => ({ key, message });

/** Whether a value is of the type the key declares. Null is always allowed: it means "no value". */
function isOfType(type: KeyType, value: unknown): boolean {
  if (value === null) return true;
  switch (type) {
    case 'int':
      return typeof value === 'number' && Number.isInteger(value);
    case 'bool':
      return typeof value === 'boolean';
    case 'string[]':
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
    default:
      return typeof value === 'string';
  }
}

function checkKey(draft: KeyDraft, seen: Set<string>): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  const name = draft.name.trim();

  if (!NAME.test(name)) {
    problems.push(
      problem(name, `'${name}' is not a valid key name: use upper snake case, like SESSION_TTL`),
    );
  }
  // `version` and `sops` are the document's own fields. A key called either would be dropped
  // from every file that carried it, silently, because the reader treats them as metadata.
  if (isMetadataKey(name)) {
    problems.push(problem(name, `'${name}' is reserved by the file format and cannot be a key`));
  }
  if (seen.has(name)) {
    problems.push(problem(name, `'${name}' is declared twice`));
  }
  seen.add(name);

  if (!TYPES.includes(draft.type)) {
    problems.push(problem(name, `'${draft.type}' is not a type this console knows`));
    return problems;
  }

  const values = draft.values.filter((value) => value.trim().length > 0);
  const enumerated = values.length > 0;

  if (draft.secret && draft.type !== 'string') {
    problems.push(problem(name, 'only a string can be secret'));
  }
  // The one value that must never pass through this form. A secret typed here would travel in a
  // POST body and sit in a draft snapshot; secrets are set on the product page, which encrypts.
  if (
    draft.secret &&
    draft.default !== null &&
    draft.default !== undefined &&
    draft.default !== ''
  ) {
    problems.push(problem(name, 'a secret is created without a value; set it on the product page'));
  }
  if (draft.secret && enumerated) {
    problems.push(problem(name, 'a secret cannot declare values'));
  }

  if (enumerated && !['string', 'enum'].includes(draft.type)) {
    problems.push(problem(name, `values can only be declared for a string, not for ${draft.type}`));
  }

  const bounded = draft.min !== undefined || draft.max !== undefined;
  if (bounded && draft.type !== 'int') {
    problems.push(
      problem(name, `min and max can only be declared for an int, not for ${draft.type}`),
    );
  }
  // A bound on an int is a whole number by definition: nothing downstream rounds it, so 1.5
  // would sit in the schema deciding by halves what values are legal. NaN is what Number('')
  // and Number('sixty') both produce, and it compares false against everything — a NaN bound
  // silently permits every value while appearing to constrain them.
  for (const [label, bound] of [
    ['min', draft.min],
    ['max', draft.max],
  ] as const) {
    if (bound === undefined) continue;
    if (typeof bound !== 'number' || !Number.isInteger(bound)) {
      problems.push(problem(name, `${label} must be a whole number`));
    }
  }

  if (
    typeof draft.min === 'number' &&
    typeof draft.max === 'number' &&
    Number.isFinite(draft.min) &&
    Number.isFinite(draft.max) &&
    draft.min > draft.max
  ) {
    problems.push(
      problem(name, `min ${draft.min} is above max ${draft.max}: no value could satisfy it`),
    );
  }

  const value = draft.default;
  if (value !== null && value !== undefined) {
    if (enumerated) {
      if (!values.includes(String(value))) {
        problems.push(
          problem(name, `default '${String(value)}' is not one of ${values.join(', ')}`),
        );
      }
    } else if (!isOfType(draft.type, value)) {
      problems.push(problem(name, `default '${String(value)}' is not a valid ${draft.type}`));
    } else if (typeof value === 'number') {
      if (draft.min !== undefined && value < draft.min) {
        problems.push(problem(name, `default ${value} is below min ${draft.min}`));
      }
      if (draft.max !== undefined && value > draft.max) {
        problems.push(problem(name, `default ${value} is above max ${draft.max}`));
      }
    }
  }

  return problems;
}

/**
 * The schema file for a service, or every problem with the drafts at once.
 *
 * Every problem, never the first: a form that reports one error per attempt is a form somebody
 * fills in five times while an incident runs.
 */
export function buildSchema(input: {
  service: string;
  keys: readonly KeyDraft[];
}): Result<string, SchemaProblem[]> {
  const seen = new Set<string>();
  const problems = input.keys.flatMap((draft) => checkKey(draft, seen));
  if (problems.length > 0) return err(problems);

  const keys: Record<string, Record<string, unknown>> = {};
  for (const draft of input.keys) {
    const values = draft.values.filter((value) => value.trim().length > 0);
    const definition: Record<string, unknown> = {
      // Declared values ARE an enum, whatever the form called the type: the validator has one
      // name for "one of these", and writing `string` beside a values list would mean the
      // validator never checked the list.
      type: values.length > 0 ? 'enum' : draft.type,
    };
    if (values.length > 0) definition.values = values;
    if (draft.min !== undefined) definition.min = draft.min;
    if (draft.max !== undefined) definition.max = draft.max;
    if (draft.secret) definition.secret = true;
    if (draft.description.trim().length > 0) definition.description = draft.description.trim();
    // A null default is the absence of one. Writing `default: null` would make the key's declared
    // value null, and a created file would then hold null rather than nothing.
    if (!draft.secret && draft.default !== null && draft.default !== undefined) {
      definition.default = draft.default;
    }
    keys[draft.name.trim()] = definition;
  }

  return ok(stringifyYaml({ version: 1, keys }));
}
