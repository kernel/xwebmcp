# southwest.com

| tool | description |
|------|-------------|
| continue_checkout | Presses Southwest's continue control for the current booking step after checking the fare, required fields and trip total. Never acts on the payment page or presses Purchase. |
| get_page_context | Describes the current Southwest page, checkout step, sign-in state, missing required passenger fields and suggested next steps. |
| get_trip_summary | Reads flights, fares, taxes and the trip total on the price or payment page, held seats on the payment page, and seat charges and total on the seats page. |
| list_flight_results | Reads every flight row on the current departing or returning results page with each fare's price and availability. |
| list_payment_methods | Reads the pay options, applicable funds, saved cards and opt-in checkbox states on the payment page. |
| list_seat_map | Reads the seat map for the current flight with prices, seat types, availability and each passenger's seat. |
| login | Signs in to Southwest with account number or username and password, submitting at most once. |
| search_flights | Searches Southwest cash fares for 1–9 adults and returns every row on the first outbound results page. |
| select_fare | Selects, changes or clears one fare for a flight row and returns every fare's benefits. |
| select_payment_method | Switches between Credit/Debit and PayPal and unchecks save-card and marketing opt-ins, without entering card details. |
| select_seat | Holds or releases one seat for one passenger on the current flight after checking its price. |
