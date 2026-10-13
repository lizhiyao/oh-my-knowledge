import { dirname, relative, resolve } from 'node:path';

// Source folders express domains; published spec URLs keep their existing identity.
const domainPath = /(^|\/)specs\/(shared|entities|knowledge|evaluation|observe)\/([^/]+)$/;

export function specRoute(path: string): string {
  return path.replace(domainPath, '$1specs/$3');
}

/** Rebase source-relative links before VitePress renders a rewritten page. */
export function specHref(href: string, env: { path: string; realPath?: string }): string {
  if (/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(href)) return href;
  const [path] = href.split(/[?#]/);
  if (!path) return href;
  // Assets keep VitePress's normal resolution; this hook only handles page links.
  if (/\.[^/]+$/.test(path) && !/\.(?:md|html)$/.test(path)) return href;
  if (href.startsWith('/')) return specRoute(path) + href.slice(path.length);
  const source = env.realPath ?? env.path;
  const target = specRoute(resolve(dirname(source), path));
  const destination = relative(dirname(specRoute(env.path)), target).replaceAll('\\', '/');
  return (destination.startsWith('.') ? destination : `./${destination}`) + href.slice(path.length);
}
