/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { GoogleGenAI } from './js-genai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.json');

// Load API Key & Model from .env.json
let env = {};
try {
  if (fs.existsSync(envPath)) {
    env = JSON.parse(fs.readFileSync(envPath, 'utf-8'));
  }
} catch (e) {
  console.warn('Could not load .env.json:', e.message);
}

const apiKey = env.apiKey || process.env.GEMINI_API_KEY;
let activeModel = env.model || 'gemini-3.6-flash';

if (!apiKey) {
  console.error('⚠️ Warning: No Gemini API Key found in .env.json or environment variables!');
}

const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;
const chats = new Map();

function getSystemInstruction() {
  const formattedDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return [
    'You are an assistant embedded in a browser tab.',
    'User prompts typically refer to the current tab unless stated otherwise.',
    'Use the provided tools to query page content when you need it.',
    `Today's date is: ${formattedDate}`,
    'CRITICAL RULE: Whenever the user provides a relative date (e.g., "next Monday", "tomorrow", "in 3 days"),  you must calculate the exact calendar date based on today\'s date.',
    'CRITICAL RULE: Do not try to use other tools than the available ones.',
  ];
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  console.log(`\n📥 [${req.method}] ${url.pathname}`);

  try {
    if (url.pathname === '/api/model') {
      if (req.method === 'POST') {
        const { model, chatId } = await parseJsonBody(req);
        if (model) {
          activeModel = model;
          if (chatId && chats.has(chatId)) {
            chats.delete(chatId);
            console.log(`  Set active model to: "${activeModel}" (chat session [${chatId}] reset)`);
          } else {
            chats.clear();
            console.log(`  Set active model to: "${activeModel}" (all chat sessions reset)`);
          }
        }
      } else {
        console.log(`  Current active model: "${activeModel}"`);
      }
      const responsePayload = { success: true, model: activeModel };
      console.log('  Response:', responsePayload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responsePayload));
      return;
    }

    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const { message, tools, toolResponses, chatId: inputChatId } = await parseJsonBody(req);

      if (!ai) {
        console.error('  Error: Gemini API Key missing on backend server.');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Gemini API Key missing on backend server.' }));
        return;
      }

      let chatId = inputChatId;
      let chatSession = chatId ? chats.get(chatId) : null;

      if (!chatSession) {
        chatId = randomUUID();
        console.log(`  Initializing new chat session [${chatId}] with model: "${activeModel}"`);
        chatSession = ai.chats.create({ model: activeModel });
        chats.set(chatId, chatSession);
      } else {
        console.log(`  Resuming chat session [${chatId}] with model: "${activeModel}"`);
      }

      let sendMessageParams;

      if (toolResponses) {
        console.log(`  Tool responses received for [${chatId}]:`, JSON.stringify(toolResponses, null, 2));
        sendMessageParams = { message: toolResponses };
      } else {
        console.log(`  [${chatId}] User message: "${message}"`);
        if (tools && tools.length > 0) {
          console.log(`  [${chatId}] Tools provided (${tools.length}):`, tools.map((t) => t.name).join(', '));
        }
        const functionDeclarations = (tools || []).map((tool) => ({
          name: `_${tool.frameId}_${tool.name}`,
          description: tool.description,
          parametersJsonSchema: tool.inputSchema
            ? JSON.parse(tool.inputSchema)
            : { type: 'object', properties: {} },
        }));

        const config = {
          systemInstruction: getSystemInstruction(),
          ...(functionDeclarations.length > 0 ? { tools: [{ functionDeclarations }] } : {}),
        };

        sendMessageParams = { message, config };
      }

      const result = await chatSession.sendMessage(sendMessageParams);

      const responsePayload = {
        chatId,
        text: result.text || '',
        functionCalls: result.functionCalls || [],
        candidates: result.candidates || [],
      };

      if (result.functionCalls && result.functionCalls.length > 0) {
        console.log(`  [${chatId}] Gemini Function Calls:`, JSON.stringify(result.functionCalls, null, 2));
      }
      if (result.text) {
        console.log(`  [${chatId}] Gemini Response Text: "${result.text}"`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responsePayload));
      return;
    }

    if (url.pathname === '/api/reset' && req.method === 'POST') {
      const { chatId } = await parseJsonBody(req);
      if (chatId && chats.has(chatId)) {
        chats.delete(chatId);
        console.log(`  Chat session [${chatId}] reset.`);
      } else {
        chats.clear();
        console.log('  All chat sessions reset.');
      }
      const responsePayload = { success: true, message: 'Chat session reset.' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responsePayload));
      return;
    }

    if (url.pathname === '/api/suggest-prompt' && req.method === 'POST') {
      const { tools } = await parseJsonBody(req);

      if (!ai) {
        console.error('  Error: Gemini API Key missing.');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Gemini API Key missing.' }));
        return;
      }

      console.log(`  Generating prompt suggestion for ${tools?.length || 0} tools using model: "${activeModel}"`);

      const formattedDate = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });

      const response = await ai.models.generateContent({
        model: activeModel,
        contents: [
          '**Context:**',
          `Today's date is: ${formattedDate}`,
          '**Tool Rules:**',
          '1. **Bank Transaction Filter:** Use **PAST** dates only (e.g., "last month," "December 15th," "yesterday").',
          '2. **Flight Search:** Use **FUTURE** dates only (e.g., "next week," "February 15th").',
          '3. **Accommodation Search:** Use **FUTURE** dates only (e.g., "next weekend," "March 15th").',
          '**Task:**',
          'Generate one natural user query for a range of tools below, ideally chaining them together.',
          'Ensure the date makes sense relative to today.',
          'Output the query text only.',
          '**Tools:**',
          JSON.stringify(tools || []),
        ],
      });

      console.log(`  Suggested prompt result: "${response.text}"`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: response.text || '' }));
      return;
    }

    console.warn(`  404 Not Found: ${url.pathname}`);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (error) {
    console.error('  Server error:', error.message || error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});

const PORT = process.env.PORT || env.port || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Backend Gemini server listening on http://localhost:${PORT}`);
});
