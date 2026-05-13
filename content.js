/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

console.debug(`[WebMCP] Content script injected in ${location.href}`);

chrome.runtime.onMessage.addListener(({ action, name, inputArgs, location }, _, reply) => {
  try {
    if (!navigator.modelContextTesting) {
      throw new Error('Error: You must run Chrome with the "WebMCP for testing" flag enabled.');
    }
    if (action == 'LIST_TOOLS') {
      listTools();
      if ('ontoolchange' in navigator.modelContext) {
        navigator.modelContext.addEventListener('toolchange', listTools);
        return;
      }
      if ('ontoolchange' in navigator.modelContextTesting) {
        navigator.modelContextTesting.addEventListener('toolchange', listTools);
        return;
      }
      navigator.modelContextTesting.registerToolsChangedCallback(listTools);
    }
    if (action == 'EXECUTE_TOOL') {
      if (location && location !== window.location.href) return;
      console.debug(`[WebMCP] Execute tool "${name}" with ${inputArgs} in ${location}`);
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
      let promise;
      if ('executeTool' in navigator.modelContext) {
        promise = navigator.modelContext.getTools().then((tools) => {
          const tool = tools.find((t) => t.name === name && t.window.location.href === location);
          return navigator.modelContext.executeTool(tool, inputArgs);
        });
      } else {
        promise = navigator.modelContextTesting.executeTool(name, inputArgs);
      }
      promise
        .then(async (result) => {
          // If result is null and we have a target frame, wait for the frame to reload.
          if (result === null && targetFrame) {
            console.debug(`[WebMCP] Waiting for form target ${targetFrame} to load`);
            await loadPromise;
            console.debug('[WebMCP] Get cross document script tool result');
            result = targetFrame.contentWindow.document.querySelector(
              'script[type="application/ld+json"]',
            )?.textContent;
          }
          reply(result);
        })
        .catch(({ message }) => reply(JSON.stringify(message)));
      return true;
    }
    if (action == 'GET_CROSS_DOCUMENT_SCRIPT_TOOL_RESULT') {
      if (location && !window.location.href.startsWith(location)) return;
      console.debug(`[WebMCP] Get cross document script tool result in ${location}`);
      reply(document.querySelector('script[type="application/ld+json"]')?.textContent);
    }
  } catch ({ message }) {
    chrome.runtime.sendMessage({ message });
  }
});

async function listTools() {
  let tools;
  if ('getTools' in navigator.modelContext) {
    tools = await navigator.modelContext.getTools();
    tools = tools.map((tool) => {
      return {
        description: tool.description,
        inputSchema: tool.inputSchema,
        readOnlyHint: tool.annotations?.readOnlyHint ? '✓' : undefined,
        untrustedContentHint: tool.annotations?.untrustedContentHint ? '✓' : undefined,
        name: tool.name,
        location: tool.window.location.href,
      };
    });
  } else {
    tools = navigator.modelContextTesting.listTools();
  }
  console.debug(`[WebMCP] Got ${tools.length} tools`, tools);
  chrome.runtime.sendMessage({ tools, url: location.href });
}

window.addEventListener('toolactivated', ({ toolName }) => {
  console.debug(`[WebMCP] Tool "${toolName}" started execution.`);
});

window.addEventListener('toolcancel', ({ toolName }) => {
  console.debug(`[WebMCP] Tool "${toolName}" execution is cancelled.`);
});
