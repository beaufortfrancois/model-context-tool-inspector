/**
 * Volcano Engine ARK (Doubao) provider.
 *
 * ARK exposes an OpenAI-compatible chat-completions endpoint. This module
 * wraps it behind the same surface the sidebar uses for Gemini
 * (`models.generateContent` and `chats.create(...).sendMessage`) so the agent
 * loop in sidebar.js stays provider-agnostic.
 *
 * Mirrors WebOperator/weboperator/models/ark.py: thinking is disabled by
 * default (Doubao Seed 2.x's reasoning budget roughly triples latency), and a
 * 400 mentioning "thinking" triggers a retry without the flag so the wrapper
 * stays portable across non-thinking ARK models.
 */

export const ARK_BASE_URL_DEFAULT = 'https://ark.cn-beijing.volces.com/api/v3';

// Curated from the Volcengine ARK model catalog. `thinking` marks models that
// accept the thinking parameter; flash/vision variants do not.
export const ARK_MODELS = [
  { id: 'doubao-seed-2-0-pro-260215', label: 'Doubao Seed 2.0 Pro', thinking: true },
  { id: 'doubao-seed-2-0-lite-260428', label: 'Doubao Seed 2.0 Lite', thinking: true },
  { id: 'doubao-seed-2-0-mini-260428', label: 'Doubao Seed 2.0 Mini', thinking: true },
  { id: 'doubao-seed-2-0-code-preview-260215', label: 'Doubao Seed 2.0 Code', thinking: true },
  { id: 'doubao-seed-1-8-251228', label: 'Doubao Seed 1.8', thinking: true },
  { id: 'doubao-seed-1-6', label: 'Doubao Seed 1.6', thinking: true },
  { id: 'doubao-seed-1-6-vision-250815', label: 'Doubao Seed 1.6 Vision', thinking: false },
];

export function modelSupportsThinking(modelId) {
  const known = ARK_MODELS.find((m) => modelId === m.id || modelId?.startsWith(m.id));
  // Unknown / custom ids (e.g. endpoint ids "ep-...") default to allowing the
  // thinking flag; the request layer retries without it if the model rejects.
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
          description: openAICompatibleDescription(fd),
          parameters: fd.parametersJsonSchema ||
            fd.parameters || { type: 'object', properties: {} },
        },
      });
    }
  }
  return out;
}

function openAICompatibleDescription(fd) {
  const parts = [fd.description || ''];
  const responseSchema = fd.responseJsonSchema || fd.response;
  if (responseSchema) {
    parts.push(`Return value JSON schema:\n${JSON.stringify(responseSchema, null, 2)}`);
  }
  return parts.filter(Boolean).join('\n\n');
}

export class ArkAI {
  constructor({ apiKey, baseURL, thinkingMode } = {}) {
    this.apiKey = apiKey;
    this.baseURL = (baseURL || ARK_BASE_URL_DEFAULT).replace(/\/+$/, '');
    // 'auto' | 'enabled' | 'disabled'
    this.thinkingMode = thinkingMode || 'disabled';

    this.models = {
      generateContent: (params) => this._generateContent(params),
    };
    this.chats = {
      create: (params) => new ArkChat(this, params),
    };
  }

  // Sends a chat-completions request, injecting the thinking flag and retrying
  // once without it if the model rejects it.
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
        if (!res.ok) throw new Error(`ARK ${res.status}: ${await res.text()}`);
      } else {
        throw new Error(`ARK ${res.status}: ${errText}`);
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
      modelSupportsThinking(model),
    );
    const msg = data.choices?.[0]?.message;
    return { text: msg?.content || '' };
  }
}

class ArkChat {
  constructor(ai, { model } = {}) {
    this.ai = ai;
    this.model = model;
    this.messages = [];
    this._systemSet = false;
    // tool name -> queue of outstanding tool_call ids (OpenAI matches tool
    // results to calls by id; Gemini-style functionResponses only carry name).
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

    const data = await this.ai._request(body, modelSupportsThinking(this.model));
    const msg = data.choices?.[0]?.message || {};
    const toolCalls = (msg.tool_calls || []).filter((tc) => tc.function);

    this.messages.push({
      role: 'assistant',
      content: msg.content ?? (toolCalls.length ? null : ''),
      ...(toolCalls.length ? { tool_calls: msg.tool_calls } : {}),
    });

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
