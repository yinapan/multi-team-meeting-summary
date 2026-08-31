const https = require('https');

function requestShortUrl(longUrl) {
  return new Promise((resolve, reject) => {
    const request = https.request(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`, {
      method: 'GET',
      timeout: 30000
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        const result = text.trim();
        if (response.statusCode < 200 || response.statusCode >= 300 || !/^https:\/\/tinyurl\.com\//.test(result)) {
          reject(new Error(`TinyURL request failed (HTTP ${response.statusCode})`));
          return;
        }
        resolve(result);
      });
    });
    request.on('timeout', () => request.destroy(new Error('TinyURL request timed out')));
    request.on('error', reject);
    request.end();
  });
}

function requestCleanUriUrl(longUrl) {
  return new Promise((resolve, reject) => {
    const body = `url=${encodeURIComponent(longUrl)}`;
    const request = https.request('https://cleanuri.com/api/v1/shorten', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 30000
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          reject(new Error(`CleanURI returned invalid JSON (HTTP ${response.statusCode})`));
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300 || !payload.result_url) {
          reject(new Error(payload.error || `CleanURI request failed (HTTP ${response.statusCode})`));
          return;
        }
        resolve(payload.result_url);
      });
    });
    request.on('timeout', () => request.destroy(new Error('CleanURI request timed out')));
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function main() {
  const longUrl = process.argv.slice(2).join(' ').trim();
  if (!longUrl) {
    console.error('用法: npm run kanban:shorten -- <发布后的长看板链接>');
    process.exitCode = 1;
    return;
  }

  try {
    console.log(await requestShortUrl(longUrl));
  } catch (error) {
    try {
      console.log(await requestCleanUriUrl(longUrl));
    } catch (fallbackError) {
      console.error(`短链生成失败: ${error.message}; 备用服务失败: ${fallbackError.message}`);
      process.exitCode = 1;
    }
  }
}

if (require.main === module) main();

module.exports = { requestShortUrl };
