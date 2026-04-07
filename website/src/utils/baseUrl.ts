/**
 * GitHub Pages project URL uses `base` in astro.config. These helpers keep
 * links, assets, and active-nav logic correct for both `/` (local) and `/axios-retryer/` (prod).
 */
export function withBase(path: string): string {
  const base = import.meta.env.BASE_URL;
  if (path === '/' || path === '') {
    return base;
  }
  const p = path.startsWith('/') ? path.slice(1) : path;
  return `${base}${p}`;
}

/** Normalize `Astro.url.pathname` to a logical route like `/docs/installation` for nav matching */
export function stripBasePath(pathname: string): string {
  const base = import.meta.env.BASE_URL;
  if (base === '/' || base === '') {
    return pathname || '/';
  }
  const root = base.endsWith('/') ? base.slice(0, -1) : base;
  if (pathname === root || pathname === `${root}/`) {
    return '/';
  }
  if (pathname.startsWith(`${root}/`)) {
    const rest = pathname.slice(root.length);
    return rest.startsWith('/') ? rest : `/${rest}`;
  }
  return pathname || '/';
}
