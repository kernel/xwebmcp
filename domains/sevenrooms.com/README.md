# sevenrooms.com

| tool | description |
|------|-------------|
| get_availability | Lists the bookable table times SevenRooms' booking widget shows for one venue, date and party size, with labels, duration, card requirements and the venue's policies. |
| get_restaurant | Reads one SevenRooms venue's public booking-widget details: identifiers, contact details, currency, party sizes, booking window and service-day start. |
| list_experiences | List the public experience/offer directory for one SevenRooms venue, including its landing_url_key, plain public description and displayed price text. |
| prepare_reservation | Prepare one exact standard dining reservation target from get_availability: venue_url_key, service date, party_size, local_start, label and description_title (both nullable). |
| search_events | Discover scheduled public event occurrences for one SevenRooms venue in a bounded relative-day window (inclusive offsets from the site's current day, at most 31 days, within the next 366). |
