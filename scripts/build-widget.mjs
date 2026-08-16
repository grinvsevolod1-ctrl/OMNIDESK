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
  // The widget ships to every visitor of every customer site — often on slow
  // mobile connections — so wire size matters more than readability here.
  // Debug the readable source in widget-src/ instead.
  minify: true,
  banner: {
    js: '/* Generated from widget-src/livechat.js — do not edit public/livechat.js directly. */',
  },
})
