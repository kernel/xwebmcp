# google.com

| tool | description |
|------|-------------|
| continue_to_airline | On Google Flights' booking page, presses Continue for one seller's fare; the airline's checkout opens in a new tab of the session with the flights in its cart. Books nothing. |
| get_booking_options | Reads Google Flights' booking options for the chosen flights: each seller's fares with price, carry-on and checked-bag allowance, and features. |
| get_flight_details | Opens Google Flights' flight-details panel for the row named by a selection_ref and returns its segments, aircraft, cabin, amenities, layovers and bags. |
| get_page_context | Describes the current Google Travel page without changing it: page type, loading state, search and leg, Google's view, sort and filters, and the available actions with valid inputs. |
| list_flights | Reads the departing or returning flights exactly as the Google Flights results page shows them, in page order with sections and selection_refs; never clicks or expands anything. |
| search_flights | Searches Google Flights and returns the initial Best or Cheapest results Google shows, unexpanded, with selection_refs and the available next actions. |
| select_flight | Chooses the departing or returning flight named by a selection_ref after checking the search, leg, chosen departing flight, itinerary and price, and reports the next step only once Google has settled on it. Books nothing. |
| set_flight_filters | Sets Google Flights' own Stops and Airlines filters through their chips and returns the re-rendered list. |
| set_flight_sort | Chooses an entry in Google Flights' sort menu (top flights, price, departure or arrival time, duration, emissions) and returns the re-sorted list. |
| set_results_view | Switches Google Flights' Best/Cheapest results tab and returns that view's initial rows. |
| show_more_flights | Clicks Google Flights' 'View more flights' once and returns the expanded list; refuses when Google shows no such control. |
