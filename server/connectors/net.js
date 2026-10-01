// fetch with a timeout and a few retries on network blips ("fetch failed", resets, DNS hiccups).
export async function netFetch(url, opts = {}, { tries = 3, timeoutMs = 20000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) {
      last = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  const why = last?.cause?.code || last?.cause?.message || last?.name || last?.message;
  throw new Error(`Couldn't reach ${host} (${why}) after ${tries} tries. Check the internet connection and try again.`);
}
