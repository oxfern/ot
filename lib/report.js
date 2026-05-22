// Formatters / aggregations for OneTab data.

export function summarize(groups) {
  const totalGroups = groups.length;
  const totalTabs = groups.reduce((n, g) => n + g.tabs.length, 0);
  const locked = groups.filter(g => g.isLocked).length;
  const starred = groups.filter(g => g.isStarred).length;
  const named = groups.filter(g => g.label).length;

  const dates = groups.map(g => g.createDate).filter(Boolean).sort((a, b) => a - b);
  const oldest = dates[0] ? new Date(dates[0]) : null;
  const newest = dates[dates.length - 1] ? new Date(dates[dates.length - 1]) : null;

  const domains = new Map();
  let withFavicon = 0;
  let pinned = 0;
  for (const g of groups) {
    for (const t of g.tabs) {
      if (t.favIconUrl) withFavicon++;
      if (t.pinned) pinned++;
      const d = hostOf(t.url);
      if (d) domains.set(d, (domains.get(d) ?? 0) + 1);
    }
  }
  const uniqueDomains = domains.size;

  // top 15 domains
  const topDomains = [...domains.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  // group-size distribution
  const sizes = groups.map(g => g.tabs.length).sort((a, b) => a - b);
  const largest = groups
    .map(g => ({ label: g.label, count: g.tabs.length, date: g.createDate }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    totalGroups, totalTabs, locked, starred, named,
    oldest, newest,
    uniqueDomains, withFavicon, pinned,
    topDomains,
    median: sizes[Math.floor(sizes.length / 2)] ?? 0,
    largest,
  };
}

export function hostOf(url) {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return null; }
}

export function fmtDate(d) {
  if (!d) return '—';
  if (!(d instanceof Date)) d = new Date(d);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export function bar(n, max, width = 24) {
  if (max <= 0) return '';
  const filled = Math.round((n / max) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function trunc(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
