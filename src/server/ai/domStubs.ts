// Minimal DOM stubs so the headless Editor (TextManager, tiptap) can measure
// text without a browser. Ported from scripts/spike-a.mjs and installed once,
// before the first Editor is constructed. These are measurement-only stubs;
// real layout ships with the browser client.
type StubEl = any

function makeTextEl(): StubEl {
  const el: StubEl = {
    _text: '',
    classList: {
      _set: new Set<string>(),
      add(...cls: string[]) {
        for (const c of cls) this._set.add(c)
      },
      remove(...cls: string[]) {
        for (const c of cls) this._set.delete(c)
      },
      contains(c: string) {
        return this._set.has(c)
      },
    },
    style: {
      _styles: new Map<string, string>(),
      setProperty(k: string, v: string) {
        this._styles.set(k, v)
      },
      removeProperty(k: string) {
        this._styles.delete(k)
      },
      getPropertyValue(k: string) {
        return this._styles.get(k) ?? ''
      },
      getPropertyNames() {
        return [...this._styles.keys()]
      },
    },
    childNodes: [],
    scrollWidth: 0,
    tabIndex: 0,
    setAttribute() {},
    removeAttribute() {},
    appendChild() {},
    removeChild() {},
    remove() {},
  }
  Object.defineProperty(el, 'textContent', {
    get() {
      return el._text
    },
    set(v: string) {
      el._text = v
    },
  })
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return el._text
    },
    set(v: string) {
      el._text = v
    },
  })
  el.getBoundingClientRect = () => {
    // ponytail: fake measurement — width scales with content so text/note
    // shapes get non-zero bounds. Real measurement ships with the browser.
    const w = Math.max(20, el._text.length * 9)
    const h = 22
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h }
  }
  return el
}

export function makeContainer(): StubEl {
  const classList = {
    _set: new Set<string>(),
    add(...cls: string[]) {
      for (const c of cls) this._set.add(c)
    },
    remove(...cls: string[]) {
      for (const c of cls) this._set.delete(c)
    },
    contains(c: string) {
      return this._set.has(c)
    },
  }
  const container: StubEl = {
    classList,
    ownerDocument: {
      createElement: () => makeTextEl(),
      defaultView: null,
      activeElement: null,
      body: {
        addEventListener() {},
        removeEventListener() {},
      },
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    remove() {},
    getBoundingClientRect: () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    }),
  }
  return container
}

let installed = false

export function installDomStubs(): void {
  if (installed) return
  installed = true
  // ponytail: the DOM globals are measurement-only stubs; cast away the real
  // DOM types so we don't have to implement every member of Window/Document.
  const g = globalThis as any

  g.requestAnimationFrame ??= (fn: (t: number) => void) => setTimeout(() => fn(Date.now()), 16)
  g.cancelAnimationFrame ??= (id: number) => clearTimeout(id)
  // @tldraw/utils' Timers references the bare `window` global (not globalThis).
  const _raf = g.requestAnimationFrame
  const _caf = g.cancelAnimationFrame
  g.window ??= {
    requestAnimationFrame: _raf,
    cancelAnimationFrame: _caf,
    devicePixelRatio: 1,
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
    get document() {
      return g.document
    },
  }
  // tiptap's generateHTML serializes DOM via the global `document`.
  g.document ??= {
    createElement: () => makeTextEl(),
    createElementNS: () => makeTextEl(),
    createDocumentFragment: () => makeTextEl(),
    createTextNode: (text: string) => ({ textContent: String(text), nodeType: 3 }),
    createRange: () => ({
      setStart() {},
      setEnd() {},
      getBoundingClientRect: () => ({ width: 0, height: 0 }),
    }),
    implementation: {
      createHTMLDocument: () => ({
        createElement: () => makeTextEl(),
        createElementNS: () => makeTextEl(),
      }),
    },
    documentElement: { ownerDocument: null },
    body: null,
    getElementById: () => null,
  }
}
