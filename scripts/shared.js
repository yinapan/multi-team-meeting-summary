const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

let cachedSkillConfig = null;

function getSkillConfig() {
  if (cachedSkillConfig) return cachedSkillConfig;
  const configFile = path.join(__dirname, '..', 'config.json');
  try {
    cachedSkillConfig = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
  } catch (_) {
    cachedSkillConfig = {};
  }
  return cachedSkillConfig;
}

function getKdocsConfig() {
  return getSkillConfig().kdocs || {};
}

function getKdocsCliPath() {
  const cfg = getKdocsConfig();
  const defaultWindowsPath = path.join(require('os').homedir(), 'AppData', 'Local', 'kdocs-cli', 'kdocs-cli.exe');
  return cfg.cliPath || (process.platform === 'win32' ? defaultWindowsPath : 'kdocs-cli');
}

function getKdocsCliEnv() {
  const cfg = getKdocsConfig();
  const env = { ...process.env };
  if (cfg.token) env.KINGSOFT_DOCS_TOKEN = cfg.token;
  return env;
}

function getKdocsCliArgs(args = []) {
  const cfg = getKdocsConfig();
  return cfg.token ? ['--token', cfg.token, ...args] : args;
}

function formatGenerationMode(mode) {
  if (mode === 'llm' || mode === 'llm-with-rules-supplement') return 'LLM';
  if (mode === 'rules-fallback') return '规则回退';
  if (mode === 'skipped') return '跳过';
  if (mode === 'error') return '失败';
  return mode || '未知';
}

function printAiReviewWarning(context = {}) {
  const title = context.title || '报告';
  const output = context.output ? `\n输出文件：${context.output}` : '';
  const stats = context.statsFile ? `\n生成统计：${context.statsFile}` : '';
  const mode = context.mode ? `\n生成方式：${formatGenerationMode(context.mode)}` : '';
  const llmUsed = typeof context.llmUsed === 'boolean'
    ? `\n是否使用 LLM：${context.llmUsed ? '是' : '否'}`
    : '';
  const timing = context.timingSummary ? `\n模块耗时汇总：${context.timingSummary}` : '';
  console.log([
    '',
    `⚠️ ${title}已生成，请务必人工审核后再对外使用。`,
    'AI 生成内容可能存在遗漏、误读、归因错误或表格统计偏差，关键事实、风险等级、时间节点和责任归属请以原始会议记录为准。',
    output,
    mode,
    llmUsed,
    timing,
    stats,
    ''
  ].filter(Boolean).join('\n'));
}

try {
  require.resolve('docx');
} catch (_) {
  throw new Error('缺少 npm 依赖 docx，请先运行 npm install');
}

const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        Header, Footer, AlignmentType, HeadingLevel, PageNumber, PageBreak,
        BorderStyle, WidthType, ShadingType, VerticalAlign, LevelFormat } = require('docx');

// ========== 缓存 ==========
const CACHE_DIR = path.join(__dirname, '..', 'cache');
const FOLDER_CACHE_TTL = Number(getKdocsConfig().cacheTtlMs) || 3600000;
const RETRY_CODES = new Set([429001, 429002, 429003]);
const MAX_RETRIES = 6;
const BASE_DELAY_MS = 3000;
const MAX_DELAY_MS = 30000;

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { const end = Date.now() + ms; while (Date.now() < end); }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== 异步并发控制 ==========
class RequestPacer {
  constructor(options = {}) {
    const cfg = getKdocsConfig();
    this.maxConcurrent = options.maxConcurrent || Number(cfg.folderConcurrency) || 2;
    this.minIntervalMs = options.minIntervalMs || Number(cfg.minIntervalMs) || 1000;
    this.rateLimitCooldownMs = options.rateLimitCooldownMs || Number(cfg.rateLimitCooldownMs) || 30000;
    this.currentIntervalMs = this.minIntervalMs;
    this.adaptiveMaxIntervalMs = options.adaptiveMaxIntervalMs || Number(cfg.adaptiveMaxIntervalMs) || 3000;
    this.adaptiveStepMs = options.adaptiveStepMs || Number(cfg.adaptiveStepMs) || 500;
    this.recoverySuccesses = options.recoverySuccesses || Number(cfg.recoverySuccesses) || 20;
    this.useCacheOnRateLimit = options.useCacheOnRateLimit !== undefined
      ? options.useCacheOnRateLimit
      : cfg.useCacheOnRateLimit !== false;
    this.successSinceRateLimit = 0;
    this.active = 0;
    this.queue = [];
    this.lastRequestTime = 0;
    this.cooldownUntil = 0;
    this.stats = {
      requests: 0,
      searchRequests: 0,
      listRequests: 0,
      readRequests: 0,
      rateLimits: 0,
      retries: 0,
      staleCacheFallbacks: 0,
      cacheHits: 0,
      apiFetches: 0
    };
  }

  acquire() {
    return new Promise(resolve => {
      const tryRun = () => {
        if (this.shouldPreferCache()) {
          this.active++;
          resolve();
          return;
        }
        if (this.active >= this.maxConcurrent) {
          this.queue.push(tryRun);
          return;
        }
        const now = Date.now();
        if (now < this.cooldownUntil) {
          setTimeout(tryRun, this.cooldownUntil - now);
          return;
        }
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.currentIntervalMs) {
          setTimeout(tryRun, this.currentIntervalMs - elapsed);
          return;
        }
        this.active++;
        this.lastRequestTime = Date.now();
        resolve();
      };
      tryRun();
    });
  }

  noteRateLimit(cooldownMs = this.rateLimitCooldownMs) {
    this.stats.rateLimits++;
    this.successSinceRateLimit = 0;
    this.currentIntervalMs = Math.min(this.adaptiveMaxIntervalMs, this.currentIntervalMs + this.adaptiveStepMs);
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + cooldownMs);
  }

  noteSuccess() {
    if (this.currentIntervalMs <= this.minIntervalMs) return;
    this.successSinceRateLimit++;
    if (this.successSinceRateLimit >= this.recoverySuccesses) {
      this.currentIntervalMs = Math.max(this.minIntervalMs, this.currentIntervalMs - this.adaptiveStepMs);
      this.successSinceRateLimit = 0;
    }
  }

  noteRetry() {
    this.stats.retries++;
  }

  noteStaleCacheFallback() {
    this.stats.staleCacheFallbacks++;
  }

  noteCacheRebuild(reason = 'cache') {
    this.stats.cacheRebuildUsed = true;
    if (!this.stats.cacheRebuildReasons) this.stats.cacheRebuildReasons = {};
    this.stats.cacheRebuildReasons[reason] = (this.stats.cacheRebuildReasons[reason] || 0) + 1;
  }

  shouldPreferCache() {
    return this.useCacheOnRateLimit && (!!this.stats.cacheRebuildUsed || this.stats.rateLimits > 0);
  }

  noteCacheHit() {
    this.stats.cacheHits++;
  }

  noteApiFetch() {
    this.stats.apiFetches++;
  }

  noteRequest(kind = 'requests') {
    this.stats.requests++;
    const key = `${kind}Requests`;
    if (Object.prototype.hasOwnProperty.call(this.stats, key)) this.stats[key]++;
  }

  getCurrentIntervalMs() {
    return this.currentIntervalMs;
  }

  getStats() {
    return { ...this.stats, currentIntervalMs: this.currentIntervalMs };
  }

  release() {
    this.active--;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      const elapsed = Date.now() - this.lastRequestTime;
      if (elapsed >= this.currentIntervalMs) {
        next();
      } else {
        setTimeout(next, this.currentIntervalMs - elapsed);
      }
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
  } catch (e) {
    process.stderr.write(`[readCache] ${path.basename(filePath)}: ${e.message.substring(0, 80)}\n`);
    return null;
  }
}

function writeCache(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
  } catch (e) {
    process.stderr.write(`[writeCache] ${path.basename(filePath)}: ${e.message.substring(0, 80)}\n`);
  }
}

function clearFolderCache(teamName) {
  try {
    const dir = teamFoldersCacheDir(teamName);
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
    }
  } catch (e) {
    process.stderr.write(`[clearFolderCache] ${teamName}: ${e.message.substring(0, 80)}\n`);
  }
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
    children: [new Paragraph({ children: [new TextRun({ text: t, bold: o.bold || false, color: o.color || C.text, font: FONT, size: 20 })] })]
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
function h3(t) { return new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: t, bold: true, color: '2E74B5' })] }); }
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

function validMonthDay(month, day) {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function extractDateFromFileName(fileName) {
  const year = currentYear();
  const yearStr = String(year);
  const prevYearStr = String(year - 1);
  const shortYearStr = yearStr.slice(-2);
  const prevShortYearStr = prevYearStr.slice(-2);

  function makeDate(monthValue, dayValue) {
    const month = parseInt(monthValue, 10);
    const day = parseInt(dayValue, 10);
    return validMonthDay(month, day) ? { month, day } : null;
  }

  // 匹配当前年份: 20260428, 2026-04-28, 2026.04.28
  const yearRe = new RegExp(yearStr + '[.\\-]?(\\d{1,2})[.\\-]?(\\d{2})');
  let match = fileName.match(yearRe);
  if (match) {
    const date = makeDate(match[1], match[2]);
    if (date) return date;
  }

  // 匹配前一年: 20251228（跨年场景）
  const prevYearRe = new RegExp(prevYearStr + '[.\\-]?(\\d{1,2})[.\\-]?(\\d{2})');
  match = fileName.match(prevYearRe);
  if (match) {
    const date = makeDate(match[1], match[2]);
    if (date) return date;
  }

  // 匹配两位年份: 260506, 26.3.30, 26-04-20
  const shortYearRe = new RegExp(`(?:^|\\D)(?:${shortYearStr}|${prevShortYearStr})[.\\-]?(\\d{1,2})[.\\-]?(\\d{2})(?=\\D|$)`);
  match = fileName.match(shortYearRe);
  if (match) {
    const date = makeDate(match[1], match[2]);
    if (date) return date;
  }

  // 匹配中文格式: 2026 年 4 月 20 日、4月28日
  match = fileName.match(/(?:\d{4}\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (match) {
    const date = makeDate(match[1], match[2]);
    if (date) return date;
  }

  // 匹配无年份的 M.D / MM-DD 格式: 5.11 xxx, 04-20会议纪要
  match = fileName.match(/(?:^|[^\d])(\d{1,2})[.\-](\d{1,2})(?=\D|$)/);
  if (match) {
    const date = makeDate(match[1], match[2]);
    if (date) return date;
  }

  // 匹配无年份的 MMDD 格式（仅当前缀是4位数字且不像年份时）: 0428-xxx
  match = fileName.match(/^(\d{2})(\d{2})\s*[\-—–]/);
  if (match) {
    const date = makeDate(match[1], match[2]);
    if (date) return date;
  }

  return null;
}

function extractDateFromContent(markdown) {
  const text = String(markdown || '').replace(/\r\n/g, '\n');
  const year = currentYear();
  const yearStr = String(year);
  const prevYearStr = String(year - 1);
  const lines = text.split('\n');
  const dateLabelRe = /会议\s*(?:时间|日期)|开会\s*时间|召开\s*时间|(?:^|\|)\s*(?:时间|日期)\s*(?:[：:]|\|)/;

  function makeDate(monthValue, dayValue) {
    const month = parseInt(monthValue, 10);
    const day = parseInt(dayValue, 10);
    return validMonthDay(month, day) ? { month, day } : null;
  }

  function dateFromLine(line, options = {}) {
    const { allowNoYear = false, startOnly = false } = options;
    const prefix = startOnly ? '^\\s*(?:#{1,6}\\s*)?' : '';
    const currentOrPrev = `(?:${yearStr}|${prevYearStr})`;
    const patterns = [
      new RegExp(`${prefix}${currentOrPrev}(\\d{2})(\\d{2})(?=\\D|$)`),
      new RegExp(`${prefix}${currentOrPrev}\\s*[.\\-/年]\\s*(\\d{1,2})\\s*[.\\-/月]\\s*(\\d{1,2})`)
    ];

    if (allowNoYear) {
      patterns.push(
        /(?:^|[^\d])(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/,
        /(?:^|[^\d])(\d{1,2})[.\-/](\d{1,2})(?=\D|$)/
      );
    }

    for (const pattern of patterns) {
      const match = String(line || '').match(pattern);
      if (!match) continue;
      const date = makeDate(match[1], match[2]);
      if (date) return date;
    }
    return null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!dateLabelRe.test(line)) continue;

    const sameLineDate = dateFromLine(line, { allowNoYear: true });
    if (sameLineDate) return sameLineDate;

    for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
      const current = lines[j].trim();
      if (!current) continue;
      if (/^\s{0,3}#{1,6}\s*/.test(current) && !dateFromLine(current, { allowNoYear: true })) break;
      if (/参会|与会|出席|会议记录|会议纪要|正文/.test(current) && !dateFromLine(current, { allowNoYear: true })) break;
      const date = dateFromLine(current, { allowNoYear: true });
      if (date) return date;
    }
  }

  let nonEmptyCount = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    nonEmptyCount++;
    if (nonEmptyCount > 5) break;
    const date = dateFromLine(line, { startOnly: true });
    if (date) return date;
  }

  return null;
}

function extractMeetingDate(fileName, markdown = '') {
  return extractDateFromFileName(fileName) || extractDateFromContent(markdown);
}

function meetingDateInRange(meetingDate, startDate, endDate) {
  if (!meetingDate) return false;
  const startMatch = startDate.match(/(\d{1,2})[.\-](\d{1,2})/);
  const endMatch = endDate.match(/(\d{1,2})[.\-](\d{1,2})/);
  if (!startMatch || !endMatch) return false;
  const fileNum = meetingDate.month * 100 + meetingDate.day;
  const startNum = parseInt(startMatch[1]) * 100 + parseInt(startMatch[2]);
  const endNum = parseInt(endMatch[1]) * 100 + parseInt(endMatch[2]);
  if (startNum <= endNum) {
    return fileNum >= startNum && fileNum <= endNum;
  }
  return fileNum >= startNum || fileNum <= endNum;
}

function dateInRange(fileName, startDate, endDate, markdown = '') {
  const fileDate = extractMeetingDate(fileName, markdown);
  return meetingDateInRange(fileDate, startDate, endDate);
}

function getWeekKey(fileName, markdown = '', meetingDate = null) {
  const d = meetingDate || extractMeetingDate(fileName, markdown);
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
      const raw = execFileSync(getKdocsCliPath(), getKdocsCliArgs(['drive', 'list-files', '--output', 'json']), {
        input: inputJson, encoding: 'utf-8', timeout: 15000, windowsHide: true, env: getKdocsCliEnv()
      });
      const parsed = JSON.parse(raw);
      if (parsed && parsed.code && parsed.code !== 0) {
        if (RETRY_CODES.has(parsed.code) && attempt < MAX_RETRIES) {
          const delay = retryDelay(attempt);
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
        const delay = retryDelay(attempt);
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

function normalizeKdocsFile(item, driveId) {
  return {
    name: item.name,
    id: item.id,
    link: item.link || item.link_url || item.url || '',
    size: item.size,
    drive_id: item.drive_id || driveId || '',
    mtime: item.mtime,
    parent_id: item.parent_id || ''
  };
}

function scanFolder(driveId, folderId, startDate, endDate, teamName) {
  const files = [];
  const items = listFolder(driveId, folderId, teamName);
  for (const item of items) {
    if (item.type === 'folder') {
      files.push(...scanFolder(driveId, item.id, startDate, endDate, teamName));
    } else if (item.type === 'file' && /\.(otl|docx)$/i.test(item.name)) {
      if (dateInRange(item.name, startDate, endDate)) {
        files.push(normalizeKdocsFile(item, driveId));
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
      totalScanned++;
      if (dateInRange(item.name, startDate, endDate)) {
        files.push(normalizeKdocsFile(item, driveId));
      }
    }
  }
  return { files, totalScanned };
}

function kdocsFileKey(file) {
  return String((file && (file.id || file.link || file.name)) || '');
}

function dedupeKdocsFiles(files) {
  const seen = new Set();
  const result = [];
  for (const file of files || []) {
    const key = kdocsFileKey(file);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(file);
  }
  return result;
}

function getKdocsScanMode() {
  const cfg = getKdocsConfig();
  if (cfg.scanMode) return String(cfg.scanMode).toLowerCase();
  if (cfg.recursiveScan === false) return 'search';
  if (cfg.recursiveScan === true) return 'recursive';
  return 'recursive';
}

let cachedDirectoryRiskProfile = null;
function getDirectoryRiskProfile() {
  if (cachedDirectoryRiskProfile) return cachedDirectoryRiskProfile;
  const profile = { teamFolderCounts: {}, sourceFolderCounts: {} };
  const file = path.join(resolveWorkspaceDir(), 'kdocs-directory-tree.json');
  try {
    if (!fs.existsSync(file)) {
      cachedDirectoryRiskProfile = profile;
      return profile;
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    for (const row of data.rows || []) {
      if (row.type !== 'folder') continue;
      const team = row.team || '';
      const source = row.source || '';
      if (team) profile.teamFolderCounts[team] = (profile.teamFolderCounts[team] || 0) + 1;
      if (team && source) {
        const key = `${team}::${source}`;
        profile.sourceFolderCounts[key] = (profile.sourceFolderCounts[key] || 0) + 1;
      }
    }
  } catch (e) {
    process.stderr.write(`[directoryRiskProfile] 读取失败: ${e.message.substring(0, 100)}\n`);
  }
  cachedDirectoryRiskProfile = profile;
  return profile;
}

function shouldHybridRecursiveScan(teamName, sourceLabel) {
  const cfg = getKdocsConfig();
  const threshold = Number(cfg.hybridFolderThreshold ?? cfg.hybridRecursiveFolderThreshold ?? 5);
  const explicitTeams = new Set([
    '运营发行中心',
    '行政管理部',
    ...(cfg.hybridRecursiveTeams || []),
    ...(cfg.recursiveFallbackTeams || [])
  ]);
  const explicitLabels = new Set([
    'K2运营发行部',
    ...(cfg.hybridRecursiveLabels || []),
    ...(cfg.recursiveFallbackLabels || [])
  ]);

  if (explicitTeams.has(teamName) || explicitLabels.has(sourceLabel)) return true;

  const profile = getDirectoryRiskProfile();
  const teamFolders = profile.teamFolderCounts[teamName] || 0;
  const sourceFolders = profile.sourceFolderCounts[`${teamName}::${sourceLabel}`] || 0;
  return teamFolders >= threshold || sourceFolders >= threshold;
}

async function scanFilesByMode(entry, options) {
  const {
    teamName,
    startDate,
    endDate,
    pacer,
    mode = getKdocsScanMode(),
    includeAll = false,
    fromDate = null
  } = options || {};
  const driveId = entry.source.drive_id;
  const folderId = entry.folderId;
  const label = entry.label || teamName;
  const normalizedMode = String(mode || 'recursive').toLowerCase();
  const stats = {
    mode: normalizedMode,
    searchCount: 0,
    recursiveCount: 0,
    mergedCount: 0,
    recursiveSupplementCount: 0,
    usedRecursive: false,
    totalScanned: 0
  };

  async function searchMatched() {
    const files = await searchFilesAsyncRateLimited({
      drive_ids: [driveId],
      parent_ids: [folderId],
      file_exts: ['otl', 'docx'],
      with_link: true
    }, teamName, pacer);
    return includeAll
      ? files
      : files.filter(f => dateInRange(f.name, startDate, endDate));
  }

  async function recursiveMatched() {
    stats.usedRecursive = true;
    if (includeAll) {
      const files = fromDate
        ? await scanFolderFromDateAsync(driveId, folderId, fromDate.month, fromDate.day, teamName, pacer)
        : await scanFolderAllAsync(driveId, folderId, teamName, pacer);
      stats.recursiveCount = files.length;
      stats.totalScanned = files.length;
      return files;
    }
    const result = await scanFolderWithStatsAsync(driveId, folderId, startDate, endDate, teamName, pacer);
    stats.recursiveCount = result.files.length;
    stats.totalScanned = result.totalScanned;
    return result.files;
  }

  let files = [];
  if (normalizedMode === 'recursive') {
    files = await recursiveMatched();
  } else if (normalizedMode === 'search') {
    files = await searchMatched();
    stats.searchCount = files.length;
    stats.totalScanned = files.length;
  } else {
    let searchFiles = [];
    try {
      searchFiles = await searchMatched();
      stats.searchCount = searchFiles.length;
    } catch (e) {
      process.stderr.write(`[hybrid-scan] search 失败 ${teamName}/${entry.monthName}: ${e.message.substring(0, 120)}\n`);
    }

    const needsRecursive = shouldHybridRecursiveScan(teamName, label) || searchFiles.length === 0;
    if (needsRecursive) {
      const recursiveFiles = await recursiveMatched();
      const searchKeys = new Set(searchFiles.map(kdocsFileKey).filter(Boolean));
      stats.recursiveSupplementCount = recursiveFiles.filter(f => !searchKeys.has(kdocsFileKey(f))).length;
      files = dedupeKdocsFiles([...searchFiles, ...recursiveFiles]);
      stats.totalScanned = Math.max(stats.totalScanned, files.length);
    } else {
      files = searchFiles;
      stats.totalScanned = searchFiles.length;
    }
  }

  files = dedupeKdocsFiles(files);
  stats.mergedCount = files.length;
  return { files, stats };
}

function scanFolderAll(driveId, folderId, teamName) {
  const files = [];
  const items = listFolder(driveId, folderId, teamName);
  for (const item of items) {
    if (item.type === 'folder') {
      files.push(...scanFolderAll(driveId, item.id, teamName));
    } else if (item.type === 'file' && /\.(otl|docx)$/i.test(item.name)) {
      files.push(normalizeKdocsFile(item, driveId));
    }
  }
  return files;
}

// ========== 异步版本 KDocs 扫描 ==========
function spawnKdocsCli(args, inputJson, timeout) {
  return new Promise((resolve) => {
    const child = require('child_process').spawn(getKdocsCliPath(), getKdocsCliArgs(args), {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: getKdocsCliEnv()
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

function retryDelay(attempt) {
  const base = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
  return base + Math.floor(Math.random() * 1000);
}

function shouldUseCacheImmediately(parsedOrCode) {
  const cfg = getKdocsConfig();
  if (cfg.useCacheOnRateLimit === false) return false;
  const code = typeof parsedOrCode === 'number' ? parsedOrCode : parsedOrCode && parsedOrCode.code;
  return RETRY_CODES.has(code);
}

async function pacedKdocsCli(pacer, args, inputJson, timeout, kind = 'requests', beforeSpawn = null) {
  if (!pacer) return spawnKdocsCli(args, inputJson, timeout);
  await pacer.acquire();
  try {
    if (typeof beforeSpawn === 'function') {
      const skipped = beforeSpawn();
      if (skipped) return skipped;
    }
    if (typeof pacer.noteRequest === 'function') pacer.noteRequest(kind);
    return await spawnKdocsCli(args, inputJson, timeout);
  } finally {
    pacer.release();
  }
}

async function listFolderAsync(driveId, parentId, teamName, pacer) {
  const cacheFile = path.join(teamFoldersCacheDir(teamName), `${driveId}_${parentId}.json`);
  const cached = readCache(cacheFile);
  if (cached && (Date.now() - cached.fetched_at) < FOLDER_CACHE_TTL) {
    return cached.items;
  }

  const inputJson = JSON.stringify({ drive_id: driveId, parent_id: parentId, page_size: 500 });
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const { error, stdout } = await pacedKdocsCli(
      pacer,
      ['drive', 'list-files', '--output', 'json'],
      inputJson,
      15000,
      'list',
      () => {
        if (!pacer || typeof pacer.shouldPreferCache !== 'function' || !pacer.shouldPreferCache()) return null;
        if (typeof pacer.noteCacheRebuild === 'function') pacer.noteCacheRebuild('rate-limit-folder-cache');
        if (!cached) return { skipped: true, stdout: JSON.stringify({ code: 0, data: { data: { items: [] } } }) };
        if (typeof pacer.noteStaleCacheFallback === 'function') pacer.noteStaleCacheFallback();
        return { skipped: true, stdout: JSON.stringify({ code: 0, data: { data: { items: cached.items } } }) };
      }
    );
    if (error && !stdout) {
      if (attempt < MAX_RETRIES) {
        if (pacer && typeof pacer.noteRetry === 'function') pacer.noteRetry();
        const delay = retryDelay(attempt);
        process.stderr.write(`[listFolderAsync] error folder=${parentId}, retry in ${(delay / 1000).toFixed(0)}s (${attempt + 1}/${MAX_RETRIES})...\n`);
        await sleep(delay);
        continue;
      }
      process.stderr.write(`[listFolderAsync] failed folder=${parentId}: ${error.substring(0, 100)}\n`);
      if (cached) return cached.items;
      return [];
    }
    try {
      const parsed = JSON.parse(stdout);
      if (parsed && parsed.code && parsed.code !== 0) {
        if (shouldUseCacheImmediately(parsed)) {
          if (pacer && typeof pacer.noteRateLimit === 'function') pacer.noteRateLimit(0);
          if (pacer && typeof pacer.noteCacheRebuild === 'function') pacer.noteCacheRebuild('rate-limit-folder-cache');
          if (cached) {
            if (pacer && typeof pacer.noteStaleCacheFallback === 'function') pacer.noteStaleCacheFallback();
            process.stderr.write(`[listFolderAsync] rate limited folder=${parentId} code=${parsed.code}, using cached folder data\n`);
            return cached.items;
          }
          process.stderr.write(`[listFolderAsync] rate limited folder=${parentId} code=${parsed.code}, no cache available\n`);
          return [];
        }
        if (RETRY_CODES.has(parsed.code) && attempt < MAX_RETRIES) {
          if (pacer && typeof pacer.noteRateLimit === 'function') pacer.noteRateLimit();
          if (pacer && typeof pacer.noteRetry === 'function') pacer.noteRetry();
          const delay = retryDelay(attempt);
          process.stderr.write(`[listFolderAsync] rate limited folder=${parentId} code=${parsed.code}, retry in ${(delay / 1000).toFixed(0)}s (${attempt + 1}/${MAX_RETRIES})...\n`);
          await sleep(delay);
          continue;
        }
        process.stderr.write(`[listFolderAsync] API error folder=${parentId} code=${parsed.code}\n`);
        if (cached) return cached.items;
        return [];
      }
      const items = (parsed && parsed.data && parsed.data.data && parsed.data.data.items) || [];
      if (pacer && typeof pacer.noteSuccess === 'function') pacer.noteSuccess();
      writeCache(cacheFile, { items, fetched_at: Date.now() });
      return items;
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        if (pacer && typeof pacer.noteRetry === 'function') pacer.noteRetry();
        const delay = retryDelay(attempt);
        await sleep(delay);
        continue;
      }
      if (cached) return cached.items;
      return [];
    }
  }

  if (cached) return cached.items;
  return [];
}

async function scanFolderAsync(driveId, folderId, startDate, endDate, teamName, pacer) {
  const items = await listFolderAsync(driveId, folderId, teamName, pacer);
  const subFolders = items.filter(i => i.type === 'folder');
  const subResults = [];
  for (const sub of subFolders) {
    subResults.push(await scanFolderAsync(driveId, sub.id, startDate, endDate, teamName, pacer));
  }
  const files = items
    .filter(i => i.type === 'file' && /\.(otl|docx)$/i.test(i.name) && dateInRange(i.name, startDate, endDate))
    .map(i => normalizeKdocsFile(i, driveId));
  return files.concat(subResults.flat());
}

async function scanFolderWithStatsAsync(driveId, folderId, startDate, endDate, teamName, pacer) {
  const items = await listFolderAsync(driveId, folderId, teamName, pacer);
  const subFolders = items.filter(i => i.type === 'folder');
  const subResults = [];
  for (const sub of subFolders) {
    subResults.push(await scanFolderWithStatsAsync(driveId, sub.id, startDate, endDate, teamName, pacer));
  }
  const docFiles = items.filter(i => i.type === 'file' && /\.(otl|docx)$/i.test(i.name));
  const matchedFiles = docFiles
    .filter(i => dateInRange(i.name, startDate, endDate))
    .map(i => normalizeKdocsFile(i, driveId));
  const files = matchedFiles.concat(subResults.flatMap(r => r.files));
  const totalScanned = docFiles.length + subResults.reduce((s, r) => s + r.totalScanned, 0);
  return { files, totalScanned };
}

async function scanFolderAllAsync(driveId, folderId, teamName, pacer) {
  const items = await listFolderAsync(driveId, folderId, teamName, pacer);
  const subFolders = items.filter(i => i.type === 'folder');
  const subResults = [];
  for (const sub of subFolders) {
    subResults.push(await scanFolderAllAsync(driveId, sub.id, teamName, pacer));
  }
  const files = items
    .filter(i => i.type === 'file' && /\.(otl|docx)$/i.test(i.name))
    .map(i => normalizeKdocsFile(i, driveId));
  return files.concat(subResults.flat());
}

async function scanFolderFromDateAsync(driveId, folderId, startMonth, startDay, teamName, pacer) {
  const startNum = startMonth * 100 + startDay;
  const items = await listFolderAsync(driveId, folderId, teamName, pacer);
  const subFolders = items.filter(i => i.type === 'folder');
  const subResults = [];
  for (const sub of subFolders) {
    subResults.push(await scanFolderFromDateAsync(driveId, sub.id, startMonth, startDay, teamName, pacer));
  }
  const files = items
    .filter(i => {
      if (i.type !== 'file' || !/\.(otl|docx)$/i.test(i.name)) return false;
      const d = extractDateFromFileName(i.name);
      return d && (d.month * 100 + d.day) >= startNum;
    })
    .map(i => normalizeKdocsFile(i, driveId));
  return files.concat(subResults.flat());
}

function dateToUnixSeconds(year, month, day) {
  return Math.floor(new Date(year, month - 1, day).getTime() / 1000);
}

async function searchFilesAsync(opts, teamName, pacer) {
  if (getKdocsConfig().useSearch === false) {
    throw new Error('searchFilesAsync disabled by config.kdocs.useSearch=false');
  }

  const keyObj = {
    drive_ids: opts.drive_ids,
    parent_ids: opts.parent_ids || [],
    keyword: opts.keyword || '',
    file_exts: opts.file_exts || [],
    file_type: opts.file_type || 'file',
    time_type: opts.time_type || '',
    start_time: opts.start_time || 0,
    end_time: opts.end_time || 0,
    type: opts.type || 'all',
    scope: opts.scope || []
  };
  const cacheKey = crypto.createHash('sha1').update(JSON.stringify(keyObj)).digest('hex');
  const cacheFile = path.join(teamFoldersCacheDir(teamName), `search_${cacheKey}.json`);
  const cached = readCache(cacheFile);
  if (cached && (Date.now() - cached.fetched_at) < FOLDER_CACHE_TTL) {
    return cached.items;
  }

  const allItems = [];
  let pageToken = null;

    for (let page = 0; page < 20; page++) {
      const inputObj = {
        drive_ids: opts.drive_ids,
        type: opts.type || 'all',
        file_type: opts.file_type || 'file',
        page_size: opts.page_size || 500,
        order_by: opts.order_by || 'mtime',
        order: opts.order || 'desc',
        with_link: opts.with_link !== undefined ? opts.with_link : true
      };
      if (opts.keyword) inputObj.keyword = opts.keyword;
      if (opts.parent_ids && opts.parent_ids.length > 0) inputObj.parent_ids = opts.parent_ids;
      if (opts.file_exts && opts.file_exts.length > 0) inputObj.file_exts = opts.file_exts;
      if (opts.time_type) inputObj.time_type = opts.time_type;
      if (opts.start_time) inputObj.start_time = opts.start_time;
      if (opts.end_time) inputObj.end_time = opts.end_time;
      if (opts.scope && opts.scope.length > 0) inputObj.scope = opts.scope;
      if (pageToken) inputObj.page_token = pageToken;

      let success = false;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const { error, stdout } = await pacedKdocsCli(
          pacer,
          ['drive', 'search-files', '--output', 'json'], JSON.stringify(inputObj), 30000, 'search'
        );
        if (error && !stdout) {
          if (cached) {
            process.stderr.write(`[searchFilesAsync] 请求失败，使用过期缓存\n`);
            return cached.items;
          }
          if (attempt < MAX_RETRIES) {
            const delay = retryDelay(attempt);
            await sleep(delay);
            continue;
          }
          throw new Error(`search-files failed for drive=${opts.drive_ids.join(',')}: ${(error || '').substring(0, 100)}`);
        }
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch (e) {
          if (attempt < MAX_RETRIES) {
            const delay = retryDelay(attempt);
            await sleep(delay);
            continue;
          }
          throw new Error(`search-files JSON parse failed: ${e.message.substring(0, 100)}`);
        }
        if (parsed && parsed.code && parsed.code !== 0) {
          if (RETRY_CODES.has(parsed.code)) {
            if (cached) {
              process.stderr.write(`[searchFilesAsync] 限流 code=${parsed.code}，使用过期缓存\n`);
              return cached.items;
            }
            if (attempt < MAX_RETRIES) {
              const delay = retryDelay(attempt);
              await sleep(delay);
              continue;
            }
          }
          const msg = parsed.message || parsed.msg || parsed.error || '';
          const detail = parsed.detail || parsed.data?.message || parsed.data?.msg || '';
          const suffix = [msg, detail].filter(Boolean).join(' ');
          throw new Error(`search-files API error code=${parsed.code}${suffix ? `: ${suffix.substring(0, 200)}` : ''}`);
        }
        const data = (parsed && parsed.data && parsed.data.data) || {};
        const items = data.items || [];
        for (const item of items) {
          const file = item.file || item;
          allItems.push({
            ...normalizeKdocsFile(file, opts.drive_ids.length === 1 ? opts.drive_ids[0] : '')
          });
        }
        pageToken = data.next_page_token || data.page_token || null;
        success = true;
        break;
      }
      if (!success || !pageToken) break;
    }

  writeCache(cacheFile, { items: allItems, fetched_at: Date.now() });
  return allItems;
}

async function searchFilesAsyncRateLimited(opts, teamName, pacer) {
  if (getKdocsConfig().useSearch === false) {
    throw new Error('searchFilesAsync disabled by config.kdocs.useSearch=false');
  }

  const keyObj = {
    drive_ids: opts.drive_ids,
    parent_ids: opts.parent_ids || [],
    keyword: opts.keyword || '',
    file_exts: opts.file_exts || [],
    file_type: opts.file_type || 'file',
    time_type: opts.time_type || '',
    start_time: opts.start_time || 0,
    end_time: opts.end_time || 0,
    type: opts.type || 'all',
    scope: opts.scope || []
  };
  const cacheKey = crypto.createHash('sha1').update(JSON.stringify(keyObj)).digest('hex');
  const cacheFile = path.join(teamFoldersCacheDir(teamName), `search_${cacheKey}.json`);
  const cached = readCache(cacheFile);
  if (cached && (Date.now() - cached.fetched_at) < FOLDER_CACHE_TTL) return cached.items;
  if (pacer && typeof pacer.shouldPreferCache === 'function' && pacer.shouldPreferCache()) {
    if (typeof pacer.noteCacheRebuild === 'function') pacer.noteCacheRebuild('rate-limit-search-cache');
    if (!cached) return [];
    if (typeof pacer.noteStaleCacheFallback === 'function') pacer.noteStaleCacheFallback();
    return cached.items;
  }

  const allItems = [];
  let pageToken = null;

  for (let page = 0; page < 20; page++) {
    const inputObj = {
      drive_ids: opts.drive_ids,
      type: opts.type || 'all',
      file_type: opts.file_type || 'file',
      page_size: opts.page_size || 500,
      order_by: opts.order_by || 'mtime',
      order: opts.order || 'desc',
      with_link: opts.with_link !== undefined ? opts.with_link : true
    };
    if (opts.keyword) inputObj.keyword = opts.keyword;
    if (opts.parent_ids && opts.parent_ids.length > 0) inputObj.parent_ids = opts.parent_ids;
    if (opts.file_exts && opts.file_exts.length > 0) inputObj.file_exts = opts.file_exts;
    if (opts.time_type) inputObj.time_type = opts.time_type;
    if (opts.start_time) inputObj.start_time = opts.start_time;
    if (opts.end_time) inputObj.end_time = opts.end_time;
    if (opts.scope && opts.scope.length > 0) inputObj.scope = opts.scope;
    if (pageToken) inputObj.page_token = pageToken;

    let pageLoaded = false;
    let lastCode = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const { error, stdout } = await pacedKdocsCli(
        pacer,
        ['drive', 'search-files', '--output', 'json'],
        JSON.stringify(inputObj),
        30000,
        'search',
        () => {
          if (!pacer || typeof pacer.shouldPreferCache !== 'function' || !pacer.shouldPreferCache()) return null;
          if (typeof pacer.noteCacheRebuild === 'function') pacer.noteCacheRebuild('rate-limit-search-cache');
          if (!cached) return { skipped: true, stdout: JSON.stringify({ code: 0, data: { data: { items: [] } } }) };
          if (typeof pacer.noteStaleCacheFallback === 'function') pacer.noteStaleCacheFallback();
          return { skipped: true, stdout: JSON.stringify({ code: 0, data: { data: { items: cached.items } } }) };
        }
      );

        if (error && !stdout) {
          if (attempt < MAX_RETRIES) {
            if (pacer && typeof pacer.noteRetry === 'function') pacer.noteRetry();
            await sleep(retryDelay(attempt));
            continue;
          }
          if (cached) {
            if (pacer && typeof pacer.noteStaleCacheFallback === 'function') pacer.noteStaleCacheFallback();
            process.stderr.write(`[searchFilesAsync] request failed after retries, using stale cache\n`);
            return cached.items;
          }
        throw new Error(`search-files failed for drive=${opts.drive_ids.join(',')}: ${(error || '').substring(0, 100)}`);
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (e) {
        if (attempt < MAX_RETRIES) {
          if (pacer && typeof pacer.noteRetry === 'function') pacer.noteRetry();
          await sleep(retryDelay(attempt));
          continue;
        }
        throw new Error(`search-files JSON parse failed: ${e.message.substring(0, 100)}`);
      }

      if (parsed && parsed.code && parsed.code !== 0) {
        lastCode = parsed.code;
        if (RETRY_CODES.has(parsed.code)) {
          if (pacer && typeof pacer.noteRateLimit === 'function') pacer.noteRateLimit(shouldUseCacheImmediately(parsed) ? 0 : undefined);
          if (shouldUseCacheImmediately(parsed)) {
            if (pacer && typeof pacer.noteCacheRebuild === 'function') pacer.noteCacheRebuild('rate-limit-search-cache');
            if (cached) {
              if (pacer && typeof pacer.noteStaleCacheFallback === 'function') pacer.noteStaleCacheFallback();
              process.stderr.write(`[searchFilesAsync] rate limited code=${parsed.code}, using cached search data\n`);
              return cached.items;
            }
            process.stderr.write(`[searchFilesAsync] rate limited code=${parsed.code}, no cache available\n`);
            return [];
          }
          if (attempt < MAX_RETRIES) {
            if (pacer && typeof pacer.noteRetry === 'function') pacer.noteRetry();
            await sleep(retryDelay(attempt));
            continue;
          }
          if (cached) {
            if (pacer && typeof pacer.noteStaleCacheFallback === 'function') pacer.noteStaleCacheFallback();
            process.stderr.write(`[searchFilesAsync] rate limited code=${parsed.code} after retries, using stale cache\n`);
            return cached.items;
          }
        }
        const msg = parsed.message || parsed.msg || parsed.error || '';
        const detail = parsed.detail || parsed.data?.message || parsed.data?.msg || '';
        const suffix = [msg, detail].filter(Boolean).join(' ');
        throw new Error(`search-files API error code=${parsed.code}${suffix ? `: ${suffix.substring(0, 200)}` : ''}`);
      }

      const data = (parsed && parsed.data && parsed.data.data) || {};
      const items = data.items || [];
      for (const item of items) {
        const file = item.file || item;
        allItems.push({
            ...normalizeKdocsFile(file, opts.drive_ids.length === 1 ? opts.drive_ids[0] : '')
        });
      }
      pageToken = data.next_page_token || data.page_token || null;
      pageLoaded = true;
      if (pacer && typeof pacer.noteSuccess === 'function') pacer.noteSuccess();
      break;
    }

    if (!pageLoaded) {
      if (cached) {
        if (pacer && typeof pacer.noteStaleCacheFallback === 'function') pacer.noteStaleCacheFallback();
        process.stderr.write(`[searchFilesAsync] page failed${lastCode ? ` code=${lastCode}` : ''}, using stale cache\n`);
        return cached.items;
      }
      break;
    }
    if (!pageToken) break;
  }

  writeCache(cacheFile, { items: allItems, fetched_at: Date.now() });
  return allItems;
}

// ========== workspaceDir ==========
function resolveWorkspaceDir() {
  return path.resolve(__dirname, '..');
}

function ensureOutputDir() {
  const dir = path.join(resolveWorkspaceDir(), 'outputs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function outputPath(fileName) {
  return path.join(ensureOutputDir(), fileName);
}

function legacyPath(fileName) {
  return path.join(resolveWorkspaceDir(), fileName);
}

function findInputFile(fileName) {
  const modern = path.join(resolveWorkspaceDir(), 'outputs', fileName);
  if (fs.existsSync(modern)) return modern;
  const legacy = legacyPath(fileName);
  return fs.existsSync(legacy) ? legacy : modern;
}

function readInputJson(fileName) {
  return JSON.parse(fs.readFileSync(findInputFile(fileName), 'utf-8'));
}

function writeOutputJson(fileName, data) {
  const file = outputPath(fileName);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  return file;
}

function compactDateLabel(date) {
  return String(date || '').replace(/[^\d]/g, '');
}

function getBaselineFileName(startDate, endDate) {
  return `meeting-baseline-${compactDateLabel(startDate)}-${compactDateLabel(endDate)}.json`;
}

function getDocumentListFromTeamEntry(entry) {
  if (!entry) return [];
  if (entry.data && Array.isArray(entry.data.documents)) return entry.data.documents;
  if (Array.isArray(entry.documents)) return entry.documents;
  return [];
}

function getMeetingListItemsFromTeamEntry(entry) {
  if (!entry) return [];
  if (Array.isArray(entry.meetingListItems)) return entry.meetingListItems;
  return getDocumentListFromTeamEntry(entry).map(doc => ({
    name: doc.name || doc.title || '',
    id: doc.id || '',
    url: doc.url || ''
  }));
}

function createMeetingBaseline(teamEntries, options = {}) {
  const teams = (teamEntries || []).map(entry => {
    const team = entry.team || entry.teamName || (entry.data && entry.data.team) || '';
    const documents = getDocumentListFromTeamEntry(entry);
    const meetingListItems = getMeetingListItemsFromTeamEntry(entry);
    const successfulReadCount = documents.filter(doc =>
      (doc.rawContent && String(doc.rawContent).trim()) ||
      (Array.isArray(doc.conclusions) && doc.conclusions.length > 0) ||
      (Array.isArray(doc.todos) && doc.todos.length > 0)
    ).length;
    const analyzedDocumentCount = documents.length;
    const meetingListCount = Number(entry.meetingListCount || entry.totalScanned || meetingListItems.length || analyzedDocumentCount);
    return {
      team,
      meetingListCount,
      successfulReadCount,
      analyzedDocumentCount,
      scanCandidateCount: Number(entry.scanCandidateCount || entry.totalScanned || 0),
      excludedMeetingCount: Number(entry.excludedMeetingCount || 0),
      documentNames: documents.map(doc => doc.name || doc.title || '').filter(Boolean),
      meetingListItems,
      unreadableMeetings: Array.isArray(entry.unreadableMeetings) ? entry.unreadableMeetings : [],
      excludedMeetings: Array.isArray(entry.excludedMeetings) ? entry.excludedMeetings : []
    };
  });

  const counts = teams.reduce((acc, team) => {
    acc.meetingListCount += team.meetingListCount;
    acc.successfulReadCount += team.successfulReadCount;
    acc.analyzedDocumentCount += team.analyzedDocumentCount;
    return acc;
  }, { meetingListCount: 0, successfulReadCount: 0, analyzedDocumentCount: 0 });

  if (Number.isFinite(Number(options.meetingListCount))) {
    counts.meetingListCount = Number(options.meetingListCount);
  }

  const unreadableMeetings = (options.unreadableMeetings || teams.flatMap(team =>
    (team.unreadableMeetings || []).map(item => ({ team: team.team, ...item }))
  )).filter(Boolean);
  const excludedMeetings = (options.excludedMeetings || teams.flatMap(team =>
    (team.excludedMeetings || []).map(item => ({ team: team.team, ...item }))
  )).filter(Boolean);

  return {
    version: 2,
    source: options.source || 'batch-read-documents',
    startDate: options.startDate || '',
    endDate: options.endDate || '',
    generatedAt: new Date().toISOString(),
    counts,
    teams,
    unreadableMeetings,
    excludedMeetings
  };
}

function writeMeetingBaseline(teamEntries, options = {}) {
  const baseline = createMeetingBaseline(teamEntries, options);
  const file = writeOutputJson(getBaselineFileName(options.startDate, options.endDate), baseline);
  return { baseline, file };
}

function readMeetingBaseline(startDate, endDate) {
  const fileName = getBaselineFileName(startDate, endDate);
  const file = findInputFile(fileName);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function getRiskImpactScope(risk) {
  const team = String((risk && risk.team) || '').trim();
  const label = String((risk && risk.label) || '').trim();
  if (team && label && label !== team) return `${team}-${label}`;
  return team || label || '未明确';
}

function classifyMeetingType(title) {
  const text = String(title || '');
  const rules = [
    ['合规/培训会', /法务|合规|版权|培训|宣讲|风控|维权/],
    ['AI应用会', /AI|ai|GPT|Codex|MCP|智能|自动化|工具链|效率提升|知识库|大模型/],
    ['项目核心会', /核心会|核心组|主创会/],
    ['项目进度会', /进度会|双周进度|进展|里程碑|排期/],
    ['管理例会', /管理例会|管理会|经营会/],
    ['平台建设会', /平台|工作流|流水线|工具建设|系统建设/],
    ['分享培训会', /分享会|应用与实践|讲师|培训|宣讲|经验分享/],
    ['项目汇报会', /汇报会|述职|汇报/],
    ['生产标准会', /生产体系|标准化|规范|流程建设|制作标准/],
    ['项目例会', /例会/],
    ['技术专项会', /技术|性能|引擎|编辑器|GPU|客户端|服务端|专项|专题/],
    ['质量测试会', /质量|测试|Bug|缺陷|验收|提测|回归/],
    ['运营发行会', /运营|发行|渠道|买量|商业化|用户|活动|周年庆|营销/],
    ['产品策划会', /策划|规划|方案|需求|版本|玩法|体验/],
    ['项目周会', /周会|周例会|周报/],
    ['晨会/站会', /晨会|站会|daily|日报/i],
    ['沟通同步会', /沟通|同步|对齐|交流|讨论|碰头/],
    ['复盘会', /复盘|总结|回顾/],
    ['评审会', /评审|评估|审查/],
    ['组织管理会', /人力|组织|OKR|OGR|绩效|招聘|外包|行政/]
  ];
  for (const [label, pattern] of rules) {
    if (pattern.test(text)) return label;
  }
  return '其他';
}

function summarizePrimaryMeetingTypes(documents, limit = 2) {
  const counts = new Map();
  for (const doc of documents || []) {
    const type = classifyMeetingType(doc.name || doc.title || doc.text || '');
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return sorted.slice(0, limit).map(([type, count]) => `${type}(${count})`).join('、') || '无';
}

function cleanParticipantLine(line) {
  return String(line || '')
    .replace(/^[\s\-*•]+/, '')
    .replace(/\s{2,}$/g, '')
    .trim();
}

function normalizePersonChars(text) {
  return String(text || '').replace(/⼈/g, '人');
}

function extractParticipants(markdown) {
  const text = normalizePersonChars(markdown).replace(/\r\n/g, '\n');
  const participantLabel = '(?:参会人员|参会人|参会|参与人员|参与人|与会人员|与会人|参加人员|参加人|出席人员|出席者|出席人|出席)';
  const inlinePatterns = [
    new RegExp(`${participantLabel}[：:]\\s*([^\\n|]+)`),
    new RegExp(`\\|\\s*${participantLabel}\\s*\\|\\s*([^|\\n]+)\\s*\\|`)
  ];

  for (const pattern of inlinePatterns) {
    const match = text.match(pattern);
    if (match) {
      const value = cleanParticipantLine(match[1]);
      if (value) return value;
    }
  }

  const lines = text.split('\n');
  const labelRe = new RegExp(participantLabel);
  const sectionHeadingRe = /^\s{0,3}#{1,6}\s*/;
  const bracketedLabelRe = new RegExp(`^\\s{0,3}#{0,6}\\s*(?:[【\\[])?${participantLabel}(?:[】\\]])?[：:]?\\s*$`);

  function isCandidate(line) {
    const value = cleanParticipantLine(line)
      .replace(/^@+/, '')
      .replace(/^\|+|\|+$/g, '')
      .trim();
    if (!value) return false;
    if (sectionHeadingRe.test(value)) return false;
    if (labelRe.test(value)) return false;
    if (/^(会议记录|会议纪要|会议时间|时间|要点速览|精选纪要|正文)[：:]?$/.test(value)) return false;
    if (/^\d{4}[.\-/年]\s*\d{1,2}[.\-/月]\s*\d{1,2}/.test(value)) return false;
    if (/^https?:\/\//i.test(value)) return false;
    return value.length <= 500;
  }

  function candidateValue(line) {
    return cleanParticipantLine(line)
      .replace(/^\|+|\|+$/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!labelRe.test(line)) continue;

    const afterLabel = line
      .replace(new RegExp(`^\\s{0,3}#{0,6}\\s*(?:[【\\[])?${participantLabel}(?:[】\\]])?\\s*[：:]?\\s*`), '');
    if (isCandidate(afterLabel)) return candidateValue(afterLabel);

    for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
      const current = lines[j];
      if (sectionHeadingRe.test(current) && !bracketedLabelRe.test(current)) break;
      if (/会议时间|时间|会议记录|会议纪要|正文/.test(current) && !isCandidate(current)) break;
      if (isCandidate(current)) return candidateValue(current);
    }

    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      const current = lines[j];
      if (sectionHeadingRe.test(current)) break;
      if (isCandidate(current)) return candidateValue(current);
    }
  }

  return '';
}

// ========== 从 Markdown 提取会议信息 ==========
function extractInfo(markdown, fileName, importantPeople) {
  const conclusions = [];
  const todos = [];
  let participants = '';
  let meetingTime = '';

  participants = extractParticipants(markdown);

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

function stripDocExt(name) {
  return String(name || '').replace(/\.(otl|docx)$/i, '');
}

function formatSourceRef(teamName, docOrName, options = {}) {
  const doc = typeof docOrName === 'string' ? { name: docOrName } : (docOrName || {});
  const docName = stripDocExt(doc.name || doc.title || options.docName || '');
  const baseTeam = options.teamName || teamName || '';
  const label = options.label || doc.sourceLabel || '';
  const parts = [baseTeam];
  if (label && label !== baseTeam) parts.push(label);
  if (docName) parts.push(docName);
  return parts.filter(Boolean).join('-');
}

function withSourceRef(text, source) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (/（来源[:：]/.test(t)) return t;
  return source ? `${t}（来源：${source}）` : t;
}

function stripInlineSourceRefs(text) {
  return String(text || '')
    .replace(/（来源[:：][^）]*）/g, '')
    .replace(/\(来源[:：][^)]*\)/g, '')
    .replace(/；\s*来源[:：][^；。]*([。；]?)/g, '$1')
    .replace(/，\s*来源[:：][^，。]*([。，]?)/g, '$1')
    .replace(/\s*-\s*会议记录）/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeMultiSourceBulletPrefixes(markdown, teamNames = []) {
  let result = String(markdown || '');
  for (const teamName of teamNames || []) {
    if (!teamName) continue;
    const teamRe = escapeRegExp(teamName);
    const re = new RegExp(
      `(^\\s*(?:[•\\-*]|\\d+[.、])\\s*)【${teamRe}】([^\\n]*(?:（来源：|\\(来源:|\\(来源：)${teamRe}-([^\\s\\-（）()]+)-)`,
      'gm'
    );
    result = result.replace(re, (match, bulletPrefix, rest, label) => {
      if (!label || label === teamName) return match;
      return `${bulletPrefix}【${teamName}-${label}】${rest}`;
    });
  }
  return result;
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
  let allConclusionItems = [], allTodoItems = [];

  documents.forEach(d => {
    const splitConclusions = splitConcatenated(d.conclusions || []);
    const splitTodos = splitConcatenated(d.todos || []);
    const source = formatSourceRef(teamName, d, options);
    totalConclusions += splitConclusions.length;
    totalTodos += splitTodos.length;
    allConclusions.push(...splitConclusions);
    allTodos.push(...splitTodos);
    allConclusionItems.push(...splitConclusions.map(text => ({ text, source, sourceLabel: d.sourceLabel || '', docName: stripDocExt(d.name || '') })));
    allTodoItems.push(...splitTodos.map(text => ({ text, source, sourceLabel: d.sourceLabel || '', docName: stripDocExt(d.name || '') })));
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
          allConclusionItems.push({
            text: topic,
            source: formatSourceRef(teamName, d, options),
            sourceLabel: d.sourceLabel || '',
            docName: stripDocExt(d.name || '')
          });
        }
      }
    }
  });

  // 风险分析：从 conclusions+todos + 全文扫描
  let riskMap = new Map();
  function addRisk(cleaned, level, matchedKw, source) {
    const existing = riskMap.get(cleaned);
    if (existing) {
      if (level === 'high' && existing.level === 'mid') {
        riskMap.set(cleaned, { keyword: matchedKw, text: cleaned, level: 'high', source: source || existing.source || '' });
      } else if (!existing.source && source) {
        existing.source = source;
      }
    } else {
      riskMap.set(cleaned, { keyword: matchedKw, text: cleaned, level, source: source || '' });
    }
  }

  function matchRisk(text, source = '') {
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
      addRisk(truncated, level, matchedKw, source);
    }
  }

  [...allConclusionItems, ...allTodoItems].forEach(item => matchRisk(item.text, item.source));

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
        matchRisk(frag, formatSourceRef(teamName, d, options));
      }
    }
  });

  let highRisks = [], midRisks = [];
  for (const [, r] of riskMap) {
    if (r.level === 'high') {
      const isDup = highRisks.some(e => textSimilar(e.text, r.text) > 0.6);
      if (!isDup) highRisks.push({ keyword: r.keyword, text: r.text, source: r.source || '' });
    } else {
      const isDupHigh = highRisks.some(e => textSimilar(e.text, r.text) > 0.6);
      if (isDupHigh) continue;
      const isDupMid = midRisks.some(e => textSimilar(e.text, r.text) > 0.6);
      if (!isDupMid) midRisks.push({ keyword: r.keyword, text: r.text, source: r.source || '' });
    }
  }

  // 时间节点提取：从 todos + 全文扫描
  const timeNodePattern = /(\d{4}[年\-]\d{1,2}[月\-]\d{1,2}[日号]?|\d{1,2}[.月]\s*\d{1,2}[日号]?|\d{1,2}月(?:\d{1,2}[日号])?|年底|年中|季度末|季度|上半年|下半年)/;
  let timeNodes = [];

  function extractTimeNode(text, docInfo) {
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
    const source = docInfo ? formatSourceRef(teamName, docInfo, options) : '';
    if (dateStr) {
      const truncated = cleaned.length > 100 ? cleaned.substring(0, 97) + '...' : cleaned;
      timeNodes.push({ text: truncated, owner: owner || teamName || '', dateStr, source });
    }
  }

  // 从 todos 提取
  documents.forEach(d => {
    const splitTodos = splitConcatenated(d.todos || []);
    splitTodos.forEach(t => extractTimeNode(t, d));
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
        extractTimeNode(frag, d);
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
  allConclusionItems = allConclusionItems
    .map(item => ({ ...item, text: cleanText(item.text) }))
    .filter(item => isValidConclusion(item.text));
  allTodoItems = allTodoItems
    .map(item => ({ ...item, text: cleanText(item.text) }))
    .filter(item => isValidConclusion(item.text));

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
    allConclusions, allTodos, allConclusionItems, allTodoItems,
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
      const allItems = [...(td.analysis.allConclusionItems || []), ...(td.analysis.allTodoItems || [])];
      const matches = allItems.filter(item => theme.pattern.test(item.text));
      if (matches.length === 0) continue;
      const docCount = td.data.documents.length;
      const meetingHits = td.data.documents.filter(d => {
        const text = [...(d.conclusions || []), ...(d.todos || [])].join(' ');
        return theme.pattern.test(text);
      }).length;
      const pct = Math.round((meetingHits / docCount) * 100);
      const examples = matches.slice(0, 4).map(item => withSourceRef(item.text.substring(0, 50), item.source));
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
        nodesByTeam[td.teamName] = nodes.slice(0, 5).map(n => `${n.dateStr} ${withSourceRef(n.text.substring(0, 30), n.source)}`);
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
        files.push(normalizeKdocsFile(item, driveId));
      }
    }
  }
  return files;
}

// ========== 标题标准化 ==========
function normalizeTitle(raw, explicitDate = null) {
  const yearStr = String(currentYear());
  let t = raw.trim();
  let dateStr = '';

  t = t.replace(/\.otl$/i, '').replace(/\.docx$/i, '');
  t = t.replace(/^《|》$/g, '');

  const extractedDate = explicitDate || extractDateFromFileName(t);
  if (extractedDate) {
    dateStr = `${yearStr}${String(extractedDate.month).padStart(2, '0')}${String(extractedDate.day).padStart(2, '0')}`;
  }

  // 1. YYYYMMDD（可能紧跟 HHMMSS 时间戳）
  const yearRe = new RegExp(yearStr + '[.\\-]?(\\d{1,2})[.\\-]?(\\d{2})');
  let m = t.match(yearRe);
  if (m) {
    t = t.replace(m[0], '');
    t = t.replace(/^\s*\d{6}\s*/, '');
  }

  // 1.5 两位年份：260506、26.3.30
  if (dateStr) {
    const shortYear = yearStr.slice(-2);
    const prevShortYear = String(currentYear() - 1).slice(-2);
    const shortYearRe = new RegExp(`(^|\\D)(?:${shortYear}|${prevShortYear})[.\\-]?\\d{1,2}[.\\-]?\\d{2}(?=\\D|$)`);
    t = t.replace(shortYearRe, '$1');
  }

  // 2. MMDD- 前缀
  m = t.match(/^(\d{2})(\d{2})\s*[\-—–]/);
  if (m) {
    t = t.replace(m[0], '');
  }

  // 3. 中文日期：X月Y日 或 YYYY年X月Y日
  m = t.match(/(?:\d{4}\s*年?\s*)?\d{1,2}\s*月\s*\d{1,2}\s*日?/);
  if (m) {
    t = t.replace(m[0], '');
  }

  // 4. 无年份 M.D / MM-DD 前缀
  m = t.match(/^\s*(\d{1,2})[.\-](\d{1,2})(?=\D|$)\s*/);
  if (m) {
    t = t.replace(m[0], '');
  }

  t = t.replace(/（[^）]*\d+月\d+日[^）]*）?/g, '');
  t = t.replace(/\([^)]*\d+月\d+日[^)]*\)?/g, '');
  t = t.replace(/_/g, ' ');
  t = t.replace(/[\-—–]{2,}/g, '-');
  t = t.replace(/^[\s\-—–_·．|｜《》【】]+/, '');
  t = t.replace(/[\s\-—–_·．|｜《》【】）]+$/, '');
  t = t.replace(/^【纪要】\s*/, '');
  t = t.replace(/\s*[\-—–·]\s*周?会议记录\s*$/, '');
  t = t.replace(/\s*周?会议记录\s*$/, '');
  t = t.replace(/\s*[\-—–·]\s*结构性会议记录\s*$/, '');
  t = t.replace(/\s*[\-—–·]\s*结构性纪要\s*$/, '');
  t = t.replace(/\s*[\-—–·]\s*结构性会议\s*$/, '');
  t = t.replace(/\s*[\-—–·]\s*结构性\s*$/, '');
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

// ========== 解析 config.json 中 ${ENV_VAR} 占位符 ==========
function resolveConfigPlaceholders(obj) {
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      result[k] = v.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || '');
    } else {
      result[k] = v;
    }
  }
  return result;
}

// ========== 读取 OpenClaw 所有 provider ==========
function resolveOpenClawConfigPath() {
  const candidates = [];
  // 1. 从脚本路径往上推导 .openclaw 目录
  const scriptDir = path.resolve(__dirname);
  const ocIdx = scriptDir.indexOf('.openclaw');
  if (ocIdx >= 0) {
    candidates.push(path.join(scriptDir.substring(0, ocIdx + '.openclaw'.length), 'openclaw.json'));
  }
  // 2. 从 cwd 往上推导
  const cwd = process.cwd();
  const cwdIdx = cwd.indexOf('.openclaw');
  if (cwdIdx >= 0) {
    candidates.push(path.join(cwd.substring(0, cwdIdx + '.openclaw'.length), 'openclaw.json'));
  }
  // 3. 环境变量
  const home = process.env.OPENCLAW_HOME || process.env.USERPROFILE || process.env.HOME;
  if (home) candidates.push(path.join(home, '.openclaw', 'openclaw.json'));
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveOpenClawProviders() {
  const providers = [];
  try {
    const cfgPath = resolveOpenClawConfigPath();
    if (!cfgPath) return providers;
    const data = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    const provMap = data.models?.providers || {};
    const preferredModels = ['mimo-v2-pro', 'glm-5.1', 'mco-4', 'deepseek-v3.2', 'kimi-k2.5'];
    for (const [name, cfg] of Object.entries(provMap)) {
      const resolvedCfg = resolveConfigPlaceholders(cfg);
      if (!resolvedCfg.baseUrl || !resolvedCfg.apiKey) continue;
      const models = resolvedCfg.models || [];
      const picked = models.find(m => preferredModels.includes(m.id)) || models[0];
      if (!picked) continue;
      providers.push({
        providerName: name,
        baseUrl: resolvedCfg.baseUrl.replace(/\/+$/, ''),
        apiKey: resolvedCfg.apiKey,
        model: picked.id
      });
    }
  } catch (e) {
    process.stderr.write(`[resolveOpenClawProviders] ${e.message}\n`);
  }
  return providers;
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

  // 1. config.json 显式配了 API 地址（支持 ${ENV_VAR} 占位符）
  if (llmCfg.baseUrl && llmCfg.apiKey) {
    const resolved = resolveConfigPlaceholders(llmCfg);
    const model = resolved.model || 'default';
    console.log(`[callLLM] 使用配置的 API: ${resolved.baseUrl} (model: ${model})`);
    const result = await callLLMApi(resolved.baseUrl, resolved.apiKey, model, prompt, timeout);
    if (result) return result;
    console.log('[callLLM] API 调用失败，尝试下一个后端...');
  }

  // 2. 自动检测 OpenClaw 环境（遍历所有 provider 逐个回退）
  const providers = resolveOpenClawProviders();
  if (providers.length === 0) {
    const cfgPath = resolveOpenClawConfigPath();
    console.log(`[callLLM] OpenClaw 配置查找: ${cfgPath || '未找到 openclaw.json'}（__dirname=${__dirname}, cwd=${process.cwd()}）`);
  }
  for (const oc of providers) {
    console.log(`[callLLM] 尝试 OpenClaw provider: ${oc.providerName} / ${oc.model} (${oc.baseUrl})`);
    const result = await callLLMApi(oc.baseUrl, oc.apiKey, oc.model, prompt, timeout);
    if (result) return result;
    console.log(`[callLLM] ${oc.providerName} 调用失败，尝试下一个...`);
  }

  if (providers.length === 0 && !llmCfg.baseUrl) {
    console.log('[callLLM] 无可用 LLM 后端（config.json 未配置 API，OpenClaw 未安装），回退到规则分析');
  } else {
    console.log('[callLLM] 所有 LLM 后端均失败，回退到规则分析');
  }
  return null;
}

// ========== 综合报告 prompt ==========
function compactOneTeamSummaryForComprehensive(summary, options = {}) {
  const maxChars = Math.max(600, Number(options.maxCharsPerTeam) || 2600);
  const text = String(summary || '').replace(/\r\n/g, '\n');
  if (text.length <= maxChars) return text.trim();

  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const mustKeepPatterns = [
    /^#{1,4}\s+/,
    /风险|高风险|中风险|阻塞|延期|异常|缺口|问题|隐患|风险点/,
    /节点|时间|日期|上线|交付|验收|评审|里程碑|05-|06-|07-|08-|\d{1,2}月\d{1,2}日/,
    /建议|行动|跟进|待办|决策|结论|关键|核心|趋势|发现/,
    /\|.*\|/,
    /来源|source/i,
  ];
  const weakFillerPatterns = [
    /普通过程描述/,
    /背景说明/,
    /详细讨论过程/,
    /会议过程记录/,
  ];

  const selected = [];
  const seen = new Set();
  function addLine(line) {
    const normalized = line.replace(/\s+/g, ' ').slice(0, 220);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    selected.push(normalized);
  }

  for (const line of lines) {
    if (mustKeepPatterns.some(pattern => pattern.test(line))) addLine(line);
  }

  if (selected.length < 8) {
    for (const line of lines) {
      if (weakFillerPatterns.some(pattern => pattern.test(line))) continue;
      addLine(line);
      if (selected.length >= 16) break;
    }
  }

  let compacted = selected.join('\n');
  if (compacted.length > maxChars) {
    const capped = [];
    let total = 0;
    for (const line of selected) {
      const nextTotal = total + line.length + 1;
      if (nextTotal > maxChars) break;
      capped.push(line);
      total = nextTotal;
    }
    compacted = capped.join('\n');
  }

  return compacted.trim() || text.slice(0, maxChars).trim();
}

function compactTeamSummariesForComprehensive(teamSummaries, options = {}) {
  const result = {};
  for (const [teamName, summary] of Object.entries(teamSummaries || {})) {
    result[teamName] = compactOneTeamSummaryForComprehensive(summary, options);
  }
  return result;
}

function summarizeTeamSummaryCompression(rawSummaries, compactedSummaries) {
  const rawChars = Object.values(rawSummaries || {}).reduce((sum, text) => sum + String(text || '').length, 0);
  const compactChars = Object.values(compactedSummaries || {}).reduce((sum, text) => sum + String(text || '').length, 0);
  const savedChars = Math.max(0, rawChars - compactChars);
  const ratio = rawChars > 0 ? Math.round((compactChars / rawChars) * 100) : 100;
  return { rawChars, compactChars, savedChars, ratio };
}

function buildComprehensiveReportPrompt(teamDataList, options = {}) {
  const { startDate, endDate, grandTotalDocs, teamCount, teamSummaries, multiSourceTeamNames } = options;
  const reportLimits = options.reportLimits || {};
  const promptMinItems = Number(reportLimits.promptMinItems) || 5;
  const promptMaxItems = Number(reportLimits.promptMaxItems) || 12;
  const compactTeamSummaries = options.compactTeamSummaries !== false;
  const activeTeamSummaries = teamSummaries && compactTeamSummaries
    ? compactTeamSummariesForComprehensive(teamSummaries, { maxCharsPerTeam: options.maxTeamSummaryChars })
    : teamSummaries;
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
  parts.push('7. 报告面向对外阅读，正文段落和普通 bullet 不要在句尾输出"（来源：...）"；来源只保留在表格的"来源会议"列以及附录中。');
  parts.push('');
  parts.push(`基于以下 ${teamCount || teamDataList.length} 个团队共 ${grandTotalDocs || '若干'} 份会议记录的汇总数据（${startDate} ~ ${endDate}），`);
  parts.push('请为综合分析报告生成全部分析内容。');
  parts.push('');

  for (const td of teamDataList) {
    const summary = activeTeamSummaries && activeTeamSummaries[td.teamName];
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
        const name = formatSourceRef(td.teamName, d);
        parts.push(`  - ${name}（结论${(d.conclusions||[]).length}条，待办${(d.todos||[]).length}条${d.important ? '，重要' : ''}）`);
      });
      parts.push('');
      if (a.topicCategories && a.topicCategories.length > 0) {
        parts.push(`议题分布：${a.topicCategories.map(([l, c]) => `${l}(${c}场)`).join('、')}`);
        parts.push('');
      }
      parts.push('### 核心议题');
      (a.allConclusionItems || []).forEach(item => parts.push(`• ${withSourceRef(item.text, item.source)}`));
      parts.push('');
      parts.push('### 关键待办');
      (a.allTodoItems || []).forEach(item => parts.push(`• ${withSourceRef(item.text, item.source)}`));
      parts.push('');
      if (a.highRisks.length > 0 || a.midRisks.length > 0) {
        parts.push(`### 风险事项（高${a.highRisks.length}项，中${a.midRisks.length}项）`);
        a.highRisks.forEach(r => parts.push(`• [高][${r.keyword}] ${withSourceRef(r.text, r.source)}`));
        a.midRisks.forEach(r => parts.push(`• [中][${r.keyword}] ${withSourceRef(r.text, r.source)}`));
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
  parts.push(`第四章的"核心议题"和"关键决议"每个团队输出 ${promptMinItems}-${promptMaxItems} 条；数据足够时优先接近上限，不要固定只写3条。`);
  parts.push('请按以下结构输出纯 markdown（不要代码块包裹），从"## 1.2 主要趋势"开始：');
  parts.push('');
  parts.push('## 1.2 主要趋势');
  parts.push('按公司层级信息贯通进行总结，列出5-6条跨团队、跨项目的主要趋势；不要照抄用户参考条目，不要按单个团队流水账罗列。每条用自然段式bullet输出，先写公司层面的趋势判断，再串联支撑该趋势的部门/项目事实。');
  if (msNames.length > 0) {
    parts.push(`多source团队（${msNames.join('、')}）格式：• 【团队名-label】趋势描述。`);
    parts.push('label 只能使用上方数据来源中已给出的 config sourceLabel，禁止从会议标题、括号分类或正文小标题中自行提取 label。');
  }
  parts.push('');
  parts.push('# 二、风险点分析');
  parts.push('先写一句概述，然后：');
  parts.push('## 2.1 高风险事项');
  parts.push('仅从上面"风险事项"章节中标记为[高]的条目中提取，用原文改写，不得新增数据中不存在的风险。');
  parts.push('只保留对交付、质量、合规或用户体验影响最大的3-6条，合并同类项，避免把所有高风险原样堆叠。每条格式：• 【高】风险描述（不超过120字）。禁止在【高】后面加 **加粗小标题**，直接写风险描述。没有则写"本期未发现高风险事项。"');
  parts.push('## 2.2 中风险事项');
  parts.push('仅从上面标记为[中]的条目中提取，保留5-8条代表性事项，合并同类项。每条格式：• 【中】风险描述。禁止在【中】后面加 **加粗小标题**，直接写风险描述。');
  parts.push('## 2.3 风险矩阵');
  parts.push('输出markdown表格，只保留3列：风险项、等级、影响范围。去掉量化影响和来源会议两列；影响范围必须填写所属部门或项目名称，不要写泛化影响描述。仅包含2.1和2.2中已列出的风险，不得新增。');
  parts.push('| 风险项 | 等级 | 影响范围 |');
  parts.push('|--------|------|----------|');
  parts.push('| 剑侠世界4外网性能不达标 | 高 | 剑侠世界系列 |');
  parts.push('');
  parts.push('# 三、重点关注节点');
  parts.push('先写一句概述，然后：');
  parts.push('## 3.1 近期节点（本月内）');
  parts.push('仅从上面"时间节点"章节中提取，不得编造不存在的时间节点。');
  parts.push('输出markdown表格，4列：节点、时间、负责人/部门、状态。');
  parts.push('⚠️ 负责人/部门必须是数据中的团队名称（即上面各"# 团队名"标题），不得填写会议内容中提到的内部小组或个人名（如"引擎组""测试团队"等）。');
  parts.push('⚠️ 状态从以下选择：冲刺中、筹备中、开发中、制作中、推进中、已过审、已执行、加急中。');
  parts.push('例如：');
  parts.push('| 节点 | 时间 | 负责人/部门 | 状态 |');
  parts.push('|------|------|-------------|------|');
  if (msNames.length > 0) {
    parts.push('| 完成新粒子系统适配 | 05-26 | 经典剑侠系列 | 开发中 |');
  }
  parts.push('| 跟进需求管理 | 05-14 | 音频中心 | 推进中 |');
  parts.push('没有则写"本月内暂无明确时间节点。"');
  parts.push('## 3.2 中期节点（未来两个月）');
  parts.push('同上格式和规则的markdown表格，仅从数据中已识别的中期节点提取');
  parts.push('## 3.3 持续跟进事项');
  parts.push('无明确时间节点但需持续跟进的重要事项，用•列表，格式：• 【团队名】事项描述；多source团队必须用格式：• 【团队名-label】事项描述。正文不输出来源尾注。');
  parts.push('');
  parts.push('# 四、各团队会议汇总');
  parts.push('对每个团队写一个小节：');
  parts.push('## 团队名');
  parts.push('### 会议统计');
  parts.push('用一句话总结会议数量、核心议题数、关键决议数和重要会议数，语气保持外发报告风格。');
  parts.push('### 核心议题');
  parts.push(`仅从该团队的"核心议题"数据中概括，3-8条（•列表），每条用一句话概括原文结论，不输出来源尾注。`);
  if (msNames.length > 0) {
    parts.push(`多source团队（${msNames.join('、')}）的每条必须加【团队名-label】前缀，如：• 【剑网3系列-剑网3】xxx`);
  }
  parts.push('### 关键决议');
  parts.push(`仅从该团队的结论数据中提取，3-8条（•列表），直接引用或简述原文决议内容，不输出来源尾注。`);
  if (msNames.length > 0) {
    parts.push('多source团队的每条必须加【团队名-label】前缀');
  }
  parts.push('');
  parts.push('');
  parts.push('⚠️ 来源标注规则（所有章节统一执行）：');
  parts.push('- 正文段落与普通 bullet 不写来源尾注；只在风险矩阵和附录的"来源会议"列中保留来源。');
  parts.push('- 单source团队表格来源格式：团队名-会议记录文件名，例如：SEED-20260507-项目周会-会议记录');
  if (msNames.length > 0) {
    parts.push(`- 多source团队（${msNames.join('、')}）表格来源格式：团队名-label-会议记录文件名，例如：经典剑侠系列-大部门-20260512-经典剑侠项目周例会`);
    parts.push('- label 必须严格来自 config.json 的 sources[].label；禁止使用会议标题中的【剧情】、【专项】等文本替代 label。');
  }
  parts.push('');
  if (msNames.length > 0) {
    parts.push('⚠️ 多source团队内容分离规则：');
    parts.push(`${msNames.join('、')}这${msNames.length}个团队包含多个子项目（数据中已用## 子项目名分隔），`);
    parts.push('在所有章节中必须用【团队名-label】标注每条内容的归属，不同子项目的内容不得混淆。');
    parts.push('例如：• 【剑网3系列-剑网3】xxx、• 【剑网3系列-剑网3缘起】xxx。第四章按子项目分小节。');
  }
  parts.push('');
  parts.push('# 五、综合评估与建议');
  parts.push('按战略主题分组撰写（不按团队分组），4-5个主题，主题应类似"版本发布与质量保障 / AI应用与效能提升 / 项目风险管控 / 团队协同与流程规范 / 合规与风险前置管理"，每个：');
  parts.push('## 5.N 主题标题');
  parts.push('概述段落（1段，直接引用数据中的具体事实但不写来源尾注）');
  parts.push('• **推进较好**：团队名（引用该团队数据中的具体结论或待办原文作为依据）');
  parts.push('• **推进一般**：团队名（同上，必须有数据支撑）');
  parts.push('• **待加强**：团队名（同上，必须有数据支撑）');
  parts.push('（某个分级如果数据中找不到支撑依据则省略该分级，不要强凑）');
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
  const reportLimits = options.reportLimits || {};
  const promptMinItems = Number(reportLimits.promptMinItems) || 5;
  const promptMaxItems = Number(reportLimits.promptMaxItems) || 12;
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
    parts.push(`  来源：${formatSourceRef(teamName, doc)}`);
    if (doc.conclusions && doc.conclusions.length > 0) {
      doc.conclusions.forEach(c => parts.push(`  结论：${withSourceRef(c, formatSourceRef(teamName, doc))}`));
    }
    if (doc.todos && doc.todos.length > 0) {
      doc.todos.forEach(t => parts.push(`  待办：${withSourceRef(t, formatSourceRef(teamName, doc))}`));
    }
    parts.push('');
  }

  if (analysis.topicCategories && analysis.topicCategories.length > 0) {
    parts.push(`议题分布：${analysis.topicCategories.map(([l, c]) => `${l}(${c}场)`).join('、')}`);
    parts.push('');
  }
  if (analysis.highRisks.length > 0 || analysis.midRisks.length > 0) {
    parts.push('## 已识别风险');
    analysis.highRisks.forEach(r => parts.push(`• [高][${r.keyword}] ${withSourceRef(r.text, r.source)}`));
    analysis.midRisks.forEach(r => parts.push(`• [中][${r.keyword}] ${withSourceRef(r.text, r.source)}`));
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
  parts.push(`第四章的"核心议题"和"关键决议"分别输出 ${promptMinItems}-${promptMaxItems} 条；数据足够时优先接近上限，不要固定只写3条。`);
  parts.push('请按以下结构输出纯 markdown（不要代码块包裹），从"## 1.2 主要趋势"开始：');
  parts.push('');
  parts.push('## 1.2 主要趋势');
  parts.push('按公司层级信息贯通进行总结，列出5-6条跨团队、跨项目的主要趋势；不要照抄用户参考条目，不要按单个团队流水账罗列。每条用自然段式bullet输出，先写公司层面的趋势判断，再串联支撑该趋势的部门/项目事实。');
  parts.push('');
  parts.push('# 二、风险点分析');
  parts.push('先写一句概述，然后：');
  parts.push('## 2.1 高风险事项');
  parts.push('仅从上面"已识别风险"中标记为[高]的条目提取，用原文改写，不得新增数据中不存在的风险。');
  parts.push('每条格式：• 【高】风险描述（不超过120字）（来源：团队名-文档标题；多source用团队名-label-文档标题）。没有则写"本期未发现高风险事项。"');
  parts.push('## 2.2 中风险事项');
  parts.push('仅从上面标记为[中]的条目提取。每条格式：• 【中】风险描述（来源：团队名-文档标题；多source用团队名-label-文档标题）');
  parts.push('## 2.3 风险矩阵');
  parts.push('输出markdown表格，只保留3列：风险项、等级、影响范围。去掉量化影响和来源会议两列；影响范围必须填写所属部门或项目名称，不要写泛化影响描述。仅包含2.1和2.2中已列出的风险，不得新增。');
  parts.push('| 风险项 | 等级 | 影响范围 |');
  parts.push('|--------|------|----------|');
  parts.push('| 剑侠世界4外网性能不达标 | 高 | 剑侠世界系列 |');
  parts.push('');
  parts.push('# 三、重点关注节点');
  parts.push('先写一句概述，然后：');
  parts.push('## 3.1 近期节点（本月内）');
  parts.push('仅从上面"已识别时间节点"中提取，不得编造不存在的时间节点。');
  parts.push('输出markdown表格，4列：时间节点、责任方、关键事项、来源会议（单source格式：团队名-文档标题；多source格式：团队名-label-文档标题）。没有则写"本月内暂无明确时间节点。"');
  parts.push('## 3.2 中期节点（未来两个月）');
  parts.push('同上格式的markdown表格，仅从数据中已识别的中期节点提取');
  parts.push('## 3.3 持续跟进事项');
  parts.push('无明确时间节点但需持续跟进的重要事项，用•列表，每条注明来源（单source格式：团队名-文档标题；多source格式：团队名-label-文档标题）；多source团队必须用【团队名-label】前缀');
  parts.push('');
  parts.push('# 四、团队会议汇总');
  parts.push('### 核心议题');
  parts.push(`仅从上面各会议的结论和议题数据中概括，${promptMinItems}-${promptMaxItems}条，每条用一句话概括原文，注明来源（单source格式：团队名-文档标题；多source格式：团队名-label-文档标题）`);
  if (isMultiSource) {
    parts.push('本团队是多source团队，每条必须加【团队名-label】前缀，如：• 【经典剑侠系列-大部门】xxx（来源：团队名-label-文档标题）');
    parts.push('label 只能使用 config.json 中该 source 的 label，禁止从会议标题括号、文件名前缀或正文标题中自行生成 label。');
  }
  parts.push('### 关键决议');
  parts.push(`仅从上面各会议的结论数据中提取，${promptMinItems}-${promptMaxItems}条，直接引用或简述原文决议，注明来源（单source格式：团队名-文档标题；多source格式：团队名-label-文档标题）`);
  if (isMultiSource) {
    parts.push('本团队是多source团队，每条必须加【团队名-label】前缀，并在来源中保留团队名-label-文档标题');
    parts.push('label 必须严格来自 config sourceLabel；例如剑网3系列只能使用“剑网3”或“剑网3缘起”，不能使用“剧情”等标题分类。');
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
          return cCell(val, w, { color: riskLevelColors[val] });
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
      elements.push(h2(trimmed.replace(/^#\s+/, '')));
      lastType = 'h2';
    } else if (/^###\s+/.test(trimmed)) {
      elements.push(p(trimmed.replace(/^###\s+/, ''), { bold: true }));
      lastType = 'bold-p';
    } else if (/^##\s+/.test(trimmed)) {
      elements.push(h3(trimmed.replace(/^##\s+/, '')));
      lastType = 'h3';
    } else if (/^\*\*建议[：:]?\*\*/.test(trimmed) || /^建议[：:]/.test(trimmed)) {
      const text = stripInlineSourceRefs(trimmed.replace(/^\*\*建议[：:]?\*\*[：:\s]*/, '').replace(/^建议[：:\s]*/, ''));
      if (text) {
        elements.push(new Paragraph({ spacing: { before: 160, after: 0 }, children: [] }));
        elements.push(p(text, { bold: true, before: 120 }));
      }
      lastType = 'suggestion';
    } else if (/^[•\-\*]\s+\*\*/.test(trimmed)) {
      const m = trimmed.match(/^[•\-\*]\s+\*\*([^*]+)\*\*[：:\s]*(.*)/);
      if (m) {
        elements.push(bullet(stripInlineSourceRefs(m[2] || ''), { bold: stripInlineSourceRefs(m[1]) + '：' }));
      } else {
        elements.push(bullet(stripInlineSourceRefs(trimmed.replace(/^[•\-\*]\s+/, ''))));
      }
      lastType = 'bullet';
    } else if (/^[•\-\*]\s+/.test(trimmed)) {
      elements.push(bullet(stripInlineSourceRefs(trimmed.replace(/^[•\-\*]\s+/, ''))));
      lastType = 'bullet';
    } else if (/^\d+[.、]\s+/.test(trimmed)) {
      elements.push(bullet(stripInlineSourceRefs(trimmed.replace(/^\d+[.、]\s+/, ''))));
      lastType = 'bullet';
    } else if (/^\*\*[^*]+\*\*[：:]?\s*$/.test(trimmed)) {
      if (lastType === 'bullet' || lastType === 'p') {
        elements.push(new Paragraph({ spacing: { before: 120, after: 0 }, children: [] }));
      }
      elements.push(p(stripInlineSourceRefs(trimmed.replace(/^\*\*/, '').replace(/\*\*[：:]?\s*$/, '')), { bold: true }));
      lastType = 'bold-p';
    } else {
      elements.push(p(stripInlineSourceRefs(trimmed)));
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

function getTeamScanEntries(teamCfg, options = {}) {
  const sources = getTeamSources(teamCfg);
  const useRoot = options.useRoot !== false;
  return sources.flatMap(source => {
    const label = source.label || teamCfg.name;
    if (useRoot && source.root_folder_id) {
      return [{
        source,
        monthName: '_root',
        folderId: source.root_folder_id,
        label,
        scope: 'root'
      }];
    }
    return Object.entries(source.months || {}).map(([monthName, folderId]) => ({
      source,
      monthName,
      folderId,
      label,
      scope: 'configured'
    }));
  });
}

function monthNameToMonthNumber(monthName) {
  const text = String(monthName || '');
  const match = text.match(/(^|\D)(1[0-2]|0?[1-9])\s*(月|鏈)/);
  return match ? Number(match[2]) : null;
}

function rangeMonthNumbers(startDate, endDate) {
  const startMatch = String(startDate || '').match(/(\d{1,2})[.\-](\d{1,2})/);
  const endMatch = String(endDate || '').match(/(\d{1,2})[.\-](\d{1,2})/);
  if (!startMatch || !endMatch) return null;

  const startMonth = Number(startMatch[1]);
  const endMonth = Number(endMatch[1]);
  if (startMonth < 1 || startMonth > 12 || endMonth < 1 || endMonth > 12) return null;

  const months = new Set();
  if (startMonth <= endMonth) {
    for (let month = startMonth; month <= endMonth; month++) months.add(month);
  } else {
    for (let month = startMonth; month <= 12; month++) months.add(month);
    for (let month = 1; month <= endMonth; month++) months.add(month);
  }
  return months;
}

function selectMonthEntriesForRange(sources, startDate, endDate, fallbackLabel) {
  const monthSet = rangeMonthNumbers(startDate, endDate);
  return sources.flatMap(source =>
    Object.entries(source.months || {})
      .filter(([monthName]) => {
        const monthNumber = monthNameToMonthNumber(monthName);
        return !monthSet || monthNumber === null || monthSet.has(monthNumber);
      })
      .map(([monthName, folderId]) => ({
        source,
        monthName,
        folderId,
        label: source.label || fallbackLabel
      }))
  );
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
  cleanText, isValidConclusion, makeSuggestion, textSimilar, dedupTexts, splitConcatenated, riskKeywords, analyzeDocs, generateStrategicAnalysis, extractParticipants, extractInfo,
  formatSourceRef, withSourceRef, stripInlineSourceRefs, normalizeMultiSourceBulletPrefixes,
  callLLM, buildComprehensiveReportPrompt, buildTeamReportPrompt, parseReportMarkdown,
  compactTeamSummariesForComprehensive, summarizeTeamSummaryCompression,
  docStyles, docNumbering, resolveWorkspaceDir, ensureOutputDir, outputPath, findInputFile, readInputJson, writeOutputJson,
  getBaselineFileName, createMeetingBaseline, writeMeetingBaseline, readMeetingBaseline,
  currentYear, normalizeDate, formatDateChinese, extractDateFromFileName, extractDateFromContent, extractMeetingDate, meetingDateInRange, dateInRange, getWeekKey,
  listFolder, scanFolder, scanFolderWithStats, scanFolderAll, scanFolderFromDate,
  listFolderAsync, searchFilesAsync: searchFilesAsyncRateLimited, dateToUnixSeconds,
  scanFolderAsync, scanFolderWithStatsAsync, scanFolderAllAsync, scanFolderFromDateAsync,
  getKdocsScanMode, shouldHybridRecursiveScan, scanFilesByMode, dedupeKdocsFiles,
  RequestPacer, sleep, getSkillConfig, getKdocsConfig, getKdocsCliPath, getKdocsCliEnv, getKdocsCliArgs,
  formatGenerationMode, printAiReviewWarning,
  getRiskImpactScope, classifyMeetingType, summarizePrimaryMeetingTypes,
  normalizeTitle, normalizeForMatch, charSimilarity,
  sleepSync,
  teamDocsCacheDir, teamFoldersCacheDir, ensureCacheDir, readCache, writeCache, clearFolderCache,
  getTeamSources, getTeamScanEntries, selectMonthEntriesForRange, isMultiSourceTeam, getMultiSourceTeamNames, groupByLabel,
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, PageNumber, PageBreak,
  BorderStyle, WidthType, ShadingType, VerticalAlign, LevelFormat
};
