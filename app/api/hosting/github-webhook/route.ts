import { createHmac, timingSafeEqual } from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'
import {
  createDeployment,
  enqueueDeployJob,
  listAutoDeployApps,
} from '@/lib/data/hosting'

/**
 * GitHub push webhook -> automatic AI redeploy ("мини-CI/CD").
 *
 * Point a repository webhook (Settings → Webhooks) at
 *   POST /api/hosting/github-webhook
 * with content type application/json and the secret from the
 * GITHUB_WEBHOOK_SECRET env var. On every push to a branch tracked by an app
 * with auto_deploy enabled, we enqueue an ai_deploy job — the same autonomous
 * agent that did the original install brings the new commit live.
 *
 * Security: requests MUST carry a valid X-Hub-Signature-256 HMAC. Without the
 * env var configured the endpoint refuses everything (fail closed). The
 * handler never trusts payload URLs beyond matching them against apps the
 * admin explicitly opted into auto-deploy.
 */

export const runtime = 'nodejs'

interface PushPayload {
  ref?: string
  after?: string
  repository?: {
    clone_url?: string
    html_url?: string
    ssh_url?: string
  }
}

function verifySignature(secret: string, body: string, header: string | null): boolean {
  if (!header || !header.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret).update(body).digest('hex')
  const given = header.slice('sha256='.length)
  if (given.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET
  if (!secret) {
    // Fail closed: without a configured secret we can't authenticate GitHub.
    return NextResponse.json({ error: 'webhook not configured' }, { status: 503 })
  }

  const body = await req.text()
  const signature = req.headers.get('x-hub-signature-256')
  if (!verifySignature(secret, body, signature)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }

  const event = req.headers.get('x-github-event')
  if (event === 'ping') return NextResponse.json({ ok: true, pong: true })
  if (event !== 'push') return NextResponse.json({ ok: true, ignored: event })

  let payload: PushPayload
  try {
    payload = JSON.parse(body) as PushPayload
  } catch {
    return NextResponse.json({ error: 'bad payload' }, { status: 400 })
  }

  // refs/heads/main -> main; tag pushes and branch deletions are ignored.
  const ref = payload.ref ?? ''
  if (!ref.startsWith('refs/heads/')) {
    return NextResponse.json({ ok: true, ignored: 'non-branch ref' })
  }
  if (payload.after && /^0+$/.test(payload.after)) {
    return NextResponse.json({ ok: true, ignored: 'branch deleted' })
  }
  const branch = ref.slice('refs/heads/'.length)
  const repoUrl =
    payload.repository?.clone_url ?? payload.repository?.html_url ?? ''
  if (!repoUrl) return NextResponse.json({ error: 'no repository url' }, { status: 400 })

  const apps = await listAutoDeployApps(repoUrl, branch)
  const started: string[] = []
  for (const app of apps) {
    // Skip if the app is mid-deploy already; the fresh push will be picked up
    // on the next webhook or a manual redeploy (avoids piling up agents).
    if (app.status === 'building') continue
    const deployment = await createDeployment(app.id, 'webhook', 'ai')
    await enqueueDeployJob({
      action: 'ai_deploy',
      serverId: app.serverId,
      appId: app.id,
      deploymentId: deployment.id,
    })
    started.push(app.id)
  }

  return NextResponse.json({ ok: true, deploys: started.length })
}
