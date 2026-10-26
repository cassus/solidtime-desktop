import { ipcMain } from 'electron'
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

const CACHE_TTL_MS = 5 * 60 * 1000

let cache: { url: string; fetchedAt: number; calendar: CalendarResponse } | null = null

async function getIcalUrl(): Promise<string> {
    return (await getSetting(SECRET_SETTING_KEYS.CALENDAR_ICAL_URL)) ?? ''
}

async function fetchCalendar(url: string, forceRefresh: boolean): Promise<CalendarResponse> {
    if (
        !forceRefresh &&
        cache &&
        cache.url === url &&
        Date.now() - cache.fetchedAt < CACHE_TTL_MS
    ) {
        return cache.calendar
    }
    const response = await fetch(url)
    if (!response.ok) {
        throw new Error(`Calendar feed request failed with HTTP ${response.status}`)
    }
    const calendar = ical.sync.parseICS(await response.text())
    cache = { url, fetchedAt: Date.now(), calendar }
    return calendar
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

        const calendar = await fetchCalendar(url, forceRefresh)
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
        // The error message may contain the feed URL, so only report a generic error
        const errorMessage = error instanceof Error ? error.name : 'Unknown error'
        console.error('Failed to fetch calendar events:', errorMessage)
        Sentry.captureMessage('Failed to fetch calendar events', {
            tags: { context: 'getCalendarEvents' },
            extra: { errorName: errorMessage },
        })
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
        cache = null
        return { success: true }
    })
}
