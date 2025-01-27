import type { InteractionEvent, ValidatedResponse } from '@txstate-mws/fastify-shared'
import { toasts } from '@txstate-mws/svelte-components'
import { type NavigationTarget, error } from '@sveltejs/kit'
import { get } from 'svelte/store'
import { pick, rescue, toArray } from 'txstate-utils'
import { page } from '$app/stores'
import { afterNavigate } from '$app/navigation'
import { unifiedAuth } from './unifiedauth.js'

export type APIBaseQueryPayload = string | Record<string, undefined|string|number|(string|number)[]>
type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>
export interface APIUploadInfo {
  __type: 'APIUploadInfo'
  multipartIndex: number
  name: string
  mime: string
  size: number
}
export type APIBaseProgressFn = (info: { loaded: number, total: number, ratio: number } | undefined) => void

/**
 * Provided for convenience in case you are not using APIBase but still want to record navigations
 *
 * If you are using or extending APIBase, call `api.recordNavigations` instead.
 *
 * Must be called from a svelte component. Should usually be your root +layout.svelte.
 */
export function recordNavigations (callback: (evt: InteractionEvent) => void) {
  let timer = 0
  let from: NavigationTarget | null
  afterNavigate(navigation => {
      // save off the navigation.from in case we're debouncing a redirect
      if (timer === 0) from = navigation.from
      clearTimeout(timer) // we are debouncing because sometimes afterNavigate gets called twice
      timer = setTimeout(() => {
        callback({ eventType: 'sveltekit-utils-navigation', screen: (from ?? navigation.to)?.route.id!, target: navigation.to?.url.pathname, action: 'navigation', additionalProperties: { fullPageLoad: String(!from) } })
        timer = 0
      }, 10)
  })
}

/**
 * A non-mutating function that will replace all File objects in the variables with an APIUploadInfo
 * object, and put the original File object into the files array so it can be appended to the multipart
 * upload.
 *
 * When I say non-mutating, I mean it will not modify the original variables object. It will mutate the
 * files parameter, which should be passed an empty array.
 */
function replaceFiles (variables: Record<string, any>, files: File[]) {
  let newVariables: Record<string, any> | undefined
  for (const key in variables) {
    const val = variables[key]
    if (val instanceof File) {
      files.push(val)
      newVariables ??= { ...variables }
      newVariables[key] = { __type: 'APIUploadInfo', multipartIndex: files.length - 1, name: val.name, mime: val.type, size: val.size }
    } else if (val instanceof Object) {
      const newVal = replaceFiles(val, files)
      if (newVal !== val) {
        newVariables ??= { ...variables }
        newVariables[key] = newVal
      }
    }
  }
  return newVariables ?? variables
}

export class APIBase {
  public token?: string
  public fetch!: (info: RequestInfo, init?: RequestInit) => Promise<Response>
  protected ready!: () => void
  protected readyPromise: Promise<void>

  constructor (protected apiBase: string, public authRedirect: string | URL, public loginRedirect: (api: APIBase, currentUrl: string) => URL = unifiedAuth.loginRedirect) {
    this.readyPromise = new Promise(resolve => { this.ready = resolve })
  }

  async init (token: string | undefined, fetch?: (info: RequestInfo, init?: RequestInit) => Promise<Response>) {
    this.fetch = fetch ?? this.fetch
    if (token) {
      this.token = token
      sessionStorage.setItem('token', token)
    } else {
      this.token ??= sessionStorage.getItem('token') ?? undefined
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
          location.href = this.loginRedirect(this, location.href).toString()
          throw error(401)
        } else {
          const body = (isJsonResponse ? (await rescue(resp.json())) : await rescue(resp.text())) ?? resp.statusText
          let message = ''
          if (typeof body === 'string') message = body
          else if (body.message) message = body.message
          else if (body[0]?.message) message = body[0].message
          throw error(resp.status, message)
        }
      }
      return ((isJsonResponse) ? await resp.json() : await resp.text()) as ReturnType
    } catch (e: any) {
      toasts.add(e.body?.message ?? e.message)
      throw e
    }
  }

  async uploadWithProgress (path: string, formData: FormData, progress: APIBaseProgressFn): Promise<any> {
    await this.readyPromise
    try {
      return await new Promise((resolve, reject) => {
        try {
          progress({ loaded: 0, total: 0, ratio: 0 })
          const request = new XMLHttpRequest()
          request.open('POST', this.apiBase + path)

          if (this.token) request.setRequestHeader('Authorization', `Bearer ${this.token}`)
          request.setRequestHeader('Accept', 'application/json')

          request.upload.addEventListener('progress', e => progress({ ...pick(e, 'loaded', 'total'), ratio: e.lengthComputable ? e.loaded / e.total : 0.1 }))

          // request finished
          request.addEventListener('load', e => {
            if (request.status >= 400) reject(new Error(request.responseText))
            else {
              try {
                resolve(JSON.parse(request.responseText))
              } catch (e) {
                reject(e)
              }
            }
          })

          request.addEventListener('abort', e => reject(new Error('Upload aborted.')))
          request.addEventListener('error', e => reject(new Error('An error occurred during transfer. Upload not completed.')))
          request.send(formData)
        } catch (e) {
          reject(e)
        }
      })
    } finally {
      progress(undefined)
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

  /**
   * This is a special graphql request method that allows you to upload files. It will
   * find all the File objects in the variables and replace them with an APIUploadInfo object.
   *
   * Then it will send a multipart/form-data request instead of a standard JSON body, and all
   * the file data will be included in later parts.
   */
  async graphqlWithUploads <ReturnType = any> (
    query: string,
    variables: Record<string, any>,
    options?: {
      /**
       * Generally, set this to true if you are only validating a form. You don't want to
       * be uploading files on every keystroke.
       *
       * In this case, we will send a regular post instead of multipart, and all the File objects
       * in the variables will be replaced by an APIUploadInfo object as normal, including the
       * multipartIndex, even though there are no multipart parts coming.
       */
      omitUploads?: boolean,
      querySignature?: string,
      /**
       * This function will be called with a number between 0 and 1 as the uploads progress. The
       * completion percentage is for the entire submission, not individual files.
       */
      progress?: APIBaseProgressFn
    }
  ): Promise<ReturnType> {
    const files: File[] = []
    variables = replaceFiles(variables, files)

    // If we are only validating, we don't need to upload files
    if (options?.omitUploads || !files.length) return this.graphql(query, variables, options?.querySignature)

    const form = new FormData()
    form.set('body', JSON.stringify({
      query,
      variables,
      extensions: {
        querySignature: options?.querySignature
      }
    }))
    for (let i = 0; i < files.length; i++) form.set(`file${i}`, files[i])
    const gqlresponse = await this.uploadWithProgress('/graphql', form, options?.progress ?? (() => {}))
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
      if (events.length) this.post('/analytics', events).catch((e) => console.error(e))
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
