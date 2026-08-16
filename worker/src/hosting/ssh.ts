import { createHash } from 'node:crypto'
import { Client, type ConnectConfig } from 'ssh2'
import { logger } from '../logger.js'

/**
 * Thin promise-based wrapper over ssh2 for the hosting pipeline.
 *
 * Security: the SSH host key is PINNED. On first connect to a server we capture
 * its key fingerprint and persist it (see pipeline/metrics callers); on every
 * later connect we refuse to proceed if the presented key doesn't match the
 * pinned one, defeating man-in-the-middle attacks against the channel that
 * carries deploy commands and secrets.
 */

export interface SshTarget {
  host: string
  port: number
  username: string
  authType: 'ssh_key' | 'password'
  /** Decrypted private key (PEM) or password. */
  secret: string
  /** Previously pinned host-key fingerprint (sha256 base64), or null on first connect. */
  pinnedFingerprint: string | null
}

export interface SshConnection {
  client: Client
  /** sha256 base64 fingerprint of the server's host key seen on this connect. */
  fingerprint: string
}

/** Compute the fingerprint we pin: base64(sha256(hostKey)). */
function fingerprintOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64')
}

/**
 * Open an SSH connection. Rejects when the host key doesn't match a previously
 * pinned fingerprint. The caller is responsible for persisting the returned
 * fingerprint on first connect (pinnedFingerprint === null).
 */
export function connect(target: SshTarget): Promise<SshConnection> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let seenFingerprint = ''
    let hostKeyRejected = false

    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: 20_000,
      // Pin the host key: capture its fingerprint and compare to the stored one.
      hostVerifier: (key: Buffer): boolean => {
        seenFingerprint = fingerprintOf(key)
        if (target.pinnedFingerprint && target.pinnedFingerprint !== seenFingerprint) {
          hostKeyRejected = true
          return false
        }
        return true
      },
    }
    if (target.authType === 'ssh_key') {
      config.privateKey = target.secret
    } else {
      config.password = target.secret
    }

    client.on('ready', () => resolve({ client, fingerprint: seenFingerprint }))
    client.on('error', (err) => {
      if (hostKeyRejected) {
        reject(
          new Error(
            'Host key mismatch — the server SSH fingerprint changed. ' +
              'Connection refused to prevent a man-in-the-middle attack.',
          ),
        )
        return
      }
      reject(err instanceof Error ? err : new Error(String(err)))
    })

    try {
      client.connect(config)
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Run a command and stream its output line-by-line to onLine as it arrives
 * (used for live deploy logs). Resolves with the exit code and captured output.
 */
export function execStream(
  client: Client,
  command: string,
  onLine: (stream: 'stdout' | 'stderr', line: string) => void,
  signal?: AbortSignal,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err)
        return
      }
      let stdout = ''
      let stderr = ''
      let outBuf = ''
      let errBuf = ''
      let code = 0
      let aborted = false

      // Cooperative interruption: when the caller aborts (e.g. the admin
      // cancelled the deploy), signal the remote process and tear the channel
      // down so a long-running command stops promptly instead of running to
      // completion.
      const onAbort = (): void => {
        aborted = true
        try {
          stream.signal('KILL')
        } catch {
          /* ignore */
        }
        try {
          stream.close()
        } catch {
          /* ignore */
        }
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })

      const flush = (which: 'stdout' | 'stderr', buf: string, rest: string) => {
        const parts = (buf + rest).split(/\r?\n/)
        const tail = parts.pop() ?? ''
        for (const line of parts) onLine(which, line)
        return tail
      }

      stream.on('data', (data: Buffer) => {
        const text = data.toString('utf8')
        stdout += text
        outBuf = flush('stdout', outBuf, text)
      })
      stream.stderr.on('data', (data: Buffer) => {
        const text = data.toString('utf8')
        stderr += text
        errBuf = flush('stderr', errBuf, text)
      })
      stream.on('close', (exitCode: number | null) => {
        if (signal) signal.removeEventListener('abort', onAbort)
        // Emit any trailing partial line without a newline.
        if (outBuf) onLine('stdout', outBuf)
        if (errBuf) onLine('stderr', errBuf)
        if (aborted) {
          reject(new Error('aborted'))
          return
        }
        code = exitCode ?? 0
        resolve({ code, stdout, stderr })
      })
      stream.on('error', (streamErr: Error) => {
        if (signal) signal.removeEventListener('abort', onAbort)
        reject(streamErr)
      })
    })
  })
}

/** Run a command and collect its output without streaming (health checks). */
export function execCollect(client: Client, command: string): Promise<ExecResult> {
  return execStream(client, command, () => {})
}

/** Close an SSH connection, swallowing any teardown error. */
export function disconnect(client: Client): void {
  try {
    client.end()
  } catch (err) {
    logger.warn({ err }, 'ssh disconnect failed')
  }
}
