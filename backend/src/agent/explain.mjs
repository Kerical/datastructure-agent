import { getRun } from '../runs/store.js';
import { checkRateLimit, reserveModelCall, finishModelCall, recordMockCall } from './rate-limit.js';
import { guardOutput, verifyOutput } from './output-guard.js';
import { buildPrompt } from './prompt.js';
import { retrieveKnowledge, loadKnowledgeCards, verifiedCards, sourceRef, isStepQuestion } from '../knowledge/retrieve.js';

function pickCardId(ev) {
  if (ev === 'probe') return 'bs-k03';
  if (ev === 'move-left') return 'bs-k04';
  if (ev === 'move-right') return 'bs-k05';
  if (ev === 'found') return 'bs-k08';
  if (ev === 'not-found') return 'bs-k06';
  return 'bs-k01';
}

function cardText(card) {
  if (!card) return '';
  let s = `\n\n📖 ${card.title || card.id}`;
  if (card.content) s += `：${card.content}`;
  if (card.sourceId) s += `\n📎 来源：${card.sourceId}`;
  return s;
}

const IRRELEVANT_PATTERNS = [
  /(天气预报|推荐电影|推荐音乐|股票行情|讲个笑话|陪我聊天)/,
  /(你是谁|你几岁|你喜欢|你能做啥|讲个笑话|陪我聊天)/,
];
function isIrrelevantQuestion(question) {
  if (!question) return false;
  return IRRELEVANT_PATTERNS.some(p => p.test(question));
}

export async function handleAgentExplain(parsedBody, ctx = {}) {
  const mode = ctx.mode || 'mock';
  const req = ctx.req;
  const bodySessionId = parsedBody?.sessionId;

  // ===== 统一校验（所有模式共用）=====
  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return { status: 400, body: { error: { code: 'INVALID_INPUT', message: '请求体必须为 JSON 对象' } } };
  }

  const { runId, stepIndex, question, hintLevel } = parsedBody;

  if (typeof runId !== 'string' || !runId.trim()) {
    return { status: 400, body: { error: { code: 'INVALID_INPUT', message: 'runId 为必填字符串' } } };
  }

  // ===== P2 FIX: 索引类型校验，禁止任何类型转换 =====
  if (stepIndex === undefined || stepIndex === null) {
    return { status: 400, body: { error: { code: 'INVALID_INPUT', message: 'stepIndex 为必填' } } };
  }
  if (typeof stepIndex !== 'number' || !Number.isSafeInteger(stepIndex) || stepIndex < 0) {
    return { status: 400, body: { error: { code: 'INVALID_INPUT', message: 'stepIndex 必须为非负整数（禁止字符串等类型转换）' } } };
  }
  const idx = stepIndex; // 直接用原值，不再 Number()

  if (hintLevel !== undefined) {
    if (!Number.isInteger(hintLevel) || hintLevel < 1 || hintLevel > 3) {
      return { status: 400, body: { error: { code: 'INVALID_INPUT', message: 'hintLevel 必须为 1、2 或 3' } } };
    }
  }

  if (typeof question !== 'string' || !question.trim() || question.length > 2000) {
    return { status: 400, body: { error: { code: 'INVALID_INPUT', message: 'question 必须为1至2000字符的非空字符串' } } };
  }

  const level = hintLevel === undefined ? 1 : hintLevel;

  // ===== 查询真实步骤 =====
  const run = getRun(runId);
  if (!run) {
    return { status: 404, body: { error: { code: 'RUN_NOT_FOUND', message: 'run 不存在或已过期，请重新运行算法' } } };
  }
  const steps = Array.isArray(run.steps) ? run.steps : [];
  if (idx >= steps.length) {
    return { status: 400, body: { error: { code: 'STEP_OUT_OF_RANGE', message: `stepIndex 越界，该 run 共 ${steps.length} 步（0-${steps.length - 1}）` } } };
  }
  const step = steps[idx] || {};
  const arr = Array.isArray(step.array) ? step.array : [];
  const target = step.target;
  const left = step.variables?.left;
  const right = step.variables?.right;
  const mid = step.variables?.mid;
  const ev = step.event;
  const stepNo = step.stepIndex ?? idx;

  if (process.env.RATE_LIMIT !== 'false' && req) {
    const limit = checkRateLimit(req, bodySessionId);
    if (!limit.allowed) return { status: 429, body: { error: { code: 'RATE_LIMIT_EXCEEDED', message: '请求过于频繁，请稍后再试', retryAfter: Math.ceil(limit.resetIn / 1000) } } };
  }
  if (mode !== 'real' || isIrrelevantQuestion(question) || (!ev && arr.length === 0)) recordMockCall(req, bodySessionId);

  // ===== P2 FIX: 空数组判断修正 =====
  // 空数组 + init 事件（ev 存在）是合法状态，走正常解释
  // 只有 step 完全没有 event（真正信息不足）才返回信息不足
  if (!ev && arr.length === 0) {
    return {
      status: 200,
      body: {
        runId, stepIndex: idx,
        answer: '当前数组为空，搜索区间 left=0, right=-1，表示区间为空，目标元素不存在。',
        stepRefs: [{ runId, stepIndex: idx, event: ev, left, right, mid }],
        sourceRefs: [],
        usage: { model: 'mock', cost: null, mock: true, infoInsufficient: true }
      }
    };
  }

  // 检索已核验知识卡
  const cardId = pickCardId(ev);
  let selectedCards, retrieval;
  try {
    const catalog = loadKnowledgeCards();
    const topicId = run.algorithm;
    const contextCard = verifiedCards(topicId, catalog).find(item => item.id === cardId);
    const result = retrieveKnowledge(question, topicId, { cards: catalog, limit: 2 });
    const generic = isStepQuestion(question);
    if (generic) { result.cards = []; result.matches = []; }
    selectedCards = [...result.cards];
    if ((selectedCards.length || generic) && contextCard && !selectedCards.some(item => item.id === contextCard.id)) selectedCards.push(contextCard);
    retrieval = { method: result.method, status: result.cards.length ? 'matched' : selectedCards.length ? 'step-context' : 'no-match',
      matchedCardIds: result.cards.map(item => item.id), contextCardId: selectedCards.some(item => item.id === cardId) ? cardId : null,
      matches: result.matches.map(({card,score,matchedTerms}) => ({cardId:card.id,score,matchedTerms})) };
  } catch {
    return { status: 503, body: { error: { code: 'KNOWLEDGE_UNAVAILABLE', message: '已核验知识资料暂不可用，请稍后重试' } } };
  }
  const refs = selectedCards.map(sourceRef);

  // ===== 无关问题处理 =====
  if (isIrrelevantQuestion(question)) {
    return {
      status: 200,
      body: {
        runId, stepIndex: idx,
        answer: `你的问题「${question}」与当前二分查找步骤无关。我专注于帮你理解这一步发生了什么——比如「为什么 mid 是这样算的？」或「下一步为什么更新左边界？」。`,
        hintLevel: level,
        stepRefs: [{ runId, stepIndex: idx, event: ev, left, right, mid }],
        sourceRefs: [], knowledgeUsed: false, retrieval: { method: retrieval.method, status: 'irrelevant', matchedCardIds: [], contextCardId: null, matches: [] },
        usage: { model: 'mock', cost: null, mock: true, irrelevant: true }
      }
    };
  }

  if (!selectedCards.length) {
    if (mode === 'real') recordMockCall(req, bodySessionId);
    return { status: 200, body: { runId, stepIndex: idx, hintLevel: level,
      answer: '当前已核验知识卡中没有找到与你的问题匹配的资料，暂不能给出有资料依据的解释。当前真实步骤为 ' + ev + '，区间 [' + left + ', ' + right + ']。请补充与二分查找有关的具体问题。',
      stepRefs: [{ runId, stepIndex: idx, event: ev, left, right, mid }], sourceRefs: [], knowledgeUsed: false, retrieval,
      usage: { model: 'local', cost: null, mock: true, insufficientKnowledge: true } } };
  }

  // ===== 真实模型模式 =====
  if (mode === 'real') {
    let receipt;
    const startedAt = Date.now();
    try {
      const { DeepSeekProvider } = await import('./providers/deepseek.js');
      const provider = new DeepSeekProvider();
      const messages = buildPrompt(run, step, level, question, selectedCards);
      const maxTokens = 1024;
      const maximumTokens = Buffer.byteLength(JSON.stringify(messages), 'utf8') + maxTokens + 256;
      const allocation = reserveModelCall(req, bodySessionId, maximumTokens);
      if (!allocation.allowed) return { status: allocation.code === 'BUDGET_UNAVAILABLE' ? 503 : 429, body: { error: { code: allocation.code, message: '模型调用额度不足或预算记录不可用，请检查后端配置' } } };
      receipt = allocation.receipt;
      // P2 FIX: 读 MODEL_TIMEOUT_MS，不再硬编码 15000
      const timeoutMs = Number(process.env.MODEL_TIMEOUT_MS) || 15000;
      const result = await provider.chat(messages, { timeoutMs, maxTokens });
      const elapsedMs = Date.now() - startedAt;

      const guard = guardOutput(result.content);
      let finalAnswer = guard.valid ? result.content : (guard.truncated || '请重新思考：当前 mid 与目标值比较，下一步应该往哪边找？');

      for (const card of selectedCards) {
        const vr = verifyOutput(finalAnswer, card);
        if (!vr.pass) { finalAnswer = vr.suggestion; break; }
      }

      finishModelCall(receipt, { tokens: result.usage?.totalTokens ?? null, cost: result.cost ?? null, elapsedMs });

      return {
        status: 200,
        body: {
          runId,
          stepIndex: idx,
          hintLevel: level,
          answer: finalAnswer + selectedCards.map(cardText).join(''),
          stepRefs: [{ runId, stepIndex: idx, event: ev, left, right, mid, knowledgeCard: retrieval.contextCardId, array: arr.length <= 20 ? arr : undefined, target }],
          sourceRefs: refs,
          retrieval,
          knowledgeUsed: selectedCards.length > 0,
          usage: {
            model: result.model || 'deepseek-chat',
            cost: result.cost ?? null,
            costCurrency: 'CNY',
            costBasis: result.cost == null ? null : '按后端配置单价估算，非实际账单',
            mock: false,
            tokens: result.usage || null,
            elapsedMs
          }
        }
      };
    } catch (err) {
      finishModelCall(receipt, { elapsedMs: Date.now() - startedAt, failed: true });
      if (err.message === 'MODEL_TIMEOUT') {
        // P2 FIX: 移除"已降级为 Mock"的误导文案
        return { status: 504, body: { error: { code: 'MODEL_TIMEOUT', message: '模型响应超时，请稍后重试', degraded: false } } };
      }
      return { status: 502, body: { error: { code: 'MODEL_CALL_FAILED', message: '模型调用失败，请稍后重试' } } };
    }
  }

  // ===== Mock 模式 =====
  const prefix = '[Mock开发模式] ';
  let answer = '';

  if (typeof left === 'number' && typeof right === 'number' && left > right) {
    answer = `${prefix}候选区间已为空（left=${left} > right=${right}），查找结束，返回 -1（not-found）。`;
  } else if (level === 1) {
    answer = `${prefix}当前步骤（第${stepNo + 1}步）：事件为 ${ev}，区间 [${left}, ${right}]`;
    if (typeof mid === 'number') {
      answer += `，mid=${mid}`;
      if (arr.length > mid) answer += `，A[${mid}]=${arr[mid]}`;
    }
    answer += `。目标值为 ${target}。`;
  } else if (level === 2) {
    answer = `${prefix}步骤 ${stepNo + 1} 事件 ${ev}：候选区间 [${left}, ${right}]`;
    if (typeof mid === 'number') answer += `，mid=${mid}，A[${mid}]=${arr[mid] ?? '?'}`;
    answer += `。目标 ${target}。`;
    if (ev === 'probe') answer += ' 正在比较目标与中间元素。';
    else if (ev === 'move-left') answer += ' 更新左边界。';
    else if (ev === 'move-right') answer += ' 更新右边界。';
    else if (ev === 'found') answer += ' 找到目标，查找成功。';
    else if (ev === 'not-found') answer += ' 候选区间已空，查找结束。';
    else if (ev === 'init') answer += ' 初始化查找区间。';
  } else {
    let next = '下一步继续二分查找流程。';
    if (arr.length === 0) next = '数组为空，查找直接结束（not-found）。';
    else if (ev === 'init') next = '初始化完成，下一步将计算 mid 并与目标比较。';
    else if (ev === 'probe') {
      const value = arr[mid];
      next = value === target ? '下一步：命中（found），返回当前中点下标。'
        : value < target ? '下一步：更新左边界（left=mid+1）。'
          : '下一步：更新右边界（right=mid-1）。';
    }
    else if (ev === 'move-left') next = '已更新左边界，下一步重新计算 mid。';
    else if (ev === 'move-right') next = '已更新右边界，下一步重新计算 mid。';
    else if (ev === 'found') next = '已找到目标，查找成功结束。';
    else if (ev === 'not-found') next = '查找结束，目标不在数组中。';

    answer = `${prefix}步骤 ${stepNo + 1} 事件 ${ev}：区间 [${left}, ${right}]`;
    if (typeof mid === 'number') answer += `，mid=${mid}，A[${mid}]=${arr[mid] ?? '?'}`;
    answer += `。目标 ${target}。${next}`;
  }

  answer += selectedCards.map(cardText).join('');

  return {
    status: 200,
    body: {
      runId,
      stepIndex: idx,
      hintLevel: level,
      answer,
      stepRefs: [{ runId, stepIndex: idx, event: ev, left, right, mid, knowledgeCard: retrieval.contextCardId, array: arr.length <= 20 ? arr : undefined, target }],
      sourceRefs: refs,
      retrieval,
      knowledgeUsed: selectedCards.length > 0,
      // P2 FIX: Mock cost 改为 null（无模型费用），修复契约回归
      usage: { model: 'mock', cost: null, mock: true }
    }
  };
}