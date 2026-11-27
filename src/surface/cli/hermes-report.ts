import {
  isHermesFailure,
  type HermesInstallResult,
  type HermesUninstallResult,
} from '../hooks-install/hermes.js';

export function hermesTurnOnCommand(profile: string | null): string {
  return profile
    ? `hermes -p ${profile} config set memory.provider hippo`
    : 'hermes config set memory.provider hippo';
}

export function hermesInstallLines(result: HermesInstallResult): string[] {
  const { status, home, profile, pluginDir } = result;
  if (isHermesFailure(status)) {
    return [
      `WARNING: hippo could not use ${pluginDir} (${status.failed}), so it was left unchanged`,
    ];
  }
  if (status === 'installed' || status === 'updated') {
    return [
      `Copied the hippo memory provider -> ${pluginDir}`,
      `Turn it on: ${hermesTurnOnCommand(profile)}`,
    ];
  }
  if (status === 'present') {
    return [
      `The hippo memory provider is already in ${pluginDir}`,
      `Turn it on: ${hermesTurnOnCommand(profile)}`,
    ];
  }
  if (status === 'no-home') {
    return [`No Hermes home at ${home}; install Hermes or set HERMES_HOME`];
  }
  return [`Left ${pluginDir} as it is: it was not written by hippo or was edited by hand`];
}

export function hermesRemoveLines(result: HermesUninstallResult): string[] {
  const { status, pluginDir } = result;
  if (isHermesFailure(status)) {
    return [
      `WARNING: hippo could not use ${pluginDir} (${status.failed}), so it was left unchanged`,
    ];
  }
  if (status === 'removed') {
    return [`Removed the hippo memory provider from ${pluginDir}`];
  }
  if (status === 'absent') {
    return [`No hippo memory provider found in ${pluginDir}`];
  }
  return [`Left ${pluginDir} as it is: it was not written by hippo or was edited by hand`];
}

export function printHermesInstall(result: HermesInstallResult, indent: string): void {
  for (const line of hermesInstallLines(result)) console.log(`${indent}${line}`);
}

export function printHermesUninstall(result: HermesUninstallResult): void {
  for (const line of hermesRemoveLines(result)) console.log(line);
}
