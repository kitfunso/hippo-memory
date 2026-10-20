#!/usr/bin/env node
// Fails when src/ or tests/ drops the Promise of an api write function, or hands one to a synchronous expect(() => ...):
// these answer through a Promise on every store, so a dropped one is a write nobody waits for and a sync expect passes on any refusal.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { isHandled, programFromConfig } from './check-floating-promises.mjs';

/** The async api write functions, by the file that declares them. */
export const API_WRITES = {
  'src/api/auth/auth.ts': ['authCreate', 'authCreateSelf', 'authListRows', 'authRevoke'],
  'src/api/memories/forget.ts': ['forget'],
  'src/api/memories/outcome.ts': ['outcome', 'outcomeForLastRecall'],
  'src/api/memories/promote.ts': ['supersede', 'rawArchive'],
  'src/api/memories/remember.ts': ['remember'],
  'src/api/memories/remember-local.ts': ['rememberLocally'],
  'src/surface/importers/vault.ts': ['importVault'],
};

const CHAIN = new Set(['then', 'catch', 'finally']);

/** The call a `.then`/`.catch`/`.finally` chain starts from. */
function chainRoot(call) {
  let inner = call;
  while (
    ts.isPropertyAccessExpression(inner.expression) &&
    CHAIN.has(inner.expression.name.text) &&
    ts.isCallExpression(inner.expression.expression)
  ) {
    inner = inner.expression.expression;
  }
  return inner;
}

/**
 * Each unawaited, unreturned, non-void call to an api write function, and each one a non-async expect callback returns, in the program's files under src/ and tests/.
 * @param {ts.Program} program
 * @param {string} rootDir
 * @returns {{ file: string, line: number, text: string, why: string }[]}
 */
export function findFloatingApiCalls(program, rootDir) {
  const root = resolve(rootDir).replace(/\\/g, '/');
  const checker = program.getTypeChecker();
  const isApiWrite = (call) => {
    const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
    let symbol = checker.getSymbolAtLocation(callee);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const file = symbol?.declarations?.[0]?.getSourceFile().fileName.replace(/\\/g, '/');
    if (!file?.startsWith(`${root}/`)) return false;
    return (API_WRITES[file.slice(root.length + 1)] ?? []).includes(symbol.getName());
  };
  const hits = [];
  for (const sf of program.getSourceFiles()) {
    const rel = sf.fileName.replace(/\\/g, '/').slice(root.length + 1);
    if (
      sf.isDeclarationFile ||
      !sf.fileName.replace(/\\/g, '/').startsWith(`${root}/`) ||
      !/^(src|tests)\//.test(rel)
    ) {
      continue;
    }
    const hit = (node, why) => {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      hits.push({ file: rel, line: line + 1, text: node.getText(sf).split('\n')[0], why });
    };
    const visit = (node) => {
      if (
        ts.isExpressionStatement(node) &&
        ts.isCallExpression(node.expression) &&
        isApiWrite(chainRoot(node.expression)) &&
        !isHandled(node.expression)
      ) {
        hit(node, 'dropped');
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'expect') {
        const [cb] = node.arguments;
        const isSync =
          cb &&
          (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) &&
          !(cb.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
        if (isSync && ts.isCallExpression(cb.body) && isApiWrite(chainRoot(cb.body))) hit(node, 'sync expect');
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hits = findFloatingApiCalls(programFromConfig('tsconfig.tests.json'), '.');
  if (hits.length > 0) {
    console.error('\nApi write calls whose Promise nothing awaits:');
    for (const h of hits) console.error(`  ${h.file}:${h.line}  (${h.why})  ${h.text}`);
    console.error(
      '\nFix: `await` or `return` the call, `void` it if a rejection cannot happen, and test a refusal with `await expect(call).rejects`.\n',
    );
    process.exit(1);
  }
  console.log('Every api write call in src/ and tests/ is awaited or returned. OK.');
}
