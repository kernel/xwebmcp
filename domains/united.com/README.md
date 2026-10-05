# united.com

| tool | description |
|------|-------------|
| continue_checkout | Presses United's continue button for the current checkout step after checking the expected total, up to but never past the payment step. Purchases nothing. |
| get_checkout_step | Reports which United checkout step the page is on, its total due, empty required traveler fields (labels only) and signed-in state. |
| get_page_context | Describes the current united.com page: its type, the tools it exposes, whether it is loading or navigating, open fare choices, signed-in state and status level, and suggested next steps. |
| get_trip_summary | Reads United's checkout cart: flights with numbers and aircraft, fare per person, taxes, priced extras, total due and cart id; never returns traveler details. |
| list_flight_results | Lists the departing or returning flights on United's results page with flight numbers, aircraft and each cabin column's From price, without searching again. |
| list_payment_methods | Lists United's payment methods on the payment step, the selected one, and saved cards (brand and last four) when signed in. |
| list_seat_map | Reads United's checkout seat map for one flight: seats with type, position, price and features, and each traveler's chosen seat. |
| list_travel_add_ons | Lists United's bundle offers, Premier Access and the trip insurance question on the current checkout step with prices, selection state and total due. |
| login | Signs in to United with a MileagePlus number or email and password, submitting at most once per stage; handles the text-message verification code in otp mode. |
| navigate_to_page | Navigates the tab to a www.united.com path; the description carries a basic site map. |
| search_flights | Searches United cash economy fares for 1-9 adults and returns the outbound itineraries on the results page with flight numbers, times, stops and From prices. |
| select_fare | Opens United's fare options for one flight and cabin and returns each fare's price, carry-on allowance, rules and whether Basic restrictions must be accepted. |
| select_fare_option | Chooses one United fare (Basic Economy only with the user's agreement to its restrictions) and reports whether the return flights or checkout come next. Purchases nothing. |
| select_payment_method | Chooses which payment method United's payment step shows after checking the current method and total; never types card data or purchases. |
| select_saved_payment_method | Chooses a card saved in the signed-in MileagePlus wallet by its last four digits after checking the total, or reports that sign-in is required. Purchases nothing. |
| select_seat | Chooses or releases one seat for a traveler on United's seat map after checking the agreed price. Purchases nothing. |
| set_travel_add_on | Adds or removes one United bundle offer or Premier Access after checking the agreed price and total due. Purchases nothing. |
| set_trip_protection | Accepts or declines United's trip insurance offer after checking the quoted premium and total due. Purchases nothing. |
