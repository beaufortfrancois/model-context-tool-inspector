/**
 * DeepSeek provider.
 *
 * DeepSeek exposes an OpenAI-compatible chat-completions endpoint. This module
 * wraps it behind the same surface the sidebar uses for Gemini
 * (`models.generateContent` and `chats.create(...).sendMessage`) so the agent
 * loop in sidebar.js stays provider-agnostic.
 */

export const DEEPSEEK_BASE_URL_DEFAULT = 'https://api.deepseek.com';

// Current DeepSeek API model ids. Legacy aliases (`deepseek-chat` and
// `deepseek-reasoner`) are intentionally omitted because DeepSeek has announced
// their July 2026 deprecation.
export const DEEPSEEK_MODELS = [
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', thinking: true },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', thinking: true },
];

export function deepSeekModelSupportsThinking(modelId) {
  const known = DEEPSEEK_MODELS.find((m) => modelId === m.id || modelId?.startsWith(m.id));
  return known ? known.thinking : true;
}

function flattenSystemInstruction(systemInstruction) {
  if (!systemInstruction) return undefined;
  return Array.isArray(systemInstruction) ? systemInstruction.join('\n') : String(systemInstruction);
}

function translateTools(geminiTools) {
  if (!geminiTools) return [];
  const out = [];
  for (const group of geminiTools) {
    for (const fd of group.functionDeclarations || []) {
      out.push({
        type: 'function',
        function: {
          name: fd.name,
          description: fd.description || '',
          parameters: fd.parametersJsonSchema ||
            fd.parameters || { type: 'object', properties: {} },
        },
      });
    }
  }
  return out;
}

export class DeepSeekAI {
  constructor({ apiKey, baseURL, thinkingMode } = {}) {
    this.apiKey = apiKey;
    this.baseURL = (baseURL || DEEPSEEK_BASE_URL_DEFAULT).replace(/\/+$/, '');
    // 'enabled' | 'disabled'
    this.thinkingMode = thinkingMode || 'disabled';

    this.models = {
      generateContent: (params) => this._generateContent(params),
    };
    this.chats = {
      create: (params) => new DeepSeekChat(this, params),
    };
  }

  async _request(body, modelSupportsThinkingFlag = true) {
    const send = async (withThinking) => {
      const payload = { ...body };
      if (withThinking && modelSupportsThinkingFlag) {
        payload.thinking = { type: this.thinkingMode };
      }
      const res = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      });
      return res;
    };

    let res = await send(true);
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 400 && /thinking/i.test(errText)) {
        res = await send(false);
        if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
      } else {
        throw new Error(`DeepSeek ${res.status}: ${errText}`);
      }
    }
    return res.json();
  }

  async _generateContent({ model, contents, config }) {
    const messages = [];
    const sys = flattenSystemInstruction(config?.systemInstruction);
    if (sys) messages.push({ role: 'system', content: sys });
    const text = Array.isArray(contents) ? contents.join('\n') : String(contents);
    messages.push({ role: 'user', content: text });

    const data = await this._request(
      { model, messages },
      deepSeekModelSupportsThinking(model),
    );
    const msg = data.choices?.[0]?.message;
    return { text: msg?.content || '' };
  }
}

class DeepSeekChat {
  constructor(ai, { model } = {}) {
    this.ai = ai;
    this.model = model;
    this.messages = [];
    this._systemSet = false;
    this._pendingToolCalls = new Map();
  }

  async sendMessage({ message, config }) {
    const sys = flattenSystemInstruction(config?.systemInstruction);
    if (sys && !this._systemSet) {
      this.messages.unshift({ role: 'system', content: sys });
      this._systemSet = true;
    }

    if (typeof message === 'string') {
      this.messages.push({ role: 'user', content: message });
    } else if (Array.isArray(message)) {
      for (const part of message) {
        const fr = part.functionResponse;
        if (!fr) continue;
        const ids = this._pendingToolCalls.get(fr.name);
        const toolCallId = ids && ids.length ? ids.shift() : fr.name;
        this.messages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: JSON.stringify(fr.response ?? {}),
        });
      }
    }

    const tools = translateTools(config?.tools);
    const body = { model: this.model, messages: this.messages };
    if (tools.length) body.tools = tools;

    const data = await this.ai._request(body, deepSeekModelSupportsThinking(this.model));
    const msg = data.choices?.[0]?.message || {};
    const toolCalls = (msg.tool_calls || []).filter((tc) => tc.function);

    const assistantMessage = {
      role: 'assistant',
      content: msg.content ?? (toolCalls.length ? null : ''),
      ...('reasoning_content' in msg ? { reasoning_content: msg.reasoning_content } : {}),
      ...(toolCalls.length ? { tool_calls: msg.tool_calls } : {}),
    };
    this.messages.push(assistantMessage);

    const functionCalls = toolCalls.map((tc) => {
      const name = tc.function.name;
      if (!this._pendingToolCalls.has(name)) this._pendingToolCalls.set(name, []);
      this._pendingToolCalls.get(name).push(tc.id);
      let args = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {}
      return { name, args };
    });

    return {
      text: msg.content || '',
      functionCalls,
      candidates: data.choices,
    };
  }
}
