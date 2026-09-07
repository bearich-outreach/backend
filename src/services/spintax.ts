export function expandSpintax(text: string): string {
  return text.replace(/\{([^{}]+)\}/g, (_, group: string) => {
    const opts = String(group).split("|").map(s => s.trim()).filter(Boolean);
    if (!opts.length) return "";
    return opts[Math.floor(Math.random() * opts.length)];
  });
}

export function generateVariants(base: string, n = 3): string[] {
  const set = new Set<string>();
  let attempts = 0;
  while (set.size < n && attempts < n * 10) {
    set.add(expandSpintax(base));
    attempts++;
  }
  return Array.from(set);
}
