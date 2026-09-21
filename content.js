/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

console.debug(`[WebMCP] Content script injected in ${window.location.href}`);

chrome.runtime.onMessage.addListener((message, _, reply) => {
  const { action, name, inputArgs, fromOrigins } = message;
  try {
    if (!document.modelContext) {
      throw new Error('Error: You must run Chrome with the "WebMCP for testing" flag enabled.');
    }
    if (action == 'LIST_TOOLS') {
      debouncedListTools(fromOrigins);
      document.modelContext.ontoolchange = debouncedListTools.bind(null, fromOrigins);
    }
    if (action == 'EXECUTE_TOOL') {
      console.debug(`[WebMCP] Execute tool "${name}" with ${inputArgs} in ${window.location.href}`);
      let targetFrame, loadPromise;
      // Check if this tool is associated with a form target
      const formTarget = document.querySelector(`form[toolname="${name}"]`)?.target;
      if (formTarget) {
        // May be null, e.g. for target="_blank"; the result then lives in a
        // new tab and the sidebar retrieves it from there.
        targetFrame = document.querySelector(`[name=${formTarget}]`);
      }
      if (targetFrame) {
        loadPromise = new Promise((resolve) => {
          targetFrame.addEventListener('load', resolve, { once: true });
        });
      }
      // Execute the experimental tool
      document.modelContext
        .getTools()
        .then(async (tools) => {
          const tool = tools.find((t) => t.name === name && t.window === window);
          let result;
          try {
            result = await document.modelContext.executeTool(tool, JSON.parse(inputArgs));
          } catch (e) {
            // TODO: Remove this when executeTool doesn't accept JSON stringified inputArgs anymore in Chrome Stable.
            if (e.message.startsWith('Failed to parse input')) {
              result = await document.modelContext.executeTool(tool, inputArgs);
            } else {
              throw e;
            }
          }
          return result;
        })
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
      console.debug(`[WebMCP] Get cross document script tool result in ${window.location.href}`);
      reply(document.querySelector('script[type="application/ld+json"]')?.textContent);
    }
  } catch ({ message }) {
    chrome.runtime.sendMessage({ message });
  }
});

let timeout;
function debouncedListTools(fromOrigins) {
  clearTimeout(timeout);
  timeout = setTimeout(() => listTools(fromOrigins), 100);
}

async function listTools(fromOrigins) {
  let tools = [];
  for (const tool of await document.modelContext.getTools({ fromOrigins })) {
    const frameId = tool.window == window ? 0 : await getFrameId(tool.window);
    const inputSchema =
      typeof tool.inputSchema === 'string' ? tool.inputSchema : JSON.stringify(tool.inputSchema);
    tools.push({
      description: tool.description,
      inputSchema,
      annotations: Object.keys(tool.annotations || {})
        .filter((k) => tool.annotations[k])
        .join(', '),
      name: tool.name,
      frameId,
    });
  }
  console.debug(`[WebMCP] Got ${tools.length} tools`, tools);
  chrome.runtime.sendMessage({ tools, url: window.location.href });
}

async function getFrameId(targetWindow) {
  await chrome.runtime.sendMessage({ action: 'INJECT_GET_FRAME_ID' });
  const promise = new Promise((resolve) => {
    let timeoutId;
    const listener = ({ source, data }) => {
      if (source == targetWindow && data.action === 'GET_FRAME_ID_RESPONSE') {
        window.removeEventListener('message', listener);
        clearTimeout(timeoutId);
        resolve(data.frameId);
      }
    };
    window.addEventListener('message', listener);
    timeoutId = setTimeout(() => {
      window.removeEventListener('message', listener);
      resolve(null);
    }, 2000);
  });
  targetWindow.postMessage({ action: 'GET_FRAME_ID' }, '*');
  return promise;
}

window.addEventListener('toolactivated', ({ toolName }) => {
  console.debug(`[WebMCP] Tool "${toolName}" started execution.`);
});

window.addEventListener('toolcancel', ({ toolName }) => {
  console.debug(`[WebMCP] Tool "${toolName}" execution is cancelled.`);
});

if (window === window.top) {
  chrome.runtime.sendMessage({ type: 'contentScriptReady' }).catch(() => {});
}
