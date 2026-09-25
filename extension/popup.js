// Popup: installed tools, whether they are registered on the current tab,
// every WebMCP tool the current tab exposes, and the CLI bridge state.

const {client} = globalThis.xw;
const {matchesAny} = globalThis.xw.urlPattern;

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function badge(text, cls = '') {
  return el('span', {className: `badge ${cls}`.trim(), textContent: text});
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  return tab;
}

function originPattern(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.host}/*`;
  } catch {
    return null;
  }
}

async function renderBridge() {
  const {bridge} = await chrome.storage.session.get('bridge');
  const node = $('bridge');
  if (!bridge) {
    node.textContent = 'bridge: unknown';
    return;
  }
  node.textContent = bridge.connected ? 'bridge: connected' : 'bridge: disconnected';
  node.className = `badge ${bridge.connected ? 'on' : 'off'}`;
  $('bridge-detail').textContent = bridge.connected
    ? 'xwebmcp CLI can reach this extension.'
    : `${bridge.error ?? ''} Run \`xwebmcp setup chrome\` if the native host is not installed.`.trim();
}

async function renderTab() {
  const tab = await currentTab();
  const list = $('tab-tools');
  const actions = $('tab-actions');
  list.replaceChildren();
  actions.replaceChildren();
  $('tab-empty').textContent = '';
  if (!tab) return;
  $('tab-url').textContent = tab.url ?? '';
  const pattern = originPattern(tab.url ?? '');
  if (!pattern) {
    $('tab-empty').textContent = 'Not a web page.';
    return;
  }
  const granted = await chrome.permissions.contains({origins: [pattern]});
  const tools = await client.listTools({tabId: tab.id});
  const snapshot = await client.tabSnapshot({tab_id: tab.id});
  for (const tool of tools) {
    list.append(el('li', {},
      el('span', {className: 'name', title: tool.tool.description ?? '', textContent: tool.tool.name}),
      tool.source.frame ? badge(`frame ${tool.source.frame.frame_id}`) : '',
      tool.source.custom ? badge(tool.source.custom.namespace, 'custom') : badge('native', 'native'),
    ));
  }
  const unsupported = snapshot?.frames.find((frame) => frame.frameId === 0 && !frame.supported);
  if (unsupported) {
    $('tab-empty').textContent = 'document.modelContext is missing: enable the WebMCP flag (xwebmcp setup chrome) and restart Chrome.';
  } else if (!tools.length) {
    $('tab-empty').textContent = granted ? 'No WebMCP tools on this page.' : 'Site access not granted; tools on this page are not discovered.';
  }
  const errors = snapshot?.frames.flatMap((frame) => frame.registrationErrors ?? []) ?? [];
  if (errors.length) $('tab-empty').append(el('div', {className: 'error', textContent: errors.join('\n')}));
  if (!granted) {
    actions.append(el('button', {
      textContent: 'Discover tools on this site',
      onclick: async () => {
        const ok = await chrome.permissions.request({origins: [pattern]});
        if (ok) {
          await client.refreshTab({tab_id: tab.id});
          setTimeout(render, 300);
        }
      },
    }));
  } else {
    actions.append(el('button', {
      textContent: 'Refresh',
      onclick: async () => {
        await client.refreshTab({tab_id: tab.id});
        setTimeout(render, 300);
      },
    }));
  }
}

async function renderInstalled() {
  const tab = await currentTab();
  const {tools, pending_origins: pending} = await client.listCustomTools();
  const snapshot = tab ? await client.tabSnapshot({tab_id: tab.id}) : null;
  const registered = new Set(snapshot?.frames.flatMap((frame) => frame.registered ?? []) ?? []);
  const list = $('installed');
  list.replaceChildren();
  $('installed-empty').textContent = tools.length ? '' : 'Nothing installed. Run `xwebmcp add kernel/xwebmcp && xwebmcp attach`.';
  for (const tool of tools) {
    const matches = tab?.url ? matchesAny(tab.url, tool.match.url_patterns) : false;
    list.append(el('li', {},
      el('span', {className: 'name', title: tool.tool.description ?? '', textContent: `${tool.namespace}/${tool.tool.name}`}),
      badge(tool.kind),
      matches ? badge(registered.has(tool.id) ? 'registered' : 'not registered', registered.has(tool.id) ? 'on' : 'off') : badge('other site'),
    ));
  }
  const pendingNode = $('pending');
  pendingNode.replaceChildren();
  if (pending.length) {
    pendingNode.append(
      el('span', {className: 'muted', textContent: `${pending.length} site(s) need access`}),
      el('button', {
        textContent: 'Grant access',
        onclick: async () => {
          await chrome.permissions.request({origins: pending});
          setTimeout(render, 300);
        },
      }),
    );
  }
}

async function render() {
  await Promise.all([renderBridge(), renderTab(), renderInstalled()]);
}

$('open-panel').onclick = async () => {
  const tab = await currentTab();
  if (tab) await chrome.sidePanel.open({windowId: tab.windowId});
  window.close();
};

client.onToolsChanged(() => {
  void render();
});
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.bridge) void renderBridge();
});
void render();
