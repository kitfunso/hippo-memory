// Finds the transcript of the Codex session a `hippo codex-run` started, in Codex's sessions folder.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codexSessionIds } from '../../domain/hooks/codex-session.js';

export interface CodexSessionTranscriptOptions {
  codexHome: string;
  historyPath: string;
  startOffsetBytes: number;
  startedAtMs: number;
}

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

function readCodexSessionIdsFromHistoryDelta(historyPath: string, startOffsetBytes: number): string[] {
  if (!fs.existsSync(historyPath)) return [];
  const raw = fs.readFileSync(historyPath);
  if (startOffsetBytes >= raw.length) return [];
  return codexSessionIds(raw.subarray(startOffsetBytes).toString('utf8'), historyPath);
}

function findCodexTranscriptBySessionId(sessionsDir: string, sessionId: string): string | null {
  const matches = collectFiles(sessionsDir).filter(
    (filePath) => filePath.endsWith('.jsonl') && filePath.includes(sessionId),
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return matches[0];
}

function findNewestCodexTranscriptSince(sessionsDir: string, startedAtMs: number): string | null {
  const matches = collectFiles(sessionsDir)
    .filter((filePath) => filePath.endsWith('.jsonl'))
    .map((filePath) => ({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs }))
    .filter((entry) => entry.mtimeMs >= startedAtMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return matches[0]?.filePath ?? null;
}

export function resolveCodexSessionTranscript(options: CodexSessionTranscriptOptions): string | null {
  const { codexHome, historyPath, startOffsetBytes, startedAtMs } = options;
  const sessionsDir = path.join(codexHome, 'sessions');

  for (const sessionId of readCodexSessionIdsFromHistoryDelta(historyPath, startOffsetBytes).reverse()) {
    const transcript = findCodexTranscriptBySessionId(sessionsDir, sessionId);
    if (transcript) return transcript;
  }

  return findNewestCodexTranscriptSince(sessionsDir, startedAtMs);
}
