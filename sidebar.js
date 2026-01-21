import { GoogleGenAI } from './node_modules/@google/genai/dist/web/index.mjs';
import env from './.env.json' with { type: 'json' };

const statusDiv = document.getElementById('status');
const tbody = document.getElementById('tableBody');
const thead = document.getElementById('tableHeaderRow');
const copyToClipboard = document.getElementById('copyToClipboard');
const toolNames = document.getElementById('toolNames');
const inputArgsText = document.getElementById('inputArgsText');
const executeBtn = document.getElementById('executeBtn');
const toolResults = document.getElementById('toolResults');
const userPromptText = document.getElementById('userPromptText');
const promptBtn = document.getElementById('promptBtn');
const resetBtn = document.getElementById('resetBtn');
const apiKeyBtn = document.getElementById('apiKeyBtn');
const promptResults = document.getElementById('promptResults');

// Inject content script first.
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { action: 'LIST_TOOLS' });
  } catch (error) {
    const statusDiv = document.getElementById('status');
    statusDiv.textContent = error;
    statusDiv.hidden = false;
  }
})();

let currentTools;

let userPromptPendingId = 0;

// Listen for the results coming back from content.js
chrome.runtime.onMessage.addListener(({ message, tools, url }) => {
  tbody.innerHTML = '';
  thead.innerHTML = '';
  toolNames.innerHTML = '';

  statusDiv.textContent = message;
  statusDiv.hidden = !message;

  const haveNewTools = JSON.stringify(currentTools) !== JSON.stringify(tools);

  currentTools = tools;

  if (!tools || tools.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="100%"><i>No tools registered yet in ${url}</i></td>`;
    tbody.appendChild(row);
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

copyToClipboard.onclick = async () => {
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

// Interact with the page

let genAI, chat;

function initGenAI() {
  localStorage.apiKey ??= env.apiKey;
  localStorage.model ??= env.model || 'gemini-2.5-flash';
  genAI = localStorage.apiKey ? new GoogleGenAI({ apiKey: localStorage.apiKey }) : undefined;
  promptBtn.disabled = !localStorage.apiKey;
  resetBtn.disabled = !localStorage.apiKey;
}
initGenAI();

async function suggestUserPrompt() {
  if (!genAI || userPromptText.value) return;
  const userPromptId = ++userPromptPendingId;
  const response = await genAI.models.generateContent({
    model: localStorage.model,
    contents: [
      'Reply with one simple prompt that would trigger one of these tools.',
      JSON.stringify(currentTools),
    ],
  });
  if (userPromptId !== userPromptPendingId || userPromptText.value) return;
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
    promptBtn.disabled = true;
    await promptAI();
  } catch (error) {
    logPrompt(`⚠️ Error: "${error}"`);
  } finally {
    promptBtn.disabled = false;
  }
};

async function promptAI() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chat ??= genAI.chats.create({ model: localStorage.model });

  const message = userPromptText.value;
  userPromptText.value = '';
  promptResults.textContent += `User prompt: "${message}"\n`;
  let currentResult = await chat.sendMessage({
    message,
    config: getConfig(),
  });
  let finalResponseGiven = false;

  while (!finalResponseGiven) {
    const response = currentResult;
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

      currentResult = await chat.sendMessage({
        message: toolResponses,
        config: getConfig(),
      });
    }
  }
}

resetBtn.onclick = () => {
  chat = undefined;
  userPromptText.value = '';
  promptResults.textContent = '';
};

apiKeyBtn.onclick = () => {
  const apiKey = prompt('Enter Gemini API key');
  if (apiKey == null) return;
  localStorage.apiKey = apiKey;
  initGenAI();
};

executeBtn.onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const name = toolNames.selectedOptions[0].value;
  const inputArgs = inputArgsText.value;
  const result = await chrome.tabs.sendMessage(tab.id, { action: 'EXECUTE_TOOL', name, inputArgs });
  toolResults.textContent = `${result}\n`;
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

function getConfig() {
  const today = new Date();
  const formattedDate = today.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const systemInstruction = [
    'You are an assistant embedded in a browser tab.',
    'User prompts typically refer to the current tab unless stated otherwise.',
    'Use your tools to query page content when you need it.',
    `Today's date is: ${formattedDate}`,
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

  if (schema.hasOwnProperty('default')) {
    return schema.default;
  }

  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    return schema.examples[0];
  }

  switch (schema.type) {
    case 'object':
      const obj = {};
      // Traverse 'properties' if they exist
      if (schema.properties) {
        Object.keys(schema.properties).forEach((key) => {
          obj[key] = generateTemplateFromSchema(schema.properties[key]);
        });
      }
      return obj;

    case 'array':
      // For arrays, we generate a single item based on the 'items' schema
      // to show what the array structure looks like.
      if (schema.items) {
        return [generateTemplateFromSchema(schema.items)];
      }
      return [];

    case 'string':
      if (schema.enum && schema.enum.length > 0) {
        return schema.enum[0]; // Return first enum option
      }
      if (schema.format === 'date-time' || schema.format === 'date') {
        return new Date().toISOString();
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
      // Fallback for "any" types or undefined types
      return {};
  }
}
