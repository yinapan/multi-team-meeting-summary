const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

function getWps365CliPath(config = {}) {
  const configured = config.cliPath || process.env.WPS365_CLI_PATH;
  if (configured) return configured;
  if (process.platform === 'win32') {
    return path.join(os.homedir(), '.wps365', 'bin', 'wps365-cli.exe');
  }
  return 'wps365-cli';
}

function getWps365CliEnv(config = {}) {
  const env = { ...process.env, ...(config.env || {}) };
  const accessToken = env.WPS365_ACCESS_TOKEN || config.accessToken || config.token;
  if (accessToken) env.WPS365_ACCESS_TOKEN = accessToken;
  return env;
}

function buildWps365Args(args = [], output = 'json') {
  return ['--output', output, '--no-color', '--quiet', ...args];
}

function runWps365Cli(args, options = {}) {
  const {
    config = {},
    timeout = 30000,
    output = 'json'
  } = options;

  return new Promise((resolve) => {
    const child = spawn(getWps365CliPath(config), buildWps365Args(args, output), {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: getWps365CliEnv(config)
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);

    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('close', code => {
      clearTimeout(timer);
      const error = code !== 0 || !stdout
        ? (timedOut ? `timeout after ${timeout}ms` : (stderr || `exit code ${code}`))
        : null;
      resolve({ error, stdout: stdout || null, stderr, code });
    });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ error: error.message, stdout: stdout || null, stderr, code: null });
    });
  });
}

function runWps365CliSync(args, options = {}) {
  const {
    config = {},
    timeout = 30000,
    output = 'json'
  } = options;
  try {
    const stdout = execFileSync(getWps365CliPath(config), buildWps365Args(args, output), {
      encoding: 'utf-8',
      timeout,
      windowsHide: true,
      env: getWps365CliEnv(config)
    });
    return { error: stdout ? null : 'empty output', stdout: stdout || null, stderr: '', code: 0 };
  } catch (error) {
    const stdout = error.stdout ? String(error.stdout) : null;
    const stderr = error.stderr ? String(error.stderr) : '';
    return {
      error: stderr || error.message,
      stdout,
      stderr,
      code: typeof error.status === 'number' ? error.status : null
    };
  }
}

function parseWps365Json(stdout) {
  if (!stdout) throw new Error('WPS 365 CLI returned empty output');
  return JSON.parse(stdout);
}

function getWps365ResponseData(payload) {
  if (!payload || typeof payload !== 'object') return {};
  return (payload.data && payload.data.data) || payload.data || payload;
}

function getWps365ApiError(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const code = payload.code;
  if (code === undefined || code === null || code === 0 || code === '0') return null;
  const data = getWps365ResponseData(payload);
  const message = payload.message || payload.msg || payload.error || data.message || data.msg || '';
  return { code, message: String(message || '') };
}

function getWps365FileList(payload) {
  const data = getWps365ResponseData(payload);
  return {
    items: Array.isArray(data.items) ? data.items : [],
    nextPageToken: data.next_page_token || data.page_token || null
  };
}

function unwrapWps365SearchItem(item) {
  return item && item.file ? item.file : item;
}

function appendFlag(args, name, value) {
  if (value === undefined || value === null || value === '') return;
  args.push(name, String(value));
}

function buildWps365ListArgs({ driveId, parentId, pageSize = 500, pageToken = null } = {}) {
  const args = ['drive', 'files', 'list', String(driveId), String(parentId)];
  appendFlag(args, '--page-size', pageSize);
  appendFlag(args, '--page-token', pageToken);
  return args;
}

function buildWps365SearchArgs(options = {}) {
  const args = ['drive', 'files', 'search'];
  appendFlag(args, '--type', options.type || 'all');
  appendFlag(args, '--drive-ids', (options.drive_ids || []).join(','));
  appendFlag(args, '--parent-ids', (options.parent_ids || []).join(','));
  appendFlag(args, '--file-exts', (options.file_exts || []).join(','));
  appendFlag(args, '--file-type', options.file_type);
  appendFlag(args, '--keyword', options.keyword);
  appendFlag(args, '--page-size', options.page_size || 500);
  appendFlag(args, '--page-token', options.page_token);
  return args;
}

function buildWps365ContentArgs({ driveId, fileId, format = 'markdown' } = {}) {
  const args = ['drive', 'file-content', 'get', String(driveId), String(fileId)];
  appendFlag(args, '--format', format);
  return args;
}

function extractRangeData(value) {
  if (!value || typeof value !== 'object') return '';
  const cells = value.range_data?.detail?.rangeData;
  if (!Array.isArray(cells)) return '';
  return cells
    .map(cell => cell && (cell.cellText || cell.originalCellValue || ''))
    .filter(Boolean)
    .join('\n');
}

function extractWps365Content(payload) {
  const data = getWps365ResponseData(payload);
  for (const key of ['markdown', 'plain', 'html', 'content']) {
    if (typeof data[key] === 'string' && data[key]) return data[key];
  }
  const rangeText = extractRangeData(data.content || data);
  return rangeText || '';
}

module.exports = {
  getWps365CliPath,
  getWps365CliEnv,
  buildWps365Args,
  runWps365Cli,
  runWps365CliSync,
  parseWps365Json,
  getWps365ResponseData,
  getWps365ApiError,
  getWps365FileList,
  unwrapWps365SearchItem,
  buildWps365ListArgs,
  buildWps365SearchArgs,
  buildWps365ContentArgs,
  extractWps365Content
};
