// Pinterest importer: takes a public pin link and returns that pin's image.
// The browser cannot read Pinterest pages itself (CORS), so this runs on the server.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_BYTES = 15 * 1024 * 1024;

const isPinterestHost = (h) =>
  h === 'pin.it' || /(^|\.)pinterest\.[a-z.]{2,6}$/.test(h);

function fail(res, status, error) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error }));
}

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
    redirect: 'follow',
  });
  return { ok: r.ok, finalUrl: r.url, text: r.ok ? await r.text() : '' };
}

// Every size of a pin image lives under the same hash path, so any one URL gives the rest.
function candidates(imageUrl) {
  const m = imageUrl.match(
    /^https:\/\/i\.pinimg\.com\/[^/]+\/((?:[0-9a-f]{2}\/){3}[0-9a-f]+\.[a-z0-9]+)$/i,
  );
  if (!m) return [];
  return ['originals', '736x', '564x', '236x'].map(
    (size) => `https://i.pinimg.com/${size}/${m[1]}`,
  );
}

async function findImage(pinUrl) {
  const page = await fetchText(pinUrl);
  let finalUrl = pinUrl;
  if (page.ok) {
    finalUrl = page.finalUrl;
    if (!isPinterestHost(new URL(finalUrl).hostname)) return null;
    const og =
      page.text.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i) ||
      page.text.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
    if (og) return og[1];
  }
  const id = finalUrl.match(/\/pin\/(?:[^/]*--)?(\d+)/);
  if (!id) return null;
  const o = await fetchText(
    'https://www.pinterest.com/oembed.json?url=' +
      encodeURIComponent(`https://www.pinterest.com/pin/${id[1]}/`),
  );
  if (!o.ok) return null;
  try {
    return JSON.parse(o.text).thumbnail_url || null;
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  let target;
  try {
    const raw = new URL(req.url, 'http://x').searchParams.get('url') || '';
    target = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
  } catch {
    return fail(res, 400, 'That does not look like a link.');
  }
  target.protocol = 'https:';
  if (!isPinterestHost(target.hostname))
    return fail(res, 400, 'Paste a Pinterest pin link (pinterest.com or pin.it).');

  try {
    const found = await findImage(target.toString());
    if (!found)
      return fail(res, 404, 'No image found. The pin may be private or deleted.');

    for (const url of candidates(found)) {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) continue;
      const type = r.headers.get('content-type') || '';
      if (!type.startsWith('image/')) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_BYTES) continue;
      res.statusCode = 200;
      res.setHeader('Content-Type', type);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.end(buf);
    }
    return fail(res, 404, 'The pin image could not be downloaded.');
  } catch {
    return fail(res, 502, 'Could not reach Pinterest. Try again in a moment.');
  }
};
