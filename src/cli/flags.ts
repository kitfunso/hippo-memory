// Each flag's kind, read from the verb table's flags: parseArgs needs a flag's kind before the verb's module loads.

import { COMMANDS } from './verbs.js';

// A value on a switch is refused, as `--fix=false` reads as on under Boolean() and `--pin=true` as off under === true.
export type FlagKind = 'switch' | 'value' | 'number' | 'list';

/** One verb's flags by kind: a number is refused unless numeric, and a list collects repeats. */
export interface VerbFlags {
  readonly switches?: readonly string[];
  readonly values?: readonly string[];
  readonly numbers?: readonly string[];
  readonly lists?: readonly string[];
}

// The entry point reads these for every verb, so no verb declares them.
const GLOBAL_FLAGS: VerbFlags = { switches: ['help', 'version'] };

const FIELD_KINDS = [['switches', 'switch'], ['values', 'value'], ['numbers', 'number'], ['lists', 'list']] as const;

const DECLARED: ReadonlyMap<VerbFlags, ReadonlyMap<string, FlagKind>> = new Map(
  [GLOBAL_FLAGS, ...Object.values(COMMANDS).map((row) => row.flags)].map((verb) => [
    verb,
    new Map(FIELD_KINDS.flatMap(([field, kind]) => (verb[field] ?? []).map((name): [string, FlagKind] => [name, kind]))),
  ]),
);

// A flag typed on a verb that does not declare it still has to parse: it takes the kind its
// declaring verbs agree on, and where they differ it is a plain value.
const SHARED_KIND: ReadonlyMap<string, FlagKind> = (() => {
  const shared = new Map<string, FlagKind>();
  for (const kinds of DECLARED.values()) {
    for (const [name, kind] of kinds) shared.set(name, (shared.get(name) ?? kind) === kind ? kind : 'value');
  }
  return shared;
})();

/** How parseArgs reads `--name` on the verb with these flags; `undefined` is a command the table lacks. */
export function flagKind(verb: VerbFlags | undefined, name: string): FlagKind {
  return (verb ? DECLARED.get(verb)?.get(name) : undefined) ?? SHARED_KIND.get(name) ?? 'value';
}

/** Whether any verb, or the entry point, reads `--name`. */
export function isKnownFlag(name: string): boolean {
  return SHARED_KIND.has(name);
}

/** The typed flags this verb does not read, in the order typed. */
export function undeclaredFlags(verb: VerbFlags, typed: readonly string[]): string[] {
  const declared = DECLARED.get(verb);
  const global = DECLARED.get(GLOBAL_FLAGS);
  return typed.filter((name) => !declared?.has(name) && !global?.has(name));
}
