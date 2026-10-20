import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

const commentOwnerKinds = new Set([
  "ExpressionStatement",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclaration",
]);

function isConstAssertion(node: TypeAssertion): boolean {
  return (
    node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const"
  );
}

const statementReads = new Set(["get", "all", "iterate"]);

/** A cast of `x.get(...)`, `x.all(...)` or `x.iterate(...)`: scripts/check-row-casts.mjs proves those in src/. */
function isStatementRead(node: TypeAssertion): boolean {
  const read = node.expression;
  return (
    read.type === "CallExpression" &&
    read.callee.type === "MemberExpression" &&
    read.callee.property.type === "Identifier" &&
    statementReads.has(read.callee.property.name)
  );
}

function hasSafetyComment(sourceCode: SourceCode, node: TypeAssertion): boolean {
  let current: ESTree.Node = node;
  while (true) {
    if (
      sourceCode
        .getCommentsBefore(current)
        .some((comment) => comment.end <= node.start && /\bSAFETY\s*:/u.test(comment.value))
    ) {
      return true;
    }
    if (commentOwnerKinds.has(current.type) || current.parent.type === "Program") return false;
    current = current.parent;
  }
}

/** Require every non-const type assertion to state the invariant TypeScript cannot express. */
export const requireSafetyCommentForTypeAssertionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a nearby SAFETY comment for every TypeScript type assertion except const assertions.",
    },
    messages: {
      missingSafetyComment:
        "This type assertion has no `SAFETY:` justification. State the checked invariant immediately before the assertion or its containing statement.",
    },
    schema: [
      {
        type: "object",
        properties: { allowStatementReads: { type: "boolean" } },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ allowStatementReads: false }],
  },
  createOnce(context) {
    const checkAssertion = (node: TypeAssertion) => {
      const option = context.options?.[0];
      const allowStatementReads =
        typeof option === "object" && option !== null && !Array.isArray(option) && option.allowStatementReads === true;
      if (isConstAssertion(node) || (allowStatementReads && isStatementRead(node))) return;
      if (hasSafetyComment(context.sourceCode, node)) return;
      context.report({ node, messageId: "missingSafetyComment" });
    };

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});
