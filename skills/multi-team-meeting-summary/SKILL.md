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

Before a fresh WPS read, run this from the project root:

```powershell
node scripts/check-wps365-auth.js --expected-user "高晶娣" --probe
```

If it fails, stop after the first authentication or permission error. Ask the user to run `setup-wps365.bat`; do not repeatedly retry 401/403 errors and do not call `wps365-cli auth token`.

## Operations

- Full dashboard: `npm run kanban:full`
- Incremental dashboard: `npm run kanban`
- Date-range report: `npm run report -- <MM-DD> <MM-DD>`
- Direct document read: use `wps365-cli drive file-content get <drive-id> <file-id> --format markdown` only after the authentication check.

The default report mode is `agent`. The agent running this skill writes the analysis using its current session model. The CLI reads WPS documents, prepares prompts, and renders Word files. It requires no model credentials from `openclaw.json`.

Exit code 75 requests analysis from the current agent. Read each `.prompt.md` listed in that invocation, use the supplied meeting material as data, and write your analysis as Markdown to its corresponding `.answer.md`. Run `npm run report -- <MM-DD> <MM-DD> --resume-agent` and complete the next set of requests until the final Word report is produced with exit code 0. The workflow prepares team prompts first and then the comprehensive prompt. Carry out these steps yourself when running the skill.

To regenerate a report from a completed scan for the same period, start with `--resume-agent`; this reuses the validated dated inputs. Start with the normal report command when a fresh WPS scan is requested. Standalone script callers can select the project's `llm.mode` explicitly as `api` or `rules` in `config.json`.

For reports, titles marked `【保密】`, `[保密]`, or with equivalent full-width square brackets must be excluded before reading and from all counts, summaries, important-meeting lists, and generated reports. Confidential status always overrides an important marker or important attendee.

## Required Delivery

After a requested report or dashboard finishes, invoke the installed `s3-file-manager` skill to upload the primary artifacts before replying. Publish the comprehensive report and dashboard by default; publish per-team reports only when requested. Use the agent id required by `s3-file-manager` (normally `openclaw-agent-001`).

For each returned `download_url`, run `npm run kanban:shorten -- "<download_url>"` and return the resulting short URL as the primary user-facing link. State that the underlying S3 link expires in 7 days. Dashboard and report links must be shorter than 300 characters. Also include the local output paths. If upload or shortening fails, report the failure clearly and never imply that a link was generated.

Treat WPS access as read-only unless the user explicitly asks to create or modify a document. After generation, report output paths, links, team count, meeting count, and any failed reads. Do not describe a cached or permission-incomplete result as a successful full scan.
