// Live view of the connection settings (see connections.js). Everything here is set up in the
// browser now; the old .env variables are only read once, to import an existing install.
// Everything else adjustable at runtime lives in settings.js.
import * as conn from './connections.js';

export const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  get publicUrl() { return (conn.get().publicUrl || process.env.PUBLIC_URL || '').replace(/\/$/, ''); },
  /** The primary Discord app: used for the web portal's "Sign in with Discord". */
  get clientId() { return conn.primaryApp()?.id || ''; },
  get clientSecret() { return conn.appSecret(conn.primaryApp()); },
  /** Owners are permanent super admins (set during setup). */
  get ownerIds() { return conn.get().ownerIds; },
  get plexUrl() { return conn.plexServer()?.url || ''; },
  get plexToken() { return conn.plexServer()?.token || ''; },
  get plexClientId() { return conn.get().plexClientId; },
  dataDir: conn.dataDir,
  port: Number(process.env.PORT || 3005),
};
