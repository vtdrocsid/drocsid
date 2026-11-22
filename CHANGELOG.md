# Changelog

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
