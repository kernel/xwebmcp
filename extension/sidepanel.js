// Side panel: the WebMCP tools of the active tab (site-native and installed),
// a schema-driven input form with a JSON fallback, a run button, and the
// result. Updates are event-driven (tool changes, tab switches, navigation).
// Drafts and results live only in this page's memory; inputs are never
// persisted or logged.

const {client} = globalThis.xw;
const {getWebMCPFields, canDisplayWebMCPFields, parseWebMCPInput} = globalThis.xw.inputs;

const examples = globalThis.xw.examples;
const TASKS_KEY = 'exampleTasks';

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
  selectedRef: null,
  drafts: new Map(), // tool_ref -> {input, mode, numbers, error, result, duration, diagnostics, unavailable}
  running: null,
  // OpenRouter settings from chrome.storage.local; the key is never logged.
  settings: {apiKey: '', model: ''},
  settingsOpen: false,
  // Per-tab task text and invocation history, mirrored to chrome.storage.session.
  tasks: {}, // tab id -> task text
  history: {}, // tab id -> [{tool, input, status, output}]
  generating: null,
  stepping: false,
  stepError: '',
  focusRun: false,
};

const HISTORY_KEY = 'stepHistory';
const HISTORY_LIMIT = 10;

function currentTask() {
  return state.tasks[state.tabId] ?? '';
}

function recordHistory(tool, input, result) {
  if (!state.tabId) return;
  let output = result?.error_text ?? result?.error ?? result?.output;
  output = typeof output === 'string' ? output : JSON.stringify(output ?? null);
  if (output.length > 2000) output = `${output.slice(0, 2000)}\u2026`;
  const entry = {tool: tool.tool.name, input, status: result?.status ?? result?.code ?? (result?.error ? 'error' : 'unknown'), output};
  const list = [...(state.history[state.tabId] ?? []), entry].slice(-HISTORY_LIMIT);
  state.history = {...state.history, [state.tabId]: list};
  void chrome.storage.session.set({[HISTORY_KEY]: state.history}).catch(() => {});
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(examples.SETTINGS_KEY).catch(() => ({}));
  const value = stored?.[examples.SETTINGS_KEY] ?? {};
  state.settings = {apiKey: typeof value.apiKey === 'string' ? value.apiKey : '', model: typeof value.model === 'string' ? value.model : ''};
  const session = await chrome.storage.session.get(TASKS_KEY).catch(() => ({}));
  state.tasks = session?.[TASKS_KEY] ?? {};
  const history = await chrome.storage.session.get(HISTORY_KEY).catch(() => ({}));
  state.history = history?.[HISTORY_KEY] ?? {};
}

async function saveSettings(update) {
  state.settings = {...state.settings, ...update};
  await chrome.storage.local.set({[examples.SETTINGS_KEY]: state.settings});
}

function setTask(text) {
  if (!state.tabId) return;
  state.tasks = {...state.tasks, [state.tabId]: text};
  if (!text) delete state.tasks[state.tabId];
  void chrome.storage.session.set({[TASKS_KEY]: state.tasks}).catch(() => {});
}

function renderTaskBar() {
  const input = $('task');
  const step = $('step');
  if (!input || !step) return;
  if (document.activeElement !== input) input.value = currentTask();
  input.disabled = !state.tabId;
  const hasKey = Boolean(state.settings.apiKey);
  step.disabled = !hasKey || state.stepping || state.running !== null || !state.tools.length;
  step.title = !hasKey ? 'set an OpenRouter API key in settings to enable' : 'ask the model for the next tool call toward the task (you still click run)';
  step.setAttribute('aria-busy', String(state.stepping));
  const label = $('step-label');
  if (label) label.textContent = state.stepping ? 'thinking\u2026' : 'step';
  const error = $('step-error');
  if (error) {
    error.textContent = state.stepError;
    error.hidden = !state.stepError;
  }
}

async function step() {
  if (state.stepping || !state.settings.apiKey || !state.tools.length) return;
  state.stepping = true;
  state.stepError = '';
  render();
  try {
    const plan = await examples.planNextStep({
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      task: currentTask(),
      page: {title: state.tab?.title ?? '', url: state.tab?.url ?? ''},
      tools: state.tools.map((tool) => ({name: tool.tool.name, description: tool.tool.description, inputSchema: tool.tool.inputSchema})),
      history: state.history[state.tabId] ?? [],
    });
    const tool = state.tools.find((candidate) => candidate.tool.name === plan.tool);
    if (!tool) throw new Error(`the model picked an unknown tool: ${plan.tool}`);
    state.selectedRef = tool.tool_ref;
    const fields = getWebMCPFields(tool.tool.inputSchema);
    updateDraft(tool.tool_ref, {
      input: JSON.stringify(plan.arguments, null, 2),
      numbers: undefined,
      mode: fields && canDisplayWebMCPFields(fields, plan.arguments) ? (state.drafts.get(tool.tool_ref)?.mode ?? 'fields') : 'json',
      error: undefined,
    });
    state.focusRun = true;
  } catch (error) {
    state.stepError = `step: ${error instanceof Error ? error.message : 'failed'}`;
  } finally {
    state.stepping = false;
    render();
  }
}

function renderSettings() {
  const node = $('settings');
  if (!node) return;
  node.hidden = !state.settingsOpen;
  node.replaceChildren();
  if (!state.settingsOpen) return;
  const keyInput = el('input', {id: 'openrouter-key', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: state.settings.apiKey ? 'key saved · paste to replace' : 'sk-or-…'});
  const modelInput = el('input', {id: 'openrouter-model', type: 'text', spellcheck: 'false', placeholder: examples.DEFAULT_MODEL, value: state.settings.model});
  const status = el('span', {className: 'muted', style: 'font-size:11px'}, state.settings.apiKey ? 'key saved' : 'no key set');
  node.append(
    el('label', {for: 'openrouter-key'}, el('span', {}, 'OpenRouter API key'), el('span', {className: 'muted', style: 'font-size:10px'}, 'stored locally; sent only to openrouter.ai')),
    keyInput,
    el('label', {for: 'openrouter-model'}, el('span', {}, 'model'), el('span', {className: 'muted', style: 'font-size:10px'}, `default ${examples.DEFAULT_MODEL}`)),
    modelInput,
    el('p', {className: 'row'}, status, el('span', {},
      el('button', {type: 'button', disabled: state.settings.apiKey ? undefined : '', onclick: async () => {
        await saveSettings({apiKey: ''});
        render();
      }}, 'clear key'), ' ',
      el('button', {type: 'button', className: 'primary', onclick: async () => {
        const update = {model: modelInput.value.trim()};
        if (keyInput.value.trim()) update.apiKey = keyInput.value.trim();
        await saveSettings(update);
        render();
      }}, 'save'))),
  );
}

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
  const groups = new Map();
  for (const tool of state.tools) {
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
  const generating = state.generating === tool.tool_ref;
  const hasKey = Boolean(state.settings.apiKey);
  const actions = el('span', {});
  actions.append(el('button', {
    type: 'button',
    disabled: running || generating || !hasKey || !available ? '' : undefined,
    title: hasKey ? 'fill the inputs with AI-generated example values (does not run the tool)' : 'set an OpenRouter API key in settings to enable',
    onclick: () => void generateExample(tool),
  }, generating ? 'generating…' : 'example inputs'), ' ');
  toolbar.append(actions);
  actions.append(el('button', {
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
  if (!hasKey) {
    editor.append(el('p', {className: 'muted', style: 'font-size:10px'}, 'example inputs: add an OpenRouter API key in ', el('button', {type: 'button', onclick: () => {
      state.settingsOpen = true;
      render();
    }}, 'settings'), '.'));
  }

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
    id: 'run-button',
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

async function generateExample(tool) {
  if (state.generating || !state.settings.apiKey) return;
  state.generating = tool.tool_ref;
  updateDraft(tool.tool_ref, {error: undefined});
  render();
  try {
    const input = await examples.generateExampleInputs({
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      tool: {name: tool.tool.name, description: tool.tool.description, inputSchema: tool.tool.inputSchema},
      page: {title: state.tab?.title ?? tool.source.page_title ?? '', url: state.tab?.url ?? tool.source.page_url ?? ''},
      task: currentTask(),
    });
    const fields = getWebMCPFields(tool.tool.inputSchema);
    updateDraft(tool.tool_ref, {
      input: JSON.stringify(input, null, 2),
      numbers: undefined,
      mode: fields && canDisplayWebMCPFields(fields, input) ? state.drafts.get(tool.tool_ref)?.mode : 'json',
      error: undefined,
    });
  } catch (error) {
    updateDraft(tool.tool_ref, {error: `example inputs: ${error instanceof Error ? error.message : 'generation failed'}`});
  } finally {
    state.generating = null;
    render();
  }
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
    recordHistory(tool, input, result);
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
    recordHistory(tool, input, update.result);
  } finally {
    state.running = null;
    render();
    void reload();
  }
}

function render() {
  renderSettings();
  renderTaskBar();
  renderList();
  renderEditor();
  if (state.focusRun) {
    state.focusRun = false;
    const button = $('run-button');
    button?.focus?.();
    button?.scrollIntoView?.({block: 'nearest'});
  }
}

$('task')?.addEventListener('input', (event) => setTask(event.target.value));
$('task')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void step();
});
$('step')?.addEventListener('click', () => void step());

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
$('settings-toggle')?.addEventListener('click', () => {
  state.settingsOpen = !state.settingsOpen;
  render();
});
chrome.storage.local?.onChanged?.addListener((changes) => {
  if (changes[examples.SETTINGS_KEY]) void loadSettings().then(render);
});
void renderBridge();
void loadSettings().then(reload);
