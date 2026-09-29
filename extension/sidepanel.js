// Side panel: the WebMCP tools of the active tab (site-native and installed),
// a schema-driven input form with a JSON fallback, a run button, and the
// result. Updates are event-driven (tool changes, tab switches, navigation).
// Drafts and results live only in this page's memory; inputs are never
// persisted or logged.

const {client} = globalThis.xw;
const {getWebMCPFields, canDisplayWebMCPFields, parseWebMCPInput} = globalThis.xw.inputs;

const $ = (id) => document.getElementById(id);
const INVOKE_TIMEOUT_SEC = 120;

// ?tab=<id> pins the panel to a tab, which is how it is exercised outside a
// real side panel (for example loaded in a tab during development).
const pinnedTabId = Number(new URLSearchParams(location.search).get('tab')) || null;
let reloadVersion = 0;

const state = {
  tabId: null,
  tab: null,
  tools: [],
  search: '',
  selectedRef: null,
  drafts: new Map(), // tool_ref -> {input, mode, numbers, error, result, duration, diagnostics, unavailable}
  running: null,
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'className') node.className = value;
    else if (key.startsWith('on')) node[key] = value;
    else if (value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

function badge(text, cls = '') {
  return el('span', {className: `badge ${cls}`.trim()}, text);
}

async function activeTab() {
  if (pinnedTabId) return chrome.tabs.get(pinnedTabId).catch(() => null);
  const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  return tab ?? null;
}

function draftFor(tool) {
  let draft = state.drafts.get(tool.tool_ref);
  if (!draft) {
    draft = {input: '{}', mode: getWebMCPFields(tool.tool.inputSchema) ? 'fields' : 'json'};
    state.drafts.set(tool.tool_ref, draft);
  }
  return draft;
}

function updateDraft(ref, update) {
  state.drafts.set(ref, {...(state.drafts.get(ref) ?? {input: '{}', mode: 'fields'}), ...update});
}

async function reload() {
  const version = ++reloadVersion;
  const tab = await activeTab();
  const tools = tab?.id ? await client.listTools({tab_id: tab.id}).catch(() => []) : [];
  if (version !== reloadVersion) return;
  state.tab = tab;
  state.tabId = tab?.id ?? null;
  state.tools = tools;
  if (state.selectedRef && !state.tools.some((tool) => tool.tool_ref === state.selectedRef) && state.running !== state.selectedRef) {
    const previous = state.drafts.get(state.selectedRef);
    if (!previous?.result) state.selectedRef = null;
  }
  if (!state.selectedRef && state.tools.length) state.selectedRef = state.tools[0].tool_ref;
  render();
}

async function renderBridge() {
  const {bridge} = await chrome.storage.session.get('bridge');
  const node = $('bridge');
  node.textContent = bridge?.connected ? 'bridge: connected' : 'bridge: off';
  node.title = bridge?.connected ? 'the xwebmcp CLI can reach this extension' : (bridge?.error ?? 'native host not connected');
}

function renderList() {
  const list = $('list');
  list.replaceChildren();
  $('count').textContent = state.tools.length ? String(state.tools.length) : '';
  $('page').textContent = state.tab ? (state.tab.title || state.tab.url || '') : 'no active tab';
  $('page').title = state.tab?.url ?? '';
  const query = state.search.toLowerCase();
  const groups = new Map();
  for (const tool of state.tools) {
    if (query && !`${tool.tool.name} ${tool.tool.description ?? ''} ${tool.source.custom?.namespace ?? ''}`.toLowerCase().includes(query)) continue;
    const key = tool.source.frame ? `frame ${tool.source.frame.frame_id} · ${tool.source.frame.url}` : 'page';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tool);
  }
  for (const [key, tools] of groups) {
    list.append(el('div', {className: 'group', title: key}, key));
    for (const tool of tools) {
      list.append(el('button', {
        type: 'button',
        className: `tool${tool.tool_ref === state.selectedRef ? ' selected' : ''}`,
        'aria-pressed': String(tool.tool_ref === state.selectedRef),
        onclick: () => {
          state.selectedRef = tool.tool_ref;
          render();
        },
      },
      el('span', {className: 'name', title: tool.tool.description ?? ''}, tool.tool.name),
      tool.source.custom ? badge(tool.source.custom.namespace, 'custom') : badge('native', 'native'),
      ));
    }
  }
  $('list-empty').textContent = groups.size ? '' : state.tools.length ? 'no matching tools' : state.tabId ? 'no webmcp tools on this page' : '';
}

function selectedTool() {
  return state.tools.find((tool) => tool.tool_ref === state.selectedRef) ?? null;
}

function renderEditor() {
  const editor = $('editor');
  const tool = selectedTool() ?? [...state.drafts.entries()].map(([ref, draft]) => draft.tool && ref === state.selectedRef ? draft.tool : null).find(Boolean);
  editor.replaceChildren();
  if (!tool) {
    editor.append(el('div', {className: 'empty'}, 'select a tool to run it.'));
    return;
  }
  const draft = draftFor(tool);
  draft.tool = tool;
  const live = state.tools.some((candidate) => candidate.tool_ref === tool.tool_ref);
  const available = live && !draft.unavailable;
  const running = state.running === tool.tool_ref;
  const busy = state.running !== null;
  const fields = getWebMCPFields(tool.tool.inputSchema);
  let input = null;
  try {
    input = parseWebMCPInput(draft.input);
  } catch {
    input = null;
  }
  const canUseFields = fields !== null && input !== null && canDisplayWebMCPFields(fields, input);
  const showFields = draft.mode === 'fields' && canUseFields;

  editor.append(
    el('div', {className: 'row'}, el('h2', {}, tool.tool.name), tool.source.custom ? badge(tool.source.custom.namespace, 'custom') : badge('native', 'native')),
    el('p', {className: 'muted'}, tool.tool.description ?? ''),
    el('p', {className: 'muted', style: 'font-size:11px', title: tool.source.page_url}, `${tool.source.page_title || tool.source.page_url} · tab ${tool.source.tab_id}${tool.source.frame ? ` · frame ${tool.source.frame.frame_id}` : ''}`),
  );
  if (!available) {
    editor.append(el('p', {className: 'error'}, 'this registration is no longer available; select a current tool.'));
  }

  // Handlers read the latest draft rather than the values captured at render
  // time, so typing into several fields without a re-render keeps them all.
  const latestInput = () => {
    try {
      return parseWebMCPInput(state.drafts.get(tool.tool_ref)?.input ?? '{}');
    } catch {
      return {};
    }
  };
  const changeField = (name, value) => {
    const next = {...latestInput(), [name]: value};
    if (value === undefined) delete next[name];
    updateDraft(tool.tool_ref, {input: JSON.stringify(next, null, 2), error: undefined});
    render();
  };

  const toolbar = el('div', {className: 'row'}, el('span', {className: 'muted', style: 'font-size:10px'}, 'inputs'));
  toolbar.append(el('button', {
    type: 'button',
    disabled: running || (!showFields && !canUseFields) ? '' : undefined,
    title: showFields ? 'edit JSON' : canUseFields ? 'edit fields' : 'this input requires JSON',
    onclick: () => {
      try {
        const parsed = parseWebMCPInput(draft.input, draft.numbers);
        updateDraft(tool.tool_ref, {input: JSON.stringify(parsed, null, 2), numbers: undefined, mode: showFields ? 'json' : 'fields', error: undefined});
      } catch (error) {
        updateDraft(tool.tool_ref, {error: error instanceof Error ? error.message : 'check the inputs'});
      }
      render();
    },
  }, showFields ? 'json' : 'fields'));
  editor.append(toolbar);

  if (showFields) {
    if (!fields.length) editor.append(el('p', {className: 'muted'}, 'no declared inputs.'));
    for (const field of fields) {
      const id = `field-${field.name}`;
      editor.append(el('label', {for: id}, el('span', {}, field.name), el('span', {className: 'muted', style: 'font-size:10px'}, `${field.type}${field.required ? ' · required' : ''}`)));
      const current = input && Object.hasOwn(input, field.name) ? input[field.name] : undefined;
      if (field.options) {
        const select = el('select', {id, title: field.description, disabled: running ? '' : undefined, onchange: (event) => changeField(field.name, event.target.value === '' ? undefined : field.options[Number(event.target.value)].value)},
          el('option', {value: ''}, 'not set'),
          ...field.options.map((option, index) => el('option', {value: String(index)}, option.label)));
        select.value = current === undefined ? '' : String(field.options.findIndex((option) => option.value === current));
        editor.append(select);
      } else if (field.type === 'boolean') {
        const select = el('select', {id, disabled: running ? '' : undefined, onchange: (event) => changeField(field.name, event.target.value === '' ? undefined : event.target.value === 'true')},
          el('option', {value: ''}, 'not set'), el('option', {value: 'true'}, 'true'), el('option', {value: 'false'}, 'false'));
        select.value = current === undefined ? '' : String(current);
        editor.append(select);
      } else {
        const pendingNumber = draft.numbers && Object.hasOwn(draft.numbers, field.name) ? draft.numbers[field.name] : undefined;
        editor.append(el('input', {
          id,
          type: 'text',
          inputmode: field.type === 'string' ? undefined : 'decimal',
          placeholder: field.description,
          disabled: running ? '' : undefined,
          value: pendingNumber ?? (current === undefined ? '' : String(current)),
          oninput: (event) => {
            if (field.type === 'string') {
              const next = {...latestInput(), [field.name]: event.target.value};
              updateDraft(tool.tool_ref, {input: JSON.stringify(next, null, 2), error: undefined});
            } else {
              const latest = state.drafts.get(tool.tool_ref);
              updateDraft(tool.tool_ref, {numbers: {...latest?.numbers, [field.name]: event.target.value}, error: undefined});
            }
          },
        }));
      }
    }
  } else {
    editor.append(el('textarea', {
      'aria-label': 'tool inputs JSON',
      spellcheck: 'false',
      disabled: running ? '' : undefined,
      oninput: (event) => updateDraft(tool.tool_ref, {input: event.target.value, numbers: undefined, mode: 'json', error: undefined}),
    }, draft.input));
  }
  if (draft.error) editor.append(el('p', {className: 'error', role: 'alert'}, draft.error));

  editor.append(el('p', {}, el('button', {
    type: 'button',
    className: 'primary',
    disabled: busy || !available ? '' : undefined,
    title: busy && !running ? 'another tool is running' : undefined,
    onclick: () => void run(tool),
  }, running ? 'running…' : 'run tool')));

  const result = draft.result;
  const section = el('div', {'aria-live': 'polite', style: 'border-top:1px solid #e5e5e5;margin-top:8px;padding-top:6px'});
  const status = running ? 'running…' : result?.code === 'outcome_unknown' ? 'outcome unknown' : result?.status ?? (result?.error ? 'run failed' : 'result');
  section.append(el('div', {className: 'row muted', style: 'font-size:10px'},
    el('span', {}, `${status}${!running && draft.duration !== undefined ? ` · ${draft.duration} ms` : ''}`),
    result ? el('button', {type: 'button', onclick: async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
      } catch {
        // Clipboard access can be refused; nothing else to do.
      }
    }}, 'copy') : null,
  ));
  if (result?.code === 'outcome_unknown') {
    section.append(el('p', {}, 'this may have executed. inspect the page before running again; no automatic retry.'));
  }
  if (result?.error_text || result?.error) section.append(el('p', {className: 'error'}, result.error_text ?? result.error));
  if (result && 'output' in result) {
    section.append(el('pre', {}, typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2)));
  } else if (result && !result.error_text && !result.error) {
    section.append(el('p', {className: 'muted'}, 'no output returned.'));
  }
  if (!result && !running) section.append(el('p', {className: 'muted'}, 'run the tool to inspect its response.'));
  if (draft.diagnostics) {
    const details = el('details', {}, el('summary', {}, 'diagnostics'));
    if (draft.diagnostics.error?.stack) details.append(el('pre', {}, draft.diagnostics.error.stack));
    if (draft.diagnostics.console?.length) {
      details.append(el('pre', {}, draft.diagnostics.console.map((entry) => `[${entry.level}] ${entry.text}`).join('\n')));
    }
    if (draft.diagnostics.timing) details.append(el('p', {className: 'muted'}, `${draft.diagnostics.timing.duration_ms} ms in the tool`));
    section.append(details);
  }
  if (result?.invocation_id) section.append(el('p', {className: 'muted', style: 'font-size:10px;word-break:break-all'}, result.invocation_id));
  editor.append(section);

  editor.append(el('details', {}, el('summary', {}, 'schema & metadata'),
    el('p', {className: 'muted'}, 'annotations are optional, page-provided hints, not guarantees.'),
    el('pre', {}, JSON.stringify({tool_ref: tool.tool_ref, source: tool.source, tool: tool.tool}, null, 2))));
}

async function run(tool) {
  if (state.running) return;
  const draft = draftFor(tool);
  let input;
  try {
    input = parseWebMCPInput(draft.input, draft.numbers);
    for (const name of Array.isArray(tool.tool.inputSchema?.required) ? tool.tool.inputSchema.required : []) {
      if (typeof name === 'string' && !Object.hasOwn(input, name)) throw new Error(`${name} is required`);
    }
  } catch (error) {
    updateDraft(tool.tool_ref, {error: error instanceof Error ? error.message : 'check the input JSON'});
    render();
    return;
  }
  state.running = tool.tool_ref;
  updateDraft(tool.tool_ref, {input: JSON.stringify(input, null, 2), numbers: undefined, error: undefined, result: undefined, duration: undefined, diagnostics: undefined});
  render();
  const started = performance.now();
  try {
    // The user is running the tool on their own tab from the panel.
    const result = await client.invoke({tool_ref: tool.tool_ref, input, timeout_sec: INVOKE_TIMEOUT_SEC, allow_user_tabs: true});
    const update = {result, duration: Math.round(performance.now() - started)};
    if (result.status !== 'completed' && result.invocation_id) {
      const record = await client.getInvocation({invocation_id: result.invocation_id}).catch(() => null);
      if (record?.diagnostics) update.diagnostics = record.diagnostics;
    }
    updateDraft(tool.tool_ref, update);
  } catch (error) {
    const update = {duration: Math.round(performance.now() - started)};
    if (error.code === 'outcome_unknown') {
      update.result = {code: 'outcome_unknown', error: error.message, invocation_id: error.invocationId};
    } else if (error.code === 'tool_not_found') {
      update.result = {error: error.message};
      update.unavailable = true;
    } else {
      update.result = {error: error.message};
    }
    updateDraft(tool.tool_ref, update);
  } finally {
    state.running = null;
    render();
    void reload();
  }
}

function render() {
  renderList();
  renderEditor();
}

$('search').addEventListener('input', (event) => {
  state.search = event.target.value;
  renderList();
});

client.onToolsChanged(() => void reload());
chrome.tabs.onActivated.addListener(() => {
  if (!pinnedTabId) void reload();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === state.tabId && (changeInfo.url || changeInfo.title || changeInfo.status === 'complete')) void reload();
});
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.bridge) void renderBridge();
});
void renderBridge();
void reload();
