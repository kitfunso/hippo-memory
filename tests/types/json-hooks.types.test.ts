/** The types an integrator sees from `hippo-memory/json-hooks` (src/entry/json-hooks.ts). */

import { typeOnly } from './_type-only.js';
import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  installJsonHooks, readJsonFile, resolveJsonHookPaths, uninstallJsonHooks, writeSettingsFile,
  type InstallResult, type JsonHookPaths,
} from '../../src/entry/json-hooks.js';

type Target = 'claude-code' | 'codex' | 'copilot';

describe('hippo-memory/json-hooks entry types', () => {
  it('the target is one of three tool names', () => {
    expectTypeOf(installJsonHooks).parameters.toEqualTypeOf<[Target]>();
    expectTypeOf(uninstallJsonHooks).parameters.toEqualTypeOf<[Target]>();
    expectTypeOf(resolveJsonHookPaths).parameters.toEqualTypeOf<[Target]>();
    // @ts-expect-error an unknown tool is not a target
    typeOnly(() => installJsonHooks('vim'));
  });

  it('install returns what it wrote and uninstall returns whether the file changed', () => {
    expectTypeOf(installJsonHooks).returns.toEqualTypeOf<InstallResult>();
    expectTypeOf(uninstallJsonHooks).returns.toEqualTypeOf<boolean>();
    expectTypeOf<InstallResult['target']>().toEqualTypeOf<Target>();
    expectTypeOf<InstallResult['settingsPath']>().toEqualTypeOf<string>();
    expectTypeOf<InstallResult['installedSessionEnd']>().toEqualTypeOf<boolean>();
  });

  it('JsonHookPaths names the settings file, the log and the display name', () => {
    expectTypeOf(resolveJsonHookPaths).returns.toEqualTypeOf<JsonHookPaths>();
    expectTypeOf<JsonHookPaths>().toEqualTypeOf<{ settings: string; logFile: string; display: string }>();
  });

  it('file helpers take a path first', () => {
    expectTypeOf(readJsonFile).parameters.toEqualTypeOf<[file: string]>();
    expectTypeOf(writeSettingsFile).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(writeSettingsFile).returns.toEqualTypeOf<void>();
    // @ts-expect-error the file path comes before the settings value
    typeOnly(() => writeSettingsFile({}, 'settings.json'));
    expect(resolveJsonHookPaths('codex').settings).toEqual(expect.any(String));
  });
});
