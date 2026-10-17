# booking.com

| tool | description |
|------|-------------|
| continue_checkout | Presses "Next: Final details" on the checkout's details step after checking the total, required fields and that the selection holds the party; never books or pays. |
| fill_guest_details | Types the main guest's name, email, phone and address into the checkout's details step; presses nothing. |
| get_checkout_step | Reads Booking.com's checkout page, including a Partner Offer's partner checkout: the step, property, dates, selected rooms, any warning that they cannot hold the party and the total including taxes and fees. |
| get_property | Reads one property's dated room rates that hold the party's adults, with IDs, adult and child places, whether they fit every child, cancellation, prepayment, meals and excluded fees, plus its address, reviews and check-in and check-out times. |
| search_stays | Searches stays for a destination, dates and party in the site's current currency and returns the first results page with prices and reviews. |
| select_room | Selects one room of an exact rate, including a Partner Offer, on the open property page for the expected party and presses "I'll reserve", which opens the details step without booking. |
