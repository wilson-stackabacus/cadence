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

    @Published var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: Keys.server) }
    }
    @Published private(set) var username: String?
    @Published private(set) var status: Status = .signedOut
    @Published private(set) var lastSynced: Date?
    @Published private(set) var isSigningIn = false

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
    }

    private var cursor: Int {
        get { UserDefaults.standard.integer(forKey: Keys.cursor) }
        set { UserDefaults.standard.set(newValue, forKey: Keys.cursor) }
    }
    private var lastPushed: Date? {
        get { UserDefaults.standard.object(forKey: Keys.lastPushed) as? Date }
        set { UserDefaults.standard.set(newValue, forKey: Keys.lastPushed) }
    }

    var isSignedIn: Bool { username != nil }

    init(store: Store) {
        self.store = store
        serverURL = UserDefaults.standard.string(forKey: Keys.server) ?? ""
        if Keychain.string(account: Keys.token) != nil, let u = UserDefaults.standard.string(forKey: Keys.username) {
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

    private var baseURL: URL? {
        var s = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        if !s.isEmpty && !s.contains("://") { s = "https://" + s }
        return URL(string: s)
    }

    func signIn(username: String, password: String, create: Bool) async {
        guard let base = baseURL else { status = .error("Enter the Cadence Web address first."); return }
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
            // A different account starts from scratch: push everything here, pull everything there.
            if user.lowercased() != UserDefaults.standard.string(forKey: Keys.username)?.lowercased() {
                cursor = 0
                lastPushed = nil
            }
            Keychain.setString(token, account: Keys.token)
            UserDefaults.standard.set(user, forKey: Keys.username)
            self.username = user
            status = .idle
            sync()
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
        UserDefaults.standard.removeObject(forKey: Keys.username)
        cursor = 0
        lastPushed = nil
        username = nil
        status = .signedOut
    }

    // MARK: Sync

    func sync() {
        guard isSignedIn, running == nil else { return }
        running = Task { await syncNow(); running = nil }
    }

    private func syncNow() async {
        guard let base = baseURL, let token = Keychain.string(account: Keys.token) else { return }
        status = .syncing
        let pushStarted = Date()
        let changes = store.pendingChanges(since: lastPushed)
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
