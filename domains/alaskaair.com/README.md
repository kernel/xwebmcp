# alaskaair.com

| tool | description |
|------|-------------|
| continue_checkout | Presses Alaska's forward button for the current booking step (Add to cart, Continue to checkout, Travelers Continue, Seats skip/next/save) after checking the expected total. Never presses "Book now". |
| get_checkout_step | Reports the Alaska booking step, total due, empty required traveler fields (labels only), trip protection answer and chosen payment method. |
| get_page_context | Describes the current alaskaair.com page: its type, open fare dialog, loading state, signed-in state, cart hold time, exposed tools and suggested next steps. |
| get_trip_summary | Reads Alaska's trip summary, cart or checkout price summary: flights, fare and booking class, price lines, included taxes and fees, total and fare notes; never traveler details. |
| list_flight_results | Lists the departing or returning flights on Alaska's results page with each fare column's displayed price, without searching again. |
| list_payment_methods | Lists Alaska's payment methods on Review & pay, the chosen one, accepted card brands and saved cards (brand and last four) when shown. |
| list_seat_map | Reads Alaska's seat map for the current flight: seat types, positions, per-type price ranges, each traveler's seat and price, and the totals. |
| login | Signs in to Alaska (Atmos Rewards) with a user ID or account number and password, submitting at most once; reports CAPTCHA and code steps instead of solving them. |
| respond_fare_offer | Answers Alaska's Saver-restrictions or refundable-itinerary dialog (continue with Saver only with the user's agreement, upgrade, decline or accept) after checking the price shown. |
| search_flights | Searches Alaska Airlines cash fares for adults and returns the first page of outbound options with displayed per-adult starting fares. |
| select_fare | Chooses one Alaska fare tile for a flight after checking its price and reports the dialog, return flights or trip summary that follows, including Saver restrictions. |
| select_payment_method | Opens Alaska's credit/debit card option (or a saved card by last four) or returns to the method list after checking the total; never types card data. |
| select_seat | Chooses or releases a seat for the active traveler on Alaska's seat map within an agreed maximum price, releasing it again if the price is higher. |
| set_trip_protection | Accepts or declines Alaska's trip protection (Allianz) after checking the quoted premium, and verifies the new total. |
