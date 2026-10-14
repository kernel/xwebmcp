# github.com

| tool | description |
|------|-------------|
| get_issue | Reads one issue's title, state, labels, assignees, linked pull requests, body and the timeline items the page holds, in a signed-out tab. |
| get_pull_request | Reads one pull request's state, branches, commits, times, labels and description as text. |
| get_repository | Reads a repository overview: description, topics, counts, license, default branch, latest commit, root entries and README text. |
| get_star_status | Reports whether the expected signed-in account has starred a public repository, without returning the account. |
| prepare_comment | Prepares exact comment Markdown and a manual handoff for the public issue or pull request already open; sends nothing. |
| prepare_issue | Checks a public repository accepts issues and returns the exact title, body and a manual new-issue URL. |
| prepare_pull_request | Checks a public repository and returns the exact title, body, base, head and comparison URL for a manual pull request. |
| search_issues | Searches issues or pull requests with GitHub qualifiers and returns one page of 10 results. |
| search_repositories | Searches repositories with GitHub qualifiers and returns one page of 10 results. |
| set_star | Stars or unstars a public repository for the expected account with one click, then verifies the result on the server. |
