// Google Flights page operations shared by the google.com tools that press Google's own controls. Each helper clicks
// at most once per call and reports what the page shows afterwards; callers decide whether that confirms their change.
// Requires lib/google-flights-read.js.

// Watches Google's live region and URL after a click so the old list is not mistaken for the new one.
const gfWatch = () => {
  const startUrl = location.href, started = Date.now();
  let mutated = false, observer = null;
  if (typeof MutationObserver === "function") {
    observer = new MutationObserver(() => { mutated = true; });
    for (const e of document.querySelectorAll("[aria-live]")) observer.observe(e, { childList: true, characterData: true, subtree: true });
  }
  return { refreshed: () => mutated || location.href !== startUrl || Date.now() - started >= 2500, stop: () => observer?.disconnect() };
};

// Polls until test() holds or the deadline passes; returns test()'s last value.
const gfWaitFor = async (test, ms) => {
  const until = Date.now() + ms;
  let value = test();
  while (!value && Date.now() < until) { await gfSleep(150); value = test(); }
  return value;
};

// Clicks once, then reads the list after Google reflects the change (reflected()) and re-announces it.
const gfClickAndRead = async (node, reflected, read) => {
  const watch = gfWatch();
  node.click();
  try { return await gfRead({ ...read, changed: () => reflected() && watch.refreshed() }); } finally { watch.stop(); }
};

const gfDialog = () => [...document.querySelectorAll('[role="dialog"]')].find(gfVisible) || null;
const gfInputLabel = input => input.getAttribute("aria-label") || gfText(document.querySelector('label[for="' + input.id + '"]')) || input.value || "";

// Opens one filter chip's dialog (Stops, Airlines); null when Google did not show it.
const gfOpenFilter = async name => {
  const chip = gfControls().chips.find(c => c.name === name);
  if (!chip) return null;
  chip.node.click();
  return gfWaitFor(() => { const d = gfDialog(); return d && gfText(d).startsWith(name) ? d : null; }, 5000);
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
  return items ? items.map(node => ({ label: gfText(node), checked: node.getAttribute("aria-checked") === "true", node })) : null;
};
const gfCloseMenu = async () => {
  const target = document.activeElement || document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
  return !!await gfWaitFor(() => ![...document.querySelectorAll('[role="menuitemradio"]')].some(gfVisible), 2000);
};

// Shared preamble of the page-changing tools: the page must be a settled results list before anything is clicked.
const gfReadyForAction = async (self, read) => {
  const before = await gfRead({ self, settle_by_ms: Date.now() + 15000, ...read });
  return ["wrong_page", "unsupported", "not_ready"].includes(before.envelope.status) ? { refusal: { ...before.envelope, clicked: false }, before } : { refusal: null, before };
};
