#if DEBUG
import AppKit

/// Launch-argument hooks for headless verification (GUI scripting is unavailable on this Mac):
///   -dataDir <path>   use a separate data folder
///   -demo             seed sample tasks/reflections into an empty store
///   -screen <name>    open a sidebar screen (today|week|month|todo|reflections|booking|settings)
///   -checkin          show the check-in window
///   -banner           show a sample on-screen banner
///   -reflect          open the reflection sheet for the first open item today
///   -edit             open the task editor for the first recurring task
///   -tick             run the reminder engine once with a fake "nudge due" state
/// The app writes "<title> <windowNumber>" lines to <dataDir>/windows.txt for `screencapture -l`.
@MainActor
enum DebugDriver {
    static func prepare(_ model: AppModel) {
        if LaunchOptions.has("-demo") && model.store.tasks.isEmpty { seed(model.store) }
        if let s = LaunchOptions.value("-screen"), let screen = Screen(rawValue: s) { model.screen = screen }
    }

    static func run(_ model: AppModel) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            if LaunchOptions.has("-checkin") { model.windows.showCheckIn(reason: "Welcome back — check your list") }
            if LaunchOptions.has("-banner") {
                let occ = model.store.todayChecklist().first { !$0.isDone }
                Notifier.shared.deliver(AlertContent(kind: .task, title: occ?.task.title ?? "Stretch break",
                                                     body: "Starting now. Check it off with a reflection when you're done.",
                                                     symbol: "checkmark.circle", tint: occ?.task.color.color ?? .blue,
                                                     occurrence: occ), channels: [.banner])
                Notifier.shared.deliver(AlertContent(kind: .nudge, title: "Checklist check — 3 left",
                                                     body: "Morning run, Read 20 pages, Weekly review",
                                                     symbol: "checklist", tint: .indigo), channels: [.banner])
            }
            if LaunchOptions.has("-reflect"), let occ = model.store.todayChecklist().first(where: { !$0.isDone }) {
                model.beginReflection(occ)
            }
            if LaunchOptions.has("-overlap"),
               let occ = model.store.occurrences(on: Date()).first(where: { $0.task.title == "Deep work block" }),
               let st = occ.start, let en = occ.end {
                model.newTask(at: st.addingTimeInterval(en.timeIntervalSince(st) / 2))
            }
            if LaunchOptions.has("-midtask") {
                // A long task running now, plus a short one starting ~30s from now inside it.
                let now = Date()
                var long = PlanTask(title: "Long focus session", startDate: now.startOfDay,
                                    timeMinutes: now.minutesSinceMidnight - 30, durationMinutes: 120,
                                    channels: [.banner], color: .teal)
                long.reminderOffsets = [0]
                let inMin = now.minutesSinceMidnight + (Calendar.current.component(.second, from: now) > 30 ? 2 : 1)
                var short = PlanTask(title: "Stretch break (mid-task)", startDate: now.startOfDay,
                                     timeMinutes: inMin, durationMinutes: 5, channels: [.banner], color: .orange)
                short.reminderOffsets = [0]
                model.store.upsert(long)
                model.store.upsert(short)
            }
            if LaunchOptions.has("-edit"), let t = model.store.tasks.first(where: \.recurrence.isRepeating) {
                model.edit(t)
            }
        }
        runSyncTest(model)
        let delay = Double(LaunchOptions.value("-listAfter") ?? "") ?? 3.5
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { writeWindowList(model) }
    }

    /// -syncTest <server> <account.json>: sign in, sync, add a Mac task, sync again, report, sign out.
    static func runSyncTest(_ model: AppModel) {
        guard let i = LaunchOptions.args.firstIndex(of: "-syncTest"), i + 2 < LaunchOptions.args.count else { return }
        let server = LaunchOptions.args[i + 1]
        let accountFile = LaunchOptions.args[i + 2]
        let out = LaunchOptions.dataDirectory.appendingPathComponent("sync-result.txt")
        Task { @MainActor in
            var log: [String] = []
            guard let data = FileManager.default.contents(atPath: accountFile),
                  let acct = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { return }
            let sync = model.sync
            sync.serverURL = server
            await sync.signIn(username: acct["username"] ?? "", password: acct["password"] ?? "", create: false)
            log.append("signedIn=\(sync.isSignedIn) status=\(sync.status)")
            @MainActor func waitIdle() async {
                for _ in 0..<60 {
                    try? await Task.sleep(nanoseconds: 250_000_000)
                    if sync.status != .syncing { break }
                }
            }
            try? await Task.sleep(nanoseconds: 500_000_000)
            await waitIdle()
            log.append("afterPull tasks=\(model.store.tasks.count) reflections=\(model.store.reflections.count)")
            log.append("titles=" + model.store.tasks.map(\.title).sorted().joined(separator: ","))
            log.append("readDone=\(model.store.tasks.first { $0.title == "Read 20 pages" }?.completions.keys.sorted() ?? [])")
            log.append("reflection=\(model.store.reflections.first?.text.prefix(40) ?? "none")")
            log.append("minWords=\(model.store.settings.minReflectionWords)")
            model.store.upsert(PlanTask(title: "Created on the Mac", startDate: Date().startOfDay, timeMinutes: 20 * 60))
            sync.sync()
            try? await Task.sleep(nanoseconds: 500_000_000)
            await waitIdle()
            log.append("afterPush status=\(sync.status)")
            sync.signOut()
            log.append("signedOut")
            try? log.joined(separator: "\n").write(to: out, atomically: true, encoding: .utf8)
        }
    }

    static func writeWindowList(_ model: AppModel) {
        let lines = NSApp.windows.filter(\.isVisible).map { w -> String in
            let kind = w === model.windows.mainWindow ? "main"
                : w === model.windows.checkInWindow ? "checkin"
                : w.isSheet ? "sheet"
                : w is NSPanel ? "panel" : "other"
            return "\(kind) \(w.windowNumber) \(Int(w.frame.width))x\(Int(w.frame.height))"
        }
        let url = LaunchOptions.dataDirectory.appendingPathComponent("windows.txt")
        try? lines.joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    private static func seed(_ store: Store) {
        let today = Date().startOfDay
        func t(_ title: String, _ day: Int, _ time: Int?, dur: Int = 30, _ color: TaskColor,
               freq: Frequency = .none, weekdays: [Int] = [], notes: String = "") -> PlanTask {
            var task = PlanTask(title: title, notes: notes, startDate: today.adding(days: day), timeMinutes: time,
                                durationMinutes: dur, color: color)
            task.recurrence = Recurrence(frequency: freq, weekdays: weekdays)
            task.reminderOffsets = time == nil ? [0] : [0, 10]
            return task
        }
        var tasks = [
            t("Morning run", -20, 7 * 60, dur: 45, .green, freq: .weekly, weekdays: [2, 4, 6]),
            t("Read 20 pages", -30, nil, .purple, freq: .daily),
            t("Stand-up meeting", -14, 10 * 60, dur: 15, .blue, freq: .weekly, weekdays: [2, 3, 4, 5, 6]),
            t("Deep work block", -14, 13 * 60, dur: 120, .teal, freq: .weekly, weekdays: [2, 3, 4, 5, 6]),
            t("Weekly review", -9, 16 * 60 + 30, dur: 45, .orange, freq: .weekly, weekdays: [6]),
            t("Pay rent", -29, nil, .red, freq: .monthly),
            t("Call grandma", 0, 19 * 60, .pink),
            t("Submit expense report", -2, nil, .yellow),
            t("Dentist appointment", 3, 15 * 60, dur: 60, .gray),
            t("Plan next sprint", 1, 14 * 60, dur: 60, .blue),
            t("Water plants", -3, nil, .green, freq: .daily, notes: "Every 3 days"),
        ]
        tasks[10].recurrence.interval = 3
        // Some history so the calendars and reflections have content.
        var reflections: [Reflection] = []
        let samples = [
            "Got out the door before checking my phone, which made a big difference. Legs felt heavy for the first mile but loosened up. Next time I want to sleep earlier.",
            "Read about habit stacking and it clicked: attaching reading to my evening tea makes it automatic. Twenty pages went by quickly tonight and I want to keep going.",
            "Stand-up ran long because we debated the release plan. I should bring a written summary next time so we can decide faster and keep it to fifteen minutes.",
        ]
        for (i, idx) in [0, 1, 2].enumerated() {
            for back in 1...3 {
                let day = today.adding(days: -back)
                if tasks[idx].occurs(on: day) {
                    tasks[idx].completions[DateKey.string(day)] = day.adding(minutes: 20 * 60)
                    reflections.append(Reflection(taskID: tasks[idx].id, taskTitle: tasks[idx].title,
                                                  occurrenceKey: DateKey.string(day), text: samples[i],
                                                  createdAt: day.adding(minutes: 20 * 60 + back * 7)))
                }
            }
        }
        store.tasks = tasks
        store.reflections = reflections.sorted { $0.createdAt > $1.createdAt }
    }
}
#endif
