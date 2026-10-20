# delta.com

| tool | description |
|------|-------------|
| continue_checkout | Continues one standard or express checkout section after confirmation and a fresh total check; never presses Complete Purchase. |
| continue_to_review_and_pay | Opens Review and Pay from legacy Trip Summary after confirmation and a fresh total check. |
| get_checkout_step | Reads the active standard or express checkout section, missing required field labels including CVV, seats, totals, insurance options and purchase-button visibility. |
| get_page_context | Describes the current Delta page, loading state, alerts and suggested next steps. |
| get_trip_summary | Reads itinerary, passengers, price breakdown, amount due and refundability in both Delta checkout versions. |
| list_flight_results | Lists rendered flight itineraries and fare columns without searching again. |
| list_payment_methods | Lists payment choices and masked saved cards for a signed-in member; otherwise returns login_required. |
| list_seat_map | Reads the current flight, cabins, seat availability and passenger seat assignments. |
| login | Opens the homepage login flyout, fills credentials and schedules one login submission. |
| navigate_to_page | Schedules navigation to a page on www.delta.com. |
| open_seat_map | Opens Select Seats or Change Seats from the redesigned Trip Summary without choosing a seat. |
| search_flights | Searches cash fares for 1–9 adults and returns first-page outbound options. |
| select_fare | Chooses a fare column on a results itinerary using result_index and brand_code. |
| select_fare_experience | Chooses an experience in the fare drawer and schedules navigation to return results or Trip Summary. |
| select_saved_payment_method | Selects an already-saved card by last four digits after confirmation and a total check; never enters card data. |
| select_seat | Holds a seat for the active passenger after confirmation, checking current fees and the approved extra-fee limit. |
| set_trip_protection | Selects explicit insurance acceptance or decline after confirmation and a total check; repricing remains unconfirmed. |
| skip_seat_selection | Cancels out of the seat map without saving new selections. |
