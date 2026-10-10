/**
 * Quote matching for citelens.
 *
 * LLM quotes rarely match PDF text byte-for-byte: spacing breaks, line-end hyphens,
 * curly vs straight quotes, Korean word spacing, small typos. We normalise both sides,
 * try an exact hit, then fall back to Sellers' approximate substring search.
 */

// ── Public types ────────────────────────────────────────────────

export interface Citation {
  id: string
  /** Text the answer relies on. Exact wording is not required. */
  quote: string
  /** 1-based page hint for PDFs. Searched first, then the rest of the document. */
  page?: number
  /** Shown on hover, e.g. "[1]". */
  label?: string
  /** Any CSS color. Default: theme highlight color. */
  color?: string
}

export interface MatchResult {
  id: string
  found: boolean
  /** 0–1. 1 = exact (after normalisation). */
  score: number
  /** 1-based pages covered by the match (PDF only). */
  pages: number[]
}

// ── Matching core ───────────────────────────────────────────────

interface Normalized {
  text: string
  /** map[i] = index in the original string of normalized char i */
  map: number[]
}

const PUNCT_MAP: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "′": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "‟": '"',
  "″": '"',
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "–": "-",
  "—": "-",
  "―": "-",
  "−": "-",
}
const SKIP = /[\s\p{P}\p{Cf}]/u

/**
 * Normalise for matching: NFKC, lower case, and drop whitespace, punctuation and
 * invisible characters. Keeps a map back to original offsets.
 */
export function normalizeForMatch(s: string): Normalized {
  let text = ""
  const map: number[] = []
  for (let i = 0; i < s.length; i++) {
    let c = s[i]
    const code = c.charCodeAt(0)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) c += s[i + 1]
    const n = (PUNCT_MAP[c] ?? c).normalize("NFKC").toLowerCase()
    for (const ch of n) {
      if (SKIP.test(ch)) continue
      text += ch
      map.push(i)
    }
    if (c.length === 2) i++
  }
  return { text, map }
}

/** Approximate substring search (Sellers). Returns the best match end and distance. */
function sellers(text: string, pattern: string): { end: number; dist: number } {
  const m = pattern.length
  let prev = new Int32Array(m + 1)
  let cur = new Int32Array(m + 1)
  for (let j = 0; j <= m; j++) prev[j] = j
  let best = { end: -1, dist: Number.POSITIVE_INFINITY }
  for (let i = 0; i < text.length; i++) {
    cur[0] = 0
    const t = text.charCodeAt(i)
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + (t === pattern.charCodeAt(j - 1) ? 0 : 1)
      const del = prev[j] + 1
      const ins = cur[j - 1] + 1
      cur[j] = sub < del ? (sub < ins ? sub : ins) : del < ins ? del : ins
    }
    if (cur[m] < best.dist) best = { end: i + 1, dist: cur[m] }
    ;[prev, cur] = [cur, prev]
  }
  return best
}

const reverse = (s: string) => Array.from(s).reverse().join("")

function fuzzyRange(
  text: string,
  pattern: string,
  threshold: number,
): { start: number; end: number; score: number } | null {
  if (!pattern || !text) return null
  const { end, dist } = sellers(text, pattern)
  const score = 1 - dist / pattern.length
  if (end < 0 || score < threshold) return null
  const winStart = Math.max(0, end - pattern.length - dist)
  const back = sellers(reverse(text.slice(winStart, end)), reverse(pattern))
  return { start: end - back.end, end, score }
}

const ANCHOR = 160

/** Find a (normalized) quote inside a (normalized) haystack. */
export function matchNormalized(
  hay: string,
  needle: string,
  threshold: number,
): { start: number; end: number; score: number } | null {
  if (!needle) return null
  const exact = hay.indexOf(needle)
  if (exact >= 0) return { start: exact, end: exact + needle.length, score: 1 }
  if (needle.length < 6) return null // too short to match fuzzily without false positives
  if (needle.length <= ANCHOR * 2.5) return fuzzyRange(hay, needle, threshold)
  // Long quote: match head and tail separately and accept a plausible span.
  const head = fuzzyRange(hay, needle.slice(0, ANCHOR), threshold)
  if (!head) return null
  const tailHay = hay.slice(head.end)
  const tail = fuzzyRange(tailHay, needle.slice(-ANCHOR), threshold)
  if (!tail) return null
  const end = head.end + tail.end
  const span = end - head.start
  if (span > needle.length * 1.6 || span < needle.length * 0.6) return null
  return { start: head.start, end, score: Math.min(head.score, tail.score) }
}

export interface QuoteMatch {
  /** Offsets in the original haystack string. */
  start: number
  end: number
  score: number
}

/**
 * Locate a quote in text, tolerating whitespace, punctuation, hyphenation and
 * minor wording differences. Returns null when nothing scores ≥ `threshold`.
 */
export function findQuote(haystack: string, quote: string, threshold = 0.82): QuoteMatch | null {
  const h = normalizeForMatch(haystack)
  const q = normalizeForMatch(quote).text
  const r = matchNormalized(h.text, q, threshold)
  if (!r) return null
  return { start: h.map[r.start], end: h.map[r.end - 1] + 1, score: r.score }
}

function trigrams(s: string): Set<string> {
  const set = new Set<string>()
  for (let i = 0; i + 3 <= s.length; i++) set.add(s.slice(i, i + 3))
  return set
}

interface Segment {
  page: number // 1-based
  /** normalized offsets within the page */
  start: number
  end: number
}

export interface Resolved {
  citation: Citation
  result: MatchResult
  segments: Segment[]
}

/** Resolve citations against per-page normalized texts (supports matches across a page break). */
export function resolveCitations(
  pageTexts: string[],
  citations: Citation[],
  threshold: number,
): Resolved[] {
  const offsets: number[] = []
  let acc = 0
  for (const t of pageTexts) (offsets.push(acc), (acc += t.length))
  const whole = pageTexts.join("")
  const pageOf = (pos: number) => {
    let lo = 0,
      hi = offsets.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (offsets[mid] <= pos) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const pageTri = pageTexts.map(trigrams)

  return citations.map((citation) => {
    const q = normalizeForMatch(citation.quote).text
    const fail: Resolved = {
      citation,
      result: { id: citation.id, found: false, score: 0, pages: [] },
      segments: [],
    }
    if (!q) return fail

    // Windows to try, in order: hinted page ±1, then pages ranked by trigram overlap.
    const windows: [number, number][] = []
    if (citation.page && citation.page >= 1 && citation.page <= pageTexts.length) {
      const p = citation.page - 1
      windows.push([p, p], [Math.max(0, p - 1), Math.min(pageTexts.length - 1, p + 1)])
    }
    let hit: { start: number; end: number; score: number } | null = null
    const exact = whole.indexOf(q)
    if (exact >= 0 && !windows.length) hit = { start: exact, end: exact + q.length, score: 1 }

    if (!hit) {
      const qt = trigrams(q)
      const ranked = pageTri
        .map((tri, i) => {
          let n = 0
          qt.forEach((g) => tri.has(g) && n++)
          return { i, n }
        })
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n)
        .slice(0, 4)
      for (const { i } of ranked)
        windows.push([i, Math.min(pageTexts.length - 1, i + 1)], [Math.max(0, i - 1), i])
      for (const [a, b] of windows) {
        const base = offsets[a]
        const end = b + 1 < offsets.length ? offsets[b + 1] : whole.length
        const r = matchNormalized(whole.slice(base, end), q, threshold)
        if (r && (!hit || r.score > hit.score))
          hit = { start: base + r.start, end: base + r.end, score: r.score }
        if (hit?.score === 1) break
      }
      if (!hit && exact >= 0) hit = { start: exact, end: exact + q.length, score: 1 }
    }
    if (!hit) return fail

    const segments: Segment[] = []
    for (let p = pageOf(hit.start); p <= pageOf(hit.end - 1); p++) {
      const ps = offsets[p]
      const pe = ps + pageTexts[p].length
      const s = Math.max(hit.start, ps) - ps
      const e = Math.min(hit.end, pe) - ps
      if (e > s) segments.push({ page: p + 1, start: s, end: e })
    }
    return {
      citation,
      result: {
        id: citation.id,
        found: true,
        score: Math.round(hit.score * 1000) / 1000,
        pages: segments.map((s) => s.page),
      },
      segments,
    }
  })
}

/**
 * Turn "[1]"-style markers in an AI answer into a list of ids, e.g. for
 * rendering clickable references next to <CiteLens>.
 */
export function extractCitationMarkers(answer: string): string[] {
  const ids: string[] = []
  for (const m of answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g))
    for (const id of m[1].split(/\s*,\s*/)) if (!ids.includes(id)) ids.push(id)
  return ids
}
