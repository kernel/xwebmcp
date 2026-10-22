# doordash.com

| tool | description |
|------|-------------|
| create_business_profile | Creates the signed-in account's business profile with a receipt email and a new credit/debit card as the business payment method. |
| get_cart | Read open DoorDash carts, line ids/options/quantities, currency and provisional subtotal/total/fee lines from the current authorized session. |
| get_checkout_summary | Prepare a read-only DoorDash order summary for an exact open cart: lines, provisional fees/totals, currency and explicit delivery context, plus a manually opened checkout URL. |
| get_store | Reads one DoorDash store by store_id: details, hours, menus, and whether delivery and pickup can be ordered now with the site's estimate and delivery-fee text. |
| login | Signs in to a DoorDash consumer account with email and password, or submits a visible six-digit verification code; confirms an existing session without submitting. |
| register | Creates a DoorDash consumer account from the email sign-up form, or submits a visible six-digit sign-up verification code; refuses when already signed in. |
| remove_cart_item | Remove exactly one existing line from an ordinary personal DoorDash cart using the site's removeCartItem operation. |
| save_address | Makes a delivery address the account's current default: selects it if already saved, otherwise adds it from DoorDash's autocomplete with optional details. |
| set_delivery_address | Sets a signed-out visit's delivery address from DoorDash's address autocomplete, as the header's address picker does, and confirms it from the site's answer. |
