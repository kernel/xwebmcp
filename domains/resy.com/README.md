# resy.com

| tool | description |
|------|-------------|
| book_reservation | Books one exact quoted slot when the user asked, after checking the total still matches the quote and no reservation exists at the venue that day. |
| cancel_reservation | Cancels one upcoming reservation when the user asked, stopping first if a cancellation fee applies or cannot be read. |
| change_reservation | Moves one upcoming reservation to another exact slot at the same venue, like Resy's Modify. |
| close_booking_dialog | Closes Resy's open booking window without booking. |
| copy_list | Copies a shared Resy list into the account as a new private list. |
| create_list | Creates one private custom list, refusing a duplicate name unless allowed. |
| create_notify | Turns on Resy Notify for a venue, date, party and service within the window Resy offers; never holds or books. |
| delete_list | Deletes one custom list when the user asked; My Hit List cannot be deleted. |
| get_account_status | Returns an opaque reference to the signed-in account that the account tools use to detect an account switch. |
| get_availability | Lists one venue's open slots for a date and party size, with each distinct cancellation and payment policy listed once. |
| get_availability_calendar | Shows per-date reservation availability for one venue over a date range. |
| get_booking_quote | Quotes one exact slot's total, fees, card requirement and cancellation terms without holding it. |
| get_collection | Lists one page of a curated collection's venues with their open slots for a date and party size. |
| get_list | Reads one page of venues on one of the account's lists, including My Hit List. |
| get_page_context | Describes the current Resy page: page type, city, venue, date and party size, live tools, loading state, an open booking or log-in window, sign-in state and next steps. |
| get_reservation | Reads one reservation from a page of the account's reservations. |
| get_restaurant | Reads one venue's public profile by URL or slugs. |
| get_share_link | Returns the share URL for one of the account's lists without changing it. |
| get_venues | Looks up up to 20 venues by id. |
| list_collections | Lists a city's curated collections, such as Climbing, Top Rated and New on Resy. |
| list_events | Lists ticketed events for a venue or a city, with a handoff URL for booking. |
| list_lists | Lists My Hit List and the account's custom lists, optionally with whether each contains a venue. |
| list_notify_requests | Lists the account's Notify requests and their time windows. |
| list_reservations | Lists one page of the account's upcoming or past reservations. |
| login | Signs in with the email and password the user supplied, then reloads so Resy restores the session. |
| navigate_to_page | Navigates the tab to a path on resy.com, with a short site map of venue, list, event and account pages. |
| open_booking_dialog | Opens Resy's booking window for one exact slot on a venue page and reads its time, card, price and cancellation terms, stopping before Reserve Now. |
| rate_reservation | Submits the user's 1 to 5 rating for one past reservation. |
| remove_notify | Turns off one Notify request when the user asked. |
| search_restaurants | Searches Resy venues by keyword, cuisine and place, optionally with open slots for a date. |
| set_favorite | Adds or removes one venue on My Hit List, checking the observed state first. |
| set_list_membership | Adds or removes one venue on one custom list, checking the observed state first. |
