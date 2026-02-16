/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AIProvider, Chat } from './ai-provider.js';

/**
 * Ollama provider implementation
 */
export class OllamaProvider extends AIProvider {
  constructor(config) {
    super();
    this.baseUrl = config.baseUrl || 'http://localhost:11434';
    this.defaultModel = config.model || 'llama2';
  }

  createChat(options) {
    return new OllamaChat(this.baseUrl, options.model || this.defaultModel);
  }

  async listModels() {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.statusText}`);
      }
      const data = await response.json();
      return (data.models || []).map(model => ({
        name: model.name,
        displayName: model.name
      }));
    } catch (error) {
      console.error('Failed to list Ollama models:', error);
      // Return empty array if Ollama is not available
      return [];
    }
  }

  async generateContent(params) {
    const model = params.model || this.defaultModel;
    const contents = Array.isArray(params.contents) ? params.contents : [params.contents];
    const prompt = contents.join('\n');

    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false
      })
    });

    if (!response.ok) {
      let errorMessage = `Ollama API error: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage += ` - ${errorData.error}`;
        }
      } catch (e) {
        // Response body is not JSON, ignore
      }
      throw new Error(errorMessage);
    }

    const data = await response.json();
    return {
      text: data.response || ''
    };
  }

  getName() {
    return 'ollama';
  }
}

/**
 * Ollama chat session implementation
 */
class OllamaChat extends Chat {
  constructor(baseUrl, model) {
    super();
    this.baseUrl = baseUrl;
    this.model = model;
    this.messages = [];
  }

  async sendMessage(params) {
    const { message, config } = params;

    // Handle tool responses (array of function responses)
    if (Array.isArray(message)) {
      // Convert tool responses to text for Ollama
      const toolResponseText = message.map(item => {
        const fr = item.functionResponse;
        return `Tool "${fr.name}" result: ${JSON.stringify(fr.response)}`;
      }).join('\n');

      this.messages.push({
        role: 'user',
        content: toolResponseText
      });
    } else {
      // Regular user message
      this.messages.push({
        role: 'user',
        content: message
      });
    }

    // Build system prompt with tools information
    let systemPrompt = '';
    if (config?.systemInstruction) {
      systemPrompt = Array.isArray(config.systemInstruction)
        ? config.systemInstruction.join('\n')
        : config.systemInstruction;
    }

    // Add tools information to system prompt
    if (config?.tools?.[0]?.functionDeclarations) {
      const toolsInfo = config.tools[0].functionDeclarations.map(tool => {
        return `Tool: ${tool.name}\nDescription: ${tool.description}\nParameters: ${JSON.stringify(tool.parametersJsonSchema)}`;
      }).join('\n\n');

      systemPrompt += `\n\nAvailable tools:\n${toolsInfo}\n\n`;
      systemPrompt += 'To use a tool, respond with JSON in this format:\n';
      systemPrompt += '{"functionCalls": [{"name": "tool_name", "args": {...}}]}\n';
      systemPrompt += 'If you need to use multiple tools, include them all in the functionCalls array.\n';
      systemPrompt += 'If you don\'t need to use any tools, respond normally without JSON.';
    }

    // Prepare messages for Ollama
    const ollamaMessages = [];
    if (systemPrompt) {
      ollamaMessages.push({
        role: 'system',
        content: systemPrompt
      });
    }
    ollamaMessages.push(...this.messages);

    // Call Ollama chat API
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: ollamaMessages,
        stream: false
      })
    });

    if (!response.ok) {
      let errorMessage = `Ollama API error: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage += ` - ${errorData.error}`;
        }
      } catch (e) {
        // Response body is not JSON, ignore
      }
      throw new Error(errorMessage);
    }

    const data = await response.json();
    const assistantMessage = data.message?.content || '';

    // Store assistant response
    this.messages.push({
      role: 'assistant',
      content: assistantMessage
    });

    // Try to parse function calls from response
    let functionCalls = [];
    try {
      // Look for JSON in the response
      const jsonMatch = assistantMessage.match(/\{[\s\S]*"functionCalls"[\s\S]*}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.functionCalls && Array.isArray(parsed.functionCalls)) {
          functionCalls = parsed.functionCalls;
        }
      }
    } catch (e) {
      // Not a function call, treat as regular text response
    }

    return {
      text: assistantMessage,
      functionCalls: functionCalls,
      candidates: [{ content: { parts: [{ text: assistantMessage }] } }]
    };
  }
}
