/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

console.debug('[WebMCP] Content script injected');

const BRIDGE_KEY = '__webMcpPolyfillTestingBridge';

chrome.runtime.onMessage.addListener(async ({ action, name, inputArgs, settings }) => {
  try {
    if (action === 'SET_OPTIONS') {
      window[BRIDGE_KEY]?.setEnabled?.(settings?.injectWebMcpPolyfill === true);
      return;
    }

    await getModelContextTesting();
    if (action == 'LIST_TOOLS') {
      listTools();
      if ('ontoolchange' in navigator.modelContextTesting.__proto__) {
        navigator.modelContextTesting.addEventListener('toolchange', listTools);
        return;
      }
      navigator.modelContextTesting.registerToolsChangedCallback(listTools);
    }
    if (action == 'EXECUTE_TOOL') {
      console.debug(`[WebMCP] Execute tool "${name}" with`, inputArgs);
      let targetFrame, loadPromise;
      // Check if this tool is associated with a form target
      const formTarget = document.querySelector(`form[toolname="${name}"]`)?.target;
      if (formTarget) {
        targetFrame = document.querySelector(`[name=${formTarget}]`);
        loadPromise = new Promise((resolve) => {
          targetFrame.addEventListener('load', resolve, { once: true });
        });
      }
      // Execute the experimental tool
      let result = await navigator.modelContextTesting.executeTool(name, inputArgs);
      // If result is null and we have a target frame, wait for the frame to reload.
      if (result === null && targetFrame) {
        console.debug(`[WebMCP] Waiting for form target ${targetFrame} to load`);
        await loadPromise;
        console.debug('[WebMCP] Get cross document script tool result');
        result =
          await targetFrame.contentWindow.navigator.modelContextTesting.getCrossDocumentScriptToolResult();
      }
      return result;
    }
    if (action == 'GET_CROSS_DOCUMENT_SCRIPT_TOOL_RESULT') {
      console.debug('[WebMCP] Get cross document script tool result');
      return navigator.modelContextTesting
        .getCrossDocumentScriptToolResult()
        .catch(({ message }) => JSON.stringify(message));
    }
  } catch ({ message }) {
    chrome.runtime.sendMessage({ message });
    if (action == 'EXECUTE_TOOL' || action == 'GET_CROSS_DOCUMENT_SCRIPT_TOOL_RESULT') {
      return JSON.stringify(message);
    }
  }
});

async function getModelContextTesting() {
  if (navigator.modelContextTesting) {
    return navigator.modelContextTesting;
  }
  if (window[BRIDGE_KEY]?.ensureTesting) {
    return await window[BRIDGE_KEY].ensureTesting();
  }
  throw new Error('Enable native WebMCP testing or turn on the WebMCP polyfill option.');
}

function listTools() {
  const tools = navigator.modelContextTesting.listTools();
  console.debug(`[WebMCP] Got ${tools.length} tools`, tools);
  chrome.runtime.sendMessage({ tools, url: location.href, hasNativeTestingApi: window[BRIDGE_KEY]?.hasNativeTestingApi?.() });
}

window.addEventListener('toolactivated', ({ toolName }) => {
  console.debug(`[WebMCP] Tool "${toolName}" started execution.`);
});

window.addEventListener('toolcancel', ({ toolName }) => {
  console.debug(`[WebMCP] Tool "${toolName}" execution is cancelled.`);
});
