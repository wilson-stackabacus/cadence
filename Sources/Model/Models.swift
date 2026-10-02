import Foundation
import SwiftUI

// MARK: - Alert channels

/// The ways Cadence can get your attention. Each task picks any combination.
enum AlertChannel: String, Codable, CaseIterable, Identifiable {
    case notification, banner, sound, checkIn

    var id: String { rawValue }

    var label: String {
        switch self {
        case .notification: return "Notification"
        case .banner: return "On-screen banner"
        case .sound: return "Sound"
        case .checkIn: return "Checklist window"
        }
    }

    var detail: String {
        switch self {
        case .notification: return "macOS Notification Center. Banner vs. persistent alert style is chosen in System Settings."
        case .banner: return "A Cadence banner in the top-right corner that stays until you dismiss it."
        case .sound: return "Play a chime."
        case .checkIn: return "Pop open the daily checklist window."
        }
    }

    var symbol: String {
        switch self {
        case .notification: return "bell.badge"
        case .banner: return "rectangle.topthird.inset.filled"
        case .sound: return "speaker.wave.2"
        case .checkIn: return "checklist"
        }
    }
}

// MARK: - Colors

enum TaskColor: String, Codable, CaseIterable, Identifiable {
    case blue, teal, green, yellow, orange, red, pink, purple, gray
    var id: String { rawValue }
    var color: Color {
        switch self {
        case .blue: return .blue
        case .teal: return .teal
        case .green: return .green
        case .yellow: return .yellow
        case .orange: return .orange
        case .red: return .red
        case .pink: return .pink
        case .purple: return .purple
        case .gray: return .gray
        }
    }
}

// MARK: - Recurrence

enum Frequency: String, Codable, CaseIterable, Identifiable {
    case none, daily, weekly, monthly, yearly
    var id: String { rawValue }
    var label: String {
        switch self {
        case .none: return "Does not repeat"
        case .daily: return "Daily"
        case .weekly: return "Weekly"
        case .monthly: return "Monthly"
        case .yearly: return "Yearly"
        }
    }
    var unit: String {
        switch self {
        case .none: return ""
        case .daily: return "day"
        case .weekly: return "week"
        case .monthly: return "month"
        case .yearly: return "year"
        }
    }
}

enum RecurrenceEnd: Codable, Hashable {
    case never
    case onDate(Date)
    case afterCount(Int)
}

struct Recurrence: Codable, Hashable {
    var frequency: Frequency = .none
    var interval: Int = 1
    /// Calendar weekdays (1 = Sunday … 7 = Saturday). Only used for weekly rules.
    var weekdays: [Int] = []
    var end: RecurrenceEnd = .never

    var isRepeating: Bool { frequency != .none }

    func effectiveWeekdays(start: Date) -> [Int] {
        weekdays.isEmpty ? [Calendar.current.component(.weekday, from: start)] : weekdays.sorted()
    }

    func summary(start: Date) -> String {
        let n = max(1, interval)
        var s: String
        switch frequency {
        case .none:
            return "Once"
        case .daily:
            s = n == 1 ? "Every day" : "Every \(n) days"
        case .weekly:
            let days = effectiveWeekdays(start: start)
            if n == 1 && days == [2, 3, 4, 5, 6] {
                s = "Every weekday"
            } else if n == 1 && days.count == 7 {
                s = "Every day"
            } else {
                let names = days.map { Calendar.current.shortWeekdaySymbols[$0 - 1] }.joined(separator: ", ")
                s = (n == 1 ? "Weekly" : "Every \(n) weeks") + " on " + names
            }
        case .monthly:
            let day = Calendar.current.component(.day, from: start)
            s = (n == 1 ? "Monthly" : "Every \(n) months") + " on day \(day)"
        case .yearly:
            s = (n == 1 ? "Yearly" : "Every \(n) years") + " on " + start.formatted(.dateTime.month(.abbreviated).day())
        }
        switch end {
        case .never: break
        case .onDate(let d): s += ", until " + d.formatted(date: .abbreviated, time: .omitted)
        case .afterCount(let c): s += ", \(c) times"
        }
        return s
    }

    /// RFC 5545 rule, used when exporting a task to Google Calendar.
    func rrule(start: Date) -> String? {
        guard isRepeating else { return nil }
        var parts = ["FREQ=" + frequency.rawValue.uppercased()]
        if interval > 1 { parts.append("INTERVAL=\(interval)") }
        if frequency == .weekly {
            let codes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]
            parts.append("BYDAY=" + effectiveWeekdays(start: start).map { codes[$0 - 1] }.joined(separator: ","))
        }
        switch end {
        case .never: break
        case .onDate(let d):
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.timeZone = TimeZone(identifier: "UTC")
            f.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
            parts.append("UNTIL=" + f.string(from: d.startOfDay.adding(days: 1).addingTimeInterval(-1)))
        case .afterCount(let c):
            parts.append("COUNT=\(c)")
        }
        return "RRULE:" + parts.joined(separator: ";")
    }
}

// MARK: - Tasks

struct PlanTask: Codable, Identifiable, Hashable {
    var id = UUID()
    var title: String
    var notes: String = ""
    /// The (first) day the task happens.
    var startDate: Date
    /// Minutes after midnight, or nil for "any time that day".
    var timeMinutes: Int?
    var durationMinutes: Int = 30
    var recurrence = Recurrence()
    /// Minutes before the start to remind. 0 = at the start time; negative = that many minutes into the task.
    var reminderOffsets: Set<Int> = [0]
    var channels: Set<AlertChannel> = [.notification, .banner]
    var color: TaskColor = .blue
    /// Occurrence day key ("yyyy-MM-dd") → completion time.
    var completions: [String: Date] = [:]
    /// Occurrence day keys the user chose to skip.
    var skipped: Set<String> = []
    var googleEventID: String?
    var createdAt = Date()
    /// Last local or synced edit; drives last-writer-wins sync. nil for data created before sync existed.
    var updatedAt: Date?
    /// "google" / "calendly" for imported items; nil for tasks made in Cadence.
    var source: String?
    /// Link back to the original event (Google Calendar page, Calendly meeting link).
    var externalURL: String?
    /// Google calendar the event came from, so any device can re-check it by ID.
    var sourceCalendar: String?
    /// Imported items are hidden instead of deleted, so the next import doesn't bring them back.
    var archived: Bool?

    /// "task" or "event"; nil means: event if imported, otherwise task.
    var kind: String?

    /// No channels = a silent item: it never pings.
    var isSilent: Bool { channels.isEmpty }
    var isImported: Bool { source != nil }
    /// Events live on the calendars only: never on the checklist, no check-off, no reflection.
    var isEvent: Bool { kind == "event" || (kind != "task" && source != nil) }
}

/// One concrete instance of a (possibly repeating) task on a given day.
struct Occurrence: Identifiable, Hashable {
    let task: PlanTask
    let day: Date

    var key: String { DateKey.string(day) }
    var id: String { "\(task.id.uuidString)|\(key)" }
    var start: Date? { task.timeMinutes.map { dayAt(day, minutes: $0) } }
    var end: Date? { start?.adding(minutes: max(5, task.durationMinutes)) }
    var isEvent: Bool { task.isEvent }
    var isDone: Bool { !task.isEvent && task.completions[key] != nil }
    var isOverdue: Bool { !task.isEvent && !isDone && day < Date().startOfDay }
}

// MARK: - Reflections

struct Reflection: Codable, Identifiable, Hashable {
    var id = UUID()
    var taskID: UUID
    var taskTitle: String
    var occurrenceKey: String
    var text: String
    var createdAt = Date()
    var updatedAt: Date?

    var wordCount: Int { countWords(text) }
}

// MARK: - Booking (Calendly-style)

struct MeetingType: Codable, Identifiable, Hashable {
    var id = UUID()
    var name: String
    var minutes: Int
    var details: String = ""
    var addMeetLink = true

    static let defaults: [MeetingType] = [
        MeetingType(name: "Quick chat", minutes: 15, details: "A short check-in."),
        MeetingType(name: "Meeting", minutes: 30, details: "A regular 30-minute meeting."),
        MeetingType(name: "Deep dive", minutes: 60, details: "An hour to work through something in depth."),
    ]
}

struct Availability: Codable, Hashable {
    var weekdays: [Int] = [2, 3, 4, 5, 6]
    var startMinutes = 9 * 60
    var endMinutes = 17 * 60
    var bufferMinutes = 10
    var minNoticeHours = 4
    var daysAhead = 14
}

// MARK: - Settings

struct AppSettings: Codable {
    // Every-30-minutes nudge while the Mac is in use
    var nudgeEnabled = true
    var nudgeIntervalMinutes = 30
    var nudgeChannels: Set<AlertChannel> = [.notification, .banner]
    var nudgeOnlyWhenIncomplete = true

    // Check-in when the computer is opened
    var checkInOnLaunch = true
    var checkInOnWake = true
    var checkInOnUnlock = true
    var checkInOnlyWhenIncomplete = false
    var checkInChannels: Set<AlertChannel> = [.checkIn, .sound]

    // Task reminders
    var defaultChannels: Set<AlertChannel> = [.notification, .banner]
    var untimedReminderMinutes = 9 * 60
    var bannerAutoDismissSeconds = 0

    // Reflections
    var minReflectionWords = 20

    // Google Calendar
    var googleClientID = ""
    var googleClientSecret = ""
    var googleCalendarIDs: [String] = []
    var showGoogleEvents = true
    var googleEventReminderMinutes = 0   // imported/calendar events don't ping by default

    // Calendar imports (Google Calendar events + Calendly meetings become silent checklist items)
    var autoImportCalendars = true
    var importDaysAhead = 14

    // Booking
    var availability = Availability()
    var meetingTypes: [MeetingType] = MeetingType.defaults

    init() {}

    // Tolerant decoding so adding a setting never wipes an existing data file.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = AppSettings()
        nudgeEnabled = c.value(.nudgeEnabled, d.nudgeEnabled)
        nudgeIntervalMinutes = c.value(.nudgeIntervalMinutes, d.nudgeIntervalMinutes)
        nudgeChannels = c.value(.nudgeChannels, d.nudgeChannels)
        nudgeOnlyWhenIncomplete = c.value(.nudgeOnlyWhenIncomplete, d.nudgeOnlyWhenIncomplete)
        checkInOnLaunch = c.value(.checkInOnLaunch, d.checkInOnLaunch)
        checkInOnWake = c.value(.checkInOnWake, d.checkInOnWake)
        checkInOnUnlock = c.value(.checkInOnUnlock, d.checkInOnUnlock)
        checkInOnlyWhenIncomplete = c.value(.checkInOnlyWhenIncomplete, d.checkInOnlyWhenIncomplete)
        checkInChannels = c.value(.checkInChannels, d.checkInChannels)
        defaultChannels = c.value(.defaultChannels, d.defaultChannels)
        untimedReminderMinutes = c.value(.untimedReminderMinutes, d.untimedReminderMinutes)
        bannerAutoDismissSeconds = c.value(.bannerAutoDismissSeconds, d.bannerAutoDismissSeconds)
        minReflectionWords = max(20, c.value(.minReflectionWords, d.minReflectionWords))
        googleClientID = c.value(.googleClientID, d.googleClientID)
        googleClientSecret = c.value(.googleClientSecret, d.googleClientSecret)
        googleCalendarIDs = c.value(.googleCalendarIDs, d.googleCalendarIDs)
        showGoogleEvents = c.value(.showGoogleEvents, d.showGoogleEvents)
        googleEventReminderMinutes = c.value(.googleEventReminderMinutes, d.googleEventReminderMinutes)
        availability = c.value(.availability, d.availability)
        meetingTypes = c.value(.meetingTypes, d.meetingTypes)
        autoImportCalendars = c.value(.autoImportCalendars, d.autoImportCalendars)
        importDaysAhead = c.value(.importDaysAhead, d.importDaysAhead)
    }
}

/// The settings that sync between devices (Google client credentials, calendar picks and
/// the like stay on each device). Same JSON keys as AppSettings, so the web app shares them.
struct SyncedSettings: Codable, Equatable {
    var nudgeEnabled: Bool
    var nudgeIntervalMinutes: Int
    var nudgeChannels: Set<AlertChannel>
    var nudgeOnlyWhenIncomplete: Bool
    var checkInOnLaunch: Bool
    var checkInOnWake: Bool
    var checkInOnUnlock: Bool
    var checkInOnlyWhenIncomplete: Bool
    var checkInChannels: Set<AlertChannel>
    var defaultChannels: Set<AlertChannel>
    var untimedReminderMinutes: Int
    var bannerAutoDismissSeconds: Int
    var minReflectionWords: Int
    var showGoogleEvents: Bool
    var googleEventReminderMinutes: Int
    var availability: Availability
    var meetingTypes: [MeetingType]
    var autoImportCalendars: Bool
    var importDaysAhead: Int

    init(_ s: AppSettings) {
        nudgeEnabled = s.nudgeEnabled; nudgeIntervalMinutes = s.nudgeIntervalMinutes
        nudgeChannels = s.nudgeChannels; nudgeOnlyWhenIncomplete = s.nudgeOnlyWhenIncomplete
        checkInOnLaunch = s.checkInOnLaunch; checkInOnWake = s.checkInOnWake; checkInOnUnlock = s.checkInOnUnlock
        checkInOnlyWhenIncomplete = s.checkInOnlyWhenIncomplete; checkInChannels = s.checkInChannels
        defaultChannels = s.defaultChannels; untimedReminderMinutes = s.untimedReminderMinutes
        bannerAutoDismissSeconds = s.bannerAutoDismissSeconds; minReflectionWords = s.minReflectionWords
        showGoogleEvents = s.showGoogleEvents; googleEventReminderMinutes = s.googleEventReminderMinutes
        availability = s.availability; meetingTypes = s.meetingTypes
        autoImportCalendars = s.autoImportCalendars; importDaysAhead = s.importDaysAhead
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(AppSettings())
        nudgeEnabled = c.value(.nudgeEnabled, nudgeEnabled)
        nudgeIntervalMinutes = c.value(.nudgeIntervalMinutes, nudgeIntervalMinutes)
        nudgeChannels = c.value(.nudgeChannels, nudgeChannels)
        nudgeOnlyWhenIncomplete = c.value(.nudgeOnlyWhenIncomplete, nudgeOnlyWhenIncomplete)
        checkInOnLaunch = c.value(.checkInOnLaunch, checkInOnLaunch)
        checkInOnWake = c.value(.checkInOnWake, checkInOnWake)
        checkInOnUnlock = c.value(.checkInOnUnlock, checkInOnUnlock)
        checkInOnlyWhenIncomplete = c.value(.checkInOnlyWhenIncomplete, checkInOnlyWhenIncomplete)
        checkInChannels = c.value(.checkInChannels, checkInChannels)
        defaultChannels = c.value(.defaultChannels, defaultChannels)
        untimedReminderMinutes = c.value(.untimedReminderMinutes, untimedReminderMinutes)
        bannerAutoDismissSeconds = c.value(.bannerAutoDismissSeconds, bannerAutoDismissSeconds)
        minReflectionWords = max(20, c.value(.minReflectionWords, minReflectionWords))
        showGoogleEvents = c.value(.showGoogleEvents, showGoogleEvents)
        googleEventReminderMinutes = c.value(.googleEventReminderMinutes, googleEventReminderMinutes)
        availability = c.value(.availability, availability)
        meetingTypes = c.value(.meetingTypes, meetingTypes)
        autoImportCalendars = c.value(.autoImportCalendars, autoImportCalendars)
        importDaysAhead = c.value(.importDaysAhead, importDaysAhead)
    }

    func apply(to s: inout AppSettings) {
        s.nudgeEnabled = nudgeEnabled; s.nudgeIntervalMinutes = nudgeIntervalMinutes
        s.nudgeChannels = nudgeChannels; s.nudgeOnlyWhenIncomplete = nudgeOnlyWhenIncomplete
        s.checkInOnLaunch = checkInOnLaunch; s.checkInOnWake = checkInOnWake; s.checkInOnUnlock = checkInOnUnlock
        s.checkInOnlyWhenIncomplete = checkInOnlyWhenIncomplete; s.checkInChannels = checkInChannels
        s.defaultChannels = defaultChannels; s.untimedReminderMinutes = untimedReminderMinutes
        s.bannerAutoDismissSeconds = bannerAutoDismissSeconds; s.minReflectionWords = minReflectionWords
        s.showGoogleEvents = showGoogleEvents; s.googleEventReminderMinutes = googleEventReminderMinutes
        s.availability = availability; s.meetingTypes = meetingTypes
        s.autoImportCalendars = autoImportCalendars; s.importDaysAhead = importDaysAhead
    }
}

extension KeyedDecodingContainer {
    func value<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        (try? decodeIfPresent(T.self, forKey: key)) ?? fallback
    }
}
