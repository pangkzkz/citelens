# citelens
> Your RAG app says *"according to page 12…"*. citelens opens page 12 and highlights the sentence.

citelens is a React PDF viewer built on PDF.js. You hand it the quotes your model cited; it finds them in the PDF — **even when they don't match character-for-character** — and draws highlights on the exact glyphs.

---

- [Why not just `indexOf`?](#why-not-just-indexof)
- [Install](#install)
- [Usage](#usage)
- [Getting good quotes out of the model](#getting-good-quotes-out-of-the-model)
- [Self-hosting the PDF.js assets](#self-hosting-the-pdfjs-assets)
- [API](#api)
- [How matching works](#how-matching-works)
- [FAQ](#faq)
- [License](#license)

## Why not just `indexOf`?

Because the text inside a PDF and the text your model returns are never quite the same:

| In the PDF | What the model quotes |
|---|---|
| `The vehicle is de-`↵`signed to deliver` | `The vehicle is designed to deliver` |
| `developed with home grown tech` | `developed with homegrown tech` |
| `“Nuri” was selected` | `"Nuri" was selected` |
| `600–800 km` | `600-800km` |
| `for the first time` | `for the frist time` (typo) |

…and the quote may straddle a page break, or the model's page number may be off by one. citelens handles all of the above, and tells you which quotes it **couldn't** find, which is a pretty good hallucination detector.

## Install

Not on npm yet. Build it and add it by path:

```sh
git clone <repo-url> citelens && cd citelens
pnpm install && pnpm build          # npm works too
cd ../your-app && pnpm add ../citelens
```

Peer dependency: React ≥ 18.

## Usage

```tsx
"use client"

import { useState } from "react"
import { CiteLens, type Citation } from "citelens"
import "citelens/citelens.css"

const citations: Citation[] = [
  { id: "1", quote: "Revenue grew 40% year over year", page: 12, label: "[1]" },
  { id: "2", quote: "62% of document work at domestic companies is in HWP format", label: "[2]" },
]

export function Sources({ url }: { url: string }) {
  const [active, setActive] = useState<string | null>(null)

  return (
    <div style={{ height: "100dvh" }}>
      <CiteLens
        file={url}
        citations={citations}
        activeId={active}
        onCitationClick={setActive}
        onMatch={(results) => console.table(results)}
        onTextSelect={({ text, page }) => askFollowUp(text, page)}
      />
    </div>
  )
}
```

The viewer fills its parent, so give the parent a height.

### Chat + sources layout

```tsx
<div className="grid grid-cols-[1fr_1fr] h-dvh">
  <Answer
    markdown={answer}
    onMarkerClick={(id) => setActive(id)}      // e.g. render [1] as buttons
  />
  <CiteLens file={pdfUrl} citations={citations} activeId={active} onCitationClick={setActive} />
</div>
```

`extractCitationMarkers(answer)` gives you the ids of `[1]`, `[2, 3]`-style markers in order.

### Plain-text sources

Not every source is a PDF. `TextLens` does the same for a string — a web page, a chunk, text extracted from DOCX/HWP:

```tsx
import { TextLens } from "citelens"

<TextLens title="minutes.txt" text={text} citations={citations} activeId={active} />
```

### Server-side checking

The matcher has no React or PDF.js dependency, so you can verify quotes before you even send the answer to the client:

```ts
import { findQuote } from "citelens/fuzzy"

const hit = findQuote(chunkText, citation.quote) // { start, end, score } | null
if (!hit) flagAsUnsupported(citation)
```

## Getting good quotes out of the model

A prompt along these lines works well:

```text
Answer only from the excerpts below. After each claim put a marker like [1].
Finish with a JSON block:
{"citations": [{"id": "1", "page": 12, "quote": "<1–2 sentences copied verbatim>"}]}
Copy quotes exactly. Do not paraphrase inside "quote".
```

Things that help:

1. **Keep page numbers with your chunks** and show them to the model (`[p.12] …`). `page` is only a hint, but it makes matching faster and disambiguates repeated sentences.
2. **Short quotes match better.** One or two sentences beats a whole paragraph.
3. **Treat `found: false` as a signal.** Hide that citation or mark it as unverified.

## Self-hosting the PDF.js assets

Out of the box, the worker, CMaps (needed for most CJK PDFs), standard fonts and WASM decoders are fetched from jsDelivr at the version of `pdfjs-dist` you installed. For production, serve them yourself:

```sh
mkdir -p public/pdfjs
cp node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs public/pdfjs/
cp -r node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm} public/pdfjs/
```

```ts
import { configurePdfjs } from "citelens"

configurePdfjs({
  workerSrc: "/pdfjs/pdf.worker.min.mjs",
  cMapUrl: "/pdfjs/cmaps/",
  standardFontDataUrl: "/pdfjs/standard_fonts/",
  wasmUrl: "/pdfjs/wasm/",
})
```

citelens loads the **legacy** build of PDF.js (the modern build calls `Math.sumPrecise`, which many browsers still lack), so point `workerSrc` at the legacy worker too. With Vite: `import workerSrc from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"`.

## API

```ts
interface Citation {
  id: string
  quote: string        // what the model quoted — exact wording not required
  page?: number        // 1-based hint
  label?: string       // tooltip, e.g. "[1]"
  color?: string       // any CSS color
}

interface MatchResult {
  id: string
  found: boolean
  score: number        // 0–1, 1 = exact after normalisation
  pages: number[]      // pages the match covers (PDF only)
}

interface CiteLensProps {
  file: string | ArrayBuffer | Uint8Array
  citations?: Citation[]
  activeId?: string | null                        // scroll to + pulse
  onCitationClick?: (id: string) => void          // highlight or ‹ › clicked
  onMatch?: (results: MatchResult[]) => void      // after text extraction + matching
  onTextSelect?: (s: { text: string; page: number }) => void
  threshold?: number                              // default 0.82
  scale?: number                                  // fixed zoom; default fits width
  locale?: "en" | "ko"                            // default "en"
  theme?: "auto" | "light" | "dark"
  toolbarExtra?: React.ReactNode
  className?: string
  style?: React.CSSProperties
}

// TextLens: text, citations, activeId, onCitationClick, onMatch, threshold, title, theme, className, style

function findQuote(text: string, quote: string, threshold?: number): { start: number; end: number; score: number } | null
function normalizeForMatch(text: string): { text: string; map: number[] }
function extractCitationMarkers(answer: string): string[]
function configurePdfjs(assets: { workerSrc?: string; cMapUrl?: string; standardFontDataUrl?: string; wasmUrl?: string }): void
```

Styling is plain CSS with custom properties on `.cl`: `--cl-hl`, `--cl-hl-active`, `--cl-hl-ring`, `--cl-accent`, `--cl-font`, and so on. See `src/citelens.css`.

## How matching works

1. **Normalise** both strings: NFKC, lowercase, unify curly quotes and dashes, then drop whitespace, punctuation and invisible characters. Keep an index map back to the original.
2. **Exact search** on the normalised text.
3. Otherwise run **Sellers' approximate substring search** (edit distance, any start position) over a few windows: the hinted page ±1, then the pages with the most trigram overlap — each joined with its neighbour, so cross-page quotes work. Quotes longer than ~400 characters are anchored by their head and tail instead.
4. **Map back** to the text nodes of the rendered PDF.js text layer and take `Range.getClientRects()` for the highlight boxes. Boxes are stored as page fractions, so they survive zoom.

A 15k-character document with a 200-character fuzzy quote matches in about 30 ms.

## FAQ

**Nothing gets highlighted.**
Check `onMatch`. If everything is `found: false`, the PDF is probably scanned (no text layer). Run OCR first, e.g. `ocrmypdf in.pdf out.pdf`.

**Text in the PDF looks garbled/overlapping.**
That's a font problem in the PDF itself, usually a subset CFF font. Other PDF.js-based viewers (Firefox) will show the same thing.

**Can it match paraphrases?**
No, on purpose. If the model paraphrased, it shouldn't be presented as a quote.

**Huge PDFs?**
Pages render lazily, but text is extracted from every page up front for matching. A few hundred pages takes a few seconds before highlights appear.
