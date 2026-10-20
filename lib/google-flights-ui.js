// Google Flights page operations shared by the google.com tools that press Google's own controls. Each helper clicks
// at most once per call and reports what the page shows afterwards; callers decide whether that confirms their change.
// Requires lib/google-flights-read.js.

// Evidence that Google rendered a new list after a click: the rows it renders now (itinerary, price, section, order)
// differ from those before the click. Elapsed time, a URL change, a finished request or a re-render of the same rows do
// not count: Google updates the URL and the selected control first, and may clear and restore the old rows before the
// new ones arrive. A list identical to the previous one therefore stays unconfirmed.
const gfWatch = () => {
  const before = gfRowsKey(gfRowNodes());
  return { refreshed: () => gfRowsKey(gfRowNodes()) !== before };
};

// Clicks a filter option once and waits until Google has processed it: test() holds, Google rendered a new list or
// changed the filter's chip, and the dialog's options have then stayed the same nodes, still passing test(), for a while.
// Google re-renders the dialog as it applies a change and drops clicks made before that, so the next click or closing
// the dialog must wait. A chip change alone comes early, so it needs the longer quiet period.
const gfClickProcessed = async (node, chipName, test, ms) => {
  const chip = () => gfLabel(gfControls().chips.find(c => c.name === chipName)?.node);
  const options = () => [...(gfDialog()?.querySelectorAll("input") || [])];
  const before = chip(), watch = gfWatch(), until = Date.now() + ms;
  node.click();
  let nodes = null, since = 0;
  while (Date.now() < until) {
    await gfSleep(150);
    const refreshed = watch.refreshed();
    if (!test() || (!refreshed && chip() === before)) { nodes = null; continue; }
    const now = options();
    if (!nodes || now.length !== nodes.length || now.some((n, i) => n !== nodes[i])) { nodes = now; since = Date.now(); continue; }
    if (Date.now() - since >= (refreshed ? 600 : 1500)) return true;
  }
  return false;
};
// What a person clicks for a dialog option: its label, which activates the input.
const gfOptionTarget = input => document.querySelector('label[for="' + input.id + '"]') || input;

// Polls until test() holds or the deadline passes; returns test()'s last value.
const gfWaitFor = async (test, ms) => {
  const until = Date.now() + ms;
  let value = test();
  while (!value && Date.now() < until) { await gfSleep(150); value = test(); }
  return value;
};

// Clicks once, then reads the list after Google reflects the change (reflected()) and re-announces it.
// Reads the list after an action. confirmed: Google reflects the change (reflected()) and rendered a new list that
// settled. When the rows stay identical to those before the action, the page is read again without that requirement,
// so the envelope and its actions describe what Google shows (unchanged: true).
const gfReadAfter = async (watch, reflected, read) => {
  const after = await gfRead({ quiet_ms: 1000, ...read, changed: () => reflected() && watch.refreshed() });
  if (after.snapshot.settled || !after.snapshot.reasons.includes("change_not_observed")) return { ...after, confirmed: after.snapshot.settled && reflected(), unchanged: false };
  const plain = await gfRead({ ...read, settle_by_ms: Date.now() + 5000 });
  // The new rows may have arrived during this re-read.
  const confirmed = plain.snapshot.settled && reflected() && watch.refreshed();
  return { ...plain, confirmed, unchanged: !confirmed && plain.snapshot.settled };
};
const gfClickAndRead = async (node, reflected, read) => {
  const watch = gfWatch();
  node.click();
  return gfReadAfter(watch, reflected, read);
};

const gfDialog = () => [...document.querySelectorAll('[role="dialog"]')].find(gfVisible) || null;
const gfInputLabel = input => input.getAttribute("aria-label") || gfText(document.querySelector('label[for="' + input.id + '"]')) || input.value || "";

// Opens one filter chip's dialog (Stops, Airlines); null when Google did not show it.
const gfOpenFilter = async name => {
  const chip = gfControls().chips.find(c => c.name === name);
  if (!chip) return null;
  chip.node.click();
  const dialog = await gfWaitFor(() => { const d = gfDialog(); return d && gfText(d).startsWith(name) ? d : null; }, 5000);
  // Google ignores clicks while the dialog is still opening.
  if (dialog) await gfSleep(500);
  return dialog;
};
const gfCloseDialog = async () => {
  const dialog = gfDialog();
  if (!dialog) return true;
  const close = [...dialog.querySelectorAll('button[aria-label="Close dialog"]')].find(gfVisible);
  if (!close) return false;
  close.click();
  return !!await gfWaitFor(() => !gfDialog(), 3000);
};

// Google's sort menu exists only while open; returns its entries, or null when it did not open.
const gfOpenSortMenu = async () => {
  const button = gfControls().sort_button;
  if (!button) return null;
  button.click();
  const items = await gfWaitFor(() => { const list = [...document.querySelectorAll('[role="menuitemradio"]')].filter(gfVisible); return list.length ? list : null; }, 4000);
  return items ? items.map(node => ({ label: gfText(node), checked: node.getAttribute("aria-checked") === "true", disabled: gfDisabled(node), node })) : null;
};
const gfCloseMenu = async () => {
  const target = document.activeElement || document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
  return !!await gfWaitFor(() => ![...document.querySelectorAll('[role="menuitemradio"]')].some(gfVisible), 2000);
};

// Why an action's new list was not confirmed, for its unconfirmed message.
const gfUnconfirmed = after => after.unchanged
  ? "Google's rows are still identical to the list before the click (it may not have re-rendered yet, or the new list is the same), so the new list is not confirmed"
  : "the list did not settle in time (" + after.snapshot.reasons.join(", ") + ")";

// Shared preamble of the page-changing tools: the page must be a settled results list before anything is clicked.
const gfReadyForAction = async (self, read) => {
  const before = await gfRead({ self, settle_by_ms: Date.now() + 15000, ...read });
  return ["wrong_page", "unsupported", "not_ready"].includes(before.envelope.status) ? { refusal: { ...before.envelope, clicked: false }, before } : { refusal: null, before };
};
