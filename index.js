/**
 * Host half of the dsh-interaction-optimize bundle.
 *
 * It carries the things the Client cannot own by itself:
 *
 *  1. The user's custom notification sound, stored under
 *     `<DSH_HOME>/dsh-interaction-optimize/` and served on
 *     `/dsh-interaction-optimize/sound` (`GET` streams the clip with byte-range
 *     support, `PUT` replaces it, `DELETE` removes it; uploads are bounded to
 *     common audio types).
 *  2. The latest `workspace/changes` summary per Session, read from the
 *     `workspaceChanges` service and served on
 *     `/dsh-interaction-optimize/changes?session=…` so the composer's diff
 *     badge can poll it while a turn runs.
 *  3. The file-link actions served on `/dsh-interaction-optimize/open` and
 *     `/dsh-interaction-optimize/apps`: native open/reveal through the Host
 *     session controller, plus the extension's registered applications.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, normalize, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROUTE_PREFIX = '/dsh-interaction-optimize';
const SOUND_PATH = `${ROUTE_PREFIX}/sound`;
const CHANGES_PATH = `${ROUTE_PREFIX}/changes`;
const LIVE_DIFF_PATH = `${ROUTE_PREFIX}/live-diff`;
/** Extensions Windows runs (or scripts) on open; the default-open action refuses them. */
const RUNNABLE_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.scr', '.pif', '.msi', '.msp', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.lnk', '.reg', '.cpl', '.msc', '.scf', '.url', '.appref-ms', '.settingcontent-ms',
]);

/** Finished turns of every Session, drained by the browser half. */
const COMPLETIONS_PATH = `${ROUTE_PREFIX}/completions`;
const OPEN_PATH = `${ROUTE_PREFIX}/open`;
const APPS_PATH = `${ROUTE_PREFIX}/apps`;
const STORE_DIR_NAME = 'dsh-interaction-optimize';
/** The pre-rename store directory; migrated once when present. */
const LEGACY_STORE_DIR_NAME = 'codex-like';
const META_FILE = 'sound.json';
const MAX_SOUND_BYTES = 4 * 1024 * 1024;
const MAX_TRACKED_SESSIONS = 64;
const MAX_FILES_IN_RESPONSE = 30;
const MAX_COMPLETIONS = 50;
/** The `turn/end` reasons worth a notice, in the Client's tone names. */
const COMPLETION_TONES = { completed: 'success', error: 'error', 'max-tokens': 'warning' };
/** Live summaries are computed from git up to four times a second at most. */
const LIVE_CACHE_MS = 450;
const MAX_LIVE_FILES = 60;
const MAX_LIVE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_BYTES = 200 * 1024;

/** Accepted upload media types and the extension each is stored under. */
const EXT_BY_TYPE = {
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
};

function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh');
}

function storeDir() {
  return join(dshHome(), STORE_DIR_NAME);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readMeta() {
  try {
    const meta = JSON.parse(readFileSync(join(storeDir(), META_FILE), 'utf8'));
    return meta !== null && typeof meta === 'object' ? meta : undefined;
  } catch {
    return undefined;
  }
}

/** Collect a bounded request body; resolves undefined when the limit is exceeded. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function soundFileOf(meta) {
  return meta === undefined || typeof meta.ext !== 'string' ? undefined : join(storeDir(), `sound.${meta.ext}`);
}

function serveSound(req, res) {
  const meta = readMeta();
  const file = soundFileOf(meta);
  if (file === undefined || !existsSync(file)) {
    sendJson(res, 404, { error: 'no custom sound' });
    return;
  }
  const data = readFileSync(file);
  const total = data.length;
  const type = typeof meta.contentType === 'string' ? meta.contentType : 'application/octet-stream';
  const range = typeof req.headers.range === 'string' ? req.headers.range.trim() : '';
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (match !== null) {
    const start = match[1] === '' ? 0 : Number(match[1]);
    const end = match[2] === '' ? total - 1 : Number(match[2]);
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < total) {
      const last = Math.min(end, total - 1);
      res.writeHead(206, {
        'content-type': type,
        'content-length': last - start + 1,
        'content-range': `bytes ${start}-${last}/${total}`,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      });
      if (req.method === 'HEAD') res.end();
      else res.end(data.subarray(start, last + 1));
      return;
    }
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': total,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') res.end();
  else res.end(data);
}

function uploadedName(req, ext) {
  const raw = req.headers['x-file-name'];
  if (typeof raw === 'string' && raw !== '') {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return `sound.${ext}`;
}

async function saveSound(req, res) {
  const contentType = String(req.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const ext = EXT_BY_TYPE[contentType];
  if (ext === undefined) {
    sendJson(res, 415, { error: 'unsupported audio type' });
    return;
  }
  const body = await readBody(req, MAX_SOUND_BYTES);
  if (body === undefined) {
    sendJson(res, 413, { error: 'sound file too large' });
    return;
  }
  if (body.length === 0) {
    sendJson(res, 400, { error: 'empty sound file' });
    return;
  }
  const dir = storeDir();
  mkdirSync(dir, { recursive: true });
  for (const candidate of Object.values(EXT_BY_TYPE)) {
    const stale = join(dir, `sound.${candidate}`);
    if (existsSync(stale)) rmSync(stale);
  }
  const file = join(dir, `sound.${ext}`);
  writeFileSync(`${file}.tmp`, body);
  renameSync(`${file}.tmp`, file);
  const meta = {
    ext,
    contentType,
    updatedAt: Date.now(),
    name: uploadedName(req, ext),
  };
  writeFileSync(join(dir, META_FILE), JSON.stringify(meta));
  sendJson(res, 200, { ok: true, updatedAt: meta.updatedAt, name: meta.name });
}

function deleteSound(res) {
  const dir = storeDir();
  for (const candidate of Object.values(EXT_BY_TYPE)) {
    const stale = join(dir, `sound.${candidate}`);
    if (existsSync(stale)) rmSync(stale);
  }
  const meta = join(dir, META_FILE);
  if (existsSync(meta)) rmSync(meta);
  sendJson(res, 200, { ok: true });
}

/** Project one recorded summary into the small shape the Client badge renders. */
function projectSummary(summary) {
  const files = Array.isArray(summary.files)
    ? summary.files.slice(0, MAX_FILES_IN_RESPONSE).map((file) => ({
        path: typeof file.path === 'string' ? file.path : '',
        display: typeof file.display === 'string' ? file.display : String(file.path ?? ''),
        added: Number.isFinite(file.added) ? file.added : 0,
        deleted: Number.isFinite(file.deleted) ? file.deleted : 0,
        binary: file.binary === true,
        oversized: file.oversized === true,
      }))
    : [];
  return {
    turn: Number.isFinite(summary.turn) ? summary.turn : 0,
    total: Number.isFinite(summary.total) ? summary.total : files.length,
    added: Number.isFinite(summary.added) ? summary.added : 0,
    deleted: Number.isFinite(summary.deleted) ? summary.deleted : 0,
    files,
  };
}

function pruneSessions(changesBySession) {
  if (changesBySession.size <= MAX_TRACKED_SESSIONS) return;
  const oldest = [...changesBySession.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0];
  if (oldest !== undefined) changesBySession.delete(oldest[0]);
}

/** The model-facing text of one assistant message, collapsed for a notice. */
function assistantExcerptOf(event) {
  const message = event && event.data ? event.data.message : undefined;
  const content = message && Array.isArray(message.content) ? message.content : undefined;
  if (content === undefined) return undefined;
  let text = '';
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += ` ${block.text}`;
  }
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? undefined : collapsed.slice(0, 200);
}

/** Append one finished turn to the queue the browser half drains. */
function recordCompletion(completions, sessionId, event) {
  const reason = event.data ? event.data.reason : undefined;
  const tone = COMPLETION_TONES[reason && reason.kind];
  if (tone === undefined) {
    completions.excerpts.delete(sessionId);
    return;
  }
  completions.next += 1;
  completions.list.push({
    id: completions.next,
    sessionId,
    tone,
    detail: tone === 'error' ? (reason && reason.error ? reason.error.message : undefined) : completions.excerpts.get(sessionId),
    at: Date.now(),
  });
  if (completions.list.length > MAX_COMPLETIONS) completions.list.splice(0, completions.list.length - MAX_COMPLETIONS);
  completions.excerpts.delete(sessionId);
}

/** Remember the summary announced by one `workspace/changes` event. */
function trackSessionEvent(ctx, changesBySession, completions, session, event) {
  if (!event) return;
  const sessionId = session && (session.header?.id ?? session.id);
  if (typeof sessionId !== 'string' || sessionId === '') return;
  // A fresh turn starts from a clean badge: the previous turn's summary no
  // longer describes what this turn is changing.
  if (event.type === 'turn/start') {
    changesBySession.delete(sessionId);
    completions.excerpts.delete(sessionId);
    return;
  }
  if (event.type === 'assistant/message') {
    const text = assistantExcerptOf(event);
    if (text !== undefined) completions.excerpts.set(sessionId, text);
    return;
  }
  if (event.type === 'turn/end') {
    recordCompletion(completions, sessionId, event);
    return;
  }
  if (event.type !== 'workspace/changes') return;
  const seq = event.seq;
  // The recorder appends `workspace/changes` first and only then stores the
  // summary it announced, so read it on the next microtask: the synchronous
  // continuation stores the record before this callback runs.
  queueMicrotask(() => {
    const service = ctx.get('workspaceChanges');
    if (!service || typeof service.summary !== 'function') return;
    let summary;
    try {
      summary = service.summary(sessionId, seq);
    } catch {
      return;
    }
    if (summary === undefined) return;
    changesBySession.set(sessionId, {
      ...projectSummary(summary),
      seq,
      updatedAt: Date.now(),
    });
    pruneSessions(changesBySession);
  });
}

/** Track each session's working directory so relative link paths can resolve. */
function trackSessionCwd(cwdBySession, session, event) {
  if (!event) return;
  const sessionId = session && (session.header?.id ?? session.id);
  const cwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : undefined;
  if (typeof sessionId !== 'string' || sessionId === '' || cwd === undefined) return;
  cwdBySession.set(sessionId, cwd);
  if (cwdBySession.size > MAX_TRACKED_SESSIONS) cwdBySession.delete(cwdBySession.keys().next().value);
}

// ---------------------------------------------------------------------------------------------
// Live turn changes.
//
// DSH records `workspace/changes` only while a turn is stopping, so the
// composer badge would otherwise appear after the answer. This half keeps a
// per-turn git baseline instead: the badge polls a live summary during the run,
// and the Client asks for one file's unified diff on demand.
// ---------------------------------------------------------------------------------------------

/** The git executable the Host resolved for this process; plain `git` until then. */
let gitExecutable = 'git';

/** Run one git command inside a repository; undefined when git is unavailable. */
async function gitRun(root, args) {
  try {
    const { stdout } = await execFileAsync(gitExecutable, args, { cwd: root, windowsHide: true, maxBuffer: 16 << 20 });
    return stdout;
  } catch {
    return undefined;
  }
}

/** The repository that contains one working directory, if any. */
async function gitTopLevel(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return undefined;
  const top = await gitRun(cwd, ['rev-parse', '--show-toplevel']);
  if (top === undefined) return undefined;
  const root = top.trim();
  return root === '' ? undefined : root;
}

/**
 * Snapshot the working tree a turn starts from without touching it: `git stash
 * create` commits tracked modifications (it never touches the stash list), and
 * HEAD covers the clean case. Untracked files are remembered by path so files
 * the turn creates later can be counted as additions.
 */
async function captureLiveBaseline(cwd) {
  const root = await gitTopLevel(cwd);
  if (root === undefined) return undefined;
  const stashed = ((await gitRun(root, ['stash', 'create'])) ?? '').trim();
  const head = ((await gitRun(root, ['rev-parse', 'HEAD'])) ?? '').trim();
  const ref = stashed !== '' ? stashed : head;
  if (ref === '') return undefined;
  const others = (await gitRun(root, ['ls-files', '--others', '--exclude-standard'])) ?? '';
  return { root, ref, untrackedAtStart: new Set(others.split(/\r?\n/).filter((line) => line !== '')) };
}

/** Line counts of one file, or why it cannot be counted. */
function countFileLines(absolute) {
  try {
    const data = readFileSync(absolute);
    if (data.length > MAX_LIVE_FILE_BYTES) return { oversized: true };
    if (data.includes(0)) return { binary: true };
    const text = data.toString('utf8');
    if (text === '') return { lines: 0 };
    return { lines: text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length };
  } catch {
    return undefined;
  }
}

/**
 * One `git diff --numstat -z` output as per-file counts. A rename carries an
 * empty path followed by the old and the new path, which is why the parse walks
 * records instead of splitting on newlines.
 */
function parseNumstat(output) {
  const entries = [];
  const parts = output.split('\0');
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (record === '' || record === undefined) continue;
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(record);
    if (match === null) continue;
    let path = match[3];
    if (path === '') {
      const oldPath = parts[index + 1] ?? '';
      path = parts[index + 2] ?? oldPath;
      index += 2;
    }
    if (path === '') continue;
    const binary = match[1] === '-' || match[2] === '-';
    entries.push({
      path,
      display: path,
      added: binary ? 0 : Number(match[1]),
      deleted: binary ? 0 : Number(match[2]),
      binary,
      oversized: false,
    });
  }
  return entries;
}

/** Every untracked path from one `git status --porcelain -z` output. */
function parseUntracked(output) {
  const paths = [];
  const parts = output.split('\0');
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (record === undefined || record.length < 4) continue;
    const code = record.slice(0, 2);
    if (code === '??') paths.push(record.slice(3));
    else if (code.includes('R') || code.includes('C')) index += 1;
  }
  return paths;
}

/** The live summary of one running turn, or null when nothing changed yet. */
async function computeLiveChanges(state) {
  const baseline = await state.baseline;
  if (baseline === undefined) return null;
  const { root, ref, untrackedAtStart } = baseline;
  const numstat = (await gitRun(root, ['diff', '--numstat', '-z', '--find-renames', ref])) ?? '';
  const files = new Map();
  for (const entry of parseNumstat(numstat)) files.set(entry.path, entry);
  const status = (await gitRun(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) ?? '';
  for (const path of parseUntracked(status)) {
    if (untrackedAtStart.has(path) || files.has(path)) continue;
    const counted = countFileLines(join(root, path));
    if (counted === undefined) continue;
    files.set(path, {
      path,
      display: path,
      added: typeof counted.lines === 'number' ? counted.lines : 0,
      deleted: 0,
      binary: counted.binary === true,
      oversized: counted.oversized === true,
    });
  }
  const sorted = [...files.values()].sort((left, right) => left.display.localeCompare(right.display));
  const summary = {
    turn: state.turn,
    total: sorted.length,
    added: sorted.reduce((sum, file) => sum + file.added, 0),
    deleted: sorted.reduce((sum, file) => sum + file.deleted, 0),
    files: sorted.slice(0, MAX_LIVE_FILES),
    live: true,
  };
  return summary.total === 0 ? null : summary;
}

/** The live summary for one session, cached briefly so polling stays cheap. */
async function liveChangesOf(state) {
  if (state === undefined) return null;
  const now = Date.now();
  if (now - state.cache.at < LIVE_CACHE_MS) return state.cache.changes;
  const changes = await computeLiveChanges(state);
  state.cache = { at: Date.now(), changes };
  return changes;
}

/** Open a live baseline at `turn/start` and close it at `turn/end`. */
function trackLiveState(liveBySession, cwdBySession, session, event) {
  if (!event) return;
  const sessionId = session && (session.header?.id ?? session.id);
  if (typeof sessionId !== 'string' || sessionId === '') return;
  if (event.type === 'turn/start') {
    const cwd = (session && session.header && typeof session.header.cwd === 'string' && session.header.cwd !== '')
      ? session.header.cwd
      : cwdBySession.get(sessionId);
    if (typeof cwd !== 'string' || cwd === '') return;
    liveBySession.set(sessionId, {
      cwd,
      turn: Number.isFinite(event.data?.turn) ? event.data.turn : 0,
      running: true,
      baseline: captureLiveBaseline(cwd),
      cache: { at: 0, changes: null },
    });
    if (liveBySession.size > MAX_TRACKED_SESSIONS) liveBySession.delete(liveBySession.keys().next().value);
    return;
  }
  const state = liveBySession.get(sessionId);
  if (state !== undefined && event.type === 'turn/end') state.running = false;
}

/** One file's unified diff against the turn baseline, or undefined when unknown. */
async function liveDiffOf(liveBySession, sessionId, requestPath) {
  const state = liveBySession.get(sessionId);
  if (state === undefined) return undefined;
  const baseline = await state.baseline;
  if (baseline === undefined) return undefined;
  const relative = String(requestPath ?? '').trim().replaceAll('\\', '/');
  if (relative === '' || relative.startsWith('/') || relative.split('/').includes('..')) return undefined;
  const { root, ref } = baseline;
  const tracked = await gitRun(root, ['diff', '--no-color', '--unified=3', ref, '--', relative]);
  if (tracked !== undefined && tracked !== '') return tracked;
  const absolute = join(root, relative);
  // A symlink inside the repository must not become a window onto a file
  // outside it, so the resolved target is checked against the repository root.
  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = root;
  }
  let realFile;
  try {
    realFile = realpathSync(absolute);
  } catch {
    realFile = absolute;
  }
  const rootPrefix = realRoot.toLowerCase() + sep;
  if (realFile.toLowerCase() !== realRoot.toLowerCase() && !realFile.toLowerCase().startsWith(rootPrefix)) return '';
  const counted = countFileLines(absolute);
  if (counted === undefined || counted.binary === true || counted.oversized === true) return '';
  const text = readFileSync(absolute, 'utf8');
  const lines = text === '' ? [] : (text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n'));
  const header = [
    `diff --git a/${relative} b/${relative}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relative}`,
    `@@ -0,0 +1,${lines.length} @@`,
  ];
  return `${[...header, ...lines.map((line) => `+${line}`)].join('\n')}\n`;
}

/** Bound one diff so a huge file cannot stall the Client. */
function truncateDiff(diff) {
  if (Buffer.byteLength(diff, 'utf8') <= MAX_DIFF_BYTES) return { diff, truncated: false };
  return { diff: Buffer.from(diff, 'utf8').subarray(0, MAX_DIFF_BYTES).toString('utf8'), truncated: true };
}

// ---------------------------------------------------------------------------------------------
// Native file actions.
// ---------------------------------------------------------------------------------------------

/**
 * Spawn a detached native command; resolves whether it accepted the request.
 * The child must stay visible: `windowsHide` also applies Explorer's folder
 * window and the shell's Open-With dialog, which then never appears.
 */
function spawnDetached(command, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: false, detached: true, stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

function openDefault(path) {
  if (process.platform === 'win32') {
    // ShellExecute via Start-Process, then activate the app window: the Host
    // cannot steal the foreground, so the launch would otherwise stay behind.
    const quoted = path.replace(/'/g, "''");
    const script = [
      `$path = '${quoted}'`,
      'Start-Process -FilePath $path',
      'Start-Sleep -Milliseconds 500',
      '$name = [System.IO.Path]::GetFileName($path)',
      '$wsh = New-Object -ComObject WScript.Shell',
      'if ($name) { [void]$wsh.AppActivate($name) }',
      '$wsh = $null',
    ].join('; ');
    return spawnDetached('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      script,
    ]);
  }
  if (process.platform === 'darwin') return spawnDetached('open', [path]);
  return spawnDetached('xdg-open', [path]);
}

function revealPath(path, isDirectory) {
  if (process.platform === 'win32') {
    // Open the containing folder through the Shell COM server, then activate the
    // window: a process spawned by the Host cannot steal the foreground, so the
    // window would otherwise stay hidden behind the app.
    const folder = isDirectory ? path : dirname(path);
    const quoted = folder.replace(/'/g, "''");
    const script = [
      `$folder = '${quoted}'`,
      '$shell = New-Object -ComObject Shell.Application',
      '$shell.Explore($folder)',
      'Start-Sleep -Milliseconds 250',
      '$name = [System.IO.Path]::GetFileName($folder)',
      '$wsh = New-Object -ComObject WScript.Shell',
      'if ($name) { [void]$wsh.AppActivate($name) }',
      "$wsh = $null; $shell = $null",
    ].join('; ');
    return spawnDetached('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      script,
    ]);
  }
  if (process.platform === 'darwin') return spawnDetached('open', ['-R', path]);
  return spawnDetached('xdg-open', [isDirectory ? path : dirname(path)]);
}

/** The OS "Open with…" picker: lets the user choose any installed application. */
function openWithPicker(path) {
  if (process.platform === 'win32') {
    return spawnDetached('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', path]);
  }
  if (process.platform === 'darwin') {
    return spawnDetached('open', ['-R', path]);
  }
  return spawnDetached('xdg-open', [path]);
}

/** Resolve a link path into a Host absolute path; undefined when it cannot be trusted. */
function resolveLinkPath(rawPath, cwd) {  if (typeof rawPath !== 'string') return undefined;
  let path = rawPath.trim();
  if (path === '') return undefined;
  if (path.startsWith('file://')) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      return undefined;
    }
  }
  path = path.replace(/^["'`]|["'`]$/g, '');
  // UNC and device paths reach a network share or a console handle: opening one
  // can hand an SMB challenge to a stranger, so they are never followed.
  if (/^[\\/]{2}/.test(path)) return undefined;
  if (process.platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  if (path.startsWith('~/') || path === '~') {
    path = join(homedir(), path.slice(1));
  }
  if (!isAbsolute(path)) {
    const base = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
    path = join(base, path);
  }
  return normalize(path);
}

/** Bounded diagnostics for the file actions: one JSON line per request. */
function logOpen(entry) {
  try {
    const dir = storeDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'open.log'), `${new Date().toISOString()} ${JSON.stringify(entry)}\n`);
  } catch {
    /* diagnostics must never break the action */
  }
}

/** Use the Host's native opener (the same service the built-in open-in-app uses). */
async function nativeOpen(ctx, path, action, application) {
  const controller = ctx.get('sessionController');
  if (!controller || typeof controller.openWorkspacePath !== 'function') return undefined;
  try {
    const request =
      action === 'reveal'
        ? { path, action: 'reveal' }
        : typeof application === 'string' && application !== ''
          ? { path, application }
          : { path };
    const result = await controller.openWorkspacePath(request, new AbortController().signal);
    return result !== null && result !== undefined && result.opened === true;
  } catch (error) {
    logOpen({ action, path, nativeError: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/** Query one registry value; an empty string when the key or value is absent. */
async function regQuery(args) {
  try {
    const { stdout } = await execFileAsync('reg.exe', args, { windowsHide: true, maxBuffer: 1 << 20 });
    return stdout;
  } catch {
    return '';
  }
}

/** The first REG_SZ value in one `reg query` output. */
function regString(output) {
  for (const line of output.split(/\r?\n/)) {
    const match = /REG_SZ\s+(.+?)\s*$/.exec(line);
    if (match !== null) return match[1].trim();
  }
  return '';
}

/** Resolve one executable name to its installed path through App Paths. */
async function resolveExecutable(name) {
  for (const hive of ['HKLM', 'HKCU']) {
    const output = await regQuery([
      'query',
      `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${name}`,
      '/ve',
    ]);
    const value = regString(output);
    if (value !== '' && existsSync(value)) return value;
  }
  return undefined;
}

/**
 * List the applications registered for a file extension from the shell's own
 * OpenWithList, resolving each executable through App Paths. This deliberately
 * avoids SHAssocEnumHandlers: that COM query fails with E_FAIL when the Host
 * runs without an interactive shell.
 */
async function extensionApplications(path) {
  if (process.platform !== 'win32') return [];
  const ext = extname(path).toLowerCase();
  if (ext === '') return [];
  const output = await regQuery([
    'query',
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\OpenWithList`,
  ]);
  const names = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_SZ\s+(.+?)\s*$/.exec(line);
    if (match === null || match[1] === 'MRUList') continue;
    const value = match[2].trim();
    if (/\.exe$/i.test(value) && !names.includes(value)) names.push(value);
  }
  const apps = [];
  for (const name of names.slice(0, 12)) {
    const exePath = await resolveExecutable(name);
    if (exePath === undefined) continue;
    apps.push({
      id: exePath,
      name: basename(exePath, extname(exePath)) || name,
      default: false,
      icon: null,
    });
  }
  return apps;
}

async function handleOpen(req, res, cwdBySession, ctx) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  const body = await readBody(req, 64 * 1024);
  if (body === undefined || body.length === 0) {
    sendJson(res, 400, { error: 'missing request body' });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body' });
    return;
  }
  if (payload === null || typeof payload !== 'object') {
    sendJson(res, 400, { error: 'invalid request body' });
    return;
  }
  const action = payload.action === 'reveal' ? 'reveal' : payload.action === 'pick' ? 'pick' : 'open';
  // The Session decides where a relative link resolves; a request cannot name an
  // arbitrary base directory.
  const cwd = typeof payload.session === 'string' ? cwdBySession.get(payload.session) : undefined;
  logOpen({ action, input: payload.path, cwd, platform: process.platform });
  const path = resolveLinkPath(payload.path, cwd);
  if (path === undefined) {
    logOpen({ action, error: 'missing path' });
    sendJson(res, 400, { error: 'missing path' });
    return;
  }
  let stats;
  try {
    stats = statSync(path);
  } catch {
    logOpen({ action, path, error: 'not found' });
    sendJson(res, 404, { error: `file not found: ${path}` });
    return;
  }
  if (!stats.isFile() && !stats.isDirectory()) {
    logOpen({ action, path, error: 'not a file or directory' });
    sendJson(res, 400, { error: 'not a regular file or directory' });
    return;
  }
  const isDirectory = stats.isDirectory();
  const application = typeof payload.application === 'string' && payload.application !== '' ? payload.application : undefined;
  // A configured application is an executable path: launch it directly with
  // the file. Everything else goes through the Host's native association.
  // Only an application the OS itself offered for this extension may be
  // launched; a request cannot name an arbitrary executable.
  const allowedApplications =
    application === undefined ? [] : await extensionApplications(path);
  const applicationExe =
    application !== undefined &&
    /\.exe$/i.test(application) &&
    existsSync(application) &&
    allowedApplications.some((candidate) => candidate.id.toLowerCase() === application.toLowerCase())
      ? application
      : undefined;
  if (application === undefined && action === 'open' && !isDirectory && RUNNABLE_EXTENSIONS.has(extname(path).toLowerCase())) {
    logOpen({ action, path, error: 'refused to run an executable' });
    sendJson(res, 400, { error: 'refusing to run an executable; use "open with another app" instead' });
    return;
  }
  if (applicationExe !== undefined) {
    const launched = await spawnDetached(applicationExe, [path]);
    logOpen({ action, path, application: applicationExe, launched });
    sendJson(res, launched ? 200 : 500, launched ? { ok: true, path } : { error: 'application launch failed' });
    return;
  }
  if (action !== 'pick') {
    const native = await nativeOpen(ctx, path, action, applicationExe);
    logOpen({ action, path, native, application });
    if (native === true) {
      sendJson(res, 200, { ok: true, path });
      return;
    }
  }
  const ok =
    action === 'reveal'
      ? await revealPath(path, isDirectory)
      : action === 'pick'
        ? await openWithPicker(path)
        : await openDefault(path);
  logOpen({ action, path, isDirectory, ok });
  if (!ok) {
    sendJson(res, 500, { error: 'native opener failed' });
    return;
  }
  sendJson(res, 200, { ok: true, path });
}

/** List the OS applications registered for one link path. */
async function handleApps(req, res, cwdBySession, ctx) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const cwd =
    url.searchParams.get('session') !== null ? cwdBySession.get(url.searchParams.get('session')) : undefined;
  const path = resolveLinkPath(url.searchParams.get('path') ?? '', cwd);
  if (path === undefined) {
    sendJson(res, 400, { error: 'missing path' });
    return;
  }
  const apps = await extensionApplications(path);
  logOpen({ action: 'apps', path, count: apps.length });
  sendJson(res, 200, { ok: true, apps });
}

/**
 * Answer a request that fails the Host/Origin fence or carries no live browser
 * session, the way the Host's own routes do. Every route below is reachable
 * from any page the browser loads, so this is checked before anything runs.
 * @returns whether the request was refused.
 */
function rejectUntrusted(ctx, req, res) {
  const connection = ctx.get('connection');
  if (!connection || typeof connection.requestRejection !== 'function') return false;
  const rejection = connection.requestRejection(req);
  if (rejection === undefined) return false;
  res.writeHead(rejection, { 'cache-control': 'no-store' });
  res.end();
  return true;
}

async function handleRequest(req, res, changesBySession, cwdBySession, liveBySession, completions, ctx) {
  try {
    if (rejectUntrusted(ctx, req, res)) return;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === OPEN_PATH) {
      await handleOpen(req, res, cwdBySession, ctx);
      return;
    }
    if (url.pathname === APPS_PATH) {
      await handleApps(req, res, cwdBySession, ctx);
      return;
    }
    if (url.pathname === CHANGES_PATH) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      const sessionId = url.searchParams.get('session') ?? '';
      const recorded = changesBySession.get(sessionId);
      if (recorded !== undefined) {
        sendJson(res, 200, { changes: recorded, running: false });
        return;
      }
      const state = liveBySession.get(sessionId);
      const changes = await liveChangesOf(state);
      sendJson(res, 200, { changes, running: state !== undefined && state.running === true });
      return;
    }
    if (url.pathname === COMPLETIONS_PATH) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      const raw = url.searchParams.get('after');
      const parsed = raw === null ? Number.NaN : Number(raw);
      // Without a cursor the Client only learns where the queue stands, so a
      // page load never replays notices the user already saw.
      const list = Number.isFinite(parsed)
        ? completions.list.filter((item) => item.id > parsed)
        : [];
      sendJson(res, 200, { completions: list, last: completions.next });
      return;
    }
    if (url.pathname === LIVE_DIFF_PATH) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      const sessionId = url.searchParams.get('session') ?? '';
      const diff = await liveDiffOf(liveBySession, sessionId, url.searchParams.get('path') ?? '');
      if (diff === undefined) {
        sendJson(res, 404, { error: 'no live diff for this turn' });
        return;
      }
      const bounded = truncateDiff(diff);
      sendJson(res, 200, { diff: bounded.diff, truncated: bounded.truncated });
      return;
    }
    if (url.pathname !== SOUND_PATH) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveSound(req, res);
      return;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      await saveSound(req, res);
      return;
    }
    if (req.method === 'DELETE') {
      deleteSound(res);
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

/** Move the pre-rename store directory into place once, so the custom sound survives. */
function migrateLegacyStore() {
  try {
    const legacy = join(dshHome(), LEGACY_STORE_DIR_NAME);
    const current = storeDir();
    if (existsSync(current) || !existsSync(legacy)) return;
    renameSync(legacy, current);
  } catch {
    /* a locked legacy directory simply keeps living next to the new one */
  }
}

export function apply(ctx) {
  migrateLegacyStore();
  // Resolve git the way the Host does (a GUI process may not inherit a shell
  // PATH); the plain name stays the fallback when the capability is absent.
  void (async () => {
    try {
      const subprocess = ctx.get('subprocess');
      if (!subprocess || typeof subprocess.resolveExecutable !== 'function') return;
      const resolved = await subprocess.resolveExecutable('git', undefined, new AbortController().signal);
      if (typeof resolved === 'string' && resolved !== '') gitExecutable = resolved;
    } catch {
      /* the live summary simply stays unavailable */
    }
  })();
  const changesBySession = new Map();
  const cwdBySession = new Map();
  const liveBySession = new Map();
  // Finished turns of every Session, drained by the browser half's poll.
  const completions = { next: 0, list: [], excerpts: new Map() };

  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        trackSessionCwd(cwdBySession, session, event);
        trackSessionEvent(ctx, changesBySession, completions, session, event);
        trackLiveState(liveBySession, cwdBySession, session, event);
      }),
    'dsh-interaction-optimize: workspace changes',
  );

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: (req, res) => handleRequest(req, res, changesBySession, cwdBySession, liveBySession, completions, ctx),
        }),
      'dsh-interaction-optimize: sound, changes and file routes',
    );
  });
}
