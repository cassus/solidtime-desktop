import { app, BrowserWindow, ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import ical, { type CalendarResponse, type VEvent } from 'node-ical'
import * as Sentry from '@sentry/electron/main'
import { getSetting, setSetting, SECRET_SETTING_KEYS } from './settings'

// Read-only overlay of an external calendar (e.g. Google Calendar's "secret address
// in iCal format"). The URL is a secret: it stays in the local settings table and
// must never be logged or sent to Sentry.

export interface ExternalCalendarEvent {
    id: string
    title: string
    start: string
    end: string
}

type CalendarEventsResult =
    | { success: true; data: ExternalCalendarEvent[] }
    | { success: false; error: string }

// Large feeds (Google: tens of MB) can take a minute to download. The last feed
// is kept on disk and shown right away; a stale feed is refreshed in the background
// and the renderer is told via 'calendarFeedStatus' when new data is ready.
const REFRESH_AFTER_MS = 15 * 60 * 1000

// The disk cache is keyed by a hash of the URL, so the URL itself is never written there
const feedFile = (): string => join(app.getPath('userData'), 'calendar-feed.ics')
const metaFile = (): string => join(app.getPath('userData'), 'calendar-feed.json')
const hashUrl = (url: string): string => createHash('sha256').update(url).digest('hex')

let cache: { urlHash: string; fetchedAt: number; calendar: CalendarResponse } | null = null
let refreshing: Promise<void> | null = null

async function getIcalUrl(): Promise<string> {
    return (await getSetting(SECRET_SETTING_KEYS.CALENDAR_ICAL_URL)) ?? ''
}

function broadcastStatus(): void {
    for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('calendarFeedStatus', { refreshing: refreshing !== null })
    }
}

async function loadFromDisk(urlHash: string): Promise<void> {
    try {
        const meta = JSON.parse(await readFile(metaFile(), 'utf8'))
        if (meta.urlHash !== urlHash) return
        const calendar = ical.sync.parseICS(await readFile(feedFile(), 'utf8'))
        cache = { urlHash, fetchedAt: meta.fetchedAt, calendar }
    } catch {
        // No usable disk cache yet
    }
}

function refreshFeed(url: string): Promise<void> {
    if (refreshing) return refreshing
    refreshing = (async () => {
        try {
            const response = await fetch(url)
            if (!response.ok) {
                throw new Error(`Calendar feed request failed with HTTP ${response.status}`)
            }
            const body = await response.text()
            const urlHash = hashUrl(url)
            const fetchedAt = Date.now()
            cache = { urlHash, fetchedAt, calendar: ical.sync.parseICS(body) }
            await writeFile(feedFile(), body, { mode: 0o600 })
            await writeFile(metaFile(), JSON.stringify({ urlHash, fetchedAt }), { mode: 0o600 })
        } finally {
            refreshing = null
            broadcastStatus()
        }
    })()
    broadcastStatus()
    return refreshing
}

async function getCalendar(url: string, forceRefresh: boolean): Promise<CalendarResponse> {
    const urlHash = hashUrl(url)
    if (!cache || cache.urlHash !== urlHash) {
        cache = null
        await loadFromDisk(urlHash)
    }
    if (!cache || forceRefresh) {
        // Nothing to show yet: wait for the download
        await refreshFeed(url)
    } else if (Date.now() - cache.fetchedAt > REFRESH_AFTER_MS) {
        // Show the stale feed now, refresh in the background
        refreshFeed(url).catch(reportError)
    }
    if (!cache) throw new Error('Calendar feed unavailable')
    return cache.calendar
}

function reportError(error: unknown): void {
    // The error message may contain the feed URL, so only report a generic error
    const errorName = error instanceof Error ? error.name : 'Unknown error'
    console.error('Failed to fetch calendar events:', errorName)
    Sentry.captureMessage('Failed to fetch calendar events', {
        tags: { context: 'getCalendarEvents' },
        extra: { errorName },
    })
}

async function clearCache(): Promise<void> {
    cache = null
    await rm(feedFile(), { force: true })
    await rm(metaFile(), { force: true })
}

function summaryText(summary: unknown): string {
    if (typeof summary === 'string') return summary
    if (summary && typeof summary === 'object' && 'val' in summary) {
        return String((summary as { val: unknown }).val)
    }
    return '(no title)'
}

async function getCalendarEvents(
    startDate: unknown,
    endDate: unknown,
    forceRefresh = false
): Promise<CalendarEventsResult> {
    try {
        if (typeof startDate !== 'string' || typeof endDate !== 'string') {
            return { success: false, error: 'Invalid date range' }
        }
        const from = new Date(startDate)
        const to = new Date(endDate)
        if (isNaN(from.getTime()) || isNaN(to.getTime())) {
            return { success: false, error: 'Invalid date range' }
        }

        const url = await getIcalUrl()
        if (!url) {
            return { success: true, data: [] }
        }

        const calendar = await getCalendar(url, forceRefresh)
        const events: ExternalCalendarEvent[] = []

        for (const entry of Object.values(calendar)) {
            if (!entry || (entry as { type?: string }).type !== 'VEVENT') continue
            const component = entry as VEvent
            // Overrides of recurring events are applied via their parent's expansion
            if (component.recurrenceid) continue
            if (component.status === 'CANCELLED') continue

            const instances = ical.expandRecurringEvent(component, {
                from,
                to,
                expandOngoing: true,
            })
            for (const instance of instances) {
                if (instance.isFullDay) continue
                // A single occurrence can be cancelled via a RECURRENCE-ID override
                if ((instance.event as VEvent | undefined)?.status === 'CANCELLED') continue
                const start = new Date(instance.start)
                const end = new Date(instance.end ?? instance.start)
                if (end <= from || start >= to || end <= start) continue
                events.push({
                    id: `${component.uid}-${start.toISOString()}`,
                    title: summaryText(instance.summary),
                    start: start.toISOString(),
                    end: end.toISOString(),
                })
            }
        }

        events.sort((a, b) => a.start.localeCompare(b.start))
        return { success: true, data: events }
    } catch (error) {
        reportError(error)
        return { success: false, error: 'Could not load the calendar feed' }
    }
}

/**
 * Registers IPC handlers for the external calendar overlay
 */
export function registerCalendarEventListeners(): void {
    ipcMain.handle(
        'getCalendarEvents',
        async (_event, startDate: unknown, endDate: unknown, forceRefresh?: boolean) => {
            return getCalendarEvents(startDate, endDate, forceRefresh === true)
        }
    )

    // The renderer only learns whether a URL is set, never the URL itself
    ipcMain.handle('hasCalendarIcalUrl', async () => {
        return (await getIcalUrl()) !== ''
    })

    ipcMain.handle('setCalendarIcalUrl', async (_event, url: unknown) => {
        const value = typeof url === 'string' ? url.trim() : ''
        if (value !== '' && !/^https:\/\//.test(value)) {
            return { success: false, error: 'The calendar address must start with https://' }
        }
        try {
            await setSetting(SECRET_SETTING_KEYS.CALENDAR_ICAL_URL, value)
        } catch {
            // setSetting already reported a redacted error; don't rethrow it to IPC
            return { success: false, error: 'Could not save the calendar address' }
        }
        await clearCache()
        return { success: true }
    })

    ipcMain.handle('getCalendarFeedStatus', () => ({ refreshing: refreshing !== null }))

    // Warm the cache at startup so the calendar view rarely waits for the download
    getIcalUrl()
        .then((url) => (url ? getCalendar(url, false) : undefined))
        .catch(reportError)
}
