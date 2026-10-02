import AppKit
import SwiftUI

struct GCalendar: Identifiable, Hashable {
    let id: String
    let summary: String
    let primary: Bool
    let colorHex: String?
    let canWrite: Bool
}

struct GoogleEvent: Identifiable, Hashable {
    let id: String
    let calendarID: String
    let title: String
    let start: Date
    let end: Date
    let isAllDay: Bool
    let location: String?
    let link: URL?
    let colorHex: String?

    var color: Color { colorHex.flatMap(Color.init(hex:)) ?? .blue }
}

struct NewGoogleEvent {
    var title: String
    var details: String = ""
    var start: Date
    var end: Date
    var allDay = false
    var attendees: [(email: String, name: String)] = []
    var addMeetLink = false
    var rrule: String?
    var calendarID = "primary"
}

/// Google Calendar REST client: OAuth, event cache, free/busy and event creation.
@MainActor
final class GoogleCalendar: ObservableObject {
    @Published private(set) var isConnected = false
    @Published private(set) var calendars: [GCalendar] = []
    @Published private(set) var events: [String: GoogleEvent] = [:]
    @Published private(set) var isSigningIn = false
    @Published var lastError: String?
    /// True when this Mac uses the website's Google connection (through your Cadence account)
    /// instead of its own Google sign-in.
    @Published private(set) var viaServer = false
    @Published private(set) var serverEmail: String?
    /// Set by AppModel: an authenticated request to the Cadence API.
    var serverCall: ((String, String, [URLQueryItem], Any?) async throws -> Any)?

    var account: String? { serverEmail ?? calendars.first(where: \.primary)?.id }

    private unowned let store: Store
    private var tokens: GoogleTokens?
    private var loadedMonths: Set<String> = []
    private var loadingMonths: Set<String> = []
    private var server: LoopbackServer?

    private static let scopes = [
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.events",
    ].joined(separator: " ")

    init(store: Store) { self.store = store }

    private var selectedCalendarIDs: [String] {
        store.settings.googleCalendarIDs.isEmpty ? ["primary"] : store.settings.googleCalendarIDs
    }

    // MARK: Connection

    func restore() {
        guard let t = Keychain.load() else {
            Task { await checkServer() }
            return
        }
        tokens = t
        isConnected = true
        Task { await afterConnect() }
    }

    /// Uses the website's Google connection if this Mac has none of its own.
    func checkServer() async {
        guard tokens == nil, let call = serverCall else { return }
        do {
            let st = try await call("GET", "/api/google/status", [], nil) as? [String: Any] ?? [:]
            if st["connected"] as? Bool == true {
                let wasConnected = viaServer
                viaServer = true
                isConnected = true
                serverEmail = st["email"] as? String
                lastError = nil
                if !wasConnected { await afterConnect() }
            } else if viaServer {
                resetServerMode()
            }
        } catch {
            // Not signed in to sync, or offline: leave things as they are.
        }
    }

    /// Called when the Mac signs out of sync.
    func resetServerMode() {
        guard viaServer else { return }
        viaServer = false
        serverEmail = nil
        isConnected = false
        calendars = []
        events = [:]
        loadedMonths = []
    }

    private func server(_ method: String, _ path: String, _ query: [URLQueryItem] = [], _ body: Any? = nil) async throws -> Any {
        guard let call = serverCall else { throw GoogleError.notConnected }
        do { return try await call(method, path, query, body) }
        catch { throw GoogleError.oauth(error.localizedDescription) }
    }

    /// Events from the Cadence API (same shape the web app uses).
    static func parseServerEvent(_ d: [String: Any]) -> GoogleEvent? {
        guard let id = d["id"] as? String, let s = d["start"] as? String, let e = d["end"] as? String else { return nil }
        let allDay = d["isAllDay"] as? Bool ?? false
        guard let start = allDay ? DateKey.date(s) : parseISO(s), let end = allDay ? DateKey.date(e) : parseISO(e) else { return nil }
        return GoogleEvent(id: id, calendarID: d["calendarID"] as? String ?? "primary", title: d["title"] as? String ?? "(No title)",
                           start: start, end: max(end, start.addingTimeInterval(60)), isAllDay: allDay,
                           location: d["location"] as? String, link: (d["link"] as? String).flatMap(URL.init(string:)),
                           colorHex: d["colorHex"] as? String)
    }

    private var calendarsParam: URLQueryItem {
        URLQueryItem(name: "calendars", value: store.settings.googleCalendarIDs.joined(separator: ","))
    }

    func connect() async {
        let s = store.settings
        guard !s.googleClientID.trimmingCharacters(in: .whitespaces).isEmpty else {
            lastError = GoogleError.missingClient.localizedDescription
            return
        }
        isSigningIn = true
        lastError = nil
        defer { isSigningIn = false; server = nil }
        do {
            let server = try LoopbackServer()
            self.server = server
            let port = try await server.start()
            let redirect = "http://127.0.0.1:\(port)"
            let verifier = PKCE.verifier()
            let state = UUID().uuidString

            var c = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
            c.queryItems = [
                URLQueryItem(name: "client_id", value: s.googleClientID.trimmingCharacters(in: .whitespaces)),
                URLQueryItem(name: "redirect_uri", value: redirect),
                URLQueryItem(name: "response_type", value: "code"),
                URLQueryItem(name: "scope", value: Self.scopes),
                URLQueryItem(name: "code_challenge", value: PKCE.challenge(for: verifier)),
                URLQueryItem(name: "code_challenge_method", value: "S256"),
                URLQueryItem(name: "state", value: state),
                URLQueryItem(name: "access_type", value: "offline"),
                URLQueryItem(name: "prompt", value: "consent"),
            ]
            NSWorkspace.shared.open(c.url!)

            let params = try await server.waitForCallback()
            server.stop()
            NSApp.activate(ignoringOtherApps: true)
            if let err = params["error"] { throw GoogleError.oauth(err) }
            guard params["state"] == state else { throw GoogleError.stateMismatch }
            guard let code = params["code"] else { throw GoogleError.badResponse }

            let json = try await postForm("https://oauth2.googleapis.com/token", [
                "client_id": s.googleClientID.trimmingCharacters(in: .whitespaces),
                "client_secret": s.googleClientSecret.trimmingCharacters(in: .whitespaces),
                "code": code,
                "code_verifier": verifier,
                "grant_type": "authorization_code",
                "redirect_uri": redirect,
            ])
            guard let access = json["access_token"] as? String,
                  let refresh = json["refresh_token"] as? String else { throw GoogleError.badResponse }
            let expires = (json["expires_in"] as? Double) ?? 3600
            let t = GoogleTokens(accessToken: access, refreshToken: refresh, expiry: Date().addingTimeInterval(expires))
            tokens = t
            Keychain.save(t)
            isConnected = true
            await afterConnect()
        } catch {
            lastError = error.localizedDescription
        }
    }

    func cancelSignIn() { server?.stop() }

    func disconnect() {
        if viaServer {
            // Disconnects Google for the whole account (web and every device).
            Task { _ = try? await server("POST", "/api/google/disconnect", [], [String: Any]()) }
            resetServerMode()
            return
        }
        if let t = tokens {
            // Best-effort revoke so the grant disappears from the Google account too.
            var req = URLRequest(url: URL(string: "https://oauth2.googleapis.com/revoke")!)
            req.httpMethod = "POST"
            req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            req.httpBody = Data("token=\(Self.formEncode(t.refreshToken))".utf8)
            URLSession.shared.dataTask(with: req).resume()
        }
        Keychain.delete()
        tokens = nil
        isConnected = false
        calendars = []
        events = [:]
        loadedMonths = []
    }

    private func afterConnect() async {
        await loadCalendars()
        reloadEvents()
    }

    // MARK: Calendars & events

    func loadCalendars() async {
        if viaServer {
            do {
                let list = try await server("GET", "/api/google/calendars") as? [[String: Any]] ?? []
                calendars = list.compactMap { d in
                    guard let id = d["id"] as? String else { return nil }
                    return GCalendar(id: id, summary: d["summary"] as? String ?? id, primary: d["primary"] as? Bool ?? false,
                                     colorHex: d["colorHex"] as? String, canWrite: d["canWrite"] as? Bool ?? false)
                }
                .sorted { ($0.primary ? 0 : 1, $0.summary) < ($1.primary ? 0 : 1, $1.summary) }
            } catch {
                lastError = error.localizedDescription
            }
            return
        }
        do {
            let json = try await api("GET", "/users/me/calendarList")
            let items = json["items"] as? [[String: Any]] ?? []
            calendars = items.compactMap { item in
                guard let id = item["id"] as? String else { return nil }
                let role = item["accessRole"] as? String ?? "reader"
                return GCalendar(id: id,
                                 summary: (item["summaryOverride"] as? String) ?? (item["summary"] as? String) ?? id,
                                 primary: item["primary"] as? Bool ?? false,
                                 colorHex: item["backgroundColor"] as? String,
                                 canWrite: role == "owner" || role == "writer")
            }
            .sorted { ($0.primary ? 0 : 1, $0.summary) < ($1.primary ? 0 : 1, $1.summary) }
        } catch {
            lastError = error.localizedDescription
        }
    }

    func reloadEvents() {
        loadedMonths = []
        events = [:]
        let today = Date().startOfDay
        ensure(from: today.adding(days: -40), to: today.adding(days: 75))
    }

    /// Makes sure events for every month touching [from, to) are loaded.
    func ensure(from: Date, to: Date) {
        guard isConnected else { return }
        var month = from.startOfMonth
        while month < to {
            let key = DateKey.string(month)
            if !loadedMonths.contains(key) && !loadingMonths.contains(key) {
                loadingMonths.insert(key)
                let start = month
                Task { await loadMonth(start, key: key) }
            }
            month = month.adding(months: 1)
        }
    }

    private func loadMonth(_ month: Date, key: String) async {
        defer { loadingMonths.remove(key) }
        let end = month.adding(months: 1)
        let colorFor = Dictionary(calendars.map { ($0.id, $0.colorHex) }, uniquingKeysWith: { a, _ in a })
        var fresh: [String: GoogleEvent] = [:]
        do {
            if viaServer {
                let list = try await server("GET", "/api/google/events", [
                    URLQueryItem(name: "from", value: Self.iso.string(from: month)),
                    URLQueryItem(name: "to", value: Self.iso.string(from: end)), calendarsParam,
                ]) as? [[String: Any]] ?? []
                for d in list { if let ev = Self.parseServerEvent(d) { fresh[ev.id] = ev } }
            } else {
            for calID in selectedCalendarIDs {
                var pageToken: String?
                repeat {
                    var q = [
                        URLQueryItem(name: "timeMin", value: Self.iso.string(from: month)),
                        URLQueryItem(name: "timeMax", value: Self.iso.string(from: end)),
                        URLQueryItem(name: "singleEvents", value: "true"),
                        URLQueryItem(name: "orderBy", value: "startTime"),
                        URLQueryItem(name: "maxResults", value: "2500"),
                    ]
                    if let pageToken { q.append(URLQueryItem(name: "pageToken", value: pageToken)) }
                    let json = try await api("GET", "/calendars/\(Self.encode(calID))/events", query: q)
                    let color = colorFor[calID] ?? (calID == "primary" ? calendars.first(where: \.primary)?.colorHex : nil)
                    for item in json["items"] as? [[String: Any]] ?? [] {
                        if let ev = Self.parseEvent(item, calendarID: calID, colorHex: color) { fresh[ev.id] = ev }
                    }
                    pageToken = json["nextPageToken"] as? String
                } while pageToken != nil
            }
            }
            // Swap this month's events in one go: picks up edits and deletions without flicker.
            var merged = events.filter { !($0.value.start >= month && $0.value.start < end) }
            merged.merge(fresh) { _, new in new }
            events = merged
            loadedMonths.insert(key)
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Re-fetches every month already on screen (called on the import cycle).
    func refreshLoadedMonths() {
        guard isConnected else { return }
        for key in loadedMonths where !loadingMonths.contains(key) {
            guard let month = DateKey.date(key) else { continue }
            loadingMonths.insert(key)
            Task { await loadMonth(month, key: key) }
        }
    }

    /// Fetches events in a range straight from Google (used by the importer), plus the raw IDs of
    /// events deleted/cancelled there (Google returns them as tombstones with showDeleted=true).
    func fetchEvents(from: Date, to: Date) async throws -> (events: [GoogleEvent], cancelled: [String]) {
        if viaServer {
            let r = try await server("GET", "/api/google/import-window", [
                URLQueryItem(name: "from", value: Self.iso.string(from: from)),
                URLQueryItem(name: "to", value: Self.iso.string(from: to)), calendarsParam,
            ]) as? [String: Any] ?? [:]
            let evs = (r["events"] as? [[String: Any]] ?? []).compactMap(Self.parseServerEvent)
            return (evs, r["cancelled"] as? [String] ?? [])
        }
        let colorFor = Dictionary(calendars.map { ($0.id, $0.colorHex) }, uniquingKeysWith: { a, _ in a })
        var out: [GoogleEvent] = []
        var cancelled: [String] = []
        for calID in selectedCalendarIDs {
            var pageToken: String?
            repeat {
                var q = [
                    URLQueryItem(name: "timeMin", value: Self.iso.string(from: from)),
                    URLQueryItem(name: "timeMax", value: Self.iso.string(from: to)),
                    URLQueryItem(name: "singleEvents", value: "true"),
                    URLQueryItem(name: "orderBy", value: "startTime"),
                    URLQueryItem(name: "maxResults", value: "2500"),
                    URLQueryItem(name: "showDeleted", value: "true"),
                ]
                if let pageToken { q.append(URLQueryItem(name: "pageToken", value: pageToken)) }
                let json = try await api("GET", "/calendars/\(Self.encode(calID))/events", query: q)
                for item in json["items"] as? [[String: Any]] ?? [] {
                    if (item["status"] as? String) == "cancelled", let id = item["id"] as? String { cancelled.append(id); continue }
                    if let ev = Self.parseEvent(item, calendarID: calID, colorHex: colorFor[calID] ?? nil) { out.append(ev) }
                }
                pageToken = json["nextPageToken"] as? String
            } while pageToken != nil
        }
        return (out, cancelled)
    }

    /// One event by ID; nil if it was deleted or cancelled.
    func fetchEvent(calendarID: String, eventID: String) async throws -> GoogleEvent? {
        if viaServer {
            let r = try await server("GET", "/api/google/event", [URLQueryItem(name: "calendar", value: calendarID),
                                                                   URLQueryItem(name: "id", value: eventID)]) as? [String: Any] ?? [:]
            return (r["event"] as? [String: Any]).flatMap(Self.parseServerEvent)
        }
        do {
            let json = try await api("GET", "/calendars/\(Self.encode(calendarID))/events/\(Self.encode(eventID))")
            return Self.parseEvent(json, calendarID: calendarID, colorHex: nil)
        } catch GoogleError.http(let code, _) where code == 404 || code == 410 {
            return nil
        }
    }

    func events(on day: Date) -> [GoogleEvent] {
        guard isConnected && store.settings.showGoogleEvents else { return [] }
        let start = day.startOfDay
        let end = start.adding(days: 1)
        // Google events already imported into Cadence (or hidden there) show once, as the Cadence item.
        let imported = Set(store.tasks.filter { $0.source == "google" }.compactMap(\.googleEventID))
        return events.values.filter { $0.start < end && $0.end > start }
            .filter { !imported.contains($0.id.split(separator: "|", maxSplits: 1).last.map(String.init) ?? $0.id) }
            .sorted { ($0.isAllDay ? 0 : 1, $0.start, $0.title) < ($1.isAllDay ? 0 : 1, $1.start, $1.title) }
    }

    /// Busy intervals across the selected calendars (Google free/busy API).
    func busyIntervals(from: Date, to: Date) async throws -> [DateInterval] {
        if viaServer {
            let list = try await server("POST", "/api/google/freebusy", [], [
                "from": Self.iso.string(from: from), "to": Self.iso.string(from: to), "calendars": store.settings.googleCalendarIDs,
            ]) as? [[String: Any]] ?? []
            return list.compactMap { b in
                guard let s = (b["start"] as? String).flatMap(Self.parseISO), let e = (b["end"] as? String).flatMap(Self.parseISO), e > s else { return nil }
                return DateInterval(start: s, end: e)
            }
        }
        let body: [String: Any] = [
            "timeMin": Self.iso.string(from: from),
            "timeMax": Self.iso.string(from: to),
            "items": selectedCalendarIDs.map { ["id": $0] },
        ]
        let json = try await api("POST", "/freeBusy", body: body)
        var result: [DateInterval] = []
        for (_, value) in json["calendars"] as? [String: Any] ?? [:] {
            for b in (value as? [String: Any])?["busy"] as? [[String: String]] ?? [] {
                if let s = b["start"].flatMap(Self.parseISO), let e = b["end"].flatMap(Self.parseISO), e > s {
                    result.append(DateInterval(start: s, end: e))
                }
            }
        }
        return result
    }

    /// Creates an event. With attendees, Google emails them an invitation.
    @discardableResult
    func create(_ e: NewGoogleEvent) async throws -> GoogleEvent? {
        let tz = TimeZone.current.identifier
        if viaServer {
            var body: [String: Any] = [
                "title": e.title, "details": e.details, "allDay": e.allDay,
                "start": Self.iso.string(from: e.start), "end": Self.iso.string(from: e.end),
                "startDate": DateKey.string(e.start), "endDate": DateKey.string(e.start.adding(days: 1)),
                "attendees": e.attendees.map { ["email": $0.email, "name": $0.name] },
                "addMeetLink": e.addMeetLink, "timeZone": tz, "calendarID": e.calendarID,
            ]
            if let r = e.rrule { body["rrule"] = r }
            let r = try await server("POST", "/api/google/events", [], body) as? [String: Any] ?? [:]
            loadedMonths.remove(DateKey.string(e.start.startOfMonth))
            ensure(from: e.start, to: e.start.adding(days: 1))
            guard let id = r["id"] as? String else { return nil }
            return GoogleEvent(id: "\(e.calendarID)|\(id)", calendarID: e.calendarID, title: e.title, start: e.start, end: e.end,
                               isAllDay: e.allDay, location: nil, link: (r["link"] as? String).flatMap(URL.init(string:)), colorHex: nil)
        }
        var body: [String: Any] = ["summary": e.title, "description": e.details]
        if e.allDay {
            body["start"] = ["date": DateKey.string(e.start)]
            body["end"] = ["date": DateKey.string(e.start.adding(days: 1))]
        } else {
            body["start"] = ["dateTime": Self.iso.string(from: e.start), "timeZone": tz]
            body["end"] = ["dateTime": Self.iso.string(from: e.end), "timeZone": tz]
        }
        if !e.attendees.isEmpty {
            body["attendees"] = e.attendees.map { ["email": $0.email, "displayName": $0.name] }
        }
        if let r = e.rrule { body["recurrence"] = [r] }
        var q = [URLQueryItem(name: "sendUpdates", value: e.attendees.isEmpty ? "none" : "all")]
        if e.addMeetLink {
            body["conferenceData"] = ["createRequest": ["requestId": UUID().uuidString,
                                                        "conferenceSolutionKey": ["type": "hangoutsMeet"]]]
            q.append(URLQueryItem(name: "conferenceDataVersion", value: "1"))
        }
        let json = try await api("POST", "/calendars/\(Self.encode(e.calendarID))/events", query: q, body: body)
        let ev = Self.parseEvent(json, calendarID: e.calendarID, colorHex: calendars.first(where: \.primary)?.colorHex)
        // Refresh the affected month so recurring instances show up too.
        let key = DateKey.string(e.start.startOfMonth)
        loadedMonths.remove(key)
        ensure(from: e.start, to: e.start.adding(days: 1))
        return ev
    }

    // MARK: HTTP

    private func accessToken() async throws -> String {
        guard var t = tokens else { throw GoogleError.notConnected }
        if t.expiry > Date().addingTimeInterval(60) { return t.accessToken }
        let s = store.settings
        do {
            let json = try await postForm("https://oauth2.googleapis.com/token", [
                "client_id": s.googleClientID.trimmingCharacters(in: .whitespaces),
                "client_secret": s.googleClientSecret.trimmingCharacters(in: .whitespaces),
                "refresh_token": t.refreshToken,
                "grant_type": "refresh_token",
            ])
            guard let access = json["access_token"] as? String else { throw GoogleError.badResponse }
            t.accessToken = access
            t.expiry = Date().addingTimeInterval((json["expires_in"] as? Double) ?? 3600)
            tokens = t
            Keychain.save(t)
            return access
        } catch GoogleError.http(let code, let msg) where code == 400 || code == 401 {
            // Refresh token revoked or expired: the user has to connect again.
            disconnect()
            throw GoogleError.oauth("access was revoked (\(msg)). Connect again in Settings.")
        }
    }

    private func api(_ method: String, _ path: String, query: [URLQueryItem] = [],
                     body: [String: Any]? = nil) async throws -> [String: Any] {
        let token = try await accessToken()
        var c = URLComponents(string: "https://www.googleapis.com/calendar/v3" + path)!
        if !query.isEmpty { c.queryItems = query }
        var req = URLRequest(url: c.url!)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return try await send(req)
    }

    private func postForm(_ url: String, _ form: [String: String]) async throws -> [String: Any] {
        var req = URLRequest(url: URL(string: url)!)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data(form.map { "\($0.key)=\(Self.formEncode($0.value))" }.joined(separator: "&").utf8)
        return try await send(req)
    }

    private func send(_ req: URLRequest) async throws -> [String: Any] {
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200..<300).contains(code) else {
            let msg = ((json["error"] as? [String: Any])?["message"] as? String)
                ?? (json["error_description"] as? String)
                ?? (json["error"] as? String)
                ?? String(data: data, encoding: .utf8) ?? ""
            throw GoogleError.http(code, msg)
        }
        return json
    }

    // MARK: Parsing helpers

    static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func parseISO(_ s: String) -> Date? { iso.date(from: s) ?? isoFractional.date(from: s) }

    private static func parseTime(_ obj: Any?) -> (Date, Bool)? {
        guard let o = obj as? [String: Any] else { return nil }
        if let s = o["dateTime"] as? String, let d = parseISO(s) { return (d, false) }
        if let s = o["date"] as? String, let d = DateKey.date(s) { return (d, true) }
        return nil
    }

    static func parseEvent(_ item: [String: Any], calendarID: String, colorHex: String?) -> GoogleEvent? {
        guard let id = item["id"] as? String,
              (item["status"] as? String) != "cancelled",
              let (start, allDay) = parseTime(item["start"]),
              let (end, _) = parseTime(item["end"]) else { return nil }
        return GoogleEvent(id: "\(calendarID)|\(id)", calendarID: calendarID,
                           title: (item["summary"] as? String) ?? "(No title)",
                           start: start, end: max(end, start.addingTimeInterval(60)), isAllDay: allDay,
                           location: item["location"] as? String,
                           link: (item["htmlLink"] as? String).flatMap(URL.init(string:)),
                           colorHex: colorHex)
    }

    private static func encode(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~@")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    private static func formEncode(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }
}

extension Color {
    init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
}
