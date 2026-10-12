import { closeSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';

// No effect on ordinary Qwen sessions using this extension. Permitted calls
// emit nothing: the existing permission engine must still approve execution.
if (process.env.QWEN_HARNESS_WRITER_GUARD !== '1') process.exit(0);

const aliases = new Map([
  ['shell', 'run_shell_command'], ['bash', 'run_shell_command'],
  ['writefile', 'write_file'], ['write', 'write_file'],
  ['edit', 'edit'], ['notebookedit', 'notebook_edit'],
  ['readfile', 'read_file'], ['read', 'read_file'],
  ['grep', 'grep_search'], ['listdirectory', 'list_directory'],
  ['toolcall', 'tool_call'], ['toolsearch', 'tool_search'],
  ['task', 'agent'],
]);
const mutations = new Set(['run_shell_command', 'edit', 'write_file', 'notebook_edit', 'monitor', 'exec']);
const readTools = new Set(['read_file', 'glob', 'grep_search', 'list_directory', 'tool_search', 'get_goal', 'update_goal', 'structured_output']);
const canonical = (name) => aliases.get(name.toLowerCase()) ?? name.toLowerCase();
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function deny(reason) {
  process.stderr.write(`Fern writer guard: ${reason}\n`);
  process.exit(2);
}

function isRecordedImplementer(payload, worktree) {
  if (typeof payload.session_id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(payload.session_id) || typeof payload.transcript_path !== 'string' || !path.isAbsolute(payload.transcript_path)) return false;
  const chats = path.dirname(payload.transcript_path);
  if (path.basename(chats) !== 'chats' || path.basename(payload.transcript_path) !== `${payload.session_id}.jsonl`) return false;
  const project = realpathSync(path.dirname(chats));
  const session = path.join(project, 'subagents', payload.session_id);
  const file = path.join(session, `agent-${payload.agent_id}.jsonl`);
  // A transcript outside this session, including a symlink escape, cannot
  // vouch for a writer's identity. Never inspect the remaining conversation.
  if (realpathSync(session) !== session || realpathSync(file) !== file) return false;
  const fd = openSync(file, 'r');
  try {
    const max = 1024 * 1024;
    const chunks = [];
    let size = 0;
    while (size < max) {
      const chunk = Buffer.alloc(Math.min(8192, max - size));
      const length = readSync(fd, chunk, 0, chunk.length, null);
      if (length === 0) return false;
      const newline = chunk.subarray(0, length).indexOf(10);
      chunks.push(chunk.subarray(0, newline < 0 ? length : newline));
      size += length;
      if (newline >= 0) {
        const header = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return object(header) && header.type === 'user' && header.isSidechain === true && header.agentId === payload.agent_id && header.agentName === 'harness-implementer' && header.sessionId === payload.session_id && typeof header.cwd === 'string' && realpathSync(header.cwd) === realpathSync(worktree);
      }
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) deny('hook input exceeds the supported limit.');
  }
  const payload = JSON.parse(input);
  if (!object(payload) || payload.hook_event_name !== 'PreToolUse' || typeof payload.tool_name !== 'string' || !payload.tool_name || !object(payload.tool_input)) deny('invalid tool hook input.');
  const worktree = process.env.QWEN_HARNESS_WORKTREE;
  if (!worktree || !path.isAbsolute(worktree) || typeof payload.cwd !== 'string' || !path.isAbsolute(payload.cwd) || realpathSync(payload.cwd) !== realpathSync(worktree)) deny('tool call is outside the assigned worktree.');
  const child = typeof payload.agent_id === 'string' && /^workflow-agent-[a-f0-9]{16}$/.test(payload.agent_id);
  let name = canonical(payload.tool_name);
  let args = payload.tool_input;
  if (name === 'tool_call') {
    if (typeof args.name !== 'string' || !args.name || !object(args.arguments) || Object.keys(args).some((key) => !['name', 'arguments'].includes(key))) deny('unsupported deferred-tool call.');
    name = canonical(args.name);
    args = args.arguments;
    if (!mutations.has(name) && !readTools.has(name) && !['agent', 'workflow'].includes(name)) deny('deferred tool is outside the guarded tool surface.');
  }
  if (name === 'workflow') {
    const expected = process.env.QWEN_HARNESS_WORKFLOW_PATH;
    if (child || !expected || !path.isAbsolute(expected) || args.scriptPath !== expected || Object.hasOwn(args, 'script') || Object.hasOwn(args, 'name') || realpathSync(args.scriptPath) !== realpathSync(expected)) deny('only the exact saved delivery workflow may run.');
  } else if (name === 'agent') {
    deny('agents must be dispatched by the saved delivery workflow.');
  } else if (mutations.has(name) && (!child || !isRecordedImplementer(payload, worktree))) {
    deny('only the recorded saved-workflow implementer may execute mutation tools.');
  } else if (!mutations.has(name) && !readTools.has(name)) {
    deny('tool is outside the guarded delivery surface.');
  }
} catch {
  // Never echo malformed input, paths, commands, or credentials.
  deny('unable to validate the guarded tool call.');
}
