import { type LoadEvent, redirect } from '@sveltejs/kit'
import type { APIBase } from './api.js'
import { isBlank, Cache } from 'txstate-utils'
import { decodeJwt } from 'jose'

const mayImpersonateAnyCache = new Cache(async (api: APIBase) => {
  if (isBlank(api.token)) return false

  const authUrl = new URL(api.authRedirect)
  const mayImpersonateUrl = new URL('/mayImpersonate', authUrl.origin)

  try {
    const resp = await fetch(mayImpersonateUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${api.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    })

    if (!resp.ok) return false

    const { authorized } = await resp.json()
    return !!authorized
  } catch {
    return false
  }
})

const mayImpersonateNetidCache = new Cache(async (api: APIBase, netid: string) => {
  if (isBlank(api.token)) return false

  const authUrl = new URL(api.authRedirect)
  const mayImpersonateUrl = new URL('/mayImpersonate', authUrl.origin)

  try {
    const resp = await fetch(mayImpersonateUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${api.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ netid })
    })

    if (!resp.ok) return false

    const { authorized } = await resp.json()
    return !!authorized
  } catch {
    return false
  }
})

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
    // If impersonating, use the original token for logout
    const originalToken = sessionStorage.getItem('originalToken')
    const token = originalToken ?? api.token!
    const authRedirect = new URL(api.authRedirect)
    authRedirect.pathname = [...authRedirect.pathname.split('/').slice(0, -1), 'logout'].join('/')
    authRedirect.searchParams.set('unifiedJwt', token)
    api.token = undefined
    sessionStorage.removeItem('token')
    sessionStorage.removeItem('originalToken')
    window.location.href = authRedirect.toString()
  },

  requireAuth (api: APIBase, input: LoadEvent) {
    if (!api.token) {
      throw redirect(302, this.loginRedirect(api, input.url.toString()))
    }
  },

  /**
   * Start impersonating a user. This will store the current token and replace it with
   * an impersonation token obtained from Unified Auth.
   *
   * The impersonation token will expire in 1 hour.
   */
  async impersonate (api: APIBase, netid: string) {
    if (isBlank(api.token)) throw new Error('Must be authenticated to impersonate.')

    // Store original token before impersonating
    const originalToken = api.token!
    sessionStorage.setItem('originalToken', originalToken)

    // Get impersonation token from unified-auth
    const authUrl = new URL(api.authRedirect)
    const impersonateUrl = new URL('/impersonate', authUrl.origin)

    const resp = await fetch(impersonateUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${originalToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ netid })
    })

    if (!resp.ok) {
      const error = await resp.text()
      throw new Error(`Failed to impersonate: ${error}`)
    }

    const { token } = await resp.json()

    // Replace current token with impersonation token
    api.token = token
    sessionStorage.setItem('token', token)
  },

  /**
   * Exit impersonation and restore the original token.
   */
  exitImpersonation (api: APIBase) {
    const originalToken = sessionStorage.getItem('originalToken')
    if (!originalToken) {
      throw new Error('No original token found. Not currently impersonating.')
    }

    api.token = originalToken
    sessionStorage.setItem('token', originalToken)
    sessionStorage.removeItem('originalToken')
  },

  /**
   * Check if the current token is an impersonation token.
   * Returns { isImpersonating: false } if not impersonating.
   * Returns { isImpersonating: true, impersonatedUser: string, impersonatedBy: string } if impersonating.
   */
  getImpersonationStatus (api: APIBase): { isImpersonating: false } | { isImpersonating: true, impersonatedUser: string, impersonatedBy: string } {
    if (isBlank(api.token)) return { isImpersonating: false }

    try {
      const payload = decodeJwt(api.token)
      if (payload.act && (payload.act as any).sub) {
        return {
          isImpersonating: true,
          impersonatedUser: payload.sub as string,
          impersonatedBy: (payload.act as any).sub as string
        }
      }
    } catch (e) {
      // Invalid token, treat as not impersonating
    }

    return { isImpersonating: false }
  },

  /**
   * Check if the current user is authorized to impersonate anyone.
   * Results are cached to avoid repeated requests.
   *
   * @param api The API instance
   * @returns A promise that resolves to true if authorized to impersonate, false otherwise
   */
  async mayImpersonateAny (api: APIBase): Promise<boolean> {
    return await mayImpersonateAnyCache.get(api)
  },

  /**
   * Check if the current user is authorized to impersonate a specific user.
   * Results are cached to avoid repeated requests.
   *
   * @param api The API instance
   * @param netid The netid to check authorization for
   * @returns A promise that resolves to true if authorized, false otherwise
   */
  async mayImpersonate (api: APIBase, netid: string): Promise<boolean> {
    return await mayImpersonateNetidCache.get(api, netid)
  }
}
