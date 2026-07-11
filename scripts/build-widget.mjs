import { build } from 'esbuild'

await build({
  entryPoints: ['widget-src/livechat.js'],
  outfile: 'public/livechat.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  charset: 'utf8',
  legalComments: 'none',
  banner: {
    js: '/* Generated from widget-src/livechat.js — do not edit public/livechat.js directly. */',
  },
})
