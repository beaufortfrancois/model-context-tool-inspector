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
const formFields = document.getElementById('formFields');
const modeSwitcher = document.getElementById('modeSwitcher');
const executeBtn = document.getElementById('executeBtn');
const toolResults = document.getElementById('toolResults');
const userPromptText = document.getElementById('userPromptText');
const promptBtn = document.getElementById('promptBtn');
const traceBtn = document.getElementById('traceBtn');
const resetBtn = document.getElementById('resetBtn');
const apiKeyBtn = document.getElementById('apiKeyBtn');
const promptResults = document.getElementById('promptResults');
const executeModalOverlay = document.getElementById('executeModalOverlay');
const executeModalTitle = document.getElementById('executeModalTitle');
const executeModalContent = document.getElementById('executeModalContent');
const executeModalClose = document.getElementById('executeModalClose');

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

  const keys = Object.keys(currentTools[0]);
  keys.forEach((key) => {
    const th = document.createElement('th');
    th.textContent = key;
    thead.appendChild(th);
  });
  const thExecute = document.createElement('th');
  thExecute.textContent = 'Execute';
  thead.appendChild(thExecute);

  const numCols = keys.length + 1;

  tools.forEach((item) => {
    const row = document.createElement('tr');
    row.className = 'tool-row';
    keys.forEach((key) => {
      const td = document.createElement('td');
      try {
        td.innerHTML = `<pre>${JSON.stringify(JSON.parse(item[key]), '', '  ')}</pre>`;
      } catch (error) {
        td.textContent = item[key];
      }
      row.appendChild(td);
    });
    const tdBtn = document.createElement('td');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row-execute-btn';
    btn.textContent = '▶';
    btn.title = 'Open execute form';
    tdBtn.appendChild(btn);
    row.appendChild(tdBtn);
    tbody.appendChild(row);

    const rawSchema = parseInputSchema(item.inputSchema);
    const schema = normalizeInputSchema(rawSchema);
    const hasInputParams = schema.properties && Object.keys(schema.properties).length > 0;

    const formWrap = document.createElement('div');
    formWrap.className = 'row-execute-form';
    formWrap.dataset.toolName = item.name;

    const modeWrap = document.createElement('div');
    modeWrap.className = 'input-args-header';
    if (hasInputParams) {
      const modeSwitcherRow = document.createElement('div');
      modeSwitcherRow.className = 'mode-switcher row-mode-switcher';
      modeSwitcherRow.innerHTML = '<button type="button" class="mode-btn active" data-mode="form">Form</button><button type="button" class="mode-btn" data-mode="json">JSON</button>';
      modeWrap.appendChild(modeSwitcherRow);
    } else {
      modeWrap.hidden = true;
    }
    formWrap.appendChild(modeWrap);

    const rowFormFields = document.createElement('div');
    rowFormFields.className = 'row-form-fields';
    formWrap.appendChild(rowFormFields);

    const rowInputArgs = document.createElement('textarea');
    rowInputArgs.className = 'row-input-args';
    rowInputArgs.hidden = true;
    rowInputArgs.placeholder = '{}';
    formWrap.appendChild(rowInputArgs);

    const template = generateTemplateFromSchema(schema) ?? {};
    rowInputArgs.value = JSON.stringify(template, '', ' ');
    buildFormFromSchema(schema, rowFormFields);
    populateFormFromJson(rowInputArgs.value, rowFormFields);

    rowInputArgs.addEventListener('input', () => fitTextareaToContent(rowInputArgs));

    const submitWrap = document.createElement('div');
    submitWrap.className = 'form-group row-form-actions';
    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'row-execute-submit';
    submitBtn.textContent = 'Execute';
    submitWrap.appendChild(submitBtn);
    const resetFormBtn = document.createElement('button');
    resetFormBtn.type = 'button';
    resetFormBtn.className = 'row-form-reset-link';
    resetFormBtn.textContent = 'Reset';
    submitWrap.appendChild(resetFormBtn);
    formWrap.appendChild(submitWrap);

    const resultPre = document.createElement('pre');
    resultPre.className = 'row-execute-result';
    formWrap.appendChild(resultPre);

    let rowInputMode = 'form';
    const modeSwitcherRow = modeWrap.querySelector('.row-mode-switcher');
    if (modeSwitcherRow) {
      modeSwitcherRow.querySelectorAll('.mode-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (btn.dataset.mode === rowInputMode) return;
          if (rowInputMode === 'form') rowInputArgs.value = JSON.stringify(collectFormData(rowFormFields), '', ' ');
          rowInputMode = btn.dataset.mode;
          modeSwitcherRow.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          if (rowInputMode === 'form') {
            rowInputArgs.hidden = true;
            rowFormFields.hidden = false;
            populateFormFromJson(rowInputArgs.value, rowFormFields);
          } else {
            rowInputArgs.hidden = false;
            rowFormFields.hidden = true;
            requestAnimationFrame(() => fitTextareaToContent(rowInputArgs));
          }
        });
      });
    }

    btn.addEventListener('click', () => {
      openExecuteModal(formWrap, item.name);
    });

    submitBtn.addEventListener('click', async () => {
      if (rowInputMode === 'form' && !validateFormFields(rowFormFields)) return;
      resultPre.textContent = '';
      resultPre.classList.remove('result-success', 'result-error');
      const inputArgs = rowInputMode === 'form' ? JSON.stringify(collectFormData(rowFormFields)) : rowInputArgs.value;
      const toolName = formWrap.dataset.toolName;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const result = await chrome.tabs.sendMessage(tab.id, { action: 'EXECUTE_TOOL', name: toolName, inputArgs });
        resultPre.textContent = result != null ? formatAsJson(result) : '';
        resultPre.classList.add('result-success');
      } catch (e) {
        resultPre.textContent = `Error: ${e.message}`;
        resultPre.classList.add('result-error');
      }
    });

    resetFormBtn.addEventListener('click', () => {
      const resetTemplate = generateTemplateFromSchema(schema) ?? {};
      rowInputArgs.value = JSON.stringify(resetTemplate, '', ' ');
      populateFormFromJson(rowInputArgs.value, rowFormFields);
      resultPre.textContent = '';
      resultPre.classList.remove('result-success', 'result-error');
      if (rowInputMode === 'json') {
        requestAnimationFrame(() => fitTextareaToContent(rowInputArgs));
      }
    });

    formWrap.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        submitBtn.click();
      }
    });
  });

  tools.forEach((item) => {
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

async function initGenAI() {
  let env;
  try {
    // Try load .env.json if present.
    env = (await envModulePromise).default;
  } catch {}
  if (env?.apiKey) localStorage.apiKey ??= env.apiKey;
  localStorage.model ??= env?.model || 'gemini-2.5-flash';
  genAI = localStorage.apiKey ? new GoogleGenAI({ apiKey: localStorage.apiKey }) : undefined;
  promptBtn.disabled = !localStorage.apiKey;
  resetBtn.disabled = !localStorage.apiKey;
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
    toolResults.textContent = formatAsJson(result);
    return;
  }
  // A navigation was triggered. The result will be on the next document.
  // TODO: Handle case where a new tab is opened.
  await waitForPageLoad(tab.id);
  toolResults.textContent = formatAsJson(await chrome.tabs.sendMessage(tab.id, {
    action: 'GET_CROSS_DOCUMENT_SCRIPT_TOOL_RESULT',
  }));
};

toolNames.onchange = updateDefaultValueForInputArgs;

function updateDefaultValueForInputArgs() {
  const inputSchema = toolNames.selectedOptions[0].dataset.inputSchema || '{}';
  const template = generateTemplateFromSchema(JSON.parse(inputSchema));
  inputArgsText.value = JSON.stringify(template, '', ' ');
}

// Utils

/** Try to pretty-print a value as indented JSON; fall back to the raw string. */
function formatAsJson(value) {
  if (value == null) return '';
  const str = String(value);
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

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


function openExecuteModal(formWrap, toolName) {
  executeModalContent.innerHTML = '';
  executeModalContent.appendChild(formWrap);
  executeModalTitle.textContent = toolName;
  executeModalOverlay.classList.add('visible');
  executeModalOverlay.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}
function closeExecuteModal() {
  executeModalOverlay.classList.remove('visible');
  executeModalOverlay.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}
executeModalClose?.addEventListener('click', closeExecuteModal);
executeModalOverlay?.addEventListener('click', (e) => {
  if (e.target === executeModalOverlay) closeExecuteModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && executeModalOverlay?.classList.contains('visible')) closeExecuteModal();
});
chrome.tabs.onActivated.addListener(() => closeExecuteModal());

/** Resize a textarea vertically to fit its content (min 2.5em; max-height from CSS). */
function fitTextareaToContent(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.max(40, ta.scrollHeight) + 'px';
}

/** Attach auto-grow behaviour to a textarea and do an initial resize once visible. */
function autoGrowTextarea(ta) {
  ta.addEventListener('input', () => fitTextareaToContent(ta));
  // Initial fit after the element is in the DOM and visible
  requestAnimationFrame(() => fitTextareaToContent(ta));
}

let inputMode = 'form';

modeSwitcher.addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-btn');
  if (!btn || btn.dataset.mode === inputMode) return;

  if (inputMode === 'form') {
    inputArgsText.value = JSON.stringify(collectFormData(formFields), '', ' ');
  }

  inputMode = btn.dataset.mode;
  modeSwitcher.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');

  if (inputMode === 'form') {
    inputArgsText.hidden = true;
    formFields.hidden = false;
    populateFormFromJson(inputArgsText.value, formFields);
  } else {
    inputArgsText.hidden = false;
    formFields.hidden = true;
  }
});

/** Parse inputSchema from string or object; empty/missing/invalid -> {}. */
function parseInputSchema(value) {
  if (value === undefined || value === null) return {};
  if (typeof value === 'object') return value;
  const s = String(value).trim();
  if (s === '') return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function getSelectedSchema() {
  if (!toolNames.selectedOptions[0]) return {};
  const raw = toolNames.selectedOptions[0].dataset.inputSchema;
  return normalizeInputSchema(parseInputSchema(raw));
}

/** Normalize API schema to JSON Schema shape with .properties (some APIs use .parameters). */
function normalizeInputSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  if (schema.properties && typeof schema.properties === 'object') {
    return { type: 'object', properties: schema.properties, required: schema.required };
  }
  if (schema.parameters && typeof schema.parameters === 'object' && !Array.isArray(schema.parameters)) {
    return { type: 'object', properties: schema.parameters, required: schema.required };
  }
  return { type: 'object', properties: {}, ...schema };
}

function buildFormFromSchema(schema, targetEl) {
  const container = targetEl;
  container.innerHTML = '';
  const normalized = normalizeInputSchema(schema);
  const propKeys = normalized.properties ? Object.keys(normalized.properties) : [];
  if (!normalized.properties || Object.keys(normalized.properties).length === 0) {
    const hint = document.createElement('div');
    hint.className = 'form-hint';
    hint.textContent = 'This tool has no input parameters.';
    container.appendChild(hint);
    return;
  }

  const required = normalized.required || [];

  for (const [name, prop] of Object.entries(normalized.properties)) {
    const group = document.createElement('div');
    group.className = 'schema-field';

    const label = document.createElement('label');
    label.textContent = name;
    if (required.includes(name)) {
      const star = document.createElement('span');
      star.className = 'required-star';
      star.textContent = ' *';
      label.appendChild(star);
    }
    group.appendChild(label);

    if (prop.description) {
      const desc = document.createElement('div');
      desc.className = 'field-description';
      desc.textContent = prop.description;
      group.appendChild(desc);
    }

    const input = createInputForProperty(name, prop);
    if (required.includes(name)) {
      const targetInput = input.matches?.('input, select, textarea')
        ? input
        : input.querySelector?.('input:not([type=checkbox]), select, textarea');
      if (targetInput && !targetInput.disabled) {
        targetInput.required = true;
      }
    }
    group.appendChild(input);
    container.appendChild(group);
  }
}

function createInputForProperty(name, prop) {
  // const: read-only field with fixed value
  if (prop.hasOwnProperty('const')) {
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.fieldName = name;
    input.dataset.fieldType = 'const';
    input.dataset.constValue = JSON.stringify(prop.const);
    input.value = typeof prop.const === 'string' ? prop.const : JSON.stringify(prop.const);
    input.disabled = true;
    input.classList.add('const-field');
    return input;
  }

  // oneOf: textarea fallback for variant schemas
  if (Array.isArray(prop.oneOf) && prop.oneOf.length > 0) {
    const wrapper = document.createElement('div');
    wrapper.className = 'oneof-field';
    wrapper.dataset.fieldName = name;
    wrapper.dataset.fieldType = 'oneOf';

    const select = document.createElement('select');
    select.className = 'oneof-select';
    prop.oneOf.forEach((variant, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = variant.title || variant.type || `Option ${i + 1}`;
      select.appendChild(opt);
    });
    wrapper.appendChild(select);

    const subContainer = document.createElement('div');
    subContainer.className = 'oneof-sub-input';
    wrapper.appendChild(subContainer);

    const renderVariant = (idx) => {
      subContainer.innerHTML = '';
      const variant = prop.oneOf[idx];
      const subInput = createInputForProperty(name, variant);
      // Override field name/type so collectFormData picks up from wrapper
      if (subInput.dataset) {
        delete subInput.dataset.fieldName;
      }
      subInput.querySelectorAll?.('[data-field-name]')?.forEach(el => delete el.dataset.fieldName);
      subContainer.appendChild(subInput);
    };
    select.addEventListener('change', () => renderVariant(parseInt(select.value)));
    renderVariant(0);

    return wrapper;
  }

  // null type: disabled field that always returns null
  if (prop.type === 'null') {
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.fieldName = name;
    input.dataset.fieldType = 'null';
    input.value = 'null';
    input.disabled = true;
    input.classList.add('null-field');
    return input;
  }

  if (prop.enum && prop.enum.length > 0) {
    const select = document.createElement('select');
    select.dataset.fieldName = name;
    select.dataset.fieldType = 'enum';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select\u2026';
    select.appendChild(placeholder);
    for (const val of prop.enum) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = val;
      select.appendChild(opt);
    }
    if (prop.hasOwnProperty('default')) select.value = prop.default;
    return select;
  }

  if (prop.type === 'boolean') {
    const wrapper = document.createElement('div');
    wrapper.className = 'checkbox-wrapper';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.fieldName = name;
    cb.dataset.fieldType = 'boolean';
    if (prop.hasOwnProperty('default')) cb.checked = !!prop.default;
    wrapper.appendChild(cb);
    const lbl = document.createElement('span');
    lbl.textContent = 'true';
    lbl.className = 'checkbox-label';
    wrapper.appendChild(lbl);
    return wrapper;
  }

  if (prop.type === 'number' || prop.type === 'integer') {
    const input = document.createElement('input');
    input.type = 'number';
    input.dataset.fieldName = name;
    input.dataset.fieldType = prop.type;
    if (prop.minimum !== undefined) input.min = prop.minimum;
    if (prop.maximum !== undefined) input.max = prop.maximum;
    if (prop.type === 'integer') input.step = '1';
    input.placeholder = getPlaceholder(prop, name);
    if (prop.hasOwnProperty('default')) input.value = prop.default;
    return input;
  }

  if (prop.type === 'array') {
    const itemSchema = prop.items || {};
    const itemType = itemSchema.type || 'string';
    // Objects with defined properties get dynamic sub-forms
    if (itemType === 'object' && itemSchema.properties && Object.keys(itemSchema.properties).length > 0) {
      return createArrayObjectField(name, itemSchema);
    }
    // Complex nested items without defined properties fall back to textarea
    if (itemType === 'object' || itemType === 'array') {
      const textarea = document.createElement('textarea');
      textarea.dataset.fieldName = name;
      textarea.dataset.fieldType = 'array';
      textarea.placeholder = getJsonPlaceholder(prop, '[]');
      textarea.rows = 1;
      if (prop.hasOwnProperty('default')) textarea.value = JSON.stringify(prop.default, null, 2);
      autoGrowTextarea(textarea);
      return textarea;
    }
    return createArrayField(name, itemSchema);
  }

  if (prop.type === 'object') {
    // If the object has defined properties, render them as nested sub-fields
    if (prop.properties && Object.keys(prop.properties).length > 0) {
      const wrapper = document.createElement('div');
      wrapper.className = 'object-field-group';
      wrapper.dataset.fieldName = name;
      wrapper.dataset.fieldType = 'object-group';

      const nestedRequired = prop.required || [];

      for (const [subName, subProp] of Object.entries(prop.properties)) {
        const group = document.createElement('div');
        group.className = 'schema-field';

        const label = document.createElement('label');
        label.textContent = subName;
        if (nestedRequired.includes(subName)) {
          const star = document.createElement('span');
          star.className = 'required-star';
          star.textContent = ' *';
          label.appendChild(star);
        }
        group.appendChild(label);

        if (subProp.description) {
          const desc = document.createElement('div');
          desc.className = 'field-description';
          desc.textContent = subProp.description;
          group.appendChild(desc);
        }

        const subInput = createInputForProperty(subName, subProp);
        if (nestedRequired.includes(subName)) {
          const targetInput = subInput.matches?.('input, select, textarea')
            ? subInput
            : subInput.querySelector?.('input:not([type=checkbox]), select, textarea');
          if (targetInput && !targetInput.disabled) {
            targetInput.required = true;
          }
        }
        group.appendChild(subInput);
        wrapper.appendChild(group);
      }
      return wrapper;
    }

    // Fallback: no properties defined, use raw JSON textarea
    const textarea = document.createElement('textarea');
    textarea.dataset.fieldName = name;
    textarea.dataset.fieldType = 'object';
    textarea.placeholder = getJsonPlaceholder(prop, '{}');
    textarea.rows = 1;
    if (prop.hasOwnProperty('default')) textarea.value = JSON.stringify(prop.default, null, 2);
    autoGrowTextarea(textarea);
    return textarea;
  }

  const input = document.createElement('input');
  input.type = getHtmlInputType(prop);
  input.dataset.fieldName = name;
  input.dataset.fieldType = 'string';
  input.placeholder = getPlaceholder(prop, name);
  if (prop.hasOwnProperty('default')) input.value = prop.default;
  return input;
}

function getPlaceholder(prop, name) {
  if (Array.isArray(prop.examples) && prop.examples.length > 0) {
    const ex = prop.examples[0];
    return `e.g. ${typeof ex === 'string' ? ex : JSON.stringify(ex)}`;
  }
  return prop.description || name;
}

/** Get placeholder text for JSON textareas (object/array), using examples or description. */
function getJsonPlaceholder(prop, fallback) {
  if (Array.isArray(prop.examples) && prop.examples.length > 0) {
    return `e.g. ${JSON.stringify(prop.examples[0], null, 2)}`;
  }
  if (prop.description) return prop.description;
  return fallback;
}

function getHtmlInputType(prop) {
  const fmt = prop.format;
  if (!fmt) return 'text';
  if (fmt === 'date') return 'date';
  if (fmt === 'email') return 'email';
  if (fmt === 'tel') return 'tel';
  if (fmt === '^#[0-9a-zA-Z]{6}$') return 'color';
  // datetime-local variants (yyyy-MM-ddThh:mm, yyyy-MM-ddThh:mm:ss, yyyy-MM-ddThh:mm:ss.SSS)
  if (fmt.startsWith('^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T')) return 'datetime-local';
  // month (yyyy-MM)
  if (fmt === '^[0-9]{4}-(0[1-9]|1[0-2])$') return 'month';
  // week (yyyy-Www)
  if (fmt === '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$') return 'week';
  // time variants (HH:mm, HH:mm:ss, HH:mm:ss.SSS)
  if (fmt.startsWith('^([01][0-9]|2[0-3]):[0-5][0-9]')) return 'time';
  return 'text';
}

function createArrayField(name, itemSchema) {
  const wrapper = document.createElement('div');
  wrapper.className = 'array-field';
  wrapper.dataset.fieldName = name;
  wrapper.dataset.fieldType = 'array';
  wrapper.dataset.itemType = itemSchema.type || 'string';
  if (itemSchema.enum) wrapper.dataset.itemEnum = JSON.stringify(itemSchema.enum);
  if (itemSchema.minimum !== undefined) wrapper.dataset.itemMin = itemSchema.minimum;
  if (itemSchema.maximum !== undefined) wrapper.dataset.itemMax = itemSchema.maximum;
  if (itemSchema.type === 'integer') wrapper.dataset.itemStep = '1';

  const itemsContainer = document.createElement('div');
  itemsContainer.className = 'array-items';
  wrapper.appendChild(itemsContainer);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'array-add-btn';
  addBtn.textContent = '+';
  addBtn.title = 'Add item';
  addBtn.addEventListener('click', () => {
    itemsContainer.appendChild(createArrayItemRow(wrapper));
  });
  wrapper.appendChild(addBtn);

  return wrapper;
}

function createArrayItemRow(arrayField, value) {
  const itemType = arrayField.dataset.itemType || 'string';
  const row = document.createElement('div');
  row.className = 'array-item';

  let input;
  const enumStr = arrayField.dataset.itemEnum;

  if (enumStr) {
    const enumValues = JSON.parse(enumStr);
    input = document.createElement('select');
    input.className = 'array-item-input';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select\u2026';
    input.appendChild(placeholder);
    for (const val of enumValues) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = val;
      input.appendChild(opt);
    }
    if (value !== undefined) input.value = value;
  } else if (itemType === 'boolean') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'array-item-input';
    if (value !== undefined) input.checked = !!value;
  } else if (itemType === 'number' || itemType === 'integer') {
    input = document.createElement('input');
    input.type = 'number';
    input.className = 'array-item-input';
    if (arrayField.dataset.itemMin !== undefined) input.min = arrayField.dataset.itemMin;
    if (arrayField.dataset.itemMax !== undefined) input.max = arrayField.dataset.itemMax;
    if (arrayField.dataset.itemStep) input.step = arrayField.dataset.itemStep;
    input.placeholder = 'Enter number\u2026';
    if (value !== undefined) input.value = value;
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.className = 'array-item-input';
    input.placeholder = 'Enter value\u2026';
    if (value !== undefined) input.value = value;
  }

  row.appendChild(input);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'array-remove-btn';
  removeBtn.textContent = '\u2212';
  removeBtn.title = 'Remove item';
  removeBtn.addEventListener('click', () => row.remove());
  row.appendChild(removeBtn);

  return row;
}

/** Create a dynamic array field for objects with defined properties (e.g. waypoints). */
function createArrayObjectField(name, itemSchema) {
  const wrapper = document.createElement('div');
  wrapper.className = 'array-field array-object-field';
  wrapper.dataset.fieldName = name;
  wrapper.dataset.fieldType = 'array-object';
  wrapper.dataset.itemSchema = JSON.stringify(itemSchema);

  const itemsContainer = document.createElement('div');
  itemsContainer.className = 'array-items';
  wrapper.appendChild(itemsContainer);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'array-add-btn';
  addBtn.textContent = '+';
  addBtn.title = 'Add item';
  addBtn.addEventListener('click', () => {
    itemsContainer.appendChild(createArrayObjectItemRow(itemSchema));
  });
  wrapper.appendChild(addBtn);

  return wrapper;
}

/** Create a single row for an array-of-objects item, reusing createInputForProperty recursively. */
function createArrayObjectItemRow(itemSchema, values) {
  const row = document.createElement('div');
  row.className = 'array-item array-object-item';

  const fieldsWrap = document.createElement('div');
  fieldsWrap.className = 'array-object-item-fields';
  fieldsWrap.dataset.fieldType = 'object-group';

  const nestedRequired = itemSchema.required || [];

  for (const [propName, propDef] of Object.entries(itemSchema.properties)) {
    const group = document.createElement('div');
    group.className = 'schema-field array-object-sub-field';

    const label = document.createElement('label');
    label.textContent = propName;
    if (nestedRequired.includes(propName)) {
      const star = document.createElement('span');
      star.className = 'required-star';
      star.textContent = ' *';
      label.appendChild(star);
    }
    group.appendChild(label);

    if (propDef.description) {
      const desc = document.createElement('div');
      desc.className = 'field-description';
      desc.textContent = propDef.description;
      group.appendChild(desc);
    }

    // Reuse the full createInputForProperty for recursive support
    const subInput = createInputForProperty(propName, propDef);
    group.appendChild(subInput);
    fieldsWrap.appendChild(group);
  }

  row.appendChild(fieldsWrap);

  // Populate values after building the DOM so nested structures are present
  if (values && typeof values === 'object') {
    populateObjectGroupFromValues(fieldsWrap, values);
  }

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'array-remove-btn';
  removeBtn.textContent = '\u2212';
  removeBtn.title = 'Remove item';
  removeBtn.addEventListener('click', () => row.remove());
  row.appendChild(removeBtn);

  return row;
}

/** Populate an object-group container with values (used by array-object rows). */
function populateObjectGroupFromValues(container, values) {
  container.querySelectorAll('[data-field-name]').forEach((el) => {
    // Only direct children of this group
    if (el.closest('[data-field-type="object-group"]') !== container) return;
    const name = el.dataset.fieldName;
    if (!(name in values)) return;
    const val = values[name];
    populateSingleField(el, val);
  });
}

/** Populate a single field element with a value (mirrors collectSingleField in reverse). */
function populateSingleField(el, val) {
  const type = el.dataset.fieldType;
  if (type === 'const' || type === 'null') return;
  if (type === 'oneOf') {
    const subInput = el.querySelector('.oneof-sub-input input, .oneof-sub-input select, .oneof-sub-input textarea');
    if (subInput) {
      subInput.value = (typeof val === 'object' && val !== null) ? JSON.stringify(val, '', ' ') : (val ?? '');
    }
  } else if (type === 'boolean') {
    el.checked = !!val;
  } else if (type === 'array-object' && el.classList.contains('array-object-field')) {
    const itemsContainer = el.querySelector('.array-items');
    itemsContainer.innerHTML = '';
    if (Array.isArray(val)) {
      const itemSchema = JSON.parse(el.dataset.itemSchema || '{}');
      for (const itemVal of val) {
        itemsContainer.appendChild(createArrayObjectItemRow(itemSchema, itemVal));
      }
    }
  } else if (type === 'array' && el.classList.contains('array-field')) {
    const itemsContainer = el.querySelector('.array-items');
    itemsContainer.innerHTML = '';
    if (Array.isArray(val)) {
      for (const itemVal of val) {
        itemsContainer.appendChild(createArrayItemRow(el, itemVal));
      }
    }
  } else if (type === 'object-group') {
    if (typeof val === 'object' && val !== null) {
      populateObjectGroupFromValues(el, val);
    }
  } else if (type === 'object' || type === 'array') {
    el.value = typeof val === 'object' ? JSON.stringify(val, '', ' ') : val;
    if (el.tagName === 'TEXTAREA') requestAnimationFrame(() => fitTextareaToContent(el));
  } else {
    el.value = (typeof val === 'object' && val !== null) ? JSON.stringify(val, '', ' ') : (val ?? '');
  }
}

function collectFormData(container) {
  const root = container;
  const data = {};
  // Only select direct (non-nested) field-name elements — skip children of object-group wrappers
  root.querySelectorAll('[data-field-name]').forEach((el) => {
    // Skip if this element is nested inside another object-group (it will be collected by its parent)
    if (el.parentElement && el.parentElement.closest('[data-field-type="object-group"]') &&
        el.closest('[data-field-type="object-group"]') !== el) {
      return;
    }

    const name = el.dataset.fieldName;
    const type = el.dataset.fieldType;

    // object-group: recursively collect sub-fields into a nested object
    if (type === 'object-group') {
      const nested = {};
      el.querySelectorAll('[data-field-name]').forEach((subEl) => {
        // Only direct children of this group (not deeper nested groups)
        if (subEl.closest('[data-field-type="object-group"]') !== el) return;
        const subData = collectSingleField(subEl);
        if (subData !== undefined) nested[subEl.dataset.fieldName] = subData;
      });
      if (Object.keys(nested).length > 0) data[name] = nested;
      return;
    }

    const val = collectSingleField(el);
    if (val !== undefined) data[name] = val;
  });
  return data;
}

function collectSingleField(el) {
  const type = el.dataset.fieldType;

  if (type === 'const') {
    return JSON.parse(el.dataset.constValue);
  }
  if (type === 'null') {
    return null;
  }
  if (type === 'oneOf') {
    const subInput = el.querySelector('.oneof-sub-input');
    if (subInput) {
      const inner = subInput.querySelector('input, select, textarea, [data-field-type]');
      if (inner) {
        const innerType = inner.dataset?.fieldType;
        if (innerType === 'boolean') return inner.checked;
        if (innerType === 'number' || innerType === 'integer') {
          if (inner.value !== '') return innerType === 'integer' ? parseInt(inner.value) : parseFloat(inner.value);
          return undefined;
        }
        if (innerType === 'object' || innerType === 'array') {
          if (inner.value.trim()) {
            try { return JSON.parse(inner.value); } catch { return inner.value; }
          }
          return undefined;
        }
        if (innerType === 'null') return null;
        if (inner.value !== '') return inner.value;
      }
    }
    return undefined;
  }
  if (type === 'boolean') {
    return el.checked;
  }
  if (type === 'number' || type === 'integer') {
    if (el.value !== '') return type === 'integer' ? parseInt(el.value) : parseFloat(el.value);
    return undefined;
  }
  if (type === 'array-object' && el.classList.contains('array-object-field')) {
    const items = [];
    el.querySelectorAll(':scope > .array-items > .array-object-item').forEach((itemRow) => {
      const fieldsWrap = itemRow.querySelector('.array-object-item-fields');
      if (!fieldsWrap) return;
      // Collect as an object-group (recursive)
      const obj = {};
      fieldsWrap.querySelectorAll('[data-field-name]').forEach((subEl) => {
        if (subEl.closest('[data-field-type="object-group"]') !== fieldsWrap) return;
        const subData = collectSingleField(subEl);
        if (subData !== undefined) obj[subEl.dataset.fieldName] = subData;
      });
      if (Object.keys(obj).length > 0) items.push(obj);
    });
    return items;
  }
  if (type === 'array' && el.classList.contains('array-field')) {
    const itemType = el.dataset.itemType || 'string';
    const items = [];
    el.querySelectorAll('.array-item-input').forEach((itemEl) => {
      if (itemType === 'boolean') {
        items.push(itemEl.checked);
      } else if (itemType === 'number' || itemType === 'integer') {
        if (itemEl.value !== '') items.push(itemType === 'integer' ? parseInt(itemEl.value) : parseFloat(itemEl.value));
      } else {
        if (itemEl.value !== '') items.push(itemEl.value);
      }
    });
    return items;
  }
  if (type === 'object' || type === 'array') {
    if (el.value.trim()) {
      try { return JSON.parse(el.value); } catch { return el.value; }
    }
    return undefined;
  }
  if (type === 'object-group') {
    // Recursively collect nested object
    const nested = {};
    el.querySelectorAll('[data-field-name]').forEach((subEl) => {
      if (subEl.closest('[data-field-type="object-group"]') !== el) return;
      const subData = collectSingleField(subEl);
      if (subData !== undefined) nested[subEl.dataset.fieldName] = subData;
    });
    return Object.keys(nested).length > 0 ? nested : undefined;
  }
  if (el.value !== '') return el.value;
  return undefined;
}

/** Validate all required inputs inside a form-fields container. Returns true if valid. */
function validateFormFields(container) {
  const inputs = container.querySelectorAll('input, select, textarea');
  for (const el of inputs) {
    if (!el.reportValidity()) return false;
  }
  return true;
}

function populateFormFromJson(jsonValueOrElement, formContainer) {
  const jsonStr =
    typeof jsonValueOrElement === 'string'
      ? jsonValueOrElement
      : (jsonValueOrElement?.value ?? '{}');
  const root = formContainer;
  try {
    const values = JSON.parse(jsonStr || '{}');
    root.querySelectorAll('[data-field-name]').forEach((el) => {
      const name = el.dataset.fieldName;
      if (!(name in values)) return;
      populateSingleField(el, values[name]);
    });
  } catch {}
}
