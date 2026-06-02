/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

console.debug(`[WebMCP] Content script injected in ${window.location.href}`);

const modelContext = document.modelContext || navigator.modelContext;

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
      if ('ontoolchange' in modelContext) {
        modelContext.addEventListener('toolchange', listTools);
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
    // A synchronous throw here (e.g. the testing-flag check, which runs before
    // EXECUTE_TOOL reaches its async reply) would otherwise leave the caller's
    // sendMessage resolving to undefined - surfacing as an empty/garbled tool
    // result instead of the actual error. Reply with it as well as broadcasting.
    reply(JSON.stringify(message));
    chrome.runtime.sendMessage({ message });
  }
});

// Surface tools without waiting for a LIST_TOOLS message. On full-document
// navigations (e.g. zhihu) the page registers tools and fires its one-shot
// `webmcp:ready` at ~1s. Previously the `webmcp:ready` / `toolchange` listeners
// were armed only inside the LIST_TOOLS handler, which often ran later - or the
// content script was injected after `ready` already fired - so the settled
// signal was missed and the panel sat empty until a LIST_TOOLS happened to
// arrive (measured ~1s+ late). Arm the listeners and enumerate proactively as
// soon as the WebMCP API exists, retrying briefly until tools appear. Listener
// refs are stable, so this never double-registers with the LIST_TOOLS path.
(function discoverToolsOnLoad() {
  // Top frame only. The content script is injected in every frame, but tool
  // enumeration is broadcast from the top frame alone: LIST_TOOLS is only sent
  // to frameId 0, and background.js sets the badge from any frame's report with
  // no frameId gate, so a subframe broadcasting its own (usually empty) list
  // would clobber the top frame's badge and the panel. Subframes stay silent.
  if (window.top !== window) return;

  let armed = false;
  let elapsed = 0;
  const STEP_MS = 150;
  const CAP_MS = 4000;

  // Count tools WITHOUT broadcasting. Calling listTools() on every poll tick
  // would push an empty list repeatedly: that blanks the panel and, mid agent
  // run, overwrites the run's tool snapshot and trips the post-navigation
  // settle early (sidebar.js consumes any report). So poll a bare count and
  // only listTools() (which broadcasts) once tools have actually appeared.
  const countTools = async () => {
    const mc = document.modelContext || navigator.modelContext;
    if (mc && 'getTools' in mc) return (await mc.getTools()).length;
    const testing = navigator.modelContextTesting;
    if (testing && typeof testing.listTools === 'function') return testing.listTools().length;
    return 0;
  };

  const timer = setInterval(async () => {
    elapsed += STEP_MS;
    const mc = document.modelContext || navigator.modelContext;
    const testing = navigator.modelContextTesting;
    if ((mc || testing) && !armed) {
      armed = true;
      // Arm the settled-signal + toolchange listeners now so later route
      // changes still refresh the panel after this discovery loop has stopped.
      window.addEventListener('webmcp:ready', onWebmcpReady);
      if (mc && 'ontoolchange' in mc) {
        mc.addEventListener('toolchange', listTools);
      } else if (testing && typeof testing.addEventListener === 'function') {
        testing.addEventListener('toolchange', listTools);
      }
    }
    if (armed) {
      let n = 0;
      try { n = await countTools(); } catch { n = 0; }
      if (n > 0) {
        clearInterval(timer);
        listTools(); // tools are present now: broadcast them once
        return;
      }
    }
    if (elapsed >= CAP_MS) clearInterval(timer);
  }, STEP_MS);
})();

// `reason === 'ready'` marks this push as the webmcp:ready-driven, settled
// snapshot (EXPERIMENTAL — see onWebmcpReady). The standard toolchange handler
// passes an Event here, which is !== 'ready', so those refreshes stay untagged.
async function listTools(reason) {
  // Resolve the API per-call rather than trusting the document_start capture
  // above: the flag-gated API can appear after this script is injected, so a
  // value captured at load may be stale/undefined.
  const mc = document.modelContext || navigator.modelContext;
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
  } else if (navigator.modelContextTesting) {
    tools = navigator.modelContextTesting.listTools();
  }
  console.debug(`[WebMCP] Got ${tools.length} tools`, tools);
  chrome.runtime.sendMessage({ tools, url: window.location.href, ready: reason === 'ready' });
  return tools.length;
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
