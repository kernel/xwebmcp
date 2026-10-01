// Tabs the extension opened itself. Agents driving the CLI only act on these
// by default so a real profile's other tabs are never touched. They are kept
// together in an "xwebmcp" tab group.

const GROUP_TITLE = 'xwebmcp';
const STORAGE_KEY = 'ownedTabs';

const owned = new Set();
let loaded = null;

async function load() {
  loaded ??= chrome.storage.session.get(STORAGE_KEY).then(async ({[STORAGE_KEY]: ids = []}) => {
    for (const id of ids) owned.add(id);
    // Session storage is cleared when the extension reloads, but the "xwebmcp"
    // tab group survives, so tabs in it are still ours.
    try {
      const groups = await chrome.tabGroups.query({title: GROUP_TITLE});
      for (const group of groups) {
        for (const tab of await chrome.tabs.query({groupId: group.id})) owned.add(tab.id);
      }
    } catch {
      // Tab groups unavailable; fall back to the stored list.
    }
  });
  return loaded;
}

async function save() {
  await chrome.storage.session.set({[STORAGE_KEY]: [...owned]});
}

// ready resolves once ownership has been restored (after a service-worker
// start or an extension reload).
export function ready() {
  return load();
}

export function isOwned(tabId) {
  return owned.has(tabId);
}

export async function ownedTabs() {
  await load();
  const all = await chrome.tabs.query({});
  return all.filter((tab) => owned.has(tab.id));
}

async function groupTab(tab) {
  try {
    const existing = await chrome.tabGroups.query({title: GROUP_TITLE, windowId: tab.windowId});
    const groupId = await chrome.tabs.group(existing.length ? {tabIds: tab.id, groupId: existing[0].id} : {tabIds: tab.id});
    if (!existing.length) await chrome.tabGroups.update(groupId, {title: GROUP_TITLE, color: 'blue'});
  } catch {
    // Grouping is cosmetic; ownership tracking is what enforces the policy.
  }
}

// open creates an owned tab.
export async function open({url, active = true}) {
  await load();
  const tab = await chrome.tabs.create({url, active});
  owned.add(tab.id);
  await save();
  await groupTab(tab);
  return tab;
}

function requireOwned(tabId, allowUserTabs) {
  if (!allowUserTabs && !owned.has(tabId)) {
    throw Object.assign(new Error(`tab ${tabId} was not opened by xwebmcp; pass allow_user_tabs to act on the user's own tabs`), {code: 'tab_not_allowed'});
  }
}

export async function navigate({tabId, url, allowUserTabs}) {
  await load();
  requireOwned(tabId, allowUserTabs);
  return chrome.tabs.update(tabId, {url});
}

export async function close({tabId, allowUserTabs}) {
  await load();
  requireOwned(tabId, allowUserTabs);
  await chrome.tabs.remove(tabId);
  owned.delete(tabId);
  await save();
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (owned.delete(tabId)) void save();
});

void load();
