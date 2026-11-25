<p align="center"><img src="web/img/drocsid-logo.svg" alt="drocsid" width="420"></p>

<p align="center"><b>Watch movies and shows together in Discord voice channels, from your own Plex, Jellyfin or Emby server.</b></p>

drocsid runs as a Docker container on your server. It gives you your own Discord app (bot plus Activity) and a web portal:

- **Discord Activity:** everyone in a voice channel opens the Activity (🚀) and watches one shared stream, kept in sync to the frame. Approved users get play/pause, seek (with preview thumbnails when the server has them) and stop.
- **Browse portal:** people sign in with Discord to browse and search your libraries, see Watching Now, the lineup and history, and start something in any voice channel.
- **Admin page:** per Discord server, choose who can browse and play (users and roles) and who admins it; pick which libraries show and in what order; connect more Discord apps and media servers.
- **Plex, Jellyfin and Emby**, several servers at once. Your media server does the transcoding; drocsid only passes the stream through, so server addresses and tokens never reach anyone's browser.

There are no slash commands. The bot posts "now playing" notices, reads roles and voice channels, and stops a stream when its channel empties.

---

## What you need

- An **Unraid** server (or any Docker host) that can reach your Plex, Jellyfin or Emby server.
- A **domain name** you control, for a subdomain such as `example.domain.com`.
- **Nginx Proxy Manager** (or another reverse proxy) with ports **80** and **443** forwarded to it from your router.
- A **Discord account** with **Manage Server** permission on the Discord server(s) you want to watch in.

Throughout this guide, `example.domain.com` stands for your own address. Replace it everywhere.

---

## Step 1 · Install the container (Unraid)

1. Open the Unraid terminal (top right `>_` icon) and download the template:

   ```sh
   wget -O /boot/config/plugins/dockerMan/templates-user/my-drocsid.xml \
     https://raw.githubusercontent.com/vtdrocsid/drocsid/main/unraid/drocsid.xml
   ```

2. Go to **Docker → Add Container**, choose **drocsid** from the **Template** list.
3. Check the settings:
   - **Network Type:** leave it on Unraid's default `bridge` for now. If Nginx Proxy Manager runs on its own Docker network (for example `proxynet`), you can switch drocsid to that network later so the proxy reaches it by name (see step 2).
   - **Web port:** `3005` unless something else already uses it.
   - **WebUI:** leave it as `http://[IP]:[PORT:3005]/`. Unraid's **WebUI** menu item then opens drocsid on your server's IP and port, which is how you reach it during setup. You can point it at your public address once that works (step 5).
   - **App data:** `/mnt/user/appdata/drocsid` holds all settings.
4. Click **Apply**. The container starts and waits for setup. You can check it now: Docker tab → drocsid icon → **WebUI** opens the setup wizard.

> On another network than `bridge`, Unraid's WebUI link uses the container's own IP, which may not be reachable from your PC. If it doesn't open, use `http://<unraid-ip>:3005/` with the port published, or the public address once step 2 is done.

<details>
<summary>Not on Unraid? Docker Compose</summary>

```yaml
services:
  drocsid:
    image: ghcr.io/vtdrocsid/drocsid:latest
    container_name: drocsid
    restart: unless-stopped
    ports:
      - "3005:3005"
    volumes:
      - ./drocsid-data:/data
```

`docker compose up -d`, then carry on with step 2.
</details>

---

## Step 2 · Give drocsid a public address

Discord loads the player from your server and sends people back to it after they sign in, so drocsid needs a public **https** address with a valid certificate. These steps use Nginx Proxy Manager.

1. **DNS:** at your DNS provider, create an **A record** for `example.domain.com` pointing at your public IP (or a CNAME to your dynamic-DNS name).
   - On **Cloudflare**, use **DNS only** (grey cloud). Cloudflare's terms restrict proxying video on free plans, and its proxy also breaks long streams.
2. **Router:** forward ports **80** and **443** to Nginx Proxy Manager, if you haven't already.
3. In Nginx Proxy Manager, go to **Hosts → Proxy Hosts → Add Proxy Host**. On the **Details** tab:
   - **Domain Names:** `example.domain.com`
   - **Scheme:** `http`
   - **Forward Hostname / IP:** your Unraid server's LAN IP (with drocsid on `bridge`), or `drocsid` if you moved drocsid onto the same Docker network as Nginx Proxy Manager
   - **Forward Port:** `3005` (the Web port from step 1)
   - **Websockets Support:** **on** (required: the player stays in sync over a WebSocket)
   - **Cache Assets:** **off** (video pieces and playlists change constantly and must never be cached)
   - **Block Common Exploits:** either way
4. **SSL** tab: **Request a new SSL Certificate** (Let's Encrypt), turn on **Force SSL** (and **HTTP/2 Support**), accept the terms.
5. **Advanced** tab: paste this into **Custom Nginx Configuration**:

   ```nginx
   proxy_read_timeout 3600s;
   proxy_send_timeout 3600s;
   send_timeout 3600s;
   proxy_buffering off;
   proxy_request_buffering off;
   ```

   - The three **timeouts** (1 hour) keep the player's sync connection and long video downloads open. Nginx's default of 60 seconds cuts them off mid-stream.
   - **Buffering off** passes video straight through as it arrives instead of Nginx saving it to disk first, which adds delay and stalls while scrubbing.
   - Don't add `proxy_http_version`. Nginx Proxy Manager already sets it, and a second copy stops the configuration from loading.
6. **Save**, then check it from outside your network (for example a phone on mobile data): open `https://example.domain.com/api/config`. You should see a short line of text starting with `{`.

---

## Step 3 · Run the setup wizard

1. Get the **setup code**: **Docker** tab → click the drocsid icon → **Logs**. Look for:

   ```
   drocsid setup code:  ABCD-EFGH
   ```

2. Open the wizard: **Docker** tab → drocsid icon → **WebUI** (or `http://<unraid-ip>:3005/` in your browser). The public address works too once step 2 is done.
3. Enter the setup code, then your public address (`https://example.domain.com`, no trailing slash).

### Create your Discord app

drocsid runs as your own Discord app, so you choose its name and icon. In another tab, open the [Discord Developer Portal](https://discord.com/developers/applications):

1. **New Application**, give it a name (this is what people see in Discord), and optionally upload an app icon. `brand/discord-app-icon-1024.png` in this repo is ready to use.
2. **OAuth2 → Redirects:** add `https://example.domain.com/auth/callback` and save.
   Copy the **Client ID**, then **Reset Secret** and copy the **Client Secret**.
3. **Bot:** turn on **Server Members Intent** and save. Then **Reset Token** and copy the token.
4. **Activities → Settings:** turn on **Enable Activities**.
5. **Activities → URL Mappings:** set **`/`** to `example.domain.com` (no `https://`).

Paste the Client ID, Client Secret and Bot Token into the wizard. **Test** checks them, then **Continue**.

### Finish the wizard

4. **Add to server:** click **Add to a Discord server** and pick the server(s) to watch in. The wizard updates when the bot joins.
5. **Sign in:** sign in with Discord. You become the **owner**, a super admin who can always change everything.
   Discord always sends you back to your **public address**, so it must work by now (step 2), and the wizard carries on there.
6. **Connect your media server:**
   - **Plex:** **Sign in with Plex** and pick the server and address, or enter the address (as the container reaches it, for example `http://192.168.1.10:32400`) and a [Plex token](https://support.plex.tv/articles/204059436).
   - **Jellyfin / Emby:** the address (for example `http://192.168.1.10:8096`) and either a username and password or an API key (Dashboard → API Keys). A dedicated user that can only see the libraries you want to share is best.
7. **Done.** You land on the Admin page.

---

## Step 4 · Choose who can watch

On the **Admin** page (`https://example.domain.com/admin`):

- **Access** (per Discord server): add **Approved users** and **Approved roles** (they can browse the libraries and play content) and **Admins** (they manage access for that server).
- **Libraries:** turn libraries on or off for each media server, and set their order and sort.
- **Connections** (super admins only): add more Discord apps or media servers, re-order servers (the first is the default on Browse), test, edit, or change the public address.

---

## Step 5 · Point Unraid's WebUI at your address (optional)

Once everything works, you can make Unraid's **WebUI** menu item open the public address: Docker tab → drocsid → **Edit** → set **WebUI** to `https://example.domain.com/admin` → **Apply**. Signing in only works on the public address, so this saves a step. The IP and port keep working for the setup wizard.

---

## Watching

1. Join a voice channel in Discord.
2. Start something: open `https://example.domain.com` (sign in with Discord), pick a title and choose the voice channel.
3. Everyone in the channel clicks the **Activities** button (🚀) and opens your app. Playback stays in sync for everyone; approved users can pause, seek and stop.

---

## Updating

- **Unraid:** Docker tab → **Check for Updates** → **apply update** on drocsid.
- **Compose:** `docker compose pull && docker compose up -d`

Every release is also published with its version number (see [CHANGELOG.md](CHANGELOG.md)). To roll back, set the repository to a version, for example `ghcr.io/vtdrocsid/drocsid:0.5.10`.

Your settings live in the app data folder (`/data` in the container) and survive updates. Back up that folder to keep your setup.

---

## Troubleshooting

- **The wizard's address check fails on WebSockets:** turn on **Websockets Support** on the proxy host.
- **Streams stop after about a minute, or scrubbing stalls:** the **Advanced** settings from step 2 are missing.
- **"Invalid OAuth2 redirect_uri" when signing in:** the redirect in the Developer Portal must be exactly `https://example.domain.com/auth/callback`.
- **The Activity shows a blank screen:** check **Activities → URL Mappings** `/` → `example.domain.com`.
- **The admin page's member picker is empty:** turn on **Server Members Intent** for the bot.
- **Lost the setup code:** restart the container. It prints the code again until setup is finished.
- **Discord sign-in during setup doesn't come back:** the public address isn't working yet. Finish step 2, then open the WebUI again and sign in.
- **Changed your address later:** update both Discord Developer Portal entries (redirect and URL mapping) for every Discord app.

---

## Development

```sh
npm install
npm run build && npm start      # builds the Activity bundle and starts the server on :3005
```

Discord Activities need HTTPS, so use a tunnel (for example `cloudflared tunnel --url http://localhost:3005`) and a separate "dev" Discord app whose redirect and URL mapping point at it. Tests: `node scripts/smoke.mjs` and `node scripts/sources-test.mjs`.

Media server logos in `web/img` are from [dashboard-icons](https://github.com/homarr-labs/dashboard-icons) (Apache-2.0); see `web/img/NOTICE.md`.
