# myntra.com

| tool | description |
|------|-------------|
| add_to_cart | Add exactly one ordinary merchandise SKU to the current signed-out guest Myntra bag, without navigation. |
| get_cart | Read the current signed-out guest Myntra bag without navigation: at most 100 lines with item_id, style_id, sku_id, seller_id, quantity, checkout selection and INR line totals. |
| get_product | Reads one Myntra product by style_id: price and MRP, rating, sizes with SKU ids and stock, seller, colour variants, attributes and return flags. |
| get_product_reviews | Read public customer reviews of one Myntra (myntra.com) product by style_id, 12 per page, sorted by most helpful or most recent and optionally limited to one star rating. |
| remove_cart_item | Remove exactly one line from the signed-out guest Myntra bag, without navigation. |
| search_products | Searches the Myntra catalog by keywords with the site's sort options, filters and price range, returning one page of organic results and a cursor. |
| update_cart_item | Set one existing signed-out guest bag line to quantity 1–10 without changing SKU, seller or checkout selection. |
