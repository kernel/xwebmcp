# opentable.com

| tool | description |
|------|-------------|
| get_account_summary | Read the authorized OpenTable account’s current dining points, points eligibility and counts of upcoming/past reservations and invitations in the current dashboard page. |
| get_availability | Read current standard table availability for one restaurant_id from search_restaurants, with restaurant-local date/time, party_size and a window of up to 120 minutes either side. |
| get_restaurant | Reads one OpenTable restaurant's profile by restaurant_id or url: details, hours, booking limits, ratings, awards and the site's review summary. |
| get_reviews | Reads one page of diner reviews for an OpenTable restaurant in the site's default order, which follows the dining date. |
| list_saved_restaurants | Read the explicitly authorized OpenTable account’s Favorites restaurant IDs, 50 per page, with total_count and has_more. |
| prepare_reservation | Prepare an exact standard OpenTable reservation for restaurant_id, restaurant-local date/time, party_size and seating_type (default means standard dining). |
| search_restaurants | Search OpenTable (US site) for restaurants by free text, the same search the site's results page runs. |
