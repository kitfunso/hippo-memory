// A quiet Copilot search or shell failure reads as routine, as the Claude Code tool of the same kind does (critic test 5, unit half).
import { describe, it, expect } from 'vitest';
import { lessonFromFailure } from '../src/capture/failure-reading.js';
import { normaliseHookPayload } from '../src/cli/stdin.js';
import type { JsonValue } from '../src/util/json.js';
import { copilotPayload } from './_helpers/copilot-hooks.js';

const CWD = '/home/user/proj';
// The error strings are synthetic: neither harness documents a failed tool's error text.
const SEARCH_ERROR = 'search failed: IO error reading src/auth';
const QUIET_EXIT = 'Command failed with exit code 1';

function failure(tool: string, error: string, command?: string): JsonValue {
  return command === undefined
    ? { session_id: 's', tool_name: tool, error }
    : { session_id: 's', tool_name: tool, error, tool_input: { command } };
}

function fixture(name: 'postToolUseFailureGrep' | 'postToolUseFailureBash' | 'postToolUseFailureBuild' | 'syntheticClaudeStyleTerminalFailure'): JsonValue {
  const text = normaliseHookPayload(copilotPayload(name, CWD));
  if (text === undefined) throw new Error('normaliser dropped the payload');
  // SAFETY: JSON.parse returns a JSON value by definition.
  return JSON.parse(text) as JsonValue;
}

describe('Copilot tool names in the routine-failure rules', () => {
  // Copilot CLI names: docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference, "Tool availability values".
  it.each(['grep', 'glob', 'rg'])('Copilot CLI search tool %s is routine', (tool) => {
    expect(lessonFromFailure(failure(tool, SEARCH_ERROR))).toMatchObject({ skip: 'skipped-routine', rule: 'search-tool' });
  });

  it.each(['bash', 'powershell'])('Copilot CLI shell tool %s with a quiet exit 1 is routine', (tool) => {
    expect(lessonFromFailure(failure(tool, QUIET_EXIT, 'grep -rn retryBudget src'))).toMatchObject({ skip: 'skipped-routine', rule: 'quiet-exit' });
  });

  // VS Code names: microsoft/vscode extensions/copilot/src/extension/tools/common/toolNames.ts, ToolName.Codebase, FindFiles, FindTextInFiles, CoreRunInTerminal.
  it.each(['semantic_search', 'file_search', 'grep_search'])('VS Code search tool %s is routine', (tool) => {
    expect(lessonFromFailure(failure(tool, SEARCH_ERROR))).toMatchObject({ skip: 'skipped-routine', rule: 'search-tool' });
  });

  it('VS Code run_in_terminal with a quiet exit 1 is routine', () => {
    expect(lessonFromFailure(failure('run_in_terminal', QUIET_EXIT, 'git diff --exit-code'))).toMatchObject({ skip: 'skipped-routine', rule: 'quiet-exit' });
  });

  it('a Copilot shell failure that is not a quiet exit stays a lesson', () => {
    expect(lessonFromFailure(failure('bash', 'Command failed with exit code 2: tsc reported TS2345', 'npm run build'))).toEqual({
      text: 'bash: Command failed with exit code 2: tsc reported TS2345',
      detail: 'bash npm run: Command failed with exit code 2: tsc reported TS2345',
    });
  });

  it('an unknown tool is not treated as search or shell', () => {
    expect(lessonFromFailure(failure('read_file', SEARCH_ERROR))).toEqual({ text: `read_file: ${SEARCH_ERROR}`, detail: `read_file: ${SEARCH_ERROR}` });
  });
});

describe('the fixture payloads after stdin.ts maps them', () => {
  // hook-payloads.json: GH hooks reference camelCase postToolUseFailure, plus a synthetic Claude-style snake_case one, since VS Code's Local agent fires no failure event.
  it('a synthetic Claude-style snake_case run_in_terminal grep exit 1 is a quiet exit', () => {
    expect(lessonFromFailure(fixture('syntheticClaudeStyleTerminalFailure'))).toMatchObject({ skip: 'skipped-routine', rule: 'quiet-exit' });
  });
});
