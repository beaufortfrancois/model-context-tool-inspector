// Allows users to open the side panel by clicking the action icon.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Update badge text with the number of tools per tab.
chrome.tabs.onUpdated.addListener((tabId) => {
  chrome.action.setBadgeText({ text: "", tabId });
  chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  chrome.tabs.sendMessage(tabId, { action: "LIST_TOOLS" });
});

chrome.runtime.onMessage.addListener(({ tools }, { tab }) => {
  const text = tools?.length ? `${tools.length}` : "";
  chrome.action.setBadgeText({ text, tabId: tab.id });
});
