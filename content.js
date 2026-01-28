console.debug('[WebMCP] Content script injected');

chrome.runtime.onMessage.addListener(({ action, name, inputArgs }, _, reply) => {
  try {
    if (!navigator.modelContextTesting) {
      throw new Error(
        'Error: You must run Chrome with the "Experimental Web Platform features" flag enabled.',
      );
    }
    if (action == 'LIST_TOOLS') {
      listTools();
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
