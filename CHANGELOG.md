# Changelog

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
