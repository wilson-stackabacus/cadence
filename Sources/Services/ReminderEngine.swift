import AppKit

/// Watches the clock and the Mac's sleep/lock state, and fires:
/// - per-task reminders (at the chosen offsets, through the task's channels)
/// - Google Calendar event reminders
/// - the recurring "check your checklist" nudge while the computer is in use
/// - a check-in every time the computer is opened (launch, wake, unlock)
@MainActor
final class ReminderEngine: ObservableObject {
    enum CheckInReason {
        case launch, wake, unlock, manual
        var title: String {
            switch self {
            case .launch: return "Time to check in"
            case .wake, .unlock: return "Welcome back — check your list"
            case .manual: return "Daily check-in"
            }
        }
    }

    private unowned let model: AppModel
    private var timer: Timer?
    private var lastTick = Date()
    private var fired: Set<String> = []
    private var lastCheckIn: Date?
    private var currentDay = Date().startOfDay
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []

    @Published private(set) var lastNudge = Date()
    @Published private(set) var screenLocked = false
    @Published private(set) var displayAsleep = false

    var nextNudge: Date { lastNudge.adding(minutes: model.store.settings.nudgeIntervalMinutes) }

    init(model: AppModel) { self.model = model }

    func start() {
        lastTick = Date().addingTimeInterval(-60)
        lastNudge = Date()
        let t = Timer(timeInterval: 15, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        t.tolerance = 3
        RunLoop.main.add(t, forMode: .common)
        timer = t

        let ws = NSWorkspace.shared.notificationCenter
        observe(ws, NSWorkspace.didWakeNotification) { $0.didWake() }
        observe(ws, NSWorkspace.screensDidWakeNotification) { $0.displayAsleep = false; $0.didWake() }
        observe(ws, NSWorkspace.screensDidSleepNotification) { $0.displayAsleep = true }
        observe(ws, NSWorkspace.sessionDidBecomeActiveNotification) { $0.didUnlock() }

        // Screen lock/unlock is only announced through the distributed notification center.
        let dnc = DistributedNotificationCenter.default()
        observe(dnc, Notification.Name("com.apple.screenIsLocked")) { $0.screenLocked = true }
        observe(dnc, Notification.Name("com.apple.screenIsUnlocked")) { $0.didUnlock() }

        tick()
    }

    private func observe(_ center: NotificationCenter, _ name: Notification.Name,
                         _ handler: @escaping (ReminderEngine) -> Void) {
        let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { if let self { handler(self) } }
        }
        observers.append((center, token))
    }

    // MARK: Computer opened

    private func didWake() {
        lastNudge = Date()
        model.sync.sync()   // pick up anything changed on the web while the Mac slept
        guard model.store.settings.checkInOnWake else { return }
        // If the screen is locked, the unlock notification will handle it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            guard let self, !self.screenLocked else { return }
            self.triggerCheckIn(reason: .wake)
        }
    }

    private func didUnlock() {
        screenLocked = false
        displayAsleep = false
        lastNudge = Date()
        guard model.store.settings.checkInOnUnlock else { return }
        triggerCheckIn(reason: .unlock)
    }

    func triggerCheckIn(reason: CheckInReason) {
        let now = Date()
        // Wake + unlock usually arrive together; one prompt is enough.
        if reason != .manual, let last = lastCheckIn, now.timeIntervalSince(last) < 90 { return }
        let store = model.store
        let s = store.settings
        let remaining = store.remainingToday
        if reason != .manual && s.checkInOnlyWhenIncomplete && remaining == 0 { return }
        lastCheckIn = now
        lastNudge = now

        var channels = s.checkInChannels
        if reason == .manual { channels.insert(.checkIn) }
        let body = remaining == 0
            ? "Everything on today's checklist is done."
            : "\(remaining) item\(remaining == 1 ? "" : "s") left on today's checklist."
        model.notifier.deliver(AlertContent(kind: .checkIn, title: reason.title, body: body,
                                            symbol: "sun.max.fill", tint: .orange),
                               channels: channels)
    }

    // MARK: Clock

    func tick() {
        let now = Date()
        let store = model.store
        let s = store.settings

        if !now.isSameDay(currentDay) {
            currentDay = now.startOfDay
            store.objectWillChange.send()   // refresh "today" everywhere, incl. the menu bar count
        }

        // Only look back a little, so waking from a long sleep doesn't dump hours of stale alerts.
        let windowStart = max(lastTick, now.addingTimeInterval(-15 * 60))
        defer { lastTick = now }
        guard now > windowStart else { return }

        func due(_ at: Date, _ key: String) -> Bool {
            at > windowStart && at <= now && fired.insert(key).inserted
        }

        // Task reminders (tomorrow included, for "1 day before" reminders).
        for offset in -1...1 {
            let day = now.startOfDay.adding(days: offset)
            for occ in store.occurrences(on: day) where !occ.isDone && !occ.task.isSilent {
                let base = occ.start ?? dayAt(day, minutes: s.untimedReminderMinutes)
                for off in occ.task.reminderOffsets.sorted() where due(base.adding(minutes: -off), "\(occ.id)|\(off)") {
                    model.notifier.deliver(reminderContent(occ, offset: off), channels: occ.task.channels)
                }
            }
        }

        // Google Calendar events.
        if model.google.isConnected && s.googleEventReminderMinutes > 0 {
            for ev in model.google.events(on: now) where !ev.isAllDay {
                let at = ev.start.adding(minutes: -s.googleEventReminderMinutes)
                if due(at, "g|\(ev.id)|\(ev.start.timeIntervalSince1970)") {
                    model.notifier.deliver(AlertContent(kind: .event, title: ev.title,
                                                        body: "Starts at \(timeString(ev.start))" + (ev.location.map { " · \($0)" } ?? ""),
                                                        symbol: "calendar", tint: .blue),
                                           channels: s.defaultChannels)
                }
            }
        }

        // The recurring checklist nudge — only while someone is actually at the computer.
        if s.nudgeEnabled && !screenLocked && !displayAsleep
            && now.timeIntervalSince(lastNudge) >= Double(s.nudgeIntervalMinutes * 60) {
            lastNudge = now
            let open = store.todayChecklist().filter { !$0.isDone && !$0.task.isSilent }
            if !open.isEmpty || !s.nudgeOnlyWhenIncomplete {
                model.notifier.deliver(nudgeContent(open), channels: s.nudgeChannels)
            }
        }
    }

    func resetNudgeTimer() { lastNudge = Date() }

    private func reminderContent(_ occ: Occurrence, offset: Int) -> AlertContent {
        var body: String
        if let start = occ.start {
            if offset < 0, let end = occ.end {
                body = "Check-in: \(offsetString(offset)) (until \(timeString(end)))"
            } else {
                body = offset == 0 ? "Starting now (\(timeString(start)))" : "At \(timeString(start)) — \(offsetString(offset))"
            }
        } else {
            body = offset >= 1440 ? "Coming up \(occ.day.formatted(.dateTime.weekday(.wide)))" : "On today's checklist"
        }
        body += ". Check it off with a reflection when you're done."
        return AlertContent(kind: .task, title: occ.task.title, body: body,
                            symbol: "checkmark.circle", tint: occ.task.color.color, occurrence: occ)
    }

    private func nudgeContent(_ open: [Occurrence]) -> AlertContent {
        guard !open.isEmpty else {
            return AlertContent(kind: .nudge, title: "Checklist check", body: "All done for today. Nice work.",
                                symbol: "checkmark.seal.fill", tint: .green)
        }
        let names = open.prefix(3).map(\.task.title).joined(separator: ", ")
        let more = open.count > 3 ? " +\(open.count - 3) more" : ""
        return AlertContent(kind: .nudge, title: "Checklist check — \(open.count) left",
                            body: names + more, symbol: "checklist", tint: .indigo)
    }
}
