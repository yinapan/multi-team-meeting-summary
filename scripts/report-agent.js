const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { normalizeDate, outputPath } = require('./shared');

function reportMode(config = {}) {
  const mode = config.llm?.mode ?? 'agent';
  if (!['agent', 'api', 'rules'].includes(mode)) {
    throw new Error('config.json 中 llm.mode 可选 agent、api 或 rules。');
  }
  return mode;
}

function agentRunDir(startDate, endDate) {
  const dates = [startDate, endDate].map(value => normalizeDate(String(value || '')));
  if (!dates.every(date => /^\d{2}-\d{2}$/.test(date))) {
    throw new Error('agent 报告需要起止日期。');
  }
  return outputPath('agent-' + dates.map(date => date.replace('-', '')).join('-'));
}

function fingerprint(values) {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 20);
}

function fileLabel(name) {
  return String(name).replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 42);
}

function teamSummaryPath(startDate, endDate, team, documents) {
  const source = documents.map(doc => [
    doc.name, doc.sourceLabel, doc.meetingDate, doc.important,
    doc.conclusions, doc.todos, doc.rawContent
  ]);
  const key = fingerprint([team, source]);
  return path.join(agentRunDir(startDate, endDate), `team-${fileLabel(team)}-${key}.summary.md`);
}

function requestAgentAnalysis(prompt, { startDate, endDate, team, label, formatAnswer } = {}) {
  const directory = agentRunDir(startDate, endDate);
  const topic = team ? 'team-' + fileLabel([team, label].filter(Boolean).join('-')) : 'report';
  const stem = path.join(directory, `${topic}-${fingerprint([team, label, prompt])}`);
  const promptPath = stem + '.prompt.md';
  const answerPath = stem + '.answer.md';
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(promptPath, prompt, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  let answer = '';
  try {
    answer = fs.readFileSync(answerPath, 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  function pending(reason) {
    const error = new Error(`${reason}\n当前 agent 请读取 ${promptPath}，将分析正文保存为 ${answerPath}`);
    return Object.assign(error, { code: 'AGENT_ANALYSIS_PENDING', promptPath, answerPath });
  }
  if (!answer) throw pending('等待当前会话分析。');
  const sections = [...answer.matchAll(/^#{1,2}[ \t]+(1\.2\b|[二三四五][、.．])/gm)];
  if (answer === prompt.trim() || !/^##?\s+1\.2\b/.test(answer) ||
      sections.map(match => match[1][0]).join('') !== '1二三四五' ||
      sections.some((match, i) => !answer.slice(match.index, sections[i + 1]?.index)
        .split('\n').some(line => line.trim() && !line.trimStart().startsWith('#')))) {
    throw pending('请补全第一至第五章的标题及正文。');
  }
  if (formatAnswer) return formatAnswer(answer, pending);
  return answer;
}

module.exports = { reportMode, agentRunDir, teamSummaryPath, requestAgentAnalysis };
