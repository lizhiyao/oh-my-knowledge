import { dirname, relative, resolve } from 'node:path';

// Source folders organize reading; published specification and report URLs stay stable.
const domainPath = /(^|\/)specs\/(shared|entities|knowledge|evaluation|observe)\/(?!index(?:\.(?:md|html))?$)([^/]+)$/;

export function pageRoute(path: string): string {
  return path.replace(domainPath, '$1specs/$3')
    .replace(/(^|\/)specs\/entities\/history\/([^/]+)$/, '$1explanation/$2');
}

/** Rebase source-relative links before VitePress renders a rewritten page. */
export function pageHref(href: string, env: { path: string; realPath?: string }): string {
  if (/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(href)) return href;
  const [path] = href.split(/[?#]/);
  if (!path) return href;
  // Assets keep VitePress's normal resolution; this hook only handles page links.
  if (/\.[^/]+$/.test(path) && !/\.(?:md|html)$/.test(path)) return href;
  if (href.startsWith('/')) return pageRoute(path) + href.slice(path.length);
  const source = env.realPath ?? env.path;
  const target = pageRoute(resolve(dirname(source), path));
  const destination = relative(dirname(pageRoute(env.path)), target).replaceAll('\\', '/');
  return (destination.startsWith('.') ? destination : `./${destination}`) + href.slice(path.length);
}
