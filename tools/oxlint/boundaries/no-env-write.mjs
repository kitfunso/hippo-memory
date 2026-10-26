// Plain JS with JSDoc types so the plugin loads on the package's Node floor, which cannot strip types.
import { defineRule } from '@oxlint/plugins';

import { isDotted, isNamed } from './nodes.mjs';

/** @typedef {import('@oxlint/plugins').ESTree.Node} Node */

/**
 * `process.env` itself.
 * @param {Node | null | undefined} node
 * @returns {boolean}
 */
const isEnv = (node) => node?.type === 'MemberExpression' && isDotted(node, 'env') && isNamed(node.object, 'process');

/**
 * `process.env.X` or `process.env[k]`.
 * @param {Node | null | undefined} node
 * @returns {boolean}
 */
const isEnvMember = (node) => node?.type === 'MemberExpression' && isEnv(node.object);

/** Bars a test from writing process.env: vi.stubEnv with vi.unstubAllEnvs in afterEach restores
 * what vitest.config.ts set, so one test cannot leak env into the next. */
export const noEnvWriteRule = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow writing process.env by hand in a test.' },
    messages: {
      write: 'Set env with vi.stubEnv(name, value) or vi.stubEnv(name, undefined), and call vi.unstubAllEnvs() in afterEach.',
    },
  },
  createOnce(context) {
    /** @param {Node} node */
    const report = (node) => context.report({ node, messageId: 'write' });
    return {
      AssignmentExpression: (node) => {
        if (isEnv(node.left) || isEnvMember(node.left)) report(node);
      },
      "UnaryExpression[operator='delete']": (node) => {
        if (isEnvMember(node.argument)) report(node);
      },
      "CallExpression[callee.object.name='Object'][callee.property.name='assign']": (node) => {
        if (isEnv(node.arguments[0])) report(node);
      },
    };
  },
});
