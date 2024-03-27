import { toasts } from '@txstate-mws/svelte-components'
import { error } from '@sveltejs/kit'
import { get } from 'svelte/store'
import { rescue, toArray } from 'txstate-utils'
import { page } from '$app/stores'
import type { InteractionEvent, ValidatedResponse } from '@txstate-mws/fastify-shared'
import { afterNavigate } from '$app/navigation'

export type APIBaseQueryPayload = string | Record<string, undefined|string|number|(string|number)[]>
type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>

/**
 * Provided for convenience in case you are not using APIBase but still want to record navigations
 *
 * If you are using or extending APIBase, call `api.recordNavigations` instead.
 *
 * Must be called from a svelte component. Should usually be your root +layout.svelte.
 */
export function recordNavigations (callback: (evt: InteractionEvent) => void) {
  afterNavigate(navigation => {
    callback({ eventType: 'sveltekit-utils-navigation', screen: (navigation.from ?? navigation.to)?.route.id!, target: navigation.to?.url.toString(), action: 'navigation', additionalProperties: { fullPageLoad: String(!navigation.from) } })
  })
}

export class APIBase {
  protected token?: string
  public fetch!: (info: RequestInfo, init?: RequestInit) => Promise<Response>
  protected ready!: () => void
  protected readyPromise: Promise<void>

  constructor (protected apiBase: string, protected authRedirect: string) {
    this.readyPromise = new Promise(resolve => { this.ready = resolve })
  }

  async init (token: string | undefined, fetch?: (info: RequestInfo, init?: RequestInit) => Promise<Response>) {
    this.token = token
    this.fetch = fetch ?? this.fetch
    if (this.token) {
      sessionStorage.setItem('token', this.token)
    } else {
      this.token = sessionStorage.getItem('token') ?? undefined
    }
    this.ready()
  }

  stringifyQuery (query: undefined | APIBaseQueryPayload) {
    if (query == null) return ''
    if (typeof query === 'string') return query.startsWith('?') ? query : '?' + query
    const p = new URLSearchParams()
    for (const [key, val] of Object.entries(query)) {
      for (const v of toArray(val)) p.append(key, String(v))
    }
    return '?' + p.toString()
  }

  protected async request <ReturnType = any> (path: string, method: string, opts?: { body?: any, query?: APIBaseQueryPayload, inlineValidation?: boolean }) {
    await this.readyPromise
    try {
      const resp = await this.fetch(this.apiBase + path + this.stringifyQuery(opts?.query), {
        method,
        headers: {
          Authorization: `Bearer ${this.token ?? ''}`,
          Accept: 'application/json',
          ...(opts?.body ? { 'Content-Type': 'application/json' } : {})
        },
        body: opts?.body ? JSON.stringify(opts.body) : undefined
      })
      const contentType = resp.headers.get("content-type")
      const isJsonResponse = contentType && contentType.indexOf("application/json") !== -1
      if (!resp.ok && !(resp.status === 422 && opts?.inlineValidation)) {
        if (resp.status === 401) {
          const loginRedirect = new URL(this.authRedirect)
          loginRedirect.searchParams.set('requestedUrl', location.href)
          location.href = loginRedirect.toString()
          throw error(401)
        } else {
          const message = ((isJsonResponse ? (await rescue(resp.json()))?.message : await rescue(resp.text())) ?? resp.statusText) as string
          toasts.add(message)
          throw error(resp.status, message)
        }
      }
      return ((isJsonResponse) ? await resp.json() : await resp.text()) as ReturnType
    } catch (e: any) {
      toasts.add(e.message as string)
      throw e
    }
  }

  async get <ReturnType = any> (path: string, query?: APIBaseQueryPayload ) {
    return await this.request<ReturnType>(path, 'GET', { query })
  }

  /**
   * Remember to use validatedPost when the user is interacting with a form. That way they
   * will get inline errors.
   */
  async post <ReturnType = any> (path: string, body?: any, query?: APIBaseQueryPayload) {
    return await this.request<ReturnType>(path, 'POST', { body, query })
  }

  /**
   * Remember to use validatedPut when the user is interacting with a form. That way they
   * will get inline errors.
   */
  async put <ReturnType = any> (path: string, body?: any, query?: APIBaseQueryPayload) {
    return await this.request<ReturnType>(path, 'PUT', { body, query })
  }

  /**
   * Remember to use validatedPatch when the user is interacting with a form. That way they
   * will get inline errors.
   */
  async patch <ReturnType = any> (path: string, body?: any, query?: APIBaseQueryPayload) {
    return await this.request<ReturnType>(path, 'PATCH', { body, query })
  }

  /**
   * Use this method when the user is interacting with a form. You should expect a ValidatedResponse,
   * e.g. { success: false, messages: [{ type: 'error', message: 'That name is already taken.', path: 'name' }] }
   */
  async validatedPost <ReturnType extends ValidatedResponse = ValidatedResponse> (path: string, body?: any, query?: APIBaseQueryPayload) {
    return await this.request<ReturnType>(path, 'POST', { body, query, inlineValidation: true })
  }

  /**
   * Use this method when the user is interacting with a form. You should expect a ValidatedResponse,
   * e.g. { success: false, messages: [{ type: 'error', message: 'That name is already taken.', path: 'name' }] }
   */
  async validatedPut <ReturnType extends ValidatedResponse = ValidatedResponse> (path: string, body?: any, query?: APIBaseQueryPayload) {
    return await this.request<ReturnType>(path, 'PUT', { body, query, inlineValidation: true })
  }

  /**
   * Use this method when the user is interacting with a form. You should expect a ValidatedResponse,
   * e.g. { success: false, messages: [{ type: 'error', message: 'That name is already taken.', path: 'name' }] }
   */
  async validatedPatch <ReturnType extends ValidatedResponse = ValidatedResponse> (path: string, body?: any, query?: APIBaseQueryPayload) {
    return await this.request<ReturnType>(path, 'PATCH', { body, query, inlineValidation: true })
  }

  /**
   * Sending a JSON body with an HTTP DELETE is not recommended
   */
  async delete <ReturnType = any> (path: string, query?: APIBaseQueryPayload, body?: any) {
    return await this.request<ReturnType>(path, 'DELETE', { body, query })
  }

  async graphql <ReturnType = any> (query: string, variables?: any, querySignature?: string): Promise<ReturnType> {
    const gqlresponse = await this.request('/graphql', 'POST', { body: {
      query,
      variables,
      extensions: {
        querySignature
      }
    } })
    if (gqlresponse.errors?.length) {
      toasts.add(gqlresponse.errors[0].message)
      throw new Error(JSON.stringify(gqlresponse.errors))
    }
    return gqlresponse.data
  }

  protected analyticsQueue: InteractionEvent[] = []
  recordInteraction(evt: Optional<InteractionEvent, 'screen'>) {
    evt.screen ??= get(page).route.id!
    this.analyticsQueue.push(evt as InteractionEvent)
    setTimeout(() => {
      const events = [...this.analyticsQueue]
      this.analyticsQueue.length = 0
      this.post('/analytics', events).catch((e) => console.error(e))
    }, 2000)
  }

  /**
   * Due to the mechanics of sveltekit, this function cannot be fully automatic and must
   * be called in your global +layout.svelte
   */
  recordNavigations () {
    recordNavigations(this.recordInteraction.bind(this))
  }
}
