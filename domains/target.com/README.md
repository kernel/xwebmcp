# target.com

| tool | description |
|------|-------------|
| add_to_cart | Adds an orderable item by tcin to the session's cart for shipping or store pickup, after checking availability and limits, and returns the new cart subtotal. |
| get_cart | Reads the session's cart: every line with tcin, quantity, price, fulfillment and stock, plus subtotal and estimated total. |
| get_product | Reads one item by tcin: price, rating, purchase limit, its variations and fulfillment availability. |
| get_store_context | Reports the session's selected store, location, nearby stores and guest or signed-in state without changing anything. |
| remove_cart_item | Removes one cart line and returns what was removed so it can be re-added. |
| search_products | Searches the Target catalog and returns one results page, with optional sorting and site filters by name or id. |
| update_cart_item | Sets the absolute quantity of one cart line within its purchase limit. |
