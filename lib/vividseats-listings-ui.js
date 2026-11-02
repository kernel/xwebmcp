// Vivid Seats event-page operations shared by the vividseats.com tools that press the page's own controls. The page opens
// its quantity, price, perks and sort menus while the mouse is over their button and closes them when it leaves, so each
// helper sends the events a person's mouse sends, presses one control once, and reports what the page shows afterwards.
// Requires lib/vividseats-listings-read.js.
const vslMouse = (node, types, init = {}) => {
  const r = node.getBoundingClientRect?.() || { x: 0, y: 0, width: 0, height: 0 };
  const base = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0, pointerId: 1, isPrimary: true, pointerType: "mouse", ...init };
  for (const type of types) {
    const Event = type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
    node.dispatchEvent(new Event(type, { ...base, bubbles: base.bubbles && !/(enter|leave)$/.test(type) }));
  }
};
const vslHover = node => vslMouse(node, ["pointerover", "pointerenter", "mouseover", "mouseenter"]);
const vslLeave = node => vslMouse(node, ["pointerout", "pointerleave", "mouseout", "mouseleave"], { relatedTarget: document.body });
// A full press: some of the page's controls act on pointer events rather than click().
const vslPress = node => vslMouse(node, ["pointerdown", "mousedown", "pointerup", "mouseup", "click"], { buttons: 1 });

// Opens a hover menu and returns the node that appears (found by find()), or null when the page did not show it.
const vslOpenMenu = async (button, find) => {
  if (!button) return null;
  vslHover(button);
  return await vslWaitFor(() => { const n = find(); return vslVisible(n) ? n : null; }, 3000);
};
const vslCloseMenu = async (button, find) => {
  if (!button) return true;
  vslLeave(button);
  if (!vslVisible(find())) return true;
  vslLeave(button.parentElement);
  return !!await vslWaitFor(() => !vslVisible(find()), 2000);
};

// Types a dollar amount into one of the price menu's boxes and presses Enter, as the page applies it then.
const vslTypeAmount = (input, amount) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  input.focus();
  setter.call(input, String(amount));
  input.dispatchEvent(new Event("input", { bubbles: true }));
  for (const type of ["keydown", "keypress", "keyup"]) input.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, charCode: type === "keypress" ? 13 : 0, bubbles: true, cancelable: true }));
};

// Evidence that the panel showed a new list after a press: its rows or its count differ from before. A URL change alone
// does not count; the page updates its query first.
const vslWatch = () => {
  const before = vslRowsKey() + "|" + vslCountText();
  return { changed: () => vslRowsKey() + "|" + vslCountText() !== before };
};
// Reads the page after an action. confirmed: the page reflects the change (reflected()) and its panel showed a new list
// or its error. unchanged: the page reflects the change but the list is identical to the one before.
const vslReadAfter = async (watch, reflected, read) => {
  await vslWaitFor(() => reflected() && (watch.changed() || vslPanelError()), 8000);
  const after = await vslRead(read);
  const changed = watch.changed() || after.snapshot.state === "error";
  return { ...after, confirmed: reflected() && changed, unchanged: reflected() && !changed };
};

// Shared preamble of the page-changing tools: the panel must have settled before anything is pressed.
const vslReadyForAction = async (self, read, { prompt_ok = false } = {}) => {
  const before = await vslRead({ self, ...read });
  const s = before.snapshot;
  const refuse = (status, message) => ({ refusal: { ...before.envelope, status, clicked: false, message: message + " Nothing was pressed." }, before });
  if (before.envelope.status === "wrong_page") return { refusal: { ...before.envelope, clicked: false }, before };
  if (s.state === "error") return refuse("not_ready", VSL_GATED);
  if (s.state === "loading") return refuse("not_ready", "The listings panel has not shown listings or a count yet; try again in a few seconds.");
  if (s.page.quantity_prompt && !prompt_ok) return refuse("unavailable", "The page asks 'How many tickets?' over the listings; answer it with set_ticket_quantity first.");
  return { refusal: null, before };
};
