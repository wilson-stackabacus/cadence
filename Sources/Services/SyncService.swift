import Foundation
import Combine

/// Signs in to Cadence Web (username + password) and keeps this Mac's data in sync with it.
/// The session token lives in the Keychain, so the app stays signed in across launches.
@MainActor
final class SyncService: ObservableObject {
    enum Status: Equatable {
        case signedOut, idle, syncing
        case error(String)
    }

    /// The live Cadence Web. Used unless you enter a different server.
    static let defaultServer = "https://cadenceplanner.vercel.app"

    /// Debug/test runs (launched with -dataDir) get their own settings so they never touch yours.
    private static let defaults: UserDefaults = LaunchOptions.has("-dataDir")
        ? (UserDefaults(suiteName: "com.ryanpark.cadence.debug") ?? .standard) : .standard

    /// Always the Cadence site in the real app (there's no address to type); test runs may override it.
    @Published var serverURL: String {
        didSet { if LaunchOptions.has("-dataDir") { Self.defaults.set(serverURL, forKey: Keys.server) } }
    }
    /// What you typed in the username box, kept even if you leave Settings before signing in.
    @Published var draftUsername: String {
        didSet { Self.defaults.set(draftUsername, forKey: Keys.draftUsername) }
    }
    @Published private(set) var username: String?
    @Published private(set) var status: Status = .signedOut
    @Published private(set) var lastSynced: Date?
    @Published private(set) var isSigningIn = false
    /// True briefly after a sync the user can see (button press or local edits pushed): shows a check mark.
    @Published private(set) var justSynced = false
    /// Spinner visibility: stays on long enough to notice even when the request takes 100 ms.
    @Published private(set) var showSpinner = false

    private unowned let store: Store
    private var timer: Timer?
    private var changeWatcher: AnyCancellable?
    private var running: Task<Void, Never>?

    private enum Keys {
        static let server = "sync.server"
        static let username = "sync.username"
        static let cursor = "sync.cursor"
        static let lastPushed = "sync.lastPushed"
        static let token = "session-token"
        static let draftUsername = "sync.draftUsername"
        static let identity = "sync.identity"
    }

    private var cursor: Int {
        get { Self.defaults.integer(forKey: Keys.cursor) }
        set { Self.defaults.set(newValue, forKey: Keys.cursor) }
    }
    private var lastPushed: Date? {
        get { Self.defaults.object(forKey: Keys.lastPushed) as? Date }
        set { Self.defaults.set(newValue, forKey: Keys.lastPushed) }
    }

    var isSignedIn: Bool { username != nil }

    /// Called after signing in / out, so other services (Google via the website) can react.
    var onSignedIn: (() -> Void)?
    var onSignedOut: (() -> Void)?

    /// An authenticated call to the Cadence API (used for the website's Google connection).
    func apiCall(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Any? = nil) async throws -> Any {
        guard let base = baseURL, let token = Keychain.string(account: Keys.token) else { throw SyncError.unauthorized }
        var c = URLComponents(url: base.appendingPathComponent(String(path.drop(while: { $0 == "/" }))), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { c.queryItems = query }
        var req = URLRequest(url: c.url!, timeoutInterval: 30)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) ?? [:]
        if code == 401 { throw SyncError.unauthorized }
        guard (200..<300).contains(code) else {
            throw SyncError.server(((json as? [String: Any])?["error"] as? String) ?? "Server returned \(code).")
        }
        return json
    }

    init(store: Store) {
        self.store = store
        // The real app always syncs with the Cadence site; only test runs (launched with -dataDir) may
        // point somewhere else. Any address saved by older versions (e.g. ".../app", which made the
        // server answer 405) is ignored and cleared.
        if LaunchOptions.has("-dataDir") {
            serverURL = Self.defaults.string(forKey: Keys.server) ?? Self.defaultServer
        } else {
            Self.defaults.removeObject(forKey: Keys.server)
            serverURL = Self.defaultServer
        }
        draftUsername = Self.defaults.string(forKey: Keys.draftUsername) ?? ""
        if Keychain.string(account: Keys.token) != nil, let u = Self.defaults.string(forKey: Keys.username) {
            username = u
            status = .idle
        }
    }

    func start() {
        let t = Timer(timeInterval: 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sync() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        // Push local edits a few seconds after they happen.
        changeWatcher = store.objectWillChange
            .debounce(for: .seconds(3), scheduler: RunLoop.main)
            .sink { [weak self] in
                guard let self, self.isSignedIn, self.store.hasPendingChanges(since: self.lastPushed) else { return }
                self.sync()
            }
        sync()
    }

    // MARK: Account

    /// Scheme + host (+ port) only, so a stray path such as "/app" can never end up in API requests.
    private var baseURL: URL? {
        var s = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.isEmpty && !s.contains("://") { s = "https://" + s }
        guard let parsed = URLComponents(string: s), let scheme = parsed.scheme, let host = parsed.host else { return nil }
        var c = URLComponents()
        c.scheme = scheme; c.host = host; c.port = parsed.port
        return c.url
    }

    func signIn(username: String, password: String, create: Bool) async {
        guard let base = baseURL else { status = .error("Couldn't reach Cadence. Try again."); return }
        isSigningIn = true
        defer { isSigningIn = false }
        do {
            let json = try await request(base.appendingPathComponent(create ? "api/register" : "api/login"), body: [
                "username": username.trimmingCharacters(in: .whitespaces),
                "password": password,
                "remember": true,
                "device": "mac",
            ], token: nil)
            guard let token = json["token"] as? String,
                  let user = (json["user"] as? [String: Any])?["username"] as? String else { throw SyncError.badResponse }
            // A different account or server (or the first sign-in) starts from scratch:
            // push everything on this Mac, pull everything from the account, merge.
            let identity = "\(base.absoluteString)|\(user.lowercased())"
            if identity != Self.defaults.string(forKey: Keys.identity) {
                cursor = 0
                lastPushed = nil
                Self.defaults.set(identity, forKey: Keys.identity)
            }
            Keychain.setString(token, account: Keys.token)
            Self.defaults.set(user, forKey: Keys.username)
            draftUsername = user
            self.username = user
            status = .idle
            sync()
            onSignedIn?()
        } catch {
            status = .error(error.localizedDescription)
        }
    }

    func signOut() {
        if let base = baseURL, let token = Keychain.string(account: Keys.token) {
            var req = URLRequest(url: base.appendingPathComponent("api/logout"))
            req.httpMethod = "POST"
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = Data("{}".utf8)
            URLSession.shared.dataTask(with: req).resume()
        }
        Keychain.setString(nil, account: Keys.token)
        Self.defaults.removeObject(forKey: Keys.username)
        cursor = 0
        lastPushed = nil
        username = nil
        status = .signedOut
        onSignedOut?()
    }

    // MARK: Sync

    func sync(manual: Bool = false) {
        guard isSignedIn, running == nil else { return }
        running = Task { await syncNow(manual: manual); running = nil }
    }

    private func syncNow(manual: Bool) async {
        guard let base = baseURL, let token = Keychain.string(account: Keys.token) else { return }
        status = .syncing
        let pushStarted = Date()
        let changes = store.pendingChanges(since: lastPushed)
        // Quiet background polls don't animate; anything the user caused does, for at least ~0.7 s.
        let visible = manual || !changes.isEmpty
        if visible { showSpinner = true; justSynced = false }
        defer {
            if visible {
                Task { @MainActor in
                    let elapsed = Date().timeIntervalSince(pushStarted)
                    if elapsed < 0.75 { try? await Task.sleep(nanoseconds: UInt64((0.75 - elapsed) * 1_000_000_000)) }
                    self.showSpinner = false
                    if self.status == .idle {
                        self.justSynced = true
                        try? await Task.sleep(nanoseconds: 1_500_000_000)
                        self.justSynced = false
                    }
                }
            }
        }
        let body: [String: Any] = [
            "since": cursor,
            "changes": changes.map { c -> [String: Any] in
                var d: [String: Any] = ["kind": c.kind, "id": c.id, "deleted": c.deleted,
                                        "updatedAt": Int64(c.updatedAt.timeIntervalSince1970 * 1000)]
                if let data = c.data { d["data"] = data }
                return d
            },
        ]
        do {
            let json = try await request(base.appendingPathComponent("api/sync"), body: body, token: token)
            let remote = (json["changes"] as? [[String: Any]] ?? []).compactMap { c -> Store.SyncChange? in
                guard let kind = c["kind"] as? String, let id = c["id"] as? String else { return nil }
                let ms = (c["updatedAt"] as? NSNumber)?.doubleValue ?? 0
                return Store.SyncChange(kind: kind, id: id, updatedAt: Date(timeIntervalSince1970: ms / 1000),
                                        deleted: c["deleted"] as? Bool ?? false, data: c["data"] is NSNull ? nil : c["data"])
            }
            store.applyRemote(remote)
            cursor = (json["cursor"] as? NSNumber)?.intValue ?? cursor
            lastPushed = pushStarted
            lastSynced = Date()
            status = .idle
        } catch SyncError.unauthorized {
            signOut()
            status = .error("Signed out — your session expired. Sign in again.")
        } catch {
            status = .error(error.localizedDescription)
        }
    }

    // MARK: HTTP

    enum SyncError: LocalizedError {
        case unauthorized, badResponse
        case server(String)
        var errorDescription: String? {
            switch self {
            case .unauthorized: return "Not signed in."
            case .badResponse: return "Unexpected response from the server."
            case .server(let m): return m
            }
        }
    }

    private func request(_ url: URL, body: [String: Any], token: String?) async throws -> [String: Any] {
        var req = URLRequest(url: url, timeoutInterval: 30)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if code == 401 && token != nil { throw SyncError.unauthorized }
        guard (200..<300).contains(code) else {
            throw SyncError.server((json["error"] as? String) ?? "Server returned \(code).")
        }
        return json
    }
}
