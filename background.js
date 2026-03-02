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

const skillsByTab = new Map();

// Update badge text with the number of tools per tab.
chrome.tabs.onActivated.addListener(({ tabId }) => updateBadge(tabId));
chrome.tabs.onUpdated.addListener((tabId) => updateBadge(tabId));

async function updateBadge(tabId) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab.id !== tabId) return;
  chrome.action.setBadgeText({ text: '', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  chrome.tabs.sendMessage(tabId, { action: 'LIST_TOOLS' }).catch(({ message }) => {
    chrome.runtime.sendMessage({ message });
  });
  chrome.tabs.sendMessage(tabId, { action: 'LIST_SKILLS' }).catch(() => {});
}

chrome.runtime.onMessage.addListener(({ tools, skills, references }, { tab }) => {
  if (tools) {
    const text = tools.length ? `${tools.length}` : '';
    chrome.action.setBadgeText({ text, tabId: tab.id });
  }
  if (skills) {
    skillsByTab.set(tab.id, { skills, references });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  skillsByTab.delete(tabId);
});
