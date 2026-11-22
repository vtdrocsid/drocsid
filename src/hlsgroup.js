// Plex's transcoder emits ~1 s HLS segments. Through Discord's proxy each request costs about as long
// as a segment plays, so the player never gets ahead. We rewrite Plex's media playlist to group N
// consecutive segments into one "virtual" segment; the server fetches the N pieces from Plex over the
// LAN in parallel and returns them concatenated (MPEG-TS can be joined byte-for-byte).

export const GROUP = 6;
const SAFE = /^[\w.\-]+$/;

/**
 * Rewrite a media playlist. Groups align to absolute segment numbers (media sequence + index), so
 * group boundaries stay stable across playlist reloads, including sliding live windows.
 * Incomplete trailing groups are held back until complete, unless the playlist has ended.
 */
export function groupPlaylist(text, n = GROUP) {
  const lines = text.split(/\r?\n/);
  if (!lines.some((l) => l.startsWith('#EXTINF'))) return text; // master playlist or empty: leave alone

  const header = [];
  const segs = [];
  let mediaSeq = 0, ended = false, pendingTags = [], dur = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { mediaSeq = parseInt(line.split(':')[1], 10) || 0; continue; }
    if (line.startsWith('#EXT-X-TARGETDURATION:')) continue;
    if (line.startsWith('#EXT-X-ENDLIST')) { ended = true; continue; }
    if (line.startsWith('#EXTINF:')) { dur = parseFloat(line.slice(8)) || 0; continue; }
    if (line.startsWith('#')) {
      if (!segs.length && dur === null && !pendingTags.length && !/^#EXT-X-(DISCONTINUITY|PROGRAM-DATE-TIME|KEY|MAP)/.test(line)) header.push(line);
      else pendingTags.push(line);
      continue;
    }
    if (dur === null) continue; // a URI without EXTINF: ignore
    segs.push({ uri: line.trim(), dur, tags: pendingTags });
    pendingTags = [];
    dur = null;
  }
  if (!segs.every((s) => SAFE.test(s.uri))) return text; // unexpected URI shapes (absolute URLs etc.): don't touch

  const groups = [];
  for (let i = 0; i < segs.length; i++) {
    const abs = mediaSeq + i;
    if (abs % n !== 0) { if (!groups.length) continue; } // skip a leading partial group
    if (abs % n === 0) groups.push({ index: abs / n, segs: [] });
    groups[groups.length - 1].segs.push(segs[i]);
  }
  const complete = groups.filter((g, i) => g.segs.length === n || (ended && i === groups.length - 1));
  if (!complete.length) {
    // Not enough yet (first second of a transcode): an empty playlist makes the player retry shortly.
    return ['#EXTM3U', ...header.filter((l) => !l.startsWith('#EXTM3U')), '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:0', ''].join('\n');
  }

  const out = [...header.filter((l) => !l.startsWith('#EXTM3U'))];
  const maxDur = Math.max(...complete.map((g) => g.segs.reduce((a, s) => a + s.dur, 0)));
  const body = [];
  for (const g of complete) {
    for (const s of g.segs) body.push(...s.tags);
    const d = g.segs.reduce((a, s) => a + s.dur, 0);
    body.push(`#EXTINF:${d.toFixed(6)},`);
    body.push(`grp.ts?u=${g.segs.map((s) => encodeURIComponent(s.uri)).join(',')}`);
  }
  return [
    '#EXTM3U',
    ...out,
    `#EXT-X-TARGETDURATION:${Math.ceil(maxDur)}`,
    `#EXT-X-MEDIA-SEQUENCE:${complete[0].index}`,
    ...body,
    ...(ended ? ['#EXT-X-ENDLIST'] : []),
    '',
  ].join('\n');
}

/** Validate the ?u= list of a grouped segment request. */
export function parseGroup(query) {
  const parts = String(query || '').split(',').map((p) => decodeURIComponent(p));
  if (!parts.length || parts.length > 20 || !parts.every((p) => SAFE.test(p))) return null;
  return parts;
}
