# purelymail.com

| tool | description |
|------|-------------|
| create_filter | Creates one incoming-mail filter through the Settings > Filters editor. |
| create_folder | Creates one mail folder, optionally nested; does nothing if it already exists. |
| delete_filter | Deletes exactly one incoming-mail filter by name. |
| get_filter | Reads one incoming-mail filter by name. |
| get_vacation_responder | Reads the vacation auto-reply filters with their message, subject, interval and enabled state. |
| get_verification_code | Waits for and returns a one-time code from a fresh, authenticated email or forwarded SMS. |
| list_filters | Lists the incoming-mail filters in run order with their conditions and actions. |
| list_folders | Lists the mail folders with their ids, roles and message counts. |
| list_messages | Lists or searches one page of messages in a folder without marking them read. |
| login | Signs in to Purelymail webmail and confirms the session is for the given address. |
| read_message | Reads one message without marking it read: safe headers, sender authentication, attachment names, links and a bounded plain-text body. |
| send_message | Sends one plain-text email from the account and saves a copy to Sent. |
| set_vacation_responder | Turns the vacation auto-reply on or off, or changes its message, subject or repeat interval. |
| update_filter | Changes the given fields of one existing filter found by name, keeping its position. |
| wait_for_message | Waits a bounded time for a new message matching sender or subject text in a folder and returns its metadata. |
