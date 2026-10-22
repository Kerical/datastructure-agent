const messagesEl = document.getElementById('chat-messages');
const sendBtn = document.getElementById('send-btn');
const retryBtn = document.getElementById('retry-btn');
const questionInput = document.getElementById('question-input');
const runIdInput = document.getElementById('run-id-input');
const stepIndexInput = document.getElementById('step-index-input');
const hintLevelSelect = document.getElementById('hint-level-select');
const usageInfo = document.getElementById('usage-info');
const statusBadge = document.getElementById('status-badge');
const currentStepLabel = document.getElementById('current-step-label');
let busy = false;
let failedRequest = null;
let usageRequest = 0;
const params = new URLSearchParams(location.search);
runIdInput.value = params.get('runId') || '';
stepIndexInput.value = params.get('stepIndex') || '';
updateCurrentStepLabel();

fetch('/api/health').then(r => r.json()).then(data => {
  statusBadge.textContent = data.modelCallsEnabled ? '在线模式（DeepSeek）' : data.mode === 'mock' ? 'Mock模式' : '模型未配置';
  statusBadge.className = data.modelCallsEnabled ? 'badge live' : 'badge mock';
}).catch(() => { statusBadge.textContent = '服务不可用'; });

// P2 FIX: refreshUsage 统一使用 sessionId（与 POST 的 sessionId 一致）
async function refreshUsage(sessionId = runIdInput.value.trim()) {
  const ticket = ++usageRequest;
  try {
    const res = await fetch('/api/agent/usage?sessionId=' + encodeURIComponent(sessionId));
    const data = await res.json();
    if (!res.ok || !data.ok || ticket !== usageRequest || sessionId !== runIdInput.value.trim()) return;
    const tokens = data.tokensUsed == null ? '未知' : data.tokensUsed;
    const cost = data.costUsed == null ? '未知' : `${Number(data.costUsed).toFixed(6)} 元（配置估算）`;
    usageInfo.textContent = `本次服务会话调用 ${data.requests} 次 · 失败 ${data.failures || 0} 次 · Token ${tokens} · 费用 ${cost}`;
  } catch { /* Keep the last known usage rather than replacing it with zero. */ }
}
refreshUsage();

function updateCurrentStepLabel() {
  const value = stepIndexInput.value;
  currentStepLabel.textContent = value === '' ? '未选择步骤' : `当前选中：步骤 ${Number(value) + 1}`;
}
stepIndexInput.addEventListener('change', updateCurrentStepLabel);
runIdInput.addEventListener('change', () => refreshUsage());

function appendMessage(role, content, meta) {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  if (meta) {
    const tag = document.createElement('div');
    tag.className = 'message-meta';
    tag.textContent = meta;
    div.appendChild(tag);
  }
  const body = document.createElement('div');
  body.className = 'message-body';
  body.textContent = content;
  div.appendChild(body);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

// P2 FIX: 重试按钮使用保存的完整快照，不重新读空输入
async function sendMessage(snapshot) {
  if (busy) return;
  const input = snapshot || { runId: runIdInput.value.trim(), stepIndex: Number(stepIndexInput.value),
    question: questionInput.value.trim(), hintLevel: Number(hintLevelSelect.value) };
  if (!input.runId) { alert('请先输入 runId'); return; }
  if ((!snapshot && stepIndexInput.value === '') || !Number.isSafeInteger(input.stepIndex) || input.stepIndex < 0) { alert('请输入有效的步骤索引'); return; }
  if (!input.question) { alert('请输入问题'); return; }
  busy = true;
  failedRequest = null;
  sendBtn.disabled = true;
  retryBtn.style.display = 'none';
  questionInput.disabled = true;
  const meta = `runId=${input.runId} · 步骤${input.stepIndex + 1} · 级别${input.hintLevel}`;
  appendMessage('user', input.question, `提问归属：${meta}`);
  if (!snapshot) questionInput.value = '';
  const loading = appendMessage('system', '正在思考…', meta);
  const startedAt = Date.now();
  try {
    const res = await fetch('/api/agent/explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, sessionId: input.runId })
    });
    const data = await res.json();
    if (!res.ok || typeof data.answer !== 'string') throw new Error(data.error?.message || '服务返回了无效回复');
    const answerMeta = `回答归属：runId=${data.runId || input.runId} · 步骤${(data.stepIndex ?? input.stepIndex) + 1} · 级别${data.hintLevel || input.hintLevel} · ${Date.now() - startedAt}ms`;
    const div = appendMessage('assistant', data.answer, answerMeta);
    if (data.sourceRefs?.length) {
      const refs = document.createElement('div');
      refs.className = 'message-meta';
      refs.textContent = data.sourceRefs.map(ref => `依据：${ref.cardId} ${ref.title || ''}（${ref.sourceId || '未提供来源'}）`).join('；');
      div.appendChild(refs);
    }
  } catch (err) {
    // P2 FIX: 保存完整失败请求快照用于重试
    failedRequest = { ...input };
    appendMessage('system', `请求失败：${err.message}`, `原请求：${meta}`);
    retryBtn.style.display = 'inline-block';
  } finally {
    loading.remove();
    busy = false;
    sendBtn.disabled = false;
    questionInput.disabled = false;
    refreshUsage(input.runId);
  }
}

sendBtn.addEventListener('click', () => sendMessage());
// P2 FIX: 重试使用保存的快照
retryBtn.addEventListener('click', () => { if (failedRequest) sendMessage({ ...failedRequest }); });
questionInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});