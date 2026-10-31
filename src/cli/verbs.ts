// Every CLI verb, one row each: dispatch, flags, help and the help listing's order all read this table.

import { MEMORY_VERBS } from './verbs/memory.js';
import { HEALTH_VERBS } from './verbs/health.js';
import { SESSION_VERBS } from './verbs/sessions.js';
import { OBJECT_VERBS } from './verbs/objects.js';

export const COMMANDS = { ...MEMORY_VERBS, ...HEALTH_VERBS, ...SESSION_VERBS, ...OBJECT_VERBS };
