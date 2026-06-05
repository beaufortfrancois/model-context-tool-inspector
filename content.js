/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

console.debug(`[WebMCP] Content script injected in ${window.location.href}`);

const modelContext = document.modelContext || navigator.modelContext;

chrome.runtime.onMessage.addListener((message, _, reply) => {
  const { action, name, inputArgs, location, fromOrigins } = message;
  try {
    if (!navigator.modelContextTesting && !modelContext) {
      throw new Error('Error: You must run Chrome with the "WebMCP for testing" flag enabled.');
    }
    if (action == 'LIST_TOOLS') {
      listTools(fromOrigins);
      if ('ontoolchange' in modelContext) {
        modelContext.addEventListener('toolchange', listTools.bind(null, fromOrigins));
        return;
      }
      navigator.modelContextTesting.addEventListener('toolchange', listTools);
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
      if ('executeTool' in modelContext) {
        promise = modelContext.getTools().then((tools) => {
          const tool = tools.find((t) => t.name === name && t.window === window);
          return modelContext.executeTool(tool, inputArgs);
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

async function listTools(fromOrigins) {
  let tools = [];
  if ('getTools' in modelContext) {
    for (const tool of await modelContext.getTools({ fromOrigins })) {
      let location;
      try {
        location = tool.window.location.href;
      } catch {
        location = await getLocation(tool.window);
      }
      tools.push({
        description: tool.description,
        inputSchema: tool.inputSchema,
        readOnlyHint: tool.annotations?.readOnlyHint ? '✓' : undefined,
        untrustedContentHint: tool.annotations?.untrustedContentHint ? '✓' : undefined,
        name: tool.name,
        location,
      });
    }
  } else {
    tools = navigator.modelContextTesting.listTools();
  }
  console.debug(`[WebMCP] Got ${tools.length} tools`, tools);
  chrome.runtime.sendMessage({ tools, url: window.location.href });
}

function getLocation(crossOriginIframeWindow) {
  const promise = new Promise((resolve) => {
    const listener = ({ data }) => {
      if (data.action === 'GET_LOCATION_RESPONSE') {
        window.removeEventListener('message', listener);
        resolve(data.location);
      }
    };
    window.addEventListener('message', listener);
  });
  crossOriginIframeWindow.postMessage({ action: 'GET_LOCATION' }, '*');
  return promise;
}

window.addEventListener('message', ({ data, origin, source }) => {
  if (data.action === 'GET_LOCATION') {
    const location = window.location.href;
    source.postMessage({ action: 'GET_LOCATION_RESPONSE', location }, origin);
  }
});

window.addEventListener('toolactivated', ({ toolName }) => {
  console.debug(`[WebMCP] Tool "${toolName}" started execution.`);
});

window.addEventListener('toolcancel', ({ toolName }) => {
  console.debug(`[WebMCP] Tool "${toolName}" execution is cancelled.`);
});
