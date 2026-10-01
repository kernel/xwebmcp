# united.com

| tool | description |
|------|-------------|
| get_page_context | Describes the current united.com page: its type, the tools it exposes, whether it is loading or navigating, open fare choices, signed-in state and status level, and suggested next steps. |
| get_trip_summary | Reads United's checkout cart: flights with numbers and aircraft, fare per person, taxes, total due and cart id; never returns traveler details. |
| list_flight_results | Lists the departing or returning flights on United's results page with flight numbers, aircraft and each cabin column's From price, without searching again. |
| login | Signs in to United with a MileagePlus number or email and password, submitting at most once per stage; handles the text-message verification code in otp mode. |
| navigate_to_page | Navigates the tab to a www.united.com path; the description carries a basic site map. |
| search_flights | Searches United cash economy fares for 1-9 adults and returns the outbound itineraries on the results page with flight numbers, times, stops and From prices. |
| select_fare | Opens United's fare options for one flight and cabin and returns each fare's price, carry-on allowance, rules and whether Basic restrictions must be accepted. |
| select_fare_option | Chooses one United fare (Basic Economy only with the user's agreement to its restrictions) and reports whether the return flights or checkout come next. Purchases nothing. |
