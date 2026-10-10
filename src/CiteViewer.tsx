"use client"
/** @jsxRuntime automatic */
/** @jsxImportSource react */

// citelens: PDF.js viewer that finds and highlights what the model quoted.
// Matching lives in ./fuzzy.ts; this file is rendering + interaction only.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist"
import {
  matchNormalized,
  normalizeForMatch,
  resolveCitations,
  type Citation,
  type MatchResult,
} from "./fuzzy"

export { findQuote, normalizeForMatch, extractCitationMarkers } from "./fuzzy"
export type { Citation, MatchResult, QuoteMatch } from "./fuzzy"

// ── PDF.js setup ────────────────────────────────────────────────

export interface PdfjsAssets {
  /** URL of legacy/build/pdf.worker.min.mjs. Default: jsDelivr for the installed pdfjs-dist version. */
  workerSrc?: string
  /** Directory URL of the bcmap files — required for many Korean/CJK PDFs. */
  cMapUrl?: string
  /** Directory URL of standard fonts. */
  standardFontDataUrl?: string
  /** Directory URL of WASM decoders (JPEG 2000 etc.). */
  wasmUrl?: string
}

let assets: PdfjsAssets = {}

/** Point PDF.js at self-hosted assets (recommended for production). Call once at startup. */
export function configurePdfjs(next: PdfjsAssets): void {
  assets = { ...assets, ...next }
}

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null
async function loadPdfjs() {
  // The legacy build polyfills newer JS features (e.g. Math.sumPrecise) for current browsers.
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs") as Promise<typeof import("pdfjs-dist")>
  const pdfjs = await pdfjsPromise
  const cdn = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}`
  if (!pdfjs.GlobalWorkerOptions.workerSrc || assets.workerSrc)
    pdfjs.GlobalWorkerOptions.workerSrc =
      assets.workerSrc ?? `${cdn}/legacy/build/pdf.worker.min.mjs`
  return {
    pdfjs,
    cMapUrl: assets.cMapUrl ?? `${cdn}/cmaps/`,
    standardFontDataUrl: assets.standardFontDataUrl ?? `${cdn}/standard_fonts/`,
    wasmUrl: assets.wasmUrl ?? `${cdn}/wasm/`,
  }
}

// ── Labels ──────────────────────────────────────────────────────

const STRINGS = {
  en: {
    loading: "Loading PDF…",
    error: "Couldn't open this PDF",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    fit: "Fit",
    page: (p: number, n: number) => `${p} / ${n}`,
    prev: "Previous citation",
    next: "Next citation",
    citation: (i: number, n: number) => `${i} of ${n}`,
    notFound: (n: number) => `${n} unmatched`,
  },
  ko: {
    loading: "PDF 불러오는 중…",
    error: "PDF를 열 수 없습니다",
    zoomIn: "확대",
    zoomOut: "축소",
    fit: "폭 맞춤",
    page: (p: number, n: number) => `${p} / ${n}`,
    prev: "이전 인용",
    next: "다음 인용",
    citation: (i: number, n: number) => `${i} / ${n}`,
    notFound: (n: number) => `미확인 ${n}건`,
  },
}

// ── <CiteLens> ──────────────────────────────────────────────────

export interface CiteLensProps {
  /** URL, or the file bytes. */
  file: string | ArrayBuffer | Uint8Array
  citations?: Citation[]
  /** Citation to scroll to and emphasise. */
  activeId?: string | null
  onCitationClick?: (id: string) => void
  /** Called once citations have been matched against the document text. */
  onMatch?: (results: MatchResult[]) => void
  /** Called when the user selects text in the document (e.g. "ask AI about this"). */
  onTextSelect?: (selection: { text: string; page: number }) => void
  /** Minimum fuzzy score (0–1). Default: 0.82 */
  threshold?: number
  /** Fixed scale (1 = 100%). Default: fit to width. */
  scale?: number
  locale?: "ko" | "en"
  theme?: "auto" | "light" | "dark"
  className?: string
  style?: CSSProperties
  /** Extra controls rendered at the right of the toolbar. */
  toolbarExtra?: ReactNode
}

interface PageInfo {
  width: number // PDF units at scale 1
  height: number
}

type HighlightRect = { id: string; x: number; y: number; w: number; h: number } // fractions of page size

export function CiteLens({
  file,
  citations = [],
  activeId,
  onCitationClick,
  onMatch,
  onTextSelect,
  threshold = 0.82,
  scale: fixedScale,
  locale = "en",
  theme = "auto",
  className,
  style,
  toolbarExtra,
}: CiteLensProps) {
  const t = STRINGS[locale]
  const scrollRef = useRef<HTMLDivElement>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [pages, setPages] = useState<PageInfo[]>([])
  const [textState, setTextState] = useState<{
    file: CiteLensProps["file"]
    texts: string[]
  } | null>(null)
  // Only trust page texts extracted from the current file (avoids stale matches while switching documents).
  const pageTexts = textState && textState.file === file ? textState.texts : null
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [error, setError] = useState("")
  const [fitScale, setFitScale] = useState(1)
  const [zoom, setZoom] = useState<number | null>(null) // null = fit width
  const [currentPage, setCurrentPage] = useState(1)
  const [rects, setRects] = useState<Record<number, HighlightRect[]>>({})
  const [flash, setFlash] = useState<string | null>(null)

  const scale = fixedScale ?? zoom ?? fitScale

  // load document
  useEffect(() => {
    let cancelled = false
    let loadingTask: { destroy(): Promise<void> } | null = null
    setStatus("loading")
    setDoc(null)
    setPages([])
    setRects({})
    ;(async () => {
      try {
        const { pdfjs, cMapUrl, standardFontDataUrl, wasmUrl } = await loadPdfjs()
        const data =
          typeof file === "string"
            ? undefined
            : new Uint8Array(file instanceof Uint8Array ? file.slice() : file.slice(0))
        const task = pdfjs.getDocument({
          url: typeof file === "string" ? file : undefined,
          data,
          cMapUrl,
          cMapPacked: true,
          standardFontDataUrl,
          wasmUrl,
        })
        loadingTask = task
        if (cancelled) return void task.destroy()
        const loaded = await task.promise
        if (cancelled) return
        const infos: PageInfo[] = []
        for (let i = 1; i <= loaded.numPages; i++) {
          const vp = (await loaded.getPage(i)).getViewport({ scale: 1 })
          infos.push({ width: vp.width, height: vp.height })
        }
        if (cancelled) return
        setPages(infos)
        setDoc(loaded)
        setStatus("ready")
        // Extract text of every page for citation matching.
        const texts: string[] = []
        for (let i = 1; i <= loaded.numPages; i++) {
          const tc = await (await loaded.getPage(i)).getTextContent()
          texts.push(
            normalizeForMatch(tc.items.map((it) => ("str" in it ? it.str : "")).join("")).text,
          )
          if (cancelled) return
        }
        setTextState({ file, texts })
      } catch (e) {
        if (cancelled) return
        setStatus("error")
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
      void loadingTask?.destroy()
    }
  }, [file])

  // fit width
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !pages.length) return
    const update = () => {
      const maxW = Math.max(...pages.map((p) => p.width))
      setFitScale(Math.max(0.25, Math.min(4, (el.clientWidth - 32) / maxW)))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [pages])

  // citations
  const resolved = useMemo(
    () => (pageTexts ? resolveCitations(pageTexts, citations, threshold) : []),
    [pageTexts, citations, threshold],
  )
  useEffect(() => {
    if (pageTexts) onMatch?.(resolved.map((r) => r.result))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved])

  const segmentsByPage = useMemo(() => {
    const map: Record<number, { id: string; start: number; end: number }[]> = {}
    for (const r of resolved)
      for (const s of r.segments)
        (map[s.page] ??= []).push({ id: r.citation.id, start: s.start, end: s.end })
    return map
  }, [resolved])

  const colorOf = useMemo(
    () => Object.fromEntries(citations.map((c) => [c.id, c.color])),
    [citations],
  )
  const labelOf = useMemo(
    () => Object.fromEntries(citations.map((c) => [c.id, c.label])),
    [citations],
  )
  const found = resolved.filter((r) => r.result.found)
  const missing = resolved.length - found.length

  const onRects = useCallback((page: number, list: HighlightRect[]) => {
    setRects((prev) => ({ ...prev, [page]: list }))
  }, [])

  // scroll to active citation
  const scrollToCitation = useCallback(
    (id: string) => {
      const r = resolved.find((x) => x.citation.id === id)
      const el = scrollRef.current
      if (!r?.segments.length || !el) return
      const page = r.segments[0].page
      const pageEl = el.querySelector<HTMLElement>(`[data-page="${page}"]`)
      if (!pageEl) return
      const rect = rects[page]?.find((x) => x.id === id)
      const info = pages[page - 1]
      const y = pageEl.offsetTop + (rect ? rect.y * info.height * scale : 0) - el.clientHeight / 3
      el.scrollTo({ top: Math.max(0, y), behavior: "smooth" })
      setFlash(id)
    },
    [resolved, rects, pages, scale],
  )

  const lastScrolled = useRef<string | null>(null)
  useEffect(() => {
    if (!activeId || !pageTexts) return
    const r = resolved.find((x) => x.citation.id === activeId)
    if (!r?.segments.length) return
    const page = r.segments[0].page
    const key = `${activeId}:${rects[page]?.some((x) => x.id === activeId) ? "r" : "p"}:${scale}`
    if (lastScrolled.current === key) return
    lastScrolled.current = key
    scrollToCitation(activeId)
  }, [activeId, resolved, rects, pageTexts, scrollToCitation, scale])

  useEffect(() => {
    if (!flash) return
    const id = setTimeout(() => setFlash(null), 1600)
    return () => clearTimeout(id)
  }, [flash])

  // current page indicator
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const mid = el.scrollTop + el.clientHeight / 2
    const pageEls = el.querySelectorAll<HTMLElement>("[data-page]")
    for (const p of pageEls) {
      if (p.offsetTop + p.offsetHeight >= mid) {
        setCurrentPage(Number(p.dataset.page))
        break
      }
    }
  }

  // selection → callback
  const onMouseUp = () => {
    if (!onTextSelect) return
    const sel = window.getSelection()
    const text = sel?.toString().trim()
    if (!sel || !text) return
    const pageEl = (
      sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement
    )?.closest<HTMLElement>("[data-page]")
    if (pageEl && scrollRef.current?.contains(pageEl))
      onTextSelect({ text: text.replace(/\s+/g, " "), page: Number(pageEl.dataset.page) })
  }

  // citation stepping
  const order = found.map((r) => r.citation.id)
  const activeIndex = activeId ? order.indexOf(activeId) : -1
  const step = (d: number) => {
    if (!order.length) return
    const next = order[(activeIndex + d + order.length) % order.length]
    if (onCitationClick) onCitationClick(next)
    else scrollToCitation(next)
  }

  const zoomBy = (f: number) =>
    setZoom(Math.max(0.25, Math.min(4, Math.round(scale * f * 100) / 100)))

  return (
    <div
      className={cn("cl", className)}
      style={style}
      data-theme={theme === "auto" ? undefined : theme}
    >
      <div className="cl-toolbar">
        <span className="cl-muted">{pages.length ? t.page(currentPage, pages.length) : ""}</span>
        <span className="cl-sep" />
        {!fixedScale && (
          <>
            <button
              type="button"
              className="cl-btn"
              title={t.zoomOut}
              aria-label={t.zoomOut}
              onClick={() => zoomBy(1 / 1.2)}
            >
              −
            </button>
            <span className="cl-zoom">{Math.round(scale * 100)}%</span>
            <button
              type="button"
              className="cl-btn"
              title={t.zoomIn}
              aria-label={t.zoomIn}
              onClick={() => zoomBy(1.2)}
            >
              +
            </button>
            <button
              type="button"
              className={cn("cl-btn", "is-text", zoom === null && "is-active")}
              onClick={() => setZoom(null)}
            >
              {t.fit}
            </button>
          </>
        )}
        {order.length > 0 && (
          <span className="cl-cite-nav">
            <button
              type="button"
              className="cl-btn"
              title={t.prev}
              aria-label={t.prev}
              onClick={() => step(-1)}
            >
              ‹
            </button>
            <span className="cl-muted">{t.citation(activeIndex + 1 || 1, order.length)}</span>
            <button
              type="button"
              className="cl-btn"
              title={t.next}
              aria-label={t.next}
              onClick={() => step(1)}
            >
              ›
            </button>
          </span>
        )}
        {missing > 0 && pageTexts && <span className="cl-warn">{t.notFound(missing)}</span>}
        {toolbarExtra && <span className="cl-toolbar-extra">{toolbarExtra}</span>}
      </div>

      <div className="cl-scroll" ref={scrollRef} onScroll={onScroll} onMouseUp={onMouseUp}>
        {status === "loading" && <div className="cl-state">{t.loading}</div>}
        {status === "error" && (
          <div className="cl-state is-error">
            {t.error}
            <small>{error}</small>
          </div>
        )}
        {doc &&
          pages.map((info, i) => (
            <PdfPage
              key={i}
              doc={doc}
              pageNumber={i + 1}
              info={info}
              scale={scale}
              root={scrollRef}
              segments={segmentsByPage[i + 1]}
              rects={rects[i + 1]}
              onRects={onRects}
              activeId={activeId ?? null}
              flashId={flash}
              colorOf={colorOf}
              labelOf={labelOf}
              onCitationClick={onCitationClick}
            />
          ))}
      </div>
    </div>
  )
}

// a single page

interface PdfPageProps {
  doc: PDFDocumentProxy
  pageNumber: number
  info: PageInfo
  scale: number
  root: React.RefObject<HTMLDivElement | null>
  segments?: { id: string; start: number; end: number }[]
  rects?: HighlightRect[]
  onRects: (page: number, rects: HighlightRect[]) => void
  activeId: string | null
  flashId: string | null
  colorOf: Record<string, string | undefined>
  labelOf: Record<string, string | undefined>
  onCitationClick?: (id: string) => void
}

function PdfPage({
  doc,
  pageNumber,
  info,
  scale,
  root,
  segments,
  rects,
  onRects,
  activeId,
  flashId,
  colorOf,
  labelOf,
  onCitationClick,
}: PdfPageProps) {
  const ref = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [renderedScale, setRenderedScale] = useState<number | null>(null)
  const [textReady, setTextReady] = useState(0)

  // Render only pages near the viewport.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), {
      root: root.current,
      rootMargin: "600px 0px",
    })
    io.observe(el)
    return () => io.disconnect()
  }, [root])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let renderTask: RenderTask | null = null
    let textLayer: { cancel(): void } | null = null
    ;(async () => {
      const { pdfjs } = await loadPdfjs()
      const page: PDFPageProxy = await doc.getPage(pageNumber)
      if (cancelled) return
      const viewport = page.getViewport({ scale })
      const canvas = canvasRef.current!
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.floor(viewport.width * ratio)
      canvas.height = Math.floor(viewport.height * ratio)
      renderTask = page.render({
        canvas,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      })
      const textContent = await page.getTextContent()
      if (cancelled) return
      const container = textRef.current!
      container.replaceChildren()
      const tl = new pdfjs.TextLayer({ textContentSource: textContent, container, viewport })
      textLayer = tl
      await Promise.all([renderTask.promise.catch(() => {}), tl.render()])
      if (cancelled) return
      setRenderedScale(scale)
      setTextReady((n) => n + 1)
    })().catch(() => {})
    return () => {
      cancelled = true
      renderTask?.cancel()
      textLayer?.cancel()
    }
  }, [visible, doc, pageNumber, scale])

  // Compute highlight rectangles from the rendered text layer.
  useEffect(() => {
    const container = textRef.current
    const pageEl = ref.current
    if (!container || !pageEl || !textReady) return
    if (!segments?.length) {
      if (rects?.length) onRects(pageNumber, [])
      return
    }
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    const nodes: { node: Text; start: number }[] = []
    let full = ""
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ node: n as Text, start: full.length })
      full += (n as Text).data
    }
    const norm = normalizeForMatch(full)
    const locate = (offset: number) => {
      let lo = 0,
        hi = nodes.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (nodes[mid].start <= offset) lo = mid
        else hi = mid - 1
      }
      return { node: nodes[lo].node, offset: offset - nodes[lo].start }
    }
    const box = pageEl.getBoundingClientRect()
    const out: HighlightRect[] = []
    for (const seg of segments) {
      if (seg.end > norm.text.length || !norm.map.length) continue
      const a = locate(norm.map[seg.start])
      const b = locate(norm.map[seg.end - 1] + 1)
      const range = document.createRange()
      try {
        range.setStart(a.node, a.offset)
        range.setEnd(b.node, Math.min(b.offset, b.node.length))
      } catch {
        continue
      }
      const merged: DOMRect[] = []
      for (const r of Array.from(range.getClientRects())) {
        if (r.width < 1 || r.height < 1) continue
        const last = merged[merged.length - 1]
        if (
          last &&
          Math.abs(last.top - r.top) < r.height * 0.5 &&
          r.left <= last.right + r.height
        ) {
          const left = Math.min(last.left, r.left)
          const top = Math.min(last.top, r.top)
          merged[merged.length - 1] = new DOMRect(
            left,
            top,
            Math.max(last.right, r.right) - left,
            Math.max(last.bottom, r.bottom) - top,
          )
        } else merged.push(r)
      }
      for (const r of merged)
        out.push({
          id: seg.id,
          x: (r.left - box.left) / box.width,
          y: (r.top - box.top) / box.height,
          w: r.width / box.width,
          h: r.height / box.height,
        })
    }
    onRects(pageNumber, out)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, textReady])

  const w = info.width * scale
  const h = info.height * scale

  // Highlights sit under the text layer (so text stays selectable); clicks are hit-tested here.
  const onClick = (e: React.MouseEvent) => {
    if (!onCitationClick || !rects?.length || window.getSelection()?.toString()) return
    const box = ref.current!.getBoundingClientRect()
    const x = (e.clientX - box.left) / box.width
    const y = (e.clientY - box.top) / box.height
    const hit = rects.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
    if (hit) onCitationClick(hit.id)
  }
  const onMove = (e: React.MouseEvent) => {
    if (!rects?.length) return
    const box = ref.current!.getBoundingClientRect()
    const x = (e.clientX - box.left) / box.width
    const y = (e.clientY - box.top) / box.height
    const hit = rects.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
    ref.current!.title = hit ? (labelOf[hit.id] ?? "") : ""
    ref.current!.style.cursor = hit && onCitationClick ? "pointer" : ""
  }

  return (
    <div
      ref={ref}
      className="cl-page"
      data-page={pageNumber}
      style={{
        width: w,
        height: h,
        ["--total-scale-factor" as string]: renderedScale ?? scale,
        ["--scale-round-x" as string]: "1px",
        ["--scale-round-y" as string]: "1px",
      }}
      onClick={onClick}
      onMouseMove={onMove}
    >
      <canvas ref={canvasRef} className="cl-canvas" style={{ width: w, height: h }} />
      <div className="cl-hl-layer" aria-hidden>
        {rects?.map((r, i) => (
          <div
            key={i}
            className={cn(
              "cl-hl",
              r.id === activeId && "is-active",
              r.id === flashId && "is-flash",
            )}
            data-citation={r.id}
            style={{
              left: `${r.x * 100}%`,
              top: `${r.y * 100}%`,
              width: `${r.w * 100}%`,
              height: `${r.h * 100}%`,
              ...(colorOf[r.id] ? { ["--cl-hl" as string]: colorOf[r.id] } : {}),
            }}
          />
        ))}
      </div>
      <div ref={textRef} className="textLayer cl-text" />
      {renderedScale === null && <div className="cl-page-loading" />}
    </div>
  )
}

// ── <TextLens> ──────────────────────────────────────────────────

export interface TextLensProps {
  /** Plain text. Blank lines separate paragraphs. */
  text: string
  citations?: Citation[]
  activeId?: string | null
  onCitationClick?: (id: string) => void
  onMatch?: (results: MatchResult[]) => void
  threshold?: number
  title?: string
  theme?: "auto" | "light" | "dark"
  className?: string
  style?: CSSProperties
}

/** Same idea for plain text: web pages, retrieved chunks, text pulled out of DOCX/HWP. */
export function TextLens({
  text,
  citations = [],
  activeId,
  onCitationClick,
  onMatch,
  threshold = 0.82,
  title,
  theme = "auto",
  className,
  style,
}: TextLensProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [flash, setFlash] = useState<string | null>(null)

  const matches = useMemo(() => {
    const norm = normalizeForMatch(text)
    return citations.map((c) => {
      const r = matchNormalized(norm.text, normalizeForMatch(c.quote).text, threshold)
      return r
        ? { citation: c, start: norm.map[r.start], end: norm.map[r.end - 1] + 1, score: r.score }
        : { citation: c, start: -1, end: -1, score: 0 }
    })
  }, [text, citations, threshold])

  useEffect(() => {
    onMatch?.(
      matches.map((m) => ({
        id: m.citation.id,
        found: m.start >= 0,
        score: Math.round(m.score * 1000) / 1000,
        pages: [],
      })),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches])

  useEffect(() => {
    if (!activeId) return
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-citation="${CSS.escape(activeId)}"]`,
    )
    if (!el || !scrollRef.current) return
    const box = scrollRef.current
    box.scrollTo({ top: el.offsetTop - box.clientHeight / 3, behavior: "smooth" })
    setFlash(activeId)
    const id = setTimeout(() => setFlash(null), 1600)
    return () => clearTimeout(id)
  }, [activeId, matches])

  // Split text at every highlight boundary; overlapping highlights favour the active one.
  const pieces = useMemo(() => {
    const valid = matches.filter((m) => m.start >= 0)
    const cuts = new Set<number>([0, text.length])
    for (const m of valid) (cuts.add(m.start), cuts.add(m.end))
    const sorted = [...cuts].sort((a, b) => a - b)
    const out: { text: string; id?: string }[] = []
    for (let i = 0; i + 1 < sorted.length; i++) {
      const [s, e] = [sorted[i], sorted[i + 1]]
      const covering = valid.filter((m) => m.start <= s && m.end >= e)
      const pick = covering.find((m) => m.citation.id === activeId) ?? covering[0]
      out.push({ text: text.slice(s, e), id: pick?.citation.id })
    }
    return out
  }, [matches, text, activeId])

  const colorOf = Object.fromEntries(citations.map((c) => [c.id, c.color]))
  const labelOf = Object.fromEntries(citations.map((c) => [c.id, c.label]))
  const seen = new Set<string>()

  return (
    <div
      className={cn("cl", "cl-textview", className)}
      style={style}
      data-theme={theme === "auto" ? undefined : theme}
    >
      {title && (
        <div className="cl-toolbar">
          <span className="cl-title">{title}</span>
        </div>
      )}
      <div className="cl-scroll" ref={scrollRef}>
        <div className="cl-textdoc">
          {pieces.map((p, i) => {
            if (!p.id) return <span key={i}>{p.text}</span>
            const first = !seen.has(p.id)
            seen.add(p.id)
            return (
              <mark
                key={i}
                className={cn(
                  "cl-mark",
                  p.id === activeId && "is-active",
                  p.id === flash && "is-flash",
                )}
                data-citation={first ? p.id : undefined}
                title={labelOf[p.id]}
                style={colorOf[p.id] ? { ["--cl-hl" as string]: colorOf[p.id] } : undefined}
                onClick={onCitationClick ? () => onCitationClick(p.id!) : undefined}
              >
                {p.text}
              </mark>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Utilities ───────────────────────────────────────────────────

const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ")
