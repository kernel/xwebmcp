# kroger.com

| tool | description |
|------|-------------|
| add_to_cart | Adds a product by UPC to the signed-in account's active cart after checking it is sellable and within the quantity limit. |
| get_cart | Reads the signed-in account's active cart: store, fulfillment method, priced lines with substitution policy, saved-for-later items and subtotal. |
| get_delivery_slots | Lists the delivery windows, providers and fees Kroger quotes for the active cart; never selects or reserves a window. |
| get_order | Opens one order's page and returns its status, window, modify/cancel flags, items, fees and totals; read-only. |
| get_page_context | Describes the current Kroger page: page type, sign-in, shopping mode, cart count, order id and suggested next tools. |
| get_product | Looks up one product by UPC and returns its description, size, price, promotion, availability and order limit for the selected store. |
| list_orders | Lists in-progress orders with the site's modify/cancel flags and one page of purchase history; read-only. |
| login | Signs in to a Kroger account with email and password, entering through a DuckDuckGo search; confirms an existing session without submitting. |
| search_products | Searches the Kroger catalog for the selected store and fulfillment method and returns the first results page with UPCs, prices and availability. |
| set_substitution_preference | Turns Best available substitutions on or off for one active cart line without changing its quantity. |
| update_cart_item | Sets the absolute quantity of a product already in the active cart; 0 removes the line. |
