const fs = require('fs');
const path = require('path');
const {
  buildWps365ListArgs,
  getWps365ResponseData,
  parseWps365Json,
  runWps365CliSync
} = require('./wps365-client');

function getOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function fail(message, code = 1) {
  console.error(`WPS 365 check failed: ${message}`);
  process.exit(code);
}

function loadProjectConfig() {
  const configPath = path.join(__dirname, '..', 'config.json');
  if (!fs.existsSync(configPath)) fail('config.json is missing; run setup-wps365.bat first.');
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function callJson(args, config) {
  const result = runWps365CliSync(args, { config, timeout: 60000 });
  if (result.error) fail(String(result.error).trim());
  return parseWps365Json(result.stdout);
}

function findProbeSource(config) {
  for (const team of config.teams || []) {
    for (const source of team.sources || []) {
      if (source.drive_id && source.root_folder_id) return source;
    }
  }
  return null;
}

const config = loadProjectConfig();
const expectedUser = getOption('--expected-user');
const me = getWps365ResponseData(callJson(['user', 'me'], config));
const userName = me.user_name || me.name || '';

if (!userName) fail('the CLI did not return the current user.');
if (expectedUser && userName !== expectedUser) {
  fail(`authorized user is "${userName}", expected "${expectedUser}".`, 3);
}

if (process.argv.includes('--probe')) {
  const source = findProbeSource(config);
  if (!source) fail('config.json has no WPS 365 source available for a permission probe.');
  callJson(buildWps365ListArgs({
    driveId: source.drive_id,
    parentId: source.root_folder_id,
    pageSize: 1
  }), config);
}

console.log(`WPS 365 ready: ${userName}${process.argv.includes('--probe') ? ' (document access verified)' : ''}`);
