import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Claude Crosby state is deliberately separate from the Pi version's ~/.pi/crosby.
export const CLAUDE_CROSBY_ROOT = path.join(os.homedir(), '.claude', 'crosby');
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const THINKING_TO_EFFORT = { off: 'low', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
const DEFAULT_MODEL = 'opus';

export class ClaudeModelError extends Error {
  constructor(message) {
    super(`${message} Recovery: set the child issue label to model:opus, model:sonnet, model:fable or a full non-Haiku claude-* model ID, then resume.`);
    this.name = 'ClaudeModelError';
  }
}

export function isClaudeModel(value) {
  return /^(opus|sonnet|fable)$/.test(value) || /^claude-[a-z0-9.-]+$/.test(value);
}

// The child issue (model:/thinking: labels) decides the worker model. Haiku is never used.
// Hints that name another provider (the Pi version's labels) fall back to the default.
export function resolveClaudeModel({ modelHint, thinkingHint, fallbackModel = process.env.CROSBY_CLAUDE_DEFAULT_MODEL || DEFAULT_MODEL } = {}) {
  const hint = String(modelHint ?? '').trim().toLowerCase().replace(/^anthropic\//, '');
  if (/haiku/.test(hint) || /haiku/.test(String(fallbackModel).toLowerCase())) throw new ClaudeModelError(`Haiku is not permitted for Crosby workers (${modelHint || fallbackModel}).`);
  if (!isClaudeModel(String(fallbackModel))) throw new ClaudeModelError(`Invalid default Claude model '${fallbackModel}'.`);
  const fromLabel = isClaudeModel(hint);
  const effort = THINKING_TO_EFFORT[String(thinkingHint ?? '').trim().toLowerCase()] ?? null;
  return { model: fromLabel ? hint : String(fallbackModel), thinking: effort, source: fromLabel ? 'issue-label' : 'default' };
}

export function validClaudeSelection(value) {
  return Boolean(value && typeof value === 'object' && isClaudeModel(value.model) && !/haiku/.test(value.model)
    && (value.thinking === null || CLAUDE_EFFORTS.includes(value.thinking))
    && ['issue-label', 'default', 'role-config'].includes(value.source));
}

function powershellQuote(value) {
  const text = String(value ?? '');
  if (!text || /[\r\n\0]/.test(text)) throw new Error('Claude launch arguments must be non-empty single-line values.');
  return `'${text.replaceAll("'", "''")}'`;
}

function posixQuote(value) {
  const text = String(value ?? '');
  if (!text || /[\r\n\0]/.test(text)) throw new Error('Claude launch arguments must be non-empty single-line values.');
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Writes the per-agent context, MCP config and settings (hooks) consumed by
 * crosby-mcp.mjs and crosby-hook.mjs. mode: 'worker' | 'gate' | 'adhoc'.
 */
export async function prepareClaudeLaunch({ root = CLAUDE_CROSBY_ROOT, name, mode, context } = {}) {
  if (!['worker', 'gate', 'adhoc'].includes(mode)) throw new Error(`Unsupported Claude launch mode '${mode}'.`);
  const dir = path.join(root, 'launch', `${String(name ?? 'agent').replace(/[^A-Za-z0-9_-]+/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  const contextPath = path.join(dir, 'context.json');
  const mcpConfig = path.join(dir, 'mcp.json');
  const settings = path.join(dir, 'settings.json');
  const node = process.execPath;
  await writeFile(contextPath, JSON.stringify({ mode, ...context }, null, 2));
  await writeFile(mcpConfig, JSON.stringify({ mcpServers: { crosby: { type: 'stdio', command: node, args: [path.join(here, 'crosby-mcp.mjs'), '--context', contextPath] } } }, null, 2));
  await writeFile(settings, JSON.stringify({
    // Scoped to Crosby-launched agents only; the operator chose unattended bypass mode.
    skipDangerousModePermissionPrompt: true,
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `"${node}" "${path.join(here, 'crosby-hook.mjs')}" --context "${contextPath}"`, timeout: 30 }] }] },
  }, null, 2));
  return { dir, contextPath, mcpConfig, settings };
}

export function claudeLaunchCommand({ model, effort, mcpConfig, settings, name, platform = process.platform } = {}) {
  if (!isClaudeModel(model) || /haiku/.test(model)) throw new ClaudeModelError(`Refusing to launch Claude with model '${model}'.`);
  if (effort != null && !CLAUDE_EFFORTS.includes(effort)) throw new Error(`Unsupported Claude effort '${effort}'.`);
  const quote = platform === 'win32' ? powershellQuote : posixQuote;
  return ['claude', '--dangerously-skip-permissions', '--model', model, ...(effort ? ['--effort', effort] : []),
    '--mcp-config', quote(mcpConfig), '--settings', quote(settings), ...(name ? ['-n', quote(name)] : [])].join(' ');
}
