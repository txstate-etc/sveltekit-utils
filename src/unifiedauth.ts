import { type LoadEvent, redirect } from '@sveltejs/kit'
import type { APIBase } from './api.js'
import { isBlank } from 'txstate-utils'
import { goto } from '$app/navigation'

interface HandleOpts {
  /**
   * handleUnifiedAuth redirects users to unified auth by default if they don't have
   * a token yet. If your UI is at least partially available to the public, set
   * allowUnauthenticated to true.
   */
  allowUnauthenticated?: boolean
}

export const unifiedAuth = {
  /**
   * Your root +layout.ts' load function should call this method to ensure that it
   * handles authentication from Unified Auth. By default it will redirect unauthenticated
   * users to Unified Auth without a screen flash.
   *
   * If you set allowUnauthenticated: true and wait for the API to send a 401, there
   * will often be a screen flash.
   */
  async handle (api: APIBase, input: LoadEvent, opts?: HandleOpts) {
    const unifiedJwt = input.url.searchParams.get('unifiedJwt') ?? undefined
    await api.init(unifiedJwt)
    if (unifiedJwt) {
      let redirectUrl = input.url.searchParams.get('requestedUrl') ?? undefined
      if (!redirectUrl) {
        const currentUrl = new URL(input.url)
        currentUrl.searchParams.delete('unifiedJwt')
        redirectUrl = currentUrl.toString()
      }
      throw redirect(302, redirectUrl)
    }
    if (!opts?.allowUnauthenticated) this.requireAuth(api, input)
  },

  loginRedirect (api: APIBase, currentUrl: string) {
    const loginRedirect = new URL(api.authRedirect)
    loginRedirect.searchParams.set('requestedUrl', currentUrl)
    return loginRedirect
  },

  logout (api: APIBase) {
    if (isBlank(api.token)) return
    const authRedirect = new URL(api.authRedirect)
    authRedirect.pathname = '/logout'
    authRedirect.searchParams.set('unifiedJwt', api.token)
    api.token = undefined
    sessionStorage.removeItem('token')
    goto(authRedirect)
  },

  requireAuth (api: APIBase, input: LoadEvent) {
    if (!api.token) {
      throw redirect(302, this.loginRedirect(api, input.url.toString()))
    }
  }
}
