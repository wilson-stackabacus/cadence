# Cadence

A macOS planner that keeps you checking your list: weekly and monthly calendars, recurring tasks,
a to-do list, reminders that pop up when you choose, Google Calendar sync, a 7-day view of your open time,
and a required reflection (20+ words) every time you check something off.

## Build & run

```
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodegen generate
xcodebuild -project Cadence.xcodeproj -target Cadence -sdk macosx build
open build/Debug/Cadence.app
```

Copy `Cadence.app` into `/Applications`, then turn on **Settings › Startup › Open Cadence automatically when I log in**.
Reminders only fire while Cadence is running (closing the window keeps it in the menu bar).

## How reminders work

| When | What happens |
|---|---|
| A task's reminder time | Its chosen alert styles: Notification, on-screen banner, sound, and/or checklist window |
| Every 30 min (configurable) while the Mac is in use | "Checklist check — N left" nudge; paused when locked/asleep |
| Cadence starts, Mac wakes, screen unlocks | Check-in window with today's checklist |
| Before Google events | Reminder X minutes before (configurable) |

## Overlapping tasks

Tasks can sit on top of each other, and each one's reminders fire on time, even in the middle of another task.
- Week view: **double-click inside an existing block** (task or Google event) to add a task at that exact time,
  or right-click → *Add task during this* (at start / halfway / 15 min before end).
- Task editor: reminder options *During the task* (10 min in … 1.5 hr in), plus an "Overlaps with" note.

## Google Calendar

Create a **Desktop app** OAuth client in Google Cloud Console (Calendar API enabled, yourself as a test user),
paste the Client ID + secret in Settings, and click Connect. Sign-in happens in your browser. Tokens live in the Keychain.

## App icon

Drawn in code: `swift scripts/generate_icon.swift Sources/Assets.xcassets` regenerates every size.

## Sync with Cadence Web

`web/` is the online version (Vercel + Turso). In Settings › **Sync with Cadence Web**, enter its URL and your
username/password; the session token is kept in the Keychain. See `web/README.md` for deployment.

## Data

`~/Library/Application Support/Cadence/cadence.json` (tasks, reflections, settings).

## Debug launch flags

`-dataDir <path> -demo -screen week|month|todo|reflections|booking|settings -checkin -banner -reflect -edit -noCheckIn`
