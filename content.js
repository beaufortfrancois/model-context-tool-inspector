/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

console.debug('[WebMCP] Content script injected');

chrome.runtime.onMessage.addListener(({ action, name, inputArgs }, _, reply) => {
  try {
    if (action == 'LIST_SKILLS') {
      discoverSkills();
      return;
    }
    if (!navigator.modelContextTesting) {
      throw new Error('Error: You must run Chrome with the "WebMCP for testing" flag enabled.');
    }
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
      const promise = navigator.modelContextTesting.executeTool(name, inputArgs);
      promise
        .then(async (result) => {
          // If result is null and we have a target frame, wait for the frame to reload.
          if (result === null && targetFrame) {
            console.debug(`[WebMCP] Waiting for form target ${targetFrame} to load`);
            await loadPromise;
            console.debug('[WebMCP] Get cross document script tool result');
            result =
              await targetFrame.contentWindow.navigator.modelContextTesting.getCrossDocumentScriptToolResult();
          }
          reply(result);
        })
        .catch(({ message }) => reply(JSON.stringify(message)));
      return true;
    }
    if (action == 'GET_CROSS_DOCUMENT_SCRIPT_TOOL_RESULT') {
      console.debug('[WebMCP] Get cross document script tool result');
      const promise = navigator.modelContextTesting.getCrossDocumentScriptToolResult();
      promise.then(reply).catch(({ message }) => reply(JSON.stringify(message)));
      return true;
    }
  } catch ({ message }) {
    chrome.runtime.sendMessage({ message });
  }
});

function listTools() {
  const tools = navigator.modelContextTesting.listTools();
  console.debug(`[WebMCP] Got ${tools.length} tools`, tools);
  chrome.runtime.sendMessage({ tools, url: location.href });
}

window.addEventListener('toolactivated', ({ toolName }) => {
  console.debug(`[WebMCP] Tool "${toolName}" started execution.`);
});

window.addEventListener('toolcancel', ({ toolName }) => {
  console.debug(`[WebMCP] Tool "${toolName}" execution is cancelled.`);
});


function discoverSkills() {
  const skillEls = document.querySelectorAll('script[type="agent-context"]');
  const skills = Array.from(skillEls).map((el) => el.textContent || '');

  const refEls = document.querySelectorAll('script[type="agent-context/reference"]');
  const references = Array.from(refEls).map((el) => ({
    skill: el.dataset.skill,
    name: el.dataset.name,
    content: el.textContent || '',
  }));

  console.debug(`[WebMCP] Got ${skills.length} skills, ${references.length} references`);
  chrome.runtime.sendMessage({ skills, references, url: location.href });
}

new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
      if (
        node.nodeName === 'SCRIPT' &&
        (node.type === 'agent-context' || node.type === 'agent-context/reference')
      ) {
        discoverSkills();
        return;
      }
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });
