[{
  kind: "page",
  match: { url_patterns: ["https://www.espn.com/*"] },
  tool: {
    name: "get_scoreboard",
    description: "Read ESPN's public scoreboard for NFL, NBA or NHL: the games on one date (NBA, NHL) or in one week (NFL), with start time, state, score and record per team, broadcasters and venue. Fetches the scoreboard page for the requested league from www.espn.com and reads its embedded data, so it does not matter which www.espn.com page is open, and it never navigates. Works signed out. With no date or week ESPN picks the day or week itself (for NBA and NHL that can be the next day with games), so read `effective` to see what was returned. Games in progress are returned as ESPN lists them; scores are snapshots, not live updates. Returns at most max_games games and says when it truncated. status \"no_games\" means ESPN lists no games for that date or week, which is different from an error. Other leagues are not supported yet. Odds, tickets and player leaders are not returned. Run it on a www.espn.com page; on other espn.com hosts it returns wrong_page.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["league"],
      properties: {
        league: { enum: ["nfl", "nba", "nhl"], description: "League to read." },
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Calendar date, YYYY-MM-DD, as ESPN dates its scoreboard (US Eastern in observed sessions). NBA and NHL only; omit to let ESPN choose." },
        year: { type: "integer", minimum: 2000, maximum: 2100, description: "NFL only: season year (the year the season starts). Give with season_type and week." },
        season_type: { enum: ["preseason", "regular", "postseason"], description: "NFL only. Give with year and week." },
        week: { type: "integer", minimum: 1, maximum: 25, description: "NFL only: week number within season_type (ESPN's own numbering; preseason week 1 is the Hall of Fame game). Give with year and season_type." },
        max_games: { type: "integer", minimum: 1, maximum: 50, default: 30, description: "Most games to return." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "league", "url", "effective", "game_count", "returned_count", "truncated", "games", "observed_at"],
          properties: {
            status: { const: "ok" },
            league: { enum: ["nfl", "nba", "nhl"] },
            url: { type: "string", format: "uri" },
            effective: {
              type: "object", additionalProperties: false, required: ["source", "date", "year", "season_type", "week"],
              properties: {
                source: { enum: ["requested", "site_default"], description: "'site_default' means the caller gave no date or week and ESPN chose." },
                date: { type: ["string", "null"], description: "YYYY-MM-DD for NBA and NHL; null for NFL." },
                year: { type: ["integer", "null"] },
                season_type: { enum: ["preseason", "regular", "postseason", null] },
                week: { type: ["integer", "null"] }
              }
            },
            game_count: { type: "integer", minimum: 1, description: "Games ESPN lists for this date or week." },
            returned_count: { type: "integer", minimum: 1 },
            truncated: { type: "boolean" },
            games: {
              type: "array", minItems: 1, maxItems: 50,
              items: {
                type: "object", additionalProperties: false,
                required: ["game_id", "url", "start_utc", "state", "status", "status_detail", "completed", "teams", "broadcasts", "venue"],
                properties: {
                  game_id: { type: "string" },
                  url: { type: ["string", "null"], description: "ESPN game page." },
                  start_utc: { type: ["string", "null"] },
                  state: { enum: ["pre", "in", "post", null], description: "pre = not started, in = in progress, post = over (including postponed or cancelled; see status)." },
                  status: { type: ["string", "null"], description: "ESPN's status name, for example Scheduled, In Progress, Final, Postponed." },
                  status_detail: { type: ["string", "null"], description: "ESPN's status line, for example the clock, 'Final/OT' or the local start time." },
                  completed: { type: "boolean" },
                  teams: {
                    type: "array", maxItems: 2,
                    items: {
                      type: "object", additionalProperties: false, required: ["team_id", "abbreviation", "name", "home", "score", "winner", "record"],
                      properties: {
                        team_id: { type: ["string", "null"] }, abbreviation: { type: ["string", "null"] }, name: { type: ["string", "null"] },
                        home: { type: "boolean" },
                        score: { type: ["integer", "null"], description: "null before the game starts." },
                        winner: { type: "boolean", description: "true only for the winning team; both false for a tie or an unfinished game." },
                        record: { type: ["string", "null"], description: "Overall record as ESPN shows it, for example 1-2 or 0-0-0." }
                      }
                    }
                  },
                  broadcasts: { type: "array", items: { type: "string" } },
                  venue: {
                    type: ["object", "null"], additionalProperties: false, required: ["name", "city", "state"],
                    properties: { name: { type: ["string", "null"] }, city: { type: ["string", "null"] }, state: { type: ["string", "null"] } }
                  }
                }
              }
            },
            warnings: { type: "array", items: { type: "string" } },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "league", "url", "effective", "message"],
          properties: {
            status: { const: "no_games" },
            league: { enum: ["nfl", "nba", "nhl"] },
            url: { type: "string", format: "uri" },
            effective: {
              type: "object", additionalProperties: false, required: ["source", "date", "year", "season_type", "week"],
              properties: {
                source: { enum: ["requested", "site_default"] },
                date: { type: ["string", "null"] }, year: { type: ["integer", "null"] },
                season_type: { enum: ["preseason", "regular", "postseason", null] }, week: { type: ["integer", "null"] }
              }
            },
            message: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "rate_limited", "blocked", "site_error", "site_changed"], description: "site_changed means ESPN's page no longer has the data layout this tool reads." },
            error_message: { type: "string" }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.espn.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const SEASON_TYPES = { preseason: 1, regular: 2, postseason: 3 };
    const ALLOWED = ["league", "date", "year", "season_type", "week", "max_games"];
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Provide an object with league.");
    const unknown = Object.keys(input).filter(key => !ALLOWED.includes(key));
    if (unknown.length) return fail("invalid_input", "Unknown input: " + unknown.join(", ") + ".");
    const league = input.league;
    if (league !== "nfl" && league !== "nba" && league !== "nhl") return fail("invalid_input", "league must be nfl, nba or nhl; other leagues are not supported yet.");
    const maxGames = input.max_games === undefined ? 30 : input.max_games;
    if (!Number.isInteger(maxGames) || maxGames < 1 || maxGames > 50) return fail("invalid_input", "max_games must be an integer from 1 to 50.");
    let path = "/" + league + "/scoreboard";
    let requested = null;
    if (league === "nfl") {
      if (input.date !== undefined) return fail("invalid_input", "NFL scoreboards are addressed by year, season_type and week; date is not supported for nfl.");
      const given = ["year", "season_type", "week"].filter(key => input[key] !== undefined);
      if (given.length && given.length < 3) return fail("invalid_input", "Give year, season_type and week together, or none of them for ESPN's current week.");
      if (given.length) {
        if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 2100) return fail("invalid_input", "year must be an integer from 2000 to 2100.");
        if (typeof input.season_type !== "string" || !Object.hasOwn(SEASON_TYPES, input.season_type)) return fail("invalid_input", "season_type must be preseason, regular or postseason.");
        if (!Number.isInteger(input.week) || input.week < 1 || input.week > 25) return fail("invalid_input", "week must be an integer from 1 to 25.");
        requested = { date: null, year: input.year, season_type: input.season_type, week: input.week };
        path += "/_/week/" + input.week + "/year/" + input.year + "/seasontype/" + SEASON_TYPES[input.season_type];
      }
    } else {
      if (input.year !== undefined || input.season_type !== undefined || input.week !== undefined) return fail("invalid_input", "year, season_type and week are for nfl only; use date for " + league + ".");
      if (input.date !== undefined) {
        const parts = typeof input.date === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.date) : null;
        const check = parts ? new Date(Date.UTC(+parts[1], +parts[2] - 1, +parts[3])) : null;
        if (!check || check.getUTCFullYear() !== +parts[1] || check.getUTCMonth() !== +parts[2] - 1 || +parts[1] < 1990) return fail("invalid_input", "date must be a real calendar date, YYYY-MM-DD, from 1990 on.");
        requested = { date: input.date, year: null, season_type: null, week: null };
        path += "/_/date/" + parts[1] + parts[2] + parts[3];
      }
    }
    if (window.location.origin !== ORIGIN) return fail("wrong_page", "Run this on a https://www.espn.com page; it reads that origin only.");

    let response;
    try {
      response = await fetch(ORIGIN + path, { credentials: "omit", signal: AbortSignal.timeout(20000) });
    } catch (error) {
      return fail("site_error", error && error.name === "TimeoutError" ? "ESPN did not respond within 20 seconds." : "The request to ESPN failed.");
    }
    if (response.status === 429) return fail("rate_limited", "ESPN is rate limiting this browser (HTTP 429). Wait before retrying.");
    if (response.status === 403) return fail("blocked", "ESPN refused the request (HTTP 403).");
    if (!response.ok) return fail("site_error", "ESPN returned HTTP " + response.status + ".");
    let html;
    try { html = await response.text(); } catch (error) { return fail("site_error", "Reading ESPN's response failed."); }

    const marker = "window['__espnfitt__']=";
    const start = html.indexOf(marker);
    const end = start < 0 ? -1 : html.indexOf("</script>", start);
    let data = null;
    if (end > 0) {
      let raw = html.slice(start + marker.length, end).trim();
      if (raw.endsWith(";")) raw = raw.slice(0, -1);
      try { data = JSON.parse(raw); } catch (error) { data = null; }
    }
    const board = data && data.page && data.page.type === "scoreboard" && data.page.content ? data.page.content.scoreboard : null;
    if (!board || !Array.isArray(board.evts)) return fail("site_changed", "ESPN's scoreboard page no longer has the data this tool reads (page data or events list missing).");

    const warnings = [];
    const site = board.requestedDates && typeof board.requestedDates === "object" ? board.requestedDates : null;
    const effective = { source: requested ? "requested" : "site_default", date: null, year: null, season_type: null, week: null };
    if (requested) Object.assign(effective, requested);
    if (league === "nfl") {
      const typeName = site && Object.keys(SEASON_TYPES).find(name => SEASON_TYPES[name] === site.seasontype);
      if (site && Number.isInteger(site.year) && Number.isInteger(site.week) && typeName) {
        if (requested && (requested.year !== site.year || requested.week !== site.week || requested.season_type !== typeName)) warnings.push("ESPN returned a different week than requested; effective shows what it returned.");
        Object.assign(effective, { year: site.year, season_type: typeName, week: site.week });
      }
    } else if (site && typeof site.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(site.date)) {
      if (requested && requested.date !== site.date) warnings.push("ESPN returned a different date than requested; effective shows what it returned.");
      effective.date = site.date;
    }
    const url = ORIGIN + path;
    const text = (value, max) => {
      const clean = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() : "";
      return clean ? clean.slice(0, max) : null;
    };
    const gameId = event => text(event.id === undefined || event.id === null ? "" : String(event.id), 30);
    const events = board.evts.filter(event => event && typeof event === "object" && gameId(event));
    if (board.evts.length && !events.length) return fail("site_changed", "ESPN's scoreboard events no longer have the fields this tool reads.");
    if (!events.length) {
      return { status: "no_games", league, url, effective, message: "ESPN lists no " + league.toUpperCase() + " games for this " + (league === "nfl" ? "week" : "date") + "." };
    }

    const path2url = value => {
      const link = typeof value === "string" && /^\/[^/]/.test(value) ? ORIGIN + value.split(/[?#]/)[0] : null;
      return link && link.length <= 300 ? link : null;
    };
    const games = events.slice(0, maxGames).map(event => {
      const status = event.status && typeof event.status === "object" ? event.status : {};
      const venue = event.vnue && typeof event.vnue === "object" ? event.vnue : null;
      return {
        game_id: gameId(event),
        url: path2url(event.link),
        start_utc: text(event.date, 40),
        state: status.state === "pre" || status.state === "in" || status.state === "post" ? status.state : null,
        status: text(status.description, 60),
        status_detail: text(status.detail, 120),
        completed: event.completed === true,
        teams: (Array.isArray(event.competitors) ? event.competitors : []).filter(team => team && typeof team === "object").slice(0, 2).map(team => {
          const total = (Array.isArray(team.records) ? team.records : []).find(record => record && record.type === "total");
          const score = team.score === undefined || team.score === null || team.score === "" ? NaN : Number(team.score);
          return {
            team_id: text(team.id === undefined || team.id === null ? "" : String(team.id), 20),
            abbreviation: text(team.abbrev, 10),
            name: text(team.displayName, 80),
            home: team.isHome === true,
            score: Number.isInteger(score) ? score : null,
            winner: team.winner === true,
            record: text(total && total.summary, 20)
          };
        }),
        broadcasts: (Array.isArray(event.broadcasts) ? event.broadcasts : []).map(item => text(item && item.name, 40)).filter(Boolean).slice(0, 6),
        venue: venue ? { name: text(venue.fullName, 100), city: text(venue.address && venue.address.city, 60), state: text(venue.address && venue.address.state, 40) } : null
      };
    });
    const result = { status: "ok", league, url, effective, game_count: events.length, returned_count: games.length, truncated: games.length < events.length, games, observed_at: new Date().toISOString() };
    if (warnings.length) result.warnings = warnings;
    return result;
  }
}]
