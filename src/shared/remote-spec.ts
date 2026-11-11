/**
 * The `layerfs` Remote namespace, written by hand in the shape the Typert
 * generator emits (`createTypertRemoteInfo`). One unary `call` carries every
 * operation as `{ op, args }`; one stream `events` delivers host events.
 * Both faces build the same info from their own `zod` module identity.
 */
import type { z as Zod } from 'zod'

export const PACKAGE = 'dsh-layerfs'
export const NAMESPACE = 'layerfs'
export const SERVICE = 'layerfsRemote'

/** One operation request on the wire. */
export interface LayerfsCall {
  readonly op: string
  readonly args?: unknown
}

/** One host event on the wire. */
export interface LayerfsEvent {
  readonly type: string
  readonly data?: unknown
}

const callJson = {
  type: 'object',
  properties: { op: { type: 'string' }, args: {} },
  required: ['op'],
} as const

/**
 * Build the Remote spec for `createTypertRemoteInfo`.
 * @param z - the caller's zod module.
 * @returns the spec object.
 */
export function remoteSpec(z: typeof Zod) {
  const call = () => z.object({ op: z.string().min(1), args: z.unknown().optional() })
  const strictCall = () => z.object({ op: z.string().min(1), args: z.unknown().optional() }).strict()
  const anyValue = () => z.unknown()
  return {
    package: PACKAGE,
    methods: {
      [`${NAMESPACE}/call`]: {
        service: SERVICE,
        description: 'Run one dsh-layerfs operation.',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'request',
          description: 'The operation name and its JSON arguments.',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: `${PACKAGE}/shared#LayerfsCall`, create: call, jsonSchema: { ...callJson, additionalProperties: true } },
          strictCodec: { mode: 'strict', typeSymbol: `${PACKAGE}/shared#LayerfsCall`, create: strictCall, jsonSchema: { ...callJson, additionalProperties: false } },
        }],
        cancellation: { parameter: 'signal' },
        result: { mode: 'strict', typeSymbol: `${PACKAGE}/shared#LayerfsResult`, create: anyValue, description: 'The operation result.', jsonSchema: {} },
        sourceLocation: { file: 'src/host/remote.ts', line: 1, column: 1 },
      },
      [`${NAMESPACE}/events`]: {
        service: SERVICE,
        description: 'Observe dsh-layerfs host events until cancellation.',
        mode: 'stream',
        invocation: { kind: 'direct' },
        parameters: [],
        cancellation: { parameter: 'signal' },
        result: { mode: 'strict', typeSymbol: `${PACKAGE}/shared#LayerfsEvent`, create: anyValue, description: 'One host event.', jsonSchema: {} },
        sourceLocation: { file: 'src/host/remote.ts', line: 1, column: 1 },
      },
    },
  }
}
