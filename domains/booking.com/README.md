# booking.com

| tool | description |
|------|-------------|
| continue_checkout | Presses "Next: Final details" on the checkout's details step after checking the total and required fields; never books or pays. |
| fill_guest_details | Types the main guest's name, email, phone and address into the checkout's details step; presses nothing. |
| get_checkout_step | Reads Booking.com's checkout page, including a Partner Offer's partner checkout: the step, property, dates, selected rooms and the total including taxes and fees. |
| get_property | Reads one property's address, reviews, facilities, highlights, description and house rules, and with dates its room rates with IDs, cancellation, prepayment, meals and excluded fees. |
| search_stays | Searches stays for a destination or property name, optional dates and party in the site's current currency and returns the first results page with prices and reviews. |
| select_room | Selects one room of an exact rate, including a Partner Offer, on the open property page and presses "I'll reserve", which opens the details step without booking. |
