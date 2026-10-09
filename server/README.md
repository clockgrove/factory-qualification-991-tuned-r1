# Local incident server

From the repository root, run `npm run seed`, then `npm run start`.
The server prints its actual URL, normally `http://127.0.0.1:3000`.
Set `PORT` to another port, or `PORT=0` for an available ephemeral port.
Press Ctrl+C to close it gracefully; SIGTERM also shuts it down.
For the supplied verification environment, run `npm run pretest`, then
`qualification-browser-smoke`, then `npm test` from the root. The package
scripts and pinned browser setup are unchanged; see the root README for
alias-relative tooling and sandbox requirements.

The server reads `.runtime/incidents.json` without changing it and serves
the repository's `public/` directory when frontend files are present.
Only GET requests are supported. API errors are `{error:{code,message}}`.

`/api/incidents` accepts literal case-insensitive `q` over ID, title and
description; repeated `service`, `status` and `severity`; inclusive UTC
`from` and `to` dates in YYYY-MM-DD form; `sort=openedAt|severity`;
`direction=asc|desc`; a positive `page`; and `pageSize=25|50`.
Defaults are no filters, openedAt descending, page 1 and size 25.
Facet values are case-sensitive and use the dataset's exact enumerations.
Values within a facet are OR, and separate facets are AND.
Opened-date ties use ID ascending. Severity ties use openedAt descending,
then ID ascending. Page requests clamp to the available range.
Summaries cover all matches, with chronological UTC day buckets.

`/api/services-overview` accepts and validates the same parameters as
`/api/incidents`, but pagination and sorting do not change its calculations.
It returns `{total, services}` for the entire filtered result. Each service
entry contains `service`, `incidentCount`, `unresolvedCount`,
`highSeverityCount`, and `averageResolutionHours`. Unresolved means open or
in progress; high severity means critical or high. Average resolution hours
is the unrounded mean of opening-to-resolution durations for resolved
incidents only, or JSON `null` when none are resolved (displayed as
“Unavailable”). Entries sort by unresolved count descending, then service
name ascending. No matches returns `{total:0, services:[]}`.

The frontend places this overview first on phones and offers loading,
selection labels, empty state and Retry. Personal triage membership and
plain-text notes live only in browser-origin storage, separately from saved
views and the address. No triage endpoint exists and the server never edits
canonical records. Malformed or unavailable browser storage is explained
in the interface; current-visit triage remains usable, with no guarantee of
reload persistence after a storage failure.

`/api/incidents/:id` returns every incident field, or 404.
`/api/export.csv` applies the same filters and sorting, ignores pagination,
and exports all fields in dataset order. Tags are JSON array text, null is
empty, quotes are doubled, and records use CRLF.
