# Changelog

## 0.5.15 — 2026-11-25
- **drocsid listens on port 3005** (was 3000), inside the container and as the default Web port in the Unraid template and Compose file. **Existing installs:** change the proxy host's Forward Port to 3005, and any Unraid port mapping's container port to 3005. A `PORT` variable still overrides it.
- Install guide, in-app Nginx Proxy Manager guide and the address check use 3005; the setup code message points to the WebUI.

## 0.5.14 — 2026-11-25
- Fixed: after Change icon, Admin → Connections stopped with "Cannot set properties of null" and the media server list was cut short (its Remove buttons didn't work). The icon dialog now shows its result.
- Change icon: the button just says Save.

## 0.5.13 — 2026-11-25
- **Change a Discord app's icon from Admin**: Connections → Change icon. Upload an image (cropped to a square) or use the drocsid icon, preview it in Discord's round crop, and set the app icon (Activity tile, profile), the bot avatar (member list, messages), or both. No Developer Portal needed. Discord's limit on avatar changes is explained when it applies.
- New Discord apps get the drocsid icon as app icon and bot avatar, unless they already have their own.

## 0.5.12 — 2026-11-25
- **Setup works from http://<ip>:<port>**: the wizard can be opened from Unraid's WebUI link. The owner sign-in carries the setup code through Discord (which always returns to the public address), and setup continues there.
- Wizard shows the Nginx Proxy Manager guide when you enter the public address, and explains the sign-in step needs it working.
- New step-by-step install guide in the README (Unraid or Compose, DNS, Nginx Proxy Manager with the streaming settings, Discord Developer Portal, access, updating, troubleshooting).
- Example files and the Unraid template hold example values only; template description mentions Jellyfin and Emby.

## 0.5.11 — 2026-11-25
- Unraid template works for anyone: icon loads from the GitHub repo, WebUI opens the container on its own port (setup wizard on a fresh install), bridge network with a Web port setting (3000), and no `--env-file` to a personal path. Existing containers keep their own settings.

## 0.5.10 — 2026-11-25
- New drocsid logo in the website banner (Browse, Admin, Setup), with an SVG master and a white version for dark backgrounds.
- Browser tab icon on every page (SVG, PNG and .ico), plus `/favicon.ico`.
- Unraid template icon served from `/browse/img/unraid-icon.png`; Discord app icon PNG in `brand/`.

## 0.5.9 — 2026-11-24
- Browsers always check for a newer copy of the website's pages, scripts and styles, so changes show up right after an update (0.5.8's example domain didn't appear until a hard refresh because an old cached script was reused).

## 0.5.8 — 2026-11-24
- Set-up instructions and examples always use `example.domain.com`; the guide no longer fills in your own domain.

## 0.5.7 — 2026-11-24
- **Public address is explained as required**: Admin → Connections says it must be a public https address with a valid certificate, because Discord loads the player from it and returns people there after signing in.
- **How to set it up in Nginx Proxy Manager**: step-by-step guide (DNS and ports, proxy host details, Websockets on, Cache Assets off, SSL, the Advanced streaming settings with a Copy button and what each does, checking it, and the Discord Developer Portal entries). Shown in Admin and in the wizard.
- **Add / Change open a wizard that checks the address before saving**: https format, reachable with a valid certificate from your browser, it's this drocsid answering, and WebSockets get through. A check from the drocsid server itself is shown as a warning only (some routers don't loop back).

## 0.5.6 — 2026-11-23
- **Scrub previews in the player.** Hovering over or dragging the timeline shows a still from that moment, with the time, when the media server has made preview thumbnails: Plex "video preview thumbnails" (one still per request, nearest 5 s) or Jellyfin "Trickplay" (tile sheets). Titles without them, and Live TV, show no preview. Stills go through drocsid; no server address or token reaches the player.

## 0.5.5 — 2026-11-23
- Admin: the Super admins list sits directly below the Poster cache panel, in the right-hand column.
- Wizards opened from Admin (add/edit a media server or Discord app) have a **Cancel** button on every step that goes back to Admin → Connections.

## 0.5.4 — 2026-11-23
- **Fixed the whole site going down while scrubbing a Jellyfin/Emby stream.** A 60-second limit covered the entire download of a video piece; when it ran out mid-download the error wasn't handled and Node exited. The limit now only covers the server starting to answer, every proxied download ends just its own response on error, and any unexpected error is logged instead of stopping the server.
- **Scrubbing Jellyfin/Emby no longer starts a new stream each time**: their stream spans the whole title, so a seek just moves everyone's position and the server transcodes from there (much lighter, and no cut-off downloads).
- **Security:** Jellyfin's preview-thumbnail line (Trickplay) in the stream list carried drocsid's Jellyfin access key to viewers' browsers. Those lines are now removed and any key in stream URLs is stripped.

## 0.5.3 — 2026-11-23
- Browse: the library buttons sit below the navy bar, above the browse panel, with space around them, and are a red gradient (the selected one brighter). The header is shorter now that it doesn't hold the buttons.

## 0.5.2 — 2026-11-23
- **Real Plex, Jellyfin and Emby logos** (from the open-source dashboard-icons project, Apache-2.0; see web/img/NOTICE.md) replace the letter badges everywhere: Browse server tiles, rail tiles, search results, the TV guide, Admin (Connections, Libraries panels, Active streams) and the setup wizard.
- **Media servers are named by the servers themselves**: Plex's friendly name, Jellyfin/Emby's server name. Set when connecting (the wizard no longer asks for a name), and kept in sync at startup and on every check, so an imported "Plex" becomes its real name.
- Libraries panels always show the server's name; Active streams show which media server each stream is from.

## 0.5.1 — 2026-11-23
- Access by server: **Approved users** first, then **Approved roles**, then **Admins**. The wording now says plainly that approved users and roles can browse the libraries and play content in that server.
- **Libraries: one panel per media server**, headed by the server's icon and name. Each server's Live TV is a row in its panel with an On/Off tag and **Reload channels & guide**; the separate Live TV panel is gone.
- **Poster cache** is its own panel, on the right.
- Connections, Libraries, Live TV and Super admins panels are hidden from the start and only shown to super admins (regular admins never see them, even briefly; the server already refused them).

## 0.5.0 — 2026-11-23
- **Choose your Discord after signing in.** People in more than one server with drocsid pick which one they're watching in; the top bar shows it and switches it. Voice channels, Watching Now, Upcoming Lineup and Play History are for that server. Super admins also get **All servers**. One server: picked automatically.
- **Admins are per server.** Admin → Access by server has each server's approved roles, approved users, **admins**, and its own "viewers must be approved" and "now playing in voice chat" settings. A regular admin sees and changes only the server they're signed into; super admins see every server.
- Existing admins became admins of the servers that existed before; each server starts with the previous global values of the two settings.
- "Use for web sign-in" is gone; signing in to the website no longer depends on picking a Discord app.

## 0.4.7 — 2026-11-23
- Fixed posters that stayed missing after the media server got them: a saved poster now always wins over an earlier "no poster" answer, that answer is only remembered for 30 minutes, and every refresh asks again for everything.

## 0.4.6 — 2026-11-23
- Titles whose media server has no poster show the plain grey box instead of a broken-image icon.
- A poster found by "Refresh now" or the nightly refresh shows right away, even if the title had no poster earlier.

## 0.4.5 — 2026-11-23
- Fixed Jellyfin/Emby titles with no poster on Browse: their library lists sometimes leave out poster info, and drocsid treated that as "no poster". It now always asks for the title's poster (seasons/episodes without their own use the show's). Titles that truly have none are remembered for 6 hours, and the poster cache counts them as "without a poster" instead of failures.

## 0.4.4 — 2026-11-23
- **Poster cache on disk** (`/data/cache/posters`) for every media server: posters load from drocsid's own disk and survive restarts and updates.
- **Nightly refresh at 2:00 AM** (container time zone): every library that's turned on gets its posters fetched again (new titles ready ahead of time, changed artwork picked up); posters unused for a week are removed.
- Admin → Libraries → Poster cache: count and size, last and next refresh, time zone, **Refresh now** and **Clear cache**.

## 0.4.3 — 2026-11-23
- Jellyfin/Emby posters that sometimes didn't show: drocsid now asks for at most 6 at a time per server, waits longer for each, retries once, and keeps recent posters in memory; the page also re-requests a poster that failed. Failures are logged as `[jf image]`.

## 0.4.2 — 2026-11-23
- With more than one media server, Watching Now, Upcoming Lineup and Play History show which server each entry is from (icon + name in the top right of the tile; long titles trim to fit), and search results show the server too.

## 0.4.1 — 2026-11-23
- With more than one media server, a **Media Servers** section at the top of the left rail shows a tile for each one. Picking a server shows only its libraries (and its Live TV) in the tabs along the top, and its titles in the centre.
- Admin → Connections: ↑ ↓ set the order of media servers. The first one is selected when Browse opens.

## 0.4.0 — 2026-11-23
- **Several media servers, of any kind:** Plex, Jellyfin and Emby. Admin → Connections lists them with Test, Edit and Remove, and **+ Add server** asks which kind, then connects it.
- Plex: Sign in with Plex or address + token. Jellyfin/Emby: username + password, or an API key (browses as the first administrator).
- Each server's movie and TV libraries appear as their own tabs on Browse (the server is named when two libraries share a name). Admin → Libraries shows which server each library is on.
- Search, hover cards, details, posters, cast photos, play, resume, seek, lineup and "now playing" posts work for every server. Jellyfin/Emby streams are transcoded by that server to H.264/AAC HLS; tokens stay on the drocsid server.
- **Live TV from every server** (Plex DVR, Jellyfin and Emby Live TV). Each server's Live TV appears in Admin → Libraries as a "Live TV" entry you turn on or off like a library; the guide shows channels from every server that's on (named by server when there are several). Installs that had picked specific libraries keep Plex Live TV on. The Live TV tab hides when no server's Live TV is on.
- Play history, lineup and resume points from earlier versions keep working (old item keys belong to the first Plex server).

## 0.3.0 — 2026-11-23
- **Setup wizard** at `/setup/`: setup code from the container log, public address, Discord app (with checks for the bot token, client secret, Server Members Intent, Activities and the sign-in redirect), inviting the bot, owner sign-in, and Plex (Sign in with Plex or address + token).
- **Several Discord apps (bots)**, each invitable to any servers you manage. The Activity signs in with whichever app it was launched from.
- **Admin → Connections** (super admins only): public address, Discord apps with status, servers and invite links, and the Plex server with a live check.
- **Access by server**: approved roles and users are now set per Discord server. Admins manage these; only super admins manage connections.
- Voice and text channel pickers group channels by server when there is more than one; announcements go to a text channel in the same server.
- Secrets (client secrets, bot tokens, Plex token) are stored encrypted in `/data/connections.json`, key in `/data/secret.key`.
- Existing installs: settings are imported from the `.env` variables on first start, and approved roles and users move to your existing server. Nothing to click.

## 0.2.38 — 2026-11-23
- Top bar: date reads "MONDAY NOVEMBER 23, 2026"; the version is white, like the Admin link.

## 0.2.37 — 2026-11-23
- The running version is shown in the top bar next to the date (browse and admin pages).
- First release built by GitHub Actions and installed through Unraid's Update button.

## 0.2.36 — 2026-11-22
- Removed the temporary size readout from the player's title bar.

## 0.2.35 — 2026-11-22
- Player sizing measures the Activity box with clientWidth/clientHeight (more reliable inside Discord).
- Temporary size readout in the player's title bar (Activity box, stream size, shown picture size)
  to diagnose full-screen sizing.

## 0.2.34 — 2026-11-22
- Activity player sizing: the picture is sized by the player itself on every window change (and re-checked
  every second), so it keeps scaling after play/pause and full screen. Black borders baked into the video
  (letterbox, pillarbox, or both) are detected from the frames and kept off-screen, so the real picture
  is as large as the window allows. Dark scenes never trigger a crop (borders must show in every recent frame).

## 0.2.33 — 2026-11-22
- Pause indicator reworked: when paused (screen click or the ⏸ button), a ⏸ sits in the center until it
  plays again; on play it turns into ▶ and fades out over 0.25 s. No pop animation on pause.

## 0.2.32 — 2026-11-22
- Activity player: click the picture to pause / play (the person who started it). A big ▶ / ⏸ icon pops and
  fades for everyone on each change, and a ▶ stays in the middle while paused. Others clicking see
  "Only <name> can pause or play".

## 0.2.31 — 2026-11-22
- Activity player: title, timeline and controls, and the mouse pointer, hide after 1.5 s without mouse
  movement and come back as soon as the mouse moves (they stay up while dragging the timeline or volume).

## 0.2.30 — 2026-11-22
- Activity player always shows the whole picture, scaled as large as the window allows (no cropping);
  black bars appear only where the window's shape differs from the video's.

## 0.2.29 — 2026-11-22
- Activity player always fills the window (what the Fill button did); Fill and Full screen buttons removed.

## 0.2.28 — 2026-11-22
- Activity player: ⬚ Fill button (zooms the picture to fill the window, cropping the black bars; remembered
  per viewer) and ⛶ Full screen button (also double-click the picture). Both work for every viewer.

## 0.2.27 — 2026-11-22
- Watch progress per user: while someone has the player open on a movie or episode, their position is
  saved every 20 s (data/progress.json). Pressing Play on that title later offers "Resume from h:mm:ss"
  (default) or "Start from the beginning". Under a minute in, or past 95%, isn't kept.

## 0.2.26 — 2026-11-22
- When everyone closes the Activity player, the stream pauses (after a 10-second grace for reloads);
  when someone opens it again it carries on. If nobody comes back within 3 minutes, the stream ends.
- A stream nobody has opened yet still ends after 10 minutes (as before).

## 0.2.25 — 2026-11-22
- Play History shows the last 8 items (was 25). Older history is still kept on the server.

## 0.2.24 — 2026-11-22
- Play History: Live TV entries show the programme that was on when the stream started (title, with
  channel and sub-title underneath) and the programme's poster instead of the station logo.
  Entries from before this version keep showing the channel only.
- (0.2.23's XMLTV change was withdrawn; guide details are fixed in Dispatcharr instead)

## 0.2.22 — 2026-11-22
- Fix: Live TV guide/posts could show a programme at the wrong time (e.g. 3 hours late). Plex lists
  every airing of a programme, including on other channels/feeds; we now keep only this channel's airing.
- Super-admin diagnostic: /api/admin/guide-debug?id=<channel number> shows the raw guide airings.

## 0.2.21 — 2026-11-22
- Live TV "now playing" posts use the guide: channel number, call sign and logo; the programme on now
  (episode/subtitle, new/rating/year/genres, description, poster); start and end times, time left with a
  live countdown, and what's up next. Times use Discord timestamps, so everyone sees their own time zone.

## 0.2.20 — 2026-11-22
- Two admin levels. Super admins (owners + anyone promoted) can change everything. Admins can manage
  streams, roles, approved users, admins and access settings, but don't see or change Libraries or
  Live TV, and can't add or remove super admins. Enforced on the server, not just hidden in the page.
- Existing admins become regular admins; promote them under Admins → Super admins.

## 0.2.19 — 2026-11-22
- New "Watching Now" panel at the top of the left column: every voice channel that's streaming, with
  poster (or station logo + current programme for Live TV), progress and time left, PAUSED tag, and
  Discord avatars of who has the player open. Refreshes every 5 seconds.

## 0.2.18 — 2026-11-22
- "LIVE TV" tab text lines up with the other tabs (the 📡 icon no longer pushes it down on Windows)

## 0.2.17 — 2026-11-22
- Live TV guide channel column lightened to #acacac, with dark call signs

## 0.2.16 — 2026-11-22
- Live TV guide: channel column is mid grey (#595959) with white call signs so light station logos show up

## 0.2.15 — 2026-11-22
- Library tabs sit flush on the navy strip (no light gap under them) and all have the same height
- Tabs have squarer corners

## 0.2.14 — 2026-11-22
- Search box is vertically centred in the header, level with the logo and sign-in

## 0.2.13 — 2026-11-22
- Logo and Signed in / Sign out are vertically centred in the header (search above the tabs is unchanged)

## 0.2.12 — 2026-11-22
- Search box is centred over the library tabs
- Live TV tab text is white like the other tabs

## 0.2.11 — 2026-11-22
- Library tabs now sit on a navy strip that is the same height as, and level with, the
  Upcoming Lineup and Play History strips, so the bar runs across the whole page

## 0.2.10 — 2026-11-22
- Play dialog: optional "📣 Announce it in a text channel" with a channel drop-down. The bot posts a
  now-playing card (poster, year/rating/runtime, synopsis, link to the voice channel). The choice is
  remembered for next time. Only channels the bot can post in are listed.

## 0.2.9 — 2026-11-22
- The details window now matches the hover card: navy title bar (rating, year, runtime, Rotten Tomatoes),
  poster beside the tagline, full synopsis, genres, director and up to 10 cast members with headshots
- Buttons say "▶ Play" and "📅 Schedule" everywhere

## 0.2.8 — 2026-11-22
- Hover card on movie and show posters: rest the mouse on a poster for about half a second to see
  the tagline, synopsis, genres, director, top 5 cast with headshots, and Play / Schedule / More details
  buttons. It flips to the left near the right edge; details are cached so repeat hovers are instant.

## 0.2.7 — 2026-11-22
- Libraries load more titles automatically as you scroll (no Load more button); posters lazy-load
- A–Z jump bar on the right of the library when sorted A–Z; greyed letters have no titles

## 0.2.6 — 2026-11-22
- Smaller Rotten Tomatoes scores on poster cards

## 0.2.5 — 2026-11-22
- Poster cards show the Rotten Tomatoes score bottom-right (tomato = fresh, splat = rotten; popcorn for
  audience score when there's no critic score). Needs the library's ratings source set to Rotten Tomatoes in Plex.

## 0.2.4 — 2026-11-22
- Admin page: top link is "Back to Home"
- DROCSID wordmark: navy-to-azure gradient (dark at top)
- Admin lists: padding around "Nothing playing." / "None yet."

## 0.2.3 — 2026-11-22
- Sort menu on the right of the library panel; ▸▸ title stays on the left

## 0.2.2 — 2026-11-22
- Library tabs: square (no slants) and centered
- Sort menu moved into the library panel, beside the ▸▸ title

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
