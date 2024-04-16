import { LoadEvent, redirect } from '@sveltejs/kit';
import { APIBase } from './api.js';

export * from './api.js'

interface HandleOpts {
  /**
   * handleUnifiedAuth redirects users to unified auth by default if they don't have
   * a token yet. If your UI is at least partially available to the public, set
   * allowUnauthenticated to true.
   */
  allowUnauthenticated?: boolean
}

/**
 * Your root +layout.ts' load function should call this method to ensure that it
 * handles authentication from Unified Auth. By default it will redirect unauthenticated
 * users to Unified Auth without a screen flash.
 *
 * If you set allowUnauthenticated: true and wait for the API to send a 401, there
 * will often be a screen flash.
 */
export async function handleUnifiedAuth (api: APIBase, input: LoadEvent, opts?: HandleOpts) {
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
  if (!opts?.allowUnauthenticated) requireAuthentication(api, input)
}

export function requireAuthentication (api: APIBase, input: LoadEvent) {
  if (!api.token) {
    const loginRedirect = new URL(api.authRedirect)
    loginRedirect.searchParams.set('requestedUrl', input.url.toString())
    throw redirect(302, loginRedirect)
  }
}
