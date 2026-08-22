export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    let message = `request failed (${res.status})`
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) message = body.error
    } catch {
      // keep the default message
    }
    // attach the HTTP status so callers can branch (e.g. 404 vs other failures)
    const err = new Error(message) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return (await res.json()) as T
}