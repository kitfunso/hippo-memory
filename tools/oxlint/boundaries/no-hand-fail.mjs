// Plain JS with JSDoc types so the plugin loads on the package's Node floor, which cannot strip types.
import { defineRule } from '@oxlint/plugins';

const PRINT = "ExpressionStatement[expression.type='CallExpression'][expression.callee.name='printError']";
const EXIT_1 =
  "ThrowStatement[argument.type='NewExpression'][argument.callee.name='CliExit'][argument.arguments.length=1][argument.arguments.0.value=1]";

/** Bars a printError statement followed by a hand-written `throw new CliExit(1)`; fail() does both,
 * so the message and the exit code cannot drift apart. */
export const noHandFailRule = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow printing an error and throwing CliExit(1) by hand.' },
    messages: { pair: 'Call fail(...) from src/surface/cli/exit.ts, which prints the message and exits 1.' },
  },
  createOnce(context) {
    return { [`${PRINT} + ${EXIT_1}`]: (node) => context.report({ node, messageId: 'pair' }) };
  },
});
