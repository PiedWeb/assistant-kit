import fs from 'node:fs';
import path from 'node:path';
import { tryContentAddress } from './content.js';

const CLAUDE_FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

/**
 * Paths touched by a PostToolUse payload. Claude Code's Write, Edit and
 * MultiEdit send one `tool_input.file_path`; Codex's apply_patch sends the
 * whole patch in `tool_input.command` and may touch several files.
 */
export function hookFilePaths(payload) {
  const input = payload?.tool_input || {};
  if (CLAUDE_FILE_TOOLS.has(payload?.tool_name)) {
    return typeof input.file_path === 'string' && input.file_path ? [input.file_path] : [];
  }
  if (payload?.tool_name !== 'apply_patch' || typeof input.command !== 'string') {
    return [];
  }
  const paths = [];
  for (const pattern of [/^\*\*\* (?:Add|Update) File: (.+?)\r?$/gm, /^\*\*\* Move to: (.+?)\r?$/gm]) {
    for (const match of input.command.matchAll(pattern)) {
      paths.push(match[1].trim());
    }
  }
  return [...new Set(paths)];
}

/** Existing page files of the workspace touched by the payload. Deletions are never inferred. */
export function pagesFromHookPayload(workspace, rawPayload) {
  let payload;
  try {
    payload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
  } catch {
    return [];
  }
  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : process.cwd();
  return hookFilePaths(payload)
    .map((file) => path.resolve(cwd, file))
    .filter((file) => fs.existsSync(file))
    .map((file) => tryContentAddress(workspace.contentRoot, file))
    .filter(Boolean);
}

/**
 * Run the PostToolUse sync. Returns the exit code for the hook: 2 makes Claude
 * Code feed stderr back to the model, which must see every failure (a 409
 * replaced the file and discarded the edit, an auth error needs a new token,
 * a page of a host outside the workspace hosts stayed local).
 *
 * An edit is never a reason to publish another host: the hook pushes the
 * workspace hosts only.
 */
export async function runSyncHook(workspace, rawPayload, { publish = true } = {}) {
  const pages = pagesFromHookPayload(workspace, rawPayload);
  if (!pages.length) {
    return 0;
  }
  const { results } = await workspace.sync(pages.map((page) => page.absolutePath), { publish, anyHost: false });
  const staticFailed = results.some((result) => result.static && !result.static.generated && result.static.error);
  return results.every((result) => result.status === 'synced') && !staticFailed ? 0 : 2;
}
