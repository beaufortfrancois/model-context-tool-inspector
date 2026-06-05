/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

async function getIframeOrigins(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });

  // Extract origins, ignoring the top-level frame (frameId === 0)
  const origins = frames
    .filter((frame) => frame.frameId !== 0)
    .map((frame) => {
      try {
        return new URL(frame.url).origin;
      } catch (e) {
        return 'null';
      }
    })
    .filter((origin) => origin !== 'null');

  return [...new Set(origins)];
}

export { getIframeOrigins };
