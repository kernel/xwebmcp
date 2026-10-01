# kroger.com

| tool | description |
|------|-------------|
| add_to_cart | Adds a product by UPC to the signed-in account's active cart after checking it is sellable and within the quantity limit. |
| get_cart | Reads the signed-in account's active cart: store, fulfillment method, priced lines, saved-for-later items and subtotal. |
| get_product | Looks up one product by UPC and returns its description, size, price, promotion, availability and order limit for the selected store. |
| login | Signs in to a Kroger account with email and password, entering through a DuckDuckGo search; confirms an existing session without submitting. |
| search_products | Searches the Kroger catalog for the selected store and fulfillment method and returns the first results page with UPCs, prices and availability. |
| update_cart_item | Sets the absolute quantity of a product already in the active cart; 0 removes the line. |
