import jsdom, { JSDOM } from 'jsdom'
import { InitOptions } from '../../'
import { AnalyticsBrowser, loadLegacySettings } from '../../browser'
import { snippet } from '../../tester/__fixtures__/segment-snippet'
import { install, AnalyticsSnippet } from '../standalone-analytics'
import { mocked } from 'ts-jest/utils'
import unfetch from 'unfetch'
import { PersistedPriorityQueue } from '../../lib/priority-queue/persisted'

const track = jest.fn()
const identify = jest.fn()
const page = jest.fn()
const setAnonymousId = jest.fn()
const register = jest.fn()
const addSourceMiddleware = jest.fn()
const on = jest.fn()

jest.mock('@/core/analytics', () => ({
  Analytics: (_: unknown, options?: InitOptions): unknown => ({
    track,
    identify,
    page,
    setAnonymousId,
    addSourceMiddleware,
    register,
    emit: jest.fn(),
    on,
    queue: {
      queue: new PersistedPriorityQueue(1, 'event-queue'),
    },
    options,
  }),
}))

const fetchSettings = Promise.resolve({
  json: () =>
    Promise.resolve({
      integrations: {},
    }),
})

jest.mock('unfetch', () => {
  return jest.fn()
})

describe('standalone bundle', () => {
  const segmentDotCom = `foo`

  beforeEach(async () => {
    ;(window as any).analytics = undefined
    const html = `
    <!DOCTYPE html>
      <head>
        <script>
          ${snippet(
            segmentDotCom,
            true,
            `
            window.analytics.track('fruit basket', { fruits: ['🍌', '🍇'] })
            window.analytics.identify('netto', { employer: 'segment' })
            window.analytics.setAnonymousId('anonNetto')
            window.analytics.on('initialize', () => ({ user: 'ariel' }))
          `
          )}
        </script>
      </head>
      <body>
      </body>
    </html>
    `.trim()

    const virtualConsole = new jsdom.VirtualConsole()
    const jsd = new JSDOM(html, {
      runScripts: 'dangerously',
      resources: 'usable',
      url: 'https://segment.com',
      virtualConsole,
    })

    const windowSpy = jest.spyOn(global, 'window', 'get')
    const documentSpy = jest.spyOn(global, 'document', 'get')

    jest.spyOn(console, 'warn').mockImplementationOnce(() => {})

    windowSpy.mockImplementation(() => {
      return jsd.window as unknown as Window & typeof globalThis
    })

    documentSpy.mockImplementation(
      () => jsd.window.document as unknown as Document
    )
  })

  it('detects embedded write keys', async () => {
    window.analyticsWriteKey = 'write_key_abc_123'

    const fakeAjs = {
      ready: async (cb: Function): Promise<void> => {
        cb()
      },
    }

    const spy = jest
      .spyOn(AnalyticsBrowser, 'standalone')
      .mockResolvedValueOnce(fakeAjs as AnalyticsSnippet)

    await install()

    expect(spy).toHaveBeenCalledWith('write_key_abc_123', {})
  })

  it('derives the write key from scripts on the page', async () => {
    const fakeAjs = {
      ready: async (cb: Function): Promise<void> => {
        cb()
      },
    }
    const spy = jest
      .spyOn(AnalyticsBrowser, 'standalone')
      .mockResolvedValueOnce(fakeAjs as AnalyticsSnippet)

    await install()

    expect(spy).toHaveBeenCalledWith(segmentDotCom, {})
  })

  it('derives the CDN from scripts on the page', async () => {
    // @ts-ignore ignore Response required fields
    mocked(unfetch).mockImplementation((): Promise<Response> => fetchSettings)

    await loadLegacySettings(segmentDotCom)

    expect(unfetch).toHaveBeenCalledWith(
      'https://cdn.foo.com/v1/projects/foo/settings'
    )
  })

  it('is capable of having the CDN overridden', async () => {
    // @ts-ignore ignore Response required fields
    mocked(unfetch).mockImplementation((): Promise<Response> => fetchSettings)
    const mockCdn = 'http://my-overridden-cdn.com'

    window.analytics._cdn = mockCdn
    await loadLegacySettings(segmentDotCom)

    expect(unfetch).toHaveBeenCalledWith(expect.stringContaining(mockCdn))
  })

  it('runs any buffered operations after load', async (done) => {
    // @ts-ignore ignore Response required fields
    mocked(unfetch).mockImplementation((): Promise<Response> => fetchSettings)

    await install()

    setTimeout(() => {
      expect(track).toHaveBeenCalledWith('fruit basket', {
        fruits: ['🍌', '🍇'],
      })
      expect(identify).toHaveBeenCalledWith('netto', {
        employer: 'segment',
      })

      expect(page).toHaveBeenCalled()
      done()
    }, 0)
  })

  it('adds buffered source middleware before other buffered operations', async (done) => {
    // @ts-ignore ignore Response required fields
    mocked(unfetch).mockImplementation((): Promise<Response> => fetchSettings)

    const operations: string[] = []

    addSourceMiddleware.mockImplementationOnce(() =>
      operations.push('addSourceMiddleware')
    )
    page.mockImplementationOnce(() => operations.push('page'))

    await install()

    setTimeout(() => {
      expect(addSourceMiddleware).toHaveBeenCalled()

      expect(operations).toEqual([
        // should run before page call in the snippet
        'addSourceMiddleware',
        'page',
      ])
      done()
    }, 0)
  })

  it('sets buffered anonymousId before loading destinations', async (done) => {
    // @ts-ignore ignore Response required fields
    mocked(unfetch).mockImplementation((): Promise<Response> => fetchSettings)

    const operations: string[] = []

    track.mockImplementationOnce(() => operations.push('track'))
    setAnonymousId.mockImplementationOnce(() =>
      operations.push('setAnonymousId')
    )
    register.mockImplementationOnce(() => operations.push('register'))

    await install()

    setTimeout(() => {
      expect(setAnonymousId).toHaveBeenCalledWith('anonNetto')

      expect(operations).toEqual([
        // should run before any plugin is registered
        'setAnonymousId',
        // should run before any events are sent downstream
        'register',
        // should run after all plugins have been registered
        'track',
      ])
      done()
    }, 0)
  })
  it('sets buffered event emitters before loading destinations', async (done) => {
    mocked(unfetch).mockImplementation(() => fetchSettings as Promise<Response>)

    const operations: string[] = []

    track.mockImplementationOnce(() => operations.push('track'))
    on.mockImplementationOnce(() => operations.push('on'))
    register.mockImplementationOnce(() => operations.push('register'))

    await install()

    setTimeout(() => {
      expect(on).toHaveBeenCalledTimes(1)
      expect(on).toHaveBeenCalledWith('initialize', expect.any(Function))

      expect(operations).toEqual([
        // should run before any plugin is registered
        'on',
        // should run before any events are sent downstream
        'register',
        // should run after all plugins have been registered
        'track',
      ])
      done()
    }, 0)
  })
})