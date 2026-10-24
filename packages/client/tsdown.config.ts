// The browser bundle in dsh's module format, built by dsh's own preset from a
// dsh checkout: ../deepseek-harness beside this repository by default, or DSH_SOURCE. The
// checkout must be at a version inside engines.dsh. dsh's preset inlines SVG,
// PNG and WebP; the GIF portrait (ellen_joe) is inlined the same way here.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const source = process.env.DSH_SOURCE ?? resolve(import.meta.dirname, '../../../deepseek-harness')
const { clientBundle } = await import(pathToFileURL(resolve(source, 'packages/client/tsdown.client.ts')).href)

const gif = {
  name: 'dsh-layerfs:gif',
  load(id: string) {
    if (!id.endsWith('.gif')) return null
    return `export default ${JSON.stringify(`data:image/gif;base64,${readFileSync(id).toString('base64')}`)}`
  },
}

const preset = clientBundle(import.meta.dirname, ['src/index.js'])
export default async (context: unknown) =>
  (await preset(context)).map((config: any) =>
    config && typeof config === 'object' ? { ...config, plugins: [gif, ...(config.plugins ?? [])] } : config,
  )
