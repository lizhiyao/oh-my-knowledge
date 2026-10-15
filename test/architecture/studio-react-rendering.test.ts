/** Studio 的原始 HTML／动态代码入口属于静态边界；实际复核投影由渲染测试验证。 */
import { describe, expect, it } from 'vitest';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { typeScriptSources, parseTypeScript } from '../helpers/source-files.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB_DIR = join(REPO_ROOT, 'src', 'studio', 'web');

function memberName(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  if (ts.isComputedPropertyName(node) && ts.isStringLiteralLike(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
  return undefined;
}

function rawEscapes(source: ts.SourceFile): string[] {
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    const member = memberName(node);
    const property = ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
    const unsafeProperty = property && (member === 'innerHTML' || member === 'outerHTML');
    const unsafeAttribute = (ts.isJsxAttribute(node) || ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
      && memberName(node.name) === 'dangerouslySetInnerHTML';
    let unsafeCall = false;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = memberName(node.expression);
      unsafeCall = name === 'eval' || name === 'Function' || name === 'insertAdjacentHTML';
      if (name === 'write' && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
        unsafeCall = memberName(node.expression.expression) === 'document';
      }
    }
    if (unsafeProperty || unsafeAttribute || unsafeCall) hits.push(node.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe('Studio React 渲染层守门', () => {
  it('真实源码不使用绕开 React 转义的 HTML 或动态代码入口', () => {
    const files = typeScriptSources(WEB_DIR);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some(file => file.endsWith('components/observe/inbox/inbox.tsx'))).toBe(true);
    const violations = files.flatMap(file => rawEscapes(parseTypeScript(file))
      .map(hit => `${relative(REPO_ROOT, file)}::${hit}`));
    expect(violations).toEqual([]);
  });

  it.each([
    'element.innerHTML = value',
    "element['outerHTML'] = value",
    'element.insertAdjacentHTML ("beforeend", value)',
    'document.write (value)',
    "window.document['write'](value)",
    'new Function (value)',
    'globalThis.Function(value)',
    'eval (value)',
    '<div dangerouslySetInnerHTML={{ __html: value }} />',
    'const props = { dangerouslySetInnerHTML: { __html: value } }; <div {...props} />',
    "const props = { ['dangerouslySetInnerHTML']: { __html: value } }; <div {...props} />",
    'const dangerouslySetInnerHTML = { __html: value }; const props = { dangerouslySetInnerHTML }; <div {...props} />',
  ])('控制组：拦截实际代码 %s', code => {
    const source = ts.createSourceFile('probe.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    expect(rawEscapes(source).length).toBeGreaterThan(0);
  });

  it('控制组：说明文字和普通 JSX 不冒充代码执行或 HTML 注入', () => {
    const source = ts.createSourceFile('probe.tsx', `
      // 不得用 element.innerHTML 或 eval(value)
      const warning = 'dangerouslySetInnerHTML / document.write / new Function(';
      <div title={warning}>{value}</div>;
    `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    expect(rawEscapes(source)).toEqual([]);
  });
});
