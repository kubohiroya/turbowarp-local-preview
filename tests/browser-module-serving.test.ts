import path from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  resolveServedBrowserModulePath,
  resolveServedBrowserVendorModulePath,
  rewriteServedBrowserModuleSource
} from '../src/browser-module-serving.js';

describe('browser module serving helpers', () => {
  it('resolves only allowlisted source module directories', () => {
    const sourceRoot = path.resolve('/repo/src');

    expect(
      resolveServedBrowserModulePath({
        requestPath: '/modules/builder/local-preview.js',
        sourceRoot,
        allowedDirectories: ['builder', 'dsl4']
      })
    ).toBe(path.join(sourceRoot, 'builder', 'local-preview.js'));

    expect(
      resolveServedBrowserModulePath({
        requestPath: '/modules/site/local-preview.js',
        sourceRoot,
        allowedDirectories: ['builder', 'dsl4']
      })
    ).toBeNull();
  });

  it('rejects source module path traversal and malformed directories', () => {
    const sourceRoot = path.resolve('/repo/src');

    expect(
      resolveServedBrowserModulePath({
        requestPath: '/modules/builder/../../package.json',
        sourceRoot,
        allowedDirectories: ['builder', 'dsl4']
      })
    ).toBeNull();

    expect(() =>
      resolveServedBrowserModulePath({
        requestPath: '/modules/builder/local-preview.js',
        sourceRoot,
        allowedDirectories: ['builder/../site']
      })
    ).toThrow('allowedDirectories entries must be safe directory names.');
  });

  it('resolves only explicit vendor module request paths', () => {
    const vendorModules = new Map([
      ['/vendor/turbowarp-preview-runtime.js', '/repo/node_modules/preview/dist/index.js']
    ]);

    expect(
      resolveServedBrowserVendorModulePath({
        requestPath: '/vendor/turbowarp-preview-runtime.js',
        vendorModules
      })
    ).toBe('/repo/node_modules/preview/dist/index.js');
    expect(
      resolveServedBrowserVendorModulePath({
        requestPath: '/vendor/package.json',
        vendorModules
      })
    ).toBeNull();
  });

  it('rewrites static bare import and export specifiers', () => {
    const source = [
      "import {x} from '@scope/pkg';",
      "export * from '@scope/pkg';",
      "import('./dynamic.js');"
    ].join('\n');

    expect(
      rewriteServedBrowserModuleSource(source, {
        '@scope/pkg': '/vendor/pkg.js'
      })
    ).toBe(["import {x} from '/vendor/pkg.js';", "export * from '/vendor/pkg.js';", "import('./dynamic.js');"].join('\n'));
  });
});
