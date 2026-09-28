import type { ActiveSession } from './model.ts';

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void chrome.storage.local.remove('activeSession');
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'RECORDER_HELLO') return;
  void chrome.storage.local.get('activeSession').then(({ activeSession }) => {
    const session = activeSession as ActiveSession | undefined;
    const sameTab = session?.tabId === sender.tab?.id;
    const sameOrigin = session && sender.url && new URL(sender.url).origin === session.origin;
    sendResponse(sameTab && sameOrigin ? { active: true, sessionId: session.sessionId } : { active: false });
  }).catch(() => sendResponse({ active: false }));
  return true;
});
