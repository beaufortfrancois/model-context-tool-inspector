/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

console.debug(`[WebMCP] Content script injected in ${window.location.href}`);

// Resolve the WebMCP API per call rather than capturing it once here: the
// flag-gated object can appear after this content script is injected at
// document_start, so a value captured at load may be stale/undefined.
const getModelContext = () => document.modelContext || navigator.modelContext;

// ─── EXPERIMENTAL / WIP — specialized to webmcp-public-sites ─────────────────
// `webmcp:ready` is NOT part of the WebMCP standard. It is a project-specific
// convention emitted by our own page partials (webmcp-public-sites,
// sites/*/src/webmcp-shared.js) from a `finally` clause after each route's tools
// finish (re)registering. It means: "tool injection for this page kind has
// settled — the full tool set is now enumerable."
//
// We consume it to get ONE authoritative refresh per transition, instead of
// reacting only to the standard per-tool `toolchange` event (which fires
// mid-batch and can momentarily expose a partial set). On the event we simply
// re-enumerate via listTools('ready'); we deliberately do NOT read
// event.detail.{kind,tools}, because that detail object is authored in the
// page's MAIN world and is not reliably readable from this isolated-world
// content script — we trust the event only as a "settled" trigger.
//
// CAVEATS — REVISIT LATER (this is a prototype, not a finished design):
//  - Pages NOT instrumented by webmcp-public-sites never fire this, so the agent
//    loop falls back to timeout-based waiting for them (see sidebar.js
//    waitForToolsUpdate). This couples the otherwise-generic inspector to our
//    sites.
//  - No payload validation or kind/url cross-checking is done.
//  - Longer term this should fold into / replace the timeout heuristics in
//    sidebar.js rather than living as a parallel signal.
// ─────────────────────────────────────────────────────────────────────────────
const onWebmcpReady = () => listTools('ready');

chrome.runtime.onMessage.addListener(({ action, name, inputArgs, location }, _, reply) => {
  try {
    if (!navigator.modelContextTesting) {
      throw new Error('Error: You must run Chrome with the "WebMCP for testing" flag enabled.');
    }
    if (action == 'LIST_TOOLS') {
      listTools();
      // EXPERIMENTAL / WIP: arm the project-specific `webmcp:ready` listener
      // (see onWebmcpReady above) next to the standard `toolchange` wiring.
      // Idempotent: onWebmcpReady is a stable reference, so repeated LIST_TOOLS
      // messages don't stack duplicate listeners. Added before the early return
      // below so it is armed on both the `ontoolchange` and testing-API paths.
      window.addEventListener('webmcp:ready', onWebmcpReady);
      const mc = getModelContext();
      if (mc && 'ontoolchange' in mc) {
        mc.addEventListener('toolchange', listTools);
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
      const mc = getModelContext();
      if (mc && 'executeTool' in mc) {
        promise = mc.getTools().then((tools) => {
          const tool = tools.find((t) => t.name === name && t.window === window);
          return mc.executeTool(tool, inputArgs);
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
    // A synchronous throw here (e.g. the testing-flag check, which runs before
    // EXECUTE_TOOL reaches its async reply) would otherwise leave the caller's
    // sendMessage resolving to undefined - surfacing as an empty/garbled tool
    // result instead of the actual error. Reply with it as well as broadcasting.
    reply(JSON.stringify(message));
    chrome.runtime.sendMessage({ message });
  }
});

// Arm the settled-signal listener at load, before the page can fire it. The page
// dispatches a `webmcp:ready` window CustomEvent after its tools settle on each
// route. Previously this listener was armed only inside the LIST_TOOLS handler,
// which on a fresh navigation arrives after the page already fired ready, so the
// settled set was missed and the panel sat empty until a later LIST_TOOLS
// (measured ~1s+ late). The content script runs at document_start, before the
// page's own scripts register tools, so arming here catches that first ready.
// `onWebmcpReady` is the same stable reference the LIST_TOOLS path adds, so this
// does not double-register. Top frame only: a subframe report would clobber the
// badge (background.js keys it off any frame) and the panel.
//
// Late injection - the script loaded after ready already fired (e.g. the
// extension was reloaded on an already-open tab) - still surfaces via the next
// LIST_TOOLS, as before; a proactive re-enumeration there can't tell a settled
// set from a mid-registration partial one, so it is intentionally not attempted.
if (window.top === window) {
  window.addEventListener('webmcp:ready', onWebmcpReady);
}

// `reason === 'ready'` marks this push as the webmcp:ready-driven, settled
// snapshot (EXPERIMENTAL — see onWebmcpReady). The standard toolchange handler
// passes an Event here, which is !== 'ready', so those refreshes stay untagged.
async function listTools(reason) {
  const mc = getModelContext();
  const testing = navigator.modelContextTesting;
  let tools = [];
  if (mc && 'getTools' in mc) {
    for (const tool of await mc.getTools()) {
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
  } else if (testing && typeof testing.listTools === 'function') {
    tools = testing.listTools();
  } else {
    // No enumeration API available (e.g. the webmcp:ready listener fired but the
    // testing flag is off). Don't broadcast a misleading empty, settled-looking
    // set, which sidebar.js would otherwise consume to resolve a pending wait.
    return;
  }
  console.debug(`[WebMCP] Got ${tools.length} tools`, tools);
  chrome.runtime.sendMessage({ tools, url: window.location.href, ready: reason === 'ready' });
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
