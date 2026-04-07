/**
 * GitHub Pages project URL uses `base` in astro.config. These helpers keep
 * links, assets, and active-nav logic correct for both `/` (local) and `/axios-retryer/` (prod).
 *
 * `import.meta.env.BASE_URL` may be `/`, `/repo`, or `/repo/`; joining must never
 * concatenate into `/repodocs`.
 */
function basePathRoot(): string {
  const base = import.meta.env.BASE_URL;
  if (base === '/' || base === '') {
    return '';
  }
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

export function withBase(path: string): string {
  const root = basePathRoot();
  if (path === '/' || path === '') {
    return root === '' ? '/' : `${root}/`;
  }
  const segment = path.startsWith('/') ? path : `/${path}`;
  if (root === '') {
    return segment;
  }
  return `${root}${segment}`;
}

/** Normalize `Astro.url.pathname` to a logical route like `/docs/installation` for nav matching */
export function stripBasePath(pathname: string): string {
  const root = basePathRoot();
  if (root === '') {
    return pathname || '/';
  }
  if (pathname === root || pathname === `${root}/`) {
    return '/';
  }
  if (pathname.startsWith(`${root}/`)) {
    const rest = pathname.slice(root.length);
    return rest.startsWith('/') ? rest : `/${rest}`;
  }
  return pathname || '/';
}
