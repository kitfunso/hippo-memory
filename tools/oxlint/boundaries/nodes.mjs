/** @typedef {import('@oxlint/plugins').ESTree.Node} Node */

/**
 * `<object>.<name>` written with a dot.
 * @param {Node | null | undefined} node
 * @param {string} name
 * @returns {boolean}
 */
export function isDotted(node, name) {
  return (
    node?.type === 'MemberExpression' &&
    !node.computed &&
    node.property.type === 'Identifier' &&
    node.property.name === name
  );
}

/**
 * An identifier named `name`.
 * @param {Node | null | undefined} node
 * @param {string} name
 * @returns {boolean}
 */
export function isNamed(node, name) {
  return node?.type === 'Identifier' && node.name === name;
}

/**
 * The text of a string literal or a template with no `${}`; undefined for any other node.
 * @param {Node | null | undefined} node
 * @returns {string | undefined}
 */
export function textOf(node) {
  if (node?.type === 'Literal' && node.raw !== null && /^['"]/.test(node.raw)) return String(node.value);
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}
