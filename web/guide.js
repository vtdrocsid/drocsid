// Shared set-up guide for the public address (Nginx Proxy Manager), used on the Admin page and
// in the public address wizard. Includes the streaming settings drocsid is tuned for.
const CSS = `
.setup-guide { margin: 6px 0 4px; border: 1px solid #d0d4d9; background: #fff; text-align: left; }
.setup-guide summary { cursor: pointer; padding: 7px 10px; font-weight: bold; color: #1a86d8; }
.setup-guide ol { margin: 0; padding: 4px 18px 12px 34px; line-height: 1.6; }
.setup-guide ol > li { margin: 6px 0; }
.setup-guide ul { margin: 4px 0; padding-left: 18px; }
.setup-guide code { background: #f1f3f5; border: 1px solid #d0d4d9; padding: 0 4px; font-size: 12px; }
.codebox { position: relative; margin: 6px 0; }
.codebox pre { margin: 0; padding: 8px 70px 8px 10px; background: #0f1d2b; color: #d7e6f5; font: 12px/1.6 Consolas, monospace; border-radius: 3px; overflow-x: auto; }
.codebox .btn { position: absolute; top: 6px; right: 6px; }`;

/** The guide's HTML. Examples always use example.domain.com (never the real address). */
export function npmGuide(open = false) {
  const host = 'example.domain.com';
  if (!document.getElementById('setupGuideCss')) {
    const st = document.createElement('style');
    st.id = 'setupGuideCss';
    st.textContent = CSS;
    document.head.append(st);
  }
  return `        <details class="setup-guide"${open ? ' open' : ''}>
          <summary>How to set up the public address in Nginx Proxy Manager</summary>
          <ol>
            <li><b>Domain and ports.</b> Create a DNS record for the address (for example <code>${host}</code>) pointing at your public IP, and forward ports <b>80</b> and <b>443</b> on your router to Nginx Proxy Manager.</li>
            <li><b>Hosts → Proxy Hosts → Add Proxy Host</b>, <b>Details</b> tab:
              <ul>
                <li>Domain Names: <code>${host}</code></li>
                <li>Scheme: <code>http</code></li>
                <li>Forward Hostname / IP: <code>drocsid</code> (the container name, when drocsid and Nginx Proxy Manager share a Docker network such as <code>proxynet</code>), otherwise the server's LAN IP</li>
                <li>Forward Port: <code>3005</code> (drocsid's Web port)</li>
                <li><b>Websockets Support: on</b> (required: the player stays in sync over a WebSocket)</li>
                <li><b>Cache Assets: off</b> (video pieces and playlists change constantly and must never be cached)</li>
              </ul></li>
            <li><b>SSL</b> tab: <b>Request a new SSL Certificate</b> (Let's Encrypt), turn on <b>Force SSL</b>, accept the terms, save.</li>
            <li><b>Advanced</b> tab: paste this into <b>Custom Nginx Configuration</b>. These are the streaming settings drocsid is tuned for:
              <div class="codebox"><pre id="npmConf">proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
send_timeout 3600s;
proxy_buffering off;
proxy_request_buffering off;</pre><button class="btn sm" type="button" data-copy="npmConf">Copy</button></div>
              <ul>
                <li><b>The three timeouts (1 hour)</b> keep the player's sync connection and long video downloads open; the default 60 seconds cuts them off mid-stream.</li>
                <li><b>Buffering off</b> passes video pieces straight through as they arrive instead of Nginx saving them to disk first, which adds delay and stalls while scrubbing.</li>
                <li><b>Don't add <code>proxy_http_version</code></b>: Nginx Proxy Manager already sets it, and a second copy stops the configuration from loading.</li>
              </ul></li>
            <li><b>Check it:</b> open <code>https://${host}/api/config</code> from outside your network (e.g. a phone on mobile data). You should see a short line of text starting with <code>{</code>. Then use <b>Add</b> (or <b>Change</b>) in drocsid: it checks the address works, including WebSockets, before saving it.</li>
            <li><b>In the Discord Developer Portal</b> for each Discord app: add <code>https://${host}/auth/callback</code> under OAuth2 → Redirects, and set Activities → URL Mappings <code>/</code> to <code>${host}</code>.</li>
          </ol>
        </details>`;
}

// Copy buttons (data-copy="<element id>")
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b || !document.getElementById(b.dataset.copy)) return;
  navigator.clipboard?.writeText(document.getElementById(b.dataset.copy).textContent).then(
    () => { const t = b.textContent; b.textContent = 'Copied'; setTimeout(() => { b.textContent = t; }, 1200); },
    () => {},
  );
});
