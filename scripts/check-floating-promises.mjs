#!/usr/bin/env node
// Fails when src/ holds a promise call nothing awaits or handles: since CLI verbs throw CliExit, a dropped `await`
// turns a clean exit into an unhandled rejection. No lint rule here has type information, so this uses tsc's checker.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

/** Handled: a `.catch` or a two-argument `.then`; a `.finally` or one-argument `.then` inherits. `void f()` is no call, so it passes. */
function isHandled(expr) {
  if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression)) return false;
  const method = expr.expression.name.text;
  if (method === 'catch') return true;
  if (method === 'then' && expr.arguments.length >= 2) return true;
  if (method === 'then' || method === 'finally') return isHandled(expr.expression.expression);
  return false;
}

function isPromise(type) {
  if (type.isUnion()) return type.types.some(isPromise);
  return (type.getSymbol() ?? type.aliasSymbol)?.getName() === 'Promise';
}

/**
 * Every statement in the program's files under `srcDir` that is a promise-returning call left unhandled.
 * @param {ts.Program} program
 * @param {string} srcDir
 * @returns {{ file: string, line: number, text: string }[]}
 */
export function findFloatingPromises(program, srcDir) {
  const root = resolve(srcDir).replace(/\\/g, '/');
  const checker = program.getTypeChecker();
  const hits = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !sf.fileName.startsWith(`${root}/`)) continue;
    const visit = (node) => {
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
        && !isHandled(node.expression) && isPromise(checker.getTypeAtLocation(node.expression))) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        hits.push({ file: sf.fileName.slice(root.length + 1), line: line + 1, text: node.getText(sf).split('\n')[0] });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** The program tsconfig.json describes. */
export function programFromConfig(configPath) {
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  if (!parsed) throw new Error(`cannot read ${configPath}`);
  return ts.createProgram(parsed.fileNames, parsed.options);
}

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hits = findFloatingPromises(programFromConfig('tsconfig.json'), 'src');
  if (hits.length > 0) {
    console.error('\nPromise calls in src/ that nothing awaits or handles:');
    for (const h of hits) console.error(`  src/${h.file}:${h.line}  ${h.text}`);
    console.error('\nFix: `await` it. A call meant to run on its own ends in `.catch(...)`, or `void` if a rejection cannot happen.\n');
    process.exit(1);
  }
  console.log('Every promise call in src/ is awaited or handled. OK.');
}
