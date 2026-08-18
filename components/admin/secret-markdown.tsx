'use client'

import type React from 'react'
import { cn } from '@/lib/utils'

/**
 * Markdown-lite renderer shared by god-panel AI surfaces (site reports, ping
 * security assessment). Supports headings, bold, inline code, ordered/unordered
 * lists, tables and horizontal rules. No external deps and NO HTML injection —
 * everything is built from React elements.
 *
 * SACRED INVARIANT (AGENTS.md §4): god-panel only.
 */

function InlineText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**')) {
          return (
            <strong key={i} className="font-semibold text-foreground">
              {p.slice(2, -2)}
            </strong>
          )
        }
        if (p.startsWith('`') && p.endsWith('`')) {
          return (
            <code
              key={i}
              className="rounded bg-muted px-1 font-mono text-[0.85em]"
            >
              {p.slice(1, -1)}
            </code>
          )
        }
        return p
      })}
    </>
  )
}

function MdTable({ rows }: { rows: string[] }) {
  const parse = (line: string) =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim())
  const header = parse(rows[0])
  const body = rows
    .slice(1)
    .filter((r) => !/^\|?[\s:|-]+\|?$/.test(r))
    .map(parse)
  return (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b">
            {header.map((h, i) => (
              <th
                key={i}
                className={cn(
                  'px-2 py-1.5 font-medium text-muted-foreground',
                  i === 0 ? 'text-left' : 'text-right',
                )}
              >
                <InlineText text={h} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((cells, ri) => (
            <tr key={ri} className="border-b border-border/50 last:border-0">
              {cells.map((c, ci) => (
                <td
                  key={ci}
                  className={cn(
                    'px-2 py-1.5',
                    ci === 0 ? 'text-left' : 'text-right font-mono tabular-nums',
                  )}
                >
                  <InlineText text={c} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const out: React.ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    // Table block
    if (line.trimStart().startsWith('|')) {
      const rows: string[] = []
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        rows.push(lines[i].trim())
        i++
      }
      if (rows.length >= 2) {
        out.push(<MdTable key={key++} rows={rows} />)
        continue
      }
      out.push(
        <p key={key++} className="my-1 text-sm leading-relaxed">
          <InlineText text={rows[0]} />
        </p>,
      )
      continue
    }

    // List block
    if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      const items: string[] = []
      const ordered = /^\s*\d+[.)]/.test(line)
      while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+[.)])\s+/, ''))
        i++
      }
      const cls = 'my-1.5 flex flex-col gap-1 pl-5 text-sm leading-relaxed'
      out.push(
        ordered ? (
          <ol key={key++} className={cn(cls, 'list-decimal')}>
            {items.map((it, j) => (
              <li key={j}>
                <InlineText text={it} />
              </li>
            ))}
          </ol>
        ) : (
          <ul key={key++} className={cn(cls, 'list-disc')}>
            {items.map((it, j) => (
              <li key={j}>
                <InlineText text={it} />
              </li>
            ))}
          </ul>
        ),
      )
      continue
    }

    i++

    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      const level = h[1].length
      out.push(
        <p
          key={key++}
          className={cn(
            'text-balance font-semibold text-foreground',
            level === 1 && 'mb-2 mt-1 text-base',
            level === 2 && 'mb-1.5 mt-4 text-sm uppercase tracking-wide',
            level >= 3 && 'mb-1 mt-3 text-sm',
          )}
        >
          <InlineText text={h[2]} />
        </p>,
      )
      continue
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      out.push(<hr key={key++} className="my-3 border-border" />)
      continue
    }

    if (line.trim() === '') continue

    out.push(
      <p key={key++} className="my-1 text-sm leading-relaxed">
        <InlineText text={line} />
      </p>,
    )
  }

  return <div className="text-foreground/90">{out}</div>
}
