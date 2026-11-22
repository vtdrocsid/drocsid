# Drocsid

Watch Plex movies, shows and live TV together in Discord voice channels.

- **Browse portal** (`/browse`): people sign in with Discord. Approved users can browse libraries, search, view the live TV guide, and start something in any voice channel.
- **Admin page** (`/admin`): approved roles and users, admins, active streams, visible libraries, Plex source quality, and Activity output quality.
- **Discord Activity:** viewers open Activities (🚀) in the voice channel and watch one shared, synced stream. Approved users get pause, seek, and stop controls.
- **Plex does all the media work.** Library playback and live TV (tuned on your Plex DVR) both come from Plex's universal transcoder as HLS. This app only proxies it, so the Plex token never reaches a browser.

There are no slash commands. The bot posts "now playing" notices, reads roles and voice channels, and stops a stream when its channel empties.

## How it fits together

```
Browser (portal/admin) ──┐
                         ├─► Drocsid container :3000 ──► Plex (LAN)
Discord Activity iframe ─┘        │
                                  └─► Discord bot gateway
```

One Plex transcode session runs per voice channel. The server owns the playback clock, and every viewer syncs to it, correcting drift by nudging playback speed. A seek restarts Plex's transcode at the new point, so everyone lands together.

## 1. Discord application

In the [Developer Portal](https://discord.com/developers/applications), create an application, then:

1. **OAuth2:** copy the Client ID and Client Secret. Add the redirect `https://discordtv.plunkett.cloud/auth/callback`.
2. **Bot:** reset the token and copy it. Turn on **Server Members Intent**, which the admin page's member picker needs.
3. **Activities → Settings:** enable Activities.
4. **Activities → URL Mappings:** set root `/` to `discordtv.plunkett.cloud`.
5. **Installation:** invite the bot to your server with the `bot` scope and the View Channels and Send Messages permissions.
6. Copy your server ID and your own user ID (Developer Mode, then right-click → Copy ID).

## 2. Plex

- `PLEX_URL`: the LAN address the container can reach, for example `http://192.168.16.10:32400`.
- `PLEX_TOKEN`: the server owner's token. See Plex's "Finding an authentication token" article.
- Live TV uses your existing Plex DVR (Dispatcharr's HDHomeRun tuner and guide). Nothing else needs configuring.

## 3. Reverse proxy

Point `discordtv.plunkett.cloud` at the container's port 3000 in Nginx Proxy Manager and **enable WebSockets support**.

> **Cloudflare:** Cloudflare's terms restrict serving video through its proxy and tunnels on free plans. For this hostname, use a DNS-only (grey cloud) record that forwards to NPM, or accept the risk.

## 4. Run on Unraid

Images are built by GitHub Actions and published to `ghcr.io/<you>/drocsid`.

**Template:** copy `unraid/drocsid.xml` to `/boot/config/plugins/dockerMan/templates-user/my-drocsid.xml`. Replace `GITHUB_OWNER`, then go to Docker → Add Container → drocsid and fill in the variables.

**Compose (Compose Manager plugin):** use `docker-compose.yml` with a `.env` built from `.env.example`.

If the GitHub package is private, log Unraid in once from its terminal:

```sh
docker login ghcr.io -u <github-user>   # password: a GitHub PAT with read:packages
```

## Updating

Push to `main`. GitHub Actions builds and publishes `:latest`. Then on Unraid, either:

- Docker tab → **Check for updates** → **Apply update**, or
- run Watchtower (or Unraid's auto-update plugin) to pull new images automatically.

For releases, tag `v1.2.0`. That publishes `:1.2.0` and `:1.2`, so you can pin a version.

## Local development

```sh
npm install
cp .env.example .env    # fill in
npm run dev             # builds the Activity bundle and starts the server
```

Discord Activities need HTTPS, so use a tunnel (for example `cloudflared tunnel --url http://localhost:3000`). Point a second "dev" Discord application's URL mapping at the tunnel.

## Data

`/data/settings.json` holds everything set on the admin page. Logins are in memory, so a container restart signs people out.

## Notes and limits

- Seeking a library title restarts Plex's transcode, which takes a second or two.
- Live TV resumes at the live edge after a pause.
- The `tune` and `grid` Plex endpoints come from Plex's public API docs. The exact live-session response can vary by Plex version, so test live TV first.
