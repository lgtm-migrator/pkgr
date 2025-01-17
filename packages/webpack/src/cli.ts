#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { __DEV__, openBrowser, PROD, tryRequirePkg } from '@pkgr/utils'
import { program } from 'commander'
import debug from 'debug'
import { JSOX } from 'jsox'
import webpack, { Compiler, StatsCompilation } from 'webpack'
import WebpackDevServer from 'webpack-dev-server'

import config, { ConfigOptions, port } from './config.js'

const info = debug('w:info')

const _dirname =
  typeof __dirname === 'undefined'
    ? path.dirname(fileURLToPath(import.meta.url))
    : __dirname

const jsoxParse = <T>(text: string) => JSOX.parse(text) as T

program
  .version(
    tryRequirePkg<{
      version: string
    }>(path.resolve(_dirname, '../package.json'))!.version,
  )
  .option('-e, --entry <filename>', 'input entry file path')
  .option(
    '-t, --type <enum>',
    'app type, could be angular, react, vue currently',
  )
  .option('-o, --output-dir [output]', 'output destination directory')
  .option(
    '-x, --externals <JSOX>',
    'extra external packages, peerDependencies, and dependencies for node by default',
    jsoxParse,
  )
  .option(
    '-g, --globals <JSOX>',
    'JSON string to be parsed as umd globals map',
    jsoxParse,
  )
  .option(
    '-c, --copies <JSOX>',
    'targets setting or whole CopyOptions for copy-webpack-plugin, could be array or object',
    jsoxParse,
  )
  .option(
    '--disableDotRule [boolean]',
    'whether to enable `disableDotRule` for `history-api-fallback`',
  )
  .option('--preferCssModules <boolean>', 'prefer css modules or global styles')
  .option('--publicPath [path]', '`publicPath` setting for `output.publicPath`')
  .option(
    '-p, --prod [boolean]',
    'whether to enable production(.min.js for lib) bundle together at the same time',
  )
  .parse(process.argv)

const options = program.opts<ConfigOptions>()

info('options: %O', options)

const handlerError = (error: Error | StatsCompilation) => {
  console.error(error)
  process.exitCode = 1
}

const startWatcher = (compiler: Compiler) => {
  const devServer = new WebpackDevServer(compiler.options.devServer, compiler)
  devServer.start().catch(handlerError)
  let isFirstCompile = true
  compiler.hooks.done.tap('@pkgr/webpack watcher', () => {
    if (!isFirstCompile) {
      return
    }
    isFirstCompile = false
    openBrowser(`http://localhost:${port}`)
  })
}

const main = async () => {
  if (options.prod && !process.env.NODE_ENV) {
    process.env.NODE_ENV = PROD
  }

  const webpackConfig = await config(options)

  const compiler = webpack(webpackConfig)

  if (__DEV__ && !options.prod) {
    startWatcher(compiler)
  } else {
    compiler.run((error, stats) => {
      if (error) {
        return handlerError(error)
      }

      if (stats?.hasErrors()) {
        return handlerError(stats.toJson())
      }
    })
  }
}

main().catch(console.error)
