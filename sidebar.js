/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ArkAI } from './ark.js';

// The Gemini SDK is bundled by `npm install` (postinstall esbuild step) into
// js-genai.js, which is gitignored. Load it lazily so the rest of the sidebar -
// including the ARK provider, which doesn't need it - still works when the
// bundle is absent. A static import here would abort the whole module.
let GoogleGenAI;
async function loadGoogleGenAI() {
  if (!GoogleGenAI) ({ GoogleGenAI } = await import('./js-genai.js'));
  return GoogleGenAI;
}

// highlight.js bundle (also produced by `npm install`), loaded lazily.
let hljs;
async function loadHljs() {
  if (!hljs) ({ default: hljs } = await import('./hljs.js'));
  return hljs;
}

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
const suggestBtn = document.getElementById('suggestBtn');
const traceBtn = document.getElementById('traceBtn');
const resetBtn = document.getElementById('resetBtn');
const apiKeyInput = document.getElementById('apiKeyInput');
const promptResults = document.getElementById('promptResults');
const advancedSection = document.getElementById('advancedSection');

// First, request list of tools from content script living in top-level frame.
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { action: 'LIST_TOOLS' }, { frameId: 0 });
  } catch (error) {
    const statusDiv = document.getElementById('status');
    statusDiv.textContent = error;
    statusDiv.hidden = false;
    copyToClipboard.hidden = true;
  }
})();

let currentTools;


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

  currentTools = tools;
  updateSuggestButton();

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

  await loadHljs().catch(() => {});

  const KEYS = ['name', 'description', 'inputSchema', 'readOnlyHint', 'untrustedContentHint'];
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
        const json = JSON.stringify(JSON.parse(item[key]), null, '  ');
        td.innerHTML = `<pre class="json">${highlightJSON(json)}</pre>`;
      } catch (error) {
        td.textContent = item[key];
      }
      row.appendChild(td);
    });
    tbody.appendChild(row);

    const option = document.createElement('option');
    option.textContent = `"${item.name}"`;
    option.value = item.name;
    if (new Set(tools.map((t) => t.location)).size > 1) {
      option.textContent += ` | ${item.location || ''}`;
    }
    option.dataset.inputSchema = item.inputSchema || '{}';
    option.dataset.location = item.location || '';
    toolNames.appendChild(option);
  });
  updateDefaultValueForInputArgs();
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

// Which key + model the active provider uses.
function isArk() {
  return localStorage.provider === 'ark';
}

function currentModel() {
  return isArk() ? localStorage.arkModel : localStorage.model;
}

async function initProvider() {
  let env;
  try {
    // Try load .env.json if present.
    env = (await envModulePromise).default;
  } catch {}

  localStorage.provider ??= env?.provider || 'ark';

  // Gemini key + model migrations.
  if (env?.apiKey) localStorage.apiKey ??= env.apiKey;
  if (localStorage.model === 'gemini-2.5-flash') {
    localStorage.model = 'gemini-3-flash-preview';
  }
  if (localStorage.model === 'gemini-3.1-flash-lite-preview') {
    localStorage.model = 'gemini-3.1-flash-lite';
  }
  localStorage.model ??= env?.model || 'gemini-3-flash-preview';

  // ARK key + model + thinking config.
  if (env?.arkApiKey) localStorage.arkApiKey ??= env.arkApiKey;
  if (env?.arkBaseUrl) localStorage.arkBaseUrl ??= env.arkBaseUrl;
  localStorage.arkModel ??= env?.arkModel || 'doubao-seed-2-0-pro-260215';
  localStorage.arkThinking ??= env?.arkThinking || 'disabled';

  await refreshClient();
  updateApiKeyField();
  syncAdvancedUI();
}

// (Re)build the active provider's client and gate the Send/Reset buttons on it.
async function refreshClient() {
  if (isArk()) {
    genAI = localStorage.arkApiKey
      ? new ArkAI({
          apiKey: localStorage.arkApiKey,
          baseURL: localStorage.arkBaseUrl,
          thinkingMode: localStorage.arkThinking,
        })
      : undefined;
  } else if (localStorage.apiKey) {
    try {
      const GenAI = await loadGoogleGenAI();
      genAI = new GenAI({ apiKey: localStorage.apiKey });
    } catch (error) {
      genAI = undefined;
      logLine('error', 'Gemini SDK not bundled', `Run "npm install", or use the ARK provider. (${error})`);
    }
  } else {
    genAI = undefined;
  }
  chat = undefined;
  promptBtn.disabled = !genAI;
  resetBtn.disabled = !genAI;
  updateSuggestButton();
}

function updateApiKeyField() {
  apiKeyInput.placeholder = isArk() ? 'ARK API key' : 'Gemini API key';
  apiKeyInput.value = (isArk() ? localStorage.arkApiKey : localStorage.apiKey) || '';
}

// Restore stored selections into the radios. Which group is visible is handled
// entirely in CSS via :has() on the checked provider radio.
function setRadio(name, value) {
  document.querySelectorAll(`input[name="${name}"]`).forEach((radio) => {
    radio.checked = radio.value === value;
  });
}

function syncAdvancedUI() {
  setRadio('provider', localStorage.provider);
  setRadio('geminiModel', localStorage.model);
  setRadio('arkModel', localStorage.arkModel);
  setRadio('arkThinking', localStorage.arkThinking);
}

await initProvider();

document.querySelectorAll('input[name="provider"]').forEach((radio) => {
  radio.onchange = async () => {
    localStorage.provider = radio.value;
    await initProvider();
  };
});

document.querySelectorAll('input[name="geminiModel"]').forEach((radio) => {
  radio.onclick = () => {
    localStorage.model = radio.value;
    chat = undefined;
    advancedSection.hidePopover();
  };
});

document.querySelectorAll('input[name="arkModel"]').forEach((radio) => {
  radio.onclick = () => {
    localStorage.arkModel = radio.value;
    chat = undefined;
    advancedSection.hidePopover();
  };
});

document.querySelectorAll('input[name="arkThinking"]').forEach((radio) => {
  radio.onclick = async () => {
    localStorage.arkThinking = radio.value;
    await initProvider();
  };
});

// The Suggest button is usable once a client and tools are both available.
function updateSuggestButton() {
  suggestBtn.disabled = !genAI || !currentTools || currentTools.length === 0;
}

suggestBtn.onclick = async () => {
  if (suggestBtn.disabled) return;
  suggestBtn.disabled = true;
  try {
    const response = await genAI.models.generateContent({
      model: currentModel(),
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
    userPromptText.value = response.text?.trim() || '';
  } catch (error) {
    logLine('error', 'Error suggesting prompt', String(error));
  } finally {
    updateSuggestButton();
  }
};

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
    trace.push({ error });
    logLine('error', 'Error', String(error));
  }
};

let trace = [];

async function promptAI() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chat ??= genAI.chats.create({ model: currentModel() });

  const message = userPromptText.value;
  userPromptText.value = '';
  logLine('user', 'User', message);
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
        logJSON('error', 'Agent response has no text', JSON.stringify(response.candidates));
      } else {
        logLine('agent', 'Agent', response.text.trim());
      }
      finalResponseGiven = true;
    } else {
      const toolResponses = [];
      for (const { name: toolName, args } of functionCalls) {
        const [locationIndex, name] = toolName.split(/_(.*)/s)[1].split(/_(.*)/s);
        const location = currentTools[locationIndex].location;
        const inputArgs = JSON.stringify(args);
        logJSON('toolcall', `Tool call → ${name}`, inputArgs);
        try {
          const result = await executeTool(tab.id, name, inputArgs, location);
          toolResponses.push({ functionResponse: { name: toolName, response: { result } } });
          logJSON('toolresult', `Tool result → ${name}`, result);
        } catch (e) {
          logLine('error', `Tool error → ${name}`, e.message);
          toolResponses.push({
            functionResponse: { name: toolName, response: { error: e.message } },
          });
        }
      }

      // FIXME: New WebMCP tools may not be discovered if there's a navigation.
      // An articial timeout is introduced for mitigation but it's not robust enough.
      await new Promise((r) => setTimeout(r, 500));

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
  promptResults.textContent = '';
};

// Save live so the Send button enables as soon as a key is present; rebuild the
// client directly rather than via initProvider so the input cursor isn't reset.
apiKeyInput.oninput = async () => {
  const apiKey = apiKeyInput.value.trim();
  if (isArk()) localStorage.arkApiKey = apiKey;
  else localStorage.apiKey = apiKey;
  await refreshClient();
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
  const location = toolNames.selectedOptions[0].dataset.location;
  toolResults.textContent = await executeTool(tab.id, name, inputArgs, location).catch(
    (error) => `⚠️ Error: "${error}"`,
  );
};

async function executeTool(tabId, name, inputArgs, location) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      action: 'EXECUTE_TOOL',
      name,
      inputArgs,
      location,
    });
    if (result !== null) return result;
  } catch (error) {
    if (!error.message.includes('message channel is closed')) throw error;
  }
  // A navigation was triggered. The result will be on the next document.
  // TODO: Handle case where a new tab is opened.
  await waitForPageLoad(tabId);
  return await chrome.tabs.sendMessage(tabId, {
    action: 'GET_CROSS_DOCUMENT_SCRIPT_TOOL_RESULT',
    location,
  });
}

toolNames.onchange = updateDefaultValueForInputArgs;

function updateDefaultValueForInputArgs() {
  const inputSchema = toolNames.selectedOptions[0].dataset.inputSchema || '{}';
  const template = generateTemplateFromSchema(JSON.parse(inputSchema));
  inputArgsText.value = JSON.stringify(template, '', ' ');
}

// Utils

// highlight.js (core + json grammar) is bundled to hljs.js by `npm install`.
// Returns editor-colored HTML, falling back to escaped plain text when the
// bundle is absent.
function highlightJSON(json) {
  if (hljs) return hljs.highlight(json, { language: 'json' }).value;
  return json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function appendLog(node) {
  promptResults.appendChild(node);
  promptResults.scrollTop = promptResults.scrollHeight;
}

// A plain text log entry tagged with a role (user/agent/tool/error/note).
function logLine(kind, label, text) {
  const entry = document.createElement('div');
  entry.className = `log-entry log-${kind}`;
  if (label) {
    const tag = document.createElement('div');
    tag.className = 'log-label';
    tag.textContent = label;
    entry.appendChild(tag);
  }
  if (text) {
    const body = document.createElement('div');
    body.className = 'log-body';
    body.textContent = text;
    entry.appendChild(body);
  }
  appendLog(entry);
}

// A collapsible entry whose body is pretty-printed, syntax-highlighted JSON
// (falls back to raw text when the payload isn't JSON).
function logJSON(kind, label, raw) {
  const entry = document.createElement('details');
  entry.className = `log-entry log-${kind}`;
  entry.open = true;
  const summary = document.createElement('summary');
  summary.className = 'log-label';
  summary.textContent = label;
  entry.appendChild(summary);
  const pre = document.createElement('pre');
  pre.className = 'log-body json';
  let pretty = raw;
  try {
    pretty = JSON.stringify(JSON.parse(raw), null, '  ');
  } catch {}
  pre.innerHTML = highlightJSON(pretty);
  entry.appendChild(pre);
  appendLog(entry);
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
    'Use the provided tools to query page content when you need it.',
    `Today's date is: ${getFormattedDate()}`,
    'CRITICAL RULE: Whenever the user provides a relative date (e.g., "next Monday", "tomorrow", "in 3 days"),  you must calculate the exact calendar date based on today\'s date.',
    'CRITICAL RULE: Do not try to use other tools than the available ones.',
  ];

  const functionDeclarations = currentTools.map((tool) => {
    const locationIndex = currentTools.findIndex((t) => t.location === tool.location);
    return {
      name: `_${locationIndex}_${tool.name}`,
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
