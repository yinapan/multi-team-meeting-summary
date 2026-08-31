---
name: multi-team-meeting-summary
description: Read WPS 365 team meeting documents and generate full or incremental meeting dashboards and date-range reports from the multi-team-meeting-summary project. Use for meeting-record search, reading, summarization, dashboards, or reports in this project.
metadata:
  openclaw:
    os: ["win32"]
    requires:
      bins: ["node", "wps365-cli"]
---

# Multi-Team Meeting Summary

Use the WPS 365 CLI credential store. Never print, request, copy, or persist a raw access token, and never add one to `config.json`.

## Project Location

Use `%MULTI_TEAM_MEETING_SUMMARY_HOME%` as the project root. If it is unavailable, use the current workspace only when it contains `package.json` with the name `multi-team-meeting-summary`. Otherwise ask the user to run `setup-wps365.bat` from the copied repository and restart OpenClaw.

## Authentication Check

Before WPS reads or report generation, run this from the project root:

```powershell
node scripts/check-wps365-auth.js --expected-user "高晶娣" --probe
```

If it fails, stop after the first authentication or permission error. Ask the user to run `setup-wps365.bat`; do not repeatedly retry 401/403 errors and do not call `wps365-cli auth token`.

## Operations

- Full dashboard: `npm run kanban:full`
- Incremental dashboard: `npm run kanban`
- Date-range report: `npm run report -- <MM-DD> <MM-DD>`
- Direct document read: use `wps365-cli drive file-content get <drive-id> <file-id> --format markdown` only after the authentication check.

For reports, titles marked `【保密】`, `[保密]`, or with equivalent full-width square brackets must be excluded before reading and from all counts, summaries, important-meeting lists, and generated reports. Confidential status always overrides an important marker or important attendee.

Treat WPS access as read-only unless the user explicitly asks to create or modify a document. After generation, report output paths, team count, meeting count, and any failed reads. Do not describe a cached or permission-incomplete result as a successful full scan.
