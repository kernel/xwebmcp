# aa.com

| tool | description |
|------|-------------|
| continue_checkout | Presses American's continue button for the current checkout step after checking the expected total, up to but never past payment selection. Purchases nothing. |
| get_checkout_step | Reports the American checkout step, its total, empty required field labels, the trip insurance answer, the selected payment method and whether a CVV is still required. |
| get_fare_options | Reads the cash or award cabin fares and the loaded nearby-date calendar on the current American results page, with pagination; never selects a fare. |
| get_flight_status | Looks up the status of one American-marketed flight number on an origin-local date with one same-origin request; public, no passenger data. |
| get_page_context | Describes the current aa.com page: its booking step, loading or pending navigation, signed-in state, total, open dialogs and suggested next tools. |
| get_trip_summary | Reads the flights, fare, base fare, tax lines and total due on Your trip summary, Passengers or Review and pay; never returns traveler details. |
| list_flight_results | Lists the departing or returning flights on American's results page with flight numbers, aircraft and each fare group's from-price, without searching again. |
| list_payment_methods | Lists American's payment methods on Review and pay, the selected one, and saved cards (brand and last four) of the signed-in member. |
| list_seat_map | Reads American's seat map for the current flight: available seats with type, features and cash price, and each passenger's seat. |
| list_trip_extras | Lists the offers on American's Trip extras page: Mileage Multiplier bonus miles (never bought) or prepaid checked bags with prices and counts. |
| login | Signs in to an American Airlines AAdvantage account, entering through a DuckDuckGo search and submitting the login form at most once. |
| prepare_itinerary | Re-reads one exact option from the current American results page as a preview for a human handoff; never selects, books or holds. |
| search_flights | Searches American Airlines cash fares, or award miles plus taxes with pay_with: miles, for 1–9 adults and returns the first-page outbound options with per-person from-fares. |
| select_fare | Opens one fare group for a flight row and returns each fare's price, bag, seat and change disclosures, refund options and whether Basic Economy consent is needed. |
| select_fare_option | Chooses one American fare (Basic Economy only with the user's agreement to its restrictions) and schedules the move to the return flights or trip summary. Purchases nothing. |
| select_payment_method | Chooses a saved AAdvantage card by last four digits or another payment method after checking the total; never types card data, holds or purchases. |
| select_seat | Chooses one seat for a passenger on American's seat map after checking the agreed price. Purchases nothing. |
| set_checked_bags | Sets a passenger's prepaid checked bags on American's Trip extras page after checking the expected extras total. Purchases nothing. |
| set_trip_protection | Accepts or declines American's required trip insurance question after checking the quoted premium. Purchases nothing. |
| skip_seat_selection | Leaves American's seat map through its Skip seats for all flights link without choosing seats. |
