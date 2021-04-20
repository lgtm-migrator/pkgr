import fs from 'fs'
import path from 'path'

import { entries } from '@pkgr/es-modules'
import {
  StringMap,
  getGlobals,
  normalizePkg,
  upperCamelCase,
} from '@pkgr/umd-globals'
import {
  CWD,
  EXTENSIONS,
  PROD,
  __DEV__,
  __PROD__,
  arrayify,
  identify,
  isTsAvailable,
  monorepoPkgs,
  tryExtensions,
  tryFile,
  tryGlob,
  tryPkg,
  tryRequirePkg,
} from '@pkgr/utils'
import babel, { RollupBabelInputPluginOptions } from '@rollup/plugin-babel'
import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import nodeResolve from '@rollup/plugin-node-resolve'
import replace from '@rollup/plugin-replace'
import typescript, { RollupTypescriptOptions } from '@rollup/plugin-typescript'
import url from '@rollup/plugin-url'
import alias, { AliasOptions } from '@rxts/rollup-plugin-alias'
import builtinModules from 'builtin-modules'
import debug from 'debug'
import isGlob from 'is-glob'
import flatMap from 'lodash/flatMap'
import { isMatch } from 'micromatch'
import {
  ModuleFormat,
  OutputOptions,
  Plugin,
  RollupOptions,
  RollupWarning,
  WarningHandler,
} from 'rollup'
import copy, { CopyOptions } from 'rollup-plugin-copy'
import postcss, { PostCSSPluginConf } from 'rollup-plugin-postcss'
import { Options as TerserOptions, terser } from 'rollup-plugin-terser'

// eslint-disable-next-line @typescript-eslint/no-type-alias
type VuePluginOptions = import('rollup-plugin-vue').Options

const vue = tryRequirePkg<(opts?: Partial<VuePluginOptions>) => Plugin>(
  'rollup-plugin-vue',
)

const info = debug('r:info')

const STYLE_EXTENSIONS = [
  '.css',
  '.less',
  '.pcss',
  '.sass',
  '.scss',
  '.styl',
  '.stylus',
]
const IMAGE_EXTENSIONS = [
  '.bmp',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
]
const ASSETS_EXTENSIONS = STYLE_EXTENSIONS.concat(IMAGE_EXTENSIONS)

const resolve = ({ deps, node }: { deps: string[]; node?: boolean }) =>
  nodeResolve({
    dedupe: node ? [] : deps,
    mainFields: [
      !node && 'browser',
      'esnext',
      'es2015',
      'esm2015',
      'fesm2015',
      'esm5',
      'fesm5',
      'module',
      'jsnext:main',
      'main',
    ].filter(Boolean) as readonly string[],
    preferBuiltins: node,
  })

const cjs = (sourceMap: boolean) =>
  commonjs({
    // TODO: add package @pkgr/cjs-ignore ?
    // see also: https://github.com/rollup/rollup-plugin-commonjs/issues/244#issuecomment-536168280
    // hard-coded temporarily
    ignore: ['invariant', 'react-draggable'],
    sourceMap,
  })

const DEFAULT_FORMATS = ['cjs', 'es2015', 'esm']

const regExpCacheMap = new Map<string, string | RegExp>()

const tryRegExp = (exp: string | RegExp) => {
  if (typeof exp === 'string' && (exp = exp.trim())) {
    const cached = regExpCacheMap.get(exp)
    if (cached != null) {
      return cached
    }

    const matched = /^\/(.*)\/([gimsuy]*)$/.exec(exp)
    if (matched) {
      try {
        const regExp = new RegExp(matched[1], matched[2])
        regExpCacheMap.set(exp, regExp)
        return regExp
      } catch {}
    }

    regExpCacheMap.set(exp, exp)
  }

  return exp
}

const onwarn = (warning: RollupWarning, warn: WarningHandler) => {
  if (warning.code === 'THIS_IS_UNDEFINED') {
    return
  }
  warn(warning)
}

export type Format = 'cjs' | 'es2015' | 'es5' | 'esm' | 'umd'

export type External =
  | string
  | string[]
  | ((id: string, collectedExternals?: string[]) => boolean)

export interface ConfigOptions {
  formats?: ModuleFormat[]
  monorepo?: boolean | string[]
  input?: string
  exclude?: string[]
  outputDir?: string
  exports?: OutputOptions['exports']
  external?: External
  externals?: External
  globals?: StringMap
  aliasEntries?: StringMap | AliasOptions['entries']
  copies?: StringMap | CopyOptions['targets'] | CopyOptions
  sourceMap?: boolean
  babel?: RollupBabelInputPluginOptions
  typescript?: RollupTypescriptOptions
  postcss?: Readonly<PostCSSPluginConf>
  vue?: VuePluginOptions
  define?: boolean | Record<string, string>
  terser?: TerserOptions
  prod?: boolean
  watch?: boolean
}

export const COPY_OPTIONS_KEYS: Array<keyof CopyOptions> = [
  'targets',
  'verbose',
  'hook',
  'copyOnce',
]

const isCopyOptions = (
  copies: ConfigOptions['copies'],
): copies is CopyOptions =>
  !!copies &&
  !Array.isArray(copies) &&
  Object.keys(copies).every(key =>
    COPY_OPTIONS_KEYS.includes(key as keyof CopyOptions),
  )

export const config = ({
  formats,
  monorepo,
  input,
  exclude = [],
  outputDir = 'lib',
  exports,
  external,
  externals = external || [],
  globals: umdGlobals,
  aliasEntries = [],
  copies = [],
  sourceMap = false,
  babel: babelOptions,
  typescript: typescriptOptions,
  postcss: postcssOptions = {},
  vue: vueOptions,
  define,
  terser: terserOptions,
  prod = __PROD__,
}: // eslint-disable-next-line sonarjs/cognitive-complexity
ConfigOptions = {}): RollupOptions[] => {
  let pkgs =
    monorepo === false
      ? [CWD]
      : Array.isArray(monorepo)
      ? tryGlob(monorepo)
      : monorepoPkgs

  if (monorepo == null && pkgs.length === 0) {
    pkgs = [CWD]
  }

  const globals = getGlobals({
    globals: umdGlobals,
  })

  const aliasOptions = {
    resolve: [...EXTENSIONS, ...ASSETS_EXTENSIONS],
    entries: [
      ...(Array.isArray(aliasEntries)
        ? aliasEntries.map(({ find, replacement }) => ({
            find: tryRegExp(find),
            replacement,
          }))
        : Object.entries(aliasEntries).map(([find, replacement]) => ({
            find: tryRegExp(find),
            replacement,
          }))),
      ...entries,
    ],
  }

  const copyOptions: CopyOptions = isCopyOptions(copies)
    ? copies
    : {
        targets: Array.isArray(copies)
          ? copies
          : Object.entries(copies).map(
              ([src, dest]: [string, string | string[]]) => ({
                src,
                dest,
              }),
            ),
      }

  const configs = flatMap(pkgs, pkg => {
    const srcPath = path.resolve(pkg, 'src')

    let pkgInput = input
    let pkgOutputDir = outputDir

    if (!fs.existsSync(srcPath) && pkgInput == null) {
      pkgInput = 'index'
    }

    pkgInput = tryExtensions(path.resolve(pkg, pkgInput || 'src/index'))

    if (pkgOutputDir && !pkgOutputDir.endsWith('/')) {
      pkgOutputDir = pkgOutputDir + '/'
    }

    if (!pkgInput || !pkgInput.startsWith(pkg)) {
      return []
    }

    const pkgJson = tryRequirePkg<{
      name: string
      engines: StringMap
      dependencies: StringMap
      peerDependencies: StringMap
    }>(path.resolve(pkg, 'package.json'))

    if (
      !pkgJson ||
      exclude.includes(pkgJson.name) ||
      tryGlob(exclude, path.resolve(pkg, '..')).includes(pkg)
    ) {
      return []
    }

    const {
      name,
      engines: { node = null } = {},
      dependencies = {},
      peerDependencies = {},
    } = pkgJson

    const deps = Object.keys(dependencies)

    const collectedExternals =
      typeof externals === 'function'
        ? []
        : [
            ...arrayify(externals),
            ...Object.keys(peerDependencies),
            ...(node ? [...deps, ...builtinModules] : []),
          ]

    const isTsInput = /\.tsx?/.test(pkgInput)
    const pkgFormats =
      formats && formats.length > 0
        ? formats
        : DEFAULT_FORMATS.concat(node ? [] : 'umd')
    const pkgGlobals = collectedExternals.reduce((pkgGlobals, pkg) => {
      if (pkgGlobals[pkg] == null) {
        pkgGlobals[pkg] = upperCamelCase(normalizePkg(pkg))
      }
      return pkgGlobals
    }, globals)

    let defineValues: Record<string, string> | undefined

    if (define) {
      defineValues = Object.entries(define).reduce(
        (acc, [key, value]: [string, string]) =>
          Object.assign(acc, {
            [key]: JSON.stringify(value),
          }),
        {},
      )
    }

    return pkgFormats.map(format => {
      const isEsVersion = /^es(\d+|next)$/.test(format) && format !== 'es5'
      return {
        input: pkgInput,
        output: {
          file: path.resolve(
            pkg,
            `${pkgOutputDir}${format}${prod ? '.min' : ''}.js`,
          ),
          format: isEsVersion ? 'esm' : (format as ModuleFormat),
          name: pkgGlobals[name] || upperCamelCase(normalizePkg(name)),
          globals,
          exports,
          sourcemap: sourceMap,
        },
        external(id: string) {
          if (typeof externals === 'function') {
            return externals.call(this, id, collectedExternals)
          }
          return collectedExternals.some(pkg => {
            const pkgRegExp = tryRegExp(pkg)
            return pkgRegExp instanceof RegExp
              ? pkgRegExp.test(id)
              : isGlob(pkg)
              ? isMatch(id, pkg)
              : id === pkg || id.startsWith(`${pkg}/`)
          })
        },
        onwarn,
        plugins: [
          alias(aliasOptions),
          isTsAvailable && isTsInput
            ? typescript({
                // @ts-ignore
                jsx: 'react',
                // @ts-ignore
                module: 'esnext',
                tsconfig:
                  // FIXME: should prefer next one
                  tryFile('tsconfig.base.json') ||
                  tryFile(path.resolve(pkg, 'tsconfig.json')) ||
                  tryPkg('@1stg/tsconfig'),
                ...typescriptOptions,
                target: isEsVersion ? format : 'es5',
                sourceMap,
              })
            : babel({
                babelHelpers: 'runtime',
                exclude: ['*.min.js', '*.prod.js', '*.production.js'],
                presets: [
                  [
                    '@babel/env',
                    isEsVersion
                      ? {
                          targets: {
                            esmodules: true,
                          },
                        }
                      : undefined,
                  ],
                ],
                plugins: ['@babel/transform-runtime'],
                ...babelOptions,
              }),
          resolve({
            deps,
            node: !!node,
          }),
          cjs(sourceMap),
          copy(copyOptions),
          json(),
          url({ include: IMAGE_EXTENSIONS.map(ext => `**/*${ext}`) }),
          postcss(postcssOptions),
          ...[
            vue && vue(vueOptions),
            // __DEV__ and __PROD__ will always be replaced while `process.env.NODE_ENV` will be preserved except on production
            define &&
              replace(
                prod
                  ? {
                      ...defineValues,
                      __DEV__: JSON.stringify(false),
                      __PROD__: JSON.stringify(true),
                      'process.env.NODE_ENV': JSON.stringify(PROD),
                    }
                  : {
                      ...defineValues,
                      __DEV__: JSON.stringify(__DEV__),
                      __PROD__: JSON.stringify(__PROD__),
                    },
              ),
            prod && terser(terserOptions),
          ].filter(identify),
        ],
      }
    })
  })

  console.assert(
    configs.length,
    "No configuration resolved, mark sure you've setup correctly",
  )

  return configs
}

export default (options: ConfigOptions = {}) => {
  const configs = [
    ...config(options),
    ...(options.prod ? config({ ...options, prod: false }) : []),
  ]

  info('configs: %O', configs)

  return configs
}
