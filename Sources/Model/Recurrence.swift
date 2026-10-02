import Foundation
import CryptoKit

/// Same input → same UUID on every device (SHA-256 based, v5-style). Used for imported
/// events so the Mac and the web never create two copies of one meeting.
func stableUUID(_ key: String) -> UUID {
    var b = Array(SHA256.hash(data: Data(key.utf8)).prefix(16))
    b[6] = (b[6] & 0x0F) | 0x50
    b[8] = (b[8] & 0x3F) | 0x80
    return UUID(uuid: (b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]))
}

// MARK: - Date helpers

enum DateKey {
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func string(_ date: Date) -> String {
        formatter.timeZone = .current
        return formatter.string(from: date)
    }

    static func date(_ key: String) -> Date? {
        formatter.timeZone = .current
        return formatter.date(from: key)
    }
}

extension Date {
    var startOfDay: Date { Calendar.current.startOfDay(for: self) }
    var startOfWeek: Date { Calendar.current.dateInterval(of: .weekOfYear, for: self)?.start ?? startOfDay }
    var startOfMonth: Date { Calendar.current.dateInterval(of: .month, for: self)?.start ?? startOfDay }
    var minutesSinceMidnight: Int {
        let c = Calendar.current.dateComponents([.hour, .minute], from: self)
        return (c.hour ?? 0) * 60 + (c.minute ?? 0)
    }
    func adding(days: Int) -> Date { Calendar.current.date(byAdding: .day, value: days, to: self) ?? self }
    func adding(months: Int) -> Date { Calendar.current.date(byAdding: .month, value: months, to: self) ?? self }
    func adding(minutes: Int) -> Date { addingTimeInterval(TimeInterval(minutes * 60)) }
    func isSameDay(_ other: Date) -> Bool { Calendar.current.isDate(self, inSameDayAs: other) }
    var isToday: Bool { Calendar.current.isDateInToday(self) }
}

/// The wall-clock time `minutes` after midnight on `day` (DST-safe).
func dayAt(_ day: Date, minutes: Int) -> Date {
    Calendar.current.date(bySettingHour: minutes / 60, minute: minutes % 60, second: 0, of: day.startOfDay)
        ?? day.startOfDay.adding(minutes: minutes)
}

func timeString(_ date: Date) -> String {
    date.formatted(date: .omitted, time: .shortened)
}

func timeString(minutes: Int) -> String {
    timeString(dayAt(Date(), minutes: minutes))
}

func offsetString(_ minutes: Int) -> String {
    // Negative offsets fire after the start, i.e. partway through the task.
    if minutes < 0 {
        let m = -minutes
        return m % 60 == 0 ? "\(m / 60) hr into task" : "\(m) min into task"
    }
    switch minutes {
    case 0: return "At start"
    case let m where m % 1440 == 0: return m == 1440 ? "1 day before" : "\(m / 1440) days before"
    case let m where m % 60 == 0: return m == 60 ? "1 hour before" : "\(m / 60) hours before"
    default: return "\(minutes) min before"
    }
}

/// Notes for an imported Google event: its description as plain text, else its location.
/// Identical to eventNotes() in the web app (model.js) and the server importer, so devices agree.
func eventNotes(_ description: String?, _ location: String?) -> String {
    var t = description ?? ""
    let rules: [(String, String)] = [
        ("(?i)<br\\s*/?>", "\n"), ("(?i)</p>", "\n"), ("<[^>]+>", ""),
        ("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&amp;", "&"),
    ]
    for (pattern, replacement) in rules {
        t = t.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
    }
    t = t.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.isEmpty ? (location ?? "").trimmingCharacters(in: .whitespacesAndNewlines) : t
}

/// Counts words the way a person would: whitespace-separated chunks containing a letter or digit.
func countWords(_ text: String) -> Int {
    text.split(whereSeparator: { $0.isWhitespace || $0.isNewline })
        .filter { $0.contains(where: { $0.isLetter || $0.isNumber }) }
        .count
}

// MARK: - Recurrence expansion

extension PlanTask {
    /// Whether this task has an occurrence on `day`.
    func occurs(on day: Date) -> Bool {
        if archived == true { return false }
        let d = day.startOfDay
        let s = startDate.startOfDay
        guard d >= s else { return false }
        if case .onDate(let end) = recurrence.end, recurrence.isRepeating, d > end.startOfDay { return false }
        guard matchesPattern(d, start: s) else { return false }
        if case .afterCount(let limit) = recurrence.end, recurrence.isRepeating {
            guard patternIndex(of: d, start: s) < limit else { return false }
        }
        return !skipped.contains(DateKey.string(d))
    }

    private func matchesPattern(_ d: Date, start s: Date) -> Bool {
        let cal = Calendar.current
        let n = max(1, recurrence.interval)
        switch recurrence.frequency {
        case .none:
            return d == s
        case .daily:
            let days = cal.dateComponents([.day], from: s, to: d).day ?? 0
            return days % n == 0
        case .weekly:
            guard recurrence.effectiveWeekdays(start: s).contains(cal.component(.weekday, from: d)) else { return false }
            let days = cal.dateComponents([.day], from: s.startOfWeek, to: d.startOfWeek).day ?? 0
            return (days / 7) % n == 0
        case .monthly:
            guard cal.component(.day, from: d) == cal.component(.day, from: s) else { return false }
            let months = cal.dateComponents([.month], from: s.startOfMonth, to: d.startOfMonth).month ?? 0
            return months % n == 0
        case .yearly:
            guard cal.component(.day, from: d) == cal.component(.day, from: s),
                  cal.component(.month, from: d) == cal.component(.month, from: s) else { return false }
            let years = cal.dateComponents([.year], from: s, to: d).year ?? 0
            return years % n == 0
        }
    }

    /// Zero-based index of `d` among the rule's occurrences (skips still count, as in iCal).
    private func patternIndex(of d: Date, start s: Date) -> Int {
        var count = 0
        var cursor = s
        var guardRail = 0
        while cursor < d && guardRail < 20_000 {
            if matchesPattern(cursor, start: s) { count += 1 }
            cursor = cursor.adding(days: 1)
            guardRail += 1
        }
        return count
    }

    /// The first occurrence on or after `from`, searching about a year ahead.
    func nextOccurrence(onOrAfter from: Date = Date()) -> Date? {
        var day = max(from.startOfDay, startDate.startOfDay)
        for _ in 0..<400 {
            if occurs(on: day) { return day }
            if !recurrence.isRepeating { return nil }
            day = day.adding(days: 1)
        }
        return nil
    }
}
