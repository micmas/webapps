/** A viewer's http(s) source grants, each covering its URL and everything below it. */
export function createSourceGrants() {
  const roots = [];
  const contains = (root, value) => {
    const url = new URL(value);
    return url.origin === root.origin && !url.username && !url.password
      && (url.pathname === root.pathname || url.pathname.startsWith(`${root.pathname.replace(/\/$/, '')}/`));
  };
  return {
    add(sources) {
      roots.push(...sources.map(source => {
        const url = new URL(source);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid remote input URL');
        return url;
      }));
    },
    permits(url) { return roots.some(root => contains(root, url)); },
  };
}
