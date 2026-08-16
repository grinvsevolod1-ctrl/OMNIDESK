import { MaxClient, MaxProtocolError } from './client.js'
import { APP_VERSION, RPC_VERSION } from './protocol.js'

/**
 * Protocol drift detector for MAX.
 *
 * There is no way to "auto-update" a reverse-engineered protocol — nobody
 * publishes a spec. What we CAN do is detect the moment ours stops matching
 * MAX's, so a human bumps the constants in protocol.ts instead of silently
 * losing every MAX account. This runs a real handshake (no login, no SMS) and
 * classifies the result:
 *
 *   ok        — the socket opened and MAX accepted our hello envelope.
 *   drift     — connected, but the handshake was rejected/misshapen: a strong
 *               signal RPC_VERSION / APP_VERSION / the hello opcode changed.
 *   offline   — couldn't even reach the endpoint (network/MAX down); NOT drift.
 *
 * The result feeds an admin alert (see the worker health loop) so protocol
 * breakage surfaces immediately and actionably.
 */
export type CanaryResult =
  | { status: 'ok'; rpcVersion: number; appVersion: string }
  | { status: 'drift'; reason: string }
  | { status: 'offline'; reason: string }

export async function runMaxCanary(): Promise<CanaryResult> {
  const client = new MaxClient()
  try {
    await client.connect()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { status: 'offline', reason }
  }

  try {
    // requestCode with an obviously-invalid phone: we do NOT want a real SMS.
    // A healthy protocol still ACKS the hello + returns a structured error or a
    // token; a drifted protocol throws a transport/protocol error because the
    // envelope no longer parses. Distinguish the two by error kind.
    await client.requestCode('00000000000')
    return { status: 'ok', rpcVersion: RPC_VERSION, appVersion: APP_VERSION }
  } catch (err) {
    if (err instanceof MaxProtocolError) {
      // 'auth'/'protocol' with a server response = handshake was understood,
      // MAX just refused the bogus phone. That's a HEALTHY protocol.
      if (err.kind === 'auth') {
        return { status: 'ok', rpcVersion: RPC_VERSION, appVersion: APP_VERSION }
      }
      // A protocol-shape error or a transport error mid-handshake = drift.
      return { status: 'drift', reason: `${err.kind}: ${err.message}` }
    }
    return {
      status: 'drift',
      reason: err instanceof Error ? err.message : String(err),
    }
  } finally {
    client.disconnect()
  }
}
