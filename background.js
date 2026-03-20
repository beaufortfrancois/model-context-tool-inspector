/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Allows users to open the side panel by clicking the action icon.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Inject content script in all tabs first.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  tabs.forEach(({ id: tabId }) => {
    chrome.scripting
      .executeScript({
        target: { tabId },
        files: ['content.js'],
      })
      .catch(() => {});
  });
});

// Update badge text with the number of tools per tab.
chrome.tabs.onActivated.addListener(({ tabId }) => updateBadge(tabId));
chrome.tabs.onUpdated.addListener((tabId) => updateBadge(tabId));

async function updateBadge(tabId) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id !== tabId) return;

  // Only try to message tabs with valid URLs.
  if (tab.url && (tab.url.startsWith('http') || tab.url.startsWith('file'))) {
    chrome.action.setBadgeText({ text: '', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
    
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'LIST_TOOLS' });
    } catch (error) {
      // Silently catch error if tab is not ready or doesn't have content script.
      // Also catch runtime errors if the sidebar is closed.
      chrome.runtime.sendMessage({ message: error.message }).catch(() => {});
    }
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.tools && sender.tab) {
    const text = msg.tools.length ? `${msg.tools.length}` : '';
    chrome.action.setBadgeText({ text, tabId: sender.tab.id });
  }
});
