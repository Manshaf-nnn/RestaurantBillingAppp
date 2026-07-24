'use client'

import * as React from 'react'
import { io, type Socket } from 'socket.io-client'

import { EVENTS, type ServerToClientEvents } from '@/lib/realtime/events'

/**
 * The socket is intentionally untyped at the transport level — event payloads
 * are typed at the subscription boundary (`useSocketEvent`) instead, which
 * keeps the generic plumbing simple while callers stay fully type-safe.
 */
type AppSocket = Socket

/**
 * One shared websocket per browser tab. Every hook subscribes to the same
 * connection, so a dashboard with six live panels still opens one socket.
 */
let socket: AppSocket | null = null
let refCount = 0

function getSocket(): AppSocket {
  if (!socket) {
    const url = process.env.NEXT_PUBLIC_SOCKET_URL || undefined
    socket = io(url, {
      path: '/socket.io',
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 800,
      reconnectionDelayMax: 8_000,
      timeout: 10_000,
    })
  }
  return socket
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected'

export function useSocket() {
  const [state, setState] = React.useState<ConnectionState>('connecting')
  const ref = React.useRef<AppSocket | null>(null)

  React.useEffect(() => {
    const client = getSocket()
    ref.current = client
    refCount += 1

    const onConnect = () => setState('connected')
    const onDisconnect = () => setState('disconnected')
    const onError = () => setState('disconnected')

    client.on('connect', onConnect)
    client.on('disconnect', onDisconnect)
    client.on('connect_error', onError)

    setState(client.connected ? 'connected' : 'connecting')

    return () => {
      client.off('connect', onConnect)
      client.off('disconnect', onDisconnect)
      client.off('connect_error', onError)
      refCount -= 1
      // Last subscriber leaves → tear the connection down.
      if (refCount <= 0) {
        client.disconnect()
        socket = null
        refCount = 0
      }
    }
  }, [])

  return { socket: ref.current, state, connected: state === 'connected' }
}

/** Subscribe to a single realtime event with a stable handler. */
export function useSocketEvent<E extends keyof ServerToClientEvents>(
  event: E,
  handler: ServerToClientEvents[E],
) {
  const { socket: client } = useSocket()
  const saved = React.useRef(handler)

  React.useEffect(() => {
    saved.current = handler
  }, [handler])

  React.useEffect(() => {
    if (!client) return
    const listener = (...args: unknown[]) => {
      ;(saved.current as (...a: unknown[]) => void)(...args)
    }

    client.on(event as string, listener)
    return () => {
      client.off(event as string, listener)
    }
  }, [client, event])
}

/** Joins the room for a specific order (guest tracking, staff detail views). */
export function useOrderRoom(orderId: string | null | undefined) {
  const { socket: client, connected } = useSocket()

  React.useEffect(() => {
    if (!client || !orderId || !connected) return
    client.emit(EVENTS.JOIN_ORDER, orderId)
    return () => {
      client.emit(EVENTS.LEAVE_ORDER, orderId)
    }
  }, [client, orderId, connected])
}
