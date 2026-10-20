// backend/src/agent/explain.mjs
// 成员05：Agent 占位实现（Mock），不接真实模型，拼接04状态+06知识卡

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 读06的知识卡（cards.json），路径按需微调
const __dirname = dirname(fileURLToPath(import.meta.url));
let knowledgeCards = [];
try {
  const cardsPath = join(__dirname, '../../content/knowledge/cards.json'); // 确认实际路径
  knowledgeCards = JSON.parse(readFileSync(cardsPath, 'utf-8'));
} catch (e) {
  console.warn('[agent] 知识卡读取失败，使用空数组', e.message);
}

// 根据04的 event 匹配06的卡片（简化映射）
const eventCardMap = {
  'init': 'bs-k01',
  'probe': 'bs-k03',
  'move-left': 'bs-k04',
  'move-right': 'bs-k05',
  'found': 'bs-k08',
  'not-found': 'bs-k06'
};

export async function explain({ runId, stepIndex, question, stepState }) {
  // stepState 是04传的 {left, right, mid, event, ...}
  const { left, right, mid, event } = stepState || {};
  const cardId = eventCardMap[event] || 'bs-k03';
  const card = knowledgeCards.find(c => c.id === cardId) || { title: '二分查找', content: '' };

  // 拼装回答
  const answer = `【Agent Mock】步骤${stepIndex}（${event}）：当前区间[${left},${right}]，mid=${mid}。${card.title}：${card.content.slice(0, 50)}... 回答你的问题：“${question}”`;

  return {
    runId,
    stepIndex,
    answer,
    references: [cardId],
    usage: { model: 'mock', cost: 0 }
  };
}

// 给路由调用（POST /api/agent/explain）
export default async function handler(req, res) {
  try {
    const { runId, stepIndex, question, stepState } = req.body || {};
    if (!runId || stepIndex == null) {
      return res.status(400).json({ error: 'INVALID_INPUT' });
    }
    const result = await explain({ runId, stepIndex, question, stepState });
    res.status(200).json(result);
  } catch (e) {
    res.status(503).json({ error: 'MODEL_NOT_CONFIGURED', message: e.message });
  }
}
