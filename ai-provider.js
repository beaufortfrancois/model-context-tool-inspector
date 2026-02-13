/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Base class for AI providers
 */
export class AIProvider {
  /**
   * Create a chat session
   * @param {Object} options - Chat options including model
   * @returns {Chat} Chat instance
   */
  createChat(options) {
    throw new Error('createChat must be implemented by subclass');
  }

  /**
   * List available models
   * @returns {Promise<Array>} List of models
   */
  async listModels() {
    throw new Error('listModels must be implemented by subclass');
  }

  /**
   * Generate content with the model
   * @param {Object} params - Generation parameters
   * @returns {Promise} Generation response
   */
  async generateContent(params) {
    throw new Error('generateContent must be implemented by subclass');
  }

  /**
   * Get provider name
   * @returns {string} Provider name
   */
  getName() {
    throw new Error('getName must be implemented by subclass');
  }
}

/**
 * Base class for chat sessions
 */
export class Chat {
  /**
   * Send a message in the chat
   * @param {Object} params - Message parameters
   * @returns {Promise} Response
   */
  async sendMessage(params) {
    throw new Error('sendMessage must be implemented by subclass');
  }
}
