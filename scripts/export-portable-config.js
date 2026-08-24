const fs = require('fs');
const path = require('path');

const sourcePath = path.resolve(process.argv[2] || 'config.json');
const targetPath = path.resolve(process.argv[3] || 'config.portable.json');
const config = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

if (config.wps365) {
  delete config.wps365.accessToken;
  delete config.wps365.token;
  if (config.wps365.env) delete config.wps365.env.WPS365_ACCESS_TOKEN;
}
if (config.kdocs) delete config.kdocs.token;

fs.writeFileSync(targetPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
console.log(`Portable configuration written: ${path.relative(process.cwd(), targetPath)}`);
