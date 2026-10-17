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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, normalize } from 'node:path';
import { homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROUTE_PREFIX = '/dsh-interaction-optimize';
const SOUND_PATH = `${ROUTE_PREFIX}/sound`;
const CHANGES_PATH = `${ROUTE_PREFIX}/changes`;
const OPEN_PATH = `${ROUTE_PREFIX}/open`;
const APPS_PATH = `${ROUTE_PREFIX}/apps`;
const STORE_DIR_NAME = 'dsh-interaction-optimize';
/** The pre-rename store directory; migrated once when present. */
const LEGACY_STORE_DIR_NAME = 'codex-like';
const META_FILE = 'sound.json';
const MAX_SOUND_BYTES = 4 * 1024 * 1024;
const MAX_TRACKED_SESSIONS = 64;
const MAX_FILES_IN_RESPONSE = 30;

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

/** Remember the summary announced by one `workspace/changes` event. */
function trackSessionEvent(ctx, changesBySession, session, event) {
  if (!event) return;
  const sessionId = session && (session.header?.id ?? session.id);
  if (typeof sessionId !== 'string' || sessionId === '') return;
  // A fresh turn starts from a clean badge: the previous turn's summary no
  // longer describes what this turn is changing.
  if (event.type === 'turn/start') {
    changesBySession.delete(sessionId);
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
  const cwd =
    typeof payload.cwd === 'string' && isAbsolute(payload.cwd)
      ? payload.cwd
      : typeof payload.session === 'string'
        ? cwdBySession.get(payload.session)
        : undefined;
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
  const applicationExe =
    application !== undefined && /\.exe$/i.test(application) && existsSync(application) ? application : undefined;
  if (applicationExe !== undefined) {
    const launched = await spawnDetached(applicationExe, [path]);
    logOpen({ action, path, application: applicationExe, launched });
    sendJson(res, launched ? 200 : 500, launched ? { ok: true, path } : { error: 'application launch failed' });
    return;
  }
  if (action !== 'pick') {
    const native = await nativeOpen(ctx, path, action, application);
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
    url.searchParams.get('cwd') ??
    (url.searchParams.get('session') !== null ? cwdBySession.get(url.searchParams.get('session')) : undefined);
  const path = resolveLinkPath(url.searchParams.get('path') ?? '', cwd);
  if (path === undefined) {
    sendJson(res, 400, { error: 'missing path' });
    return;
  }
  const apps = await extensionApplications(path);
  logOpen({ action: 'apps', path, count: apps.length });
  sendJson(res, 200, { ok: true, apps });
}

async function handleRequest(req, res, changesBySession, cwdBySession, ctx) {
  try {
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
      sendJson(res, 200, { changes: changesBySession.get(sessionId) ?? null });
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
  const changesBySession = new Map();
  const cwdBySession = new Map();

  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        trackSessionCwd(cwdBySession, session, event);
        trackSessionEvent(ctx, changesBySession, session, event);
      }),
    'dsh-interaction-optimize: workspace changes',
  );

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: (req, res) => handleRequest(req, res, changesBySession, cwdBySession, ctx),
        }),
      'dsh-interaction-optimize: sound, changes and file routes',
    );
  });
}
