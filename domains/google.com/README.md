# google.com

| tool | description |
|------|-------------|
| continue_to_airline | On Google Flights' booking page, presses Continue for one seller's fare; the airline's checkout opens in a new tab of the session with the flights in its cart. Books nothing. |
| get_booking_options | Reads Google Flights' booking options for the chosen flights: each seller's fares with price, carry-on and checked-bag allowance, and features. |
| get_page_context | Describes the current Google Flights page: its type, the tools it exposes, whether it is still loading, the chosen flights and suggested next steps. |
| list_flights | Lists the departing flights, or the returning flights Google offers for the chosen departing flight, on the current Google Flights results page once Google has settled the list, without searching again. Each row has a selection_ref for select_flight, flight numbers, segments, layovers, ISO dates, airport-local times, price scope and bags. |
| search_flights | Searches Google Flights across airlines and returns outbound itineraries with flight numbers, times, stops, layovers, emissions, total prices and a selection_ref for select_flight. Supports max_stops (0 for nonstop), applied before the result limit, and warns when results are incomplete. |
| select_flight | Chooses the departing or returning flight named by a selection_ref after checking the search, leg, chosen departing flight, itinerary and price, and reports the next step only once Google has settled on it: returning flights or booking options. Books nothing. |
