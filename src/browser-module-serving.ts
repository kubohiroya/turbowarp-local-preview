import path from 'node:path';

export type BrowserModuleSpecifierReplacements =
  | ReadonlyMap<string, string>
  | Readonly<Record<string, string>>;

export interface BrowserModulePathOptions {
  requestPath: string;
  sourceRoot: string;
  allowedDirectories: readonly string[];
  prefix?: string;
}

export interface BrowserVendorModulePathOptions {
  requestPath: string;
  vendorModules: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
}

function asEntries(input: BrowserModuleSpecifierReplacements): readonly [string, string][] {
  return input instanceof Map ? [...input.entries()] : Object.entries(input);
}

function normalizePrefix(prefix: string): string {
  if (!prefix.startsWith('/') || prefix.endsWith('/')) {
    throw new TypeError('browser module prefix must start with / and must not end with /.');
  }
  return prefix;
}

function normalizedAllowedDirectories(input: readonly string[]): Set<string> {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError('allowedDirectories must be a non-empty array.');
  }
  const result = new Set<string>();
  for (const directory of input) {
    if (typeof directory !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(directory)) {
      throw new TypeError('allowedDirectories entries must be safe directory names.');
    }
    result.add(directory);
  }
  return result;
}

export function resolveServedBrowserModulePath(options: BrowserModulePathOptions): string | null {
  const prefix = normalizePrefix(options.prefix ?? '/modules');
  const sourceRoot = path.resolve(options.sourceRoot);
  const allowedDirectories = normalizedAllowedDirectories(options.allowedDirectories);
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(
    `^${escapedPrefix}/([A-Za-z0-9._-]+)/([A-Za-z0-9._/-]+\\.js)$`,
    'u'
  ).exec(options.requestPath);
  if (!match || !allowedDirectories.has(match[1] ?? '')) return null;
  const directory = path.join(sourceRoot, match[1] as string);
  const candidate = path.resolve(directory, match[2] as string);
  return candidate.startsWith(`${directory}${path.sep}`) ? candidate : null;
}

export function resolveServedBrowserVendorModulePath(
  options: BrowserVendorModulePathOptions
): string | null {
  const entries =
    options.vendorModules instanceof Map
      ? options.vendorModules.entries()
      : Object.entries(options.vendorModules);
  for (const [requestPath, filePath] of entries) {
    if (options.requestPath === requestPath) return filePath;
  }
  return null;
}

export function rewriteServedBrowserModuleSource(
  source: string,
  replacements: BrowserModuleSpecifierReplacements
): string {
  const replacementMap = new Map(asEntries(replacements));
  return source.replace(
    /\b(from|export\s+\*\s+from)\s*(['"])([^'"]+)\2/gu,
    (match, keyword: string, quote: string, specifier: string) => {
      const replacement = replacementMap.get(specifier);
      return replacement === undefined ? match : `${keyword} ${quote}${replacement}${quote}`;
    }
  );
}
