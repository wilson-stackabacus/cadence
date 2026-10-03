import AppKit
import Foundation

/// Calendly via a Personal Access Token (Calendly › Integrations › API & Webhooks).
/// Reads your booked meetings (imported as silent checklist items) and your event-type
/// booking links (shown on the Booking page so you can share a public link).
@MainActor
final class CalendlyService: ObservableObject {
    struct EventType: Identifiable, Hashable {
        let id: String
        let name: String
        let minutes: Int
        let url: URL
        let color: String?
        let active: Bool
    }

    struct Meeting {
        let uri: String
        let name: String
        let start: Date
        let end: Date
        let joinURL: String?
        let location: String?
        let invitees: [String]
    }

    @Published private(set) var isConnected = false
    @Published private(set) var userName: String?
    @Published private(set) var schedulingURL: URL?
    @Published private(set) var eventTypes: [EventType] = []
    @Published var lastError: String?
    @Published private(set) var isWorking = false

    private var userURI: String?
    private static let tokenAccount = "calendly-token"

    init() {
        if Keychain.string(account: Self.tokenAccount) != nil { isConnected = true }
    }

    func restore() {
        guard isConnected else { return }
        Task { await loadProfile() }
    }

    func connect(token: String) async {
        let t = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        Keychain.setString(t, account: Self.tokenAccount)
        isConnected = true
        await loadProfile()
        if lastError != nil { disconnect(keepError: true) }
    }

    func disconnect(keepError: Bool = false) {
        Keychain.setString(nil, account: Self.tokenAccount)
        isConnected = false
        userName = nil; userURI = nil; schedulingURL = nil; eventTypes = []
        if !keepError { lastError = nil }
    }

    func loadProfile() async {
        isWorking = true
        defer { isWorking = false }
        do {
            let me = try await get("https://api.calendly.com/users/me")
            guard let res = me["resource"] as? [String: Any], let uri = res["uri"] as? String else { throw err("Unexpected response from Calendly.") }
            userURI = uri
            userName = res["name"] as? String
            schedulingURL = (res["scheduling_url"] as? String).flatMap(URL.init(string:))
            lastError = nil
            var types: [EventType] = []
            var next: String? = "https://api.calendly.com/event_types?user=\(enc(uri))&count=100"
            while let url = next {
                let page = try await get(url)
                for t in page["collection"] as? [[String: Any]] ?? [] {
                    guard let id = t["uri"] as? String, let u = (t["scheduling_url"] as? String).flatMap(URL.init(string:)) else { continue }
                    types.append(EventType(id: id, name: t["name"] as? String ?? "Event", minutes: t["duration"] as? Int ?? 30,
                                           url: u, color: t["color"] as? String, active: t["active"] as? Bool ?? true))
                }
                next = (page["pagination"] as? [String: Any])?["next_page"] as? String
            }
            eventTypes = types.filter(\.active)
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Active (not cancelled) meetings between two dates, with invitee names.
    func meetings(from: Date, to: Date) async throws -> [Meeting] {
        if userURI == nil { await loadProfile() }
        guard let uri = userURI else { throw err(lastError ?? "Calendly is not connected.") }
        let iso = ISO8601DateFormatter()
        var out: [Meeting] = []
        var next: String? = "https://api.calendly.com/scheduled_events?user=\(enc(uri))&status=active&count=100&sort=start_time:asc"
            + "&min_start_time=\(enc(iso.string(from: from)))&max_start_time=\(enc(iso.string(from: to)))"
        let frac = ISO8601DateFormatter()
        frac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        func date(_ s: Any?) -> Date? { (s as? String).flatMap { frac.date(from: $0) ?? iso.date(from: $0) } }
        while let url = next, out.count < 200 {
            let page = try await get(url)
            for e in page["collection"] as? [[String: Any]] ?? [] {
                guard let euri = e["uri"] as? String, let s = date(e["start_time"]), let en = date(e["end_time"]) else { continue }
                let loc = e["location"] as? [String: Any]
                var invitees: [String] = []
                if let inv = try? await get("\(euri)/invitees?count=10") {
                    invitees = (inv["collection"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }
                }
                out.append(Meeting(uri: euri, name: e["name"] as? String ?? "Calendly meeting", start: s, end: en,
                                   joinURL: loc?["join_url"] as? String, location: loc?["location"] as? String, invitees: invitees))
            }
            next = (page["pagination"] as? [String: Any])?["next_page"] as? String
        }
        return out
    }

    // MARK: HTTP

    private func get(_ url: String) async throws -> [String: Any] {
        guard let token = Keychain.string(account: Self.tokenAccount), let u = URL(string: url) else { throw err("Calendly is not connected.") }
        var req = URLRequest(url: u, timeoutInterval: 30)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if code == 401 { throw err("Calendly rejected the token. Create a new Personal Access Token and connect again.") }
        guard (200..<300).contains(code) else { throw err((json["message"] as? String) ?? "Calendly returned \(code).") }
        return json
    }

    private func enc(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    private func err(_ m: String) -> Error { NSError(domain: "Calendly", code: 0, userInfo: [NSLocalizedDescriptionKey: m]) }
}

/// Turns Google Calendar events and Calendly meetings into silent checklist tasks.
/// IDs come from stableUUID("google:<event id>") / stableUUID("calendly:<uri>"), matching the web app.
@MainActor
final class CalendarImporter: ObservableObject {
    @Published private(set) var isImporting = false
    @Published private(set) var lastImport: Date?
    @Published private(set) var lastSummary: String?

    private unowned let model: AppModel
    private var timer: Timer?
    private var lastCalendly = Date.distantPast
    private var observers: [NSObjectProtocol] = []

    init(model: AppModel) { self.model = model }

    /// Google is re-checked every 2 minutes (and on wake / when Cadence comes to the front) so edits
    /// in Google Calendar show up almost immediately; Calendly every 30 minutes.
    func start() {
        let t = Timer(timeInterval: 120, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.autoImport() }
        }
        t.tolerance = 15
        RunLoop.main.add(t, forMode: .common)
        timer = t
        let nc = NSWorkspace.shared.notificationCenter
        observers.append(nc.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.autoImport() }
        })
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.autoImport() }
        })
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.autoImport() }
    }

    func autoImport() {
        if !model.google.isConnected && model.sync.isSignedIn {
            Task { await model.google.checkServer(); self.autoImportNow() }
            return
        }
        autoImportNow()
    }

    private func autoImportNow() {
        guard model.store.settings.autoImportCalendars, !isImporting,
              model.google.isConnected || model.calendly.isConnected else { return }
        Task { await importNow(includeCalendly: Date().timeIntervalSince(lastCalendly) > 30 * 60) }
    }

    func importNow(includeCalendly: Bool = true) async {
        guard !isImporting else { return }
        isImporting = true
        defer { isImporting = false }
        let store = model.store
        let from = Date().startOfDay
        let to = from.adding(days: max(1, store.settings.importDaysAhead))
        var parts: [String] = []

        if model.google.isConnected {
            model.google.refreshLoadedMonths()
            do {
                let google = model.google
                let (events, cancelled) = try await google.fetchEvents(from: from, to: to)
                var items = events.map(Self.task(from:))
                var archive = Set(cancelled.map { stableUUID("google:\($0)") })
                // Events we imported earlier that no longer appear in the window: moved or deleted. Ask Google.
                let seen = Set(items.map(\.id)).union(archive)
                let stale = store.tasks.filter { $0.source == "google" && $0.archived != true && $0.completions.isEmpty
                    && !seen.contains($0.id) && $0.startDate >= from && $0.startDate < to && $0.googleEventID != nil }
                for t in stale.prefix(25) {
                    if let ev = try? await google.fetchEvent(calendarID: t.sourceCalendar ?? "primary", eventID: t.googleEventID!) {
                        items.append(Self.task(from: ev))
                    } else {
                        archive.insert(t.id)
                    }
                }
                let r = store.applyImport(source: "google", items: items, from: from, to: to, archiveMissing: false, archiveIDs: archive)
                parts.append("Google: \(r.added) new, \(r.updated) updated, \(r.removed) removed")
            } catch {
                parts.append("Google failed: \(error.localizedDescription)")
            }
        }
        if model.calendly.isConnected && includeCalendly {
            lastCalendly = Date()
            do {
                let meetings = try await model.calendly.meetings(from: from, to: to)
                let items = meetings.map { m -> PlanTask in
                    let who = m.invitees.isEmpty ? "" : " with " + m.invitees.joined(separator: ", ")
                    var t = PlanTask(id: stableUUID("calendly:\(m.uri)"), title: m.name + who, notes: m.location ?? "",
                                     startDate: m.start.startOfDay, timeMinutes: m.start.minutesSinceMidnight,
                                     durationMinutes: max(5, Int(m.end.timeIntervalSince(m.start) / 60)),
                                     reminderOffsets: [0], channels: [], color: .purple)
                    t.source = "calendly"; t.externalURL = m.joinURL
                    return t
                }
                let r = store.applyImport(source: "calendly", items: items, from: from, to: to)
                parts.append("Calendly: \(r.added) new, \(r.updated) updated, \(r.removed) removed")
            } catch {
                parts.append("Calendly failed: \(error.localizedDescription)")
            }
        }
        lastImport = Date()
        if !parts.isEmpty { lastSummary = parts.joined(separator: " · ") + " — " + timeString(Date()) }
    }

    /// A Google event as a silent checklist task. Must match the web app field-for-field.
    static func task(from ev: GoogleEvent) -> PlanTask {
        let raw = ev.id.split(separator: "|", maxSplits: 1).last.map(String.init) ?? ev.id
        var t = PlanTask(id: stableUUID("google:\(raw)"), title: ev.title, notes: eventNotes(ev.details, ev.location),
                         startDate: ev.start.startOfDay,
                         timeMinutes: ev.isAllDay ? nil : ev.start.minutesSinceMidnight,
                         durationMinutes: ev.isAllDay ? 30 : max(5, Int(ev.end.timeIntervalSince(ev.start) / 60)),
                         reminderOffsets: [0], channels: [], color: .blue)
        t.source = "google"; t.googleEventID = raw; t.externalURL = ev.link?.absoluteString
        t.sourceCalendar = ev.calendarID
        t.busy = !ev.transparent
        return t
    }
}
