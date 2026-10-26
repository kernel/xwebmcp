// Cart readers shared by the target.com cart tools.
const CART_FIELDS = "field_groups=CART%2CCART_ITEMS%2CSUMMARY";
const line = item => {
  const f = item.fulfillment || {};
  const attrs = item.item_attributes || {};
  return {
    cart_item_id: String(item.cart_item_id), tcin: String(item.tcin), title: decode(attrs.description) || null, quantity: item.quantity,
    unit_price_cents: cents(item.current_price ?? item.unit_price), list_price_cents: cents(item.list_price) || null,
    fulfillment: { type: f.type || null, ship_method: f.ship_method || null, location_id: f.location_id ? String(f.location_id) : null, location_name: f.location_name || null },
    availability_status: (item.inventory_info || {}).availability_status || null,
    max_purchase_quantity: Number.isInteger(attrs.max_purchase_quantity) ? attrs.max_purchase_quantity : null
  };
};
const readCart = async ctx => {
  const r = await call(CARTS + "cart?cart_type=REGULAR&" + CART_FIELDS + "&key=" + encodeURIComponent(ctx.key));
  if (blocked(r)) return { error: fail("challenge", CHALLENGE) };
  // 204 means this session has never had a cart; it reads as an empty cart.
  if (r.status === 204 || (r.status === 404 && !siteMessage(r.json))) return { cart: { id: null, lines: [], summary: null } };
  if (r.status !== 200 || !r.json) return { error: fail("site_error", "Target's cart service answered HTTP " + r.status + (siteMessage(r.json) ? ": " + siteMessage(r.json) : "") + ". Nothing was changed.") };
  return { cart: parseCart(r.json) };
};
const parseCart = json => ({
  id: json.cart_id ? String(json.cart_id) : null,
  lines: (Array.isArray(json.cart_items) ? json.cart_items : []).filter(i => i && i.cart_item_id && i.tcin && Number.isInteger(i.quantity) && i.quantity > 0).map(line),
  summary: json.summary || null
});
const units = cart => cart.lines.reduce((sum, l) => sum + l.quantity, 0);
