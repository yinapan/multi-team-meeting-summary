const path = require('path');
const fs = require('fs');
const { execSync, execFile, execFileSync } = require('child_process');

const KDOCS_CLI = process.env.KDOCS_CLI_PATH || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'kdocs-cli', 'kdocs-cli.exe') : 'kdocs-cli');

try {
  require.resolve('docx');
} catch (_) {
  console.log('首次运行，安装依赖...');
  execSync('npm install --production', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
}

const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        Header, Footer, AlignmentType, HeadingLevel, PageNumber, PageBreak,
        BorderStyle, WidthType, ShadingType, VerticalAlign, LevelFormat } = require('docx');

// ========== 缓存 ==========
const CACHE_DIR = path.join(__dirname, '..', 'cache');
const FOLDER_CACHE_TTL = parseInt(process.env.KDOCS_CACHE_TTL_MS, 10) || 3600000;
const RETRY_CODES = new Set([429001, 429002, 429003]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { const end = Date.now() + ms; while (Date.now() < end); }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== 异步并发控制 ==========
class RequestPacer {
  constructor(options = {}) {
    this.maxConcurrent = parseInt(process.env.KDOCS_FOLDER_CONCURRENCY, 10) || options.maxConcurrent || 3;
    this.minIntervalMs = parseInt(process.env.KDOCS_MIN_INTERVAL_MS, 10) || options.minIntervalMs || 300;
    this.active = 0;
    this.queue = [];
    this.lastRequestTime = 0;
  }

  acquire() {
    return new Promise(resolve => {
      const tryRun = () => {
        if (this.active >= this.maxConcurrent) {
          this.queue.push(tryRun);
          return;
        }
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.minIntervalMs) {
          setTimeout(tryRun, this.minIntervalMs - elapsed);
          return;
        }
        this.active++;
        this.lastRequestTime = Date.now();
        resolve();
      };
      tryRun();
    });
  }

  release() {
    this.active--;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next();
    }
  }
}

function teamCacheDir(teamName) {
  return path.join(CACHE_DIR, teamName || '_default');
}
function teamDocsCacheDir(teamName) {
  return path.join(teamCacheDir(teamName), 'docs');
}
function teamFoldersCacheDir(teamName) {
  return path.join(teamCacheDir(teamName), 'folders');
}

function ensureCacheDir(teamName) {
  for (const d of [teamDocsCacheDir(teamName), teamFoldersCacheDir(teamName)]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function readCache(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return null; }
}

function writeCache(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
  } catch {}
}

function clearFolderCache(teamName) {
  try {
    const dir = teamFoldersCacheDir(teamName);
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
    }
  } catch {}
}

// ========== 样式常量 ==========
const C = {
  primary: "2E75B6", lightBlue: "EBF5FB", border: "BFCBD9", text: "1A202C",
  red: "C00000", orange: "ED7D31", white: "FFFFFF", gray: "718096",
  h1: "1A4B8C", h2: "2E75B6", h3: "4A5568"
};
const FONT = "微软雅黑";

// ========== 表格/段落工具函数 ==========
const cellBorder = { style: BorderStyle.SINGLE, size: 1, color: C.border };
const cellBorders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };

function hCell(t, w) {
  return new TableCell({
    borders: cellBorders, width: { size: w, type: WidthType.DXA },
    shading: { fill: C.primary, type: ShadingType.CLEAR },
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [new Paragraph({ children: [new TextRun({ text: t, bold: true, color: C.white, font: FONT, size: 18 })] })]
  });
}

function cCell(t, w, o = {}) {
  return new TableCell({
    borders: cellBorders, width: { size: w, type: WidthType.DXA },
    shading: { fill: C.lightBlue, type: ShadingType.CLEAR },
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [new Paragraph({ children: [new TextRun({ text: t, bold: o.bold || false, color: o.color || C.text, font: FONT, size: 18 })] })]
  });
}

function bullet(t, o = {}) {
  return new Paragraph({
    numbering: { reference: "bl", level: 0 },
    spacing: { before: 80, after: 80, line: 276 },
    children: o.bold
      ? [new TextRun({ text: o.bold, bold: true, color: C.text, font: FONT, size: 20 }), new TextRun({ text: t, font: FONT, size: 20, color: C.text })]
      : [new TextRun({ text: t, font: FONT, size: 20, color: C.text })]
  });
}

function h1(t) { return new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: t, bold: true })] }); }
function h2(t) { return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: t, bold: true })] }); }
function h3(t) { return new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: t, bold: true })] }); }
function p(t, o = {}) { return new Paragraph({ spacing: { before: o.before || 160, after: o.after || 120, line: 276 }, alignment: AlignmentType.JUSTIFIED, children: [new TextRun({ text: t, bold: o.bold || false, font: FONT, size: 20, color: o.color || C.text })] }); }
function pb() { return new Paragraph({ children: [new PageBreak()] }); }

// ========== 文本清洗 ==========
function cleanText(raw) {
  let t = raw.trim();
  t = t.replace(/^→\s*(责任人|截止)[：:]*\s*[^\s•]*\s*/, '');
  t = t.replace(/[•·]\s*结论\s*\d*\s*[：:．.].*/g, '');
  t = t.replace(/[•·]\s*待决事项\s*[一二三四五六七八九十\d]*\s*[：:．.].*/g, '');
  t = t.replace(/[•·]\s*待办事项\s*[一二三四五六七八九十\d]*\s*[：:．.].*/g, '');
  t = t.replace(/^结论\s*\d*\s*[：:．.]\s*/, '');
  t = t.replace(/^待决事项\s*[一二三四五六七八九十\d]*\s*[：:．.]\s*/, '');
  t = t.replace(/^待办事项\s*[一二三四五六七八九十\d]*\s*[：:．.]\s*/, '');
  t = t.replace(/^代办\s*\d*\s*[：:．.]\s*/, '');
  t = t.replace(/^[一二三四五六七八九十]+\s*[：:．.]\s*/, '');
  t = t.replace(/^\d+\s*[.、．]\s*/, '');
  t = t.replace(/^[•·\-–—\/\\|、]+\s*/, '');
  t = t.replace(/^要点\s*\d*\s*[：:．.]\s*/, '');
  t = t.replace(/^[\[\]【】]\s*/, '');
  t = t.replace(/^[☐☑✓✗□■◻◼]\s*/, '');
  t = t.replace(/^(结论|待决事项|待办事项|代办)\s*[一二三四五六七八九十\d]*\s*[•·\/\\|：:．.]*\s*/, '');
  t = t.replace(/^[☐☑✓✗□]\s*(代办|待办)\s*\d*\s*[：:．.]*\s*/, '');
  t = t.replace(/\s*→\s*(责任人|截止)[：:]*.*$/, '');
  t = t.replace(/\s*[—–-]\s*(责任人|截止)[：:]*.*$/, '');
  t = t.replace(/\s*【负责人[：:].*$/, '');
  t = t.replace(/\s*\[负责人[：:].*$/, '');
  t = t.trim();
  if (t && !/[。！？；：,，.!?;:）\)」】》]$/.test(t)) t += '。';
  return t;
}

function isValidConclusion(text) {
  if (!text || text.length < 6) return false;
  const cleaned = text.replace(/[。.]+$/, '').replace(/^[\/\\|•·\-–—\s]+/, '').trim();
  if (!cleaned || cleaned.length < 4) return false;
  const invalid = /^(结论|后续讨论|待办|代办|待定|待确认|待跟进|待处理|待决事项|暂无|无|TBD|TODO|N\/A|\]|\[|【|】)$/i;
  if (invalid.test(cleaned)) return false;
  const labelOnly = /^[\[\]【】☐☑✓✗□■◻◼\s\-—–·•\/\\|]*$/;
  if (labelOnly.test(cleaned)) return false;
  if (/^(后续|下次|待).{0,4}(讨论|确认|跟进|沟通|对齐|同步|安排|处理)[。.]?$/.test(cleaned)) return false;
  if (/^后续(讨论|跟进|处理|确认)[。.]?$/.test(cleaned)) return false;
  if (/^(结论|待决事项|待办事项|代办)\s*\d*\s*[：:•·\/\\|]?\s*$/.test(cleaned)) return false;
  if (/^[☐☑✓✗□]\s*(代办|待办)\s*\d*\s*[：:]?\s*$/.test(cleaned)) return false;
  if (/^主题\s*[：:]/i.test(cleaned)) return false;
  if (/[【\[]/.test(cleaned) && !/[】\]]/.test(cleaned)) return false;
  if (/[】\]]/.test(cleaned) && !/[【\[]/.test(cleaned)) return false;
  if (/^.{0,20}(是否|能否|可否|有没有|有无).{0,20}[。？?]?$/.test(cleaned) && cleaned.length < 30) return false;
  if (/^(汇报|总结|回顾|同步).{0,6}(情况|进展|进度|结果)[。.]?$/.test(cleaned)) return false;
  if (/^.{2,8}(问题总结|情况汇报|进展汇报|工作汇报)[。.]?$/.test(cleaned)) return false;
  if (/^[一二三四五六七八九十\d]+[：:].{0,20}(是否|能否|怎么|如何|为何)/.test(cleaned)) return false;
  return true;
}

// ========== 建议语句生成 ==========
function makeSuggestion(risk) {
  const t = risk.text;
  const brief = t.length > 60 ? t.substring(0, 57) + '...' : t;
  const actions = {
    '短缺': '建议协调相关部门优先保障资源供给，明确补充到位时间。',
    '紧张': '建议评估各项目优先级，合理调配资源或申请外部支援。',
    '严重': '建议立即组织专项排查并制定限时整改方案。',
    '延期': '建议重新评估排期，同步相关方并明确新的交付节点。',
    '停止': '建议建立监控预警机制并制定应急预案。',
    '失败': '建议排查根因并优化流程以降低再次发生概率。',
    '泄漏': '建议加强权限管控并推进数据隔离方案落地。',
    '不达标': '建议推动优化方案落地，明确达标时间节点。',
    '风险': '建议制定应对预案并明确责任人与时间节点。',
    '危险': '建议立即采取缓解措施并上报决策层。',
    '未到位': '建议推动加速交付，明确最终到位时间。',
    '待确认': '建议尽快组织相关方会议明确决策。',
    '需关注': '建议建立定期同步机制确保进展可控。',
    '不确定': '建议补充调研数据以降低决策风险。',
    '可能影响': '建议制定预案并持续跟踪变化。',
    '需跟进': '建议明确责任人和时间节点确保闭环。',
    '待审批': '建议推动审批流程并设定预期完成时间。',
  };
  const action = actions[risk.keyword] || '建议制定应对方案并跟踪闭环。';
  return `${brief}——${action}`;
}

// ========== 文本相似度 ==========
function getBigrams(str) {
  const bigrams = new Set();
  for (let i = 0; i < str.length - 1; i++) {
    bigrams.add(str[i] + str[i + 1]);
  }
  return bigrams;
}

function textSimilar(a, b) {
  if (a === b) return 1;
  if (a.substring(0, 20) === b.substring(0, 20)) return 0.9;
  const setA = getBigrams(a);
  const setB = getBigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const bg of setA) { if (setB.has(bg)) overlap++; }
  return (2 * overlap) / (setA.size + setB.size);
}

function dedupTexts(texts, threshold = 0.6) {
  const result = [];
  for (const t of texts) {
    if (!t) continue;
    const isDup = result.some(existing => textSimilar(existing, t) > threshold);
    if (!isDup) result.push(t);
  }
  return result;
}

// ========== 日期工具函数 ==========
function currentYear() {
  return new Date().getFullYear();
}

function normalizeDate(dateArg) {
  let m = dateArg.match(/^\d{4}(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}`;
  m = dateArg.match(/^(\d{1,2})[.\-](\d{1,2})$/);
  if (m) return `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return dateArg;
}

function formatDateChinese(mmdd) {
  const m = mmdd.match(/(\d{1,2})[.\-](\d{1,2})/);
  if (!m) return mmdd;
  return `${parseInt(m[1])}月${parseInt(m[2])}日`;
}

function extractDateFromFileName(fileName) {
  const yearStr = String(currentYear());
  const yearRe = new RegExp(yearStr + '[.\\-]?(\\d{2})[.\\-]?(\\d{2})');
  let match = fileName.match(yearRe);
  if (match) return { month: parseInt(match[1]), day: parseInt(match[2]) };

  match = fileName.match(/(\d{1,2})月(\d{1,2})[日号]?/);
  if (match) return { month: parseInt(match[1]), day: parseInt(match[2]) };

  return null;
}

function dateInRange(fileName, startDate, endDate) {
  const fileDate = extractDateFromFileName(fileName);
  if (!fileDate) return false;
  const startMatch = startDate.match(/(\d{1,2})[.\-](\d{1,2})/);
  const endMatch = endDate.match(/(\d{1,2})[.\-](\d{1,2})/);
  if (!startMatch || !endMatch) return false;
  const fileNum = fileDate.month * 100 + fileDate.day;
  const startNum = parseInt(startMatch[1]) * 100 + parseInt(startMatch[2]);
  const endNum = parseInt(endMatch[1]) * 100 + parseInt(endMatch[2]);
  if (startNum <= endNum) {
    return fileNum >= startNum && fileNum <= endNum;
  }
  // Cross-year range (e.g., 12-20 to 01-15): match if >= start OR <= end
  return fileNum >= startNum || fileNum <= endNum;
}

function getWeekKey(fileName) {
  const d = extractDateFromFileName(fileName);
  if (!d) return 'unknown';
  const date = new Date(currentYear(), d.month - 1, d.day);
  const dayOfWeek = date.getDay();
  const monday = new Date(date);
  monday.setDate(date.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (dt) => `${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
  return `${fmt(monday)}-${fmt(sunday)}`;
}

// ========== KDocs CLI 工具函数 ==========
function listFolder(driveId, parentId, teamName) {
  const cacheFile = path.join(teamFoldersCacheDir(teamName), `${driveId}_${parentId}.json`);
  const cached = readCache(cacheFile);
  if (cached && (Date.now() - cached.fetched_at) < FOLDER_CACHE_TTL) {
    return cached.items;
  }

  const inputJson = JSON.stringify({ drive_id: driveId, parent_id: parentId, page_size: 500 });
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const raw = execFileSync(KDOCS_CLI, ['drive', 'list-files', '--output', 'json'], {
        input: inputJson, encoding: 'utf-8', timeout: 15000, windowsHide: true
      });
      const parsed = JSON.parse(raw);
      if (parsed && parsed.code && parsed.code !== 0) {
        if (RETRY_CODES.has(parsed.code) && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          process.stderr.write(`[listFolder] 限流 folder=${parentId} code=${parsed.code}，${(delay / 1000).toFixed(0)}s 后重试 (${attempt + 1}/${MAX_RETRIES})...\n`);
          sleepSync(delay);
          continue;
        }
        process.stderr.write(`[listFolder] API错误 folder=${parentId} code=${parsed.code}\n`);
        if (cached) return cached.items;
        return [];
      }
      const items = (parsed && parsed.data && parsed.data.data && parsed.data.data.items) || [];
      writeCache(cacheFile, { items, fetched_at: Date.now() });
      return items;
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        process.stderr.write(`[listFolder] 异常 folder=${parentId}，${(delay / 1000).toFixed(0)}s 后重试 (${attempt + 1}/${MAX_RETRIES})...\n`);
        sleepSync(delay);
        continue;
      }
      process.stderr.write(`[listFolder] 失败 folder=${parentId}: ${e.message.substring(0, 100)}\n`);
      if (cached) return cached.items;
      return [];
    }
  }
  if (cached) return cached.items;
  return [];
}

function scanFolder(driveId, folderId, startDate, endDate, teamName) {
  const files = [];
  const items = listFolder(driveId, folderId, teamName);
  for (const item of items) {
    if (item.type === 'folder') {
      files.push(...scanFolder(driveId, item.id, startDate, endDate, teamName));
    } else if (item.type === 'file' && /\.(otl|docx)$/i.test(item.name)) {
      if (dateInRange(item.name, startDate, endDate)) {
        files.push({ name: item.name, id: item.id, link: item.link_url, size: item.size, drive_id: driveId, mtime: item.mtime });
      }
    }
  }
  return files;
}

function scanFolderWithStats(driveId, folderId, startDate, endDate, teamName) {
  const files = [];
  let totalScanned = 0;
  const items = listFolder(driveId, folderId, teamName);
  for (const item of items) {
    if (item.type === 'folder') {
      const sub = scanFolderWithStats(driveId, item.id, startDate, endDate, teamName);
      files.push(...sub.files);
      totalScanned += sub.totalScanned;
    } else if (item.type === 'file' && /\.(otl|docx)$/i.test(item.name)) {
      if (dateInRange(item.name, startDate, endDate)) {
        totalScanned++;
        files.push({ name: item.name, id: item.id, link: item.link_url, size: item.size, drive_id: driveId, mtime: item.mtime });
      }
    }
  }
  return { files, totalScanned };
}

function scanFolderAll(driveId, folderId, teamName) {
  const files = [];
  const items = listFolder(driveId, folderId, teamName);
  for (const item of items) {
    if (item.type === 'folder') {
      files.push(...scanFolderAll(driveId, item.id, teamName));
    } else if (item.type === 'file' && /\.(otl|docx)$/i.test(item.name)) {
      files.push({ name: item.name, id: item.id, link: item.link_url, size: item.size, drive_id: driveId, mtime: item.mtime });
    }
  }
  return files;
}

// ========== 异步版本 KDocs 扫描 ==========
function spawnKdocsCli(args, inputJson, timeout) {
  return new Promise((resolve) => {
    const child = require('child_process').spawn(KDOCS_CLI, args, {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); }, timeout);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout) {
        resolve({ error: stderr || `exit code ${code}`, stdout: null });
        return;
      }
      resolve({ error: null, stdout });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ error: e.message, stdout: null });
    });
    child.stdin.write(inputJson);
    child.stdin.end();
  });
}

async function listFolderAsync(driveId, parentId, teamName, pacer) {
  const cacheFile = path.join(teamFoldersCacheDir(teamName), `${driveId}_${parentId}.json`);
  const cached = readCache(cacheFile);
  if (cached && (Date.now() - cached.fetched_at) < FOLDER_CACHE_TTL) {
    return cached.items;
  }

  await pacer.acquire();
  try {
    const inputJson = JSON.stringify({ drive_id: driveId, parent_id: parentId, page_size: 500 });
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const { error, stdout } = await spawnKdocsCli(
        ['drive', 'list-files', '--output', 'json'], inputJson, 15000
      );
      if (error && !stdout) {
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          process.stderr.write(`[listFolderAsync] 异常 folder=${parentId}，${(delay / 1000).toFixed(0)}s 后重试 (${attempt + 1}/${MAX_RETRIES})...\n`);
          await sleep(delay);
          continue;
        }
        process.stderr.write(`[listFolderAsync] 失败 folder=${parentId}: ${error.substring(0, 100)}\n`);
        if (cached) return cached.items;
        return [];
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed && parsed.code && parsed.code !== 0) {
          if (RETRY_CODES.has(parsed.code) && attempt < MAX_RETRIES) {
            const delay = BASE_DELAY_MS * Math.pow(2, attempt);
            process.stderr.write(`[listFolderAsync] 限流 folder=${parentId} code=${parsed.code}，${(delay / 1000).toFixed(0)}s 后重试 (${attempt + 1}/${MAX_RETRIES})...\n`);
            await sleep(delay);
            continue;
          }
          process.stderr.write(`[listFolderAsync] API错误 folder=${parentId} code=${parsed.code}\n`);
          if (cached) return cached.items;
          return [];
        }
        const items = (parsed && parsed.data && parsed.data.data && parsed.data.data.items) || [];
        writeCache(cacheFile, { items, fetched_at: Date.now() });
        return items;
      } catch (e) {
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }
        if (cached) return cached.items;
        return [];
      }
    }
    if (cached) return cached.items;
    return [];
  } finally {
    pacer.release();
  }
}

async function scanFolderAsync(driveId, folderId, startDate, endDate, teamName, pacer) {
  const items = await listFolderAsync(driveId, folderId, teamName, pacer);
  const subFolderPromises = items
    .filter(i => i.type === 'folder')
    .map(i => scanFolderAsync(driveId, i.id, startDate, endDate, teamName, pacer));
  const subResults = await Promise.all(subFolderPromises);
  const files = items
    .filter(i => i.type === 'file' && /\.(otl|docx)$/i.test(i.name) && dateInRange(i.name, startDate, endDate))
    .map(i => ({ name: i.name, id: i.id, link: i.link_url, size: i.size, drive_id: driveId, mtime: i.mtime }));
  return files.concat(subResults.flat());
}

async function scanFolderWithStatsAsync(driveId, folderId, startDate, endDate, teamName, pacer) {
  const items = await listFolderAsync(driveId, folderId, teamName, pacer);
  const subFolderPromises = items
    .filter(i => i.type === 'folder')
    .map(i => scanFolderWithStatsAsync(driveId, i.id, startDate, endDate, teamName, pacer));
  const subResults = await Promise.all(subFolderPromises);
  const matchedFiles = items
    .filter(i => i.type === 'file' && /\.(otl|docx)$/i.test(i.name) && dateInRange(i.name, startDate, endDate))
    .map(i => ({ name: i.name, id: i.id, link: i.link_url, size: i.size, drive_id: driveId, mtime: i.mtime }));
  const files = matchedFiles.concat(subResults.flatMap(r => r.files));
  const totalScanned = matchedFiles.length + subResults.reduce((s, r) => s + r.totalScanned, 0);
  return { files, totalScanned };
}

async function scanFolderAllAsync(driveId, folderId, teamName, pacer) {
  const items = await listFolderAsync(driveId, folderId, teamName, pacer);
  const subFolderPromises = items
    .filter(i => i.type === 'folder')
    .map(i => scanFolderAllAsync(driveId, i.id, teamName, pacer));
  const subResults = await Promise.all(subFolderPromises);
  const files = items
    .filter(i => i.type === 'file' && /\.(otl|docx)$/i.test(i.name))
    .map(i => ({ name: i.name, id: i.id, link: i.link_url, size: i.size, drive_id: driveId, mtime: i.mtime }));
  return files.concat(subResults.flat());
}

async function scanFolderFromDateAsync(driveId, folderId, startMonth, startDay, teamName, pacer) {
  const startNum = startMonth * 100 + startDay;
  const items = await listFolderAsync(driveId, folderId, teamName, pacer);
  const subFolderPromises = items
    .filter(i => i.type === 'folder')
    .map(i => scanFolderFromDateAsync(driveId, i.id, startMonth, startDay, teamName, pacer));
  const subResults = await Promise.all(subFolderPromises);
  const files = items
    .filter(i => {
      if (i.type !== 'file' || !/\.(otl|docx)$/i.test(i.name)) return false;
      const d = extractDateFromFileName(i.name);
      return d && (d.month * 100 + d.day) >= startNum;
    })
    .map(i => ({ name: i.name, id: i.id, link: i.link_url, size: i.size, mtime: i.mtime }));
  return files.concat(subResults.flat());
}

// ========== workspaceDir ==========
function resolveWorkspaceDir() {
  return process.env.WORKSPACE_DIR || path.resolve(__dirname, '../../..');
}

// ========== 从 Markdown 提取会议信息 ==========
function extractInfo(markdown, fileName, importantPeople) {
  const conclusions = [];
  const todos = [];
  let participants = '';
  let meetingTime = '';

  const pMatch = markdown.match(/参会[人⼈][：:]\s*([^\n]+)/);
  if (pMatch) participants = pMatch[1].trim();

  const tMatch = markdown.match(/会议时间[：:]\s*([^\n]+)/);
  if (tMatch) meetingTime = tMatch[1].trim();

  const cPatterns = [/•\s*结论\s*\d+[：:]\s*([^\n]+)/g, /结论\s*\d+[：:]\s*([^\n]+)/g];
  for (const p of cPatterns) {
    let m;
    while ((m = p.exec(markdown)) !== null) {
      const text = m[1].trim();
      if (text && !conclusions.includes(text)) conclusions.push(text);
    }
  }

  const todoSection = markdown.match(/⚠️\s*待办事项([\s\S]*?)(?=#|$)/);
  if (todoSection) {
    const lines = todoSection[1].split(/[\n]/);
    for (const line of lines) {
      const cleaned = line.replace(/^[•\-\s]+/, '').trim();
      if (cleaned.length > 5) todos.push(cleaned);
    }
  }

  const pendingPatterns = [/•\s*待决事项[一二三四五六七八九十\d]*[：:]\s*([^\n]+)/g, /•\s*待办事项[一二三四五六七八九十\d]*[：:]\s*([^\n]+)/g];
  for (const p of pendingPatterns) {
    let m;
    while ((m = p.exec(markdown)) !== null) {
      const text = m[1].trim();
      if (text && !todos.includes(text)) todos.push(text);
    }
  }

  if (conclusions.length === 0) {
    const lines = markdown.split(/[\n]/);
    for (const line of lines) {
      if (/完成|上线|优化|确认|决定|明确|通过|落地/.test(line) && line.length > 10 && line.length < 200) {
        const cleaned = line.replace(/^[•\-\s\d.]+/, '').trim();
        if (cleaned && !conclusions.includes(cleaned)) conclusions.push(cleaned);
        if (conclusions.length >= 3) break;
      }
    }
  }

  const important = importantPeople.some(name => participants.includes(name));

  return {
    name: fileName,
    participants,
    meetingTime,
    conclusions: splitConcatenated(conclusions).filter(isValidConclusion),
    todos: splitConcatenated(todos).filter(isValidConclusion),
    important,
    rawContent: markdown
  };
}

// ========== 按 sourceLabel 分组文档 ==========
function groupByLabel(documents, teamName) {
  const groups = new Map();
  for (const doc of documents) {
    const label = doc.sourceLabel || teamName;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(doc);
  }
  return groups;
}

// ========== 拆分拼接项 ==========
function splitConcatenated(items) {
  const result = [];
  for (const item of items) {
    if (!item) continue;
    const parts = item.split(/\s*•\s*/).filter(p => p.trim().length > 5);
    result.push(...parts);
  }
  return result;
}

// ========== 风险分析 ==========
const riskKeywords = {
  high: ['短缺', '紧张', '严重', '延期', '停止', '失败', '泄漏', '不达标', '风险', '危险'],
  mid: ['未到位', '待确认', '需关注', '不确定', '可能影响', '需跟进', '待审批']
};

function analyzeDocs(documents, teamName, options = {}) {
  let totalConclusions = 0, totalTodos = 0, importantCount = 0;
  let allConclusions = [], allTodos = [];

  documents.forEach(d => {
    const splitConclusions = splitConcatenated(d.conclusions || []);
    const splitTodos = splitConcatenated(d.todos || []);
    totalConclusions += splitConclusions.length;
    totalTodos += splitTodos.length;
    allConclusions.push(...splitConclusions);
    allTodos.push(...splitTodos);
    if (d.important) importantCount++;
  });

  // 从全文中补充议题标题到 allConclusions
  documents.forEach(d => {
    const raw = d.rawContent || '';
    if (!raw) return;
    const lines = raw.split('\n');
    for (const line of lines) {
      const topicMatch = line.match(/^(?:议题[一二三四五六七八九十\d]*|主题)[：:]\s*(.+)/);
      if (topicMatch) {
        const topic = topicMatch[1].trim();
        if (topic.length > 5 && !allConclusions.includes(topic)) {
          allConclusions.push(topic);
        }
      }
    }
  });

  // 风险分析：从 conclusions+todos + 全文扫描
  let riskMap = new Map();
  function addRisk(cleaned, level, matchedKw) {
    const existing = riskMap.get(cleaned);
    if (existing) {
      if (level === 'high' && existing.level === 'mid') {
        riskMap.set(cleaned, { keyword: matchedKw, text: cleaned, level: 'high' });
      }
    } else {
      riskMap.set(cleaned, { keyword: matchedKw, text: cleaned, level });
    }
  }

  function matchRisk(text) {
    const cleaned = cleanText(text);
    if (!cleaned || cleaned.length < 10) return;
    if (/^(本次会议|重点讨论|会议围绕|本期会议|探讨|汇报|总结)/.test(cleaned)) return;
    if (/未(发现|反馈|出现|发生)(严重|重大|高)/.test(cleaned)) return;
    if (/风险(较低|可控|不大|较小)/.test(cleaned)) return;
    if (/暂未(发现|出现)|无重大|稳定性可控/.test(cleaned)) return;
    if (/仅剩.{0,10}未解决/.test(cleaned)) return;
    if (/已(修复|解决|修正|回测|完成)/.test(cleaned) && !/未/.test(cleaned) && cleaned.length < 60) return;
    if (/预设.*严重|提问方式/.test(cleaned)) return;
    let level = null, matchedKw = '';
    for (const kw of riskKeywords.high) {
      if (cleaned.includes(kw)) { level = 'high'; matchedKw = kw; break; }
    }
    if (!level) {
      for (const kw of riskKeywords.mid) {
        if (cleaned.includes(kw)) { level = 'mid'; matchedKw = kw; break; }
      }
    }
    if (level) {
      const truncated = cleaned.length > 120 ? cleaned.substring(0, 117) + '...' : cleaned;
      addRisk(truncated, level, matchedKw);
    }
  }

  [...allConclusions, ...allTodos].forEach(matchRisk);

  // 从全文中提取结论/待决/待办段落，补充风险匹配
  documents.forEach(d => {
    const raw = d.rawContent || '';
    if (!raw) return;
    const sectionPattern = /(?:✅\s*会议结论|⚠️\s*待[决办]事项|待办事项|会议结论)([\s\S]*?)(?=(?:📝|✅|⚠️|#|$))/g;
    let sMatch;
    while ((sMatch = sectionPattern.exec(raw)) !== null) {
      const section = sMatch[1];
      const fragments = section.split(/[\n\v]/).flatMap(l => l.split(/(?=•\s)/));
      for (const frag of fragments) {
        if (frag.trim().length < 12) continue;
        matchRisk(frag);
      }
    }
  });

  let highRisks = [], midRisks = [];
  for (const [, r] of riskMap) {
    if (r.level === 'high') {
      const isDup = highRisks.some(e => textSimilar(e.text, r.text) > 0.6);
      if (!isDup) highRisks.push({ keyword: r.keyword, text: r.text });
    } else {
      const isDupHigh = highRisks.some(e => textSimilar(e.text, r.text) > 0.6);
      if (isDupHigh) continue;
      const isDupMid = midRisks.some(e => textSimilar(e.text, r.text) > 0.6);
      if (!isDupMid) midRisks.push({ keyword: r.keyword, text: r.text });
    }
  }

  // 时间节点提取：从 todos + 全文扫描
  const timeNodePattern = /(\d{4}[年\-]\d{1,2}[月\-]\d{1,2}[日号]?|\d{1,2}[.月]\s*\d{1,2}[日号]?|\d{1,2}月(?:\d{1,2}[日号])?|年底|年中|季度末|季度|上半年|下半年)/;
  let timeNodes = [];

  function extractTimeNode(text, docName) {
    if (!timeNodePattern.test(text)) return;
    if (/\d+\.\d+\s*版/.test(text) && !/月/.test(text) && !/\d{4}[年\-]/.test(text)) return;
    let stripped = text.trim();
    stripped = stripped.replace(/^[\-•·–—]+\s*/, '');
    stripped = stripped.replace(/^\d+[、.．]\s*/, '');
    stripped = stripped.replace(/^[一-鿿\w\/]{2,12}[：:]\s*/, '');
    const cleaned = cleanText(stripped);
    if (!isValidConclusion(cleaned)) return;
    let owner = '';
    const ownerMatch = text.match(/[【\[]([^\]】]{1,8})[】\]]/);
    if (ownerMatch) {
      const candidate = ownerMatch[1];
      if (!/负责人|截止|日期|\d{4}/.test(candidate)) {
        owner = candidate;
      }
    }
    const dateMatchFull = text.match(/(\d{4})[年\-](\d{1,2})[月\-](\d{1,2})/);
    let dateStr = '';
    if (dateMatchFull) {
      dateStr = `${dateMatchFull[2].padStart(2, '0')}-${dateMatchFull[3].padStart(2, '0')}`;
    } else {
      const dateMatch = text.match(/(\d{1,2})[.月]\s*(\d{1,2})[日号]?/);
      if (dateMatch) {
        const matchIdx = text.indexOf(dateMatch[0]);
        const afterMatch = text.substring(matchIdx + dateMatch[0].length);
        if (/^\s*%/.test(afterMatch)) return;
        dateStr = `${dateMatch[1].padStart(2, '0')}-${dateMatch[2].padStart(2, '0')}`;
      } else {
        const monthOnly = text.match(/(\d{1,2})月(?:份)?(?![.\d])/);
        if (monthOnly) {
          const m = parseInt(monthOnly[1]);
          if (m >= 1 && m <= 12) {
            dateStr = `${String(m).padStart(2, '0')}-01`;
          }
        }
      }
    }
    const source = docName ? docName.replace(/\.(otl|docx)$/i, '') : '';
    if (dateStr) {
      const truncated = cleaned.length > 100 ? cleaned.substring(0, 97) + '...' : cleaned;
      timeNodes.push({ text: truncated, owner: owner || teamName || '', dateStr, source });
    }
  }

  // 从 todos 提取
  documents.forEach(d => {
    const splitTodos = splitConcatenated(d.todos || []);
    splitTodos.forEach(t => extractTimeNode(t, d.name));
  });

  // 从全文结论/待办/讨论要点段落中补充提取时间节点
  documents.forEach(d => {
    const raw = d.rawContent || '';
    if (!raw) return;
    const sectionPattern = /(?:✅\s*会议结论|⚠️\s*待[决办]事项|待办事项|会议结论|讨论要点)([\s\S]*?)(?=(?:📝|✅|⚠️|议题|#|$))/g;
    let sMatch;
    while ((sMatch = sectionPattern.exec(raw)) !== null) {
      const section = sMatch[1];
      const fragments = section.split(/[\n\v]/).flatMap(l => l.split(/(?=•\s)/));
      for (const frag of fragments) {
        if (frag.trim().length < 10) continue;
        extractTimeNode(frag, d.name);
      }
    }
  });

  // 去重（同日期节点使用更低的相似度阈值）
  const dedupedNodes = [];
  for (const n of timeNodes) {
    const isDup = dedupedNodes.some(existing => {
      if (existing.dateStr === n.dateStr) return textSimilar(existing.text, n.text) > 0.35;
      return textSimilar(existing.text, n.text) > 0.6;
    });
    if (!isDup) dedupedNodes.push(n);
  }
  timeNodes = dedupedNodes;

  function parseDateNode(dateStr) {
    if (!dateStr) return null;
    const [m, d] = dateStr.split('-').map(Number);
    return new Date(currentYear(), m - 1, d);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const nearTermEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const midTermEnd = new Date(today.getFullYear(), today.getMonth() + 3, 0);

  function sortByDate(nodes) {
    return nodes.sort((a, b) => {
      const da = parseDateNode(a.dateStr);
      const db = parseDateNode(b.dateStr);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da - db;
    });
  }

  let nearTermNodes = [];
  let midTermNodes = [];
  timeNodes.forEach(node => {
    const nodeDate = parseDateNode(node.dateStr);
    if (!nodeDate) return;
    if (nodeDate >= today && nodeDate <= nearTermEnd) {
      nearTermNodes.push(node);
    } else if (nodeDate > nearTermEnd && nodeDate <= midTermEnd) {
      midTermNodes.push(node);
    }
  });

  nearTermNodes = sortByDate(nearTermNodes);
  midTermNodes = sortByDate(midTermNodes);

  allConclusions = allConclusions.map(c => cleanText(c)).filter(isValidConclusion);
  allTodos = allTodos.map(t => cleanText(t)).filter(isValidConclusion);

  // 从全文提取议题分类，生成趋势描述
  const topicCategories = {};
  const categoryPatterns = [
    { pattern: /性能|内存|帧率|卡顿|优化|CPU|GPU|耗时/, label: '性能优化' },
    { pattern: /提审|审核|上线|发布|版本|上架/, label: '版本发布与提审' },
    { pattern: /Bug|bug|缺陷|问题|修复|回归|crash|崩溃|闪退|当机/, label: '质量与缺陷管理' },
    { pattern: /自动化|脚本|CI|流水线|工具|效率/, label: '自动化与工具建设' },
    { pattern: /AI|人工智能|大模型|智能|数字员工/, label: 'AI与智能化' },
    { pattern: /人力|资源|排期|工期|人员|招聘|加班/, label: '人力与资源调配' },
    { pattern: /安全|权限|泄漏|合规|隐私/, label: '安全与合规' },
    { pattern: /兼容|适配|设备|平台|主机|PS5|Xbox|Switch/, label: '多端兼容适配' },
  ];
  documents.forEach(d => {
    const text = [...(d.conclusions || []), ...(d.todos || [])].join(' ');
    for (const { pattern, label } of categoryPatterns) {
      if (pattern.test(text)) {
        topicCategories[label] = (topicCategories[label] || 0) + 1;
      }
    }
  });
  const sortedCategories = Object.entries(topicCategories)
    .sort((a, b) => b[1] - a[1]);
  const totalDocCount = documents.length;

  const trends = [];
  for (const [label, count] of sortedCategories) {
    const pct = Math.round((count / totalDocCount) * 100);
    if (pct >= 20) {
      trends.push(`${label}是本期高频议题，涉及 ${count}/${totalDocCount} 场会议（${pct}%），需持续关注相关进展。`);
    } else if (pct >= 10) {
      trends.push(`${label}方面共 ${count} 场会议涉及（${pct}%），建议保持跟踪。`);
    }
  }
  if (importantCount > 0) {
    trends.push(`本期有 ${importantCount} 场重要会议（含重要人员参会），重点决策事项需优先落地。`);
  }
  if (nearTermNodes.length > 0) {
    trends.push(`本月内有 ${nearTermNodes.length} 个关键时间节点待完成，需密切跟进交付进度。`);
  }

  // 生成综合建议（引用具体会议数据）
  const actionSuggestions = [];

  if (nearTermNodes.length >= 3) {
    const items = nearTermNodes.slice(0, 3).map(n => `${n.dateStr} ${n.text.substring(0, 25)}`).join('；');
    actionSuggestions.push(`本月内有 ${nearTermNodes.length} 个时间节点密集排布（${items}），建议各项目组制定每日进度同步机制，防止遗漏。`);
  }

  const overdueNodes = nearTermNodes.filter(n => {
    const nd = parseDateNode(n.dateStr);
    return nd && nd < today;
  });
  if (overdueNodes.length > 0) {
    const items = overdueNodes.map(n => `「${n.dateStr} ${n.text.substring(0, 20)}」`).join('、');
    actionSuggestions.push(`以下 ${overdueNodes.length} 个节点已过期：${items}，建议立即核查完成状态并更新进展。`);
  }

  if (highRisks.length >= 5) {
    const topKws = [...new Set(highRisks.map(r => r.keyword))].slice(0, 4);
    actionSuggestions.push(`本期高风险事项达 ${highRisks.length} 项，集中在${topKws.map(k => `"${k}"`).join('、')}等方面，建议按优先级排序后分批跟进。`);
  }

  for (const [label, count] of sortedCategories.slice(0, 3)) {
    if (count >= 5) {
      const relatedTodos = allTodos.filter(t => categoryPatterns.find(p => p.label === label)?.pattern.test(t));
      const sample = relatedTodos.slice(0, 2).map(t => t.substring(0, 30)).join('；');
      actionSuggestions.push(`"${label}"涉及 ${count} 场会议（${Math.round(count/totalDocCount*100)}%），典型待办如：${sample || '详见各会议记录'}——建议整合形成统一跟踪看板。`);
    }
  }

  if (totalTodos > totalConclusions * 1.5) {
    actionSuggestions.push(`待办 ${totalTodos} 项远多于结论 ${totalConclusions} 项，部分议题可能缺乏闭环决策，建议加强会后决议的跟踪确认机制。`);
  }

  if (midTermNodes.length > 0) {
    const items = midTermNodes.slice(0, 3).map(n => `${n.dateStr} ${n.text.substring(0, 25)}`).join('；');
    actionSuggestions.push(`未来两个月有 ${midTermNodes.length} 个节点待关注（${items}），建议提前协调资源保障交付。`);
  }

  return {
    totalConclusions, totalTodos, importantCount,
    highRisks, midRisks, timeNodes, nearTermNodes, midTermNodes,
    allConclusions, allTodos,
    trends, actionSuggestions, topicCategories: sortedCategories
  };
}

// ========== 跨团队战略分析 ==========
function generateStrategicAnalysis(teamDataList) {
  const themes = [
    {
      name: 'AI与智能化应用推进',
      pattern: /AI|人工智能|大模型|智能|数字员工|Agent|MCP|LLM|GPT|Token|Copilot|自动生成/i,
      overviewTemplate: (teams) => {
        const active = teams.filter(t => t.level === 'high');
        const mid = teams.filter(t => t.level === 'mid');
        if (active.length > 0) return `本期会议显示AI应用已进入落地阶段，但各团队深度参差不齐：`;
        return `AI相关议题在部分团队中有所涉及，整体处于探索阶段：`;
      },
      suggestion: '建议建立AI应用成效评估标准，以实际效率提升数据衡量落地效果，避免形式化推进；同时关注"AI增负"风险，确保工具真正减负而非增加流程。'
    },
    {
      name: '产品节点与版本发布压力',
      pattern: /提审|上线|发布|版本|上架|封包|资料片|上线日期|提审版本/,
      overviewTemplate: (teams, allNodes) => {
        if (allNodes.length >= 3) return `近期多个产品节点密集叠加，测试与发布压力显著：`;
        return `当前产品发布节奏整体平稳，部分团队有版本节点推进：`;
      },
      suggestion: '建议建立跨部门节点冲突预警机制，将测试资源和发布窗口纳入统一协调；优先保障最高商业价值节点的质量保障资源。'
    },
    {
      name: '质量与稳定性风险',
      pattern: /崩溃|宕机|crash|Bug|bug|缺陷|闪退|当机|崩溃率|宕机率|OOM|内存泄漏/i,
      overviewTemplate: () => `基于各团队会议记录，质量与稳定性相关议题情况如下：`,
      suggestion: '建议建立跨项目的稳定性指标看板，统一监控各平台崩溃率/宕机率，按阈值触发预警和专项排查。'
    },
    {
      name: '人力资源与测试能力',
      pattern: /人力|资源|紧张|短缺|排期|工期|人员|招聘|加班|测试压力|人手不足/,
      overviewTemplate: () => `多个团队反映人力与资源压力：`,
      suggestion: '建议开展跨部门测试资源统筹，建立共享人力池机制；对资源瓶颈团队优先补充关键岗位，避免因人力不足导致质量风险。'
    },
    {
      name: '自动化与工具建设',
      pattern: /自动化|CI|流水线|工具|效率|脚本|Pipeline|自动回归|自动测试/i,
      overviewTemplate: () => `各团队在自动化与工具建设方面的推进情况：`,
      suggestion: '建议制定全团队自动化覆盖率目标，优先将高频回归场景纳入自动化；推动工具平台化，避免各团队重复建设。'
    },
    {
      name: '多端兼容与适配挑战',
      pattern: /主机|PS5|Xbox|NS|Switch|鸿蒙|兼容|适配|多端|跨端|移动端|PC端/i,
      overviewTemplate: () => `多端兼容适配相关议题情况如下：`,
      suggestion: '建议建立各平台兼容性基线标准，明确各端最低性能/稳定性指标；针对资源受限平台（如NS）单独制定优化路线图。'
    }
  ];

  const allNearNodes = teamDataList.flatMap(td => td.analysis.nearTermNodes);
  const allMidNodes = teamDataList.flatMap(td => td.analysis.midTermNodes);
  const allNodes = [...allNearNodes, ...allMidNodes];

  const results = [];
  for (const theme of themes) {
    const teamStats = [];
    for (const td of teamDataList) {
      const allText = [...td.analysis.allConclusions, ...td.analysis.allTodos];
      const matches = allText.filter(t => theme.pattern.test(t));
      if (matches.length === 0) continue;
      const docCount = td.data.documents.length;
      const meetingHits = td.data.documents.filter(d => {
        const text = [...(d.conclusions || []), ...(d.todos || [])].join(' ');
        return theme.pattern.test(text);
      }).length;
      const pct = Math.round((meetingHits / docCount) * 100);
      const examples = dedupTexts(matches).slice(0, 4).map(m => m.substring(0, 50));
      let level;
      if (pct >= 40 || matches.length >= 10) level = 'high';
      else if (pct >= 15 || matches.length >= 4) level = 'mid';
      else level = 'low';
      teamStats.push({ team: td.teamName, count: matches.length, meetingHits, docCount, pct, level, examples });
    }
    if (teamStats.length === 0) continue;
    teamStats.sort((a, b) => b.pct - a.pct);
    results.push({
      name: theme.name,
      overview: theme.overviewTemplate(teamStats, allNodes),
      teamStats,
      suggestion: theme.suggestion
    });
  }

  // 产品节点叠加专项（引用具体节点数据）
  if (allNodes.length >= 3) {
    const nodesByTeam = {};
    teamDataList.forEach(td => {
      const nodes = [...td.analysis.nearTermNodes, ...td.analysis.midTermNodes];
      if (nodes.length > 0) {
        nodesByTeam[td.teamName] = nodes.slice(0, 5).map(n => `${n.dateStr} ${n.text.substring(0, 30)}`);
      }
    });
    const existing = results.find(r => r.name.includes('产品节点'));
    if (existing) {
      existing.nodeDetail = nodesByTeam;
    }
  }

  return results;
}

// ========== 文档通用样式配置 ==========
const docStyles = {
  default: {
    document: {
      run: { font: FONT, size: 20, color: C.text },
      paragraph: { alignment: AlignmentType.JUSTIFIED, spacing: { line: 276 } }
    }
  },
  paragraphStyles: [
    { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
      run: { size: 32, bold: true, color: C.h1, font: FONT },
      paragraph: { spacing: { before: 480, after: 240 }, outlineLevel: 0, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.primary, space: 4 } } } },
    { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
      run: { size: 26, bold: true, color: C.h2, font: FONT },
      paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 1 } },
    { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
      run: { size: 22, bold: true, color: C.h3, font: FONT },
      paragraph: { spacing: { before: 280, after: 160 }, outlineLevel: 2 } }
  ]
};

const docNumbering = {
  config: [{ reference: "bl", levels: [
    { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 420, hanging: 220 } } } },
    { level: 1, format: LevelFormat.BULLET, text: "◦", alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 840, hanging: 220 } } } }
  ] }]
};

// ========== 增量扫描（从指定日期开始） ==========
function scanFolderFromDate(driveId, folderId, startMonth, startDay, teamName) {
  const files = [];
  const startNum = startMonth * 100 + startDay;
  const items = listFolder(driveId, folderId, teamName);
  for (const item of items) {
    if (item.type === 'folder') {
      files.push(...scanFolderFromDate(driveId, item.id, startMonth, startDay, teamName));
    } else if (item.type === 'file' && /\.(otl|docx)$/i.test(item.name)) {
      const d = extractDateFromFileName(item.name);
      if (d && (d.month * 100 + d.day) >= startNum) {
        files.push({ name: item.name, id: item.id, link: item.link_url, size: item.size, mtime: item.mtime });
      }
    }
  }
  return files;
}

// ========== 标题标准化 ==========
function normalizeTitle(raw) {
  const yearStr = String(currentYear());
  let t = raw.trim();
  let dateStr = '';

  const yearRe = new RegExp(yearStr + '[.\\-]?(\\d{2})[.\\-]?(\\d{2})');
  let m = t.match(yearRe);
  if (m) {
    dateStr = `${yearStr}${m[1]}${m[2]}`;
    t = t.replace(m[0], '');
  } else {
    m = t.match(/^(\d{2})(\d{2})\s*[\-—–]/);
    if (m) {
      dateStr = `${yearStr}${m[1]}${m[2]}`;
      t = t.replace(m[0], '');
    }
  }

  t = t.replace(/\.otl$/i, '');
  t = t.replace(/\.docx$/i, '');
  t = t.replace(/^[\s\-—–_·．|｜]+/, '');
  t = t.replace(/[\s\-—–_·．|｜]+$/, '');
  t = t.replace(/^【纪要】\s*/, '');
  t = t.replace(/\s*[\-—–·]\s*会议记录\s*$/, '');
  t = t.replace(/\s*会议记录\s*$/, '');
  t = t.replace(/\s*[\-—–·]\s*结构性会议记录\s*$/, '');
  t = t.replace(/\s*[\-—–·]\s*结构性纪要\s*$/, '');
  t = t.replace(/\s*[\-—–·]\s*结构性会议\s*$/, '');
  t = t.replace(/\s*[\-—–·]\s*结构性\s*$/, '');
  t = t.replace(/_/g, ' ');
  t = t.replace(/^[\s\-—–_·．|｜]+/, '');
  t = t.replace(/[\s\-—–_·．|｜]+$/, '');
  t = t.replace(/\s{2,}/g, ' ');

  if (!dateStr) return raw.replace(/\.(otl|docx)$/i, '');
  return `${dateStr} - ${t}`;
}

// ========== URL 匹配工具（看板用） ==========
function normalizeForMatch(s) {
  return s
    .replace(/\.otl$/i, '')
    .replace(/\.docx$/i, '')
    .replace(/[【】｜\[\]·\s\-—–_．·]/g, '')
    .replace(/纪要/g, '')
    .replace(/会议记录/g, '')
    .replace(/结构性/g, '')
    .replace(/汇报/g, '')
    .replace(/20\d{2}[\-.]?/g, '')
    .toLowerCase();
}

function charSimilarity(a, b) {
  if (a === b) return 1;
  const setA = new Set(a.split(''));
  const setB = new Set(b.split(''));
  let overlap = 0;
  for (const c of setA) { if (setB.has(c)) overlap++; }
  return overlap / Math.max(setA.size, setB.size);
}

// ========== OpenClaw provider 自动检测 ==========
function resolveOpenClawProvider() {
  const homedir = require('os').homedir();
  const ocConfigPath = path.join(homedir, '.openclaw', 'openclaw.json');
  try {
    if (!fs.existsSync(ocConfigPath)) {
      console.log(`[OpenClaw] 配置文件不存在: ${ocConfigPath}`);
      return null;
    }
    let rawConfig = fs.readFileSync(ocConfigPath, 'utf-8');
    // Resolve ${ENV_VAR} placeholders in the config
    rawConfig = rawConfig.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      const val = process.env[varName];
      if (val) return val;
      console.log(`[OpenClaw] 环境变量 ${varName} 未设置`);
      return '';
    });
    const oc = JSON.parse(rawConfig);
    const primary = oc.agents && oc.agents.defaults && oc.agents.defaults.model && oc.agents.defaults.model.primary;
    if (!primary) {
      console.log('[OpenClaw] 未找到 agents.defaults.model.primary');
      return null;
    }
    const slashIdx = primary.lastIndexOf('/');
    if (slashIdx === -1) {
      console.log(`[OpenClaw] primary 格式不含 /: "${primary}"`);
      return null;
    }
    const providerName = primary.substring(0, slashIdx);
    const modelId = primary.substring(slashIdx + 1);
    const provider = oc.models && oc.models.providers && oc.models.providers[providerName];
    if (!provider) {
      console.log(`[OpenClaw] 未找到 provider "${providerName}"，可用: ${Object.keys(oc.models && oc.models.providers || {}).join(', ')}`);
      return null;
    }
    if (!provider.baseUrl || !provider.apiKey) {
      console.log(`[OpenClaw] provider "${providerName}" 缺少 ${!provider.baseUrl ? 'baseUrl' : 'apiKey'}`);
      return null;
    }
    return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: modelId };
  } catch (e) {
    console.log(`[OpenClaw] 解析失败: ${e.message}`);
    return null;
  }
}

// ========== HTTP 调用 OpenAI-compatible API ==========
function callLLMApi(baseUrl, apiKey, model, prompt, timeout, options = {}) {
  const maxTokens = options.maxTokens || 32768;
  return new Promise((resolve) => {
    const url = new (require('url').URL)(baseUrl.replace(/\/+$/, '') + '/chat/completions');
    const isHttps = url.protocol === 'https:';
    const httpMod = isHttps ? require('https') : require('http');
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens
    });
    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: timeout + 60000
    };
    const overallTimer = setTimeout(() => { req.destroy(new Error('Overall request timeout')); }, timeout + 30000);
    const req = httpMod.request(reqOptions, (res) => {
      clearTimeout(overallTimer);
      const chunks = [];
      res.on('data', chunk => { chunks.push(chunk); });
      res.on('end', () => {
        try {
          const data = Buffer.concat(chunks).toString('utf-8');
          const json = JSON.parse(data);
          const choice = json.choices && json.choices[0];
          const content = choice && choice.message && choice.message.content;
          if (choice && choice.finish_reason === 'length') {
            console.log(`⚠️ [callLLMApi] finish_reason=length — 输出被 max_tokens(${maxTokens}) 截断`);
          }
          resolve(content ? content.trim() : null);
        } catch (e) {
          process.stderr.write(`[callLLMApi] 响应解析失败: ${e.message.substring(0, 100)}\n`);
          resolve(null);
        }
      });
    });
    req.on('error', (e) => {
      clearTimeout(overallTimer);
      process.stderr.write(`[callLLMApi] 请求失败: ${e.message.substring(0, 100)}\n`);
      resolve(null);
    });
    req.on('timeout', () => {
      clearTimeout(overallTimer);
      req.destroy();
      process.stderr.write('[callLLMApi] 请求超时\n');
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

// ========== CLI 方式调用 LLM ==========
function callLLMCli(cmd, args, prompt, timeout, maxRetries) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = execFileSync(cmd, args, {
        input: prompt,
        encoding: 'utf-8',
        timeout,
        maxBuffer: 1024 * 1024 * 10,
        windowsHide: true
      });
      return result.trim();
    } catch (e) {
      const isTimeout = e.message.includes('ETIMEDOUT') || e.message.includes('timed out') || e.killed;
      const errMsg = e.message.substring(0, 200);
      if (attempt < maxRetries) {
        console.log(`[callLLM] 第${attempt}次调用失败（${errMsg.substring(0,80)}），重试 ${attempt+1}/${maxRetries}...`);
        continue;
      }
      console.log(`[callLLM] CLI 调用失败，回退到规则分析。`);
      return null;
    }
  }
  return null;
}

// ========== 通用 LLM 调用（多后端自动选择） ==========
async function callLLM(prompt, config = {}) {
  const llmCfg = config.llm || {};
  const baseTimeout = llmCfg.timeout || 300000;
  const promptKB = Math.ceil(prompt.length / 1024);
  const timeout = Math.min(Math.max(baseTimeout, promptKB * 5000), 600000);
  if (timeout > baseTimeout) {
    console.log(`[callLLM] prompt ${promptKB}KB 较大，超时自动调整为 ${Math.round(timeout / 1000)}s`);
  }
  const maxRetries = llmCfg.maxRetries || 3;

  // 1. config.json 显式配了 API 地址
  if (llmCfg.baseUrl && llmCfg.apiKey) {
    const model = llmCfg.model || 'default';
    console.log(`[callLLM] 使用配置的 API: ${llmCfg.baseUrl} (model: ${model})`);
    const result = await callLLMApi(llmCfg.baseUrl, llmCfg.apiKey, model, prompt, timeout);
    if (result) return result;
    console.log('[callLLM] API 调用失败，尝试下一个后端...');
  }

  // 2. config.json 配了自定义 CLI 命令（非默认 claude）
  const cmd = llmCfg.command || 'claude';
  const args = llmCfg.args || ['-p'];
  if (cmd !== 'claude') {
    console.log(`[callLLM] 使用自定义命令: ${cmd} ${args.join(' ')}`);
    return callLLMCli(cmd, args, prompt, timeout, maxRetries);
  }

  // 3. 自动检测 OpenClaw 环境
  const oc = resolveOpenClawProvider();
  if (oc) {
    console.log(`[callLLM] 检测到 OpenClaw 环境，使用 ${oc.model} (${oc.baseUrl})`);
    const result = await callLLMApi(oc.baseUrl, oc.apiKey, oc.model, prompt, timeout);
    if (result) return result;
    console.log('[callLLM] OpenClaw API 调用失败，尝试 claude CLI...');
  }

  // 4. 默认尝试 claude -p（仅 1 次快速失败）
  console.log('[callLLM] 尝试 claude CLI...');
  return callLLMCli(cmd, args, prompt, timeout, 1);
}

// ========== 综合报告 prompt ==========
function buildComprehensiveReportPrompt(teamDataList, options = {}) {
  const { startDate, endDate, grandTotalDocs, teamCount, teamSummaries, multiSourceTeamNames } = options;
  const msNames = multiSourceTeamNames || [];
  const parts = [];

  parts.push('你是一位企业战略分析师，负责从多团队会议记录中提炼关键信息并撰写分析报告。');
  parts.push('');
  parts.push('【铁律 — 反幻觉约束（违反任何一条即为严重错误）】');
  parts.push('1. 你的唯一信息来源是下面提供的会议数据。数据中没有的内容，绝对不允许出现在报告中。');
  parts.push('2. 禁止推测、补充、臆造任何信息，包括但不限于：人员的个人情况（预产期、家庭、健康、学习方向等）、工作负荷评估、能力评价、情绪状态。');
  parts.push('3. 提到人名时，只能引用该人在数据中实际承担的具体任务或实际发言，一字不多。');
  parts.push('4. 禁止编造数字、百分比、时间节点。所有数字必须能在数据中找到原文。');
  parts.push('5. 每条分析必须能指出来源于哪场会议的哪条结论或待办。如果某个章节数据不足以支撑分析，直接写"数据不足，暂无法分析"，绝不凑内容。');
  parts.push('6. 风险分析只能基于数据中明确提到的问题原文，不允许自行推断潜在风险。');
  parts.push('');
  parts.push(`基于以下 ${teamCount || teamDataList.length} 个团队共 ${grandTotalDocs || '若干'} 份会议记录的汇总数据（${startDate} ~ ${endDate}），`);
  parts.push('请为综合分析报告生成全部分析内容。');
  parts.push('');

  for (const td of teamDataList) {
    const summary = teamSummaries && teamSummaries[td.teamName];
    if (summary) {
      parts.push(`# ${td.teamName}（${td.data.documents.length}场会议，以下为该团队分析摘要）`);
      parts.push('');
      parts.push(summary);
      parts.push('');
      parts.push('---');
      parts.push('');
    } else {
      const a = td.analysis;
      parts.push(`# ${td.teamName}（${td.data.documents.length}场会议）`);
      parts.push('');
      parts.push('会议清单：');
      td.data.documents.forEach(d => {
        const name = (d.name || '').replace(/\.(otl|docx)$/i, '');
        parts.push(`  - ${name}（结论${(d.conclusions||[]).length}条，待办${(d.todos||[]).length}条${d.important ? '，重要' : ''}）`);
      });
      parts.push('');
      if (a.topicCategories && a.topicCategories.length > 0) {
        parts.push(`议题分布：${a.topicCategories.map(([l, c]) => `${l}(${c}场)`).join('、')}`);
        parts.push('');
      }
      parts.push('### 核心议题');
      dedupTexts(a.allConclusions).forEach(c => parts.push(`• ${c}`));
      parts.push('');
      parts.push('### 关键待办');
      dedupTexts(a.allTodos).forEach(t => parts.push(`• ${t}`));
      parts.push('');
      if (a.highRisks.length > 0 || a.midRisks.length > 0) {
        parts.push(`### 风险事项（高${a.highRisks.length}项，中${a.midRisks.length}项）`);
        a.highRisks.forEach(r => parts.push(`• [高][${r.keyword}] ${r.text}`));
        a.midRisks.forEach(r => parts.push(`• [中][${r.keyword}] ${r.text}`));
        parts.push('');
      }
      if ((a.nearTermNodes && a.nearTermNodes.length > 0) || (a.midTermNodes && a.midTermNodes.length > 0)) {
        parts.push(`### 时间节点（近期${a.nearTermNodes.length}个，中期${a.midTermNodes.length}个）`);
        [...a.nearTermNodes, ...a.midTermNodes].forEach(n =>
          parts.push(`• ${n.dateStr} [${n.owner || '未指定'}] ${n.text}（来源：${n.source || '未知'}）`)
        );
        parts.push('');
      }
      parts.push('---');
      parts.push('');
    }
  }

  parts.push('## 输出要求');
  parts.push('');
  parts.push('请按以下结构输出纯 markdown（不要代码块包裹），从"## 1.2 主要趋势"开始：');
  parts.push('');
  parts.push('## 1.2 主要趋势');
  parts.push('列出3-8条跨团队的主要趋势和核心发现，每条格式：• 【团队名】趋势描述（来源：团队名-会议名称）');
  parts.push('多source团队格式：• 【团队名·子项目】趋势描述（来源：团队名·子项目-会议名称）');
  parts.push('');
  parts.push('# 二、风险点分析');
  parts.push('先写一句概述，然后：');
  parts.push('## 2.1 高风险事项');
  parts.push('仅从上面"风险事项"章节中标记为[高]的条目中提取，用原文改写，不得新增数据中不存在的风险。');
  parts.push('每条格式：• 【高】团队名+风险描述（不超过120字）（来源：团队名-会议名称）。没有则写"本期未发现高风险事项。"');
  parts.push('## 2.2 中风险事项');
  parts.push('仅从上面标记为[中]的条目中提取。每条格式：• 【中】团队名+风险描述（来源：团队名-会议名称）');
  parts.push('## 2.3 风险矩阵');
  parts.push('输出markdown表格，4列：风险项、等级、影响范围、来源会议。仅包含2.1和2.2中已列出的风险，不得新增。例如：');
  parts.push('| 风险项 | 等级 | 影响范围 | 来源会议 |');
  parts.push('|--------|------|----------|----------|');
  parts.push('| 剑侠世界4外网性能不达标 | 高 | 用户体验 | 剑侠世界系列·剑世4-20260402-质量汇报会 |');
  parts.push('');
  parts.push('# 三、重点关注节点');
  parts.push('先写一句概述，然后：');
  parts.push('## 3.1 近期节点（本月内）');
  parts.push('仅从上面"时间节点"章节中提取，不得编造不存在的时间节点。');
  parts.push('输出markdown表格，4列：时间节点、责任方、关键事项、来源会议。例如：');
  parts.push('| 时间节点 | 责任方 | 关键事项 | 来源会议 |');
  parts.push('|----------|--------|----------|----------|');
  parts.push('| 04-10 | 马力 | 重置版案例联调验收 | 剑网3系列·剑网3-20260402-质量汇报会 |');
  parts.push('没有则写"本月内暂无明确时间节点。"');
  parts.push('## 3.2 中期节点（未来两个月）');
  parts.push('同上格式的markdown表格，仅从数据中已识别的中期节点提取');
  parts.push('## 3.3 持续跟进事项');
  parts.push('无明确时间节点但需持续跟进的重要事项，用•列表，格式：• 【团队名】事项描述（来源：团队名-会议名称）');
  parts.push('');
  parts.push('# 四、各团队会议汇总');
  parts.push('对每个团队写一个小节：');
  parts.push('## 团队名');
  parts.push('### 会议统计');
  parts.push('一句话总结会议数量和重要会议');
  parts.push('### 核心议题');
  parts.push('仅从该团队的"核心议题"数据中概括，3-8条（•列表），每条用一句话概括原文结论');
  if (msNames.length > 0) {
    parts.push(`多source团队（${msNames.join('、')}）的每条必须加【子项目名】前缀，如：• 【子项目A】xxx`);
  }
  parts.push('### 关键决议');
  parts.push('仅从该团队的结论数据中提取，3-8条（•列表），直接引用或简述原文决议内容');
  if (msNames.length > 0) {
    parts.push('多source团队的每条必须加【子项目名】前缀');
  }
  parts.push('');
  parts.push('');
  parts.push('⚠️ 来源标注规则：');
  parts.push('- 单source团队：来源格式为"团队名-文档标题"，例如：（来源：测试部门0-20260422-质量周会）');
  if (msNames.length > 0) {
    parts.push(`- 多source团队（${msNames.join('、')}）：来源格式为"团队名·子项目名-文档标题"，例如：（来源：团队名·子项目-20260422-质量汇报会）`);
  }
  parts.push('');
  if (msNames.length > 0) {
    parts.push('⚠️ 多source团队内容分离规则：');
    parts.push(`${msNames.join('、')}这${msNames.length}个团队包含多个子项目（数据中已用## 子项目名分隔），`);
    parts.push('在所有章节中必须用【子项目名】标注每条内容的归属，不同子项目的内容不得混淆。');
    parts.push('例如：• 【子项目A】xxx、• 【子项目B】xxx。第四章按子项目分小节。');
  }
  parts.push('');
  parts.push('# 五、综合评估与建议');
  parts.push('按战略主题分组撰写（不按团队分组），3-6个主题，每个：');
  parts.push('## 5.N 主题标题');
  parts.push('概述段落（一句话总结当前状态，必须引用数据中的具体事实）');
  parts.push('• **推进较好**：团队名（引用该团队数据中的具体结论或待办原文作为依据）');
  parts.push('• **推进一般**：团队名（同上，必须有数据支撑）');
  parts.push('• **待加强**：团队名（同上，必须有数据支撑）');
  parts.push('（某个分级如果数据中找不到支撑依据则省略该分级，不要强凑）');
  parts.push('**建议**：一句话具体可执行的行动建议');
  parts.push('');
  parts.push('【再次强调 — 反幻觉检查清单（输出前逐条自检）】');
  parts.push('1. 报告中每一条事实陈述，是否都能在上面的数据中找到对应原文？找不到则删除。');
  parts.push('2. 报告中是否出现了数据中从未提及的人员个人情况描述？有则删除。');
  parts.push('3. 报告中提到的每个人名，其关联描述是否都来自数据中该人实际承担的任务？不是则删除。');
  parts.push('4. 报告中的数字/百分比/日期，是否都能在数据中找到出处？找不到则删除。');
  parts.push('5. 风险项是否全部来自数据中明确提到的问题？自行推断的风险必须删除。');
  parts.push('6. 每条建议是否简洁（一句话）且可执行？空泛模板句必须改写或删除。');
  parts.push('7. 输出纯 markdown，不要代码块包裹。');

  return parts.join('\n');
}

// ========== 单团队报告 prompt ==========
function buildTeamReportPrompt(data, analysis, teamName, options = {}) {
  const { startDate, endDate, isMultiSource } = options;
  const parts = [];

  parts.push(`你是一位项目管理分析师。你的唯一信息来源是下面提供的会议数据，数据中没有的内容绝对不允许出现在报告中。`);
  parts.push('');
  parts.push('【铁律 — 反幻觉约束（违反任何一条即为严重错误）】');
  parts.push('1. 禁止推测、补充、臆造任何信息。数据里没有的，报告里就不能有。');
  parts.push('2. 禁止编造人员的个人情况（预产期、家庭、健康、学习方向、能力评价、工作负荷评估等）。');
  parts.push('3. 提到人名时，只能引用该人在数据中实际承担的具体任务，不能添加任何数据中未出现的描述。');
  parts.push('4. 禁止编造数字、百分比、时间节点。所有数字必须能在数据中找到原文出处。');
  parts.push('5. 如果某个章节数据不足以支撑分析，直接写"数据不足，暂无法分析"，绝不凑内容。');
  parts.push('');
  parts.push(`基于${teamName}团队的 ${data.documents.length} 份会议记录（${startDate} ~ ${endDate}），`);
  parts.push('请为该团队的会议汇总分析报告生成全部分析内容。');
  parts.push('');
  parts.push('## 会议记录数据');
  parts.push('');

  for (const doc of data.documents) {
    const name = (doc.name || '').replace(/\.(otl|docx)$/i, '');
    parts.push(`### ${name}${doc.important ? '（重要会议）' : ''}`);
    if (doc.conclusions && doc.conclusions.length > 0) {
      doc.conclusions.forEach(c => parts.push(`  结论：${c}`));
    }
    if (doc.todos && doc.todos.length > 0) {
      doc.todos.forEach(t => parts.push(`  待办：${t}`));
    }
    parts.push('');
  }

  if (analysis.topicCategories && analysis.topicCategories.length > 0) {
    parts.push(`议题分布：${analysis.topicCategories.map(([l, c]) => `${l}(${c}场)`).join('、')}`);
    parts.push('');
  }
  if (analysis.highRisks.length > 0 || analysis.midRisks.length > 0) {
    parts.push('## 已识别风险');
    analysis.highRisks.forEach(r => parts.push(`• [高][${r.keyword}] ${r.text}`));
    analysis.midRisks.forEach(r => parts.push(`• [中][${r.keyword}] ${r.text}`));
    parts.push('');
  }
  if (analysis.nearTermNodes.length > 0 || analysis.midTermNodes.length > 0) {
    parts.push('## 已识别时间节点');
    [...analysis.nearTermNodes, ...analysis.midTermNodes].forEach(n =>
      parts.push(`• ${n.dateStr} [${n.owner || '未指定'}] ${n.text}（来源：${n.source || '未知'}）`)
    );
    parts.push('');
  }

  parts.push('## 输出要求');
  parts.push('');
  parts.push('请按以下结构输出纯 markdown（不要代码块包裹），从"## 1.2 主要趋势"开始：');
  parts.push('');
  parts.push('## 1.2 主要趋势');
  parts.push('列出3-5条该团队的主要趋势和核心发现，每条必须注明来源（格式：来源：团队名-文档标题）');
  parts.push('');
  parts.push('# 二、风险点分析');
  parts.push('先写一句概述，然后：');
  parts.push('## 2.1 高风险事项');
  parts.push('仅从上面"已识别风险"中标记为[高]的条目提取，用原文改写，不得新增数据中不存在的风险。');
  parts.push('每条格式：• 【高】风险描述（不超过120字）（来源：团队名-文档标题）。没有则写"本期未发现高风险事项。"');
  parts.push('## 2.2 中风险事项');
  parts.push('仅从上面标记为[中]的条目提取。每条格式：• 【中】风险描述（来源：团队名-文档标题）');
  parts.push('## 2.3 风险矩阵');
  parts.push('输出markdown表格，4列：风险项、等级、影响范围、来源会议。仅包含2.1和2.2中已列出的风险，不得新增。例如：');
  parts.push('| 风险项 | 等级 | 影响范围 | 来源会议 |');
  parts.push('|--------|------|----------|----------|');
  parts.push('| 某项目性能不达标 | 高 | 产品口碑、发布节点 | 团队名-20260402-质量汇报会 |');
  parts.push('');
  parts.push('# 三、重点关注节点');
  parts.push('先写一句概述，然后：');
  parts.push('## 3.1 近期节点（本月内）');
  parts.push('仅从上面"已识别时间节点"中提取，不得编造不存在的时间节点。');
  parts.push('输出markdown表格，4列：时间节点、责任方、关键事项、来源会议（格式：团队名-文档标题）。没有则写"本月内暂无明确时间节点。"');
  parts.push('## 3.2 中期节点（未来两个月）');
  parts.push('同上格式的markdown表格，仅从数据中已识别的中期节点提取');
  parts.push('## 3.3 持续跟进事项');
  parts.push('无明确时间节点但需持续跟进的重要事项，用•列表，每条注明来源（格式：团队名-文档标题）');
  parts.push('');
  parts.push('# 四、团队会议汇总');
  parts.push('### 核心议题');
  parts.push('仅从上面各会议的结论和议题数据中概括，5-8条，每条用一句话概括原文，注明来源（格式：团队名-文档标题）');
  if (isMultiSource) {
    parts.push('本团队是多source团队，每条必须加【子项目名】前缀，如：• 【子项目名】xxx（来源：团队名·子项目名-文档标题）');
  }
  parts.push('### 关键决议');
  parts.push('仅从上面各会议的结论数据中提取，5-8条，直接引用或简述原文决议，注明来源（格式：团队名-文档标题）');
  if (isMultiSource) {
    parts.push('本团队是多source团队，每条必须加【子项目名】前缀');
  }
  parts.push('');
  parts.push('# 五、综合评估与建议');
  parts.push('## 5.1 整体概况');
  parts.push('对该团队本期工作的整体评估（1-2段），每个判断都必须引用具体会议数据作为依据');
  parts.push('## 5.2 建议');
  parts.push('3-5条具体可执行的建议，每条一句话说清楚，必须关联到数据中的具体问题');
  parts.push('');
  parts.push('【再次强调 — 反幻觉检查清单（输出前逐条自检）】');
  parts.push('1. 报告中每一条事实陈述，是否都能在上面的会议数据中找到对应原文？找不到则删除。');
  parts.push('2. 报告中是否出现了数据中从未提及的人员个人情况描述？有则删除。');
  parts.push('3. 报告中提到的每个人名，其关联描述是否都来自数据中该人实际承担的任务？不是则删除。');
  parts.push('4. 报告中的数字/百分比/日期，是否都能在数据中找到出处？找不到则删除。');
  parts.push('5. 风险项是否全部来自数据中明确提到的问题？自行推断的风险必须删除。');
  parts.push('6. 每条建议是否简洁（一句话）且可执行？空泛模板句必须改写或删除。');
  parts.push('7. 输出纯 markdown，不要代码块包裹。');

  return parts.join('\n');
}

// ========== LLM markdown → docx 元素 ==========
function parseMarkdownTable(lines, startIdx) {
  const rows = [];
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) break;
    if (/^\|[\s\-:]+\|/.test(line)) { i++; continue; }
    const cells = line.split('|').filter((_, idx, arr) => idx > 0 && idx < arr.length - 1).map(c => c.trim());
    if (cells.length > 0) rows.push(cells);
    i++;
  }
  if (rows.length < 2) return { table: null, nextIdx: startIdx };

  const headers = rows[0];
  const dataRows = rows.slice(1);
  const colCount = headers.length;
  const totalWidth = 9026;
  const colWidth = Math.floor(totalWidth / colCount);
  const lastColWidth = totalWidth - colWidth * (colCount - 1);

  const riskLevelColors = { '高': C.red, '中': C.orange };

  const tableRows = [
    new TableRow({ tableHeader: true, children: headers.map((h, ci) =>
      hCell(h, ci === colCount - 1 ? lastColWidth : colWidth)
    ) }),
    ...dataRows.map(row => new TableRow({ children:
      headers.map((_, ci) => {
        const val = row[ci] || '';
        const w = ci === colCount - 1 ? lastColWidth : colWidth;
        if (riskLevelColors[val]) {
          return cCell(val, w, { bold: true, color: riskLevelColors[val] });
        }
        return cCell(val, w);
      })
    }))
  ];

  return {
    table: new Table({ columnWidths: headers.map((_, ci) => ci === colCount - 1 ? lastColWidth : colWidth), rows: tableRows }),
    nextIdx: i
  };
}

function parseReportMarkdown(markdown) {
  const elements = [];
  const lines = markdown.split('\n');
  let isFirstH1 = true;
  let lastType = '';

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('|')) {
      if (lastType && lastType !== 'table') {
        elements.push(new Paragraph({ spacing: { before: 120, after: 0 }, children: [] }));
      }
      const { table, nextIdx } = parseMarkdownTable(lines, i);
      if (table) {
        elements.push(table);
        elements.push(new Paragraph({ spacing: { before: 120, after: 0 }, children: [] }));
        i = nextIdx - 1;
        lastType = 'table';
      }
    } else if (/^#\s+/.test(trimmed) && !/^##/.test(trimmed)) {
      if (!isFirstH1) elements.push(pb());
      isFirstH1 = false;
      elements.push(h1(trimmed.replace(/^#\s+/, '')));
      lastType = 'h1';
    } else if (/^###\s+/.test(trimmed)) {
      elements.push(h3(trimmed.replace(/^###\s+/, '')));
      lastType = 'h3';
    } else if (/^##\s+/.test(trimmed)) {
      elements.push(h2(trimmed.replace(/^##\s+/, '')));
      lastType = 'h2';
    } else if (/^\*\*建议[：:]?\*\*/.test(trimmed) || /^建议[：:]/.test(trimmed)) {
      const text = trimmed.replace(/^\*\*建议[：:]?\*\*[：:\s]*/, '').replace(/^建议[：:\s]*/, '');
      if (text) {
        elements.push(new Paragraph({ spacing: { before: 160, after: 0 }, children: [] }));
        elements.push(p(text, { bold: true, before: 120 }));
      }
      lastType = 'suggestion';
    } else if (/^[•\-\*]\s+\*\*/.test(trimmed)) {
      const m = trimmed.match(/^[•\-\*]\s+\*\*([^*]+)\*\*[：:\s]*(.*)/);
      if (m) {
        elements.push(bullet(m[2] || '', { bold: m[1] + '：' }));
      } else {
        elements.push(bullet(trimmed.replace(/^[•\-\*]\s+/, '')));
      }
      lastType = 'bullet';
    } else if (/^[•\-\*]\s+/.test(trimmed)) {
      elements.push(bullet(trimmed.replace(/^[•\-\*]\s+/, '')));
      lastType = 'bullet';
    } else if (/^\d+[.、]\s+/.test(trimmed)) {
      elements.push(bullet(trimmed.replace(/^\d+[.、]\s+/, '')));
      lastType = 'bullet';
    } else if (/^\*\*[^*]+\*\*[：:]?\s*$/.test(trimmed)) {
      if (lastType === 'bullet' || lastType === 'p') {
        elements.push(new Paragraph({ spacing: { before: 120, after: 0 }, children: [] }));
      }
      elements.push(p(trimmed.replace(/^\*\*/, '').replace(/\*\*[：:]?\s*$/, ''), { bold: true }));
      lastType = 'bold-p';
    } else {
      elements.push(p(trimmed));
      lastType = 'p';
    }
  }
  return elements;
}

// ========== 标准页眉/页脚（按参考文档格式） ==========
function makeHeader(title, dateRange) {
  return new Header({
    children: [new Paragraph({
      border: { bottom: { style: BorderStyle.SINGLE, color: C.primary, size: 4, space: 4 } },
      children: [
        new TextRun({ text: title, font: FONT, size: 18, color: C.h3 }),
        new TextRun({ text: `   ${dateRange}`, font: FONT, size: 18, color: C.gray })
      ]
    })]
  });
}

function makeFooter() {
  return new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      border: { top: { style: BorderStyle.SINGLE, color: C.border, size: 2, space: 2 } },
      children: [
        new TextRun({ text: "第 ", font: FONT, size: 18, color: C.gray }),
        new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 18, color: C.gray }),
        new TextRun({ text: " 页", font: FONT, size: 18, color: C.gray })
      ]
    })]
  });
}

// ========== 标准封面（按参考文档格式） ==========
function makeCoverPage(opts) {
  const { title1, title2, subtitle, dateRange, stats, editDate, org } = opts;
  const children = [
    new Paragraph({ spacing: { before: 1200, after: 400 }, alignment: AlignmentType.CENTER, children: [
      new TextRun({ text: title1, bold: true, font: FONT, size: 56, color: C.h1 })
    ]}),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [
      new TextRun({ text: title2, bold: true, font: FONT, size: 56, color: C.h1 })
    ]}),
  ];
  if (subtitle) {
    children.push(new Paragraph({ spacing: { before: 400, after: 200 }, alignment: AlignmentType.CENTER, children: [
      new TextRun({ text: subtitle, font: FONT, size: 28, color: C.primary })
    ]}));
  }
  children.push(new Paragraph({ spacing: { before: subtitle ? 0 : 400, after: 200 }, alignment: AlignmentType.CENTER, children: [
    new TextRun({ text: dateRange, font: FONT, size: 28, color: C.primary })
  ]}));
  children.push(new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, color: C.primary, size: 4, space: 1 } },
    spacing: { before: 80, after: 80 }, children: []
  }));
  for (const line of stats) {
    children.push(new Paragraph({ spacing: { before: 200, after: 100 }, alignment: AlignmentType.CENTER, children: [
      new TextRun({ text: line, font: FONT, size: 24, color: C.h3 })
    ]}));
  }
  children.push(new Paragraph({ spacing: { before: 100, after: 800 }, alignment: AlignmentType.CENTER, children: [
    new TextRun({ text: `编制日期：${editDate}`, font: FONT, size: 22, color: C.gray })
  ]}));
  children.push(pb());
  return { properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } }, children };
}

function getTeamSources(teamCfg) {
  if (teamCfg.sources && teamCfg.sources.length > 0) return teamCfg.sources;
  if (teamCfg.drive_id && teamCfg.months) return [{ drive_id: teamCfg.drive_id, root_folder_id: teamCfg.root_folder_id, months: teamCfg.months }];
  return [];
}

function isMultiSourceTeam(teamCfg) {
  return teamCfg.sources && teamCfg.sources.length > 1;
}

function getMultiSourceTeamNames(config) {
  return (config.teams || []).filter(isMultiSourceTeam).map(t => t.name);
}

module.exports = {
  C, FONT, cellBorders, hCell, cCell, bullet, h1, h2, h3, p, pb,
  makeHeader, makeFooter, makeCoverPage,
  cleanText, isValidConclusion, makeSuggestion, textSimilar, dedupTexts, splitConcatenated, riskKeywords, analyzeDocs, generateStrategicAnalysis, extractInfo,
  callLLM, buildComprehensiveReportPrompt, buildTeamReportPrompt, parseReportMarkdown,
  docStyles, docNumbering, resolveWorkspaceDir,
  currentYear, normalizeDate, formatDateChinese, extractDateFromFileName, dateInRange, getWeekKey,
  listFolder, scanFolder, scanFolderWithStats, scanFolderAll, scanFolderFromDate,
  listFolderAsync, scanFolderAsync, scanFolderWithStatsAsync, scanFolderAllAsync, scanFolderFromDateAsync,
  RequestPacer, sleep,
  normalizeTitle, normalizeForMatch, charSimilarity,
  sleepSync,
  teamDocsCacheDir, teamFoldersCacheDir, ensureCacheDir, readCache, writeCache, clearFolderCache,
  getTeamSources, isMultiSourceTeam, getMultiSourceTeamNames, groupByLabel,
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, PageNumber, PageBreak,
  BorderStyle, WidthType, ShadingType, VerticalAlign, LevelFormat
};
