import Foundation
import Combine

/// All persistent app data: tasks, reflections and settings, saved as one JSON file.
@MainActor
final class Store: ObservableObject {
    @Published var tasks: [PlanTask] = [] { didSet { stampTasks(oldValue); scheduleSave() } }
    @Published var reflections: [Reflection] = [] { didSet { stampReflections(oldValue); scheduleSave() } }
    @Published var settings = AppSettings() { didSet { stampSettings(oldValue); scheduleSave() } }

    /// Deleted records ("task|<id>" / "reflection|<id>") → when, so deletions sync too.
    private(set) var tombstones: [String: Date] = [:]
    private(set) var settingsUpdatedAt: Date?

    let fileURL: URL
    private var saveItem: DispatchWorkItem?
    private var isLoading = false
    private var applyingRemote = false
    private var stamping = false

    private struct Snapshot: Codable {
        var tasks: [PlanTask]
        var reflections: [Reflection]
        var settings: AppSettings
        var tombstones: [String: Date]?
        var settingsUpdatedAt: Date?
    }

    init(directory: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        fileURL = directory.appendingPathComponent("cadence.json")
        load()
    }

    // MARK: Persistence

    private func load() {
        guard let data = try? Data(contentsOf: fileURL) else { return }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        do {
            let snap = try decoder.decode(Snapshot.self, from: data)
            isLoading = true
            tasks = snap.tasks
            reflections = snap.reflections
            settings = snap.settings
            tombstones = snap.tombstones ?? [:]
            settingsUpdatedAt = snap.settingsUpdatedAt
            isLoading = false
        } catch {
            // Never silently lose data: keep the unreadable file next to the new one.
            let backup = fileURL.deletingPathExtension()
                .appendingPathExtension("unreadable-\(Int(Date().timeIntervalSince1970)).json")
            try? FileManager.default.copyItem(at: fileURL, to: backup)
            NSLog("Cadence: could not read data file (%@); backed up to %@", "\(error)", backup.path)
        }
    }

    private func scheduleSave() {
        guard !isLoading else { return }
        saveItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.saveNow() }
        }
        saveItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: item)
    }

    func saveNow() {
        saveItem?.cancel()
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        do {
            let data = try encoder.encode(Snapshot(tasks: tasks, reflections: reflections, settings: settings,
                                                   tombstones: tombstones, settingsUpdatedAt: settingsUpdatedAt))
            try data.write(to: fileURL, options: .atomic)
        } catch {
            NSLog("Cadence: save failed: %@", "\(error)")
        }
    }

    // MARK: Change tracking (for sync)

    /// Every edit, from any view, passes through these didSet hooks: changed records get a fresh
    /// `updatedAt` and removed ones a tombstone. Remote changes skip this so they keep their stamps.
    private func stampTasks(_ old: [PlanTask]) {
        guard !isLoading, !applyingRemote, !stamping else { return }
        let oldByID = Dictionary(old.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let now = Date()
        var updated = tasks
        var changed = false
        for i in updated.indices {
            if let o = oldByID[updated[i].id] {
                var a = o, b = updated[i]
                a.updatedAt = nil; b.updatedAt = nil
                if a == b { continue }
            }
            updated[i].updatedAt = now
            changed = true
        }
        let ids = Set(tasks.map(\.id))
        for o in old where !ids.contains(o.id) { tombstones["task|\(o.id.uuidString)"] = now }
        if changed { stamping = true; tasks = updated; stamping = false }
    }

    private func stampReflections(_ old: [Reflection]) {
        guard !isLoading, !applyingRemote, !stamping else { return }
        let oldByID = Dictionary(old.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let now = Date()
        var updated = reflections
        var changed = false
        for i in updated.indices {
            if let o = oldByID[updated[i].id] {
                var a = o, b = updated[i]
                a.updatedAt = nil; b.updatedAt = nil
                if a == b { continue }
            }
            updated[i].updatedAt = now
            changed = true
        }
        let ids = Set(reflections.map(\.id))
        for o in old where !ids.contains(o.id) { tombstones["reflection|\(o.id.uuidString)"] = now }
        if changed { stamping = true; reflections = updated; stamping = false }
    }

    private func stampSettings(_ old: AppSettings) {
        guard !isLoading, !applyingRemote else { return }
        if SyncedSettings(old) != SyncedSettings(settings) { settingsUpdatedAt = Date() }
    }

    struct SyncChange {
        var kind: String
        var id: String
        var updatedAt: Date
        var deleted: Bool
        var data: Any?
    }

    private static let syncEncoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    private static let syncDecoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    private static func jsonObject<T: Encodable>(_ value: T) -> Any? {
        guard let data = try? syncEncoder.encode(value) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    /// Everything edited after `since` (or everything, on the first sync).
    func pendingChanges(since: Date?) -> [SyncChange] {
        func newer(_ d: Date) -> Bool { since.map { d > $0 } ?? true }
        var out: [SyncChange] = []
        for t in tasks {
            let stamp = t.updatedAt ?? t.createdAt
            if since == nil || (t.updatedAt.map(newer) ?? false) {
                out.append(SyncChange(kind: "task", id: t.id.uuidString, updatedAt: stamp, deleted: false, data: Self.jsonObject(t)))
            }
        }
        for r in reflections {
            let stamp = r.updatedAt ?? r.createdAt
            if since == nil || (r.updatedAt.map(newer) ?? false) {
                out.append(SyncChange(kind: "reflection", id: r.id.uuidString, updatedAt: stamp, deleted: false, data: Self.jsonObject(r)))
            }
        }
        for (key, when) in tombstones where newer(when) {
            let parts = key.split(separator: "|", maxSplits: 1).map(String.init)
            if parts.count == 2 { out.append(SyncChange(kind: parts[0], id: parts[1], updatedAt: when, deleted: true, data: nil)) }
        }
        if since == nil || (settingsUpdatedAt.map(newer) ?? false) {
            out.append(SyncChange(kind: "settings", id: "main", updatedAt: settingsUpdatedAt ?? Date(timeIntervalSince1970: 0),
                                  deleted: false, data: Self.jsonObject(SyncedSettings(settings))))
        }
        return out
    }

    func hasPendingChanges(since: Date?) -> Bool { !pendingChanges(since: since).isEmpty }

    /// Applies changes from the server (last-writer-wins against our own stamps).
    func applyRemote(_ changes: [SyncChange]) {
        guard !changes.isEmpty else { return }
        applyingRemote = true
        defer { applyingRemote = false }
        var newTasks = tasks
        var newReflections = reflections
        var newSettings = settings
        for c in changes {
            switch c.kind {
            case "task":
                guard let id = UUID(uuidString: c.id) else { continue }
                let i = newTasks.firstIndex { $0.id == id }
                if let i, (newTasks[i].updatedAt ?? newTasks[i].createdAt) > c.updatedAt { continue }
                if c.deleted {
                    if let i { newTasks.remove(at: i) }
                    tombstones["task|\(c.id.uppercased())"] = nil
                    continue
                }
                guard let obj = c.data, let data = try? JSONSerialization.data(withJSONObject: obj),
                      var t = try? Self.syncDecoder.decode(PlanTask.self, from: data) else { continue }
                t.updatedAt = c.updatedAt
                if let i { newTasks[i] = t } else { newTasks.append(t) }
            case "reflection":
                guard let id = UUID(uuidString: c.id) else { continue }
                let i = newReflections.firstIndex { $0.id == id }
                if let i, (newReflections[i].updatedAt ?? newReflections[i].createdAt) > c.updatedAt { continue }
                if c.deleted {
                    if let i { newReflections.remove(at: i) }
                    tombstones["reflection|\(c.id.uppercased())"] = nil
                    continue
                }
                guard let obj = c.data, let data = try? JSONSerialization.data(withJSONObject: obj),
                      var r = try? Self.syncDecoder.decode(Reflection.self, from: data) else { continue }
                r.updatedAt = c.updatedAt
                if let i { newReflections[i] = r } else { newReflections.append(r) }
            case "settings":
                if let mine = settingsUpdatedAt, mine > c.updatedAt { continue }
                guard !c.deleted, let obj = c.data, let data = try? JSONSerialization.data(withJSONObject: obj),
                      let s = try? Self.syncDecoder.decode(SyncedSettings.self, from: data) else { continue }
                s.apply(to: &newSettings)
                settingsUpdatedAt = c.updatedAt
            default:
                continue
            }
        }
        tasks = newTasks
        reflections = newReflections.sorted { $0.createdAt > $1.createdAt }
        settings = newSettings
    }

    // MARK: Queries

    func task(_ id: UUID) -> PlanTask? { tasks.first { $0.id == id } }

    func occurrences(on day: Date) -> [Occurrence] {
        let d = day.startOfDay
        return tasks.filter { $0.occurs(on: d) }
            .map { Occurrence(task: $0, day: d) }
            .sorted(by: Store.order)
    }

    /// One-off tasks from earlier days that were never checked off.
    func overdue(today: Date = Date()) -> [Occurrence] {
        let t = today.startOfDay
        return tasks.filter { $0.archived != true && !$0.isEvent && !$0.recurrence.isRepeating && $0.startDate.startOfDay < t && $0.completions.isEmpty }
            .map { Occurrence(task: $0, day: $0.startDate.startOfDay) }
            .sorted { $0.day < $1.day }
    }

    /// Everything that belongs on today's checklist: overdue items first, then today.
    /// Checklist items (tasks) on a day.
    func checklist(on day: Date) -> [Occurrence] { occurrences(on: day).filter { !$0.isEvent } }
    /// Cadence events on a day (your own + imported).
    func events(on day: Date) -> [Occurrence] { occurrences(on: day).filter(\.isEvent) }

    func todayChecklist() -> [Occurrence] { overdue() + checklist(on: Date()) }

    var remainingToday: Int { todayChecklist().filter { !$0.isDone }.count }

    static func order(_ a: Occurrence, _ b: Occurrence) -> Bool {
        switch (a.task.timeMinutes, b.task.timeMinutes) {
        case let (x?, y?): return x == y ? a.task.title < b.task.title : x < y
        case (nil, _?): return false
        case (_?, nil): return true
        case (nil, nil): return a.task.createdAt < b.task.createdAt
        }
    }

    func reflection(for occ: Occurrence) -> Reflection? {
        reflections.first { $0.taskID == occ.task.id && $0.occurrenceKey == occ.key }
    }

    /// Consecutive days (ending today or yesterday) with at least one reflection.
    var reflectionStreak: Int {
        let days = Set(reflections.map { $0.createdAt.startOfDay })
        var day = Date().startOfDay
        if !days.contains(day) { day = day.adding(days: -1) }
        var streak = 0
        while days.contains(day) { streak += 1; day = day.adding(days: -1) }
        return streak
    }

    // MARK: Mutations

    func upsert(_ task: PlanTask) {
        if let i = tasks.firstIndex(where: { $0.id == task.id }) { tasks[i] = task } else { tasks.append(task) }
    }

    /// Imported items are archived (hidden) so re-importing doesn't resurrect them.
    func delete(taskID: UUID) {
        if let i = tasks.firstIndex(where: { $0.id == taskID }), tasks[i].isImported {
            tasks[i].archived = true
        } else {
            tasks.removeAll { $0.id == taskID }
        }
    }

    /// Creates or refreshes imported tasks for one source within [from, to), and archives ones
    /// that vanished upstream (cancelled meetings). Completions, skips and alert choices are kept.
    @discardableResult
    func applyImport(source: String, items: [PlanTask], from: Date, to: Date, archiveMissing: Bool = true,
                     archiveIDs: Set<UUID> = []) -> (added: Int, updated: Int, removed: Int) {
        var list = tasks
        var added = 0, updated = 0, removed = 0
        let incoming = Set(items.map(\.id))
        for item in items {
            if let i = list.firstIndex(where: { $0.id == item.id }) {
                guard list[i].archived != true else { continue }
                var t = list[i]
                t.title = item.title; t.notes = item.notes; t.startDate = item.startDate
                t.timeMinutes = item.timeMinutes; t.durationMinutes = item.durationMinutes
                t.externalURL = item.externalURL; t.googleEventID = item.googleEventID
                t.sourceCalendar = item.sourceCalendar ?? t.sourceCalendar
                if t != list[i] { list[i] = t; updated += 1 }
            } else {
                list.append(item); added += 1
            }
        }
        for i in list.indices where list[i].source == source && list[i].archived != true && list[i].completions.isEmpty {
            let missing = archiveMissing && !incoming.contains(list[i].id)
                && list[i].startDate >= from.startOfDay && list[i].startDate < to
            if missing || archiveIDs.contains(list[i].id) { list[i].archived = true; removed += 1 }
        }
        if added + updated + removed > 0 { tasks = list }
        return (added, updated, removed)
    }

    /// Checking something off always goes through here, and always records a reflection.
    func complete(_ occ: Occurrence, reflection text: String) {
        guard countWords(text) >= settings.minReflectionWords,
              let i = tasks.firstIndex(where: { $0.id == occ.task.id }) else { return }
        tasks[i].completions[occ.key] = Date()
        reflections.insert(Reflection(taskID: occ.task.id, taskTitle: occ.task.title,
                                      occurrenceKey: occ.key, text: text), at: 0)
    }

    /// Unchecking keeps the reflection: it is part of the record.
    func uncomplete(_ occ: Occurrence) {
        guard let i = tasks.firstIndex(where: { $0.id == occ.task.id }) else { return }
        tasks[i].completions[occ.key] = nil
    }

    func skip(_ occ: Occurrence) {
        guard let i = tasks.firstIndex(where: { $0.id == occ.task.id }) else { return }
        tasks[i].skipped.insert(occ.key)
    }

    func deleteReflection(_ id: UUID) { reflections.removeAll { $0.id == id } }
}
