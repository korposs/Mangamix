import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

import JSZip from 'jszip'

import * as pdfjs from 'pdfjs-dist'

import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'



pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker



type Chapter = { id: string; name: string; fileName: string; type: 'pdf' | 'archive' | 'images'; blob: Blob; pageCount: number; progress: number; addedAt: number }

type LibraryItem = { id: string; title: string; chapters: Chapter[]; addedAt: number }

type ReadingMode = 'scroll' | 'page'

type Direction = 'ltr' | 'rtl'



const DB_NAME = 'manga-shelf-v1'

const STORE = 'library'

const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i

const sortNatural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

const uid = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }

  return 'xxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const random = Math.random() * 16 | 0
    const value = char === 'x' ? random : (random & 0x3 | 0x8)
    return value.toString(16)
  })
}



function openDb(): Promise<IDBDatabase> {

  return new Promise((resolve, reject) => {

    const request = indexedDB.open(DB_NAME, 1)

    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' })

    request.onsuccess = () => resolve(request.result)

    request.onerror = () => reject(request.error)

  })

}

async function getLibrary(): Promise<LibraryItem[]> {

  const db = await openDb()

  return new Promise((resolve, reject) => {

    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()

    request.onsuccess = () => resolve((request.result as LibraryItem[]).sort((a,b) => b.addedAt-a.addedAt))

    request.onerror = () => reject(request.error)

  })

}

async function saveItem(item: LibraryItem): Promise<void> {

  const db = await openDb()

  return new Promise((resolve, reject) => {

    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(item)

    request.onsuccess = () => resolve()

    request.onerror = () => reject(request.error)

  })

}

async function removeItem(id: string): Promise<void> {

  const db = await openDb()

  return new Promise((resolve, reject) => {

    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id)

    request.onsuccess = () => resolve()

    request.onerror = () => reject(request.error)

  })

}

function isPdf(file: File) { return /\.pdf$/i.test(file.name) }

function isArchive(file: File) { return /\.(cbz|zip)$/i.test(file.name) }

function cleanTitle(name: string) { return name.replace(/\.(pdf|cbz|zip)$/i, '').replace(/[_]+/g, ' ').trim() || 'Без названия' }



async function inspectFile(file: File): Promise<Chapter> {

  if (isPdf(file)) {

    const data = new Uint8Array(await file.arrayBuffer())

    const doc = await pdfjs.getDocument({ data }).promise

    const pageCount = doc.numPages

    await doc.destroy()

    return { id: uid(), name: cleanTitle(file.name), fileName: file.name, type: 'pdf', blob: file, pageCount, progress: 0, addedAt: Date.now() }

  }

  if (isArchive(file)) {

    const zip = await JSZip.loadAsync(file)

    const pages = Object.keys(zip.files).filter(path => !zip.files[path].dir && IMAGE_RE.test(path)).sort(sortNatural)

    if (!pages.length) throw new Error(`${file.name}: в архиве не найдены изображения`)

    return { id: uid(), name: cleanTitle(file.name), fileName: file.name, type: 'archive', blob: file, pageCount: pages.length, progress: 0, addedAt: Date.now() }

  }

  throw new Error(`${file.name}: формат пока не поддерживается. Выберите PDF, CBZ или ZIP.`)

}





// Один PDF-документ загружается только один раз

const pdfDocumentCache = new WeakMap<Blob, Promise<PDFDocumentProxy>>()

const archiveCache = new WeakMap<Blob, Promise<JSZip>>()

function getArchive(blob: Blob): Promise<JSZip> {
  let loading = archiveCache.get(blob)

  if (!loading) {
    loading = JSZip.loadAsync(blob)
    archiveCache.set(blob, loading)

    void loading.catch(() => {
      archiveCache.delete(blob)
    })
  }

  return loading
}



function getPdfDocument(blob: Blob): Promise<PDFDocumentProxy> {

  let loading = pdfDocumentCache.get(blob)



  if (!loading) {

    loading = blob.arrayBuffer().then(buffer => {

      return pdfjs.getDocument({

        data: new Uint8Array(buffer),

      }).promise

    })



    pdfDocumentCache.set(blob, loading)



    // Если загрузка завершилась ошибкой, разрешаем повторную попытку

    void loading.catch(() => {

      pdfDocumentCache.delete(blob)

    })

  }



  return loading

}





function PdfPage({

  blob,

  pageNumber,

  onVisible,

}: {

  blob: Blob

  pageNumber: number

  onVisible?: (n: number) => void

}) {

  const canvasRef = useRef<HTMLCanvasElement>(null)

  const hostRef = useRef<HTMLDivElement>(null)



  const [visible, setVisible] = useState(pageNumber === 1)

  const [error, setError] = useState('')



  // Загружаем страницу только когда она приближается к экрану

  useEffect(() => {

    const node = hostRef.current



    if (!node || visible) return



    const observer = new IntersectionObserver(

      entries => {

        if (entries.some(entry => entry.isIntersecting)) {

          setVisible(true)

          observer.disconnect()

        }

      },

      { rootMargin: '900px' }

    )



    observer.observe(node)



    return () => observer.disconnect()

  }, [visible])



  // Рендерим PDF-страницу

  useEffect(() => {

    if (!visible || !canvasRef.current) return



    let cancelled = false

    let cancelRender: (() => void) | undefined



    setError('')



    const renderPage = async () => {

      try {

        // Берём документ из общего кеша

        const doc = await getPdfDocument(blob)



        if (cancelled) return



        const pdfPage = await doc.getPage(pageNumber)



        if (cancelled) return



        const canvas = canvasRef.current

        if (!canvas) return



        const context = canvas.getContext('2d', {

          alpha: false,

        })



        if (!context) return





        const baseViewport = pdfPage.getViewport({

          scale: 1,

        })



        const containerWidth =

          hostRef.current?.clientWidth || window.innerWidth - 24



        // Максимальная ширина страницы

        const maxWidth = Math.min(containerWidth, 1400)



        // Размер страницы на экране

        const cssScale = maxWidth / baseViewport.width



        // Повышенное разрешение для чёткого рендеринга

        const pixelRatio = Math.min(

          (window.devicePixelRatio || 1) * 1.5,

          3

        )



        const viewport = pdfPage.getViewport({

          scale: cssScale * pixelRatio,

        })





        // Физический размер canvas

        canvas.width = Math.ceil(viewport.width)

        canvas.height = Math.ceil(viewport.height)



        // Видимый размер canvas

        canvas.style.width = `${viewport.width / pixelRatio}px`

        canvas.style.height = `${viewport.height / pixelRatio}px`



        const renderTask = pdfPage.render({

          canvasContext: context,

          viewport,

        })



        cancelRender = () => renderTask.cancel()



        await renderTask.promise



        if (!cancelled) {

          onVisible?.(pageNumber)

        }

      } catch (e) {

        if (

          !cancelled &&

          !(e instanceof Error && e.name === 'RenderingCancelledException')

        ) {

          setError(

            e instanceof Error ? e.message : 'Ошибка PDF'

          )

        }

      }

    }



    void renderPage()



    return () => {

      cancelled = true

      cancelRender?.()

    }

  }, [blob, pageNumber, visible, onVisible])



  return (

    <div className="pdf-page" ref={hostRef}>

      <canvas ref={canvasRef} />

      {error && (

        <span className="page-error">{error}</span>

      )}

    </div>

  )

}

const archiveImageUrlCache = new WeakMap<Blob, Map<string, string>>()

async function getArchiveImageUrl(blob: Blob, pagePath: string) {
  let pages = archiveImageUrlCache.get(blob)

  if (!pages) {
    pages = new Map()
    archiveImageUrlCache.set(blob, pages)
  }

  const cachedUrl = pages.get(pagePath)
  if (cachedUrl) return cachedUrl

  const zip = await getArchive(blob)
  const entry = zip.file(pagePath)

  if (!entry) {
    throw new Error('Страница не найдена в архиве')
  }

  const content = await entry.async('blob')
  const url = URL.createObjectURL(content)

  pages.set(pagePath, url)

  return url
}

function ArchivePage({
  blob,
  pagePath,
  pageNumber,
}: {
  blob: Blob
  pagePath: string
  pageNumber: number
}) {
  const [src, setSrc] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false

    setSrc('')
    setError('')

    if (!pagePath) return

    ;(async () => {
      try {
        const url = await getArchiveImageUrl(blob, pagePath)

        if (!cancelled) {
          setSrc(url)
        }
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : 'Ошибка архива'
          )
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [blob, pagePath])

  return (
    <div className="archive-page">
      {src ? (
        <img
          src={src}
          alt={`Страница ${pageNumber}`}
          loading="lazy"
        />
      ) : error ? (
        <span className="page-error">{error}</span>
      ) : (
        <div className="page-loading">
          Загрузка страницы {pageNumber}…
        </div>
      )}
    </div>
  )
}


export default function App() {
  const [library, setLibrary] = useState<LibraryItem[]>([])
  const [activeSeries, setActiveSeries] = useState<LibraryItem | null>(null)
  const [activeChapter, setActiveChapter] = useState<Chapter | null>(null)
  const [mode, setMode] = useState<ReadingMode>('scroll')
  const [direction, setDirection] = useState<Direction>('ltr')
  const [page, setPage] = useState(0)
  const [archivePages, setArchivePages] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('Файлы обрабатываются на устройстве и не отправляются на сервер.')

  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [importMode, setImportMode] = useState<'new' | 'existing'>('new')
  const [newSeriesTitle, setNewSeriesTitle] = useState('')
  const [selectedSeriesId, setSelectedSeriesId] = useState('')

  const fileInput = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const touchStart = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    setLibrary(await getLibrary())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' })
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [mode, activeChapter?.id])

  const openImportDialog = () => {
    setImportMode('new')
    setNewSeriesTitle('')
    setSelectedSeriesId(library[0]?.id ?? '')
    setImportDialogOpen(true)
  }

  const importFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const files = Array.from(input.files || [])
    if (!files.length) return

    if (importMode === 'new' && !newSeriesTitle.trim()) {
      setNotice('Введи название новой манги перед выбором файлов.')
      input.value = ''
      return
    }

    const targetSeries = importMode === 'existing'
      ? library.find(item => item.id === selectedSeriesId)
      : undefined

    if (importMode === 'existing' && !targetSeries) {
      setNotice('Сначала выбери мангу, в которую нужно добавить главы.')
      input.value = ''
      return
    }

    setBusy(true)
    setNotice(`Импортирую ${files.length} файл(ов)…`)

    try {
      const importedChapters: Chapter[] = []
      for (const file of files) {
        importedChapters.push(await inspectFile(file))
      }

      if (importMode === 'new') {
        const title = newSeriesTitle.trim()
        const item: LibraryItem = {
          id: uid(),
          title,
          chapters: importedChapters.sort((a, b) => sortNatural(a.fileName, b.fileName)),
          addedAt: Date.now(),
        }
        await saveItem(item)
        setNotice(`Создана манга «${title}». Добавлено глав: ${importedChapters.length}.`)
      } else if (targetSeries) {
        const updatedSeries: LibraryItem = {
          ...targetSeries,
          chapters: [...targetSeries.chapters, ...importedChapters]
            .sort((a, b) => sortNatural(a.fileName, b.fileName)),
        }
        await saveItem(updatedSeries)

        if (activeSeries?.id === updatedSeries.id) {
          setActiveSeries(updatedSeries)
        }

        setNotice(`В «${updatedSeries.title}» добавлено глав: ${importedChapters.length}.`)
      }

      await refresh()
      setImportDialogOpen(false)
      setNewSeriesTitle('')
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Не удалось импортировать файлы.')
    } finally {
      setBusy(false)
      input.value = ''
    }
  }

  const filtered = useMemo(
    () => library.filter(item => item.title.toLowerCase().includes(query.toLowerCase())),
    [library, query]
  )

  const chapterLoadId = useRef(0)

const openChapter = async (series: LibraryItem, chapter: Chapter) => {
  const loadId = ++chapterLoadId.current

  setActiveSeries(series)
  setActiveChapter(chapter)
  setPage(chapter.progress)
  setArchivePages([])

  if (chapter.type === 'archive') {
    try {
      const zip = await getArchive(chapter.blob)

      const pages = Object.keys(zip.files)
        .filter(path => !zip.files[path].dir && IMAGE_RE.test(path))
        .sort(sortNatural)

      if (loadId !== chapterLoadId.current) return

      if (!pages.length) {
        throw new Error('В архиве не найдены изображения')
      }

      setArchivePages(pages)
    } catch (error) {
      if (loadId !== chapterLoadId.current) return

      setNotice(
        error instanceof Error
          ? error.message
          : 'Не удалось открыть архив'
      )
    }
  }
}

  const updateProgress = async (next: number) => {
    if (!activeSeries || !activeChapter) return

    const updatedChapter = { ...activeChapter, progress: next }
    const updatedSeries = {
      ...activeSeries,
      chapters: activeSeries.chapters.map(chapter =>
        chapter.id === updatedChapter.id ? updatedChapter : chapter
      ),
    }

    setActiveChapter(updatedChapter)
    setActiveSeries(updatedSeries)
    await saveItem(updatedSeries)
    await refresh()
  }

  const leaveReader = () => {
    setActiveChapter(null)
    setActiveSeries(null)
    setArchivePages([])
  }

  const switchPage = (delta: number) => {
    if (!activeChapter) return
    const next = Math.max(0, Math.min(activeChapter.pageCount - 1, page + delta))
    setPage(next)
    void updateProgress(next)
  }

  const switchChapter = (delta: number) => {
    if (!activeSeries || !activeChapter) return

    const index = activeSeries.chapters.findIndex(chapter => chapter.id === activeChapter.id)
    const next = activeSeries.chapters[index + delta]

    if (next) {
      void openChapter(activeSeries, next)
    } else {
      setNotice(delta > 0 ? 'Это последняя глава.' : 'Это первая глава.')
    }
  }

  const selectChapter = (chapterId: string) => {
    if (!activeSeries) return
    const selected = activeSeries.chapters.find(chapter => chapter.id === chapterId)
    if (selected) void openChapter(activeSeries, selected)
  }

  const renameSeries = async (series: LibraryItem) => {
    const enteredTitle = window.prompt('Новое название манги:', series.title)
    const title = enteredTitle?.trim()
    if (!title || title === series.title) return

    const updatedSeries = { ...series, title }
    await saveItem(updatedSeries)
    await refresh()

    if (activeSeries?.id === series.id) {
      setActiveSeries(updatedSeries)
    }
    setNotice(`Манга переименована в «${title}».`)
  }

  const currentChapterIndex = activeSeries && activeChapter
    ? activeSeries.chapters.findIndex(chapter => chapter.id === activeChapter.id)
    : -1

  useEffect(() => {
    if (!activeChapter || mode !== 'page') return

    const handler = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        switchPage(direction === 'rtl' ? -1 : 1)
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        switchPage(direction === 'rtl' ? 1 : -1)
      }
      if (event.key === 'Escape') leaveReader()
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeChapter, mode, page, direction])

  const handleTouchStart = (event: React.TouchEvent) => {
    touchStart.current = event.touches[0]?.clientX ?? null
  }

  const handleTouchEnd = (event: React.TouchEvent) => {
    if (touchStart.current === null || mode !== 'page') return

    const dx = event.changedTouches[0].clientX - touchStart.current
    if (Math.abs(dx) > 55) {
      switchPage(
        dx < 0
          ? (direction === 'rtl' ? -1 : 1)
          : (direction === 'rtl' ? 1 : -1)
      )
    }
    touchStart.current = null
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={leaveReader}>
          <span className="brand-mark">漫</span>
          <span>MANGA<span className="brand-muted">MIX</span></span>
        </button>

        <div className="topbar-right">
          <span className="local-label"><i /> LOCAL ONLY</span>
          <button className="primary small" onClick={openImportDialog} disabled={busy}>
            {busy ? 'Импорт…' : '+ Добавить мангу'}
          </button>
          <input
            ref={fileInput}
            hidden
            type="file"
            multiple
            accept=".pdf,.cbz,.zip,application/pdf,application/zip,application/x-cbz,application/octet-stream"
            onChange={importFiles}
          />
        </div>
      </header>

      {importDialogOpen && (
        <div className="import-backdrop" onMouseDown={event => {
          if (event.target === event.currentTarget && !busy) setImportDialogOpen(false)
        }}>
          <section className="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
            <div className="import-dialog-header">
              <div>
                <div className="eyebrow">ЛОКАЛЬНАЯ БИБЛИОТЕКА</div>
                <h2 id="import-title">Добавить мангу</h2>
              </div>
              <button className="dialog-close" onClick={() => setImportDialogOpen(false)} disabled={busy} aria-label="Закрыть">×</button>
            </div>

            <div className="import-mode-switch">
              <button
                className={importMode === 'new' ? 'selected' : ''}
                onClick={() => setImportMode('new')}
              >
                Новая манга
              </button>
              <button
                className={importMode === 'existing' ? 'selected' : ''}
                onClick={() => setImportMode('existing')}
                disabled={library.length === 0}
              >
                В существующую
              </button>
            </div>

            {importMode === 'new' ? (
              <label className="import-field">
                <span>Название манги</span>
                <input
                  value={newSeriesTitle}
                  onChange={event => setNewSeriesTitle(event.target.value)}
                  placeholder="Например, Solo Leveling"
                  autoFocus
                />
              </label>
            ) : (
              <label className="import-field">
                <span>Выбери мангу</span>
                <select
                  value={selectedSeriesId || library[0]?.id || ''}
                  onChange={event => setSelectedSeriesId(event.target.value)}
                >
                  {library.map(series => (
                    <option key={series.id} value={series.id}>{series.title}</option>
                  ))}
                </select>
              </label>
            )}

            <p className="import-help">
              Можно выбрать сразу несколько PDF, CBZ или ZIP. Каждый файл будет добавлен как отдельная глава.
              Файлы остаются на этом устройстве.
            </p>

            <button
              className="primary import-submit"
              onClick={() => fileInput.current?.click()}
              disabled={busy || (importMode === 'new' && !newSeriesTitle.trim()) || (importMode === 'existing' && library.length === 0)}
            >
              {busy ? 'Обработка файлов…' : 'Выбрать файлы'}
            </button>
          </section>
        </div>
      )}

      {activeChapter && activeSeries ? (
        <section className="reader">
          <div className="reader-toolbar">
            <button className="text-button" onClick={leaveReader}>← Библиотека</button>

            <div className="reader-heading">
              <strong>{activeSeries.title}</strong>
              <span>{activeChapter.name}</span>
            </div>

            <div className="reader-chapter-navigation">
              <button
                className="chapter-step"
                onClick={() => switchChapter(-1)}
                disabled={currentChapterIndex <= 0}
                title="Предыдущая глава"
              >
                ‹
              </button>
              <select
                className="chapter-select"
                value={activeChapter.id}
                onChange={event => selectChapter(event.target.value)}
                aria-label="Выбрать главу"
              >
                {activeSeries.chapters.map((chapter, index) => (
                  <option key={chapter.id} value={chapter.id}>
                    {index + 1}. {chapter.name}
                  </option>
                ))}
              </select>
              <button
                className="chapter-step"
                onClick={() => switchChapter(1)}
                disabled={currentChapterIndex < 0 || currentChapterIndex >= activeSeries.chapters.length - 1}
                title="Следующая глава"
              >
                ›
              </button>
            </div>

            <div className="reader-options">
              <button className={mode === 'scroll' ? 'selected' : ''} onClick={() => setMode('scroll')}>Лента</button>
              <button className={mode === 'page' ? 'selected' : ''} onClick={() => setMode('page')}>Страницы</button>
              <button onClick={() => {
                setPage(0)
                void updateProgress(0)
                window.scrollTo({ top: 0, behavior: 'auto' })
              }}>С начала</button>
              <button className="direction-btn" onClick={() => setDirection(value => value === 'rtl' ? 'ltr' : 'rtl')}>
                {direction.toUpperCase()}
              </button>
            </div>
          </div>

          {mode === 'scroll' ? (
            <div className="scroll-reader" ref={scrollRef}>
              {Array.from({ length: activeChapter.pageCount }, (_, index) =>
                activeChapter.type === 'pdf'
                  ? <PdfPage key={`${activeChapter.id}-${index}`} blob={activeChapter.blob} pageNumber={index + 1} />
                  : <ArchivePage key={`${activeChapter.id}-${index}`} blob={activeChapter.blob} pagePath={archivePages[index] || ''} pageNumber={index + 1} />
              )}
              <div className="chapter-end">
                <span>ГЛАВА ЗАВЕРШЕНА</span>
                <h2>Конец главы</h2>
                <button className="primary" onClick={() => switchChapter(1)}>Следующая глава →</button>
                <button className="text-button" onClick={leaveReader}>Вернуться к библиотеке</button>
              </div>
            </div>
          ) : (
            <div className="page-reader" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
              <div className="page-counter">{page + 1} / {activeChapter.pageCount}</div>
              <div className="page-content">
                {activeChapter.type === 'pdf'
                  ? <PdfPage key={`${activeChapter.id}-${page}`} blob={activeChapter.blob} pageNumber={page + 1} />
                  : <ArchivePage key={`${activeChapter.id}-${page}`} blob={activeChapter.blob} pagePath={archivePages[page] || ''} pageNumber={page + 1} />
                }
              </div>
              <div className="page-nav">
                <button onClick={() => switchPage(direction === 'rtl' ? 1 : -1)} disabled={page === (direction === 'rtl' ? activeChapter.pageCount - 1 : 0)}>‹</button>
                <button onClick={() => switchPage(direction === 'rtl' ? -1 : 1)} disabled={page === (direction === 'rtl' ? 0 : activeChapter.pageCount - 1)}>›</button>
              </div>
            </div>
          )}
        </section>
      ) : (
        <main>
          <section className="hero">
            <div className="eyebrow">ТВОЯ КОЛЛЕКЦИЯ · ТВОИ ПРАВИЛА</div>
            <h1>Читай мангу<br /><em>по-своему.</em></h1>
            <p>
              Открой PDF, CBZ или ZIP и читай в удобном формате.
              Файлы остаются на твоём устройстве — сайт их никуда не загружает.
            </p>
            <button className="primary hero-button" onClick={openImportDialog} disabled={busy}>
              {busy ? 'Обработка файлов…' : '＋ Добавить мангу'}
            </button>
            <div className="privacy">✦ Локальная обработка · Без регистрации · Без облака</div>
          </section>

          <section className="library">
            <div className="section-head">
              <div>
                <div className="eyebrow">ЛОКАЛЬНОЕ ХРАНИЛИЩЕ</div>
                <h2>Моя библиотека <span>{library.length}</span></h2>
              </div>
              <input
                className="search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Поиск по библиотеке…"
              />
            </div>

            {notice && <div className="notice">{notice}</div>}

            {filtered.length ? (
              <div className="series-grid">
                {filtered.map(series => (
                  <article className="series-card" key={series.id}>
                    <div className="series-cover">
                      <span>漫</span>
                      <small>MANGAMIX</small>
                    </div>
                    <div className="series-details">
                      <strong>{series.title}</strong>
                      <span>{series.chapters.length} глав · {series.chapters.reduce((total, chapter) => total + chapter.pageCount, 0)} страниц</span>

                      {series.chapters.map(chapter => (
                        <button className="chapter-row" key={chapter.id} onClick={() => void openChapter(series, chapter)}>
                          <span>{chapter.name}</span>
                          <small>{chapter.pageCount} стр. · {chapter.progress ? `с ${chapter.progress + 1}` : 'не начато'}</small>
                        </button>
                      ))}

                      <div className="series-actions">
                        <button className="rename-series" onClick={() => void renameSeries(series)}>Переименовать</button>
                        <button
                          className="remove-series"
                          onClick={async () => {
                            if (confirm(`Удалить ${series.title} из локальной библиотеки?`)) {
                              await removeItem(series.id)
                              await refresh()
                            }
                          }}
                        >
                          Удалить из библиотеки
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty">
                <div className="empty-mark">冊</div>
                <strong>Библиотека пока пуста</strong>
                <span>Добавь мангу, выбрав PDF / CBZ / ZIP файлы.</span>
              </div>
            )}
          </section>
        </main>
      )}

      <footer className="footer">
        <span>MANGAMIX</span>
        <span>Локальная веб-читалка</span>
        <span>Файлы не отправляются на сервер</span>
      </footer>
    </div>
  )
}
