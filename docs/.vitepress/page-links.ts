import { dirname, relative, resolve } from 'node:path';

// Source folders organize reading; published specification and report URLs stay stable.
const domainPath = /(^|\/)specs\/(shared|entities|knowledge|evaluation|observe|studio)\/(?!index(?:\.(?:md|html))?$)([^/]+)$/;
const guidePath = /(^|\/)guides\/(knowledge|observe|evaluation|integration|maintenance)\/(?!index(?:\.(?:md|html))?$)([^/]+)$/;
const referencePath = /(^|\/)reference\/(shared|evaluation|integration)\/(?!index(?:\.(?:md|html))?$)([^/]+)$/;

export function pageRoute(path: string): string {
  return path
    .replace(/(^|\/)guides\/evaluation\/quickstart-skill-eval(?=\.(?:md|html)$|$)/, '$1quickstart-skill-eval')
    .replace(/(^|\/)guides\/(?:evaluation\/)?sample-design(?=\.(?:md|html)$|$)/, '$1specs/sample-design-spec')
    .replace(/(^|\/)guides\/integration\/eval-runtime(?=\.(?:md|html)$|$)/, '$1guides/service-evaluation')
    .replace(/(^|\/)reference\/integration\/eval-runtime-recipes(?=\.(?:md|html)$|$)/, '$1guides/eval-runtime')
    .replace(/(^|\/)specs\/evaluation\/history\/eval-core-cutover(?=\.(?:md|html)$|$)/, '$1guides/eval-core-cutover')
    .replace(/(^|\/)specs\/observe\/(effective-observation-review(?:\.(?:md|html))?)$/, '$1explanation/$2')
    .replace(/(^|\/)specs\/studio\/(?:history\/)?(studio-(?:data-flow|performance-baseline)(?:\.(?:md|html))?)$/, '$1explanation/$2')
    .replace(/(^|\/)specs\/evaluation\/history\/([^/]+)$/, '$1specs/$2')
    .replace(domainPath, '$1specs/$3')
    .replace(guidePath, '$1guides/$3')
    .replace(referencePath, '$1reference/$3')
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
