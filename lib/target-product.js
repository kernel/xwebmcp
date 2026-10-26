// Product and availability readers shared by get_product and add_to_cart.
const AVAILABLE = /^(IN_STOCK|LIMITED_STOCK|PRE_ORDER_SELLABLE)$/;
const fulfillmentFor = async (ctx, tcin) => {
  const r = await redsky("product_fulfillment_v1", {
    key: ctx.key, channel: "WEB", tcin, store_id: ctx.store.store_id, zip: ctx.location.postal_code || ctx.store.postal_code, state: ctx.location.state,
    latitude: ctx.location.latitude, longitude: ctx.location.longitude, scheduled_delivery_store_id: ctx.store.store_id, required_store_id: ctx.store.store_id,
    paid_membership: "false", base_membership: "false", card_membership: "false", visitor_id: ctx.visitorId
  });
  if (r.error) return r;
  const f = r.json && r.json.data && r.json.data.product && r.json.data.product.fulfillment;
  if (r.status === 404) return { error: fail("not_found", "Target has no item with tcin " + tcin + ".") };
  if (r.status >= 300 || !f) return { error: fail("site_error", "Target's availability service answered HTTP " + r.status + (siteMessage(r.json) ? ": " + siteMessage(r.json) : "") + ".") };
  const store = (f.store_options || []).find(s => String(s.location_id) === ctx.store.store_id) || {};
  const ship = f.shipping_options || {};
  const services = Array.isArray(ship.services) ? ship.services : [];
  const base = services.find(s => s && s.is_base_shipping_method) || services[0] || {};
  const status = value => typeof value === "string" ? value : null;
  const shipping = { status: status(ship.availability_status), available: AVAILABLE.test(ship.availability_status || ""), min_delivery_date: base.min_delivery_date || null, max_delivery_date: base.max_delivery_date || null };
  const pickup = { status: status((store.order_pickup || {}).availability_status), available: AVAILABLE.test((store.order_pickup || {}).availability_status || ""), pickup_date: (store.order_pickup || {}).pickup_date || null };
  const position = ((r.json.data.product.store_positions || [])[0]) || null;
  return {
    fulfillment: {
      store: ctx.store, sold_out: !!f.sold_out, shipping, pickup,
      in_store: { status: status((store.in_store_only || {}).availability_status), available: AVAILABLE.test((store.in_store_only || {}).availability_status || ""), aisle: position && position.aisle !== undefined ? String(position.aisle) + (position.block ? position.block : "") : null },
      same_day_delivery: { status: status((f.scheduled_delivery || {}).availability_status), available: AVAILABLE.test((f.scheduled_delivery || {}).availability_status || "") }
    }
  };
};
const productFor = async (ctx, tcin) => {
  const r = await redsky("pdp_client_v1", {
    key: ctx.key, channel: "WEB", tcin, is_bot: "false", store_id: ctx.store.store_id, pricing_store_id: ctx.store.store_id, has_pricing_store_id: "true",
    has_financing_options: "true", include_obsolete: "true", visitor_id: ctx.visitorId, skip_personalized: "true", skip_variation_hierarchy: "false",
    page: "/p/A-" + tcin, zip: ctx.location.postal_code || ctx.store.postal_code, state: ctx.location.state, latitude: ctx.location.latitude, longitude: ctx.location.longitude
  });
  if (r.error) return r;
  const product = r.json && r.json.data && r.json.data.product;
  if (r.status === 404 || (r.status < 300 && !product)) return { error: fail("not_found", "Target has no item with tcin " + tcin + ".") };
  if (r.status >= 300 || !product) return { error: fail("site_error", "Target's product service answered HTTP " + r.status + (siteMessage(r.json) ? ": " + siteMessage(r.json) : "") + ".") };
  const children = Array.isArray(product.children) ? product.children : [];
  const leaves = [];
  const walk = (nodes, attrs) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!node || typeof node.name !== "string") continue;
      const next = Object.assign({}, attrs, { [node.name]: String(node.value) });
      if (node.tcin) leaves.push({ tcin: String(node.tcin), attributes: next, url: node.buy_url || null, availability: node.availability || node.fulfillment || {} });
      walk(node.variation_hierarchy, next);
    }
  };
  walk(product.variation_hierarchy, {});
  const isParent = String(product.tcin) === tcin && (children.length > 0 || leaves.length > 0);
  const selected = String(product.tcin) === tcin ? product : children.find(c => c && String(c.tcin) === tcin);
  if (!selected) return { error: fail("not_found", "Target returned item " + product.tcin + " for tcin " + tcin + " but not that variation.") };
  const item = selected.item || {};
  const family = product.item || {};
  const priceOf = p => {
    const price = (p && p.price) || {};
    const text = typeof price.formatted_current_price === "string" ? price.formatted_current_price : null;
    const first = text ? /\$([\d,]+(?:\.\d{1,2})?)/.exec(text) : null;
    return {
      current_cents: cents(price.current_retail ?? price.current_retail_min) ?? (first ? Math.round(Number(first[1].replace(/,/g, "")) * 100) : null),
      regular_cents: cents(price.reg_retail ?? price.reg_retail_min), text, type: price.formatted_current_price_type || null, is_range: !!text && text.indexOf("-") !== -1
    };
  };
  const limitOf = f => f && Number.isInteger(f.purchase_limit) ? f.purchase_limit : null;
  const variants = leaves.map(leaf => {
    const child = children.find(c => c && String(c.tcin) === leaf.tcin) || {};
    const av = leaf.availability;
    return {
      tcin: leaf.tcin, attributes: leaf.attributes, price_cents: priceOf(child).current_cents,
      orderable: !av.is_sold_out && !!(av.is_shipping_available || av.is_primary_store_available || av.is_backup_store_available || av.is_scheduled_delivery_available)
    };
  });
  const themes = [];
  for (const v of variants) for (const [name, value] of Object.entries(v.attributes)) {
    let theme = themes.find(t => t.name === name);
    if (!theme) themes.push(theme = { name, values: [] });
    if (!theme.values.includes(value)) theme.values.push(value);
  }
  const rating = ((product.ratings_and_reviews || {}).statistics || {}).rating || {};
  const bulletList = (((family.product_description || {}).soft_bullets || (item.product_description || {}).soft_bullets || {}).bullets);
  const bullets = Array.isArray(bulletList) ? bulletList : [];
  return {
    product: {
      tcin, parent_tcin: String(product.tcin) !== tcin || isParent ? String(product.tcin) : null, is_variation_parent: isParent,
      title: decode((item.product_description || {}).title) || decode((family.product_description || {}).title) || "Untitled item",
      brand: decode((item.primary_brand || family.primary_brand || {}).name) || null,
      url: (item.enrichment || {}).buy_url || (family.enrichment || {}).buy_url || null,
      image_url: (((item.enrichment || family.enrichment || {}).image_info || {}).primary_image || {}).url || null,
      price: priceOf(selected), rating_average: typeof rating.average === "number" ? rating.average : null, rating_count: Number.isInteger(rating.count) ? rating.count : null,
      purchase_limit: limitOf(item.fulfillment) ?? limitOf(family.fulfillment), is_marketplace: !!((item.fulfillment || family.fulfillment || {}).is_marketplace),
      highlights: bullets.filter(b => typeof b === "string").slice(0, 6).map(b => decode(b.replace(/<[^>]+>/g, "")).slice(0, 300)),
      selected_variation: (leaves.find(l => l.tcin === tcin) || {}).attributes || {},
      variation_themes: themes, variants
    }
  };
};
