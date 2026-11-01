#!/usr/bin/env node
// Fails when src/ or tests/ holds a promise call nothing awaits or handles: in src a dropped `await` turns a CliExit into
// an unhandled rejection, in tests it races the next step. No lint rule here has type information, so this uses tsc.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

/** Handled: a `.catch` or a two-argument `.then`; a `.finally` or one-argument `.then` inherits. */
export function isHandled(expr) {
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
 * Every statement in the program's files under `srcDir` that is a promise-returning call left unhandled, `void f()`
 * included unless `voidMarks` takes `void` as the mark of a call started on purpose.
 * @param {ts.Program} program
 * @param {string} srcDir
 * @param {{ voidMarks?: boolean }} [opts]
 * @returns {{ file: string, line: number, text: string }[]}
 */
export function findFloatingPromises(program, srcDir, { voidMarks = false } = {}) {
  const root = resolve(srcDir).replace(/\\/g, '/');
  const checker = program.getTypeChecker();
  const hits = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !sf.fileName.startsWith(`${root}/`)) continue;
    const visit = (node) => {
      // `void f()` only silences the lint rule: a rejection still reaches the process-wide handler.
      const voided = !voidMarks && ts.isVoidExpression(node);
      const call = ts.isExpressionStatement(node) || voided ? node.expression : undefined;
      if (
        call !== undefined &&
        ts.isCallExpression(call) &&
        !isHandled(call) &&
        isPromise(checker.getTypeAtLocation(call))
      ) {
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
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  );
  if (!parsed) throw new Error(`cannot read ${configPath}`);
  return ts.createProgram(parsed.fileNames, parsed.options);
}

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // tsconfig.tests.json holds src and tests in one program. vitest fails a run on an unhandled rejection, so a test may
  // mark a call it starts on purpose with `void`.
  const program = programFromConfig('tsconfig.tests.json');
  const hits = [
    ...findFloatingPromises(program, 'src').map((h) => ({ ...h, file: `src/${h.file}` })),
    ...findFloatingPromises(program, 'tests', { voidMarks: true }).map((h) => ({ ...h, file: `tests/${h.file}` })),
  ];
  if (hits.length > 0) {
    console.error('\nPromise calls in src/ or tests/ that nothing awaits or handles:');
    for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.text}`);
    console.error(
      '\nFix: `await` it. A call meant to run on its own ends in `.catch(...)`, or `void` if a rejection cannot happen.\n',
    );
    process.exit(1);
  }
  console.log('Every promise call in src/ and tests/ is awaited or handled. OK.');
}
