# Changelog

## 0.2.1 — 2026-11-22
- Top strip shows only the Admin link (admins only); Libraries / Live TV live in the center tabs
- Wordmark is just DROCSID (no "(.TV)")

## 0.2.0 — 2026-11-22
- New look: light gray / white with navy strips, two-tone headers, slanted navy tabs and azure accents
  (Browse and Admin). Roll back with `update.sh 0.1.22` if needed.
- Three columns: Upcoming Lineup (left), library browsing + Live TV guide (center, as tabs), Play History (right)
- Lineup: schedule a movie, episode or future live TV show for a voice channel at a date/time
  (📅 Schedule… in a title's details, on each episode, by clicking a future show in the guide, or
  "+ Schedule a showing"). Reminder posted 10 min before; starts automatically on time. Owner/admin can remove.
- Play history: every stream with who started it, when, voice channel, and who watched in the Activity
- Stored in /data/schedule.json and /data/history.json

## 0.1.22 — 2026-11-21
- Fix switching titles in a channel (e.g. live TV → movie): stream versions are now unique across titles,
  so the player always loads the new stream instead of freezing on the old one

## 0.1.21 — 2026-11-21
- Fix seeking: Plex's playlist after a seek still spans the whole title (filler before the seek point),
  so the player now seeks to the real title time instead of the playlist start

## 0.1.20 — 2026-11-21
- Fix black screen after seeking: only real MPEG-TS pieces from Plex are passed on; placeholder/empty
  replies during a transcode restart are retried instead of sent to the player
- Log the head of each Plex playlist and any non-video reply, for diagnosis

## 0.1.19 — 2026-11-21
- Browse: Search tab removed; search bar sits in the middle of the top navigation with a live drop-down
  of up to 7 results (poster, title, type/year). Click, or ↑/↓ + Enter, opens the title. Esc closes.

## 0.1.18 — 2026-11-21
- Guide: ▶ sits in its own fixed right-hand column above the vertical scrollbar; it no longer moves with the timeline

## 0.1.17 — 2026-11-21
- Guide: no horizontal scrollbar; ◀ ▶ buttons at the ends of the timeline row move one hour at a time
- Guide: timeline header stays fixed; the vertical scrollbar covers only the channel rows
- Guide: 12 hours of listings (was 6); range label shows the visible window
- Guide keeps its position when the filter changes or the guide refreshes

## 0.1.16 — 2026-11-21
- Guide: hover details only for blocks scrolled under the channel column whose title is cut off

## 0.1.15 — 2026-11-21
- Guide: labels of shows scrolled under the channel column now actually slide to the visible edge
  (the 0.1.12 sticky approach couldn't move long titles)
- Guide: hover details only where the title is cut off (clipped at the left or ending in "…")

## 0.1.14 — 2026-11-21
- Guide: hover details only for shows that started before the "now" line (currently airing or past)

## 0.1.13 — 2026-11-21
- Guide: hover details only appear when a show's label is cut off (short block or scrolled under the channel column)
- Activity: live TV control bar matches library titles (● LIVE in the progress bar's place; volume and stop on the right)

## 0.1.12 — 2026-11-21
- Live TV: find Plex's live session anywhere in the tune reply (fixes "could not tune" with free tuners);
  logs the raw reply if it still can't
- Guide: show titles stick beside the channel column while scrolling instead of sliding under it
- Guide: hovering a show expands it with full title, time range, episode and description

## 0.1.11 — 2026-11-21
- Admin › Libraries: default sort per library (A–Z, Recently added, Release date)
- Admin › Libraries: ↑ ↓ to set the order of library tabs on the Browse page (top one opens first)

## 0.1.10 — 2026-11-21
- Only the person who started a stream can pause/resume, scrub, change quality or stop it
  (Activity and Browse player bar; enforced on the server). Admins can still stop any stream from Admin.
- Everyone else sees title, progress and play state without controls

## 0.1.9 — 2026-11-21
- Fix 0.1.8 black screen: grouped segments now fetch Plex's pieces in order and wait for pieces
  Plex is still writing (0.1.8 fetched them in parallel and got 404s / empty pieces)
- Any click in the Activity starts playback / unmutes (no need to hit the button exactly)

## 0.1.8 — 2026-11-21
- Fix periodic stutter: Plex's ~1 s segments are regrouped into ~6 s segments (fetched from Plex in
  parallel over the LAN), so far fewer requests go through Nginx and Discord's proxy
- Player logs segment download times; server logs Plex fetch times for grouped segments

## 0.1.7 — 2026-11-21
- Smoother playback: sync ignores drift under 1s, corrects with ±3% speed (was ±5% at 0.3s), seeks only past 4s
- Stable server-clock estimate (no more target jitter from network latency)
- hls.js no longer jumps toward a "live edge" on library titles while Plex is still transcoding
- No corrections while buffering or right after a seek
- Real buffering stalls are logged to the container log

## 0.1.6 — 2026-11-21
- Quality moved from the admin page to the player bar (per stream); changing it restarts that stream in place
- New streams default to the last quality picked
- One video per voice channel: a busy channel can only be replaced by whoever started it, or an admin
- One stream per user: starting elsewhere offers to stop your other stream first
- Admin "Active streams" shows each stream's quality
- Log why every stream ends, viewer count changes and Activity disconnects

## 0.1.5 — 2026-11-21
- Admin: one "Stream quality" setting with Plex's standard presets replaces the separate source/output settings
- Best source copy is chosen automatically for the selected quality

## 0.1.4 — 2026-11-21
- Fix black video: Plex now always transcodes to H.264/AAC unless Output = "Original" (Discord can't decode HEVC)
- Activity page loads versioned player files so Discord never runs a stale cached copy
- Activity signs itself back in after a container restart
- Player reports its version, manifest, first segment and errors to the container log

## 0.1.3 — 2026-11-21
- Admin page: cache the server member list (fixes "opcode 8 rate limited" warnings)
- Log Activity sign-in, WebSocket connects and every playlist request
- "Watching" count stays correct when a new title starts
- Version printed in the container log at startup

## 0.1.2 — 2026-11-21
- Stream diagnostics: playlists, Plex proxy failures and player errors go to the container log

## 0.1.1 — 2026-11-21
- Activity loads its CSS/JS by absolute path (fixes unstyled "Connecting…" inside Discord)

## 0.1.0 — 2026-11-21
- First build: web portal, admin page, Discord Activity player, Plex library + live TV
