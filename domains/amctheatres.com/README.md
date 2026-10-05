# amctheatres.com

| tool | description |
|------|-------------|
| add_tickets_to_cart | Picks seats and ticket types for one showtime on AMC's own seat and ticket pages and opens a cart, which holds the seats for about 7 minutes; never checks out or pays. |
| cancel_cart | Releases the cart open in the tab through its close button and AMC's cancel prompt. |
| get_cart | Reads the cart open in the tab before payment: ticket, fee and tax lines, seats, total, checkout step and time left on the hold. |
| get_favorite_theatres | Reads the Favorite Theatres list on the signed-in member's open profile page, in preference order. |
| get_movie | Reads one movie's details: runtime, rating, release date, genre, synopsis, cast and crew, and Rotten Tomatoes scores. |
| get_page_context | Describes the open page: page type, slugs and date from the address, current theatre, sign-in, an open cart's hold, AMC's security check, live tools and next steps. |
| get_rewards | Reads the signed-in member's open Points & Rewards page: points, reward dollars, progress, rewards, spending benefits and visits. |
| get_seat_map | Reads the open seat page row by row as runs of side-by-side open seats, plus accessible spaces, optionally only rows that fit a party. |
| get_showtimes | Reads the dated theatre showtimes page already open: movies, formats, screening IDs, start times and availability, filterable by movie, format and local start time; large results come back as a summary. |
| get_theatre | Reads the open theatre page: name, address, highlights and features grouped as AMC groups them. |
| get_ticket_prices | Reads the open ticket page: each ticket type's price with fees, base price, convenience fee and age rule. |
| list_theatres | Lists AMC's markets, or every theatre in one market with its address, from AMC's published sitemaps. |
| navigate_to_page | Opens a path on www.amctheatres.com after returning, with a site map of which tool reads each page; refuses to leave an open cart unless asked. |
| preview_tickets | Picks seats and ticket types on AMC's seat and ticket pages and reads the prices and subtotal, without pressing Continue, so no order is created or seats held. |
| search_catalog | Reads AMC's open movie search results, 12 per page with the next page, or the plain search's 3-movie preview with a link to the full list. |
| search_movies | Lists AMC's featured Now Playing, Events or Coming Soon movies, optionally filtered by title. |
| search_theatres | Reads the open Find a Theatre search: theatres nearest first with distance and formats, or AMC's choices for an ambiguous place. |
| set_current_theatre | Makes a theatre AMC's current theatre with its Make Current button on the open theatre search, confirmed in the site header. |
| set_favorite_theatre | Adds or removes the open theatre page's theatre from the signed-in member's favorites with the page's own button. |
