/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getAllFrameOrigins } from './utils.js';

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
const promptResults = document.getElementById('promptResults');
const advancedSection = document.getElementById('advancedSection');
const suggestUserPromptCheckbox = document.getElementById('suggestUserPromptCheckbox');

// First, request list of tools from content script living in top-level frame.
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const fromOrigins = await getAllFrameOrigins(tab.id);
    await chrome.tabs.sendMessage(tab.id, { action: 'LIST_TOOLS', fromOrigins }, { frameId: 0 });
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
  if (sender.frameId && sender.frameId !== 0) return;

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

  const KEYS = ['description', 'inputSchema', 'readOnlyHint', 'untrustedContentHint', 'name'];
  const keys = KEYS.filter((key) => tools.some((tool) => key in tool));
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
    option.textContent = `"${item.name}"${item.frameId !== 0 ? ` (${item.frameId})` : ''}`;
    option.value = item.name;
    option.dataset.inputSchema = item.inputSchema || '{}';
    option.dataset.frameId = item.frameId;
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

const env = (await import('./.env.json', { with: { type: 'json' } })).default;

const SERVER_URL = (env?.serverUrl || 'http://localhost:3000').replace(/\/$/, '');

let abortController;

async function callBackend(endpoint, data, options = {}) {
  const res = await fetch(`${SERVER_URL}${endpoint}`, {
    method: data ? 'POST' : 'GET',
    ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}),
    signal: options.signal ?? abortController?.signal,
    ...options,
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;
}

let { model } = await callBackend('/api/model');
let chatId;

promptBtn.disabled = false;
resetBtn.disabled = false;
suggestUserPromptCheckbox.checked = localStorage.suggestUserPrompt !== 'false';

document.querySelectorAll('input[name="model"]').forEach((radio) => {
  radio.checked = radio.value === model;
  radio.onclick = () => {
    abortController?.abort();
    abortController = new AbortController();
    model = radio.value;
    callBackend('/api/model', { model, chatId });
    chatId = undefined;
    advancedSection.hidePopover();
  };
});

suggestUserPromptCheckbox.onchange = () => {
  localStorage.suggestUserPrompt = suggestUserPromptCheckbox.checked;
  if (localStorage.suggestUserPrompt) suggestUserPrompt();
  advancedSection.hidePopover();
};

async function suggestUserPrompt() {
  if (localStorage.suggestUserPrompt === 'false') return;
  if (currentTools.length === 0 || userPromptText.value !== lastSuggestedUserPrompt)
    return;
  const userPromptId = ++userPromptPendingId;
  try {
    const response = await callBackend('/api/suggest-prompt', { tools: currentTools });
    if (userPromptId !== userPromptPendingId || userPromptText.value !== lastSuggestedUserPrompt)
      return;
    lastSuggestedUserPrompt = response.text;
    userPromptText.value = '';
    for (const chunk of response.text) {
      await new Promise((r) => requestAnimationFrame(r));
      userPromptText.value += chunk;
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.warn('Suggest prompt failed:', e);
  }
}

userPromptText.onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    promptBtn.click();
  }
};

promptBtn.onclick = async () => {
  try {
    await promptAI();
  } catch (error) {
    if (error.name === 'AbortError') return;
    trace.push({ error });
    logPrompt(`⚠️ Error: "${error}"`);
  }
};

let trace = [];

async function promptAI() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  abortController?.abort();
  abortController = new AbortController();

  const message = userPromptText.value;
  userPromptText.value = '';
  lastSuggestedUserPrompt = '';
  promptResults.textContent += `User prompt: "${message}"\n`;
  trace.push({ userPrompt: message });
  let currentResult = await callBackend('/api/chat', {
    message,
    tools: currentTools,
    chatId,
  });
  if (currentResult.chatId) chatId = currentResult.chatId;

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
      for (const { name: toolName, args } of functionCalls) {
        let [frameId, name] = toolName.split(/_(.*)/s)[1].split(/_(.*)/s);
        frameId = parseInt(frameId);
        const inputArgs = JSON.stringify(args);
        logPrompt(`AI calling tool "${name}" with ${inputArgs}`);
        try {
          const result = await executeTool(tab.id, name, inputArgs, frameId);
          toolResponses.push({ functionResponse: { name: toolName, response: { result } } });
          logPrompt(`Tool "${name}" result: ${result}`);
        } catch (e) {
          logPrompt(`⚠️ Error executing tool "${name}": ${e.message}`);
          toolResponses.push({
            functionResponse: { name: toolName, response: { error: e.message } },
          });
        }
      }

      // FIXME: New WebMCP tools may not be discovered if there's a navigation.
      // An articial timeout is introduced for mitigation but it's not robust enough.
      await new Promise((r) => setTimeout(r, 500));

      trace.push({ userPrompt: toolResponses });
      currentResult = await callBackend('/api/chat', { toolResponses, chatId });
      if (currentResult.chatId) chatId = currentResult.chatId;
    }
  }
}

resetBtn.onclick = () => {
  abortController?.abort();
  abortController = new AbortController();
  callBackend('/api/reset', { chatId });
  chatId = undefined;
  trace = [];
  userPromptText.value = '';
  lastSuggestedUserPrompt = '';
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
  const frameId = parseInt(toolNames.selectedOptions[0].dataset.frameId);
  toolResults.textContent = await executeTool(tab.id, name, inputArgs, frameId).catch(
    (error) => `⚠️ Error: "${error}"`,
  );
};

async function executeTool(tabId, name, inputArgs, frameId) {
  try {
    const result = await chrome.tabs.sendMessage(
      tabId,
      { action: 'EXECUTE_TOOL', name, inputArgs },
      { frameId },
    );
    if (result !== null) return result;
  } catch (error) {
    if (!error.message.includes('message channel is closed')) throw error;
  }
  // A navigation was triggered. The result will be on the next document.
  // TODO: Handle case where a new tab is opened.
  await waitForPageLoad(tabId);
  return await chrome.tabs.sendMessage(
    tabId,
    { action: 'GET_CROSS_DOCUMENT_SCRIPT_TOOL_RESULT' },
    { frameId },
  );
}

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
