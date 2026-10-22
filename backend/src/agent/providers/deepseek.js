export class DeepSeekProvider {
  constructor(apiKey) {
    this.apiKey = apiKey || process.env.DEEPSEEK_API_KEY;
    if (!this.apiKey) throw new Error('MODEL_NOT_CONFIGURED');
    this.model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
    this.timeoutMs = Number(process.env.MODEL_TIMEOUT_MS) || 15000;
  }

  async chat(messages, options = {}) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('MODEL_TIMEOUT')); }, options.timeoutMs || this.timeoutMs);
    });
    try {
      const request = (async () => {
        const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model: this.model, messages, temperature: options.temperature ?? 0.7,
            max_tokens: options.maxTokens ?? 1024, stream: false }),
          signal: controller.signal
        });
        // P2 FIX: 超时保护覆盖 response.json()（body 读取）
        // timer 在 response.json() 完成后才 clear
        if (!response.ok) throw new Error('MODEL_CALL_FAILED');
        const data = await response.json();
        clearTimeout(timer); // P2 FIX: 移到 json() 之后
        const raw = data.usage;
        const validUsage = raw && [raw.prompt_tokens, raw.completion_tokens, raw.total_tokens]
          .every(n => Number.isSafeInteger(n) && n >= 0) && raw.total_tokens === raw.prompt_tokens + raw.completion_tokens;
        const usage = validUsage ? { promptTokens: raw.prompt_tokens, completionTokens: raw.completion_tokens, totalTokens: raw.total_tokens } : null;
        return { content: data.choices?.[0]?.message?.content || '', model: data.model || this.model,
          cost: validUsage ? this.estimateCost(raw) : null, usage };
      })();
      return await Promise.race([request, timeout]);
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted || err.message === 'MODEL_TIMEOUT') throw new Error('MODEL_TIMEOUT');
      throw new Error('MODEL_CALL_FAILED');
    }
  }

  estimateCost(usage) {
    const input = Number(process.env.MODEL_INPUT_CNY_PER_MILLION);
    const output = Number(process.env.MODEL_OUTPUT_CNY_PER_MILLION);
    if (!process.env.MODEL_INPUT_CNY_PER_MILLION || !process.env.MODEL_OUTPUT_CNY_PER_MILLION ||
        !Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) return null;
    return (usage.prompt_tokens * input + usage.completion_tokens * output) / 1000000;
  }
}