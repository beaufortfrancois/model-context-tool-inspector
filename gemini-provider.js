/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI } from './js-genai.js';
import { AIProvider, Chat } from './ai-provider.js';

/**
 * Google GenAI provider implementation
 */
export class GeminiProvider extends AIProvider {
  constructor(config) {
    super();
    this.apiKey = config.apiKey;
    this.genAI = new GoogleGenAI({ apiKey: this.apiKey });
  }

  createChat(options) {
    return this.genAI.chats.create(options);
  }

  async listModels() {
    const response = await this.genAI.models.list();
    const models = [];
    
    for await (const model of response) {
      // Only include models that support generateContent
      if (model.supportedActions?.includes('generateContent')) {
        models.push({
          name: model.name.replace('models/', ''),
          displayName: model.displayName || model.name.replace('models/', '')
        });
      }
    }
    
    return models;
  }

  async generateContent(params) {
    return await this.genAI.models.generateContent(params);
  }

  getName() {
    return 'gemini';
  }
}
