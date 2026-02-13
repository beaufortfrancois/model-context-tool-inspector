/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI } from './js-genai.js';

const statusDiv = document.getElementById('status');
const tbody = document.getElementById('tableBody');
const thead = document.getElementById('tableHeaderRow');
const copyToClipboard = document.getElementById('copyToClipboard');
const copyAsScriptToolConfig = document.getElementById('copyAsScriptToolConfig');
const copyAsJSON = document.getElementById('copyAsJSON');
const toolNames = document.getElementById('toolNames');
const inputArgsText = document.getElementById('inputArgsText');
const executeBtn = document.getElementById('executeBtn');
const toolResults = document.getElementById('toolResults');
const userPromptText = document.getElementById('userPromptText');
const promptBtn = document.getElementById('promptBtn');
const traceBtn = document.getElementById('traceBtn');
const resetBtn = document.getElementById('resetBtn');
const apiKeyBtn = document.getElementById('apiKeyBtn');
const promptResults = document.getElementById('promptResults');
const modelSelect = document.getElementById('modelSelect');

// Inject content script first.
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { action: 'LIST_TOOLS' });
  } catch (error) {
    const statusDiv = document.getElementById('status');
    statusDiv.textContent = error;
    statusDiv.hidden = false;
    copyToClipboard.hidden = true;
  }
})();

let currentTools;

let userPromptPendingId = 0;
let lastSuggestedUserPrompt = '';

// Listen for the results coming back from content.js
chrome.runtime.onMessage.addListener(async ({ message, tools, url }, sender) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (sender.tab && sender.tab.id !== tab.id) return;

  tbody.innerHTML = '';
  thead.innerHTML = '';
  toolNames.innerHTML = '';

  statusDiv.textContent = message;
  statusDiv.hidden = !message;

  const haveNewTools = JSON.stringify(currentTools) !== JSON.stringify(tools);

  currentTools = tools;

  if (!tools || tools.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="100%"><i>No tools registered yet in ${url || tab.url}</i></td>`;
    tbody.appendChild(row);
    inputArgsText.value = '';
    inputArgsText.disabled = true;
    toolNames.disabled = true;
    executeBtn.disabled = true;
    copyToClipboard.hidden = true;
    return;
  }

  inputArgsText.disabled = false;
  toolNames.disabled = false;
  executeBtn.disabled = false;
  copyToClipboard.hidden = false;

  const keys = Object.keys(tools[0]);
  keys.forEach((key) => {
    const th = document.createElement('th');
    th.textContent = key;
    thead.appendChild(th);
  });

  tools.forEach((item) => {
    const row = document.createElement('tr');
    keys.forEach((key) => {
      const td = document.createElement('td');
      try {
        td.innerHTML = `<pre>${JSON.stringify(JSON.parse(item[key]), '', '  ')}</pre>`;
      } catch (error) {
        td.textContent = item[key];
      }
      row.appendChild(td);
    });
    tbody.appendChild(row);

    const option = document.createElement('option');
    option.textContent = `"${item.name}"`;
    option.value = item.name;
    option.dataset.inputSchema = item.inputSchema;
    toolNames.appendChild(option);
  });
  updateDefaultValueForInputArgs();

  if (haveNewTools) suggestUserPrompt();
});

tbody.ondblclick = () => {
  tbody.classList.toggle('prettify');
};

copyAsScriptToolConfig.onclick = async () => {
  const text = currentTools
    .map((tool) => {
      return `\
script_tools {
  name: "${tool.name}"
  description: "${tool.description}"
  input_schema: ${JSON.stringify(tool.inputSchema || { type: 'object', properties: {} })}
}`;
    })
    .join('\r\n');
  await navigator.clipboard.writeText(text);
};

copyAsJSON.onclick = async () => {
  const tools = currentTools.map((tool) => {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
        ? JSON.parse(tool.inputSchema)
        : { type: 'object', properties: {} },
    };
  });
  await navigator.clipboard.writeText(JSON.stringify(tools, '', '  '));
};

// Interact with the page

let genAI, chat;

const envModulePromise = import('./.env.json', { with: { type: 'json' } });

async function loadAvailableModels() {
  if (!genAI) return;

  // Show loading state
  modelSelect.disabled = true;
  modelSelect.innerHTML = '<option>Loading models...</option>';

  try {
    // Fetch available models from the API
    const response = await genAI.models.list();
    const models = [];
    let totalModels = 0;
    let skippedModels = 0;

    for await (const model of response) {
      totalModels++;
      console.log('Model found:', model.name, 'supportedActions:', model.supportedActions);

      // Only include models that support generateContent
      if (model.supportedActions?.includes('generateContent')) {
        models.push({
          name: model.name.replace('models/', ''),
          displayName: model.displayName || model.name.replace('models/', '')
        });
      } else {
        skippedModels++;
      }
    }

    console.log(`Total models: ${totalModels}, Filtered models: ${models.length}, Skipped: ${skippedModels}`);

    // Clear loading message
    modelSelect.innerHTML = '';

    if (models.length > 0) {
      // Save the current selection
      const currentModel = localStorage.model;

      // Add the fetched models
      models.forEach(model => {
        const option = document.createElement('option');
        option.value = model.name;
        option.textContent = model.displayName;
        modelSelect.appendChild(option);
      });

      // Restore the previous selection if it's still available, otherwise use the first model
      if (models.some(m => m.name === currentModel)) {
        modelSelect.value = currentModel;
      } else {
        localStorage.model = models[0].name;
        modelSelect.value = models[0].name;
      }
    } else {
      // No models available - add fallback
      console.warn('No models with generateContent support found. Using fallback list.');
      modelSelect.innerHTML = `
        <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
        <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
        <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
        <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
        <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
      `;
      if (localStorage.model) {
        modelSelect.value = localStorage.model;
      }
    }
  } catch (error) {
    console.error('Failed to load models:', error);
    // Restore default hardcoded models if API call fails
    modelSelect.innerHTML = `
      <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
      <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
      <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
      <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
      <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
    `;
    if (localStorage.model) {
      modelSelect.value = localStorage.model;
    }
  } finally {
    modelSelect.disabled = false;
  }
}

async function initGenAI() {
  let env;
  try {
    // Try load .env.json if present.
    env = (await envModulePromise).default;
  } catch {}
  if (env?.apiKey) localStorage.apiKey ??= env.apiKey;
  localStorage.model ??= env?.model || 'gemini-2.5-flash';

  // Set the model selector to the saved value
  if (modelSelect) modelSelect.value = localStorage.model;

  genAI = localStorage.apiKey ? new GoogleGenAI({ apiKey: localStorage.apiKey }) : undefined;
  promptBtn.disabled = !localStorage.apiKey;
  resetBtn.disabled = !localStorage.apiKey;

  // Load available models if API key is set
  if (genAI) {
    await loadAvailableModels();
  }
}
initGenAI();

async function suggestUserPrompt() {
  if (currentTools.length == 0 || !genAI || userPromptText.value !== lastSuggestedUserPrompt)
    return;
  const userPromptId = ++userPromptPendingId;
  const response = await genAI.models.generateContent({
    model: localStorage.model,
    contents: [
      '**Context:**',
      `Today's date is: ${getFormattedDate()}`,
      '**Tool Rules:**',
      '1. **Bank Transaction Filter:** Use **PAST** dates only (e.g., "last month," "December 15th," "yesterday").',
      '2. **Flight Search:** Use **FUTURE** dates only (e.g., "next week," "February 15th").',
      '3. **Accommodation Search:** Use **FUTURE** dates only (e.g., "next weekend," "March 15th").',
      '**Task:**',
      'Generate one natural user query for a range of tools below, ideally chaining them together.',
      'Ensure the date makes sense relative to today.',
      'Output the query text only.',
      '**Tools:**',
      JSON.stringify(currentTools),
    ],
  });
  if (userPromptId !== userPromptPendingId || userPromptText.value !== lastSuggestedUserPrompt)
    return;
  lastSuggestedUserPrompt = response.text;
  userPromptText.value = '';
  for (const chunk of response.text) {
    await new Promise((r) => requestAnimationFrame(r));
    userPromptText.value += chunk;
  }
}

userPromptText.onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    promptBtn.click();
  }
};

promptBtn.onclick = async () => {
  try {
    await promptAI();
  } catch (error) {
    trace.push({ error });
    logPrompt(`⚠️ Error: "${error}"`);
  }
};

let trace = [];

async function promptAI() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chat ??= genAI.chats.create({ model: localStorage.model });

  const message = userPromptText.value;
  userPromptText.value = '';
  lastSuggestedUserPrompt = '';
  promptResults.textContent += `User prompt: "${message}"\n`;
  const sendMessageParams = { message, config: getConfig() };
  trace.push({ userPrompt: sendMessageParams });
  let currentResult = await chat.sendMessage(sendMessageParams);
  let finalResponseGiven = false;

  while (!finalResponseGiven) {
    const response = currentResult;
    trace.push({ response });
    const functionCalls = response.functionCalls || [];

    if (functionCalls.length === 0) {
      if (!response.text) {
        logPrompt(`⚠️ AI response has no text: ${JSON.stringify(response.candidates)}\n`);
      } else {
        logPrompt(`AI result: ${response.text?.trim()}\n`);
      }
      finalResponseGiven = true;
    } else {
      const toolResponses = [];
      for (const { name, args } of functionCalls) {
        const inputArgs = JSON.stringify(args);
        logPrompt(`AI calling tool "${name}" with ${inputArgs}`);
        try {
          const result = await chrome.tabs.sendMessage(tab.id, {
            action: 'EXECUTE_TOOL',
            name,
            inputArgs,
          });
          toolResponses.push({ functionResponse: { name, response: { result } } });
          logPrompt(`Tool "${name}" result: ${result}`);
        } catch (e) {
          logPrompt(`⚠️ Error executing tool "${name}": ${e.message}`);
          toolResponses.push({
            functionResponse: { name, response: { error: e.message } },
          });
        }
      }

      // FIXME: New WebMCP tools may not be discovered if there's a navigation.
      // An articial timeout could be introduced for mitigation but it's not robust.

      const sendMessageParams = { message: toolResponses, config: getConfig() };
      trace.push({ userPrompt: sendMessageParams });
      currentResult = await chat.sendMessage(sendMessageParams);
    }
  }
}

resetBtn.onclick = () => {
  chat = undefined;
  trace = [];
  userPromptText.value = '';
  lastSuggestedUserPrompt = '';
  promptResults.textContent = '';
  suggestUserPrompt();
};

apiKeyBtn.onclick = async () => {
  const apiKey = prompt('Enter Gemini API key');
  if (apiKey == null) return;
  localStorage.apiKey = apiKey;
  await initGenAI();
  suggestUserPrompt();
};

modelSelect.onchange = () => {
  localStorage.model = modelSelect.value;
  // Reset the chat when model changes to avoid mixing contexts
  chat = undefined;
  trace = [];
  promptResults.textContent = '';
  suggestUserPrompt();
};

traceBtn.onclick = async () => {
  const text = JSON.stringify(trace, '', ' ');
  await navigator.clipboard.writeText(text);
};

executeBtn.onclick = async () => {
  toolResults.textContent = '';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const name = toolNames.selectedOptions[0].value;
  const inputArgs = inputArgsText.value;
  const result = await chrome.tabs.sendMessage(tab.id, { action: 'EXECUTE_TOOL', name, inputArgs });
  if (result !== null) {
    toolResults.textContent = result;
    return;
  }
  // A navigation was triggered. The result will be on the next document.
  // TODO: Handle case where a new tab is opened.
  await waitForPageLoad(tab.id);
  toolResults.textContent = await chrome.tabs.sendMessage(tab.id, {
    action: 'GET_CROSS_DOCUMENT_SCRIPT_TOOL_RESULT',
  });
};

toolNames.onchange = updateDefaultValueForInputArgs;

function updateDefaultValueForInputArgs() {
  const inputSchema = toolNames.selectedOptions[0].dataset.inputSchema || '{}';
  const template = generateTemplateFromSchema(JSON.parse(inputSchema));
  inputArgsText.value = JSON.stringify(template, '', ' ');
}

// Utils

function logPrompt(text) {
  promptResults.textContent += `${text}\n`;
  promptResults.scrollTop = promptResults.scrollHeight;
}

function getFormattedDate() {
  const today = new Date();
  return today.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function getConfig() {
  const systemInstruction = [
    'You are an assistant embedded in a browser tab.',
    'User prompts typically refer to the current tab unless stated otherwise.',
    'Use your tools to query page content when you need it.',
    `Today's date is: ${getFormattedDate()}`,
    'CRITICAL RULE: Whenever the user provides a relative date (e.g., "next Monday", "tomorrow", "in 3 days"),  you must calculate the exact calendar date based on today\'s date.',
  ];

  const functionDeclarations = currentTools.map((tool) => {
    return {
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.inputSchema
        ? JSON.parse(tool.inputSchema)
        : { type: 'object', properties: {} },
    };
  });
  return { systemInstruction, tools: [{ functionDeclarations }] };
}

function generateTemplateFromSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return null;
  }

  if (schema.hasOwnProperty('const')) {
    return schema.const;
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return generateTemplateFromSchema(schema.oneOf[0]);
  }

  if (schema.hasOwnProperty('default')) {
    return schema.default;
  }

  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    return schema.examples[0];
  }

  switch (schema.type) {
    case 'object':
      const obj = {};
      if (schema.properties) {
        Object.keys(schema.properties).forEach((key) => {
          obj[key] = generateTemplateFromSchema(schema.properties[key]);
        });
      }
      return obj;

    case 'array':
      if (schema.items) {
        return [generateTemplateFromSchema(schema.items)];
      }
      return [];

    case 'string':
      if (schema.enum && schema.enum.length > 0) {
        return schema.enum[0];
      }
      if (schema.format === 'date') {
        return new Date().toISOString().substring(0, 10);
      }
      // yyyy-MM-ddThh:mm:ss.SSS
      if (
        schema.format ===
        '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]{1,3})?)?$'
      ) {
        return new Date().toISOString().substring(0, 23);
      }
      // yyyy-MM-ddThh:mm:ss
      if (
        schema.format ===
        '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
      ) {
        return new Date().toISOString().substring(0, 19);
      }
      // yyyy-MM-ddThh:mm
      if (schema.format === '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$') {
        return new Date().toISOString().substring(0, 16);
      }
      // yyyy-MM
      if (schema.format === '^[0-9]{4}-(0[1-9]|1[0-2])$') {
        return new Date().toISOString().substring(0, 7);
      }
      // yyyy-Www
      if (schema.format === '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$') {
        return `${new Date().toISOString().substring(0, 4)}-W01`;
      }
      // HH:mm:ss.SSS
      if (schema.format === '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]{1,3})?)?$') {
        return new Date().toISOString().substring(11, 23);
      }
      // HH:mm:ss
      if (schema.format === '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$') {
        return new Date().toISOString().substring(11, 19);
      }
      // HH:mm
      if (schema.format === '^([01][0-9]|2[0-3]):[0-5][0-9]$') {
        return new Date().toISOString().substring(11, 16);
      }
      if (schema.format === '^#[0-9a-zA-Z]{6}$') {
        return '#ff00ff';
      }
      if (schema.format === 'tel') {
        return '123-456-7890';
      }
      if (schema.format === 'email') {
        return 'user@example.com';
      }
      return 'example_string';

    case 'number':
    case 'integer':
      if (schema.minimum !== undefined) return schema.minimum;
      return 0;

    case 'boolean':
      return false;

    case 'null':
      return null;

    default:
      return {};
  }
}

function waitForPageLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

document.querySelectorAll('.collapsible-header').forEach((header) => {
  header.addEventListener('click', () => {
    header.classList.toggle('collapsed');
    const content = header.nextElementSibling;
    if (content?.classList.contains('section-content')) {
      content.classList.toggle('is-hidden');
    }
  });
});
