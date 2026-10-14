# instacart.com

| tool | description |
|------|-------------|
| add_to_cart | Adds an item to the logged-in account's cart for one store, or increases its quantity, after checking availability and quantity rules. |
| complete_registration | Finishes an Instacart sign-up started by register by typing the verification code once and confirming the new account. |
| get_cart | Reads the logged-in account's cart for one store, or summarizes every non-empty cart across stores. |
| get_delivery_address | Reads the delivery address the session shops for and every address saved on the account. |
| get_item | Reads one item's price, availability, stock level, quantity rules and rating for a store. |
| list_payment_methods | Lists the payment methods saved on the account and marks the one checkout will use. |
| list_stores | Lists the stores serving the account's current address with the store slug the other tools take. |
| login | Logs in with an email address through Instacart's passwordless email-code flow, one step per call. |
| register | Starts a new Instacart account from the signup page and stops at the verification-code step. |
| resume_registration | Reports where a sign-up in the current tab stands without submitting, resending or navigating. |
| search | Searches one store's catalog and returns the first results page with item ids, prices, availability and quantity rules. |
| select_payment_method | Makes one saved payment method the one checkout charges, without placing an order. |
| set_delivery_address | Switches the session's delivery address to one of the account's saved addresses. |
| update_cart_item | Sets an item in one store's cart to an exact quantity; 0 removes it. |
